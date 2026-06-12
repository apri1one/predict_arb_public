/**
 * Poly Fill Watcher — Polymarket GTC 挂单成交监听器
 *
 * 双通道架构:
 * - 通道 1: User WS OrderEvent (实时, 按 orderId 路由)
 * - 通道 2: REST getOrderStatus 轮询 (100ms 兜底，历史值为 500ms，2026-04-18 下调)
 *
 * REST 兜底通道间隔说明:
 * - 该间隔决定 WS 断流/丢事件时 fill 检测的尾延迟上限
 * - Polymarket API 性能已验证充足，不担心 100ms 轮询触发限流
 * - restTickInFlight 互斥防止轮询叠加; mergeFilledQty 保证增量单调性
 *
 * 关键修复:
 * - 共享 watcher，但按 orderId -> ctx/session 精确路由
 * - 避免并发 POLY_MAKER 任务互相覆盖 this.ctx / this.orderId 导致串单
 *
 * delta 模式: size_matched 是累计值, 用 lastKnownSizeMatched 计算增量
 * Math.max 保证单调递增, WS 乱序不影响正确性
 */

import { EventEmitter } from 'events';
import type { PolyMakerContext, PolyFillEvent, PolyOrderTerminalEvent, PolyTradeFailedEvent } from './types.js';
import type { PolymarketTrader } from '../polymarket-trader.js';
import type { OrderEvent, TradeEvent } from '../../polymarket/user-ws-client.js';

const REST_POLL_INTERVAL = 100;
const SESSION_LINGER_MS = 5 * 60 * 1000;

type FillWaitResult =
    | { kind: 'fill'; detail: PolyFillEvent }
    | { kind: 'terminal'; detail: PolyOrderTerminalEvent }
    | { kind: 'tradeFailed'; detail: PolyTradeFailedEvent }
    | { kind: 'timeout' };

interface PolyWatchSession {
    ctx: PolyMakerContext;
    stopped: boolean;
    terminalEmitted: boolean;
}

export class PolyFillWatcher extends EventEmitter {
    private polyTrader: PolymarketTrader;
    private wsListenerId: string | null = null;
    private tradeWsListenerId: string | null = null;
    private restTimer: ReturnType<typeof setInterval> | null = null;
    private restTickInFlight = false;
    private sessions = new Map<string, PolyWatchSession>();

    constructor(polyTrader: PolymarketTrader) {
        super();
        this.polyTrader = polyTrader;
    }

    /**
     * 注册单个订单监听
     */
    start(orderId: string, ctx: PolyMakerContext): void {
        this.sessions.set(orderId, {
            ctx,
            stopped: false,
            terminalEmitted: false,
        });

        this.ensureInfrastructure();
        console.log(`[PolyFillWatcher] started: orderId=${orderId.slice(0, 12)}...`);
    }

    /**
     * 注销单个订单监听
     */
    unregister(orderId: string): void {
        const session = this.sessions.get(orderId);
        if (!session) return;
        session.stopped = true;
        this.sessions.delete(orderId);
        this.cleanupIfIdle();
        console.log(`[PolyFillWatcher] stopped: orderId=${orderId.slice(0, 12)}...`);
    }

    /**
     * 停止所有监听（兼容测试/单实例场景）
     */
    stop(): void {
        for (const orderId of Array.from(this.sessions.keys())) {
            this.unregister(orderId);
        }
        this.cleanupInfrastructure();
        console.log('[PolyFillWatcher] stopped');
    }

    /**
     * 切换监听的订单 ID (GTC 取消后重挂时使用)
     *
     * 保留 totalPolyFilled 和 totalHedged (累计值不重置)
     * 重置 delta 追踪状态
     */
    switchOrder(oldOrderId: string, newOrderId: string, ctx: PolyMakerContext): void {
        const activeCtx = this.sessions.get(oldOrderId)?.ctx || ctx;

        console.log(`[PolyFillWatcher] switchOrder: ${oldOrderId.slice(0, 12)}... -> ${newOrderId.slice(0, 12)}...`);

        // 快照当前成交量到 baseFilledQty，保证跨订单单调递增
        activeCtx.baseFilledQty = activeCtx.totalPolyFilled;
        // 重置 delta 追踪 (新订单从 0 开始累计)
        activeCtx.lastKnownSizeMatched = 0;
        activeCtx.wsFilledQty = 0;
        activeCtx.restFilledQty = 0;
        // 注意: totalPolyFilled / totalHedged / hedgePriceSum 保留

        this.unregister(oldOrderId);
        this.start(newOrderId, activeCtx);
    }

