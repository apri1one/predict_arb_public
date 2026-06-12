/**
 * Order Monitor - 订单状态监控
 *
 * 功能:
 * - Polymarket 订单簿 WebSocket 监控
 * - 价格守护 (Price Guard) - 共享全局 Polymarket WS 监控套利机会有效性
 */

import { EventEmitter } from 'events';
import type { PolymarketWebSocketClient } from '../polymarket/ws-client.js';
import { getPolymarketTrader } from './polymarket-trader.js';
import { getSportsService } from './sports-service.js';
import type { UserWsFinalStatus } from '../polymarket/user-ws-client.js';

// ============================================================================
// 类型定义
// ============================================================================

export interface PriceGuardConfig {
    taskId?: string;                // 任务 ID (用于 per-task 隔离，避免同 token 并发冲突)
    predictPrice: number;           // Predict 挂单价格
    polymarketTokenId: string;      // Polymarket token ID (NO)
    feeRateBps: number;             // 费率基点
    maxPolymarketPrice: number;     // 最大可接受 Polymarket 价格 (BUY 用)
    minPolymarketPrice?: number;    // 最小可接受 Polymarket 价格 (SELL 用)
    side: 'BUY' | 'SELL';           // 任务方向
    isSportsMarket?: boolean;       // 体育市场: Polymarket WS 不支持，纯 REST 轮询
}

export interface OrderWatchResult {
    filled: boolean;
    filledQty: number;
    avgPrice: number;
    error?: string;
    status?: string;
    pollCount?: number;
    pollSource?: string;
    pollElapsedMs?: number;
}

// ============================================================================
// OrderMonitor 类
// ============================================================================

export class OrderMonitor extends EventEmitter {
    private polymarketWatches: Map<string, { active: boolean; abortController: AbortController }> = new Map();
    private priceGuards: Map<string, { active: boolean; listenerId?: string; restTimer?: NodeJS.Timeout; lastValidState: boolean }> = new Map();
    private polyWsClient: PolymarketWebSocketClient | null = null;

    constructor() {
        super();
    }

    /** 注入全局 Polymarket WS 客户端（在 start-dashboard 初始化后调用） */
    setPolyWsClient(client: PolymarketWebSocketClient): void {
        this.polyWsClient = client;
    }

    // ========================================================================
    // Polymarket 订单监控 (轮询)
    // ========================================================================

    /**
     * 监控 Polymarket 订单直到成交
     *
     * 策略: User WS 为主，REST 轮询仅在 WS 断连时降级使用
     */
    async watchPolymarketOrder(
        orderId: string,
        onFill: (result: OrderWatchResult) => void,
        options?: {
            timeoutMs?: number;
            tradeWindowMs?: number;
        }
    ): Promise<void> {
        const timeoutMs = options?.timeoutMs ?? 2000;
        const tradeWindowMs = options?.tradeWindowMs;

        if (this.polymarketWatches.has(orderId)) {
            console.warn(`[OrderMonitor] Already watching Polymarket order: ${orderId.slice(0, 10)}...`);
            return;
        }

        const abortController = new AbortController();
        const watch = { active: true, abortController };
        this.polymarketWatches.set(orderId, watch);

        const polyTrader = getPolymarketTrader();

        // 直接用 pollOrderStatus (内部已有 WS+REST 混合逻辑)
        console.log(`[OrderMonitor] Watching Polymarket order: ${orderId.slice(0, 10)}...`);
        const status = await polyTrader.pollOrderStatus(orderId, timeoutMs, abortController.signal, tradeWindowMs);

        this.polymarketWatches.delete(orderId);

        if (!watch.active) {
            console.log(`[OrderMonitor] Polymarket watch aborted, skipping callback: ${orderId.slice(0, 10)}...`);
            return;
        }

        if (status) {
            if (status.status === 'MATCHED') {
                onFill({
                    filled: true,
                    filledQty: status.filledQty,
                    avgPrice: status.avgPrice,
                    status: status.status,
                    pollCount: status.pollCount,
                    pollSource: status.pollSource,
                    pollElapsedMs: status.pollElapsedMs,
                });
            } else if (status.status === 'CANCELLED') {
                onFill({
                    filled: status.filledQty > 0,
                    filledQty: status.filledQty,
                    avgPrice: status.avgPrice,
                    error: status.filledQty > 0 ? undefined : 'Order cancelled without fill',
                    status: status.status,
                    pollCount: status.pollCount,
                    pollSource: status.pollSource,
                    pollElapsedMs: status.pollElapsedMs,
                });
            } else {
                onFill({
                    filled: status.filledQty > 0,
                    filledQty: status.filledQty,
                    avgPrice: status.avgPrice,
                    status: status.status,
                    pollCount: status.pollCount,
                    pollSource: status.pollSource,
                    pollElapsedMs: status.pollElapsedMs,
                });
            }
        } else {
            onFill({ filled: false, filledQty: 0, avgPrice: 0, error: 'Order not found' });
        }
    }

