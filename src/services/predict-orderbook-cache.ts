/**
 * Predict 订单簿统一缓存层
 *
 * 功能:
 * - 统一缓存: Map<marketId, { bids, asks, timestamp }>
 * - WS 优先: 实时订阅活跃市场
 * - REST 降级: WS 断开或数据过期时自动切换
 * - TTL 检查: 可配置过期时间
 * - 多模块共享: 单例模式，避免重复订阅
 *
 * 使用方式:
 * ```typescript
 * const cache = getPredictOrderbookCache();
 * await cache.init(apiKey, jwt);
 * const book = await cache.getOrderbook(marketId);
 * ```
 */

import { PredictWsClient, initPredictWsClient, getPredictWsClient, type OrderbookUpdateData } from './predict-ws-client.js';

// ============================================================================
// 配置
// ============================================================================

const DEFAULT_TTL_MS = 15000;           // 默认 15 秒过期
const DEFAULT_STALE_THRESHOLD_MS = 5000; // 5 秒内认为新鲜
const REST_TIMEOUT_MS = 5000;           // REST 请求超时
const MAX_CONCURRENT_REST = 30;         // 最大并发 REST 请求
const SUBSCRIPTION_BATCH_SIZE = 50;     // 批量订阅大小
const SUBSCRIPTION_BATCH_DELAY_MS = 100; // 批量订阅间隔

// 环境变量配置
const ENV_TTL_MS = Number(process.env.PREDICT_ORDERBOOK_CACHE_TTL_MS) || DEFAULT_TTL_MS;
const ENV_ALLOW_STALE = process.env.PREDICT_ALLOW_STALE_ORDERBOOK_CACHE === 'true';
const ENV_WS_ENABLED = process.env.PREDICT_ORDERBOOK_SOURCE?.toLowerCase() !== 'rest';
const ENV_REST_ENABLED = process.env.PREDICT_ORDERBOOK_SOURCE?.toLowerCase() !== 'ws';
const ENV_WS_RECONNECT_DELAY_MS = Number(process.env.PREDICT_WS_RECONNECT_DELAY_MS) > 0
    ? Number(process.env.PREDICT_WS_RECONNECT_DELAY_MS)
    : 3000;
const ENV_WS_MAX_RECONNECT_ATTEMPTS = Number.parseInt(process.env.PREDICT_WS_MAX_RECONNECT_ATTEMPTS || '', 10) > 0
    ? Number.parseInt(process.env.PREDICT_WS_MAX_RECONNECT_ATTEMPTS || '', 10)
    : 5;
const ENV_WS_MAX_RECONNECT_DELAY_MS = Number(process.env.PREDICT_WS_RECONNECT_MAX_DELAY_MS) > 0
    ? Number(process.env.PREDICT_WS_RECONNECT_MAX_DELAY_MS)
    : 0;

// ============================================================================
// 类型定义
// ============================================================================

export interface OrderbookLevel {
    price: number;
    size: number;
}

export interface CachedOrderbook {
    marketId: number;
    bids: OrderbookLevel[];
    asks: OrderbookLevel[];
    timestamp: number;
    source: 'ws' | 'rest';
}

export interface OrderbookCacheConfig {
    apiKey: string;
    jwt?: string;
    ttlMs?: number;
    allowStale?: boolean;
    wsEnabled?: boolean;
    restEnabled?: boolean;
    restApiKey?: string;  // REST 专用 Key（轮换）
    wsReconnectDelayMs?: number;
    wsMaxReconnectAttempts?: number;
    wsMaxReconnectDelayMs?: number;
}

export interface OrderbookCacheStats {
    cacheSize: number;
    wsConnected: boolean;
    wsSubscriptions: number;
    totalHits: number;
    totalMisses: number;
    wsUpdates: number;
    restFetches: number;
    restErrors: number;
    lastUpdateTime: number;
}

// ============================================================================
// PredictOrderbookCache
// ============================================================================

export class PredictOrderbookCache {
    private config: Required<OrderbookCacheConfig>;
    private cache = new Map<number, CachedOrderbook>();
    private wsClient: PredictWsClient | null = null;
    private subscribedMarkets = new Set<number>();
    private pendingSubscriptions = new Set<number>();
    private restSemaphore = 0;  // 简单的并发控制

