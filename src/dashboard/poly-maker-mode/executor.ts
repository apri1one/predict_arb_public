/**
 * Poly Maker Mode 执行器
 *
 * 核心流程: Polymarket GTC 挂单 → 监听成交 → Predict LIMIT@Ask 对冲
 *
 * 与 PREDICT_MAKER/TAKER 模式的区别:
 * - 挂单端: Polymarket GTC (被动 Maker, 0 fee)
 * - 对冲端: Predict LIMIT@Ask (模拟 Taker, 有 fee)
 * - 价格守护: 监控 Predict ask (而非 Poly ask)
 * - 成交监听: Poly User WS + REST 双通道 (而非 BSC WSS)
 */

import { EventEmitter } from 'events';
import type {
    PolyMakerContext,
    PolyMakerExecutorDeps,
    PredictHedgeResult,
    PolyOrderTerminalEvent,
    PolyTradeFailedEvent,
} from './types.js';
import { PolyFillWatcher } from './poly-fill-watcher.js';
import { PredictPriceGuard } from './predict-price-guard.js';
import {
    ensureHedgeMetrics,
    updateMetrics,
    formatMetricsLine,
    type HedgeMetricsSample,
} from './hedge-metrics.js';
import {
    calculateActualSharesReceived,
    checkPolyMakerShouldHedge,
    computePredictBreakevenAsk,
    computePredictHedgeCap,
    FEE_REBATE_PERCENT,
    getPolyMakerHedgeTokenId,
    getPolyMakerPredictOutcome,
    MIN_HEDGE_NOTIONAL,
    MIN_HEDGE_QTY,
    PREDICT_TICK,
} from './helpers.js';
import { POLY_MAKER_PREDICT_HEDGE_SLIPPAGE_TICKS } from '../dashboard-config.js';
import type { PredictTrader } from '../predict-trader.js';
import type { PolymarketTrader } from '../polymarket-trader.js';
import type { TaskLogger } from '../task-logger/index.js';
import type { Task } from '../types.js';
import { getSportsService } from '../sports-service.js';
import { alignPriceUp, alignQuantity } from '../../trading/price-utils.js';
import { getBscOrderWatcher, getSharesFromFillEvent, type OrderFilledEvent } from '../../services/bsc-order-watcher.js';

// ============================================================================
// 常量
// ============================================================================

/** 对冲订单 BSC WS 成交等待超时 (ms) */
const HEDGE_TIMEOUT_MS = 2_000;

/** Maker 安全检查最大等待 (ms) */
const MAKER_PRICE_CHECK_MAX_WAIT_MS = 30_000;

/** monitorAndHedge 主循环超时 (ms) */
const MONITOR_LOOP_TIMEOUT_MS = 10_000;

/** Predict 对冲允许的最大滑点（2 ticks = 0.02） */
const PREDICT_HEDGE_SLIPPAGE = POLY_MAKER_PREDICT_HEDGE_SLIPPAGE_TICKS * 0.01;

/** Predict GTC 保底轮询间隔 */
const PREDICT_FALLBACK_GTC_POLL_MS = 3_000;

/** 取消 GTC 后等待最终状态的延迟 (ms) */
const CANCEL_VERIFY_DELAY_MS = 500;

/** 最大暂停次数 — 超过后任务 FAIL (对标 P. 模式的 5 次) */
const MAX_PAUSE_COUNT = 5;

/** GTC 重挂失败最大重试次数 */
const MAX_RESUBMIT_RETRIES = 2;

// ============================================================================
// PolyMakerExecutor
// ============================================================================

export class PolyMakerExecutor extends EventEmitter {
    private predictTrader: PredictTrader;
    private polyTrader: PolymarketTrader;
    private taskLogger: TaskLogger;
    private updateTask: (taskId: string, updates: Partial<Task>) => void;
    private getTask: (taskId: string) => Task | undefined;
    private polyWsOrderbookProvider?: (tokenId: string) => { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null;
    private predictHedgeAlertCache = new Map<string, { reason: string; ts: number }>();

    private fillWatcher: PolyFillWatcher;
    private priceGuard: PredictPriceGuard;

    constructor(deps: PolyMakerExecutorDeps) {
        super();
        this.predictTrader = deps.predictTrader;
        this.polyTrader = deps.polyTrader;
        this.taskLogger = deps.taskLogger;
        this.updateTask = deps.updateTask;
        this.getTask = deps.getTask;
        this.polyWsOrderbookProvider = deps.polyWsOrderbookProvider;

        this.fillWatcher = new PolyFillWatcher(this.polyTrader);
        this.priceGuard = new PredictPriceGuard(this.predictTrader);
    }

    // ========================================================================
    // 主入口
    // ========================================================================

    /**
     * 执行 Poly Maker BUY 任务
     *
     * 1. Maker 安全检查: polyBidPrice < Poly best ask
     * 2. 提交 Polymarket GTC BUY (skipFeeCompensation=true)
     * 3. 启动 PredictPriceGuard (价格守护)
     * 4. 启动 PolyFillWatcher + monitorAndHedge 循环
     * 5. 完成/失败处理
     */
    async executePolyMakerBuy(ctx: PolyMakerContext): Promise<void> {
        const { task, signal } = ctx;
        const hedgeTokenId = this.getHedgeTokenId(task);

        // polyBidPrice 必须存在
        if (task.polyBidPrice === undefined || task.polyBidPrice === null) {
            const msg = `POLY_MAKER task missing polyBidPrice (task.polyBidPrice=${task.polyBidPrice})`;
            console.error(`[PolyMakerExecutor] Task ${task.id}: ${msg}`);
            this.updateTask(task.id, { status: 'FAILED', error: msg });
            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                status: 'FAILED',
                reason: msg,
            }).catch(() => {});
            return;
        }

        console.log(
            `[PolyMakerExecutor] 开始执行: task=${task.id}, market=${task.marketId}, ` +
            `polyBid=${task.polyBidPrice}, qty=${task.quantity}, arbSide=${task.arbSide}`,
        );

        ctx.pauseCount = Math.max(ctx.pauseCount, task.pauseCount || 0);
        ctx.currentPolyOrderId = ctx.currentPolyOrderId || task.currentPolyOrderId;
        ctx.totalPolyFilled = Math.max(ctx.totalPolyFilled, task.polyFilledQty || 0);
        ctx.restFilledQty = Math.max(ctx.restFilledQty, task.polyFilledQty || 0);
        if (ctx.currentPolyOrderId) {
            ctx.lastKnownSizeMatched = Math.max(ctx.lastKnownSizeMatched, task.polyFilledQty || 0);
        }

        // 价格保护阈值 = 保本价 (不含滑点)
        // 滑点容忍仅用于 Poly 成交后对冲执行 (computePredictHedgeCap)
        const maxPredictAsk = computePredictBreakevenAsk(task.polyBidPrice!);
        // POLY_MAKER: arbSide = Poly 主仓方向, Predict 对冲买对面
        const predictOutcome = getPolyMakerPredictOutcome(task.arbSide);
        const hedgeOutcome = predictOutcome;

        let startWithTerminalEvent: PolyOrderTerminalEvent | null = null;
        let activeOrderId = ctx.currentPolyOrderId;
        let watcherStarted = false;

        // 恢复路径：优先复用现有 GTC，而不是总是重新挂单
        if (activeOrderId) {
            const recoveredStatus = await this.polyTrader.getOrderStatus(activeOrderId);
            if (recoveredStatus) {
                ctx.restFilledQty = Math.max(ctx.restFilledQty, recoveredStatus.filledQty);
                ctx.totalPolyFilled = Math.max(ctx.totalPolyFilled, recoveredStatus.filledQty);
                this.syncPersistedProgress(ctx);

                if (recoveredStatus.status === 'LIVE') {
                    console.log(
                        `[PolyMakerExecutor] Task ${task.id}: 恢复现有 Poly GTC ${activeOrderId.slice(0, 12)}..., ` +
                        `filled=${recoveredStatus.filledQty.toFixed(2)}`,
                    );
                } else {
                    console.log(
                        `[PolyMakerExecutor] Task ${task.id}: 恢复到终态 Poly GTC ${activeOrderId.slice(0, 12)}..., ` +
                        `status=${recoveredStatus.status}, filled=${recoveredStatus.filledQty.toFixed(2)}`,
                    );
                    startWithTerminalEvent = {
                        type: recoveredStatus.status === 'MATCHED' ? 'MATCHED' : 'CANCELLED',
                        filledQty: recoveredStatus.filledQty,
                        cancelledByUs: task.status === 'PAUSED' || ctx.cancelledByUs === true,
                    };
                    ctx.currentPolyOrderId = undefined;
                    activeOrderId = undefined;
                    this.updateTask(task.id, {
                        currentPolyOrderId: undefined,
                        polyFilledQty: ctx.totalPolyFilled,
                        predictFilledQty: ctx.totalHedged,
                    });
                }
            }
        }

        let remainingMakerQty = Math.max(0, task.quantity - ctx.totalPolyFilled);

