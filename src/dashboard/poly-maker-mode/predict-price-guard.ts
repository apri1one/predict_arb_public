/**
 * Predict 侧价格守护 (多任务 session)
 *
 * 监控 Predict 订单簿的 ask 价格和深度，当价格或深度不满足条件时
 * 触发 PAUSE 回调，恢复时触发 RESUME 回调。
 *
 * 核心公式:
 *   maxAllowedAsk = (1 - polyBidPrice) + slippageTolerance
 *   if predictAsk > maxAllowedAsk → onPriceInvalid (PAUSE)
 *   if was_paused && predictAsk <= maxAllowedAsk → REST 门禁确认 → onPriceValid (RESUME)
 *
 * arbSide 价格转换 (Predict 订单簿基于 YES 侧):
 *   arbSide='YES': 直接取 ask 侧
 *   arbSide='NO':  NO best ask = 1 - YES best bid
 *                  NO ask depth = YES bid 侧 price >= (1 - maxAllowedAsk) 的累计
 *
 * 并发支持:
 *   共享一个实例，内部按 taskId 维护独立 session。
 *   每个 session 独立的: config, isPaused, pausedChecks, pausedSince。
 *   共享一个定时循环扫描所有活跃 session。
 */

import type { PredictPriceGuardConfig, PredictPriceGuardState } from './types.js';
import type { PredictTrader } from '../predict-trader.js';
import { getPredictWsClient, type OrderbookUpdateData } from '../../services/predict-ws-client.js';

// ============================================================================
// 退避间隔
// ============================================================================

/** PAUSED 状态下动态退避 (对标 waitForFreshBookAndSafePrice) */
function getCheckInterval(pausedChecks: number): number {
    if (pausedChecks < 10) return 500;      // 前 10 次: 500ms
    if (pausedChecks < 60) return 2_000;    // 10-60: 2s
    return 5_000;                           // 60+: 5s
}

/** PAUSED 超 2h 自动终止守护 (由 executor 处理 FAIL) */
const PAUSED_AUTO_FAIL_MS = 2 * 60 * 60 * 1000;

/** ACTIVE 状态兜底检查间隔 (WS push 为主，此为 fallback) */
const ACTIVE_CHECK_INTERVAL_MS = 10_000;

/** 错误后重试间隔 */
const ERROR_RETRY_INTERVAL_MS = 5_000;

/** 幽灵深度检测: 30s 窗口 */
const DEPTH_FLIP_WINDOW_MS = 30_000;
/** 幽灵深度检测: 6 次翻转阈值 (3 轮出现/消失) */
const DEPTH_FLIP_THRESHOLD = 6;

// ============================================================================
// Session 类型
// ============================================================================

/** 深度恢复需连续 N 次 WS push 确认 (对标 P. DEPTH_RECOVERY_THRESHOLD) */
const DEPTH_RECOVERY_THRESHOLD = 2;
/** 深度增加低于此值忽略恢复 (减少优先原则, 对标 P. DEPTH_INCREASE_MIN_SHARES) */
const DEPTH_INCREASE_MIN_SHARES = 100;

interface PriceGuardSession {
    config: PredictPriceGuardConfig;
    signal: AbortSignal;
    isPaused: boolean;
    pausedChecks: number;
    pausedSince: number | null;
    nextCheckAt: number;
    checking: boolean;
    /** WS push 在 checking 期间到达时置 true，checking 结束后立即重检 */
    wsPushPending: boolean;
    // 幽灵深度检测 (对标 order-monitor.ts)
    lastHadHedgeableDepth: boolean | null;
    depthFlipCount: number;
    depthFlipWindowStart: number;
    depthUnstableNotified: boolean;
    // 深度恢复连续确认计数 (对标 P. recoveryCount)
    depthRecoveryCount: number;
}

// ============================================================================
// PredictPriceGuard
// ============================================================================

export class PredictPriceGuard {
    private predictTrader: PredictTrader;
    private sessions = new Map<string, PriceGuardSession>();
    private timer: ReturnType<typeof setTimeout> | null = null;

