/**
 * BSC 订单监控服务 - 通过 WebSocket 订阅链上 OrderFilled 事件
 *
 * 目标：
 * - 作为“更快的事件源”用于打断轮询等待（加速订单状态确认）
 * - 支持同一订单多个 watcher（Set callbacks）
 * - stop() 后不再触发重连（shouldReconnect 标志）
 * - WSS URL 从环境变量 BSC_WSS_URLS 读取（逗号分隔），默认公共节点
 */

import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { Interface, formatUnits } from 'ethers';

// ============================================================================
// 常量 / 配置
// ============================================================================

const PUBLIC_NODES = [
    'wss://bsc-rpc.publicnode.com',        // PublicNode (~900ms)
    'wss://bsc.publicnode.com',            // PublicNode (~1000ms)
];

const BSC_WSS_ENV_KEYS = [
    'BSC_WSS_URL',
    'BSC_WS_QUICKNODE',
    'BSC_WS_NODEREAL_1',
    'BSC_WS_NODEREAL_2',
    'BSC_WS_ALCHEMY',
];

function getBscWssUrls(): string[] {
    const envList = [
        ...(process.env.BSC_WSS_URLS || '').split(','),
        ...BSC_WSS_ENV_KEYS.map(key => process.env[key] || ''),
    ].map(u => u.trim()).filter(Boolean);

    // 去重: 环境变量中的低延迟节点优先，公共节点兜底
    const seen = new Set<string>();
    const result: string[] = [];
    for (const url of [...envList, ...PUBLIC_NODES]) {
        if (!seen.has(url)) {
            seen.add(url);
            result.push(url);
        }
    }
    return result;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15000; // 增加到 15 秒，公共节点可能响应较慢
const PING_INTERVAL_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 60000;   // 订阅健康检查间隔 (60s)
const MAX_SILENCE_MS = 5 * 60 * 1000;     // 最长静默期 (5 分钟)，超过则认为订阅失效
const RESUBSCRIBE_ACK_TIMEOUT_MS = 15000; // 重新订阅 ACK 等待超时 (15s)

/**
 * 安全解析 hex 或 decimal 字符串为数字
 * - "0x1a" -> 26 (hex)
 * - "26" -> 26 (decimal)
 * - 26 -> 26 (number passthrough)
 * - NaN/undefined/null -> 0 (兜底)
 */
function safeParseInt(value: string | number | undefined): number {
    if (value === undefined || value === null) return 0;
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : 0;
    }
    const str = String(value).trim();
    if (!str) return 0;
    const n = str.startsWith('0x') || str.startsWith('0X')
        ? parseInt(str, 16)
        : parseInt(str, 10);
    return Number.isFinite(n) ? n : 0;
}

// Predict Exchange 合约地址 (BSC Mainnet)
const PREDICT_EXCHANGES = {
    CTF_EXCHANGE: '0x8BC070BEdAB741406F4B1Eb65A72bee27894B689',
    NEG_RISK_CTF_EXCHANGE: '0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A',
    YIELD_BEARING_CTF_EXCHANGE: '0x6bEb5a40C032AFc305961162d8204CDA16DECFa5',
    YIELD_BEARING_NEG_RISK_CTF_EXCHANGE: '0x8A289d458f5a134bA40015085A8F50Ffb681B41d',
} as const;

/** Exchange 合约地址集合 (小写)，用于判断 negRisk 内部结算事件 */
export const PREDICT_EXCHANGE_ADDRESSES = new Set(
    Object.values(PREDICT_EXCHANGES).map(a => a.toLowerCase())
);

// OrderFilled 事件签名
const ORDER_FILLED_TOPIC = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';

const ORDER_FILLED_ABI = [
    'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
];

const orderFilledInterface = new Interface(ORDER_FILLED_ABI);

// ============================================================================
// 类型
// ============================================================================

export interface OrderFilledEvent {
    orderHash: string;
    maker: string;             // 挂单方地址
    taker: string;             // 吃单方地址
    makerAssetId: string;      // maker 给出的资产 ID（0=USDC, 非0=tokenId）
    takerAssetId: string;      // taker 给出的资产 ID（0=USDC, 非0=tokenId）
    makerAmountFilled: number; // maker 给出的数量（可能是 USDC 或 tokens）
    takerAmountFilled: number; // taker 给出的数量（可能是 USDC 或 tokens）
    fee: number;               // 手续费 (token 单位, shares)
    blockNumber: number;
    txHash: string;
    logIndex: number;          // 日志索引 (同一 tx 内唯一)
    timestamp: number;         // 本地收到事件时间
    exchange: string;          // Exchange 合约地址
}

