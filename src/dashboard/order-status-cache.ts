/**
 * 订单状态缓存服务
 *
 * 通过批量查询 GET /v1/orders?status=OPEN 减少 API 调用次数
 *
 * 优化效果:
 * - 原来: N 个任务 × 每 500ms 轮询 = N×2 次/秒
 * - 现在: 1 次批量查询/500ms = 2 次/秒 (无论多少任务)
 */

import { EventEmitter } from 'events';

// ============================================================================
// 类型定义
// ============================================================================

export interface CachedOrderStatus {
    hash: string;
    id: string;
    status: 'OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'INVALIDATED';
    filledQty: number;
    remainingQty: number;
    cancelReason?: string;
    rawResponse?: any;
    updatedAt: number;  // 缓存更新时间
}

interface OrderApiResponse {
    id: string;
    hash?: string;
    status: string;
    filledAmount?: string;
    remainingAmount?: string;
    amount?: string;
    order?: {
        hash?: string;
        takerAmount?: string;
    };
    cancelReason?: string;
}

// ============================================================================
// 常量
// ============================================================================

const API_BASE_URL = 'https://api.predict.fun';
const DEFAULT_POLL_INTERVAL = Number(process.env.ORDER_CACHE_POLL_MS) || 3000;
const CACHE_STALE_MS = 5000;  // 缓存过期时间 5 秒
const DEFAULT_SOURCE = (process.env.PREDICT_ORDER_STATUS_SOURCE || 'ws+poll').toLowerCase(); // ws | poll | ws+poll

// ============================================================================
// 单例
// ============================================================================

let instance: OrderStatusCache | null = null;

export function getOrderStatusCache(): OrderStatusCache {
    if (!instance) {
        throw new Error('OrderStatusCache not initialized. Call initOrderStatusCache first.');
    }
    return instance;
}

export function initOrderStatusCache(getAuthHeaders: () => Promise<Record<string, string>>): OrderStatusCache {
    if (!instance) {
        instance = new OrderStatusCache(getAuthHeaders);
    }
    return instance;
}

// ============================================================================
// OrderStatusCache 类
// ============================================================================

export class OrderStatusCache extends EventEmitter {
    private cache: Map<string, CachedOrderStatus> = new Map();
    private getAuthHeaders: () => Promise<Record<string, string>>;
    private pollInterval: NodeJS.Timeout | null = null;
    private isPolling = false;
    private lastPollTime = 0;
    private pollCount = 0;
    private errorCount = 0;

    constructor(getAuthHeaders: () => Promise<Record<string, string>>) {
        super();
        this.getAuthHeaders = getAuthHeaders;
    }

    /**
     * 启动定时轮询
     */
    start(intervalMs: number = DEFAULT_POLL_INTERVAL): void {
        const enablePolling = DEFAULT_SOURCE.includes('poll') && intervalMs > 0;
        if (!enablePolling) {
            console.log(`[OrderStatusCache] Polling disabled (PREDICT_ORDER_STATUS_SOURCE=${DEFAULT_SOURCE})`);
            return;
        }

        if (this.pollInterval) {
            console.log('[OrderStatusCache] Already running');
            return;
        }

        console.log(`[OrderStatusCache] Starting with ${intervalMs}ms interval`);

        // 立即执行一次
        this.pollOrders();

        // 定时轮询
        this.pollInterval = setInterval(() => {
            this.pollOrders();
        }, intervalMs);
    }

