/**
 * 账户余额和持仓查询服务
 */

import { Wallet, JsonRpcProvider, Contract, formatUnits, FetchRequest, Network } from 'ethers';
import { getBscRpcEndpoints } from '../config/bsc-rpc.js';

// BSC 网络配置
const BSC_NETWORK = new Network('bnb', 56);
// Polygon 网络配置
const POLYGON_NETWORK = new Network('matic', 137);
const POLYMARKET_COLLATERAL_ADDRESS = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'; // pUSD
// 已验证可用的 Polygon RPC（按响应速度排序），按需扩展
const POLYGON_RPC_ENDPOINTS = [
    'https://polygon-pokt.nodies.app',
    'https://polygon.gateway.tenderly.co',
    'https://polygon.rpc.subquery.network/public',
    'https://polygon.drpc.org',
    'https://polygon.api.onfinality.io/public',
    'https://polygon-bor-rpc.publicnode.com',
];

/**
 * 创建静默的 JsonRpcProvider（禁用网络检测和重试日志）
 */
function createSilentProvider(rpcUrl: string, network: Network): JsonRpcProvider {
    const fetchReq = new FetchRequest(rpcUrl);
    fetchReq.timeout = 3000; // 3秒超时
    // 使用显式网络配置跳过网络检测
    return new JsonRpcProvider(fetchReq, network, { staticNetwork: true });
}
import { OrderBuilder, ChainId } from '@predictdotfun/sdk';
import { createHmac } from 'crypto';
import { detectPolymarketSignatureType } from '../polymarket/wallet-type-detector.js';

// 注意：环境变量必须在函数内部动态读取，不能在模块顶层读取
// 因为 ES 模块的 import 语句先于 await initConfig() 执行，
// 此时 .env 还未加载，顶层读取会得到 undefined

interface OpenOrder {
    market: string;      // 市场标题
    side: 'BUY' | 'SELL';
    outcome: 'YES' | 'NO';
    price: number;       // 价格 (0-1 小数)
    qty: number;         // 数量
    filled: number;      // 已成交数量
    orderId: string;     // 订单ID
}

interface AccountData {
    predict: {
        total: number;
        available: number;
        portfolio: number;    // 持仓价值 (原 locked)
        positions: Array<{
            market: string;    // 市场标题
            side: string;      // YES/NO
            qty: number;       // 持仓数量
            avgPrice: number;  // 平均价格 (美分)
        }>;
        openOrders: OpenOrder[];
    };
    polymarket: {
        total: number;
        available: number;
        portfolio: number;    // 持仓价值 (原 locked)
        positions: Array<{
            market: string;
            side: string;
            qty: number;
            avgPrice: number;
        }>;
        openOrders: OpenOrder[];
    };
}

let cachedJwtToken: string | null = null;
let jwtExpiresAt: number = 0;
let orderBuilder: OrderBuilder | null = null;
let orderBuilderInitFailed = false; // 防止反复尝试
let orderBuilderErrorLogged = false;
let orderBuilderLastAttempt = 0; // 上次尝试时间
let orderBuilderCreatedAt = 0; // OrderBuilder 创建时间
const ORDER_BUILDER_RETRY_INTERVAL = 60000; // 失败后 60 秒才重试
const ORDER_BUILDER_MAX_AGE_MS = 5 * 60 * 1000; // OrderBuilder 最大存活 5 分钟，防止 provider 连接退化

// 市场标题查找器 (由 start-dashboard 注入)
type MarketTitleResolver = (predictId: number) => string | undefined;
let marketTitleResolver: MarketTitleResolver | null = null;

/**
 * 设置市场标题查找器 (由 start-dashboard 调用)
 */
export function setMarketTitleResolver(resolver: MarketTitleResolver): void {
    marketTitleResolver = resolver;
}
let predictBalanceErrorLogged = false;
let predictRpcFailed = false;
let predictRpcLastAttempt = 0;
let predictRpcConsecutiveFailures = 0; // 连续 RPC 失败计数
let lastPredictBalance = 0;
const PREDICT_RPC_RETRY_INTERVAL = 60000; // 失败后 60 秒才重试
const PREDICT_RPC_MAX_FAILURES = 3; // 连续失败 N 次后重建 OrderBuilder
const ACCOUNT_CACHE_MS = Number(process.env.ACCOUNT_CACHE_MS || 5000); // 默认 5 秒
let cachedAccountData: AccountData | null = null;
let accountCacheAt = 0;
let accountFetchInFlight: Promise<AccountData> | null = null;

// 持仓/挂单独立缓存 (失败时保留上次成功数据)
let lastPredictPositions: AccountData['predict']['positions'] = [];
let lastPredictOpenOrders: AccountData['predict']['openOrders'] = [];
let lastPolyPositions: AccountData['polymarket']['positions'] = [];
let lastPolyOpenOrders: AccountData['polymarket']['openOrders'] = [];

/**
 * 获取 Predict SCAN API Key (用于查询操作，不用于交易)
 * 优先级: SCAN -> SCAN_4 -> 主 key (fallback)
 */
function getScanApiKey(): string | null {
    return process.env.PREDICT_API_KEY_SCAN
        || process.env.PREDICT_API_KEY_SCAN_4
        || process.env.PREDICT_API_KEY
        || null;  // 最后 fallback
}

/**
 * 初始化 OrderBuilder (用于查询链上余额)
 */
