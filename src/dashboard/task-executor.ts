/**
 * Task Executor - 任务执行引擎 v2
 *
 * 修复问题:
 * 1. 价格守护流程卡死 - 使用 AbortSignal 控制 Promise
 * 2. 增量对冲 - 部分成交时立即触发对冲
 * 3. 对冲部分成交计算 - 累加 hedgedQty，正确计算加权均价
 * 4. UNWIND 实现 - 对冲失败后反向平仓
 * 5. SELL 价格守护 - 对称风控
 * 6. isInverted 执行逻辑 - 根据 inverted 选择对冲 token
 * 7. 正确的盈亏计算
 */

import { EventEmitter } from 'events';
import { performance } from 'node:perf_hooks';
import { Task, TaskStatus } from './types.js';
import { getTaskService, TaskService } from './task-service.js';
import { getPredictTrader, PredictTrader, PredictOrderInput, CancelResult } from './predict-trader.js';
import {
    getPolymarketTrader,
    PolymarketTrader,
    PolyOrderInput,
    calculatePolyNetBuyShares,
} from './polymarket-trader.js';
import { getOrderMonitor, OrderMonitor, OrderWatchResult } from './order-monitor.js';
import { getTaskLogger, TaskLogger, TaskConfigSnapshot, ArbOpportunitySnapshot, SnapshotTrigger } from './task-logger/index.js';
import { initTakerExecutor, TakerExecutor, TakerExecutorDeps } from './taker-mode/index.js';
import { initPolyMakerExecutor, PolyMakerExecutor, type PolyMakerExecutorDeps } from './poly-maker-mode/index.js';
import { getBscOrderWatcher, getSharesFromFillEvent, PREDICT_EXCHANGE_ADDRESSES, type BscOrderWatcher, type OrderFilledEvent } from '../services/bsc-order-watcher.js';
import {
    getPredictOrderWatcher,
    type OrderTerminatedEvent,
    getSharesFromFillEvent as getPredictWsFillShares,
    type OrderFilledEvent as PredictWsFilledEvent,
} from '../services/predict-order-watcher.js';
import type { WalletEventData } from '../services/predict-ws-client.js';
import type { PolymarketWebSocketClient } from '../polymarket/ws-client.js';
import { PolymarketRestClient } from '../polymarket/rest-client.js';
import { calculatePredictFee } from '../trading/depth-calculator.js';
import { roundToTick } from '../trading/price-utils.js';
import { getSportsService } from './sports-service.js';
import { getHedgeTimingLogger, HedgeTimingLogger, type HedgeFillSource } from './hedge-timing.js';

// ============================================================================
// 常量
// ============================================================================

const MAX_PAUSE_COUNT = 5;          // 最大价格守护暂停次数
const HEDGE_TIMEOUT_MS = 30000;     // 对冲超时
const REST_FALLBACK_INTERVAL = 500;  // WS 断连时 REST 降级轮询间隔
const UNWIND_MAX_RETRIES = 3;       // 反向平仓最大重试
const BSC_WATCHER_TIMEOUT = 0; // 不超时，Maker 订单可存活任意时长，由主循环/cleanup 负责取消注册
const MIN_HEDGE_QTY = 1;            // 最小对冲数量阈值 (shares)，低于此值跳过对冲
const POLY_WS_STALE_MS = 15000;

// ============================================================================
// Pending-as-hedge-trigger 开关
//   ON (default): pending 事件作为 hedge 触发源 + 打点起点
//   OFF:          pending 只记录日志，BSC WSS fill 继续作为触发源
// ============================================================================
const PENDING_HEDGE_TRIGGER_ENABLED =
    (process.env.PENDING_HEDGE_TRIGGER_ENABLED ?? 'true').toLowerCase() === 'true';

// Polymarket 最小订单名义金额阈值 ($1)
// 小额成交先累计，避免 Polymarket 400 "invalid amounts" 拒单
const MIN_HEDGE_NOTIONAL = Number(process.env.MIN_HEDGE_NOTIONAL) || 1.5;  // USD (>$1 Polymarket 最小限制，留浮点余量)

// Polymarket 硬性最小订单 $1。若估算 notional 低于此值，hedge 入口直接 SKIP 视为完成 (dust)。
// 防止 Predict 已完全成交后残余 ≥1 share 但 < $1 USD 反复打到 Polymarket 被 "min size: $1" 拒单死循环。
const POLY_MIN_ORDER_NOTIONAL = Number(process.env.POLY_MIN_ORDER_NOTIONAL) || 1.10;

// 对冲滑点容忍 (tick 单位，从 env 或 dashboard-config 读取)
import { HEDGE_SLIPPAGE_TICKS } from './dashboard-config.js';
const HEDGE_SLIPPAGE = HEDGE_SLIPPAGE_TICKS * 0.01;  // 转换为价格值 (e.g. 2 ticks → 0.02)
const HEDGE_RETRY_EXTRA_TICKS = 2;
const HEDGE_RETRY_MAX_TICKS = HEDGE_SLIPPAGE_TICKS + HEDGE_RETRY_EXTRA_TICKS;
const HEDGE_RETRY_MAX_SLIPPAGE = HEDGE_RETRY_MAX_TICKS * 0.01;

// Hedge fallback chain 全失败后的指数退避: 5s × 2^(n-1)，封顶 5 分钟
// 防止 Invalid price / 余额不足等硬错把日志刷爆并阻塞 event loop
const HEDGE_FAILURE_BACKOFF_BASE_MS = 5_000;
const HEDGE_FAILURE_BACKOFF_CAP_MS = 5 * 60_000;

// Polymarket 成交状态可能有延迟：关键决策前做一次短暂再确认，降低误判导致的重复对冲/误触发 UNWIND
const POLY_FILL_RECHECK_MAX_RETRIES = Number(process.env.POLY_FILL_RECHECK_MAX_RETRIES) || 6;   // 6 * 400ms = 2.4s
const POLY_FILL_RECHECK_INTERVAL_MS = Number(process.env.POLY_FILL_RECHECK_INTERVAL_MS) || 400;

// 终态 Poly 订单在 polyOrderFills 中的 TTL: 超过此时间后自动清理，避免 Map 无限增长
const POLY_FILL_TERMINAL_TTL_MS = Number(process.env.POLY_FILL_TERMINAL_TTL_MS) || 60_000;  // 1 分钟
// refreshTrackedPolyFills 并发上限
const POLY_FILL_REFRESH_CONCURRENCY = Number(process.env.POLY_FILL_REFRESH_CONCURRENCY) || 3;

// ============================================================================
// 类型
// ============================================================================

type PolyOrderbook = { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] };

interface PolyOrderFillTracker {
    /** Net shares counted toward hedge after fee accounting. */
    filledQty: number;
    /** Gross size_matched reported by Polymarket CLOB. */
    rawFilledQty?: number;
    /** Intended net hedge size for this order; fee-compensated BUY gross must not count above this. */
    targetQty?: number;
    avgPrice: number;
    lastCheckedAt: number;
    accountForBuyFees?: boolean;
    feeRate?: number;
    feeExponent?: number;
    isTerminal?: boolean;   // MATCHED/CANCELLED 已确认，refreshTrackedPolyFills 可跳过
    terminalAt?: number;    // 标记终态的时间戳，用于 TTL 清理
}

interface TaskContext {
    task: Task;
    signal: AbortSignal;
    abortController: AbortController;
    // 价格守护控制
    priceGuardAbort?: AbortController;
    predictWatchAbort?: AbortController;
    isPaused: boolean;
    currentOrderHash?: string;
    // 增量对冲跟踪
    totalPredictFilled: number;
    totalHedged: number;
    hedgePriceSum: number;  // 用于计算加权均价

    // ====== 累计对冲机制 (Polymarket $1 最小订单) ======
    /** 待对冲累计数量 (等待达到 $1 名义阈值) */
    pendingHedgeQty: number;
    /** 最后一次对冲价格估算 (用于计算名义金额) */
    lastHedgePriceEstimate: number;

    // 仅追踪本次进程内发出的 Poly 订单，用于处理"迟到成交/状态延迟"导致的漏记和误触发
    polyOrderFills: Map<string, PolyOrderFillTracker>;

    // ====== WSS-first 成交追踪 (与 TakerExecutor 对齐) ======
    /** WSS 累计成交量 (BSC 链上事件增量累加) */
    wssFilledQty: number;
    /** Predict WS 累计成交量 (Predict WebSocket fill 事件增量累加，BSC WSS 兜底) */
    predictWsFilledQty: number;
    /** WSS 成交事件去重集合 key: `${txHash}:${logIndex}` */
    wssFillEvents: Set<string>;
    /** Pending 事件已累计的 shares 池（pending 来的 shares 尚未被 BSC WSS fill 确认扣减） */
    pendingFillAccumulated: number;
    /** REST API 返回的累计成交量 */
    restFilledQty: number;
    /** WSS 首次成交时间戳 */
    wssFirstFillTime?: number;
    /** 最近一次 fill 事件的本地接收时间戳 (Date.now()) */
    lastFillRecvTs?: number;
    /** 最近一次 fill 事件的单调时钟时间戳 */
    lastFillRecvMono?: number;
    /** 最近一次 fill 触发来源 */
    lastFillSource?: HedgeFillSource;
    /** 幽灵深度检测：对冲 IOC 0 成交但订单簿显示有深度，通知深度保护触发 PAUSE */
    phantomDepthDetected?: boolean;
    /** 防止 onPriceValid 与 checkDepth 并发提交订单 */
    isSubmitting?: boolean;
    /** 上次深度调整时间戳，防止扩缩振荡 */
    lastDepthAdjustTime?: number;

    // ====== 延迟结算填充检测 ======
    /** 当前订单累计 fee (net fee = gross fee * (1-rebate), 单位: shares) */
    currentOrderFeeShares: number;
    /** 任务总累计 fee shares (用于利润计算) */
    totalPredictFeeShares: number;
    /** 当前订单之前的已成交基线（从 monitorAndHedge 局部变量提升） */
    baseFilledBeforeOrder: number;
    /** 已取消订单的延迟成交量（additive, 独立于 wss/rest/predictWs 三通道） */
    delayedFillQty: number;
    /** 延迟成交回调：通知主循环触发对冲检查 */
    onDelayedFill?: () => void;
    /** WS 深度监听器 ID */
    depthListenerId?: string;
    /** 防重入：WS 触发的 checkDepth 正在执行 */
    depthCheckPending?: boolean;
    /** 深度监控正在调整订单（取消→重提），防止主循环误判为外部取消 */
    isDepthAdjusting?: boolean;
    /** 对冲互斥: 任意对冲路径执行中时为 true，防止并发竞争 */
    isHedgingInProgress?: boolean;

    // ====== Phase 2: 下单/确认解耦 ======
    /** 已预留给 inflight IOC 的对冲数量 (虚拟占用，防超额) */
    reservedHedgeQty: number;
    /** 当前在飞的 Poly IOC 订单 (单 inflight 互斥) */
    inflightHedge?: {
        orderId: string;
        submittedQty: number;
        side: 'BUY' | 'SELL';
        price: number;
        attemptId: string;
        submittedAt: number;
        retryCount: number;
        status?: 'LIVE' | 'UNKNOWN';
        reconcileRetryCount?: number;
        reconcileInProgress?: boolean;
    };
    /** 防重入: fill callback microtask 已排队 */
    hedgeKickScheduled?: boolean;
    /** fast hedge 0-fill / unknown 后的冷却截止时间 */
    fastHedgeCooldownUntil?: number;
    /** fast hedge IOC 失败后的兜底链 (Tier 1 抬价 IOC + Tier 2 保本 GTC) 进行中 */
    fastHedgeFallbackInProgress?: boolean;
    /** fast hedge 观测指标 */
    fastHedgeMetrics: {
        submitCount: number;
        zeroFillCount: number;
        cooldownBlockCount: number;
        unknownCount: number;
        redispatchCount: number;
        totalSubmitMs: number;
        totalWatchMs: number;
        totalE2eMs: number;
        e2eSamples: number;
    };
    /** 取消 BSC WSS per-order watcher（由 monitorAndHedge 设置，防止与全局监听器双计数） */
    cancelBscWatcher?: () => void;
    /** 唤醒 monitorAndHedge 主循环（供后台对冲 reconcile/refresh 完成后触发完成判定） */
    wakeMonitor?: () => void;
    /** 暴露 monitorAndHedge 闭包内的 mergeFilledQty，供 startDepthMonitor / onPriceValid 在 force-hedge 前同步最新成交量 */
    mergeFilledQty?: () => boolean;

    // ====== 深度监控退避 (防止 PAUSED 任务高频空转) ======
    /** PAUSED 后连续 depth check 次数（恢复后重置） */
    depthPausedChecks: number;
    /** PAUSED 状态起始时间 */
    pausedSince?: number;
    /** Collateral 不足时的退避截止时间 */
    collateralBackoffUntil?: number;
    /** Hedge fallback chain 全部失败（Tier1+Tier2）的连续次数，成功一次即清零 */
    hedgeFailureCount?: number;
    /** Hedge fallback 退避截止时间：失败后指数退避到此时间前不再发起 hedge */
    hedgeFailureBackoffUntil?: number;
}

interface CancelTaskOptions {
    reason?: string;
    cancelReason?: 'ORDER_TIMEOUT' | 'COST_INVALID' | 'USER_CANCELLED' | 'BALANCE_GUARD' | 'SPORTS_START_TIME_CHANGED' | 'SPORTS_EVENT_LIVE';
}

// ============================================================================
// TaskExecutor 类
// ============================================================================

export class TaskExecutor extends EventEmitter {
    private taskService: TaskService;
    private predictTrader: PredictTrader;
    private polyTrader: PolymarketTrader;
    private polyWsClient: PolymarketWebSocketClient | null = null;
    // GTC 保底对冲 WS 监听器 (taskId → { listenerId, orderId })
    private gtcWatchers: Map<string, { listenerId: string; orderId: string }> = new Map();
    private polyRestClient: PolymarketRestClient;
    private orderMonitor: OrderMonitor;
    private taskLogger: TaskLogger;
    private hedgeTimingLogger: HedgeTimingLogger;
    private takerExecutor!: TakerExecutor;  // 延迟初始化
    private polyMakerExecutor!: PolyMakerExecutor;  // 延迟初始化
    private runningTasks: Map<string, TaskContext> = new Map();
    private initialized = false;
    private expiryCheckInterval?: ReturnType<typeof setInterval>;
    private shuttingDown = false;
    private pausing = false;
    /** 同一 poly order 的 in-flight refresh 去重，避免并发重复 API 调用 */
    private inFlightRefreshes: Map<string, Promise<{ filledQty: number; avgPrice: number; delta: number }>> = new Map();
    /** executor 使用过的所有 Predict orderHash → taskId 映射 (用于识别 WS 取消事件) */
    private knownOrderHashes = new Map<string, string>();
    constructor() {
        super();
        this.taskService = getTaskService();
        this.predictTrader = getPredictTrader();
        this.polyTrader = getPolymarketTrader();
        this.polyRestClient = new PolymarketRestClient();
        this.orderMonitor = getOrderMonitor();
        this.taskLogger = getTaskLogger();
        this.hedgeTimingLogger = getHedgeTimingLogger();

        // 非体育市场 Polymarket WS 断连 → 暂停所有非体育任务
        this.orderMonitor.on('priceGuard:wsDisconnect', ({ tokenId }: { tokenId: string }) => {
            this.pauseAllNonSportsTasks(tokenId).catch(err => {
                console.error(`[TaskExecutor] pauseAllNonSportsTasks error:`, err);
            });
        });
    }

    private formatAlertNumber(value: number | undefined, digits = 2): string {
        if (value === undefined || value === null || Number.isNaN(value)) return '0';
        return value.toFixed(digits);
    }

    private emitStageAlert(
        icon: '✅' | '⚠️' | '🚨',
        module: string,
        stage: string,
        header: string,
        lines: Array<string | undefined | null | false>,
    ): void {
        const detailLines = lines.filter((line): line is string => Boolean(line));
        const msg = `${icon} [${module}][${stage}] ${header}`
            + (detailLines.length ? `\n${detailLines.join('\n')}` : '');
        this.emit('alert:pin', msg);
    }

    private markHedgeFillSignal(ctx: TaskContext, source: HedgeFillSource): void {
        ctx.lastFillRecvTs = Date.now();
        ctx.lastFillRecvMono = performance.now();
        ctx.lastFillSource = source;
    }

    private clearHedgeFillSignal(ctx: TaskContext): void {
        ctx.lastFillRecvTs = undefined;
        ctx.lastFillRecvMono = undefined;
        ctx.lastFillSource = undefined;
    }

    private elapsedFromMono(start: number | undefined, end = performance.now()): number | undefined {
        if (start === undefined) return undefined;
        return Math.round((end - start) * 1000) / 1000;
    }

    private shortTokenId(tokenId: string): string {
        if (tokenId.length <= 20) return tokenId;
        return `${tokenId.slice(0, 10)}...${tokenId.slice(-6)}`;
    }

    private logHedgeTiming(event: Parameters<HedgeTimingLogger['log']>[0]): void {
        this.hedgeTimingLogger?.log(event);
    }


    /**
     * 初始化
     * 注意：启动时批量取消任务与关联订单 (cancelAllTasksOnStartup) 不在这里执行，
     * 需要等 WS 客户端注入后由 start-dashboard 单独调用
     */
    async init(): Promise<void> {
        if (this.initialized) return;

        await this.predictTrader.init();
        await this.polyTrader.init();

        // 初始化 TakerExecutor
        const takerDeps: TakerExecutorDeps = {
            predictTrader: this.predictTrader,
            polyTrader: this.polyTrader,
            polyWsClient: this.polyWsClient ?? undefined,
            taskLogger: this.taskLogger,
            updateTask: this.updateTask.bind(this),
            getTask: (taskId: string) => this.taskService.getTask(taskId) ?? undefined,
        };
        this.takerExecutor = initTakerExecutor(takerDeps);

        const polyMakerDeps: PolyMakerExecutorDeps = {
            predictTrader: this.predictTrader,
            polyTrader: this.polyTrader,
            taskLogger: this.taskLogger,
            updateTask: this.updateTask.bind(this),
            getTask: (taskId: string) => this.taskService.getTask(taskId) ?? undefined,
            polyWsOrderbookProvider: (tokenId: string) => {
                // 直接查体育 WS 缓存 (0 延迟，无 REST fallback)
                try {
                    const cached = getSportsService()?.getPolyOrderbookFromCache(tokenId);
                    if (!cached) return null;
                    return {
                        bids: cached.bids.map(([price, size]) => ({ price, size })),
                        asks: cached.asks.map(([price, size]) => ({ price, size })),
                    };
                } catch {
                    return null;
                }
            },
        };
        this.polyMakerExecutor = initPolyMakerExecutor(polyMakerDeps);
        this.polyMakerExecutor.on('alert:pin', (msg: string) => {
            this.emit('alert:pin', msg);
        });
        this.polyMakerExecutor.on('alert:info', (msg: string) => {
            this.emit('alert:info', msg);
        });

        this.initialized = true;
        console.log('[TaskExecutor] Initialized');

        // 启动任务过期检查定时器 (每 30 秒检查一次)
        this.expiryCheckInterval = setInterval(() => this.checkExpiredTasks(), 30_000);

        // 注意：cancelAllTasksOnStartup() 不在这里调用
        // 由 start-dashboard.ts 在 Predict WS 连接后调用
    }

    /**
     * 启动时取消所有非终态任务，并顺带取消其对应订单
     * 由启动入口在 WS 客户端注入后调用
     *
     * 流程:
     * 1. 调用 cancelAllOrders() 批量取消所有 Predict 挂单
     * 2. 监听 Predict WS ORDER_CANCELLED 事件确认取消成功
     * 3. 逐个取消任务关联的 Polymarket 订单
     * 4. 将所有非终态任务标记为 CANCELLED
     */
    async cancelAllTasksOnStartup(): Promise<void> {
        const terminalStatuses: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'HEDGE_FAILED', 'UNWIND_COMPLETED'];
        const allTasks = this.taskService.getTasks({ includeCompleted: true });
        const activeTasks = allTasks.filter(t => !terminalStatuses.includes(t.status));

        if (activeTasks.length === 0) {
            console.log('[TaskExecutor] 没有活跃任务需要取消');
            return;
        }

        console.log(`[TaskExecutor] 启动清理: 发现 ${activeTasks.length} 个活跃任务，执行批量取消...`);

        // 收集所有需要确认取消的订单 hash
        const pendingHashes = new Set<string>();
        const pendingPolyOrderIds = new Set<string>();
        for (const task of activeTasks) {
            if (task.currentOrderHash) {
                pendingHashes.add(task.currentOrderHash.toLowerCase());
            }
            if (task.currentPolyOrderId) {
                pendingPolyOrderIds.add(task.currentPolyOrderId);
            }
        }

        // 设置 WS 监听器等待 ORDER_CANCELLED 确认
        let wsListener: ((event: WalletEventData) => void) | null = null;
        let wsConfirmPromise: Promise<void> | undefined;

        if (pendingHashes.size > 0) {
            const watcher = getPredictOrderWatcher();

            wsConfirmPromise = new Promise<void>((resolve) => {
                const CANCEL_CONFIRM_TIMEOUT_MS = 15000;
                const timer = setTimeout(() => {
                    if (pendingHashes.size > 0) {
                        console.warn(`[TaskExecutor] 启动清理: ${pendingHashes.size} 个订单取消确认超时 (${CANCEL_CONFIRM_TIMEOUT_MS}ms)，继续执行`);
                    }
                    resolve();
                }, CANCEL_CONFIRM_TIMEOUT_MS);

                wsListener = (event: WalletEventData) => {
                    if (event.type !== 'ORDER_CANCELLED') return;
                    const hash = event.orderHash?.toLowerCase();
                    if (hash && pendingHashes.has(hash)) {
                        pendingHashes.delete(hash);
                        console.log(`[TaskExecutor] 启动清理: WS 确认订单取消 ${hash.slice(0, 16)}... (剩余 ${pendingHashes.size})`);
                    }
                    if (pendingHashes.size === 0) {
                        clearTimeout(timer);
                        resolve();
                    }
                };

                watcher.on('walletEvent', wsListener);
            });

            console.log(`[TaskExecutor] 启动清理: 等待 ${pendingHashes.size} 个订单的 WS 取消确认...`);
        }

        // 调用批量取消 API
        const cancelResult = await this.predictTrader.cancelAllOrders();
        if (cancelResult.failed) {
            console.warn('[TaskExecutor] 启动清理: cancelAllOrders API 调用失败，等待 WS 确认');
        } else {
            console.log(`[TaskExecutor] 启动清理: API 返回 removed=${cancelResult.removed.length}, noop=${cancelResult.noop.length}`);
            // 通过 idToHash 映射，将 API 确认的订单从待确认列表移除
            for (const id of [...cancelResult.removed, ...cancelResult.noop]) {
                const hash = cancelResult.idToHash.get(id)?.toLowerCase();
                if (hash && pendingHashes.has(hash)) {
                    pendingHashes.delete(hash);
                    console.log(`[TaskExecutor] 启动清理: API 确认订单取消 ${hash.slice(0, 16)}... (剩余 ${pendingHashes.size})`);
                }
            }
        }

        // 等待 WS 确认（如果有待确认的订单）
        if (wsConfirmPromise) {
            await wsConfirmPromise;
            // 清理监听器
            if (wsListener) {
                const watcher = getPredictOrderWatcher();
                watcher.removeListener('walletEvent', wsListener);
            }
        }

        // 逐个取消残留的 Polymarket GTC/IOC 订单
        for (const orderId of pendingPolyOrderIds) {
            try {
                const cancelled = await this.polyTrader.cancelOrder(orderId, {
                    timeoutMs: 5000,
                    skipTelegram: true,
                });
                console.log(`[TaskExecutor] 启动清理: Polymarket 订单 ${orderId.slice(0, 16)}... ${cancelled ? '已取消' : '取消失败/不存在'}`);
            } catch (e: any) {
                console.warn(`[TaskExecutor] 启动清理: 取消 Polymarket 订单 ${orderId.slice(0, 16)}... 失败: ${e.message}`);
            }
        }

        // 将所有活跃任务标记为 CANCELLED
        for (const task of activeTasks) {
            this.taskLogger.logTaskLifecycle(task.id, 'TASK_CANCELLED', {
                status: 'CANCELLED',
                previousStatus: task.status,
                reason: 'Dashboard 重启: 批量取消任务并撤销关联订单',
            }).catch(() => {});

            this.updateTask(task.id, {
                status: 'CANCELLED',
                currentOrderHash: undefined,
                currentPolyOrderId: undefined,
                error: 'Dashboard 重启：任务已批量取消，关联订单已撤销',
            });
        }