        // ====================================================================
        // 1. 如果当前没有活动 GTC，则按剩余量重新挂单
        // ====================================================================
        if (!activeOrderId && remainingMakerQty >= MIN_HEDGE_QTY) {
            const safeToSubmit = await this.waitForSafePolyMakerPrice(task, hedgeTokenId, signal);
            if (!safeToSubmit) return;

            const predictReady = await this.waitForPredictAskPrecheck(task, hedgeOutcome, maxPredictAsk, ctx.pauseCount, signal);
            if (!predictReady) return;

            const submitResult = await this.submitPolyGtcOrder(task, hedgeTokenId, remainingMakerQty);
            if (!submitResult.success || !submitResult.orderId) {
                await this.failTask(task, `Poly GTC BUY failed: ${submitResult.error}`);
                return;
            }

            ctx.currentPolyOrderId = submitResult.orderId;
            activeOrderId = submitResult.orderId;
            this.syncPersistedProgress(ctx, {
                status: 'PREDICT_SUBMITTED',
                currentPolyOrderId: submitResult.orderId,
            });

            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_STARTED', {
                status: 'PREDICT_SUBMITTED',
            }).catch(() => {});
        } else if (!activeOrderId) {
            console.log(
                `[PolyMakerExecutor] Task ${task.id}: 无需新挂单，remainingMakerQty=${remainingMakerQty.toFixed(2)}, totalPolyFilled=${ctx.totalPolyFilled.toFixed(2)}`,
            );
        }

        const currentUnhedgedAtStart = Math.max(0, ctx.totalPolyFilled - ctx.totalHedged);
        if (!activeOrderId && !startWithTerminalEvent && remainingMakerQty < MIN_HEDGE_QTY && currentUnhedgedAtStart < MIN_HEDGE_QTY && ctx.totalPolyFilled > 0) {
            await this.completeTask(task, ctx);
            return;
        }

        // ====================================================================
        // 2. 启动 PredictPriceGuard
        // ====================================================================

        this.priceGuard.start(
            task.id,
            {
                predictMarketId: task.marketId,
                arbSide: predictOutcome,  // 监控 Predict 对冲端 ask
                maxPredictAsk,
                requiredQty: remainingMakerQty,
                getRequiredQty: () => Math.max(0, task.quantity - ctx.totalPolyFilled),

                onPriceInvalid: async (currentAsk: number) => {
                    ctx.pauseCount++;

                    // MAX_PAUSE_COUNT: 超过上限直接 FAIL (对标 P. 模式)
                    if (ctx.pauseCount > MAX_PAUSE_COUNT) {
                        const msg = `PriceGuard: pauseCount ${ctx.pauseCount} > MAX ${MAX_PAUSE_COUNT}`;
                        console.error(`[PolyMakerExecutor] Task ${task.id}: ${msg}, FAIL`);
                        if (ctx.currentPolyOrderId) {
                            await this.cancelPolyGtcAndVerify(ctx);
                        }
                        await this.failTask(task, msg);
                        ctx.abortController.abort();
                        return;
                    }

                    console.log(
                        `[PolyMakerExecutor] Task ${task.id}: PriceGuard INVALID (${ctx.pauseCount}/${MAX_PAUSE_COUNT}) — ` +
                        `predictAsk=${currentAsk.toFixed(4)} > max=${maxPredictAsk.toFixed(4)}, 取消 Poly GTC`,
                    );
                    ctx.isPaused = true;
                    ctx.pausedSince = Date.now();

                    this.taskLogger.logPriceGuard(task.id, 'PRICE_GUARD_TRIGGERED', {
                        polymarketTokenId: hedgeTokenId,
                        triggerPrice: currentAsk,
                        thresholdPrice: maxPredictAsk,
                        predictPrice: task.predictPrice,
                        arbValid: false,
                        pauseCount: ctx.pauseCount,
                    }).catch(() => {});

                    // 取消 Poly GTC 并记录最终成交
                    if (ctx.currentPolyOrderId) {
                        await this.cancelPolyGtcAndVerify(ctx);
                    }

                    this.syncPersistedProgress(ctx, {
                        status: 'PAUSED',
                        pauseCount: ctx.pauseCount,
                    });

                    await this.taskLogger.logTaskLifecycle(task.id, 'TASK_PAUSED', {
                        status: 'PAUSED',
                        previousStatus: 'PREDICT_SUBMITTED',
                        reason: `PriceGuard (${ctx.pauseCount}/${MAX_PAUSE_COUNT}): predictAsk=${currentAsk.toFixed(4)} > max=${maxPredictAsk.toFixed(4)}`,
                    }).catch(() => {});
                },

                onPriceValid: async (currentAsk: number) => {
                    console.log(
                        `[PolyMakerExecutor] Task ${task.id}: PriceGuard VALID — ` +
                        `predictAsk=${currentAsk.toFixed(4)} <= max=${maxPredictAsk.toFixed(4)}, 重挂 Poly GTC`,
                    );

                    // 重新获取任务 (可能已更新)
                    const latestTask = this.getTask(task.id);
                    if (!latestTask || signal.aborted) return;

                    // 计算剩余需要挂单的数量 (扣除已成交)
                    const remainingQty = latestTask.quantity - ctx.totalPolyFilled;
                    if (remainingQty < MIN_HEDGE_QTY) {
                        console.log(`[PolyMakerExecutor] Task ${task.id}: 剩余挂单量 ${remainingQty.toFixed(2)} < MIN, 跳过重挂`);
                        ctx.isPaused = false;
                        this.syncPersistedProgress(ctx, { status: 'HEDGING' });
                        return;
                    }

                    // 重新提交 Poly GTC (带重试)
                    let resubResult: { success: boolean; orderId?: string; error?: string } = { success: false };
                    for (let attempt = 0; attempt < MAX_RESUBMIT_RETRIES; attempt++) {
                        resubResult = await this.submitPolyGtcOrder(latestTask, hedgeTokenId, remainingQty);
                        if (resubResult.success && resubResult.orderId) break;
                        console.warn(
                            `[PolyMakerExecutor] Task ${task.id}: 重挂 Poly GTC 失败 (${attempt + 1}/${MAX_RESUBMIT_RETRIES}): ${resubResult.error}`,
                        );
                        if (attempt < MAX_RESUBMIT_RETRIES - 1) await this.delay(1000);
                    }

                    if (!resubResult.success || !resubResult.orderId) {
                        // 重挂彻底失败 → FAIL 任务，防止卡死
                        const msg = `Poly GTC 重挂失败 (${MAX_RESUBMIT_RETRIES} 次): ${resubResult.error}`;
                        console.error(`[PolyMakerExecutor] Task ${task.id}: ${msg}`);
                        ctx.isPaused = false;
                        await this.failTask(task, msg);
                        ctx.abortController.abort();
                        return;
                    }

                    const previousOrderId = ctx.currentPolyOrderId;
                    ctx.currentPolyOrderId = resubResult.orderId;
                    ctx.isPaused = false;
                    ctx.cancelledByUs = false;

                    // 切换/启动 fillWatcher 到新订单
                    if (watcherStarted && previousOrderId) {
                        this.fillWatcher.switchOrder(previousOrderId, resubResult.orderId, ctx);
                    } else {
                        this.fillWatcher.start(resubResult.orderId, ctx);
                        watcherStarted = true;
                    }

                    this.syncPersistedProgress(ctx, {
                        status: 'PREDICT_SUBMITTED',
                        currentPolyOrderId: resubResult.orderId,
                    });

                    await this.taskLogger.logPriceGuard(task.id, 'PRICE_GUARD_RESUMED', {
                        polymarketTokenId: hedgeTokenId,
                        triggerPrice: currentAsk,
                        thresholdPrice: maxPredictAsk,
                        predictPrice: latestTask.predictPrice,
                        arbValid: true,
                        pauseCount: ctx.pauseCount,
                    }).catch(() => {});

                    await this.taskLogger.logTaskLifecycle(task.id, 'TASK_RESUMED', {
                        status: 'PREDICT_SUBMITTED',
                        previousStatus: 'PAUSED',
                        reason: `PriceGuard restored: predictAsk=${currentAsk.toFixed(4)}, resubmitted orderId=${resubResult.orderId}`,
                    }).catch(() => {});
                },

                onAutoFail: async (pausedMinutes: number) => {
                    console.error(
                        `[PolyMakerExecutor] Task ${task.id}: PriceGuard auto-fail after ${pausedMinutes}min paused`,
                    );
                    await this.failTask(task, `PriceGuard auto-fail: PAUSED for ${pausedMinutes}min`);

                    // 中止执行
                    ctx.abortController.abort();
                },

                onDepthUnstable: async (flipCount: number) => {
                    const latestTask = this.getTask(task.id);
                    if (!latestTask || signal.aborted) return;

                    ctx.pauseCount++;
                    console.warn(
                        `[PolyMakerExecutor] Task ${task.id}: 幽灵深度触发 PAUSE (翻转 ${flipCount} 次), pauseCount=${ctx.pauseCount}`,
                    );

                    if (ctx.pauseCount > MAX_PAUSE_COUNT) {
                        const msg = `PriceGuard: phantom depth, pauseCount ${ctx.pauseCount} > MAX ${MAX_PAUSE_COUNT}`;
                        if (ctx.currentPolyOrderId) {
                            await this.cancelPolyGtcAndVerify(ctx);
                        }
                        await this.failTask(task, msg);
                        ctx.abortController.abort();
                        return;
                    }

                    ctx.isPaused = true;
                    ctx.pausedSince = Date.now();

                    if (ctx.currentPolyOrderId) {
                        await this.cancelPolyGtcAndVerify(ctx);
                    }

                    this.syncPersistedProgress(ctx, {
                        status: 'PAUSED',
                        pauseCount: ctx.pauseCount,
                        error: `幽灵深度: Predict 对冲价位深度翻转 ${flipCount} 次`,
                    });

                    await this.taskLogger.logTaskLifecycle(task.id, 'TASK_PAUSED', {
                        status: 'PAUSED',
                        previousStatus: latestTask.status,
                        reason: `Phantom depth: ${flipCount} flips in 30s`,
                    }).catch(() => {});

                    this.taskLogger.logDepthGuard(task.id, 'DEPTH_GUARD_TRIGGERED', {
                        predictMarketId: task.marketId,
                        arbSide: predictOutcome,
                        availableDepth: 0,
                        requiredDepth: 1,
                        pauseCount: ctx.pauseCount,
                    }).catch(() => {});
                },

                // ====== 深度保护 ======
                onDepthInsufficient: async (availableDepth: number, requiredQty: number) => {
                    // 已在 PAUSED 状态则跳过 (价格保护已取消 GTC)
                    if (ctx.isPaused) return;

                    const remaining = task.quantity - ctx.totalPolyFilled;
                    if (remaining < MIN_HEDGE_QTY) return; // 已接近完成

                    console.warn(
                        `[PolyMakerExecutor] Task ${task.id}: 深度不足 — ` +
                        `available=${availableDepth.toFixed(0)} < required=${remaining.toFixed(0)}, 取消 GTC`,
                    );

                    ctx.isPaused = true;
                    ctx.depthPausedChecks++;
                    ctx.pausedSince = Date.now();

                    this.taskLogger.logDepthGuard(task.id, 'DEPTH_GUARD_TRIGGERED', {
                        predictMarketId: task.marketId,
                        arbSide: predictOutcome,
                        availableDepth,
                        requiredDepth: remaining,
                        pauseCount: ctx.pauseCount,
                        currentAsk: undefined,
                        maxAllowedAsk: maxPredictAsk,
                    }).catch(() => {});

                    if (ctx.currentPolyOrderId) {
                        await this.cancelPolyGtcAndVerify(ctx);
                    }

                    this.syncPersistedProgress(ctx, {
                        status: 'PAUSED',
                        pauseCount: ctx.pauseCount,
                    });

                    await this.taskLogger.logTaskLifecycle(task.id, 'TASK_PAUSED', {
                        status: 'PAUSED',
                        previousStatus: 'PREDICT_SUBMITTED',
                        reason: `Depth: available=${availableDepth.toFixed(0)} < required=${remaining.toFixed(0)}`,
                    }).catch(() => {});
                },

                onDepthRecovered: async (availableDepth: number) => {
                    if (ctx.depthPausedChecks > 0) {
                        console.log(
                            `[PolyMakerExecutor] Task ${task.id}: 深度恢复 — depth=${availableDepth.toFixed(0)}`,
                        );
                        this.taskLogger.logDepthGuard(task.id, 'DEPTH_GUARD_RESUMED', {
                            predictMarketId: task.marketId,
                            arbSide: predictOutcome,
                            availableDepth,
                            requiredDepth: Math.max(0, task.quantity - ctx.totalPolyFilled),
                            pauseCount: ctx.pauseCount,
                            currentAsk: undefined,
                            maxAllowedAsk: maxPredictAsk,
                        }).catch(() => {});
                        ctx.depthPausedChecks = 0;
                    }
                    // 实际重挂由 onPriceValid 处理 (价格+深度同时满足才恢复)
                },
            },
            signal,
        );

        // ====================================================================
        // 3. 启动 PolyFillWatcher + monitorAndHedge
        // ====================================================================
        if (activeOrderId) {
            this.fillWatcher.start(activeOrderId, ctx);
            watcherStarted = true;
        }

        try {
            await this.monitorAndHedge(ctx, startWithTerminalEvent);
        } finally {
            // ================================================================
            // 5. 清理
            // ================================================================
            this.priceGuard.stop(task.id);

            // 有成交的订单不立即 unregister，保留 session 等待可能的 TradeEvent FAILED
            if (ctx.currentPolyOrderId && ctx.totalPolyFilled > 0) {
                this.startTradeFailedLinger(ctx);
            } else if (ctx.currentPolyOrderId) {
                this.fillWatcher.unregister(ctx.currentPolyOrderId);
            }

            // 信号中止 (定时过期 / 用户取消) → 撤销 Poly GTC 挂单 + 对冲残留敞口
            if (ctx.signal.aborted && ctx.currentPolyOrderId) {
                console.log(`[PolyMakerExecutor] 信号中止，取消残留 Poly GTC: ${ctx.currentPolyOrderId.slice(0, 12)}...`);
                await this.cancelPolyGtcAndVerify(ctx).catch((e: any) => {
                    console.warn(`[PolyMakerExecutor] 清理取消失败: ${e.message}`);
                });

                // 取消后发现有未对冲的 Poly 成交 → 补对冲
                const cancelUnhedged = ctx.totalPolyFilled - ctx.totalHedged;
                if (cancelUnhedged >= MIN_HEDGE_QTY) {
                    console.warn(
                        `[PolyMakerExecutor] Task ${task.id}: 取消时发现未对冲敞口 ${cancelUnhedged.toFixed(2)}, 执行补对冲`,
                    );
                    const hedgeResult = await this.executePredictHedge(ctx, cancelUnhedged).catch((e: any) => {
                        console.error(`[PolyMakerExecutor] 补对冲异常: ${e.message}`);
                        return { success: false, actualReceived: 0, grossQty: 0, avgPrice: 0, error: e.message } as PredictHedgeResult;
                    });
                    if (hedgeResult.success) {
                        console.log(
                            `[PolyMakerExecutor] Task ${task.id}: 补对冲完成 — actual=${hedgeResult.actualReceived.toFixed(2)}, totalHedged=${ctx.totalHedged.toFixed(2)}`,
                        );
                    } else {
                        console.error(
                            `[PolyMakerExecutor] Task ${task.id}: 补对冲失败 — ${hedgeResult.error}, 未对冲=${cancelUnhedged.toFixed(2)}`,
                        );
                        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                            status: 'FAILED',
                            reason: `取消后补对冲失败: unhedged=${cancelUnhedged.toFixed(2)}, error=${hedgeResult.error}`,
                        }).catch(() => {});
                    }
                    // 同步最终状态
                    this.syncPersistedProgress(ctx, {});
                }
            }
        }
    }

    // ========================================================================
    // monitorAndHedge 主循环
    // ========================================================================

    /**
     * 等待 fill / terminal 事件，驱动对冲循环
     *
     * 对标 task-executor.ts 的 monitorAndHedge，但事件源是 PolyFillWatcher
     */
    private async monitorAndHedge(
        ctx: PolyMakerContext,
        initialTerminalEvent?: PolyOrderTerminalEvent | null,
    ): Promise<void> {
        const task = ctx.task;
        let pendingTerminalEvent = initialTerminalEvent ?? null;
        // PAUSED 分支防空转：记录上次已尝试对冲的 unhedged 值
        // 只有敞口增长（新 fill 到达）才再次发对冲请求，避免残余金额过小时 2Hz 空转
        let lastPausedHedgeUnhedged = 0;

        while (!ctx.signal.aborted) {
            const activeOrderId = ctx.currentPolyOrderId;
            const event = pendingTerminalEvent
                ? { kind: 'terminal' as const, detail: pendingTerminalEvent, historical: true as const }
                : activeOrderId
                    ? await this.fillWatcher.waitForEvent(activeOrderId, MONITOR_LOOP_TIMEOUT_MS)
                    : { kind: 'timeout' as const };

            pendingTerminalEvent = null;

            if (ctx.signal.aborted) break;

            // 打点：记录外部事件到达时刻，作为 e2e 延迟的起点
            if (event.kind === 'fill') {
                ctx.lastFillRecvTs = event.detail.timestamp;
            } else if (event.kind === 'terminal') {
                ctx.lastFillRecvTs = Date.now();
            }

            this.syncPersistedProgress(ctx);

            // TradeEvent FAILED: 链上结算回滚，按卖一价紧急回补
            if (event.kind === 'tradeFailed') {
                const failDetail = event.detail as PolyTradeFailedEvent;
                const failedAmount = parseFloat(failDetail.matchedAmount) || 0;
                const exposure = ctx.totalHedged;
                console.error(
                    `[PolyMakerExecutor] Task ${task.id}: TRADE FAILED — ` +
                    `orderId=${failDetail.orderId.slice(0, 12)}..., ` +
                    `matchedAmount=${failedAmount}, exposure=${exposure.toFixed(2)}`,
                );

                await this.taskLogger.logOrderEvent(
                    task.id,
                    'TRADE_SETTLEMENT_FAILED',
                    {
                        platform: 'polymarket',
                        orderId: failDetail.orderId,
                        side: 'BUY',
                        price: task.polyBidPrice || 0,
                        quantity: task.quantity,
                        filledQty: ctx.totalPolyFilled,
                        remainingQty: Math.max(0, task.quantity - ctx.totalPolyFilled),
                        avgPrice: task.polyBidPrice || 0,
                        title: this.getPolyMarketDisplayTitle(task),
                    } as any,
                    failDetail.orderId,
                ).catch(() => {});

                // 回滚 totalPolyFilled (链上未实际成交)
                const rolledBack = Math.min(failedAmount || ctx.totalPolyFilled, ctx.totalPolyFilled);
                ctx.totalPolyFilled = Math.max(0, ctx.totalPolyFilled - rolledBack);
                ctx.lastKnownSizeMatched = 0;
                ctx.wsFilledQty = 0;
                ctx.restFilledQty = 0;
                ctx.baseFilledQty = ctx.totalPolyFilled;

                if (exposure > 0) {
                    // 有已对冲仓位 = 裸敞口，紧急按卖一价回补
                    const hedgeTokenId = this.getHedgeTokenId(task);
                    let orderbook = this.polyWsOrderbookProvider?.(hedgeTokenId) ?? null;
                    if (!orderbook || orderbook.asks.length === 0) {
                        orderbook = await this.polyTrader.getOrderbook(hedgeTokenId);
                    }

                    const bestAsk = orderbook?.asks?.[0]?.price;
                    if (!bestAsk) {
                        this.alertPin(
                            `\u{1F6A8} [POLY_MAKER][TRADE_FAILED] ${task.id}\n`
                            + `\u5E02\u573A: ${task.title}\n`
                            + `\u94FE\u4E0A\u7ED3\u7B97\u56DE\u6EDA! \u88F8\u6572\u53E3=${this.formatNum(exposure)}\n`
                            + `\u65E0\u6CD5\u83B7\u53D6 Poly \u5356\u4E00\u4EF7\uFF0C\u9700\u4EBA\u5DE5\u5904\u7406`,
                        );
                        continue;
                    }

                    console.log(
                        `[PolyMakerExecutor] Task ${task.id}: \u7D27\u6025\u56DE\u8865 — ` +
                        `exposure=${exposure.toFixed(2)}, polyAsk=${bestAsk}`,
                    );

                    this.alertPin(
                        `\u{1F6A8} [POLY_MAKER][TRADE_FAILED] ${task.id}\n`
                        + `\u5E02\u573A: ${task.title}\n`
                        + `\u94FE\u4E0A\u7ED3\u7B97\u56DE\u6EDA! \u88F8\u6572\u53E3=${this.formatNum(exposure)}\n`
                        + `\u7D27\u6025\u6309\u5356\u4E00\u4EF7 ${bestAsk} \u56DE\u8865\u4E2D...`,
                    );

                    const rebuyResult = await this.polyTrader.placeOrder({
                        tokenId: hedgeTokenId,
                        side: 'BUY',
                        price: bestAsk,
                        quantity: exposure,
                        orderType: 'GTC',
                        outcome: task.arbSide || 'YES',
                        outcomeName: this.getPolyOutcomeDisplayName(task, hedgeTokenId),
                        marketTitle: this.getPolyMarketDisplayTitle(task),
                        negRisk: task.negRisk,
                        skipFeeCompensation: true,
                        conditionId: task.polymarketConditionId,
                    });

                    if (rebuyResult.success && rebuyResult.orderId) {
                        console.log(
                            `[PolyMakerExecutor] Task ${task.id}: \u7D27\u6025\u56DE\u8865\u5355\u5DF2\u63D0\u4EA4 — ` +
                            `orderId=${rebuyResult.orderId.slice(0, 12)}..., price=${bestAsk}, qty=${exposure.toFixed(2)}`,
                        );
                        ctx.currentPolyOrderId = rebuyResult.orderId;
                        // 回补单补回被链上回滚的 Poly 头寸，Predict 侧 exposure 未回滚仍然存在。
                        // 预先把 totalHedged 抬高 exposure，避免 mergeFilledQty 把回补 fill 当作新成交触发二次对冲。
                        ctx.totalHedged += exposure;
                        this.fillWatcher.start(rebuyResult.orderId, ctx);

                        this.alertPin(
                            `\u2705 [POLY_MAKER][REBUY_SUBMITTED] ${task.id}\n`
                            + `\u5E02\u573A: ${task.title}\n`
                            + `\u56DE\u8865\u5355\u5DF2\u63D0\u4EA4: ${exposure.toFixed(2)} @ ${bestAsk}\n`
                            + `orderId: ${rebuyResult.orderId.slice(0, 16)}...`,
                        );
                    } else {
                        console.error(
                            `[PolyMakerExecutor] Task ${task.id}: \u7D27\u6025\u56DE\u8865\u5931\u8D25 — ${rebuyResult.error}`,
                        );
                        this.alertPin(
                            `\u{1F6A8} [POLY_MAKER][REBUY_FAILED] ${task.id}\n`
                            + `\u5E02\u573A: ${task.title}\n`
                            + `\u7D27\u6025\u56DE\u8865\u5931\u8D25! \u88F8\u6572\u53E3=${this.formatNum(exposure)}\n`
                            + `\u9519\u8BEF: ${rebuyResult.error}\n`
                            + `\u9700\u8981\u4EBA\u5DE5\u5904\u7406`,
                        );
                    }
                } else {
                    this.alertPin(
                        `\u26A0\uFE0F [POLY_MAKER][TRADE_FAILED] ${task.id}\n`
                        + `\u5E02\u573A: ${task.title}\n`
                        + `\u94FE\u4E0A\u7ED3\u7B97\u56DE\u6EDA (\u65E0\u5BF9\u51B2\u6572\u53E3)\n`
                        + `matchedAmount=${failedAmount}`,
                    );
                }

                continue;
            }

            // PAUSED 状态下仍需对冲已成交的敞口 (GTC 取消前可能已部分成交)
            const unhedged = ctx.totalPolyFilled - ctx.totalHedged;

            if (ctx.isPaused) {
                // 有未对冲量 → 先对冲再等待恢复
                // 残余敞口金额过小（min-notional 失败）会把自己累计到 ctx.pendingHedgeQty，
                // 此处用 lastPausedHedgeUnhedged 追踪，只有 unhedged 增长后（新 fill 到达）才再发请求，
                // 避免同一笔残余每 500ms 重试一次造成 TG / 日志风暴
                if (unhedged >= MIN_HEDGE_QTY && unhedged > lastPausedHedgeUnhedged + 1e-6) {
                    console.log(
                        `[PolyMakerExecutor] Task ${task.id}: PAUSED 但有未对冲敞口 ${unhedged.toFixed(2)}, 执行对冲`,
                    );
                    lastPausedHedgeUnhedged = unhedged;
                    await this.executePredictHedge(ctx, unhedged);
                    this.syncPersistedProgress(ctx, {});
                }
                await this.delay(500);
                continue;
            }
            // 非 PAUSED：重置 PAUSED 追踪器，下次进入 paused 时可重新尝试
            lastPausedHedgeUnhedged = 0;
            const isTerminal = event.kind === 'terminal';

            // Poly 侧成交通知 (触发 TG 推送)
            if (event.kind === 'fill') {
                const fillDetail = event.detail;
                const isFullyFilled = ctx.totalPolyFilled >= task.quantity - 0.5;
                await this.taskLogger.logOrderEvent(
                    task.id,
                    isFullyFilled ? 'ORDER_FILLED' : 'ORDER_PARTIAL_FILL',
                    {
                        platform: 'polymarket',
                        orderId: activeOrderId || '',
                        side: 'BUY',
                        outcome: task.arbSide || 'YES',
                        price: task.polyBidPrice || 0,
                        quantity: task.quantity,
                        filledQty: ctx.totalPolyFilled,
                        remainingQty: Math.max(0, task.quantity - ctx.totalPolyFilled),
                        avgPrice: task.polyBidPrice || 0,
                        title: this.getPolyMarketDisplayTitle(task),
                        outcomeName: this.getPolyOutcomeDisplayName(task, this.getHedgeTokenId(task)),
                    },
                    activeOrderId,
                ).catch(() => {});

                // 仅使用 Polymarket User WS 成交通知推送 TG，避免 REST fallback 噪音/重复
                if (fillDetail.source === 'WS') {
                    const hedgeTokenId = this.getHedgeTokenId(task);
                    this.polyTrader.notifyOrderAlert({
                        type: isFullyFilled ? 'FILLED' : 'PARTIAL_FILL',
                        platform: 'POLYMARKET',
                        marketName: this.getPolyMarketDisplayTitle(task),
                        action: 'BUY',
                        side: task.arbSide || 'YES',
                        outcome: this.getPolyOutcomeDisplayName(task, hedgeTokenId),
                        price: task.polyBidPrice || 0,
                        quantity: task.quantity,
                        filledQuantity: ctx.totalPolyFilled,
                        filledDelta: fillDetail.delta,
                        timestamp: fillDetail.timestamp,
                        role: 'Maker',
                        orderHash: activeOrderId,
                        dataSource: 'Polymarket User WS',
                    });
                }
            }

            if (unhedged > 0) {
                const shouldHedge = this.checkShouldHedge(ctx, unhedged, isTerminal);
                if (shouldHedge.shouldHedge) {
                    console.log(
                        `[PolyMakerExecutor] Task ${task.id}: 触发对冲 — unhedged=${unhedged.toFixed(2)}, ` +
                        `hedgeQty=${shouldHedge.hedgeQty.toFixed(2)}, event=${event.kind}`,
                    );

                    const result = await this.executePredictHedge(ctx, shouldHedge.hedgeQty);

                    if (result.success) {
                        this.syncPersistedProgress(ctx, {
                            status: ctx.currentPolyOrderId ? 'HEDGING' : ctx.task.status,
                        });

                        console.log(
                            `[PolyMakerExecutor] Task ${task.id}: 对冲完成 — actual=${result.actualReceived.toFixed(2)}, ` +
                            `totalHedged=${ctx.totalHedged.toFixed(2)}/${ctx.totalPolyFilled.toFixed(2)}`,
                        );
                    } else {
                        console.error(
                            `[PolyMakerExecutor] Task ${task.id}: 对冲失败 — ${result.error}`,
                        );
                    }
                }
            }

            // 终态处理
            if (isTerminal) {
                const terminalDetail = event.detail;
                const isHistoricalTerminal = 'historical' in event && event.historical === true;

                console.log(
                    `[PolyMakerExecutor] Task ${task.id}: 终态事件 — type=${terminalDetail.type}, ` +
                    `filledQty=${terminalDetail.filledQty}, cancelledByUs=${terminalDetail.cancelledByUs}, ` +
                    `totalPolyFilled=${ctx.totalPolyFilled.toFixed(2)}`,
                );

                // CANCELLED + 0 成交 + 非我们取消 = 异常取消，不应标记 COMPLETED
                const wasCancelledExternally = terminalDetail.type === 'CANCELLED'
                    && ctx.totalPolyFilled < MIN_HEDGE_QTY
                    && !terminalDetail.cancelledByUs
                    && !ctx.cancelledByUs;

                if (wasCancelledExternally) {
                    // 查一次 REST 获取取消原因 (WS 不携带 cancel_reason)
                    let cancelReason: string | undefined;
                    if (ctx.currentPolyOrderId) {
                        const orderStatus = await this.polyTrader.getOrderStatus(ctx.currentPolyOrderId).catch(() => null);
                        cancelReason = orderStatus?.cancelReason;
                    }
                    const reason = cancelReason
                        ? `Poly GTC cancelled externally (${cancelReason}), 0 fills`
                        : 'Poly GTC cancelled externally, 0 fills';
                    console.warn(
                        `[PolyMakerExecutor] Task ${task.id}: GTC 订单被外部取消 (0 成交, reason=${cancelReason ?? 'unknown'})，标记 FAILED`,
                    );
                    if (isHistoricalTerminal && ctx.currentPolyOrderId) {
                        await this.cancelPolyGtcAndVerify(ctx).catch(() => {});
                    }
                    await this.failTask(task, reason);
                    break;
                }

                // 最后一轮: 处理剩余未对冲
                const finalUnhedged = ctx.totalPolyFilled - ctx.totalHedged;
                if (finalUnhedged > 0 && finalUnhedged < MIN_HEDGE_QTY) {
                    this.alertPin(
                        `⚠️ [POLY_MAKER][CANCEL_HEDGE_SKIPPED] ${task.id}\n`
                        + `市场: ${task.title}\n`
                        + `敞口过小: ${this.formatNum(finalUnhedged)} < ${MIN_HEDGE_QTY}`
                    );
                }
                if (finalUnhedged > 0) {
                    console.log(
                        `[PolyMakerExecutor] Task ${task.id}: 终态剩余对冲 — finalUnhedged=${finalUnhedged.toFixed(2)}`,
                    );
                    await this.executePredictHedge(ctx, finalUnhedged);
                }

                const stillUnhedged = Math.max(0, ctx.totalPolyFilled - ctx.totalHedged);
                if (stillUnhedged < MIN_HEDGE_QTY && finalUnhedged > 0) {
                    this.alertPin(
                        `✅ [POLY_MAKER][CANCEL_HEDGED] ${task.id}\n`
                        + `市场: ${task.title}\n`
                        + `原始敞口: ${this.formatNum(finalUnhedged)}\n`
                        + `已对冲: ${this.formatNum(ctx.totalHedged)}`
                    );
                }
                if (stillUnhedged >= MIN_HEDGE_QTY) {
                    if (isHistoricalTerminal && ctx.currentPolyOrderId) {
                        console.warn(
                            `[PolyMakerExecutor] Task ${task.id}: 历史终态仍有未对冲 ${stillUnhedged.toFixed(2)}，当前已有新 GTC，继续主循环跟踪`,
                        );
                        continue;
                    }

                    const fallback = await this.placePredictFallbackGtc(ctx, stillUnhedged);
                    if (!fallback.success || !fallback.orderHash) {
                        await this.failTask(
                            task,
                            fallback.error || `Predict hedge incomplete after terminal: unhedged=${stillUnhedged.toFixed(2)}`,
                            {
                                polyFilledQty: ctx.totalPolyFilled,
                                predictFilledQty: ctx.totalHedged,
                                hedgedQty: ctx.totalHedged,
                                remainingQty: stillUnhedged,
                                currentPolyOrderId: undefined,
                                currentOrderHash: undefined,
                            },
                        );
                        break;
                    }

                    await this.monitorPredictFallbackGtc(ctx, fallback.orderHash, stillUnhedged, fallback.limitPrice!);
                    break;
                }

                if (isHistoricalTerminal && ctx.currentPolyOrderId) {
                    console.log(
                        `[PolyMakerExecutor] Task ${task.id}: 历史终态已处理，继续跟踪新 GTC ${ctx.currentPolyOrderId.slice(0, 12)}...`,
                    );
                    continue;
                }

                await this.completeTask(task, ctx);

                break;
            }
        }
    }

    // ========================================================================
    // executePredictHedge — 核心对冲逻辑
    // ========================================================================

    /**
     * 在 Predict 执行对冲 (LIMIT@Ask, 逐级抬价重试)
     *
     * 对标 task-executor.ts 的 executeIncrementalHedge，但方向反转:
     * - 原模式: Predict 成交 → Poly 对冲
     * - 本模式: Poly 成交 → Predict 对冲
     */
    private async executePredictHedge(
        ctx: PolyMakerContext,
        targetQty: number,
    ): Promise<PredictHedgeResult> {
        // 对冲互斥
        if (ctx.isHedgingInProgress) {
            return {
                success: false,
                actualReceived: 0,
                grossQty: 0,
                avgPrice: 0,
                error: 'Hedge in progress',
            };
        }
        ctx.isHedgingInProgress = true;

        const task = ctx.task;
        const feeRateBps = task.feeRateBps || 200;
        const outcome = getPolyMakerPredictOutcome(task.arbSide);
        const attemptId = Math.random().toString(36).substring(2, 10);
        const maxAllowedAsk = computePredictHedgeCap(task.polyBidPrice || 0, PREDICT_HEDGE_SLIPPAGE);
        const tHedgeStart = Date.now();
        // Snapshot e2e 起点（fill/terminal 事件到达时刻），并立即消费 ctx 字段避免下次对冲复用过期值
        const fillRecvTs = ctx.lastFillRecvTs;
        ctx.lastFillRecvTs = undefined;
        let lastFailureReason = '';

        try {
            // 记录对冲开始
            await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_STARTED', {
                hedgeQty: targetQty,
                totalHedged: ctx.totalHedged,
                totalPredictFilled: ctx.totalPolyFilled,
                avgHedgePrice: 0,
                retryCount: 0,
                reason: `Predict LIMIT hedge (maxAsk=${maxAllowedAsk.toFixed(4)})`,
            }, attemptId).catch(() => {});

            // LIMIT 重试：
            // 1) 先按任务配置价 task.predictPrice 下单
            // 2) 失败后改为追 best ask
            // 3) 只要 best ask 仍在“成本价 + 滑点容忍”内，就继续重试
            const maxRetries = task.maxHedgeRetries || 3;
            let totalReceived = 0;
            let totalPriceSum = 0;
            let remaining = targetQty;
            let lastHash: string | undefined;
            /** 实际执行的 attempt 次数（含第一次），用于 metrics.retries = actualAttempts - 1 */
            let actualAttempts = 0;

            for (let attempt = 0; attempt <= maxRetries && remaining >= MIN_HEDGE_QTY; attempt++) {
                actualAttempts = attempt + 1;
                if (ctx.signal.aborted) {
                    lastFailureReason = 'signal aborted';
                    break;
                }

                const book = await this.predictTrader.getOrderbook(task.marketId);
                if (!book) {
                    lastFailureReason = 'Predict orderbook unavailable';
                    console.warn(`[PolyMakerExecutor] ${lastFailureReason}`);
                    this.alertPredictHedgeError(task, lastFailureReason, {
                        attempt,
                        targetQty: remaining,
                    });
                    break;
                }

                let bestAsk: number;
                if (outcome === 'YES') {
                    if (book.asks.length === 0) {
                        lastFailureReason = '无可用卖单 (YES ask)';
                        console.warn(`[PolyMakerExecutor] ${lastFailureReason}`);
                        this.alertPredictHedgeError(task, lastFailureReason, {
                            attempt,
                            targetQty: remaining,
                        });
                        break;
                    }
                    bestAsk = book.asks[0][0];
                } else {
                    if (book.bids.length === 0) {
                        lastFailureReason = '无可用买单 (NO 转换)';
                        console.warn(`[PolyMakerExecutor] ${lastFailureReason}`);
                        this.alertPredictHedgeError(task, lastFailureReason, {
                            attempt,
                            targetQty: remaining,
                        });
                        break;
                    }
                    bestAsk = Number((1 - book.bids[0][0]).toFixed(6));
                }

                const desiredPrice = attempt === 0
                    ? Number((task.predictPrice || bestAsk).toFixed(6))
                    : bestAsk;
                const askPrice = alignPriceUp(desiredPrice, PREDICT_TICK);

                if (askPrice > maxAllowedAsk + 1e-9) {
                    lastFailureReason =
                        `Predict ask 超出滑点容忍: ask=${askPrice.toFixed(4)} > max=${maxAllowedAsk.toFixed(4)}`;
                    console.warn(`[PolyMakerExecutor] ${lastFailureReason}`);
                    this.alertPredictHedgeError(task, lastFailureReason, {
                        attempt,
                        askPrice,
                        bestAsk,
                        targetQty: remaining,
                    });
                    break;
                }

                // Fee 补偿: 多买以弥补 fee 扣减
                const feePerShare =
                    (feeRateBps / 10000) *
                    Math.min(askPrice, 1 - askPrice) *
                    (1 - FEE_REBATE_PERCENT);
                const feeAsSharePercent = feePerShare / askPrice;
                const grossQty = Math.max(1, alignQuantity(remaining / (1 - feeAsSharePercent)));

                // 最小订单检查
                if (grossQty * askPrice < MIN_HEDGE_NOTIONAL) {
                    const notional = grossQty * askPrice;
                    lastFailureReason = `对冲名义金额过小: ${notional.toFixed(4)} < ${MIN_HEDGE_NOTIONAL}`;
                    if (remaining >= MIN_HEDGE_QTY) {
                        ctx.pendingHedgeQty += remaining;
                    }
                    console.log(
                        `[PolyMakerExecutor] ${lastFailureReason}, 累计到 pendingHedgeQty`,
                    );
                    break;
                }

                const alignedPrice = alignPriceUp(askPrice, PREDICT_TICK);

                // 记录对冲尝试
                await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_ATTEMPT', {
                    hedgeQty: remaining,
                    totalHedged: ctx.totalHedged,
                    totalPredictFilled: ctx.totalPolyFilled,
                    avgHedgePrice: totalReceived > 0 ? totalPriceSum / totalReceived : 0,
                    retryCount: attempt,
                    reason: attempt === 0
                        ? `initial limit @ ${askPrice.toFixed(4)}`
                        : `best ask retry @ ${askPrice.toFixed(4)} (max=${maxAllowedAsk.toFixed(4)})`,
                }, attemptId).catch(() => {});

                console.log(
                    `[PolyMakerExecutor] Predict hedge attempt ${attempt + 1}: ` +
                    `price=${askPrice}, bestAsk=${bestAsk.toFixed(4)}, grossQty=${grossQty}, target=${remaining.toFixed(2)}`,
                );

                // 提交订单
                const tPlaceStart = Date.now();
                const result = await this.predictTrader.placeOrder({
                    marketId: task.marketId,
                    side: 'BUY',
                    price: askPrice,
                    quantity: grossQty,
                    outcome,
                });
                const tSubmit = Date.now();

                if (!result.success || !result.hash) {
                    lastFailureReason = result.error || 'Predict hedge submit failed';
                    console.error(
                        `[PolyMakerExecutor] Predict 下单失败: ${lastFailureReason}`,
                    );
                    this.alertPredictHedgeError(task, lastFailureReason, {
                        attempt,
                        askPrice,
                        bestAsk,
                        targetQty: remaining,
                        grossQty,
                    });
                    await this.taskLogger.logOrderEvent(task.id, 'ORDER_FAILED', {
                        platform: 'predict',
                        orderId: `hedge-attempt-${attempt + 1}`,
                        side: 'BUY',
                        outcome,
                        price: askPrice,
                        quantity: grossQty,
                        filledQty: 0,
                        remainingQty: grossQty,
                        avgPrice: 0,
                        cancelReason: lastFailureReason,
                    }).catch(() => {});
                    continue;
                }

                lastHash = result.hash;
                await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                    platform: 'predict',
                    orderId: result.hash,
                    side: 'BUY',
                    outcome,
                    price: askPrice,
                    quantity: grossQty,
                    filledQty: 0,
                    remainingQty: grossQty,
                    avgPrice: 0,
                }, result.hash).catch(() => {});

                // 等待成交 (BSC WS 事件驱动)
                const orderStatus = await this.waitForPredictFill(
                    result.hash, HEDGE_TIMEOUT_MS, grossQty,
                    { tPlaceStart, tSubmit, attempt },
                );

                let filled = orderStatus?.filledQty || 0;
                const avgPrice = orderStatus?.avgPrice || askPrice;

                // 超时/部分成交 → 取消剩余（并行发起 cancel + finalStatus 查询）
                if (orderStatus?.status !== 'FILLED' && filled < grossQty) {
                    lastFailureReason = `Hedge status=${orderStatus?.status || 'TIMEOUT'}`;
                    const [, finalStatusResult] = await Promise.allSettled([
                        this.predictTrader.cancelOrder(result.hash),
                        this.predictTrader.getOrderStatus(result.hash),
                    ]);
                    if (finalStatusResult.status === 'fulfilled' && finalStatusResult.value) {
                        filled = Math.max(filled, finalStatusResult.value.filledQty);
                    }
                    await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                        platform: 'predict',
                        orderId: result.hash,
                        side: 'BUY',
                        outcome,
                        price: askPrice,
                        quantity: grossQty,
                        filledQty: filled,
                        remainingQty: Math.max(0, grossQty - filled),
                        avgPrice,
                        cancelReason: lastFailureReason,
                    }, result.hash).catch(() => {});
                }

                if (filled > 0) {
                    this.clearPredictHedgeAlertCache(task.id);
                    const actualReceived = calculateActualSharesReceived(
                        filled,
                        avgPrice,
                        feeRateBps,
                    );
                    totalReceived += actualReceived;
                    totalPriceSum += actualReceived * avgPrice;
                    remaining = targetQty - totalReceived;

                    ctx.totalHedged += actualReceived;
                    ctx.hedgePriceSum += actualReceived * avgPrice;
                    this.syncPersistedProgress(ctx, { status: ctx.currentPolyOrderId ? 'HEDGING' : ctx.task.status });

                    console.log(
                        `[PolyMakerExecutor] Predict hedge filled: gross=${filled}, ` +
                        `actual=${actualReceived.toFixed(2)}, remaining=${remaining.toFixed(2)}`,
                    );

                    await this.taskLogger.logOrderEvent(
                        task.id,
                        remaining < MIN_HEDGE_QTY ? 'ORDER_FILLED' : 'ORDER_PARTIAL_FILL',
                        {
                            platform: 'predict',
                            orderId: result.hash,
                            side: 'BUY',
                            outcome,
                            price: askPrice,
                            quantity: grossQty,
                            filledQty: filled,
                            remainingQty: Math.max(0, grossQty - filled),
                            avgPrice,
                        },
                        result.hash,
                    ).catch(() => {});

                    await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_PARTIAL', {
                        hedgeQty: actualReceived,
                        totalHedged: ctx.totalHedged,
                        totalPredictFilled: ctx.totalPolyFilled,
                        avgHedgePrice: avgPrice,
                        retryCount: attempt,
                    }, attemptId).catch(() => {});
                } else {
                    lastFailureReason = lastFailureReason || `0 fill at ${askPrice.toFixed(4)}`;
                    console.log(
                        `[PolyMakerExecutor] Predict hedge 0 fill on attempt ${attempt + 1}`,
                    );
                }
            }

            // 记录对冲完成/失败（含耗时）
            // - elapsedMs：函数内部耗时（getOrderbook + placeOrder + waitForFill + retry）
            // - e2eMs：业务真实延迟 = Poly fill 到达本地到对冲确认，反映风险敞口窗口
            const tHedgeEnd = Date.now();
            const elapsedMs = tHedgeEnd - tHedgeStart;
            const e2eMs = fillRecvTs ? tHedgeEnd - fillRecvTs : undefined;
            const avgFillPrice = totalReceived > 0 ? totalPriceSum / totalReceived : 0;
            // 优先用 e2e（fill 到对冲确认），拿不到时回退到函数内耗时（用于 TG 文案）
            const displayMs = e2eMs ?? elapsedMs;
            const timingLine = `耗时: ${displayMs}ms`;

            const retriesUsed = Math.max(0, actualAttempts - 1);

            if (remaining < MIN_HEDGE_QTY && totalReceived > 0) {
                // 聚合指标（只在 completed 分支污染 e2e 分布）
                const metrics = ensureHedgeMetrics(ctx);
                const sample: HedgeMetricsSample = {
                    outcome: 'completed',
                    elapsedMs,
                    e2eMs,
                    retries: retriesUsed,
                };
                updateMetrics(metrics, sample);
                const metricsLine = formatMetricsLine(sample, metrics, attemptId);

                await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_COMPLETED', {
                    hedgeQty: totalReceived,
                    totalHedged: ctx.totalHedged,
                    totalPredictFilled: ctx.totalPolyFilled,
                    avgHedgePrice: avgFillPrice,
                    retryCount: maxRetries,
                    elapsedMs: e2eMs ?? elapsedMs,
                }, attemptId).catch(() => {});

                console.log(
                    `[PolyMakerExecutor] Predict hedge reconciled: +${totalReceived.toFixed(2)} @ ${avgFillPrice.toFixed(4)}, ` +
                    `total hedged=${ctx.totalHedged.toFixed(2)}/${ctx.totalPolyFilled.toFixed(2)}\n` +
                    `    ${metricsLine}`,
                );

                this.alertInfo(
                    `✅ <b>[POLY_MAKER] 对冲完成</b>\n`
                    + `市场: ${(task.title || '').slice(0, 40)}\n`
                    + `对冲: ${totalReceived.toFixed(2)} shares @ ${avgFillPrice.toFixed(4)}\n`
                    + `累计: ${ctx.totalHedged.toFixed(2)} / ${ctx.totalPolyFilled.toFixed(2)}\n`
                    + timingLine
                );
            } else {
                if (lastFailureReason) {
                    this.alertPredictHedgeError(task, lastFailureReason, {
                        targetQty: remaining,
                    });
                }
                // 聚合指标（failed 只累加 failedCount + retries，不污染 e2e 分布）
                const metrics = ensureHedgeMetrics(ctx);
                const sample: HedgeMetricsSample = {
                    outcome: 'failed',
                    elapsedMs,
                    e2eMs,
                    retries: retriesUsed,
                };
                updateMetrics(metrics, sample);
                const metricsLine = formatMetricsLine(sample, metrics, attemptId);

                await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_FAILED', {
                    hedgeQty: remaining,
                    totalHedged: ctx.totalHedged,
                    totalPredictFilled: ctx.totalPolyFilled,
                    avgHedgePrice: avgFillPrice,
                    retryCount: maxRetries,
                    reason: lastFailureReason || 'Predict LIMIT retries exhausted',
                    elapsedMs: e2eMs ?? elapsedMs,
                }, attemptId).catch(() => {});

                console.warn(
                    `[PolyMakerExecutor] Predict hedge failed: partial=${totalReceived.toFixed(2)}, ` +
                    `remaining=${remaining.toFixed(2)}, reason="${lastFailureReason}"\n` +
                    `    ${metricsLine}`,
                );

                this.alertInfo(
                    `🚨 <b>[POLY_MAKER] 对冲失败</b>\n`
                    + `市场: ${(task.title || '').slice(0, 40)}\n`
                    + `缺口: ${remaining.toFixed(2)} shares (已对冲 ${totalReceived.toFixed(2)})\n`
                    + `原因: ${lastFailureReason || 'LIMIT retries exhausted'}\n`
                    + timingLine
                );
            }

            return {
                success: remaining < MIN_HEDGE_QTY,
                actualReceived: totalReceived,
                grossQty: targetQty,
                avgPrice: totalReceived > 0 ? totalPriceSum / totalReceived : 0,
                orderHash: lastHash,
                error: remaining < MIN_HEDGE_QTY ? undefined : (lastFailureReason || 'Predict LIMIT retries exhausted'),
            };
        } finally {
            ctx.isHedgingInProgress = false;
        }
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /**
     * 获取 Polymarket 挂单用的 token ID
     *
     * arbSide 表示 Poly 主仓方向：
     * - arbSide='YES': Poly 买 YES (或 NO if inverted)
     * - arbSide='NO':  Poly 买 NO (或 YES if inverted)
     */
    private getHedgeTokenId(task: Task): string {
        return getPolyMakerHedgeTokenId(task);
    }

    /**
     * 检查是否应该触发对冲
     *
     * 累计阈值检查: 只在未对冲量 >= MIN_HEDGE_QTY 时触发
     * terminal 事件时强制对冲所有剩余
     */
    private checkShouldHedge(
        ctx: PolyMakerContext,
        unhedged: number,
        isTerminal: boolean,
    ): { shouldHedge: boolean; hedgeQty: number } {
        const result = checkPolyMakerShouldHedge(ctx.pendingHedgeQty, unhedged, isTerminal);
        ctx.pendingHedgeQty = result.nextPendingHedgeQty;
        return { shouldHedge: result.shouldHedge, hedgeQty: result.hedgeQty };
    }

    /**
     * 取消 Poly GTC 并等待确认最终 size_matched
     */
    private async cancelPolyGtcAndVerify(ctx: PolyMakerContext): Promise<void> {
        const orderId = ctx.currentPolyOrderId;
        if (!orderId) return;

        ctx.cancelledByUs = true;

        console.log(`[PolyMakerExecutor] 取消 Poly GTC: ${orderId.slice(0, 12)}...`);

        const cancelled = await this.polyTrader.cancelOrder(orderId, {
            skipTelegram: true,
            conditionId: ctx.task.polymarketConditionId,
        });

        if (!cancelled) {
            console.warn(`[PolyMakerExecutor] Poly GTC 取消请求失败: ${orderId.slice(0, 12)}...`);
        }

        // 等待 REST 确认最终成交量
        await this.delay(CANCEL_VERIFY_DELAY_MS);
        const finalStatus = await this.polyTrader.getOrderStatus(orderId);
        if (finalStatus) {
            ctx.restFilledQty = Math.max(ctx.restFilledQty, finalStatus.filledQty);
            ctx.totalPolyFilled = Math.max(
                ctx.totalPolyFilled,
                ctx.baseFilledQty + Math.max(ctx.wsFilledQty, ctx.restFilledQty),
            );
            this.syncPersistedProgress(ctx, { currentPolyOrderId: undefined });

            console.log(
                `[PolyMakerExecutor] Poly GTC 最终状态: status=${finalStatus.status}, ` +
                `filledQty=${finalStatus.filledQty}, totalPolyFilled=${ctx.totalPolyFilled.toFixed(2)}`,
            );
        }

        ctx.currentPolyOrderId = undefined;
    }

    private syncPersistedProgress(ctx: PolyMakerContext, extra: Partial<Task> = {}): void {
        const avgPredictPrice = ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0;
        this.updateTask(ctx.task.id, {
            polyFilledQty: ctx.totalPolyFilled,
            predictFilledQty: ctx.totalHedged,
            hedgedQty: ctx.totalHedged,
            avgPredictPrice,
            avgPolymarketPrice: ctx.task.polyBidPrice || 0,
            remainingQty: Math.max(0, ctx.totalPolyFilled - ctx.totalHedged),
            ...extra,
        });
        const latestTask = this.getTask(ctx.task.id);
        if (latestTask) {
            ctx.task = latestTask;
        }
    }

    private startTradeFailedLinger(ctx: PolyMakerContext): void {
        const orderId = ctx.currentPolyOrderId;
        const task = ctx.task;
        if (!orderId) return;

        const LINGER_MS = 5 * 60 * 1000;
        console.log(
            `[PolyMakerExecutor] Task ${task.id}: 启动 tradeFailed 后台监听 (${LINGER_MS / 1000}s), orderId=${orderId.slice(0, 12)}...`,
        );

        const lingerLoop = async () => {
            const deadline = Date.now() + LINGER_MS;
            while (Date.now() < deadline) {
                const remaining = deadline - Date.now();
                if (remaining <= 0) break;

                const event = await this.fillWatcher.waitForEvent(orderId, remaining);
                if (event.kind === 'tradeFailed') {
                    const failDetail = event.detail as PolyTradeFailedEvent;
                    const failedAmount = parseFloat(failDetail.matchedAmount) || 0;
                    const exposure = ctx.totalHedged;

                    console.error(
                        `[PolyMakerExecutor] Task ${task.id}: [LINGER] TRADE FAILED — ` +
                        `orderId=${failDetail.orderId.slice(0, 12)}..., ` +
                        `matchedAmount=${failedAmount}, exposure=${exposure.toFixed(2)}`,
                    );

                    this.alertPin(
                        `🚨 [POLY_MAKER][TRADE_FAILED] ${task.id}\n`
                        + `市场: ${task.title}\n`
                        + `链上结算回滚! 裸敞口=${this.formatNum(exposure)}\n`
                        + `matchedAmount=${failedAmount}\n`
                        + `任务已完成后收到 FAILED, 紧急回补中...`,
                    );

                    await this.taskLogger.logOrderEvent(
                        task.id,
                        'TRADE_SETTLEMENT_FAILED',
                        {
                            platform: 'polymarket',
                            orderId: failDetail.orderId,
                            side: 'BUY',
                            price: task.polyBidPrice || 0,
                            quantity: task.quantity,
                            filledQty: ctx.totalPolyFilled,
                            remainingQty: Math.max(0, task.quantity - ctx.totalPolyFilled),
                            avgPrice: task.polyBidPrice || 0,
                            title: this.getPolyMarketDisplayTitle(task),
                            source: 'linger',
                        } as any,
                        failDetail.orderId,
                    ).catch(() => {});

                    ctx.totalPolyFilled = Math.max(0, ctx.totalPolyFilled - Math.min(failedAmount || ctx.totalPolyFilled, ctx.totalPolyFilled));
                    ctx.lastKnownSizeMatched = 0;
                    ctx.wsFilledQty = 0;
                    ctx.restFilledQty = 0;
                    ctx.baseFilledQty = ctx.totalPolyFilled;

                    if (exposure > 0) {
                        const hedgeTokenId = this.getHedgeTokenId(task);
                        let orderbook = this.polyWsOrderbookProvider?.(hedgeTokenId) ?? null;
                        if (!orderbook || orderbook.asks.length === 0) {
                            orderbook = await this.polyTrader.getOrderbook(hedgeTokenId);
                        }

                        const bestAsk = orderbook?.asks?.[0]?.price;
                        if (!bestAsk) {
                            this.alertPin(
                                `🚨 [POLY_MAKER][TRADE_FAILED][LINGER] ${task.id}\n`
                                + `市场: ${task.title}\n`
                                + `链上结算回滚! 裸敞口=${this.formatNum(exposure)}\n`
                                + `无法获取 Poly 卖一价，需人工处理`,
                            );
                            break;
                        }

                        console.log(
                            `[PolyMakerExecutor] Task ${task.id}: [LINGER] 紧急回补 — ` +
                            `exposure=${exposure.toFixed(2)}, polyAsk=${bestAsk}`,
                        );

                        const rebuyResult = await this.polyTrader.placeOrder({
                            tokenId: hedgeTokenId,
                            side: 'BUY',
                            price: bestAsk,
                            quantity: exposure,
                            orderType: 'GTC',
                            outcome: task.arbSide || 'YES',
                            outcomeName: this.getPolyOutcomeDisplayName(task, hedgeTokenId),
                            marketTitle: this.getPolyMarketDisplayTitle(task),
                            negRisk: task.negRisk,
                            skipFeeCompensation: true,
                            conditionId: task.polymarketConditionId,
                        });

                        if (rebuyResult.success && rebuyResult.orderId) {
                            this.alertPin(
                                `✅ [POLY_MAKER][REBUY_SUBMITTED][LINGER] ${task.id}\n`
                                + `市场: ${task.title}\n`
                                + `回补单已提交: ${exposure.toFixed(2)} @ ${bestAsk}\n`
                                + `orderId: ${rebuyResult.orderId.slice(0, 16)}...`,
                            );
                        } else {
                            this.alertPin(
                                `🚨 [POLY_MAKER][REBUY_FAILED][LINGER] ${task.id}\n`
                                + `市场: ${task.title}\n`
                                + `紧急回补失败! 裸敞口=${this.formatNum(exposure)}\n`
                                + `错误: ${rebuyResult.error}\n`
                                + `需要人工处理`,
                            );
                        }
                    } else {
                        this.alertPin(
                            `⚠️ [POLY_MAKER][TRADE_FAILED][LINGER] ${task.id}\n`
                            + `市场: ${task.title}\n`
                            + `链上结算回滚 (无对冲敞口)\n`
                            + `matchedAmount=${failedAmount}`,
                        );
                    }
                    break;
                }

                if (event.kind !== 'timeout') break;
            }

            this.fillWatcher.unregister(orderId);
            console.log(`[PolyMakerExecutor] Task ${task.id}: tradeFailed 后台监听结束, orderId=${orderId.slice(0, 12)}...`);
        };

        lingerLoop().catch((err) => {
            console.error(`[PolyMakerExecutor] Task ${task.id}: tradeFailed linger error:`, (err as Error).message);
            this.fillWatcher.unregister(orderId);
        });
    }

    private alertPin(message: string): void {
        this.emit('alert:pin', message);
    }

    /** 普通 TG 通知（不置顶）—— 用于对冲完成/耗时等非紧急事件 */
    private alertInfo(message: string): void {
        this.emit('alert:info', message);
    }

    private alertPredictHedgeError(
        task: Task,
        reason: string,
        extra: {
            attempt?: number;
            askPrice?: number;
            targetQty?: number;
            grossQty?: number;
            bestAsk?: number;
        } = {},
    ): void {
        const now = Date.now();
        const cached = this.predictHedgeAlertCache.get(task.id);
        if (cached && cached.reason === reason && now - cached.ts < 60_000) {
            return;
        }
        this.predictHedgeAlertCache.set(task.id, { reason, ts: now });

        this.alertPin(
            `🚨 [POLY_MAKER][PREDICT_HEDGE_ERROR] ${task.id}\n`
            + `市场: ${task.title}\n`
            + `原因: ${reason}\n`
            + (extra.attempt !== undefined ? `尝试: 第 ${extra.attempt + 1} 次\n` : '')
            + (extra.targetQty !== undefined ? `目标对冲: ${this.formatNum(extra.targetQty)}\n` : '')
            + (extra.grossQty !== undefined ? `下单数量: ${this.formatNum(extra.grossQty)}\n` : '')
            + (extra.askPrice !== undefined ? `下单价格: ${extra.askPrice.toFixed(4)}\n` : '')
            + (extra.bestAsk !== undefined ? `盘口最优价: ${extra.bestAsk.toFixed(4)}\n` : '')
            + '说明: Predict 对冲失败，当前仍有未对冲敞口'
        );
    }

    private clearPredictHedgeAlertCache(taskId: string): void {
        this.predictHedgeAlertCache.delete(taskId);
    }

    private getCompletionHedgeSlippage(task: Task, ctx: PolyMakerContext): {
        reason?: string;
        hedgeSlippageTicks?: number;
        hedgeSlippagePercent?: number;
    } {
        if (ctx.totalHedged <= 0) return {};

        const avgPredictPrice = ctx.hedgePriceSum / ctx.totalHedged;
        const benchmarkPrice = computePredictBreakevenAsk(task.polyBidPrice || 0);
        const tickSize = PREDICT_TICK;

        if (!Number.isFinite(avgPredictPrice) || !Number.isFinite(benchmarkPrice) || benchmarkPrice <= 0) {
            return {};
        }

        const rawDelta = avgPredictPrice - benchmarkPrice;
        if (!Number.isFinite(rawDelta) || rawDelta < tickSize / 2) {
            return {};
        }

        const ticks = Math.max(1, Math.round(rawDelta / tickSize));
        const slippagePercent = Number((rawDelta * 100).toFixed(2));

        return {
            reason: `对冲成交滑点: +${ticks} tick (${slippagePercent.toFixed(2)}%)`,
            hedgeSlippageTicks: ticks,
            hedgeSlippagePercent: slippagePercent,
        };
    }

    private formatNum(value: number | undefined, digits = 2): string {
        return Number.isFinite(value) ? Number(value).toFixed(digits) : '0.00';
    }

    private getPolyMarketDisplayTitle(task: Task): string {
        const sportsMarket = this.findSportsMarket(task);
        if (sportsMarket) {
            return sportsMarket.eventTitle || `${sportsMarket.awayTeam} vs. ${sportsMarket.homeTeam}`;
        }
        return task.title || `Task ${task.id}`;
    }

    private getPolyOutcomeDisplayName(task: Task, tokenId: string): string | undefined {
        const sportsMarket = this.findSportsMarket(task);
        if (!sportsMarket) return undefined;

        if (sportsMarket.isThreeWayEvent && sportsMarket.selectionLabel) {
            return sportsMarket.selectionLabel;
        }
        if (tokenId === sportsMarket.polymarketAwayTokenId) {
            return sportsMarket.awayTeam;
        }
        if (tokenId === sportsMarket.polymarketHomeTokenId) {
            return sportsMarket.homeTeam;
        }
        return undefined;
    }

    private findSportsMarket(task: Task) {
        if (!task.isSportsMarket) return null;

        try {
            const sportsService = getSportsService();
            const markets = sportsService.getMarkets();
            return markets.find((market) =>
                market.polymarketConditionId === task.polymarketConditionId &&
                (
                    market.predictMarketId === task.marketId ||
                    market.predictAwayMarketId === task.marketId ||
                    market.predictHomeMarketId === task.marketId
                )
            ) || null;
        } catch {
            return null;
        }
    }

    private async waitForSafePolyMakerPrice(task: Task, hedgeTokenId: string, signal: AbortSignal): Promise<boolean> {
        const priceCheckStart = Date.now();
        if (!task.polyBidPrice) {
            return false;
        }

        while (!signal.aborted) {
            const safeResult = await this.isPolyPriceSafeForMaker(hedgeTokenId, task.polyBidPrice);
            if (safeResult.safe) {
                return true;
            }

            if (Date.now() - priceCheckStart > MAKER_PRICE_CHECK_MAX_WAIT_MS) {
                await this.failTask(task, `Maker price safety timeout: ${safeResult.reason}`);
                return false;
            }

            await this.delay(1000);
        }

        return false;
    }

    private async waitForPredictAskPrecheck(
        task: Task,
        hedgeOutcome: 'YES' | 'NO',
        maxPredictAsk: number,
        currentPauseCount: number,
        signal: AbortSignal,
    ): Promise<boolean> {
        const predictCheckStart = Date.now();
        let predictWaited = false;

        while (!signal.aborted) {
            const predictBook = await this.predictTrader.getOrderbook(task.marketId);
            if (!predictBook) {
                console.warn(`[PolyMakerExecutor] Task ${task.id}: Predict orderbook 不可用，放行`);
                return true;
            }

            const currentAsk = hedgeOutcome === 'YES'
                ? (predictBook.asks[0]?.[0] ?? 1)
                : (1 - (predictBook.bids[0]?.[0] ?? 0));
            if (currentAsk <= maxPredictAsk) {
                return true;
            }

            if (Date.now() - predictCheckStart > MAKER_PRICE_CHECK_MAX_WAIT_MS) {
                this.updateTask(task.id, { status: 'PAUSED', pauseCount: currentPauseCount + 1 });
                await this.taskLogger.logTaskLifecycle(task.id, 'TASK_PAUSED', {
                    status: 'PAUSED',
                    reason: `Predict ask timeout: ${currentAsk.toFixed(4)} > max ${maxPredictAsk.toFixed(4)}`,
                }).catch(() => {});
                return false;
            }
            if (!predictWaited) {
                console.warn(`[PolyMakerExecutor] Task ${task.id}: Predict ask ${currentAsk.toFixed(4)} > max ${maxPredictAsk.toFixed(4)}，等待`);
                predictWaited = true;
            }
            await this.delay(1000);
        }

        return false;
    }

    private async submitPolyGtcOrder(
        task: Task,
        hedgeTokenId: string,
        quantity: number,
    ): Promise<{ success: boolean; orderId?: string; error?: string }> {
        console.log(
            `[PolyMakerExecutor] Task ${task.id}: 提交 Poly GTC BUY: token=${hedgeTokenId.slice(0, 12)}..., ` +
            `price=${task.polyBidPrice}, qty=${quantity.toFixed(2)}`,
        );

        const polyResult = await this.polyTrader.placeOrder({
            tokenId: hedgeTokenId,
            side: 'BUY',
            price: task.polyBidPrice!,
            quantity,
            orderType: 'GTC',
            outcome: task.arbSide || 'YES',
            outcomeName: this.getPolyOutcomeDisplayName(task, hedgeTokenId),
            marketTitle: this.getPolyMarketDisplayTitle(task),
            negRisk: task.negRisk,
            skipFeeCompensation: true,
            conditionId: task.polymarketConditionId,
        });

        if (polyResult.success && polyResult.orderId) {
            await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                platform: 'polymarket',
                orderId: polyResult.orderId,
                side: 'BUY',
                price: task.polyBidPrice!,
                quantity,
                filledQty: 0,
                remainingQty: quantity,
                avgPrice: 0,
                title: this.getPolyMarketDisplayTitle(task),
                outcome: task.arbSide || 'YES',
                outcomeName: this.getPolyOutcomeDisplayName(task, hedgeTokenId),
            }).catch(() => {});
        }

        return polyResult;
    }

    private async placePredictFallbackGtc(
        ctx: PolyMakerContext,
        targetQty: number,
    ): Promise<{ success: boolean; orderHash?: string; limitPrice?: number; error?: string }> {
        const task = ctx.task;
        const outcome = getPolyMakerPredictOutcome(task.arbSide);
        const breakevenAsk = computePredictBreakevenAsk(task.polyBidPrice || 0);
        const limitPrice = alignPriceUp(breakevenAsk, PREDICT_TICK);
        // GTC fallback 是挂单逻辑，按用户要求不做 fee 补偿
        const grossQty = Math.max(1, alignQuantity(targetQty));

        if (grossQty * limitPrice < MIN_HEDGE_NOTIONAL) {
            return {
                success: false,
                error: `Predict GTC 保底名义金额过小: ${(grossQty * limitPrice).toFixed(4)} < ${MIN_HEDGE_NOTIONAL}`,
            };
        }

        console.warn(
            `[PolyMakerExecutor] Task ${task.id}: 即时 LIMIT 对冲未完成，降级为 Predict GTC 保底 ` +
            `price=${limitPrice.toFixed(4)}, grossQty=${grossQty}, target=${targetQty.toFixed(2)}`,
        );

        const result = await this.predictTrader.placeOrder({
            marketId: task.marketId,
            side: 'BUY',
            price: limitPrice,
            quantity: grossQty,
            outcome,
        });

        if (!result.success || !result.hash) {
            await this.taskLogger.logOrderEvent(task.id, 'ORDER_FAILED', {
                platform: 'predict',
                orderId: 'predict-gtc-fallback',
                side: 'BUY',
                outcome,
                price: limitPrice,
                quantity: grossQty,
                filledQty: 0,
                remainingQty: grossQty,
                avgPrice: 0,
                cancelReason: result.error || 'Predict GTC fallback submit failed',
            }).catch(() => {});
            return {
                success: false,
                error: result.error || 'Predict GTC fallback submit failed',
            };
        }

        await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
            platform: 'predict',
            orderId: result.hash,
            side: 'BUY',
            outcome,
            price: limitPrice,
            quantity: grossQty,
            filledQty: 0,
            remainingQty: grossQty,
            avgPrice: 0,
        }, result.hash).catch(() => {});

        await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_STARTED', {
            hedgeQty: targetQty,
            totalHedged: ctx.totalHedged,
            totalPredictFilled: ctx.totalPolyFilled,
            avgHedgePrice: limitPrice,
            retryCount: 0,
            reason: `Predict GTC fallback @ ${limitPrice.toFixed(4)}`,
        }, `gtc-${Math.random().toString(36).substring(2, 10)}`).catch(() => {});

        this.syncPersistedProgress(ctx, {
            status: 'HEDGE_FAILED_GTC_PENDING',
            currentPolyOrderId: undefined,
            currentOrderHash: result.hash,
            remainingQty: Math.max(0, ctx.totalPolyFilled - ctx.totalHedged),
            error: `Predict GTC fallback @ ${limitPrice.toFixed(4)}`,
        });

        this.alertPin(
            `⚠️ [POLY_MAKER][PREDICT_GTC_FALLBACK] ${task.id}\n`
            + `市场: ${task.title}\n`
            + `未对冲: ${this.formatNum(targetQty)}\n`
            + `GTC价格: ${limitPrice.toFixed(4)}\n`
            + `orderHash: ${result.hash}`
        );

        return {
            success: true,
            orderHash: result.hash,
            limitPrice,
        };
    }

    private async monitorPredictFallbackGtc(
        ctx: PolyMakerContext,
        orderHash: string,
        targetQty: number,
        fallbackPrice: number,
    ): Promise<void> {
        const task = ctx.task;
        const feeRateBps = task.feeRateBps || 200;
        let accountedActual = 0;

        while (!ctx.signal.aborted) {
            const status = await this.predictTrader.getOrderStatus(orderHash);

            if (!status) {
                await this.delay(PREDICT_FALLBACK_GTC_POLL_MS);
                continue;
            }

            const avgPrice = status.avgPrice || fallbackPrice;
            const totalActual = calculateActualSharesReceived(status.filledQty, avgPrice, feeRateBps);
            if (totalActual > accountedActual) {
                const deltaActual = totalActual - accountedActual;
                accountedActual = totalActual;
                ctx.totalHedged += deltaActual;
                ctx.hedgePriceSum += deltaActual * avgPrice;

                await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_PARTIAL', {
                    hedgeQty: deltaActual,
                    totalHedged: ctx.totalHedged,
                    totalPredictFilled: ctx.totalPolyFilled,
                    avgHedgePrice: avgPrice,
                    retryCount: 0,
                    reason: 'Predict GTC fallback fill',
                }, `gtc-fill-${Math.random().toString(36).substring(2, 10)}`).catch(() => {});

                this.syncPersistedProgress(ctx, {
                    status: 'HEDGE_FAILED_GTC_PENDING',
                    currentOrderHash: orderHash,
                    remainingQty: Math.max(0, ctx.totalPolyFilled - ctx.totalHedged),
                });
            }

            const stillUnhedged = Math.max(0, ctx.totalPolyFilled - ctx.totalHedged);
            if (status.status === 'FILLED') {
                this.alertPin(
                    `✅ [POLY_MAKER][PREDICT_GTC_FILLED] ${task.id}\n`
                    + `市场: ${task.title}\n`
                    + `成交: ${this.formatNum(ctx.totalHedged)}\n`
                    + `orderHash: ${orderHash}`
                );
                await this.completeTask(task, ctx);
                return;
            }

            if (stillUnhedged < MIN_HEDGE_QTY) {
                await this.predictTrader.cancelOrder(orderHash).catch(() => {});
                await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                    platform: 'predict',
                    orderId: orderHash,
                    side: 'BUY',
                    outcome: getPolyMakerPredictOutcome(task.arbSide),
                    price: fallbackPrice,
                    quantity: targetQty,
                    filledQty: status.filledQty,
                    remainingQty: status.remainingQty,
                    avgPrice,
                    cancelReason: 'Predict GTC fallback filled enough, cancel remainder',
                }, orderHash).catch(() => {});
                await this.completeTask(task, ctx);
                return;
            }

            if (status.status === 'CANCELLED' || status.status === 'EXPIRED') {
                const tag = status.status === 'CANCELLED' ? 'PREDICT_GTC_CANCELLED' : 'PREDICT_GTC_FAILED';
                this.alertPin(
                    `🚨 [POLY_MAKER][${tag}] ${task.id}\n`
                    + `市场: ${task.title}\n`
                    + `状态: ${status.status}\n`
                    + `剩余敞口: ${this.formatNum(stillUnhedged)}\n`
                    + `orderHash: ${orderHash}`
                );
                await this.failTask(task, `Predict GTC fallback ${status.status.toLowerCase()}: unhedged=${stillUnhedged.toFixed(2)}`, {
                    polyFilledQty: ctx.totalPolyFilled,
                    predictFilledQty: ctx.totalHedged,
                    hedgedQty: ctx.totalHedged,
                    remainingQty: stillUnhedged,
                    currentOrderHash: undefined,
                    currentPolyOrderId: undefined,
                });
                return;
            }

            await this.delay(PREDICT_FALLBACK_GTC_POLL_MS);
        }
    }

    private async completeTask(task: Task, ctx: PolyMakerContext): Promise<void> {
        this.clearPredictHedgeAlertCache(task.id);
        const avgPolyPrice = task.polyBidPrice || 0;
        const avgPredictPrice = ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0;
        const profit = ctx.totalHedged > 0
            ? ctx.totalHedged * (1 - avgPolyPrice - avgPredictPrice)
            : 0;
        const completionHedgeSlippage = this.getCompletionHedgeSlippage(task, ctx);

        this.syncPersistedProgress(ctx, {
            status: 'COMPLETED' as Task['status'],
            currentPolyOrderId: undefined,
            currentOrderHash: undefined,
            actualProfit: profit,
            completedAt: Date.now(),
        });

        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_COMPLETED', {
            status: 'COMPLETED' as Task['status'],
            profit,
            duration: Date.now() - task.createdAt,
            ...completionHedgeSlippage,
        }).catch(() => {});

        await this.taskLogger.generateSummary(task.id, {
            type: task.type,
            marketId: task.marketId,
            title: task.title,
            status: 'COMPLETED',
            predictFilledQty: ctx.totalHedged,
            polyFilledQty: ctx.totalPolyFilled,
            hedgedQty: ctx.totalHedged,
            avgPredictPrice,
            avgPolymarketPrice: avgPolyPrice,
            actualProfit: profit,
            unwindLoss: 0,
            pauseCount: ctx.pauseCount,
            hedgeRetryCount: task.maxHedgeRetries,
            createdAt: task.createdAt,
            strategy: 'POLY_MAKER',
        }).catch(() => {});

        console.log(
            `[PolyMakerExecutor] Task ${task.id}: 完成 — polyFilled=${ctx.totalPolyFilled.toFixed(2)}, ` +
            `hedged=${ctx.totalHedged.toFixed(2)}, profit=${profit.toFixed(4)}`,
        );
    }

    private async failTask(task: Task, reason: string, extra: Partial<Task> = {}): Promise<void> {
        this.clearPredictHedgeAlertCache(task.id);
        this.updateTask(task.id, {
            status: 'FAILED',
            error: reason,
            completedAt: Date.now(),
            ...extra,
        });
        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
            status: 'FAILED',
            reason,
        }).catch(() => {});
        const updatedTask = this.getTask(task.id);
        await this.taskLogger.generateSummary(task.id, {
            type: task.type,
            marketId: task.marketId,
            title: task.title,
            status: 'FAILED',
            predictFilledQty: extra.predictFilledQty ?? updatedTask?.predictFilledQty ?? 0,
            polyFilledQty: extra.polyFilledQty ?? updatedTask?.polyFilledQty ?? 0,
            hedgedQty: extra.hedgedQty ?? updatedTask?.hedgedQty ?? 0,
            avgPredictPrice: updatedTask?.avgPredictPrice ?? 0,
            avgPolymarketPrice: updatedTask?.avgPolymarketPrice ?? (task.polyBidPrice || 0),
            actualProfit: updatedTask?.actualProfit ?? 0,
            unwindLoss: updatedTask?.unwindLoss ?? 0,
            pauseCount: updatedTask?.pauseCount ?? task.pauseCount,
            hedgeRetryCount: task.maxHedgeRetries,
            createdAt: task.createdAt,
            strategy: 'POLY_MAKER',
        }).catch(() => {});

        const failedFilled = extra.polyFilledQty ?? updatedTask?.polyFilledQty ?? 0;
        const failedHedged = extra.hedgedQty ?? updatedTask?.hedgedQty ?? 0;
        const failedRemaining = extra.remainingQty ?? updatedTask?.remainingQty ?? 0;
        this.alertPin(
            `🚨 [POLY_MAKER][TASK_FAILED] ${task.id}\n`
            + `市场: ${task.title}\n`
            + `原因: ${reason}\n`
            + `Poly成交: ${this.formatNum(failedFilled)}\n`
            + `已对冲: ${this.formatNum(failedHedged)}\n`
            + `剩余敞口: ${this.formatNum(failedRemaining)}`
        );
    }

    /**
     * Maker 价格安全检查: polyBidPrice < Poly best ask
     *
     * 如果我们的 bid >= best ask，会被立即撮合 (吃单)，失去 Maker 优势
     */
    private async isPolyPriceSafeForMaker(
        tokenId: string,
        polyBidPrice: number,
    ): Promise<{ safe: boolean; reason?: string }> {
        // 先查 WS 缓存；如果缓存为空/无 asks，则用 REST 再确认一次，避免批量建任务时因 cache 未 warm up 而直接放行
        let orderbook = this.polyWsOrderbookProvider?.(tokenId) ?? null;
        if (!orderbook || orderbook.asks.length === 0) {
            orderbook = await this.polyTrader.getOrderbook(tokenId);
        }

        if (!orderbook) {
            return { safe: false, reason: 'poly orderbook unavailable (ws empty, rest failed)' };
        }

        if (orderbook.asks.length === 0) {
            return { safe: true, reason: 'poly orderbook has no asks' };
        }

        const bestAsk = orderbook.asks[0].price;
        if (polyBidPrice < bestAsk) {
            return { safe: true };
        }

        return {
            safe: false,
            reason: `polyBid=${polyBidPrice.toFixed(4)} >= bestAsk=${bestAsk.toFixed(4)}`,
        };
    }

    /**
     * 等待 Predict 订单成交 (纯 BSC WS 事件驱动)
     *
     * BSC 链上 OrderFilled 事件是最快的成交通知渠道，
     * 直接从事件数据提取 filledQty，无需 REST 轮询。
     *
     * 日志维度:
     *   placeStartToFirstFill — 下单请求开始 → 首次 fill (含 API 往返)
     *   submitToFirstFill     — API 返回 → 首次 fill
     *   watchStartSkew        — API 返回 → watcher 注册完成 (盲区)
     *   watchToFill           — watcher 注册 → 首次 fill
     *   confirmSource         — BSC_WS | REST
     */
    private async waitForPredictFill(
        hash: string,
        timeoutMs: number,
        expectedQty: number,
        timing: { tPlaceStart: number; tSubmit: number; attempt: number },
    ): Promise<{ status: string; filledQty: number; avgPrice: number } | null> {
        const watcher = getBscOrderWatcher();

        if (!watcher.isConnected()) {
            console.warn('[PolyMakerExecutor] BSC WS 未连接，降级 REST 查询');
            const finalStatus = await this.predictTrader.getOrderStatus(hash);
            const now = Date.now();
            console.log(
                `[PolyMakerExecutor] waitForPredictFill: ` +
                `orderHash=${hash.slice(0, 18)}, attempt=${timing.attempt + 1}, ` +
                `status=${finalStatus?.status ?? 'TIMEOUT'}, confirmSource=REST, ` +
                `placeStartToResult=${now - timing.tPlaceStart}ms, ` +
                `submitToResult=${now - timing.tSubmit}ms`,
            );
            return finalStatus
                ? { status: finalStatus.status, filledQty: finalStatus.filledQty, avgPrice: finalStatus.avgPrice }
                : null;
        }

        const tWatchStart = Date.now();
        const watchStartSkew = tWatchStart - timing.tSubmit;
        let tFirstFill: number | null = null;
        let tAllFilled: number | null = null;
        let totalShares = 0;
        let totalUsdc = 0;
        let fillCount = 0;
        const dedupKeys = new Set<string>();
        let fillResolve: (() => void) | null = null;

        const fillPromise = new Promise<void>((resolve) => { fillResolve = resolve; });

        const cancel = watcher.watchOrder(hash, (event: OrderFilledEvent) => {
            const dedupKey = `${event.txHash}:${event.logIndex}`;
            if (dedupKeys.has(dedupKey)) return;
            dedupKeys.add(dedupKey);

            const recvTs = Date.now();
            if (!tFirstFill) tFirstFill = recvTs;
            fillCount++;

            const shares = getSharesFromFillEvent(event);
            const usdc = event.takerAssetId === '0'
                ? event.takerAmountFilled
                : event.makerAmountFilled;
            totalShares += shares;
            totalUsdc += usdc;

            console.log(
                `[PolyMakerExecutor] BSC WS fill: ` +
                `orderHash=${hash.slice(0, 18)}, attempt=${timing.attempt + 1}, ` +
                `fillDelta=${shares.toFixed(2)}, cumFilled=${totalShares.toFixed(2)}/${expectedQty.toFixed(2)}, ` +
                `submitToFill=${recvTs - timing.tSubmit}ms, ` +
                `watchToFill=${recvTs - tWatchStart}ms, ` +
                `block=${event.blockNumber}, ` +
                `blockTs=${event.timestamp}, recvTs=${recvTs}, ` +
                `txHash=${event.txHash}, logIndex=${event.logIndex}`,
            );

            if (totalShares >= expectedQty - 1e-6) {
                tAllFilled = recvTs;
                fillResolve?.();
            }
        }, timeoutMs);

        try {
            const result = await Promise.race([
                fillPromise.then(() => 'FILLED' as const),
                this.delay(timeoutMs).then(() => 'TIMEOUT' as const),
            ]);

            const now = Date.now();
            console.log(
                `[PolyMakerExecutor] waitForPredictFill: ` +
                `orderHash=${hash.slice(0, 18)}, attempt=${timing.attempt + 1}, ` +
                `status=${result}, confirmSource=BSC_WS, fills=${fillCount}, ` +
                `placeStartToFirstFill=${tFirstFill ? `${tFirstFill - timing.tPlaceStart}ms` : 'n/a'}, ` +
                `submitToFirstFill=${tFirstFill ? `${tFirstFill - timing.tSubmit}ms` : 'n/a'}, ` +
                `watchStartSkew=${watchStartSkew}ms, ` +
                `watchToFirstFill=${tFirstFill ? `${tFirstFill - tWatchStart}ms` : 'n/a'}, ` +
                `watchToAllFilled=${tAllFilled ? `${tAllFilled - tWatchStart}ms` : 'n/a'}, ` +
                `totalWait=${now - tWatchStart}ms`,
            );

            return {
                status: result === 'FILLED'
                    ? 'FILLED'
                    : (totalShares > 0 ? 'PARTIALLY_FILLED' : 'OPEN'),
                filledQty: totalShares,
                // 从链上 USDC/shares 计算真实成交均价；全 0 时上游 `|| askPrice` 会兜底。
                avgPrice: totalShares > 0 ? totalUsdc / totalShares : 0,
            };
        } finally {
            try { cancel(); } catch { /* ignore */ }
        }
    }

    /**
     * 延迟
     */
    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// ============================================================================
// 单例
// ============================================================================

let instance: PolyMakerExecutor | null = null;

export function getPolyMakerExecutor(): PolyMakerExecutor | null {
    return instance;
}

export function initPolyMakerExecutor(deps: PolyMakerExecutorDeps): PolyMakerExecutor {
    if (!instance) {
        instance = new PolyMakerExecutor(deps);
    }
    return instance;
}