    // WS push 订阅管理: marketId → callback (用于 unsubscribe)
    private wsCallbacks = new Map<number, (data: OrderbookUpdateData) => void>();
    // marketId → Set<taskId> (反向索引，用于 WS push 时快速找到相关 session)
    private marketToSessions = new Map<number, Set<string>>();
    // 修复: WS 未连接时记录待订阅 marketId，tick 时重试
    private pendingWsSubscriptions = new Set<number>();

    constructor(predictTrader: PredictTrader) {
        this.predictTrader = predictTrader;
    }

    // ========================================================================
    // 公开 API
    // ========================================================================

    /**
     * 启动/覆盖指定 task 的价格守护 session
     */
    start(taskId: string, config: PredictPriceGuardConfig, signal: AbortSignal): void {
        // 先清理旧 session (如有)
        this.stopSession(taskId);

        const session: PriceGuardSession = {
            config,
            signal,
            isPaused: false,
            pausedChecks: 0,
            pausedSince: null,
            nextCheckAt: Date.now(), // 立即首次检查
            checking: false,
            // 幽灵深度
            lastHadHedgeableDepth: null,
            depthFlipCount: 0,
            depthFlipWindowStart: Date.now(),
            depthUnstableNotified: false,
            depthRecoveryCount: 0,
            wsPushPending: false,
        };
        this.sessions.set(taskId, session);

        // 注册 WS push 订阅 (与 P. 模式 order-monitor 对标: 每次推送立即检查)
        this.subscribeWs(config.predictMarketId, taskId);

        // 监听外部中止
        signal.addEventListener('abort', () => this.stop(taskId), { once: true });

        // 新 session 需要立即检查，取消当前定时器并重新调度
        this.stopTimer();
        this.scheduleNextTick();
    }

    /**
     * 停止守护
     * @param taskId 指定 taskId 只停该任务; 不传则停全部 (兼容)
     */
    stop(taskId?: string): void {
        if (taskId !== undefined) {
            this.stopSession(taskId);
            if (this.sessions.size === 0) {
                this.stopTimer();
            }
        } else {
            // 停全部: 清理所有 WS 订阅
            for (const tid of [...this.sessions.keys()]) {
                this.stopSession(tid);
            }
            this.stopTimer();
        }
    }

    private stopSession(taskId: string): void {
        const session = this.sessions.get(taskId);
        if (!session) return;

        // 从反向索引移除，必要时取消 WS 订阅
        this.unsubscribeWs(session.config.predictMarketId, taskId);
        this.sessions.delete(taskId);
    }

    /**
     * 更新最大允许价格 (动态调整，Poly bid 价格变化时由 executor 调用)
     */
    updateMaxPredictAsk(taskId: string, newMax: number): void {
        const session = this.sessions.get(taskId);
        if (session) {
            session.config.maxPredictAsk = newMax;
        }
    }

    /**
     * 获取指定 task 的状态快照
     */
    getState(taskId: string): { isPaused: boolean; pausedChecks: number; pausedSince: number | null } | null {
        const session = this.sessions.get(taskId);
        if (!session) return null;
        return {
            isPaused: session.isPaused,
            pausedChecks: session.pausedChecks,
            pausedSince: session.pausedSince,
        };
    }

    private getRequiredQty(session: PriceGuardSession): number | undefined {
        const config = session.config;
        const dynamicQty = config.getRequiredQty?.();
        if (dynamicQty !== undefined && Number.isFinite(dynamicQty)) {
            return Math.max(0, dynamicQty);
        }
        if (config.requiredQty !== undefined && Number.isFinite(config.requiredQty)) {
            return Math.max(0, config.requiredQty);
        }
        return undefined;
    }

    // ========================================================================
    // 共享定时循环
    // ========================================================================

    private stopTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private scheduleNextTick(): void {
        if (this.timer) return; // 已有定时器
        if (this.sessions.size === 0) return;

        let soonest = Infinity;
        for (const session of this.sessions.values()) {
            if (!session.checking && !session.signal.aborted) {
                soonest = Math.min(soonest, session.nextCheckAt);
            }
        }

        if (!Number.isFinite(soonest)) return;

        const delayMs = Math.max(0, soonest - Date.now());
        this.timer = setTimeout(() => this.tick(), delayMs);
    }