/**
 * 从 OrderFilledEvent 中提取成交的 shares 数量
 *
 * 逻辑：哪边的 assetId 是 tokens（非0），那边的 amount 就是 shares 数量
 * - tokens 减少（给出 tokens）= 卖出成交
 * - tokens 增加（收到 tokens）= 买入成交
 */
export function getSharesFromFillEvent(event: OrderFilledEvent): number {
    return event.takerAssetId !== '0'
        ? event.takerAmountFilled   // taker 给出 tokens
        : event.makerAmountFilled;  // maker 给出 tokens
}

/**
 * 判断成交方向：卖出还是买入
 *
 * @param event 成交事件
 * @param myAddress 我的钱包地址
 * @returns 'SELL' | 'BUY' | null (null 表示不是我的订单)
 */
export function getFillDirection(event: OrderFilledEvent, myAddress: string): 'SELL' | 'BUY' | null {
    const my = myAddress.toLowerCase();
    const iAmMaker = event.maker.toLowerCase() === my;
    const iAmTaker = event.taker.toLowerCase() === my;

    if (!iAmMaker && !iAmTaker) return null;

    // 我给出 tokens = 卖出，我收到 tokens = 买入
    if (iAmMaker) {
        // maker 给出 makerAssetId，收到 takerAssetId
        return event.makerAssetId !== '0' ? 'SELL' : 'BUY';
    } else {
        // taker 给出 takerAssetId，收到 makerAssetId
        return event.takerAssetId !== '0' ? 'SELL' : 'BUY';
    }
}

export type OrderWatchCallback = (event: OrderFilledEvent) => void;

interface OrderWatchEntry {
    callbacks: Set<OrderWatchCallback>;
    createdAt: number;
    fillCount: number;
}

export interface MarketTokenInfo {
    marketId: number;
    title: string;
    yesTokenId: string;
    noTokenId: string;
    yesName?: string;
    noName?: string;
    status: string;
}

// ============================================================================
// BscOrderWatcher
// ============================================================================

export class BscOrderWatcher extends EventEmitter {
    private ws: WebSocket | null = null;
    private connected = false;
    private shouldReconnect = true;
    private subscriptionId: string | null = null;
    private reconnectAttempts = 0;
    private readonly maxReconnectAttempts = 10;
    private currentWssIndex = 0;
    private pingTimer: NodeJS.Timeout | null = null;
    private healthCheckTimer: NodeJS.Timeout | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private lastSubscribeAckTime = 0;
    private readonly wssUrls: string[];

    /**
     * 已处理日志去重 Map: key = "txHash:logIndex", value = 首次处理时间戳
     * 防止 WS 重连时重放旧区块事件触发重复通知/对冲
     * 保留 24 小时，每小时清理一次
     */
    private readonly processedLogs = new Map<string, number>();
    private logCleanupTimer: NodeJS.Timeout | null = null;
    private static readonly LOG_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;  // 24小时
    private static readonly LOG_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1小时清理一次

    private readonly smartWalletAddress: string;
    private readonly orderWatchers = new Map<string, OrderWatchEntry>();
    private tokenToMarketCache = new Map<string, MarketTokenInfo>();

    private _healthCheckLogCount = 0;
    /** 连续重新订阅 ACK 但仍无事件的次数，用于升级到节点轮换 */
    private _resubscribeStaleCount = 0;
    /** 重新订阅 ACK 后连续无事件的最大容忍次数，超过则断连轮换节点 */
    private readonly MAX_RESUBSCRIBE_STALE = 3;
    /** 健康探测: 上次 eth_blockNumber 响应时间 */
    private _lastProbeResponseTime = 0;
    /** 健康探测: 当前等待响应的探测 ID */
    private _pendingProbeId: number | null = null;
    /** 健康探测: 连续无响应次数 */
    private _probeFailCount = 0;

    private stats = {
        totalEventsReceived: 0,
        ownOrdersFilled: 0,
        lastEventTime: 0,
        connectionStartTime: 0,
    };

    constructor(smartWalletAddress: string) {
        super();
        this.smartWalletAddress = smartWalletAddress.toLowerCase();
        this.wssUrls = getBscWssUrls();
    }

    async start(): Promise<void> {
        if (this.connected) return;
        if (this.wssUrls.length === 0) {
            throw new Error('没有可用的 BSC WSS URL，请设置 BSC_WSS_URLS 环境变量');
        }

        this.shouldReconnect = true;
        this.startLogCleanup();
        await this.connect();
    }