export async function getOrderBuilder(): Promise<OrderBuilder | null> {
    // 定期重建 OrderBuilder，防止 RPC provider 连接退化导致余额查询永远超时
    if (orderBuilder && Date.now() - orderBuilderCreatedAt > ORDER_BUILDER_MAX_AGE_MS) {
        orderBuilder = null;
    }

    if (orderBuilder) return orderBuilder;

    // 失败后需要等待重试间隔
    if (orderBuilderInitFailed) {
        if (Date.now() - orderBuilderLastAttempt < ORDER_BUILDER_RETRY_INTERVAL) {
            return null; // 还在冷却期，不重试
        }
        // 重置标志，允许重试
        orderBuilderInitFailed = false;
    }

    orderBuilderLastAttempt = Date.now();

    const PREDICT_SIGNER_PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY;
    const PREDICT_SMART_WALLET_ADDRESS = process.env.PREDICT_SMART_WALLET_ADDRESS;

    if (!PREDICT_SIGNER_PRIVATE_KEY || !PREDICT_SMART_WALLET_ADDRESS) {
        orderBuilderInitFailed = true;
        return null;
    }

    // 使用共享配置的 BSC RPC 端点（按延迟优化排序）
    const bscRpcEndpoints = getBscRpcEndpoints();

    for (const rpcUrl of bscRpcEndpoints) {
        try {
            const provider = createSilentProvider(rpcUrl, BSC_NETWORK);
            // 快速测试连接（3秒超时，更积极）
            await Promise.race([
                provider.getBlockNumber(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
            ]);

            const signer = new Wallet(PREDICT_SIGNER_PRIVATE_KEY, provider);

            // 使用静态方法 OrderBuilder.make() 创建实例 (ChainId.BnbMainnet = 56)
            // 包装在超时中防止 SDK 内部卡住
            orderBuilder = await Promise.race([
                // @ts-ignore - ethers ESM/CJS 模块格式差异导致 BaseWallet 类型不兼容，运行时正常
                OrderBuilder.make(ChainId.BnbMainnet, signer, {
                    predictAccount: PREDICT_SMART_WALLET_ADDRESS
                }),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('OrderBuilder timeout')), 5000))
            ]);

            orderBuilderCreatedAt = Date.now();
            orderBuilderErrorLogged = false; // 成功，重置错误标志
            return orderBuilder;
        } catch {
            // 尝试下一个 RPC
            continue;
        }
    }

    orderBuilderInitFailed = true;
    if (!orderBuilderErrorLogged) {
        console.warn('[AccountService] BSC RPC 不可用，Predict 余额暂时无法查询 (60秒后重试)');
        orderBuilderErrorLogged = true;
    }
    return null;
}

/**
 * 获取 Predict JWT Token (带缓存)
 * 使用智能钱包签名方式认证
 */
export async function getPredictJwtToken(): Promise<string | null> {
    // 动态读取环境变量 - 使用 SCAN key (不用于交易)
    const PREDICT_API_KEY = getScanApiKey();
    const PREDICT_SMART_WALLET_ADDRESS = process.env.PREDICT_SMART_WALLET_ADDRESS;
    const PREDICT_BASE_URL = process.env.PREDICT_API_BASE_URL || 'https://api.predict.fun';

    if (!PREDICT_API_KEY) {
        console.warn('[AccountService] 缺少 API Key (SCAN 或主 key)');
        return null;
    }

    // 使用缓存的token(提前5分钟过期)
    if (cachedJwtToken && Date.now() < jwtExpiresAt - 300000) {
        return cachedJwtToken;
    }

    try {
        // 获取 OrderBuilder (用于智能钱包签名)
        const builder = await getOrderBuilder();
        if (!builder || !PREDICT_SMART_WALLET_ADDRESS) {
            console.warn('[AccountService] 缺少 OrderBuilder 或智能钱包地址');
            return null;
        }

        // 获取认证消息
        const msgRes = await fetch(`${PREDICT_BASE_URL}/v1/auth/message`, {
            headers: { 'x-api-key': PREDICT_API_KEY },
            signal: AbortSignal.timeout(5000),
        });

        if (!msgRes.ok) {
            console.error('[AccountService] 获取认证消息失败:', msgRes.status);
            return null;
        }

        const msgData = await msgRes.json() as any;
        const message = msgData.data.message;

        // 使用智能钱包签名方法
        const signature = await builder.signPredictAccountMessage(message);

        // 获取 JWT (使用智能钱包地址)
        const authRes = await fetch(`${PREDICT_BASE_URL}/v1/auth`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': PREDICT_API_KEY
            },
            signal: AbortSignal.timeout(5000),
            body: JSON.stringify({
                signer: PREDICT_SMART_WALLET_ADDRESS,
                signature: signature,
                message: message
            })
        });

        if (!authRes.ok) {
            const errorText = await authRes.text();
            console.error('[AccountService] JWT 获取失败:', authRes.status, errorText);
            return null;
        }

        const authData = await authRes.json() as any;
        cachedJwtToken = authData.data.token;
        jwtExpiresAt = authData.data.expiresAt ? new Date(authData.data.expiresAt).getTime() : Date.now() + 3600000;

        return cachedJwtToken;
    } catch (error) {
        console.error('[AccountService] JWT 获取异常:', error);
        return null;
    }
}

/**
 * 查询 Predict 账户信息和持仓
 */