    private async tick(): Promise<void> {
        this.timer = null;

        if (this.sessions.size === 0) return;

        // 修复: 重试 pending WS 订阅
        if (this.pendingWsSubscriptions.size > 0) {
            const wsClient = getPredictWsClient();
            if (wsClient && wsClient.isConnected()) {
                for (const marketId of [...this.pendingWsSubscriptions]) {
                    // 只订阅仍有活跃 session 的 market
                    if (this.marketToSessions.has(marketId)) {
                        this.doSubscribeWs(marketId, wsClient);
                    } else {
                        this.pendingWsSubscriptions.delete(marketId);
                    }
                }
            }
        }

        const now = Date.now();
        const dueTaskIds: string[] = [];

        // 清理已中止的 session + 收集到期的 session
        for (const [taskId, session] of this.sessions) {
            if (session.signal.aborted) {
                this.sessions.delete(taskId);
                continue;
            }
            if (!session.checking && now >= session.nextCheckAt) {
                dueTaskIds.push(taskId);
            }
        }

        // 并行检查到期的 session (各 task 独立，不会互相影响)
        if (dueTaskIds.length > 0) {
            await Promise.all(dueTaskIds.map(taskId => this.checkSession(taskId)));
        }

        // 调度下一轮
        this.scheduleNextTick();
    }

    // ========================================================================
    // 单 session 检查
    // ========================================================================

    /**
     * session 过期判断: stop() 删除 map entry 后引用不等, start() 创建新对象也不等
     */
    private isSessionStale(taskId: string, session: PriceGuardSession): boolean {
        return this.sessions.get(taskId) !== session || session.signal.aborted;
    }

    private async checkSession(taskId: string): Promise<void> {
        const session = this.sessions.get(taskId);
        if (!session || session.checking || session.signal.aborted) return;

        session.checking = true;
        try {
            const config = session.config;

            // 1. 从缓存获取 Predict 订单簿 (WS 缓存优先，低延迟)
            const book = await this.predictTrader.getOrderbook(config.predictMarketId);
            if (!book || this.isSessionStale(taskId, session)) {
                // 订单簿不可用或 session 已过期
                if (!this.isSessionStale(taskId, session)) {
                    session.nextCheckAt = Date.now() + ACTIVE_CHECK_INTERVAL_MS;
                }
                return;
            }

            // 2. 提取 best ask 和深度 (根据 arbSide 转换)
            const { bestAsk, askDepth } = this.extractAskInfo(
                book,
                config.maxPredictAsk,
                config.arbSide,
            );

            // 3. 构建状态
            const state: PredictPriceGuardState = {
                isValid: bestAsk <= config.maxPredictAsk,
                currentAsk: bestAsk,
                maxAllowedAsk: config.maxPredictAsk,
                availableDepth: askDepth,
                timestamp: Date.now(),
            };

            if (session.isPaused) {
                await this.handlePausedCheck(taskId, session, state, book);
            } else {
                await this.handleActiveCheck(taskId, session, state);
            }
        } catch (err) {
            console.error(`[PredictPriceGuard] check error (${taskId}):`, (err as Error).message);
            if (!this.isSessionStale(taskId, session)) {
                session.nextCheckAt = Date.now() + ERROR_RETRY_INTERVAL_MS;
            }
        } finally {
            session.checking = false;
            // 修复: checking 期间收到的 WS push 不再丢失，立即重检
            if (session.wsPushPending && !this.isSessionStale(taskId, session)) {
                session.wsPushPending = false;
                session.nextCheckAt = 0;
                this.stopTimer();
                this.timer = setTimeout(() => this.tick(), 0);
            }
        }
    }

    // ========================================================================
    // PAUSED 状态处理
    // ========================================================================