    // REST 刷新去重/冷却
    private pendingRestRefresh = new Set<number>();  // 正在刷新的 market
    private refreshCooldown = new Map<number, number>();  // marketId → 上次刷新时间
    private static readonly REFRESH_COOLDOWN_MS = 3000;  // 3 秒冷却

    // 统计
    private stats = {
        totalHits: 0,
        totalMisses: 0,
        wsUpdates: 0,
        restFetches: 0,
        restErrors: 0,
        lastUpdateTime: 0,
    };

    // REST 延迟追踪
    private restLatencySum = 0;
    private restLatencyCount = 0;

    // 事件回调
    private updateCallbacks = new Set<(marketId: number, book: CachedOrderbook) => void>();

    constructor(config: OrderbookCacheConfig) {
        this.config = {
            apiKey: config.apiKey,
            jwt: config.jwt || '',
            ttlMs: config.ttlMs ?? ENV_TTL_MS,
            allowStale: config.allowStale ?? ENV_ALLOW_STALE,
            wsEnabled: config.wsEnabled ?? ENV_WS_ENABLED,
            restEnabled: config.restEnabled ?? ENV_REST_ENABLED,
            restApiKey: config.restApiKey || config.apiKey,
            wsReconnectDelayMs: config.wsReconnectDelayMs ?? ENV_WS_RECONNECT_DELAY_MS,
            wsMaxReconnectAttempts: config.wsMaxReconnectAttempts ?? ENV_WS_MAX_RECONNECT_ATTEMPTS,
            wsMaxReconnectDelayMs: config.wsMaxReconnectDelayMs ?? ENV_WS_MAX_RECONNECT_DELAY_MS,
        };
    }

    // ============================================================================
    // 初始化与清理
    // ============================================================================

    /**
     * 初始化缓存（连接 WS）
     */
    async init(): Promise<void> {
        if (this.config.wsEnabled) {
            await this.initWsClient();
        }
        console.log(`[OrderbookCache] 初始化完成 (WS=${this.config.wsEnabled}, REST=${this.config.restEnabled}, TTL=${this.config.ttlMs}ms)`);
    }

    /**
     * 关闭缓存（断开 WS）
     */
    stop(): void {
        if (this.wsClient) {
            this.wsClient.disconnect();
            this.wsClient = null;
        }
        this.cache.clear();
        this.subscribedMarkets.clear();
        this.pendingSubscriptions.clear();
        this.pendingRestRefresh.clear();
        this.refreshCooldown.clear();
        console.log('[OrderbookCache] 已停止');
    }

    /**
     * 更新 JWT（用于钱包事件订阅）
     */
    setJwt(jwt: string): void {
        this.config.jwt = jwt;
        if (this.wsClient) {
            this.wsClient.setJwt(jwt);
        }
    }

    // ============================================================================
    // 公共 API
    // ============================================================================

    /**
     * 获取订单簿（优先 WS 缓存，降级 REST）
     */
    async getOrderbook(marketId: number): Promise<CachedOrderbook | null> {
        // 1. 检查缓存
        const cached = this.cache.get(marketId);
        const now = Date.now();

        if (cached) {
            const age = now - cached.timestamp;

            // 缓存有效
            if (age <= this.config.ttlMs || this.config.allowStale) {
                this.stats.totalHits++;

                // 如果数据较旧但允许使用，在后台刷新
                if (age > DEFAULT_STALE_THRESHOLD_MS && this.config.restEnabled) {
                    this.refreshInBackground(marketId);
                }

                return cached;
            }
        }

        this.stats.totalMisses++;

        // 2. 缓存无效，尝试 REST
        if (this.config.restEnabled) {
            const book = await this.fetchFromRest(marketId);
            if (book) {
                this.updateCache(marketId, book, 'rest');
                return this.cache.get(marketId)!;
            }
        }

        // 3. REST 也失败，返回过期缓存（如果允许）
        if (cached && this.config.allowStale) {
            return cached;
        }

        return null;
    }