async function fetchPredictAccount(): Promise<AccountData['predict']> {
    const PREDICT_SMART_WALLET_ADDRESS = process.env.PREDICT_SMART_WALLET_ADDRESS;
    const PREDICT_BASE_URL = process.env.PREDICT_API_BASE_URL || 'https://api.predict.fun';
    const PREDICT_API_KEY = getScanApiKey();  // 使用 SCAN key (不用于交易)

    try {
        // 1. 查询链上 USDT 余额 (使用 OrderBuilder)
        const builder = await getOrderBuilder();
        let balance = lastPredictBalance;
        const shouldSkipRpc = predictRpcFailed &&
            (Date.now() - predictRpcLastAttempt < PREDICT_RPC_RETRY_INTERVAL);

        if (!builder || !PREDICT_SMART_WALLET_ADDRESS || shouldSkipRpc) {
            console.log(`[AccountService] Using cached balance: ${balance.toFixed(4)} (builder=${!!builder}, addr=${!!PREDICT_SMART_WALLET_ADDRESS}, skipRpc=${shouldSkipRpc})`);
        }

        if (builder && PREDICT_SMART_WALLET_ADDRESS && !shouldSkipRpc) {
            predictRpcLastAttempt = Date.now();
            try {
                const balanceWei = await Promise.race([
                    builder.balanceOf('USDT', PREDICT_SMART_WALLET_ADDRESS),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
                ]) as bigint;
                // Predict SDK balanceOf 返回 1e18 精度（内部标准化），不是原生 USDT 的 1e6
                balance = Number(balanceWei) / 1e18;
                // 仅余额变化超过 1 USD 时输出日志
                if (Math.abs(balance - lastPredictBalance) > 1) {
                    console.log(`[AccountService] Chain balance: ${balance.toFixed(2)} (prev: ${lastPredictBalance.toFixed(2)})`);
                }
                lastPredictBalance = balance;
                predictRpcFailed = false;
                predictRpcConsecutiveFailures = 0;
                predictBalanceErrorLogged = false;
            } catch (error) {
                predictRpcFailed = true;
                predictRpcConsecutiveFailures++;
                // 连续失败多次 → 销毁 OrderBuilder，下次用新 provider 重建
                if (predictRpcConsecutiveFailures >= PREDICT_RPC_MAX_FAILURES) {
                    orderBuilder = null;
                    predictRpcConsecutiveFailures = 0;
                    console.warn(`[AccountService] 连续 ${PREDICT_RPC_MAX_FAILURES} 次 RPC 失败，已重置 OrderBuilder`);
                }
                if (!predictBalanceErrorLogged) {
                    console.warn('[AccountService] 查询链上余额失败 (60秒后重试):', (error as Error).message || error);
                    predictBalanceErrorLogged = true;
                }
            }
        }

        // 2. 查询持仓和订单 (需要 JWT Token)
        const jwtToken = await getPredictJwtToken();
        // 初始化为上次成功的数据 (失败时保留)
        let positions: typeof lastPredictPositions = [...lastPredictPositions];
        let openOrders: OpenOrder[] = [...lastPredictOpenOrders];
        let positionsFetched = false;
        let ordersFetched = false;

        // 2a. 查询持仓 (使用 GraphQL API 获取 averageBuyPriceUsd)
        // GraphQL API 无需认证，使用钱包地址直接查询
        const SMART_WALLET = process.env.PREDICT_SMART_WALLET_ADDRESS;
        if (SMART_WALLET) {
            try {
                const graphqlRes = await fetch('https://graphql.predict.fun/graphql', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        query: `query {
                            account(address: "${SMART_WALLET}") {
                                positions {
                                    edges {
                                        node {
                                            id
                                            shares
                                            averageBuyPriceUsd
                                            valueUsd
                                            pnlUsd
                                            market { id title question }
                                            outcome { name }
                                        }
                                    }
                                }
                            }
                        }`
                    }),
                    signal: AbortSignal.timeout(8000),
                });

                if (graphqlRes.ok) {
                    const graphqlData = await graphqlRes.json() as any;
                    const edges = graphqlData?.data?.account?.positions?.edges || [];

                    // 累计持仓当前市值 (用于 portfolio)
                    let totalValueUsd = 0;

                    positions = edges.map((edge: any) => {
                        const node = edge.node;
                        // shares 是 bigint string (wei 格式)
                        const sharesWei = BigInt(node.shares || '0');
                        const qty = Number(sharesWei) / 1e18;
                        // averageBuyPriceUsd 是 0-1 格式，转换为美分
                        const avgPrice = (node.averageBuyPriceUsd || 0) * 100;
                        // valueUsd 是当前市值 (USD)
                        const valueUsd = node.valueUsd || 0;
                        totalValueUsd += valueUsd;

                        // 判断是否为二元市场
                        const outcomeName = (node.outcome?.name || '').toUpperCase();
                        const isBinaryMarket = outcomeName === 'YES' || outcomeName === 'NO';

                        // 优先使用 marketTitleResolver 获取完整事件标题
                        const marketId = node.market?.id;
                        const resolvedTitle = marketTitleResolver && marketId
                            ? marketTitleResolver(Number(marketId))
                            : null;
                        const marketTitle = resolvedTitle || node.market?.question || node.market?.title || `Market #${marketId}`;

                        // 多选项市场: 显示 "事件标题 - 选项名"
                        const displayMarket = isBinaryMarket
                            ? marketTitle
                            : `${marketTitle} - ${node.outcome?.name || 'Unknown'}`;

                        return {
                            market: displayMarket,
                            side: isBinaryMarket ? outcomeName : (node.outcome?.name || 'Unknown'),
                            qty: Math.round(qty * 100) / 100,
                            avgPrice: Math.round(avgPrice * 10) / 10,
                            _valueUsd: valueUsd  // 内部字段用于 portfolio 计算
                        };
                    }).filter((p: any) => p.qty > 0);

                    // 存储 portfolio 值供后续使用
                    (positions as any)._totalValueUsd = totalValueUsd;

                    const prevCount = lastPredictPositions.length;
                    lastPredictPositions = positions;
                    positionsFetched = true;
                    // 仅持仓数量变化时输出日志
                    if (positions.length !== prevCount) {
                        console.log(`[AccountService] Predict 持仓: ${positions.length} 个 (prev: ${prevCount})`);
                    }
                } else {
                    console.warn(`[AccountService] GraphQL 请求失败: ${graphqlRes.status}`);
                }
            } catch (error) {
                console.error('[AccountService] GraphQL 查询持仓失败 (使用缓存):', error);
            }
        }

        if (jwtToken && PREDICT_API_KEY) {

            // 2b. 查询未成交订单 (从 /v1/orders?status=OPEN 端点)
            try {
                const ordersRes = await fetch(`${PREDICT_BASE_URL}/v1/orders?status=OPEN`, {
                    headers: {
                        'x-api-key': PREDICT_API_KEY,
                        'Authorization': `Bearer ${jwtToken}`
                    },
                    signal: AbortSignal.timeout(5000),
                });

                if (ordersRes.ok) {
                    const ordersData = await ordersRes.json() as any;
                    const rawOrders = ordersData.data || [];

                    // /v1/orders 实际返回格式:
                    // { data: [{ id, marketId, amount, amountFilled, status, order: {hash, side(0/1), makerAmount, takerAmount, ...} }] }
                    openOrders = rawOrders.map((o: any) => {
                        const orderData = o.order || {};

                        // side: 0 = BUY, 1 = SELL
                        const sideNum = orderData.side ?? o.side;
                        const side = sideNum === 0 || sideNum === '0' ? 'BUY' : 'SELL';

                        // 数量: amount 是 wei 格式
                        const amountWei = BigInt(o.amount || orderData.takerAmount || '0');
                        const qty = Number(amountWei) / 1e18;

                        // 已成交数量
                        const filledWei = BigInt(o.amountFilled || '0');
                        const filled = Number(filledWei) / 1e18;

                        // 价格计算:
                        // BUY: makerAmount 是 USDC, takerAmount 是 tokens -> price = maker/taker
                        // SELL: makerAmount 是 tokens, takerAmount 是 USDC -> price = taker/maker
                        const makerAmount = Number(BigInt(orderData.makerAmount || '0')) / 1e18;
                        const takerAmount = Number(BigInt(orderData.takerAmount || '0')) / 1e18;
                        const price = side === 'BUY'
                            ? (takerAmount > 0 ? makerAmount / takerAmount : 0)
                            : (makerAmount > 0 ? takerAmount / makerAmount : 0);

                        // outcome: 从 tokenId 无法直接判断，默认 YES (需要查询市场信息才能确定)
                        const outcome = 'YES';

                        // 使用注入的市场标题查找器 (优先) 或回退到 Market #ID
                        const marketTitle = (marketTitleResolver && o.marketId)
                            ? (marketTitleResolver(o.marketId) || `Market #${o.marketId}`)
                            : `Market #${o.marketId || 'Unknown'}`;

                        return {
                            market: marketTitle,
                            side: side as 'BUY' | 'SELL',
                            outcome: outcome as 'YES' | 'NO',
                            price: price,
                            qty: Math.round(qty * 100) / 100,
                            filled: Math.round(filled * 100) / 100,
                            orderId: orderData.hash || o.id || 'unknown'
                        };
                    }).filter((o: OpenOrder) => o.qty > 0);
                    // 成功获取，更新缓存
                    lastPredictOpenOrders = openOrders;
                    ordersFetched = true;
                }
            } catch (error) {
                console.error('[AccountService] 查询订单失败 (使用缓存):', error);
            }
        } else if (!jwtToken) {
            console.warn('[AccountService] JWT 获取失败，使用缓存的持仓/订单数据');
        }

        // 3. 计算账户余额
        // portfolio = 持仓当前市值 (从 GraphQL valueUsd 获取，或回退到成本价计算)
        const graphqlTotalValue = (positions as any)._totalValueUsd;
        const costBasisFallback = positions.reduce((sum, p) => sum + (p.qty * p.avgPrice / 100), 0);
        const portfolio = graphqlTotalValue > 0 ? graphqlTotalValue : costBasisFallback;

        // Predict: 链上余额即“可用余额”；订单不锁定资金（链上余额不会减少）
        const orderLocked = openOrders
            .filter(o => o.side === 'BUY')
            .reduce((sum, o) => {
                const remaining = Math.max(0, (o.qty || 0) - (o.filled || 0));
                const price = o.price || 0;
                return sum + remaining * price;
            }, 0);

        const available = balance;

        console.log(`[AccountService] Predict: available=${available.toFixed(2)}, locked(orders)=${orderLocked.toFixed(2)}, portfolio=${portfolio.toFixed(2)} (valueUsd=${graphqlTotalValue?.toFixed(2) || 'N/A'}), total=${(balance + portfolio).toFixed(2)}`);

        return {
            total: balance + portfolio,  // 总资产 = 链上余额 + 持仓
            available,                  // 可用 = 链上余额 - 未成交 BUY 订单占用
            portfolio,                   // 持仓价值
            positions,
            openOrders
        };
    } catch (error) {
        console.error('[AccountService] Predict 账户查询异常:', error);
        return {
            total: 0,
            available: 0,
            portfolio: 0,
            positions: [],
            openOrders: []
        };
    }
}