    private async handlePausedCheck(
        taskId: string,
        session: PriceGuardSession,
        state: PredictPriceGuardState,
        _book: { bids: [number, number][]; asks: [number, number][] },
    ): Promise<void> {
        const config = session.config;
        if (this.isSessionStale(taskId, session)) return;

        session.pausedChecks++;

        // Auto-fail: PAUSED 超 2h → 停止守护，由 executor 处理 FAIL
        if (session.pausedSince && Date.now() - session.pausedSince > PAUSED_AUTO_FAIL_MS) {
            if (this.isSessionStale(taskId, session)) return;
            const mins = Math.round((Date.now() - session.pausedSince) / 60_000);
            console.log(
                `[PredictPriceGuard] (${taskId}) PAUSED 超 2h (${mins}min, checks=${session.pausedChecks})，auto-fail`,
            );
            this.sessions.delete(taskId);
            // 通知 executor (通过 onAutoFail 回调，如果提供了的话)
            if (config.onAutoFail) {
                await config.onAutoFail(mins);
            }
            return; // 不再 scheduleNext
        }

        const requiredQty = this.getRequiredQty(session);

        if (state.isValid) {
            // 价格恢复 → REST 门禁二次确认 (防 WS 跳变)
            const freshBook = await this.predictTrader.getOrderbookFresh(
                config.predictMarketId,
                { timeoutMs: 2500, signal: session.signal ?? undefined },
            );

            // 异步边界: REST 返回后重新确认 session 有效性
            if (this.isSessionStale(taskId, session)) return;

            if (freshBook) {
                const freshInfo = this.extractAskInfo(
                    freshBook,
                    config.maxPredictAsk,
                    config.arbSide,
                );

                if (freshInfo.bestAsk <= config.maxPredictAsk) {
                    if (requiredQty !== undefined && freshInfo.askDepth < requiredQty) {
                        if (session.pausedChecks <= 3 || session.pausedChecks % 30 === 0) {
                            console.log(
                                `[PredictPriceGuard] (${taskId}) 深度仍不足: depth=${freshInfo.askDepth.toFixed(2)} < required=${requiredQty.toFixed(2)}`,
                            );
                        }
                        session.nextCheckAt = Date.now() + getCheckInterval(session.pausedChecks);
                        return;
                    }

                    // 深度安全垫检查 (对标 hasSameSideDepthAtPrice)
                    const hasCushion = this.hasPredictDepthAtPrice(freshBook, config.maxPredictAsk, config.arbSide);
                    if (!hasCushion) {
                        // 无安全垫: 等 5s 后二次确认价格
                        console.log(
                            `[PredictPriceGuard] (${taskId}) REST 通过但无深度安全垫，等 5s 确认...`,
                        );
                        await new Promise(resolve => setTimeout(resolve, 5_000));

                        if (this.isSessionStale(taskId, session)) return;

                        const book2 = await this.predictTrader.getOrderbookFresh(
                            config.predictMarketId,
                            { timeoutMs: 2500, signal: session.signal ?? undefined },
                        );
                        if (this.isSessionStale(taskId, session)) return;

                        if (!book2) {
                            session.nextCheckAt = Date.now() + getCheckInterval(session.pausedChecks);
                            return;
                        }
                        const info2 = this.extractAskInfo(book2, config.maxPredictAsk, config.arbSide);
                        if (info2.bestAsk > config.maxPredictAsk) {
                            console.log(
                                `[PredictPriceGuard] (${taskId}) 5s 后价格已失效: ask=${info2.bestAsk.toFixed(4)}`,
                            );
                            session.nextCheckAt = Date.now() + getCheckInterval(session.pausedChecks);
                            return;
                        }
                    }

                    // REST 门禁 + 安全垫/5s确认 通过 → 确认恢复
                    console.log(
                        `[PredictPriceGuard] (${taskId}) 价格恢复 (REST 确认${hasCushion ? '+安全垫' : '+5s确认'}): ask=${freshInfo.bestAsk.toFixed(4)}, max=${config.maxPredictAsk.toFixed(4)}`,
                    );

                    // 深度恢复回调 (先于价格恢复)
                    if (config.onDepthRecovered && freshInfo.askDepth > 0) {
                        if (this.isSessionStale(taskId, session)) return;
                        await config.onDepthRecovered(freshInfo.askDepth);
                    }

                    if (this.isSessionStale(taskId, session)) return;

                    // 重置 PAUSED 状态
                    session.isPaused = false;
                    session.pausedChecks = 0;
                    session.pausedSince = null;

                    // 价格恢复回调 (RESUME)
                    await config.onPriceValid(freshInfo.bestAsk);

                    if (this.isSessionStale(taskId, session)) return;

                    // 恢复后立即以 ACTIVE 间隔调度
                    session.nextCheckAt = Date.now() + ACTIVE_CHECK_INTERVAL_MS;
                    return;
                } else {
                    // REST 门禁未通过: WS 跳变 (假恢复)，继续 PAUSED
                    if (session.pausedChecks <= 3 || session.pausedChecks % 30 === 0) {
                        console.log(
                            `[PredictPriceGuard] (${taskId}) REST 门禁未通过: freshAsk=${freshInfo.bestAsk.toFixed(4)} > max=${config.maxPredictAsk.toFixed(4)}`,
                        );
                    }
                }
            }
        }

        // 继续 PAUSED，退避调度
        if (!this.isSessionStale(taskId, session)) {
            session.nextCheckAt = Date.now() + getCheckInterval(session.pausedChecks);
        }
    }

