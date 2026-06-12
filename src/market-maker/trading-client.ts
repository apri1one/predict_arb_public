/**
 * Predict 做市模块 - 交易客户端
 *
 * 整合:
 * - JWT 认证
 * - Token ID 计算 (NegRiskAdapter)
 * - 订单签名与提交 (OrderBuilder)
 * - 持仓与订单查询
 */

import { Wallet, JsonRpcProvider, Contract, parseUnits, formatUnits } from 'ethers';
import { OrderBuilder, Side, ChainId, AddressesByChainId } from '@predictdotfun/sdk';
import type { EngineDependencies, PlaceOrderParams } from './engine.js';
import type { PredictOrderResponse, PositionQueryOptions, OrderStatusResult, OrderStatusFromAPI, OutcomeChoice } from './types.js';
import { getBscRpcEndpoints, getBscRpcUrl } from '../config/bsc-rpc.js';

// ============================================================================
// 常量
// ============================================================================

// 使用共享配置的 BSC RPC 节点（按延迟优化排序）
const BSC_RPC_ENDPOINTS = getBscRpcEndpoints();
const BSC_RPC = getBscRpcUrl();
const CHAIN_ID = ChainId.BnbMainnet;
const RPC_RETRY_COUNT = 3;
const RPC_RETRY_DELAY_MS = 500;

// NegRiskAdapter ABI (仅需要 getPositionId)
const NEG_RISK_ADAPTER_ABI = [
    {
        inputs: [
            { name: '_questionId', type: 'bytes32' },
            { name: '_outcome', type: 'bool' }
        ],
        name: 'getPositionId',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function'
    }
];

// ConditionalTokens ABI for non-negRisk markets
const CONDITIONAL_TOKENS_ABI = [
    {
        inputs: [
            { name: 'collateralToken', type: 'address' },
            { name: 'conditionId', type: 'bytes32' },
            { name: 'indexSet', type: 'uint256' }
        ],
        name: 'getPositionId',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function'
    }
];

// ERC-1155 balanceOf ABI (用于按 tokenId 查询真实可卖份额)
const ERC1155_BALANCE_ABI = [
    {
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'id', type: 'uint256' },
        ],
        name: 'balanceOf',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
    },
];

const QUANTITY_DECIMALS = 5; // API 要求金额/数量精度（18-13=5）
const PRICE_DECIMALS = 6;    // price 通常是更粗的 tick，保守保留 6 位
const PRECISION_DIVISOR = BigInt(1e13); // API 要求 amount % 1e13 === 0

function floorToFixed(value: number, decimals: number): string {
    const factor = 10 ** decimals;
    // value * factor 在本项目范围内保持在安全整数附近（price<1, decimals<=6；quantity 一般不大且 decimals=5）
    const floored = Math.floor(value * factor + 1e-9) / factor;
    return floored.toFixed(decimals);
}

/**
 * 将 BigInt 金额对齐到 1e13（API 精度要求）
 * 向下取整确保不超出可用余额
 */
function alignToPrecision(amount: bigint): bigint {
    return (amount / PRECISION_DIVISOR) * PRECISION_DIVISOR;
}

// ============================================================================
// 交易客户端
// ============================================================================

export interface TradingClientConfig {
    apiKey: string;
    signerPrivateKey: string;
    smartWalletAddress: string;  // Predict 智能钱包地址
    baseUrl?: string;
}

export class TradingClient {
    private apiKey: string;
    private baseUrl: string;
    private signer: Wallet;
    private provider: JsonRpcProvider;
    private smartWalletAddress: string;  // Predict 智能钱包地址
    private orderBuilder: OrderBuilder | null = null;

    // JWT 认证
    private jwt: string | null = null;
    private jwtExpiresAt: Date | null = null;

    // 合约
    private negRiskAdapter: Contract | null = null;
    private conditionalTokens: Contract | null = null;
    private erc1155ByAddress: Map<string, Contract> = new Map();

    // Token ID 缓存 (marketId -> tokenId)
    private tokenIdCache: Map<number, string> = new Map();

    // RPC 节点切换
    private currentRpcIndex = 0;

    constructor(config: TradingClientConfig) {
        this.apiKey = config.apiKey;
        this.baseUrl = config.baseUrl || 'https://api.predict.fun';
        this.smartWalletAddress = config.smartWalletAddress;

        // 初始化 Provider 和 Signer
        this.provider = new JsonRpcProvider(BSC_RPC);
        this.signer = new Wallet(config.signerPrivateKey, this.provider);

        console.log(`[TradingClient] Signer: ${this.signer.address}`);
        console.log(`[TradingClient] Smart Wallet: ${this.smartWalletAddress}`);
    }