    stop(): void {
        this.shouldReconnect = false;
        this.cleanup();
    }

    isConnected(): boolean {
        return this.connected;
    }

    getStats(): typeof this.stats & { pendingWatchers: number; cachedTokens: number } {
        return {
            ...this.stats,
            pendingWatchers: this.orderWatchers.size,
            cachedTokens: this.tokenToMarketCache.size,
        };
    }

    /**
     * 判断 BSC WSS 连接是否健康
     * 基于 eth_blockNumber 主动探测结果，而非成交事件沉默时间
     */
    isSubscriptionHealthy(): boolean {
        if (!this.connected || this.orderWatchers.size === 0) return true;
        // 连续探测失败 → 不健康
        if (this._probeFailCount >= 2) return false;
        // 从未收到探测响应且连接已超过 2 分钟 → 不健康
        if (this._lastProbeResponseTime === 0) {
            return (Date.now() - this.stats.connectionStartTime) < 2 * HEALTH_CHECK_INTERVAL_MS;
        }
        return true;
    }

    // ============================================================================
    // Watch API
    // ============================================================================

    /**
     * 监听特定订单的成交事件（支持多个 callback；不会自动删除 entry）
     * 返回取消函数：用于移除此 callback
     */
    watchOrder(orderHash: string, callback: OrderWatchCallback, timeoutMs: number = 60000): () => void {
        const key = orderHash.toLowerCase();

        let entry = this.orderWatchers.get(key);
        if (!entry) {
            entry = { callbacks: new Set(), createdAt: Date.now(), fillCount: 0 };
            this.orderWatchers.set(key, entry);
        }

        entry.callbacks.add(callback);

        // timeoutMs <= 0 表示不超时（Maker 订单可存活数小时甚至更久）
        const timer = timeoutMs > 0
            ? setTimeout(() => { this.unwatchOrderCallback(key, callback); }, timeoutMs)
            : null;

        return () => {
            if (timer) clearTimeout(timer);
            this.unwatchOrderCallback(key, callback);
        };
    }

    waitForOrderFilled(orderHash: string, timeoutMs: number = 60000): Promise<OrderFilledEvent | null> {
        return new Promise((resolve) => {
            let resolved = false;

            const cancel = this.watchOrder(orderHash, (event) => {
                if (resolved) return;
                resolved = true;
                cancel();
                resolve(event);
            }, timeoutMs);

            setTimeout(() => {
                if (resolved) return;
                resolved = true;
                cancel();
                resolve(null);
            }, timeoutMs);
        });
    }

    private unwatchOrderCallback(orderHashLower: string, callback: OrderWatchCallback): void {
        const entry = this.orderWatchers.get(orderHashLower);
        if (!entry) return;
        entry.callbacks.delete(callback);
        if (entry.callbacks.size === 0) {
            this.orderWatchers.delete(orderHashLower);
        }
    }

    /**
     * 取消订单监控（实现 IOrderWatcher 接口）
     */
    unwatchOrder(orderHash: string, callback?: OrderWatchCallback): void {
        const key = orderHash.toLowerCase();
        if (callback) {
            this.unwatchOrderCallback(key, callback);
        } else {
            // 如果没有指定 callback，删除所有 watchers
            this.orderWatchers.delete(key);
        }
    }

    // ============================================================================
    // Token mapping
    // ============================================================================

    setTokenMarketMappings(markets: MarketTokenInfo[]): void {
        // 防止长期运行缓存累积旧 token
        this.tokenToMarketCache = new Map();
        for (const market of markets) {
            if (market.yesTokenId) this.tokenToMarketCache.set(market.yesTokenId, market);
            if (market.noTokenId) this.tokenToMarketCache.set(market.noTokenId, market);
        }
    }

    getMarketByTokenId(tokenId: string): { market: MarketTokenInfo; side: 'YES' | 'NO' } | null {
        const market = this.tokenToMarketCache.get(tokenId);
        if (!market) return null;
        const side = market.yesTokenId === tokenId ? 'YES' : 'NO';
        return { market, side };
    }

    parseMarketFromEvent(event: OrderFilledEvent): { market: MarketTokenInfo; side: 'YES' | 'NO' } | null {
        if (event.makerAssetId === '0') return this.getMarketByTokenId(event.takerAssetId);
        if (event.takerAssetId === '0') return this.getMarketByTokenId(event.makerAssetId);
        return null;
    }