        console.log(`[TaskExecutor] 启动清理完成: ${activeTasks.length} 个任务已取消`);
    }

    /**
     * 由启动入口注入 Polymarket WS 客户端（避免模块循环依赖）
     */
    setPolymarketWsClient(client: PolymarketWebSocketClient | null): void {
        this.polyWsClient = client;
        this.takerExecutor?.setPolymarketWsClient(client);
    }

    /**
     * 检查并取消已过期的任务
     */
    private async checkExpiredTasks(): Promise<void> {
        const now = Date.now();
        const allTasks = this.taskService.getTasks({});

        for (const task of allTasks) {
            // 跳过没有设置过期时间的任务
            if (!task.expiresAt) continue;

            // 跳过已完成/失败/取消的任务
            const terminalStatuses: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'HEDGE_FAILED', 'UNWIND_COMPLETED'];
            if (terminalStatuses.includes(task.status)) continue;

            // 检查是否已过期
            if (now >= task.expiresAt) {
                console.log(`[TaskExecutor] ⏰ 任务 ${task.id} 已过期，正在取消...`);
                await this.cancelExpiredTask(task.id);
            }
        }
    }

    /**
     * 取消过期任务 (取消订单 + 更新状态)
     */
    private async cancelExpiredTask(taskId: string): Promise<void> {
        const task = this.taskService.getTask(taskId);
        if (!task) return;

        const ctx = this.runningTasks.get(taskId);

        // 中止执行
        if (ctx) {
            ctx.abortController.abort();
            ctx.priceGuardAbort?.abort();
            ctx.predictWatchAbort?.abort();
        }

        // 取消 Predict 订单
        const orderHashToCancel = task.currentOrderHash || ctx?.currentOrderHash;
        if (orderHashToCancel) {
            try {
                console.log(`[TaskExecutor] ⏰ 取消过期任务订单: ${orderHashToCancel.slice(0, 20)}...`);
                await this.predictTrader.cancelOrder(orderHashToCancel);
            } catch (e: any) {
                console.warn(`[TaskExecutor] ⚠️ 取消订单出错: ${e.message}`);
            }
            if (ctx) {
                ctx.cancelBscWatcher?.();
            }
        }

        // 清理运行上下文
        this.runningTasks.delete(taskId);

        // 记录日志
        await this.taskLogger.logTaskLifecycle(taskId, 'TASK_CANCELLED', {
            status: 'CANCELLED',
            reason: `Task expired (expiresAt: ${task.expiresAt})`,
        });

        // 更新状态
        this.updateTask(taskId, {
            status: 'CANCELLED',
            cancelReason: 'ORDER_TIMEOUT',
            currentOrderHash: undefined,
        });

        console.log(`[TaskExecutor] ⏰ 任务 ${taskId} 已因过期取消`);
    }

    /**
     * 检查任务的 Polymarket 价格是否仍然有效
     * BUY: polyAsk < polymarketMaxAsk
     * SELL: polyBid > polymarketMinBid
     */
    private async checkPriceValidity(task: Task): Promise<{ valid: boolean; reason?: string }> {
        // 浮点精度容差 - 允许 yes + no = 1 的边界情况
        const EPSILON = 0.0001;

        try {
            const hedgeTokenId = this.getHedgeTokenId(task);
            const orderbook = await this.getPolymarketOrderbook(hedgeTokenId, task.isSportsMarket);

            if (!orderbook) {
                return { valid: false, reason: '无法获取订单簿' };
            }

            if (task.type === 'BUY') {
                // BUY 任务: 检查 polyAsk <= polymarketMaxAsk + epsilon
                const bestAsk = orderbook.asks[0]?.price;
                if (bestAsk === undefined) {
                    return { valid: false, reason: '无可用卖单' };
                }
                if (bestAsk > task.polymarketMaxAsk + EPSILON) {
                    return {
                        valid: false,
                        reason: `polyAsk(${bestAsk.toFixed(4)}) > maxAsk(${task.polymarketMaxAsk.toFixed(4)})`,
                    };
                }
            } else {
                // SELL 任务: 检查 polyBid >= polymarketMinBid - epsilon
                const bestBid = orderbook.bids[0]?.price;
                if (bestBid === undefined) {
                    return { valid: false, reason: '无可用买单' };
                }
                if (bestBid < task.polymarketMinBid - EPSILON) {
                    return {
                        valid: false,
                        reason: `polyBid(${bestBid.toFixed(4)}) < minBid(${task.polymarketMinBid.toFixed(4)})`,
                    };
                }
            }

            return { valid: true };
        } catch (error: any) {
            return { valid: false, reason: `检查失败: ${error.message}` };
        }
    }

    /**
     * 获取 Polymarket 订单簿
     * 优先使用 WS 缓存，缓存 miss 时回退到 REST API
     * 注: 体育市场不走 WS，直接使用 REST
     */
    private async getPolymarketOrderbook(
        tokenId: string,
        isSportsMarket: boolean = false
    ): Promise<{ bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null> {
        const normalizeRestOrderbook = (restBook: any) => {
            if (!restBook || !Array.isArray(restBook.bids) || !Array.isArray(restBook.asks)) {
                return null;
            }
            return {
                bids: restBook.bids.map((b: any) => ({
                    price: parseFloat(b.price),
                    size: parseFloat(b.size),
                })).sort((a: any, b: any) => b.price - a.price),
                asks: restBook.asks.map((a: any) => ({
                    price: parseFloat(a.price),
                    size: parseFloat(a.size),
                })).sort((a: any, b: any) => a.price - b.price),
            };
        };

        // 体育市场: 优先从 SportsService 缓存读取，REST 作为 fallback
        if (isSportsMarket) {
            // 1. 尝试 SportsService polyOrderbook 缓存 (0 延迟)
            try {
                const cached = getSportsService().getPolyOrderbookFromCache(tokenId);
                if (cached && cached.bids.length > 0 && cached.asks.length > 0) {
                    return {
                        bids: cached.bids.map(([price, size]) => ({ price, size })),
                        asks: cached.asks.map(([price, size]) => ({ price, size })),
                    };
                }
            } catch {
                // SportsService 未初始化等情况，静默 fallback
            }

            // 2. 缓存未命中，回退到 REST API
            try {
                const restBook = await this.polyRestClient.getOrderBook(tokenId);
                const normalized = normalizeRestOrderbook(restBook);
                if (normalized && normalized.bids.length > 0 && normalized.asks.length > 0) {
                    return normalized;
                }
            } catch (error: any) {
                console.error(`[TaskExecutor] Sports REST orderbook failed:`, error.message);
            }
            return null;
        }

        // 尝试 WS 缓存
        const wsClient = this.polyWsClient;
        if (wsClient && wsClient.isConnected()) {
            const wsBook = wsClient.getOrderBook(tokenId);
            if (wsBook && wsBook.bids.length > 0 && wsBook.asks.length > 0) {
                return {
                    bids: wsBook.bids.map(([price, size]) => ({ price, size })),
                    asks: wsBook.asks.map(([price, size]) => ({ price, size })),
                };
            }
            // WS 已连接但缓存无数据：确保 token 已订阅（自愈：防止重连时订阅丢失）
            wsClient.subscribe([tokenId]);
        }

        // WS 缓存 miss 时回退到 REST API
        // 注: 非体育任务保留 REST 回退，避免 WS 抖动导致完全无报价
        try {
            const restBook = await this.polyRestClient.getOrderBook(tokenId);
            const normalized = normalizeRestOrderbook(restBook);
            if (normalized && normalized.bids.length > 0 && normalized.asks.length > 0) {
                return normalized;
            }
        } catch (error: any) {
            console.error(`[TaskExecutor] REST orderbook failed:`, error.message);
        }

        return null;
    }

    /**
     * 检查是否应该触发对冲 (考虑 Polymarket $1 最小名义金额阈值)
     *
     * @param ctx 任务上下文
     * @param newFilledQty 本次新成交的数量
     * @param isPredictFullyFilled Predict 订单是否已完全成交
     * @returns { shouldHedge, hedgeQty, reason }
     */
    private checkShouldHedge(
        ctx: TaskContext,
        newFilledQty: number,
        isPredictFullyFilled: boolean
    ): { shouldHedge: boolean; hedgeQty: number; reason: string } {
        const task = ctx.task;

        // 累计待对冲数量
        ctx.pendingHedgeQty += newFilledQty;

        // 计算总未对冲量
        const totalUnhedged = ctx.totalPredictFilled - ctx.totalHedged;

        // 如果未对冲量 < MIN_HEDGE_QTY，无需对冲
        if (totalUnhedged < MIN_HEDGE_QTY) {
            return { shouldHedge: false, hedgeQty: 0, reason: `Unhedged ${totalUnhedged.toFixed(4)} < MIN_HEDGE_QTY ${MIN_HEDGE_QTY}` };
        }

        // 使用 lastHedgePriceEstimate 估算 notional（同步，不查 orderbook）
        // 兜底: poly 预设价 ≈ 1 - predict 下单价
        let hedgePrice = ctx.lastHedgePriceEstimate;
        if (hedgePrice <= 0) {
            hedgePrice = 1 - task.predictPrice;
        }

        // 使用总未对冲量计算名义金额（包含历史精度缺口）
        const notionalAmount = totalUnhedged * hedgePrice;

        // 如果 Predict 已完全成交，强制对冲剩余量
        // 但若 notional 已 < Polymarket 最小订单 ($1)，放弃 dust 对冲（否则会死循环被 min size 拒单）
        if (isPredictFullyFilled && totalUnhedged >= MIN_HEDGE_QTY) {
            if (notionalAmount < POLY_MIN_ORDER_NOTIONAL) {
                ctx.pendingHedgeQty = 0;
                console.log(`[TaskExecutor] Predict fully filled, dust hedge skipped: notional $${notionalAmount.toFixed(2)} < $${POLY_MIN_ORDER_NOTIONAL} (remaining ${totalUnhedged.toFixed(4)} shares)`);
                return { shouldHedge: false, hedgeQty: 0, reason: `Dust notional $${notionalAmount.toFixed(2)} < $${POLY_MIN_ORDER_NOTIONAL}` };
            }
            const hedgeQty = totalUnhedged;
            ctx.pendingHedgeQty = 0;  // 清空累计
            console.log(`[TaskExecutor] Predict fully filled, force hedge remaining ${hedgeQty.toFixed(4)} (notional: $${(hedgeQty * hedgePrice).toFixed(2)})`);
            return { shouldHedge: true, hedgeQty, reason: 'Predict fully filled' };
        }

        // 检查名义金额是否达到阈值
        if (notionalAmount >= MIN_HEDGE_NOTIONAL) {
            const hedgeQty = totalUnhedged;  // 使用总未对冲量，包含历史精度缺口
            ctx.pendingHedgeQty = 0;  // 清空累计
            console.log(`[TaskExecutor] Notional $${notionalAmount.toFixed(2)} >= $${MIN_HEDGE_NOTIONAL}, triggering hedge for ${hedgeQty.toFixed(4)} shares (totalUnhedged)`);
            return { shouldHedge: true, hedgeQty, reason: `Notional $${notionalAmount.toFixed(2)} >= threshold` };
        }

        // 金额未达阈值，继续累计
        console.log(`[TaskExecutor] Accumulating: pending=${ctx.pendingHedgeQty.toFixed(4)}, totalUnhedged=${totalUnhedged.toFixed(4)}, notional=$${notionalAmount.toFixed(2)} < $${MIN_HEDGE_NOTIONAL}, waiting...`);
        return { shouldHedge: false, hedgeQty: 0, reason: `Notional $${notionalAmount.toFixed(2)} < $${MIN_HEDGE_NOTIONAL}` };
    }

    private hasPendingFastHedge(ctx: TaskContext): boolean {
        return Boolean(ctx.inflightHedge)
            || Boolean(ctx.isHedgingInProgress)
            || ctx.reservedHedgeQty > 1e-9;
    }

    /**
     * 估算 hedge notional (USD)。
     * 优先用 lastHedgePriceEstimate (上次成交价/初始 ask)，兜底用 1 - predictPrice。
     */
    private estimateHedgeNotional(ctx: TaskContext, quantity: number): number {
        let price = ctx.lastHedgePriceEstimate;
        if (price <= 0) price = 1 - ctx.task.predictPrice;
        return quantity * price;
    }

    // ========================================================================
    // 公共方法
    // ========================================================================

    /**
     * 判断某个 orderHash 是否属于 executor 管理的订单
     * 检查: 当前活跃任务的 currentOrderHash + executor 使用过的所有 orderHash
     */
    isOrderManagedByExecutor(orderHash: string): { managed: boolean; taskId?: string; title?: string } {
        const hash = orderHash.toLowerCase();

        // 1. 检查当前活跃任务
        for (const [taskId, ctx] of this.runningTasks) {
            if (ctx.currentOrderHash?.toLowerCase() === hash) {
                return { managed: true, taskId, title: ctx.task.title };
            }
        }

        // 2. 检查 executor 使用过的所有 orderHash (覆盖已调单替换的旧 hash)
        const knownTaskId = this.knownOrderHashes.get(hash);
        if (knownTaskId) {
            const knownTask = this.taskService.getTask(knownTaskId);
            return { managed: true, taskId: knownTaskId, title: knownTask?.title };
        }

        return { managed: false };
    }

    /**
     * 启动任务执行
     */
    async startTask(taskId: string): Promise<void> {
        const task = this.taskService.getTask(taskId);
        if (!task) {
            throw new Error(`Task ${taskId} not found`);
        }

        // 支持从 PENDING 或可恢复状态启动 (与 resumeTask 保持一致)
        const startableStatuses: TaskStatus[] = [
            'PENDING',
            'PAUSED',
            'PREDICT_SUBMITTED',
            'PARTIALLY_FILLED',
            'HEDGING',
            'HEDGE_PENDING',
        ];
        if (!startableStatuses.includes(task.status)) {
            throw new Error(`Task ${taskId} cannot be started from status: ${task.status}`);
        }

        if (this.runningTasks.has(taskId)) {
            throw new Error(`Task ${taskId} is already running`);
        }

        if (!this.initialized) {
            await this.init();
        }

        // 创建任务上下文 (恢复已有订单和状态)
        const abortController = new AbortController();
        const ctx: TaskContext = {
            task,
            signal: abortController.signal,
            abortController,
            isPaused: false,
            currentOrderHash: task.currentOrderHash, // 恢复已提交的订单 hash
            totalPredictFilled: task.predictFilledQty || 0,
            totalHedged: task.hedgedQty || 0,
            hedgePriceSum: (task.avgPolymarketPrice || 0) * (task.hedgedQty || 0),
            // 累计对冲机制
            pendingHedgeQty: 0,
            lastHedgePriceEstimate: task.polymarketMaxAsk || 0.5,  // 默认使用任务配置的最大 ask
            polyOrderFills: new Map(),
            // WSS-first 成交追踪
            wssFilledQty: 0,
            predictWsFilledQty: 0,
            wssFillEvents: new Set<string>(),
            pendingFillAccumulated: 0,
            restFilledQty: task.predictFilledQty || 0,
            // Fee 追踪
            currentOrderFeeShares: 0,
            totalPredictFeeShares: 0,
            // 延迟结算填充检测
            baseFilledBeforeOrder: task.predictFilledQty || 0,
            delayedFillQty: 0,
            // 深度监控退避
            depthPausedChecks: 0,
            // Phase 2: 下单/确认解耦
            reservedHedgeQty: 0,
            fastHedgeMetrics: {
                submitCount: 0,
                zeroFillCount: 0,
                cooldownBlockCount: 0,
                unknownCount: 0,
                redispatchCount: 0,
                totalSubmitMs: 0,
                totalWatchMs: 0,
                totalE2eMs: 0,
                e2eSamples: 0,
            },
        };
        this.runningTasks.set(taskId, ctx);

        // 订阅对冲 token 到 Polymarket WS（arb-service 只订阅了 YES token，对冲常用 NO token）
        if (!task.isSportsMarket) {
            const hedgeTokenId = this.getHedgeTokenId(task);
            this.polyWsClient?.subscribe([hedgeTokenId]);
        }

        // 异步执行任务（preflight、日志初始化等慢操作全部在 executeTask 内部，不阻塞 HTTP 响应）
        this.executeTask(ctx).catch(async error => {
            console.error(`[TaskExecutor] Task ${taskId} failed:`, error);

            // 取消未完成的 Predict 订单
            const latestTask = this.taskService.getTask(taskId);
            if (latestTask?.currentOrderHash) {
                try {
                    console.log(`[TaskExecutor] 任务失败，取消 Predict 订单: ${latestTask.currentOrderHash.slice(0, 20)}...`);
                    await this.predictTrader.cancelOrder(latestTask.currentOrderHash);
                } catch (cancelError: any) {
                    console.warn(`[TaskExecutor] 取消订单失败: ${cancelError.message}`);
                }
            }

            // 记录 TASK_FAILED
            await this.taskLogger.logTaskLifecycle(taskId, 'TASK_FAILED', {
                status: 'FAILED',
                error,
            });
            this.updateTask(taskId, {
                status: 'FAILED',
                error: error.message,
            });
        }).finally(() => {
            this.cleanup(ctx);
            this.runningTasks.delete(taskId);
        });
    }

    /**
     * 恢复任务 (从 PAUSED, HEDGING 等状态)
     */
    async resumeTask(taskId: string): Promise<void> {
        const task = this.taskService.getTask(taskId);
        if (!task) {
            throw new Error(`Task ${taskId} not found`);
        }

        const resumableStatuses: TaskStatus[] = [
            'PAUSED',
            'PREDICT_SUBMITTED',
            'PARTIALLY_FILLED',
            'HEDGING',
            'HEDGE_PENDING',
        ];

        if (!resumableStatuses.includes(task.status)) {
            throw new Error(`Task ${taskId} cannot be resumed from status: ${task.status}`);
        }

        // 如果已经在运行，不重复启动
        if (this.runningTasks.has(taskId)) {
            console.log(`[TaskExecutor] Task ${taskId} already running`);
            return;
        }

        console.log(`[TaskExecutor] Resuming task ${taskId} from ${task.status}`);
        await this.startTask(taskId);
    }

    /**
     * 取消任务
     */
    async cancelTask(taskId: string, options?: CancelTaskOptions): Promise<void> {
        let task = this.taskService.getTask(taskId);
        if (!task) {
            throw new Error(`Task ${taskId} not found`);
        }

        const lifecycleReason = options?.reason || 'User cancelled';
        const structuredCancelReason = options?.cancelReason || 'USER_CANCELLED';

        console.log(`[TaskExecutor] 🛑 取消任务 ${taskId}, 当前状态: ${task.status}`);

        // 获取运行上下文
        const ctx = this.runningTasks.get(taskId);
        if (ctx) {
            // 中止所有操作
            ctx.abortController.abort();
            ctx.priceGuardAbort?.abort();
            ctx.predictWatchAbort?.abort();

            // 等待异步操作有机会完成状态同步
            await this.delay(100);
        }

        // 重新获取最新的 task 对象（可能已被执行器更新）
        task = this.taskService.getTask(taskId)!;

        // 取消相关订单
        // 优先使用 task 中的 orderHash (TAKER 模式通过 updateTask 回调更新)
        // ctx.currentOrderHash 仅作为 fallback (PREDICT_MAKER 模式直接更新 ctx)
        const orderHashToCancel = task.currentOrderHash || ctx?.currentOrderHash;

        console.log(`[TaskExecutor] Cancel order check: task.currentOrderHash=${task.currentOrderHash?.slice(0, 16) || 'none'}, ctx.currentOrderHash=${ctx?.currentOrderHash?.slice(0, 16) || 'none'}`);

        if (orderHashToCancel) {
            console.log(`[TaskExecutor] 取消 Predict 订单: ${orderHashToCancel.slice(0, 20)}... (状态: ${task.status}, 已成交: ${task.predictFilledQty}/${task.quantity})`);
            try {
                // 先获取当前订单状态
                const orderStatus = await this.predictTrader.getOrderStatus(orderHashToCancel);
                const remainingQty = orderStatus?.remainingQty ?? (task.quantity - task.predictFilledQty);

                if (orderStatus && (orderStatus.status === 'FILLED' || orderStatus.remainingQty === 0)) {
                    console.log(`[TaskExecutor] ℹ️ Predict 订单已全部成交，无需取消 — 检查是否需要对冲`);
                    await this.handleFilledOrderOnCancel(task, orderStatus, ctx);
                } else if (orderStatus && (orderStatus.status === 'CANCELLED' || orderStatus.status === 'EXPIRED')) {
                    console.log(`[TaskExecutor] ℹ️ Predict 订单已取消/过期，无需操作`);
                } else {
                    // 尝试取消订单
                    const cancelResult = await this.predictTrader.cancelOrder(orderHashToCancel);
                    if (cancelResult.success) {
                        console.log(`[TaskExecutor] ✅ Predict 订单已取消 (剩余: ${remainingQty})`);
                        // 记录订单取消事件（触发 TG 通知）
                        await this.taskLogger.logOrderEvent(taskId, 'ORDER_CANCELLED', {
                            platform: 'predict',
                            orderId: orderHashToCancel,
                            side: task.type,
                            outcome: task.arbSide || 'YES',
                            price: task.predictPrice,
                            quantity: task.quantity,
                            filledQty: task.predictFilledQty,
                            remainingQty: remainingQty,
                            avgPrice: task.avgPredictPrice,
                            cancelReason: lifecycleReason,
                        });

                        // 取消成功后，检查是否有已成交但未对冲的部分
                        if (orderStatus && orderStatus.filledQty > 0) {
                            await this.handleFilledOrderOnCancel(task, orderStatus, ctx);
                        }
                    } else {
                        console.warn(`[TaskExecutor] ⚠️ Predict 订单取消失败 (hash: ${orderHashToCancel.slice(0, 20)}..., 状态: ${task.status}, 已成交: ${task.predictFilledQty}/${task.quantity})`);
                    }
                }
            } catch (e: any) {
                console.warn(`[TaskExecutor] ❌ 取消 Predict 订单异常:`, e.message);
            }
        } else {
            console.log(`[TaskExecutor] 无 Predict 订单需要取消 (task.currentOrderHash: ${task.currentOrderHash || 'none'})`);
        }

        if (orderHashToCancel && ctx) {
            ctx.cancelBscWatcher?.();
        }

        // 重新读取 task，handleFilledOrderOnCancel 可能已下了新的 GTC 订单并设置 HEDGE_FAILED_GTC_PENDING
        const freshTask = this.taskService.getTask(taskId);
        const freshStatus = freshTask?.status;
        const currentPolyOrderId = freshTask?.currentPolyOrderId;

        // 如果 handleFilledOrderOnCancel 下了 GTC 并设置了 HEDGE_FAILED_GTC_PENDING，
        // 保留该状态和 watcher，不覆写为 CANCELLED
        if (freshStatus === 'HEDGE_FAILED_GTC_PENDING') {
            console.log(`[TaskExecutor] cancelTask: 任务 ${taskId} 已转为 HEDGE_FAILED_GTC_PENDING (GTC 对冲中)，保留追踪`);

            // 只取消旧的 Polymarket 订单（非新 GTC）
            const oldPolyOrderId = task.currentPolyOrderId;
            if (oldPolyOrderId && oldPolyOrderId !== currentPolyOrderId) {
                try {
                    await this.polyTrader.cancelOrder(oldPolyOrderId, {
                        marketTitle: task.title,
                        conditionId: task.polymarketConditionId,
                    });
                    console.log(`[TaskExecutor] ✅ 旧 Polymarket 订单 ${oldPolyOrderId.slice(0, 16)}... 已取消`);
                } catch (e: any) {
                    console.warn(`[TaskExecutor] ❌ 取消旧 Polymarket 订单异常:`, e.message);
                }
            }

            // 停止价格守护（但不移除 GTC watcher）
            this.orderMonitor.stopPriceGuard(task.id);
            return;
        }

        // 正常取消流程: 无新 GTC 被创建
        if (currentPolyOrderId) {
            console.log(`[TaskExecutor] 取消 Polymarket 订单: ${currentPolyOrderId}`);
            try {
                await this.polyTrader.cancelOrder(currentPolyOrderId, {
                    marketTitle: task.title,
                    conditionId: task.polymarketConditionId,
                });
                console.log(`[TaskExecutor] ✅ Polymarket 订单已取消`);
                await this.taskLogger.logOrderEvent(taskId, 'ORDER_CANCELLED', {
                    platform: 'polymarket',
                    orderId: currentPolyOrderId,
                    side: task.type === 'BUY' ? 'BUY' : 'SELL',
                    outcome: task.arbSide === 'YES' ? 'NO' : 'YES',
                    price: task.avgPolymarketPrice || 0,
                    quantity: task.hedgedQty || 0,
                    filledQty: task.hedgedQty || 0,
                    remainingQty: 0,
                    avgPrice: task.avgPolymarketPrice || 0,
                    cancelReason: lifecycleReason,
                });
            } catch (e: any) {
                console.warn(`[TaskExecutor] ❌ 取消 Polymarket 订单异常:`, e.message);
            }
        }

        // 清理 GTC 保底 WS 监听器
        this.removeGtcWatcher(taskId);

        // 停止监控
        this.orderMonitor.stopPolymarketWatch(task.currentPolyOrderId || '');
        this.orderMonitor.stopPriceGuard(task.id);

        // 记录 TASK_CANCELLED
        await this.taskLogger.logTaskLifecycle(taskId, 'TASK_CANCELLED', {
            status: 'CANCELLED',
            previousStatus: task.status,
            reason: lifecycleReason,
            cancelledOrderHash: orderHashToCancel,
            cancelledPolyOrderId: task.currentPolyOrderId,
            cancelReason: structuredCancelReason,
        });

        // 更新状态
        this.updateTask(taskId, {
            status: 'CANCELLED',
            cancelReason: structuredCancelReason,
            error: lifecycleReason,
        });
        console.log(`[TaskExecutor] ✅ 任务 ${taskId} 已取消`);
    }

    /**
     * 检查任务是否正在运行
     */
    isTaskRunning(taskId: string): boolean {
        return this.runningTasks.has(taskId);
    }

    /**
     * 获取运行中任务数量
     */
    getRunningTaskCount(): number {
        return this.runningTasks.size;
    }

    /**
     * 优雅关闭 - 暂停所有运行中的任务
     * 在 Dashboard 关闭/重启时调用
     */
    async shutdown(options?: { concurrency?: number; timeoutMs?: number }): Promise<void> {
        console.log('[TaskExecutor] shutdown() 开始执行...');
        if (this.shuttingDown) {
            console.log('[TaskExecutor] shutdown() 已在进行中，跳过重复调用');
            return;
        }
        this.shuttingDown = true;

        // 停止过期检查定时器
        if (this.expiryCheckInterval) {
            clearInterval(this.expiryCheckInterval);
            this.expiryCheckInterval = undefined;
            console.log('[TaskExecutor] 已停止过期检查定时器');
        }

        // 先批量取消 Predict 所有挂单（比逐个取消快得多）
        // Polymarket 只做 TAKER 吃单，不会有挂单，无需取消
        console.log('[TaskExecutor] 批量取消 Predict 所有挂单...');
        const bulkStart = Date.now();
        await this.predictTrader.cancelAllOrders().catch(e => {
            console.warn('[TaskExecutor] Predict 批量取消失败:', e.message);
        });
        console.log(`[TaskExecutor] 批量取消完成 (${Date.now() - bulkStart}ms)`);

        // 再逐个暂停任务（更新状态、清理监控，不再需要逐个取消订单）
        const taskIdsToPause = this.collectTaskIdsToPause();
        await this.pauseTasksInternal(taskIdsToPause, 'Dashboard 关闭/重启', options);
        console.log('[TaskExecutor] 所有任务已暂停，可以安全关闭');
    }

    /**
     * 暂停所有运行中的任务（不停止过期检查）
     */
    async pauseTasks(reason: string, options?: { concurrency?: number; timeoutMs?: number; excludeSports?: boolean }): Promise<string[]> {
        if (this.pausing) {
            console.log('[TaskExecutor] pauseTasks() 已在进行中，跳过重复调用');
            return [];
        }
        this.pausing = true;

        try {
            let taskIdsToPause = this.collectTaskIdsToPause();

            // WS 断连时排除体育市场任务（体育市场使用 REST 轮询，不依赖 WS）
            if (options?.excludeSports) {
                taskIdsToPause = taskIdsToPause.filter(id => {
                    const task = this.taskService.getTask(id);
                    return task && !task.isSportsMarket;
                });
            }

            if (taskIdsToPause.length === 0) {
                console.log('[TaskExecutor] 没有需要暂停/取消挂单的任务');
                return [];
            }

            console.log(`[TaskExecutor] 正在暂停 ${taskIdsToPause.length} 个任务 (reason=${reason})...`);
            const pausedIds: string[] = [];

            // 标记哪些任务原本不是 PAUSED，用于自动恢复
            const preStatuses = new Map<string, TaskStatus>();
            for (const taskId of taskIdsToPause) {
                const task = this.taskService.getTask(taskId);
                if (task) preStatuses.set(taskId, task.status);
            }

            await this.pauseTasksInternal(taskIdsToPause, reason, options);

            for (const taskId of taskIdsToPause) {
                const prev = preStatuses.get(taskId);
                if (prev && prev !== 'PAUSED') {
                    pausedIds.push(taskId);
                }
            }

            return pausedIds;
        } finally {
            this.pausing = false;
        }
    }

    /**
     * 为关闭/断连而暂停单个任务
     */
    private async pauseTaskWithCancel(taskId: string, reason: string): Promise<void> {
        const task = this.taskService.getTask(taskId);
        if (!task) {
            console.log(`[TaskExecutor] 任务 ${taskId} 不存在，跳过`);
            return;
        }

        const ctx = this.runningTasks.get(taskId);

        // 详细日志：显示所有可能的订单 hash 来源
        console.log(`[TaskExecutor] Pause task ${taskId} (reason=${reason}):`);
        console.log(`  - task.currentOrderHash: ${task.currentOrderHash?.slice(0, 20) || '(none)'}`);
        console.log(`  - ctx?.currentOrderHash: ${ctx?.currentOrderHash?.slice(0, 20) || '(none)'}`);
        console.log(`  - task.status: ${task.status}`);

        if (ctx) {
            // 中止所有操作
            console.log(`[TaskExecutor] 中止任务 ${taskId} 的所有控制器...`);
            ctx.abortController.abort();
            ctx.priceGuardAbort?.abort();
            ctx.predictWatchAbort?.abort();
        }

        // 取消 Predict 订单（如果有）- 同时检查 task 和 ctx 中的订单 hash
        const orderHashToCancel = task.currentOrderHash || ctx?.currentOrderHash;
        let shouldClearPredictOrderHash = false;
        if (orderHashToCancel) {
            try {
                console.log(`[TaskExecutor] 🔴 正在取消 Predict 订单: ${orderHashToCancel.slice(0, 20)}...`);
                const startTime = Date.now();

                // 使用 Promise.race 确保有明确的等待行为
                const cancelPromise = this.predictTrader.cancelOrder(orderHashToCancel);
                const timeoutPromise = new Promise<CancelResult>((resolve) =>
                    setTimeout(() => {
                        console.log(`[TaskExecutor] ⚠️ 取消订单等待超时 (8s)`);
                        resolve({ success: false, action: 'failed' });
                    }, 8000)
                );

                const cancelResult = await Promise.race([cancelPromise, timeoutPromise]);
                const elapsed = Date.now() - startTime;

                if (cancelResult.success) {
                    console.log(`[TaskExecutor] ✅ 已取消 Predict 订单: ${orderHashToCancel.slice(0, 20)}... (耗时 ${elapsed}ms)`);
                    shouldClearPredictOrderHash = true;
                } else {
                    console.log(`[TaskExecutor] ⚠️ 订单可能已成交或已取消: ${orderHashToCancel.slice(0, 20)}... (耗时 ${elapsed}ms)`);
                }
            } catch (e: any) {
                console.warn(`[TaskExecutor] ⚠️ 取消订单时出错: ${e.message}`);
            }
        } else {
            console.log(`[TaskExecutor] ⚠️ 没有找到需要取消的订单 (task 和 ctx 中都没有 orderHash)`);
        }

        // 取消 Polymarket 订单（如果有）
        const polyOrderIdToCancel = task.currentPolyOrderId;
        let shouldClearPolyOrderId = false;
        if (polyOrderIdToCancel) {
            try {
                console.log(`[TaskExecutor] 🔴 正在取消 Polymarket 订单: ${polyOrderIdToCancel.slice(0, 10)}...`);
                const cancelled = await this.polyTrader.cancelOrder(polyOrderIdToCancel, {
                    timeoutMs: 5000,
                    skipTelegram: true,
                });
                if (cancelled) {
                    console.log(`[TaskExecutor] ✅ Polymarket 订单已取消`);
                    shouldClearPolyOrderId = true;
                } else {
                    console.warn(`[TaskExecutor] ⚠️ Polymarket 订单取消失败或已不存在`);
                }
            } catch (e: any) {
                console.warn(`[TaskExecutor] ⚠️ 取消 Polymarket 订单时出错: ${e.message}`);
            }
        }

        // 停止监控
        console.log(`[TaskExecutor] 停止任务 ${taskId} 的监控...`);
        this.orderMonitor.stopPolymarketWatch(task.currentPolyOrderId || '');
        this.orderMonitor.stopPriceGuard(taskId);

        // 清理运行上下文
        this.runningTasks.delete(taskId);

        // 只暂停未完成的任务
        const terminalStatuses: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'HEDGE_FAILED', 'UNWIND_COMPLETED'];
        if (!terminalStatuses.includes(task.status)) {
            // 记录暂停原因 (不 await，避免阻塞关闭)
            this.taskLogger.logTaskLifecycle(taskId, 'TASK_PAUSED', {
                status: 'PAUSED',
                previousStatus: task.status,
                reason,
            }).catch(() => { /* ignore log errors during shutdown */ });

            // 更新状态为暂停（保留原有的 pauseCount）
            this.updateTask(taskId, {
                status: 'PAUSED',
                // 只有在确认取消成功时才清空引用；否则保留用于下次启动继续取消/排查
                currentOrderHash: shouldClearPredictOrderHash ? undefined : orderHashToCancel,
                currentPolyOrderId: shouldClearPolyOrderId ? undefined : polyOrderIdToCancel,
            });
            console.log(`[TaskExecutor] 任务 ${taskId} 状态已更新为 PAUSED`);
        }
    }

    /**
     * Polymarket WS 断连时暂停所有非体育任务
     *
     * 非体育市场完全依赖 WS 监控 Polymarket 订单簿，
     * WS 断连意味着价格保护失效，必须立即撤单暂停以避免单边风险。
     * WS 自动重连后，价格守护 onPriceValid 会触发恢复。
     */
    private async pauseAllNonSportsTasks(disconnectedTokenId: string): Promise<void> {
        const tasksToPause: string[] = [];
        for (const [taskId, ctx] of this.runningTasks) {
            if (!ctx.task.isSportsMarket && !ctx.isPaused) {
                tasksToPause.push(taskId);
            }
        }

        if (tasksToPause.length === 0) return;

        console.warn(`[TaskExecutor] Polymarket WS 断连 (token: ${disconnectedTokenId.slice(0, 10)}...) → 暂停 ${tasksToPause.length} 个非体育任务`);

        for (const taskId of tasksToPause) {
            const ctx = this.runningTasks.get(taskId);
            if (!ctx || ctx.isPaused) continue;

            ctx.isPaused = true;

            // 取消 Predict 挂单
            let cancelSuccess = false;
            if (ctx.currentOrderHash) {
                try {
                    const cancelResult = await this.predictTrader.cancelOrder(ctx.currentOrderHash);
                    cancelSuccess = cancelResult.success;
                    if (cancelSuccess) {
                        await this.taskLogger.logOrderEvent(taskId, 'ORDER_CANCELLED', {
                            platform: 'predict',
                            orderId: ctx.currentOrderHash,
                            side: ctx.task.type,
                            price: ctx.task.predictPrice,
                            quantity: ctx.task.quantity,
                            filledQty: ctx.totalPredictFilled,
                            remainingQty: ctx.task.quantity - ctx.totalPredictFilled,
                            avgPrice: ctx.task.predictPrice,
                            cancelReason: `WS 断连 (token: ${disconnectedTokenId.slice(0, 10)}...)`,
                        }, ctx.currentOrderHash);
                    }
                } catch (e: any) {
                    console.warn(`[TaskExecutor] 取消订单失败 (WS断连暂停): ${e.message}`);
                }
                ctx.predictWatchAbort?.abort();
                ctx.predictWatchAbort = new AbortController();
                if (cancelSuccess) {
                    ctx.cancelBscWatcher?.();
                    ctx.currentOrderHash = undefined;
                }
                // 取消失败时保留 hash，让恢复路径可以重试取消
            }

            const reason = `Polymarket WS 断连 (token: ${disconnectedTokenId.slice(0, 10)}...)`;
            await this.taskLogger.logTaskLifecycle(taskId, 'TASK_PAUSED', {
                status: 'PAUSED',
                previousStatus: ctx.task.status,
                reason,
            });

            const task = this.updateTask(taskId, {
                status: 'PAUSED',
                pauseCount: ctx.task.pauseCount + 1,
                ...(cancelSuccess ? { currentOrderHash: undefined } : {}),
            });
            ctx.task = task;

            console.log(`[TaskExecutor] 任务 ${taskId} 已暂停 (WS断连)`);
        }
    }

    private collectTaskIdsToPause(): string[] {
        const runningTaskIds = Array.from(this.runningTasks.keys());

        // 兜底：除了 runningTasks 外，也暂停所有“可能仍有挂单”的非终态任务
        // 场景：启动/恢复过程中 Ctrl+C，任务还没加入 runningTasks，但 currentOrderHash/currentPolyOrderId 已写入 task
        const terminalStatuses: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'HEDGE_FAILED', 'UNWIND_COMPLETED'];
        const tasksWithPotentialOrders = this.taskService.getTasks({ includeCompleted: true })
            .filter(t => !terminalStatuses.includes(t.status))
            .filter(t => Boolean(t.currentOrderHash || t.currentPolyOrderId))
            .map(t => t.id);

        return Array.from(new Set([...runningTaskIds, ...tasksWithPotentialOrders]));
    }

    private async pauseTasksInternal(
        taskIdsToPause: string[],
        reason: string,
        options?: { concurrency?: number; timeoutMs?: number }
    ): Promise<void> {
        if (taskIdsToPause.length === 0) {
            console.log('[TaskExecutor] 没有需要暂停/取消挂单的任务');
            return;
        }

        const concurrency = Math.max(1, Math.min(options?.concurrency ?? 4, taskIdsToPause.length));
        const timeoutMs = options?.timeoutMs ?? 60000;
        const queue = [...taskIdsToPause];
        const startTime = Date.now();

        const runWorkers = async () => {
            const workers = Array.from({ length: concurrency }, async () => {
                while (queue.length > 0) {
                    const taskId = queue.shift();
                    if (!taskId) break;
                    try {
                        console.log(`[TaskExecutor] 开始暂停任务 ${taskId}...`);
                        await this.pauseTaskWithCancel(taskId, reason);
                        console.log(`[TaskExecutor] ✅ 任务 ${taskId} 已暂停`);
                    } catch (error: any) {
                        console.error(`[TaskExecutor] ❌ 暂停任务 ${taskId} 失败:`, error.message);
                    }
                }
            });
            await Promise.all(workers);
        };

        try {
            await Promise.race([
                runWorkers(),
                new Promise<void>((_, reject) =>
                    setTimeout(() => reject(new Error(`TaskExecutor pause timeout (${timeoutMs}ms)`)), timeoutMs)
                ),
            ]);
        } finally {
            const elapsed = Date.now() - startTime;
            console.log(`[TaskExecutor] pause finished in ${elapsed}ms (concurrency=${concurrency}, reason=${reason})`);
        }
    }

    // ========================================================================
    // 任务执行
    // ========================================================================

    private async executeTask(ctx: TaskContext): Promise<void> {
        const { task, signal } = ctx;
        const taskId = task.id;

        // 1. 并行执行独立的初始化操作（减少启动延迟）
        const hedgeTokenId = this.getHedgeTokenId(task);
        if (task.status === 'PENDING') {
            const [_, preflightResult] = await Promise.all([
                // 初始化日志目录
                this.taskLogger.initTaskLogDir(taskId),
                // Polymarket 签名预检
                this.polyTrader.preflightCheck({
                    tokenId: hedgeTokenId,
                    negRisk: task.negRisk,
                    conditionId: task.polymarketConditionId,
                }),
                // 预热 Predict 市场信息缓存
                this.predictTrader.getPriceDecimals(task.marketId).catch(e =>
                    console.warn('[TaskExecutor] getPriceDecimals warmup error:', e?.message)),
                // 预热 Polymarket fee rate 缓存（对冲时不再阻塞）
                this.polyTrader.getFeeRate(hedgeTokenId).catch(e =>
                    console.warn('[TaskExecutor] getFeeRate warmup error:', e?.message)),
            ]);
            if (!preflightResult.success) {
                throw new Error(`Polymarket 签名预检失败: ${preflightResult.error}`);
            }
        } else {
            // 恢复任务: 只需初始化日志 + 预热缓存
            await Promise.all([
                this.taskLogger.initTaskLogDir(taskId),
                this.predictTrader.getPriceDecimals(task.marketId).catch(e =>
                    console.warn('[TaskExecutor] getPriceDecimals warmup error:', e?.message)),
                // 预热 Polymarket fee rate 缓存
                this.polyTrader.getFeeRate(hedgeTokenId).catch(e =>
                    console.warn('[TaskExecutor] getFeeRate warmup error:', e?.message)),
            ]);
        }

        // 2. 记录 TASK_STARTED (必须在 initTaskLogDir 之后)
        await this.taskLogger.logTaskLifecycle(taskId, 'TASK_STARTED', {
            status: task.status,
            taskConfig: this.buildTaskConfigSnapshot(task),
        });

        // 3. 执行任务
        console.log(`[TaskExecutor] Executing ${task.type} task: ${taskId}`);

        if (task.type === 'BUY') {
            await this.executeBuyTask(ctx);
        } else {
            await this.executeSellTask(ctx);
        }
    }

    /**
     * 执行 BUY 任务
     *
     * 流程:
     * - PREDICT_MAKER: Predict 下 Maker 买单 (YES)，等待成交，对冲
     * - TAKER: Predict 下 LIMIT @ ask，超时撤单，对冲
     */
    private async executeBuyTask(ctx: TaskContext): Promise<void> {
        const { signal } = ctx;
        let task = ctx.task;
        const strategy = task.strategy ?? 'PREDICT_MAKER';

        // ===== TAKER 模式路由到 TakerExecutor =====
        if (strategy === 'TAKER') {
            console.log(`[TaskExecutor] Routing to TakerExecutor for task ${task.id}`);
            await this.takerExecutor.executeTakerBuy({
                task,
                currentOrderHash: ctx.currentOrderHash,
                // WSS-first 成交追踪
                wssFilledQty: 0,
                wssFillEvents: new Set<string>(),
                restFilledQty: ctx.totalPredictFilled,
                totalPredictFilled: ctx.totalPredictFilled,
                totalHedged: ctx.totalHedged,
                hedgePriceSum: ctx.hedgePriceSum,
                // 累计对冲机制
                pendingHedgeQty: 0,
                lastHedgePriceEstimate: task.polymarketMaxAsk || 0.5,
                signal,
                abortController: ctx.abortController,
                startTime: task.createdAt,
                // 状态预获取相关
                hasReceivedValidStatus: false,
                statusFetchAttempts: 0,
                statusFetchFailures: 0,
            });
            return;
        }

        // ===== POLY_MAKER 模式路由到 PolyMakerExecutor =====
        if (strategy === 'POLY_MAKER') {
            console.log(`[TaskExecutor] Routing to PolyMakerExecutor for task ${task.id}`);
            await this.polyMakerExecutor.executePolyMakerBuy({
                task,
                currentPolyOrderId: task.currentPolyOrderId,
                // 成交追踪
                wsFilledQty: 0,
                restFilledQty: task.predictFilledQty || 0,
                totalPolyFilled: task.predictFilledQty || 0,
                baseFilledQty: task.currentPolyOrderId ? 0 : (task.predictFilledQty || 0),
                // 对冲追踪
                totalHedged: task.hedgedQty || ctx.totalHedged,
                hedgePriceSum: (task.avgPredictPrice || 0) * (task.hedgedQty || ctx.totalHedged),
                // 累计对冲
                pendingHedgeQty: 0,
                lastHedgePriceEstimate: task.predictPrice || 0.5,
                // 价格守护
                isPaused: false,
                pauseCount: task.pauseCount || 0,
                depthPausedChecks: 0,
                // 互斥
                isHedgingInProgress: false,
                // WS 去重
                lastKnownSizeMatched: task.currentPolyOrderId ? (task.predictFilledQty || 0) : 0,
                // abort
                signal,
                abortController: ctx.abortController,
            });
            return;
        }

        // ===== PREDICT_MAKER 模式 (原有逻辑) =====
        // negRisk 预检已在 executeTask → preflightCheck 中完成，此处不再重复调用 getMarketInfo

        // 1. 提交 Predict Maker 买单 (如果还没有)
        if (!ctx.currentOrderHash && task.status === 'PENDING') {
            // Maker 价格安全检查: 等待挂单价 < 卖一价，防止被吃单成交
            const priceCheckStartBuy = Date.now();
            const PRICE_CHECK_MAX_WAIT_MS_BUY = 30_000;
            let waited = false;
            while (!signal.aborted && !ctx.isPaused) {
                const priceCheck = await this.isPredictPriceSafeForMaker(task, 'BUY');
                if (priceCheck.safe) break;
                // 超时处理：区分 orderbook 不可用 vs 价格确实不安全
                if (Date.now() - priceCheckStartBuy > PRICE_CHECK_MAX_WAIT_MS_BUY) {
                    const isOrderbookIssue = priceCheck.reason?.includes('unavailable') || priceCheck.reason?.includes('exception');
                    if (isOrderbookIssue) {
                        console.warn(`[TaskExecutor] Task ${task.id}: 价格安全检查超时 (${PRICE_CHECK_MAX_WAIT_MS_BUY / 1000}s)，orderbook 不可用，放行执行`);
                        break;
                    } else {
                        console.warn(`[TaskExecutor] Task ${task.id}: 价格安全检查超时 (${PRICE_CHECK_MAX_WAIT_MS_BUY / 1000}s)，价格持续不安全 (${priceCheck.reason})，暂停任务`);
                        ctx.isPaused = true;
                        this.taskLogger.logTaskLifecycle(task.id, 'TASK_PAUSED', {
                            status: 'PAUSED',
                            previousStatus: task.status,
                            reason: `Maker price safety timeout: ${priceCheck.reason}`,
                        }).catch(() => {});
                        task = this.updateTask(task.id, { status: 'PAUSED', pauseCount: task.pauseCount + 1 });
                        ctx.task = task;
                        return;
                    }
                }
                if (!waited) {
                    console.warn(`[TaskExecutor] Task ${task.id}: Maker BUY 价格不安全 (${priceCheck.reason})，等待卖一价上移后下单`);
                    waited = true;
                }
                await this.delay(1000);
            }
            if (signal.aborted || ctx.isPaused) return;

            const predictResult = await this.submitPredictOrder(task, 'BUY');
            if (!predictResult.success) {
                // 记录订单失败
                await this.taskLogger.logOrderEvent(task.id, 'ORDER_FAILED', {
                    platform: 'predict',
                    orderId: '',
                    side: 'BUY',
                    price: task.predictPrice,
                    quantity: task.quantity,
                    filledQty: 0,
                    remainingQty: task.quantity,
                    avgPrice: 0,
                    error: new Error(predictResult.error || 'Unknown error'),
                });
                throw new Error(`Predict order failed: ${predictResult.error}`);
            }

            ctx.currentOrderHash = predictResult.hash;

            // 记录订单提交 + 订单簿快照
            await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                platform: 'predict',
                orderId: predictResult.hash!,
                side: 'BUY',
                price: task.predictPrice,
                quantity: task.quantity,
                filledQty: 0,
                remainingQty: task.quantity,
                avgPrice: 0,
            }, predictResult.hash);

            // 捕获订单簿快照 (fire-and-forget，不阻塞关键路径)
            this.captureSnapshot(task.id, 'order_submit', task).catch(e => console.warn(`[TaskExecutor] captureSnapshot error:`, e?.message));

            task = this.updateTask(task.id, {
                status: 'PREDICT_SUBMITTED',
                currentOrderHash: predictResult.hash,
            });
            ctx.task = task;
        }

        if (signal.aborted) return;

        // 2. 启动价格守护 + Predict 订单监控
        await this.runWithPriceGuard(ctx, 'BUY');
    }

    /**
     * 执行 SELL 任务
     *
     * 流程:
     * 1. Predict 下 Maker 卖单 (YES)
     * 2. 启动价格守护 (对称风控)
     * 3. 等待成交
     * 4. Polymarket 卖出 (NO/YES based on isInverted)
     */
    private async executeSellTask(ctx: TaskContext): Promise<void> {
        const { signal } = ctx;
        let task = ctx.task;
        const strategy = task.strategy ?? 'PREDICT_MAKER';

        // ===== TAKER 模式路由到 TakerExecutor（NO 端套利: Predict SELL YES ≈ BUY NO） =====
        if (strategy === 'TAKER') {
            console.log(`[TaskExecutor] Routing to TakerExecutor for task ${task.id}`);
            await this.takerExecutor.executeTakerSell({
                task,
                currentOrderHash: ctx.currentOrderHash,
                // WSS-first 成交追踪
                wssFilledQty: 0,
                wssFillEvents: new Set<string>(),
                restFilledQty: ctx.totalPredictFilled,
                totalPredictFilled: ctx.totalPredictFilled,
                totalHedged: ctx.totalHedged,
                hedgePriceSum: ctx.hedgePriceSum,
                // 累计对冲机制
                pendingHedgeQty: 0,
                lastHedgePriceEstimate: task.polymarketMinBid || 0.5,
                signal,
                abortController: ctx.abortController,
                startTime: task.createdAt,
                // 状态预获取相关
                hasReceivedValidStatus: false,
                statusFetchAttempts: 0,
                statusFetchFailures: 0,
            });
            return;
        }

        // negRisk 预检已在 executeTask → preflightCheck 中完成，此处不再重复调用 getMarketInfo

        // 1. 提交 Predict Maker 卖单
        if (!ctx.currentOrderHash && task.status === 'PENDING') {
            // Maker 价格安全检查: 等待挂单价 > 买一价，防止被吃单成交
            const priceCheckStartSell = Date.now();
            const PRICE_CHECK_MAX_WAIT_MS_SELL = 30_000;
            let waited = false;
            while (!signal.aborted && !ctx.isPaused) {
                const priceCheck = await this.isPredictPriceSafeForMaker(task, 'SELL');
                if (priceCheck.safe) break;
                // 超时处理：区分 orderbook 不可用 vs 价格确实不安全
                if (Date.now() - priceCheckStartSell > PRICE_CHECK_MAX_WAIT_MS_SELL) {
                    const isOrderbookIssue = priceCheck.reason?.includes('unavailable') || priceCheck.reason?.includes('exception');
                    if (isOrderbookIssue) {
                        console.warn(`[TaskExecutor] Task ${task.id}: 价格安全检查超时 (${PRICE_CHECK_MAX_WAIT_MS_SELL / 1000}s)，orderbook 不可用，放行执行`);
                        break;
                    } else {
                        console.warn(`[TaskExecutor] Task ${task.id}: 价格安全检查超时 (${PRICE_CHECK_MAX_WAIT_MS_SELL / 1000}s)，价格持续不安全 (${priceCheck.reason})，暂停任务`);
                        ctx.isPaused = true;
                        this.taskLogger.logTaskLifecycle(task.id, 'TASK_PAUSED', {
                            status: 'PAUSED',
                            previousStatus: task.status,
                            reason: `Maker price safety timeout: ${priceCheck.reason}`,
                        }).catch(() => {});
                        task = this.updateTask(task.id, { status: 'PAUSED', pauseCount: task.pauseCount + 1 });
                        ctx.task = task;
                        return;
                    }
                }
                if (!waited) {
                    console.warn(`[TaskExecutor] Task ${task.id}: Maker SELL 价格不安全 (${priceCheck.reason})，等待买一价下移后下单`);
                    waited = true;
                }
                await this.delay(1000);
            }
            if (signal.aborted || ctx.isPaused) return;

            const predictResult = await this.submitPredictOrder(task, 'SELL');
            if (!predictResult.success) {
                // 记录订单失败
                await this.taskLogger.logOrderEvent(task.id, 'ORDER_FAILED', {
                    platform: 'predict',
                    orderId: '',
                    side: 'SELL',
                    price: task.predictPrice,
                    quantity: task.quantity,
                    filledQty: 0,
                    remainingQty: task.quantity,
                    avgPrice: 0,
                    error: new Error(predictResult.error || 'Unknown error'),
                });
                throw new Error(`Predict order failed: ${predictResult.error}`);
            }

            ctx.currentOrderHash = predictResult.hash;

            // 记录订单提交 + 订单簿快照
            await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                platform: 'predict',
                orderId: predictResult.hash!,
                side: 'SELL',
                price: task.predictPrice,
                quantity: task.quantity,
                filledQty: 0,
                remainingQty: task.quantity,
                avgPrice: 0,
            }, predictResult.hash);

            // 捕获订单簿快照 (fire-and-forget，不阻塞关键路径)
            this.captureSnapshot(task.id, 'order_submit', task).catch(e => console.warn(`[TaskExecutor] captureSnapshot error:`, e?.message));

            task = this.updateTask(task.id, {
                status: 'PREDICT_SUBMITTED',
                currentOrderHash: predictResult.hash,
            });
            ctx.task = task;
        }

        if (signal.aborted) return;

        // 2. 启动价格守护 + Predict 订单监控 (SELL 也需要价格守护)
        await this.runWithPriceGuard(ctx, 'SELL');
    }

    /**
     * 带价格守护的订单监控
     *
     * 核心改进:
     * - 使用 AbortController 控制 Promise 生命周期
     * - 价格无效时正确中断等待
     * - 支持增量对冲 (部分成交时立即对冲)
     */
    private async runWithPriceGuard(ctx: TaskContext, side: 'BUY' | 'SELL'): Promise<void> {
        const { signal } = ctx;
        let task = ctx.task;

        // 创建价格守护的 AbortController
        ctx.priceGuardAbort = new AbortController();
        ctx.predictWatchAbort = new AbortController();

        const hedgeTokenId = this.getHedgeTokenId(task);

        // 启动价格守护
        const maxPrice = side === 'BUY' ? task.polymarketMaxAsk : 1.0;
        const minPrice = side === 'SELL' ? task.polymarketMinBid : 0.0;

        // Predict 价格复查: 当 onPriceValid 因 Predict 价格不安全而阻塞时，
        // 使用 generation 计数器确保 onPriceInvalid 能中断旧的复查循环
        let priceGuardGeneration = 0;

        this.orderMonitor.startPriceGuard(
            {
                taskId: task.id,
                predictPrice: task.predictPrice,
                polymarketTokenId: hedgeTokenId,
                feeRateBps: 0, // Maker 无费用
                maxPolymarketPrice: maxPrice,
                minPolymarketPrice: minPrice,
                side: side,
                isSportsMarket: task.isSportsMarket,
            },
            {
                onPriceInvalid: async (currentPrice) => {
                    if (signal.aborted || ctx.priceGuardAbort?.signal.aborted) return;
                    task = ctx.task; // 同步深度监控可能更新的 task.quantity

                    priceGuardGeneration++; // 中断旧的 onPriceValid 复查循环

                    const priceType = side === 'BUY' ? 'ask' : 'bid';
                    const threshold = side === 'BUY' ? maxPrice : minPrice;
                    console.log(`[TaskExecutor] Price guard triggered: poly ${priceType}=${currentPrice.toFixed(4)}, threshold=${threshold.toFixed(4)}`);

                    ctx.isPaused = true;

                    // 构造取消原因
                    const priceReasonMsg = side === 'BUY'
                        ? `价格保护: poly ask=${currentPrice.toFixed(4)} > max=${threshold.toFixed(4)}`
                        : `价格保护: poly bid=${currentPrice.toFixed(4)} < min=${threshold.toFixed(4)}`;

                    // Cancel-first: 立即取消 Predict 订单，最高优先级
                    let cancelSuccess = false;
                    if (ctx.currentOrderHash) {
                        let cancelAction: CancelResult['action'] = 'failed';
                        try {
                            const cancelResult = await this.predictTrader.cancelOrder(ctx.currentOrderHash);
                            cancelAction = cancelResult.action;
                            // noop 时不视为取消成功 — 订单可能尚未入簿，随后仍会入簿
                            cancelSuccess = cancelResult.action === 'removed';
                            if (cancelResult.action === 'noop') {
                                console.warn(`[TaskExecutor] Price guard: cancel returned noop — order may still enter orderbook, keeping hash for REST polling`);
                            }
                            // 取消后查询最终成交量
                            const postStatus = await this.predictTrader.getOrderStatus(ctx.currentOrderHash);
                            if (postStatus && postStatus.filledQty > ctx.restFilledQty) {
                                ctx.restFilledQty = postStatus.filledQty;
                            }
                            if (postStatus && postStatus.status === 'FILLED') {
                                // 订单已完全成交 (cancel 为 noop)，让主循环处理对冲
                                console.log(`[TaskExecutor] Price guard: order FILLED after cancel → main loop will hedge`);
                                // 日志和快照 fire-and-forget
                                this.taskLogger.logPriceGuard(task.id, 'PRICE_GUARD_TRIGGERED', {
                                    polymarketTokenId: hedgeTokenId,
                                    triggerPrice: currentPrice,
                                    thresholdPrice: threshold,
                                    predictPrice: task.predictPrice,
                                    arbValid: false,
                                    pauseCount: task.pauseCount + 1,
                                }).catch(() => {});
                                this.taskLogger.logTaskLifecycle(task.id, 'TASK_RESUMED', {
                                    status: task.status as any,
                                    reason: 'Price guard: order FILLED after cancel (noop), resuming for hedge',
                                }).catch(() => {});
                                ctx.isPaused = false;
                                return;
                            }
                            if (cancelSuccess) {
                                // 正常取消成功 — 日志后置 fire-and-forget
                                this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                                    platform: 'predict',
                                    orderId: ctx.currentOrderHash,
                                    side: side,
                                    price: task.predictPrice,
                                    quantity: task.quantity,
                                    filledQty: ctx.totalPredictFilled,
                                    remainingQty: task.quantity - ctx.totalPredictFilled,
                                    avgPrice: task.predictPrice,
                                    cancelReason: priceReasonMsg,
                                }, ctx.currentOrderHash).catch(() => {});
                            }
                        } catch (e) {
                            console.warn('[TaskExecutor] Failed to cancel order on pause:', e);
                        }
                        // 中断当前的订单监控
                        ctx.predictWatchAbort?.abort();
                        ctx.predictWatchAbort = new AbortController();
                        if (cancelSuccess) {
                            ctx.cancelBscWatcher?.();
                            ctx.currentOrderHash = undefined;
                        } else {
                            // Cancel noop/failed: 订单可能仍在簿上或即将入簿，保留 hash 让主循环 REST 轮询继续监控
                            this.orderMonitor.resetPriceGuardState(task.id);
                        }
                    }

                    // 日志和快照后置 (fire-and-forget，不阻塞关键路径)
                    this.taskLogger.logPriceGuard(task.id, 'PRICE_GUARD_TRIGGERED', {
                        polymarketTokenId: hedgeTokenId,
                        triggerPrice: currentPrice,
                        thresholdPrice: threshold,
                        predictPrice: task.predictPrice,
                        arbValid: false,
                        pauseCount: task.pauseCount + 1,
                    }).catch(() => {});
                    this.captureSnapshot(task.id, 'price_guard', task).catch(() => {});

                    // 记录任务暂停
                    const reasonMsg = side === 'BUY'
                        ? `poly ask=${currentPrice.toFixed(4)} > max=${threshold.toFixed(4)}`
                        : `poly bid=${currentPrice.toFixed(4)} < min=${threshold.toFixed(4)}`;
                    await this.taskLogger.logTaskLifecycle(task.id, 'TASK_PAUSED', {
                        status: 'PAUSED',
                        previousStatus: task.status,
                        reason: `Price guard triggered: ${reasonMsg}`,
                    });

                    task = this.updateTask(task.id, {
                        status: 'PAUSED',
                        pauseCount: task.pauseCount + 1,
                        ...(cancelSuccess ? { currentOrderHash: undefined } : {}),
                    });
                    ctx.task = task;

                    // 检查是否超过最大暂停次数
                    if (task.pauseCount >= MAX_PAUSE_COUNT) {
                        console.error(`[TaskExecutor] Max pause count exceeded`);
                        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                            status: 'FAILED',
                            previousStatus: 'PAUSED',
                            reason: 'Max pause count exceeded',
                        });
                        ctx.priceGuardAbort?.abort();
                        this.updateTask(task.id, {
                            status: 'FAILED',
                            error: 'Max pause count exceeded',
                        });
                    }
                },
                onPriceValid: async (currentPrice) => {
                    if (signal.aborted || ctx.priceGuardAbort?.signal.aborted) return;
                    if (!ctx.isPaused) return;
                    task = ctx.task; // 同步深度监控可能更新的 task.quantity

                    // 关键检查：任务可能已在其他地方被取消，不应再提交订单
                    const currentTask = this.taskService.getTask(task.id);
                    const terminalStatuses: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'HEDGE_FAILED', 'UNWIND_COMPLETED'];
                    if (!currentTask || terminalStatuses.includes(currentTask.status)) {
                        console.log(`[TaskExecutor] Task ${task.id} is in terminal state ${currentTask?.status}, skipping order re-submit`);
                        ctx.priceGuardAbort?.abort();
                        return;
                    }

                    // 统一 REST 门禁：替代原有双重 isPredictPriceSafeForMaker 检查
                    const gen = priceGuardGeneration;
                    const gateSignal = AbortSignal.any([
                        ctx.priceGuardAbort!.signal,
                        signal,
                    ]);
                    const gate = await this.waitForFreshBookAndSafePrice({
                        task, side, signal: gateSignal, tag: 'price-recovery',
                        maxWaitMs: 4 * 60 * 60 * 1000, // 4 小时超时
                    });
                    if (!gate.ok || gen !== priceGuardGeneration) {
                        // 超时：价格长时间未恢复，FAIL 任务
                        if (gate.reason === 'timeout') {
                            console.error(`[TaskExecutor] Price recovery gate timeout (${gate.waitedMs}ms), failing task ${task.id}`);
                            ctx.priceGuardAbort?.abort();
                            this.updateTask(task.id, {
                                status: 'FAILED',
                                error: `Price never recovered after ${Math.round(gate.waitedMs / 60000)}min`,
                            });
                            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                                status: 'FAILED',
                                previousStatus: 'PAUSED',
                                reason: `RESUME_GATE price-recovery timeout after ${gate.attempts} attempts / ${Math.round(gate.waitedMs / 60000)}min`,
                            });
                        }
                        return;
                    }

                    // 防重: 深度监控可能在 async 间隙已恢复并提交了订单
                    if (!ctx.isPaused || ctx.currentOrderHash) {
                        console.log(`[TaskExecutor] Price guard resume skipped: already resumed by another path (isPaused=${ctx.isPaused}, hash=${!!ctx.currentOrderHash})`);
                        return;
                    }

                    // 互斥: 防止 onPriceValid 与 checkDepth 并发提交
                    if (ctx.isSubmitting) {
                        console.log(`[TaskExecutor] Price guard resume skipped: another path is submitting`);
                        return;
                    }
                    ctx.isSubmitting = true;

                    const priceType = side === 'BUY' ? 'ask' : 'bid';
                    console.log(`[TaskExecutor] Price valid again: poly ${priceType}=${currentPrice.toFixed(4)}`);

                    try {

                    // Bug C 修复: 价格恢复后、重下 Predict 单之前，若有历史悬空，先 force hedge 兜底
                    await this.forceHedgeResidual(ctx, side, 'price_resume');

                    // 计算剩余量 (原始数量 - 已成交量)
                    const remainingQty = task.quantity - ctx.totalPredictFilled;
                    if (remainingQty <= 0) {
                        console.log(`[TaskExecutor] No remaining quantity, skipping re-submit`);
                        return;
                    }

                    // 检查对冲深度是否足够，避免下单后被深度监控立即暂停
                    const hedgeDepthForResume = await this.getHedgeDepth(hedgeTokenId, side, maxPrice, minPrice, task.isSportsMarket);
                    if (hedgeDepthForResume < 0) {
                        console.log(`[TaskExecutor] Price guard resume: hedge depth API failed, staying paused`);
                        return; // API 失败时保持暂停，等待下一次检查
                    }
                    if (hedgeDepthForResume < remainingQty) {
                        console.log(`[TaskExecutor] Price guard resume: hedge depth insufficient (${hedgeDepthForResume.toFixed(2)} < ${remainingQty}), staying paused`);
                        return; // ctx.isPaused 保持 true，等待深度恢复
                    }

                    const threshold = side === 'BUY' ? maxPrice : minPrice;

                    // 记录价格守护恢复
                    await this.taskLogger.logPriceGuard(task.id, 'PRICE_GUARD_RESUMED', {
                        polymarketTokenId: hedgeTokenId,
                        triggerPrice: currentPrice,
                        thresholdPrice: threshold,
                        predictPrice: task.predictPrice,
                        arbValid: true,
                        pauseCount: task.pauseCount,
                    });

                    // REST 门禁已通过，解除暂停
                    ctx.isPaused = false;
                    ctx.depthPausedChecks = 0;
                    ctx.pausedSince = undefined;
                    ctx.collateralBackoffUntil = undefined;

                    // 重新提交 Predict 订单 (使用剩余量)
                    const taskWithRemaining = { ...task, quantity: remainingQty };
                    const result = await this.submitPredictOrder(taskWithRemaining, side);
                    if (result.success) {
                        // submitPredictOrder 期间可能触发了价格保护，立即撤单避免无保护暴露
                        if (ctx.isPaused) {
                            console.log(`[TaskExecutor] Price guard resume: order submitted but task paused during submit, cancelling`);
                            try {
                                await this.predictTrader.cancelOrder(result.hash!);
                                ctx.cancelBscWatcher?.();
                            } catch (e) {
                                console.warn(`[TaskExecutor] Failed to cancel order after pause: ${e}`);
                                // 撤单失败: 保留 hash 让主循环继续监控，不清除
                                ctx.currentOrderHash = result.hash;
                            }
                            return;
                        }

                        ctx.currentOrderHash = result.hash;

                        // 记录新订单提交
                        await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                            platform: 'predict',
                            orderId: result.hash!,
                            side: side,
                            price: task.predictPrice,
                            quantity: remainingQty,
                            filledQty: 0,
                            remainingQty: remainingQty,
                            avgPrice: 0,
                            adjustReason: '价格恢复: 重新挂单',
                        }, result.hash);

                        // 记录任务恢复
                        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_RESUMED', {
                            status: 'PREDICT_SUBMITTED',
                            previousStatus: 'PAUSED',
                        });

                        task = this.updateTask(task.id, {
                            status: 'PREDICT_SUBMITTED',
                            currentOrderHash: result.hash,
                            error: undefined, // 清除旧 error (如 "Hedge depth insufficient")
                        });
                        ctx.task = task;

                        // 重新监控订单 (不需要这里启动，主循环会处理)
                    } else {
                        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                            status: 'FAILED',
                            previousStatus: 'PAUSED',
                            error: new Error(result.error || 'Re-submit failed'),
                        });
                        task = this.updateTask(task.id, {
                            status: 'FAILED',
                            error: `Re-submit failed: ${result.error}`,
                        });
                        ctx.task = task;
                        ctx.priceGuardAbort?.abort();
                    }

                    } finally {
                        ctx.isSubmitting = false;
                    }
                },
                onDepthUnstable: async (flipCount) => {
                    if (signal.aborted || ctx.priceGuardAbort?.signal.aborted) return;
                    if (ctx.phantomDepthDetected) return; // 已触发过，避免重复

                    const terminalStatuses: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'HEDGE_FAILED', 'UNWIND_COMPLETED'];
                    const currentTask = this.taskService.getTask(task.id);
                    if (!currentTask || terminalStatuses.includes(currentTask.status)) return;

                    console.warn(`[TaskExecutor] 🛑 幽灵深度 (WebSocket): 对冲价位深度 30s 内翻转 ${flipCount} 次`);
                    ctx.phantomDepthDetected = true;
                    ctx.isPaused = true;

                    // 取消 Predict 订单，防止继续成交
                    let cancelSuccess = false;
                    if (ctx.currentOrderHash) {
                        try {
                            const cancelResult = await this.predictTrader.cancelOrder(ctx.currentOrderHash);
                            cancelSuccess = cancelResult.success;
                            if (cancelSuccess) {
                                await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                                    platform: 'predict',
                                    orderId: ctx.currentOrderHash,
                                    side: side,
                                    price: task.predictPrice,
                                    quantity: task.quantity,
                                    filledQty: ctx.totalPredictFilled,
                                    remainingQty: task.quantity - ctx.totalPredictFilled,
                                    avgPrice: task.predictPrice,
                                }, ctx.currentOrderHash);
                            }
                        } catch (e: any) {
                            console.warn(`[TaskExecutor] ⚠️ 取消 Predict 订单出错: ${e.message}`);
                        }
                        ctx.predictWatchAbort?.abort();
                        ctx.predictWatchAbort = new AbortController();
                        if (cancelSuccess) {
                            ctx.currentOrderHash = undefined;
                        }
                        // 取消失败时保留 hash，让恢复路径可以重试取消
                    }

                    const phantomReason = `幽灵深度: 对冲价位深度 30s 内翻转 ${flipCount} 次，疑似机器人高频挂撤`;

                    // 记录 TASK_PAUSED 生命周期 (触发 SSE taskEvent → 前端 toast)
                    await this.taskLogger.logTaskLifecycle(task.id, 'TASK_PAUSED', {
                        status: 'PAUSED',
                        previousStatus: task.status,
                        reason: phantomReason,
                    });

                    task = this.updateTask(task.id, {
                        status: 'PAUSED',
                        pauseCount: task.pauseCount + 1,
                        ...(cancelSuccess ? { currentOrderHash: undefined } : {}),
                        error: phantomReason,
                    });
                    ctx.task = task;
                },
            }
        ).catch(err => {
            console.error('[TaskExecutor] Price guard error:', err);
        });

        // 启动深度监控（确保 Polymarket 有足够深度对冲）
        this.startDepthMonitor(ctx, side, hedgeTokenId, maxPrice, minPrice);

        // 体育市场: 注册 token 让 SportsService 在 WS 断线时通过 REST 兜底刷新缓存
        if (task.isSportsMarket) {
            try { getSportsService()?.addActiveTaskToken(hedgeTokenId); } catch { /* 忽略 */ }
        }

        // 主监控循环
        try {
            await this.monitorAndHedge(ctx, side);
        } finally {
            // 清理价格守护
            this.orderMonitor.stopPriceGuard(task.id);
            // 注销活跃 token
            if (task.isSportsMarket) {
                try { getSportsService()?.removeActiveTaskToken(hedgeTokenId); } catch { /* 忽略 */ }
            }
        }
    }

    /**
     * 监控订单并执行增量对冲
     * WSS-first 架构：优先使用 BSC WebSocket 检测成交，REST 作为兜底
     */
    private async monitorAndHedge(ctx: TaskContext, side: 'BUY' | 'SELL'): Promise<void> {
        const { signal } = ctx;
        let task = ctx.task;
        const startTime = Date.now();

        // ========================================================================
        // BSC WSS 成交事件处理 (WSS-first 架构)
        // ========================================================================
        let bscWssWatcher: BscOrderWatcher | null = null;
        // 使用 ref 对象存储 cancel 函数，避免 TypeScript 闭包类型推断问题
        const wssWatcherRef = { cancel: null as (() => void) | null };
        // Pending 订阅 unsub 引用，与 BSC WSS 同级，共享 cancelWatcherIfAny 清理
        const pendingUnsubRef = { unsub: null as (() => void) | null };
        let wssEventResolve: (() => void) | null = null;
        let wssEventPromise: Promise<void> | null = null;
        let wssEventPending = false;
        let monitorWakeResolve: (() => void) | null = null;
        let monitorWakePromise!: Promise<void>;

        const resetWssSignal = () => {
            wssEventPromise = new Promise<void>((resolve) => {
                wssEventResolve = resolve;
            });
        };
        resetWssSignal();

        const resetMonitorWakeSignal = () => {
            monitorWakePromise = new Promise<void>((resolve) => {
                monitorWakeResolve = resolve;
            });
        };
        const wakeMonitor = () => {
            const resolve = monitorWakeResolve;
            if (!resolve) return;
            resolve();
            resetMonitorWakeSignal();
        };
        resetMonitorWakeSignal();
        ctx.wakeMonitor = wakeMonitor;

        // ========================================================================
        // Predict WS 终态事件处理 (ORDER_CANCELLED / ORDER_EXPIRED)
        // ========================================================================
        const terminatedRef = { event: null as OrderTerminatedEvent | null };
        let terminatedResolve: (() => void) | null = null;
        let terminatedPromise: Promise<void> = new Promise(r => { terminatedResolve = r; });

        const predictWatcher = getPredictOrderWatcher();
        const onTerminated = (event: OrderTerminatedEvent) => {
            const eventHash = event.orderHash?.toLowerCase();
            const currentHash = ctx.currentOrderHash?.toLowerCase();
            if (!currentHash || eventHash !== currentHash) return;
            terminatedRef.event = event;
            terminatedResolve?.();
        };
        predictWatcher.on('orderTerminated', onTerminated);

        const resetTerminatedSignal = () => {
            terminatedRef.event = null;
            terminatedPromise = new Promise(r => { terminatedResolve = r; });
        };

        // WS 降级 REST 轮询状态
        let wsSubscriptionActive = predictWatcher.isSubscriptionValid();
        let restFallbackActive = !wsSubscriptionActive;
        const onSubLost = () => { wsSubscriptionActive = false; restFallbackActive = true; };
        const onSubRestored = () => { wsSubscriptionActive = true; restFallbackActive = false; };
        predictWatcher.on('subscriptionLost', onSubLost);
        predictWatcher.on('subscriptionRestored', onSubRestored);

        // ========================================================================
        // Predict WS 成交事件处理 (BSC WSS 兜底)
        // ========================================================================
        const predictWsFillRef = { cancel: null as (() => void) | null };

        /**
         * 注册 Predict WS fill watcher
         * 作为 BSC WSS 的兜底，独立累计 predictWsFilledQty
         */
        const registerPredictWsFillWatcher = (orderHash: string) => {
            // 取消旧 watcher
            if (predictWsFillRef.cancel) {
                predictWsFillRef.cancel();
                predictWsFillRef.cancel = null;
            }

            try {
                if (predictWatcher.isConnected()) {
                    predictWsFillRef.cancel = predictWatcher.watchOrder(
                        orderHash,
                        (event: PredictWsFilledEvent) => {
                            const fillDelta = getPredictWsFillShares(event);
                            if (fillDelta <= 0) return;
                            ctx.predictWsFilledQty += fillDelta;
                            this.markHedgeFillSignal(ctx, 'predict_ws');

                            // 唤醒主循环
                            if (wssEventResolve) {
                                wssEventPending = true;
                                wssEventResolve();
                                resetWssSignal();
                            }

                            // Phase 2E: 直接从 fill callback 触发对冲，不等主循环
                            if (!ctx.hedgeKickScheduled && !ctx.inflightHedge && !ctx.isHedgingInProgress) {
                                ctx.hedgeKickScheduled = true;
                                queueMicrotask(() => {
                                    ctx.hedgeKickScheduled = false;
                                    mergeFilledQty();  // 先 merge，确保 totalPredictFilled 反映最新 fill
                                    const check = this.checkShouldHedge(ctx, 0, false);
                                    if (check.shouldHedge) {
                                        void this.submitFastHedgeIOC(ctx, side).catch(e =>
                                            console.error(`[TaskExecutor] microtask hedge error:`, (e as Error).message)
                                        );
                                    }
                                });
                            }
                        },
                        0,  // 不超时，PREDICT_MAKER 订单可存活任意时长
                    );
                    console.log(`[TaskExecutor] Task ${task.id}: Predict WS fill watcher registered for ${orderHash.slice(0, 10)}...`);
                }
            } catch {
                console.log(`[TaskExecutor] Task ${task.id}: Predict WS fill watcher not available`);
            }
        };

        const cancelPredictWsFillWatcher = () => {
            if (predictWsFillRef.cancel) {
                predictWsFillRef.cancel();
                predictWsFillRef.cancel = null;
            }
        };

        // 延迟成交回调：唤醒主循环，让 mergeFilledQty 捕获 delayedFillQty 增量
        ctx.onDelayedFill = () => {
            if (wssEventResolve) {
                wssEventPending = true;
                wssEventResolve();
                resetWssSignal();
            }
        };

        // 当前正在监听的订单 hash（用于检测 hash 变更）
        let watchedOrderHash: string | null = null;
        // 基准偏移初始化：
        // - 正常场景（新订单）: base = 已成交总量，rest/wss 从 0 开始累加
        // - 恢复场景（已有 currentOrderHash 且已有成交）:
        //   Predict API filledQty 是“订单累计成交”，不能再叠加 base，否则会双计数
        const isResumingLiveOrderWithHistory = Boolean(ctx.currentOrderHash && ctx.totalPredictFilled > 0);
        if (!isResumingLiveOrderWithHistory) {
            ctx.baseFilledBeforeOrder = ctx.totalPredictFilled;
        }
        // REST 连续失败计数（防止无限静默重试）
        let restConsecutiveFailures = 0;
        const REST_MAX_CONSECUTIVE_FAILURES = 20; // 连续 20 次 (~10s) 后告警

        /**
         * 合并 WSS/PredictWS/REST 成交量，更新 totalPredictFilled
         * 规则: total = ctx.baseFilledBeforeOrder + max(wssFilledQty, predictWsFilledQty, restFilledQty)
         * 三源取最大值，确保任一通道检测到的成交都不会被漏计
         */
        const mergeFilledQty = (): boolean => {
            const grossMerged = ctx.baseFilledBeforeOrder + Math.max(ctx.wssFilledQty, ctx.predictWsFilledQty, ctx.restFilledQty) + ctx.delayedFillQty;
            // 从 gross 中扣除当前订单的净 fee，得到实际到手量
            const netMerged = Math.max(0, grossMerged - ctx.currentOrderFeeShares);
            // 用 totalQuantity (原始不可变目标量) 作为上限，而非 task.quantity (深度动态调整值)
            // 防止深度缩减后 clamp 截断已确认的成交量
            const clamped = Math.min(netMerged, task.totalQuantity);
            const prev = ctx.totalPredictFilled;
            if (clamped !== prev) {
                ctx.totalPredictFilled = clamped;
                return clamped > prev;  // 仅增量时触发对冲
            }
            return false;
        };
        // 暴露到 ctx，供 startDepthMonitor / onPriceValid 在 force-hedge 前同步最新成交量
        ctx.mergeFilledQty = mergeFilledQty;

        /**
         * 取消当前 watcher（如果有）
         */
        const cancelWatcherIfAny = () => {
            if (wssWatcherRef.cancel) {
                wssWatcherRef.cancel();
                wssWatcherRef.cancel = null;
                console.log(`[TaskExecutor] Task ${task.id}: WSS watcher cancelled`);
            }
            if (pendingUnsubRef.unsub) {
                try { pendingUnsubRef.unsub(); } catch { /* ignore */ }
                pendingUnsubRef.unsub = null;
            }
        };
        // 暴露到 ctx，供 runWithPriceGuard/startDepthMonitor 在订单取消前调用
        ctx.cancelBscWatcher = cancelWatcherIfAny;

        /**
         * 重置为新订单状态
         * 设置基准偏移，清空 WSS/REST 状态，重新注册 watcher
         */
        const resetForNewOrder = (orderHash: string) => {
            // 切换订单前先合并一次，避免已到达的 WSS/REST 增量被清空
            const preBase = ctx.baseFilledBeforeOrder;
            const preWss = ctx.wssFilledQty;
            const preRest = ctx.restFilledQty;
            mergeFilledQty();
            console.log(`[TaskExecutor] Task ${task.id}: resetForNewOrder merge (prevBase=${preBase.toFixed(2)}, wss=${preWss.toFixed(2)}, rest=${preRest.toFixed(2)}) -> total=${ctx.totalPredictFilled.toFixed(2)}`);

            // 设置基准偏移：当前已累计的成交量
            ctx.baseFilledBeforeOrder = ctx.totalPredictFilled;

            // 先取消旧 watcher，避免迟到事件污染
            cancelWatcherIfAny();

            // 清除旧订单的 terminated 事件，避免旧 CANCELLED/EXPIRED 事件污染新订单
            resetTerminatedSignal();

            // 清空 WSS/REST/PredictWS 状态（新订单从 0 开始累计）
            ctx.wssFilledQty = 0;
            ctx.predictWsFilledQty = 0;
            ctx.restFilledQty = 0;
            ctx.delayedFillQty = 0;
            ctx.currentOrderFeeShares = 0;  // 新订单 fee 从 0 开始
            ctx.wssFillEvents.clear();
            ctx.wssFirstFillTime = undefined;
            this.clearHedgeFillSignal(ctx);

            watchedOrderHash = orderHash;

            // 注册 Predict WS fill watcher (BSC WSS 兜底)
            registerPredictWsFillWatcher(orderHash);

            // 注册新 BSC WSS watcher
            try {
                bscWssWatcher = getBscOrderWatcher();
                if (bscWssWatcher.isConnected()) {
                    wssWatcherRef.cancel = bscWssWatcher.watchOrder(
                        orderHash,
                        (event: OrderFilledEvent) => {
                            // 1. 去重: 使用 txHash:logIndex 作为唯一键
                            const dedupKey = `${event.txHash}:${event.logIndex}`;
                            if (ctx.wssFillEvents.has(dedupKey)) return;
                            ctx.wssFillEvents.add(dedupKey);

                            // 2. 累加增量（使用统一工具函数）
                            const fillDelta = getSharesFromFillEvent(event);
                            ctx.wssFilledQty += fillDelta;

                            // 2.5 检测 taker fee（fee 单位是 shares, 非 USDT）
                            // negRisk 产生 2 个 OrderFilled 事件，内部结算事件的 taker 是 Exchange 合约。
                            // 规律：用户 orderHash 出现在内部结算事件 = 用户实际是 taker；
                            //       出现在真实事件（对手方非 Exchange）= 用 event.taker 判断。
                            if (event.fee > 0) {
                                const myAddr = (process.env.PREDICT_SMART_WALLET_ADDRESS || '').toLowerCase();
                                const counterparty = event.maker.toLowerCase() === myAddr
                                    ? event.taker.toLowerCase()
                                    : event.maker.toLowerCase();
                                // 内部结算（对手方是 Exchange）→ 用户实际是 taker，fee 适用
                                // 真实事件且 event.taker === me → 用户是 taker，fee 适用
                                const isInternalSettlement = PREDICT_EXCHANGE_ADDRESSES.has(counterparty);
                                const userIsTaker = isInternalSettlement || event.taker.toLowerCase() === myAddr;
                                if (userIsTaker) {
                                    const FEE_REBATE = 0.10;
                                    const netFee = event.fee * (1 - FEE_REBATE);
                                    ctx.currentOrderFeeShares += netFee;
                                    ctx.totalPredictFeeShares += netFee;
                                    console.log(`[TaskExecutor] Task ${task.id}: taker fee detected: gross=${event.fee.toFixed(4)}, net=${netFee.toFixed(4)} shares (settlement=${isInternalSettlement})`);
                                } else {
                                    console.log(`[TaskExecutor] Task ${task.id}: maker fill, fee=${event.fee.toFixed(4)} belongs to counterparty, not deducting`);
                                }
                            }

                            // 3. 记录 WSS 成交时间
                            this.markHedgeFillSignal(ctx, 'bsc_wss');
                            if (!ctx.wssFirstFillTime) {
                                ctx.wssFirstFillTime = event.timestamp;
                                console.log(`[TaskExecutor] Task ${task.id}: WSS first fill at ${ctx.wssFirstFillTime - startTime}ms, delta=${fillDelta.toFixed(4)}`);
                            }

                            // 4. 唤醒主循环
                            if (wssEventResolve) {
                                wssEventPending = true;
                                wssEventResolve();
                                resetWssSignal();
                            }

                            // Phase 2E: 直接从 fill callback 触发对冲，不等主循环
                            if (!ctx.hedgeKickScheduled && !ctx.inflightHedge && !ctx.isHedgingInProgress) {
                                ctx.hedgeKickScheduled = true;
                                queueMicrotask(() => {
                                    ctx.hedgeKickScheduled = false;
                                    mergeFilledQty();  // 先 merge，确保 totalPredictFilled 反映最新 fill
                                    const check = this.checkShouldHedge(ctx, 0, false);
                                    if (check.shouldHedge) {
                                        void this.submitFastHedgeIOC(ctx, side).catch(e =>
                                            console.error(`[TaskExecutor] microtask hedge error:`, (e as Error).message)
                                        );
                                    }
                                });
                            }
                        },
                        BSC_WATCHER_TIMEOUT
                    );
                    console.log(`[TaskExecutor] Task ${task.id}: WSS watcher registered for ${orderHash.slice(0, 10)}... (base=${ctx.baseFilledBeforeOrder.toFixed(2)})`);
                }
            } catch {
                console.log(`[TaskExecutor] Task ${task.id}: BSC WSS not available for ${orderHash.slice(0, 10)}...`);
            }

            // 重置 REST 连续失败计数，避免旧订单的失败计数影响新订单告警
            restConsecutiveFailures = 0;
        };

        // 初始注册（如果有订单）
        if (ctx.currentOrderHash) {
            // 重要：
            // 恢复已有订单且已有历史成交时，restFilledQty 需要保留“累计成交基线”，
            // 并将 base 置 0，避免 merged = base + rest 造成双计数。
            // 新订单场景仍按原逻辑：base=已有总成交，rest/wss 从 0 开始。
            if (isResumingLiveOrderWithHistory) {
                const baseline = Math.max(ctx.restFilledQty, ctx.totalPredictFilled);
                ctx.baseFilledBeforeOrder = 0;
                ctx.wssFilledQty = 0;
                ctx.predictWsFilledQty = 0;
                ctx.restFilledQty = baseline;
                console.log(
                    `[TaskExecutor] Task ${task.id}: resume existing order with historical fills, ` +
                    `baseline=${baseline.toFixed(4)}, base=0`,
                );
            } else {
                ctx.wssFilledQty = 0;
                ctx.predictWsFilledQty = 0;
                ctx.restFilledQty = 0;
            }
            watchedOrderHash = ctx.currentOrderHash;

            // 初始注册 Predict WS fill watcher (BSC WSS 兜底)
            registerPredictWsFillWatcher(ctx.currentOrderHash);

            try {
                bscWssWatcher = getBscOrderWatcher();
                if (bscWssWatcher.isConnected()) {
                    wssWatcherRef.cancel = bscWssWatcher.watchOrder(
                        ctx.currentOrderHash,
                        (event: OrderFilledEvent) => {
                            const dedupKey = `${event.txHash}:${event.logIndex}`;
                            if (ctx.wssFillEvents.has(dedupKey)) return;
                            ctx.wssFillEvents.add(dedupKey);
                            // 使用统一工具函数计算 shares 数量
                            const fillDelta = getSharesFromFillEvent(event);
                            // Pending FIFO 扣减：pending 池里的 shares 优先被 BSC fill 消耗，超额部分才累加到 wssFilledQty
                            const preDeductPool = ctx.pendingFillAccumulated;
                            const deductFromPool = Math.min(preDeductPool, fillDelta);
                            const excessFromBsc = fillDelta - deductFromPool;
                            const alreadyHandledByPending = deductFromPool > 0.001;
                            if (alreadyHandledByPending) {
                                ctx.pendingFillAccumulated = Math.max(0, preDeductPool - deductFromPool);
                                if (excessFromBsc > 0.001) {
                                    console.warn(`[TaskExecutor] Task ${task.id}: PENDING↔BSC drift oh=${event.orderHash.slice(0, 12)} pool=${preDeductPool.toFixed(4)} bsc=${fillDelta.toFixed(4)} excess=${excessFromBsc.toFixed(4)} (adding to wssFilledQty)`);
                                    ctx.wssFilledQty += excessFromBsc;
                                }
                            } else {
                                ctx.wssFilledQty += fillDelta;
                            }
                            // fee 检测（与 resetForNewOrder 路径保持一致）
                            if (event.fee > 0) {
                                const myAddr = (process.env.PREDICT_SMART_WALLET_ADDRESS || '').toLowerCase();
                                const counterparty = event.maker.toLowerCase() === myAddr
                                    ? event.taker.toLowerCase()
                                    : event.maker.toLowerCase();
                                const isInternalSettlement = PREDICT_EXCHANGE_ADDRESSES.has(counterparty);
                                const userIsTaker = isInternalSettlement || event.taker.toLowerCase() === myAddr;
                                if (userIsTaker) {
                                    const FEE_REBATE = 0.10;
                                    const netFee = event.fee * (1 - FEE_REBATE);
                                    ctx.currentOrderFeeShares += netFee;
                                    ctx.totalPredictFeeShares += netFee;
                                    console.log(`[TaskExecutor] Task ${task.id}: taker fee detected (recovery): gross=${event.fee.toFixed(4)}, net=${netFee.toFixed(4)} shares (settlement=${isInternalSettlement})`);
                                } else {
                                    console.log(`[TaskExecutor] Task ${task.id}: maker fill (recovery), fee=${event.fee.toFixed(4)} belongs to counterparty, not deducting`);
                                }
                            }
                            // 打点起点：pending 已设过则保留（不被 BSC 到达时间覆盖）
                            if (!alreadyHandledByPending) {
                                this.markHedgeFillSignal(ctx, 'bsc_wss');
                            }
                            if (!ctx.wssFirstFillTime) {
                                ctx.wssFirstFillTime = event.timestamp;
                                console.log(`[TaskExecutor] Task ${task.id}: WSS first fill, delta=${fillDelta.toFixed(4)}${alreadyHandledByPending ? ' (confirmed pending)' : ''}`);
                            }
                            if (wssEventResolve) {
                                wssEventPending = true;
                                wssEventResolve();
                                resetWssSignal();
                            }

                            // Phase 2E: 直接从 fill callback 触发对冲，不等主循环
                            // 若 pending 已触发，跳过（避免重复对冲）
                            if (!alreadyHandledByPending && !ctx.hedgeKickScheduled && !ctx.inflightHedge && !ctx.isHedgingInProgress) {
                                ctx.hedgeKickScheduled = true;
                                queueMicrotask(() => {
                                    ctx.hedgeKickScheduled = false;
                                    mergeFilledQty();  // 先 merge，确保 totalPredictFilled 反映最新 fill
                                    const check = this.checkShouldHedge(ctx, 0, false);
                                    if (check.shouldHedge) {
                                        void this.submitFastHedgeIOC(ctx, side).catch(e =>
                                            console.error(`[TaskExecutor] microtask hedge error:`, (e as Error).message)
                                        );
                                    }
                                });
                            }
                        },
                        BSC_WATCHER_TIMEOUT
                    );
                    console.log(`[TaskExecutor] Task ${task.id}: WSS watcher initialized (base=${ctx.baseFilledBeforeOrder.toFixed(2)})`);
                }
            } catch {
                console.log(`[TaskExecutor] Task ${task.id}: BSC WSS not available, REST-only mode`);
            }

            // ====================================================================
            // PENDING 事件订阅（mempool 预警，比 BSC 链上 fill 提前 ~300-600ms）
            //   PENDING_HEDGE_TRIGGER_ENABLED=true  → pending 作为触发源 + 打点起点
            //   PENDING_HEDGE_TRIGGER_ENABLED=false → pending 仅记录
            // ====================================================================
            try {
                const predictWatcher = getPredictOrderWatcher();
                const onPendingForTask = (event: WalletEventData) => {
                    if (event.type !== 'ORDER_TX_PENDING') return;
                    const eventOh = (event.orderHash || event.orderId || '').toLowerCase();
                    if (!eventOh || eventOh !== ctx.currentOrderHash?.toLowerCase()) return;

                    // 解码 pending shares（与 start-dashboard.ts 同款）
                    const raw = (event as unknown as { rawData?: Record<string, unknown> }).rawData;
                    const fillObj = raw?.fill as Record<string, unknown> | undefined;
                    const executedSizeWei = fillObj?.executedSizeWei;
                    if (!executedSizeWei) return;
                    let pendingShares = 0;
                    try {
                        pendingShares = Number(BigInt(String(executedSizeWei)) / 10n ** 12n) / 1e6;
                    } catch { return; }
                    if (pendingShares <= 0) return;

                    if (!PENDING_HEDGE_TRIGGER_ENABLED) {
                        console.log(`[TaskExecutor] Task ${task.id}: PENDING event (trigger=OFF) shares=${pendingShares.toFixed(4)}`);
                        return;
                    }

                    // 作为 fill 触发源：累加到 pending 池 + 打点起点 + 触发 hedge
                    // 注意：Predict WS 的 pending 事件目前没有 txHash，用 FIFO 累计池做去重
                    ctx.pendingFillAccumulated += pendingShares;
                    ctx.wssFilledQty += pendingShares;
                    this.markHedgeFillSignal(ctx, 'pending');
                    if (!ctx.wssFirstFillTime) ctx.wssFirstFillTime = Date.now();

                    console.log(`[TaskExecutor] Task ${task.id}: PENDING-triggered fill delta=${pendingShares.toFixed(4)} (pool=${ctx.pendingFillAccumulated.toFixed(4)})`);

                    if (wssEventResolve) {
                        wssEventPending = true;
                        wssEventResolve();
                        resetWssSignal();
                    }

                    if (!ctx.hedgeKickScheduled && !ctx.inflightHedge && !ctx.isHedgingInProgress) {
                        ctx.hedgeKickScheduled = true;
                        queueMicrotask(() => {
                            ctx.hedgeKickScheduled = false;
                            mergeFilledQty();
                            const check = this.checkShouldHedge(ctx, 0, false);
                            if (check.shouldHedge) {
                                void this.submitFastHedgeIOC(ctx, side).catch(e =>
                                    console.error(`[TaskExecutor] pending-trigger hedge error:`, (e as Error).message)
                                );
                            }
                        });
                    }
                };
                predictWatcher.on('walletEvent', onPendingForTask);
                pendingUnsubRef.unsub = () => {
                    try { predictWatcher.off('walletEvent', onPendingForTask); } catch { /* ignore */ }
                };
                console.log(`[TaskExecutor] Task ${task.id}: pending subscription active (trigger=${PENDING_HEDGE_TRIGGER_ENABLED ? 'ON' : 'OFF'})`);
            } catch (e) {
                console.warn(`[TaskExecutor] Task ${task.id}: pending subscription init failed: ${(e as Error).message}`);
            }
        }

        try {
            while (!signal.aborted && !ctx.priceGuardAbort?.signal.aborted) {
                // 同步局部 task 变量，防止深度监控/价格守护更新 ctx.task 后主循环使用过期值
                // (尤其是 task.quantity 被深度扩增修改后，mergeFilledQty 的 clamp 上限必须同步)
                task = ctx.task;

                // UNKNOWN inflight 自动重试 reconcile（异常后由主循环驱动自愈）
                if (
                    ctx.inflightHedge?.status === 'UNKNOWN' &&
                    !ctx.inflightHedge.reconcileInProgress &&
                    !ctx.signal.aborted &&
                    (ctx.fastHedgeCooldownUntil ?? 0) <= Date.now()
                ) {
                    void this.reconcileInflightHedge(ctx, side).catch(e =>
                        console.error(`[TaskExecutor] retry reconcile error:`, (e as Error).message)
                    );
                }

                // 如果暂停中，等待恢复（WSS 事件 或 终态事件可打断）
                if (ctx.isPaused) {
                    await Promise.race([this.delay(500), wssEventPromise, terminatedPromise, monitorWakePromise]);
                    if (!wssEventPending) {
                        // 取消失败时订单仍然活跃，继续 REST 轮询以检测成交
                        // 否则 BSC watcher 超时后成交将永远不会被检测到
                        if (!ctx.currentOrderHash) {
                            continue;
                        }
                        // fall through: 对活跃订单执行 REST 轮询
                    } else {
                        wssEventPending = false;
                    }
                }

                // 如果没有订单，取消 watcher 并等待重新提交
                if (!ctx.currentOrderHash) {
                    // hash 变为 null 时，先合并已到达的增量，避免丢失成交
                    if (watchedOrderHash !== null) {
                        const previousPredictFilled = ctx.totalPredictFilled;
                        mergeFilledQty();
                        const newlyObservedFilled = ctx.totalPredictFilled - previousPredictFilled;

                        if (newlyObservedFilled > 0) {
                            const effectiveAvgPrice = task.predictPrice;
                            const orderEventType = ctx.totalPredictFilled >= task.quantity ? 'ORDER_FILLED' : 'ORDER_PARTIAL_FILL';

                            // fire-and-forget: 不阻塞成交→对冲关键路径
                            this.taskLogger.logOrderEvent(task.id, orderEventType, {
                                platform: 'predict',
                                orderId: watchedOrderHash,
                                side: side,
                                price: task.predictPrice,
                                quantity: task.quantity,
                                filledQty: ctx.totalPredictFilled,
                                remainingQty: task.quantity - ctx.totalPredictFilled,
                                avgPrice: effectiveAvgPrice,
                            }, watchedOrderHash).catch(e => console.warn(`[TaskExecutor] logOrderEvent error:`, e?.message));

                            this.captureSnapshot(task.id, 'order_fill', task).catch(e => console.warn(`[TaskExecutor] captureSnapshot error:`, e?.message));

                            task = this.updateTask(task.id, {
                                status: orderEventType === 'ORDER_FILLED' ? 'HEDGING' : 'PARTIALLY_FILLED',
                                predictFilledQty: ctx.totalPredictFilled,
                                avgPredictPrice: effectiveAvgPrice,
                            });
                            ctx.task = task;

                            // 后台刷新，不阻塞对冲路径
                            this.refreshTrackedPolyFills(ctx).catch(err => {
                                console.warn(`[TaskExecutor] refreshTrackedPolyFills error:`, err.message);
                            });

                            // 检查是否应该触发对冲 (考虑 $1 名义金额阈值)
                            const isPredictFullyFilled = orderEventType === 'ORDER_FILLED';
                            const hedgeCheck = this.checkShouldHedge(ctx, newlyObservedFilled, isPredictFullyFilled);

                            if (hedgeCheck.shouldHedge) {
                                await this.submitFastHedgeIOC(ctx, side);
                                // reconcile 在后台运行，不阻塞
                                // task 状态由 reconcile 更新
                            }
                        } else if (ctx.totalPredictFilled > (task.predictFilledQty || 0) + 1e-9) {
                            console.log(
                                `[TaskExecutor] Persisting pending-triggered Predict fill before hash reset: ` +
                                `${(task.predictFilledQty || 0).toFixed(4)} → ${ctx.totalPredictFilled.toFixed(4)}`,
                            );
                            task = this.updateTask(task.id, {
                                predictFilledQty: ctx.totalPredictFilled,
                                avgPredictPrice: task.predictPrice,
                            });
                            ctx.task = task;
                        }

                        // 更新基准偏移并清零增量，避免下次 mergeFilledQty 双重计数
                        console.log(`[TaskExecutor] Task ${task.id}: Order hash -> null, reset increments (base=${ctx.baseFilledBeforeOrder.toFixed(2)}, wss=${ctx.wssFilledQty.toFixed(2)}, rest=${ctx.restFilledQty.toFixed(2)}, delayed=${ctx.delayedFillQty.toFixed(2)}, total=${ctx.totalPredictFilled.toFixed(2)})`);
                        ctx.baseFilledBeforeOrder = ctx.totalPredictFilled;
                        ctx.wssFilledQty = 0;
                        ctx.predictWsFilledQty = 0;
                        ctx.restFilledQty = 0;
                        ctx.delayedFillQty = 0;
                        ctx.wssFillEvents.clear();
                        ctx.wssFirstFillTime = undefined;
                        this.clearHedgeFillSignal(ctx);
                        // 始终取消 per-order watcher，防止与全局 fill listener 对同一事件双重路由
                        cancelWatcherIfAny();
                        cancelPredictWsFillWatcher();
                        if (!ctx.isPaused) {
                            watchedOrderHash = null;
                        }
                    }
                    await Promise.race([this.delay(500), wssEventPromise, terminatedPromise, monitorWakePromise]);
                    continue;
                }

                // 检测订单 hash 变化，重置为新订单状态
                if (ctx.currentOrderHash !== watchedOrderHash) {
                    console.log(`[TaskExecutor] Task ${task.id}: Order hash changed from ${watchedOrderHash?.slice(0, 10) || 'null'} to ${ctx.currentOrderHash.slice(0, 10)}`);
                    resetForNewOrder(ctx.currentOrderHash);
                }

                // 确定订单状态（WS 事件驱动 / REST 降级）
                let status: { status: string; filledQty: number; avgPrice: number; cancelReason?: string; rawResponse?: Record<string, unknown> };
                const capturedTerminated = terminatedRef.event;

                if (restFallbackActive) {
                    // Predict WS 断连降级: REST 轮询
                    const restStatus = await this.predictTrader.getOrderStatus(ctx.currentOrderHash);
                    if (!restStatus) {
                        restConsecutiveFailures++;
                        if (restConsecutiveFailures === REST_MAX_CONSECUTIVE_FAILURES) {
                            console.error(`[TaskExecutor] ⚠️ Task ${task.id}: REST getOrderStatus 连续 ${restConsecutiveFailures} 次失败，API 可能异常`);
                        } else if (restConsecutiveFailures > 0 && restConsecutiveFailures % 60 === 0) {
                            console.error(`[TaskExecutor] ⚠️ Task ${task.id}: REST getOrderStatus 持续失败 (${restConsecutiveFailures} 次)`);
                        }
                        await Promise.race([this.delay(REST_FALLBACK_INTERVAL), wssEventPromise, terminatedPromise, monitorWakePromise]);
                        continue;
                    }
                    restConsecutiveFailures = 0;
                    status = restStatus;
                } else if (capturedTerminated) {
                    // Predict WS 终态事件 (CANCELLED / EXPIRED)
                    console.log(`[TaskExecutor] Task ${task.id}: Order ${capturedTerminated.type} via Predict WS. Reason: ${capturedTerminated.reason || 'none'}`);
                    status = {
                        status: capturedTerminated.type,
                        filledQty: ctx.totalPredictFilled,
                        avgPrice: task.predictPrice,
                        cancelReason: capturedTerminated.reason,
                        rawResponse: capturedTerminated.rawEvent?.rawData as Record<string, unknown> | undefined,
                    };
                    resetTerminatedSignal();
                } else {
                    // WS 正常模式: 从 BSC WSS 成交量推导订单状态
                    const isFullyFilled = ctx.totalPredictFilled >= task.quantity - 0.5;
                    status = {
                        status: isFullyFilled ? 'FILLED' : 'OPEN',
                        filledQty: ctx.totalPredictFilled,
                        avgPrice: task.predictPrice,
                    };
                }

                // 合并 WSS 和 REST 成交量
                const previousPredictFilled = ctx.totalPredictFilled;
                mergeFilledQty();
                const effectivePredictFilled = ctx.totalPredictFilled;
                const newlyObservedFilled = effectivePredictFilled - previousPredictFilled;

                // avgPrice uses order price
                const effectiveAvgPrice = task.predictPrice;
                const persistedPredictFilled = task.predictFilledQty || 0;
                const shouldPersistPredictFill = effectivePredictFilled > persistedPredictFilled + 1e-9;

                if (newlyObservedFilled > 0) {
                    if (!ctx.lastFillRecvTs) {
                        this.markHedgeFillSignal(ctx, 'rest_poll');
                    }
                    const tFillDetected = Date.now();
                    const source = ctx.wssFirstFillTime ? 'WSS' : 'REST';
                    const wssToLoopMs = ctx.lastFillRecvTs ? tFillDetected - ctx.lastFillRecvTs : undefined;
                    console.log(
                        `[TaskExecutor] Predict filled (${source}): +${newlyObservedFilled.toFixed(4)} ` +
                        `(total: ${effectivePredictFilled.toFixed(4)}, avgPrice: ${effectiveAvgPrice.toFixed(4)})` +
                        (wssToLoopMs !== undefined ? ` [wssToLoop=${wssToLoopMs}ms]` : ''),
                    );

                    // 记录成交事件 (fire-and-forget: 不阻塞成交→对冲关键路径)
                    const orderEventType = status.status === 'FILLED' ? 'ORDER_FILLED' : 'ORDER_PARTIAL_FILL';
                    this.taskLogger.logOrderEvent(task.id, orderEventType, {
                        platform: 'predict',
                        orderId: ctx.currentOrderHash!,
                        side: side,
                        price: task.predictPrice,
                        quantity: task.quantity,
                        filledQty: effectivePredictFilled,
                        remainingQty: task.quantity - effectivePredictFilled,
                        avgPrice: effectiveAvgPrice,
                    }, ctx.currentOrderHash).catch(e => console.warn(`[TaskExecutor] logOrderEvent error:`, e?.message));

                    // 捕获订单簿快照 (fire-and-forget)
                    this.captureSnapshot(task.id, 'order_fill', task).catch(e => console.warn(`[TaskExecutor] captureSnapshot error:`, e?.message));

                    task = this.updateTask(task.id, {
                        status: status.status === 'FILLED' ? 'HEDGING' : 'PARTIALLY_FILLED',
                        predictFilledQty: effectivePredictFilled,
                        avgPredictPrice: effectiveAvgPrice,
                    });
                    ctx.task = task;
                }

                if (newlyObservedFilled <= 0 && shouldPersistPredictFill) {
                    console.log(
                        `[TaskExecutor] Persisting pending-triggered Predict fill: ` +
                        `${persistedPredictFilled.toFixed(4)} → ${effectivePredictFilled.toFixed(4)}`,
                    );
                    task = this.updateTask(task.id, {
                        status: status.status === 'FILLED' ? 'HEDGING' : task.status,
                        predictFilledQty: effectivePredictFilled,
                        avgPredictPrice: effectiveAvgPrice,
                    });
                    ctx.task = task;
                }

                const shouldCheckHedge = (newlyObservedFilled > 0) || status.status === 'FILLED';
                if (shouldCheckHedge) {
                    // 后台刷新，不阻塞对冲路径
                    this.refreshTrackedPolyFills(ctx).catch(err => {
                        console.warn(`[TaskExecutor] refreshTrackedPolyFills error:`, err.message);
                    });

                    // 检查是否应该触发对冲 (考虑 $1 名义金额阈值)
                    const isPredictFullyFilled = status.status === 'FILLED';
                    const hedgeCheck = this.checkShouldHedge(ctx, newlyObservedFilled, isPredictFullyFilled);

                    // 若 Predict 已完全成交但存在未对冲余量，也需要补齐对冲（否则会卡在 FILLED 状态无法自愈）
                    if (hedgeCheck.shouldHedge) {
                        await this.submitFastHedgeIOC(ctx, side);
                        // reconcile 在后台运行，不阻塞
                        // task 状态由 reconcile 更新
                    }
                }

                // 检查是否完成
                // 考虑跳过的小额对冲：如果未对冲量 < MIN_HEDGE_QTY，视为完成
                const unhedgedQty = ctx.totalPredictFilled - ctx.totalHedged;
                const isHedgeComplete = ctx.totalHedged >= ctx.totalPredictFilled || unhedgedQty < MIN_HEDGE_QTY;
                if (status.status === 'FILLED' && isHedgeComplete && !this.hasPendingFastHedge(ctx)) {
                    // 计算实际利润
                    const profit = this.calculateProfit(task, ctx);
                    const profitPercent = task.predictPrice > 0 && ctx.totalPredictFilled > 0
                        ? (profit / (task.predictPrice * ctx.totalPredictFilled)) * 100
                        : 0;
                    const completionHedgeSlippage = this.getCompletionHedgeSlippage(task, ctx);

                    // 记录任务完成
                    await this.taskLogger.logTaskLifecycle(task.id, 'TASK_COMPLETED', {
                        status: 'COMPLETED',
                        previousStatus: task.status,
                        profit,
                        profitPercent,
                        duration: Date.now() - task.createdAt,
                        ...completionHedgeSlippage,
                    });

                    task = this.updateTask(task.id, {
                        status: 'COMPLETED',
                        actualProfit: profit,
                        completedAt: Date.now(),
                        predictFilledQty: ctx.totalPredictFilled,
                        hedgedQty: ctx.totalHedged,
                        avgPredictPrice: task.predictPrice,
                        avgPolymarketPrice: ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0,
                        remainingQty: ctx.totalPredictFilled - ctx.totalHedged,
                    });

                    // 生成任务汇总
                    await this.taskLogger.generateSummary(task.id, {
                        type: task.type,
                        marketId: task.marketId,
                        title: task.title,
                        status: 'COMPLETED',
                        predictFilledQty: ctx.totalPredictFilled,
                        hedgedQty: ctx.totalHedged,
                        avgPredictPrice: task.predictPrice,
                        avgPolymarketPrice: ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0,
                        actualProfit: profit,
                        unwindLoss: 0,
                        pauseCount: task.pauseCount,
                        hedgeRetryCount: task.hedgeRetryCount,
                        createdAt: task.createdAt,
                    });

                    console.log(`[TaskExecutor] Task ${task.id} completed. Profit: $${profit.toFixed(2)}`);
                    return;
                }

                // 订单已取消或过期
                if (status.status === 'CANCELLED' || status.status === 'EXPIRED') {
                    // 构建详细的取消原因
                    const detailReason = status.cancelReason
                        ? `Order ${status.status}: ${status.cancelReason}`
                        : `Order ${status.status}`;

                    console.log(`[TaskExecutor] Task ${task.id} order ${status.status}. Reason: ${detailReason}`);

                    // 后台刷新，不阻塞对冲路径
                    this.refreshTrackedPolyFills(ctx).catch(err => {
                        console.warn(`[TaskExecutor] refreshTrackedPolyFills error:`, err.message);
                    });

                    if (ctx.totalPredictFilled > ctx.totalHedged) {
                        // 有未对冲的部分
                        const unhedgedQty = ctx.totalPredictFilled - ctx.totalHedged;

                        // 检查是否是深度/价格保护导致的取消 (hash 变化 = guard 已处理, isPaused = guard 正在处理)
                        const isGuardCancel = ctx.currentOrderHash !== watchedOrderHash || ctx.isPaused;
                        const cancelSource = isGuardCancel ? 'guard' : 'external';
                        console.log(`[TaskExecutor] Task ${task.id}: Order ${status.status} with fills (${ctx.totalPredictFilled.toFixed(2)} filled, ${unhedgedQty.toFixed(2)} unhedged), source=${cancelSource}`);

                        // 记录订单取消事件
                        await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                            platform: 'predict',
                            orderId: watchedOrderHash!,
                            side: side,
                            price: task.predictPrice,
                            quantity: task.quantity,
                            filledQty: ctx.totalPredictFilled,
                            remainingQty: task.quantity - ctx.totalPredictFilled,
                            avgPrice: task.predictPrice,
                            cancelReason: `${cancelSource}: ${status.cancelReason || status.status}`,
                            rawResponse: status.rawResponse,
                        }, watchedOrderHash ?? undefined);

                        // 对冲已成交部分 (无论 guard 还是 external，都尝试对冲，绝不触发反向平仓)
                        const hedgeCheck = this.checkShouldHedge(ctx, unhedgedQty, false);
                        if (hedgeCheck.shouldHedge) {
                            await this.submitFastHedgeIOC(ctx, side);
                            // reconcile 在后台运行，不阻塞
                            // task 状态由 reconcile 更新
                        }

                        if (isGuardCancel) {
                            // Guard cancel: 继续监控新订单
                            if (ctx.currentOrderHash && ctx.currentOrderHash !== watchedOrderHash) {
                                resetForNewOrder(ctx.currentOrderHash);
                            } else {
                                // isPaused 场景: hash 未变化 (cancel 失败但订单已取消)，清除旧 hash
                                ctx.currentOrderHash = undefined;
                                cancelWatcherIfAny();
                                watchedOrderHash = null;
                            }
                            continue;
                        }

                        // === External cancel: 按残余 notional 分类 ===
                        const DUST_NOTIONAL_USD = 5;
                        let hedgePriceForDust = ctx.lastHedgePriceEstimate;
                        if (hedgePriceForDust <= 0) {
                            hedgePriceForDust = side === 'BUY' ? task.polymarketMaxAsk : task.polymarketMinBid;
                        }
                        if (hedgePriceForDust <= 0) {
                            hedgePriceForDust = Math.max(0, 1 - task.predictPrice);
                        }
                        const preHedgeNotional = unhedgedQty * hedgePriceForDust;

                        // 若刚提交补对冲 IOC，等 reconcile 完成（≤5s）再分类
                        if (hedgeCheck.shouldHedge) {
                            const reconcileDeadline = Date.now() + 5000;
                            while (this.hasPendingFastHedge(ctx) && Date.now() < reconcileDeadline && !ctx.signal.aborted) {
                                await this.delay(200);
                            }
                        }

                        const finalUnhedged = Math.max(0, ctx.totalPredictFilled - ctx.totalHedged);
                        const finalNotional = finalUnhedged * hedgePriceForDust;

                        // 显性记录补对冲尝试事件
                        await this.taskLogger.logTaskLifecycle(task.id, 'RESIDUAL_HEDGE_ATTEMPTED', {
                            status: task.status,
                            previousStatus: task.status,
                            reason: `External ${status.status}: pre=${unhedgedQty.toFixed(2)}股 ($${preHedgeNotional.toFixed(2)}), post=${finalUnhedged.toFixed(2)}股 ($${finalNotional.toFixed(2)}), hedgeTriggered=${hedgeCheck.shouldHedge}`,
                        }).catch(() => {});

                        this.emitStageAlert('⚠️', 'PREDICT_MAKER', 'RESIDUAL_HEDGE', task.id, [
                            `市场: ${task.title}`,
                            `Predict ${status.status}: external`,
                            `成交前残余: ${unhedgedQty.toFixed(2)} 股 ($${preHedgeNotional.toFixed(2)})`,
                            hedgeCheck.shouldHedge
                                ? `补对冲 IOC 已发, reconcile 后残余: ${finalUnhedged.toFixed(2)} 股 ($${finalNotional.toFixed(2)})`
                                : `< $${MIN_HEDGE_NOTIONAL} 阈值, 跳过补对冲`,
                        ]);

                        if (finalNotional < DUST_NOTIONAL_USD) {
                            // Dust 路径 → COMPLETED
                            const profit = this.calculateProfit(task, ctx);
                            const profitPercent = task.predictPrice > 0 && ctx.totalPredictFilled > 0
                                ? (profit / (task.predictPrice * ctx.totalPredictFilled)) * 100
                                : 0;
                            const completionHedgeSlippage = this.getCompletionHedgeSlippage(task, ctx);

                            await this.taskLogger.logTaskLifecycle(task.id, 'DUST_RESIDUAL_COMPLETED', {
                                status: 'COMPLETED',
                                previousStatus: task.status,
                                reason: `External ${status.status}: residual ${finalUnhedged.toFixed(2)}股 ($${finalNotional.toFixed(2)}) < $${DUST_NOTIONAL_USD}, dust 豁免`,
                            });

                            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_COMPLETED', {
                                status: 'COMPLETED',
                                previousStatus: task.status,
                                profit,
                                profitPercent,
                                duration: Date.now() - task.createdAt,
                                ...completionHedgeSlippage,
                            });

                            task = this.updateTask(task.id, {
                                status: 'COMPLETED',
                                actualProfit: profit,
                                completedAt: Date.now(),
                                predictFilledQty: ctx.totalPredictFilled,
                                hedgedQty: ctx.totalHedged,
                                avgPredictPrice: task.predictPrice,
                                avgPolymarketPrice: ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0,
                                remainingQty: finalUnhedged,
                            });
                            ctx.task = task;

                            await this.taskLogger.generateSummary(task.id, {
                                type: task.type,
                                marketId: task.marketId,
                                title: task.title,
                                status: 'COMPLETED',
                                predictFilledQty: ctx.totalPredictFilled,
                                hedgedQty: ctx.totalHedged,
                                avgPredictPrice: task.predictPrice,
                                avgPolymarketPrice: ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0,
                                actualProfit: profit,
                                unwindLoss: 0,
                                pauseCount: task.pauseCount,
                                hedgeRetryCount: task.hedgeRetryCount,
                                createdAt: task.createdAt,
                            });

                            this.emitStageAlert('✅', 'PREDICT_MAKER', 'DUST_COMPLETED', task.id, [
                                `市场: ${task.title}`,
                                `Predict ${status.status} (external) 残余 ${finalUnhedged.toFixed(2)} 股 ($${finalNotional.toFixed(2)})`,
                                `< $${DUST_NOTIONAL_USD} dust 阈值, 自动标 COMPLETED`,
                                `利润: $${profit.toFixed(2)}`,
                            ]);

                            console.log(`[TaskExecutor] Task ${task.id} dust-completed. Residual=${finalUnhedged.toFixed(2)} ($${finalNotional.toFixed(2)}), profit=$${profit.toFixed(2)}`);
                            return;
                        }

                        // 残余 ≥ $5: 真正需人工的 HEDGE_FAILED
                        console.error(`[TaskExecutor] External cancel with $${finalNotional.toFixed(2)} residual (≥ $${DUST_NOTIONAL_USD}), marking HEDGE_FAILED`);
                        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                            status: 'HEDGE_FAILED',
                            previousStatus: task.status,
                            reason: `External ${status.status} with ${finalUnhedged.toFixed(2)} unhedged ($${finalNotional.toFixed(2)})`,
                        });
                        task = this.updateTask(task.id, {
                            status: 'HEDGE_FAILED',
                            error: `External ${status.status}: ${finalUnhedged.toFixed(2)} unhedged @ $${finalNotional.toFixed(2)} (hedged: ${ctx.totalHedged.toFixed(2)}/${ctx.totalPredictFilled.toFixed(2)})`,
                        });
                        ctx.task = task;

                        this.emitStageAlert('🚨', 'PREDICT_MAKER', 'EXTERNAL_HEDGE_FAILED', task.id, [
                            `市场: ${task.title}`,
                            `Predict ${status.status} (external)`,
                            `未对冲: ${finalUnhedged.toFixed(2)} 股 ($${finalNotional.toFixed(2)}, ≥ $${DUST_NOTIONAL_USD})`,
                            `需人工处理`,
                        ]);
                        return;
                    } else if (ctx.totalPredictFilled === 0) {
                        // 没有成交，检查是否是深度/价格保护导致的取消
                        // hash 变化 = guard 已处理, isPaused = guard 正在处理 (cancel 失败但订单已取消)
                        // isDepthAdjusting = 深度监控正在调整订单（取消→重提）
                        if (ctx.currentOrderHash !== watchedOrderHash || ctx.isPaused || ctx.isDepthAdjusting) {
                            console.log(`[TaskExecutor] Task ${task.id}: Order cancelled by guard (hash changed: ${watchedOrderHash?.slice(0, 10)} → ${ctx.currentOrderHash?.slice(0, 10) || 'null'}, isDepthAdjusting: ${!!ctx.isDepthAdjusting}), continuing...`);
                            // 记录订单取消事件
                            await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                                platform: 'predict',
                                orderId: watchedOrderHash!,
                                side: side,
                                price: task.predictPrice,
                                quantity: task.quantity,
                                filledQty: 0,
                                remainingQty: task.quantity,
                                avgPrice: task.predictPrice,
                                cancelReason: status.cancelReason,
                                rawResponse: status.rawResponse,
                            }, watchedOrderHash ?? undefined);
                            // 不取消任务，继续监控循环
                            if (ctx.currentOrderHash && ctx.currentOrderHash !== watchedOrderHash) {
                                // 已有新订单，重置监控状态
                                resetForNewOrder(ctx.currentOrderHash);
                            } else {
                                // isPaused 场景或等待新订单提交
                                ctx.currentOrderHash = undefined;
                                cancelWatcherIfAny();
                                watchedOrderHash = null;
                            }
                            continue;
                        }

                        // 订单确实被外部取消（非保护机制），取消任务
                        await this.taskLogger.logOrderEvent(task.id, status.status === 'CANCELLED' ? 'ORDER_CANCELLED' : 'ORDER_EXPIRED', {
                            platform: 'predict',
                            orderId: ctx.currentOrderHash!,
                            side: side,
                            price: task.predictPrice,
                            quantity: task.quantity,
                            filledQty: 0,
                            remainingQty: task.quantity,
                            avgPrice: task.predictPrice,
                            cancelReason: status.cancelReason,
                            rawResponse: status.rawResponse,
                        }, ctx.currentOrderHash);

                        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_CANCELLED', {
                            status: 'CANCELLED',
                            previousStatus: task.status,
                            reason: detailReason,
                            cancelReason: status.cancelReason,
                        });

                        this.updateTask(task.id, {
                            status: 'CANCELLED',
                            error: detailReason,
                        });
                    } else if (this.hasPendingFastHedge(ctx)) {
                        // 等后台 IOC reconcile 完成后再结束任务，避免已提交的补偿订单迟到回报造成超量对冲。
                        await Promise.race([this.delay(100), monitorWakePromise]);
                        continue;
                    } else {
                        // 已完全对冲
                        const profit = this.calculateProfit(task, ctx);
                        const profitPercent = task.predictPrice > 0 && ctx.totalPredictFilled > 0
                            ? (profit / (task.predictPrice * ctx.totalPredictFilled)) * 100
                            : 0;
                        const completionHedgeSlippage = this.getCompletionHedgeSlippage(task, ctx);

                        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_COMPLETED', {
                            status: 'COMPLETED',
                            previousStatus: task.status,
                            profit,
                            profitPercent,
                            duration: Date.now() - task.createdAt,
                            ...completionHedgeSlippage,
                        });

                        task = this.updateTask(task.id, {
                            status: 'COMPLETED',
                            actualProfit: profit,
                            completedAt: Date.now(),
                            predictFilledQty: ctx.totalPredictFilled,
                            hedgedQty: ctx.totalHedged,
                            avgPredictPrice: task.predictPrice,
                            avgPolymarketPrice: ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0,
                            remainingQty: ctx.totalPredictFilled - ctx.totalHedged,
                        });

                        // 生成任务汇总
                        await this.taskLogger.generateSummary(task.id, {
                            type: task.type,
                            marketId: task.marketId,
                            title: task.title,
                            status: 'COMPLETED',
                            predictFilledQty: ctx.totalPredictFilled,
                            hedgedQty: ctx.totalHedged,
                            avgPredictPrice: task.predictPrice,
                            avgPolymarketPrice: ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0,
                            actualProfit: profit,
                            unwindLoss: 0,
                            pauseCount: task.pauseCount,
                            hedgeRetryCount: task.hedgeRetryCount,
                            createdAt: task.createdAt,
                        });
                    }
                    return;
                }

                // 等待事件 (BSC WSS 成交 / Predict WS 终态 / 兜底超时)
                if (restFallbackActive) {
                    await Promise.race([
                        this.delay(REST_FALLBACK_INTERVAL),
                        wssEventPromise,
                        terminatedPromise,
                        monitorWakePromise,
                    ]);
                } else {
                    // WS 正常模式: 纯事件驱动等待
                    await Promise.race([
                        wssEventPromise,
                        terminatedPromise,
                        monitorWakePromise,
                        this.delay(10_000),  // 10s 兜底超时
                    ]);
                }
            }
        } finally {
            // 清理 BSC WSS watcher
            if (wssWatcherRef.cancel) {
                wssWatcherRef.cancel();
                console.log(`[TaskExecutor] Task ${task.id}: BSC WSS order listener cleaned up`);
            }
            // 清理 Predict WS fill watcher
            cancelPredictWsFillWatcher();
            // 清理 Predict WS 事件监听
            predictWatcher.removeListener('orderTerminated', onTerminated);
            predictWatcher.removeListener('subscriptionLost', onSubLost);
            predictWatcher.removeListener('subscriptionRestored', onSubRestored);
            if (ctx.wakeMonitor === wakeMonitor) {
                ctx.wakeMonitor = undefined;
            }
        }
    }

    /**
     * 强制对冲悬空：绕开 checkShouldHedge 的 MIN_HEDGE_NOTIONAL 阈值，直接调用 fallback chain
     * 用于：depth-guard 暂停前、价格/深度恢复重下前，确保已成交未对冲量先被处理
     *
     * 复用 executeHedgeFallbackChain：Tier1 抬价 IOC (maxAsk + HEDGE_SLIPPAGE) + Tier2 保本 GTC，
     * 仅检查 MIN_HEDGE_QTY=1，不受 MIN_HEDGE_NOTIONAL 阈值阻塞。
     */
    private async forceHedgeResidual(
        ctx: TaskContext,
        side: 'BUY' | 'SELL',
        reason: 'depth_pause' | 'price_resume' | 'depth_resume' | 'zero_fill',
    ): Promise<void> {
        // 调用前先合并最新成交量，确保 totalPredictFilled 准确
        try { ctx.mergeFilledQty?.(); } catch { /* ignore */ }

        const unhedged = ctx.totalPredictFilled - ctx.totalHedged - ctx.reservedHedgeQty;
        if (unhedged < MIN_HEDGE_QTY) return;

        // Dust 检查：notional < Polymarket 最小订单 ($1) → SKIP，避免死循环
        const fhNotional = this.estimateHedgeNotional(ctx, unhedged);
        if (fhNotional < POLY_MIN_ORDER_NOTIONAL) {
            console.log(`[TaskExecutor] forceHedgeResidual skip dust (${reason}): unhedged=${unhedged.toFixed(4)} shares, notional=$${fhNotional.toFixed(2)} < $${POLY_MIN_ORDER_NOTIONAL}`);
            return;
        }

        // 防重入：与 fast hedge / fallback / inflight 互斥
        if (ctx.inflightHedge || ctx.isHedgingInProgress || ctx.fastHedgeFallbackInProgress) {
            console.log(`[TaskExecutor] forceHedgeResidual skip (${reason}): hedge already in progress`);
            return;
        }

        console.log(`[TaskExecutor] 🛡️ forceHedgeResidual triggered (${reason}): unhedged=${unhedged.toFixed(2)} shares, calling fallback chain`);
        this.taskLogger.logTaskLifecycle(ctx.task.id, 'FORCE_HEDGE_TRIGGERED', {
            status: ctx.task.status as any,
            reason: `force hedge residual (${reason}): unhedged=${unhedged.toFixed(2)}`,
        }).catch(() => {});

        // executeHedgeFallbackChain 自身会设置/释放 fastHedgeFallbackInProgress + isHedgingInProgress
        ctx.isHedgingInProgress = true;
        try {
            await this.executeHedgeFallbackChain(ctx, side);
        } catch (e: any) {
            console.error(`[TaskExecutor] forceHedgeResidual error: ${e?.message || e}`);
            // fallback finally 块负责释放，但若 chain 在进入前抛错（如 fastHedgeFallbackInProgress 已设），手动兜底
            ctx.isHedgingInProgress = false;
        }
    }

    /**
     * Phase 2: 快速下单 — 不等确认，后台 reconcile
     * 单 inflight 互斥，dispatchable 扣减 reservedHedgeQty 防超额
     */
    private async submitFastHedgeIOC(
        ctx: TaskContext,
        side: 'BUY' | 'SELL',
    ): Promise<{ submitted: boolean; orderId?: string; qty?: number; price?: number }> {
        const task = ctx.task;

        // 单 inflight 互斥
        if (ctx.inflightHedge) return { submitted: false };
        if (ctx.isHedgingInProgress) return { submitted: false };
        if (ctx.signal.aborted) return { submitted: false };

        // cooldown gate: 0-fill / UNKNOWN 后冷却期内不再发单
        const now = Date.now();
        if ((ctx.fastHedgeCooldownUntil ?? 0) > now) {
            ctx.fastHedgeMetrics.cooldownBlockCount++;
            return { submitted: false };
        }

        // hedge failure backoff: fallback chain 全失败退避中，跳过本次 fast hedge 避免触发新一轮 fallback
        if ((ctx.hedgeFailureBackoffUntil ?? 0) > now) {
            return { submitted: false };
        }

        // 计算可派发量
        const dispatchable = ctx.totalPredictFilled - ctx.totalHedged - ctx.reservedHedgeQty;
        if (dispatchable < MIN_HEDGE_QTY) return { submitted: false };

        // Dust 检查：notional < Polymarket 最小订单 ($1) → SKIP，避免反复打到 Polymarket 被拒单
        const fhDispatchNotional = this.estimateHedgeNotional(ctx, dispatchable);
        if (fhDispatchNotional < POLY_MIN_ORDER_NOTIONAL) {
            console.log(`[TaskExecutor] Fast hedge skip dust: dispatchable=${dispatchable.toFixed(4)} shares, notional=$${fhDispatchNotional.toFixed(2)} < $${POLY_MIN_ORDER_NOTIONAL}`);
            return { submitted: false };
        }

        // 从这里开始即使还没拿到 Polymarket orderId，也要阻止下一次 fill 触发并发 IOC。
        ctx.isHedgingInProgress = true;

        // 预留
        ctx.reservedHedgeQty += dispatchable;

        const hedgeSide = side;
        const hedgePrice = side === 'BUY' ? task.polymarketMaxAsk : task.polymarketMinBid;
        const hedgeTokenId = this.getHedgeTokenId(task);
        const attemptId = Math.random().toString(36).substring(2, 10);

        this.logFF('HEDGE_STARTED', this.taskLogger.logHedgeEvent(task.id, 'HEDGE_STARTED', {
            hedgeQty: dispatchable,
            totalHedged: ctx.totalHedged,
            totalPredictFilled: ctx.totalPredictFilled,
            avgHedgePrice: 0,
            retryCount: 0,
        }, attemptId));

        let tSubmit = 0;
        let tSubmitMono: number | undefined;
        let fillToSubmitStartMs: number | undefined;

        try {
            tSubmit = Date.now();
            tSubmitMono = performance.now();
            fillToSubmitStartMs = this.elapsedFromMono(ctx.lastFillRecvMono, tSubmitMono);
            const polyResult = await this.polyTrader.placeOrder({
                tokenId: hedgeTokenId,
                side: hedgeSide,
                price: hedgePrice,
                quantity: dispatchable,
                orderType: 'IOC',
                negRisk: task.negRisk,
                marketTitle: task.title,
                conditionId: task.polymarketConditionId,
            });

            if (!polyResult.success) {
                ctx.reservedHedgeQty -= dispatchable;
                // 不清 isHedgingInProgress: 由 fallback chain 持有互斥，完成时统一释放
                console.error(`[TaskExecutor] Fast hedge IOC failed: ${polyResult.error}`);
                this.logFF('HEDGE_FAILED(submit)', this.taskLogger.logHedgeEvent(task.id, 'HEDGE_FAILED', {
                    hedgeQty: dispatchable,
                    totalHedged: ctx.totalHedged,
                    totalPredictFilled: ctx.totalPredictFilled,
                    avgHedgePrice: hedgePrice,
                    retryCount: 0,
                    error: polyResult.error ? new Error(polyResult.error) : undefined,
                }, attemptId));
                this.logHedgeTiming({
                    taskId: task.id,
                    attemptId,
                    phase: 'submit_failed',
                    strategy: 'PREDICT_MAKER_FAST_HEDGE',
                    fillSource: ctx.lastFillSource ?? 'unknown',
                    side: hedgeSide,
                    qty: dispatchable,
                    price: hedgePrice,
                    tokenId: this.shortTokenId(hedgeTokenId),
                    error: polyResult.error,
                    fillToSubmitStartMs,
                    polyPlaceOrderMs: polyResult.timing?.totalMs ?? this.elapsedFromMono(tSubmitMono),
                    polyOrderTiming: polyResult.timing,
                    redispatchCount: ctx.fastHedgeMetrics.redispatchCount,
                    zeroFillCount: ctx.fastHedgeMetrics.zeroFillCount,
                    unknownCount: ctx.fastHedgeMetrics.unknownCount,
                });

                // 触发兜底链 (Tier 1 抬价 IOC + Tier 2 保本 GTC)，detach 不阻塞调用方
                void this.executeHedgeFallbackChain(ctx, side).catch(e => {
                    console.error(`[TaskExecutor] fallback chain error:`, (e as Error).message);
                    ctx.fastHedgeFallbackInProgress = false;
                    ctx.isHedgingInProgress = false;
                });

                return { submitted: false };
            }

            // 登记 inflight
            ctx.inflightHedge = {
                orderId: polyResult.orderId!,
                submittedQty: dispatchable,
                side: hedgeSide,
                price: hedgePrice,
                attemptId,
                submittedAt: tSubmit,
                retryCount: 0,
                status: 'LIVE',
                reconcileRetryCount: 0,
            };

            // 追踪 Poly 订单
            if (!ctx.polyOrderFills.has(polyResult.orderId!)) {
                ctx.polyOrderFills.set(polyResult.orderId!, {
                    filledQty: 0,
                    rawFilledQty: 0,
                    targetQty: dispatchable,
                    avgPrice: hedgePrice,
                    lastCheckedAt: 0,
                    accountForBuyFees: hedgeSide === 'BUY',
                    feeRate: polyResult.feeRate ?? 0,
                    feeExponent: polyResult.feeExponent ?? 1,
                });
            }

            this.logFF('ORDER_SUBMITTED(poly)', this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                platform: 'polymarket',
                orderId: polyResult.orderId!,
                side: hedgeSide,
                price: hedgePrice,
                quantity: polyResult.submittedQuantity ?? dispatchable,
                filledQty: 0,
                remainingQty: polyResult.submittedQuantity ?? dispatchable,
                avgPrice: 0,
            }));

            this.updateTask(task.id, {
                status: 'HEDGING',
                currentPolyOrderId: polyResult.orderId,
            });

            const submitMs = this.elapsedFromMono(tSubmitMono) ?? (Date.now() - tSubmit);
            ctx.fastHedgeMetrics.submitCount++;
            ctx.fastHedgeMetrics.totalSubmitMs += submitMs;
            const fillToSubmitMs = fillToSubmitStartMs ?? (ctx.lastFillRecvTs ? tSubmit - ctx.lastFillRecvTs : undefined);
            console.log(`[TaskExecutor] Fast hedge IOC submitted: ${dispatchable.toFixed(2)} @ ${hedgePrice.toFixed(4)} [submitMs=${submitMs}ms${fillToSubmitMs !== undefined ? `, fill→submit=${fillToSubmitMs}ms` : ''}]`);
            this.logHedgeTiming({
                taskId: task.id,
                attemptId,
                phase: 'submit',
                strategy: 'PREDICT_MAKER_FAST_HEDGE',
                fillSource: ctx.lastFillSource ?? 'unknown',
                side: hedgeSide,
                qty: dispatchable,
                price: hedgePrice,
                tokenId: this.shortTokenId(hedgeTokenId),
                orderId: polyResult.orderId!,
                fillToSubmitStartMs: fillToSubmitMs,
                polyPlaceOrderMs: polyResult.timing?.totalMs ?? submitMs,
                polyOrderTiming: polyResult.timing,
                redispatchCount: ctx.fastHedgeMetrics.redispatchCount,
                zeroFillCount: ctx.fastHedgeMetrics.zeroFillCount,
                unknownCount: ctx.fastHedgeMetrics.unknownCount,
            });

            // 后台确认 (不阻塞)
            void this.reconcileInflightHedge(ctx, side).catch(e =>
                console.error(`[TaskExecutor] reconcileInflightHedge error:`, (e as Error).message)
            );

            return { submitted: true, orderId: polyResult.orderId!, qty: dispatchable, price: hedgePrice };

        } catch (error: any) {
            ctx.reservedHedgeQty -= dispatchable;
            ctx.isHedgingInProgress = false;
            console.error(`[TaskExecutor] Fast hedge IOC exception:`, error.message);
            this.logHedgeTiming({
                taskId: task.id,
                attemptId,
                phase: 'submit_failed',
                strategy: 'PREDICT_MAKER_FAST_HEDGE',
                fillSource: ctx.lastFillSource ?? 'unknown',
                side: hedgeSide,
                qty: dispatchable,
                price: hedgePrice,
                tokenId: this.shortTokenId(hedgeTokenId),
                error: error.message,
                fillToSubmitStartMs,
                polyPlaceOrderMs: this.elapsedFromMono(tSubmitMono),
                redispatchCount: ctx.fastHedgeMetrics.redispatchCount,
                zeroFillCount: ctx.fastHedgeMetrics.zeroFillCount,
                unknownCount: ctx.fastHedgeMetrics.unknownCount,
            });
            return { submitted: false };
        }
    }

    /**
     * Phase 2: 后台确认 inflight IOC 结果
     * watch → applyDelta → 释放 reserve → 清除 inflight → 检查是否需要补单
     */
    private async reconcileInflightHedge(
        ctx: TaskContext,
        side: 'BUY' | 'SELL',
    ): Promise<void> {
        const inflight = ctx.inflightHedge;
        if (!inflight) return;
        if (inflight.reconcileInProgress) return;
        inflight.reconcileInProgress = true;

        const task = ctx.task;
        let tWatchStartMono: number | undefined;

        try {
            // 等待 IOC 成交
            const tWatchStart = Date.now();
            tWatchStartMono = performance.now();
            const watchResult = await new Promise<OrderWatchResult>((resolve) => {
                this.orderMonitor.watchPolymarketOrder(
                    inflight.orderId,
                    (result) => resolve(result),
                    { timeoutMs: 2000, tradeWindowMs: 150 }
                );
            });
            const tWatchEnd = Date.now();
            const tWatchEndMono = performance.now();

            const watchDelta = this.applyPolyFillDelta(
                ctx, inflight.orderId, watchResult.filledQty, inflight.price
            );

            // 异步校验
            this.refreshSinglePolyFill(ctx, inflight.orderId, {
                fallbackFilledQty: watchResult.filledQty,
                fallbackAvgPrice: inflight.price,
                force: true,
            }).catch(err => {
                console.warn(`[TaskExecutor] Async refresh failed: ${(err as Error).message}`);
            });

            // 刷新估算价
            if (watchDelta > 0) {
                ctx.lastHedgePriceEstimate = inflight.price;
            }

            // 释放预留 + 清除 inflight
            ctx.reservedHedgeQty -= inflight.submittedQty;
            if (ctx.reservedHedgeQty < 0) ctx.reservedHedgeQty = 0;
            ctx.inflightHedge = undefined;
            ctx.isHedgingInProgress = false;

            // 计时日志 + 指标
            const watchMs = this.elapsedFromMono(tWatchStartMono, tWatchEndMono) ?? (tWatchEnd - tWatchStart);
            const e2eMs = this.elapsedFromMono(ctx.lastFillRecvMono, tWatchEndMono)
                ?? (ctx.lastFillRecvTs ? tWatchEnd - ctx.lastFillRecvTs : undefined);
            ctx.fastHedgeMetrics.totalWatchMs += watchMs;
            if (e2eMs !== undefined && watchDelta > 0) {
                ctx.fastHedgeMetrics.totalE2eMs += e2eMs;
                ctx.fastHedgeMetrics.e2eSamples++;
            }
            if (watchDelta > 0) {
                const m = ctx.fastHedgeMetrics;
                const avgSubmit = m.submitCount > 0 ? (m.totalSubmitMs / m.submitCount).toFixed(0) : '?';
                const avgE2e = m.e2eSamples > 0 ? (m.totalE2eMs / m.e2eSamples).toFixed(0) : '?';
                console.log(
                    `[TaskExecutor] Hedge reconciled: +${watchDelta.toFixed(2)}, total hedged: ${ctx.totalHedged.toFixed(2)} ` +
                    `[watchMs=${watchMs}ms${e2eMs !== undefined ? `, e2e=${e2eMs}ms` : ''}` +
                    `, avgSubmit=${avgSubmit}ms, avgE2e=${avgE2e}ms` +
                    `, 0fill=${m.zeroFillCount}, cdBlock=${m.cooldownBlockCount}]`
                );
            }

            // 有成交: 清掉 cooldown
            if (watchDelta > 0) {
                ctx.fastHedgeCooldownUntil = 0;
            }

            // 0 fill: 设置 cooldown + 幽灵深度处理
            if (watchDelta === 0) {
                ctx.fastHedgeMetrics.zeroFillCount++;
                ctx.fastHedgeCooldownUntil = Date.now() + 300;
                if (ctx.currentOrderHash) {
                    console.warn(`[TaskExecutor] 🛑 幽灵深度: IOC 0 成交，取消 Predict 订单`);
                    ctx.phantomDepthDetected = true;
                    if (task.isSportsMarket) {
                        getSportsService().reportPhantomFromIOC(
                            this.getHedgeTokenId(task), side
                        );
                    }
                    // fire-and-forget: phantomDepthDetected + cooldown 已设置，不阻塞 reconcile
                    const hashToCancel = ctx.currentOrderHash;
                    ctx.currentOrderHash = undefined;
                    void this.predictTrader.cancelOrder(hashToCancel).catch(() => {});
                }
                // 兜底: IOC 0 fill 时若已有未对冲量，直接走 fallback chain (Tier1 抬价 IOC + Tier2 保本 GTC)
                // Why: Predict 已 FILLED 且 hash=null 时，主循环不会触发 depth_pause/depth_resume/price_resume,
                // 任务会陷入"已成交未对冲"死角直到过期或人工介入 (历史事故: PARIVISION vs Liquid 186 股裸敞口)
                const unhedgedAfterReconcile = ctx.totalPredictFilled - ctx.totalHedged - ctx.reservedHedgeQty;
                if (unhedgedAfterReconcile >= MIN_HEDGE_QTY) {
                    void this.forceHedgeResidual(ctx, side, 'zero_fill').catch(e =>
                        console.error(`[TaskExecutor] forceHedgeResidual after zero-fill error:`, (e as Error).message),
                    );
                }
            }

            // 日志 — 用 tWatchEnd 而非 Date.now()，避免 cancel 等后续操作污染耗时
            const fillRecvTs = ctx.lastFillRecvTs;
            this.logFF('HEDGE_COMPLETED', this.taskLogger.logHedgeEvent(task.id,
                watchDelta > 0 ? 'HEDGE_COMPLETED' : 'HEDGE_FAILED',
            {
                hedgeQty: inflight.submittedQty,
                totalHedged: ctx.totalHedged,
                totalPredictFilled: ctx.totalPredictFilled,
                avgHedgePrice: inflight.price,
                retryCount: inflight.retryCount,
                elapsedMs: fillRecvTs ? tWatchEnd - fillRecvTs : undefined,
            }, inflight.attemptId));
            this.logHedgeTiming({
                taskId: task.id,
                attemptId: inflight.attemptId,
                phase: 'reconcile',
                strategy: 'PREDICT_MAKER_FAST_HEDGE',
                fillSource: ctx.lastFillSource ?? 'unknown',
                side: inflight.side,
                qty: inflight.submittedQty,
                price: inflight.price,
                orderId: inflight.orderId,
                resultStatus: watchResult.status ?? (watchDelta > 0 ? 'FILLED' : 'NO_FILL'),
                watchMs,
                e2eToTerminalMs: e2eMs,
                watchDelta,
                statusPollCount: watchResult.pollCount,
                statusPollSource: watchResult.pollSource,
                redispatchCount: ctx.fastHedgeMetrics.redispatchCount,
                zeroFillCount: ctx.fastHedgeMetrics.zeroFillCount,
                unknownCount: ctx.fastHedgeMetrics.unknownCount,
            });

            // 更新 task 状态
            const avgHedgePrice = ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0;
            this.updateTask(task.id, {
                hedgedQty: ctx.totalHedged,
                avgPolymarketPrice: avgHedgePrice,
                remainingQty: ctx.totalPredictFilled - ctx.totalHedged,
                polyRequiredBalance: this.calcPolyRequiredBalance(task, ctx.totalHedged),
            });
            ctx.task = this.taskService.getTask(task.id)!;

            // 再次检查: 部分成交后是否还有未对冲量需要继续派发
            // 仅在 watchDelta > 0 时 re-dispatch，0 fill 不重试（防无界同价重试，由主循环兜底）
            if (watchDelta > 0) {
                const stillDispatchable = ctx.totalPredictFilled - ctx.totalHedged - ctx.reservedHedgeQty;
                if (stillDispatchable >= MIN_HEDGE_QTY && !ctx.inflightHedge && !ctx.signal.aborted) {
                    const check = this.checkShouldHedge(ctx, 0, false);
                    if (check.shouldHedge) {
                        ctx.fastHedgeMetrics.redispatchCount++;
                        void this.submitFastHedgeIOC(ctx, side).catch(e =>
                            console.error(`[TaskExecutor] re-dispatch error:`, (e as Error).message)
                        );
                    }
                }
            }

        } catch (error: any) {
            // 异常路径: 不盲释放 reserve，先尝试确认终态
            console.error(`[TaskExecutor] reconcileInflightHedge exception:`, error.message);
            const failedInflight = ctx.inflightHedge;
            if (!failedInflight) return;

            failedInflight.status = 'UNKNOWN';
            failedInflight.reconcileRetryCount = (failedInflight.reconcileRetryCount ?? 0) + 1;
            ctx.fastHedgeMetrics.unknownCount++;

            try {
                await this.refreshSinglePolyFill(ctx, failedInflight.orderId, {
                    fallbackFilledQty: 0,
                    fallbackAvgPrice: failedInflight.price,
                    force: true,
                });

                const tracker = ctx.polyOrderFills.get(failedInflight.orderId);
                const isTerminal = Boolean(tracker?.isTerminal);

                if (isTerminal) {
                    // 终态已确认: 安全释放 reserve
                    console.log(`[TaskExecutor] reconcile exception: terminal confirmed for ${failedInflight.orderId}, releasing reserve`);
                    ctx.reservedHedgeQty -= failedInflight.submittedQty;
                    if (ctx.reservedHedgeQty < 0) ctx.reservedHedgeQty = 0;
                    ctx.inflightHedge = undefined;
                    ctx.isHedgingInProgress = false;
                } else {
                    // 未确认终态: 保留 reserve + inflight，主循环稍后重试
                    console.warn(`[TaskExecutor] reconcile exception: non-terminal for ${failedInflight.orderId}, keeping inflight (retry=${failedInflight.reconcileRetryCount})`);
                    ctx.fastHedgeCooldownUntil = Date.now() + 300;
                }
            } catch (restErr) {
                // REST reconcile 也失败: 保留 reserve + inflight，主循环稍后重试
                console.warn(`[TaskExecutor] reconcile exception: REST also failed: ${(restErr as Error).message}, keeping inflight (retry=${failedInflight.reconcileRetryCount})`);
                ctx.fastHedgeCooldownUntil = Date.now() + 300;
            }
            this.logHedgeTiming({
                taskId: task.id,
                attemptId: failedInflight.attemptId,
                phase: 'reconcile_failed',
                strategy: 'PREDICT_MAKER_FAST_HEDGE',
                fillSource: ctx.lastFillSource ?? 'unknown',
                side: failedInflight.side,
                qty: failedInflight.submittedQty,
                price: failedInflight.price,
                orderId: failedInflight.orderId,
                resultStatus: failedInflight.status,
                error: error.message,
                watchMs: this.elapsedFromMono(tWatchStartMono),
                e2eToTerminalMs: this.elapsedFromMono(ctx.lastFillRecvMono),
                redispatchCount: ctx.fastHedgeMetrics.redispatchCount,
                zeroFillCount: ctx.fastHedgeMetrics.zeroFillCount,
                unknownCount: ctx.fastHedgeMetrics.unknownCount,
            });
        } finally {
            // 清除 reconcile 互斥标志
            if (ctx.inflightHedge?.orderId === inflight.orderId) {
                ctx.inflightHedge.reconcileInProgress = false;
            }
            ctx.wakeMonitor?.();
        }
    }

    /**
     * Fast hedge IOC 失败后的兜底链
     * Tier 1: 抬价 IOC — 用 polymarketMaxAsk + HEDGE_RETRY_MAX_SLIPPAGE 重发 IOC，吃掉滑点求成交
     * Tier 2: 保本 GTC — Tier 1 仍失败 / 实时价已超滑点上限，挂保本价 GTC 等成交
     *
     * 调用前提：submitFastHedgeIOC 已 return false 且 ctx.isHedgingInProgress 仍为 true
     * （由失败分支保留，本方法 finally 释放）
     */
    private async executeHedgeFallbackChain(
        ctx: TaskContext,
        side: 'BUY' | 'SELL',
    ): Promise<void> {
        if (ctx.fastHedgeFallbackInProgress) return;

        // 失败退避：上次 Tier1+Tier2 全失败后退避中，跳过本次尝试避免刷屏
        const nowTs = Date.now();
        if ((ctx.hedgeFailureBackoffUntil ?? 0) > nowTs) {
            const waitMs = (ctx.hedgeFailureBackoffUntil ?? 0) - nowTs;
            console.log(`[TaskExecutor] fallback skip: backoff ${(waitMs / 1000).toFixed(1)}s remaining (failure count=${ctx.hedgeFailureCount ?? 0})`);
            return;
        }

        ctx.fastHedgeFallbackInProgress = true;

        const task = ctx.task;
        const hedgeTokenId = this.getHedgeTokenId(task);
        const tickStep = 0.01;
        const attemptId = Math.random().toString(36).substring(2, 10);

        let reservedHere = 0;
        // 本次 fallback chain 是否有任何"有效进展"（Tier1 部分成交 / Tier2 GTC 挂单成功）
        // 用于失败计数：全失败才累加退避，任何 progress 都清零
        let anyProgress = false;

        try {
            if (ctx.signal.aborted) return;

            // 重新计算可派发量 (失败分支已清 reservedHedgeQty)
            const dispatchable = ctx.totalPredictFilled - ctx.totalHedged - ctx.reservedHedgeQty;
            if (dispatchable < MIN_HEDGE_QTY) {
                console.log(`[TaskExecutor] Fallback skip: dispatchable ${dispatchable.toFixed(2)} < ${MIN_HEDGE_QTY}`);
                return;
            }

            // Dust 检查：notional < Polymarket 最小订单 ($1) → SKIP，避免兜底链反复拒单
            const fbDispatchNotional = this.estimateHedgeNotional(ctx, dispatchable);
            if (fbDispatchNotional < POLY_MIN_ORDER_NOTIONAL) {
                console.log(`[TaskExecutor] Fallback skip dust: dispatchable=${dispatchable.toFixed(4)} shares, notional=$${fbDispatchNotional.toFixed(2)} < $${POLY_MIN_ORDER_NOTIONAL}`);
                return;
            }

            ctx.reservedHedgeQty += dispatchable;
            reservedHere = dispatchable;

            // ====== Tier 1: 抬价 IOC ======
            const escalatedAsk = roundToTick(task.polymarketMaxAsk + HEDGE_RETRY_MAX_SLIPPAGE, tickStep);
            const escalatedBid = roundToTick(task.polymarketMinBid - HEDGE_RETRY_MAX_SLIPPAGE, tickStep);

            let tier1Tried = false;
            const orderbook = await this.getPolymarketOrderbook(hedgeTokenId, task.isSportsMarket);
            if (orderbook) {
                let hedgePrice = 0;
                let canTryTier1 = false;

                if (side === 'BUY') {
                    if (orderbook.asks.length > 0) {
                        const bestAsk = orderbook.asks[0].price;
                        if (bestAsk <= escalatedAsk) {
                            hedgePrice = roundToTick(Math.max(bestAsk, escalatedAsk), tickStep);
                            canTryTier1 = true;
                        } else {
                            console.log(`[TaskExecutor] Fallback Tier1 skip BUY: best ask ${bestAsk.toFixed(4)} > escalated ${escalatedAsk.toFixed(4)}`);
                        }
                    }
                } else {
                    if (orderbook.bids.length > 0) {
                        const bestBid = orderbook.bids[0].price;
                        if (bestBid >= escalatedBid) {
                            hedgePrice = roundToTick(Math.min(bestBid, escalatedBid), tickStep);
                            canTryTier1 = true;
                        } else {
                            console.log(`[TaskExecutor] Fallback Tier1 skip SELL: best bid ${bestBid.toFixed(4)} < escalated ${escalatedBid.toFixed(4)}`);
                        }
                    }
                }

                if (canTryTier1) {
                    tier1Tried = true;
                    console.log(`[TaskExecutor] Fallback Tier1: IOC @ ${hedgePrice.toFixed(4)} qty=${dispatchable.toFixed(2)} (escalated from ${task.polymarketMaxAsk.toFixed(4)})`);

                    this.logFF('HEDGE_STARTED(fallback-tier1)', this.taskLogger.logHedgeEvent(task.id, 'HEDGE_STARTED', {
                        hedgeQty: dispatchable,
                        totalHedged: ctx.totalHedged,
                        totalPredictFilled: ctx.totalPredictFilled,
                        avgHedgePrice: hedgePrice,
                        retryCount: 0,
                        reason: 'fallback Tier1: escalated IOC after fast IOC failed',
                    }, attemptId));

                    try {
                        const polyResult = await this.polyTrader.placeOrder({
                            tokenId: hedgeTokenId,
                            side,
                            price: hedgePrice,
                            quantity: dispatchable,
                            orderType: 'IOC',
                            negRisk: task.negRisk,
                            marketTitle: task.title,
                            conditionId: task.polymarketConditionId,
                        });

                        if (polyResult.success && polyResult.orderId) {
                            if (!ctx.polyOrderFills.has(polyResult.orderId)) {
                                ctx.polyOrderFills.set(polyResult.orderId, {
                                    filledQty: 0,
                                    rawFilledQty: 0,
                                    targetQty: dispatchable,
                                    avgPrice: hedgePrice,
                                    lastCheckedAt: 0,
                                    accountForBuyFees: side === 'BUY',
                                    feeRate: polyResult.feeRate ?? 0,
                                    feeExponent: polyResult.feeExponent ?? 1,
                                });
                            }

                            const watchResult = await new Promise<OrderWatchResult>((resolve) => {
                                this.orderMonitor.watchPolymarketOrder(
                                    polyResult.orderId!,
                                    resolve,
                                    { timeoutMs: 2000, tradeWindowMs: 150 }
                                );
                            });

                            const watchDelta = this.applyPolyFillDelta(ctx, polyResult.orderId, watchResult.filledQty, hedgePrice);
                            this.refreshSinglePolyFill(ctx, polyResult.orderId, {
                                fallbackFilledQty: watchResult.filledQty,
                                fallbackAvgPrice: hedgePrice,
                                force: true,
                            }).catch(err => {
                                console.warn(`[TaskExecutor] Fallback Tier1 async refresh failed: ${(err as Error).message}`);
                            });

                            if (watchDelta > 0) {
                                anyProgress = true;
                                ctx.lastHedgePriceEstimate = hedgePrice;
                                console.log(`[TaskExecutor] Fallback Tier1 filled: +${watchDelta.toFixed(2)} @ ${hedgePrice.toFixed(4)}, totalHedged=${ctx.totalHedged.toFixed(2)}`);
                                this.logFF('HEDGE_COMPLETED(fallback-tier1)', this.taskLogger.logHedgeEvent(task.id, 'HEDGE_COMPLETED', {
                                    hedgeQty: dispatchable,
                                    totalHedged: ctx.totalHedged,
                                    totalPredictFilled: ctx.totalPredictFilled,
                                    avgHedgePrice: hedgePrice,
                                    retryCount: 0,
                                }, attemptId));

                                this.updateTask(task.id, {
                                    hedgedQty: ctx.totalHedged,
                                    avgPolymarketPrice: ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0,
                                    remainingQty: ctx.totalPredictFilled - ctx.totalHedged,
                                    polyRequiredBalance: this.calcPolyRequiredBalance(task, ctx.totalHedged),
                                });
                                ctx.task = this.taskService.getTask(task.id) ?? ctx.task;
                            } else {
                                console.warn(`[TaskExecutor] Fallback Tier1: 0 fill at escalated ${hedgePrice.toFixed(4)} (depth gone)`);
                            }
                        } else {
                            console.error(`[TaskExecutor] Fallback Tier1 IOC failed: ${polyResult.error}`);
                            this.logFF('HEDGE_FAILED(fallback-tier1)', this.taskLogger.logHedgeEvent(task.id, 'HEDGE_FAILED', {
                                hedgeQty: dispatchable,
                                totalHedged: ctx.totalHedged,
                                totalPredictFilled: ctx.totalPredictFilled,
                                avgHedgePrice: hedgePrice,
                                retryCount: 0,
                                error: polyResult.error ? new Error(polyResult.error) : undefined,
                            }, attemptId));
                        }
                    } catch (e: any) {
                        console.error(`[TaskExecutor] Fallback Tier1 exception: ${e.message}`);
                    }
                }
            } else {
                console.warn(`[TaskExecutor] Fallback Tier1 skip: orderbook unavailable`);
            }

            if (ctx.signal.aborted) return;

            // ====== Tier 2: 保本 GTC ======
            const remainingUnhedged = ctx.totalPredictFilled - ctx.totalHedged;
            if (remainingUnhedged < MIN_HEDGE_QTY) {
                console.log(`[TaskExecutor] Fallback complete after Tier1: remaining ${remainingUnhedged.toFixed(2)} < ${MIN_HEDGE_QTY}`);
                return;
            }

            // Dust 检查：Tier1 部分成交后残余 notional < $1 → 放弃 Tier2 GTC
            const tier2Notional = this.estimateHedgeNotional(ctx, remainingUnhedged);
            if (tier2Notional < POLY_MIN_ORDER_NOTIONAL) {
                console.log(`[TaskExecutor] Fallback Tier2 skip dust: remaining=${remainingUnhedged.toFixed(4)}, notional=$${tier2Notional.toFixed(2)} < $${POLY_MIN_ORDER_NOTIONAL}`);
                return;
            }

            console.log(`[TaskExecutor] Fallback Tier2: 保本 GTC, remaining=${remainingUnhedged.toFixed(2)} (tier1Tried=${tier1Tried})`);
            const estimatedLoss = this.calculateUnwindLoss(task, ctx, remainingUnhedged);
            const gtcPlaced = await this.placeGtcFallbackHedge(ctx, remainingUnhedged, estimatedLoss);
            if (gtcPlaced) {
                anyProgress = true;
            } else {
                console.error(`[TaskExecutor] Fallback Tier2 GTC also failed; ${remainingUnhedged.toFixed(2)} shares remain unhedged`);
            }
        } catch (error: any) {
            console.error(`[TaskExecutor] executeHedgeFallbackChain error:`, error.message);
        } finally {
            if (reservedHere > 0) {
                ctx.reservedHedgeQty -= reservedHere;
                if (ctx.reservedHedgeQty < 0) ctx.reservedHedgeQty = 0;
            }

            // 退避：本次有进展则清零，否则累加失败计数 + 指数退避
            if (anyProgress) {
                if ((ctx.hedgeFailureCount ?? 0) > 0) {
                    console.log(`[TaskExecutor] fallback progress, reset failure count from ${ctx.hedgeFailureCount}`);
                }
                ctx.hedgeFailureCount = 0;
                ctx.hedgeFailureBackoffUntil = undefined;
            } else {
                ctx.hedgeFailureCount = (ctx.hedgeFailureCount ?? 0) + 1;
                const delay = Math.min(
                    HEDGE_FAILURE_BACKOFF_CAP_MS,
                    HEDGE_FAILURE_BACKOFF_BASE_MS * Math.pow(2, ctx.hedgeFailureCount - 1),
                );
                ctx.hedgeFailureBackoffUntil = Date.now() + delay;
                console.warn(`[TaskExecutor] fallback all-failed #${ctx.hedgeFailureCount}, backoff ${(delay / 1000).toFixed(1)}s`);
            }

            ctx.fastHedgeFallbackInProgress = false;
            ctx.isHedgingInProgress = false;
            ctx.wakeMonitor?.();
        }
    }

    /**
     * 执行增量对冲 (同步下单→等确认)
     * Phase 2 后 monitorAndHedge 主路径已切到 submitFastHedgeIOC + reconcileInflightHedge。
     * 本方法保留供 executeUnwind() 使用（带重试升级价 + 最大重试数）。
     * 当前无其他 call site。
     */
    private async executeIncrementalHedge(
        ctx: TaskContext,
        quantity: number,
        side: 'BUY' | 'SELL',
    ): Promise<{ success: boolean; filledQty: number; avgPrice: number }> {
        const task = ctx.task;
        const { signal } = ctx;

        // 最小对冲数量检查：低于阈值时跳过对冲，视为成功
        // 原因：Polymarket 对极小订单 (如 0.01 shares) 会报错 "invalid amounts"
        // 同时检查 notional：≥1 share 但 < $1 USD 也会被 "min size: $1" 拒单，必须 SKIP 否则死循环
        const entryNotional = this.estimateHedgeNotional(ctx, quantity);
        if (quantity < MIN_HEDGE_QTY || entryNotional < POLY_MIN_ORDER_NOTIONAL) {
            const reason = quantity < MIN_HEDGE_QTY
                ? `Quantity ${quantity.toFixed(4)} below ${MIN_HEDGE_QTY} shares`
                : `Notional $${entryNotional.toFixed(2)} below $${POLY_MIN_ORDER_NOTIONAL} (Poly min order)`;
            console.log(`[TaskExecutor] Hedge skip dust: ${reason}, treating as complete`);
            this.logFF('HEDGE_SKIPPED', this.taskLogger.logHedgeEvent(task.id, 'HEDGE_SKIPPED', {
                hedgeQty: quantity,
                totalHedged: ctx.totalHedged,
                totalPredictFilled: ctx.totalPredictFilled,
                avgHedgePrice: 0,
                retryCount: 0,
                reason,
            }));
            return { success: true, filledQty: 0, avgPrice: 0 };
        }

        // 对冲互斥: 另一条路径正在对冲中，跳过避免并发竞争
        if (ctx.isHedgingInProgress) {
            console.log(`[TaskExecutor] executeIncrementalHedge: 跳过，另一条对冲路径正在执行中 (task=${task.id})`);
            return { success: true, filledQty: 0, avgPrice: 0 };
        }
        ctx.isHedgingInProgress = true;

        try {

        const hedgeTokenId = this.getHedgeTokenId(task);
        let retryCount = 0;
        let totalFilled = 0;
        let priceSum = 0;
        let remaining = quantity;
        const attemptId = Math.random().toString(36).substring(2, 10);

        // 记录对冲开始 (fire-and-forget: 不阻塞下单关键路径)
        this.logFF('HEDGE_STARTED', this.taskLogger.logHedgeEvent(task.id, 'HEDGE_STARTED', {
            hedgeQty: quantity,
            totalHedged: ctx.totalHedged,
            totalPredictFilled: ctx.totalPredictFilled,
            avgHedgePrice: 0,
            retryCount: 0,
        }, attemptId));

        // 捕获订单簿���照 (fire-and-forget，不阻塞对冲下单)
        this.captureSnapshot(task.id, 'hedge_start', task).catch(() => {});

        // 重试价格策略：
        // - 首次尝试：使用当前最优价
        // - IOC 0 成交后的重试：直接跳到“配置滑点上限 + 2 ticks”
        //   避免 1 tick / 轮地慢速试探，错过最佳对冲窗口
        const tickStep = 0.01;  // 每次升级 1 cent
        let escalatedPrice: number | undefined;  // undefined = 尚未升级，使用 orderbook best price
        // 安全重试上限保留少量余量；由于重试直接跳极限价，不再需要按 tick 数扩展过多次数
        const maxSafetyRetries = task.maxHedgeRetries + 2;

        while (
            retryCount < maxSafetyRetries
            && remaining >= MIN_HEDGE_QTY
            && this.estimateHedgeNotional(ctx, remaining) >= POLY_MIN_ORDER_NOTIONAL
        ) {
            // 全局幽灵深度: 仅在尚未进入逐级抬价时检查
            // 逐级抬价本身就是穿透幽灵深度的机制 (escalatedPrice !== undefined 表示已在抬价)
            // 如果此处不跳过，reportPhantomFromIOC 会在第 1 次 0 fill 后标记 phantom，
            // 导致第 2 次迭代在入口直接 break，escalatedPrice 永远无法使用
            if (task.isSportsMarket && escalatedPrice === undefined) {
                const hedgeTokenId_ = this.getHedgeTokenId(task);
                const isPhantom = getSportsService().isTokenPhantom(hedgeTokenId_, side);
                if (isPhantom) {
                    console.warn(`[TaskExecutor] Hedge loop: 全局幽灵深度, break (retried=${retryCount}, remaining=${remaining.toFixed(2)})`);
                    break;
                }
            }

            if (signal.aborted) {
                this.logFF('HEDGE_FAILED(abort)', this.taskLogger.logHedgeEvent(task.id, 'HEDGE_FAILED', {
                    hedgeQty: quantity,
                    totalHedged: ctx.totalHedged,
                    totalPredictFilled: ctx.totalPredictFilled,
                    avgHedgePrice: totalFilled > 0 ? priceSum / totalFilled : 0,
                    retryCount,
                    error: new Error('Aborted'),
                }, attemptId));
                return { success: false, filledQty: totalFilled, avgPrice: totalFilled > 0 ? priceSum / totalFilled : 0 };
            }

            try {
                // 防超额对冲: 用全局 totalHedged 重新校准局部 remaining
                // 场景: 上一轮 watchResult 低报/漏报，异步 refresh 或 refreshTrackedPolyFills
                //        已发现"迟到成交"并更新了 ctx.totalHedged，此时 remaining 已过时
                const currentUnhedged = ctx.totalPredictFilled - ctx.totalHedged;
                if (currentUnhedged < MIN_HEDGE_QTY) {
                    console.log(`[TaskExecutor] Hedge calibration: totalHedged=${ctx.totalHedged.toFixed(4)} covers totalPredictFilled=${ctx.totalPredictFilled.toFixed(4)}, done`);
                    break;
                }
                if (currentUnhedged < remaining) {
                    console.log(`[TaskExecutor] Hedge calibration: remaining ${remaining.toFixed(4)} → ${currentUnhedged.toFixed(4)} (async refresh discovered late fills)`);
                    remaining = currentUnhedged;
                }
                // Dust 检查：校准后 remaining 可能掉到 < $1 → break 避免下一轮拒单
                const loopNotional = this.estimateHedgeNotional(ctx, remaining);
                if (loopNotional < POLY_MIN_ORDER_NOTIONAL) {
                    console.log(`[TaskExecutor] Hedge loop break dust: remaining=${remaining.toFixed(4)}, notional=$${loopNotional.toFixed(2)} < $${POLY_MIN_ORDER_NOTIONAL}`);
                    break;
                }

                // 记录对冲尝试 (fire-and-forget)
                this.logFF('HEDGE_ATTEMPT', this.taskLogger.logHedgeEvent(task.id, 'HEDGE_ATTEMPT', {
                    hedgeQty: remaining,
                    totalHedged: ctx.totalHedged,
                    totalPredictFilled: ctx.totalPredictFilled,
                    avgHedgePrice: totalFilled > 0 ? priceSum / totalFilled : 0,
                    retryCount,
                }, attemptId));

                // 获取订单簿（体育: SportsService WS 缓存 → REST fallback，非体育: Poly WS 缓存 → REST fallback）
                const orderbook = await this.getPolymarketOrderbook(hedgeTokenId, task.isSportsMarket);
                if (!orderbook) {
                    throw new Error('Failed to get orderbook');
                }

                // 确定对冲方向和价格
                let hedgePrice: number;
                let hedgeSide: 'BUY' | 'SELL';

                const retryMaxAsk = roundToTick(
                    task.polymarketMaxAsk + HEDGE_RETRY_MAX_SLIPPAGE,
                    tickStep
                );
                const retryMinBid = roundToTick(
                    task.polymarketMinBid - HEDGE_RETRY_MAX_SLIPPAGE,
                    tickStep
                );

                if (side === 'BUY') {
                    // BUY 任务: 买入 Poly (NO/YES based on isInverted) 对冲
                    if (orderbook.asks.length === 0) {
                        throw new Error('No asks available');
                    }
                    hedgePrice = orderbook.asks[0].price;
                    hedgeSide = 'BUY';

                    // 逐级抬价: 取 orderbook best ask 和升级价格中的较大值
                    if (escalatedPrice !== undefined) {
                        hedgePrice = Math.max(hedgePrice, escalatedPrice);
                    }
                    hedgePrice = roundToTick(hedgePrice, tickStep);

                    // 重试上限 = 配置滑点 + 2 ticks
                    const maxAllowed = retryMaxAsk;
                    if (hedgePrice > maxAllowed) {
                        console.log(`[TaskExecutor] 价格升级已达上限: ${hedgePrice} > maxAllowed ${maxAllowed} (maxAsk=${task.polymarketMaxAsk} + retryMaxTicks=${HEDGE_RETRY_MAX_TICKS}), 停止对冲`);
                        break;
                    }
                } else {
                    // SELL 任务: 卖出 Poly (NO/YES based on isInverted) 对冲
                    if (orderbook.bids.length === 0) {
                        throw new Error('No bids available');
                    }
                    hedgePrice = orderbook.bids[0].price;
                    hedgeSide = 'SELL';

                    // 逐级降价: 取 orderbook best bid 和升级价格中的较小值
                    if (escalatedPrice !== undefined) {
                        hedgePrice = Math.min(hedgePrice, escalatedPrice);
                    }
                    hedgePrice = roundToTick(hedgePrice, tickStep);

                    // 重试下限 = 配置滑点 + 2 ticks
                    const minAllowed = retryMinBid;
                    if (hedgePrice < minAllowed) {
                        console.log(`[TaskExecutor] 价格降级已达下限: ${hedgePrice} < minAllowed ${minAllowed} (minBid=${task.polymarketMinBid} - retryMaxTicks=${HEDGE_RETRY_MAX_TICKS}), 停止对冲`);
                        break;
                    }
                }

                // 提交 Polymarket IOC 订单
                const tPolyOrderStart = Date.now();
                const polyResult = await this.polyTrader.placeOrder({
                    tokenId: hedgeTokenId,
                    side: hedgeSide,
                    price: hedgePrice,
                    quantity: remaining,
                    orderType: 'IOC',
                    negRisk: task.negRisk,  // negRisk 市场需要使用不同的合约地址签名
                    marketTitle: task.title,  // 市场标题用于 TG 通知
                    conditionId: task.polymarketConditionId,  // 用于从 poly-slugs 查找标题
                });
                const tPolyOrderEnd = Date.now();

                if (!polyResult.success) {
                    throw new Error(`Polymarket order failed: ${polyResult.error}`);
                }

                // 记录 Polymarket 订单提交 (fire-and-forget)
                this.logFF('ORDER_SUBMITTED(poly)', this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                    platform: 'polymarket',
                    orderId: polyResult.orderId!,
                    side: hedgeSide,
                    price: hedgePrice,
                    quantity: polyResult.submittedQuantity ?? remaining,
                    filledQty: 0,
                    remainingQty: polyResult.submittedQuantity ?? remaining,
                    avgPrice: 0,
                }));

                this.updateTask(task.id, {
                    status: 'HEDGING',
                    currentPolyOrderId: polyResult.orderId,
                });

                // 追踪本次进程内创建的 Poly 订单，用于“迟到成交”再确认
                if (!ctx.polyOrderFills.has(polyResult.orderId!)) {
                    ctx.polyOrderFills.set(polyResult.orderId!, {
                        filledQty: 0,
                        rawFilledQty: 0,
                        targetQty: remaining,
                        avgPrice: hedgePrice,
                        lastCheckedAt: 0,
                        accountForBuyFees: hedgeSide === 'BUY',
                        feeRate: polyResult.feeRate ?? 0,
                        feeExponent: polyResult.feeExponent ?? 1,
                    });
                }

                // 等待成交（WS+REST 双轨，intervalMs=250 加速 IOC 确认）
                const tWatchStart = Date.now();
                const hedgeResult = await new Promise<OrderWatchResult>((resolve) => {
                    this.orderMonitor.watchPolymarketOrder(
                        polyResult.orderId!,
                        (result) => resolve(result),
                        { timeoutMs: 2000, tradeWindowMs: 150 }
                    );
                });
                const tWatchEnd = Date.now();

                // 信任 watchResult (WS+REST 双轨已确认)，直接用于更新累计
                // 异步启动 refreshSinglePolyFill 做延迟校验（不阻塞下一步决策）
                const watchFilledQty = hedgeResult.filledQty;
                const watchAvgPrice = hedgePrice;

                // 先用 watchResult 立即更新
                const watchDelta = this.applyPolyFillDelta(ctx, polyResult.orderId!, watchFilledQty, watchAvgPrice);

                // 异步校验：不阻塞主流程，发现差异会通过 ctx.totalHedged 传递给下轮校准
                // 注意: watchFilledQty=0 时也必须启动，否则"迟到成交"无法被及时发现
                this.refreshSinglePolyFill(ctx, polyResult.orderId!, {
                    fallbackFilledQty: watchFilledQty,
                    fallbackAvgPrice: watchAvgPrice,
                    force: true,
                }).catch(err => {
                    console.warn(`[TaskExecutor] Async refresh failed for ${polyResult.orderId!.slice(0, 10)}...: ${err.message}`);
                });

                if (watchDelta > 0) {
                    totalFilled += watchDelta;
                    priceSum += watchDelta * watchAvgPrice;
                    remaining -= watchDelta;

                    // 用实际成交价刷新估算价（供 checkShouldHedge 同步判定）
                    ctx.lastHedgePriceEstimate = hedgePrice;

                    // 记录 Polymarket 订单成交 (fire-and-forget)
                    const orderEventType = remaining <= 0 ? 'ORDER_FILLED' : 'ORDER_PARTIAL_FILL';
                    this.logFF(orderEventType + '(poly)', this.taskLogger.logOrderEvent(task.id, orderEventType, {
                        platform: 'polymarket',
                        orderId: polyResult.orderId!,
                        side: hedgeSide,
                        price: hedgePrice,
                        quantity: quantity,
                        filledQty: watchFilledQty,
                        remainingQty: remaining,
                        avgPrice: watchAvgPrice,
                    }));

                    // 记录部分对冲 (fire-and-forget)
                    if (remaining > 0) {
                        this.logFF('HEDGE_PARTIAL', this.taskLogger.logHedgeEvent(task.id, 'HEDGE_PARTIAL', {
                            hedgeQty: watchDelta,
                            totalHedged: ctx.totalHedged,
                            totalPredictFilled: ctx.totalPredictFilled,
                            avgHedgePrice: totalFilled > 0 ? priceSum / totalFilled : 0,
                            retryCount,
                        }, attemptId));
                    }

                    const polyPlaceMs = tPolyOrderEnd - tPolyOrderStart;
                    const watchMs = tWatchEnd - tWatchStart;
                    console.log(
                        `[TaskExecutor] Hedge filled (watch): ${watchDelta} @ ${watchAvgPrice.toFixed(4)} ` +
                        `[polyPlace=${polyPlaceMs}ms, watch=${watchMs}ms]`,
                    );
                }

                if (remaining <= 0 || remaining < MIN_HEDGE_QTY) {
                    // 对冲成功，清除幽灵深度标记
                    ctx.phantomDepthDetected = false;

                    // 记录对冲完成 (fire-and-forget, 含耗时)
                    const fillRecvTs = ctx.lastFillRecvTs;
                    const hedgeCompleteTs = Date.now();
                    this.logFF('HEDGE_COMPLETED', this.taskLogger.logHedgeEvent(task.id, 'HEDGE_COMPLETED', {
                        hedgeQty: quantity,
                        totalHedged: ctx.totalHedged,
                        totalPredictFilled: ctx.totalPredictFilled,
                        avgHedgePrice: totalFilled > 0 ? priceSum / totalFilled : 0,
                        retryCount,
                        elapsedMs: fillRecvTs ? hedgeCompleteTs - fillRecvTs : undefined,
                    }, attemptId));

                    return {
                        success: true,
                        filledQty: totalFilled,
                        avgPrice: totalFilled > 0 ? priceSum / totalFilled : 0,
                    };
                }

                // 幽灵深度检测: 订单簿显示有深度但 IOC 0 成交
                // 立即取消 Predict 挂单，防止在对冲重试期间继续成交扩大敞口
                if (watchDelta === 0 && ctx.currentOrderHash) {
                    console.warn(`[TaskExecutor] 🛑 幽灵深度: 订单簿有 ${hedgePrice} asks 但 IOC 0 成交，取消 Predict 订单防止继续成交`);
                    ctx.phantomDepthDetected = true;
                    // 反馈全局幽灵深度 tracker（覆盖情况 B: 深度稳定但不可执行）
                    if (task.isSportsMarket) {
                        const hedgeTokenId_ = this.getHedgeTokenId(task);
                        getSportsService().reportPhantomFromIOC(hedgeTokenId_, side);
                    }
                    try {
                        const phantomCancelResult = await this.predictTrader.cancelOrder(ctx.currentOrderHash);
                        if (phantomCancelResult.success) {
                            ctx.currentOrderHash = undefined;
                            console.log(`[TaskExecutor] ✓ Predict 订单已取消 (幽灵深度保护)`);
                        } else {
                            console.warn(`[TaskExecutor] ⚠️ 幽灵深度取消返回 false，保留 hash 待恢复重试`);
                        }
                    } catch (e: any) {
                        console.warn(`[TaskExecutor] ⚠️ 取消 Predict 订单出错: ${e.message}`);
                    }
                }

                // 部分成交，取消剩余订单后再重试
                // 防止 IOC 订单剩余部分继续在 orderbook 等待，导致重复对冲
                try {
                    console.log(`[TaskExecutor] Cancelling remaining order ${polyResult.orderId!.slice(0, 10)}... before retry`);
                    await this.polyTrader.cancelOrder(polyResult.orderId!, {
                        skipTelegram: true,  // 内部操作，不发 TG 通知
                    });
                } catch (cancelErr: any) {
                    // 取消失败不阻塞流程，可能订单已经被取消或完全成交
                    console.warn(`[TaskExecutor] Cancel order failed (may already be cancelled): ${cancelErr.message}`);
                }

                retryCount++;

                // IOC 0 fill 时，重试直接跳到“配置滑点上限 + 2 ticks”
                if (watchDelta === 0) {
                    if (side === 'BUY') {
                        const directRetryPrice = retryMaxAsk;
                        if (escalatedPrice === directRetryPrice) {
                            console.log(`[TaskExecutor] IOC 0 成交，重试价已在上限 ${directRetryPrice.toFixed(4)}，保持不变`);
                        } else {
                            escalatedPrice = directRetryPrice;
                            console.log(`[TaskExecutor] IOC 0 成交，价格直接升级到重试上限: ${hedgePrice.toFixed(4)} → ${escalatedPrice.toFixed(4)} (maxAsk=${task.polymarketMaxAsk.toFixed(4)}, retryMaxTicks=${HEDGE_RETRY_MAX_TICKS})`);
                        }
                    } else {
                        const directRetryPrice = retryMinBid;
                        if (escalatedPrice === directRetryPrice) {
                            console.log(`[TaskExecutor] IOC 0 成交，重试价已在下限 ${directRetryPrice.toFixed(4)}，保持不变`);
                        } else {
                            escalatedPrice = directRetryPrice;
                            console.log(`[TaskExecutor] IOC 0 成交，价格直接降到重试下限: ${hedgePrice.toFixed(4)} → ${escalatedPrice.toFixed(4)} (minBid=${task.polymarketMinBid.toFixed(4)}, retryMaxTicks=${HEDGE_RETRY_MAX_TICKS})`);
                        }
                    }
                }

                // watchDelta>0: 已确认成交，快速重试; watchDelta=0: 价格已升级，缩短等待快速重试
                await this.delay(watchDelta > 0 ? 100 : 200);

            } catch (error: any) {
                retryCount++;
                const errorMsg = error.message || String(error);
                console.warn(`[TaskExecutor] Hedge attempt ${retryCount} failed:`, errorMsg);

                // 记录对冲尝试失败的详细原因 (fire-and-forget)
                this.logFF('HEDGE_ATTEMPT(fail)', this.taskLogger.logHedgeEvent(task.id, 'HEDGE_ATTEMPT', {
                    hedgeQty: remaining,
                    totalHedged: ctx.totalHedged,
                    totalPredictFilled: ctx.totalPredictFilled,
                    avgHedgePrice: totalFilled > 0 ? priceSum / totalFilled : 0,
                    retryCount,
                    error: { errorType: 'Error', message: errorMsg, stack: error.stack },
                }, attemptId));

                this.updateTask(task.id, {
                    hedgeRetryCount: retryCount,
                    error: errorMsg,
                });

                if (retryCount < task.maxHedgeRetries) {
                    await this.delay(Math.min(500 * retryCount, 2000));  // 500ms, 1s, 2s (capped)
                }
            }
        }

        // 记录对冲失败 (fire-and-forget)
        if (totalFilled < quantity) {
            this.logFF('HEDGE_FAILED', this.taskLogger.logHedgeEvent(task.id, 'HEDGE_FAILED', {
                hedgeQty: quantity,
                totalHedged: ctx.totalHedged,
                totalPredictFilled: ctx.totalPredictFilled,
                avgHedgePrice: totalFilled > 0 ? priceSum / totalFilled : 0,
                retryCount,
                error: new Error(`Hedge incomplete: ${totalFilled}/${quantity}`),
            }, attemptId));
        }

        // 返回部分成交结果
        return {
            success: (quantity - totalFilled) < MIN_HEDGE_QTY,
            filledQty: totalFilled,
            avgPrice: totalFilled > 0 ? priceSum / totalFilled : 0,
        };

        } finally {
            ctx.isHedgingInProgress = false;
        }
    }

    /**
     * 处理对冲失败: 先尝试 GTC 保底，失败则标记 HEDGE_FAILED
     */
    private async executeUnwind(ctx: TaskContext): Promise<void> {
        let task = ctx.task;

        // unwind 需要准确的 totalHedged，必须等待刷新完成
        await this.refreshTrackedPolyFills(ctx).catch(err => {
            console.warn(`[TaskExecutor] refreshTrackedPolyFills error:`, err.message);
        });

        const unhedgedQty = ctx.totalPredictFilled - ctx.totalHedged;

        if (unhedgedQty <= 0) {
            console.log('[TaskExecutor] No unhedged position');
            return;
        }

        // 计算潜在损失（仅用于记录）
        const estimatedLoss = this.calculateUnwindLoss(task, ctx, unhedgedQty);

        console.warn(`[TaskExecutor] ⚠️ HEDGE_FAILED: ${unhedgedQty} shares unhedged (Predict filled: ${ctx.totalPredictFilled}, hedged: ${ctx.totalHedged})`);

        // 取消 Predict 端挂单，防止继续成交扩大裸露头寸
        const hashToCancel = ctx.currentOrderHash;
        if (hashToCancel) {
            ctx.currentOrderHash = undefined;
            this.updateTask(task.id, { currentOrderHash: undefined });
            try {
                const cancelResult = await this.predictTrader.cancelOrder(hashToCancel);
                console.log(`[TaskExecutor] executeUnwind: cancelled Predict order ${hashToCancel.slice(0, 16)}... result=${cancelResult.action}`);
                await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                    platform: 'predict',
                    orderId: hashToCancel,
                    side: task.type,
                    outcome: task.arbSide || 'YES',
                    price: task.predictPrice,
                    quantity: task.quantity,
                    filledQty: ctx.totalPredictFilled,
                    remainingQty: 0,
                    avgPrice: task.predictPrice,
                    cancelReason: 'HEDGE_FAILED auto-cancel',
                }, hashToCancel).catch(() => {});
            } catch (e: any) {
                console.error(`[TaskExecutor] executeUnwind: cancel order ${hashToCancel.slice(0, 16)}... failed: ${e.message}`);
            }
        }

        // ========== GTC 保底对冲 ==========
        // executeIncrementalHedge 已包含逐级价格升级 (asks[0] → +2% 滑点)，
        // 到此处说明 IOC 已穷尽价格范围，直接下 GTC 保本价挂单
        const remainingUnhedged = unhedgedQty;
        const updatedEstimatedLoss = estimatedLoss;
        console.log(`[TaskExecutor] executeUnwind: IOC 价格升级已穷尽，${remainingUnhedged.toFixed(2)} 股未对冲，下 GTC 保底`);
        const gtcPlaced = await this.placeGtcFallbackHedge(ctx, remainingUnhedged, updatedEstimatedLoss);

        if (!gtcPlaced) {
            // GTC 挂单失败，回退到原有 HEDGE_FAILED 逻辑
            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                status: 'HEDGE_FAILED',
                previousStatus: task.status,
                reason: `Hedge failed, ${remainingUnhedged.toFixed(2)} shares unhedged, est. loss: $${updatedEstimatedLoss.toFixed(2)} (GTC fallback also failed)`,
            });

            this.updateTask(task.id, {
                status: 'HEDGE_FAILED',
                error: `Hedge failed, ${remainingUnhedged.toFixed(2)} shares unhedged, GTC fallback failed`,
                remainingQty: remainingUnhedged,
                completedAt: Date.now(),
            });

            await this.taskLogger.generateSummary(task.id, {
                type: task.type,
                marketId: task.marketId,
                title: task.title,
                status: 'HEDGE_FAILED',
                predictFilledQty: ctx.totalPredictFilled,
                hedgedQty: ctx.totalHedged,
                avgPredictPrice: task.predictPrice,
                avgPolymarketPrice: ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0,
                actualProfit: 0,
                unwindLoss: 0,
                pauseCount: task.pauseCount,
                hedgeRetryCount: task.hedgeRetryCount,
                createdAt: task.createdAt,
            });
        }
    }

    /**
     * GTC 保底对冲：以保本价在 Polymarket 挂 GTC 限价单
     *
     * 当 IOC 对冲重试全部失败后，作为最后防线挂出 GTC 限价单。
     * 价格 = 1 - predictPrice（保本价），确保成交时零利润零损失。
     *
     * @returns true = GTC 挂单成功, false = 挂单失败
     */
    private async placeGtcFallbackHedge(
        ctx: TaskContext,
        unhedgedQty: number,
        estimatedLoss: number
    ): Promise<boolean> {
        const task = ctx.task;

        // 保本价: 1 - predictPrice (整数运算避免浮点精度)
        const breakevenPrice = Math.round((1 - task.predictPrice) * 1e4) / 1e4;
        const gtcPrice = Math.max(0.01, Math.min(0.99, breakevenPrice));

        // 数量精确到小数点后 1 位
        const gtcQty = Math.floor(unhedgedQty * 10) / 10;

        // 检查 Polymarket $1 最小名义金额
        const notional = gtcQty * gtcPrice;
        if (notional < MIN_HEDGE_NOTIONAL) {
            console.warn(`[TaskExecutor] GTC 保底: 名义金额 $${notional.toFixed(2)} < $${MIN_HEDGE_NOTIONAL}，无法挂单`);
            this.emitStageAlert('🚨', 'PREDICT_MAKER', 'UNWIND_GTC_TOO_SMALL', task.id, [
                `市场: ${task.title}`,
                `阶段: IOC 重试已穷尽，准备进入 Polymarket GTC 保底`,
                `未对冲: ${this.formatAlertNumber(unhedgedQty, 2)} 股`,
                `GTC价格: ${gtcPrice.toFixed(4)} (保本价)`,
                `名义金额: $${notional.toFixed(2)} < $${MIN_HEDGE_NOTIONAL}`,
                '动作: 无法挂单，需立即人工干预',
            ]);
            return false;
        }

        // 确定对冲方向和 tokenId — 复用 getHedgeTokenId 确保与其他路径一致
        const hedgeSide: 'BUY' | 'SELL' = task.type === 'BUY' ? 'BUY' : 'SELL';
        const hedgeTokenId = this.getHedgeTokenId(task);

        console.log(`[TaskExecutor] GTC 保底对冲: ${gtcQty} 股 @ ${gtcPrice} (breakeven=${breakevenPrice}), side=${hedgeSide}, token=${hedgeTokenId.slice(0, 16)}...`);

        const attemptId = Math.random().toString(36).substring(2, 10);

        try {
            const gtcResult = await this.polyTrader.placeOrder({
                tokenId: hedgeTokenId,
                side: hedgeSide,
                price: gtcPrice,
                quantity: gtcQty,
                orderType: 'GTC',
                negRisk: task.negRisk,
                marketTitle: task.title,
                conditionId: task.polymarketConditionId,
            });

            if (!gtcResult.success) {
                console.error(`[TaskExecutor] GTC 保底挂单失败: ${gtcResult.error}`);
                this.emitStageAlert('🚨', 'PREDICT_MAKER', 'UNWIND_GTC_SUBMIT_FAILED', task.id, [
                    `市场: ${task.title}`,
                    `阶段: IOC 重试已穷尽，尝试 Polymarket GTC 保底失败`,
                    `未对冲: ${this.formatAlertNumber(unhedgedQty, 2)} 股`,
                    `GTC价格: ${gtcPrice.toFixed(4)} (保本价)`,
                    `原因: ${gtcResult.error}`,
                    '动作: 需立即人工干预',
                ]);
                return false;
            }

            const gtcOrderId = gtcResult.orderId!;

            // 记录 GTC 订单提交
            await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                platform: 'polymarket',
                orderId: gtcOrderId,
                side: hedgeSide,
                price: gtcPrice,
                quantity: gtcQty,
                filledQty: 0,
                remainingQty: gtcQty,
                avgPrice: 0,
            });

            await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_STARTED', {
                hedgeQty: gtcQty,
                totalHedged: ctx.totalHedged,
                totalPredictFilled: ctx.totalPredictFilled,
                avgHedgePrice: gtcPrice,
                retryCount: 0,
                reason: 'GTC fallback hedge',
            }, attemptId);

            // 更新任务状态为 HEDGE_FAILED_GTC_PENDING
            this.updateTask(task.id, {
                status: 'HEDGE_FAILED_GTC_PENDING',
                currentPolyOrderId: gtcOrderId,
                error: `GTC 保底挂单 ${gtcQty} @ ${gtcPrice}`,
                remainingQty: unhedgedQty,
            });

            // TG 置顶警报
            this.emitStageAlert('⚠️', 'PREDICT_MAKER', 'UNWIND_GTC_FALLBACK', task.id, [
                `市场: ${task.title}`,
                `Predict成交: ${this.formatAlertNumber(ctx.totalPredictFilled, 2)} 股 @ ${task.predictPrice}`,
                `已对冲: ${this.formatAlertNumber(ctx.totalHedged, 2)} 股`,
                `剩余未对冲: ${this.formatAlertNumber(unhedgedQty, 2)} 股`,
                `GTC挂单: ${this.formatAlertNumber(gtcQty, 2)} 股 @ ${gtcPrice.toFixed(4)} (保本价)`,
                `orderId: ${gtcOrderId}`,
                '动作: 已注册 WS 自动跟踪',
            ]);

            // 注册 User WS 监听器追踪 GTC 成交
            this.registerGtcFillWatcher(task.id, gtcOrderId, gtcQty, gtcPrice, ctx);

            return true;
        } catch (err: any) {
            console.error(`[TaskExecutor] GTC 保底异常: ${err.message}`);
            this.emitStageAlert('🚨', 'PREDICT_MAKER', 'UNWIND_GTC_EXCEPTION', task.id, [
                `市场: ${task.title}`,
                `阶段: IOC 重试已穷尽，尝试 Polymarket GTC 保底时抛异常`,
                `未对冲: ${this.formatAlertNumber(unhedgedQty, 2)} 股`,
                `GTC价格: ${gtcPrice.toFixed(4)} (保本价)`,
                `异常: ${err.message}`,
                '动作: 需立即人工干预',
            ]);
            return false;
        }
    }

    /**
     * 注册 User WS 监听器追踪 GTC 保底订单成交
     *
     * 监听 OrderEvent:
     * - 完全成交: 状态 → COMPLETED, TG 通知
     * - 取消: 状态 → HEDGE_FAILED, TG 置顶警报
     */
    private registerGtcFillWatcher(
        taskId: string,
        orderId: string,
        gtcQty: number,
        gtcPrice: number,
        ctx: TaskContext
    ): void {
        // 清理旧监听器
        this.removeGtcWatcher(taskId);

        const userWs = this.polyTrader.getUserWsClient();
        if (!userWs) {
            console.warn(`[TaskExecutor] GTC watcher: User WS 不可用，降级为不监控 (需手动关注)`);
            return;
        }

        const listenerId = userWs.addOrderEventListener((event) => {
            if (event.id !== orderId) return;

            const sizeMatched = parseFloat(event.size_matched || '0');
            const originalSize = parseFloat(event.original_size || '0');

            if (event.type === 'CANCELLATION') {
                console.warn(`[TaskExecutor] GTC 保底订单被取消: ${orderId}, filled=${sizeMatched}`);
                this.removeGtcWatcher(taskId);

                if (sizeMatched > 0) {
                    ctx.totalHedged += sizeMatched;
                    ctx.hedgePriceSum += sizeMatched * gtcPrice;
                }

                const stillUnhedged = ctx.totalPredictFilled - ctx.totalHedged;

                this.updateTask(taskId, {
                    status: 'HEDGE_FAILED',
                    hedgedQty: ctx.totalHedged,
                    remainingQty: stillUnhedged,
                    completedAt: Date.now(),
                    error: `GTC 保底订单被取消, 成交 ${sizeMatched}/${gtcQty}, 仍有 ${stillUnhedged.toFixed(1)} 未对冲`,
                });

                this.taskLogger.logTaskLifecycle(taskId, 'TASK_FAILED', {
                    status: 'HEDGE_FAILED',
                    previousStatus: 'HEDGE_FAILED_GTC_PENDING',
                    reason: `GTC cancelled, filled ${sizeMatched}/${gtcQty}, ${stillUnhedged} shares still unhedged`,
                }).catch(() => {});

                this.emitStageAlert('🚨', 'PREDICT_MAKER', 'UNWIND_GTC_CANCELLED', taskId, [
                    `阶段: Polymarket GTC 保底订单被外部取消/终止`,
                    `orderId: ${orderId}`,
                    `保底价格: ${gtcPrice.toFixed(4)}`,
                    `GTC成交: ${this.formatAlertNumber(sizeMatched, 2)} / ${this.formatAlertNumber(gtcQty, 2)} 股`,
                    `剩余未对冲: ${this.formatAlertNumber(stillUnhedged, 2)} 股`,
                    '动作: 需立即人工干预',
                ]);
                return;
            }

            if (event.type === 'UPDATE') {
                if (originalSize > 0 && sizeMatched >= originalSize) {
                    console.log(`[TaskExecutor] ✅ GTC 保底订单完全成交: ${orderId}, filled=${sizeMatched}`);
                    this.removeGtcWatcher(taskId);

                    ctx.totalHedged += sizeMatched;
                    ctx.hedgePriceSum += sizeMatched * gtcPrice;

                    const avgHedgePrice = ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0;

                    this.updateTask(taskId, {
                        status: 'COMPLETED',
                        hedgedQty: ctx.totalHedged,
                        avgPolymarketPrice: avgHedgePrice,
                        remainingQty: 0,
                        completedAt: Date.now(),
                        error: undefined,
                    });

                    this.taskLogger.logHedgeEvent(taskId, 'HEDGE_COMPLETED', {
                        hedgeQty: sizeMatched,
                        totalHedged: ctx.totalHedged,
                        totalPredictFilled: ctx.totalPredictFilled,
                        avgHedgePrice: gtcPrice,
                        retryCount: 0,
                        reason: 'GTC fallback hedge completed',
                    }, Math.random().toString(36).substring(2, 10)).catch(() => {});

                    this.taskLogger.generateSummary(taskId, {
                        type: ctx.task.type,
                        marketId: ctx.task.marketId,
                        title: ctx.task.title,
                        status: 'COMPLETED',
                        predictFilledQty: ctx.totalPredictFilled,
                        hedgedQty: ctx.totalHedged,
                        avgPredictPrice: ctx.task.predictPrice,
                        avgPolymarketPrice: avgHedgePrice,
                        actualProfit: 0,
                        unwindLoss: 0,
                        pauseCount: ctx.task.pauseCount,
                        hedgeRetryCount: ctx.task.hedgeRetryCount,
                        createdAt: ctx.task.createdAt,
                    }).catch(() => {});

                    this.emitStageAlert('✅', 'PREDICT_MAKER', 'UNWIND_GTC_FILLED', taskId, [
                        `阶段: Polymarket GTC 保底订单完成`,
                        `orderId: ${orderId}`,
                        `成交: ${this.formatAlertNumber(sizeMatched, 2)} 股 @ ${gtcPrice.toFixed(4)} (保本价)`,
                        `累计对冲: ${this.formatAlertNumber(ctx.totalHedged, 2)} 股`,
                        '结果: 任务完成（保本收口）',
                    ]);
                } else if (sizeMatched > 0) {
                    console.log(`[TaskExecutor] GTC 保底部分成交: ${orderId}, filled=${sizeMatched}/${originalSize}`);
                }
            }
        });

        this.gtcWatchers.set(taskId, { listenerId, orderId });
        console.log(`[TaskExecutor] GTC watcher registered: taskId=${taskId}, orderId=${orderId.slice(0, 16)}...`);
    }

    /**
     * 清理 GTC WS 监听器
     */
    private removeGtcWatcher(taskId: string): void {
        const watcher = this.gtcWatchers.get(taskId);
        if (!watcher) return;

        const userWs = this.polyTrader.getUserWsClient();
        if (userWs) {
            userWs.removeOrderEventListener(watcher.listenerId);
        }
        this.gtcWatchers.delete(taskId);
        console.log(`[TaskExecutor] GTC watcher removed: taskId=${taskId}`);
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    private async submitPredictOrder(
        task: Task,
        side: 'BUY' | 'SELL'
    ): Promise<{ success: boolean; hash?: string; error?: string }> {
        // 根据套利方向选择 outcome:
        // - YES 端套利: Predict 交易 YES token
        // - NO 端套利: Predict 交易 NO token
        const outcome = task.arbSide || 'YES';

        const input: PredictOrderInput = {
            marketId: task.marketId,
            side,
            price: task.predictPrice,
            quantity: task.quantity,
            outcome,  // 传递套利方向对应的 token
            // 有 expiresAt 的任务：订单过期 = 任务过期，作为链上兜底风控
            ...(task.expiresAt ? { expiresAt: new Date(task.expiresAt) } : {}),
        };

        return this.predictTrader.placeOrder(input);
    }

    /**
     * 检查挂单价格是否安全（不会立即被吃单）
     *
     * BUY: 挂单价 < 卖一价 (确保以 Maker 身份挂在买盘)
     * SELL: 挂单价 > 买一价 (确保以 Maker 身份挂在卖盘)
     *
     * 如果挂单价 >= 卖一价 (BUY) 或 <= 买一价 (SELL)，说明会被立即成交为 Taker
     */
    private isPredictPriceSafeForMakerWithBook(
        task: Task,
        side: 'BUY' | 'SELL',
        book: { bids: [number, number][]; asks: [number, number][] }
    ): { safe: boolean; reason?: string } {
        // Predict API orderbook 基于 YES 侧。
        // arbSide='NO' 时 predictPrice 是 NO 价格，需要转换:
        //   NO bestAsk = 1 - YES bestBid
        //   NO bestBid = 1 - YES bestAsk
        const isNoSide = (task.arbSide || 'YES') === 'NO';

        const PRICE_EPSILON = 1e-9;

        if (side === 'BUY') {
            // BUY: 挂单价必须 < 卖一价
            let bestAsk: number | null;
            if (isNoSide) {
                // NO BUY: NO bestAsk = 1 - YES bestBid
                const yesBestBid = book.bids.length > 0 ? book.bids[0][0] : null;
                bestAsk = yesBestBid !== null ? Number((1 - yesBestBid).toFixed(4)) : null;
            } else {
                bestAsk = book.asks.length > 0 ? book.asks[0][0] : null;
            }
            if (bestAsk !== null && task.predictPrice >= bestAsk - PRICE_EPSILON) {
                return {
                    safe: false,
                    reason: `BUY ${isNoSide ? 'NO' : 'YES'} price ${task.predictPrice} >= bestAsk ${bestAsk}`,
                };
            }
        } else {
            // SELL: 挂单价必须 > 买一价
            let bestBid: number | null;
            if (isNoSide) {
                // NO SELL: NO bestBid = 1 - YES bestAsk
                const yesBestAsk = book.asks.length > 0 ? book.asks[0][0] : null;
                bestBid = yesBestAsk !== null ? Number((1 - yesBestAsk).toFixed(4)) : null;
            } else {
                bestBid = book.bids.length > 0 ? book.bids[0][0] : null;
            }
            if (bestBid !== null && task.predictPrice <= bestBid + PRICE_EPSILON) {
                return {
                    safe: false,
                    reason: `SELL ${isNoSide ? 'NO' : 'YES'} price ${task.predictPrice} <= bestBid ${bestBid}`,
                };
            }
        }

        return { safe: true };
    }

    private async isPredictPriceSafeForMaker(task: Task, side: 'BUY' | 'SELL'): Promise<{ safe: boolean; reason?: string }> {
        try {
            const book = await this.predictTrader.getOrderbook(task.marketId);
            if (!book) {
                return { safe: false, reason: 'orderbook unavailable, blocking for safety' };
            }
            return this.isPredictPriceSafeForMakerWithBook(task, side, book);
        } catch {
            return { safe: false, reason: 'price check exception, blocking for safety' };
        }
    }

    /**
     * 恢复下单前的订单簿门禁
     * 使用 WS 缓存（低延迟）+ 价格安全检查，直到通过或中止
     *
     * 价格保护恢复时增加额外安全机制（防止 maker 变 taker）：
     * 1. 如果我们的挂单价位有同方向深度（安全垫），立即通过
     * 2. 如果没有安全垫，等待 5 秒后再做一次检测，通过才恢复
     */
    private async waitForFreshBookAndSafePrice(params: {
        task: Task;
        side: 'BUY' | 'SELL';
        signal: AbortSignal;
        tag: string;
        maxAttempts?: number;
        maxWaitMs?: number;
    }): Promise<{ ok: boolean; reason?: string; attempts: number; waitedMs: number }> {
        const { task, side, signal, tag, maxAttempts = 0 } = params;
        // 默认超时 4 小时，防止已结束市场永久阻塞
        const maxWaitMs = params.maxWaitMs ?? 4 * 60 * 60 * 1000;
        const startTime = Date.now();
        let attempts = 0;
        const isPriceRecovery = tag === 'price-recovery';

        /** 递增退避: 前 10 次 500ms, 10-60 次 2s, 60+ 次 5s */
        const getGateDelay = () => {
            if (attempts < 10) return 500;
            if (attempts < 60) return 2000;
            return 5000;
        };

        console.log(`[RESUME_GATE] start tag=${tag}, task=${task.id}, marketId=${task.marketId}, maxWaitMs=${maxWaitMs}`);

        while (true) {
            if (signal.aborted) {
                return { ok: false, reason: 'aborted', attempts, waitedMs: Date.now() - startTime };
            }

            attempts++;

            if (maxAttempts > 0 && attempts > maxAttempts) {
                return { ok: false, reason: 'max attempts exceeded', attempts: maxAttempts, waitedMs: Date.now() - startTime };
            }

            // 超时保护：防止已结束/死亡市场的任务永久阻塞
            const elapsed = Date.now() - startTime;
            if (maxWaitMs > 0 && elapsed >= maxWaitMs) {
                console.warn(`[RESUME_GATE] timeout tag=${tag}, task=${task.id}, attempts=${attempts}, waited=${elapsed}ms`);
                return { ok: false, reason: 'timeout', attempts, waitedMs: elapsed };
            }

            // 使用 WS 缓存订单簿（低延迟），替代 REST（1-3s 延迟）
            const book = await this.predictTrader.getOrderbook(task.marketId);
            if (!book) {
                if (attempts <= 1 || attempts % 120 === 0) {
                    console.log(`[RESUME_GATE] book unavailable tag=${tag}, attempt=${attempts}`);
                }
                await this.delay(getGateDelay());
                continue;
            }

            const check = this.isPredictPriceSafeForMakerWithBook(task, side, book);
            if (!check.safe) {
                // 每 60 次打印一次，防止日志风暴
                if (attempts <= 1 || attempts % 60 === 0) {
                    console.log(`[RESUME_GATE] unsafe tag=${tag}, reason=${check.reason}, attempt=${attempts}, elapsed=${Math.round((Date.now() - startTime) / 1000)}s`);
                }
                await this.delay(getGateDelay());
                continue;
            }

            // 价格保护恢复：额外安全机制
            if (isPriceRecovery) {
                const hasCushion = this.hasSameSideDepthAtPrice(task, side, book);
                if (hasCushion) {
                    const waitedMs = Date.now() - startTime;
                    console.log(`[RESUME_GATE] passed (cushion) tag=${tag}, attempts=${attempts}, waited=${waitedMs}ms`);
                    return { ok: true, attempts, waitedMs };
                }

                // 无安全垫：等 5 秒后再检测一次
                console.log(`[RESUME_GATE] no cushion tag=${tag}, waiting 5s for confirmation...`);
                await this.delay(5000);

                if (signal.aborted) {
                    return { ok: false, reason: 'aborted', attempts, waitedMs: Date.now() - startTime };
                }

                const book2 = await this.predictTrader.getOrderbook(task.marketId);
                if (!book2) {
                    console.log(`[RESUME_GATE] book unavailable after wait tag=${tag}`);
                    continue;  // 回到主循环重试
                }

                const check2 = this.isPredictPriceSafeForMakerWithBook(task, side, book2);
                if (!check2.safe) {
                    console.log(`[RESUME_GATE] unsafe after 5s wait tag=${tag}, reason=${check2.reason}`);
                    continue;  // 回到主循环重试
                }
            }

            const waitedMs = Date.now() - startTime;
            console.log(`[RESUME_GATE] passed tag=${tag}, attempts=${attempts}, waited=${waitedMs}ms`);
            return { ok: true, attempts, waitedMs };
        }
    }

    /**
     * 检查我们的挂单价位是否有同方向深度（安全垫）
     *
     * BUY @ 0.50: 检查订单簿中 0.50 是否有 bid 存在（有人先排在我们前面）
     * SELL @ 0.50: 检查订单簿中 0.50 是否有 ask 存在
     *
     * arbSide='NO' 时需要价格转换：NO price = 1 - YES price
     */
    private hasSameSideDepthAtPrice(
        task: Task,
        side: 'BUY' | 'SELL',
        book: { bids: [number, number][]; asks: [number, number][] }
    ): boolean {
        const isNoSide = (task.arbSide || 'YES') === 'NO';
        const PRICE_EPSILON = 1e-4;

        if (side === 'BUY') {
            // BUY: 检查 bid 侧是否有我们价位的深度
            if (isNoSide) {
                // NO BUY: 我们的 NO 价格对应 YES 侧的 ask
                // NO bid @ predictPrice ↔ YES ask @ (1 - predictPrice)
                // 安全垫 = YES 侧 ask 价位有深度 → 有人在卖 YES，即有人在买 NO
                const targetYesAsk = Math.round((1 - task.predictPrice) * 1e4) / 1e4;
                return book.asks.some(([price, size]) =>
                    Math.abs(price - targetYesAsk) < PRICE_EPSILON && size > 0
                );
            } else {
                // YES BUY: 检查 bid 侧在我们挂单价位是否有深度
                return book.bids.some(([price, size]) =>
                    Math.abs(price - task.predictPrice) < PRICE_EPSILON && size > 0
                );
            }
        } else {
            // SELL: 检查 ask 侧是否有我们价位的深度
            if (isNoSide) {
                // NO SELL: NO ask @ predictPrice ↔ YES bid @ (1 - predictPrice)
                const targetYesBid = Math.round((1 - task.predictPrice) * 1e4) / 1e4;
                return book.bids.some(([price, size]) =>
                    Math.abs(price - targetYesBid) < PRICE_EPSILON && size > 0
                );
            } else {
                // YES SELL: 检查 ask 侧在我们挂单价位是否有深度
                return book.asks.some(([price, size]) =>
                    Math.abs(price - task.predictPrice) < PRICE_EPSILON && size > 0
                );
            }
        }
    }

    /**
     * 获取对冲用的 Polymarket token ID
     *
     * 套利逻辑:
     * - YES 端套利 (arbSide='YES'): Predict 买 YES → Polymarket 买 NO
     * - NO 端套利 (arbSide='NO'): Predict 买 NO → Polymarket 买 YES
     *
     * isInverted 标记表示市场方向是否反转
     */
    private getHedgeTokenId(task: Task): string {
        const arbSide = task.arbSide || 'YES';

        if (arbSide === 'YES') {
            // YES 端套利: 对冲买 Poly NO (或 YES if inverted)
            return task.isInverted ? task.polymarketYesTokenId : task.polymarketNoTokenId;
        } else {
            // NO 端套利: 对冲买 Poly YES (或 NO if inverted)
            return task.isInverted ? task.polymarketNoTokenId : task.polymarketYesTokenId;
        }
    }

    /**
     * 计算 Polymarket 对冲可用深度
     *
     * @param tokenId 对冲代币 ID
     * @param side 对冲方向 (BUY/SELL)
     * @param maxPrice 最大可接受价格 (BUY 时使用)
     * @param minPrice 最小可接受价格 (SELL 时使用)
     * @param isSportsMarket 是否是体育市场 (体育市场使用 REST 回退)
     * @returns 在价格范围内的可用深度
     */
    private async getHedgeDepth(
        tokenId: string,
        side: 'BUY' | 'SELL',
        maxPrice: number,
        minPrice: number,
        isSportsMarket: boolean = false
    ): Promise<number> {
        try {
            const orderbook = await this.getPolymarketOrderbook(tokenId, isSportsMarket);
            if (!orderbook) {
                console.warn('[TaskExecutor] getHedgeDepth: orderbook is null (API failed)');
                return -1;  // 返回 -1 表示 API 失败，区别于真正的 0 深度
            }

            let totalDepth = 0;

            // 浮点容差: 1e-9 防止 0.68 <= 0.6799999999999999 判断失败
            const PRICE_EPSILON = 1e-9;

            if (side === 'BUY') {
                // 买入时看 asks，累计价格 <= maxPrice 的深度
                const bestAsk = orderbook.asks[0]?.price;
                for (const ask of orderbook.asks) {
                    if (ask.price <= maxPrice + PRICE_EPSILON) {
                        totalDepth += ask.size;
                    } else {
                        break; // asks 已排序，后面的价格更高
                    }
                }
                // totalDepth === 0 when bestAsk > maxPrice is normal market condition, no log needed
            } else {
                // 卖出时看 bids，累计价格 >= minPrice 的深度
                const bestBid = orderbook.bids[0]?.price;
                for (const bid of orderbook.bids) {
                    if (bid.price >= minPrice - PRICE_EPSILON) {
                        totalDepth += bid.size;
                    } else {
                        break; // bids 已排序，后面的价格更低
                    }
                }
                // totalDepth === 0 when bestBid < minPrice is normal market condition, no log needed
            }

            return totalDepth;
        } catch (err) {
            console.warn('[TaskExecutor] Failed to get hedge depth:', err);
            return -1;  // API 错误返回 -1
        }
    }

    /**
     * 启动深度监控
     *
     * 定期检查 Polymarket 对冲深度，如果深度不足：
     * 1. 取消当前 Predict 订单
     * 2. 调整任务数量为：已成交量 + 可用深度
     * 3. 重新下单
     */
    private startDepthMonitor(
        ctx: TaskContext,
        side: 'BUY' | 'SELL',
        hedgeTokenId: string,
        maxPrice: number,
        minPrice: number
    ): void {
        // 非体育市场: WS 覆盖高频检查，REST 轮询降为 3s 兜底
        // 体育市场原 200ms：依靠 WS 推送驱动深度/价格守护后大幅放宽，仅作为 PAUSED 恢复/扩量/isSubmitting 兜回的状态机心跳
        const BASE_DEPTH_CHECK_INTERVAL = ctx.task.isSportsMarket ? 5000 : 5000;
        const DEPTH_EXPAND_COOLDOWN_MS = 10_000; // 扩增冷却期，防止扩缩振荡
        const DEPTH_INCREASE_MIN_SHARES = 100;  // 深度增加低于此值忽略（减少优先原则）
        const PAUSED_AUTO_FAIL_MS = 2 * 60 * 60 * 1000; // PAUSED 超 2h 自动 FAIL

        /** 动态退避间隔：PAUSED 状态下逐步递增，减轻 EventLoop 压力 */
        const getNextInterval = (): number => {
            if (!ctx.isPaused) {
                return BASE_DEPTH_CHECK_INTERVAL;
            }
            const checks = ctx.depthPausedChecks;
            // 前 10 次: 基础间隔; 10-30 次: 5s; 30-60 次: 15s; 60+ 次: 30s
            if (checks < 10) return Math.max(BASE_DEPTH_CHECK_INTERVAL, 1000);
            if (checks < 30) return 5_000;
            if (checks < 60) return 15_000;
            return 30_000;
        };

        const scheduleNext = () => {
            const interval = getNextInterval();
            setTimeout(checkDepth, interval);
        };

        const checkDepth = async () => {
            // 互斥门禁：WS 和轮询共用，防止并发取消/重提
            if (ctx.depthCheckPending) return;
            ctx.depthCheckPending = true;
            try {
                await checkDepthInner();
            } finally {
                ctx.depthCheckPending = false;
            }
        };

        const checkDepthInner = async () => {
            if (ctx.signal.aborted || ctx.priceGuardAbort?.signal.aborted) return;

            // 检查任务是否已进入终态，避免在取消后继续操作
            const currentTask = this.taskService.getTask(ctx.task.id);
            const terminalStatuses: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'HEDGE_FAILED', 'UNWIND_COMPLETED'];
            if (!currentTask || terminalStatuses.includes(currentTask.status)) {
                console.log(`[TaskExecutor] Depth monitor: task ${ctx.task.id} in terminal state ${currentTask?.status}, stopping`);
                return;
            }

            // Collateral backoff: 余额不足时跳过本次检查，直接调度下一次
            if (ctx.collateralBackoffUntil && Date.now() < ctx.collateralBackoffUntil) {
                setTimeout(checkDepth, 60_000); // backoff 期间 60s 轮询
                return;
            }

            if (ctx.isPaused) {
                ctx.depthPausedChecks++;
                // 记录 PAUSED 起始时间
                if (!ctx.pausedSince) ctx.pausedSince = Date.now();
                // PAUSED 超 2h 自动 FAIL
                if (Date.now() - ctx.pausedSince >= PAUSED_AUTO_FAIL_MS) {
                    const mins = Math.round((Date.now() - ctx.pausedSince) / 60000);
                    console.error(`[TaskExecutor] Depth monitor: task ${ctx.task.id} PAUSED for ${mins}min, auto-failing`);
                    this.updateTask(ctx.task.id, {
                        status: 'FAILED',
                        error: `Auto-fail: PAUSED for ${mins}min without recovery`,
                    });
                    await this.taskLogger.logTaskLifecycle(ctx.task.id, 'TASK_FAILED', {
                        status: 'FAILED',
                        previousStatus: 'PAUSED',
                        reason: `PAUSED auto-fail after ${mins}min (depthChecks=${ctx.depthPausedChecks})`,
                    });
                    return; // 停止 depth monitor
                }
                // 全局幽灵深度: phantom 未清除时不恢复
                if (ctx.task.isSportsMarket) {
                    const isPhantom = getSportsService().isTokenPhantom(hedgeTokenId, side);
                    if (isPhantom) {
                        scheduleNext();
                        return;
                    }
                    // phantom 已清除，同步清除 ctx 标志
                    if (ctx.phantomDepthDetected) {
                        ctx.phantomDepthDetected = false;
                        console.log(`[TaskExecutor] 全局幽灵深度已恢复，允许 depth recovery`);
                    }
                }

                // 暂停时检查深度是否已恢复，如果恢复则重新提交订单
                // 以 totalQuantity 为上限，恢复到深度支持的最大数量
                const task = ctx.task;
                const originalRemaining = task.totalQuantity - ctx.totalPredictFilled;
                if (originalRemaining > 0) {
                    let recoveredDepth = await this.getHedgeDepth(hedgeTokenId, side, maxPrice, minPrice, task.isSportsMarket);
                    // API 失败 (返回 -1)，跳过本次检查
                    if (recoveredDepth < 0) {
                        scheduleNext();
                        return;
                    }
                    const recoverableQty = Math.min(originalRemaining, Math.floor(recoveredDepth));
                    if (recoverableQty >= DEPTH_INCREASE_MIN_SHARES) {
                        // REST 门禁 (30 分钟超时，防止死亡市场永久阻塞)
                        const gate = await this.waitForFreshBookAndSafePrice({
                            task, side, signal: ctx.signal, tag: 'depth-recovery',
                            maxWaitMs: 30 * 60 * 1000,
                        });
                        if (!gate.ok) {
                            if (gate.reason === 'timeout') {
                                console.error(`[TaskExecutor] Depth recovery gate timeout (${gate.waitedMs}ms), failing task ${task.id}`);
                                this.updateTask(task.id, {
                                    status: 'FAILED',
                                    error: `RESUME_GATE timeout: price never safe after ${Math.round(gate.waitedMs / 60000)}min`,
                                });
                                await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                                    status: 'FAILED',
                                    previousStatus: 'PAUSED',
                                    reason: `RESUME_GATE depth-recovery timeout after ${gate.attempts} attempts / ${Math.round(gate.waitedMs / 60000)}min`,
                                });
                                return; // 不再 setTimeout，停止 depth monitor
                            }
                            console.log(`[TaskExecutor] Depth recovered but REST gate failed (${gate.reason}), staying PAUSED`);
                            scheduleNext();
                            return;
                        }

                        // 防重: onPriceValid 可能在 async 间隙已恢复并提交了订单
                        if (!ctx.isPaused || ctx.currentOrderHash) {
                            console.log(`[TaskExecutor] Depth resume skipped: already resumed by another path (isPaused=${ctx.isPaused}, hash=${!!ctx.currentOrderHash})`);
                            scheduleNext();
                            return;
                        }

                        // 互斥: 防止 onPriceValid 与 checkDepth 并发提交
                        if (ctx.isSubmitting) {
                            console.log(`[TaskExecutor] Depth resume skipped: another path is submitting`);
                            scheduleNext();
                            return;
                        }
                        ctx.isSubmitting = true;
                        ctx.isDepthAdjusting = true;

                        // 再次检查 abort 状态（深度检测是异步的，期间可能任务已被取消）
                        if (ctx.signal.aborted || ctx.priceGuardAbort?.signal.aborted) {
                            console.log(`[TaskExecutor] Depth recovery aborted (task cancelled during async depth check)`);
                            ctx.isSubmitting = false;
                            ctx.isDepthAdjusting = false;
                            return;
                        }

                        // 再次检查任务终态（双重保险）
                        const currentTaskAfterDepthCheck = this.taskService.getTask(task.id);
                        const terminalStatuses: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'HEDGE_FAILED', 'UNWIND_COMPLETED'];
                        if (!currentTaskAfterDepthCheck || terminalStatuses.includes(currentTaskAfterDepthCheck.status)) {
                            console.log(`[TaskExecutor] Depth recovery aborted: task in terminal state ${currentTaskAfterDepthCheck?.status}`);
                            ctx.isSubmitting = false;
                            ctx.isDepthAdjusting = false;
                            return;
                        }

                        // 深度恢复：更新 task.quantity 到深度支持的量（不超过 totalQuantity）
                        const oldQuantity = task.quantity;
                        const newQuantity = ctx.totalPredictFilled + recoverableQty;
                        console.log(`[TaskExecutor] Depth recovered: ${recoveredDepth.toFixed(2)}, resumable=${recoverableQty}, resuming task`);

                        try {
                        // REST 门禁已通过，检查期间是否已被其他路径恢复或 abort
                        if (!ctx.isPaused) {
                            console.log(`[TaskExecutor] Depth recovery skipped: already resumed by another path`);
                            ctx.isSubmitting = false;
                            ctx.isDepthAdjusting = false;
                            scheduleNext();
                            return;
                        }
                        if (ctx.signal.aborted || ctx.priceGuardAbort?.signal.aborted) {
                            console.log(`[TaskExecutor] Depth recovery aborted before submit`);
                            ctx.isSubmitting = false;
                            ctx.isDepthAdjusting = false;
                            return;
                        }

                        // Bug C 修复: 深度恢复后、重下 Predict 单之前，若有历史悬空，先 force hedge 兜底
                        await this.forceHedgeResidual(ctx, side, 'depth_resume');

                        // 重新提交 Predict 订单
                        const taskWithRemaining = { ...task, quantity: recoverableQty };
                        const result = await this.submitPredictOrder(taskWithRemaining, side);
                        if (result.success) {
                            // 提交成功后再次检查任务状态（submitOrder 是异步的，期间任务可能被取消）
                            const taskAfterSubmit = this.taskService.getTask(task.id);
                            if (!taskAfterSubmit || terminalStatuses.includes(taskAfterSubmit.status)) {
                                console.log(`[TaskExecutor] Depth recovery: order submitted but task is ${taskAfterSubmit?.status}, cancelling new order`);
                                // 任务已终止，取消刚提交的订单
                                try {
                                    await this.predictTrader.cancelOrder(result.hash!);
                                } catch (e) {
                                    console.warn(`[TaskExecutor] Failed to cancel orphan order: ${e}`);
                                }
                                ctx.isSubmitting = false;
                                ctx.isDepthAdjusting = false;
                                return;
                            }

                            ctx.isPaused = false;
                            ctx.depthPausedChecks = 0;
                            ctx.pausedSince = undefined;
                            ctx.collateralBackoffUntil = undefined;
                            ctx.currentOrderHash = result.hash;

                            await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                                platform: 'predict',
                                orderId: result.hash!,
                                side: side,
                                price: task.predictPrice,
                                quantity: recoverableQty,
                                filledQty: 0,
                                remainingQty: recoverableQty,
                                avgPrice: 0,
                                adjustReason: `深度恢复: qty=${recoverableQty} (depth=${recoveredDepth.toFixed(2)})`,
                            }, result.hash);

                            // 如果 quantity 有扩增，记录 DEPTH_RESTORED
                            if (newQuantity > oldQuantity) {
                                await this.taskLogger.logTaskLifecycle(task.id, 'DEPTH_RESTORED', {
                                    status: 'PREDICT_SUBMITTED',
                                    reason: `Depth recovered: ${oldQuantity} → ${newQuantity} (depth=${recoveredDepth.toFixed(2)})`,
                                });
                            }

                            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_RESUMED', {
                                status: 'PREDICT_SUBMITTED',
                                previousStatus: 'PAUSED',
                                reason: `Depth recovered: ${recoveredDepth.toFixed(2)} shares, qty=${newQuantity}`,
                            });

                            ctx.task = this.updateTask(task.id, {
                                status: 'PREDICT_SUBMITTED',
                                quantity: newQuantity,
                                currentOrderHash: result.hash,
                                error: undefined,
                            });
                        } else {
                            console.warn(`[TaskExecutor] Depth recovered but re-submit failed: ${result.error}, staying PAUSED`);
                            // isPaused 未变，保持 PAUSED，下一轮 checkDepth 重试
                        }
                        } finally {
                            ctx.isSubmitting = false;
                            ctx.isDepthAdjusting = false;
                        }
                    }
                }
                scheduleNext();
                return;
            }

            const task = ctx.task;
            const remainingQty = task.quantity - ctx.totalPredictFilled;

            if (remainingQty <= 0) return; // 已完成，无需监控

            // ====== 全局幽灵深度检查: Polymarket 侧不健康时主动暂停 ======
            if (task.isSportsMarket) {
                const isPhantom = getSportsService().isTokenPhantom(hedgeTokenId, side);
                if (isPhantom) {
                    console.warn(`[TaskExecutor] 🛑 全局幽灵深度: ${task.title} ${side} 侧, 暂停任务`);
                    ctx.isPaused = true;
                    ctx.phantomDepthDetected = true;

                    if (ctx.currentOrderHash) {
                        try {
                            const cancelResult = await this.predictTrader.cancelOrder(ctx.currentOrderHash);
                            if (cancelResult.success) {
                                ctx.currentOrderHash = undefined;
                            }
                        } catch (e: any) {
                            console.warn(`[TaskExecutor] 幽灵深度取消 Predict 出错: ${e.message}`);
                        }
                    }

                    await this.taskLogger.logTaskLifecycle(task.id, 'TASK_PAUSED', {
                        status: 'PAUSED',
                        previousStatus: task.status as any,
                        reason: `全局幽灵深度: Polymarket ${side} 侧订单簿不健康`,
                    });
                    this.updateTask(task.id, {
                        status: 'PAUSED',
                        error: `全局幽灵深度: Polymarket ${side} 侧`,
                        currentOrderHash: ctx.currentOrderHash,
                    });

                    scheduleNext();
                    return;
                }
            }

            let hedgeDepth = await this.getHedgeDepth(hedgeTokenId, side, maxPrice, minPrice, task.isSportsMarket);

            // API 失败 (返回 -1)，跳过本次检查，继续监控
            if (hedgeDepth < 0) {
                console.warn('[TaskExecutor] Depth check skipped (API failed), will retry');
                scheduleNext();
                return;
            }

            // 幽灵深度: 对冲 IOC 已报告 0 成交但订单簿显示有深度
            // 视实际可用深度为 0，触发 PAUSE 取消 Predict 订单
            if (ctx.phantomDepthDetected && hedgeDepth > 0) {
                console.warn(`[TaskExecutor] 🛑 Depth monitor: phantom depth override (orderbook=${hedgeDepth.toFixed(2)} → 0)`);
                hedgeDepth = 0;
            }

            // 如果深度充足（>= 剩余挂单量）
            if (hedgeDepth >= remainingQty) {
                // 检查是否可以向上扩增：quantity 被缩减过且深度能支持更多
                if (task.quantity < task.totalQuantity) {
                    const cooldownElapsed = !ctx.lastDepthAdjustTime || (Date.now() - ctx.lastDepthAdjustTime >= DEPTH_EXPAND_COOLDOWN_MS);
                    if (cooldownElapsed) {
                        const originalRemaining = task.totalQuantity - ctx.totalPredictFilled;
                        const expandableQty = Math.min(originalRemaining, Math.floor(hedgeDepth));
                        if (expandableQty > remainingQty && (expandableQty - remainingQty) >= DEPTH_INCREASE_MIN_SHARES) {
                            // 深度支持更多量且增量 >= 阈值，取消当前订单并扩增重下
                            console.log(`[TaskExecutor] Depth expand: depth=${hedgeDepth.toFixed(2)} supports ${expandableQty} > current remaining ${remainingQty} (increase=${expandableQty - remainingQty})`);

                            // 标记深度调整中，防止主循环误判为外部取消
                            ctx.isDepthAdjusting = true;

                            let cancelSuccess = false;
                            if (ctx.currentOrderHash) {
                                try {
                                    // 取消前先检查订单是否已 FILLED，避免对已成交订单的误操作
                                    const preStatus = await this.predictTrader.getOrderStatus(ctx.currentOrderHash);
                                    if (preStatus && preStatus.filledQty > ctx.restFilledQty) {
                                        ctx.restFilledQty = preStatus.filledQty;
                                    }
                                    if (preStatus && preStatus.status === 'FILLED') {
                                        console.log(`[TaskExecutor] Depth expand: order already FILLED, skip expand → main loop will hedge`);
                                        ctx.isDepthAdjusting = false;
                                        scheduleNext();
                                        return;
                                    }
                                    cancelSuccess = (await this.predictTrader.cancelOrder(ctx.currentOrderHash)).success;
                                    if (cancelSuccess) {
                                        // 取消后确认最终成交量
                                        const postStatus = await this.predictTrader.getOrderStatus(ctx.currentOrderHash);
                                        if (postStatus && postStatus.filledQty > ctx.restFilledQty) {
                                            ctx.restFilledQty = postStatus.filledQty;
                                        }
                                        if (postStatus && postStatus.status === 'FILLED') {
                                            console.log(`[TaskExecutor] Depth expand: cancel noop but order FILLED → main loop will hedge`);
                                            ctx.isDepthAdjusting = false;
                                            scheduleNext();
                                            return;
                                        }
                                        await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                                            platform: 'predict',
                                            orderId: ctx.currentOrderHash,
                                            side: side,
                                            price: task.predictPrice,
                                            quantity: remainingQty,
                                            filledQty: ctx.totalPredictFilled,
                                            remainingQty: 0,
                                            avgPrice: task.predictPrice,
                                            cancelReason: `深度扩增: ${task.quantity} → ${ctx.totalPredictFilled + expandableQty} (depth=${hedgeDepth.toFixed(2)})`,
                                        }, ctx.currentOrderHash);
                                    }
                                } catch (e) {
                                    console.warn('[TaskExecutor] Failed to cancel order on depth expand:', e);
                                }
                                ctx.predictWatchAbort?.abort();
                                ctx.predictWatchAbort = new AbortController();
                                if (cancelSuccess) {
                                    ctx.currentOrderHash = undefined;
                                } else {
                                    // 取消失败，跳过本次扩增
                                    ctx.isDepthAdjusting = false;
                                    scheduleNext();
                                    return;
                                }
                            }

                            // 再次检查 abort 状态（取消订单是异步的，期间可能任务已被取消）
                            if (ctx.signal.aborted || ctx.priceGuardAbort?.signal.aborted) {
                                console.log(`[TaskExecutor] Depth expand aborted after cancel (task cancelled during async operation)`);
                                ctx.isDepthAdjusting = false;
                                return;
                            }

                            // 价格保护暂停检查：取消订单期间可能触发了价格保护
                            if (ctx.isPaused) {
                                console.log(`[TaskExecutor] Depth expand skipped: task is paused`);
                                ctx.isDepthAdjusting = false;
                                scheduleNext();
                                return;
                            }

                            // 再次检查任务终态（双重保险）
                            const currentTaskAfterCancel = this.taskService.getTask(ctx.task.id);
                            const terminalStatuses: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'HEDGE_FAILED', 'UNWIND_COMPLETED'];
                            if (!currentTaskAfterCancel || terminalStatuses.includes(currentTaskAfterCancel.status)) {
                                console.log(`[TaskExecutor] Depth expand aborted: task in terminal state ${currentTaskAfterCancel?.status}`);
                                ctx.isDepthAdjusting = false;
                                return;
                            }

                            // 互斥
                            if (ctx.isSubmitting) {
                                ctx.isDepthAdjusting = false;
                                scheduleNext();
                                return;
                            }
                            ctx.isSubmitting = true;

                            // Maker 价格安全检查: 确保扩量重下时不会以 Taker 成交
                            const priceCheck = await this.isPredictPriceSafeForMaker(task, side);
                            if (!priceCheck.safe) {
                                console.log(`[TaskExecutor] Depth expand: price unsafe (${priceCheck.reason}), pausing`);
                                ctx.isPaused = true;
                                this.updateTask(task.id, { status: 'PAUSED', currentOrderHash: undefined });
                                ctx.isSubmitting = false;
                                ctx.isDepthAdjusting = false;
                                scheduleNext();
                                return;
                            }

                            // 价格检查期间可能触发了价格保护，再次确认未暂停
                            if (ctx.isPaused) {
                                console.log(`[TaskExecutor] Depth expand skipped: task paused during price check`);
                                ctx.isSubmitting = false;
                                ctx.isDepthAdjusting = false;
                                scheduleNext();
                                return;
                            }

                            try {
                                const oldQuantity = task.quantity;
                                const newQuantity = ctx.totalPredictFilled + expandableQty;
                                ctx.lastDepthAdjustTime = Date.now();

                                const taskWithExpandedQty = { ...task, quantity: expandableQty };
                                const result = await this.submitPredictOrder(taskWithExpandedQty, side);
                                if (result.success) {
                                    // 提交成功后再次检查任务状态（submitOrder 是异步的，期间任务可能被取消）
                                    const taskAfterSubmit = this.taskService.getTask(task.id);
                                    if (!taskAfterSubmit || terminalStatuses.includes(taskAfterSubmit.status)) {
                                        console.log(`[TaskExecutor] Depth expand: order submitted but task is ${taskAfterSubmit?.status}, cancelling new order`);
                                        // 任务已终止，取消刚提交的订单
                                        try {
                                            await this.predictTrader.cancelOrder(result.hash!);
                                        } catch (e) {
                                            console.warn(`[TaskExecutor] Failed to cancel orphan order: ${e}`);
                                        }
                                        ctx.isDepthAdjusting = false;
                                        return;
                                    }

                                    // submitOrder 期间可能触发了价格保护，立即撤单避免无保护暴露
                                    if (ctx.isPaused) {
                                        console.log(`[TaskExecutor] Depth expand: order submitted but task paused during submit, cancelling`);
                                        try {
                                            await this.predictTrader.cancelOrder(result.hash!);
                                            ctx.cancelBscWatcher?.();
                                            ctx.currentOrderHash = undefined;
                                        } catch (e) {
                                            console.warn(`[TaskExecutor] Failed to cancel order after pause: ${e}`);
                                            // 撤单失败: 保留 hash 让主循环继续监控，不清除
                                            ctx.currentOrderHash = result.hash;
                                        }
                                        ctx.isDepthAdjusting = false;
                                        return;
                                    }

                                    ctx.currentOrderHash = result.hash;
                                    const updatedTask = this.updateTask(task.id, {
                                        quantity: newQuantity,
                                        status: 'PREDICT_SUBMITTED',
                                        currentOrderHash: result.hash,
                                    });
                                    ctx.task = updatedTask;

                                    await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                                        platform: 'predict',
                                        orderId: result.hash!,
                                        side: side,
                                        price: task.predictPrice,
                                        quantity: expandableQty,
                                        filledQty: 0,
                                        remainingQty: expandableQty,
                                        avgPrice: 0,
                                        adjustReason: `深度扩增: ${task.quantity} → ${newQuantity} (depth=${hedgeDepth.toFixed(2)})`,
                                    }, result.hash);

                                    await this.taskLogger.logTaskLifecycle(task.id, 'DEPTH_RESTORED', {
                                        status: 'PREDICT_SUBMITTED',
                                        reason: `Depth expanded: ${oldQuantity} → ${newQuantity} (depth=${hedgeDepth.toFixed(2)})`,
                                    });
                                } else {
                                    // 扩增提交失败
                                    const errMsg = result.error || '';
                                    const isCollateralError = /insufficient|collateral|balance/i.test(errMsg);

                                    if (isCollateralError) {
                                        // collateral 不足: 设置 5 分钟退避，checkDepthInner 入口跳过
                                        console.warn(`[TaskExecutor] Depth expand: collateral insufficient, backoff 5min. error=${errMsg}`);
                                        ctx.collateralBackoffUntil = Date.now() + 5 * 60 * 1000;
                                        ctx.lastDepthAdjustTime = Date.now() + 5 * 60 * 1000 - DEPTH_EXPAND_COOLDOWN_MS;
                                    } else {
                                        console.warn(`[TaskExecutor] Depth expand submit failed: ${errMsg}`);
                                    }

                                    // 原始订单已被取消，尝试以原始量回退下单（避免任务无单挂簿）
                                    if (!ctx.currentOrderHash && !ctx.isPaused) {
                                        const fallbackResult = await this.submitPredictOrder(
                                            { ...task, quantity: remainingQty }, side
                                        );
                                        if (fallbackResult.success) {
                                            ctx.currentOrderHash = fallbackResult.hash;
                                            this.updateTask(task.id, {
                                                status: 'PREDICT_SUBMITTED',
                                                currentOrderHash: fallbackResult.hash,
                                            });
                                        } else {
                                            // 连原始量都下不了，暂停任务等待余额恢复
                                            console.warn(`[TaskExecutor] Depth expand fallback also failed: ${fallbackResult.error}, pausing`);
                                            ctx.isPaused = true;
                                            this.updateTask(task.id, { status: 'PAUSED', currentOrderHash: undefined });
                                        }
                                    }
                                }
                            } finally {
                                ctx.isSubmitting = false;
                                ctx.isDepthAdjusting = false;
                            }
                        }
                    }
                }
                scheduleNext();
                return;
            }

            // 深度不足，需要调整
            console.log(`[TaskExecutor] Depth guard triggered: depth=${hedgeDepth.toFixed(2)}, remaining=${remainingQty}`);
            ctx.lastDepthAdjustTime = Date.now();

            // 计算新的目标数量 = 已成交量 + 可用深度
            const newQuantity = ctx.totalPredictFilled + Math.floor(hedgeDepth);

            if (newQuantity <= ctx.totalPredictFilled) {
                // 深度为 0，需要暂停
                console.warn(`[TaskExecutor] No hedge depth available (depth=${hedgeDepth}), pausing task`);

                // Bug B 修复: 暂停前先对原价深度=0 但实际仍可用 maxAsk + HEDGE_SLIPPAGE 成交的悬空成交量做兜底对冲
                // executeHedgeFallbackChain 会用 +3 ticks 抬价 IOC, 失败则保本 GTC, 不受 MIN_HEDGE_NOTIONAL 阻塞
                await this.forceHedgeResidual(ctx, side, 'depth_pause');

                ctx.isPaused = true;

                // 取消当前订单
                const depthReason = ctx.phantomDepthDetected
                    ? `幽灵深度: IOC 0 成交 (订单簿显示 ${hedgeDepth.toFixed(2)})`
                    : `深度保护: depth=${hedgeDepth.toFixed(2)} < remaining=${remainingQty}`;
                let cancelSuccess = false;
                if (ctx.currentOrderHash) {
                    try {
                        // 取消前先查订单状态，避免取消已成交订单
                        const preStatus = await this.predictTrader.getOrderStatus(ctx.currentOrderHash);
                        if (preStatus && preStatus.filledQty > ctx.restFilledQty) {
                            ctx.restFilledQty = preStatus.filledQty;
                        }
                        // 订单已完全成交，跳过取消，让主循环处理对冲
                        if (preStatus && preStatus.status === 'FILLED') {
                            console.log(`[TaskExecutor] Depth guard: order already FILLED, skip cancel → main loop will hedge`);
                            this.taskLogger.logTaskLifecycle(task.id, 'TASK_RESUMED', {
                                status: task.status as any,
                                reason: 'Depth guard: order already FILLED before cancel, resuming for hedge',
                            }).catch(() => {});
                            ctx.isPaused = false;
                            scheduleNext();
                            return;
                        }
                        cancelSuccess = (await this.predictTrader.cancelOrder(ctx.currentOrderHash)).success;
                        if (cancelSuccess) {
                            // 取消后再查一次确认最终成交量 (处理竞态: cancel noop 但订单实际已成交)
                            const postStatus = await this.predictTrader.getOrderStatus(ctx.currentOrderHash);
                            if (postStatus && postStatus.filledQty > ctx.restFilledQty) {
                                ctx.restFilledQty = postStatus.filledQty;
                            }
                            if (postStatus && postStatus.status === 'FILLED') {
                                // cancel 返回 noop 但订单实际已成交，让主循环处理对冲
                                console.log(`[TaskExecutor] Depth guard: cancel noop but order FILLED → main loop will hedge`);
                                this.taskLogger.logTaskLifecycle(task.id, 'TASK_RESUMED', {
                                    status: task.status as any,
                                    reason: 'Depth guard: order FILLED after cancel (noop), resuming for hedge',
                                }).catch(() => {});
                                ctx.isPaused = false;
                                scheduleNext();
                                return;
                            }
                            await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                                platform: 'predict',
                                orderId: ctx.currentOrderHash,
                                side: side,
                                price: task.predictPrice,
                                quantity: remainingQty,
                                filledQty: ctx.totalPredictFilled,
                                remainingQty: 0,
                                avgPrice: task.predictPrice,
                                cancelReason: depthReason,
                            }, ctx.currentOrderHash);
                        }
                    } catch (e) {
                        console.warn('[TaskExecutor] Failed to cancel order on depth guard:', e);
                    }
                    ctx.predictWatchAbort?.abort();
                    ctx.predictWatchAbort = new AbortController();
                    if (cancelSuccess) {
                        ctx.cancelBscWatcher?.();
                        ctx.currentOrderHash = undefined;
                    }
                    // 取消失败时保留 hash，让恢复路径可以重试取消
                }

                // 记录深度暂停生命周期事件 (之前缺失，导致排障链路不完整)
                await this.taskLogger.logTaskLifecycle(task.id, 'TASK_PAUSED', {
                    status: 'PAUSED',
                    previousStatus: task.status,
                    reason: depthReason,
                });

                this.updateTask(task.id, {
                    status: 'PAUSED',
                    ...(cancelSuccess ? { currentOrderHash: undefined } : {}),
                    error: `Hedge depth insufficient: ${hedgeDepth.toFixed(2)}`,
                });

                // 继续监控，等待深度恢复
                scheduleNext();
                return;
            }

            // 深度部分可用，调整数量
            console.log(`[TaskExecutor] Adjusting task quantity: ${task.quantity} → ${newQuantity}`);

            // 标记深度调整中，防止主循环误判为外部取消
            ctx.isDepthAdjusting = true;

            // 取消当前订单（与深度扩增/深度保护路径对齐: pre-cancel + post-cancel 验证）
            let depthAdjustCancelSuccess = false;
            if (ctx.currentOrderHash) {
                try {
                    // 取消前先检查订单是否已 FILLED，避免对已成交订单的误操作
                    const preStatus = await this.predictTrader.getOrderStatus(ctx.currentOrderHash);
                    if (preStatus && preStatus.filledQty > ctx.restFilledQty) {
                        ctx.restFilledQty = preStatus.filledQty;
                    }
                    if (preStatus && preStatus.status === 'FILLED') {
                        console.log(`[TaskExecutor] Depth shrink: order already FILLED, skip shrink → main loop will hedge`);
                        ctx.isDepthAdjusting = false;
                        scheduleNext();
                        return;
                    }
                    depthAdjustCancelSuccess = (await this.predictTrader.cancelOrder(ctx.currentOrderHash)).success;
                    if (depthAdjustCancelSuccess) {
                        // 取消后再查一次确认最终成交量 (处理竞态: cancel 与成交并发)
                        const postStatus = await this.predictTrader.getOrderStatus(ctx.currentOrderHash);
                        if (postStatus && postStatus.filledQty > ctx.restFilledQty) {
                            ctx.restFilledQty = postStatus.filledQty;
                        }
                        if (postStatus && postStatus.status === 'FILLED') {
                            console.log(`[TaskExecutor] Depth shrink: cancel noop but order FILLED → main loop will hedge`);
                            ctx.isDepthAdjusting = false;
                            scheduleNext();
                            return;
                        }
                        await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                            platform: 'predict',
                            orderId: ctx.currentOrderHash,
                            side: side,
                            price: task.predictPrice,
                            quantity: remainingQty,
                            filledQty: ctx.totalPredictFilled,
                            remainingQty: 0,
                            avgPrice: task.predictPrice,
                            cancelReason: `深度调整: ${task.quantity} → ${newQuantity} (depth=${hedgeDepth.toFixed(2)})`,
                        }, ctx.currentOrderHash);
                    }
                } catch (e) {
                    console.warn('[TaskExecutor] Failed to cancel order on depth adjustment:', e);
                }
                ctx.predictWatchAbort?.abort();
                ctx.predictWatchAbort = new AbortController();
                if (depthAdjustCancelSuccess) {
                    ctx.cancelBscWatcher?.();
                    ctx.currentOrderHash = undefined;
                } else {
                    // 取消失败，不能安全地重新下单，跳过本次调整
                    console.warn('[TaskExecutor] Depth adjustment skipped: cancel failed, retaining current order');
                    ctx.isDepthAdjusting = false;
                    scheduleNext();
                    return;
                }
            }

            // 更新任务数量
            const updatedTask = this.updateTask(task.id, {
                quantity: newQuantity,
            });
            ctx.task = updatedTask;

            // 重新下单前再次检查任务状态（取消订单后可能触发任务取消）
            const taskBeforeResubmit = this.taskService.getTask(ctx.task.id);
            if (!taskBeforeResubmit || terminalStatuses.includes(taskBeforeResubmit.status)) {
                console.log(`[TaskExecutor] Depth adjustment: task ${ctx.task.id} became ${taskBeforeResubmit?.status} after order cancel, aborting resubmit`);
                ctx.isDepthAdjusting = false;
                return;
            }

            // 再次检查 abort 状态（取消订单是异步的，期间可能任务已被取消）
            if (ctx.signal.aborted || ctx.priceGuardAbort?.signal.aborted) {
                console.log(`[TaskExecutor] Depth adjustment aborted after cancel (task cancelled during async operation)`);
                ctx.isDepthAdjusting = false;
                return;
            }

            // 价格保护暂停检查：取消订单期间可能触发了价格保护
            if (ctx.isPaused) {
                console.log(`[TaskExecutor] Depth shrink skipped: task is paused`);
                ctx.isDepthAdjusting = false;
                scheduleNext();
                return;
            }

            // 互斥: 防止并发提交
            if (ctx.isSubmitting) {
                console.log(`[TaskExecutor] Depth adjustment skipped: another path is submitting`);
                ctx.isDepthAdjusting = false;
                scheduleNext();
                return;
            }
            ctx.isSubmitting = true;

            // Maker 价格安全检查: 确保缩量重下时不会以 Taker 成交
            const priceCheck = await this.isPredictPriceSafeForMaker(updatedTask, side);
            if (!priceCheck.safe) {
                console.log(`[TaskExecutor] Depth shrink: price unsafe (${priceCheck.reason}), pausing`);
                ctx.isPaused = true;
                this.updateTask(task.id, { status: 'PAUSED', currentOrderHash: undefined });
                ctx.isSubmitting = false;
                ctx.isDepthAdjusting = false;
                scheduleNext();
                return;
            }

            // 价格检查期间可能触发了价格保护，再次确认未暂停
            if (ctx.isPaused) {
                console.log(`[TaskExecutor] Depth shrink skipped: task paused during price check`);
                ctx.isSubmitting = false;
                ctx.isDepthAdjusting = false;
                scheduleNext();
                return;
            }

            try {
            // 重新下单（新的剩余量）
            const newRemainingQty = newQuantity - ctx.totalPredictFilled;
            if (newRemainingQty > 0) {
                const taskWithNewQty = { ...updatedTask, quantity: newRemainingQty };
                const result = await this.submitPredictOrder(taskWithNewQty, side);

                if (result.success) {
                    // 提交成功后再次检查任务状态（submitOrder 是异步的，期间任务可能被取消）
                    const taskAfterSubmit = this.taskService.getTask(ctx.task.id);
                    if (!taskAfterSubmit || terminalStatuses.includes(taskAfterSubmit.status)) {
                        console.log(`[TaskExecutor] Depth adjustment: order submitted but task is ${taskAfterSubmit?.status}, cancelling new order`);
                        // 任务已终止，取消刚提交的订单
                        try {
                            await this.predictTrader.cancelOrder(result.hash!);
                        } catch (e) {
                            console.warn(`[TaskExecutor] Failed to cancel orphan order: ${e}`);
                        }
                        ctx.isSubmitting = false;
                        ctx.isDepthAdjusting = false;
                        return;
                    }

                    // submitOrder 期间可能触发了价格保护，立即撤单避免无保护暴露
                    if (ctx.isPaused) {
                        console.log(`[TaskExecutor] Depth shrink: order submitted but task paused during submit, cancelling`);
                        try {
                            await this.predictTrader.cancelOrder(result.hash!);
                            ctx.cancelBscWatcher?.();
                            ctx.currentOrderHash = undefined;
                        } catch (e) {
                            console.warn(`[TaskExecutor] Failed to cancel order after pause: ${e}`);
                            // 撤单失败: 保留 hash 让主循环继续监控，不清除
                            ctx.currentOrderHash = result.hash;
                        }
                        ctx.isSubmitting = false;
                        ctx.isDepthAdjusting = false;
                        return;
                    }

                    ctx.currentOrderHash = result.hash;

                    await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
                        platform: 'predict',
                        orderId: result.hash!,
                        side: side,
                        price: task.predictPrice,
                        quantity: newRemainingQty,
                        filledQty: 0,
                        remainingQty: newRemainingQty,
                        avgPrice: 0,
                        adjustReason: `深度调整: ${task.quantity} → ${newQuantity} (depth=${hedgeDepth.toFixed(2)})`,
                    }, result.hash);

                    this.updateTask(task.id, {
                        status: 'PREDICT_SUBMITTED',
                        currentOrderHash: result.hash,
                    });
                }
            }
            } finally {
                ctx.isSubmitting = false;
                ctx.isDepthAdjusting = false;
            }

            // 继续监控
            scheduleNext();
        };

        // WS 事件驱动深度检查 —— 带防抖滞回
        // 体育市场用 SportsService 独立 WS，非体育用主 polyWsClient
        // checkDepth 内置互斥门禁，WS 和轮询均安全调用
        const wsClientForDepth = ctx.task.isSportsMarket
            ? getSportsService()?.getWsClient()
            : this.polyWsClient;
        if (wsClientForDepth) {
            let recoveryCount = 0;
            const DEPTH_RECOVERY_THRESHOLD = 2;     // 连续 N 次确认深度恢复才触发

            const listenerId = wsClientForDepth.addOrderBookListener((book) => {
                if (ctx.signal.aborted || ctx.isSubmitting) return;

                const remaining = ctx.task.quantity - ctx.totalPredictFilled;
                if (remaining <= 0) return;

                // 同步计算可对冲深度
                let hedgeableDepth = 0;
                const PRICE_EPSILON = 1e-9;
                if (side === 'BUY') {
                    for (const [price, size] of book.asks) {
                        if (price <= maxPrice + PRICE_EPSILON) hedgeableDepth += size;
                    }
                } else {
                    for (const [price, size] of book.bids) {
                        if (price >= minPrice - PRICE_EPSILON) hedgeableDepth += size;
                    }
                }
                if (ctx.phantomDepthDetected) hedgeableDepth = 0;

                if (hedgeableDepth < remaining) {
                    recoveryCount = 0;
                    checkDepth(); // 深度不足立即触发，互斥门禁在 checkDepth 内部
                } else {
                    // 深度恢复/可扩量：PAUSED 或已缩量时也主动触发
                    // 减少优先：深度增加不足 DEPTH_INCREASE_MIN_SHARES 时忽略
                    const depthIncrease = ctx.isPaused
                        ? hedgeableDepth                    // PAUSED: 从 0 恢复，增量 = 绝对深度
                        : hedgeableDepth - remaining;       // 运行中: 增量 = 超出当前剩余的部分
                    if ((ctx.isPaused || ctx.task.quantity < ctx.task.totalQuantity) && depthIncrease >= DEPTH_INCREASE_MIN_SHARES) {
                        recoveryCount++;
                        if (recoveryCount >= DEPTH_RECOVERY_THRESHOLD) {
                            checkDepth();
                            recoveryCount = 0;
                        }
                    } else {
                        recoveryCount = 0;
                    }
                }
            }, hedgeTokenId);

            ctx.depthListenerId = listenerId;
        }

        // 启动深度监控（延迟 2 秒开始，给订单提交一些时间）
        setTimeout(checkDepth, 2000);
    }

    /**
     * 计算实际利润
     *
     * BUY 任务: 买入 Predict YES + 买入 Poly NO = 锁定 (1 - cost)
     * SELL 任务: 卖出 Predict YES + 卖出 Poly NO = 收回 (predictPrice + polyPrice) - entryCost
     */
    private calculateProfit(task: Task, ctx: TaskContext): number {
        const avgPredictPrice = task.predictPrice;
        const avgPolyPrice = ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0;
        const quantity = Math.min(ctx.totalPredictFilled, ctx.totalHedged);

        // Predict taker fee 损失 (fee 扣减了 shares，但 USDT 成本不变)
        const feeLoss = ctx.totalPredictFeeShares * avgPredictPrice;

        if (task.type === 'BUY') {
            // BUY: 成本 = predictPrice + polyPrice, 收益 = 1.0 (事件结算)
            // 利润 = (1.0 - avgPredictPrice - avgPolyPrice) * quantity - feeLoss
            return (1.0 - avgPredictPrice - avgPolyPrice) * quantity - feeLoss;
        } else {
            // SELL:
            // 收入 = avgPredictPrice * quantity + avgPolyPrice * quantity
            // 成本 = entryCost (建仓时的总成本)
            // 利润 = 收入 - 成本 - feeLoss
            const revenue = (avgPredictPrice + avgPolyPrice) * quantity;
            const entryCost = task.entryCost;

            if (entryCost === undefined || entryCost <= 0) {
                console.warn(`[TaskExecutor] SELL task ${task.id} missing entryCost, profit calculation inaccurate`);
                return revenue - quantity - feeLoss;
            }

            return revenue - entryCost - feeLoss;
        }
    }

    private getCompletionHedgeSlippage(task: Task, ctx: TaskContext): {
        reason?: string;
        hedgeSlippageTicks?: number;
        hedgeSlippagePercent?: number;
    } {
        if (ctx.totalHedged <= 0) return {};

        const avgHedgePrice = ctx.hedgePriceSum / ctx.totalHedged;
        const benchmarkPrice = task.type === 'BUY'
            ? task.polymarketMaxAsk
            : task.polymarketMinBid;
        const tickSize = task.tickSize && task.tickSize > 0 ? task.tickSize : 0.01;

        if (!Number.isFinite(avgHedgePrice) || !Number.isFinite(benchmarkPrice) || benchmarkPrice <= 0) {
            return {};
        }

        const rawDelta = task.type === 'BUY'
            ? (avgHedgePrice - benchmarkPrice)
            : (benchmarkPrice - avgHedgePrice);

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

    /**
     * 计算 UNWIND 损失
     */
    private calculateUnwindLoss(task: Task, ctx: TaskContext, unwoundQty: number): number {
        // UNWIND 损失 = 买入成本 - 卖出收入
        const avgPredictPrice = task.predictPrice;
        const buyCost = avgPredictPrice * unwoundQty;
        // 假设以 0.9 * 买入价卖出 (滑点损失)
        const sellRevenue = avgPredictPrice * 0.9 * unwoundQty;
        return buyCost - sellRevenue;
    }

    private calcPolyRequiredBalance(task: Task, hedgedQty: number): number {
        // 仅 PREDICT_MAKER 任务需要 Poly 余额对冲; POLY_MAKER 的 Poly 余额在 GTC 挂单时已锁定
        if (task.strategy === 'POLY_MAKER') return 0;
        return task.type === 'BUY' ? (task.quantity - hedgedQty) * task.polymarketMaxAsk : 0;
    }

    private updateTask(taskId: string, update: Partial<Task>): Task {
        // 自动注册 orderHash → taskId 映射 (用于 WS 取消事件识别)
        if (update.currentOrderHash) {
            this.knownOrderHashes.set(update.currentOrderHash.toLowerCase(), taskId);
            // 防止无限增长: 超过 500 条时清理最早的一半
            if (this.knownOrderHashes.size > 500) {
                const keys = [...this.knownOrderHashes.keys()];
                for (let i = 0; i < 250; i++) this.knownOrderHashes.delete(keys[i]);
            }
        }
        const task = this.taskService.updateTask(taskId, update);
        this.emit('task:updated', task);
        return task;
    }

    // ========================================================================
    // 延迟结算填充检测
    // ========================================================================

    /**
     * cancelTask 发现已成交订单时的智能对冲
     *
     * 当用户取消任务时发现 Predict 订单已全部/部分成交但未对冲，
     * 自动在 Polymarket 下对冲单以消除裸露头寸。
     *
     * 三种场景:
     * A) 最优价在保本范围内 + 深度充足 → IOC 全量对冲
     * B) 最优价在保本范围内 + 深度不足 → IOC 吃掉可用深度 + GTC 挂单剩余
     * C) 最优价超出保本范围 → GTC 挂单在保本价
     */
    private async handleFilledOrderOnCancel(
        task: Task,
        orderStatus: { filledQty: number; remainingQty: number; status: string },
        ctx?: TaskContext
    ): Promise<void> {
        const filledQty = orderStatus.filledQty;
        // 优先使用 ctx.totalHedged（包含 emergency hedge 的最新数据），防止过时的 task.hedgedQty 导致重复对冲
        const hedgedQty = ctx ? Math.max(ctx.totalHedged, task.hedgedQty || 0) : (task.hedgedQty || 0);
        const unhedgedQty = filledQty - hedgedQty;

        if (unhedgedQty < MIN_HEDGE_QTY) {
            console.log(`[TaskExecutor] cancelTask 对冲检查: 未对冲量 ${unhedgedQty.toFixed(2)} < ${MIN_HEDGE_QTY}，跳过`);
            return;
        }

        // 对冲互斥: 另一条路径正在对冲中，跳过避免并发竞争
        if (ctx?.isHedgingInProgress) {
            const msg = `cancelTask handleFilledOrderOnCancel 跳过: task=${task.id}, 另一条对冲路径正在执行中 (unhedged=${unhedgedQty.toFixed(2)})`;
            console.warn(`[TaskExecutor] ${msg}`);
            this.emitStageAlert('⚠️', 'PREDICT_MAKER', 'CANCEL_HEDGE_SKIPPED', task.id, [
                `市场: ${task.title}`,
                `原因: 另一条对冲路径正在执行`,
                `已成交: ${this.formatAlertNumber(filledQty, 2)} 股`,
                `已对冲: ${this.formatAlertNumber(hedgedQty, 2)} 股`,
                `未对冲: ${this.formatAlertNumber(unhedgedQty, 2)} 股`,
            ]);
            return;
        }
        if (ctx) ctx.isHedgingInProgress = true;

        try {

        console.warn(`[TaskExecutor] 🚨 cancelTask 发现未对冲头寸: task=${task.id}, filled=${filledQty}, hedged=${hedgedQty}, unhedged=${unhedgedQty}`);

        const hedgeTokenId = this.getHedgeTokenId(task);
        const attemptId = `cancel-hedge-${Math.random().toString(36).substring(2, 8)}`;

        // GTC 挂单价 = 1 - predictPrice（整数运算避免浮点精度问题）
        const hedgeSide: 'BUY' | 'SELL' = task.type === 'BUY' ? 'BUY' : 'SELL';
        const breakevenPrice = Math.round((1 - task.predictPrice) * 1e4) / 1e4;

        console.log(`[TaskExecutor] GTC 挂单价: 1 - ${task.predictPrice} = ${breakevenPrice}, hedgeSide=${hedgeSide}`);

        // 获取 Polymarket 订单簿
        const orderbook = await this.getPolymarketOrderbook(hedgeTokenId, task.isSportsMarket);
        if (!orderbook) {
            const msg = `取消任务 ${task.id} 发现 ${filledQty} 股已成交未对冲`;
            console.error(`[TaskExecutor] ${msg}`);
            this.emitStageAlert('🚨', 'PREDICT_MAKER', 'CANCEL_ORDERBOOK_UNAVAILABLE', task.id, [
                `市场: ${task.title}`,
                `阶段: cancelTask 发现撤单后有已成交未对冲头寸`,
                `已成交: ${this.formatAlertNumber(filledQty, 2)} 股`,
                `已对冲: ${this.formatAlertNumber(hedgedQty, 2)} 股`,
                `剩余未对冲: ${this.formatAlertNumber(unhedgedQty, 2)} 股`,
                '原因: 无法获取 Polymarket 订单簿',
                '动作: 需立即人工干预',
            ]);
            await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_FAILED', {
                hedgeQty: unhedgedQty,
                totalHedged: hedgedQty,
                totalPredictFilled: filledQty,
                avgHedgePrice: 0,
                retryCount: 0,
                reason: 'cancelTask: 无法获取订单簿',
            }, attemptId);
            return;
        }

        // 分析订单簿
        let bestPrice: number;
        let depthWithinBudget = 0;

        if (hedgeSide === 'BUY') {
            if (orderbook.asks.length === 0) {
                const msg = `取消任务 ${task.id} 发现 ${filledQty} 股已成交未对冲`;
                console.error(`[TaskExecutor] ${msg}`);
                this.emitStageAlert('🚨', 'PREDICT_MAKER', 'CANCEL_ORDERBOOK_EMPTY', task.id, [
                    `市场: ${task.title}`,
                    `阶段: cancelTask 发现撤单后有已成交未对冲头寸`,
                    `方向: BUY 对冲`,
                    `已成交: ${this.formatAlertNumber(filledQty, 2)} 股`,
                    `剩余未对冲: ${this.formatAlertNumber(unhedgedQty, 2)} 股`,
                    '原因: Polymarket asks 为空',
                    '动作: 需立即人工干预',
                ]);
                return;
            }
            bestPrice = orderbook.asks[0].price;
            // 累计 breakeven 范围内的深度
            for (const level of orderbook.asks) {
                if (level.price <= breakevenPrice) {
                    depthWithinBudget += level.size;
                } else {
                    break;
                }
            }
        } else {
            if (orderbook.bids.length === 0) {
                const msg = `取消任务 ${task.id} 发现 ${filledQty} 股已成交未对冲`;
                console.error(`[TaskExecutor] ${msg}`);
                this.emitStageAlert('🚨', 'PREDICT_MAKER', 'CANCEL_ORDERBOOK_EMPTY', task.id, [
                    `市场: ${task.title}`,
                    `阶段: cancelTask 发现撤单后有已成交未对冲头寸`,
                    `方向: SELL 对冲`,
                    `已成交: ${this.formatAlertNumber(filledQty, 2)} 股`,
                    `剩余未对冲: ${this.formatAlertNumber(unhedgedQty, 2)} 股`,
                    '原因: Polymarket bids 为空',
                    '动作: 需立即人工干预',
                ]);
                return;
            }
            bestPrice = orderbook.bids[0].price;
            // 累计 breakeven 范围内的深度
            for (const level of orderbook.bids) {
                if (level.price >= breakevenPrice) {
                    depthWithinBudget += level.size;
                } else {
                    break;
                }
            }
        }

        const isWithinBreakeven = hedgeSide === 'BUY'
            ? bestPrice <= breakevenPrice
            : bestPrice >= breakevenPrice;

        console.log(`[TaskExecutor] 订单簿分析: bestPrice=${bestPrice.toFixed(4)}, breakeven=${breakevenPrice.toFixed(4)}, withinBreakeven=${isWithinBreakeven}, depthWithinBudget=${depthWithinBudget.toFixed(2)}`);

        await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_STARTED', {
            hedgeQty: unhedgedQty,
            totalHedged: hedgedQty,
            totalPredictFilled: filledQty,
            avgHedgePrice: 0,
            retryCount: 0,
            reason: 'cancelTask: 发现未对冲头寸',
        }, attemptId);

        // ========== 场景 A/B: 最优价在保本范围内 ==========
        if (isWithinBreakeven) {
            const iocQty = Math.min(unhedgedQty, depthWithinBudget);

            if (iocQty >= MIN_HEDGE_QTY) {
                // IOC 吃掉可用深度
                try {
                    const iocResult = await this.polyTrader.placeOrder({
                        tokenId: hedgeTokenId,
                        side: hedgeSide,
                        price: bestPrice,
                        quantity: iocQty,
                        orderType: 'IOC',
                        negRisk: task.negRisk,
                        marketTitle: task.title,
                        conditionId: task.polymarketConditionId,
                    });

                    let iocFilled = 0;
                    if (iocResult.success && iocResult.orderId) {
                        // 等待 IOC 成交确认
                        const fillResult = await new Promise<OrderWatchResult>((resolve) => {
                            this.orderMonitor.watchPolymarketOrder(
                                iocResult.orderId!,
                                (result) => resolve(result),
                                { timeoutMs: 2000, tradeWindowMs: 150 }
                            );
                        });
                        iocFilled = fillResult.filledQty;
                    }

                    if (iocFilled > 0) {
                        // 更新 task
                        const newHedgedQty = hedgedQty + iocFilled;
                        const avgPrice = task.avgPolymarketPrice
                            ? (task.avgPolymarketPrice * hedgedQty + bestPrice * iocFilled) / newHedgedQty
                            : bestPrice;
                        this.updateTask(task.id, {
                            hedgedQty: newHedgedQty,
                            avgPolymarketPrice: avgPrice,
                            remainingQty: filledQty - newHedgedQty,
                            polyRequiredBalance: this.calcPolyRequiredBalance(task, newHedgedQty),
                        });

                        if (ctx) {
                            ctx.totalHedged += iocFilled;
                            ctx.hedgePriceSum += iocFilled * bestPrice;
                        }

                        console.log(`[TaskExecutor] ✅ cancelTask IOC 对冲成交: ${iocFilled.toFixed(2)} @ ${bestPrice.toFixed(4)}`);
                    }

                    const gtcQty = unhedgedQty - iocFilled;

                    // 场景 A: IOC 全量成交
                    if (gtcQty < MIN_HEDGE_QTY) {
                        const msg = `取消任务 ${task.id} 发现已成交 ${filledQty} 股，已紧急 IOC 对冲 ${iocFilled.toFixed(1)} 股`;
                        console.log(`[TaskExecutor] ${msg}`);
                        this.emitStageAlert('✅', 'PREDICT_MAKER', 'CANCEL_IOC_HEDGED', task.id, [
                            `市场: ${task.title}`,
                            `阶段: cancelTask 紧急 IOC 对冲完成`,
                            `已成交: ${this.formatAlertNumber(filledQty, 2)} 股`,
                            `本次IOC: ${this.formatAlertNumber(iocFilled, 2)} 股 @ ${bestPrice.toFixed(4)}`,
                            `累计已对冲: ${this.formatAlertNumber(hedgedQty + iocFilled, 2)} 股`,
                            '结果: 未对冲敞口已清零',
                        ]);
                        await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_COMPLETED', {
                            hedgeQty: iocFilled,
                            totalHedged: hedgedQty + iocFilled,
                            totalPredictFilled: filledQty,
                            avgHedgePrice: bestPrice,
                            retryCount: 0,
                            reason: 'cancelTask: IOC 全量对冲完成',
                        }, attemptId);
                        return;
                    }

                    // 场景 B: IOC 部分成交，GTC 挂单剩余
                    await this.placeGtcHedgeForCancel(task, hedgeTokenId, hedgeSide, breakevenPrice, gtcQty, attemptId, {
                        iocFilled,
                        filledQty,
                        hedgedQty,
                        bestPrice,
                    }, ctx);
                } catch (err: any) {
                    console.error(`[TaskExecutor] cancelTask IOC 对冲异常: ${err.message}`);
                    // IOC 失败，降级为 GTC
                    await this.placeGtcHedgeForCancel(task, hedgeTokenId, hedgeSide, breakevenPrice, unhedgedQty, attemptId, {
                        iocFilled: 0,
                        filledQty,
                        hedgedQty,
                        bestPrice,
                    }, ctx);
                }
            } else {
                // 深度太浅，全部 GTC
                await this.placeGtcHedgeForCancel(task, hedgeTokenId, hedgeSide, breakevenPrice, unhedgedQty, attemptId, {
                    iocFilled: 0,
                    filledQty,
                    hedgedQty,
                    bestPrice,
                }, ctx);
            }
        } else {
            // ========== 场景 C: 最优价超出保本范围 → GTC 挂单 ==========
            await this.placeGtcHedgeForCancel(task, hedgeTokenId, hedgeSide, breakevenPrice, unhedgedQty, attemptId, {
                iocFilled: 0,
                filledQty,
                hedgedQty,
                bestPrice,
                outOfRange: true,
            }, ctx);
        }

        } finally {
            if (ctx) ctx.isHedgingInProgress = false;
        }
    }

    /**
     * cancelTask 对冲辅助: 在保本价挂 GTC 限价单
     */
    private async placeGtcHedgeForCancel(
        task: Task,
        hedgeTokenId: string,
        hedgeSide: 'BUY' | 'SELL',
        breakevenPrice: number,
        gtcQty: number,
        attemptId: string,
        info: { iocFilled: number; filledQty: number; hedgedQty: number; bestPrice: number; outOfRange?: boolean },
        ctx?: TaskContext
    ): Promise<void> {
        // 确保 GTC 价格在 Polymarket 有效范围内 (0.01-0.99)
        const gtcPrice = Math.max(0.01, Math.min(0.99, breakevenPrice));
        // 数量精确到小数点后 1 位
        gtcQty = Math.floor(gtcQty * 10) / 10;

        // 检查 Polymarket $1 最小名义金额
        const notional = gtcQty * gtcPrice;
        if (notional < MIN_HEDGE_NOTIONAL) {
            const msg = `取消任务 ${task.id} 发现 ${info.filledQty} 股已成交`;
            console.warn(`[TaskExecutor] ${msg}`);
            this.emitStageAlert('🚨', 'PREDICT_MAKER', 'CANCEL_GTC_TOO_SMALL', task.id, [
                `市场: ${task.title}`,
                `阶段: cancelTask 需要 Polymarket GTC 保底`,
                info.iocFilled > 0 ? `已先IOC对冲: ${this.formatAlertNumber(info.iocFilled, 2)} 股 @ ${info.bestPrice.toFixed(4)}` : undefined,
                `待挂GTC: ${this.formatAlertNumber(gtcQty, 2)} 股 @ ${gtcPrice.toFixed(4)}`,
                `名义金额: $${notional.toFixed(2)} < $${MIN_HEDGE_NOTIONAL}`,
                '动作: 无法挂单，需立即人工干预',
            ]);
            await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_FAILED', {
                hedgeQty: gtcQty,
                totalHedged: info.hedgedQty + info.iocFilled,
                totalPredictFilled: info.filledQty,
                avgHedgePrice: 0,
                retryCount: 0,
                reason: `cancelTask: GTC 名义金额 $${notional.toFixed(2)} < $${MIN_HEDGE_NOTIONAL}`,
            }, attemptId + '-gtc');
            return;
        }

        try {
            const gtcResult = await this.polyTrader.placeOrder({
                tokenId: hedgeTokenId,
                side: hedgeSide,
                price: gtcPrice,
                quantity: gtcQty,
                orderType: 'GTC',
                negRisk: task.negRisk,
                marketTitle: task.title,
                conditionId: task.polymarketConditionId,
            });

            const gtcOrderId = gtcResult.success ? gtcResult.orderId : 'FAILED';

            // 持久化 GTC orderId + 设置 HEDGE_FAILED_GTC_PENDING 状态，确保 GTC 订单被追踪
            if (gtcResult.success && gtcResult.orderId) {
                this.updateTask(task.id, {
                    currentPolyOrderId: gtcResult.orderId,
                    status: 'HEDGE_FAILED_GTC_PENDING',
                });

                // 注册 WS 监听器追踪 GTC 成交/取消
                // 需要 ctx 来更新对冲状态；若无 ctx 则构造最小上下文
                const watcherCtx = ctx ?? {
                    task,
                    signal: new AbortController().signal,
                    abortController: new AbortController(),
                    isPaused: false,
                    totalPredictFilled: info.filledQty,
                    totalHedged: info.hedgedQty + info.iocFilled,
                    hedgePriceSum: (info.hedgedQty + info.iocFilled) * (task.avgPolymarketPrice || 0),
                    pendingHedgeQty: 0,
                    lastHedgePriceEstimate: 0,
                    polyOrderFills: new Map(),
                    wssFilledQty: 0,
                    predictWsFilledQty: 0,
                    wssFillEvents: new Set<string>(),
                    pendingFillAccumulated: 0,
                    restFilledQty: 0,
                    currentOrderFeeShares: 0,
                    totalPredictFeeShares: 0,
                    baseFilledBeforeOrder: 0,
                    delayedFillQty: 0,
                    depthPausedChecks: 0,
                } as TaskContext;
                this.registerGtcFillWatcher(task.id, gtcResult.orderId, gtcQty, gtcPrice, watcherCtx);
            }

            if (info.outOfRange) {
                const msg = `取消任务 ${task.id} 发现 ${info.filledQty} 股已成交`;
                console.warn(`[TaskExecutor] ${msg}`);
                this.emitStageAlert('🚨', 'PREDICT_MAKER', 'CANCEL_GTC_OUT_OF_RANGE', task.id, [
                    `市场: ${task.title}`,
                    `阶段: cancelTask 发现当前价格超出保本范围，改挂 GTC`,
                    `已成交: ${this.formatAlertNumber(info.filledQty, 2)} 股`,
                    `已对冲: ${this.formatAlertNumber(info.hedgedQty + info.iocFilled, 2)} 股`,
                    `bestPrice: ${info.bestPrice.toFixed(4)} / breakeven: ${breakevenPrice.toFixed(4)}`,
                    `GTC挂单: ${this.formatAlertNumber(gtcQty, 2)} 股 @ ${gtcPrice.toFixed(4)}`,
                    `orderId: ${gtcOrderId}`,
                    '动作: 已挂保底单，但建议人工关注',
                ]);
            } else {
                const msg = `取消任务 ${task.id} 发现 ${info.filledQty} 股已成交`;
                console.warn(`[TaskExecutor] ${msg}`);
                this.emitStageAlert('⚠️', 'PREDICT_MAKER', 'CANCEL_GTC_FALLBACK', task.id, [
                    `市场: ${task.title}`,
                    `阶段: cancelTask 紧急对冲后仍有剩余，进入 Polymarket GTC 保底`,
                    `已成交: ${this.formatAlertNumber(info.filledQty, 2)} 股`,
                    info.iocFilled > 0 ? `已先IOC对冲: ${this.formatAlertNumber(info.iocFilled, 2)} 股 @ ${info.bestPrice.toFixed(4)}` : undefined,
                    `GTC挂单: ${this.formatAlertNumber(gtcQty, 2)} 股 @ ${gtcPrice.toFixed(4)}`,
                    `orderId: ${gtcOrderId}`,
                    '动作: 已注册自动追踪 (HEDGE_FAILED_GTC_PENDING)',
                ]);
            }

            await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_STARTED', {
                hedgeQty: gtcQty,
                totalHedged: info.hedgedQty + info.iocFilled,
                totalPredictFilled: info.filledQty,
                avgHedgePrice: gtcPrice,
                retryCount: 0,
                reason: `cancelTask: GTC 挂单 @ ${gtcPrice.toFixed(4)}`,
            }, attemptId + '-gtc');
        } catch (err: any) {
            const msg = `取消任务 ${task.id} 发现 ${info.filledQty} 股已成交`;
            console.error(`[TaskExecutor] ${msg}`);
            this.emitStageAlert('🚨', 'PREDICT_MAKER', 'CANCEL_GTC_FAILED', task.id, [
                `市场: ${task.title}`,
                `阶段: cancelTask 尝试 Polymarket GTC 保底失败`,
                info.iocFilled > 0 ? `已先IOC对冲: ${this.formatAlertNumber(info.iocFilled, 2)} 股 @ ${info.bestPrice.toFixed(4)}` : undefined,
                `待挂GTC: ${this.formatAlertNumber(gtcQty, 2)} 股 @ ${gtcPrice.toFixed(4)}`,
                `异常: ${err.message}`,
                '动作: 需立即人工干预',
            ]);

            await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_FAILED', {
                hedgeQty: gtcQty,
                totalHedged: info.hedgedQty + info.iocFilled,
                totalPredictFilled: info.filledQty,
                avgHedgePrice: 0,
                retryCount: 0,
                reason: `cancelTask: GTC 挂单失败 ${err.message}`,
            }, attemptId + '-gtc');
        }
    }

    private cleanup(ctx: TaskContext): void {
        ctx.priceGuardAbort?.abort();
        ctx.predictWatchAbort?.abort();
        this.orderMonitor.stopPriceGuard(ctx.task.id);
        // 清理 WS 深度监听器
        if (ctx.depthListenerId && this.polyWsClient) {
            this.polyWsClient.removeOrderBookListener(ctx.depthListenerId);
            ctx.depthListenerId = undefined;
        }
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /** fire-and-forget: 不阻塞调用方，但打印警告方便排障 */
    private logFF(label: string, p: Promise<unknown>): void {
        void p.catch(e => console.warn(`[TaskExecutor] ${label} failed:`, (e as Error)?.message));
    }

    /**
     * 构建任务配置快照
     */
    private buildTaskConfigSnapshot(task: Task): TaskConfigSnapshot {
        return {
            type: task.type,
            marketId: task.marketId,
            title: task.title,
            predictPrice: task.predictPrice,
            polymarketMaxAsk: task.polymarketMaxAsk,
            polymarketMinBid: task.polymarketMinBid,
            quantity: task.quantity,
            polymarketConditionId: task.polymarketConditionId,
            polymarketNoTokenId: task.polymarketNoTokenId,
            polymarketYesTokenId: task.polymarketYesTokenId,
            isInverted: task.isInverted,
            feeRateBps: 0, // Maker 无费用
            tickSize: task.tickSize || 0.01,
            negRisk: task.negRisk,  // Polymarket negRisk 市场标志
            arbSide: task.arbSide || 'YES',  // 套利方向
        };
    }

    private applyPolyFillDelta(ctx: TaskContext, orderId: string, filledQty: number, avgPrice: number): number {
        const existing = ctx.polyOrderFills.get(orderId);
        const previousAvgPrice = existing?.avgPrice || 0;
        const priceForAccounting = avgPrice || previousAvgPrice || 0;
        const prevRaw = existing?.rawFilledQty ?? existing?.filledQty ?? 0;
        const prevCounted = existing?.filledQty ?? 0;
        const nextRaw = Math.max(prevRaw, filledQty);
        let nextCounted = nextRaw;

        if (existing?.accountForBuyFees && (existing.feeRate ?? 0) > 0 && priceForAccounting > 0) {
            nextCounted = calculatePolyNetBuyShares(
                nextRaw,
                priceForAccounting,
                existing.feeRate ?? 0,
                existing.feeExponent ?? 1,
            );
        }

        const targetQty = existing?.targetQty;
        if (targetQty !== undefined && targetQty > 0 && nextCounted - targetQty >= 0.0001) {
            console.log(
                `[TaskExecutor] Poly IOC over-fill (better price): counted=${nextCounted.toFixed(4)} ` +
                `target=${targetQty.toFixed(4)} raw=${nextRaw.toFixed(4)} (kept, not capped)`,
            );
        }

        const delta = Math.max(0, nextCounted - prevCounted);
        ctx.polyOrderFills.set(orderId, {
            filledQty: nextCounted,
            rawFilledQty: nextRaw,
            targetQty: existing?.targetQty,
            avgPrice: priceForAccounting,
            lastCheckedAt: Date.now(),
            accountForBuyFees: existing?.accountForBuyFees,
            feeRate: existing?.feeRate,
            feeExponent: existing?.feeExponent,
            isTerminal: existing?.isTerminal,
            terminalAt: existing?.terminalAt,
        });

        if (delta > 0) {
            ctx.totalHedged += delta;
            ctx.hedgePriceSum += delta * priceForAccounting;
            if (existing?.accountForBuyFees && Math.abs(nextRaw - nextCounted) >= 0.0001) {
                console.log(
                    `[TaskExecutor] Poly BUY fee accounting: gross=${nextRaw.toFixed(4)}, ` +
                    `net=${nextCounted.toFixed(4)}, feeRate=${existing.feeRate ?? 0}, ` +
                    `feeExponent=${existing.feeExponent ?? 1}`,
                );
            }
        }

        return delta;
    }

    private async refreshSinglePolyFill(
        ctx: TaskContext,
        orderId: string,
        options?: {
            fallbackFilledQty?: number;
            fallbackAvgPrice?: number;
            force?: boolean;
        }
    ): Promise<{ filledQty: number; avgPrice: number; delta: number }> {
        if (!ctx.polyOrderFills.has(orderId)) {
            ctx.polyOrderFills.set(orderId, { filledQty: 0, rawFilledQty: 0, avgPrice: 0, lastCheckedAt: 0 });
        }

        const current = ctx.polyOrderFills.get(orderId)!;
        if (!options?.force && Date.now() - current.lastCheckedAt < POLY_FILL_RECHECK_INTERVAL_MS) {
            return { filledQty: current.filledQty, avgPrice: current.avgPrice, delta: 0 };
        }

        // WS 缓存短路: 同步操作，不需要去重
        const wsCached = this.polyTrader.getWsCachedFillStatus(orderId);
        if (wsCached && wsCached.isTerminal) {
            const filledQty = wsCached.filledQty > 0 ? wsCached.filledQty
                : (options?.fallbackFilledQty ?? current.filledQty);
            const avgPrice = options?.fallbackAvgPrice ?? current.avgPrice;
            const delta = this.applyPolyFillDelta(ctx, orderId, filledQty, avgPrice);
            const updated = ctx.polyOrderFills.get(orderId)!;
            updated.isTerminal = true;
            updated.terminalAt = updated.terminalAt || Date.now();

            if (delta > 0) {
                const avgHedgePrice = ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0;
                ctx.task = this.updateTask(ctx.task.id, {
                    hedgedQty: ctx.totalHedged,
                    avgPolymarketPrice: avgHedgePrice,
                    remainingQty: ctx.totalPredictFilled - ctx.totalHedged,
                    polyRequiredBalance: this.calcPolyRequiredBalance(ctx.task, ctx.totalHedged),
                });
            }

            return { filledQty: updated.filledQty, avgPrice: updated.avgPrice, delta };
        }

        // In-flight 去重: 如果已有相同 orderId 的 REST poll 在进行中，复用其结果
        const existing = this.inFlightRefreshes.get(orderId);
        if (existing) {
            return existing;
        }

        const doRefresh = async (): Promise<{ filledQty: number; avgPrice: number; delta: number }> => {
            try {
                // WS 缓存未命中或非终态，降级到 REST poll
                const status = await this.polyTrader.pollOrderStatus(
                    orderId,
                    POLY_FILL_RECHECK_MAX_RETRIES * POLY_FILL_RECHECK_INTERVAL_MS
                );

                const filledQty = status?.filledQty ?? options?.fallbackFilledQty ?? current.filledQty;
                const avgPrice = options?.fallbackAvgPrice ?? current.avgPrice;
                const delta = this.applyPolyFillDelta(ctx, orderId, filledQty, avgPrice);
                const updated = ctx.polyOrderFills.get(orderId)!;

                // REST poll 也标记终态
                if (status?.status === 'MATCHED' || status?.status === 'CANCELLED') {
                    updated.isTerminal = true;
                    updated.terminalAt = updated.terminalAt || Date.now();
                }

                if (delta > 0) {
                    const avgHedgePrice = ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0;
                    ctx.task = this.updateTask(ctx.task.id, {
                        hedgedQty: ctx.totalHedged,
                        avgPolymarketPrice: avgHedgePrice,
                        remainingQty: ctx.totalPredictFilled - ctx.totalHedged,
                        polyRequiredBalance: this.calcPolyRequiredBalance(ctx.task, ctx.totalHedged),
                    });
                }

                return { filledQty: updated.filledQty, avgPrice: updated.avgPrice, delta };
            } catch (err: any) {
                console.warn(`[TaskExecutor] Failed to refresh Poly order ${orderId.slice(0, 10)}...: ${err.message}`);
                return { filledQty: current.filledQty, avgPrice: current.avgPrice, delta: 0 };
            } finally {
                this.inFlightRefreshes.delete(orderId);
            }
        };

        const promise = doRefresh();
        this.inFlightRefreshes.set(orderId, promise);

        try {
            return await promise;
        } catch (err: any) {
            console.warn(`[TaskExecutor] Failed to refresh Poly order ${orderId.slice(0, 10)}...: ${err.message}`);
            return { filledQty: current.filledQty, avgPrice: current.avgPrice, delta: 0 };
        }
    }

    private async refreshTrackedPolyFills(ctx: TaskContext): Promise<void> {
        if (ctx.polyOrderFills.size === 0) return;

        // TTL 清理: 删除已确认终态且超过 TTL 的订单，避免 Map 无限增长
        const now = Date.now();
        for (const [orderId, tracker] of ctx.polyOrderFills) {
            if (tracker.isTerminal && tracker.terminalAt && now - tracker.terminalAt > POLY_FILL_TERMINAL_TTL_MS) {
                ctx.polyOrderFills.delete(orderId);
            }
        }

        // 收集需要刷新的订单 (跳过已确认终态)
        const toRefresh: string[] = [];
        for (const [orderId, tracker] of ctx.polyOrderFills) {
            if (!tracker.isTerminal) {
                toRefresh.push(orderId);
            }
        }

        if (toRefresh.length === 0) return;

        // 有并发上限的并行刷新
        for (let i = 0; i < toRefresh.length; i += POLY_FILL_REFRESH_CONCURRENCY) {
            const batch = toRefresh.slice(i, i + POLY_FILL_REFRESH_CONCURRENCY);
            await Promise.all(batch.map(orderId => this.refreshSinglePolyFill(ctx, orderId)));
        }
    }

    /**
     * 捕获订单簿快照
     */
    private async captureSnapshot(
        taskId: string,
        trigger: 'task_created' | 'order_submit' | 'order_fill' | 'price_guard' | 'hedge_start' | 'exposure_alert',
        task: Task,
        extras?: { exposure?: number; includeWsHealth?: boolean }
    ): Promise<void> {
        try {
            // 并行获取 Predict + Polymarket 订单簿
            const hedgeTokenId = this.getHedgeTokenId(task);
            const [predictBook, polyBook] = await Promise.all([
                this.predictTrader.getOrderbook(task.marketId).catch(() => null),
                this.getPolymarketOrderbook(hedgeTokenId, task.isSportsMarket),
            ]);

            // 构建 Predict 快照 (基于 YES 侧原始数据，保留完整信息用于 Maker/Taker 排障)
            const predictBookData = predictBook ? {
                bids: predictBook.bids.slice(0, 5).map(([p, s]: [number, number]) => [p, s] as [number, number]),
                asks: predictBook.asks.slice(0, 5).map(([p, s]: [number, number]) => [p, s] as [number, number]),
                updateTimestampMs: Date.now(),
            } : null;

            // 构建 Polymarket 快照
            const polyBookData = polyBook ? {
                bids: polyBook.bids.map(b => [b.price, b.size] as [number, number]),
                asks: polyBook.asks.map(a => [a.price, a.size] as [number, number]),
                updateTimestampMs: Date.now(),
            } : null;

            // 计算套利指标
            // PREDICT_MAKER 模式不需要手续费，TAKER 模式需要计算手续费
            const bestPolyAsk = polyBook?.asks[0]?.price ?? 1;
            const isTaker = task.strategy === 'TAKER';
            const predictFee = isTaker && task.feeRateBps
                ? calculatePredictFee(task.predictPrice, task.feeRateBps)
                : 0;
            const totalCost = task.predictPrice + bestPolyAsk + predictFee;
            const profitPercent = (1 - totalCost) * 100;

            const polyWsHealth = extras?.includeWsHealth
                ? this.polyWsClient?.getHealthSnapshot()
                : undefined;

            await this.taskLogger.captureOrderBookSnapshot(
                taskId,
                trigger,
                predictBookData,
                polyBookData,
                {
                    totalCost,
                    profitPercent,
                    isValid: profitPercent > 0,
                    maxDepth: polyBook?.asks[0]?.size ?? 0,
                },
                {
                    exposure: extras?.exposure,
                    polyWs: polyWsHealth,
                }
            );
        } catch (error) {
            console.warn('[TaskExecutor] Failed to capture snapshot:', error);
        }
    }

    /**
     * Public: 敞口告警触发的快照采集 (供 exposure-monitor 调用)
     * 持续期内每个 tick 一份双边订单簿 + Polymarket WS 健康状态，用于事后复盘"幽灵深度"/对冲失败时刻的市场真实状况
     */
    async captureExposureSnapshot(taskId: string, exposure: number): Promise<void> {
        const task = this.taskService.getTask(taskId);
        if (!task) return;
        await this.captureSnapshot(taskId, 'exposure_alert', task, {
            exposure,
            includeWsHealth: true,
        });
    }
}

// ============================================================================
// 单例
// ============================================================================

let instance: TaskExecutor | null = null;

export function getTaskExecutor(): TaskExecutor {
    if (!instance) {
        instance = new TaskExecutor();
    }
    return instance;
}