/**
 * 构建 Polymarket L2 API Headers (HMAC 签名)
 */
function buildPolymarketHeaders(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    address: string,
    method: string,
    path: string,
    body: string = ''
): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method + path + body;

    const secretBuffer = Buffer.from(apiSecret, 'base64');
    const signature = createHmac('sha256', secretBuffer)
        .update(message, 'utf-8')
        .digest('base64');

    // URL-safe base64
    const urlSafeSignature = signature.replace(/\+/g, '-').replace(/\//g, '_');

    return {
        'POLY_API_KEY': apiKey,
        'POLY_SIGNATURE': urlSafeSignature,
        'POLY_TIMESTAMP': timestamp,
        'POLY_PASSPHRASE': passphrase,
        'POLY_ADDRESS': address,
        'Content-Type': 'application/json',
    };
}

let polymarketBalanceErrorLogged = false;
let polymarketOrderErrorLogged = false;
let polymarketRpcFailed = false;
let polymarketRpcLastAttempt = 0;
let lastPolymarketBalance = 0;
const POLYMARKET_RPC_RETRY_INTERVAL = 60000; // 失败后 60 秒才重试

// Polymarket API 延迟追踪 (基于 positions REST 调用)
let polymarketApiLatencyMs = 0;

/** 获取最近一次 Polymarket API 延迟 (ms) */
export function getPolymarketApiLatency(): number {
    return polymarketApiLatencyMs;
}

