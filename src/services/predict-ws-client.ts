/**
 * Predict.fun 官方 WebSocket 客户端
 *
 * 功能:
 * - 订单簿实时订阅 (predictOrderbook/{marketId})
 * - 钱包事件订阅 (predictWalletEvents/{jwt}) - 订单状态变更
 * - 心跳维护
 *
 * 基于官方文档: https://dev.predict.fun/general-information-1915499m0.md
 */

import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

// ============================================================================
// 常量
// ============================================================================

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

function parsePredictSharesFromRaw(raw: any): number | undefined {
    const executedSizeWei = raw?.fill?.executedSizeWei;
    if (executedSizeWei !== undefined && executedSizeWei !== null) {
        try {
            const value = Number(BigInt(String(executedSizeWei)) / 10n ** 12n) / 1e6;
            if (Number.isFinite(value) && value > 0) return value;
        } catch {
            // ignore
        }
    }

    const candidates = [
        raw?.filledQty,
        raw?.filled_qty,
        raw?.quantityFilled,
        raw?.details?.quantityFilled,
    ];

    for (const candidate of candidates) {
        if (candidate === undefined || candidate === null || candidate === '') continue;
        const num = Number(candidate);
        if (Number.isFinite(num) && num > 0) return num;
        try {
            const asWei = Number(BigInt(String(candidate)) / 10n ** 12n) / 1e6;
            if (Number.isFinite(asWei) && asWei > 0) return asWei;
        } catch {
            // ignore
        }
    }

    return undefined;
}

const WS_URL = 'wss://ws.predict.fun/ws';
const HEARTBEAT_INTERVAL_MS = 15000; // 服务器每 15 秒发心跳
const SUBSCRIBE_TIMEOUT_MS = 10000;
const DEFAULT_WS_URL = (process.env.PREDICT_WS_URL || WS_URL).trim();
const DEFAULT_AUTO_RECONNECT = process.env.PREDICT_WS_AUTO_RECONNECT !== 'false';
const DEFAULT_RECONNECT_DELAY_MS = getPositiveNumberEnv('PREDICT_WS_RECONNECT_DELAY_MS', 3000);
const DEFAULT_MAX_RECONNECT_ATTEMPTS = getPositiveIntegerEnv('PREDICT_WS_MAX_RECONNECT_ATTEMPTS', 5);
const DEFAULT_MAX_RECONNECT_DELAY_MS = getPositiveNumberEnv('PREDICT_WS_RECONNECT_MAX_DELAY_MS', 0);

// ============================================================================
// 类型定义
// ============================================================================

export interface PredictWsConfig {
    apiKey: string;
    jwt?: string; // 用于 predictWalletEvents 订阅
    autoReconnect?: boolean;
    wsUrl?: string;
    reconnectDelayMs?: number;
    maxReconnectAttempts?: number;
    maxReconnectDelayMs?: number;
}

// 订单簿更新消息
export interface OrderbookUpdateData {
    marketId: number;
    updateTimestampMs: number;
    bids: [number, number][]; // [price, size][]
    asks: [number, number][];
}

// 钱包事件类型
export type WalletEventType =
    | 'ORDER_ACCEPTED'      // 订单被接受
    | 'ORDER_REJECTED'      // 订单被拒绝
    | 'ORDER_FILLED'        // 订单完全成交
    | 'ORDER_PARTIALLY_FILLED'  // 订单部分成交
    | 'ORDER_CANCELLED'     // 订单被取消
    | 'ORDER_EXPIRED'       // 订单过期
    | 'ORDER_TX_PENDING'    // 链上交易已提交（待确认）
    | 'ORDER_TX_CONFIRMED'  // 链上交易成功确认
    | 'ORDER_TX_FAILED';    // 链上交易失败

// 钱包事件数据
export interface WalletEventData {
    type: WalletEventType;
    orderHash: string;
    orderId?: string;
    marketId?: number;
    filledQty?: number;
    remainingQty?: number;
    avgPrice?: number;
    txHash?: string;
    reason?: string;
    timestamp: number;
    rawData?: unknown;
}

// WebSocket 消息类型
interface WsMessage {
    type?: 'R' | 'M';  // R=响应, M=推送
    requestId?: number;
    topic?: string;
    success?: boolean;
    data?: unknown;
    error?: { code: string; message: string };
    method?: string;  // heartbeat
}

