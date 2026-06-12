/**
 * Predict Trader - Predict.fun 订单执行封装
 *
 * 功能:
 * - Maker 订单提交 (0 手续费)
 * - 订单状态查询
 * - 订单取消
 *
 * 使用 @predictdotfun/sdk 的 OrderBuilder 确保正确的订单构建和签名
 */

import { Wallet, JsonRpcProvider, parseUnits, formatUnits } from 'ethers';
import { EventEmitter } from 'events';
import { OrderBuilder, Side } from '@predictdotfun/sdk';
import { BscRpcFailover, getBscRpcUrl } from '../config/bsc-rpc.js';
import { getBscOrderWatcher, type OrderFilledEvent } from '../services/bsc-order-watcher.js';
import { getOrderStatusCache, initOrderStatusCache, type CachedOrderStatus } from './order-status-cache.js';

// ============================================================================
// 常量
// ============================================================================

const CHAIN_ID = 56; // BSC
const API_BASE_URL = 'https://api.predict.fun';

// 数量精度 (与 market-maker 保持一致: 18-13=5)
const QUANTITY_DECIMALS = 5;
const PRECISION_ALIGNMENT = BigInt(1e13); // API 要求 amount % 1e13 === 0
// 价格精度 (与 market-maker 保持一致: 固定 6 位)
const PRICE_DECIMALS = 6;

/**
 * 保留指定小数位（向下取整）
 */
function floorToFixed(value: number, decimals: number): string {
    const multiplier = Math.pow(10, decimals);
    const floored = Math.floor(value * multiplier) / multiplier;
    return floored.toFixed(decimals);
}

/**
 * 对齐到 1e13 精度（API 要求）
 */
function alignToPrecision(amount: bigint): bigint {
    return (amount / PRECISION_ALIGNMENT) * PRECISION_ALIGNMENT;
}

// ============================================================================
// Predict API number parsing helpers
// ============================================================================

/**
 * Predict API may return share quantities/prices as:
 * - human numbers (e.g. "4", "4.0", 4)
 * - wei strings (e.g. "4000000000000000000") using 18 decimals
 */
function parsePredictNumberMaybeWei(raw: unknown): number {
    if (raw === undefined || raw === null) return 0;

    if (typeof raw === 'bigint') {
        return Number(formatUnits(raw, 18));
    }

    const str = (typeof raw === 'number' ? raw.toString() : String(raw)).trim();
    if (!str) return 0;

    // If it is like "9000...000.0", strip trailing ".0..."
    const normalizedInt = str.includes('.') ? str.replace(/\.0+$/, '') : str;

    // Large integer string => treat as wei
    if (/^\d+$/.test(normalizedInt) && normalizedInt.length > 12) {
        try {
            return Number(formatUnits(BigInt(normalizedInt), 18));
        } catch {
            return 0;
        }
    }

    const n = Number(str);
    return Number.isFinite(n) ? n : 0;
}

function parsePredictQuantity(raw: unknown): number {
    return parsePredictNumberMaybeWei(raw);
}

function parsePredictPrice(raw: unknown): number {
    return parsePredictNumberMaybeWei(raw);
}

// ============================================================================
// 类型定义
// ============================================================================

export interface PredictOrderInput {
    marketId: number;
    side: 'BUY' | 'SELL';
    price: number;        // 0-1 小数价格
    quantity: number;     // shares 数量
    outcome?: 'YES' | 'NO'; // 交易的 token 类型，默认 YES
    expiresAt?: Date;     // 订单链上过期时间 (SDK expiration 字段)
}

export interface PredictOrderResult {
    success: boolean;
    hash?: string;
    error?: string;
}

export interface PredictOrderStatus {
    id: string;  // 订单 ID（用于取消）
    status: 'OPEN' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'EXPIRED';
    filledQty: number;
    remainingQty: number;
    avgPrice: number;
    cancelReason?: string;  // 取消原因（如有）
    rawResponse?: Record<string, unknown>;  // 原始响应（用于调试）
}

export interface PredictPosition {
    marketId: number;
    tokenId: string;
    side: 'YES' | 'NO';
    quantity: number;
    avgPrice: number;
}

export interface CancelResult {
    success: boolean;      // 是否认为取消成功（removed 或 noop 都是 true）
    action: 'removed' | 'noop' | 'failed';  // 具体结果
}

// ============================================================================
// 订单簿缓存提供者（依赖注入，避免循环依赖）
// ============================================================================

type OrderbookProvider = (marketId: number) => { bids: [number, number][]; asks: [number, number][] } | null;
let orderbookCacheProvider: OrderbookProvider | null = null;
let orderbookRestFallbackEnabled = true;

/**
 * 设置订单簿缓存提供者（由 start-dashboard 注入）
 * 任务执行时优先使用缓存数据，减少 API 调用
 */
export function setPredictOrderbookCacheProvider(provider: OrderbookProvider): void {
    orderbookCacheProvider = provider;
    console.log('[PredictTrader] 订单簿缓存提供者已注入');
}

export function setPredictOrderbookRestFallbackEnabled(enabled: boolean): void {
    orderbookRestFallbackEnabled = enabled;
    console.log(`[PredictTrader] REST fallback ${enabled ? 'enabled' : 'disabled'}`);
}

// ============================================================================
// PredictTrader 类
// ============================================================================

export class PredictTrader extends EventEmitter {
    private signer: Wallet;
    private apiKey: string;
    private smartWalletAddress: string;
    private orderBuilder: OrderBuilder | null = null;
    private initialized = false;

    // JWT 认证
    private jwt: string | null = null;
    private jwtExpiresAt: Date | null = null;

    // RPC 故障转移
    private rpcFailover: BscRpcFailover;
    private privateKey: string;