/**
 * 查询 Polymarket 账户余额和订单
 */
async function fetchPolymarketAccount(): Promise<AccountData['polymarket']> {
    const POLYMARKET_PROXY_ADDRESS = process.env.POLYMARKET_PROXY_ADDRESS;
    const POLYMARKET_API_KEY = process.env.POLYMARKET_API_KEY;
    const POLYMARKET_API_SECRET = process.env.POLYMARKET_API_SECRET;
    const POLYMARKET_PASSPHRASE = process.env.POLYMARKET_PASSPHRASE;
    const POLYMARKET_TRADER_ADDRESS = process.env.POLYMARKET_TRADER_ADDRESS;

    try {
        let usdcBalance = lastPolymarketBalance;
        let orderLocked = 0;
        let positionValue = 0;

        // 1. 查询链上 pUSD 余额 (代理钱包)
        const shouldSkipRpc = polymarketRpcFailed &&
            (Date.now() - polymarketRpcLastAttempt < POLYMARKET_RPC_RETRY_INTERVAL);

        if (POLYMARKET_PROXY_ADDRESS && !shouldSkipRpc) {
            polymarketRpcLastAttempt = Date.now();

            const polygonRpcEndpoints = POLYGON_RPC_ENDPOINTS;

            const erc20ABI = [
                'function balanceOf(address account) view returns (uint256)',
            ];

            let rpcSuccess = false;
            for (const rpcUrl of polygonRpcEndpoints) {
                try {
                    const polygonRpc = createSilentProvider(rpcUrl, POLYGON_NETWORK);
                    const contract = new Contract(POLYMARKET_COLLATERAL_ADDRESS, erc20ABI, polygonRpc);
                    const balance = await Promise.race([
                        contract.balanceOf(POLYMARKET_PROXY_ADDRESS),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
                    ]) as bigint;
                    // pUSD decimals 固定为 6
                    usdcBalance = Number(balance) / 1e6;
                    lastPolymarketBalance = usdcBalance;
                    polymarketBalanceErrorLogged = false;
                    polymarketRpcFailed = false;
                    rpcSuccess = true;
                    break;
                } catch {
                    continue;
                }
            }

            // RPC 全失败时，fallback 到 CLOB REST API
            if (!rpcSuccess && POLYMARKET_API_KEY && POLYMARKET_API_SECRET && POLYMARKET_PASSPHRASE && POLYMARKET_TRADER_ADDRESS) {
                try {
                    const balancePath = '/balance-allowance';
                    const balanceHeaders = buildPolymarketHeaders(
                        POLYMARKET_API_KEY,
                        POLYMARKET_API_SECRET,
                        POLYMARKET_PASSPHRASE,
                        POLYMARKET_TRADER_ADDRESS,
                        'GET',
                        balancePath
                    );
                    const sigType = await detectPolymarketSignatureType(POLYMARKET_PROXY_ADDRESS!);
                    const balanceRes = await fetch(
                        `https://clob.polymarket.com/balance-allowance?asset_type=COLLATERAL&signature_type=${sigType}`,
                        { headers: balanceHeaders, signal: AbortSignal.timeout(5000) }
                    );
                    if (balanceRes.ok) {
                        const data = await balanceRes.json() as any;
                        if (data.balance != null) {
                            usdcBalance = parseFloat(data.balance) / 1e6;
                            lastPolymarketBalance = usdcBalance;
                            polymarketBalanceErrorLogged = false;
                            polymarketRpcFailed = false;
                            rpcSuccess = true;
                            console.log(`[AccountService] Polygon RPC 全失败，CLOB REST 兜底 pUSD: $${usdcBalance.toFixed(2)}`);
                        }
                    }
                } catch (error) {
                    console.warn('[AccountService] CLOB REST 兜底失败:', (error as Error).message);
                }
            }

            if (!rpcSuccess) {
                polymarketRpcFailed = true;
                if (!polymarketBalanceErrorLogged) {
                    console.warn('[AccountService] Polygon RPC 与 CLOB REST 均失败，Polymarket 余额暂时无法查询 (60秒后重试)');
                    polymarketBalanceErrorLogged = true;
                }
            }
        } else {
            console.log(`[AccountService] Using cached Polymarket balance: ${usdcBalance.toFixed(4)} (addr=${!!POLYMARKET_PROXY_ADDRESS}, skipRpc=${shouldSkipRpc})`);
        }

        // 2. 查询持仓 (使用 Data API - 无需认证)
        // 初始化为上次成功的数据 (失败时保留)
        let positions: typeof lastPolyPositions = [...lastPolyPositions];

        if (POLYMARKET_PROXY_ADDRESS) {
            try {
                const positionsUrl = `https://data-api.polymarket.com/positions?user=${POLYMARKET_PROXY_ADDRESS}&sizeThreshold=0.01`;
                const posStart = Date.now();
                const positionsRes = await fetch(positionsUrl, { signal: AbortSignal.timeout(5000) });

                if (positionsRes.ok) {
                    const positionsData = await positionsRes.json() as any[];
                    polymarketApiLatencyMs = Date.now() - posStart; // headers + body 完整耗时
                    console.log(`[AccountService] Polymarket positions fetched: ${positionsData?.length ?? 0} positions, latency=${polymarketApiLatencyMs}ms`);
                    positions = [];  // 成功时重置
                    positionValue = 0;  // 重新计算

                    if (Array.isArray(positionsData)) {
                        for (const pos of positionsData) {
                            const size = parseFloat(pos.size || '0');
                            const avgPrice = parseFloat(pos.avgPrice || '0');
                            const curPrice = parseFloat(pos.curPrice || '0');
                            const currentValue = parseFloat(pos.currentValue || '0');
                            const redeemable = pos.redeemable === true;

                            // 过滤掉已结算仓位 (redeemable: true)
                            if (size > 0 && !redeemable) {
                                // 累计持仓当前价值
                                positionValue += currentValue;

                                positions.push({
                                    market: pos.title || 'Unknown',
                                    side: (pos.outcome || 'YES').toUpperCase(),
                                    qty: Math.round(size * 100) / 100,
                                    avgPrice: Math.round(avgPrice * 1000) / 10,  // 转换为美分并保留一位小数
                                });
                            }
                        }
                    }
                    // 成功获取，更新缓存
                    lastPolyPositions = positions;
                }
            } catch (error) {
                console.warn('[AccountService] Polymarket 持仓查询失败 (使用缓存):', (error as Error).message);
            }
        }

        // 3. 查询未成交订单 (使用 CLOB API - 需要 HMAC 认证)
        // 初始化为上次成功的数据 (失败时保留)
        let openOrders: OpenOrder[] = [...lastPolyOpenOrders];

        if (POLYMARKET_API_KEY && POLYMARKET_API_SECRET && POLYMARKET_PASSPHRASE && POLYMARKET_TRADER_ADDRESS) {
            try {
                const ordersPath = '/data/orders';
                const ordersQuery = '?state=LIVE';
                const ordersHeaders = buildPolymarketHeaders(
                    POLYMARKET_API_KEY,
                    POLYMARKET_API_SECRET,
                    POLYMARKET_PASSPHRASE,
                    POLYMARKET_TRADER_ADDRESS,
                    'GET',
                    ordersPath
                );

                const ordersRes = await fetch(
                    `https://clob.polymarket.com${ordersPath}${ordersQuery}`,
                    { headers: ordersHeaders, signal: AbortSignal.timeout(5000) }
                );

                if (ordersRes.ok) {
                    const ordersData = await ordersRes.json() as any;
                    const orderList = Array.isArray(ordersData) ? ordersData : (ordersData.data || ordersData.orders || []);
                    openOrders = [];  // 成功时重置
                    orderLocked = 0;  // 重新计算

                    for (const order of orderList) {
                        const status = (order.status || '').toUpperCase();
                        const isLive = status === 'LIVE' || status === 'OPEN';

                        if (isLive) {
                            const side = (order.side || '').toUpperCase();
                            const price = parseFloat(order.price || '0');
                            const originalSize = parseFloat(order.original_size || order.size || '0');
                            const sizeMatched = parseFloat(order.size_matched || '0');
                            const remainingSize = originalSize - sizeMatched;

                            // BUY 订单锁定金额 = 剩余数量 * 价格
                            if (side === 'BUY' && remainingSize > 0) {
                                orderLocked += remainingSize * price;
                            }

                            const outcome = (order.outcome || 'NO').toUpperCase();

                            openOrders.push({
                                market: order.market ? `${order.market.slice(0, 10)}...` : 'Unknown',
                                side: side as 'BUY' | 'SELL',
                                outcome: outcome as 'YES' | 'NO',
                                price: price,
                                qty: Math.round(originalSize * 100) / 100,
                                filled: Math.round(sizeMatched * 100) / 100,
                                orderId: order.id || order.order_id || 'unknown'
                            });
                        }
                    }
                    // 成功获取，更新缓存
                    lastPolyOpenOrders = openOrders;
                    polymarketOrderErrorLogged = false;
                }
            } catch (error) {
                if (!polymarketOrderErrorLogged) {
                    console.warn('[AccountService] Polymarket 订单查询失败 (使用缓存):', (error as Error).message);
                    polymarketOrderErrorLogged = true;
                }
            }
        }

        // 4. 计算账户余额
        // total = pUSD 余额 + 持仓当前价值
        // available = pUSD 余额 - 订单锁定
        // portfolio = 订单锁定 + 持仓价值
        const total = usdcBalance + positionValue;
        const portfolio = orderLocked + positionValue;
        const available = Math.max(0, usdcBalance - orderLocked);

        return {
            total,
            available,
            portfolio,
            positions,
            openOrders
        };

    } catch (error) {
        console.error('[AccountService] Polymarket 账户查询异常:', error);
        return {
            total: 0,
            available: 0,
            portfolio: 0,
            positions: [],
            openOrders: []
        };
    }
}