    /**
     * 同步获取缓存（高频场景用）
     * - 返回缓存数据（如果有效或允许 stale）
     * - 在 cache miss/过期时触发后台 REST 刷新
     */
    getOrderbookSync(marketId: number): CachedOrderbook | null {
        const cached = this.cache.get(marketId);
        const now = Date.now();

        if (cached) {
            const age = now - cached.timestamp;

            // 缓存有效
            if (age <= this.config.ttlMs) {
                this.stats.totalHits++;
                return cached;
            }

            // 缓存过期但允许使用 stale 数据
            if (this.config.allowStale) {
                this.stats.totalHits++;
                // 触发后台刷新
                if (this.config.restEnabled) {
                    this.refreshInBackground(marketId);
                }
                return cached;
            }

            // 缓存过期且不允许 stale，触发后台刷新
            this.stats.totalMisses++;
            if (this.config.restEnabled) {
                this.refreshInBackground(marketId);
            }
            return null;
        }

        // 完全无缓存，触发后台刷新
        this.stats.totalMisses++;
        if (this.config.restEnabled) {
            this.refreshInBackground(marketId);
        }
        return null;
    }

    /**
     * 批量订阅市场（WS）
     */
    async subscribeMarkets(marketIds: number[]): Promise<void> {
        if (!this.config.wsEnabled || !this.wsClient) return;

        const toSubscribe = marketIds.filter(id => !this.subscribedMarkets.has(id) && !this.pendingSubscriptions.has(id));
        if (toSubscribe.length === 0) return;

        // 标记为待订阅
        for (const id of toSubscribe) {
            this.pendingSubscriptions.add(id);
        }

        // 分批订阅
        for (let i = 0; i < toSubscribe.length; i += SUBSCRIPTION_BATCH_SIZE) {
            const batch = toSubscribe.slice(i, i + SUBSCRIPTION_BATCH_SIZE);

            await Promise.all(batch.map(async (marketId) => {
                try {
                    const success = await this.wsClient!.subscribeOrderbook(marketId, (data) => {
                        this.handleWsUpdate(data);
                    });

                    if (success) {
                        this.subscribedMarkets.add(marketId);
                    }
                } catch (e) {
                    console.warn(`[OrderbookCache] 订阅 market ${marketId} 失败:`, e);
                } finally {
                    this.pendingSubscriptions.delete(marketId);
                }
            }));

            // 批次间延迟
            if (i + SUBSCRIPTION_BATCH_SIZE < toSubscribe.length) {
                await new Promise(r => setTimeout(r, SUBSCRIPTION_BATCH_DELAY_MS));
            }
        }

        console.log(`[OrderbookCache] 订阅 ${toSubscribe.length} 个市场，当前总订阅: ${this.subscribedMarkets.size}`);
    }

    /**
     * 取消订阅市场
     */
    async unsubscribeMarkets(marketIds: number[]): Promise<void> {
        if (!this.wsClient) return;

        for (const marketId of marketIds) {
            if (this.subscribedMarkets.has(marketId)) {
                try {
                    await this.wsClient.unsubscribeOrderbook(marketId);
                    this.subscribedMarkets.delete(marketId);
                } catch (e) {
                    console.warn(`[OrderbookCache] 取消订阅 market ${marketId} 失败:`, e);
                }
            }
        }
    }

    /**
     * 手动更新缓存（供外部 WS 回调使用）
     * 用于渐进式迁移：现有 WS 回调可以同步数据到新缓存
     */
    updateFromExternal(marketId: number, bids: [number, number][], asks: [number, number][]): void {
        this.updateCache(marketId, { bids, asks }, 'ws');
    }

    /**
     * 清理过期缓存
     */
    cleanupExpired(): number {
        const now = Date.now();
        let cleaned = 0;

        for (const [marketId, cached] of this.cache) {
            if (now - cached.timestamp > this.config.ttlMs * 2) {
                this.cache.delete(marketId);
                cleaned++;
            }
        }

        return cleaned;
    }

    /**
     * 添加更新回调
     */
    onUpdate(callback: (marketId: number, book: CachedOrderbook) => void): void {
        this.updateCallbacks.add(callback);
    }