    constructor() {
        super();

        const privateKey = process.env.PREDICT_SIGNER_PRIVATE_KEY;
        const apiKey = process.env.PREDICT_API_KEY_TRADE || process.env.PREDICT_API_KEY;
        const smartWallet = process.env.PREDICT_SMART_WALLET_ADDRESS;

        if (!privateKey) {
            throw new Error('PREDICT_SIGNER_PRIVATE_KEY is required');
        }
        if (!apiKey) {
            throw new Error('PREDICT_API_KEY is required');
        }
        if (!smartWallet) {
            throw new Error('PREDICT_SMART_WALLET_ADDRESS is required');
        }

        this.privateKey = privateKey;
        this.rpcFailover = new BscRpcFailover();
        const provider = new JsonRpcProvider(this.rpcFailover.getCurrentUrl());
        this.signer = new Wallet(privateKey, provider);
        this.apiKey = apiKey;
        this.smartWalletAddress = smartWallet;
    }

    /**
     * 切换到下一个 RPC 节点（故障转移）
     */
    private switchRpc(): void {
        const newUrl = this.rpcFailover.switchToNext();
        const provider = new JsonRpcProvider(newUrl);
        this.signer = new Wallet(this.privateKey, provider);
        console.log(`[PredictTrader] Switched RPC to: ${newUrl}`);
    }