/**
 * 获取完整账户数据
 */
const ACCOUNT_FETCH_TIMEOUT_MS = 30000; // 整体超时 30 秒，防止永久阻塞

export async function getAccountData(): Promise<AccountData> {
    const now = Date.now();
    if (cachedAccountData && now - accountCacheAt < ACCOUNT_CACHE_MS) {
        return cachedAccountData;
    }

    if (accountFetchInFlight) {
        return accountFetchInFlight;
    }

    accountFetchInFlight = (async () => {
        const fetchPromise = Promise.all([
            fetchPredictAccount(),
            fetchPolymarketAccount()
        ]);

        const [predict, polymarket] = await Promise.race([
            fetchPromise,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('getAccountData timeout')), ACCOUNT_FETCH_TIMEOUT_MS)
            )
        ]);

        const data = { predict, polymarket };
        cachedAccountData = data;
        accountCacheAt = Date.now();
        return data;
    })();

    try {
        return await accountFetchInFlight;
    } catch (error) {
        console.error('[AccountService] getAccountData failed:', (error as Error).message);
        if (cachedAccountData) {
            return cachedAccountData;
        }
        return {
            predict: { total: 0, available: 0, portfolio: 0, positions: [], openOrders: [] },
            polymarket: { total: 0, available: 0, portfolio: 0, positions: [], openOrders: [] }
        };
    } finally {
        accountFetchInFlight = null;
    }
}