// ============================================================================
// PredictWsClient
// ============================================================================

export class PredictWsClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private config: PredictWsConfig;
    private connected = false;
    private shouldReconnect = true;
    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private lastHeartbeatTime = 0;

    // 订阅管理
    private requestId = 1;
    private pendingRequests = new Map<number, {
        resolve: (success: boolean) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
    }>();
    private subscribedTopics = new Set<string>();

    // 订单簿回调
    private orderbookCallbacks = new Map<number, Set<(data: OrderbookUpdateData) => void>>();
    // 钱包事件回调
    private walletEventCallbacks = new Set<(event: WalletEventData) => void>();

    // 统计
    private stats = {
        totalMessages: 0,
        orderbookUpdates: 0,
        walletEvents: 0,
        lastMessageTime: 0,
        connectionStartTime: 0,
        heartbeatsMissed: 0,
    };

    constructor(config: PredictWsConfig) {
        super();
        this.config = {
            autoReconnect: DEFAULT_AUTO_RECONNECT,
            wsUrl: DEFAULT_WS_URL,
            reconnectDelayMs: DEFAULT_RECONNECT_DELAY_MS,
            maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS,
            maxReconnectDelayMs: DEFAULT_MAX_RECONNECT_DELAY_MS,
            ...config,
        };

        this.config.reconnectDelayMs = normalizePositiveNumber(this.config.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS);
        this.config.maxReconnectAttempts = normalizePositiveInteger(this.config.maxReconnectAttempts, DEFAULT_MAX_RECONNECT_ATTEMPTS);
        this.config.maxReconnectDelayMs = normalizeNonNegativeNumber(this.config.maxReconnectDelayMs, DEFAULT_MAX_RECONNECT_DELAY_MS);
        this.config.wsUrl = (this.config.wsUrl || DEFAULT_WS_URL).trim();
    }

    // ============================================================================
    // Public API
    // ============================================================================

    async connect(): Promise<void> {
        if (this.connected) return;

        this.shouldReconnect = true;
        await this.doConnect();
    }

    disconnect(): void {
        this.shouldReconnect = false;
        this.cleanup();
    }

    isConnected(): boolean {
        return this.connected;
    }

    getStats() {
        return {
            ...this.stats,
            subscribedTopics: Array.from(this.subscribedTopics),
            pendingRequests: this.pendingRequests.size,
        };
    }

    /**
     * 订阅订单簿更新
     */
    async subscribeOrderbook(
        marketId: number,
        callback: (data: OrderbookUpdateData) => void
    ): Promise<boolean> {
        const topic = `predictOrderbook/${marketId}`;

        // 添加回调
        let callbacks = this.orderbookCallbacks.get(marketId);
        if (!callbacks) {
            callbacks = new Set();
            this.orderbookCallbacks.set(marketId, callbacks);
        }
        callbacks.add(callback);

        // 如果已订阅，直接返回
        if (this.subscribedTopics.has(topic)) {
            return true;
        }

        // 订阅
        const success = await this.subscribe(topic);
        if (success) {
            this.subscribedTopics.add(topic);
        }
        return success;
    }

    /**
     * 取消订阅订单簿
     */
    async unsubscribeOrderbook(
        marketId: number,
        callback?: (data: OrderbookUpdateData) => void
    ): Promise<boolean> {
        const topic = `predictOrderbook/${marketId}`;
        const callbacks = this.orderbookCallbacks.get(marketId);

        if (callback && callbacks) {
            callbacks.delete(callback);
            // 如果还有其他回调，不取消订阅
            if (callbacks.size > 0) return true;
        }

        // 清理回调
        this.orderbookCallbacks.delete(marketId);

        // 取消订阅
        if (this.subscribedTopics.has(topic)) {
            const success = await this.unsubscribe(topic);
            if (success) {
                this.subscribedTopics.delete(topic);
            }
            return success;
        }
        return true;
    }

    /**
     * 订阅钱包事件（订单状态变更）
     * 需要在 config 中提供 jwt
     */
    async subscribeWalletEvents(
        callback: (event: WalletEventData) => void
    ): Promise<boolean> {
        if (!this.config.jwt) {
            console.error('[PredictWS] JWT is required for wallet events subscription');
            return false;
        }

        const topic = `predictWalletEvents/${this.config.jwt}`;

        // 添加回调
        this.walletEventCallbacks.add(callback);

        // 如果已订阅，直接返回
        if (this.subscribedTopics.has(topic)) {
            return true;
        }

        // 订阅
        const success = await this.subscribe(topic);
        if (success) {
            this.subscribedTopics.add(topic);
        }
        return success;
    }

    /**
     * 取消订阅钱包事件
     */
    async unsubscribeWalletEvents(
        callback?: (event: WalletEventData) => void
    ): Promise<boolean> {
        if (callback) {
            this.walletEventCallbacks.delete(callback);
            // 如果还有其他回调，不取消订阅
            if (this.walletEventCallbacks.size > 0) return true;
        }

        // 清理所有回调
        this.walletEventCallbacks.clear();

        // 找到钱包事件主题
        const topic = Array.from(this.subscribedTopics).find(t =>
            t.startsWith('predictWalletEvents/')
        );

        if (topic) {
            const success = await this.unsubscribe(topic);
            if (success) {
                this.subscribedTopics.delete(topic);
            }
            return success;
        }
        return true;
    }

    /**
     * 更新 JWT（用于重新订阅钱包事件）
     */
    setJwt(jwt: string): void {
        this.config.jwt = jwt;
    }

    // ============================================================================
    // Private - Connection
    // ============================================================================

    private async doConnect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const wsUrl = this.config.wsUrl || WS_URL;
            const separator = wsUrl.includes('?') ? '&' : '?';
            const url = `${wsUrl}${separator}apiKey=${encodeURIComponent(this.config.apiKey)}`;
            const connectStartTime = Date.now();

            console.log('[PredictWS] 正在连接...');

            try {
                this.ws = new WebSocket(url);
            } catch (e: any) {
                console.error('[PredictWS] WebSocket 创建失败:', e?.message);
                this.scheduleReconnect();
                reject(e);
                return;
            }

            const connectTimeout = setTimeout(() => {
                if (!this.connected) {
                    console.error('[PredictWS] 连接超时');
                    try { this.ws?.terminate(); } catch { /* ignore */ }
                    this.scheduleReconnect();
                    reject(new Error('Connection timeout'));
                }
            }, 15000);

            this.ws.on('open', () => {
                clearTimeout(connectTimeout);
                const elapsed = Date.now() - connectStartTime;
                this.connected = true;
                this.reconnectAttempts = 0;
                this.stats.connectionStartTime = Date.now();

                console.log(`[PredictWS] 连接成功 (${elapsed}ms)`);

                this.startHeartbeatMonitor();
                this.emit('connected');

                // 重新订阅之前的主题
                this.resubscribeTopics();

                resolve();
            });

            this.ws.on('message', (data) => this.handleMessage(data.toString()));

            this.ws.on('error', (err: any) => {
                clearTimeout(connectTimeout);
                console.error('[PredictWS] 连接错误:', err?.message);
                this.emit('error', err);
            });

            this.ws.on('close', (code, reason) => {
                clearTimeout(connectTimeout);
                this.connected = false;
                this.stopHeartbeatMonitor();
                console.log(`[PredictWS] 连接关闭: code=${code}, reason=${reason?.toString() || 'none'}`);
                this.emit('disconnected');

                if (this.shouldReconnect && this.config.autoReconnect) {
                    this.scheduleReconnect();
                }
            });
        });
    }

    private scheduleReconnect(): void {
        if (!this.shouldReconnect || !this.config.autoReconnect) return;
        if (this.reconnectTimer) return;

        const maxReconnectAttempts = this.config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
        if (this.reconnectAttempts >= maxReconnectAttempts) {
            console.error('[PredictWS] 达到最大重连次数');
            this.emit('maxReconnectAttemptsReached');
            return;
        }

        this.reconnectAttempts++;
        const reconnectDelayMs = this.config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
        const maxReconnectDelayMs = this.config.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
        const uncappedDelay = reconnectDelayMs * this.reconnectAttempts;
        const delay = maxReconnectDelayMs > 0
            ? Math.min(uncappedDelay, maxReconnectDelayMs)
            : uncappedDelay;

        console.log(`[PredictWS] 将在 ${delay}ms 后重连 (${this.reconnectAttempts}/${maxReconnectAttempts})`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.shouldReconnect) {
                this.doConnect().catch(() => { /* ignore */ });
            }
        }, delay);
    }

    private async resubscribeTopics(): Promise<void> {
        // 复制订阅列表（因为重新订阅会修改它）
        const topics = Array.from(this.subscribedTopics);
        this.subscribedTopics.clear();

        for (const topic of topics) {
            try {
                const success = await this.subscribe(topic);
                if (success) {
                    this.subscribedTopics.add(topic);
                }
            } catch (e) {
                console.error(`[PredictWS] 重新订阅失败: ${topic}`, e);
            }
        }
    }

    // ============================================================================
    // Private - Message Handling
    // ============================================================================

    private handleMessage(data: string): void {
        this.stats.totalMessages++;
        this.stats.lastMessageTime = Date.now();

        let msg: WsMessage;
        try {
            msg = JSON.parse(data);
        } catch {
            console.warn('[PredictWS] 无效 JSON:', data.slice(0, 100));
            return;
        }

        // 心跳消息
        if (msg.type === 'M' && msg.topic === 'heartbeat') {
            this.handleHeartbeat(msg.data);
            return;
        }

        // 请求响应
        if (msg.type === 'R' && msg.requestId !== undefined) {
            this.handleRequestResponse(msg);
            return;
        }

        // 推送消息
        if (msg.type === 'M' && msg.topic) {
            this.handlePushMessage(msg);
            return;
        }
    }

    private handleHeartbeat(data: unknown): void {
        this.lastHeartbeatTime = Date.now();

        // 回复心跳
        if (this.ws && this.connected) {
            const response = {
                method: 'heartbeat',
                data: data,  // 回复相同的时间戳
            };
            try {
                this.ws.send(JSON.stringify(response));
            } catch (e) {
                console.error('[PredictWS] 发送心跳响应失败:', e);
            }
        }
    }

    private handleRequestResponse(msg: WsMessage): void {
        const pending = this.pendingRequests.get(msg.requestId!);
        if (!pending) return;

        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.requestId!);

        if (msg.success) {
            pending.resolve(true);
        } else {
            console.error(`[PredictWS] 请求 ${msg.requestId} 失败:`, msg.error);
            pending.resolve(false);
        }
    }

    private handlePushMessage(msg: WsMessage): void {
        const topic = msg.topic!;

        // 订单簿更新
        if (topic.startsWith('predictOrderbook/')) {
            this.stats.orderbookUpdates++;
            const marketIdStr = topic.replace('predictOrderbook/', '');
            const marketId = parseInt(marketIdStr, 10);

            if (!isNaN(marketId)) {
                const callbacks = this.orderbookCallbacks.get(marketId);
                if (callbacks) {
                    const data = this.parseOrderbookData(msg.data, marketId);
                    for (const cb of callbacks) {
                        try { cb(data); } catch { /* ignore */ }
                    }
                }
            }
            return;
        }

        // 钱包事件
        if (topic.startsWith('predictWalletEvents/')) {
            this.stats.walletEvents++;
            const event = this.parseWalletEvent(msg.data);
            if (event) {
                for (const cb of this.walletEventCallbacks) {
                    try { cb(event); } catch { /* ignore */ }
                }
                this.emit('walletEvent', event);
            }
            return;
        }

        // 其他主题
        this.emit('message', { topic, data: msg.data });
    }

    private parseOrderbookData(data: unknown, marketId: number): OrderbookUpdateData {
        const raw = data as any;
        return {
            marketId: raw?.marketId ?? marketId,
            updateTimestampMs: raw?.updateTimestampMs ?? Date.now(),
            bids: Array.isArray(raw?.bids) ? raw.bids : [],
            asks: Array.isArray(raw?.asks) ? raw.asks : [],
        };
    }

    private parseWalletEvent(data: unknown): WalletEventData | null {
        const raw = data as any;
        if (!raw) return null;

        // 解析事件类型
        // 支持多种格式：
        // - 小写: accepted, rejected, filled, partially_filled, cancelled, expired
        // - 驼峰: orderAccepted, orderNotAccepted, orderFilled, orderPartiallyFilled
        // - 下划线: order_filled, order_tx_confirmed
        // - 全大写: ORDER_FILLED, ORDER_TX_CONFIRMED
        // - 链上事件: orderTransactionSubmitted, orderTransactionSuccess, orderTransactionFailed
        const typeMap: Record<string, WalletEventType> = {
            // 小写格式
            'accepted': 'ORDER_ACCEPTED',
            'rejected': 'ORDER_REJECTED',
            'filled': 'ORDER_FILLED',
            'partially_filled': 'ORDER_PARTIALLY_FILLED',
            'cancelled': 'ORDER_CANCELLED',
            'canceled': 'ORDER_CANCELLED',
            'expired': 'ORDER_EXPIRED',
            'tx_confirmed': 'ORDER_TX_CONFIRMED',
            'tx_pending': 'ORDER_TX_PENDING',
            'tx_failed': 'ORDER_TX_FAILED',
            // 驼峰格式 (Predict API 实际格式)
            'orderaccepted': 'ORDER_ACCEPTED',
            'ordernotaccepted': 'ORDER_REJECTED',
            'orderrejected': 'ORDER_REJECTED',
            'orderfilled': 'ORDER_FILLED',
            'orderpartiallyfilled': 'ORDER_PARTIALLY_FILLED',
            'ordercancelled': 'ORDER_CANCELLED',
            'ordercanceled': 'ORDER_CANCELLED',
            'orderexpired': 'ORDER_EXPIRED',
            // 链上交易事件（区分提交与确认，避免提前触发对冲）
            'ordertransactionsubmitted': 'ORDER_TX_PENDING',    // 交易已提交（待确认，不触发 fill）
            'ordertransactionsuccess': 'ORDER_TX_CONFIRMED',    // 交易成功（可触发 fill）
            'ordertransactionfailed': 'ORDER_TX_FAILED',        // 交易失败
            // 下划线格式 (order_filled, order_tx_confirmed)
            'order_accepted': 'ORDER_ACCEPTED',
            'order_rejected': 'ORDER_REJECTED',
            'order_filled': 'ORDER_FILLED',
            'order_partially_filled': 'ORDER_PARTIALLY_FILLED',
            'order_cancelled': 'ORDER_CANCELLED',
            'order_canceled': 'ORDER_CANCELLED',
            'order_expired': 'ORDER_EXPIRED',
            'order_tx_pending': 'ORDER_TX_PENDING',
            'order_tx_confirmed': 'ORDER_TX_CONFIRMED',
            'order_tx_failed': 'ORDER_TX_FAILED',
        };

        const rawTypeOriginal = raw.type || raw.event || raw.status || '';
        // 统一转小写并移除空格
        const rawType = rawTypeOriginal.toLowerCase().replace(/\s+/g, '');
        // 直接查表；若未命中则标准化处理：移除 order_ 前缀后再拼接
        let eventType = typeMap[rawType];
        if (!eventType) {
            // 移除可能的 order_/order 前缀，避免生成 ORDER_ORDER_*
            const normalized = rawType.replace(/^order[_]?/, '').replace(/_/g, '');
            eventType = typeMap[normalized] || ('ORDER_' + normalized.toUpperCase()) as WalletEventType;
        }

        // 提取 orderId（可能带 'n' 后缀表示 bigint）
        let orderId = raw.orderId || raw.id || raw.order_id || '';
        if (typeof orderId === 'string' && orderId.endsWith('n')) {
            orderId = orderId.slice(0, -1);  // 移除 'n' 后缀
        }

        // orderHash 可能在不同字段中，或需要从 orderId 映射
        // 注意：Predict API 的 wallet events 可能只提供 orderId，不提供 orderHash
        const orderHash = raw.orderHash || raw.hash || raw.order_hash || '';

        // 从 details 中提取额外信息
        const details = raw.details || {};
        const filledQty = parsePredictSharesFromRaw(raw);

        return {
            type: eventType,
            orderHash,
            orderId: String(orderId),
            marketId: raw.marketId || raw.market_id || details.marketId,
            filledQty,
            remainingQty: raw.remainingQty || raw.remaining_qty || raw.quantityRemaining,
            avgPrice: raw.avgPrice || raw.avg_price || raw.averagePrice || parseFloat(details.price) || undefined,
            txHash: raw.txHash || raw.tx_hash || raw.transactionHash,
            reason: raw.reason || raw.message || raw.error,
            timestamp: this.parseTimestamp(raw.timestamp || raw.createdAt),
            rawData: raw,
        };
    }

    /**
     * 解析时间戳（支持毫秒数、秒数、ISO 字符串）
     */
    private parseTimestamp(value: unknown): number {
        if (!value) return Date.now();
        if (typeof value === 'number') {
            // 如果是秒级时间戳（小于 2000000000），转换为毫秒
            return value < 2000000000 ? value * 1000 : value;
        }
        if (typeof value === 'string') {
            // 尝试解析 ISO 字符串
            const parsed = Date.parse(value);
            if (!isNaN(parsed)) return parsed;
            // 尝试解析纯数字字符串
            const num = Number(value);
            if (!isNaN(num)) return num < 2000000000 ? num * 1000 : num;
        }
        return Date.now();
    }

    // ============================================================================
    // Private - Subscribe/Unsubscribe
    // ============================================================================

    private async subscribe(topic: string): Promise<boolean> {
        if (!this.ws || !this.connected) {
            console.error('[PredictWS] 未连接，无法订阅');
            return false;
        }

        const reqId = this.requestId++;
        const request = {
            method: 'subscribe',
            requestId: reqId,
            params: [topic],
        };

        return this.sendRequest(reqId, request);
    }

    private async unsubscribe(topic: string): Promise<boolean> {
        if (!this.ws || !this.connected) {
            return true; // 未连接，视为成功
        }

        const reqId = this.requestId++;
        const request = {
            method: 'unsubscribe',
            requestId: reqId,
            params: [topic],
        };

        return this.sendRequest(reqId, request);
    }

    private sendRequest(reqId: number, request: object): Promise<boolean> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(reqId);
                console.error(`[PredictWS] 请求 ${reqId} 超时`);
                resolve(false);
            }, SUBSCRIBE_TIMEOUT_MS);

            this.pendingRequests.set(reqId, { resolve, reject: () => resolve(false), timer });

            try {
                this.ws!.send(JSON.stringify(request));
            } catch (e) {
                clearTimeout(timer);
                this.pendingRequests.delete(reqId);
                console.error('[PredictWS] 发送请求失败:', e);
                resolve(false);
            }
        });
    }

    // ============================================================================
    // Private - Heartbeat
    // ============================================================================

    private startHeartbeatMonitor(): void {
        this.stopHeartbeatMonitor();
        this.lastHeartbeatTime = Date.now();

        this.heartbeatTimer = setInterval(() => {
            const elapsed = Date.now() - this.lastHeartbeatTime;
            if (elapsed > HEARTBEAT_INTERVAL_MS * 2) {
                this.stats.heartbeatsMissed++;
                console.warn(`[PredictWS] 心跳超时 (${elapsed}ms)`);

                // 强制重连
                if (this.ws) {
                    try { this.ws.terminate(); } catch { /* ignore */ }
                }
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    private stopHeartbeatMonitor(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    // ============================================================================
    // Private - Cleanup
    // ============================================================================

    private cleanup(): void {
        this.stopHeartbeatMonitor();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // 清理待处理请求
        for (const [, pending] of this.pendingRequests) {
            clearTimeout(pending.timer);
        }
        this.pendingRequests.clear();

        if (this.ws) {
            try { this.ws.close(); } catch { /* ignore */ }
            this.ws = null;
        }

        this.connected = false;
    }
}

// ============================================================================
// Singleton
// ============================================================================

let globalClient: PredictWsClient | null = null;

export function getPredictWsClient(): PredictWsClient | null {
    return globalClient;
}

export function initPredictWsClient(config: PredictWsConfig): PredictWsClient {
    if (globalClient) {
        globalClient.disconnect();
    }
    globalClient = new PredictWsClient(config);
    return globalClient;
}

export function stopPredictWsClient(): void {
    if (globalClient) {
        globalClient.disconnect();
        globalClient = null;
    }
}