    // ========================================================================
    // ACTIVE 状态处理
    // ========================================================================

    private async handleActiveCheck(
        taskId: string,
        session: PriceGuardSession,
        state: PredictPriceGuardState,
    ): Promise<void> {
        const config = session.config;
        if (this.isSessionStale(taskId, session)) return;

        if (!state.isValid) {
            // 价格失效 → PAUSE
            console.log(
                `[PredictPriceGuard] (${taskId}) 价格失效: ask=${state.currentAsk.toFixed(4)} > max=${state.maxAllowedAsk.toFixed(4)}`,
            );
            session.isPaused = true;
            session.pausedChecks = 0;
            session.pausedSince = Date.now();

            if (this.isSessionStale(taskId, session)) return;
            await config.onPriceInvalid(state.currentAsk);

            if (!this.isSessionStale(taskId, session)) {
                session.nextCheckAt = Date.now() + getCheckInterval(0);
            }
            return;
        }

        // 深度不足回调：与价格失效一样进入 PAUSED，恢复时统一走 paused-check
        const requiredQty = this.getRequiredQty(session);
        if (config.onDepthInsufficient && requiredQty !== undefined) {
            if (state.availableDepth < requiredQty) {
                console.log(
                    `[PredictPriceGuard] (${taskId}) 深度失效: depth=${state.availableDepth.toFixed(2)} < required=${requiredQty.toFixed(2)}`,
                );
                session.isPaused = true;
                session.pausedChecks = 0;
                session.pausedSince = Date.now();

                if (this.isSessionStale(taskId, session)) return;
                await config.onDepthInsufficient(state.availableDepth, requiredQty);

                if (!this.isSessionStale(taskId, session)) {
                    session.nextCheckAt = Date.now() + getCheckInterval(0);
                }
                return;
            }
        }

        // 幽灵深度检测 (对标 order-monitor.ts checkOrderBook)
        if (config.onDepthUnstable) {
            const hedgeableDepth = state.availableDepth;
            const hasDepth = hedgeableDepth >= 1;
            const now = Date.now();

            if (now - session.depthFlipWindowStart > DEPTH_FLIP_WINDOW_MS) {
                // 窗口重置，跨窗口翻转保留为 1
                session.depthFlipCount = (session.lastHadHedgeableDepth !== null && hasDepth !== session.lastHadHedgeableDepth) ? 1 : 0;
                session.depthFlipWindowStart = now;
                session.depthUnstableNotified = false;
            } else {
                if (session.lastHadHedgeableDepth !== null && hasDepth !== session.lastHadHedgeableDepth) {
                    session.depthFlipCount++;
                }
            }

            session.lastHadHedgeableDepth = hasDepth;

            if (session.depthFlipCount >= DEPTH_FLIP_THRESHOLD && !session.depthUnstableNotified) {
                console.warn(
                    `[PredictPriceGuard] (${taskId}) 🛑 幽灵深度: 对冲价位深度在 ${((now - session.depthFlipWindowStart) / 1000).toFixed(0)}s 内翻转 ${session.depthFlipCount} 次`,
                );
                session.depthUnstableNotified = true;

                // 进入 PAUSED
                session.isPaused = true;
                session.pausedChecks = 0;
                session.pausedSince = Date.now();

                if (this.isSessionStale(taskId, session)) return;
                await config.onDepthUnstable(session.depthFlipCount);

                if (!this.isSessionStale(taskId, session)) {
                    session.nextCheckAt = Date.now() + getCheckInterval(0);
                }
                return;
            }
        }

        // 正常: ACTIVE 间隔后再检查
        session.nextCheckAt = Date.now() + ACTIVE_CHECK_INTERVAL_MS;
    }