/**
 * 强制刷新账户数据（跳过缓存）
 */
export async function refreshAccountData(): Promise<AccountData> {
    console.log('[AccountService] Force refreshing account data...');

    // 清除缓存和可能卡住的 in-flight promise
    cachedAccountData = null;
    accountCacheAt = 0;
    accountFetchInFlight = null;

    // 重置 OrderBuilder，强制使用新 provider 连接
    orderBuilder = null;
    predictRpcFailed = false;
    predictRpcConsecutiveFailures = 0;

    // 重置 Polymarket RPC 状态，强制重新查询
    polymarketRpcFailed = false;

    // 重新获取
    const data = await getAccountData();
    console.log(`[AccountService] Refreshed - Predict: $${data.predict.available.toFixed(2)}, Poly: $${data.polymarket.available.toFixed(2)}`);
    return data;
}

/**
 * 轻量级 Predict 可用余额查询 (余额守卫专用)
 * 无缓存、不查持仓，按需调用
 * 返回 null 表示查询失败（不应据此取消任务）
 */
export async function getPredictAvailableBalance(): Promise<number | null> {
    const PREDICT_SMART_WALLET_ADDRESS = process.env.PREDICT_SMART_WALLET_ADDRESS;
    const builder = await getOrderBuilder();
    const shouldSkipRpc = predictRpcFailed &&
        (Date.now() - predictRpcLastAttempt < PREDICT_RPC_RETRY_INTERVAL);

    if (!builder || !PREDICT_SMART_WALLET_ADDRESS || shouldSkipRpc) {
        console.warn('[BalanceGuard] Predict 余额查询不可用，跳过 Predict 余额检查');
        return null;
    }

    try {
        predictRpcLastAttempt = Date.now();
        const balanceWei = await Promise.race([
            builder.balanceOf('USDT', PREDICT_SMART_WALLET_ADDRESS),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ]) as bigint;
        const balance = Number(balanceWei) / 1e18;
        lastPredictBalance = balance;
        predictRpcFailed = false;
        predictRpcConsecutiveFailures = 0;
        predictBalanceErrorLogged = false;
        return balance;
    } catch (error) {
        predictRpcFailed = true;
        predictRpcConsecutiveFailures++;
        if (predictRpcConsecutiveFailures >= PREDICT_RPC_MAX_FAILURES) {
            orderBuilder = null;
            predictRpcConsecutiveFailures = 0;
            console.warn(`[AccountService] 连续 ${PREDICT_RPC_MAX_FAILURES} 次 Predict RPC 失败，已重置 OrderBuilder`);
        }
        console.warn('[BalanceGuard] Predict 余额查询失败，跳过 Predict 余额检查:', (error as Error).message);
        return null;
    }
}