    /**
     * 等待指定订单的下一条事件
     */
    waitForEvent(orderId: string, timeoutMs: number): Promise<FillWaitResult> {
        return new Promise((resolve) => {
            const fillKey = `fill:${orderId}`;
            const terminalKey = `terminal:${orderId}`;
            const tradeFailedKey = `tradeFailed:${orderId}`;

            const onFill = (detail: PolyFillEvent) => {
                cleanup();
                resolve({ kind: 'fill', detail });
            };
            const onTerminal = (detail: PolyOrderTerminalEvent) => {
                cleanup();
                resolve({ kind: 'terminal', detail });
            };
            const onTradeFailed = (detail: PolyTradeFailedEvent) => {
                cleanup();
                resolve({ kind: 'tradeFailed', detail });
            };
            const timer = setTimeout(() => {
                cleanup();
                resolve({ kind: 'timeout' });
            }, timeoutMs);

            const cleanup = () => {
                this.removeListener(fillKey, onFill);
                this.removeListener(terminalKey, onTerminal);
                this.removeListener(tradeFailedKey, onTradeFailed);
                clearTimeout(timer);
            };

            this.once(fillKey, onFill);
            this.once(terminalKey, onTerminal);
            this.once(tradeFailedKey, onTradeFailed);
        });
    }

    // ========================================================================
    // 内部方法
    // ========================================================================

    private ensureInfrastructure(): void {
        if (!this.wsListenerId) {
            this.setupWsListener();
        }
        if (!this.tradeWsListenerId) {
            this.setupTradeEventListener();
        }
        if (!this.restTimer) {
            this.setupRestPoller();
        }
    }

    private cleanupIfIdle(): void {
        if (this.sessions.size === 0) {
            this.cleanupInfrastructure();
        }
    }

    private cleanupInfrastructure(): void {
        if (this.wsListenerId) {
            const userWs = this.polyTrader.getUserWsClient();
            if (userWs) {
                userWs.removeOrderEventListener(this.wsListenerId);
            }
            this.wsListenerId = null;
        }

        if (this.tradeWsListenerId) {
            const userWs2 = this.polyTrader.getUserWsClient();
            if (userWs2) {
                userWs2.removeTradeEventListener(this.tradeWsListenerId);
            }
            this.tradeWsListenerId = null;
        }

        if (this.restTimer) {
            clearInterval(this.restTimer);
            this.restTimer = null;
        }
    }

    private setupWsListener(): void {
        const userWs = this.polyTrader.getUserWsClient();
        if (!userWs) {
            console.warn('[PolyFillWatcher] User WS 不可用，仅 REST 轮询');
            return;
        }

        this.wsListenerId = userWs.addOrderEventListener((event: OrderEvent) => {
            const orderId = event.id;
            const session = this.sessions.get(orderId);
            if (!session || session.stopped) return;

            const sizeMatched = parseFloat(event.size_matched || '0');
            if (!Number.isFinite(sizeMatched)) return;

            const ctx = session.ctx;

            // delta 模式: Math.max 保证单调递增
            const prev = ctx.lastKnownSizeMatched;
            const delta = Math.max(0, sizeMatched - prev);
            ctx.lastKnownSizeMatched = Math.max(prev, sizeMatched);
            ctx.wsFilledQty = ctx.lastKnownSizeMatched;

            // 合并 WS + REST
            this.mergeFilledQty(ctx);

            // 终态: CANCELLATION
            if (event.type === 'CANCELLATION') {
                console.log(`[PolyFillWatcher] CANCELLATION: orderId=${orderId.slice(0, 12)}..., finalMatched=${sizeMatched}`);
                this.emitTerminal(orderId, {
                    type: 'CANCELLED',
                    filledQty: sizeMatched,
                    cancelledByUs: ctx.cancelledByUs ?? false,
                });
                return;
            }

            // 增量成交通知
            if (delta > 0) {
                console.log(`[PolyFillWatcher] WS fill: orderId=${orderId.slice(0, 12)}..., delta=${delta}, total=${sizeMatched}`);
                const fillEvent = {
                    delta,
                    total: sizeMatched,
                    source: 'WS',
                    timestamp: Date.now(),
                } as PolyFillEvent;
                this.emit('fill', fillEvent); // 兼容测试/旧监听
                this.emit(`fill:${orderId}`, fillEvent);
            }

            // 完全成交检测: size_matched >= original_size
            const originalSize = parseFloat(event.original_size || '0');
            if (originalSize > 0 && sizeMatched >= originalSize - 0.01) {
                console.log(`[PolyFillWatcher] MATCHED (WS): orderId=${orderId.slice(0, 12)}..., filled=${sizeMatched}`);
                this.emitTerminal(orderId, {
                    type: 'MATCHED',
                    filledQty: sizeMatched,
                    cancelledByUs: false,
                });
            }
        });

        console.log('[PolyFillWatcher] WS listener registered (shared)');
    }