    // ========================================================================
    // 初始化
    // ========================================================================

    /**
     * 初始化客户端（异步）
     */
    async init(): Promise<void> {
        // 初始化 OrderBuilder（使用智能钱包模式）
        // @ts-expect-error - ethers ESM/CJS 模块格式差异导致 BaseWallet 类型不兼容，运行时正常
        this.orderBuilder = await OrderBuilder.make(CHAIN_ID, this.signer, {
            predictAccount: this.smartWalletAddress
        });
        console.log('[TradingClient] 使用智能钱包模式');

        // 初始化合约
        const addresses = AddressesByChainId[CHAIN_ID];
        this.negRiskAdapter = new Contract(
            addresses.NEG_RISK_ADAPTER,
            NEG_RISK_ADAPTER_ABI,
            this.provider
        );
        this.conditionalTokens = new Contract(
            addresses.CONDITIONAL_TOKENS,
            CONDITIONAL_TOKENS_ABI,
            this.provider
        );

        // 获取 JWT（使用智能钱包认证）
        await this.authenticateSmartWallet();

        console.log('[TradingClient] 初始化完成');
    }

    // ========================================================================
    // 链上持仓（按 tokenId）
    // ========================================================================

    private getConditionalTokensAddress(options: PositionQueryOptions): string {
        const addresses = AddressesByChainId[CHAIN_ID];

        if (options.isYieldBearing) {
            return options.isNegRisk
                ? addresses.YIELD_BEARING_NEG_RISK_CONDITIONAL_TOKENS
                : addresses.YIELD_BEARING_CONDITIONAL_TOKENS;
        }

        return options.isNegRisk
            ? addresses.NEG_RISK_CONDITIONAL_TOKENS
            : addresses.CONDITIONAL_TOKENS;
    }

    private getErc1155Contract(address: string): Contract {
        const existing = this.erc1155ByAddress.get(address);
        if (existing) return existing;

        const contract = new Contract(address, ERC1155_BALANCE_ABI, this.provider);
        this.erc1155ByAddress.set(address, contract);
        return contract;
    }

    /**
     * 切换到备用 RPC 节点
     */
    private switchToBackupRpc(): void {
        this.currentRpcIndex = (this.currentRpcIndex + 1) % BSC_RPC_ENDPOINTS.length;
        const newRpc = BSC_RPC_ENDPOINTS[this.currentRpcIndex];
        console.log(`[TradingClient] 切换 RPC 节点: ${newRpc}`);
        this.provider = new JsonRpcProvider(newRpc);
        // 清空合约缓存（需要用新 provider 重建）
        this.erc1155ByAddress.clear();
    }