    /**
     * 停止 Polymarket 订单监控
     */
    stopPolymarketWatch(orderId: string): void {
        const watch = this.polymarketWatches.get(orderId);
        if (watch) {
            watch.active = false;
            watch.abortController.abort();
            this.polymarketWatches.delete(orderId);
            console.log(`[OrderMonitor] Stopped watching Polymarket order: ${orderId.slice(0, 10)}...`);
        }
    }

    // ========================================================================
    // 价格守护 (Price Guard)
    // ========================================================================

    /**
     * 启动价格守护
     *
     * 当 Polymarket 价格上移导致套利无效时触发 onPriceInvalid
     * 当价格回落套利有效时触发 onPriceValid
     */
    async startPriceGuard(
        config: PriceGuardConfig,
        callbacks: {
            onPriceInvalid: (currentPolyPrice: number) => void;
            onPriceValid: (currentPolyPrice: number) => void;
            /** 幽灵深度检测: 对冲价位深度在短时间内频繁出现/消失 */
            onDepthUnstable?: (flipCount: number) => void;
        }
    ): Promise<void> {
        // 使用 taskId 作为 guard key (per-task 隔离)，回退到 tokenId (兼容旧调用)
        const guardId = config.taskId || config.polymarketTokenId;

        if (this.priceGuards.has(guardId)) {
            console.warn(`[OrderMonitor] Price guard already active for: ${guardId.slice(0, 10)}...`);
            return;
        }

        console.log(`[OrderMonitor] Starting price guard for token: ${config.polymarketTokenId.slice(0, 10)}... (guardId: ${guardId.slice(0, 10)}...)`);
        console.log(`  Side: ${config.side}`);
        console.log(`  Predict price: ${config.predictPrice}`);
        console.log(`  Max Poly price: ${config.maxPolymarketPrice}`);
        console.log(`  Min Poly price: ${config.minPolymarketPrice ?? 'N/A'}`);
        console.log(`  Fee: ${config.feeRateBps} bps`);

        const guard: { active: boolean; listenerId?: string; restTimer?: NodeJS.Timeout; lastValidState: boolean } = { active: true, lastValidState: true };
        this.priceGuards.set(guardId, guard);

        // ====== REST 轮询配置 (仅体育市场) ======
        const isSports = config.isSportsMarket ?? false;
        const REST_SPORTS_INTERVAL_MS = 200;  // 体育市场: 从 SportsService 0.1s 缓存读取

        // ====== 幽灵深度检测: 追踪对冲价位深度翻转 ======
        let lastHadHedgeableDepth: boolean | null = null;
        let depthFlipCount = 0;
        let depthFlipWindowStart = Date.now();
        let depthUnstableNotified = false;
        const DEPTH_FLIP_WINDOW_MS = 30_000;  // 30 秒窗口
        const DEPTH_FLIP_THRESHOLD = 6;       // 6 次翻转 = 3 轮出现/消失

        // ====== 核心检查逻辑 (WS 和 REST 共用) ======
        const checkOrderBook = (
            bids: [number, number][],
            asks: [number, number][],
            source: 'WS' | 'REST'
        ) => {
            if (!guard.active) return;

            let checkPrice: number | null = null;
            let isValid: boolean;

            if (config.side === 'BUY') {
                const bestAsk = asks.length > 0
                    ? Math.min(...asks.map(([price]) => price))
                    : null;

                if (bestAsk === null) return;

                checkPrice = bestAsk;
                isValid = this.isArbValidBuy(
                    config.predictPrice,
                    bestAsk,
                    config.feeRateBps,
                    config.maxPolymarketPrice
                );
            } else {
                const bestBid = bids.length > 0
                    ? Math.max(...bids.map(([price]) => price))
                    : null;

                if (bestBid === null) return;

                checkPrice = bestBid;
                isValid = this.isArbValidSell(
                    config.predictPrice,
                    bestBid,
                    config.minPolymarketPrice ?? 0
                );
            }

            // 状态变化时触发回调
            if (isValid !== guard.lastValidState) {
                const priceType = config.side === 'BUY' ? 'ask' : 'bid';
                if (isValid) {
                    console.log(`[OrderMonitor] Price guard: ARB VALID (poly ${priceType}: ${checkPrice.toFixed(4)}, src: ${source})`);
                    callbacks.onPriceValid(checkPrice);
                } else {
                    console.log(`[OrderMonitor] Price guard: ARB INVALID (poly ${priceType}: ${checkPrice.toFixed(4)}, src: ${source})`);
                    callbacks.onPriceInvalid(checkPrice);
                }
                guard.lastValidState = isValid;
            }

            // ====== 幽灵深度检测 (仅 WS 数据触发) ======
            if (source === 'WS' && callbacks.onDepthUnstable) {
                let hedgeableDepth = 0;
                if (config.side === 'BUY') {
                    for (const [price, size] of asks) {
                        if (price <= config.maxPolymarketPrice) hedgeableDepth += size;
                        else break;
                    }
                } else {
                    for (const [price, size] of bids) {
                        if (price >= (config.minPolymarketPrice ?? 0)) hedgeableDepth += size;
                        else break;
                    }
                }

                const hasDepth = hedgeableDepth >= 1;

                // 先检查窗口是否过期（在更新 lastHadHedgeableDepth 之前）
                const now = Date.now();
                if (now - depthFlipWindowStart > DEPTH_FLIP_WINDOW_MS) {
                    // 窗口重置时，如果当前状态与上次不同，保留为 1（携带翻转）
                    depthFlipCount = (lastHadHedgeableDepth !== null && hasDepth !== lastHadHedgeableDepth) ? 1 : 0;
                    depthFlipWindowStart = now;
                    depthUnstableNotified = false;
                } else {
                    // 窗口内：检测翻转
                    if (lastHadHedgeableDepth !== null && hasDepth !== lastHadHedgeableDepth) {
                        depthFlipCount++;
                    }
                }

                // 最后更新状态
                lastHadHedgeableDepth = hasDepth;

                if (depthFlipCount >= DEPTH_FLIP_THRESHOLD && !depthUnstableNotified) {
                    console.warn(`[OrderMonitor] 🛑 幽灵深度: 对冲价位深度在 ${((now - depthFlipWindowStart) / 1000).toFixed(0)}s 内翻转 ${depthFlipCount} 次`);
                    callbacks.onDepthUnstable(depthFlipCount);
                    depthUnstableNotified = true;
                }
            }

            this.emit('priceGuard:update', {
                tokenId: config.polymarketTokenId,
                guardId,
                polyPrice: checkPrice,
                isValid,
                side: config.side,
            });
        };

        // ====== WS 驱动的价格守护 (体育用独立 WS，非体育用主 WS) ======
        const wsClient = isSports
            ? getSportsService()?.getWsClient() ?? this.polyWsClient
            : this.polyWsClient;
        if (!wsClient) {
            console.error('[OrderMonitor] Price guard: Polymarket WS 未初始化');
            guard.lastValidState = false;
            this.emit('priceGuard:wsDisconnect', { tokenId: config.polymarketTokenId });
            return;
        }

        // 确保 token 被订阅 (体育 tokens 已由 SportsService 批量订阅，此处做自愈)
        wsClient.subscribe([config.polymarketTokenId]);

        // 注册多订阅者监听器（带 assetId 过滤）
        const listenerId = wsClient.addOrderBookListener(
            (book) => {
                if (!guard.active) return;
                checkOrderBook(book.bids, book.asks, 'WS');
            },
            config.polymarketTokenId
        );
        guard.listenerId = listenerId;
        console.log(`[OrderMonitor] Price guard using shared WS (listenerId: ${listenerId.slice(0, 8)}...${isSports ? ', sports' : ''})`);

        // 体育市场: REST 轮询兜底 (WS 断连时仍有数据)
        if (isSports) {
            const sportsRestPoll = async () => {
                if (!guard.active) return;
                // 仅在 WS 断连时执行 REST 轮询
                if (this.polyWsClient?.isConnected()) {
                    if (guard.active) guard.restTimer = setTimeout(sportsRestPoll, 2_000);
                    return;
                }
                try {
                    const cached = getSportsService().getPolyOrderbookFromCache(config.polymarketTokenId);
                    if (cached && guard.active) {
                        checkOrderBook(cached.bids, cached.asks, 'REST');
                    }
                } catch (err: any) {
                    console.warn(`[OrderMonitor] Price guard REST fallback failed:`, err?.message || err);
                }
                if (guard.active) {
                    guard.restTimer = setTimeout(sportsRestPoll, REST_SPORTS_INTERVAL_MS);
                }
            };
            guard.restTimer = setTimeout(sportsRestPoll, 2_000);
        }
    }