    /**
     * 初始化 - 创建 OrderBuilder 和获取 JWT（带重试）
     */
    async init(): Promise<void> {
        if (this.initialized) return;

        const MAX_RETRIES = 3;
        const RETRY_DELAY_MS = 2000;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                console.log(`[PredictTrader] Initializing... (attempt ${attempt}/${MAX_RETRIES})`);

                // 初始化 OrderBuilder（使用智能钱包模式）
                // ethers ESM/CJS 模块格式差异导致 BaseWallet 类型不兼容，运行时正常
                this.orderBuilder = await Promise.race([
                    OrderBuilder.make(CHAIN_ID, this.signer as any, {
                        predictAccount: this.smartWalletAddress
                    }),
                    new Promise<never>((_, reject) =>
                        setTimeout(() => reject(new Error('OrderBuilder init timeout')), 10000)
                    )
                ]) as OrderBuilder;

                // 获取 JWT
                await this.authenticateSmartWallet();

                this.initialized = true;
                console.log(`[PredictTrader] Initialized: signer=${this.signer.address.slice(0, 10)}..., smartWallet=${this.smartWalletAddress.slice(0, 10)}...`);

                // 初始化并启动订单状态缓存服务
                try {
                    const cache = initOrderStatusCache(() => this.getAuthHeaders());
                    cache.start();
                    console.log('[PredictTrader] OrderStatusCache 已启动');
                } catch (e: any) {
                    console.warn('[PredictTrader] OrderStatusCache 启动失败:', e.message);
                }

                return;
            } catch (e: any) {
                console.error(`[PredictTrader] Init attempt ${attempt} failed:`, e.message || e);

                if (attempt < MAX_RETRIES) {
                    console.log(`[PredictTrader] Retrying in ${RETRY_DELAY_MS / 1000}s...`);
                    await this.delay(RETRY_DELAY_MS);
                } else {
                    console.error('[PredictTrader] Failed to initialize after all retries');
                    throw e;
                }
            }
        }
    }

    /**
     * 智能钱包 JWT 认证 (与 market-maker TradingClient 保持一致)
     */
    private async authenticateSmartWallet(): Promise<void> {
        try {
            // 1. 获取签名消息 (不带 address 参数)
            const msgRes = await fetch(`${API_BASE_URL}/v1/auth/message`, {
                headers: { 'x-api-key': this.apiKey }
            });

            if (!msgRes.ok) {
                throw new Error(`获取认证消息失败: ${msgRes.status}`);
            }

            const msgData = await msgRes.json() as { data: { message: string } };
            const message = msgData.data.message;

            // 2. 使用智能钱包签名方法
            const signature = await this.orderBuilder!.signPredictAccountMessage(message);

            // 3. 提交认证 (使用 signer 字段，包含 message)
            const authRes = await fetch(`${API_BASE_URL}/v1/auth`, {
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
                throw new Error(`JWT 认证失败: ${authRes.status} - ${text}`);
            }

            const authData = await authRes.json() as {
                data: { token: string; expiresAt?: string }
            };

            this.jwt = authData.data.token;
            this.jwtExpiresAt = authData.data.expiresAt
                ? new Date(authData.data.expiresAt)
                : new Date(Date.now() + 24 * 60 * 60 * 1000);

            console.log('[PredictTrader] JWT 认证成功');
        } catch (e) {
            console.error('[PredictTrader] 认证失败:', e);
            throw e;
        }
    }

    /**
     * 获取认证头
     */
    private async getAuthHeaders(): Promise<Record<string, string>> {
        // 提前 5 分钟刷新 JWT，避免在下单关键路径上触发完整认证流程
        const JWT_REFRESH_BUFFER_MS = 300_000; // 5 minutes
        if (!this.jwt || !this.jwtExpiresAt || new Date(Date.now() + JWT_REFRESH_BUFFER_MS) >= this.jwtExpiresAt) {
            await this.authenticateSmartWallet();
        }

        return {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'Authorization': `Bearer ${this.jwt}`
        };
    }

    /**
     * 提交 Maker 买单 (YES)
     */
    async placeBuyOrder(input: PredictOrderInput): Promise<PredictOrderResult> {
        return this.placeOrder({ ...input, side: 'BUY' });
    }

    /**
     * 提交 Maker 卖单 (YES)
     */
    async placeSellOrder(input: PredictOrderInput): Promise<PredictOrderResult> {
        return this.placeOrder({ ...input, side: 'SELL' });
    }

    /**
     * 提交订单 (使用 SDK OrderBuilder)
     */
    async placeOrder(input: PredictOrderInput): Promise<PredictOrderResult> {
        if (!this.initialized) await this.init();

        if (!this.orderBuilder) {
            return { success: false, error: 'OrderBuilder 未初始化' };
        }

        const t0 = Date.now();
        try {
            // 1. 获取市场信息 (tokenId, isNegRisk, isYieldBearing)
            const marketInfo = await this.getMarketInfo(input.marketId);
            if (!marketInfo) {
                const detailedError = this.lastMarketInfoError || 'Failed to get market info';
                return { success: false, error: detailedError };
            }

            // 根据 outcome 选择 token (默认 YES)
            const outcome = input.outcome || 'YES';
            const tokenId = outcome === 'YES' ? marketInfo.yesTokenId : marketInfo.noTokenId;

            // 2. 计算订单金额 (与 market-maker 保持一致: 固定精度)
            const priceStr = floorToFixed(input.price, PRICE_DECIMALS);
            const quantityStr = floorToFixed(input.quantity, QUANTITY_DECIMALS);

            // Predict API 最小下单金额限制（低于阈值会直接 400: BelowMinOrderPriceError）
            // 注意：start-dashboard.ts 的 loadEnv 在模块导入后执行，因此这里必须运行时读取 env
            const minOrderValueUsd = Number(process.env.PREDICT_MIN_ORDER_VALUE_USD || 0.9);
            if (input.side === 'BUY') {
                const priceNum = parseFloat(priceStr) || 0;
                const qtyNum = parseFloat(quantityStr) || 0;
                const orderValue = priceNum * qtyNum;
                if (orderValue > 0 && orderValue < minOrderValueUsd) {
                    const minQty = priceNum > 0 ? Math.ceil(minOrderValueUsd / priceNum) : 0;
                    return {
                        success: false,
                        error:
                            `Order value too small: ${orderValue.toFixed(4)} < ${minOrderValueUsd} USD. ` +
                            `Increase quantity (minQty>=${minQty}).`,
                    };
                }
            }
            const priceWei = parseUnits(priceStr, 18);
            const quantityWei = parseUnits(quantityStr, 18);

            const amounts = this.orderBuilder.getLimitOrderAmounts({
                side: input.side === 'BUY' ? Side.BUY : Side.SELL,
                pricePerShareWei: priceWei,
                quantityWei: quantityWei
            });

            // 对齐到 1e13 精度 (API 要求 amount % 1e13 === 0)
            const alignedMakerAmount = alignToPrecision(amounts.makerAmount);
            const alignedTakerAmount = alignToPrecision(amounts.takerAmount);

            if (alignedMakerAmount === BigInt(0) || alignedTakerAmount === BigInt(0)) {
                return { success: false, error: `订单金额过小，对齐后为 0` };
            }

            // 3. 构建订单
            // feeRateBps 是市场的费率参数，必须与市场匹配
            // Maker 订单不收费，但构建时仍需传入市场费率
            const order = this.orderBuilder.buildOrder('LIMIT', {
                side: input.side === 'BUY' ? Side.BUY : Side.SELL,
                tokenId: tokenId,
                makerAmount: alignedMakerAmount,
                takerAmount: alignedTakerAmount,
                feeRateBps: marketInfo.feeRateBps,  // 使用市场费率
                ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
            });

            // 4. 构建类型化数据并签名
            const typedData = this.orderBuilder.buildTypedData(order, {
                isNegRisk: marketInfo.isNegRisk,
                isYieldBearing: marketInfo.isYieldBearing
            });

            const signedOrder = await this.orderBuilder.signTypedDataOrder(typedData);
            const hash = this.orderBuilder.buildTypedDataHash(typedData);

            // 5. 提交订单
            const payload = {
                data: {
                    order: { ...signedOrder, hash },
                    pricePerShare: amounts.pricePerShare.toString(),
                    strategy: 'LIMIT'
                }
            };

            const headers = await this.getAuthHeaders();
            const tPreFetch = Date.now();

            // 重试: nginx 间歇性 404/502/503 (最多 3 次)
            let res: Response | null = null;
            let responseText = '';
            const maxSubmitRetries = 3;
            for (let attempt = 1; attempt <= maxSubmitRetries; attempt++) {
                res = await fetch(`${API_BASE_URL}/v1/orders`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(payload)
                });

                responseText = await res.text();

                // nginx 间歇性错误 (HTML 404/502/503): 重试
                const isNginxError = !res.ok && [404, 502, 503].includes(res.status)
                    && responseText.includes('nginx');
                if (isNginxError && attempt < maxSubmitRetries) {
                    console.warn(`[PredictTrader] nginx ${res.status}, retry ${attempt}/${maxSubmitRetries}...`);
                    await this.delay(100 * attempt);
                    continue;
                }
                break;
            }

            if (!res!.ok) {
                return {
                    success: false,
                    error: `HTTP ${res!.status}: ${responseText}`
                };
            }

            let parsed: any = {};
            try {
                parsed = responseText ? JSON.parse(responseText) : {};
            } catch {
                return { success: false, error: `返回非 JSON: ${responseText}` };
            }

            if (parsed.success === false) {
                return {
                    success: false,
                    error: parsed.message || parsed.error || 'Unknown error'
                };
            }

            const orderHash = parsed?.data?.orderHash || parsed?.data?.hash || hash;
            this.emit('order:placed', { hash: orderHash, input });

            const tDone = Date.now();
            console.log(
                `[PredictTrader] 下单成功: ${input.side} ${input.quantity} @ ${input.price}` +
                ` (prep=${tPreFetch - t0}ms, api=${tDone - tPreFetch}ms, total=${tDone - t0}ms)`,
            );
            return { success: true, hash: orderHash };
        } catch (error: any) {
            console.error('[PredictTrader] 下单失败:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * 获取订单状态 (优先使用缓存，缓存未命中时调用 API)
     */
    async getOrderStatus(hash: string): Promise<PredictOrderStatus | null> {
        // 1. 尝试从缓存获取
        try {
            const cache = getOrderStatusCache();
            const cached = cache.getOrderStatus(hash);

            if (cached) {
                const cacheStaleMs = Number(process.env.ORDER_CACHE_STALE_MS || 5000);
                const isStale = cached.status === 'OPEN' && Date.now() - cached.updatedAt > cacheStaleMs;
                if (isStale) {
                    // 缂撳瓨鍙兘涓嶅啀鍑嗙‘锛屾敼鐢?API 閲嶆柊鏌ヨ
                    return this.getOrderStatusWithSignal(hash);
                }
                // 缓存命中，转换为 PredictOrderStatus 格式
                let status: PredictOrderStatus['status'] = 'OPEN';
                if (cached.status === 'FILLED') {
                    status = 'FILLED';
                } else if (cached.status === 'CANCELLED') {
                    status = 'CANCELLED';
                } else if (cached.status === 'EXPIRED') {
                    status = 'EXPIRED';
                } else if (cached.filledQty > 0) {
                    status = 'PARTIALLY_FILLED';
                }

                return {
                    id: cached.id,
                    status,
                    filledQty: cached.filledQty,
                    remainingQty: cached.remainingQty,
                    avgPrice: 0,  // 缓存不包含价格，需要时再查询
                    cancelReason: cached.cancelReason,
                    rawResponse: cached.rawResponse,
                };
            }
        } catch {
            // 缓存服务未初始化，降级到直接查询
        }

        // 2. 缓存未命中，调用 API
        return this.getOrderStatusWithSignal(hash);
    }

    private async getOrderStatusWithSignal(hash: string, signal?: AbortSignal): Promise<PredictOrderStatus | null> {
        try {
            // 订单状态查询需要 JWT 认证
            const headers = await this.getAuthHeaders();
            const res = await fetch(`${API_BASE_URL}/v1/orders/${hash}`, {
                headers,
                signal,
            });

            if (!res.ok) {
                if (res.status === 429) {
                    console.warn(`[PredictTrader] Rate limit on getOrderStatus`);
                }
                return null;
            }

            const data = await res.json() as any;

            // 兼容多种 API 响应格式 (参考 market-maker 的解析逻辑)
            const order = data?.data ?? data?.order ?? data;

            // 解析 status (多种可能的字段名)
            const statusRaw =
                order?.status ??
                order?.order?.status ??
                data?.status;

            // 解析 filled 数量 (多种可能的字段名)
            // NOTE: amountFilled is often wei(1e18), quantityFilled may already be human shares
            const rawFilled =
                order?.quantityFilled ??
                order?.order?.quantityFilled ??
                order?.amountFilled ??
                order?.order?.amountFilled ??
                '0';
            const filledQty = parsePredictQuantity(rawFilled);

            // 解析 total 数量
            const rawTotal =
                order?.quantity ??
                order?.order?.quantity ??
                order?.amount ??
                order?.order?.amount ??
                '0';
            const totalQty = parsePredictQuantity(rawTotal);

            // 标准化状态 (大写)
            const normalizedStatus = statusRaw ? String(statusRaw).toUpperCase() : '';

            let status: PredictOrderStatus['status'] = 'OPEN';
            if (normalizedStatus === 'FILLED' || (totalQty > 0 && filledQty >= totalQty)) {
                status = 'FILLED';
            } else if (normalizedStatus === 'CANCELLED' || normalizedStatus === 'CANCELED') {
                status = 'CANCELLED';
            } else if (normalizedStatus === 'EXPIRED') {
                status = 'EXPIRED';
            } else if (filledQty > 0) {
                status = 'PARTIALLY_FILLED';
            }

            // 解析平均成交价
            const avgPrice = parsePredictPrice(
                order?.averagePrice ??
                order?.order?.averagePrice ??
                order?.avgPrice ??
                order?.order?.avgPrice ??
                order?.pricePerShare ??
                order?.order?.pricePerShare ??
                order?.price ??
                order?.order?.price ??
                '0'
            );

            // 解析订单 ID（用于取消订单）
            const orderId = order?.id ?? order?.order?.id ?? data?.id ?? '';

            // 解析取消原因（多种可能的字段名）
            const cancelReason =
                order?.cancelReason ??
                order?.cancel_reason ??
                order?.reason ??
                order?.cancelledReason ??
                order?.cancelled_reason ??
                order?.message ??
                order?.error ??
                order?.order?.cancelReason ??
                order?.order?.reason ??
                data?.cancelReason ??
                data?.reason ??
                data?.message ??
                undefined;

            // 如果是 CANCELLED 状态，记录详细日志
            if (status === 'CANCELLED' || status === 'EXPIRED') {
                console.log(`[PredictTrader] Order ${hash.slice(0, 16)}... status=${status}, reason=${cancelReason || 'unknown'}`);
                console.log(`[PredictTrader] Raw order response:`, JSON.stringify(order, null, 2));
            }

            return {
                id: orderId,
                status,
                filledQty,
                remainingQty: Math.max(0, totalQty - filledQty),
                avgPrice,
                cancelReason: cancelReason ? String(cancelReason) : undefined,
                rawResponse: order as Record<string, unknown>,
            };
        } catch {
            return null;
        }
    }

    /**
     * 轮询订单状态直到成交或超时
     */
    async pollOrderUntilFilled(
        hash: string,
        timeoutMs: number = 30000,
        intervalMs: number = 500
    ): Promise<PredictOrderStatus | null> {
        const startTime = Date.now();

        while (Date.now() - startTime < timeoutMs) {
            const status = await this.getOrderStatus(hash);

            if (!status) {
                await this.delay(intervalMs);
                continue;
            }

            if (status.status === 'FILLED') {
                this.emit('order:filled', { hash, status });
                return status;
            }

            if (status.status === 'PARTIALLY_FILLED') {
                this.emit('order:partial', { hash, status });
            }

            if (status.status === 'CANCELLED' || status.status === 'EXPIRED') {
                return status;
            }

            await this.delay(intervalMs);
        }

        return null; // 超时
    }

    /**
     * 使用 WSS + API 双轨监听订单状态（推荐）
     *
     * - WSS 用于“打断等待/唤醒轮询”，更快进入下一次状态拉取
     * - 最终仍以 API 状态为准（避免链上事件与 API 语义差异）
     */
    async pollOrderWithWss(
        hash: string,
        timeoutMs: number = 30000,
        intervalMs: number = 500
    ): Promise<PredictOrderStatus | null> {
        const startTime = Date.now();
        let lastStatus: PredictOrderStatus | null = null;

        let cancelWatch: (() => void) | null = null;
        let wssResolve: (() => void) | null = null;
        let wssPromise: Promise<void> | null = null;

        const resetSignal = () => {
            wssPromise = new Promise<void>((resolve) => {
                wssResolve = resolve;
            });
        };
        resetSignal();

        try {
            const watcher = getBscOrderWatcher(this.smartWalletAddress);
            if (watcher.isConnected()) {
                cancelWatch = watcher.watchOrder(
                    hash,
                    (_event: OrderFilledEvent) => {
                        if (wssResolve) {
                            wssResolve();
                            resetSignal(); // 支持连续 fill
                        }
                    },
                    timeoutMs
                );
            }
        } catch {
            // watcher 不可用，静默降级
        }

        try {
            while (Date.now() - startTime < timeoutMs) {
                const status = await this.getOrderStatus(hash);
                if (status) {
                    lastStatus = status;

                    if (status.status === 'FILLED') {
                        this.emit('order:filled', { hash, status });
                        return status;
                    }

                    if (status.status === 'PARTIALLY_FILLED') {
                        this.emit('order:partial', { hash, status });
                    }

                    if (status.status === 'CANCELLED' || status.status === 'EXPIRED') {
                        return status;
                    }
                }

                if (wssPromise) {
                    await Promise.race([
                        this.delay(intervalMs),
                        wssPromise,
                    ]);
                } else {
                    await this.delay(intervalMs);
                }
            }

            return lastStatus;
        } finally {
            if (cancelWatch) {
                try { cancelWatch(); } catch { /* ignore */ }
            }
        }
    }

    /**
     * 启动 BSC WSS 订单监控服务（可选）
     */
    async startWssOrderWatcher(): Promise<void> {
        const watcher = getBscOrderWatcher(this.smartWalletAddress);
        if (watcher.isConnected()) return;
        await watcher.start();
    }

    /**
     * 取消订单
     * @param hashOrId - 订单 hash 或 id（优先用 id）
     */
    async cancelOrder(hashOrId: string): Promise<CancelResult> {
        const CANCEL_TIMEOUT_MS = 5000;  // 5 秒超时

        try {
            // 1. 如果传入的是 hash，先查询获取订单 id
            let orderId = hashOrId;
            if (hashOrId.startsWith('0x')) {
                // 这是 hash，需要查询获取 id (带超时)
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), CANCEL_TIMEOUT_MS);
                try {
                    const orderStatus = await this.getOrderStatusWithSignal(hashOrId, controller.signal);
                    clearTimeout(timeoutId);
                    if (!orderStatus) {
                        console.warn(`[PredictTrader] ⚠️ Order ${hashOrId.slice(0, 16)}... not found, may already be cancelled/filled`);
                        return { success: false, action: 'failed' };
                    }
                    orderId = orderStatus.id;
                    console.log(`[PredictTrader] Resolved hash ${hashOrId.slice(0, 16)}... to id ${orderId}`);
                } catch (e: any) {
                    clearTimeout(timeoutId);
                    if (e.name === 'AbortError') {
                        console.warn(`[PredictTrader] ⚠️ Timeout getting order status for ${hashOrId.slice(0, 16)}...`);
                        return { success: false, action: 'failed' };
                    }
                    throw e;
                }
            }

            // 2. 使用 POST /v1/orders/remove 端点 (带超时)
            const headers = await this.getAuthHeaders();
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CANCEL_TIMEOUT_MS);
            let res: Response;
            try {
                res = await fetch(`${API_BASE_URL}/v1/orders/remove`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ data: { ids: [orderId] } }),
                    signal: controller.signal,
                });
                clearTimeout(timeoutId);
            } catch (e: any) {
                clearTimeout(timeoutId);
                if (e.name === 'AbortError') {
                    console.warn(`[PredictTrader] ⚠️ Timeout cancelling order ${orderId}`);
                    return { success: false, action: 'failed' };
                }
                throw e;
            }

            if (res.ok) {
                const result = await res.json() as { success: boolean; removed: string[]; noop: string[] };
                if (result.removed?.includes(orderId)) {
                    console.log(`[PredictTrader] ✅ Order ${orderId} removed from orderbook`);
                    this.emit('order:cancelled', { hash: hashOrId, id: orderId });
                    return { success: true, action: 'removed' };
                } else if (result.noop?.includes(orderId)) {
                    console.log(`[PredictTrader] ⚠️ Order ${orderId} noop — not in active orderbook (may be pending entry)`);
                    return { success: true, action: 'noop' };
                }
            }

            // 非 2xx 响应，记录详细错误
            const errorBody = await res.text().catch(() => 'N/A');
            console.error(`[PredictTrader] ❌ Cancel order failed: ${res.status} ${res.statusText}, body: ${errorBody.slice(0, 200)}`);

            // 401/403 可能是 JWT 过期，清除缓存以便下次重新认证
            if (res.status === 401 || res.status === 403) {
                console.warn(`[PredictTrader] Auth error on cancel, clearing JWT cache`);
                this.jwt = null;
                this.jwtExpiresAt = null;
            }

            return { success: false, action: 'failed' };
        } catch (err: any) {
            console.error(`[PredictTrader] ❌ Cancel order exception: ${err.message}`);
            return { success: false, action: 'failed' };
        }
    }

    /**
     * 取消所有未成交订单 (批量)
     * 先查询所有 OPEN 订单，再一次性调用 /v1/orders/remove
     */
    async cancelAllOrders(): Promise<{ removed: string[]; noop: string[]; failed: boolean; idToHash: Map<string, string> }> {
        const TIMEOUT_MS = 8000;
        const idToHash = new Map<string, string>();
        try {
            const headers = await this.getAuthHeaders();

            // 1. 查询所有 OPEN 订单 (加 first=100 避免默认分页截断)
            const listRes = await fetch(`${API_BASE_URL}/v1/orders?status=OPEN&first=100`, {
                headers,
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });

            if (!listRes.ok) {
                console.error(`[PredictTrader] ❌ 查询 OPEN 订单失败: ${listRes.status}`);
                return { removed: [], noop: [], failed: true, idToHash };
            }

            const listData = await listRes.json() as any;
            const orders = listData.data || [];
            const orderIds: string[] = [];
            for (const o of orders) {
                const id = o.id?.toString();
                if (!id) continue;
                orderIds.push(id);
                const hash = o.hash ?? o.orderHash ?? '';
                if (hash) idToHash.set(id, hash);
            }

            if (orderIds.length === 0) {
                console.log('[PredictTrader] 没有 OPEN 订单需要取消');
                return { removed: [], noop: [], failed: false, idToHash };
            }

            console.log(`[PredictTrader] 🔴 批量取消 ${orderIds.length} 个 Predict 订单...`);

            // 2. 一次性取消所有订单
            const removeRes = await fetch(`${API_BASE_URL}/v1/orders/remove`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ data: { ids: orderIds } }),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });

            if (removeRes.ok) {
                const result = await removeRes.json() as { success: boolean; removed: string[]; noop: string[] };
                const removed = result.removed || [];
                const noop = result.noop || [];
                console.log(`[PredictTrader] ✅ 批量取消完成: removed=${removed.length}, noop=${noop.length}`);

                // 发射事件 (附带 hash)
                for (const id of removed) {
                    this.emit('order:cancelled', { hash: idToHash.get(id) || '', id });
                }

                return { removed, noop, failed: false, idToHash };
            }

            const errorBody = await removeRes.text().catch(() => 'N/A');
            console.error(`[PredictTrader] ❌ 批量取消失败: ${removeRes.status}, body: ${errorBody.slice(0, 200)}`);
            return { removed: [], noop: [], failed: true, idToHash };
        } catch (err: any) {
            console.error(`[PredictTrader] ❌ 批量取消异常: ${err.message}`);
            return { removed: [], noop: [], failed: true, idToHash };
        }
    }

    /**
     * 获取持仓
     */
    async getPositions(): Promise<PredictPosition[]> {
        try {
            const headers = await this.getAuthHeaders();
            const res = await fetch(`${API_BASE_URL}/v1/positions?first=100`, {
                headers,
            });

            if (!res.ok) {
                console.error(`[PredictTrader] Failed to get positions: ${res.status}`);
                return [];
            }

            const data = await res.json() as {
                success: boolean;
                data: Array<{
                    market: { id: number };
                    outcome: { name: string; onChainId: string };
                    amount: string;  // bigint string (wei)
                    valueUsd: string;
                }>;
            };

            if (!data.success || !data.data) {
                return [];
            }

            return data.data.map(p => ({
                marketId: p.market.id,
                tokenId: p.outcome.onChainId,
                side: p.outcome.name.toUpperCase() as 'YES' | 'NO',
                quantity: parsePredictQuantity(p.amount),  // wei -> human
                avgPrice: 0,  // API 不返回均价
            }));
        } catch (err: any) {
            console.error(`[PredictTrader] Get positions error: ${err.message}`);
            return [];
        }
    }

    /**
     * 获取特定市场的持仓数量
     */
    async getPositionQuantity(marketId: number, side: 'YES' | 'NO'): Promise<number> {
        const positions = await this.getPositions();
        const pos = positions.find(p => p.marketId === marketId && p.side === side);
        return pos?.quantity || 0;
    }

    /**
     * 同步获取缓存订单簿 (WS push 回调中使用，避免 async 开销)
     * 仅读 WS 缓存，无 REST fallback
     */
    getOrderbookFromCache(marketId: number): { bids: [number, number][]; asks: [number, number][] } | null {
        if (orderbookCacheProvider) {
            return orderbookCacheProvider(marketId) || null;
        }
        return null;
    }

    /**
     * 获取订单簿
     * 优先使用缓存数据（2秒刷新），fallback 到 REST API
     */
    async getOrderbook(marketId: number): Promise<{
        bids: [number, number][];
        asks: [number, number][];
    } | null> {
        // 优先使用缓存数据（减少 API 调用，避免限频）
        if (orderbookCacheProvider) {
            const cached = orderbookCacheProvider(marketId);
            if (cached) {
                return cached;  // 空订单簿也返回（无对手方 = Maker 安全）
            }
        }

        // Fallback: REST API
        if (!orderbookRestFallbackEnabled) {
            return null;
        }
        try {
            const res = await fetch(`${API_BASE_URL}/v1/markets/${marketId}/orderbook`, {
                headers: { 'x-api-key': this.apiKey },
            });

            if (!res.ok) {
                if (res.status === 429) {
                    console.warn(`[PredictTrader] Rate limit on orderbook ${marketId}`);
                }
                return null;
            }

            const data = await res.json() as {
                success: boolean;
                data: {
                    bids: Array<{ price?: string | number; size?: string | number } | [number | string, number | string]>;
                    asks: Array<{ price?: string | number; size?: string | number } | [number | string, number | string]>;
                };
            };

            if (!data.success || !data.data) {
                return null;
            }

            const normalizeLevel = (level: unknown): [number, number] | null => {
                if (Array.isArray(level)) {
                    const [price, size] = level as [unknown, unknown];
                    const priceNum = Number(price);
                    const sizeNum = Number(size);
                    return Number.isFinite(priceNum) && Number.isFinite(sizeNum) && priceNum > 0 && sizeNum > 0
                        ? [priceNum, sizeNum]
                        : null;
                }
                if (level && typeof level === 'object') {
                    const raw = level as { price?: unknown; size?: unknown };
                    const priceNum = Number(raw.price ?? 0);
                    const sizeNum = Number(raw.size ?? 0);
                    return Number.isFinite(priceNum) && Number.isFinite(sizeNum) && priceNum > 0 && sizeNum > 0
                        ? [priceNum, sizeNum]
                        : null;
                }
                return null;
            };

            const bids = (data.data.bids || [])
                .map(normalizeLevel)
                .filter((lvl): lvl is [number, number] => lvl !== null);
            const asks = (data.data.asks || [])
                .map(normalizeLevel)
                .filter((lvl): lvl is [number, number] => lvl !== null);

            return { bids, asks };
        } catch (err) {
            console.error(`[PredictTrader] getOrderbook error:`, err);
            return null;
        }
    }

    /**
     * 强制通过 REST API 获取最新订单簿（不走缓存）
     * 用于恢复类下单前的门禁检查
     */
    async getOrderbookFresh(marketId: number, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<{
        bids: [number, number][];
        asks: [number, number][];
    } | null> {
        const timeoutMs = opts?.timeoutMs ?? 2500;
        // 组合超时信号和外部中止信号，避免 addEventListener 累积
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const fetchSignal = opts?.signal
            ? AbortSignal.any([timeoutSignal, opts.signal])
            : timeoutSignal;
        try {
            const res = await fetch(`${API_BASE_URL}/v1/markets/${marketId}/orderbook`, {
                headers: { 'x-api-key': this.apiKey },
                signal: fetchSignal,
            });

            if (!res.ok) {
                console.warn(`[PredictTrader] getOrderbookFresh failed: marketId=${marketId}, status=${res.status}`);
                return null;
            }

            const data = await res.json() as {
                success: boolean;
                data: {
                    bids: Array<{ price?: string | number; size?: string | number } | [number | string, number | string]>;
                    asks: Array<{ price?: string | number; size?: string | number } | [number | string, number | string]>;
                };
            };

            if (!data.success) {
                console.warn(`[PredictTrader] getOrderbookFresh failed: marketId=${marketId}, success=false`);
                return null;
            }
            if (!data.data) {
                return null;
            }

            const normalizeLevel = (level: unknown): [number, number] | null => {
                if (Array.isArray(level)) {
                    const [price, size] = level as [unknown, unknown];
                    const priceNum = Number(price);
                    const sizeNum = Number(size);
                    return Number.isFinite(priceNum) && Number.isFinite(sizeNum) && priceNum > 0 && sizeNum > 0
                        ? [priceNum, sizeNum]
                        : null;
                }
                if (level && typeof level === 'object') {
                    const raw = level as { price?: unknown; size?: unknown };
                    const priceNum = Number(raw.price ?? 0);
                    const sizeNum = Number(raw.size ?? 0);
                    return Number.isFinite(priceNum) && Number.isFinite(sizeNum) && priceNum > 0 && sizeNum > 0
                        ? [priceNum, sizeNum]
                        : null;
                }
                return null;
            };

            const bids = (data.data.bids || [])
                .map(normalizeLevel)
                .filter((lvl): lvl is [number, number] => lvl !== null);
            const asks = (data.data.asks || [])
                .map(normalizeLevel)
                .filter((lvl): lvl is [number, number] => lvl !== null);

            return { bids, asks };
        } catch (err: any) {
            if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
                const reason = opts?.signal?.aborted ? 'aborted' : `timeout=${timeoutMs}ms`;
                console.warn(`[PredictTrader] getOrderbookFresh failed: marketId=${marketId}, ${reason}`);
            } else {
                console.warn(`[PredictTrader] getOrderbookFresh failed: marketId=${marketId}, error=${err?.message}`);
            }
            return null;
        }
    }

    // ========================================================================
    // 私有方法
    // ========================================================================

    // 市场信息缓存 (避免重复 API 调用)
    private marketInfoCache: Map<number, {
        yesTokenId: string;
        noTokenId: string;
        isNegRisk: boolean;
        isYieldBearing: boolean;
        feeRateBps: number;
        priceDecimals: number;
        cachedAt: number;
    }> = new Map();

    private readonly MARKET_INFO_CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存

    // 最后一次 getMarketInfo 失败的详细原因
    private lastMarketInfoError: string = '';

    private async getMarketInfo(marketId: number): Promise<{
        yesTokenId: string;
        noTokenId: string;
        isNegRisk: boolean;
        isYieldBearing: boolean;
        feeRateBps: number;
        priceDecimals: number;
    } | null> {
        // 重置错误信息
        this.lastMarketInfoError = '';

        // 检查缓存
        const cached = this.marketInfoCache.get(marketId);
        if (cached && Date.now() - cached.cachedAt < this.MARKET_INFO_CACHE_TTL) {
            return cached;
        }

        // 重试逻辑 (最多 3 次，遇到 429 时退避)
        const maxRetries = 3;
        let lastError: string = '';

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const res = await fetch(`${API_BASE_URL}/v1/markets/${marketId}`, {
                    headers: { 'x-api-key': this.apiKey },
                });

                if (res.status === 429) {
                    // 频率限制，退避后重试
                    const backoffMs = attempt * 2000; // 2s, 4s, 6s
                    console.warn(`[PredictTrader] Rate limited on market ${marketId}, retry ${attempt}/${maxRetries} after ${backoffMs}ms`);
                    lastError = `Rate limited (429), attempt ${attempt}/${maxRetries}`;
                    await this.delay(backoffMs);
                    continue;
                }

                if (!res.ok) {
                    // 尝试获取响应体以获取更多错误信息
                    let responseBody = '';
                    try {
                        responseBody = await res.text();
                    } catch { /* ignore */ }
                    lastError = `HTTP ${res.status}: ${responseBody.slice(0, 200)}`;
                    this.lastMarketInfoError = `Market ${marketId} API error: HTTP ${res.status}`;
                    console.error(`[PredictTrader] Failed to get market ${marketId}: ${res.status}, body: ${responseBody.slice(0, 200)}`);
                    // nginx 间歇性错误 (HTML 404/502/503): 重试
                    const isNginxError = [404, 502, 503].includes(res.status) && responseBody.includes('nginx');
                    if (isNginxError) {
                        await this.delay(attempt * 1000);
                        continue;
                    }
                    // 对于其他 4xx 错误不重试（市场不存在等）
                    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                        break;
                    }
                    continue;
                }

                const data = await res.json() as {
                    success: boolean;
                    data: {
                        isNegRisk?: boolean;
                        isYieldBearing?: boolean;
                        baseFeeRate?: number;  // 例如 0.02 = 2%
                        decimalPrecision?: number;  // 价格精度 (例如 2)
                        feeRateBps?: number;        // 直接的 bps 费率
                        outcomes?: Array<{
                            name: string;
                            indexSet: number;
                            onChainId: string;
                        }>;
                    }
                };

                if (!data.success || !data.data?.outcomes || data.data.outcomes.length < 2) {
                    lastError = `Invalid market data: success=${data.success}, outcomes=${data.data?.outcomes?.length ?? 0}`;
                    this.lastMarketInfoError = `Market ${marketId}: invalid data structure`;
                    console.error(`[PredictTrader] Invalid market data for ${marketId}: success=${data.success}, outcomes=${data.data?.outcomes?.length ?? 0}`);
                    break;  // 数据格式错误不重试
                }

                // outcomes[0] = Yes, outcomes[1] = No (按 indexSet 排序)
                const outcomes = data.data.outcomes.sort((a, b) => a.indexSet - b.indexSet);
                const yesOutcome = outcomes.find(o => o.name === 'Yes' || o.indexSet === 1);
                const noOutcome = outcomes.find(o => o.name === 'No' || o.indexSet === 2);

                if (!yesOutcome || !noOutcome) {
                    lastError = `Cannot find YES/NO outcomes: found=${outcomes.map(o => o.name).join(',')}`;
                    this.lastMarketInfoError = `Market ${marketId}: no YES/NO outcomes`;
                    console.error(`[PredictTrader] Cannot find YES/NO outcomes for market ${marketId}: ${outcomes.map(o => o.name).join(',')}`);
                    break;  // outcomes 格式错误不重试
                }

                // 获取费率 (优先使用 feeRateBps，其次使用 baseFeeRate 转换)
                let feeRateBps = data.data.feeRateBps || 0;
                if (!feeRateBps && data.data.baseFeeRate) {
                    feeRateBps = Math.round(data.data.baseFeeRate * 10000);
                }

                // 获取市场价格精度 (用于参考，实际下单使用固定 PRICE_DECIMALS)
                const priceDecimals = data.data.decimalPrecision ?? 2;

                const result = {
                    yesTokenId: yesOutcome.onChainId,
                    noTokenId: noOutcome.onChainId,
                    isNegRisk: data.data.isNegRisk || false,
                    isYieldBearing: data.data.isYieldBearing || false,
                    feeRateBps,
                    priceDecimals,
                    cachedAt: Date.now(),
                };

                // 缓存成功结果
                this.marketInfoCache.set(marketId, result);
                return result;

            } catch (error: any) {
                lastError = error?.message || String(error);
                console.error(`[PredictTrader] getMarketInfo attempt ${attempt} error:`, lastError);
                if (attempt < maxRetries) {
                    await this.delay(1000 * attempt);
                }
            }
        }

        // 所有重试失败
        this.lastMarketInfoError = lastError || 'Unknown error';
        console.error(`[PredictTrader] getMarketInfo failed after ${maxRetries} retries: ${lastError}`);
        return null;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 获取市场价格精度 (公开方法)
     * @param marketId - 市场 ID
     * @returns 价格小数位数 (默认 2)
     */
    async getPriceDecimals(marketId: number): Promise<number> {
        const info = await this.getMarketInfo(marketId);
        return info?.priceDecimals ?? 2;
    }

    /**
     * 获取指定市场的活跃（OPEN）订单
     * 用于恢复时检测残留订单，避免重复下单
     */
    async getOpenOrdersForMarket(marketId: number): Promise<Array<{ id: string; hash: string; status: string }>> {
        try {
            const headers = await this.getAuthHeaders();
            const res = await fetch(`${API_BASE_URL}/v1/orders?marketId=${marketId}&status=OPEN`, {
                headers,
            });

            if (!res.ok) {
                console.warn(`[PredictTrader] getOpenOrdersForMarket(${marketId}) failed: HTTP ${res.status}`);
                return [];
            }

            const data = await res.json() as {
                success?: boolean;
                data?: Array<{
                    id?: string;
                    hash?: string;
                    orderHash?: string;
                    status?: string;
                }>;
            };

            const orders = data?.data ?? [];
            return orders.map(o => ({
                id: o.id ?? '',
                hash: o.hash ?? o.orderHash ?? '',
                status: o.status ?? 'OPEN',
            })).filter(o => o.id); // 过滤掉无 id 的无效条目
        } catch (err: any) {
            console.warn(`[PredictTrader] getOpenOrdersForMarket(${marketId}) error: ${err.message}`);
            return [];
        }
    }
}

// ============================================================================
// 单例
// ============================================================================

let instance: PredictTrader | null = null;

export function getPredictTrader(): PredictTrader {
    if (!instance) {
        instance = new PredictTrader();
    }
    return instance;
}
