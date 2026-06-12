/**
 * 订单簿缓存
 *
 * 功能：
 * - TTL 缓存：减少 API 调用频率
 * - 新鲜度检测：标记过期数据
 * - 后台刷新：过期时异步刷新不阻塞
 * - WS/REST 降级：优先使用实时数据
 */

import type { CachedOrderBook, OrderbookCacheConfig } from './taker-mode/types.js';

// ============================================================================
// 默认配置
// ============================================================================

export const DEFAULT_CACHE_CONFIG: OrderbookCacheConfig = {
    ttlMs: 500,           // 缓存有效期 500ms
    staleThresholdMs: 1000, // 过期警告阈值 1s
    maxStaleMs: 2000,       // 最大容忍过期 2s
};

// ============================================================================
// 缓存条目
// ============================================================================

interface CacheEntry<T> {
    data: T;
    timestamp: number;
    source: 'WS' | 'REST';
}

// ============================================================================
// 订单簿缓存类
// ============================================================================

export class OrderbookCache {
    private cache: Map<string, CacheEntry<any>> = new Map();
    private config: OrderbookCacheConfig;
    private refreshing: Set<string> = new Set();  // 正在刷新的 key

    constructor(config: Partial<OrderbookCacheConfig> = {}) {
        this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
    }

    /**
     * 获取缓存数据
     *
     * 返回策略：
     * 1. 新鲜数据 (< ttlMs) → 直接返回
     * 2. 过期但可容忍 (< maxStaleMs) → 返回 + 后台刷新
     * 3. 超过最大容忍 → 同步获取
     *
     * @param key - 缓存键 (如 "predict:123" 或 "poly:tokenId")
     * @param fetcher - 数据获取函数
     * @returns 数据和新鲜度状态
     */
    async get<T>(
        key: string,
        fetcher: () => Promise<T>,
        source: 'WS' | 'REST' = 'REST'
    ): Promise<{ data: T; isStale: boolean; age: number }> {
        const cached = this.cache.get(key);
        const now = Date.now();

        if (cached) {
            const age = now - cached.timestamp;

            // 1. 新鲜数据，直接返回
            if (age < this.config.ttlMs) {
                return {
                    data: cached.data,
                    isStale: false,
                    age,
                };
            }

            // 2. 过期但可容忍，后台刷新
            if (age < this.config.maxStaleMs) {
                // 异步刷新，不阻塞
                this.refreshInBackground(key, fetcher, source);

                return {
                    data: cached.data,
                    isStale: age > this.config.staleThresholdMs,
                    age,
                };
            }
        }

        // 3. 无缓存或超过最大容忍，同步获取
        const data = await fetcher();
        this.set(key, data, source);

        return {
            data,
            isStale: false,
            age: 0,
        };
    }

    /**
     * 直接设置缓存
     * 用于 WebSocket 实时更新
     */
    set<T>(key: string, data: T, source: 'WS' | 'REST' = 'REST'): void {
        this.cache.set(key, {
            data,
            timestamp: Date.now(),
            source,
        });
    }

    /**
     * 从 WS 更新缓存
     * WS 数据优先级更高，直接覆盖
     */
    updateFromWs<T>(key: string, data: T): void {
        this.set(key, data, 'WS');
    }

    /**
     * 获取原始缓存条目 (不触发刷新)
     */
    getRaw<T>(key: string): CacheEntry<T> | undefined {
        return this.cache.get(key);
    }

    /**
     * 检查是否有有效缓存
     */
    has(key: string): boolean {
        const entry = this.cache.get(key);
        if (!entry) return false;

        const age = Date.now() - entry.timestamp;
        return age < this.config.maxStaleMs;
    }

    /**
     * 检查缓存新鲜度
     */
    isFresh(key: string): boolean {
        const entry = this.cache.get(key);
        if (!entry) return false;

        const age = Date.now() - entry.timestamp;
        return age < this.config.ttlMs;
    }

    /**
     * 检查是否过期 (超过警告阈值)
     */
    isStale(key: string): boolean {
        const entry = this.cache.get(key);
        if (!entry) return true;

        const age = Date.now() - entry.timestamp;
        return age > this.config.staleThresholdMs;
    }

    /**
     * 删除缓存
     */
    delete(key: string): void {
        this.cache.delete(key);
    }

    /**
     * 清空所有缓存
     */
    clear(): void {
        this.cache.clear();
    }

    /**
     * 获取缓存统计
     */
    getStats(): {
        size: number;
        freshCount: number;
        staleCount: number;
        expiredCount: number;
    } {
        const now = Date.now();
        let freshCount = 0;
        let staleCount = 0;
        let expiredCount = 0;

        for (const entry of this.cache.values()) {
            const age = now - entry.timestamp;
            if (age < this.config.ttlMs) {
                freshCount++;
            } else if (age < this.config.maxStaleMs) {
                staleCount++;
            } else {
                expiredCount++;
            }
        }

        return {
            size: this.cache.size,
            freshCount,
            staleCount,
            expiredCount,
        };
    }

    /**
     * 后台刷新 (不阻塞)
     */
    private async refreshInBackground<T>(
        key: string,
        fetcher: () => Promise<T>,
        source: 'WS' | 'REST'
    ): Promise<void> {
        // 避免重复刷新
        if (this.refreshing.has(key)) {
            return;
        }

        this.refreshing.add(key);

        try {
            const data = await fetcher();
            this.set(key, data, source);
        } catch (err) {
            console.error(`[OrderbookCache] Refresh failed for ${key}:`, err);
        } finally {
            this.refreshing.delete(key);
        }
    }
}

// ============================================================================
// 单例实例
// ============================================================================

let defaultCache: OrderbookCache | null = null;

/**
 * 获取默认缓存实例
 */
export function getDefaultCache(): OrderbookCache {
    if (!defaultCache) {
        defaultCache = new OrderbookCache();
    }
    return defaultCache;
}

/**
 * 创建新的缓存实例
 */
export function createCache(config?: Partial<OrderbookCacheConfig>): OrderbookCache {
    return new OrderbookCache(config);
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 生成 Predict 订单簿缓存键
 */
export function predictCacheKey(marketId: number): string {
    return `predict:${marketId}`;
}

/**
 * 生成 Polymarket 订单簿缓存键
 */
export function polyCacheKey(tokenId: string): string {
    return `poly:${tokenId}`;
}