/**
 * 轻量级 Polymarket 可用余额查询 (余额守卫专用)
 * 无缓存、不查持仓，按需调用
 * 返回 null 表示查询失败（不应据此取消任务）
 */
export async function getPolymarketAvailableBalance(): Promise<number | null> {
    const POLYMARKET_PROXY_ADDRESS = process.env.POLYMARKET_PROXY_ADDRESS;
    const POLYMARKET_API_KEY = process.env.POLYMARKET_API_KEY;
    const POLYMARKET_API_SECRET = process.env.POLYMARKET_API_SECRET;
    const POLYMARKET_PASSPHRASE = process.env.POLYMARKET_PASSPHRASE;
    const POLYMARKET_TRADER_ADDRESS = process.env.POLYMARKET_TRADER_ADDRESS;

    if (!POLYMARKET_PROXY_ADDRESS) return null;

    // 1. 查询链上 pUSD 余额
    const polygonRpcEndpoints = POLYGON_RPC_ENDPOINTS;
    const erc20ABI = [
        'function balanceOf(address account) view returns (uint256)',
        'function decimals() view returns (uint8)',
    ];

    let usdcBalance: number | null = null;
    for (const rpcUrl of polygonRpcEndpoints) {
        try {
            const provider = createSilentProvider(rpcUrl, POLYGON_NETWORK);
            const contract = new Contract(POLYMARKET_COLLATERAL_ADDRESS, erc20ABI, provider);
            const balance = await Promise.race([
                contract.balanceOf(POLYMARKET_PROXY_ADDRESS),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
            ]) as bigint;
            // pUSD decimals 固定为 6，无需额外 RPC 查询
            usdcBalance = Number(balance) / 1e6;
            break;
        } catch {
            continue;
        }
    }

    // RPC 全部失败时，fallback 到 CLOB REST API 查询余额
    if (usdcBalance === null && POLYMARKET_API_KEY && POLYMARKET_API_SECRET && POLYMARKET_PASSPHRASE && POLYMARKET_TRADER_ADDRESS) {
        try {
            // 签名路径不含 query params; signature_type 由链上钱包类型自动探测
            const balanceHeaders = buildPolymarketHeaders(
                POLYMARKET_API_KEY,
                POLYMARKET_API_SECRET,
                POLYMARKET_PASSPHRASE,
                POLYMARKET_TRADER_ADDRESS,
                'GET',
                '/balance-allowance'
            );
            const sigType = await detectPolymarketSignatureType(POLYMARKET_PROXY_ADDRESS);
            const balanceRes = await fetch(
                `https://clob.polymarket.com/balance-allowance?asset_type=COLLATERAL&signature_type=${sigType}`,
                { headers: balanceHeaders, signal: AbortSignal.timeout(5000) }
            );
            if (balanceRes.ok) {
                const data = await balanceRes.json() as any;
                if (data.balance != null) {
                    // REST API 返回 pUSD 微单位 (6 decimals)
                    usdcBalance = parseFloat(data.balance) / 1e6;
                    console.log(`[BalanceGuard] RPC 失败，使用 CLOB REST API 余额: $${usdcBalance.toFixed(2)}`);
                }
            }
        } catch (error) {
            console.warn('[BalanceGuard] CLOB REST API 余额查询也失败:', (error as Error).message);
        }
    }

    if (usdcBalance === null) {
        console.warn('[BalanceGuard] Polygon RPC 和 CLOB REST API 均失败，跳过余额检查');
        return null;
    }

    // 2. 查询 CLOB LIVE 订单锁定金额
    let orderLocked = 0;
    if (POLYMARKET_API_KEY && POLYMARKET_API_SECRET && POLYMARKET_PASSPHRASE && POLYMARKET_TRADER_ADDRESS) {
        try {
            const ordersPath = '/data/orders';
            const ordersQuery = '?state=LIVE';
            const ordersHeaders = buildPolymarketHeaders(
                POLYMARKET_API_KEY,
                POLYMARKET_API_SECRET,
                POLYMARKET_PASSPHRASE,
                POLYMARKET_TRADER_ADDRESS,
                'GET',
                ordersPath
            );
            const ordersRes = await fetch(
                `https://clob.polymarket.com${ordersPath}${ordersQuery}`,
                { headers: ordersHeaders, signal: AbortSignal.timeout(5000) }
            );
            if (ordersRes.ok) {
                const ordersData = await ordersRes.json() as any;
                const orderList = Array.isArray(ordersData) ? ordersData : (ordersData.data || ordersData.orders || []);
                for (const order of orderList) {
                    const status = (order.status || '').toUpperCase();
                    const isLive = status === 'LIVE' || status === 'OPEN';
                    if (isLive) {
                        const side = (order.side || '').toUpperCase();
                        const price = parseFloat(order.price || '0');
                        const originalSize = parseFloat(order.original_size || order.size || '0');
                        const sizeMatched = parseFloat(order.size_matched || '0');
                        const remainingSize = originalSize - sizeMatched;
                        if (side === 'BUY' && remainingSize > 0) {
                            orderLocked += remainingSize * price;
                        }
                    }
                }
            }
        } catch (error) {
            console.warn('[BalanceGuard] CLOB 订单查询失败，保守处理 (orderLocked=0):', (error as Error).message);
            // 查询失败时 orderLocked 保持 0，使 available 偏高，不会误杀任务
        }
    }

    return Math.max(0, usdcBalance - orderLocked);
}