    // ============================================================================
    // Connection
    // ============================================================================

    private async connect(): Promise<void> {
        if (!this.shouldReconnect) return;

        const wssUrl = this.wssUrls[this.currentWssIndex];
        const connectStartTime = Date.now();

        console.log(`[BSC WSS] 正在连接: ${wssUrl} (节点 ${this.currentWssIndex + 1}/${this.wssUrls.length})`);

        await new Promise<void>((resolve, reject) => {
            let settled = false;
            try {
                this.ws = new WebSocket(wssUrl);
            } catch (e: any) {
                console.error(`[BSC WSS] WebSocket 创建失败: ${e?.message || e}`);
                this.scheduleReconnect();
                settled = true;
                reject(e);
                return;
            }

            const connectTimeout = setTimeout(() => {
                if (this.connected) return;
                const elapsed = Date.now() - connectStartTime;
                console.warn(`[BSC WSS] 连接超时 (${elapsed}ms): ${wssUrl}`);
                try { this.ws?.terminate(); } catch { /* ignore */ }
                this.scheduleReconnect();
                if (!settled) {
                    settled = true;
                    reject(new Error(`BSC WSS connect timeout after ${elapsed}ms: ${wssUrl}`));
                }
            }, DEFAULT_CONNECT_TIMEOUT_MS);

            this.ws.on('open', async () => {
                clearTimeout(connectTimeout);
                const elapsed = Date.now() - connectStartTime;
                this.connected = true;
                this.reconnectAttempts = 0;
                this.stats.connectionStartTime = Date.now();

                console.log(`[BSC WSS] 连接成功 (${elapsed}ms): ${wssUrl}`);

                await this.subscribeToOrderFilled();
                this.startPing();
                this.startHealthCheck();
                this.emit('connected');
                settled = true;
                resolve();
            });

            this.ws.on('message', (data) => this.handleMessage(data.toString()));

            this.ws.on('error', (err: any) => {
                clearTimeout(connectTimeout);
                const elapsed = Date.now() - connectStartTime;
                const errorMsg = err?.message || String(err);
                console.error(`[BSC WSS] 连接错误 (${elapsed}ms): ${errorMsg}`);
                const error = err instanceof Error ? err : new Error(errorMsg);
                this.emit('error', error);
                if (!settled) {
                    settled = true;
                    reject(error);
                }
            });

            this.ws.on('close', (code, reason) => {
                clearTimeout(connectTimeout);
                const elapsed = Date.now() - connectStartTime;
                this.connected = false;
                this.subscriptionId = null;
                this.stopPing();
                this.stopHealthCheck();
                console.log(`[BSC WSS] 连接关闭 (${elapsed}ms): code=${code}, reason=${reason?.toString() || 'none'}`);
                this.emit('disconnected');
                if (this.shouldReconnect) this.scheduleReconnect();
                if (!settled) {
                    settled = true;
                    reject(new Error(`BSC WSS closed before open: code=${code}`));
                }
            });
        });
    }

    private async subscribeToOrderFilled(): Promise<void> {
        if (!this.ws || !this.connected) return;

        const addresses = Object.values(PREDICT_EXCHANGES).map(a => a.toLowerCase());

        // 将地址填充为 32 字节 (topic 格式)
        // 0x + 24个0 + 40位地址 = 66字符
        const paddedAddress = '0x' + '0'.repeat(24) + this.smartWalletAddress.slice(2).toLowerCase();

        // OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, ...)
        // topic[0] = 事件签名
        // topic[1] = orderHash (不过滤)
        // topic[2] = maker
        // topic[3] = taker

        // 订阅 1: maker = 我的地址 (我是 maker，卖单成交)
        const makerRequest = {
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_subscribe',
            params: [
                'logs',
                {
                    address: addresses,
                    topics: [ORDER_FILLED_TOPIC, null, paddedAddress],  // topic[2] = maker
                },
            ],
        };

        // 订阅 2: taker = 我的地址 (我是 taker，吃单成交)
        const takerRequest = {
            jsonrpc: '2.0',
            id: 2,
            method: 'eth_subscribe',
            params: [
                'logs',
                {
                    address: addresses,
                    topics: [ORDER_FILLED_TOPIC, null, null, paddedAddress],  // topic[3] = taker
                },
            ],
        };

        console.log(`[BSC WSS] 订阅地址: ${this.smartWalletAddress}`);

        try {
            this.ws.send(JSON.stringify(makerRequest));
            this.ws.send(JSON.stringify(takerRequest));
        } catch {
            // ignore
        }
    }