    /**
     * 重置价格守护的内部状态，使其在下次检查时重新触发回调
     * 用于 cancel noop 等场景，确保订单仍在簿上时能再次触发 onPriceInvalid
     */
    resetPriceGuardState(guardId: string): void {
        const guard = this.priceGuards.get(guardId);
        if (guard) {
            guard.lastValidState = true;
            console.log(`[OrderMonitor] Price guard state reset for ${guardId.slice(0, 10)}...`);
        }
    }

    /**
     * 停止价格守护
     */
    stopPriceGuard(tokenId: string): void {
        const guard = this.priceGuards.get(tokenId);
        if (guard) {
            guard.active = false;
            // 移除全局 WS 监听器
            if (guard.listenerId && this.polyWsClient) {
                this.polyWsClient.removeOrderBookListener(guard.listenerId);
            }
            if (guard.restTimer) clearTimeout(guard.restTimer);
            this.priceGuards.delete(tokenId);
            console.log(`[OrderMonitor] Stopped price guard for: ${tokenId.slice(0, 10)}...`);
        }
    }

    /**
     * 检查 BUY 套利是否有效
     *
     * Buy 套利公式: predict_yes_bid + polymarket_no_ask + fee <= 1.0
     * 同时检查 polymarket 价格是否在可接受范围内
     *
     * 注: 使用 <= 1.0 + EPSILON 是因为:
     * - Maker 模式允许零利润 (有积分奖励)
     * - 体育市场互斥事件 (yes + no = 1) 不应触发价格保护
     * - 浮点精度问题 (0.39 + 0.61 可能等于 1.0000000000000002)
     */
    private isArbValidBuy(
        predictPrice: number,
        polyNoAsk: number,
        feeRateBps: number,
        maxPolyPrice: number
    ): boolean {
        // 浮点精度容差
        const EPSILON = 0.0001;

        // 检查价格是否超过最大可接受价格 (加 epsilon 容差)
        if (polyNoAsk > maxPolyPrice + EPSILON) {
            return false;
        }

        // 计算 Predict Taker 费用 (Maker 费用为 0)
        // Taker Fee = BaseFee% * min(Price, 1-Price) * (1 - rebate)
        // Predict 有 10% 返点
        const FEE_REBATE = 0.10;
        const baseFeeRate = feeRateBps / 10000;
        const grossFee = baseFeeRate * Math.min(predictPrice, 1 - predictPrice);
        const fee = grossFee * (1 - FEE_REBATE);

        // 套利条件: total cost <= 1.0 + epsilon (允许零利润，容忍浮点精度误差)
        const totalCost = predictPrice + polyNoAsk + fee;

        return totalCost <= 1.0 + EPSILON;
    }

