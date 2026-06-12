/**
 * Polymarket User WebSocket Client
 *
 * 实时接收用户订单状态更新，用于加速订单状态确认（替代/补充 REST 轮询）。
 *
 * 注意：
 * - 该 client 采用“多订阅者”模式（addXxxListener/removeXxxListener），避免多个模块互相覆盖 handlers。
 * - waitForOrderEvent/waitForOrderFinal 使用按 orderId 的局部监听器。
 */

import WebSocket from 'ws';

function getPositiveNumberEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getPositiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeNonNegativeNumber(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

// ============================================================================
// 常量 / 配置
// ============================================================================

const DEFAULT_WS_USER_URL = (process.env.POLYMARKET_USER_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/user').trim();
const DEFAULT_PING_INTERVAL_MS = getPositiveNumberEnv('POLYMARKET_USER_WS_PING_INTERVAL_MS', 10000);
const DEFAULT_RECONNECT_DELAY_MS = getPositiveNumberEnv('POLYMARKET_USER_WS_RECONNECT_DELAY_MS', 5000);
const DEFAULT_MAX_RECONNECT_ATTEMPTS = getPositiveIntegerEnv('POLYMARKET_USER_WS_MAX_RECONNECT_ATTEMPTS', 5);
const DEFAULT_CONNECT_TIMEOUT_MS = getPositiveNumberEnv('POLYMARKET_USER_WS_CONNECT_TIMEOUT_MS', 10000);
const DEFAULT_RECONNECT_BACKOFF_MULTIPLIER = getPositiveNumberEnv('POLYMARKET_USER_WS_RECONNECT_BACKOFF', 1.5);
const DEFAULT_RECONNECT_MAX_DELAY_MS = getPositiveNumberEnv('POLYMARKET_USER_WS_RECONNECT_MAX_DELAY_MS', 30000);

// ============================================================================
// 类型定义
// ============================================================================

export interface UserWsAuth {
    apiKey: string;
    secret: string;
    passphrase: string;
}

export interface OrderEvent {
    event_type: 'order';
    type: 'PLACEMENT' | 'UPDATE' | 'CANCELLATION';
    id: string;           // order ID
    market: string;       // condition ID
    asset_id: string;     // token ID
    side: 'BUY' | 'SELL';
    price: string;
    original_size: string;
    size_matched: string;
    timestamp: string;
}

export interface TradeEvent {
    event_type: 'trade';
    type: 'TRADE';
    status: 'MATCHED' | 'MINED' | 'CONFIRMED' | 'RETRYING' | 'FAILED';
    taker_order_id: string;
    maker_orders: Array<{
        order_id: string;
        matched_amount: string;
    }>;
    price: string;
    side: 'BUY' | 'SELL';
    size: string;
    timestamp: string;
}

export type UserEvent = OrderEvent | TradeEvent;

export type OrderEventHandler = (event: OrderEvent) => void;
export type TradeEventHandler = (event: TradeEvent) => void;
export type ConnectHandler = () => void;
export type DisconnectHandler = (code: number, reason: string) => void;
export type ErrorHandler = (error: Error) => void;

export interface PolymarketUserWsClientConfig {
    url?: string;
    pingIntervalMs?: number;
    reconnectDelayMs?: number;
    maxReconnectAttempts?: number;
    connectTimeoutMs?: number;
    reconnectBackoffMultiplier?: number;
    reconnectMaxDelayMs?: number;
}

export type UserWsFinalStatus = 'MATCHED' | 'CANCELLED' | 'TIMEOUT' | 'LIVE';

// ============================================================================
// PolymarketUserWsClient
// ============================================================================

export class PolymarketUserWsClient {
    private readonly auth: UserWsAuth;
    private readonly url: string;
    private readonly pingIntervalMs: number;
    private readonly reconnectDelayMs: number;
    private readonly maxReconnectAttempts: number;
    private readonly connectTimeoutMs: number;
    private readonly reconnectBackoffMultiplier: number;
    private readonly reconnectMaxDelayMs: number;

    private ws: WebSocket | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    private reconnectAttempts = 0;
    private isConnecting = false;
    private isConnected = false;
    private shouldReconnect = true;

    // ws heartbeat (ping/pong)
    private isAlive = true;

    // Recent events cache (解决“事件先到、orderId 后拿到”的竞态；用于 waitFor* 快速命中)
    private readonly recentEventTtlMs = 60_000;
    private recentOrderEventById: Map<string, { event: OrderEvent; receivedAt: number }> = new Map();
    private recentTradeEventByOrderId: Map<string, { event: TradeEvent; receivedAt: number }> = new Map();

    // 订单局部监听器 (orderId -> callbacks) - waitForOrderEvent/waitForOrderFinal 使用
    private orderListeners: Map<string, Set<(event: OrderEvent) => void>> = new Map();

    // 全局事件监听器 (多订阅者模式)
    private listenerIdCounter = 0;
    private orderEventListeners: Map<string, OrderEventHandler> = new Map();
    private tradeEventListeners: Map<string, TradeEventHandler> = new Map();
    private connectListeners: Map<string, ConnectHandler> = new Map();
    private disconnectListeners: Map<string, DisconnectHandler> = new Map();
    private errorListeners: Map<string, ErrorHandler> = new Map();

    constructor(auth: UserWsAuth, config: PolymarketUserWsClientConfig = {}) {
        this.auth = auth;
        this.url = config.url ?? DEFAULT_WS_USER_URL;
        this.pingIntervalMs = normalizePositiveNumber(config.pingIntervalMs, DEFAULT_PING_INTERVAL_MS);
        this.reconnectDelayMs = normalizePositiveNumber(config.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS);
        this.maxReconnectAttempts = normalizePositiveInteger(config.maxReconnectAttempts, DEFAULT_MAX_RECONNECT_ATTEMPTS);
        this.connectTimeoutMs = normalizePositiveNumber(config.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
        this.reconnectBackoffMultiplier = normalizePositiveNumber(
            config.reconnectBackoffMultiplier,
            DEFAULT_RECONNECT_BACKOFF_MULTIPLIER
        );
        this.reconnectMaxDelayMs = normalizeNonNegativeNumber(config.reconnectMaxDelayMs, DEFAULT_RECONNECT_MAX_DELAY_MS);
    }

    // ============================================================================
    // Public API - listeners
    // ============================================================================

    addOrderEventListener(handler: OrderEventHandler): string {
        const id = `order_${++this.listenerIdCounter}`;
        this.orderEventListeners.set(id, handler);
        return id;
    }

    removeOrderEventListener(listenerId: string): boolean {
        return this.orderEventListeners.delete(listenerId);
    }

    addTradeEventListener(handler: TradeEventHandler): string {
        const id = `trade_${++this.listenerIdCounter}`;
        this.tradeEventListeners.set(id, handler);
        return id;
    }

    removeTradeEventListener(listenerId: string): boolean {
        return this.tradeEventListeners.delete(listenerId);
    }

    addConnectListener(handler: ConnectHandler): string {
        const id = `connect_${++this.listenerIdCounter}`;
        this.connectListeners.set(id, handler);
        return id;
    }

    removeConnectListener(listenerId: string): boolean {
        return this.connectListeners.delete(listenerId);
    }

    addDisconnectListener(handler: DisconnectHandler): string {
        const id = `disconnect_${++this.listenerIdCounter}`;
        this.disconnectListeners.set(id, handler);
        return id;
    }

    removeDisconnectListener(listenerId: string): boolean {
        return this.disconnectListeners.delete(listenerId);
    }

    addErrorListener(handler: ErrorHandler): string {
        const id = `error_${++this.listenerIdCounter}`;
        this.errorListeners.set(id, handler);
        return id;
    }

    removeErrorListener(listenerId: string): boolean {
        return this.errorListeners.delete(listenerId);
    }

    /**
     * 设置事件处理器（兼容旧接口；内部转为多订阅者模式）
     * @deprecated 使用 addXxxListener/removeXxxListener 代替
     * @returns 监听器 ID 列表，便于调用方自行移除
     */
    setHandlers(handlers: {
        onOrderEvent?: OrderEventHandler;
        onTradeEvent?: TradeEventHandler;
        onConnect?: ConnectHandler;
        onDisconnect?: DisconnectHandler;
        onError?: ErrorHandler;
    }): string[] {
        const ids: string[] = [];
        if (handlers.onOrderEvent) ids.push(this.addOrderEventListener(handlers.onOrderEvent));
        if (handlers.onTradeEvent) ids.push(this.addTradeEventListener(handlers.onTradeEvent));
        if (handlers.onConnect) ids.push(this.addConnectListener(handlers.onConnect));
        if (handlers.onDisconnect) ids.push(this.addDisconnectListener(handlers.onDisconnect));
        if (handlers.onError) ids.push(this.addErrorListener(handlers.onError));
        return ids;
    }

    // ============================================================================
    // Public API - connect lifecycle
    // ============================================================================

    connected(): boolean {
        return this.isConnected;
    }

    async connect(): Promise<void> {
        if (this.isConnected || this.isConnecting) return;

        this.isConnecting = true;
        this.shouldReconnect = true;
        this.isAlive = true;

        await new Promise<void>((resolve, reject) => {
            let settled = false;
            let connectTimeout: ReturnType<typeof setTimeout> | null = null;
            const cleanupConnectTimeout = () => {
                if (connectTimeout) clearTimeout(connectTimeout);
                connectTimeout = null;
            };

            try {
                this.ws = new WebSocket(this.url);
            } catch (e) {
                this.isConnecting = false;
                settled = true;
                reject(e);
                return;
            }

            connectTimeout = setTimeout(() => {
                if (!this.isConnected) {
                    try { this.ws?.terminate(); } catch { /* ignore */ }
                    this.isConnecting = false;
                    if (!settled) {
                        settled = true;
                        reject(new Error('User WS connection timeout'));
                    }
                }
            }, this.connectTimeoutMs);

            this.ws.on('open', () => {
                cleanupConnectTimeout();

                const subscribeMsg = {
                    type: 'user',
                    markets: [],
                    auth: {
                        apiKey: this.auth.apiKey,
                        secret: this.auth.secret,
                        passphrase: this.auth.passphrase,
                    },
                };

                try {
                    this.ws?.send(JSON.stringify(subscribeMsg));
                } catch (e) {
                    this.isConnecting = false;
                    reject(e);
                    return;
                }

                this.isConnecting = false;
                this.isConnected = true;
                this.reconnectAttempts = 0;

                this.startPing();
                for (const [, handler] of this.connectListeners) {
                    try { handler(); } catch { /* ignore */ }
                }
                settled = true;
                resolve();
            });

            this.ws.on('message', (data) => {
                this.handleMessage(data.toString());
            });

            this.ws.on('pong', () => {
                this.isAlive = true;
            });

            this.ws.on('error', (err: any) => {
                cleanupConnectTimeout();
                const error = err instanceof Error ? err : new Error(String(err?.message || 'WebSocket error'));
                this.notifyError(error);
                if (this.isConnecting) {
                    this.isConnecting = false;
                    if (!settled) {
                        settled = true;
                        reject(error);
                    }
                }
            });

            this.ws.on('close', (code: number, reason: Buffer) => {
                cleanupConnectTimeout();
                this.stopPing();

                const wasConnected = this.isConnected;
                this.isConnected = false;
                this.isConnecting = false;
                this.ws = null;

                for (const [, handler] of this.disconnectListeners) {
                    try { handler(code, reason.toString()); } catch { /* ignore */ }
                }

                if (wasConnected && this.shouldReconnect) {
                    this.scheduleReconnect();
                }

                if (!wasConnected && !settled) {
                    settled = true;
                    reject(new Error(`User WS closed before open (${code} ${reason.toString()})`));
                }
            });
        });
    }

    disconnect(): void {
        this.shouldReconnect = false;
        this.stopPing();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            try { this.ws.close(1000, 'Manual disconnect'); } catch { /* ignore */ }
            this.ws = null;
        }

        this.isConnected = false;
        this.isConnecting = false;
        this.orderListeners.clear();
    }

    // ============================================================================
    // Public API - order waits
    // ============================================================================

    waitForOrderEvent(orderId: string, timeoutMs: number = 5000): Promise<OrderEvent | null> {
        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                this.removeOrderListener(orderId, callback);
                resolve(null);
            }, timeoutMs);

            const callback = (event: OrderEvent) => {
                clearTimeout(timeoutId);
                this.removeOrderListener(orderId, callback);
                resolve(event);
            };

            this.addOrderListener(orderId, callback);
        });
    }

    async waitForOrderFinal(
        orderId: string,
        timeoutMs: number = 5000,
        tradeWindowMs: number = 2000
    ): Promise<{ status: UserWsFinalStatus; filledQty: number }> {
        return new Promise((resolve) => {
            // 先检查近期事件缓存：可能 WS 事件已经到达，但 placeOrder 的 HTTP 响应还没返回 orderId
            const cachedOrder = this.getRecentOrderEvent(orderId);
            if (cachedOrder) {
                const matched = parseFloat(cachedOrder.size_matched || '0');
                const cachedFilledQty = Number.isFinite(matched) ? matched : 0;
                if (cachedOrder.type === 'CANCELLATION') {
                    resolve({ status: 'CANCELLED', filledQty: cachedFilledQty });
                    return;
                }
                if (cachedOrder.type === 'UPDATE') {
                    const original = parseFloat(cachedOrder.original_size || '0');
                    if (Number.isFinite(original) && original > 0 && cachedFilledQty >= original) {
                        resolve({ status: 'MATCHED', filledQty: cachedFilledQty });
                        return;
                    }
                }
            }

            const cachedTrade = this.getRecentTradeEvent(orderId);
            if (cachedTrade) {
                // TRADE 已在缓存 → 有成交，立即返回 LIVE（最快路径）
                // avgPrice 由并行 REST 路径补全，不阻塞主流程
                const size = parseFloat(cachedTrade.size || '0');
                const cachedFilledQty = Number.isFinite(size) ? size : 0;
                resolve({ status: 'LIVE', filledQty: cachedFilledQty });
                return;
            }

            let filledQty = 0;
            let hasReceivedAnyEvent = false;
            let timeoutId: ReturnType<typeof setTimeout>;
            let tradeListenerId: string | null = null;

            const cleanup = () => {
                clearTimeout(timeoutId);
                this.removeOrderListener(orderId, callback);
                if (tradeListenerId) this.removeTradeEventListener(tradeListenerId);
            };

            const callback = (event: OrderEvent) => {
                hasReceivedAnyEvent = true;
                const matched = parseFloat(event.size_matched || '0');
                filledQty = Number.isFinite(matched) ? matched : filledQty;

                if (event.type === 'CANCELLATION') {
                    cleanup();
                    resolve({ status: 'CANCELLED', filledQty });
                    return;
                }

                if (event.type === 'UPDATE') {
                    const original = parseFloat(event.original_size || '0');
                    if (Number.isFinite(original) && original > 0 && filledQty >= original) {
                        cleanup();
                        resolve({ status: 'MATCHED', filledQty });
                        return;
                    }
                }
            };

            this.addOrderListener(orderId, callback);
            tradeListenerId = this.addTradeEventListener((event: TradeEvent) => {
                if (event.taker_order_id !== orderId) return;
                hasReceivedAnyEvent = true;
                const size = parseFloat(event.size || '0');
                // trade event 的 size 是单笔成交量，需要累加（IOC 可能分多笔成交）
                if (Number.isFinite(size) && size > 0) filledQty += size;
                // 不立即 resolve：等待后续 trade 或 order 终态事件。
                // 重置 timeout 给后续成交留窗口。
                clearTimeout(timeoutId);
                timeoutId = setTimeout(() => {
                    cleanup();
                    resolve({ status: 'LIVE', filledQty });
                }, Math.min(timeoutMs, tradeWindowMs));
            });

            timeoutId = setTimeout(() => {
                cleanup();
                resolve({ status: hasReceivedAnyEvent ? 'LIVE' : 'TIMEOUT', filledQty });
            }, timeoutMs);
        });
    }

    // ============================================================================
    // Internals
    // ============================================================================

    private notifyError(error: Error): void {
        for (const [, handler] of this.errorListeners) {
            try { handler(error); } catch { /* ignore */ }
        }
    }

    private handleMessage(data: string): void {
        if (data === 'PONG') {
            this.isAlive = true;
            return;
        }

        let message: any;
        try {
            message = JSON.parse(data);
        } catch {
            return;
        }

        if (Array.isArray(message) && message.length === 0) return;

        if (message?.event_type === 'order') {
            const event = message as OrderEvent;
            this.storeRecentOrderEvent(event);

            for (const [, handler] of this.orderEventListeners) {
                try { handler(event); } catch { /* ignore */ }
            }

            const listeners = this.orderListeners.get(event.id);
            if (listeners) {
                for (const listener of listeners) {
                    try { listener(event); } catch { /* ignore */ }
                }
            }
        }

        if (message?.event_type === 'trade') {
            const event = message as TradeEvent;
            this.storeRecentTradeEvent(event);
            for (const [, handler] of this.tradeEventListeners) {
                try { handler(event); } catch { /* ignore */ }
            }
        }
    }

    /**
     * 公开查询 WS 缓存中的订单成交状态 (用于 refreshSinglePolyFill 短路)
     * 返回 null 表示缓存未命中，调用方应降级到 REST poll
     */
    getCachedFillStatus(orderId: string): { filledQty: number; isTerminal: boolean } | null {
        const cached = this.recentOrderEventById.get(orderId);
        if (!cached || Date.now() - cached.receivedAt > this.recentEventTtlMs) return null;

        const event = cached.event;
        const matched = parseFloat(event.size_matched || '0');
        const filledQty = Number.isFinite(matched) ? matched : 0;
        const original = parseFloat(event.original_size || '0');

        if (event.type === 'CANCELLATION') {
            return { filledQty, isTerminal: true };
        }
        if (event.type === 'UPDATE' && original > 0 && filledQty >= original) {
            return { filledQty, isTerminal: true };
        }
        return { filledQty, isTerminal: false };
    }

    private getRecentOrderEvent(orderId: string): OrderEvent | null {
        const cached = this.recentOrderEventById.get(orderId);
        if (!cached) return null;
        if (Date.now() - cached.receivedAt > this.recentEventTtlMs) {
            this.recentOrderEventById.delete(orderId);
            return null;
        }
        return cached.event;
    }

    private getRecentTradeEvent(orderId: string): TradeEvent | null {
        const cached = this.recentTradeEventByOrderId.get(orderId);
        if (!cached) return null;
        if (Date.now() - cached.receivedAt > this.recentEventTtlMs) {
            this.recentTradeEventByOrderId.delete(orderId);
            return null;
        }
        return cached.event;
    }

    private storeRecentOrderEvent(event: OrderEvent): void {
        const id = event?.id;
        if (!id) return;
        // 保留“最近一次”即可
        this.recentOrderEventById.set(id, { event, receivedAt: Date.now() });
        this.pruneRecentCaches();
    }

    private storeRecentTradeEvent(event: TradeEvent): void {
        const orderId = event?.taker_order_id;
        if (!orderId) return;
        this.recentTradeEventByOrderId.set(orderId, { event, receivedAt: Date.now() });
        this.pruneRecentCaches();
    }

    private pruneRecentCaches(): void {
        const now = Date.now();
        for (const [id, v] of this.recentOrderEventById) {
            if (now - v.receivedAt > this.recentEventTtlMs) this.recentOrderEventById.delete(id);
        }
        for (const [id, v] of this.recentTradeEventByOrderId) {
            if (now - v.receivedAt > this.recentEventTtlMs) this.recentTradeEventByOrderId.delete(id);
        }
    }

    private addOrderListener(orderId: string, callback: (event: OrderEvent) => void): void {
        let set = this.orderListeners.get(orderId);
        if (!set) {
            set = new Set();
            this.orderListeners.set(orderId, set);
        }
        set.add(callback);
    }

    private removeOrderListener(orderId: string, callback: (event: OrderEvent) => void): void {
        const set = this.orderListeners.get(orderId);
        if (!set) return;
        set.delete(callback);
        if (set.size === 0) this.orderListeners.delete(orderId);
    }

    private startPing(): void {
        this.stopPing();
        this.isAlive = true;

        this.pingTimer = setInterval(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

            if (!this.isAlive) {
                try { this.ws.terminate(); } catch { /* ignore */ }
                return;
            }

            this.isAlive = false;
            try { this.ws.send('PING'); } catch { /* ignore */ }
        }, this.pingIntervalMs);
    }

    private stopPing(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private scheduleReconnect(): void {
        if (!this.shouldReconnect) return;
        if (this.reconnectTimer) return;

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.notifyError(new Error(`User WS max reconnect attempts reached (${this.maxReconnectAttempts})`));
            return;
        }

        this.reconnectAttempts++;
        const uncappedDelay = this.reconnectDelayMs * Math.pow(this.reconnectBackoffMultiplier, this.reconnectAttempts - 1);
        const delay = this.reconnectMaxDelayMs > 0
            ? Math.min(uncappedDelay, this.reconnectMaxDelayMs)
            : uncappedDelay;

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.shouldReconnect) return;
            this.connect().catch((err) => this.notifyError(err instanceof Error ? err : new Error(String(err))));
        }, delay);
    }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: PolymarketUserWsClient | null = null;
let instanceAuth: UserWsAuth | null = null;

function isSameAuth(a: UserWsAuth, b: UserWsAuth): boolean {
    return a.apiKey === b.apiKey && a.secret === b.secret && a.passphrase === b.passphrase;
}

export function getPolymarketUserWsClient(auth?: UserWsAuth, config?: PolymarketUserWsClientConfig): PolymarketUserWsClient {
    if (!instance) {
        if (!auth) throw new Error('Auth required for first initialization');
        instance = new PolymarketUserWsClient(auth, config);
        instanceAuth = auth;
        return instance;
    }

    if (auth && instanceAuth && !isSameAuth(auth, instanceAuth)) {
        throw new Error('PolymarketUserWsClient already initialized with different credentials');
    }

    return instance;
}

export function destroyPolymarketUserWsClient(): void {
    if (instance) {
        instance.disconnect();
        instance = null;
        instanceAuth = null;
    }
}
