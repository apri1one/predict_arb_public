/**
 * Polymarket WebSocket Client
 * 
 * Real-time order book updates via WebSocket connection
 * URL: wss://ws-subscriptions-clob.polymarket.com
 */

import type {
    WebSocketMessage,
    WebSocketOrderBookUpdate,
    WebSocketTradeUpdate,
    NormalizedOrderBook,
    OrderLevel,
    WebSocketAuth,
} from './types.js';

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

// Default configuration
const DEFAULT_WS_URL = (process.env.POLYMARKET_CLOB_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com').trim();
const DEFAULT_PING_INTERVAL = getPositiveNumberEnv('POLYMARKET_WS_PING_INTERVAL_MS', 10000);
const DEFAULT_RECONNECT_DELAY = getPositiveNumberEnv('POLYMARKET_WS_RECONNECT_DELAY_MS', 5000);
const DEFAULT_MAX_RECONNECT_ATTEMPTS = getPositiveIntegerEnv('POLYMARKET_WS_MAX_RECONNECT_ATTEMPTS', 10);
const DEFAULT_RECONNECT_BACKOFF_MULTIPLIER = getPositiveNumberEnv('POLYMARKET_WS_RECONNECT_BACKOFF', 1.5);
const DEFAULT_RECONNECT_MAX_DELAY_MS = getPositiveNumberEnv('POLYMARKET_WS_RECONNECT_MAX_DELAY_MS', 0);

export interface WebSocketClientConfig {
    url?: string;
    pingInterval?: number;
    reconnectDelay?: number;
    maxReconnectAttempts?: number;
    reconnectBackoffMultiplier?: number;
    reconnectMaxDelayMs?: number;
    auth?: WebSocketAuth;
}

export interface WebSocketEventHandlers {
    onOrderBookUpdate?: (book: NormalizedOrderBook) => void;
    onTradeUpdate?: (assetId: string, price: number, side?: 'BUY' | 'SELL', size?: number) => void;
    onConnect?: () => void;
    onDisconnect?: (code: number, reason: string) => void;
    onError?: (error: Error) => void;
    onMessage?: (message: WebSocketMessage) => void;
}

type WebSocketState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export class PolymarketWebSocketClient {
    private readonly url: string;
    private readonly pingInterval: number;
    private readonly reconnectDelay: number;
    private readonly maxReconnectAttempts: number;
    private readonly reconnectBackoffMultiplier: number;
    private readonly reconnectMaxDelayMs: number;
    private readonly auth?: WebSocketAuth;

    private ws: WebSocket | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempts = 0;
    private state: WebSocketState = 'disconnected';
    private subscribedAssets: Set<string> = new Set();
    private handlers: WebSocketEventHandlers = {};

    // 健康指标 (供 exposure_alert 快照/外部诊断使用)
    private lastMessageAt = 0;
    private totalMessages = 0;
    private totalReconnects = 0;
    private connectedSince = 0;

    // In-memory order book cache
    private orderBooks: Map<string, NormalizedOrderBook> = new Map();

    // Metadata cache for minOrderSize and tickSize
    private assetMetadata: Map<string, { minOrderSize: number; tickSize: number }> = new Map();

    // 多订阅者模式：订单簿更新监听器
    private orderBookListeners: Map<string, (book: NormalizedOrderBook) => void> = new Map();
    private listenerIdCounter = 0;

    constructor(config: WebSocketClientConfig = {}) {
        this.url = config.url || DEFAULT_WS_URL;
        this.pingInterval = normalizePositiveNumber(config.pingInterval, DEFAULT_PING_INTERVAL);
        this.reconnectDelay = normalizePositiveNumber(config.reconnectDelay, DEFAULT_RECONNECT_DELAY);
        this.maxReconnectAttempts = normalizePositiveInteger(config.maxReconnectAttempts, DEFAULT_MAX_RECONNECT_ATTEMPTS);
        this.reconnectBackoffMultiplier = normalizePositiveNumber(
            config.reconnectBackoffMultiplier,
            DEFAULT_RECONNECT_BACKOFF_MULTIPLIER
        );
        this.reconnectMaxDelayMs = normalizeNonNegativeNumber(config.reconnectMaxDelayMs, DEFAULT_RECONNECT_MAX_DELAY_MS);
        this.auth = config.auth;
    }

    // ============================================================================
    // Public API
    // ============================================================================

    /**
     * Set event handlers (全局处理器，不推荐用于单任务订阅)
     * @deprecated 推荐使用 addOrderBookListener/removeOrderBookListener 进行多订阅者管理
     */
    setHandlers(handlers: WebSocketEventHandlers): void {
        this.handlers = { ...this.handlers, ...handlers };
    }

    /**
     * 添加订单簿更新监听器 (多订阅者模式)
     * @param listener 监听回调函数
     * @param assetIdFilter 可选，只监听特定 assetId 的更新
     * @returns 监听器 ID，用于 removeOrderBookListener
     */
    addOrderBookListener(
        listener: (book: NormalizedOrderBook) => void,
        assetIdFilter?: string
    ): string {
        const id = `listener_${++this.listenerIdCounter}`;
        const wrappedListener = assetIdFilter
            ? (book: NormalizedOrderBook) => {
                if (book.assetId === assetIdFilter) {
                    listener(book);
                }
            }
            : listener;
        this.orderBookListeners.set(id, wrappedListener);
        return id;
    }

    /**
     * 移除订单簿更新监听器
     * @param listenerId 由 addOrderBookListener 返回的 ID
     * @returns 是否成功移除
     */
    removeOrderBookListener(listenerId: string): boolean {
        return this.orderBookListeners.delete(listenerId);
    }

    /**
     * 获取当前活跃的监听器数量
     */
    getListenerCount(): number {
        return this.orderBookListeners.size;
    }

    /**
     * 移除所有订单簿更新监听器 (异常兜底/清理用)
     *
     * ⚠️ 使用场景限定：
     * - dispose/销毁整个 WS 客户端时
     * - 致命错误需要完全重置时
     * - 测试环境清理时
     *
     * ⚠️ 不要用于：
     * - 普通任务清理（应使用 removeOrderBookListener）
     * - 重连场景（监听器应保留，重连后继续生效）
     *
     * @returns 移除的监听器数量
     */
    removeAllOrderBookListeners(): number {
        const count = this.orderBookListeners.size;
        this.orderBookListeners.clear();
        if (count > 0) {
            console.log(`[WS] 已清理 ${count} 个订单簿监听器`);
        }
        return count;
    }

    /**
     * Connect to WebSocket server
     */
    async connect(): Promise<void> {
        if (this.state === 'connected' || this.state === 'connecting') {
            console.log('[WS] Already connected or connecting');
            return;
        }

        return new Promise((resolve, reject) => {
            this.state = 'connecting';
            const wsUrl = `${this.url}/ws/market`;

            console.log(`[WS] Connecting to ${wsUrl}...`);

            try {
                this.ws = new WebSocket(wsUrl);
            } catch (error) {
                this.state = 'disconnected';
                reject(error);
                return;
            }

            const connectionTimeout = setTimeout(() => {
                if (this.state === 'connecting') {
                    this.ws?.close();
                    reject(new Error('Connection timeout'));
                }
            }, 30000);

            this.ws.onopen = () => {
                clearTimeout(connectionTimeout);
                this.state = 'connected';
                if (this.connectedSince === 0 || this.reconnectAttempts > 0) {
                    if (this.connectedSince > 0) this.totalReconnects++;
                    this.connectedSince = Date.now();
                }
                this.reconnectAttempts = 0;
                console.log('[WS] Connected');

                // Start ping timer
                this.startPing();

                // Re-subscribe to assets
                if (this.subscribedAssets.size > 0) {
                    this.sendSubscription([...this.subscribedAssets]);
                }

                this.handlers.onConnect?.();
                resolve();
            };

            this.ws.onmessage = (event) => {
                this.handleMessage(event.data as string);
            };

            this.ws.onerror = (event) => {
                console.error('[WS] Error:', event);
                this.handlers.onError?.(new Error('WebSocket error'));

                if (this.state === 'connecting') {
                    clearTimeout(connectionTimeout);
                    reject(new Error('WebSocket connection error'));
                }
            };

            this.ws.onclose = (event) => {
                clearTimeout(connectionTimeout);
                this.stopPing();

                const prevState = this.state;
                this.state = 'disconnected';

                console.log(`[WS] Disconnected: code=${event.code}, reason=${event.reason}`);
                this.handlers.onDisconnect?.(event.code, event.reason);

                if (prevState === 'connected') {
                    this.scheduleReconnect();
                }
            };
        });
    }

    /**
     * Disconnect from WebSocket server
     *
     * @param options.clearListeners 是否清理所有订单簿监听器
     *
     * ⚠️ clearListeners 使用场景限定：
     * - 仅用于 dispose/销毁整个客户端
     * - 仅用于致命错误需要完全重置
     *
     * ⚠️ 不要在以下场景使用 clearListeners：
     * - 正常重连（监听器应保留，重连后继续生效）
     * - 临时断开后计划重连
     *
     * 误用风险：clearListeners=true 会导致重连后监听器丢失但调用方不自知
     */
    disconnect(options?: { clearListeners?: boolean }): void {
        console.log('[WS] Disconnecting...');
        this.stopPing();
        this.clearReconnectTimer();
        this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnect

        if (this.ws) {
            this.ws.close(1000, 'Manual disconnect');
            this.ws = null;
        }

        this.state = 'disconnected';

        // 可选：清理所有监听器 (仅用于 dispose/致命错误)
        if (options?.clearListeners) {
            this.removeAllOrderBookListeners();
        }
    }

    /**
     * Subscribe to order book updates for specific asset IDs
     * 自动过滤已订阅的 assets，避免重复订阅导致 INVALID OPERATION 错误
     */
    subscribe(assetIds: string[]): void {
        // 过滤掉已订阅的 assets
        const newAssets = assetIds.filter(id => !this.subscribedAssets.has(id));
        if (newAssets.length === 0) return;

        for (const id of newAssets) {
            this.subscribedAssets.add(id);
        }

        if (this.state === 'connected') {
            this.sendSubscription(newAssets);
        }
    }

    /**
     * Unsubscribe from asset IDs
     */
    unsubscribe(assetIds: string[]): void {
        for (const id of assetIds) {
            this.subscribedAssets.delete(id);
            this.orderBooks.delete(id);
        }

        // Note: Polymarket WebSocket doesn't support unsubscribe
        // Would need to reconnect with new subscription list
        console.warn('[WS] Unsubscribe not fully supported - consider reconnecting');
    }

    /**
     * Get current order book for an asset (from cache)
     */
    getOrderBook(assetId: string): NormalizedOrderBook | undefined {
        return this.orderBooks.get(assetId);
    }

    /**
     * Get all cached order books
     */
    getAllOrderBooks(): Map<string, NormalizedOrderBook> {
        return new Map(this.orderBooks);
    }

    /**
     * Get connection state
     */
    getState(): WebSocketState {
        return this.state;
    }

    /**
     * Check if connected
     */
    isConnected(): boolean {
        return this.state === 'connected';
    }

    /**
     * Get list of subscribed assets
     */
    getSubscribedAssets(): string[] {
        return [...this.subscribedAssets];
    }

    /**
     * 健康快照: 供敞口告警等诊断写入
     */
    getHealthSnapshot(): {
        state: WebSocketState;
        connected: boolean;
        subscriptions: number;
        lastMessageAt: number;
        messageLagMs: number;
        totalMessages: number;
        totalReconnects: number;
        connectedSince: number;
        connectedDurationMs: number;
    } {
        const now = Date.now();
        return {
            state: this.state,
            connected: this.state === 'connected',
            subscriptions: this.subscribedAssets.size,
            lastMessageAt: this.lastMessageAt,
            messageLagMs: this.lastMessageAt > 0 ? now - this.lastMessageAt : -1,
            totalMessages: this.totalMessages,
            totalReconnects: this.totalReconnects,
            connectedSince: this.connectedSince,
            connectedDurationMs: this.connectedSince > 0 ? now - this.connectedSince : 0,
        };
    }

    /**
     * Set metadata for an asset (minOrderSize, tickSize)
     * Should be called after fetching initial data from REST API
     */
    setAssetMetadata(assetId: string, metadata: { minOrderSize: number; tickSize: number }): void {
        this.assetMetadata.set(assetId, metadata);
    }

    /**
     * Get metadata for an asset
     */
    getAssetMetadata(assetId: string): { minOrderSize: number; tickSize: number } | undefined {
        return this.assetMetadata.get(assetId);
    }

    // ============================================================================
    // Private Methods
    // ============================================================================

    private sendSubscription(assetIds: string[]): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            console.warn('[WS] Cannot subscribe - not connected');
            return;
        }

        // 分批订阅，每批 ≤ 50 个 token，间隔 100ms，防止服务端断连
        const BATCH_SIZE = 50;
        if (assetIds.length <= BATCH_SIZE) {
            const message = JSON.stringify({
                type: 'market',
                assets_ids: assetIds,
            });
            console.log(`[WS] Subscribing to ${assetIds.length} assets`);
            this.ws.send(message);
        } else {
            console.log(`[WS] Subscribing to ${assetIds.length} assets in batches of ${BATCH_SIZE}`);
            let batchIdx = 0;
            const sendBatch = () => {
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
                const start = batchIdx * BATCH_SIZE;
                const batch = assetIds.slice(start, start + BATCH_SIZE);
                if (batch.length === 0) return;

                const message = JSON.stringify({
                    type: 'market',
                    assets_ids: batch,
                });
                this.ws.send(message);
                batchIdx++;

                if (start + BATCH_SIZE < assetIds.length) {
                    setTimeout(sendBatch, 100);
                } else {
                    console.log(`[WS] All ${assetIds.length} assets subscribed (${batchIdx} batches)`);
                }
            };
            sendBatch();
        }
    }

    private handleMessage(data: string): void {
        this.lastMessageAt = Date.now();
        this.totalMessages++;

        // Handle PING/PONG
        if (data === 'PONG') {
            return;
        }

        // Handle error messages (plain text, not JSON)
        if (data === 'INVALID OPERATION' || data.startsWith('ERROR')) {
            // 通常是重复订阅或无效 tokenId 导致，静默忽略
            return;
        }

        try {
            const message = JSON.parse(data);

            // Handle array-style initial response
            if (Array.isArray(message)) {
                this.handleInitialResponse(message);
                return;
            }

            // Call raw message handler
            this.handlers.onMessage?.(message);

            // Handle specific message types
            if (this.isOrderBookUpdate(message)) {
                this.handleOrderBookUpdate(message);
            } else if (this.isPriceChangeUpdate(message)) {
                this.handlePriceChangeUpdate(message);
            } else if (this.isTradeUpdate(message)) {
                this.handleTradeUpdate(message);
            }
        } catch (error) {
            console.error('[WS] Failed to parse message:', error);
        }
    }

    private handleInitialResponse(response: Array<{ asset_id?: string; market?: string; bids?: any[]; asks?: any[] }>): void {
        for (const item of response) {
            if (item.asset_id && item.bids && item.asks) {
                // Get cached metadata or use defaults
                const metadata = this.assetMetadata.get(item.asset_id);

                // 解析并排序 asks (升序 - 最低价在前) 和 bids (降序 - 最高价在前)
                const asks = item.asks
                    .map((level: any) => [parseFloat(level.price), parseFloat(level.size)] as [number, number])
                    .sort((a, b) => a[0] - b[0]);
                const bids = item.bids
                    .map((level: any) => [parseFloat(level.price), parseFloat(level.size)] as [number, number])
                    .sort((a, b) => b[0] - a[0]);

                const normalized: NormalizedOrderBook = {
                    assetId: item.asset_id,
                    marketId: item.market || '',
                    updateTimestampMs: Date.now(),
                    asks,
                    bids,
                    minOrderSize: metadata?.minOrderSize ?? 0,
                    tickSize: metadata?.tickSize ?? 0,
                    isNegRisk: false,
                };

                this.orderBooks.set(item.asset_id, normalized);
                this.notifyOrderBookListeners(normalized);
            }
        }
    }

    private isOrderBookUpdate(msg: unknown): msg is WebSocketOrderBookUpdate {
        return typeof msg === 'object' && msg !== null && 'event_type' in msg && (msg as any).event_type === 'book';
    }

    private isPriceChangeUpdate(msg: unknown): boolean {
        return typeof msg === 'object' && msg !== null
            && 'event_type' in msg && (msg as any).event_type === 'price_change'
            && 'price_changes' in msg && Array.isArray((msg as any).price_changes);
    }

    private isTradeUpdate(msg: unknown): msg is WebSocketTradeUpdate {
        if (typeof msg !== 'object' || msg === null || !('event_type' in msg)) return false;
        const eventType = (msg as any).event_type;
        return eventType === 'last_trade_price'
            || (eventType === 'price_change' && !('price_changes' in msg));
    }

    private handleOrderBookUpdate(update: WebSocketOrderBookUpdate): void {
        // Get cached metadata or use defaults
        const metadata = this.assetMetadata.get(update.asset_id);

        // 解析并排序 asks (升序 - 最低价在前) 和 bids (降序 - 最高价在前)
        const asks = update.asks
            .map(level => [parseFloat(level.price), parseFloat(level.size)] as [number, number])
            .sort((a, b) => a[0] - b[0]);
        const bids = update.bids
            .map(level => [parseFloat(level.price), parseFloat(level.size)] as [number, number])
            .sort((a, b) => b[0] - a[0]);

        const normalized: NormalizedOrderBook = {
            assetId: update.asset_id,
            marketId: update.market,
            updateTimestampMs: new Date(update.timestamp).getTime(),
            asks,
            bids,
            minOrderSize: metadata?.minOrderSize ?? 0,
            tickSize: metadata?.tickSize ?? 0,
            isNegRisk: false, // Need to look up from market data
        };

        // Update cache
        this.orderBooks.set(update.asset_id, normalized);

        // Notify all listeners (多订阅者模式)
        this.notifyOrderBookListeners(normalized);
    }

    /**
     * 通知所有订单簿监听器 (内部方法)
     */
    private notifyOrderBookListeners(book: NormalizedOrderBook): void {
        // 通知全局处理器 (兼容旧 API)
        this.handlers.onOrderBookUpdate?.(book);

        // 通知所有注册的监听器
        for (const [id, listener] of this.orderBookListeners) {
            try {
                listener(book);
            } catch (err) {
                // 监听器异常不应影响其他监听器
                console.warn(`[WS] OrderBook listener ${id} error:`, err);
            }
        }
    }

    private handleTradeUpdate(update: WebSocketTradeUpdate): void {
        // Handle price_change with changes array
        if (update.changes && update.changes.length > 0) {
            for (const change of update.changes) {
                const price = parseFloat(change.price);
                const side = change.side.toUpperCase() as 'BUY' | 'SELL';
                this.handlers.onTradeUpdate?.(update.asset_id, price, side, undefined);
            }
            return;
        }

        // Handle direct price update
        if (update.price) {
            const price = parseFloat(update.price);
            const size = update.size ? parseFloat(update.size) : undefined;
            const side = update.side ? update.side.toUpperCase() as 'BUY' | 'SELL' : undefined;

            this.handlers.onTradeUpdate?.(
                update.asset_id,
                price,
                side,
                size
            );
        }
    }

    /**
     * 处理 price_change 增量更新 — 将 delta 应用到缓存订单簿并通知 listeners
     */
    private handlePriceChangeUpdate(msg: any): void {
        const priceChanges = msg.price_changes as Array<{
            asset_id?: string; price: string; size: string;
            side: string; hash?: string;
        }>;
        if (!priceChanges || priceChanges.length === 0) return;

        // 按 asset_id 分组处理，每个 asset 只通知一次 listener
        const updatedAssets = new Set<string>();

        for (const change of priceChanges) {
            const assetId = change.asset_id;
            if (!assetId || !this.subscribedAssets.has(assetId)) continue;

            const book = this.orderBooks.get(assetId);
            if (!book) continue; // 没有初始快照，跳过

            const price = parseFloat(change.price);
            const size = parseFloat(change.size);
            const side = (change.side || '').toUpperCase();

            if (side === 'BUY') {
                this.applyOrderBookDelta(book.bids, price, size, 'desc');
            } else if (side === 'SELL') {
                this.applyOrderBookDelta(book.asks, price, size, 'asc');
            }

            book.updateTimestampMs = Date.now();
            updatedAssets.add(assetId);
        }

        // 对每个更新过的 asset 通知 listeners
        for (const assetId of updatedAssets) {
            const book = this.orderBooks.get(assetId)!;
            this.notifyOrderBookListeners(book);
        }
    }

    /**
     * 原地修改 price level 数组: 更新/新增/删除
     */
    private applyOrderBookDelta(
        levels: [number, number][],
        price: number,
        size: number,
        sortOrder: 'asc' | 'desc'
    ): void {
        const idx = levels.findIndex(([p]) => Math.abs(p - price) < 1e-9);

        if (size < 1e-9) {
            // 删除
            if (idx >= 0) levels.splice(idx, 1);
        } else if (idx >= 0) {
            // 更新
            levels[idx][1] = size;
        } else {
            // 新增并插入排序位置
            if (sortOrder === 'asc') {
                const insertIdx = levels.findIndex(([p]) => p > price);
                levels.splice(insertIdx < 0 ? levels.length : insertIdx, 0, [price, size]);
            } else {
                const insertIdx = levels.findIndex(([p]) => p < price);
                levels.splice(insertIdx < 0 ? levels.length : insertIdx, 0, [price, size]);
            }
        }
    }

    private startPing(): void {
        this.stopPing();

        this.pingTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send('PING');
            }
        }, this.pingInterval);
    }

    private stopPing(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`[WS] Max reconnect attempts (${this.maxReconnectAttempts}) reached`);
            return;
        }

        this.reconnectAttempts++;
        this.state = 'reconnecting';

        const uncappedDelay = this.reconnectDelay * Math.pow(this.reconnectBackoffMultiplier, this.reconnectAttempts - 1);
        const delay = this.reconnectMaxDelayMs > 0
            ? Math.min(uncappedDelay, this.reconnectMaxDelayMs)
            : uncappedDelay;
        console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        this.reconnectTimer = setTimeout(() => {
            this.connect().catch(err => {
                console.error('[WS] Reconnect failed:', err);
            });
        }, delay);
    }
}

// ============================================================================
// Factory function for convenience
// ============================================================================

export function createWebSocketClient(
    config?: WebSocketClientConfig,
    handlers?: WebSocketEventHandlers
): PolymarketWebSocketClient {
    const client = new PolymarketWebSocketClient(config);
    if (handlers) {
        client.setHandlers(handlers);
    }
    return client;
}