    /**
     * 移除更新回调
     */
    offUpdate(callback: (marketId: number, book: CachedOrderbook) => void): void {
        this.updateCallbacks.delete(callback);
    }

    /**
     * 获取统计信息
     */
    getStats(): OrderbookCacheStats {
        return {
            cacheSize: this.cache.size,
            wsConnected: this.wsClient?.isConnected() ?? false,
            wsSubscriptions: this.subscribedMarkets.size,
            ...this.stats,
        };
    }

    /**
     * WS 是否已连接
     */
    isWsConnected(): boolean {
        return this.wsClient?.isConnected() ?? false;
    }

    /**
     * 获取内部 WS 客户端（用于外部事件监听）
     */
    getWsClient(): PredictWsClient | null {
        return this.wsClient;
    }

    /**
     * 获取 REST 请求平均延迟（ms），读取后重置计数器
     */
    getRestLatency(): number {
        if (this.restLatencyCount === 0) return 0;
        const avg = Math.round(this.restLatencySum / this.restLatencyCount);
        this.restLatencySum = 0;
        this.restLatencyCount = 0;
        return avg;
    }

    // ============================================================================
    // 私有方法 - WS
    // ============================================================================

    private async initWsClient(): Promise<void> {
        // 复用全局客户端或创建新的
        let client = getPredictWsClient();

        if (!client) {
            client = initPredictWsClient({
                apiKey: this.config.apiKey,
                jwt: this.config.jwt || undefined,
                autoReconnect: true,
                reconnectDelayMs: this.config.wsReconnectDelayMs,
                maxReconnectAttempts: this.config.wsMaxReconnectAttempts,
                maxReconnectDelayMs: this.config.wsMaxReconnectDelayMs,
            });
        }

        this.wsClient = client;

        // 连接事件
        this.wsClient.on('connected', () => {
            console.log('[OrderbookCache] WS 已连接');
            // 重连后重新订阅
            this.resubscribeAll();
        });

        this.wsClient.on('disconnected', () => {
            console.log('[OrderbookCache] WS 已断开');
        });

        this.wsClient.on('error', (err: any) => {
            console.error('[OrderbookCache] WS error:', err?.message || err);
        });

        // 连接
        try {
            await this.wsClient.connect();
        } catch (e) {
            console.warn('[OrderbookCache] WS 连接失败，将使用 REST:', e);
        }
    }

    private async resubscribeAll(): Promise<void> {
        const markets = Array.from(this.subscribedMarkets);
        this.subscribedMarkets.clear();

        if (markets.length > 0) {
            console.log(`[OrderbookCache] 重新订阅 ${markets.length} 个市场`);
            await this.subscribeMarkets(markets);
        }
    }

    private handleWsUpdate(data: OrderbookUpdateData): void {
        this.stats.wsUpdates++;
        this.stats.lastUpdateTime = Date.now();

        this.updateCache(data.marketId, {
            bids: data.bids,
            asks: data.asks,
        }, 'ws');
    }

    // ============================================================================
    // 私有方法 - REST
    // ============================================================================

    private async fetchFromRest(marketId: number): Promise<{ bids: [number, number][]; asks: [number, number][] } | null> {
        // 并发控制
        if (this.restSemaphore >= MAX_CONCURRENT_REST) {
            return null;
        }

        this.restSemaphore++;
        this.stats.restFetches++;
        const restStart = Date.now();

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);