    /**
     * 停止轮询
     */
    stop(): void {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
            console.log(`[OrderStatusCache] Stopped. Total polls: ${this.pollCount}, errors: ${this.errorCount}`);
        }
    }

    /**
     * 获取订单状态 (从缓存)
     */
    getOrderStatus(hash: string): CachedOrderStatus | null {
        const normalizedHash = hash.toLowerCase();
        const cached = this.cache.get(normalizedHash);

        if (!cached) {
            return null;
        }

        // 检查缓存是否过期
        if (Date.now() - cached.updatedAt > CACHE_STALE_MS) {
            // 缓存过期，但仍返回（调用方可决定是否使用）
            // 标记为可能过期
        }

        return cached;
    }

    /**
     * 手动更新单个订单状态 (供 WSS 事件使用)
     */
    updateOrderStatus(hash: string, update: Partial<CachedOrderStatus>): void {
        const normalizedHash = hash.toLowerCase();
        const existing = this.cache.get(normalizedHash);

        const now = Date.now();
        const next: CachedOrderStatus = {
            hash: normalizedHash,
            id: update.id ?? existing?.id ?? '',
            status: (update.status ?? existing?.status ?? 'OPEN') as CachedOrderStatus['status'],
            filledQty: update.filledQty ?? existing?.filledQty ?? 0,
            remainingQty: update.remainingQty ?? existing?.remainingQty ?? 0,
            cancelReason: update.cancelReason ?? existing?.cancelReason,
            rawResponse: update.rawResponse ?? existing?.rawResponse,
            updatedAt: now,
        };

        this.cache.set(normalizedHash, next);
        this.emit('order:updated', normalizedHash);
    }

    /**
     * 标记订单为已完成 (从缓存移除)
     */
    markOrderCompleted(hash: string): void {
        const normalizedHash = hash.toLowerCase();
        this.cache.delete(normalizedHash);
    }

    /**
     * 获取缓存统计
     */
    getStats(): { cacheSize: number; pollCount: number; errorCount: number; lastPollTime: number } {
        return {
            cacheSize: this.cache.size,
            pollCount: this.pollCount,
            errorCount: this.errorCount,
            lastPollTime: this.lastPollTime,
        };
    }

    /**
     * 批量查询订单状态
     */
    private async pollOrders(): Promise<void> {
        if (this.isPolling) {
            return;  // 避免重叠
        }

        this.isPolling = true;
        this.pollCount++;

        try {
            const headers = await this.getAuthHeaders();
            const res = await fetch(`${API_BASE_URL}/v1/orders?status=OPEN`, {
                headers,
                signal: AbortSignal.timeout(3000),
            });

            if (!res.ok) {
                if (res.status === 429) {
                    console.warn('[OrderStatusCache] Rate limited');
                }
                this.errorCount++;
                return;
            }

            const data = await res.json() as { data: OrderApiResponse[] };
            const orders = data.data || [];

            // 更新缓存
            const now = Date.now();
            const newHashes = new Set<string>();

            for (const order of orders) {
                const hash = (order.hash || order.order?.hash || '').toLowerCase();
                if (!hash) continue;

                newHashes.add(hash);

                // 解析成交量
                const filledAmount = order.filledAmount || '0';
                const remainingAmount = order.remainingAmount || order.order?.takerAmount || order.amount || '0';
                const filledQty = Number(BigInt(filledAmount)) / 1e18;
                const remainingQty = Number(BigInt(remainingAmount)) / 1e18;

                const cached: CachedOrderStatus = {
                    hash,
                    id: order.id,
                    status: order.status as CachedOrderStatus['status'],
                    filledQty,
                    remainingQty,
                    cancelReason: order.cancelReason,
                    rawResponse: order,
                    updatedAt: now,
                };

                const existing = this.cache.get(hash);
                if (!existing || cached.filledQty !== existing.filledQty || cached.status !== existing.status) {
                    this.cache.set(hash, cached);
                    this.emit('order:updated', hash);
                }
            }

            // 标记不在 OPEN 列表中的订单为可能已完成
            // 注意：不直接删除，因为可能是 FILLED/CANCELLED 状态
            for (const [hash, cached] of this.cache) {
                if (!newHashes.has(hash) && cached.status === 'OPEN') {
                    // 订单不再是 OPEN 状态，需要单独查询确认最终状态
                    this.emit('order:maybeCompleted', hash);
                }
            }

            this.lastPollTime = now;

        } catch (error: any) {
            if (error.name !== 'AbortError') {
                this.errorCount++;
                if (this.errorCount % 10 === 0) {
                    console.error(`[OrderStatusCache] Poll error (${this.errorCount}):`, error.message);
                }
            }
        } finally {
            this.isPolling = false;
        }
    }

    /**
     * 强制刷新 (供外部触发)
     */
    async refresh(): Promise<void> {
        await this.pollOrders();
    }
}