    private handleMessage(data: string): void {
        let msg: any;
        try {
            msg = JSON.parse(data);
        } catch {
            return;
        }

        // 健康探测响应 (id: 999)
        if (msg?.id === 999 && msg?.result !== undefined) {
            this._lastProbeResponseTime = Date.now();
            this._pendingProbeId = null;
            this._probeFailCount = 0;
            return;
        }

        // subscribe ack (id: 1 = maker, id: 2 = taker)
        if ((msg?.id === 1 || msg?.id === 2) && msg?.result) {
            const subType = msg.id === 1 ? 'maker' : 'taker';
            console.log(`[BSC WSS] 订阅成功 (${subType}): subscriptionId=${msg.result}`);
            this.lastSubscribeAckTime = Date.now();
            // 保存第一个订阅 ID (用于兼容)
            if (!this.subscriptionId) {
                this.subscriptionId = msg.result;
            }
            return;
        }

        // subscribe error
        if ((msg?.id === 1 || msg?.id === 2) && msg?.error) {
            const subType = msg.id === 1 ? 'maker' : 'taker';
            console.error(`[BSC WSS] 订阅失败 (${subType}): ${msg.error.message}`);
            return;
        }

        if (msg?.method === 'eth_subscription' && msg?.params?.result) {
            this.handleLogEvent(msg.params.result);
        }
    }

    private handleLogEvent(log: any): void {
        const timestamp = Date.now();
        this.stats.totalEventsReceived++;
        this.stats.lastEventTime = timestamp;
        this._resubscribeStaleCount = 0; // 收到事件，重置 stale 计数

        // ===== 去重: 防止 WS 重连时重放旧区块事件 =====
        const dedupKey = `${log.transactionHash}:${safeParseInt(log.logIndex)}`;
        if (this.processedLogs.has(dedupKey)) {
            console.log(`[BSC WSS] 跳过重复日志: ${dedupKey}`);
            return;
        }
        this.processedLogs.set(dedupKey, timestamp);

        let decoded: any;
        try {
            decoded = orderFilledInterface.parseLog({ topics: log.topics, data: log.data });
        } catch {
            return;
        }
        if (!decoded) return;

        const event: OrderFilledEvent = {
            orderHash: decoded.args[0],
            maker: decoded.args[1],
            taker: decoded.args[2],
            makerAssetId: decoded.args[3].toString(),
            takerAssetId: decoded.args[4].toString(),
            makerAmountFilled: Number(formatUnits(decoded.args[5], 18)),
            takerAmountFilled: Number(formatUnits(decoded.args[6], 18)),
            fee: Number(formatUnits(decoded.args[7], 18)),
            blockNumber: safeParseInt(log.blockNumber),
            txHash: log.transactionHash,
            logIndex: safeParseInt(log.logIndex),
            timestamp,
            exchange: log.address,
        };

        const isOurOrder =
            event.maker.toLowerCase() === this.smartWalletAddress ||
            event.taker.toLowerCase() === this.smartWalletAddress;

        if (isOurOrder) this.stats.ownOrdersFilled++;

        this.emit('orderFilled', event);

        const key = event.orderHash.toLowerCase();
        const entry = this.orderWatchers.get(key);
        if (entry) {
            entry.fillCount++;
            for (const callback of entry.callbacks) {
                try { callback(event); } catch { /* ignore */ }
            }
        }
    }

    private startPing(): void {
        this.stopPing();
        this.pingTimer = setInterval(() => {
            if (!this.ws || !this.connected) return;
            try {
                this.ws.send(JSON.stringify({
                    jsonrpc: '2.0',
                    id: 'ping',
                    method: 'net_version',
                    params: [],
                }));
            } catch {
                // ignore
            }
        }, PING_INTERVAL_MS);
    }