    // ========================================================================
    // 深度安全垫检查
    // ========================================================================

    /**
     * 检查 Predict 订单簿在对冲价位是否有深度 (安全垫)
     *
     * 对标 task-executor.ts 的 hasSameSideDepthAtPrice:
     * arbSide='YES': ask 侧 price <= maxAllowedAsk + epsilon
     * arbSide='NO':  bid 侧 price >= (1 - maxAllowedAsk) - epsilon (反转)
     */
    private hasPredictDepthAtPrice(
        book: { bids: [number, number][]; asks: [number, number][] },
        maxAllowedAsk: number,
        arbSide: 'YES' | 'NO',
    ): boolean {
        const PRICE_EPSILON = 1e-4;

        if (arbSide === 'YES') {
            return book.asks.some(([price, size]) =>
                price <= maxAllowedAsk + PRICE_EPSILON && size > 0
            );
        } else {
            const minYesBid = 1 - maxAllowedAsk;
            return book.bids.some(([price, size]) =>
                price >= minYesBid - PRICE_EPSILON && size > 0
            );
        }
    }

    // ========================================================================
    // 订单簿解析 (arbSide 转换)
    // ========================================================================

    /**
     * 提取 best ask 和在 maxAllowedAsk 范围内的深度
     *
     * Predict 订单簿基于 YES 侧:
     *   arbSide='YES': 直接取 ask 侧
     *   arbSide='NO':  NO best ask = 1 - YES best bid
     *                  NO ask depth = YES bid 侧 price >= (1 - maxAllowedAsk) 的累计
     */
    private extractAskInfo(
        book: { bids: [number, number][]; asks: [number, number][] },
        maxAllowedAsk: number,
        arbSide: 'YES' | 'NO',
    ): { bestAsk: number; askDepth: number } {
        const PRICE_EPSILON = 1e-9;

        if (arbSide === 'YES') {
            // YES ask 直接取
            const bestAsk = book.asks.length > 0 ? book.asks[0][0] : Infinity;

            // 在 maxAllowedAsk 范围内的 ask 深度
            let askDepth = 0;
            for (const [price, size] of book.asks) {
                if (price <= maxAllowedAsk + PRICE_EPSILON) {
                    askDepth += size;
                } else {
                    break; // asks 按价格升序排列
                }
            }
            return { bestAsk, askDepth };
        } else {
            // NO ask = 1 - YES best bid
            const bestBid = book.bids.length > 0 ? book.bids[0][0] : 0;
            const bestAsk = bestBid > 0 ? Number((1 - bestBid).toFixed(6)) : Infinity;

            // NO 深度: YES bid 侧 price >= (1 - maxAllowedAsk) 的累计 size
            const minYesBid = 1 - maxAllowedAsk;
            let askDepth = 0;
            for (const [price, size] of book.bids) {
                if (price >= minYesBid - PRICE_EPSILON) {
                    askDepth += size;
                } else {
                    break; // bids 按价格降序排列
                }
            }
            return { bestAsk, askDepth };
        }
    }

    // ========================================================================
    // WS push 订阅管理
    // ========================================================================

    /**
     * 为 marketId 注册 WS orderbook 回调
     * 同一 marketId 多个 session 共享一个 WS callback
     */
    private subscribeWs(marketId: number, taskId: string): void {
        // 反向索引: marketId → taskIds
        let taskIds = this.marketToSessions.get(marketId);
        if (!taskIds) {
            taskIds = new Set();
            this.marketToSessions.set(marketId, taskIds);
        }
        taskIds.add(taskId);

        // 如果已有此 marketId 的 WS 订阅则跳过
        if (this.wsCallbacks.has(marketId)) return;

        const wsClient = getPredictWsClient();
        if (!wsClient || !wsClient.isConnected()) {
            // 修复: WS 未连接时记录 pending，tick 时重试
            this.pendingWsSubscriptions.add(marketId);
            console.warn(`[PredictPriceGuard] WS 未连接，marketId=${marketId} 加入待订阅队列`);
            return;
        }

        this.doSubscribeWs(marketId, wsClient);
    }