    /**
     * 带重试的 RPC 调用
     */
    private async rpcCallWithRetry<T>(fn: () => Promise<T>, retries = RPC_RETRY_COUNT): Promise<T> {
        let lastError: unknown;
        for (let i = 0; i < retries; i++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                const errMsg = String(error);
                // 网络错误时切换 RPC 节点
                if (errMsg.includes('socket hang up') ||
                    errMsg.includes('socket disconnected') ||
                    errMsg.includes('TLS connection') ||
                    errMsg.includes('ECONNRESET') ||
                    errMsg.includes('ECONNREFUSED') ||
                    errMsg.includes('ETIMEDOUT') ||
                    errMsg.includes('network')) {
                    this.switchToBackupRpc();
                }
                if (i < retries - 1) {
                    await new Promise(r => setTimeout(r, RPC_RETRY_DELAY_MS * (i + 1)));
                }
            }
        }
        throw lastError;
    }

    /**
     * 按 tokenId 查询智能钱包的真实持仓（用于 SELL 可用量判断）
     *
     * 注意：合约地址会随 isNegRisk / isYieldBearing 变化，否则会出现"持仓口径不一致"。
     */
    async fetchTokenPosition(tokenId: string, options: PositionQueryOptions): Promise<number> {
        try {
            const conditionalTokensAddress = this.getConditionalTokensAddress(options);
            const ctf = this.getErc1155Contract(conditionalTokensAddress);

            const balanceWei = await this.rpcCallWithRetry(() =>
                ctf.balanceOf(this.smartWalletAddress, BigInt(tokenId))
            );
            // 用 string 进行 18 位小数转换，避免 Number 精度问题导致下单 amount 精度异常
            const raw = formatUnits(balanceWei, 18);
            const rounded = Number(floorToFixed(Number(raw), QUANTITY_DECIMALS));
            return rounded;
        } catch (error) {
            console.error('[TradingClient] 获取链上持仓错误 (重试后仍失败):', error);
            return 0;
        }
    }

    // ========================================================================
    // JWT 认证（智能钱包模式）
    // ========================================================================

    /**
     * 使用智能钱包进行 JWT 认证
     * 认证地址是智能钱包，但签名使用 Privy 钱包通过 signPredictAccountMessage
     */
    private async authenticateSmartWallet(): Promise<void> {
        try {
            // 1. 获取签名消息
            const msgRes = await fetch(`${this.baseUrl}/v1/auth/message`, {
                headers: { 'x-api-key': this.apiKey }
            });

            if (!msgRes.ok) {
                throw new Error(`获取认证消息失败: ${msgRes.status}`);
            }

            const msgData = await msgRes.json() as { data: { message: string } };
            const message = msgData.data.message;

            // 2. 使用智能钱包签名方法
            const signature = await this.orderBuilder!.signPredictAccountMessage(message);

            // 3. 提交认证（使用智能钱包地址）
            const authRes = await fetch(`${this.baseUrl}/v1/auth`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey
                },
                body: JSON.stringify({
                    signer: this.smartWalletAddress,  // 使用智能钱包地址
                    signature,
                    message
                })
            });

            if (!authRes.ok) {
                const text = await authRes.text();
                throw new Error(`认证失败: ${authRes.status} - ${text}`);
            }

            const authData = await authRes.json() as {
                data: { token: string; expiresAt?: string }
            };

            this.jwt = authData.data.token;
            this.jwtExpiresAt = authData.data.expiresAt
                ? new Date(authData.data.expiresAt)
                : new Date(Date.now() + 24 * 60 * 60 * 1000);

            console.log('[TradingClient] 智能钱包 JWT 认证成功');

        } catch (error) {
            console.error('[TradingClient] 智能钱包认证失败:', error);
            throw error;
        }
    }

    // ========================================================================
    // JWT 认证
    // ========================================================================

    /**
     * 获取 JWT Token
     */
    private async authenticate(): Promise<void> {
        try {
            // 1. 获取签名消息
            const msgRes = await fetch(`${this.baseUrl}/v1/auth/message`, {
                headers: { 'x-api-key': this.apiKey }
            });

            if (!msgRes.ok) {
                throw new Error(`获取认证消息失败: ${msgRes.status}`);
            }

            const msgData = await msgRes.json() as { data: { message: string } };
            const message = msgData.data.message;

            // 2. 签名
            const signature = await this.signer.signMessage(message);

            // 3. 提交认证
            const authRes = await fetch(`${this.baseUrl}/v1/auth`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey
                },
                body: JSON.stringify({
                    signer: this.signer.address,
                    signature,
                    message
                })
            });

            if (!authRes.ok) {
                const text = await authRes.text();
                throw new Error(`认证失败: ${authRes.status} - ${text}`);
            }

            const authData = await authRes.json() as {
                data: { token: string; expiresAt?: string }
            };

            this.jwt = authData.data.token;
            // JWT 默认有效期 24 小时
            this.jwtExpiresAt = authData.data.expiresAt
                ? new Date(authData.data.expiresAt)
                : new Date(Date.now() + 24 * 60 * 60 * 1000);

            console.log('[TradingClient] JWT 认证成功');

        } catch (error) {
            console.error('[TradingClient] 认证失败:', error);
            throw error;
        }
    }

    /**
     * 确保 JWT 有效
     *
     * 重要：必须使用 authenticateSmartWallet() 而非 authenticate()，
     * 因为初始化时使用的是智能钱包认证，刷新时也必须保持一致。
     */
    private async ensureAuth(): Promise<void> {
        if (!this.jwt || !this.jwtExpiresAt || this.jwtExpiresAt <= new Date()) {
            // 使用与 init() 一致的智能钱包认证
            await this.authenticateSmartWallet();
        }
    }

    /**
     * 获取带 JWT 的请求头
     */
    private async getAuthHeaders(): Promise<Record<string, string>> {
        await this.ensureAuth();
        return {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'Authorization': `Bearer ${this.jwt}`
        };
    }

    /**
     * 获取当前 JWT (用于外部调试)
     */
    async getJwt(): Promise<string> {
        await this.ensureAuth();
        return this.jwt!;
    }

    // ========================================================================
    // Token ID 计算
    // ========================================================================

    /**
     * 获取 YES Token ID
     * 直接从 API 的 outcomes[0].onChainId 获取
     *
     * @param marketId 市场 ID
     */
    async getTokenId(marketId: number, outcome: OutcomeChoice = 'YES'): Promise<string> {
        // 缓存 key 包含 outcome
        const cacheKey = `${marketId}-${outcome}`;

        // 检查缓存（使用扩展的 cacheKey）
        const cached = this.tokenIdCache.get(marketId);
        if (cached && cached.startsWith(`${outcome}:`)) {
            return cached.substring(outcome.length + 1);
        }

        // 从 API 获取市场数据
        const res = await fetch(`${this.baseUrl}/v1/markets/${marketId}`, {
            headers: { 'x-api-key': this.apiKey }
        });

        if (!res.ok) {
            throw new Error(`获取市场数据失败: ${res.status}`);
        }

        const data = await res.json() as {
            data: {
                outcomes: Array<{ name: string; onChainId: string }>
            }
        };

        const outcomes = data.data.outcomes;
        if (!outcomes || outcomes.length === 0) {
            throw new Error(`市场 ${marketId} 没有 outcomes`);
        }

        // 根据 outcome 选择对应的 token
        // YES = 第一个 outcome (index 0), NO = 第二个 outcome (index 1)
        // 优先尝试按名称匹配 "Yes"/"No"，否则按索引
        let selectedOutcome: { name: string; onChainId: string } | undefined;

        if (outcome === 'YES') {
            selectedOutcome = outcomes.find(o => o.name === 'Yes') || outcomes[0];
        } else {
            selectedOutcome = outcomes.find(o => o.name === 'No') || outcomes[1];
        }

        if (!selectedOutcome) {
            throw new Error(`市场 ${marketId} 只有 ${outcomes.length} 个 outcome，无法选择 ${outcome}`);
        }

        const tokenId = selectedOutcome.onChainId;
        console.log(`[TradingClient] Market ${marketId} outcome="${selectedOutcome.name}" → ${outcome}`);

        // 缓存（使用带 outcome 前缀的值）
        this.tokenIdCache.set(marketId, `${outcome}:${tokenId}`);
        console.log(`[TradingClient] Market ${marketId} [${outcome}] TokenID: ${tokenId.slice(0, 20)}...`);

        return tokenId;
    }

    // ========================================================================
    // 订单操作
    // ========================================================================

    /**
     * 下限价单
     * @returns { id, hash }
     */
    async placeOrder(params: PlaceOrderParams): Promise<{ id: string; hash: string }> {
        if (!this.orderBuilder) {
            throw new Error('OrderBuilder 未初始化');
        }

        try {
            // 1. 计算订单金额
            // 注意：不能用 JS number * 1e18 再转 BigInt，会触发浮点精度误差，导致 API InvalidPrecisionError（takerAmount % 1e13 != 0）
            const priceStr = floorToFixed(params.price, PRICE_DECIMALS);
            const quantityStr = floorToFixed(params.quantity, QUANTITY_DECIMALS);
            const priceWei = parseUnits(priceStr, 18);
            const quantityWei = parseUnits(quantityStr, 18);

            const amounts = this.orderBuilder.getLimitOrderAmounts({
                side: params.side === 'BUY' ? Side.BUY : Side.SELL,
                pricePerShareWei: priceWei,
                quantityWei: quantityWei
            });

            // 对齐到 1e13 精度（API 要求 amount % 1e13 === 0）
            const alignedMakerAmount = alignToPrecision(amounts.makerAmount);
            const alignedTakerAmount = alignToPrecision(amounts.takerAmount);

            // 检查对齐后金额是否仍有效
            if (alignedMakerAmount === BigInt(0) || alignedTakerAmount === BigInt(0)) {
                throw new Error(`订单金额过小，对齐后为 0 (maker=${amounts.makerAmount}, taker=${amounts.takerAmount})`);
            }

            // 2. 构建订单
            const order = this.orderBuilder.buildOrder('LIMIT', {
                side: params.side === 'BUY' ? Side.BUY : Side.SELL,
                tokenId: params.tokenId,
                makerAmount: alignedMakerAmount,
                takerAmount: alignedTakerAmount,
                feeRateBps: params.feeRateBps
            });

            if (params.isYieldBearing === undefined) {
                throw new Error('placeOrder 需要显式提供 isYieldBearing（影响 verifyingContract，否则会导致 Order hash mismatch）');
            }

            // 3. 构建类型化数据并签名
            const typedData = this.orderBuilder.buildTypedData(order, {
                isNegRisk: params.isNegRisk,
                isYieldBearing: params.isYieldBearing
            });

            const signedOrder = await this.orderBuilder.signTypedDataOrder(typedData);
            const hash = this.orderBuilder.buildTypedDataHash(typedData);

            // 4. 提交订单
            const payload = {
                data: {
                    order: { ...signedOrder, hash },
                    pricePerShare: amounts.pricePerShare.toString(),
                    strategy: 'LIMIT'
                }
            };

            const headers = await this.getAuthHeaders();
            const res = await fetch(`${this.baseUrl}/v1/orders`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });

            const responseText = await res.text();

            if (!res.ok) {
                throw new Error(`[TradingClient] 下单失败: ${res.status} - ${responseText}`);
            }

            let parsed: any = {};
            try {
                parsed = responseText ? JSON.parse(responseText) : {};
            } catch {
                throw new Error(`[TradingClient] 下单返回非 JSON: ${responseText}`);
            }

            // 有些情况下服务端会用 200 返回 success=false
            if (parsed?.success === false) {
                const msg = parsed?.message ? String(parsed.message) : 'Unknown';
                throw new Error(`[TradingClient] 下单失败: ${msg} - ${responseText}`);
            }

            const orderHash: string = parsed?.data?.hash || parsed?.hash || hash;
            const rawOrderId =
                parsed?.data?.id ??
                parsed?.id ??
                parsed?.data?.orderId ??
                parsed?.orderId ??
                parsed?.data?.order?.id ??
                parsed?.order?.id;

            const orderId = rawOrderId !== undefined && rawOrderId !== null ? String(rawOrderId) : null;

            if (!orderId) {
                // 回包未带 id：尝试用 hash 在订单列表中回填（撤单需要 orderId）
                console.warn('[TradingClient] 下单回包缺少订单 ID，尝试通过 hash 回填…');

                const maxAttempts = 10;
                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                    const orders = await this.fetchOrders(params.marketId);
                    const found = orders.find(o => o?.order?.hash === orderHash);
                    if (found?.id) {
                        console.log(`[TradingClient] 下单成功: ${params.side} ${params.quantity} @ ${params.price} (ID: ${found.id})`);
                        return { id: String(found.id), hash: orderHash };
                    }
                }

                throw new Error(`[TradingClient] 下单响应缺少订单 ID: ${responseText}`);
            }

            console.log(`[TradingClient] 下单成功: ${params.side} ${params.quantity} @ ${params.price} (ID: ${orderId})`);
            return { id: orderId, hash: orderHash };

        } catch (error) {
            console.error(`[TradingClient] 下单错误 (${params.side} ${params.quantity} @ ${params.price}):`, error);
            throw error;
        }
    }

    /**
     * 取消订单（通过 API，无需 gas）
     * 使用 POST /v1/orders/remove 端点
     * @param orderId 订单 ID（字符串，如 "226532"）
     */
    async cancelOrder(orderId: string): Promise<boolean> {
        try {
            const headers = await this.getAuthHeaders();
            const res = await fetch(`${this.baseUrl}/v1/orders/remove`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    data: {
                        ids: [orderId]
                    }
                })
            });

            const text = await res.text();

            if (!res.ok) {
                console.error(`[TradingClient] 取消失败: ${res.status} - ${text}`);
                return false;
            }

            try {
                const result = JSON.parse(text) as {
                    data?: { removed?: string[]; noop?: string[] }
                };
                const removed = result.data?.removed || [];
                const noop = result.data?.noop || [];

                if (removed.includes(orderId)) {
                    console.log(`[TradingClient] 订单已取消: ${orderId}`);
                    return true;
                } else if (noop.includes(orderId)) {
                    console.log(`[TradingClient] 订单已被处理（已成交/已取消）: ${orderId}`);
                    return true;
                }
            } catch {
                // JSON 解析失败但 API 返回成功
            }

            console.log(`[TradingClient] 订单取消请求成功: ${orderId}`);
            return true;

        } catch (error) {
            console.error('[TradingClient] 取消订单错误:', error);
            return false;
        }
    }

    /**
     * 批量取消订单（通过 API，无需 gas）
     * @param orderIds 订单 ID 数组（最多 100 个）
     */
    async cancelOrders(orderIds: string[]): Promise<{ removed: string[]; noop: string[] }> {
        try {
            const headers = await this.getAuthHeaders();
            const res = await fetch(`${this.baseUrl}/v1/orders/remove`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    data: {
                        ids: orderIds
                    }
                })
            });

            if (res.ok) {
                const result = await res.json() as {
                    data?: { removed?: string[]; noop?: string[] }
                };
                const removed = result.data?.removed || [];
                const noop = result.data?.noop || [];
                console.log(`[TradingClient] 批量取消: ${removed.length} 个成功, ${noop.length} 个已处理`);
                return { removed, noop };
            }

            const text = await res.text();
            console.error(`[TradingClient] 批量取消失败: ${res.status} - ${text}`);
            return { removed: [], noop: [] };

        } catch (error) {
            console.error('[TradingClient] 批量取消订单错误:', error);
            return { removed: [], noop: [] };
        }
    }

    /**
     * 链上取消订单（使用 SDK 的 cancelOrders 方法）
     * @param orders 要取消的订单数据数组 (来自 API 的 order 对象)
     * @param options isNegRisk 和 isYieldBearing 选项
     */
    async cancelOrderOnChain(
        orders: any[],
        options: { isNegRisk: boolean; isYieldBearing: boolean }
    ): Promise<string | null> {
        if (!this.orderBuilder) {
            throw new Error('OrderBuilder 未初始化');
        }

        try {
            console.log(`[TradingClient] 链上撤单: ${orders.length} 个订单`);
            const result = await this.orderBuilder.cancelOrders(orders, options);
            console.log(`[TradingClient] 撤单结果:`, result);
            if (result.success && result.receipt) {
                return result.receipt.hash;
            }
            return null;
        } catch (error) {
            console.error('[TradingClient] 链上撤单错误:', error);
            throw error;
        }
    }

    // ========================================================================
    // 订单与持仓查询
    // ========================================================================

    /**
     * 获取活跃订单
     * 返回 API 原始结构 { id, order: {...} }
     */
    async fetchOrders(marketId: number): Promise<PredictOrderResponse[]> {
        try {
            const headers = await this.getAuthHeaders();
            const statuses: Array<'OPEN' | 'PARTIALLY_FILLED'> = ['OPEN', 'PARTIALLY_FILLED'];
            const lists = await Promise.all(statuses.map(async (status) => {
                try {
                    const res = await fetch(
                        `${this.baseUrl}/v1/orders?marketId=${marketId}&status=${status}`,
                        { headers }
                    );
                    if (!res.ok) {
                        // 某些环境下 API 可能不支持 PARTIALLY_FILLED 过滤；忽略即可
                        if (status === 'OPEN') {
                            console.error(`[TradingClient] 获取订单失败: ${res.status} (status=${status})`);
                        }
                        return [] as PredictOrderResponse[];
                    }
                    const data = await res.json() as { data?: any[] };
                    // 转换 API 返回的数据格式
                    return (data.data || []).map(item => this.normalizeOrderResponse(item));
                } catch (error) {
                    if (status === 'OPEN') {
                        console.error(`[TradingClient] 获取订单错误 (status=${status}):`, error);
                    }
                    return [] as PredictOrderResponse[];
                }
            }));

            const merged = new Map<string, PredictOrderResponse>();
            for (const list of lists) {
                for (const item of list) {
                    // 二次过滤：确保只返回指定 marketId 的订单
                    // （API 的 marketId 过滤可能不生效）
                    if (item?.id && item.order?.marketId === marketId) {
                        merged.set(item.id, item);
                    }
                }
            }
            return Array.from(merged.values());

        } catch (error) {
            console.error('[TradingClient] 获取订单错误:', error);
            return [];
        }
    }

    /**
     * 标准化 API 返回的订单数据
     *
     * API 实际返回结构：
     * {
     *   order: { hash, side, makerAmount, takerAmount, ... },  // side 是数字 (0=BUY, 1=SELL)
     *   id, marketId, amount, amountFilled, status, ...        // status 在顶层，金额是 wei
     * }
     */
    private normalizeOrderResponse(raw: any): PredictOrderResponse {
        const id = String(raw.id ?? raw.orderId ?? '');
        const orderData = raw.order ?? {};

        // 转换 side: 0=BUY, 1=SELL (从 order 子对象获取)
        let side: 'BUY' | 'SELL' = 'BUY';
        if (orderData.side === 1 || orderData.side === 'SELL' || orderData.side === 'sell') {
            side = 'SELL';
        }

        // 转换 status (从顶层获取)
        const statusMap: Record<number | string, string> = {
            0: 'OPEN',
            1: 'PARTIALLY_FILLED',
            2: 'FILLED',
            3: 'CANCELLED',
            4: 'EXPIRED',
            'OPEN': 'OPEN',
            'PARTIALLY_FILLED': 'PARTIALLY_FILLED',
            'FILLED': 'FILLED',
            'CANCELLED': 'CANCELLED',
            'EXPIRED': 'EXPIRED',
            'INVALIDATED': 'INVALIDATED',
        };
        const status = statusMap[raw.status] ?? 'OPEN';

        // 金额转换：wei -> 实际数量 (除以 1e18)
        // amount = 订单总量，amountFilled = 已成交量
        const amountWei = BigInt(raw.amount ?? '0');
        const amountFilledWei = BigInt(raw.amountFilled ?? '0');
        const quantity = Number(amountWei) / 1e18;
        const quantityFilled = Number(amountFilledWei) / 1e18;

        // 计算价格：对于 SELL，price = takerAmount / makerAmount
        // 对于 BUY，price = makerAmount / takerAmount
        let price = 0;
        const makerAmount = BigInt(orderData.makerAmount ?? '0');
        const takerAmount = BigInt(orderData.takerAmount ?? '0');
        if (makerAmount > 0 && takerAmount > 0) {
            if (side === 'SELL') {
                price = Number(takerAmount) / Number(makerAmount);
            } else {
                price = Number(makerAmount) / Number(takerAmount);
            }
        }

        return {
            id,
            order: {
                hash: String(orderData.hash ?? ''),
                marketId: Number(raw.marketId ?? 0),
                outcomeId: 0,
                maker: String(orderData.maker ?? ''),
                side,
                price,
                quantity,
                quantityFilled,
                status: status as any,
                createdAt: String(raw.createdAt ?? new Date().toISOString()),
            }
        };
    }

    /**
     * 通过 hash 查询订单真实状态
     * GET /v1/orders/{hash}
     */
    async fetchOrderByHash(hash: string): Promise<OrderStatusResult> {
        try {
            const headers = await this.getAuthHeaders();
            const res = await fetch(`${this.baseUrl}/v1/orders/${hash}`, { headers });

            if (res.status === 404) {
                return { found: false };
            }

            const text = await res.text();
            if (!res.ok) {
                throw new Error(`[TradingClient] 查询订单失败: ${res.status} - ${text}`);
            }

            let parsed: any = {};
            try {
                parsed = text ? JSON.parse(text) : {};
            } catch {
                throw new Error(`[TradingClient] 查询订单返回非 JSON: ${text}`);
            }

            if (parsed?.success === false) {
                const msg = parsed?.message ? String(parsed.message) : 'Unknown';
                return { found: false, status: undefined, amountFilled: undefined };
            }

            const statusRaw =
                parsed?.data?.status ??
                parsed?.data?.order?.status ??
                parsed?.status ??
                parsed?.order?.status;

            const status = (statusRaw ? String(statusRaw).toUpperCase() : undefined) as OrderStatusFromAPI | undefined;

            const amountFilled =
                parsed?.data?.amountFilled ??
                parsed?.data?.order?.amountFilled ??
                parsed?.data?.quantityFilled ??
                parsed?.data?.order?.quantityFilled ??
                parsed?.amountFilled ??
                parsed?.quantityFilled;

            return {
                found: true,
                status,
                amountFilled: amountFilled !== undefined && amountFilled !== null ? String(amountFilled) : undefined,
            };
        } catch (error) {
            console.error('[TradingClient] 查询订单错误:', error);
            throw error;
        }
    }

    /**
     * 获取持仓
     */
    async fetchPosition(marketId: number): Promise<number> {
        try {
            const headers = await this.getAuthHeaders();
            const res = await fetch(`${this.baseUrl}/v1/account`, { headers });

            if (!res.ok) {
                console.error(`[TradingClient] 获取账户失败: ${res.status}`);
                return 0;
            }

            const data = await res.json() as {
                data?: {
                    positions?: Array<{
                        marketId: number;
                        quantity: number;
                    }>
                }
            };

            const position = data.data?.positions?.find(p => p.marketId === marketId);
            return position?.quantity || 0;

        } catch (error) {
            console.error('[TradingClient] 获取持仓错误:', error);
            return 0;
        }
    }

    /**
     * 获取订单簿
     */
    async fetchOrderBook(marketId: number): Promise<{
        bids: [number, number][];
        asks: [number, number][];
    } | null> {
        try {
            const res = await fetch(
                `${this.baseUrl}/v1/markets/${marketId}/orderbook`,
                { headers: { 'x-api-key': this.apiKey } }
            );

            if (!res.ok) {
                return null;
            }

            const data = await res.json() as {
                data: { bids: [number, number][]; asks: [number, number][] }
            };
            return data.data;

        } catch {
            return null;
        }
    }

    /**
     * 获取市场价格精度 (tick size)
     * 从 API 的 decimalPrecision 字段计算
     * decimalPrecision=2 → tickSize=0.01 (1%)
     * decimalPrecision=3 → tickSize=0.001 (0.1%)
     */
    async getMarketTickSize(marketId: number): Promise<number> {
        try {
            const res = await fetch(
                `${this.baseUrl}/v1/markets/${marketId}`,
                { headers: { 'x-api-key': this.apiKey } }
            );

            if (!res.ok) {
                console.warn(`[TradingClient] 获取市场精度失败: ${res.status}，使用默认值 0.01`);
                return 0.01;
            }

            const data = await res.json() as {
                data: { decimalPrecision: 2 | 3 }
            };

            const decimalPrecision = data.data.decimalPrecision;
            const tickSize = Math.pow(10, -decimalPrecision);
            console.log(`[TradingClient] Market ${marketId} decimalPrecision=${decimalPrecision} → tickSize=${tickSize}`);
            return tickSize;

        } catch (error) {
            console.error('[TradingClient] 获取市场精度错误:', error);
            return 0.01; // 默认 1%
        }
    }

    // ========================================================================
    // 创建引擎依赖
    // ========================================================================

    /**
     * 创建 EngineDependencies 接口实现
     */
    createDependencies(): EngineDependencies {
        return {
            fetchOrderBook: (marketId) => this.fetchOrderBook(marketId),
            fetchOrders: (marketId) => this.fetchOrders(marketId),
            fetchPosition: (_marketId, tokenId, options) => this.fetchTokenPosition(tokenId, options),
            placeOrder: (params) => this.placeOrder(params),
            cancelOrder: (orderId) => this.cancelOrder(orderId),
            cancelOrders: (orderIds) => this.cancelOrders(orderIds),
            fetchOrderByHash: (hash) => this.fetchOrderByHash(hash),
            getMarketTickSize: (marketId) => this.getMarketTickSize(marketId),
        };
    }

    // ========================================================================
    // 余额查询
    // ========================================================================

    /**
     * 获取 USDT 余额（智能钱包模式下返回智能钱包余额）
     */
    async getBalance(): Promise<number> {
        if (!this.orderBuilder) {
            throw new Error('OrderBuilder 未初始化');
        }

        try {
            // 查询智能钱包余额（用于下单）
            const balance = await this.orderBuilder.balanceOf('USDT', this.smartWalletAddress);
            return Number(balance) / 1e18;
        } catch (error) {
            console.error('[TradingClient] 获取余额失败:', error);
            return 0;
        }
    }

    /**
     * 获取智能钱包地址
     */
    getSmartWalletAddress(): string {
        return this.smartWalletAddress;
    }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 从环境变量创建 TradingClient
 */
export function createTradingClient(): TradingClient {
    const apiKey = process.env.PREDICT_API_KEY;
    const signerPrivateKey = process.env.PREDICT_SIGNER_PRIVATE_KEY;
    const smartWalletAddress = process.env.PREDICT_SMART_WALLET_ADDRESS;

    if (!apiKey) {
        throw new Error('PREDICT_API_KEY 未设置');
    }
    if (!signerPrivateKey) {
        throw new Error('PREDICT_SIGNER_PRIVATE_KEY 未设置');
    }
    if (!smartWalletAddress) {
        throw new Error('PREDICT_SMART_WALLET_ADDRESS 未设置');
    }

    return new TradingClient({
        apiKey,
        signerPrivateKey,
        smartWalletAddress,
        baseUrl: process.env.PREDICT_API_BASE_URL
    });
}