            const url = `https://api.predict.fun/v1/markets/${marketId}/orderbook`;
            const res = await fetch(url, {
                headers: {
                    'X-API-Key': this.config.restApiKey,
                    'Accept': 'application/json',
                },
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!res.ok) {
                if (res.status === 429) {
                    console.warn(`[OrderbookCache] REST 429 限流 (market ${marketId})`);
                }
                this.stats.restErrors++;
                return null;
            }

            const raw = await res.json() as {
                success?: boolean;
                data?: {
                    bids?: Array<{ price?: string | number; size?: string | number } | [number | string, number | string]>;
                    asks?: Array<{ price?: string | number; size?: string | number } | [number | string, number | string]>;
                };
            };

            if (!raw.data) {
                this.stats.restErrors++;
                return null;
            }

            // 转换格式（兼容 {price,size} 对象和 [price,size] 元组）
            const normalizeLevel = (level: unknown): [number, number] | null => {
                if (Array.isArray(level)) {
                    const p = Number(level[0]), s = Number(level[1]);
                    return Number.isFinite(p) && Number.isFinite(s) && p > 0 && s > 0 ? [p, s] : null;
                }
                if (level && typeof level === 'object') {
                    const obj = level as Record<string, unknown>;
                    const p = Number(obj.price ?? 0);
                    const s = Number(obj.size ?? obj.quantity ?? 0);
                    return Number.isFinite(p) && Number.isFinite(s) && p > 0 && s > 0 ? [p, s] : null;
                }
                return null;
            };

            const bids: [number, number][] = (raw.data.bids || [])
                .map(normalizeLevel)
                .filter((l): l is [number, number] => l !== null);
            const asks: [number, number][] = (raw.data.asks || [])
                .map(normalizeLevel)
                .filter((l): l is [number, number] => l !== null);

            // 记录 REST 延迟（滚动平均）
            const restLatency = Date.now() - restStart;
            this.restLatencySum += restLatency;
            this.restLatencyCount++;

            return { bids, asks };
        } catch (e: any) {
            if (e.name !== 'AbortError') {
                this.stats.restErrors++;
                console.warn(`[OrderbookCache] REST 获取失败 (market ${marketId}):`, e.message);
            }
            return null;
        } finally {
            this.restSemaphore--;
        }
    }

    private refreshInBackground(marketId: number): void {
        // 去重：正在刷新中
        if (this.pendingRestRefresh.has(marketId)) return;

        // 去重：WS 正在订阅中
        if (this.pendingSubscriptions.has(marketId)) return;

        // 冷却：距上次刷新不足 REFRESH_COOLDOWN_MS
        const lastRefresh = this.refreshCooldown.get(marketId) || 0;
        if (Date.now() - lastRefresh < PredictOrderbookCache.REFRESH_COOLDOWN_MS) return;

        // 标记为正在刷新
        this.pendingRestRefresh.add(marketId);
        this.refreshCooldown.set(marketId, Date.now());

        this.fetchFromRest(marketId).then(book => {
            if (book) {
                this.updateCache(marketId, book, 'rest');
            }
        }).catch(() => { /* ignore */ }).finally(() => {
            this.pendingRestRefresh.delete(marketId);
        });
    }

    // ============================================================================
    // 私有方法 - 缓存
    // ============================================================================

    private updateCache(
        marketId: number,
        book: { bids: [number, number][]; asks: [number, number][] },
        source: 'ws' | 'rest'
    ): void {
        // 转换为标准格式并排序
        const bids: OrderbookLevel[] = book.bids
            .map(([price, size]) => ({ price, size }))
            .sort((a, b) => b.price - a.price);  // 降序

        const asks: OrderbookLevel[] = book.asks
            .map(([price, size]) => ({ price, size }))
            .sort((a, b) => a.price - b.price);  // 升序

        const cached: CachedOrderbook = {
            marketId,
            bids,
            asks,
            timestamp: Date.now(),
            source,
        };

        this.cache.set(marketId, cached);

        // 触发回调
        for (const cb of this.updateCallbacks) {
            try {
                cb(marketId, cached);
            } catch { /* ignore */ }
        }
    }
}

// ============================================================================
// 单例
// ============================================================================

let instance: PredictOrderbookCache | null = null;

/**
 * 获取全局订单簿缓存实例
 */
export function getPredictOrderbookCache(): PredictOrderbookCache | null {
    return instance;
}

/**
 * 初始化全局订单簿缓存
 */
export async function initPredictOrderbookCache(config: OrderbookCacheConfig): Promise<PredictOrderbookCache> {
    if (instance) {
        instance.stop();
    }

    instance = new PredictOrderbookCache(config);
    await instance.init();

    return instance;
}

/**
 * 停止全局订单簿缓存
 */
export function stopPredictOrderbookCache(): void {
    if (instance) {
        instance.stop();
        instance = null;
    }
}