    /** 执行实际 WS 订阅 */
    private doSubscribeWs(marketId: number, wsClient: NonNullable<ReturnType<typeof getPredictWsClient>>): void {
        if (this.wsCallbacks.has(marketId)) return;

        const callback = (_data: OrderbookUpdateData) => {
            this.onWsPush(marketId);
        };
        this.wsCallbacks.set(marketId, callback);
        this.pendingWsSubscriptions.delete(marketId);

        wsClient.subscribeOrderbook(marketId, callback).then(ok => {
            if (ok) {
                console.log(`[PredictPriceGuard] WS push 已订阅 marketId=${marketId}`);
            }
        }).catch(() => { /* ignore, timer 兜底 */ });
    }

    /**
     * 移除 taskId 对 marketId 的关联，无 session 时取消 WS 订阅
     */
    private unsubscribeWs(marketId: number, taskId: string): void {
        const taskIds = this.marketToSessions.get(marketId);
        if (!taskIds) return;
        taskIds.delete(taskId);

        if (taskIds.size > 0) return; // 还有其他 session 在用

        this.marketToSessions.delete(marketId);
        this.pendingWsSubscriptions.delete(marketId);
        const callback = this.wsCallbacks.get(marketId);
        if (!callback) return;
        this.wsCallbacks.delete(marketId);

        const wsClient = getPredictWsClient();
        if (wsClient) {
            wsClient.unsubscribeOrderbook(marketId, callback).catch(() => {});
        }
    }

    /**
     * WS orderbook push 回调: 减少优先 + 恢复连续确认 (对标 P. 模式 task-executor.ts)
     *
     * 减少优先原则:
     *   - 深度不足/价格失效 → 立即触发 checkSession
     *   - 深度恢复 → 需 ≥ DEPTH_INCREASE_MIN_SHARES 且连续 DEPTH_RECOVERY_THRESHOLD 次确认
     */
    private onWsPush(marketId: number): void {
        const taskIds = this.marketToSessions.get(marketId);
        if (!taskIds || taskIds.size === 0) return;

        // 从缓存读最新 book (WS push 已更新缓存)
        // 使用同步方式尽量避免延迟, getOrderbook 优先走 cache
        let needTick = false;

        for (const taskId of taskIds) {
            const session = this.sessions.get(taskId);
            if (!session || session.signal.aborted) continue;
            if (session.checking) {
                // 修复: checking 期间不丢弃 WS push，标记待处理
                session.wsPushPending = true;
                continue;
            }

            const config = session.config;
            const book = this.predictTrader.getOrderbookFromCache?.(config.predictMarketId);
            if (!book) {
                // 无缓存 fallback: 直接触发检查
                session.nextCheckAt = 0;
                needTick = true;
                continue;
            }

            const { bestAsk, askDepth } = this.extractAskInfo(book, config.maxPredictAsk, config.arbSide);
            const priceValid = bestAsk <= config.maxPredictAsk;
            const requiredQty = this.getRequiredQty(session) ?? 0;
            const depthSufficient = requiredQty <= 0 || askDepth >= requiredQty;

            if (!priceValid || !depthSufficient) {
                // 减少方向: 立即触发
                session.depthRecoveryCount = 0;
                session.nextCheckAt = 0;
                needTick = true;
            } else if (session.isPaused) {
                // 恢复方向: 减少优先原则 — 需 ≥ 100 shares 且连续确认
                const depthIncrease = askDepth; // PAUSED: 从 0 恢复，增量 = 绝对深度
                if (depthIncrease >= DEPTH_INCREASE_MIN_SHARES) {
                    session.depthRecoveryCount++;
                    if (session.depthRecoveryCount >= DEPTH_RECOVERY_THRESHOLD) {
                        session.nextCheckAt = 0;
                        session.depthRecoveryCount = 0;
                        needTick = true;
                    }
                } else {
                    session.depthRecoveryCount = 0;
                }
            }
            // ACTIVE + 价格/深度正常: 不触发 (定时器兜底)
        }

        if (needTick) {
            this.stopTimer();
            this.timer = setTimeout(() => this.tick(), 0);
        }
    }
}