    private stopPing(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    /**
     * 启动订阅健康检查定时器
     * 当有活跃 watcher 且超过 MAX_SILENCE_MS 未收到事件时：
     * 1. 尝试在当前连接重新发送 eth_subscribe
     * 2. 等待 ACK，若无响应则强制断开重连
     */
    private startHealthCheck(): void {
        this.stopHealthCheck();
        this.healthCheckTimer = setInterval(() => {
            this.runHealthCheck();
        }, HEALTH_CHECK_INTERVAL_MS);
    }

    private stopHealthCheck(): void {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }

    private startLogCleanup(): void {
        if (this.logCleanupTimer) return;
        this.logCleanupTimer = setInterval(() => {
            const cutoff = Date.now() - BscOrderWatcher.LOG_DEDUP_TTL_MS;
            let removed = 0;
            for (const [key, ts] of this.processedLogs) {
                if (ts < cutoff) {
                    this.processedLogs.delete(key);
                    removed++;
                }
            }
            if (removed > 0) {
                console.log(`[BSC WSS] 清理 ${removed} 条过期去重记录，剩余 ${this.processedLogs.size} 条`);
            }
        }, BscOrderWatcher.LOG_CLEANUP_INTERVAL_MS);
    }

    private stopLogCleanup(): void {
        if (this.logCleanupTimer) {
            clearInterval(this.logCleanupTimer);
            this.logCleanupTimer = null;
        }
    }

    private runHealthCheck(): void {
        // 没有活跃 watcher 时跳过
        if (this.orderWatchers.size === 0) return;
        if (!this.connected || !this.ws) return;

        // ===== 主动探测: 通过 eth_blockNumber RPC 检测节点是否存活 =====
        // 不再依赖成交事件沉默时间 (低交易频率时几小时无成交是正常的)

        // 检查上一次探测是否超时未响应
        if (this._pendingProbeId !== null) {
            this._probeFailCount++;
            if (this._probeFailCount >= 2) {
                // 连续 2 次探测无响应 (~2 分钟)，节点已死，断连轮换
                console.warn(`[BSC WSS] 健康探测连续 ${this._probeFailCount} 次无响应，强制断连轮换节点`);
                this._probeFailCount = 0;
                this._pendingProbeId = null;
                this.forceDisconnectAndReconnect();
                return;
            }
            console.warn(`[BSC WSS] 健康探测无响应 (failCount=${this._probeFailCount})，等待下次检查`);
        }

        // 发送新的探测
        this._pendingProbeId = Date.now();
        try {
            this.ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id: 999,
                method: 'eth_blockNumber',
                params: [],
            }));
        } catch {
            // WS 发送失败，连接可能已断
            console.warn(`[BSC WSS] 健康探测发送失败，强制断连轮换`);
            this._pendingProbeId = null;
            this.forceDisconnectAndReconnect();
        }
    }

    /** 强制断开当前连接并触发节点轮换重连 */
    private forceDisconnectAndReconnect(): void {
        this.connected = false;
        this.subscriptionId = null;
        this.stopPing();
        this.stopHealthCheck();
        try { this.ws?.terminate(); } catch { /* ignore */ }
        this.ws = null;
        this.emit('disconnected');
        if (this.shouldReconnect) this.scheduleReconnect();
    }

    private scheduleReconnect(): void {
        if (!this.shouldReconnect) return;
        if (this.reconnectTimer) return;

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            // 发出告警但不放弃 — 重置计数器，60s 后重新开始轮换
            console.error(`[BSC WSS] ${this.maxReconnectAttempts} 次重连全部失败，60s 后重新轮换`);
            this.emit('maxReconnectAttemptsReached');
            this.reconnectAttempts = 0;
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                if (!this.shouldReconnect) return;
                this.connect().catch(() => { /* ignore */ });
            }, 60_000);
            return;
        }

        this.reconnectAttempts++;
        this.currentWssIndex = (this.currentWssIndex + 1) % this.wssUrls.length;

        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.shouldReconnect) return;
            this.connect().catch(() => { /* ignore */ });
        }, delay);
    }

    private cleanup(): void {
        this.stopPing();
        this.stopHealthCheck();
        this.stopLogCleanup();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.orderWatchers.clear();

        if (this.ws) {
            try { this.ws.close(); } catch { /* ignore */ }
            this.ws = null;
        }

        this.connected = false;
        this.subscriptionId = null;
    }
}

// ============================================================================
// Singleton
// ============================================================================

let globalWatcher: BscOrderWatcher | null = null;

export function getBscOrderWatcher(smartWalletAddress?: string): BscOrderWatcher {
    if (!globalWatcher) {
        const address = smartWalletAddress || process.env.PREDICT_SMART_WALLET_ADDRESS;
        if (!address) {
            throw new Error('PREDICT_SMART_WALLET_ADDRESS 未设置');
        }
        globalWatcher = new BscOrderWatcher(address);
    }
    return globalWatcher;
}

export function stopBscOrderWatcher(): void {
    if (globalWatcher) {
        globalWatcher.stop();
        globalWatcher = null;
    }
}