    /**
     * 检查 SELL 套利是否有效
     *
     * Sell 套利公式: predict_yes_ask + polymarket_no_bid >= entryCost (或 > minBid)
     * SELL 任务需要 Polymarket bid 不低于 minBid
     */
    private isArbValidSell(
        predictPrice: number,
        polyNoBid: number,
        minPolyPrice: number
    ): boolean {
        // 检查价格是否低于最小可接受价格
        if (polyNoBid < minPolyPrice) {
            return false;
        }

        // SELL 任务: 收回资金 = predictPrice + polyNoBid
        // 只要 polyNoBid >= minBid 就认为有效
        return true;
    }

    // ========================================================================
    // 工具方法
    // ========================================================================

    /**
     * 停止所有监控
     */
    stopAll(): void {
        // 停止 Polymarket 监控
        for (const orderId of this.polymarketWatches.keys()) {
            this.stopPolymarketWatch(orderId);
        }

        // 停止价格守护
        for (const tokenId of this.priceGuards.keys()) {
            this.stopPriceGuard(tokenId);
        }

        console.log('[OrderMonitor] All watches stopped');
    }

    /**
     * 获取活跃监控数量
     */
    getActiveWatchCount(): {
        polymarket: number;
        priceGuard: number;
    } {
        return {
            polymarket: this.polymarketWatches.size,
            priceGuard: this.priceGuards.size,
        };
    }
}

// ============================================================================
// 单例
// ============================================================================

let instance: OrderMonitor | null = null;

export function getOrderMonitor(): OrderMonitor {
    if (!instance) {
        instance = new OrderMonitor();
    }
    return instance;
}