    private setupTradeEventListener(): void {
        const userWs = this.polyTrader.getUserWsClient();
        if (!userWs) return;

        this.tradeWsListenerId = userWs.addTradeEventListener((event: TradeEvent) => {
            if (event.type !== 'TRADE') return;

            for (const makerOrder of event.maker_orders) {
                const orderId = makerOrder.order_id;

                if (event.status === 'FAILED') {
                    console.error(
                        `[PolyFillWatcher] TRADE FAILED: orderId=${orderId.slice(0, 12)}..., ` +
                        `matchedAmount=${makerOrder.matched_amount}, takerOrderId=${event.taker_order_id.slice(0, 12)}..., ` +
                        `sessionExists=${this.sessions.has(orderId)}, wsTimestamp=${event.timestamp}`,
                    );
                    const failedEvent: PolyTradeFailedEvent = {
                        orderId,
                        matchedAmount: makerOrder.matched_amount,
                        takerOrderId: event.taker_order_id,
                        timestamp: Date.now(),
                    };
                    this.emit(`tradeFailed:${orderId}`, failedEvent);
                    continue;
                }

                const session = this.sessions.get(orderId);
                if (!session || session.stopped) continue;

                if (event.status === 'RETRYING') {
                    console.warn(
                        `[PolyFillWatcher] TRADE RETRYING: orderId=${orderId.slice(0, 12)}..., ` +
                        `matchedAmount=${makerOrder.matched_amount}`,
                    );
                } else if (event.status === 'CONFIRMED') {
                    console.log(
                        `[PolyFillWatcher] TRADE CONFIRMED: orderId=${orderId.slice(0, 12)}..., ` +
                        `matchedAmount=${makerOrder.matched_amount}`,
                    );
                }
            }
        });

        console.log('[PolyFillWatcher] TradeEvent listener registered');
    }

    private setupRestPoller(): void {
        this.restTimer = setInterval(async () => {
            if (this.restTickInFlight) return;
            if (this.sessions.size === 0) {
                this.cleanupInfrastructure();
                return;
            }

            this.restTickInFlight = true;
            try {
                const orderIds = Array.from(this.sessions.keys());
                await Promise.all(orderIds.map(async (orderId) => {
                    const session = this.sessions.get(orderId);
                    if (!session || session.stopped || session.terminalEmitted) return;
                    if (session.ctx.signal.aborted) {
                        this.unregister(orderId);
                        return;
                    }

                    const status = await this.polyTrader.getOrderStatus(orderId);
                    if (!status) return;

                    const currentSession = this.sessions.get(orderId);
                    if (!currentSession || currentSession.stopped || currentSession.terminalEmitted) return;

                    const ctx = currentSession.ctx;
                    const prevRest = ctx.restFilledQty;
                    ctx.restFilledQty = Math.max(ctx.restFilledQty, status.filledQty);

                    const hadIncrease = this.mergeFilledQty(ctx);

                    // REST 检测到 WS 未覆盖的增量
                    if (ctx.restFilledQty > prevRest && hadIncrease) {
                        const delta = ctx.restFilledQty - prevRest;
                        console.log(`[PolyFillWatcher] REST fill: orderId=${orderId.slice(0, 12)}..., delta=${delta}, total=${ctx.totalPolyFilled}`);
                        const fillEvent = {
                            delta,
                            total: ctx.totalPolyFilled,
                            source: 'REST',
                            timestamp: Date.now(),
                        } as PolyFillEvent;
                        this.emit('fill', fillEvent); // 兼容测试/旧监听
                        this.emit(`fill:${orderId}`, fillEvent);
                    }

                    // 终态检测
                    if (status.status === 'MATCHED') {
                        console.log(`[PolyFillWatcher] MATCHED (REST): orderId=${orderId.slice(0, 12)}..., filled=${status.filledQty}`);
                        this.emitTerminal(orderId, {
                            type: 'MATCHED',
                            filledQty: status.filledQty,
                            cancelledByUs: false,
                        });
                    } else if (status.status === 'CANCELLED') {
                        console.log(`[PolyFillWatcher] CANCELLED (REST): orderId=${orderId.slice(0, 12)}..., filled=${status.filledQty}`);
                        this.emitTerminal(orderId, {
                            type: 'CANCELLED',
                            filledQty: status.filledQty,
                            cancelledByUs: ctx.cancelledByUs ?? false,
                        });
                    }
                }));
            } catch (err) {
                console.warn(`[PolyFillWatcher] REST poll error:`, (err as Error).message);
            } finally {
                this.restTickInFlight = false;
            }
        }, REST_POLL_INTERVAL);
    }

    /**
     * 合并 WS 和 REST 成交量 (取两者最大值)
     * @returns 是否有增量
     */
    private mergeFilledQty(ctx: PolyMakerContext): boolean {
        const prev = ctx.totalPolyFilled;
        // baseFilledQty 保证跨订单 (switchOrder) 单调递增
        const currentOrderFilled = Math.max(ctx.wsFilledQty, ctx.restFilledQty);
        ctx.totalPolyFilled = Math.max(prev, ctx.baseFilledQty + currentOrderFilled);
        return ctx.totalPolyFilled > prev;
    }

    /**
     * 防重复 terminal emit
     * WS 和 REST 可能几乎同时检测到终态，只 emit 一次
     */
    private emitTerminal(orderId: string, event: PolyOrderTerminalEvent): void {
        const session = this.sessions.get(orderId);
        if (!session || session.terminalEmitted) return;
        session.terminalEmitted = true;
        this.emit('terminal', event);
        this.emit(`terminal:${orderId}`, event);
        setTimeout(() => this.unregister(orderId), SESSION_LINGER_MS);
    }
}
