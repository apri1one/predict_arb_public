/**
 * Dashboard 启动脚本 - 真实数据模式
 *
 * 使用与 arb-monitor CLI 一致的深度计算逻辑
 * 支持 Maker 和 Taker 双策略套利检测
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { calculateDepth, calculateNoSideDepth, type DepthResult, type NoSideDepthResult } from '../trading/depth-calculator.js';
import { computePointsYield } from '../trading/pp-yield.js';
import { PolymarketWebSocketClient } from '../polymarket/ws-client.js';
import { destroyPolymarketUserWsClient, getPolymarketUserWsClient } from '../polymarket/user-ws-client.js';
import { getAccountData, refreshAccountData, setMarketTitleResolver, getPolymarketAvailableBalance, getPredictAvailableBalance, getPolymarketApiLatency } from './account-service.js';
import { getTaskService, initTaskService } from './task-service.js';
import { getOrderMonitor } from './order-monitor.js';
import { getTaskExecutor } from './task-executor.js';
import { getTaskLogger, initTaskLogger } from './task-logger/index.js';
import { createTelegramNotifier, TelegramNotifier } from '../notification/telegram.js';
import { startWsOrderNotifierFromEnv, stopWsOrderNotifier } from '../notification/ws-order-notifier.js';
import { startBscOrderNotifierFromEnv, stopBscOrderNotifier } from '../notification/bsc-order-notifier.js';
import type { CreateTaskInput, TaskFilter, Task, TaskStatus, ArbOpportunity, CloseOpportunity, AutoCreateTasksInput, AutoTaskPreviewItem, BatchCancelTasksInput } from './types.js';
import type { SystemStats, MarketPair, DashboardData, SSEClientMeta, BroadcastChannel, LiquidityScanItem, LiquidityScanResult } from './dashboard-types.js';
import { getLogQueryService } from './log-query-service.js';
import { calculateCloseOpportunities, getClosePositions, getPositionMarketIds, getUnmatchedPositions, refreshMarketMatches, setPolyOrderbookProvider, setPredictOrderbookProvider as setClosePredictOrderbookProvider, setPredictApiKeyProvider } from './hedge-mode/index.js';
import { setPolymarketWsOrderbookProvider } from './polymarket-trader.js';
import { setPredictOrderbookCacheProvider, setPredictOrderbookRestFallbackEnabled } from './predict-trader.js';
import { getSportsService, setSportsPredictOrderbookProvider } from './sports-service.js';
import { fetchBoostData, isMarketBoosted, getBoostCache, setBoostMarketIdProvider } from './boost-cache.js';
import { fetchRewardData, getMarketRewardInfo, getRewardCacheStats, hasMarketReward } from './rewards-cache.js';
import { startAutoRedeem, stopAutoRedeem } from './redeem-service.js';
import { initUrlMapper, getPredictSlug, getPolymarketSlug, cachePredictSlugs, generatePredictSlug } from './url-mapper.js';
import { getBscOrderWatcher, stopBscOrderWatcher, type OrderFilledEvent as BscOrderFilledEvent } from '../services/bsc-order-watcher.js';
import { getPredictOrderWatcher, stopPredictOrderWatcher, type OrderFilledEvent } from '../services/predict-order-watcher.js';
import type { WalletEventData } from '../services/predict-ws-client.js';
import { getTokenMarketCache, stopTokenMarketCache } from '../services/token-market-cache.js';
import { getPredictOrderbookCache, initPredictOrderbookCache, stopPredictOrderbookCache, type CachedOrderbook } from '../services/predict-orderbook-cache.js';
import { initConfig, killProcessOnPort } from './cli-init.js';
import { initHttpUtils, parseJsonBody, getMimeType, isAuthorizedRequest, getSecureCorsHeaders, requireAuth } from './http-utils.js';
import { ApiKeyRotator, getInactiveScanKey, getAllScanKeys, maskApiKey, recordApiKeyUsage } from './api-key-rotation.js';
import {
    initSSETransport,
    broadcastSSEGlobal,
    broadcastTaskUpdate,
    broadcastTaskDeleted,
    broadcastBscOrderFilled,
    broadcastPredictWalletEvent,
    sendSSEToClientAsync,
    sendSSEToClient,
    isSSEClientAlive,
    sendOpportunityBatchesAsync,
    sendOpportunityBatches,
} from './sse-transport.js';
import { createExposureMonitor, type ExposureMonitor } from './exposure-monitor.js';
import { createBalanceGuard, type BalanceGuard } from './balance-guard.js';
import { generateAutoTaskPreview } from './auto-task-preview.js';
import { AutoTaskCreateRunner, buildAutoCreateTaskInput, filterAutoCreateCandidates } from './auto-task-create.js';
import { PpFarmerRunner } from './pp-farmer/index.js';
import { initPpArchive, getArchive, getArchivedMarketIds, addToArchive, removeFromArchive } from './pp-archive.js';
import { BatchTaskCancelRunner, isTerminalTaskStatus } from './batch-task-cancel.js';
import {
    POLL_INTERVAL_MS,
    ENABLE_SPORTS_SERVICE,
    ENABLE_ALL_MARKETS,
    ENABLE_ARB_TG_NOTIFICATION,
    DASHBOARD_PREDICT_ORDERBOOK_MODE,
    POLY_ORDERBOOK_SOURCE,
    PREDICT_ORDERBOOK_STALE_MS,
    CALC_ORDERBOOK_STALE_MS,
    PREDICT_ORDERBOOK_WARM_ON_SUBSCRIBE,
    CACHE_TTL_MS,
    CACHE_EXPIRY_MS,
    FULL_RESCAN_INTERVAL_MS,
    PREDICT_CACHE_TTL_MS,
    POLY_WS_STALE_MS,
    FETCH_TIMEOUT_MS,
    WS_HEALTH_CHECK_MS,
    WS_DISCONNECT_PAUSE_MS,
    WS_RECONNECT_RESUME_DELAY_MS,
    HYBRID_FALLBACK_ENABLED,
    HYBRID_FALLBACK_INTERVAL_MS,
    WS_DRIVEN_CALCULATION,
    BROADCAST_THROTTLE_MS,
    OPPORTUNITY_THROTTLE_MS,
    SPORTS_RECOMPUTE_THROTTLE_MS,
    CLOSE_RECOMPUTE_THROTTLE_MS,
    WS_UPDATE_THROTTLE_MS,
    PREDICT_WS_UPDATE_THROTTLE_MS,
    BOOST_REFRESH_INTERVAL_MS,
    BATCH_TASK_READY_EVENT_TYPES,
    WS_NOTIFY_COOLDOWN_MS,
} from './dashboard-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const FRONT_DIR_CANDIDATES = [
    resolve(PROJECT_ROOT, 'front'),
    resolve(__dirname, 'frontend'),
    resolve(PROJECT_ROOT, 'src', 'dashboard', 'frontend'),
];
const FRONT_DIR = FRONT_DIR_CANDIDATES.find((dir) => existsSync(join(dir, 'preview.html'))) ?? FRONT_DIR_CANDIDATES[0];
const FRONT_PREVIEW_PATH = join(FRONT_DIR, 'preview.html');
const HAS_FRONT_PREVIEW = existsSync(FRONT_PREVIEW_PATH);

// ============================================================================
// 初始化（异步）— CLI 参数解析 + 环境加载 (逻辑已提取到 cli-init.ts)
// ============================================================================

const { port: PORT, accountName: ACCOUNT_NAME, dataDir: DATA_DIR } = await initConfig();

// 初始化 HTTP 工具 (CORS 白名单依赖端口号)
initHttpUtils(PORT);

// 初始化数据存储 (多账号使用独立目录)
initTaskLogger({ baseDir: `${DATA_DIR}/logs/tasks` });
initTaskService(`${DATA_DIR}/tasks.json`);
initPpArchive(`${DATA_DIR}/pp-archive.json`);

// 初始化 URL 映射 (加载缓存 + 获取 Polymarket slugs)
await initUrlMapper();

// ============================================================================
// API Key 轮换管理 (逻辑已提取到 api-key-rotation.ts)
// ============================================================================

// 统一扫描 key 池: SCAN_1, SCAN_2, SCAN_3 并发
const scanApiKeys = new ApiKeyRotator('scan');
// 兼容旧引用 (orderbookApiKeys 指向同一个 key 池)
const orderbookApiKeys = scanApiKeys;

// SCAN_4 备用 key (可选)
const inactiveScanKey = getInactiveScanKey();

// Polymarket token ID 缓存
const polymarketTokenCache: Map<string, { tokenId: string; timestamp: number }> = new Map();

// ============================================================================
// Types
// ============================================================================

// ArbOpportunity, SystemStats, MarketPair, DashboardData 从 dashboard-types.ts 导入

// ============================================================================
// Data Store
// ============================================================================

let dashboardData: DashboardData = {
    opportunities: [],
    stats: {
        latency: {
            predict: 0,
            polymarket: 0,
        },
        connectionStatus: {
            polymarketWs: 'disconnected',
            predictWs: 'disconnected',
            bscWss: 'disconnected',
            predictApi: 'ok',
        },
        lastFullUpdate: new Date().toISOString(),
        marketsMonitored: 0,
        refreshInterval: 10000,
        arbStats: {
            makerCount: 0,
            takerCount: 0,
            avgProfit: 0,
            maxProfit: 0,
            totalDepth: 0,
        },
        dataVersion: 0,
    },
};

// 机会缓存：保留上次成功获取的机会数据，避免 API 限流时卡片消失
// key: `${marketId}-${side}-${strategy}`
const opportunityCache = new Map<string, ArbOpportunity>();

// 已知机会 ID 集合：用于判断是否是新发现的机会
// 只有首次发现时 isNew=true，后续轮询时 isNew=false
const knownOpportunityIds = new Set<string>();

function makeOpportunityKey(marketId: number, side: 'YES' | 'NO', strategy: 'PREDICT_MAKER' | 'TAKER'): string {
    return `${marketId}-${side}-${strategy}`;
}

// 双轨扫描：记录有套利机会的市场 ID
// - 活跃市场使用 ORDERBOOK keys 扫描
// - 非活跃市场使用 SCAN key 扫描
const activeMarketIds = new Set<number>();
const failedMarketIds = new Set<number>(); // API 失败的市场统计

// 首次扫描标志：启动后第一次扫描不发送 TG 通知，只填充缓存
let isFirstScan = true;
// 强制下一次扫描走 REST 全量拉取（用于定时刷新长尾市场缓存）
let forceFullScan = false;
let scanRoundCount = 0;

const startTime = Date.now();

// 平仓机会缓存（用于 SSE 推送）
let cachedCloseOpportunities: CloseOpportunity[] = [];
let lastCloseOpportunitiesUpdate = 0;

// SSEClientMeta 从 dashboard-types.ts 导入
const sseClients: Map<ServerResponse, SSEClientMeta> = new Map();
initSSETransport(sseClients);

const marketPairs: MarketPair[] = [];
let polymarketWsClient: PolymarketWebSocketClient | null = null;

// Dashboard 运行资源（用于优雅关闭）
let httpServer: ReturnType<typeof createServer> | null = null;
let mainPollInterval: ReturnType<typeof setInterval> | null = null;
let predictRefreshInterval: ReturnType<typeof setInterval> | null = null;
let polyRefreshInterval: ReturnType<typeof setInterval> | null = null;
let boostRefreshInterval: ReturnType<typeof setInterval> | null = null;
let wsDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsResumeTimer: ReturnType<typeof setTimeout> | null = null;
let wsPauseActive = false;
let wsPauseInProgress = false;
let lastWsHealthy: boolean | null = null;
const wsPausedTaskIds = new Set<string>();
const serialSchedulerStops: Array<() => void> = [];
let shutdownRequested = false;

// All 市场运行时开关 (可通过 API 切换)
let allMarketsEnabled: boolean = ENABLE_ALL_MARKETS;

/**
 * 获取 Polymarket WebSocket 客户端
 * 供其他模块获取实时订单簿
 */
export function getPolymarketWsClient(): PolymarketWebSocketClient | null {
    return polymarketWsClient;
}

function getPolymarketWsStatus(): SystemStats['connectionStatus']['polymarketWs'] {
    if (!polymarketWsClient) return 'disconnected';
    const state = polymarketWsClient.getState();
    if (state === 'connected') return 'connected';
    if (state === 'connecting' || state === 'reconnecting') return 'reconnecting';
    return 'disconnected';
}

function isWsHealthy(): boolean {
    const requirePredictWs = usePredictWsMode;
    const requirePolyWs = POLY_ORDERBOOK_SOURCE !== 'rest';
    const predictOk = !requirePredictWs || (getPredictOrderbookCache()?.isWsConnected() ?? false);
    const polyOk = !requirePolyWs || (polymarketWsClient?.isConnected() ?? false);
    return Boolean(predictOk && polyOk);
}

/**
 * 检查 WS 物理连接是否健康（双边判定）
 * 仅检查连接状态，不检查数据新鲜度
 * WS-only 模式下：Predict + Polymarket 都要在线
 */
function isWsConnectionHealthy(): boolean {
    if (!usePredictWsMode) return true;

    // Predict WS 连接检查
    const cache = getPredictOrderbookCache();
    const predictConnected = cache?.isWsConnected() ?? false;

    // Polymarket WS 连接检查
    const polyConnected = polymarketWsClient?.isConnected() ?? false;

    // 双边都要在线
    return predictConnected && polyConnected;
}

/**
 * 检查特定市场的 Predict 订单簿是否新鲜 (用于计算)
 * @param marketId 市场 ID
 * @param maxAgeMs 最大允许年龄 (默认 CALC_ORDERBOOK_STALE_MS = 10s)
 */
function isPredictOrderbookFreshForCalc(marketId: number, maxAgeMs: number = CALC_ORDERBOOK_STALE_MS): boolean {
    const lastUpdate = lastWsUpdateByMarket.get(marketId);
    if (!lastUpdate) return false;
    return (Date.now() - lastUpdate) < maxAgeMs;
}

/**
 * 检查特定 token 的 Polymarket 订单簿是否新鲜 (用于计算)
 * @param tokenId Token ID
 * @param maxAgeMs 最大允许年龄 (默认 CALC_ORDERBOOK_STALE_MS = 10s)
 */
function isPolymarketOrderbookFreshForCalc(tokenId: string, maxAgeMs: number = CALC_ORDERBOOK_STALE_MS): boolean {
    const lastUpdate = lastPolyWsUpdateByToken.get(tokenId);
    if (!lastUpdate) return false;
    return (Date.now() - lastUpdate) < maxAgeMs;
}

/**
 * 检查市场双边订单簿是否都新鲜 (用于计算/交易)
 * 严格 10s 过期，防止用过期数据计算利润
 */
function isMarketDataFreshForCalc(marketId: number, tokenId: string): boolean {
    return isPredictOrderbookFreshForCalc(marketId) && isPolymarketOrderbookFreshForCalc(tokenId);
}

// Hybrid 兜底轮询定时器
let hybridFallbackInterval: ReturnType<typeof setInterval> | null = null;

/**
 * 启动 Hybrid 兜底轮询
 * 当 WS 不健康时，用 REST 轮询 Predict 订单簿
 */
function startHybridFallback(): void {
    if (hybridFallbackInterval || !HYBRID_FALLBACK_ENABLED) return;
    hybridFallbackActive = true;
    console.warn(`[Hybrid] 启动 REST 兜底轮询 (间隔 ${HYBRID_FALLBACK_INTERVAL_MS}ms)`);

    hybridFallbackInterval = setInterval(async () => {
        if (!hybridFallbackActive || shutdownRequested) return;
        try {
            const cache = getPredictOrderbookCache();
            if (!cache) return;

            // 批量刷新活跃市场的订单簿
            const activeIds = Array.from(activeMarketIds).slice(0, 50);  // 限制数量
            const BATCH_SIZE = 30;
            for (let i = 0; i < activeIds.length; i += BATCH_SIZE) {
                const batch = activeIds.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(id => cache.getOrderbook(id).catch(() => null)));
            }
        } catch {
            // 静默失败
        }
    }, HYBRID_FALLBACK_INTERVAL_MS);
}

/**
 * 停止 Hybrid 兜底轮询
 */
function stopHybridFallback(): void {
    if (!hybridFallbackInterval) return;
    clearInterval(hybridFallbackInterval);
    hybridFallbackInterval = null;
    hybridFallbackActive = false;
    console.log(`[Hybrid] 停止 REST 兜底轮询 (WS 已恢复)`);
}

async function pauseTasksForWsDisconnect(): Promise<void> {
    if (wsPauseInProgress || wsPauseActive) return;
    wsPauseInProgress = true;
    try {
        const pausedIds = await taskExecutor.pauseTasks('WS disconnected', { concurrency: 4, timeoutMs: 60000, excludeSports: true });
        for (const id of pausedIds) wsPausedTaskIds.add(id);
        if (pausedIds.length > 0) {
            wsPauseActive = true;
            console.warn(`[WS Health] 已暂停 ${pausedIds.length} 个任务 (WS 断连超过 ${WS_DISCONNECT_PAUSE_MS}ms)`);
        }
    } catch (error: any) {
        console.warn(`[WS Health] 暂停任务失败: ${error?.message || error}`);
    } finally {
        wsPauseInProgress = false;
    }
}

async function resumeTasksAfterWsReconnect(): Promise<void> {
    if (wsPauseInProgress || !wsPauseActive) return;
    wsPauseInProgress = true;
    try {
        const taskIds = Array.from(wsPausedTaskIds);
        if (taskIds.length === 0) {
            wsPausedTaskIds.clear();
            wsPauseActive = false;
            return;
        }

        // WS-only 激进模式：恢复时只看连接状态，不检查数据新鲜度
        // WS 重连后数据会自然通过 WS 推送更新，无需等待
        console.log(`[WS Health] WS 双边连接已恢复，恢复 ${taskIds.length} 个任务...`);

        const resumedIds: string[] = [];

        for (const taskId of taskIds) {
            try {
                const task = taskService.getTask(taskId);
                if (!task) {
                    wsPausedTaskIds.delete(taskId);
                    continue;
                }

                // 直接恢复任务，不检查数据新鲜度
                await taskExecutor.resumeTask(taskId);
                wsPausedTaskIds.delete(taskId);
                resumedIds.push(taskId);
            } catch (error: any) {
                console.warn(`[WS Health] 恢复任务 ${taskId} 失败: ${error?.message || error}`);
            }
        }

        if (resumedIds.length > 0) {
            console.log(`[WS Health] 已恢复 ${resumedIds.length} 个任务`);
        }

        // 清除标志
        wsPausedTaskIds.clear();
        wsPauseActive = false;
    } finally {
        wsPauseInProgress = false;
    }
}

async function handleWsHealthCheck(): Promise<void> {
    // 仅检查 WS 物理连接状态，不检查数据新鲜度
    // 数据新鲜度在计算入口单独检查，避免"市场静默"被误判为断连
    const connected = isWsConnectionHealthy();

    if (lastWsHealthy === null) {
        lastWsHealthy = connected;
    }

    // 更新连接状态变量
    predictWsConnected = connected;
    if (connected) {
        predictWsDisconnectedAt = 0;
    } else if (predictWsDisconnectedAt === 0) {
        predictWsDisconnectedAt = Date.now();
    }

    // Hybrid 兜底逻辑：WS 断连时启用 REST 轮询（仅用于保持缓存，不用于计算）
    if (!connected && HYBRID_FALLBACK_ENABLED && !hybridFallbackActive) {
        startHybridFallback();
    } else if (connected && hybridFallbackActive) {
        stopHybridFallback();
    }

    // 任务暂停/恢复逻辑（基于连接状态）
    if (connected) {
        // WS 连接正常
        if (wsDisconnectTimer) {
            clearTimeout(wsDisconnectTimer);
            wsDisconnectTimer = null;
        }
        if (wsPauseActive && !wsResumeTimer) {
            wsResumeTimer = setTimeout(() => {
                wsResumeTimer = null;
                resumeTasksAfterWsReconnect().catch(() => { /* ignore */ });
            }, WS_RECONNECT_RESUME_DELAY_MS);
        }
    } else {
        // WS 断连
        if (wsResumeTimer) {
            clearTimeout(wsResumeTimer);
            wsResumeTimer = null;
        }
        if (!wsDisconnectTimer) {
            wsDisconnectTimer = setTimeout(() => {
                wsDisconnectTimer = null;
                pauseTasksForWsDisconnect().catch(() => { /* ignore */ });
            }, WS_DISCONNECT_PAUSE_MS);
        }
    }

    // 状态变化时输出日志
    if (lastWsHealthy !== connected) {
        if (connected) {
            console.log(`[WS Health] ✅ WS 连接恢复`);
        } else {
            console.warn(`[WS Health] ⚠️ WS 连接断开`);
        }
    }

    lastWsHealthy = connected;
}

// Task Service 和 Executor 实例
const taskService = getTaskService();
const taskExecutor = getTaskExecutor();

function createBatchTaskReadyWaiter(taskId: string, timeoutMs = 10_000): {
    promise: Promise<{ ready: boolean; reason: string; waitedMs: number; eventType?: string; status?: TaskStatus }>;
    dispose: () => void;
} {
    const taskLogger = getTaskLogger();
    const startedAt = Date.now();
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    const cleanups: Array<() => void> = [];
    let resolvePromise!: (value: { ready: boolean; reason: string; waitedMs: number; eventType?: string; status?: TaskStatus }) => void;

    const cleanup = () => {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
        }
        while (cleanups.length > 0) {
            const fn = cleanups.pop();
            try {
                fn?.();
            } catch {
                // Ignore cleanup errors.
            }
        }
    };

    const finish = (value: { ready: boolean; reason: string; eventType?: string; status?: TaskStatus }) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolvePromise({
            ...value,
            waitedMs: Date.now() - startedAt,
        });
    };

    const promise = new Promise<{ ready: boolean; reason: string; waitedMs: number; eventType?: string; status?: TaskStatus }>((resolve) => {
        resolvePromise = resolve;
    });

    const currentTask = taskService.getTask(taskId);
    if (currentTask && currentTask.status !== 'PENDING') {
        finish({
            ready: true,
            reason: `status:${currentTask.status}`,
            status: currentTask.status,
        });
        return {
            promise,
            dispose: () => {
                settled = true;
                cleanup();
            },
        };
    }

    const unsubscribeNotifier = taskLogger.connectNotifier(({ taskId: notifiedTaskId, event }) => {
        if (notifiedTaskId !== taskId) return;
        if (!BATCH_TASK_READY_EVENT_TYPES.has(event.type)) return;
        finish({
            ready: true,
            reason: `event:${event.type}`,
            eventType: event.type,
        });
    });
    cleanups.push(unsubscribeNotifier);

    const handleTaskUpdated = (task: Task) => {
        if (task.id !== taskId) return;
        if (task.status === 'PENDING') return;
        finish({
            ready: true,
            reason: `status:${task.status}`,
            status: task.status,
        });
    };
    taskService.on('task:updated', handleTaskUpdated);
    cleanups.push(() => taskService.off('task:updated', handleTaskUpdated));

    timeoutHandle = setTimeout(() => {
        finish({
            ready: false,
            reason: 'timeout',
        });
    }, timeoutMs);

    return {
        promise,
        dispose: () => {
            if (settled) return;
            settled = true;
            cleanup();
        },
    };
}
// P. (PREDICT_MAKER) 和 M. (POLY_MAKER) 各自独立的批量创建 runner
const autoTaskCreateRunnerConfig: ConstructorParameters<typeof AutoTaskCreateRunner>[0] = {
    createTask: async (candidate: AutoTaskPreviewItem, context) => {
        const createTaskInput = buildAutoCreateTaskInput(
            candidate,
            context.index,
            Date.now(),
            context.jobId
                ? {
                    jobId: context.jobId,
                    index: context.index + 1,
                    total: context.total,
                    source: context.source,
                }
                : undefined
        );
        console.log(`[AutoCreate] #${context.index} strategy=${createTaskInput.strategy}, polyBidPrice=${createTaskInput.polyBidPrice}, predictPrice=${createTaskInput.predictPrice}, market=${createTaskInput.marketId}, arbSide=${createTaskInput.arbSide}`);
        try {
            const task = taskService.createTask(createTaskInput);
            subscribeTaskTokensForWs(createTaskInput);

            if (createTaskInput.strategy === 'POLY_MAKER') {
                const makerTokenId = getPolyMakerSubmitTokenId(createTaskInput);
                const snapshotReady = await waitForPolymarketWsSnapshot(makerTokenId);
                console.log(
                    `[AutoCreate] #${context.index} POLY_MAKER WS warmup: token=${makerTokenId.slice(0, 12)}..., ` +
                    `ready=${snapshotReady.ready}, reason=${snapshotReady.reason}`,
                );
            }

            if (!context.autoStart) {
                return {
                    created: true,
                    taskId: task.id,
                    started: false,
                    createTaskInput,
                };
            }

            const waiter = createBatchTaskReadyWaiter(task.id);
            try {
                await taskExecutor.startTask(task.id);
                const readyResult = await waiter.promise;
                return {
                    created: true,
                    taskId: task.id,
                    started: true,
                    createTaskInput,
                    ...readyResult,
                };
            } catch (error: any) {
                waiter.dispose();
                return {
                    created: true,
                    taskId: task.id,
                    started: false,
                    error: error.message,
                    createTaskInput,
                };
            }
        } catch (error: any) {
            return {
                created: false,
                started: false,
                error: error.message,
                createTaskInput,
            };
        }
    },
    debugDir: join(DATA_DIR, 'logs', 'auto-task-create'),
    minTaskIntervalMs: 2000,
};
const autoTaskCreateRunner = new AutoTaskCreateRunner(autoTaskCreateRunnerConfig);
const polyMakerAutoCreateRunner = new AutoTaskCreateRunner(autoTaskCreateRunnerConfig);

// Auto PP-Farmer: 每 5 分钟轮询有 PP 收益率门槛以上的市场，PREDICT_MAKER 策略自动创建 + 启动
// 拆成两个 runner: all (非体育套利) + sports (体育)，各自独立 enable/threshold/budgetPoolRatio
const makePpFarmerRunner = (source: 'all' | 'sports') => new PpFarmerRunner({
    source,
    getOpportunities: () => dashboardData.opportunities,
    getSportsMarkets: () => (ENABLE_SPORTS_SERVICE ? getSportsService().getMarkets() : []),
    getAccounts: async () => {
        const data = await getAccountData();
        return {
            predict: { available: data.predict.available },
            polymarket: { available: data.polymarket.available },
        };
    },
    hasActiveTask: (marketId, type, arbSide, strategy) =>
        taskService.hasActiveTask(marketId, type, arbSide, strategy),
    getArchivedMarketIds: source === 'all' ? () => getArchivedMarketIds() : undefined,
    createAndStartTask: async (candidate, index) => {
        const createTaskInput = buildAutoCreateTaskInput(candidate, index, Date.now(), undefined);
        // 强制 PREDICT_MAKER — buildAutoCreateTaskInput 已按 candidate.strategy 分支；
        // pp-farmer 候选没有 strategy 字段，走默认 PREDICT_MAKER 分支。
        let task: Task;
        try {
            task = taskService.createTask(createTaskInput);
        } catch (err: any) {
            return { error: err?.message || String(err) };
        }
        subscribeTaskTokensForWs(createTaskInput);
        const waiter = createBatchTaskReadyWaiter(task.id);
        try {
            await taskExecutor.startTask(task.id);
            await waiter.promise;
            return { taskId: task.id };
        } catch (err: any) {
            waiter.dispose();
            return { taskId: task.id, error: err?.message || String(err) };
        }
    },
    logFilePath: join(DATA_DIR, `pp-farmer-${source}.log.jsonl`),
});

const ppFarmerAllRunner = makePpFarmerRunner('all');
const ppFarmerSportsRunner = makePpFarmerRunner('sports');

const getPpFarmerRunner = (source: string | null | undefined): PpFarmerRunner =>
    source === 'sports' ? ppFarmerSportsRunner : ppFarmerAllRunner;

async function cancelActiveTaskForBatch(taskId: string): Promise<{
    cancelled: boolean;
    skipped?: boolean;
    status?: TaskStatus;
    error?: string;
}> {
    const task = taskService.getTask(taskId);
    if (!task) {
        return {
            cancelled: false,
            skipped: true,
            error: 'Task not found',
        };
    }

    if (isTerminalTaskStatus(task.status)) {
        return {
            cancelled: false,
            skipped: true,
            status: task.status,
            error: `Task already terminal: ${task.status}`,
        };
    }

    await taskExecutor.cancelTask(taskId);
    const updated = taskService.getTask(taskId);
    return {
        cancelled: true,
        status: updated?.status,
    };
}

const batchTaskCancelRunner = new BatchTaskCancelRunner({
    cancelTask: cancelActiveTaskForBatch,
    minTaskIntervalMs: 1000,
});

// Telegram 通知实例 (懒加载)
let telegramNotifier: TelegramNotifier | null = null;
function getTelegramNotifier(): TelegramNotifier | null {
    if (telegramNotifier) return telegramNotifier;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (token && chatId) {
        telegramNotifier = createTelegramNotifier({
            botToken: token,
            chatId: chatId,
            enabled: true,
        });
    }
    return telegramNotifier;
}

// WS 断连/重连 TG 通知（60 秒冷却防刷）
let lastWsNotifyTime = 0;
function sendWsNotification(message: string) {
    const now = Date.now();
    if (now - lastWsNotifyTime < WS_NOTIFY_COOLDOWN_MS) return;
    lastWsNotifyTime = now;
    const tg = getTelegramNotifier();
    if (tg) {
        tg.sendText(message).catch(err =>
            console.warn(`[WS TG] 发送失败: ${err.message}`)
        );
    }
}

// 全局敞口检测实例 (在 main() 中初始化)
let exposureMonitor: ExposureMonitor;
// 全局余额守卫实例 (在 main() 中初始化)
let balanceGuard: BalanceGuard;

function subscribeTaskTokensForWs(input: Pick<CreateTaskInput, 'polymarketNoTokenId' | 'polymarketYesTokenId'>): void {
    if (!polymarketWsClient || !polymarketWsClient.isConnected()) {
        return;
    }

    const tokensToSubscribe: string[] = [];
    if (input.polymarketNoTokenId) tokensToSubscribe.push(input.polymarketNoTokenId);
    if (input.polymarketYesTokenId) tokensToSubscribe.push(input.polymarketYesTokenId);

    if (tokensToSubscribe.length > 0) {
        polymarketWsClient.subscribe(tokensToSubscribe);
        console.log(`[Task] 动态订阅 ${tokensToSubscribe.length} 个 token 到 WS`);
    }
}

const POLY_MAKER_WS_WARMUP_TIMEOUT_MS = 3000;
const POLY_MAKER_WS_WARMUP_POLL_MS = 100;

function getPolyMakerSubmitTokenId(input: Pick<CreateTaskInput, 'arbSide' | 'isInverted' | 'polymarketNoTokenId' | 'polymarketYesTokenId'>): string {
    if (input.arbSide === 'YES') {
        return input.isInverted ? input.polymarketNoTokenId : input.polymarketYesTokenId;
    }
    return input.isInverted ? input.polymarketYesTokenId : input.polymarketNoTokenId;
}

async function waitForPolymarketWsSnapshot(tokenId: string, timeoutMs = POLY_MAKER_WS_WARMUP_TIMEOUT_MS): Promise<{ ready: boolean; reason: string }> {
    if (!tokenId) {
        return { ready: false, reason: 'missing-token' };
    }

    const hasSnapshot = () => {
        const book = getPolymarketOrderbookFromWs(tokenId);
        return !!book && (book.bids.length > 0 || book.asks.length > 0);
    };

    if (hasSnapshot()) {
        return { ready: true, reason: 'cache-hit' };
    }

    const client = polymarketWsClient;
    if (!client || !client.isConnected()) {
        return { ready: false, reason: 'ws-not-connected' };
    }

    return await new Promise((resolve) => {
        let settled = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let pollHandle: ReturnType<typeof setInterval> | null = null;
        let listenerId: string | null = null;

        const finish = (ready: boolean, reason: string) => {
            if (settled) return;
            settled = true;
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (pollHandle) clearInterval(pollHandle);
            if (listenerId) client.removeOrderBookListener(listenerId);
            resolve({ ready, reason });
        };

        listenerId = client.addOrderBookListener((book) => {
            if (book.assetId !== tokenId) return;
            if ((book.bids?.length ?? 0) === 0 && (book.asks?.length ?? 0) === 0) return;
            finish(true, 'listener');
        }, tokenId);

        pollHandle = setInterval(() => {
            if (hasSnapshot()) {
                finish(true, 'poll');
            }
        }, POLY_MAKER_WS_WARMUP_POLL_MS);

        timeoutHandle = setTimeout(() => {
            finish(false, 'timeout');
        }, timeoutMs);
    });
}

// ============================================================================
// 统一 SSE 广播调度器 (200ms 节流)
// 所有面板数据通过 markDirty() 标记，统一 flush 广播，避免乱序
// ============================================================================

// BroadcastChannel 从 dashboard-types.ts 导入

const dirtyFlags = new Set<BroadcastChannel>();
const pendingPayloads = new Map<BroadcastChannel, string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let opportunityFlushTimer: ReturnType<typeof setTimeout> | null = null;

// Opportunity 增量推送 diff 状态
const lastBroadcastedOpps = new Map<string, string>(); // key → JSON string

function getOpportunityKey(opp: ArbOpportunity): string {
    return `${opp.marketId}-${opp.side}-${opp.strategy}`;
}

function computeOpportunityIncremental(opportunities: ArbOpportunity[]): { updated: ArbOpportunity[]; removed: string[] } {
    const currentKeys = new Set<string>();
    const updated: ArbOpportunity[] = [];

    for (const opp of opportunities) {
        const key = getOpportunityKey(opp);
        currentKeys.add(key);
        const json = JSON.stringify(opp);
        if (lastBroadcastedOpps.get(key) !== json) {
            updated.push(opp);
            lastBroadcastedOpps.set(key, json);
        }
    }

    const removed: string[] = [];
    for (const key of lastBroadcastedOpps.keys()) {
        if (!currentKeys.has(key)) {
            removed.push(key);
            lastBroadcastedOpps.delete(key);
        }
    }

    return { updated, removed };
}

/**
 * 标记通道为 dirty 并缓存 payload
 * opportunity 使用独立 2s 节流，其他通道共享 200ms 节流
 */
function markDirty(channel: BroadcastChannel, payload: string): void {
    pendingPayloads.set(channel, payload);
    if (channel === 'opportunity') {
        scheduleOpportunityFlush();
    } else {
        dirtyFlags.add(channel);
        scheduleFlush();
    }
}

/**
 * 标记 opportunity 为 dirty（不传 payload，广播时实时计算增量 diff）
 */
function markOpportunityDirty(): void {
    scheduleOpportunityFlush();
}

/**
 * 调度 flush (200ms 节流，不含 opportunity)
 */
function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushBroadcast();
    }, BROADCAST_THROTTLE_MS);
}

/**
 * 调度 opportunity flush (2s 节流，广播时计算增量 diff)
 */
function scheduleOpportunityFlush(): void {
    if (opportunityFlushTimer) return;
    opportunityFlushTimer = setTimeout(() => {
        opportunityFlushTimer = null;
        const incremental = computeOpportunityIncremental(dashboardData.opportunities);
        if (incremental.updated.length > 0 || incremental.removed.length > 0) {
            broadcastSSEGlobal('opportunity', JSON.stringify(incremental));
        }
    }, OPPORTUNITY_THROTTLE_MS);
}

/**
 * 批量 flush 所有 dirty 通道（不含 opportunity）
 */
function flushBroadcast(): void {
    for (const channel of dirtyFlags) {
        const payload = pendingPayloads.get(channel);
        if (payload !== undefined) {
            broadcastSSEGlobal(channel, payload);
        }
    }
    dirtyFlags.clear();
}

// ============================================================================
// 节流重算工具 (Sports / Close)
// ============================================================================

let sportsRecomputeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 节流触发体育市场重算 (200ms 节流)
 * WS 更新时调用，实际触发 refreshPredictOrderbooks → rebuildMarketsFromCache
 */
function scheduleSportsRecompute(): void {
    if (sportsRecomputeTimer) return;
    sportsRecomputeTimer = setTimeout(async () => {
        sportsRecomputeTimer = null;
        try {
            const sportsService = getSportsService();
            if (sportsService) {
                // 触发实际重算（从 WS 缓存读取 → 重建机会）
                await sportsService.refreshPredictOrderbooks();
            }
            const sportsData = JSON.stringify(sportsService?.getSSEDataIncremental() ?? { updated: [], removed: [], stats: { totalMatched: 0, withArbitrage: 0, avgProfit: 0, maxProfit: 0 }, lastUpdate: 0 });
            markDirty('sports', sportsData);
        } catch {
            // 忽略错误
        }
    }, SPORTS_RECOMPUTE_THROTTLE_MS);
}

let closeRecomputeTimer: ReturnType<typeof setTimeout> | null = null;
let closeRecomputeForce = false;
let closeRecomputeInFlight = false;
let closeRecomputePending = false;

/**
 * 节流触发平仓机会重算 (200ms 节流 + 单飞锁)
 * WS 更新时调用，实际触发 calculateCloseOpportunities
 */
function scheduleCloseRecompute(forcePositionsRefresh: boolean = false): void {
    if (forcePositionsRefresh) closeRecomputeForce = true;
    // 正在执行时标记 pending，当前轮完成后自动重算
    if (closeRecomputeInFlight) {
        closeRecomputePending = true;
        return;
    }
    if (closeRecomputeTimer) return;
    closeRecomputeTimer = setTimeout(async () => {
        closeRecomputeTimer = null;
        closeRecomputeInFlight = true;
        const shouldForce = closeRecomputeForce;
        closeRecomputeForce = false;
        try {
            cachedCloseOpportunities = await calculateCloseOpportunities(shouldForce);
            lastCloseOpportunitiesUpdate = Date.now();
            markDirty('closeOpportunities', JSON.stringify(cachedCloseOpportunities));
        } catch {
            markDirty('closeOpportunities', JSON.stringify(cachedCloseOpportunities));
        } finally {
            closeRecomputeInFlight = false;
            // 执行期间有新事件到达，立即触发下一轮
            if (closeRecomputePending) {
                closeRecomputePending = false;
                scheduleCloseRecompute();
            }
        }
    }, CLOSE_RECOMPUTE_THROTTLE_MS);
}


// ============================================================================
// Polymarket WebSocket + 增量更新
// ============================================================================

// Predict 订单簿缓存（legacy 模式用于 REST 轮询）
const predictOrderbookCacheLegacy = new Map<number, { bids: OrderBookLevel[]; asks: OrderBookLevel[]; timestamp: number }>();

// 运行时模式标记（在 main() 中设置）
let usePredictWsMode = false;

/**
 * 获取 Predict 订单簿缓存（供 PredictTrader 使用）
 * 返回格式: { bids: [[price, size], ...], asks: [[price, size], ...] }
 *
 * WS 模式: 从统一 PredictOrderbookCache 读取
 * Legacy 模式: 从本地 Map 读取
 */
function getPredictOrderbookFromCache(marketId: number): { bids: [number, number][]; asks: [number, number][] } | null {
    // WS 模式: 使用统一缓存
    if (usePredictWsMode) {
        const unifiedCache = getPredictOrderbookCache();
        if (!unifiedCache) return null;

        const cached = unifiedCache.getOrderbookSync(marketId);
        if (!cached) return null;
        // 转换为 [price, size] 元组格式
        const bids = cached.bids.map(l => [l.price, l.size] as [number, number]);
        const asks = cached.asks.map(l => [l.price, l.size] as [number, number]);
        return { bids, asks };
    }

    // Legacy 模式: 使用本地缓存
    const cached = predictOrderbookCacheLegacy.get(marketId);
    if (!cached) return null;

    // 检查缓存有效期
    if (Date.now() - cached.timestamp > PREDICT_CACHE_TTL_MS) {
        return null;
    }

    // 转换为 [price, size] 元组格式
    const bids = cached.bids.map(l => [l.price, l.size] as [number, number]);
    const asks = cached.asks.map(l => [l.price, l.size] as [number, number]);

    return { bids, asks };
}

/**
 * 获取 Predict 订单簿缓存（供 hedge-mode 使用）
 * 返回格式: { bids: [{price, size}, ...], asks: [{price, size}, ...] }
 *
 * WS 模式: 从统一 PredictOrderbookCache 读取
 * Legacy 模式: 从本地 Map 读取
 */
function getPredictOrderbookForCloseService(marketId: number): { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null {
    // WS 模式: 使用统一缓存
    if (usePredictWsMode) {
        const unifiedCache = getPredictOrderbookCache();
        if (!unifiedCache) return null;

        const cached = unifiedCache.getOrderbookSync(marketId);
        if (!cached) return null;
        // 转换为对象格式
        return {
            bids: cached.bids.map(l => ({ price: l.price, size: l.size })),
            asks: cached.asks.map(l => ({ price: l.price, size: l.size })),
        };
    }

    // Legacy 模式: 使用本地缓存
    const cached = predictOrderbookCacheLegacy.get(marketId);
    if (!cached) return null;

    // 检查缓存有效期
    if (Date.now() - cached.timestamp > PREDICT_CACHE_TTL_MS) {
        return null;
    }

    // 直接返回对象格式（与缓存格式相同）
    return { bids: cached.bids, asks: cached.asks };
}

// tokenId → marketPair 索引（启动时构建）
const tokenIdToMarketPair = new Map<string, MarketPair>();

function buildTokenIdIndex(): void {
    tokenIdToMarketPair.clear();
    for (const pair of marketPairs) {
        if (pair.polymarketTokenId) {
            tokenIdToMarketPair.set(pair.polymarketTokenId, pair);
        }
    }
}

// WS 订单簿更新节流：接近实时推送
let lastWsUpdateBroadcast = 0;

/**
 * 获取 Predict 订单簿（用于 WS 增量更新）
 * 支持 WS 模式和 Legacy 模式
 */
function getPredictOrderbookForWsUpdate(marketId: number): { bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null {
    if (usePredictWsMode) {
        const unifiedCache = getPredictOrderbookCache();
        if (!unifiedCache) return null;

        const cached = unifiedCache.getOrderbookSync(marketId);
        if (!cached) return null;
        return {
            bids: cached.bids.map(l => ({ price: l.price, size: l.size })),
            asks: cached.asks.map(l => ({ price: l.price, size: l.size })),
        };
    }

    // Legacy 模式
    const cached = predictOrderbookCacheLegacy.get(marketId);
    if (!cached || Date.now() - cached.timestamp > PREDICT_CACHE_TTL_MS) {
        return null;
    }
    return { bids: cached.bids, asks: cached.asks };
}

/**
 * 统一注入/清理 boost 字段，避免 WS 增量路径遗漏或缓存残留过期状态。
 */
function applyBoostToOpportunity(opp: ArbOpportunity): ArbOpportunity {
    const boost = isMarketBoosted(opp.marketId);
    if (boost.boosted) {
        opp.boosted = true;
        opp.boostStartTime = boost.boostStartTime;
        opp.boostEndTime = boost.boostEndTime;
    } else {
        delete opp.boosted;
        delete opp.boostStartTime;
        delete opp.boostEndTime;
    }
    return opp;
}

/**
 * 注入 PP 奖励档位 + 收益率（新公式：按 1, 1/3, 1/9 加权累加前 3 档 shares，
 * 仅 |price-mid| ≤ spreadThreshold 范围内的档位计入）。
 *   pointsYield = hourlyRate / weightedShares     单位 PP/hr/share
 * 与 sports-service / src/trading/pp-yield.ts 共享同一函数。
 */
function applyPointsToOpportunity(opp: ArbOpportunity): ArbOpportunity {
    const reward = getMarketRewardInfo(opp.marketId);
    if (!reward) {
        delete opp.pointsTier;
        delete opp.pointsHourlyRate;
        delete opp.pointsNextTier;
        delete opp.pointsNextHourlyRate;
        delete opp.pointsYield;
        return opp;
    }
    opp.pointsTier = reward.tier;
    opp.pointsHourlyRate = reward.hourlyRate;
    opp.pointsNextTier = reward.nextTier;
    opp.pointsNextHourlyRate = reward.nextHourlyRate;
    const book = getPredictOrderbookForWsUpdate(opp.marketId);
    const y = book
        ? computePointsYield(book.bids, book.asks, reward.spreadThreshold, reward.hourlyRate)
        : null;
    if (y != null) opp.pointsYield = y;
    else delete opp.pointsYield;
    return opp;
}

/**
 * 处理 Polymarket WS 订单簿更新，增量更新对应市场的套利机会
 * - 记录 Polymarket WS 更新时间戳
 * - profit > 0 时更新机会
 * - profit <= 0 时清除机会（避免残留"幽灵机会"）
 */
/**
 * 从 depth 计算结果构建 ArbOpportunity 对象
 * 用于 WS 更新时创建新机会（复用扫描构造逻辑）
 */
function buildOpportunityFromDepth(
    pair: MarketPair,
    depth: DepthResult | NoSideDepthResult,
    side: 'YES' | 'NO',
    strategy: 'PREDICT_MAKER' | 'TAKER',
    nowOverride?: number
): ArbOpportunity {
    const now = nowOverride ?? Date.now();
    const profitPercent = strategy === 'PREDICT_MAKER'
        ? (depth as DepthResult).makerProfit * 100
        : depth.takerProfit * 100;
    const riskLevel = profitPercent > 2 ? 'LOW' : profitPercent > 1 ? 'MEDIUM' : 'HIGH';
    const maxQuantity = strategy === 'PREDICT_MAKER'
        ? (depth as DepthResult).makerMaxQuantity
        : depth.takerMaxQuantity;
    const totalCost = strategy === 'PREDICT_MAKER'
        ? (depth as DepthResult).makerCost
        : depth.takerCost;

    // YES 端使用 DepthResult, NO 端使用 NoSideDepthResult
    const isYes = side === 'YES';
    const yesDepth = depth as DepthResult;
    const noDepth = depth as NoSideDepthResult;
    const predictPrice = isYes
        ? (strategy === 'PREDICT_MAKER' ? yesDepth.predictYesBid : yesDepth.predictYesAsk)
        : (strategy === 'PREDICT_MAKER' ? noDepth.predictNoBid : noDepth.predictNoAsk);

    const opportunity: ArbOpportunity = {
        marketId: pair.predictId,
        title: pair.predictQuestion,
        strategy,
        side,
        profitPercent,
        maxQuantity,
        estimatedProfit: (profitPercent / 100) * maxQuantity,
        predictPrice,
        predictBid: isYes ? yesDepth.predictYesBid : noDepth.predictNoBid,
        predictAsk: isYes ? yesDepth.predictYesAsk : noDepth.predictNoAsk,
        polymarketPrice: isYes ? yesDepth.polymarketNoAsk : noDepth.polymarketYesAsk,
        totalCost,
        makerCost: +((depth as DepthResult).makerCost * 100).toFixed(2),
        takerCost: +(depth.takerCost * 100).toFixed(2),
        depth: {
            predict: isYes
                ? (strategy === 'PREDICT_MAKER' ? yesDepth.predictYesBidDepth : yesDepth.predictYesAskDepth)
                : (depth as NoSideDepthResult).predictYesBidDepth,  // NO ask depth = YES bid depth
            polymarket: isYes ? yesDepth.polymarketNoAskDepth : (depth as NoSideDepthResult).polymarketNoBidDepth,  // YES ask depth = NO bid depth
            polymarketNoAskDepth: isYes ? yesDepth.polymarketNoAskDepth : (depth as NoSideDepthResult).polymarketNoBidDepth,
            predictAskDepth: isYes ? yesDepth.predictYesAskDepth : (depth as NoSideDepthResult).predictYesBidDepth,  // NO ask depth
            predictBidDepth: isYes ? yesDepth.predictYesBidDepth : (depth as NoSideDepthResult).predictYesAskDepth,  // NO bid depth
        },
        lastUpdate: now,
        isInverted: pair.isInverted,
        isNew: true,  // 标记为新机会

        // 执行必需字段
        polymarketConditionId: pair.polymarketConditionId,
        polymarketSlug: getPolymarketSlug(pair.polymarketConditionId) || pair.polymarketSlug,
        predictSlug: pair.categorySlug || getPredictSlug(pair.predictId) || generatePredictSlug(pair.predictQuestion),
        polymarketNoTokenId: pair.polymarketNoTokenId || '',
        polymarketYesTokenId: pair.polymarketYesTokenId || '',
        tickSize: pair.tickSize,
        feeRateBps: pair.feeRateBps,
        negRisk: pair.negRisk,
        outcome: pair.predictTitle !== pair.predictQuestion ? pair.predictTitle : undefined,

        // 风险和费用
        risk: {
            level: riskLevel as 'LOW' | 'MEDIUM' | 'HIGH',
            slippage: 0.5,
        },
        fees: {
            predict: (depth as DepthResult).predictFee || 0,
            gas: 0.01,
        },
        costs: {
            total: totalCost,
        },
        endDate: pair.endDate,
        predictVolume: pair.predictVolume,
        polyVolume: pair.polyVolume,
    };
    applyPointsToOpportunity(opportunity);
    return applyBoostToOpportunity(opportunity);
}

function removeOpportunityByKey(marketId: number, side: 'YES' | 'NO', strategy: 'PREDICT_MAKER' | 'TAKER'): void {
    const key = makeOpportunityKey(marketId, side, strategy);
    const index = dashboardData.opportunities.findIndex(o => o.marketId === marketId && o.side === side && o.strategy === strategy);
    if (index >= 0) {
        dashboardData.opportunities.splice(index, 1);
        opportunityCache.delete(key);
    }

    if (!dashboardData.opportunities.some(o => o.marketId === marketId)) {
        activeMarketIds.delete(marketId);
    }
}

function upsertOpportunityFromDepth(
    pair: MarketPair,
    depth: DepthResult | NoSideDepthResult,
    side: 'YES' | 'NO',
    strategy: 'PREDICT_MAKER' | 'TAKER',
    now: number
): void {
    const profit = strategy === 'PREDICT_MAKER'
        ? (depth as DepthResult).makerProfit
        : depth.takerProfit;

    if (!profit || profit <= 0) {
        removeOpportunityByKey(pair.predictId, side, strategy);
        return;
    }

    const key = makeOpportunityKey(pair.predictId, side, strategy);
    const newOpp = buildOpportunityFromDepth(pair, depth, side, strategy, now);
    const isNewOpportunity = !knownOpportunityIds.has(key);
    newOpp.isNew = isNewOpportunity;
    if (isNewOpportunity) {
        knownOpportunityIds.add(key);
    }

    const index = dashboardData.opportunities.findIndex(o => o.marketId === pair.predictId && o.side === side && o.strategy === strategy);
    if (index >= 0) {
        dashboardData.opportunities[index] = newOpp;
    } else {
        dashboardData.opportunities.push(newOpp);
    }

    opportunityCache.set(key, newOpp);
    activeMarketIds.add(pair.predictId);
}

async function handlePolymarketWsUpdate(tokenId: string): Promise<void> {
    const pair = tokenIdToMarketPair.get(tokenId);
    if (!pair) return;

    // Track Polymarket WS update time
    const now = Date.now();
    lastPolyWsUpdateByToken.set(tokenId, now);

    // Predict orderbook (WS cache)
    const predictCache = getPredictOrderbookForWsUpdate(pair.predictId);
    if (!predictCache) {
        return;  // No Predict cache, skip update
    }

    // Polymarket orderbook (WS cache)
    const polyBook = getPolymarketOrderbookFromWs(tokenId);
    if (!polyBook) return;

    try {
        // YES side (Predict YES + Polymarket hedge)
        let polyHedgeAsks = polyBook.asks;
        if (pair.isInverted) {
            // Inverted market: Predict YES + Polymarket YES = hedge
            // YES ask = 1 - NO bid
            polyHedgeAsks = polyBook.bids.map(level => ({
                price: 1 - level.price,
                size: level.size,
            }));
            polyHedgeAsks.sort((a, b) => a.price - b.price);
        }

        const yesDepth = calculateDepth(
            predictCache.bids,
            predictCache.asks,
            polyHedgeAsks,
            pair.feeRateBps
        );

        upsertOpportunityFromDepth(pair, yesDepth, 'YES', 'PREDICT_MAKER', now);
        upsertOpportunityFromDepth(pair, yesDepth, 'YES', 'TAKER', now);

        // NO side (Predict NO + Polymarket YES)
        if (!pair.isInverted) {
            const noDepth = calculateNoSideDepth(
                predictCache.bids,
                predictCache.asks,
                polyBook.bids,  // Polymarket NO bids
                pair.feeRateBps
            );

            upsertOpportunityFromDepth(pair, noDepth, 'NO', 'PREDICT_MAKER', now);
            upsertOpportunityFromDepth(pair, noDepth, 'NO', 'TAKER', now);
        } else {
            removeOpportunityByKey(pair.predictId, 'NO', 'PREDICT_MAKER');
            removeOpportunityByKey(pair.predictId, 'NO', 'TAKER');
        }

        // Broadcast updated opportunities
        markOpportunityDirty();
        // Trigger downstream recompute
        scheduleSportsRecompute();
        scheduleCloseRecompute();
    } catch {
        // Ignore calculation failures
    }
}


let predictWsUpdateTimer: ReturnType<typeof setTimeout> | null = null;
const pendingPredictWsUpdates = new Set<number>();

/**
 * 处理 Predict WS 订单簿更新，触发机会重算
 * - 与 Polymarket WS 保持一致的处理逻辑
 * - 节流 50ms 避免频繁计算
 */
function handlePredictWsUpdate(marketId: number): void {
    pendingPredictWsUpdates.add(marketId);

    if (predictWsUpdateTimer) return;  // 已有定时器，等待批量处理

    predictWsUpdateTimer = setTimeout(() => {
        predictWsUpdateTimer = null;
        const marketIds = Array.from(pendingPredictWsUpdates);
        pendingPredictWsUpdates.clear();

        for (const id of marketIds) {
            processPredictWsUpdate(id);
        }
    }, PREDICT_WS_UPDATE_THROTTLE_MS);
}

/**
 * 实际处理 Predict WS 更新
 * 找到对应的 Polymarket token，触发机会重算
 * WS-only 模式：支持创建新机会
 */
function processPredictWsUpdate(marketId: number): void {
    // Resolve Polymarket token
    const pair = marketPairs.find(p => p.predictId === marketId);
    if (!pair || !pair.polymarketTokenId) return;

    // Predict orderbook (WS cache)
    const predictCache = getPredictOrderbookForWsUpdate(marketId);
    if (!predictCache) return;

    // Polymarket orderbook (WS cache)
    const polyBook = getPolymarketOrderbookFromWs(pair.polymarketTokenId);
    if (!polyBook) return;

    try {
        const now = Date.now();

        // YES side (Predict YES + Polymarket hedge)
        let polyHedgeAsks = polyBook.asks;
        if (pair.isInverted) {
            // Inverted market: Predict YES + Polymarket YES = hedge
            // YES ask = 1 - NO bid
            polyHedgeAsks = polyBook.bids.map(level => ({
                price: 1 - level.price,
                size: level.size,
            }));
            polyHedgeAsks.sort((a, b) => a.price - b.price);
        }

        const yesDepth = calculateDepth(
            predictCache.bids,
            predictCache.asks,
            polyHedgeAsks,
            pair.feeRateBps
        );

        upsertOpportunityFromDepth(pair, yesDepth, 'YES', 'PREDICT_MAKER', now);
        upsertOpportunityFromDepth(pair, yesDepth, 'YES', 'TAKER', now);

        // NO side (Predict NO + Polymarket YES)
        if (!pair.isInverted) {
            const noDepth = calculateNoSideDepth(
                predictCache.bids,
                predictCache.asks,
                polyBook.bids,
                pair.feeRateBps
            );

            upsertOpportunityFromDepth(pair, noDepth, 'NO', 'PREDICT_MAKER', now);
            upsertOpportunityFromDepth(pair, noDepth, 'NO', 'TAKER', now);
        } else {
            removeOpportunityByKey(pair.predictId, 'NO', 'PREDICT_MAKER');
            removeOpportunityByKey(pair.predictId, 'NO', 'TAKER');
        }

        // Trigger downstream recompute
        markOpportunityDirty();
        scheduleSportsRecompute();
        scheduleCloseRecompute();
    } catch {
        // Ignore calculation failures
    }
}


async function fetchMarketVolumes(): Promise<void> {
    if (marketPairs.length === 0) return;

    console.log('📊 获取 volume 数据...');

    // 1. 获取 Polymarket volume (从 Gamma API)
    try {
        const res = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500');
        if (res.ok) {
            const markets = await res.json() as Array<{ conditionId?: string; volumeNum?: number }>;
            const volumeMap = new Map<string, number>();
            for (const m of markets) {
                if (m.conditionId && m.volumeNum) {
                    volumeMap.set(m.conditionId, m.volumeNum);
                }
            }

            let polyUpdated = 0;
            for (const pair of marketPairs) {
                const vol = volumeMap.get(pair.polymarketConditionId);
                if (vol !== undefined && vol > 0) {
                    pair.polyVolume = vol;
                    polyUpdated++;
                }
            }
            console.log(`   Polymarket: ${polyUpdated}/${marketPairs.length} 个市场`);
        }
    } catch {
        console.log('   ⚠️ Polymarket volume 获取失败');
    }

    // 2. 获取 Predict volume (从 Stats API)
    const apiKeys = [
        process.env.PREDICT_API_KEY_SCAN,
        process.env.PREDICT_API_KEY_SCAN_2,
        process.env.PREDICT_API_KEY_SCAN_3,
        process.env.PREDICT_API_KEY,
    ].filter(Boolean) as string[];

    if (apiKeys.length === 0) {
        console.log('   ⚠️ 无可用 API Key，跳过 Predict volume');
        return;
    }

    try {
        const volumeMap = new Map<number, number>();
        const batchSize = Math.min(apiKeys.length * 3, 10);

        for (let i = 0; i < marketPairs.length; i += batchSize) {
            const batch = marketPairs.slice(i, i + batchSize);
            const results = await Promise.all(batch.map(async (pair, idx) => {
                const apiKey = apiKeys[(i + idx) % apiKeys.length];
                try {
                    const res = await fetch(`https://api.predict.fun/v1/markets/${pair.predictId}/stats`, {
                        headers: { 'x-api-key': apiKey }
                    });
                    if (!res.ok) return { marketId: pair.predictId, volume: 0 };
                    const data = await res.json() as any;
                    return { marketId: pair.predictId, volume: data.data?.volumeTotalUsd || 0 };
                } catch {
                    return { marketId: pair.predictId, volume: 0 };
                }
            }));

            for (const r of results) {
                if (r.volume > 0) volumeMap.set(r.marketId, r.volume);
            }
        }

        let predictUpdated = 0;
        for (const pair of marketPairs) {
            const vol = volumeMap.get(pair.predictId);
            if (vol !== undefined && vol > 0) {
                pair.predictVolume = vol;
                predictUpdated++;
            }
        }
        console.log(`   Predict: ${predictUpdated}/${marketPairs.length} 个市场`);
    } catch {
        console.log('   ⚠️ Predict volume 获取失败');
    }
}

// ============================================================================
// 流动性扫描 (Predict API)
// ============================================================================

// LiquidityScanItem, LiquidityScanResult 从 dashboard-types.ts 导入

let liquidityScanCache: LiquidityScanResult | null = null;
let liquidityScanRunning = false;

async function runLiquidityScan(): Promise<void> {
    if (liquidityScanRunning) return;
    liquidityScanRunning = true;

    const apiKeys = [
        process.env.PREDICT_API_KEY_SCAN,
        process.env.PREDICT_API_KEY_SCAN_2,
        process.env.PREDICT_API_KEY_SCAN_3,
        process.env.PREDICT_API_KEY,
    ].filter(Boolean) as string[];

    if (apiKeys.length === 0) {
        console.warn('[LiquidityScan] 无可用 API Key');
        liquidityScanRunning = false;
        return;
    }

    console.log('[LiquidityScan] 开始扫描 Predict 市场...');
    const startTime = Date.now();

    try {
        // 1. 分页获取活跃市场 (按 24h volume 降序，取前 200 个)
        const allMarkets: Array<{
            id: number;
            title: string;
            categorySlug: string;
            outcomes: Array<{ name: string; indexSet: number }>;
        }> = [];

        let cursor = '';
        for (let page = 0; page < 2; page++) {
            const url = `https://api.predict.fun/v1/markets?status=OPEN&sort=VOLUME_24H_DESC&first=100${cursor ? '&after=' + cursor : ''}`;
            const apiKey = apiKeys[page % apiKeys.length];
            const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
            if (!res.ok) {
                if (res.status === 429) {
                    await new Promise(r => setTimeout(r, 3000));
                    page--;
                    continue;
                }
                console.warn(`[LiquidityScan] 获取市场列表失败: ${res.status}`);
                break;
            }
            const data = await res.json() as { data?: any[]; cursor?: string };
            const markets = Array.isArray(data.data) ? data.data : [];
            if (markets.length === 0) break;

            for (const m of markets) {
                allMarkets.push({
                    id: Number(m.id),
                    title: m.title || m.question || '',
                    categorySlug: m.categorySlug || '',
                    outcomes: Array.isArray(m.outcomes) ? m.outcomes : [],
                });
            }

            cursor = data.cursor || '';
            if (!cursor) break;
            await new Promise(r => setTimeout(r, 100));
        }

        if (allMarkets.length === 0) {
            console.warn('[LiquidityScan] 未获取到任何市场');
            liquidityScanRunning = false;
            return;
        }

        console.log(`[LiquidityScan] 获取到 ${allMarkets.length} 个市场，开始批量获取 stats...`);

        // 2. 批量获取 stats (volume24hUsd, totalLiquidityUsd)
        const statsMap = new Map<number, { volume24h: number; liquidity: number }>();
        const batchSize = Math.min(apiKeys.length * 3, 10);

        for (let i = 0; i < allMarkets.length; i += batchSize) {
            const batch = allMarkets.slice(i, i + batchSize);
            const results = await Promise.all(batch.map(async (market, idx) => {
                const apiKey = apiKeys[(i + idx) % apiKeys.length];
                try {
                    const res = await fetch(`https://api.predict.fun/v1/markets/${market.id}/stats`, {
                        headers: { 'x-api-key': apiKey },
                    });
                    if (!res.ok) return null;
                    const data = await res.json() as any;
                    return {
                        marketId: market.id,
                        volume24h: data.data?.volume24hUsd ?? 0,
                        liquidity: data.data?.totalLiquidityUsd ?? 0,
                    };
                } catch {
                    return null;
                }
            }));

            for (const r of results) {
                if (r && (r.volume24h > 0 || r.liquidity > 0)) {
                    statsMap.set(r.marketId, { volume24h: r.volume24h, liquidity: r.liquidity });
                }
            }

            // 避免触发限流
            if (i + batchSize < allMarkets.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }

        // 3. 计算比值并排序
        const ranked: LiquidityScanItem[] = [];
        for (const market of allMarkets) {
            const stats = statsMap.get(market.id);
            if (!stats || stats.liquidity <= 0 || stats.volume24h <= 0) continue;
            ranked.push({
                marketId: market.id,
                title: market.title,
                categorySlug: market.categorySlug,
                predictSlug: market.categorySlug,
                outcomeCount: market.outcomes?.length ?? 2,
                volume24h: stats.volume24h,
                liquidity: stats.liquidity,
                volumeLiquidityRatio: stats.volume24h / stats.liquidity,
            });
        }

        ranked.sort((a, b) => b.volumeLiquidityRatio - a.volumeLiquidityRatio);

        liquidityScanCache = {
            data: {
                valid: ranked.length,
                top20: ranked.slice(0, 20),
            },
            lastScanTime: Date.now(),
        };

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[LiquidityScan] 完成: ${ranked.length} 个有效市场, Top1 ratio=${ranked[0]?.volumeLiquidityRatio.toFixed(2) ?? 'N/A'}, 耗时 ${duration}s`);
    } catch (err: any) {
        console.error('[LiquidityScan] 扫描异常:', err?.message || err);
    } finally {
        liquidityScanRunning = false;
    }
}

async function initPolymarketWs(): Promise<void> {
    try {
        const opportunities: ArbOpportunity[] = [];
        polymarketWsClient = new PolymarketWebSocketClient();
        let polyWsFirstConnect = true;
        polymarketWsClient.setHandlers({
            onConnect: () => {
                console.log('[WS] Polymarket connected');
                if (polyWsFirstConnect) {
                    polyWsFirstConnect = false;
                } else {
                    // 重连通知（非首次连接）
                    sendWsNotification('✅ Polymarket WS 已重连');
                }
            },
            onDisconnect: (code, reason) => {
                console.log(`[WS] Polymarket disconnected (${code} ${reason})`);
                sendWsNotification(`⚠️ Polymarket WS 断连 (${code} ${reason})`);
            },
            onError: (error) => {
                console.log(`[WS] Polymarket error: ${error.message}`);
            },
            // 订单簿更新触发增量推送
            onOrderBookUpdate: (book) => {
                const now = Date.now();
                if (now - lastWsUpdateBroadcast < WS_UPDATE_THROTTLE_MS) return;
                lastWsUpdateBroadcast = now;

                // 触发增量更新（非阻塞）
                handlePolymarketWsUpdate(book.assetId).catch(() => { /* ignore */ });
            },
        });

        await polymarketWsClient.connect();

        // 注入 WS 订单簿提供者（实时数据，减少 API 调用）
        setPolyOrderbookProvider(getPolymarketOrderbookFromWs);  // hedge-mode 用
        setPolymarketWsOrderbookProvider(getPolymarketOrderbookFromWs);  // 任务执行用
        console.log('[WS] Polymarket WS 订单簿提供者已注入 (hedge-mode + PolymarketTrader)');
    } catch {
        console.log('[WS] Polymarket connect failed, fallback to REST');
        polymarketWsClient = null;
    }
}

function subscribePolymarketTokens(additionalTokenIds: string[] = []): void {
    if (!polymarketWsClient) return;

    // 主市场 tokens（包含 YES 和 NO tokens，用于任务对冲）
    const mainTokenIds: string[] = [];
    for (const pair of marketPairs) {
        if (pair.polymarketTokenId) mainTokenIds.push(pair.polymarketTokenId);
        if (pair.polymarketYesTokenId) mainTokenIds.push(pair.polymarketYesTokenId);
        if (pair.polymarketNoTokenId) mainTokenIds.push(pair.polymarketNoTokenId);
    }

    // 合并主市场 + 体育市场 tokens
    const allTokenIds = [...mainTokenIds, ...additionalTokenIds];
    const uniqueTokenIds = Array.from(new Set(allTokenIds));

    if (uniqueTokenIds.length === 0) return;

    polymarketWsClient.subscribe(uniqueTokenIds);
    console.log(`[WS] Subscribed to ${uniqueTokenIds.length} Polymarket tokens (main markets: ${marketPairs.length}, sports: ${additionalTokenIds.length})`);
}

// ============================================================================
// Data Update Functions
// ============================================================================

let lastBroadcastedMarketsJson = '';  // markets 去重（元数据几乎不变，110KB 全量推送触发背压）

async function broadcastUpdate(): Promise<void> {
    dashboardData.stats.lastFullUpdate = new Date().toISOString();

    // 发送带事件类型的 SSE 消息 (与前端 useSSE.ts 匹配)
    const statsData = JSON.stringify(dashboardData.stats);

    // 获取真实账户数据
    const accountsData = JSON.stringify(await getAccountData());

    // 市场列表 - 仅在内容变化时推送（元数据几乎不变，避免 110KB 重复推送触发背压）
    const marketsData = JSON.stringify(marketPairs.map(p => ({
        predictId: p.predictId,
        predictTitle: p.predictTitle,
        predictQuestion: p.predictQuestion,
        predictSlug: p.categorySlug || getPredictSlug(p.predictId) || generatePredictSlug(p.predictQuestion),
        polymarketConditionId: p.polymarketConditionId,
        polymarketSlug: getPolymarketSlug(p.polymarketConditionId) || p.polymarketSlug,
        feeRateBps: p.feeRateBps,
        isInverted: p.isInverted,
        endDate: p.endDate
    })));

    // tasks 不在周期性广播中推送（2MB+ 触发 drain_timeout）
    // 任务变化已通过独立 'task'/'taskDeleted' SSE 事件实时推送，初始连接发全量

    // 体育市场数据 (仅当启用时) - 增量推送
    const sportsData = ENABLE_SPORTS_SERVICE
        ? JSON.stringify(getSportsService().getSSEDataIncremental())
        : JSON.stringify({ updated: [], removed: [], stats: { totalMatched: 0, withArbitrage: 0, avgProfit: 0, maxProfit: 0 }, lastUpdate: 0 });

    // 使用节流广播调度器 (200ms 节流)
    markOpportunityDirty();
    markDirty('stats', statsData);
    markDirty('accounts', accountsData);
    if (marketsData !== lastBroadcastedMarketsJson) {
        lastBroadcastedMarketsJson = marketsData;
        markDirty('markets', marketsData);
    }
    markDirty('sports', sportsData);
}

// ============================================================================
// HTTP Server
// ============================================================================

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url || '/';

    if (url === '/api/stream') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...corsHeaders,
        });

        // 先注册客户端元数据（发送初始数据前，确保背压日志能获取到 metadata）
        // initialized=false 表示初始快照尚未完成，广播会跳过此客户端
        const clientMeta: SSEClientMeta = {
            ip: (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
                || req.socket?.remoteAddress
                || 'unknown',
            ua: (req.headers['user-agent'] || 'unknown').slice(0, 50),  // 截断避免过长
            connectedAt: Date.now(),
            initialized: false,
            backpressured: false,
            drainTimeoutCount: 0,
            lastBackpressureLogTime: 0,
            backpressureCycleCount: 0,
        };
        sseClients.set(res, clientMeta);
        req.on('close', () => sseClients.delete(res));

        // 异步发送初始数据（使用异步写入函数，支持 drain 等待）
        (async () => {
            try {
                // 发送初始 opportunity 全量快照
                if (allMarketsEnabled) {
                    if (!await sendOpportunityBatchesAsync(res, dashboardData.opportunities)) return;
                } else {
                    if (!await sendSSEToClientAsync(res, 'opportunity-batch', JSON.stringify({ snapshot: true, updated: [], removed: [] }))) return;
                }
                if (!await sendSSEToClientAsync(res, 'stats', JSON.stringify(dashboardData.stats))) return;

                // 昂贵计算前检查客户端是否仍存活（避免无效 API 调用）
                if (!isSSEClientAlive(res)) return;

                // 发送真实账户数据（涉及多个 API 调用）
                const accountsData = await getAccountData();
                if (!await sendSSEToClientAsync(res, 'accounts', JSON.stringify(accountsData))) return;

                // 市场列表构建前再检查一次（marketPairs 较大时可能有开销）
                if (!isSSEClientAlive(res)) return;

                // 发送市场列表
                const marketsData = marketPairs.map(p => ({
                    predictId: p.predictId,
                    predictTitle: p.predictTitle,
                    predictQuestion: p.predictQuestion,
                    predictSlug: p.categorySlug || getPredictSlug(p.predictId) || generatePredictSlug(p.predictQuestion),
                    polymarketConditionId: p.polymarketConditionId,
                    polymarketSlug: getPolymarketSlug(p.polymarketConditionId) || p.polymarketSlug,
                    feeRateBps: p.feeRateBps,
                    isInverted: p.isInverted,
                    endDate: p.endDate
                }));
                if (!await sendSSEToClientAsync(res, 'markets', JSON.stringify(marketsData))) return;

                // 发送体育市场数据 (优先于 tasks，因为 tasks 可能很大导致 SSH 隧道背压)
                const sportsData = ENABLE_SPORTS_SERVICE
                    ? getSportsService().getSSEDataSnapshot()
                    : { snapshot: true, updated: [], removed: [], stats: { totalMatched: 0, withArbitrage: 0, avgProfit: 0, maxProfit: 0 }, lastUpdate: 0 };
                if (!await sendSSEToClientAsync(res, 'sports', JSON.stringify(sportsData))) return;

                // 发送任务列表 (限制 terminal 任务数量，避免 SSE 初始快照过大)
                const MAX_TERMINAL_TASKS_IN_SNAPSHOT = 200;
                const allTasks = taskService.getTasks({ includeCompleted: true });
                const activeTasks = allTasks.filter(t => !isTerminalTaskStatus(t.status));
                const terminalTasks = allTasks.filter(t => isTerminalTaskStatus(t.status)).slice(0, MAX_TERMINAL_TASKS_IN_SNAPSHOT);
                const snapshotTasks = [...activeTasks, ...terminalTasks].sort((a, b) => b.createdAt - a.createdAt);
                if (!await sendSSEToClientAsync(res, 'tasks', JSON.stringify(snapshotTasks))) return;

                // 发送平仓机会数据（使用缓存，避免初始化时阻塞）
                if (!await sendSSEToClientAsync(res, 'closeOpportunities', JSON.stringify(cachedCloseOpportunities))) return;

                // 初始快照发送完毕，标记为已初始化（后续广播将包含此客户端）
                clientMeta.initialized = true;

                // 补偿同步：快照期间可能漏掉的增量更新
                // 数据源与 broadcastUpdate() 一致（都读 dashboardData 全局对象），确保一致性
                // 顺序与快照开头一致（opportunity → stats → tasks），减少前端渲染闪动
                if (!await sendOpportunityBatchesAsync(res, dashboardData.opportunities)) return;
                if (!await sendSSEToClientAsync(res, 'stats', JSON.stringify(dashboardData.stats))) return;
                const latestAll = taskService.getTasks({ includeCompleted: true });
                const latestActive = latestAll.filter(t => !isTerminalTaskStatus(t.status));
                const latestTerminal = latestAll.filter(t => isTerminalTaskStatus(t.status)).slice(0, MAX_TERMINAL_TASKS_IN_SNAPSHOT);
                const latestSnapshot = [...latestActive, ...latestTerminal].sort((a, b) => b.createdAt - a.createdAt);
                if (!await sendSSEToClientAsync(res, 'tasks', JSON.stringify(latestSnapshot))) return;
            } catch (error) {
                console.error('[SSE] 初始化数据发送失败:', error);
                sseClients.delete(res);
                try { res.end(); } catch {}
            }
        })();
        return;
    }

    if (url === '/api/data') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'application/json',
            ...corsHeaders,
        });
        res.end(JSON.stringify(dashboardData));
        return;
    }

    if (url === '/api/rescan' && req.method === 'POST') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        res.writeHead(200, {
            'Content-Type': 'application/json',
            ...corsHeaders,
        });

        // 异步执行扫描,不阻塞响应（windowsHide 防止弹出 cmd 窗口）
        console.log('\n🔍 收到扫描请求，正在后台执行...\n');

        import('child_process').then(({ exec }) => {
            exec('npx tsx src/terminal/scan-all-markets.ts', {
                cwd: join(__dirname, '..', '..'),
                windowsHide: true,
            }, (error, stdout, stderr) => {
                if (error) {
                    console.error('❌ 扫描失败:', error);
                    return;
                }
                console.log('✅ 扫描完成');
                console.log(stdout);

                // 扫描完成后,需要重启服务器以加载新的市场列表
                console.log('\n⚠️  新市场已扫描,请手动重启Dashboard以加载最新数据\n');
            });
        });

        res.end(JSON.stringify({
            success: true,
            message: '扫描已在后台启动，完成后请刷新页面'
        }));
        return;
    }

    // ========================================================================
    // Task API 端点
    // ========================================================================

    // CORS preflight
    if (req.method === 'OPTIONS') {
        const corsHeaders = getSecureCorsHeaders(req);
        res.writeHead(204, {
            ...corsHeaders,
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, PATCH, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
    }

    // GET /api/tasks/auto-preview - 生成自动任务预览 (仅 M-T / BUY 候选)
    if (url?.startsWith('/api/tasks/auto-preview') && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
            const sourceParam = new URL(url, 'http://127.0.0.1').searchParams.get('source');
            const source = sourceParam === 'all' || sourceParam === 'sports' || sourceParam === 'mixed' || sourceParam === 'poly-maker'
                ? sourceParam
                : sourceParam === 'live'
                    ? 'all'
                    : 'mixed';
            const accounts = await getAccountData();
            const sportsMarkets = ENABLE_SPORTS_SERVICE ? getSportsService().getMarkets() : [];
            const preview = generateAutoTaskPreview({
                opportunities: dashboardData.opportunities,
                sportsMarkets,
                source,
                accounts,
                hasActiveTask: (marketId, type, arbSide, strategy) => taskService.hasActiveTask(marketId, type, arbSide, strategy),
            });

            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: preview }));
        } catch (error: any) {
            console.error('[Dashboard] 自动任务预览生成失败:', error);
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // 根据 source 选择对应 runner (poly-maker 用独立 runner，其余共用 maker runner)
    const getRunnerBySource = (source: string) =>
        source === 'poly-maker' ? polyMakerAutoCreateRunner : autoTaskCreateRunner;

    // GET /api/tasks/auto-create?source=xxx - 获取批量创建状态
    if (url?.startsWith('/api/tasks/auto-create') && !url.includes('/control') && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
        const source = parsedUrl.searchParams.get('source') || 'sports';
        const runner = getRunnerBySource(source);
        res.writeHead(200, {
            'Content-Type': 'application/json',
            ...corsHeaders,
        });
        res.end(JSON.stringify({ success: true, data: runner.getStatus() }));
        return;
    }

    if (url === '/api/tasks/auto-create' && req.method === 'POST') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
            const input = await parseJsonBody<AutoCreateTasksInput>(req);
            const source = input.source === 'all' || input.source === 'sports' || input.source === 'mixed' || input.source === 'poly-maker'
                ? input.source
                : 'mixed';
            const autoStart = input.autoStart !== false;
            const requestedIds = Array.isArray(input.candidateIds)
                ? input.candidateIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
                : undefined;

            const accounts = await getAccountData();
            const sportsMarkets = ENABLE_SPORTS_SERVICE ? getSportsService().getMarkets() : [];
            const preview = generateAutoTaskPreview({
                opportunities: dashboardData.opportunities,
                sportsMarkets,
                source,
                accounts,
                hasActiveTask: (marketId, type, arbSide, strategy) => taskService.hasActiveTask(marketId, type, arbSide, strategy),
            });

            const runner = getRunnerBySource(source);
            const candidates = filterAutoCreateCandidates(preview.candidates, requestedIds);
            const status = runner.start({
                source,
                candidates,
                autoStart,
            });

            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: status }));
        } catch (error: any) {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    if (url === '/api/tasks/auto-create/control' && req.method === 'POST') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
            const input = await parseJsonBody<{ action?: 'pause' | 'resume' | 'stop'; source?: string }>(req);
            const runner = getRunnerBySource(input.source || 'sports');
            let status;

            if (input.action === 'pause') {
                status = runner.requestPause();
            } else if (input.action === 'resume') {
                status = runner.resume();
            } else if (input.action === 'stop') {
                status = runner.stop();
            } else {
                throw new Error('Invalid action');
            }

            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: status }));
        } catch (error: any) {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/pp-farmer/status - PP Farmer 当前状态
    if (url?.startsWith('/api/pp-farmer/status') && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        const source = new URL(url, 'http://127.0.0.1').searchParams.get('source');
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ success: true, data: getPpFarmerRunner(source).getState() }));
        return;
    }

    // POST /api/pp-farmer/toggle?source=all|sports - 切换 PP Farmer 开关 (off→on 会立即触发一次)
    if (url?.startsWith('/api/pp-farmer/toggle') && req.method === 'POST') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
            const source = new URL(url, 'http://127.0.0.1').searchParams.get('source');
            const state = await getPpFarmerRunner(source).toggle();
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: true, data: state }));
        } catch (error: any) {
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // POST /api/pp-farmer/config?source=all|sports - 设置 PP Farmer 配置 (收益率阈值 / 资金池比例)
    if (url?.startsWith('/api/pp-farmer/config') && req.method === 'POST') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
            const source = new URL(url, 'http://127.0.0.1').searchParams.get('source');
            const runner = getPpFarmerRunner(source);
            const body = await parseJsonBody<{ yieldThreshold?: number; budgetPoolRatio?: number }>(req);
            const tRaw = body?.yieldThreshold;
            const rRaw = body?.budgetPoolRatio;
            const hasT = tRaw !== undefined && tRaw !== null;
            const hasR = rRaw !== undefined && rRaw !== null;
            if (!hasT && !hasR) {
                res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
                res.end(JSON.stringify({ success: false, error: 'must provide yieldThreshold or budgetPoolRatio' }));
                return;
            }
            if (hasT) {
                const t = Number(tRaw);
                if (!Number.isFinite(t) || t < 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
                    res.end(JSON.stringify({ success: false, error: 'yieldThreshold must be a non-negative number' }));
                    return;
                }
                runner.setYieldThreshold(t);
            }
            if (hasR) {
                const r = Number(rRaw);
                if (!Number.isFinite(r) || r < 0 || r > 0.5) {
                    res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
                    res.end(JSON.stringify({ success: false, error: 'budgetPoolRatio must be between 0 and 0.5' }));
                    return;
                }
                runner.setBudgetPoolRatio(r);
            }
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: true, data: runner.getState() }));
        } catch (error: any) {
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/pp-archive - 获取归档列表
    if (url === '/api/pp-archive' && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ success: true, data: getArchive() }));
        return;
    }

    // POST /api/pp-archive/add - 加入归档
    if (url === '/api/pp-archive/add' && req.method === 'POST') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
            const body = await parseJsonBody<{ marketId?: number | string; title?: string; reason?: string }>(req);
            const id = Number(body?.marketId);
            if (!Number.isFinite(id)) {
                res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
                res.end(JSON.stringify({ success: false, error: 'marketId required' }));
                return;
            }
            const entry = addToArchive(id, body?.title || `market ${id}`, body?.reason);
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: true, data: entry }));
        } catch (error: any) {
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // POST /api/pp-archive/remove - 从归档中移除
    if (url === '/api/pp-archive/remove' && req.method === 'POST') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
            const body = await parseJsonBody<{ marketId?: number | string }>(req);
            const id = Number(body?.marketId);
            if (!Number.isFinite(id)) {
                res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
                res.end(JSON.stringify({ success: false, error: 'marketId required' }));
                return;
            }
            const removed = removeFromArchive(id);
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: true, data: { marketId: id, removed } }));
        } catch (error: any) {
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/tasks - 获取任务列表
    if (url === '/api/tasks/batch-cancel' && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        res.writeHead(200, {
            'Content-Type': 'application/json',
            ...corsHeaders,
        });
        res.end(JSON.stringify({ success: true, data: batchTaskCancelRunner.getStatus() }));
        return;
    }

    if (url === '/api/tasks/batch-cancel' && req.method === 'POST') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
            const input = await parseJsonBody<BatchCancelTasksInput>(req);
            const requestedIds = Array.isArray(input.taskIds)
                ? input.taskIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
                : [];

            const activeTasks = taskService.getTasks({ includeCompleted: false });
            const activeTaskMap = new Map(activeTasks.map((task) => [task.id, task]));
            const tasksToCancel = requestedIds.length > 0
                ? requestedIds
                    .map((id) => activeTaskMap.get(id))
                    .filter((task): task is Task => Boolean(task))
                : activeTasks;

            const status = batchTaskCancelRunner.start({ tasks: tasksToCancel });

            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: status }));
        } catch (error: any) {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    if (url === '/api/tasks/batch-cancel/control' && req.method === 'POST') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
            const input = await parseJsonBody<{ action?: 'stop' }>(req);
            if (input.action !== 'stop') {
                throw new Error('Invalid action');
            }
            const status = batchTaskCancelRunner.stop();
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: status }));
        } catch (error: any) {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    if (url === '/api/tasks' && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
        const opportunities: ArbOpportunity[] = [];
            const tasks = taskService.getTasks({ includeCompleted: true });
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: tasks }));
        } catch (error: any) {
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // POST /api/tasks - 创建任务 (支持 autoStart=true 一次请求完成 create+start)
    if (url === '/api/tasks' && req.method === 'POST') {
        const taskReqStart = Date.now();
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
        const opportunities: ArbOpportunity[] = [];
            const input = await parseJsonBody<CreateTaskInput & { autoStart?: boolean }>(req);

            // 计时：从前端 Date.now() 到后端收到请求
            const frontendTs = input.idempotencyKey ? parseInt(input.idempotencyKey.split('-').pop() || '0') : 0;
            const networkDelay = frontendTs ? taskReqStart - frontendTs : -1;
            console.log(`[TaskTiming] marketId=${input.marketId}, networkDelay=${networkDelay}ms, parseBody=${Date.now() - taskReqStart}ms`);

            // 调试日志：检查前端传入的 negRisk 值
            console.log(`[negRisk] Task create input: marketId=${input.marketId}, negRisk=${input.negRisk}`);

            const task = taskService.createTask(input);

            // 动态订阅任务的 Polymarket token 到 WebSocket
            subscribeTaskTokensForWs(input);

            broadcastTaskUpdate(task);

            // autoStart: 合并 create+start 为一次请求，避免 SSH 隧道二次 round trip
            if (input.autoStart) {
                try {
                    await taskExecutor.startTask(task.id);
                    const updated = taskService.getTask(task.id);
                    res.writeHead(201, {
                        'Content-Type': 'application/json',
                        ...corsHeaders,
                    });
                    res.end(JSON.stringify({ success: true, data: updated, started: true }));
                } catch (startError: any) {
                    // 任务已创建但启动失败
                    res.writeHead(201, {
                        'Content-Type': 'application/json',
                        ...corsHeaders,
                    });
                    res.end(JSON.stringify({ success: true, data: task, started: false, startError: startError.message }));
                }
            } else {
                res.writeHead(201, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({ success: true, data: task }));
            }
        } catch (error: any) {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/tasks/:id - 获取单个任务
    const taskGetMatch = url.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)$/);
    if (taskGetMatch && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        const taskId = taskGetMatch[1];
        const task = taskService.getTask(taskId);
        if (task) {
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: task }));
        } else {
            res.writeHead(404, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: 'Task not found' }));
        }
        return;
    }

    // DELETE /api/tasks/:id - 取消/删除任务
    const taskDeleteMatch = url.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)$/);
    if (taskDeleteMatch && req.method === 'DELETE') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        const taskId = taskDeleteMatch[1];
        try {
        const opportunities: ArbOpportunity[] = [];
            const task = taskService.getTask(taskId);
            if (!task) {
                res.writeHead(404, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({ success: false, error: 'Task not found' }));
                return;
            }

            // 根据状态决定操作
            if (['COMPLETED', 'FAILED', 'CANCELLED', 'UNWIND_COMPLETED'].includes(task.status)) {
                // 终态任务直接删除
                taskService.deleteTask(taskId);
                broadcastTaskDeleted(taskId);
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({ success: true, message: 'Task deleted' }));
            } else {
                // 活跃任务取消：使用 taskExecutor.cancelTask() 来取消订单
                // taskService.cancelTask() 只更新状态，不取消实际订单
                await taskExecutor.cancelTask(taskId);
                const cancelled = taskService.getTask(taskId);
                broadcastTaskUpdate(cancelled!);

                // 发送 TG 通知：任务取消（fire-and-forget，不阻塞响应）
                const tg = getTelegramNotifier();
                if (tg && cancelled) {
                    // 已成交按主动方口径：POLY_MAKER 看 Poly 成交，其余看 Predict 成交
                    const activeFilled = cancelled.strategy === 'POLY_MAKER'
                        ? (cancelled.polyFilledQty ?? 0)
                        : (cancelled.predictFilledQty ?? 0);
                    tg.sendText(`🛑 <b>任务已取消</b>\n\n<b>市场:</b> ${cancelled.title}\n<b>类型:</b> ${cancelled.type}\n<b>状态:</b> ${task.status} → CANCELLED\n<b>已成交:</b> ${activeFilled}/${cancelled.quantity}`)
                        .catch(err => console.warn('[Dashboard] TG 通知发送失败:', err.message));
                }

                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({ success: true, data: cancelled }));
            }
        } catch (error: any) {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // POST /api/tasks/:id/start - 开始执行任务
    const taskStartMatch = url.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)\/start$/);
    if (taskStartMatch && req.method === 'POST') {
        const startReqTime = Date.now();
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        const taskId = taskStartMatch[1];
        console.log(`[TaskTiming] /start taskId=${taskId}, reqReceived=${startReqTime}`);
        try {
        const opportunities: ArbOpportunity[] = [];
            const task = taskService.getTask(taskId);
            if (!task) {
                res.writeHead(404, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({ success: false, error: 'Task not found' }));
                return;
            }

            if (task.status !== 'PENDING') {
                res.writeHead(400, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({
                    success: false,
                    error: `Task cannot be started from status: ${task.status}`
                }));
                return;
            }

            // 前置检查: 任务是否已在运行中 (状态可能仍为 PENDING 但实际已启动)
            if (taskExecutor.isTaskRunning(taskId)) {
                res.writeHead(409, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({
                    success: false,
                    error: `Task ${taskId} is already running`
                }));
                return;
            }

            // 启动 TaskExecutor (await 确保初始化阶段的错误能返回前端)
            await taskExecutor.startTask(taskId);

            // 立即返回，任务状态更新通过 SSE 推送
            const updated = taskService.getTask(taskId);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: updated }));
        } catch (error: any) {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // PATCH /api/tasks/:id - 更新任务 (expiresAt)
    const taskPatchMatch = url.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)$/);
    if (taskPatchMatch && req.method === 'PATCH') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        const taskId = taskPatchMatch[1];
        try {
            const body = await parseJsonBody<{ expiresAt?: number | null }>(req);
            const { expiresAt } = body;

            const task = taskService.getTask(taskId);
            if (!task) {
                res.writeHead(404, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({ success: false, error: 'Task not found' }));
                return;
            }

            // 更新 expiresAt (null 表示取消定时)
            const newExpiresAt = expiresAt === null ? undefined : expiresAt;
            const updated = taskService.updateTaskExpiry(taskId, newExpiresAt);

            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: updated }));
        } catch (error: any) {
            res.writeHead(400, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // ========================================================================
    // 平仓 API (需鉴权)
    // ========================================================================

    // GET /api/close-opportunities - 获取平仓机会（使用缓存，支持 refresh 参数强制刷新）
    if (url?.startsWith('/api/close-opportunities') && req.method === 'GET') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        try {
            // 解析查询参数
            const urlObj = new URL(url, `http://${req.headers.host || 'localhost'}`);
            const forceRefresh = urlObj.searchParams.get('refresh') === 'true';

            let opportunities = cachedCloseOpportunities;

            // 强制刷新或缓存为空时重新计算
            const shouldForceRefresh = forceRefresh || cachedCloseOpportunities.length === 0;
            if (shouldForceRefresh) {
                opportunities = await calculateCloseOpportunities(shouldForceRefresh);
                cachedCloseOpportunities = opportunities;
                lastCloseOpportunitiesUpdate = Date.now();
            }

            // 同时获取未匹配的单腿持仓
            const unmatchedPositions = await getUnmatchedPositions();

            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({
                success: true,
                opportunities,
                unmatchedPositions,  // 未匹配的单腿持仓
                cached: !forceRefresh && cachedCloseOpportunities.length > 0,
                lastUpdate: lastCloseOpportunitiesUpdate,
            }));
        } catch (error: any) {
            console.error('[Dashboard] 获取平仓机会失败:', error);
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/close-positions - 获取可平仓持仓
    if (url === '/api/close-positions' && req.method === 'GET') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        try {
            const positions = await getClosePositions();
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: true, positions }));
        } catch (error: any) {
            console.error('[Dashboard] 获取平仓持仓失败:', error);
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // POST /api/close-refresh - 刷新市场映射缓存
    if (url === '/api/close-refresh' && req.method === 'POST') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        try {
            refreshMarketMatches();
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: true, message: 'Market matches refreshed' }));
        } catch (error: any) {
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // ========================================================================
    // 体育市场 API
    // ========================================================================

    // GET /api/sports - 获取体育市场套利数据
    if (url === '/api/sports' && req.method === 'GET') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (!ENABLE_SPORTS_SERVICE) {
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: true, markets: [], opportunities: [], lastScan: null, disabled: true }));
            return;
        }
        try {
            const sportsService = getSportsService();
            const data = sportsService.getSSEData();
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: true, ...data }));
        } catch (error: any) {
            console.error('[Dashboard] 获取体育市场失败:', error);
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/sports/ws-status - 体育市场 WS 订单簿状态
    if (url === '/api/sports/ws-status' && req.method === 'GET') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        try {
            const wsStats = ENABLE_SPORTS_SERVICE
                ? getSportsService().getWsStats()
                : { connected: false, subscribedTokens: 0, updateCount: 0, lastUpdateTime: 0, updatesPerSecond: 0 };
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: true, ...wsStats }));
        } catch (error: any) {
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // POST /api/sports/scan - 手动触发体育市场扫描
    if (url === '/api/sports/scan' && req.method === 'POST') {
        const corsHeaders = getSecureCorsHeaders(req);
        if (!isAuthorizedRequest(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
            return;
        }
        if (!ENABLE_SPORTS_SERVICE) {
            res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: 'Sports service is disabled' }));
            return;
        }
        try {
            const sportsService = getSportsService();
            const markets = await sportsService.scan();
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: true, count: markets.length }));
        } catch (error: any) {
            console.error('[Dashboard] 体育市场扫描失败:', error);
            res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // ========================================================================
    // 日志查询 API
    // ========================================================================

    const logQueryService = getLogQueryService();

    // GET /api/logs/tasks - 获取任务日志列表
    if (url.startsWith('/api/logs/tasks') && req.method === 'GET' && !url.includes('/timeline') && !url.includes('/orderbook')) {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
        const opportunities: ArbOpportunity[] = [];
            const urlObj = new URL(url, `http://localhost`);
            const limit = parseInt(urlObj.searchParams.get('limit') || '50');
            const offset = parseInt(urlObj.searchParams.get('offset') || '0');
            const status = urlObj.searchParams.get('status') || undefined;
            const type = urlObj.searchParams.get('type') || undefined;

            const result = logQueryService.getTaskList({ limit, offset, status, type });
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: result }));
        } catch (error: any) {
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/logs/tasks/:id/timeline - 获取任务时间线
    const timelineMatch = url.match(/^\/api\/logs\/tasks\/([a-zA-Z0-9_-]+)\/timeline$/);
    if (timelineMatch && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        const taskId = timelineMatch[1];
        try {
        const opportunities: ArbOpportunity[] = [];
            const timeline = logQueryService.getTaskTimeline(taskId);
            if (timeline) {
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({ success: true, data: timeline }));
            } else {
                res.writeHead(404, {
                    'Content-Type': 'application/json',
                    ...corsHeaders,
                });
                res.end(JSON.stringify({ success: false, error: 'Task logs not found' }));
            }
        } catch (error: any) {
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/logs/tasks/:id/orderbook - 获取订单簿快照
    const orderbookMatch = url.match(/^\/api\/logs\/tasks\/([a-zA-Z0-9_-]+)\/orderbook$/);
    if (orderbookMatch && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        const taskId = orderbookMatch[1];
        try {
        const opportunities: ArbOpportunity[] = [];
            const urlObj = new URL(url, `http://localhost`);
            const sequence = urlObj.searchParams.get('sequence');
            const snapshots = logQueryService.getOrderBookSnapshot(
                taskId,
                sequence ? parseInt(sequence) : undefined
            );
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: snapshots }));
        } catch (error: any) {
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/logs/stats - 获取统计数据
    if (url.startsWith('/api/logs/stats') && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
        const opportunities: ArbOpportunity[] = [];
            const urlObj = new URL(url, `http://localhost`);
            const days = parseInt(urlObj.searchParams.get('days') || '7');
            const stats = logQueryService.getStats(days);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: stats }));
        } catch (error: any) {
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/logs/failures - 获取失败任务列表
    if (url.startsWith('/api/logs/failures') && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
        const opportunities: ArbOpportunity[] = [];
            const urlObj = new URL(url, `http://localhost`);
            const days = parseInt(urlObj.searchParams.get('days') || '7');
            const failures = logQueryService.getFailures(days);
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: failures }));
        } catch (error: any) {
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/all-markets/status - 查询 All 市场开关状态
    if (url === '/api/all-markets/status' && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ enabled: allMarketsEnabled }));
        return;
    }

    // POST /api/all-markets/toggle - 切换 All 市场开关
    if (url === '/api/all-markets/toggle' && req.method === 'POST') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;

        allMarketsEnabled = !allMarketsEnabled;
        console.log(`[Config] All 市场已${allMarketsEnabled ? '启用' : '禁用'}`);

        if (allMarketsEnabled) {
            // 启用: 连接主 WS + 订阅 + 触发首次扫描
            if (!polymarketWsClient) {
                await initPolymarketWs();
                if (polymarketWsClient) {
                    getOrderMonitor().setPolyWsClient(polymarketWsClient);
                    taskExecutor.setPolymarketWsClient(polymarketWsClient);
                }
            }
            const unifiedCache = getPredictOrderbookCache();
            if (unifiedCache && marketPairs.length > 0) {
                // 用户 toggle 启用 ALL Markets：先确保 reward 数据就绪，再过滤订阅
                if (getRewardCacheStats().size === 0) {
                    try {
                        await fetchRewardData();
                    } catch (err: any) {
                        console.warn(`[Config] reward 拉取失败: ${err?.message || err}`);
                    }
                }
                const allIds = marketPairs.map(p => p.predictId);
                const marketIds = allIds.filter(id => hasMarketReward(id));
                await unifiedCache.subscribeMarkets(marketIds);
                console.log(`[Config] 已补订阅 ${marketIds.length}/${allIds.length} 个有 PP reward 的主市场`);
            }
            subscribePolymarketTokens();
            // 重置扫描状态，让下个 interval 触发扫描
            scanInProgress = false;
        } else {
            // 禁用: 断开主 WS + 取消订阅 + 清空数据
            if (polymarketWsClient) {
                polymarketWsClient.disconnect();
                polymarketWsClient = null;
                taskExecutor.setPolymarketWsClient(null);
                console.log(`[Config] 已断开 Polymarket 主 WS`);
            }
            const unifiedCache = getPredictOrderbookCache();
            if (unifiedCache && marketPairs.length > 0) {
                const marketIds = marketPairs.map(p => p.predictId);
                await unifiedCache.unsubscribeMarkets(marketIds);
                console.log(`[Config] 已取消订阅 ${marketIds.length} 个 Predict 主市场`);
            }
            // 清空 opportunities 并广播
            dashboardData.opportunities = [];
            markOpportunityDirty();
        }

        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ success: true, enabled: allMarketsEnabled }));
        return;
    }

    // GET /api/account - 获取账户数据
    if (url === '/api/account' && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
            const accountData = await getAccountData();
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: accountData }));
        } catch (error: any) {
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // POST /api/account/refresh - 强制刷新账户数据
    if (url === '/api/account/refresh' && req.method === 'POST') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        try {
            const accountData = await refreshAccountData();
            res.writeHead(200, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: true, data: accountData }));
        } catch (error: any) {
            res.writeHead(500, {
                'Content-Type': 'application/json',
                ...corsHeaders,
            });
            res.end(JSON.stringify({ success: false, error: error.message }));
        }
        return;
    }

    // GET /api/liquidity - 获取流动性扫描数据
    if (url === '/api/liquidity' && req.method === 'GET') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        if (liquidityScanCache) {
            res.end(JSON.stringify({ success: true, data: liquidityScanCache.data, lastScanTime: liquidityScanCache.lastScanTime }));
        } else {
            res.end(JSON.stringify({ success: false, data: null }));
        }
        return;
    }

    // POST /api/liquidity/refresh - 触发流动性扫描
    if (url === '/api/liquidity/refresh' && req.method === 'POST') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        // 异步执行扫描，立即返回
        runLiquidityScan().catch(err => console.warn('[LiquidityScan] 扫描失败:', err?.message || err));
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ success: true, message: 'scan started' }));
        return;
    }

    // POST /api/exposure/dismiss - 前端关闭敞口 banner，静默当前任务相关的前端/TG 告警
    if (url === '/api/exposure/dismiss' && req.method === 'POST') {
        const corsHeaders = requireAuth(req, res);
        if (!corsHeaders) return;
        let taskIds: string[] | undefined;
        try {
            const body = await parseJsonBody<{ taskIds?: string[] }>(req);
            if (Array.isArray(body?.taskIds)) {
                taskIds = body.taskIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
            }
        } catch {
            // 兼容旧客户端空 body：默认静默当前全部敞口任务
        }
        exposureMonitor.dismiss(taskIds);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ success: true, muted: true, taskIds: taskIds || [] }));
        return;
    }

    // ========================================================================
    // 静态文件服务
    // ========================================================================

    let filePath = url === '/' ? '/index.html' : url;
    let fullPath = '';

    // 优先从 front 目录提供文件
    if ((filePath === '/preview' || filePath === '/preview.html') && HAS_FRONT_PREVIEW) {
        fullPath = FRONT_PREVIEW_PATH;
        filePath = '/index.html';
    } else if (filePath === '/index.html' && HAS_FRONT_PREVIEW) {
        fullPath = FRONT_PREVIEW_PATH;
    } else if (filePath.startsWith('/preview/')) {
        // 提供 front/preview/ 目录下的文件
        fullPath = join(FRONT_DIR, filePath);
    } else {
        fullPath = join(PUBLIC_DIR, filePath);
    }

    // 路径安全检查：防止目录穿越
    const resolvedPath = resolve(fullPath);
    const normalizePathForCompare = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const normalizedResolvedPath = normalizePathForCompare(resolvedPath);
    const allowedDirs = [resolve(FRONT_DIR), resolve(PUBLIC_DIR)].map(normalizePathForCompare);
    if (!allowedDirs.some((dir) => normalizedResolvedPath === dir || normalizedResolvedPath.startsWith(dir + sep))) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, 'utf-8');
        res.writeHead(200, {
            'Content-Type': getMimeType(filePath),
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
        res.end(content);
    } else {
        res.writeHead(404, {
            'Content-Type': 'text/plain',
            'Access-Control-Allow-Origin': '*'
        });
        res.end('Not Found');
    }
}

// ============================================================================
// 获取 Predict 订单簿
// ============================================================================

interface OrderBookLevel {
    price: number;
    size: number;
}

let predictErrorLogged = false;
let rateLimitBackoff = 0; // Rate limit 退避时间

async function fetchPredictOrderbook(
    marketId: number,
    options: { useOrderbookKeys?: boolean; apiKey?: string } = {}
): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null> {
    // 如果在退避期，跳过请求
    if (rateLimitBackoff > Date.now()) {
        return null;
    }

    try {
        const opportunities: ArbOpportunity[] = [];
        // 优先使用传入的 apiKey，否则根据 useOrderbookKeys 选择
        const { useOrderbookKeys = true, apiKey: explicitKey } = options;
        const apiKey = explicitKey || (useOrderbookKeys ? orderbookApiKeys.getNextKey() : scanApiKeys.getNextKey());
        recordApiKeyUsage(apiKey);

        // 添加超时保护
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}/orderbook`, {
            headers: { 'x-api-key': apiKey },
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            // Rate limit 特殊处理
            if (res.status === 429) {
                rateLimitBackoff = Date.now() + 10000; // 退避 10 秒
                if (!predictErrorLogged) {
                    console.warn(`[Predict API] Rate limit, 退避 10 秒...`);
                    predictErrorLogged = true;
                }
                return null;
            }

            if (!predictErrorLogged) {
                const errorText = await res.text();
                console.error(`[Predict API] 订单簿获取失败: HTTP ${res.status} - ${errorText.substring(0, 200)}`);
                predictErrorLogged = true;
            }
            return null;
        }

        // 重置错误标志和退避
        predictErrorLogged = false;
        rateLimitBackoff = 0;

        const data = await res.json() as { data: { bids: [number, number][]; asks: [number, number][] } };
        const orderbook = data.data;

        if (!orderbook) return null;

        // 转换格式: [[price, size], ...] -> [{ price, size }, ...]
        const bids = (orderbook.bids || []).map(([price, size]: [number, number]) => ({ price, size }));
        const asks = (orderbook.asks || []).map(([price, size]: [number, number]) => ({ price, size }));

        return { bids, asks };
    } catch (error) {
        if (!predictErrorLogged) {
            console.error(`[Predict API] 订单簿获取异常:`, error);
            predictErrorLogged = true;
        }
        return null;
    }
}

// ============================================================================
// 获取 Polymarket 订单簿
// ============================================================================

function getPolymarketOrderbookFromWs(tokenId: string): { bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null {
    // WS-only 模式：不检查连接状态，只检查缓存是否存在
    // 连接状态由 isWsConnectionHealthy() 统一判定

    // 1. 主 WS 查询
    const cached = polymarketWsClient?.getOrderBook(tokenId);

    // 2. 主 WS 没命中 → 回退到体育独立 WS
    const book = cached ?? getSportsService()?.getWsClient()?.getOrderBook(tokenId) ?? null;
    if (!book) return null;

    // WS-only 激进模式：移除 POLY_WS_STALE_MS 过滤
    // 只要 WS 连接在线，缓存数据就是有效的（WS 会实时推送更新）
    // 新鲜度过滤改为仅用于监控/日志，不参与计算决策

    const bids = book.bids.map(([price, size]: [number, number]) => ({ price, size }));
    const asks = book.asks.map(([price, size]: [number, number]) => ({ price, size }));

    bids.sort((a: OrderBookLevel, b: OrderBookLevel) => b.price - a.price);
    asks.sort((a: OrderBookLevel, b: OrderBookLevel) => a.price - b.price);

    return { bids, asks };
}

async function fetchPolymarketOrderbookRest(tokenId: string): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null> {
    try {
        const opportunities: ArbOpportunity[] = [];
        // 添加超时保护
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!res.ok) return null;

        const book = await res.json() as { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] };

        // 转换为数值格式
        const bids = (book.bids || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));
        const asks = (book.asks || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));

        // 排序: bids 降序, asks 升序
        bids.sort((a, b) => b.price - a.price);
        asks.sort((a, b) => a.price - b.price);

        return { bids, asks };
    } catch {
        return null;
    }
}

async function fetchPolymarketOrderbook(tokenId: string): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null> {
    const wsBook = getPolymarketOrderbookFromWs(tokenId);
    if (wsBook) return wsBook;

    // WS-only 激进模式：非首轮不回退到 REST
    // 首轮扫描或定时强制重扫允许 REST 作为种子数据
    if (!isFirstScan && !forceFullScan && usePredictWsMode) {
        return null;  // WS miss 直接返回 null，不调用 REST
    }

    return fetchPolymarketOrderbookRest(tokenId);
}

// ============================================================================
// Polymarket 市场信息
// ============================================================================

interface PolymarketMarketInfo {
    tokenId: string | null;        // Legacy: 第一个 token (NO)
    yesTokenId: string | null;     // YES token ID
    noTokenId: string | null;      // NO token ID
    tickSize: number;               // 动态 tick size
    negRisk: boolean;
    slug: string | null;           // Market slug (用于 URL 导航)
}

const polymarketMarketInfoCache = new Map<string, { info: PolymarketMarketInfo; timestamp: number }>();

async function getPolymarketMarketInfo(conditionId: string): Promise<PolymarketMarketInfo | null> {
    // 检查缓存
    const cached = polymarketMarketInfoCache.get(conditionId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        // 调试日志：缓存命中
        console.log(`[negRisk] Cache hit: ${conditionId.slice(0, 20)}... negRisk=${cached.info.negRisk}`);
        return cached.info;
    }

    try {
        const opportunities: ArbOpportunity[] = [];
        const res = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
        if (!res.ok) return null;

        const data = await res.json() as {
            tokens?: { token_id: string; outcome: string }[];
            closed?: boolean;
            accepting_orders?: boolean;
            minimum_tick_size?: string;
            neg_risk?: boolean;
            market_slug?: string;
        };

        // 跳过已关闭的市场
        if (data.closed || data.accepting_orders === false) {
            return null;
        }

        // 解析 tokens - 根据 outcome 区分 YES/NO
        let yesTokenId: string | null = null;
        let noTokenId: string | null = null;

        if (data.tokens && data.tokens.length > 0) {
            for (const token of data.tokens) {
                if (token.outcome.toLowerCase() === 'yes') {
                    yesTokenId = token.token_id;
                } else if (token.outcome.toLowerCase() === 'no') {
                    noTokenId = token.token_id;
                }
            }
            // 如果没有明确标记，使用位置：第一个是 YES，第二个是 NO
            if (!yesTokenId && data.tokens.length > 0) {
                yesTokenId = data.tokens[0].token_id;
            }
            if (!noTokenId && data.tokens.length > 1) {
                noTokenId = data.tokens[1].token_id;
            }
        }

        const info: PolymarketMarketInfo = {
            tokenId: noTokenId || yesTokenId,  // Legacy: 用于订单簿查询
            yesTokenId,
            noTokenId,
            tickSize: parseFloat(data.minimum_tick_size || '0.01'),
            negRisk: data.neg_risk === true,
            slug: data.market_slug || null,
        };

        // 调试日志：追踪 negRisk 值
        if (data.neg_risk !== undefined) {
            console.log(`[negRisk] Market ${conditionId.slice(0, 20)}... neg_risk=${data.neg_risk} → negRisk=${info.negRisk}`);
        }

        polymarketMarketInfoCache.set(conditionId, { info, timestamp: Date.now() });

        return info;
    } catch {
        return null;
    }
}

// Legacy wrapper
async function getPolymarketTokenId(conditionId: string): Promise<string | null> {
    const info = await getPolymarketMarketInfo(conditionId);
    return info?.tokenId || null;
}

// ============================================================================
// 获取 Polymarket 市场结算时间 (使用事件级别的 endDate)
// ============================================================================

// conditionId → 事件 endDate 映射缓存 (Polymarket Gamma API)
const conditionIdToEventEndDate = new Map<string, string>();

// categorySlug → endsAt 映射缓存 (Predict Categories API)
const categorySlugToEndsAt = new Map<string, string>();

// 检查 endDate 是否有效（未过期，给 1 天缓冲避免时区问题）
function isEndDateValid(endDateStr: string | null | undefined): boolean {
    if (!endDateStr) return false;
    try {
        const endDate = new Date(endDateStr);
        if (isNaN(endDate.getTime())) return false;
        const now = new Date();
        // 给 1 天缓冲，避免时区问题
        const bufferMs = 24 * 60 * 60 * 1000;
        return endDate.getTime() + bufferMs >= now.getTime();
    } catch {
        return false;
    }
}

// 构建 conditionId → 事件 endDate 映射（缓存所有，包括过期的，在使用时判断有效性）
async function buildEventEndDateMapping(): Promise<void> {
    try {
        console.log('[endDate] 正在从 Gamma API 获取事件级别的结算时间...');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);  // 10秒超时

        const res = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&limit=500', {
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!res.ok) {
            console.log('[endDate] Gamma API 请求失败:', res.status);
            return;
        }
        const events = await res.json() as Array<{
            endDate?: string;
            markets?: Array<{ conditionId?: string }>;
        }>;

        let count = 0;
        let expiredCount = 0;
        for (const event of events) {
            if (event.endDate && event.markets) {
                const isExpired = !isEndDateValid(event.endDate);
                if (isExpired) expiredCount += event.markets.length;
                for (const market of event.markets) {
                    if (market.conditionId) {
                        conditionIdToEventEndDate.set(market.conditionId, event.endDate);
                        count++;
                    }
                }
            }
        }
        console.log(`[endDate] Polymarket: ${count} 个 conditionId → endDate 映射 (${expiredCount} 个已过期)`);
    } catch (e: any) {
        if (e.name === 'AbortError') {
            console.log('[endDate] Gamma API 请求超时，跳过');
        } else {
            console.log('[endDate] 构建映射失败:', e.message);
        }
    }
}

function getPolymarketEndDate(conditionId: string): string | null {
    // 直接从缓存获取事件级别的 endDate（启动时已批量加载）
    // 有效性判断在使用时进行（见 marketPairs 构建逻辑）
    return conditionIdToEventEndDate.get(conditionId) || null;
}

// 从 Predict Categories API 批量获取 endsAt
async function buildPredictEndsAtMapping(categorySlugs: string[]): Promise<void> {
    if (categorySlugs.length === 0) return;

    // 去重
    const uniqueSlugs = [...new Set(categorySlugs)];
    console.log(`[endDate] 正在从 Predict API 获取 ${uniqueSlugs.length} 个 category 的 endsAt...`);

    const apiKey = process.env.PREDICT_API_KEY || scanApiKeys.getNextKey();
    let successCount = 0;
    let failCount = 0;

    // 批量并发获取，每批 30 个
    const BATCH_SIZE = 30;
    for (let i = 0; i < uniqueSlugs.length; i += BATCH_SIZE) {
        const batch = uniqueSlugs.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (slug) => {
            try {
                const res = await fetch(`https://api.predict.fun/v1/categories/${slug}`, {
                    headers: { 'x-api-key': apiKey }
                });

                if (res.ok) {
                    const data = await res.json() as { data?: { endsAt?: string } };
                    if (data.data?.endsAt) {
                        categorySlugToEndsAt.set(slug, data.data.endsAt);
                        successCount++;
                    }
                } else {
                    failCount++;
                }
            } catch {
                failCount++;
            }
        }));

        // 避免 rate limit
        if (i + BATCH_SIZE < uniqueSlugs.length) {
            await new Promise(r => setTimeout(r, 100));
        }
    }

    console.log(`[endDate] 已建立 ${successCount} 个 categorySlug → endsAt 映射 (${failCount} 个失败)`);
}

function getPredictEndsAt(categorySlug: string | undefined): string | null {
    if (!categorySlug) return null;
    return categorySlugToEndsAt.get(categorySlug) || null;
}

// ============================================================================
// 套利检测 (使用 depth-calculator)
// ============================================================================

let updateCount = 0;
let scanInProgress = false;
let lastScanInProgressLogTime = 0;

async function detectArbitrageOpportunities(): Promise<void> {
    if (scanInProgress) {
        const now = Date.now();
        if (now - lastScanInProgressLogTime > 15000) {
            console.log('[智能轮询] 上一轮扫描未结束，跳过本轮');
            lastScanInProgressLogTime = now;
        }
        return;
    }

    scanInProgress = true;
    try {
        const opportunities: ArbOpportunity[] = [];
        let predictLatencySum = 0;
        let predictCount = 0;
        let polyLatencySum = 0;
        let polyCount = 0;
        let predictSuccess = 0;
        let polymarketSuccess = 0;
        let totalDepth = 0;

    // ========== 双轨扫描：活跃市场 + 非活跃市场并行 ==========
    // - 活跃市场：使用 ORDERBOOK keys（高优先级，有套利机会的市场）
    // - 非活跃市场：使用 SCAN key（发现新机会）
    const now = Date.now();

    // 保存扫描前的活跃市场快照（用于检测新激活的市场）
    const previousActiveMarketIds = new Set(activeMarketIds);

    // 统一扫描：所有市场使用 SCAN_1, SCAN_2, SCAN_3 并发
    // 过滤：endDate 未过期 + 有 PP reward (与 WS 订阅范围对齐，避免显示无 PP 的长尾市场)
    const allMarkets = marketPairs.filter(p =>
        p.polymarketTokenId
        && (!p.endDate || isEndDateValid(p.endDate))
        && hasMarketReward(p.predictId)
    );
    const activeCount = allMarkets.filter(p => activeMarketIds.has(p.predictId)).length;
    const inactiveCount = allMarkets.length - activeCount;

    scanRoundCount++;
    if (isFirstScan) {
        console.log(`[扫描] 首次全量扫描: ${allMarkets.length} 个市场 (活跃: ${activeCount}, 非活跃: ${inactiveCount})`);
    } else if (scanRoundCount % 30 === 0) {
        console.log(`[扫描] #${scanRoundCount} 全量扫描: ${allMarkets.length} 个市场 (活跃: ${activeCount}, 非活跃: ${inactiveCount})`);
    }

    // 本轮扫描中成功和失败的市场 ID
    const thisRoundSucceeded = new Set<number>();
    const thisRoundFailed = new Set<number>();

    // 存储订单簿结果
    const predictBooks = new Map<number, { bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null>();
    const polyBooks = new Map<string, { bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null>();

    let allScanKeys = scanApiKeys.getAllKeys();

    // 保护：如果没有 SCAN keys，回退到主 API key
    if (allScanKeys.length === 0) {
        const fallbackKey = process.env['PREDICT_API_KEY'];
        if (fallbackKey) {
            console.warn('[扫描] 警告: 没有 SCAN keys，使用主 API key');
            allScanKeys = [fallbackKey];
        } else {
            console.error('[扫描] 错误: 没有可用的 API key');
            return;
        }
    }

    // ========== WS-only 激进模式：非首轮跳过订单簿拉取 ==========
    // 首轮扫描：使用 REST/WS 获取种子数据并计算机会
    // 后续扫描：完全跳过订单簿拉取，机会由 WS 更新驱动维护
    const wsSkipOrderbookFetch = WS_DRIVEN_CALCULATION && usePredictWsMode && !isFirstScan && !forceFullScan;

    if (wsSkipOrderbookFetch) {
        // WS-only 模式非首轮：跳过订单簿拉取
        // 只维护市场列表，机会由 WS 回调维护
        // WS-only 模式日志已在全量扫描中包含，不再单独输出
        dashboardData.stats.lastFullUpdate = new Date().toISOString();
        dashboardData.stats.connectionStatus.polymarketWs = getPolymarketWsStatus();
        dashboardData.stats.connectionStatus.predictWs = getPredictOrderbookCache()?.isWsConnected() ? 'connected' : 'disconnected';
        dashboardData.stats.connectionStatus.bscWss = (() => { try { return getBscOrderWatcher().isConnected() ? 'connected' : 'disconnected'; } catch { return 'disconnected' as const; } })();

        // 体育市场 WS 订单簿状态
        try {
            (dashboardData.stats as any).sportsWs = getSportsService()?.getWsStats() ?? null;
        } catch { /* SportsService 未初始化 */ }

        // 从实际 REST 请求获取延迟
        const pRestLat = getPredictOrderbookCache()?.getRestLatency();
        const pmRestLat = getPolymarketApiLatency();
        if (pRestLat) dashboardData.stats.latency.predict = pRestLat;
        if (pmRestLat) dashboardData.stats.latency.polymarket = pmRestLat;

        dashboardData.stats.dataVersion++;
        updateCount++;
        await broadcastUpdate();
        return;
    } else {
        // 首轮扫描或 Legacy 模式：执行订单簿拉取

        // 均匀分布扫描：将请求分散到轮询间隔内
        const SCAN_INTERVAL_SECONDS = Math.max(1, Math.floor(POLL_INTERVAL_MS / 1000));
        const marketsPerSecond = Math.ceil(allMarkets.length / SCAN_INTERVAL_SECONDS);

        // 统一并发扫描（分时均匀）
        const scanStart = Date.now();

        for (let sec = 0; sec < SCAN_INTERVAL_SECONDS; sec++) {
            const startIdx = sec * marketsPerSecond;
            const endIdx = Math.min(startIdx + marketsPerSecond, allMarkets.length);
            if (startIdx >= allMarkets.length) break;

            const batch = allMarkets.slice(startIdx, endIdx);

            // 本秒的请求并发发出，按 key 轮换
            await Promise.all(batch.map(async (pair, idx) => {
                const apiKey = allScanKeys[idx % allScanKeys.length];

                // WS 模式: Predict 订单簿从统一缓存读取，只拉取 Polymarket
                // Legacy 模式: 两边都用 REST
                let predictBook: { bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null = null;

                if (usePredictWsMode) {
                    // WS 模式: 从统一缓存读取
                    const unifiedCache = getPredictOrderbookCache();
                    if (unifiedCache) {
                        const cached = unifiedCache.getOrderbookSync(pair.predictId);
                        if (cached) {
                            predictBook = {
                                bids: cached.bids.map(l => ({ price: l.price, size: l.size })),
                                asks: cached.asks.map(l => ({ price: l.price, size: l.size })),
                            };
                        }
                    }
                } else {
                    // Legacy 模式: REST 拉取
                    predictBook = await fetchPredictOrderbook(pair.predictId, { apiKey });
                    // 更新本地缓存
                    if (predictBook) {
                        predictOrderbookCacheLegacy.set(pair.predictId, {
                            bids: predictBook.bids,
                            asks: predictBook.asks,
                            timestamp: Date.now()
                        });
                    }
                }

                // Polymarket 订单簿: WS 缓存优先，REST 兜底（首轮允许 REST）
                let polyBook = getPolymarketOrderbookFromWs(pair.polymarketTokenId!);
                if (!polyBook) {
                    // WS 缓存不可用，fallback to REST（fetchPolymarketOrderbook 内部会检查 isFirstScan）
                    polyBook = await fetchPolymarketOrderbook(pair.polymarketTokenId!);
                }
                predictBooks.set(pair.predictId, predictBook);
                polyBooks.set(pair.polymarketTokenId!, polyBook);
            }));

            // 非最后一秒时等待，确保请求均匀分布
            if (sec < SCAN_INTERVAL_SECONDS - 1 && endIdx < allMarkets.length) {
                const elapsed = Date.now() - scanStart;
                const targetTime = (sec + 1) * 1000;
                const waitTime = Math.max(0, targetTime - elapsed);
                if (waitTime > 0) {
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }
            }
        }

        // 从实际 REST 请求获取延迟
        const pLat = getPredictOrderbookCache()?.getRestLatency();
        const pmLat = getPolymarketApiLatency();
        if (pLat) { predictLatencySum = pLat; predictCount = 1; }
        if (pmLat) { polyLatencySum = pmLat; polyCount = 1; }
    }

    // 所有要处理的市场
    const validPairs = allMarkets;

    // 统计成功/失败
    for (const pair of validPairs) {
        const predictBook = predictBooks.get(pair.predictId);
        const polyBook = polyBooks.get(pair.polymarketTokenId!);

        if (predictBook) {
            predictSuccess++;
            thisRoundSucceeded.add(pair.predictId);
        } else {
            thisRoundFailed.add(pair.predictId);
        }
        if (polyBook) polymarketSuccess++;
    }

    // ========== 套利计算（使用缓存的订单簿） ==========
    // WS 驱动计算模式：
    //   - 首次扫描：计算所有机会（发现新机会）
    //   - 后续扫描：跳过计算，由 WS 更新驱动重算
    //   - WS 断连时：回退到主扫描计算（兜底）
    const wsSkipAllCalculation = WS_DRIVEN_CALCULATION && usePredictWsMode && predictWsConnected && !isFirstScan && !forceFullScan;
    let wsSkippedCount = 0;

    // WS 驱动模式下跳过所有计算，机会由 WS 更新维护
    if (wsSkipAllCalculation) {
        wsSkippedCount = validPairs.length;
    }

    for (const pair of validPairs) {
        // WS 驱动模式：跳过所有计算，机会由 WS 更新维护
        if (wsSkipAllCalculation) {
            continue;
        }

        const predictBook = predictBooks.get(pair.predictId);
        const polyBook = polyBooks.get(pair.polymarketTokenId!);

        // 计算套利深度
        if (predictBook && polyBook) {
            // 调试:检查订单簿是否有数据
            if (predictBook.bids.length === 0 || predictBook.asks.length === 0 || polyBook.bids.length === 0 || polyBook.asks.length === 0) {
                console.log(`[DEBUG] 市场 ${pair.predictId} 订单簿为空: Predict bids=${predictBook.bids.length}, asks=${predictBook.asks.length}, Poly bids=${polyBook.bids.length}, asks=${polyBook.asks.length}`);
                continue;
            }

            // 计算 Polymarket 对冲价格
            // polymarketTokenId 优先使用 NO token，所以 polyBook 是 NO 的订单簿
            let polyHedgeAsks: OrderBookLevel[];

            if (pair.isInverted) {
                // Inverted 市场: Predict YES + Polymarket YES = 对冲
                // 需要从 NO 订单簿转换：YES Ask = 1 - NO Bid
                polyHedgeAsks = polyBook.bids.map(level => ({
                    price: 1 - level.price,
                    size: level.size
                }));
                polyHedgeAsks.sort((a, b) => a.price - b.price);
            } else {
                // 正常市场: Predict YES + Polymarket NO = 对冲
                // polyBook 已经是 NO 的订单簿，直接使用 NO 的 asks
                polyHedgeAsks = polyBook.asks;
            }

            // 使用 depth-calculator 计算
            const depth = calculateDepth(
                predictBook.bids,
                predictBook.asks,
                polyHedgeAsks,
                pair.feeRateBps || 200
            );

            // ================================================================
            // YES 端套利检测 (predict_yes + polymarket_no < 1)
            // ================================================================

            // YES 端 Maker 机会
            if (depth.makerCost < 1 && depth.makerProfit > 0) {
                const profitPercent = depth.makerProfit * 100;
                const riskLevel = profitPercent > 2 ? 'LOW' : profitPercent > 1 ? 'MEDIUM' : 'HIGH';
                opportunities.push({
                    marketId: pair.predictId,
                    title: pair.predictQuestion,
                    strategy: 'PREDICT_MAKER',
                    side: 'YES',
                    profitPercent,
                    maxQuantity: depth.makerMaxQuantity,
                    estimatedProfit: depth.makerProfit * depth.makerMaxQuantity,
                    predictPrice: depth.predictYesBid,
                    predictBid: depth.predictYesBid,
                    predictAsk: depth.predictYesAsk,
                    polymarketPrice: depth.polymarketNoAsk,
                    totalCost: depth.makerCost,
                    // 前端显示用 (美分单位)
                    makerCost: +(depth.makerCost * 100).toFixed(2),
                    takerCost: +(depth.takerCost * 100).toFixed(2),
                    depth: {
                        predict: depth.predictYesBidDepth,
                        polymarket: depth.polymarketNoAskDepth,
                        polymarketNoAskDepth: depth.polymarketNoAskDepth,
                        predictAskDepth: depth.predictYesAskDepth,
                        predictBidDepth: depth.predictYesBidDepth,
                    },
                    lastUpdate: Date.now(),
                    isInverted: pair.isInverted,

                    // 执行必需字段
                    polymarketConditionId: pair.polymarketConditionId,
                    polymarketSlug: getPolymarketSlug(pair.polymarketConditionId) || pair.polymarketSlug,
                    predictSlug: pair.categorySlug || getPredictSlug(pair.predictId) || generatePredictSlug(pair.predictQuestion),
                    polymarketNoTokenId: pair.polymarketNoTokenId || '',
                    polymarketYesTokenId: pair.polymarketYesTokenId || '',
                    tickSize: pair.tickSize,
                    feeRateBps: pair.feeRateBps,
                    negRisk: pair.negRisk,
                    outcome: pair.predictTitle !== pair.predictQuestion ? pair.predictTitle : undefined,

                    // 风险和费用
                    risk: {
                        level: riskLevel as 'LOW' | 'MEDIUM' | 'HIGH',
                        slippage: 0.5,
                    },
                    fees: {
                        predict: depth.predictFee,
                        gas: 0.01,
                    },
                    costs: {
                        total: depth.makerCost,
                    },
                    endDate: pair.endDate,
                    predictVolume: pair.predictVolume,
                    polyVolume: pair.polyVolume,
                });
                totalDepth += depth.makerMaxQuantity;
            }

            // YES 端 Taker 机会
            if (depth.takerCost < 1 && depth.takerProfit > 0) {
                const profitPercent = depth.takerProfit * 100;
                const riskLevel = profitPercent > 2 ? 'LOW' : profitPercent > 1 ? 'MEDIUM' : 'HIGH';
                opportunities.push({
                    marketId: pair.predictId,
                    title: pair.predictQuestion,
                    strategy: 'TAKER',
                    side: 'YES',
                    profitPercent,
                    maxQuantity: depth.takerMaxQuantity,
                    estimatedProfit: depth.takerProfit * depth.takerMaxQuantity,
                    predictPrice: depth.predictYesAsk,
                    predictBid: depth.predictYesBid,
                    predictAsk: depth.predictYesAsk,
                    polymarketPrice: depth.polymarketNoAsk,
                    totalCost: depth.takerCost,
                    // 前端显示用 (美分单位)
                    makerCost: +(depth.makerCost * 100).toFixed(2),
                    takerCost: +(depth.takerCost * 100).toFixed(2),
                    depth: {
                        predict: depth.predictYesAskDepth,
                        polymarket: depth.polymarketNoAskDepth,
                        polymarketNoAskDepth: depth.polymarketNoAskDepth,
                        predictAskDepth: depth.predictYesAskDepth,
                        predictBidDepth: depth.predictYesBidDepth,
                    },
                    lastUpdate: Date.now(),
                    isInverted: pair.isInverted,

                    // 执行必需字段
                    polymarketConditionId: pair.polymarketConditionId,
                    polymarketSlug: getPolymarketSlug(pair.polymarketConditionId) || pair.polymarketSlug,
                    predictSlug: pair.categorySlug || getPredictSlug(pair.predictId) || generatePredictSlug(pair.predictQuestion),
                    polymarketNoTokenId: pair.polymarketNoTokenId || '',
                    polymarketYesTokenId: pair.polymarketYesTokenId || '',
                    tickSize: pair.tickSize,
                    feeRateBps: pair.feeRateBps,
                    negRisk: pair.negRisk,
                    outcome: pair.predictTitle !== pair.predictQuestion ? pair.predictTitle : undefined,

                    // 风险和费用
                    risk: {
                        level: riskLevel as 'LOW' | 'MEDIUM' | 'HIGH',
                        slippage: 0.5,
                    },
                    fees: {
                        predict: depth.predictFee,
                        gas: 0.01,
                    },
                    costs: {
                        total: depth.takerCost,
                    },
                    endDate: pair.endDate,
                    predictVolume: pair.predictVolume,
                    polyVolume: pair.polyVolume,
                });
                totalDepth += depth.takerMaxQuantity;
            }

            // ================================================================
            // NO 端套利检测 (predict_no + polymarket_yes < 1)
            // 使用 polyBook.bids 反演 polymarket_yes_ask = 1 - polymarket_no_bid
            // ================================================================

            // 只对非 inverted 市场检测 NO 端（inverted 市场的逻辑更复杂）
            if (!pair.isInverted && polyBook.bids.length > 0) {
                const noDepth = calculateNoSideDepth(
                    predictBook.bids,
                    predictBook.asks,
                    polyBook.bids,  // NO 的 bids，用于反演 YES ask
                    pair.feeRateBps || 200
                );

                // NO 端 Maker 机会
                if (noDepth.makerCost < 1 && noDepth.makerProfit > 0) {
                    const profitPercent = noDepth.makerProfit * 100;
                    const riskLevel = profitPercent > 2 ? 'LOW' : profitPercent > 1 ? 'MEDIUM' : 'HIGH';
                    opportunities.push({
                        marketId: pair.predictId,
                        title: pair.predictQuestion,
                        strategy: 'PREDICT_MAKER',
                        side: 'NO',
                        profitPercent,
                        maxQuantity: noDepth.makerMaxQuantity,
                        estimatedProfit: noDepth.makerProfit * noDepth.makerMaxQuantity,
                        predictPrice: noDepth.predictNoBid,
                        predictBid: noDepth.predictNoBid,
                        predictAsk: noDepth.predictNoAsk,
                        polymarketPrice: noDepth.polymarketYesAsk,
                        totalCost: noDepth.makerCost,
                        // 前端显示用 (美分单位)
                        makerCost: +(noDepth.makerCost * 100).toFixed(2),
                        takerCost: +(noDepth.takerCost * 100).toFixed(2),
                        depth: {
                            predict: noDepth.predictYesAskDepth,
                            polymarket: noDepth.polymarketNoBidDepth,
                            polymarketNoAskDepth: noDepth.polymarketNoBidDepth,
                            predictAskDepth: noDepth.predictYesBidDepth,
                            predictBidDepth: noDepth.predictYesAskDepth,
                        },
                        lastUpdate: Date.now(),
                        isInverted: pair.isInverted,

                        // 执行必需字段
                        polymarketConditionId: pair.polymarketConditionId,
                        polymarketSlug: getPolymarketSlug(pair.polymarketConditionId) || pair.polymarketSlug,
                        predictSlug: pair.categorySlug || getPredictSlug(pair.predictId) || generatePredictSlug(pair.predictQuestion),
                        polymarketNoTokenId: pair.polymarketNoTokenId || '',
                        polymarketYesTokenId: pair.polymarketYesTokenId || '',
                        tickSize: pair.tickSize,
                        feeRateBps: pair.feeRateBps,
                        negRisk: pair.negRisk,
                    outcome: pair.predictTitle !== pair.predictQuestion ? pair.predictTitle : undefined,

                        // 风险和费用
                        risk: {
                            level: riskLevel as 'LOW' | 'MEDIUM' | 'HIGH',
                            slippage: 0.5,
                        },
                        fees: {
                            predict: noDepth.predictFee,
                            gas: 0.01,
                        },
                        costs: {
                            total: noDepth.makerCost,
                        },
                        endDate: pair.endDate,
                        predictVolume: pair.predictVolume,
                        polyVolume: pair.polyVolume,
                    });
                    totalDepth += noDepth.makerMaxQuantity;
                }

                // NO 端 Taker 机会
                if (noDepth.takerCost < 1 && noDepth.takerProfit > 0) {
                    const profitPercent = noDepth.takerProfit * 100;
                    const riskLevel = profitPercent > 2 ? 'LOW' : profitPercent > 1 ? 'MEDIUM' : 'HIGH';
                    opportunities.push({
                        marketId: pair.predictId,
                        title: pair.predictQuestion,
                        strategy: 'TAKER',
                        side: 'NO',
                        profitPercent,
                        maxQuantity: noDepth.takerMaxQuantity,
                        estimatedProfit: noDepth.takerProfit * noDepth.takerMaxQuantity,
                        predictPrice: noDepth.predictNoAsk,
                        predictBid: noDepth.predictNoBid,
                        predictAsk: noDepth.predictNoAsk,
                        polymarketPrice: noDepth.polymarketYesAsk,
                        totalCost: noDepth.takerCost,
                        // 前端显示用 (美分单位)
                        makerCost: +(noDepth.makerCost * 100).toFixed(2),
                        takerCost: +(noDepth.takerCost * 100).toFixed(2),
                        depth: {
                            predict: noDepth.predictYesBidDepth,
                            polymarket: noDepth.polymarketNoBidDepth,
                            polymarketNoAskDepth: noDepth.polymarketNoBidDepth,
                            predictAskDepth: noDepth.predictYesBidDepth,
                            predictBidDepth: noDepth.predictYesAskDepth,
                        },
                        lastUpdate: Date.now(),
                        isInverted: pair.isInverted,

                        // 执行必需字段
                        polymarketConditionId: pair.polymarketConditionId,
                        polymarketSlug: getPolymarketSlug(pair.polymarketConditionId) || pair.polymarketSlug,
                        predictSlug: pair.categorySlug || getPredictSlug(pair.predictId) || generatePredictSlug(pair.predictQuestion),
                        polymarketNoTokenId: pair.polymarketNoTokenId || '',
                        polymarketYesTokenId: pair.polymarketYesTokenId || '',
                        tickSize: pair.tickSize,
                        feeRateBps: pair.feeRateBps,
                        negRisk: pair.negRisk,
                    outcome: pair.predictTitle !== pair.predictQuestion ? pair.predictTitle : undefined,

                        // 风险和费用
                        risk: {
                            level: riskLevel as 'LOW' | 'MEDIUM' | 'HIGH',
                            slippage: 0.5,
                        },
                        fees: {
                            predict: noDepth.predictFee,
                            gas: 0.01,
                        },
                        costs: {
                            total: noDepth.takerCost,
                        },
                        endDate: pair.endDate,
                        predictVolume: pair.predictVolume,
                        polyVolume: pair.polyVolume,
                    });
                    totalDepth += noDepth.takerMaxQuantity;
                }
            }
        }
    }

    // 更新缓存和标记新机会
    const cacheNow = Date.now();
    const fetchedIds = new Set<string>();
    const newActiveMarkets = new Set<number>();

    // Inject boost flags + PP rewards
    for (const opp of opportunities) {
        applyBoostToOpportunity(opp);
        applyPointsToOpportunity(opp);
    }

    for (const opp of opportunities) {
        const key = makeOpportunityKey(opp.marketId, opp.side, opp.strategy);
        fetchedIds.add(key);

        // 标记是否是新发现的机会
        const isNewOpportunity = !knownOpportunityIds.has(key);
        opp.isNew = isNewOpportunity;

        if (isNewOpportunity) {
            knownOpportunityIds.add(key);
            console.log(`[新机会] ${opp.title} | ${opp.side} ${opp.strategy} | ${opp.profitPercent.toFixed(2)}%`);
        }

        // 记录有套利机会的市场 ID
        newActiveMarkets.add(opp.marketId);
        opportunityCache.set(key, opp);
    }

    // TG 通知：当非活跃市场变成活跃市场时发送通知
    // 首次扫描时不发送通知，只填充缓存（避免启动时发送大量历史机会通知）
    // 可通过 ENABLE_ARB_TG_NOTIFICATION 开关控制
    const tg = getTelegramNotifier();
    if (tg && !isFirstScan && !forceFullScan && ENABLE_ARB_TG_NOTIFICATION) {
        // 找出新激活的市场（之前没有机会，现在有了）
        const newlyActivatedMarketIds = new Set<number>();
        for (const marketId of newActiveMarkets) {
            if (!previousActiveMarketIds.has(marketId)) {
                newlyActivatedMarketIds.add(marketId);
            }
        }

        if (newlyActivatedMarketIds.size > 0) {
            console.log(`[TG] 发现 ${newlyActivatedMarketIds.size} 个新激活的市场: ${[...newlyActivatedMarketIds].join(', ')}`);

            // 为每个新激活的市场发送通知（选择该市场最好的机会）
            // 使用 fire-and-forget 模式，不阻塞扫描循环
            for (const marketId of newlyActivatedMarketIds) {
                // 找到该市场的所有机会，选择利润率最高的
                const marketOpps = opportunities.filter(o => o.marketId === marketId);
                if (marketOpps.length === 0) continue;

                const bestOpp = marketOpps.reduce((best, curr) =>
                    curr.profitPercent > best.profitPercent ? curr : best
                );

                // 异步发送，不等待完成
                tg.alertArbitrage({
                    marketName: bestOpp.title,
                    predictMarketId: bestOpp.marketId,
                    mode: bestOpp.strategy,
                    side: bestOpp.side,
                    predictYesPrice: bestOpp.predictPrice,
                    polymarketNoPrice: bestOpp.polymarketPrice,
                    totalCost: bestOpp.totalCost,
                    profitPercent: bestOpp.profitPercent,
                    maxQuantity: bestOpp.maxQuantity,
                    endDate: bestOpp.endDate,
                }).catch(err => console.warn(`[TG] 发送失败: ${err.message}`));
            }
        }
    }

    // 首次扫描完成后清除标志
    if (isFirstScan) {
        console.log(`📢 首次扫描完成，已静默加载 ${opportunities.length} 个机会到缓存，后续新机会将发送 TG 通知`);
        isFirstScan = false;
    }
    if (forceFullScan) {
        console.log(`[扫描] 定时全量重扫完成，opportunity 缓存已刷新（${opportunities.length} 个机会）`);
        forceFullScan = false;
    }

    // 更新活跃市场列表
    activeMarketIds.clear();
    for (const id of newActiveMarkets) {
        activeMarketIds.add(id);
    }

    // 更新失败市场列表：移除成功的，添加新失败的（非活跃市场）
    for (const id of thisRoundSucceeded) {
        failedMarketIds.delete(id);
    }
    for (const id of thisRoundFailed) {
        // 只添加非活跃市场到失败列表（活跃市场会在下次增量扫描中重试）
        if (!activeMarketIds.has(id)) {
            failedMarketIds.add(id);
        }
    }

    // 合并缓存：对于本次未获取到的市场，使用缓存数据（如果未过期 + 仍有 PP reward）
    for (const [key, cachedOpp] of opportunityCache) {
        if (!fetchedIds.has(key)) {
            // 检查是否过期；同时要求仍有 PP reward（对齐扫描范围）
            if (cacheNow - cachedOpp.lastUpdate < CACHE_EXPIRY_MS && hasMarketReward(cachedOpp.marketId)) {
                // 缓存补齐/清理 boost 字段（防止显示过期状态）
                applyBoostToOpportunity(cachedOpp);
                applyPointsToOpportunity(cachedOpp);
                // 缓存的机会不是新的
                cachedOpp.isNew = false;
                opportunities.push(cachedOpp);
                // 保留缓存市场在活跃列表中
                activeMarketIds.add(cachedOpp.marketId);
            } else {
                // 过期则从缓存和已知集合中移除
                opportunityCache.delete(key);
                knownOpportunityIds.delete(key);
            }
        }
    }

    // 按 marketId 稳定排序（避免卡片跳动）
    opportunities.sort((a, b) => a.marketId - b.marketId);

    // 更新统计
    const makerOpps = opportunities.filter(o => o.strategy === 'PREDICT_MAKER');
    const takerOpps = opportunities.filter(o => o.strategy === 'TAKER');
    const avgProfit = opportunities.length > 0
        ? opportunities.reduce((sum, o) => sum + o.profitPercent, 0) / opportunities.length
        : 0;
    const maxProfit = opportunities.length > 0
        ? Math.max(...opportunities.map(o => o.profitPercent))
        : 0;

    dashboardData.opportunities = opportunities;
    dashboardData.stats.latency.predict = predictCount > 0 ? Math.round(predictLatencySum / predictCount) : 0;
    dashboardData.stats.latency.polymarket = polyCount > 0 ? Math.round(polyLatencySum / polyCount) : 0;
    dashboardData.stats.connectionStatus.predictApi = predictSuccess > 0 ? 'ok' : 'error';
    dashboardData.stats.connectionStatus.polymarketWs = getPolymarketWsStatus();
    dashboardData.stats.connectionStatus.predictWs = getPredictOrderbookCache()?.isWsConnected() ? 'connected' : 'disconnected';
    dashboardData.stats.connectionStatus.bscWss = (() => { try { return getBscOrderWatcher().isConnected() ? 'connected' : 'disconnected'; } catch { return 'disconnected' as const; } })();
    dashboardData.stats.arbStats.makerCount = makerOpps.length;
    dashboardData.stats.arbStats.takerCount = takerOpps.length;
    dashboardData.stats.arbStats.avgProfit = avgProfit;
    dashboardData.stats.arbStats.maxProfit = maxProfit;
    dashboardData.stats.arbStats.totalDepth = totalDepth;
    dashboardData.stats.dataVersion++;  // 原子递增，与 opportunities 同一 tick 更新

    updateCount++;

    // 广播更新
    await broadcastUpdate();

    const time = new Date().toLocaleTimeString();
    const scannedCount = predictCount;
    // WS 驱动模式显示跳过计数
    const wsSkipInfo = wsSkippedCount > 0 ? ` | WS跳过: ${wsSkippedCount}` : '';
        console.log(`[${time}] #${updateCount} | 扫描: ${scannedCount}/${marketPairs.length} | 成功: P${predictSuccess}/M${polymarketSuccess} | Maker: ${makerOpps.length} | Taker: ${takerOpps.length} | 活跃: ${activeMarketIds.size}${wsSkipInfo}`);
    } finally {
        scanInProgress = false;
    }
}

// ============================================================================
// WS 模式运行时状态
// ============================================================================

// --- WS 健康状态 ---
let predictWsConnected = true;     // Predict WS 物理连接状态
let predictWsLastUpdate = 0;       // 最后一次 WS 更新时间
let predictWsDisconnectedAt = 0;   // WS 断连时间点
let tasksPausedDueToWs = false;    // 任务是否因 WS 断连而暂停
let hybridFallbackActive = false;  // Hybrid 兜底是否激活

// --- WS 驱动计算跟踪 ---
// 记录每个市场最后一次被 WS 更新的时间戳
// 用于机会管理和新鲜度检查
const lastWsUpdateByMarket = new Map<number, number>();
const lastPolyWsUpdateByToken = new Map<string, number>();

// ============================================================================
// 获取 Predict 市场详情 (包含 feeRateBps)
// ============================================================================

async function fetchPredictMarketDetail(marketId: number, apiKey?: string): Promise<{ feeRateBps: number; endDate?: string } | null> {
    try {
        const key = apiKey || scanApiKeys.getNextKey();
        recordApiKeyUsage(key);
        const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}`, {
            headers: { 'x-api-key': key }
        });

        if (!res.ok) return null;

        const data = await res.json() as { data?: { feeRateBps?: number; endDate?: string } };
        return {
            feeRateBps: data.data?.feeRateBps ?? 200,
            endDate: data.data?.endDate
        };
    } catch {
        return null;
    }
}

// ============================================================================
// 主入口
// ============================================================================

const polymarketEventMarketsCache = new Map<string, Array<{ conditionId: string; question?: string; slug?: string }>>();

function normalizeQuestionForMatch(text: string): string {
    return String(text || '')
        .toLowerCase()
        .replace(/[’']/g, "'")
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\bany other\b/g, 'another');
}

async function tryFixPolymarketConditionIdForAnyOther(
    predictQuestion: string,
    currentPolymarketQuestion: string,
    currentMarketSlug: string | null
): Promise<{ conditionId: string; question?: string; slug?: string } | null> {
    if (!/\bany other\b/i.test(predictQuestion)) return null;
    if (/\b(any other|another)\b/i.test(currentPolymarketQuestion)) return null;
    if (!currentMarketSlug) return null;

    // 通过 /market/{slug} 的 307 Location 解析 event slug
    let eventSlug: string | null = null;
    try {
        const res = await fetch(`https://polymarket.com/market/${currentMarketSlug}`, {
            method: 'HEAD',
            redirect: 'manual',
        });
        const location = res.headers.get('location') || '';
        const m = location.match(/^\/event\/([^/]+)\/[^/]+/);
        if (m?.[1]) eventSlug = m[1];
    } catch {
        return null;
    }
    if (!eventSlug) return null;

    let markets = polymarketEventMarketsCache.get(eventSlug);
    if (!markets) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(eventSlug)}`, {
                signal: controller.signal,
            }).finally(() => clearTimeout(timeoutId));
            if (!res.ok) return null;
            const events = await res.json() as Array<{ markets?: Array<{ conditionId: string; question?: string; slug?: string }> }>;
            markets = events[0]?.markets || [];
            polymarketEventMarketsCache.set(eventSlug, markets);
        } catch {
            return null;
        }
    }

    const target = normalizeQuestionForMatch(predictQuestion);
    const hit = markets.find(m => normalizeQuestionForMatch(m.question || '') === target);
    if (!hit?.conditionId) return null;
    return hit;
}

async function main(): Promise<void> {
    console.log('🚀 启动 Dashboard（深度计算模式）\n');

    // 尽早注册优雅关闭处理，避免启动阶段 Ctrl+C 直接杀进程导致取消请求发不出去
    setupGracefulShutdown();

    // 初始化 TaskService
    await taskService.init();
    console.log('✅ TaskService 已初始化\n');

    // 初始化 TaskExecutor
    try {
        const opportunities: ArbOpportunity[] = [];
        await taskExecutor.init();
        console.log('✅ TaskExecutor 已初始化\n');
    } catch (error: any) {
        console.warn('⚠️  TaskExecutor 初始化失败 (交易功能不可用):', error.message);
        console.log('   请检查环境变量: PREDICT_SIGNER_PRIVATE_KEY, POLYMARKET_* 配置\n');
    }

    // 初始化 BSC WSS 订单监听（必需；用于加速 Predict 成交确认）
    // BSC WSS 连接失败将终止 dashboard
    if (process.env.PREDICT_SMART_WALLET_ADDRESS) {
        const bscWatcher = getBscOrderWatcher();

        // 先注册事件监听器（不依赖连接状态）
        bscWatcher.on('orderFilled', (event: BscOrderFilledEvent) => {
            // 仅广播"自己的订单"，避免全网 OrderFilled 触发 SSE 刷屏/背压断开
            const smartWallet = process.env.PREDICT_SMART_WALLET_ADDRESS?.toLowerCase();
            if (smartWallet) {
                const maker = event.maker.toLowerCase();
                const taker = event.taker.toLowerCase();
                const isMine = maker === smartWallet || taker === smartWallet;
                if (!isMine) return;
            }

            const tokenId = event.makerAssetId === '0' ? event.takerAssetId : event.makerAssetId;
            const marketInfo = bscWatcher.parseMarketFromEvent(event);
            broadcastBscOrderFilled({
                type: 'bscOrderFilled',
                event,
                tokenId,
                marketId: marketInfo?.market.marketId,
                marketTitle: marketInfo?.market.title,
                side: marketInfo?.side,
            });
            scheduleCloseRecompute(true);
        });

        // 注册 error 监听器，记录运行时错误（不终止进程，让重连机制处理）
        bscWatcher.on('error', (err) => {
            console.error(`[BSC WSS] 运行时错误: ${err?.message || err}`);
        });

        // 注册断开事件监听器
        bscWatcher.on('disconnected', () => {
            console.warn('[BSC WSS] 连接断开，正在重连...');
        });

        // 所有节点重连耗尽 → TG 告警（watcher 会自动 60s 后继续尝试）
        bscWatcher.on('maxReconnectAttemptsReached', () => {
            const tg = getTelegramNotifier();
            if (tg) {
                tg.sendAndPin('🚨 BSC WSS 所有节点重连失败\n成交检测已降级到 Predict WS 兜底\n60s 后自动重试').catch(() => {});
            }
        });

        bscWatcher.once('connected', () => {
            console.log('✅ BSC Order Watcher 已连接 (实时监控链上订单)\n');
        });

        // 阻塞启动 - BSC WSS 是必需的，连接失败则终止 dashboard
        console.log('⏳ BSC Order Watcher 正在连接...');
        try {
            await bscWatcher.start();
        } catch (err: any) {
            console.error('\n❌ BSC Order Watcher 启动失败:', err?.message || err);
            console.error('   BSC WSS 连接是必需的，无法继续启动 dashboard');
            console.error('   请检查网络连接或设置 BSC_WSS_URLS 环境变量\n');
            process.exit(1);
        }

        // TokenMarketCache 也阻塞启动
        if (process.env.PREDICT_API_KEY) {
            const tokenCache = getTokenMarketCache(process.env.PREDICT_API_KEY);

            tokenCache.on('refreshed', () => {
                bscWatcher.setTokenMarketMappings(tokenCache.exportTokenMappings());
            });

            try {
                await tokenCache.start();
                bscWatcher.setTokenMarketMappings(tokenCache.exportTokenMappings());
                console.log('✅ TokenMarketCache 已就绪\n');
            } catch (err: any) {
                console.warn('⚠️  TokenMarketCache 启动失败:', err?.message || err);
                // TokenMarketCache 失败不终止，只是没有市场名称映射
            }
        }

        // 初始化 Predict WS 钱包事件监听（API 级别订单状态推送）
        // 补充 BSC 链上事件，提供完整订单生命周期通知
        try {
            const predictWatcher = getPredictOrderWatcher();
            const taskLogger = getTaskLogger();

            // orderHash → 任务信息缓存 (WS CANCELLED/EXPIRED 事件不含市场数据，需要反查)
            // ORDER_ACCEPTED 写入，CANCELLED/EXPIRED 读取后删除
            const orderHashTaskCache = new Map<string, { title: string; side: string; taskId: string }>();
            const orderIdTaskCache = new Map<string, { title: string; side: string; taskId: string }>();
            const pendingAlertedKeys = new Set<string>();

            // 监听所有钱包事件（完整订单生命周期 SSE 广播）
            predictWatcher.on('walletEvent', (walletEvent: WalletEventData) => {
                const rawData = walletEvent.rawData as any;
                const tokenId = String(rawData?.makerAssetId || rawData?.order?.makerAssetId || rawData?.tokenId || '');
                const tokenCache = getTokenMarketCache();
                const marketInfo = tokenId && tokenCache.isReady() ? tokenCache.getMarketByTokenId(tokenId) : null;

                broadcastPredictWalletEvent({
                    type: 'predictWalletEvent',
                    event: walletEvent,
                    marketId: marketInfo?.market.marketId,
                    marketTitle: marketInfo?.market.title,
                });

                // ORDER_ACCEPTED: 缓存 orderHash → 任务信息 (供后续 CANCELLED/EXPIRED 查询)
                if (walletEvent.type === 'ORDER_ACCEPTED') {
                    const hash = walletEvent.orderHash?.toLowerCase();
                    const orderId = walletEvent.orderId?.replace(/n$/, '');
                    if (hash) {
                        const allTasks = taskService.getTasks({ includeCompleted: false });
                        const matched = allTasks.find(t => t.currentOrderHash?.toLowerCase() === hash);
                        if (matched) {
                            const cacheEntry = {
                                title: matched.title || matched.predictSlug || `#${matched.marketId}`,
                                side: matched.arbSide || '',
                                taskId: matched.id,
                            };
                            orderHashTaskCache.set(hash, cacheEntry);
                            if (orderId) {
                                orderIdTaskCache.set(orderId, cacheEntry);
                            }
                        }
                        // 防止无限增长：超过 200 条时清理最早的
                        if (orderHashTaskCache.size > 200) {
                            const firstKey = orderHashTaskCache.keys().next().value!;
                            orderHashTaskCache.delete(firstKey);
                        }
                        if (orderIdTaskCache.size > 200) {
                            const firstKey = orderIdTaskCache.keys().next().value!;
                            orderIdTaskCache.delete(firstKey);
                        }
                    }
                }

                if (walletEvent.type === 'ORDER_TX_PENDING') {
                    const orderHash = walletEvent.orderHash?.toLowerCase() || '';
                    const orderId = walletEvent.orderId?.replace(/n$/, '') || '';
                    const lookupKey = orderHash || orderId;

                    let taskId =
                        (orderHash && orderHashTaskCache.get(orderHash)?.taskId)
                        || (orderId && orderIdTaskCache.get(orderId)?.taskId)
                        || null;
                    let taskTitle =
                        (orderHash && orderHashTaskCache.get(orderHash)?.title)
                        || (orderId && orderIdTaskCache.get(orderId)?.title)
                        || '';

                    if (!taskId && orderHash) {
                        const executorCheck = taskExecutor.isOrderManagedByExecutor(orderHash);
                        if (executorCheck.managed) {
                            taskId = executorCheck.taskId || null;
                            taskTitle = executorCheck.title || '';
                        }
                    }

                    if (!taskId) return;
                    if (lookupKey && pendingAlertedKeys.has(lookupKey)) return;

                    const task = taskService.getTask(taskId);
                    if (!task) return;

                    if (lookupKey) pendingAlertedKeys.add(lookupKey);

                    const rawFill = (walletEvent.rawData as any)?.fill;
                    let pendingShares = 0;
                    try {
                        const executedSizeWei = rawFill?.executedSizeWei;
                        if (executedSizeWei !== undefined && executedSizeWei !== null) {
                            pendingShares = Number(BigInt(String(executedSizeWei)) / 10n ** 12n) / 1e6;
                        }
                    } catch {
                        pendingShares = 0;
                    }
                    const fallbackQty = typeof walletEvent.filledQty === 'number' ? walletEvent.filledQty : 0;
                    const filledQty = pendingShares > 0 ? pendingShares : fallbackQty;
                    const remainingQty = Math.max((task.quantity || 0) - filledQty, 0);
                    const title = taskTitle || task.title || task.predictSlug || `#${task.marketId}`;
                    const eventOrderId = orderHash || orderId || task.currentOrderHash || '';
                    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    const eventTime = new Date(walletEvent.timestamp || Date.now()).toLocaleString('zh-CN', { hour12: false });

                    console.warn(
                        `[PredictWS] 预警: ORDER_TX_PENDING task=${taskId}, order=${eventOrderId.slice(0, 18) || 'n/a'}, ` +
                        `market=${title}, filled=${filledQty}/${task.quantity}, txHash=${walletEvent.txHash || 'n/a'}`
                    );

                    taskLogger.logOrderEvent(
                        taskId,
                        'ORDER_PENDING',
                        {
                            platform: 'predict',
                            orderId: eventOrderId,
                            side: task.type as 'BUY' | 'SELL',
                            outcome: task.arbSide,
                            price: task.predictPrice || walletEvent.avgPrice || 0,
                            quantity: task.quantity || 0,
                            filledQty,
                            remainingQty,
                            avgPrice: walletEvent.avgPrice || 0,
                            title,
                            rawResponse: (walletEvent.rawData as Record<string, unknown>) || {},
                        },
                        orderHash || task.currentOrderHash,
                    ).catch((e: any) => {
                        console.warn(`[PredictWS] ORDER_PENDING 任务日志失败: ${e?.message || e}`);
                    });

                    const tg = getTelegramNotifier();
                    if (tg) {
                        const message = [
                            `🟠 <b>Predict Pending 预警</b>`,
                            `<b>任务:</b> <code>${taskId}</code>`,
                            `<b>市场:</b> ${escHtml(title.slice(0, 80))}`,
                            `<b>方向:</b> ${escHtml(task.type)}${task.arbSide ? ` (${escHtml(task.arbSide)})` : ''}`,
                            eventOrderId ? `<b>订单:</b> <code>${escHtml(eventOrderId.slice(0, 24))}${eventOrderId.length > 24 ? '...' : ''}</code>` : null,
                            walletEvent.txHash ? `<b>Tx:</b> <code>${escHtml(walletEvent.txHash.slice(0, 24))}${walletEvent.txHash.length > 24 ? '...' : ''}</code>` : null,
                            `<b>本次链上成交:</b> ${filledQty.toFixed(2)} shares`,
                            `<b>任务总量:</b> ${task.quantity}`,
                            `<b>时间:</b> ${eventTime}`,
                        ].filter((v): v is string => v !== null).join('\n')
                            + '\n\n📡 <i>via Predict WebSocket ORDER_TX_PENDING</i>';

                        tg.sendText(message).catch((e: any) => {
                            console.warn('[TG] Predict pending 预警发送失败:', e?.message);
                        });
                    }
                }

                // TG 通知: ORDER_CANCELLED / ORDER_EXPIRED
                // executor 管理的订单取消（价格/深度保护、订单调整）已有 TaskLogger 通知，跳过
                // 仅推送 executor 未管理的孤儿订单（如 OOM 后交易所取消、手动取消、链上过期）
                if (walletEvent.type === 'ORDER_CANCELLED' || walletEvent.type === 'ORDER_EXPIRED') {
                    const orderHash = walletEvent.orderHash?.toLowerCase() || '';
                    const orderId = walletEvent.orderId?.replace(/n$/, '') || '';
                    const reason = walletEvent.reason || '';
                    const isBalanceCancellation = /insufficient|balance|allowance|collateral/i.test(reason);

                    // 检查是否为 executor 管理的订单
                    // 三层查找: orderHashTaskCache → executor.isOrderManagedByExecutor → 任务列表
                    let managedByExecutor = false;
                    let managedTaskId: string | null = null;
                    if (orderHash) {
                        if (orderHashTaskCache.has(orderHash)) {
                            managedTaskId = orderHashTaskCache.get(orderHash)?.taskId || null;
                            orderHashTaskCache.delete(orderHash);
                            pendingAlertedKeys.delete(orderHash);
                            managedByExecutor = true;
                        } else {
                            // 查询 executor 的运行时上下文 + 已取消订单注册表
                            const executorCheck = taskExecutor.isOrderManagedByExecutor(orderHash);
                            if (executorCheck.managed) {
                                managedByExecutor = true;
                                managedTaskId = executorCheck.taskId || null;
                            }
                        }
                    }
                    if (orderId) {
                        orderIdTaskCache.delete(orderId);
                        pendingAlertedKeys.delete(orderId);
                    }

                    // 交易所/链上因余额不足自动撤单：除了通知，还要联动取消关联任务
                    if (isBalanceCancellation && managedTaskId) {
                        const task = taskService.getTask(managedTaskId);
                        if (task && !['COMPLETED', 'FAILED', 'CANCELLED', 'UNWIND_COMPLETED'].includes(task.status)) {
                            console.warn(`[PredictWS] 检测到余额不足撤单，联动取消任务: ${managedTaskId}, reason=${reason}`);
                            taskExecutor.cancelTask(managedTaskId).catch((err: any) => {
                                console.warn(`[PredictWS] 余额不足撤单后取消任务失败: ${managedTaskId}, ${err?.message || err}`);
                            });

                            const tg = getTelegramNotifier();
                            if (tg) {
                                const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                                const title = task.title ? escHtml(task.title.slice(0, 60)) : `#${task.marketId}`;
                                tg.sendText([
                                    `🚨 <b>Predict 余额不足自动撤单 → 任务取消</b>`,
                                    `<b>任务:</b> <code>${managedTaskId}</code>`,
                                    `<b>市场:</b> ${title}`,
                                    orderHash ? `<b>订单:</b> <code>${orderHash.slice(0, 16)}...</code>` : null,
                                    `<b>原因:</b> ${escHtml(reason)}`,
                                ].filter((v): v is string => v !== null).join('\n')).catch(() => {});
                            }
                        }
                    }

                    if (!managedByExecutor) {
                        // 孤儿订单: 非 executor 管理，推送 TG 通知
                        const tg = getTelegramNotifier();
                        if (tg) {
                            const emoji = walletEvent.type === 'ORDER_CANCELLED' ? '❌' : '⏰';
                            const statusText = walletEvent.type === 'ORDER_CANCELLED' ? '订单已取消' : '订单已过期';
                            const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

                            // 市场名称: tokenCache → walletEvent.marketId 反查任务 → "未知市场"
                            let title = marketInfo?.market.title
                                ? escHtml(marketInfo.market.title.slice(0, 60))
                                : '';
                            if (!title && walletEvent.marketId) {
                                const allTasks = taskService.getTasks({ includeCompleted: true });
                                const taskByMarket = allTasks.find(t => t.marketId === walletEvent.marketId);
                                if (taskByMarket?.title) {
                                    title = escHtml(taskByMarket.title.slice(0, 60));
                                } else {
                                    title = `#${walletEvent.marketId}`;
                                }
                            }
                            if (!title) title = '未知市场';

                            // 取消原因: WS reason → rawData 补充字段
                            let displayReason = reason;
                            if (!displayReason) {
                                const raw = walletEvent.rawData as any;
                                displayReason = raw?.cancelReason || raw?.cancel_reason
                                    || raw?.message || raw?.error || '';
                            }

                            const time = new Date(walletEvent.timestamp || Date.now()).toLocaleString('zh-CN');

                            const message = [
                                `🟠 ${emoji} <b>Predict ${statusText} (非托管)</b>`,
                                `<b>市场:</b> ${title}`,
                                orderHash ? `<b>订单:</b> <code>${orderHash.slice(0, 16)}...</code>` : null,
                                displayReason ? `<b>原因:</b> ${escHtml(displayReason)}` : null,
                                `<b>时间:</b> ${time}`,
                            ].filter((v): v is string => v !== null).join('\n')
                                + '\n\n📡 <i>via Predict WebSocket</i>';

                            tg.sendText(message).catch((e: any) => {
                                console.warn('[TG] Predict 终态通知发送失败:', e?.message);
                            });
                        }
                    }
                }

                if (
                    walletEvent.type === 'ORDER_TX_CONFIRMED'
                    || walletEvent.type === 'ORDER_TX_FAILED'
                    || walletEvent.type === 'ORDER_FILLED'
                    || walletEvent.type === 'ORDER_PARTIALLY_FILLED'
                ) {
                    const orderHash = walletEvent.orderHash?.toLowerCase() || '';
                    const orderId = walletEvent.orderId?.replace(/n$/, '') || '';
                    if (orderHash) pendingAlertedKeys.delete(orderHash);
                    if (orderId) pendingAlertedKeys.delete(orderId);
                }
            });

            // 监听成交事件 → 触发平仓机会重算
            predictWatcher.on('orderFilled', (_filledEvent: OrderFilledEvent) => {
                scheduleCloseRecompute(true);
            });

            predictWatcher.on('subscriptionLost', (info: { reason: string }) => {
                console.warn(`[PredictOrderWatcher] 订阅断开: ${info.reason}`);
            });

            predictWatcher.on('subscriptionRestored', () => {
                console.log('[PredictOrderWatcher] 订阅已恢复');
            });

            await predictWatcher.start();
            console.log('✅ Predict WS 钱包事件监听已启动 (订单生命周期推送)\n');
        } catch (err: any) {
            console.warn('⚠️  Predict WS 钱包事件监听启动失败:', err?.message || err);
            console.warn('   手动下单状态推送将不可用，但链上成交通知正常');
        }
    } else {
        console.log('ℹ️  未配置 PREDICT_SMART_WALLET_ADDRESS，跳过 BSC WSS 订单监听\n');
    }

    // 监听任务事件并广播给 SSE 客户端
    taskService.on('task:created', (task: Task) => broadcastTaskUpdate(task));
    taskService.on('task:updated', (task: Task) => broadcastTaskUpdate(task));
    taskService.on('task:deleted', (taskId: string) => broadcastTaskDeleted(taskId));

    // 监听 TaskExecutor 事件
    taskExecutor.on('task:updated', (task: Task) => broadcastTaskUpdate(task));

    // 关键告警 → TG 置顶消息
    taskExecutor.on('alert:pin', (msg: string) => {
        const tg = getTelegramNotifier();
        if (tg) {
            tg.sendAndPin(msg).catch(err =>
                console.warn(`[TaskExecutor TG] sendAndPin 失败: ${err.message}`)
            );
        }
    });

    // 普通信息（对冲完成/耗时等）→ TG 不置顶
    taskExecutor.on('alert:info', (msg: string) => {
        const tg = getTelegramNotifier();
        if (tg) {
            tg.sendText(msg).catch(err =>
                console.warn(`[TaskExecutor TG] sendText 失败: ${err.message}`)
            );
        }
    });

    // 连接 TaskLogger SSE 通知 (独立于 Telegram，用于前端浮窗通知)
    {
        const taskLogger = getTaskLogger();
        taskLogger.connectNotifier(({ taskId, event }) => {
            // 广播任务事件到前端 (用于订单状态浮窗通知)
            const ssePayload = {
                taskId,
                type: event.type,
                timestamp: event.timestamp,
                platform: (event.payload as any)?.platform,
                side: (event.payload as any)?.side,
                price: (event.payload as any)?.price,
                quantity: (event.payload as any)?.quantity,
                filledQty: (event.payload as any)?.filledQty,
                avgPrice: (event.payload as any)?.avgPrice,
                error: typeof (event.payload as any)?.error === 'string'
                    ? (event.payload as any).error
                    : (event.payload as any)?.error?.message || undefined,
                reason: (event.payload as any)?.reason,
            };
            broadcastSSEGlobal('taskEvent', JSON.stringify(ssePayload));
        });
        console.log('✅ TaskLogger SSE 通知已连接 (前端浮窗)\n');
    }

    // 连接 Telegram 通知 (如果配置了)
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;
    if (telegramToken && telegramChatId) {
        const telegram = createTelegramNotifier({
            botToken: telegramToken,
            chatId: telegramChatId,
            enabled: true,
        });
        const taskLogger = getTaskLogger();
        // Predict 成交事件由 BSC OrderNotifier 推送（链上确认，更可靠）
        // TaskLogger 的 ORDER_PARTIAL_FILL/ORDER_FILLED (platform=predict) 跳过，避免重复通知
        const PREDICT_FILL_EVENTS = new Set(['ORDER_PARTIAL_FILL', 'ORDER_FILLED']);

        // 批量创建/取消的 TG 节流：每 50 条汇总一次，5 秒无新事件冲尾批
        // 仅在批量 runner 运行中生效，避免误伤手动单条操作
        const BATCH_THROTTLE_THRESHOLD = 50;
        const BATCH_TAIL_FLUSH_MS = 5000;
        type ThrottleKey = 'TASK_CREATED' | 'TASK_CANCELLED';
        interface ThrottleBucket { count: number; timer: NodeJS.Timeout | null }
        const throttleBuckets = new Map<ThrottleKey, ThrottleBucket>();

        const isBatchRunnerActive = (): boolean =>
            autoTaskCreateRunner.isBusy() ||
            polyMakerAutoCreateRunner.isBusy() ||
            batchTaskCancelRunner.isBusy() ||
            ppFarmerAllRunner.getState().busy ||
            ppFarmerSportsRunner.getState().busy;

        const flushThrottle = (key: ThrottleKey): void => {
            const st = throttleBuckets.get(key);
            if (!st || st.count === 0) return;
            if (st.timer) { clearTimeout(st.timer); st.timer = null; }
            const label = key === 'TASK_CREATED' ? '已创建' : '已取消';
            const emoji = key === 'TASK_CREATED' ? '📝' : '🛑';
            const text = `${emoji} 批量${key === 'TASK_CREATED' ? '创建' : '取消'}: ${label} ${st.count}`;
            st.count = 0;
            telegram.sendText(text).catch((err: any) =>
                console.warn(`[TaskLogger TG] 批量汇总发送失败: ${err?.message || err}`)
            );
        };

        taskLogger.connectNotifier(({ taskId, event }) => {
            const platform = (event.payload as any)?.platform as string | undefined;
            if (PREDICT_FILL_EVENTS.has(event.type) && platform === 'predict') {
                return; // BSC OrderNotifier 已覆盖
            }
            const task = taskService.getTask(taskId);

            // 节流：仅当批量 runner 运行中，且是 TASK_CREATED / TASK_CANCELLED 事件
            const throttleKey: ThrottleKey | null =
                event.type === 'TASK_CREATED' ? 'TASK_CREATED'
                : event.type === 'TASK_CANCELLED' ? 'TASK_CANCELLED'
                : null;
            if (throttleKey && isBatchRunnerActive()) {
                let st = throttleBuckets.get(throttleKey);
                if (!st) {
                    st = { count: 0, timer: null };
                    throttleBuckets.set(throttleKey, st);
                }
                st.count += 1;
                if (st.count >= BATCH_THROTTLE_THRESHOLD) {
                    flushThrottle(throttleKey);
                } else {
                    if (st.timer) clearTimeout(st.timer);
                    st.timer = setTimeout(() => flushThrottle(throttleKey), BATCH_TAIL_FLUSH_MS);
                }
                return; // 吞掉单条消息，等汇总发送
            }

            const batchPrefix = (event.type === 'TASK_CREATED' && task?.batchCreate)
                ? `<b>批量:</b> ${task.batchCreate.index}/${task.batchCreate.total}\n`
                : '';
            const text = `${batchPrefix}${taskLogger.formatEventForNotification(taskId, event)}`;
            // fire-and-forget，不阻塞任务执行
            telegram.sendText(text).catch(err =>
                console.warn(`[TaskLogger TG] 发送失败: ${err.message}`)
            );
        });
        console.log('✅ Telegram 通知已连接 (Predict 成交由 BSC 通知覆盖)\n');

        // Polymarket User WS 订单通知已禁用
        // （TaskLogger 已经报告 CLOB 成交，WS 的链上确认通知有延迟且重复）
        // startWsOrderNotifierFromEnv()
        //     .then(() => console.log('✅ WS 订单通知服务已启动 (实时推送 Polymarket 订单状态到 Telegram)'))
        //     .catch((e: any) => console.warn(`⚠️  WS 订单通知服务启动失败: ${e?.message || e}`));

        // 启动 BSC 订单通知（只通知自己的订单；需配置 PREDICT_SMART_WALLET_ADDRESS）
        // 非阻塞启动，避免卡住 dashboard
        startBscOrderNotifierFromEnv()
            .then((started) => {
                if (started) console.log('✅ BSC 订单通知服务已启动 (实时推送 Predict 链上订单到 Telegram)');
            })
            .catch((e: any) => console.warn(`⚠️  BSC 订单通知服务启动失败: ${e?.message || e}`));
    } else {
        console.log('⚠️  Telegram 未配置 (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)\n');
    }

    // 启动全局敞口定时检测
    exposureMonitor = createExposureMonitor({
        taskService,
        broadcastSSEGlobal,
        getTelegramNotifier,
        captureExposureSnapshot: (taskId, exposure) => taskExecutor.captureExposureSnapshot(taskId, exposure),
    });

    // 启动双边余额守卫 (Poly WS + Predict WS 成交后检查余额，自动取消余额不足的任务)
    balanceGuard = createBalanceGuard({
        getUserWsClient: () => {
            try { return getPolymarketUserWsClient(); } catch { return null; }
        },
        getPredictOrderWatcher: () => {
            try { return getPredictOrderWatcher(); } catch { return null; }
        },
        taskExecutor,
        getTaskList: () => taskService.getTasks(),
        getAvailableBalance: getPolymarketAvailableBalance,
        getPredictAvailableBalance,
        broadcastSSE: broadcastSSEGlobal,
        getTelegramNotifier,
    });
    balanceGuard.start();

    // 构建 conditionId → 事件 endDate 映射 (用于显示与 Polymarket 前端一致的结算时间)
    // 非阻塞启动，映射完成后市场列表会自动获取到 endDate
    console.log('🔄 正在后台构建 endDate 映射...');
    buildEventEndDateMapping()
        .then(() => console.log('✅ endDate 映射完成'))
        .catch((e: any) => console.warn(`⚠️  endDate 映射失败: ${e?.message || e}`));

    // 加载已匹配的市场对
    const matchResultPath = join(__dirname, '..', '..', 'polymarket-match-result.json');

    // 默认启动时刷新市场，除非指定 --use-cache
    const useCache = process.argv.includes('--use-cache') || process.argv.includes('--cache');
    const backgroundRescan = process.argv.includes('--rescan') || process.argv.includes('--scan');

    // 检查缓存时间
    let cacheAge = 0;
    if (existsSync(matchResultPath)) {
        const { statSync } = await import('fs');
        const stats = statSync(matchResultPath);
        cacheAge = Math.floor((Date.now() - stats.mtimeMs) / 1000 / 60); // 分钟
    }

    if (!useCache || !existsSync(matchResultPath)) {
        if (!existsSync(matchResultPath)) {
            console.log('🔍 未找到缓存文件，正在扫描市场...\n');
        } else {
            console.log('🔍 启动时刷新市场列表...\n');
        }

        // 执行扫描（windowsHide 防止弹出 cmd 窗口）
        const { execSync } = await import('child_process');
        try {
            const opportunities: ArbOpportunity[] = [];
            const output = execSync('npx tsx src/terminal/scan-all-markets.ts', {
                cwd: join(__dirname, '..', '..'),
                stdio: 'pipe',
                windowsHide: true,
                encoding: 'utf-8',
            });
            if (output) console.log(output);
            console.log('\n✅ 市场扫描完成\n');
        } catch (error: any) {
            // execSync 失败时 stdout/stderr 在 error 对象中
            if (error.stdout) console.log(error.stdout);
            if (error.stderr) console.error(error.stderr);
            console.error('❌ 扫描失败');
            if (!existsSync(matchResultPath)) {
                console.error('   没有可用的市场数据，退出\n');
                process.exit(1);
            }
            console.log('   使用现有缓存继续...\n');
        }
    } else if (backgroundRescan) {
        console.log('🔍 检测到 --rescan 参数，将在后台更新市场列表\n');
        // 后台异步扫描（windowsHide 防止弹出 cmd 窗口）
        import('child_process').then(({ exec }) => {
            exec('npx tsx src/terminal/scan-all-markets.ts', {
                cwd: join(__dirname, '..', '..'),
                windowsHide: true,
            }, (error) => {
                if (error) {
                    console.error('❌ 后台扫描失败:', error);
                } else {
                    console.log('\n✅ 后台扫描完成，重启 Dashboard 以加载新数据\n');
                }
            });
        });
    } else {
        console.log(`📂 使用缓存 (--use-cache)，缓存时间: ${cacheAge}分钟前\n`);
    }

    if (existsSync(matchResultPath)) {
        // 重新读取缓存时间
        const { statSync } = await import('fs');
        const stats = statSync(matchResultPath);
        const fileAge = Math.floor((Date.now() - stats.mtimeMs) / 1000 / 60); // 分钟
        console.log(`📂 加载市场数据... (缓存: ${fileAge}分钟前)\n`);

        const matchResult = JSON.parse(readFileSync(matchResultPath, 'utf-8'));
        const activeMatches = (matchResult.matches || []).filter((m: any) =>
            m.polymarket.active && !m.polymarket.closed && m.polymarket.acceptingOrders
        );

        console.log(`  共 ${activeMatches.length} 个活跃市场，正在获取详情...\n`);

        // 提取所有 categorySlug 并构建 Predict endsAt 缓存
        const categorySlugs = activeMatches
            .map((m: any) => m.predict?.categorySlug)
            .filter(Boolean) as string[];
        if (categorySlugs.length > 0) {
            await buildPredictEndsAtMapping(categorySlugs);
        }

        // 使用所有 key 并发批量获取
        const allKeys = getAllScanKeys();
        const BATCH_SIZE = 30;

        // 检查缓存是否包含预缓存的 tokenId (scan-all-markets.ts 新版本会保存)
        const hasCachedTokens = activeMatches.some((m: any) => m.polymarket?.tokenId);
        if (hasCachedTokens) {
            console.log(`  ⚡ 缓存包含 tokenId/negRisk，跳过 Polymarket API 调用\n`);
        } else {
            console.log(`  使用 ${allKeys.length} 个 API key 并发获取 (缓存无 tokenId，需调 API)\n`);
        }

        let processed = 0;
        let apiCallCount = 0;
        for (let i = 0; i < activeMatches.length; i += BATCH_SIZE) {
            const batch = activeMatches.slice(i, i + BATCH_SIZE);

            const results = await Promise.all(batch.map(async (match: any, idx: number) => {
                let conditionId = match.polymarket.conditionId;
                const predictQuestion = match.predict.question || match.predict.title || '';

                // 优先从缓存读取 tokenId/negRisk/tickSize (无需 API 调用)
                let marketInfo: PolymarketMarketInfo | null = null;
                if (match.polymarket.tokenId) {
                    // 缓存中有完整数据，直接使用
                    marketInfo = {
                        tokenId: match.polymarket.tokenId,
                        yesTokenId: match.polymarket.yesTokenId || null,
                        noTokenId: match.polymarket.noTokenId || null,
                        tickSize: match.polymarket.tickSize || 0.01,
                        negRisk: match.polymarket.negRisk === true,
                        slug: match.polymarket.slug || null,
                    };
                    // 也写入内存缓存，后续扫描/计算可用
                    polymarketMarketInfoCache.set(conditionId, { info: marketInfo, timestamp: Date.now() });
                } else {
                    // 旧版缓存无 tokenId，回退到 API 调用
                    marketInfo = await getPolymarketMarketInfo(conditionId);
                    apiCallCount++;
                }
                let endDate = getPolymarketEndDate(conditionId);

                // 修复少量 “any other” 市场被错误绑定到具体选手/标的的情况
                const fixed = await tryFixPolymarketConditionIdForAnyOther(
                    predictQuestion,
                    match.polymarket.question || '',
                    marketInfo?.slug || null
                );
                if (fixed?.conditionId && fixed.conditionId !== conditionId) {
                    const fixedConditionId = fixed.conditionId;
                    const fixedMarketInfo = await getPolymarketMarketInfo(fixedConditionId);
                    apiCallCount++;
                    if (fixedMarketInfo?.tokenId) {
                        console.log(`\n  🔧 [FixLink] Predict#${match.predict.id} conditionId override: ${conditionId.slice(0, 10)}… -> ${fixedConditionId.slice(0, 10)}…`);
                        conditionId = fixedConditionId;
                        marketInfo = fixedMarketInfo;
                        endDate = getPolymarketEndDate(fixedConditionId);
                    }
                }

                if (marketInfo && marketInfo.tokenId) {
                    // 优先使用 Polymarket endDate，如果过期则使用 Predict endsAt 作为备选
                    const predictEndsAt = getPredictEndsAt(match.predict?.categorySlug);
                    const finalEndDate = isEndDateValid(endDate)
                        ? endDate
                        : (predictEndsAt || undefined);
                    return {
                        predictId: match.predict.id,
                        predictTitle: match.predict.title,
                        predictQuestion,
                        categorySlug: match.predict.categorySlug,
                        polymarketConditionId: conditionId,
                        polymarketSlug: marketInfo.slug || undefined,
                        polymarketTokenId: marketInfo.tokenId,
                        polymarketNoTokenId: marketInfo.noTokenId || undefined,
                        polymarketYesTokenId: marketInfo.yesTokenId || undefined,
                        tickSize: marketInfo.tickSize,
                        feeRateBps: match.predict.feeRateBps ?? 200,
                        isInverted: match.inverted === true,
                        endDate: finalEndDate,
                        negRisk: marketInfo.negRisk,
                    };
                }
                return null;
            }));

            for (const result of results) {
                if (result) marketPairs.push(result);
            }

            processed += batch.length;
            process.stdout.write(`\r  已处理 ${processed}/${activeMatches.length} 个市场`);
        }

        console.log('\n');
        if (apiCallCount > 0) {
            console.log(`  📡 Polymarket API 调用: ${apiCallCount} 次`);
        } else {
            console.log(`  ⚡ 0 次 Polymarket API 调用 (全部从缓存读取)`);
        }
        dashboardData.stats.marketsMonitored = marketPairs.length;

        // 显示费率统计
        const feeStats = new Map<number, number>();
        for (const pair of marketPairs) {
            feeStats.set(pair.feeRateBps, (feeStats.get(pair.feeRateBps) || 0) + 1);
        }
        console.log('📊 费率分布:');
        for (const [fee, count] of Array.from(feeStats.entries()).sort((a, b) => a[0] - b[0])) {
            console.log(`   ${fee / 100}%: ${count} 个市场`);
        }

        console.log(`\n✅ 加载了 ${marketPairs.length} 个市场对\n`);

        // 注册 boost 市场 ID 提供者（包含 live + sports 市场）
        setBoostMarketIdProvider(() => {
            const ids = new Set<number>();
            for (const p of marketPairs) {
                ids.add(p.predictId);
            }
            const sportsService = getSportsService();
            if (sportsService) {
                for (const m of sportsService.getMarkets()) {
                    if (m.predictMarketId) ids.add(m.predictMarketId);
                    if (m.predictAwayMarketId) ids.add(m.predictAwayMarketId);
                    if (m.predictHomeMarketId) ids.add(m.predictHomeMarketId);
                }
            }
            return Array.from(ids);
        });

        // 获取 volume 数据
        await fetchMarketVolumes();

        // 自动缓存 Predict slugs (用于 View 导航 URL)
        // 使用 predictQuestion (完整市场标题) 匹配 browser-slugs.json，而非 predictTitle (选项名)
        cachePredictSlugs(marketPairs.map(p => ({ id: p.predictId, title: p.predictQuestion })));

        // 注入市场标题查找器到 account-service (使用 predictQuestion 完整标题)
        const marketTitleMap = new Map(marketPairs.map(p => [p.predictId, p.predictQuestion]));
        setMarketTitleResolver((predictId: number) => marketTitleMap.get(predictId));
    } else {
        console.log('❌ 未找到匹配结果文件: polymarket-match-result.json');
        console.log('   请先运行: npm run scan-markets\n');
        process.exit(1);
    }

    if (marketPairs.length === 0 && !ENABLE_SPORTS_SERVICE) {
        console.log('❌ 没有可用的市场对且体育服务未启用\n');
        process.exit(1);
    }

    // 初始化体育市场服务 (可通过 ENABLE_SPORTS_SERVICE 开关控制)
    let sportsService: ReturnType<typeof getSportsService> | null = null;
    if (ENABLE_SPORTS_SERVICE) {
        console.log('🔄 正在初始化体育市场服务...');
        sportsService = getSportsService();
        // 注入 TG 告警回调
        sportsService.setAlertCallback((msg: string) => {
            const tg = getTelegramNotifier();
            if (tg) {
                tg.sendAndPin(msg).catch(err =>
                    console.warn(`[SportsService TG] sendAndPin 失败: ${err.message}`)
                );
            }
        });
        console.log('✅ SportsService 已初始化\n');
    } else {
        console.log('⏸️  体育市场服务已禁用 (ENABLE_SPORTS_SERVICE=false)\n');
    }

    // 连接 Polymarket WebSocket (仅 allMarketsEnabled 时连接主 WS，否则只启动 Sports 独立 WS)
    if (allMarketsEnabled) {
        console.log('🔄 正在连接 Polymarket WebSocket...');
        await initPolymarketWs();
        if (polymarketWsClient) {
            getOrderMonitor().setPolyWsClient(polymarketWsClient);
        }
        console.log('✅ Polymarket WebSocket 已连接\n');
    } else {
        console.log('⏸️  All 市场已禁用，跳过 Polymarket 主 WS 连接\n');
    }
    // 启动体育市场独立 WS 订单簿订阅 (不依赖主 WS)
    if (sportsService) {
        sportsService.initWsSubscription().catch(err =>
            console.error('[Sports] WS 初始化失败:', err.message)
        );
    }

    // 初始化 Predict 订单簿数据源
    if (DASHBOARD_PREDICT_ORDERBOOK_MODE === 'ws') {
        console.log('🔄 正在初始化 Predict WebSocket 订单簿缓存...');
        usePredictWsMode = true;

        const apiKey = process.env.PREDICT_API_KEY;
        if (!apiKey) {
            console.error('❌ 缺少 PREDICT_API_KEY，无法初始化 WS 模式');
            process.exit(1);
        }

        // 初始化统一缓存（WS 优先，允许 stale 数据避免频繁缺失）
        // 注意：Predict WS 仅推增量，无初始快照，必须 allowStale 或 warm
        await initPredictOrderbookCache({
            apiKey,
            wsEnabled: true,
            restEnabled: true,  // 允许 REST 作为兜底和 warm
            ttlMs: PREDICT_ORDERBOOK_STALE_MS,
            allowStale: true,   // 允许使用过期数据（WS 无快照时避免大量 null）
        });

        // 启动前先拉一次 PP 数据，用于过滤主市场订阅范围（仅订阅有 reward 的市场）
        if (allMarketsEnabled) {
            try {
                await fetchRewardData();
                console.log(`  ✓ Reward data fetched (${getRewardCacheStats().size} markets with rewards)`);
            } catch (err: any) {
                console.warn(`  ✗ Reward data fetch failed: ${err?.message || err}`);
            }
        }

        // 先订阅主市场 ID（体育市场在 scan() 后补订阅）
        // 内存优化：只订阅有 PP reward 的市场（过滤无 reward 的长尾市场）
        const allMarketIds = marketPairs.map(p => p.predictId);
        const marketIds = allMarketsEnabled
            ? allMarketIds.filter(id => hasMarketReward(id))
            : allMarketIds;

        // 批量订阅主市场
        const unifiedCache = getPredictOrderbookCache();
        if (unifiedCache) {
            if (allMarketsEnabled) {
                await unifiedCache.subscribeMarkets(marketIds);
                console.log(`✅ Predict WebSocket 已连接，订阅 ${marketIds.length}/${allMarketIds.length} 个有 PP reward 的主市场`);

                // 心跳快照: WS 订阅后用 REST warm 缓存（Predict WS 无初始快照）
                if (PREDICT_ORDERBOOK_WARM_ON_SUBSCRIBE) {
                    console.log(`🔥 正在用 REST 预热订单簿缓存 (${marketIds.length} 个市场)...`);
                    const warmStart = Date.now();
                    const WARM_BATCH_SIZE = 30;
                    const WARM_BATCH_DELAY_MS = 50;
                    let warmedCount = 0;

                    for (let i = 0; i < marketIds.length; i += WARM_BATCH_SIZE) {
                        const batch = marketIds.slice(i, i + WARM_BATCH_SIZE);
                        await Promise.all(batch.map(async (marketId) => {
                            try {
                                const book = await unifiedCache.getOrderbook(marketId);
                                if (book) warmedCount++;
                            } catch {
                                // 静默失败
                            }
                        }));
                        if (i + WARM_BATCH_SIZE < marketIds.length) {
                            await new Promise(r => setTimeout(r, WARM_BATCH_DELAY_MS));
                        }
                    }
                    console.log(`✅ 预热完成: ${warmedCount}/${marketIds.length} 个市场，耗时 ${Date.now() - warmStart}ms`);
                }

                console.log(`   ⏳ 体育市场将在 scan() 完成后补订阅\n`);
            } else {
                console.log('⏸️  All 市场已禁用，跳过 Predict 主市场 WS 订阅');
                console.log(`   ⏳ 体育市场将在 scan() 完成后补订阅\n`);
            }

            // Predict WS 断连/重连 TG 通知
            const predictWsClient = unifiedCache.getWsClient();
            if (predictWsClient) {
                let predictWsFirstConnect = true;
                predictWsClient.on('connected', () => {
                    if (predictWsFirstConnect) {
                        predictWsFirstConnect = false;
                    } else {
                        sendWsNotification('✅ Predict WS 已重连');
                    }
                });
                predictWsClient.on('disconnected', () => {
                    sendWsNotification('⚠️ Predict WS 断连');
                });
            }

            // 注入 Sports Service 的 Predict 订单簿 provider
            setSportsPredictOrderbookProvider((marketId: number) => {
                const cached = unifiedCache.getOrderbookSync(marketId);
                if (!cached) return null;
                return {
                    bids: cached.bids.map(l => [l.price, l.size] as [number, number]),
                    asks: cached.asks.map(l => [l.price, l.size] as [number, number]),
                };
            });

            // 注册 Predict WS 更新回调，触发机会重算
            // 与 Polymarket WS 保持一致的处理逻辑
            unifiedCache.onUpdate((marketId: number, _book: CachedOrderbook) => {
                if (_book.source !== 'ws') return;
                // 记录 Predict WS 更新时间戳
                lastWsUpdateByMarket.set(marketId, Date.now());

                // 触发机会重算（节流）
                handlePredictWsUpdate(marketId);
            });
            console.log(`✅ Predict WS 更新回调已注册`);
        }
    } else {
        console.log('ℹ️  Predict 订单簿使用 Legacy 模式 (REST 轮询)\n');
        usePredictWsMode = false;
        // Legacy 模式下不注入 provider，sports-service 使用 REST
        setSportsPredictOrderbookProvider(null);
    }

    // 构建 tokenId → marketPair 索引（用于 WS 增量更新）
    buildTokenIdIndex();

    // 订阅主市场 tokens (体育市场通过 REST API 轮询)
    if (allMarketsEnabled) {
        subscribePolymarketTokens();
    } else {
        console.log('⏸️  All 市场已禁用，跳过 Polymarket 主市场 WS 订阅');
    }

    // 注入 Polymarket WS 客户端给交易执行器（仅主市场 WS，体育仍走 REST）
    taskExecutor.setPolymarketWsClient(getPolymarketWsClient());

    // 启动时取消所有活跃任务和 Predict 挂单（需要 Predict WS 已连接以接收取消确认）
    await taskExecutor.cancelAllTasksOnStartup();

    // 启动清理完成后再开启全局敞口监控，避免重启恢复阶段对历史活跃任务发出误报
    exposureMonitor.start();

    // 启动 HTTP 服务器 (固定端口,自动清理占用进程)
    const targetPort = Number(PORT);

    // 前置检查：如果端口被占用，先清理
    killProcessOnPort(targetPort);
    await new Promise(r => setTimeout(r, 500)); // 等待端口释放

    const server = createServer(handleRequest);
    httpServer = server;
    await new Promise<void>((resolve, reject) => {
        server.once('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`\n❌ 端口 ${targetPort} 仍被占用，启动失败`);
                console.error(`   请手动运行: taskkill /F /PID <PID>\n`);
            }
            reject(err);
        });
        // 监听所有接口 (0.0.0.0)，允许局域网访问
        server.listen(targetPort, '0.0.0.0', () => resolve());
    });

    // 获取局域网 IP (ESM 环境不可用 require，使用 dynamic import)
    const getLocalIP = async (): Promise<string> => {
        try {
            const { networkInterfaces } = await import('os');
            const nets = networkInterfaces();
            for (const name of Object.keys(nets)) {
                for (const net of nets[name] || []) {
                    if (net.family === 'IPv4' && !net.internal) {
                        return net.address;
                    }
                }
            }
            return 'localhost';
        } catch {
            return 'localhost';
        }
    };
    const localIP = await getLocalIP();

    console.log(`📊 Dashboard 运行在 http://localhost:${targetPort}`);
    console.log(`🌐 局域网访问: http://${localIP}:${targetPort}\n`);
    console.log(`📡 SSE 端点: http://localhost:${targetPort}/api/stream`);
    console.log(`📋 数据端点: http://localhost:${targetPort}/api/data\n`);

    // ========================================================================
    // 任务 API 独立端口（隔离 SSE 流量，防止 SSH 隧道拥塞阻塞任务请求）
    // ========================================================================
    const taskApiPort = targetPort + 1;
    killProcessOnPort(taskApiPort);

    const taskApiServer = createServer(async (req, res) => {
        const url = req.url || '/';
        // 仅处理任务相关 API 和 CORS preflight
        if (url.startsWith('/api/tasks') || url.startsWith('/api/pp-farmer') || url.startsWith('/api/pp-archive') || req.method === 'OPTIONS') {
            return handleRequest(req, res);
        }
        res.writeHead(404);
        res.end('Not Found');
    });

    taskApiServer.listen(taskApiPort, '0.0.0.0', () => {
        console.log(`🚀 任务 API 独立端口: http://localhost:${taskApiPort} (隔离 SSE 流量)`);
    });

    // 事件循环延迟监控：检测 >500ms 的阻塞
    let lastLoopCheck = Date.now();
    setInterval(() => {
        const now = Date.now();
        const delay = now - lastLoopCheck - 1000; // 减去预期间隔
        lastLoopCheck = now;
        if (delay > 500) {
            console.warn(`[EventLoop] ⚠️ blocked ${delay}ms`);
        }
    }, 1000).unref();

    // 首次扫描 (并行执行: Live 套利 + 体育市场 + 账户数据预加载)
    console.log(`🚀 并行扫描: Live 套利${sportsService ? '、体育市场' : ''}、账户数据...`);
    const startScanTime = Date.now();

    // 带超时的包装函数
    const withTimeout = <T>(promise: Promise<T>, ms: number, name: string): Promise<T> =>
        Promise.race([
            promise,
            new Promise<T>((_, reject) =>
                setTimeout(() => reject(new Error(`${name} 超时 (${ms / 1000}s)`)), ms)
            )
        ]);

    const scanTasks: Promise<void>[] = [];

    // 1. Live 套利扫描 (仅当 All 市场启用时)
    if (allMarketsEnabled) {
        scanTasks.push(
            withTimeout(detectArbitrageOpportunities(), 60000, 'Live套利扫描')
                .then(() => console.log('  ✓ Live 套利扫描完成'))
                .catch(err => console.warn('  ✗ Live 套利扫描失败:', err.message)),
        );
    } else {
        console.log('  ⏸️  All 市场已禁用，跳过 Live 套利扫描');
    }

    // 2. 账户数据预加载 (始终执行)
    scanTasks.push(
        withTimeout(getAccountData(), 10000, '账户数据')
            .then(() => console.log('  ✓ 账户数据预加载完成'))
            .catch(err => console.warn('  ✗ 账户数据预加载失败:', err.message)),
    );

    // 3. 体育市场扫描 (仅当启用时)
    if (sportsService) {
        scanTasks.push(
            withTimeout(sportsService.scan(), 60000, '体育市场扫描')
                .then(() => console.log(`  ✓ 体育市场扫描完成 (${sportsService!.getMarkets().length} 场比赛)`))
                .catch(err => console.warn('  ✗ 体育市场扫描失败:', err.message))
        );
    }

    await Promise.all(scanTasks);
    console.log(`✅ 并行扫描完成，耗时 ${((Date.now() - startScanTime) / 1000).toFixed(1)}s\n`);

    // Boost data fetch (扫描完成后执行，确保市场 ID 已加载)
    await withTimeout(fetchBoostData(), 60000, 'BoostData')
        .then(() => console.log(`  ✓ Boost data fetched (${getBoostCache().size} boosted markets)`))
        .catch(err => console.warn('  ✗ Boost data fetch failed:', err.message));

    // PP 奖励档位数据 (graphql.predict.fun, 全量未结算市场)
    // 若 allMarkets 启动前已拉过，跳过；否则首拉一次
    if (getRewardCacheStats().size === 0) {
        await withTimeout(fetchRewardData(), 60000, 'RewardData')
            .then(() => console.log(`  ✓ Reward data fetched (${getRewardCacheStats().size} markets with rewards)`))
            .catch(err => console.warn('  ✗ Reward data fetch failed:', err.message));
    }

    // 体育市场订单簿补订阅 (scan 完成后才有 marketId/tokenId)
    if (sportsService) {
        // 1. Predict 订单簿补订阅
        if (usePredictWsMode) {
            const sportsMarketIds = sportsService.getMarkets().map(m => m.predictMarketId).filter(Boolean);
            const liveOnlySportsIds = sportsService.getLiveOnlySportsMarketIds();  // 多选事件 (非对阵)
            const allSportsMarketIds = [...sportsMarketIds, ...liveOnlySportsIds];

            if (allSportsMarketIds.length > 0) {
                const unifiedCache = getPredictOrderbookCache();
                if (unifiedCache) {
                    await unifiedCache.subscribeMarkets(allSportsMarketIds);
                    console.log(`✅ 体育市场 Predict 订单簿已补订阅: ${sportsMarketIds.length} 个体育面板市场 + ${liveOnlySportsIds.length} 个多选事件市场`);

                    // REST 预热：Predict WS 无初始快照，订阅后用 REST 填充缓存
                    console.log(`🔥 正在预热体育市场订单簿 (${allSportsMarketIds.length} 个)...`);
                    const warmStart = Date.now();
                    const WARM_BATCH = 10;
                    const WARM_DELAY = 200;
                    let warmed = 0;
                    for (let i = 0; i < allSportsMarketIds.length; i += WARM_BATCH) {
                        const batch = allSportsMarketIds.slice(i, i + WARM_BATCH);
                        await Promise.all(batch.map(async (id) => {
                            try {
                                const book = await unifiedCache.getOrderbook(id);
                                if (book) warmed++;
                            } catch { /* 静默 */ }
                        }));
                        if (i + WARM_BATCH < allSportsMarketIds.length) {
                            await new Promise(r => setTimeout(r, WARM_DELAY));
                        }
                    }
                    console.log(`✅ 体育市场预热完成: ${warmed}/${allSportsMarketIds.length}，耗时 ${Date.now() - warmStart}ms`);
                }
            }
        }

        // 体育市场 Polymarket 使用 REST API，无需 WS 订阅
        console.log('');  // 空行分隔
    }

    // 自动赎回服务 (每 10 分钟扫描已结算持仓并赎回)
    startAutoRedeem();

    // 主轮询 (LIVE 标签页套利机会)
    console.log(`⏱️  主轮询间隔: ${POLL_INTERVAL_MS / 1000} 秒\n`);

    // 带超时保护的轮询 (防止卡死)
    const POLL_TIMEOUT_MS = 60000; // 60秒轮询超时
    let lastPollStart = 0;
    mainPollInterval = setInterval(async () => {
        if (shutdownRequested) return;
        if (!allMarketsEnabled) return;  // All 市场关闭时跳过轮询
        // 超时保护：如果上一轮超过60秒未完成，强制重置状态
        if (scanInProgress && lastPollStart > 0 && Date.now() - lastPollStart > POLL_TIMEOUT_MS) {
            console.warn(`[超时保护] 轮询超时 ${Math.round((Date.now() - lastPollStart) / 1000)}s，强制重置状态`);
            scanInProgress = false;
        }

        if (!scanInProgress) {
            lastPollStart = Date.now();
            await detectArbitrageOpportunities();
        }
    }, POLL_INTERVAL_MS);

    // 定时强制 REST 全量重扫（覆盖 WS 长时间无推送的长尾市场）
    setInterval(() => {
        if (shutdownRequested) return;
        if (!allMarketsEnabled) return;
        if (forceFullScan) return;  // 已在排队中
        forceFullScan = true;
        console.log(`[扫描] 已请求定时 REST 全量重扫（间隔 ${FULL_RESCAN_INTERVAL_MS / 60000} 分钟）`);
    }, FULL_RESCAN_INTERVAL_MS);

    // 注入 Predict 订单簿缓存提供者（任务执行时复用缓存，减少 API 调用）
    // Boost data refresh (5 minutes)
    boostRefreshInterval = setInterval(async () => {
        if (shutdownRequested) return;
        await fetchBoostData();
    }, BOOST_REFRESH_INTERVAL_MS);

    // PP 奖励档位刷新 (每小时一次，单次 ~3-5s)
    // 增量补订阅：新出现 reward 的市场加进 WS（失去 reward 的市场保留订阅，避免抖动）
    setInterval(async () => {
        if (shutdownRequested) return;
        const newlyRewarded = await fetchRewardData();
        if (!allMarketsEnabled || newlyRewarded.size === 0) return;
        const pairIds = new Set(marketPairs.map(p => p.predictId));
        const toSubscribe = [...newlyRewarded].filter(id => pairIds.has(id));
        if (toSubscribe.length === 0) return;
        const cache = getPredictOrderbookCache();
        if (!cache) return;
        try {
            await cache.subscribeMarkets(toSubscribe);
            console.log(`[Rewards] 增量补订阅 ${toSubscribe.length} 个新出现 reward 的主市场`);
        } catch (err: any) {
            console.warn(`[Rewards] 增量补订阅失败: ${err?.message || err}`);
        }
    }, 3600_000);

    setPredictOrderbookCacheProvider(getPredictOrderbookFromCache);  // PredictTrader 用
    setPredictOrderbookRestFallbackEnabled(!usePredictWsMode);
    setClosePredictOrderbookProvider(getPredictOrderbookForCloseService);  // hedge-mode 用
    setPredictApiKeyProvider(() => scanApiKeys.getNextKey());  // hedge-mode REST fallback 用
    console.log('[Cache] Predict 订单簿缓存提供者已注入 (PredictTrader + hedge-mode)');

    // 体育市场订单簿刷新 (仅当启用时)
    // Predict: 定时 500ms 轮询
    // Polymarket: WS 事件驱动 (有更新即 rebuild)，REST 作为断连回退
    if (sportsService) {
        const PREDICT_REFRESH_MS = 500;
        const POLY_REST_FALLBACK_MS = 100;  // 内部有节流: WS 连接时 1s, 断连时 100ms

        predictRefreshInterval = setInterval(async () => {
            if (shutdownRequested) return;
            try {
                await sportsService!.refreshPredictOrderbooks();
            } catch (error: any) {
                // 静默
            }
        }, PREDICT_REFRESH_MS);

        // Poly WS 事件驱动: rebuild 后触发 SSE 广播
        sportsService.setPolyWsRebuildCallback(() => {
            if (shutdownRequested) return;
            scheduleSportsRecompute();
        });

        // Poly REST 回退: WS 断连时自动接管 (函数内部根据 WS 状态节流)
        polyRefreshInterval = setInterval(async () => {
            if (shutdownRequested) return;
            try {
                await sportsService!.refreshPolymarketOrderbooks();
            } catch (error: any) {
                // 静默
            }
        }, POLY_REST_FALLBACK_MS);
    }

    // ========================================================================
    // 持仓市场 WS 订阅同步 (确保 hedge-mode 能获取持仓市场的订单簿)
    // ========================================================================
    {
        const POSITION_MARKETS_SYNC_MS = 30000;  // 30秒同步一次（与 hedge 重算周期对齐）
        let positionMarketsSyncInFlight = false;

        const syncPositionMarketsToWs = async () => {
            if (shutdownRequested || positionMarketsSyncInFlight) return;
            positionMarketsSyncInFlight = true;

            try {
                const { predictMarketIds, polymarketTokenIds } = await getPositionMarketIds();

                // 订阅 Predict 持仓市场
                if (predictMarketIds.length > 0 && usePredictWsMode) {
                    const unifiedCache = getPredictOrderbookCache();
                    if (unifiedCache) {
                        await unifiedCache.subscribeMarkets(predictMarketIds);
                    }
                }

                // 订阅 Polymarket 持仓市场
                if (polymarketTokenIds.length > 0 && polymarketWsClient && polymarketWsClient.isConnected()) {
                    polymarketWsClient.subscribe(polymarketTokenIds);
                }

                if (predictMarketIds.length > 0 || polymarketTokenIds.length > 0) {
                    console.log(`[持仓WS订阅] Predict: ${predictMarketIds.length} 市场, Polymarket: ${polymarketTokenIds.length} tokens`);
                }
            } catch (error: any) {
                // 静默失败
            } finally {
                positionMarketsSyncInFlight = false;
            }
        };

        // 首次同步 (延迟 5 秒等待持仓缓存加载)
        setTimeout(syncPositionMarketsToWs, 5000);

        // 定期同步 (清理在 gracefulShutdown 中通过 shutdownRequested 标志自动停止)
        setInterval(syncPositionMarketsToWs, POSITION_MARKETS_SYNC_MS);
    }

    // ========================================================================
    // 定期清理已结算市场对 (每2小时，移除 endDate 过期的市场)
    // ========================================================================
    const MARKET_PRUNE_INTERVAL_MS = 2 * 60 * 60 * 1000;  // 2 小时
    const pruneSettledMarkets = () => {
        if (shutdownRequested) return;
        const before = marketPairs.length;
        // 从后往前遍历，安全删除 endDate 已过期的市场
        for (let i = marketPairs.length - 1; i >= 0; i--) {
            const p = marketPairs[i];
            if (p.endDate && !isEndDateValid(p.endDate)) {
                marketPairs.splice(i, 1);
                activeMarketIds.delete(p.predictId);
                // 清理所有相关机会缓存（key 格式: {marketId}-{side}-{strategy}）
                for (const side of ['YES', 'NO'] as const) {
                    for (const strategy of ['PREDICT_MAKER', 'TAKER'] as const) {
                        const cacheKey = makeOpportunityKey(p.predictId, side, strategy);
                        opportunityCache.delete(cacheKey);
                        knownOpportunityIds.delete(cacheKey);
                    }
                }
            }
        }
        const removed = before - marketPairs.length;
        if (removed > 0) {
            console.log(`[清理] 移除 ${removed} 个已结算市场对，剩余 ${marketPairs.length} 个`);
            dashboardData.stats.marketsMonitored = marketPairs.length;
        }
    };
    // 延迟首次执行（等待 endDate 映射完成）
    setTimeout(pruneSettledMarkets, 30 * 60 * 1000);  // 30 分钟后首次执行
    setInterval(pruneSettledMarkets, MARKET_PRUNE_INTERVAL_MS);

    // ========================================================================
    // 串行调度器 (防止 async setInterval 重入堆积)
    // ========================================================================
    interface SerialSchedulerOptions {
        warnThresholdMs?: number;    // 耗时警告阈值，默认 intervalMs * 2
        runImmediately?: boolean;    // 是否立即执行首次，默认 false
        errorLogIntervalMs?: number; // 错误日志限频间隔，默认 30000ms
    }

    function createSerialScheduler(
        name: string,
        intervalMs: number,
        task: () => Promise<void>,
        options: SerialSchedulerOptions = {}
    ): () => void {
        const {
            warnThresholdMs = intervalMs * 2,
            runImmediately = false,
            errorLogIntervalMs = 30000,  // 默认 30s 限频
        } = options;
        let inFlight = false;
        let lastErrorLogTime = 0;
        let errorCount = 0;
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const scheduleNext = () => {
            if (stopped || shutdownRequested) return;
            timer = setTimeout(run, intervalMs);
        };

        const run = async () => {
            if (stopped || shutdownRequested) return;
            if (inFlight) {
                console.warn(`[${name}] 跳过：上一轮未完成`);
                scheduleNext();
                return;
            }

            inFlight = true;
            const startTime = Date.now();

            try {
                await task();
                // 成功后重置错误计数
                if (errorCount > 0) {
                    console.log(`[${name}] 恢复正常 (之前连续 ${errorCount} 次失败)`);
                    errorCount = 0;
                }
            } catch (error: any) {
                errorCount++;
                // 限频错误日志：避免刷屏，但不完全静默
                const now = Date.now();
                if (now - lastErrorLogTime >= errorLogIntervalMs) {
                    const errorMsg = error.message || String(error);
                    const errorStack = error.stack ? `\n${error.stack}` : '';
                    console.error(`[${name}] 任务失败 (连续 ${errorCount} 次): ${errorMsg}${errorStack}`);
                    lastErrorLogTime = now;
                }
            } finally {
                const elapsed = Date.now() - startTime;
                if (elapsed > warnThresholdMs) {
                    console.warn(`[${name}] 耗时过长: ${elapsed}ms (阈值 ${warnThresholdMs}ms)`);
                }
                inFlight = false;
                scheduleNext();
            }
        };

        // 启动调度：runImmediately=true 时立即执行首次，减少"刚开面板没数据"的窗口
        if (runImmediately) {
            run();  // 立即执行
        } else {
            scheduleNext();
        }

        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
        };
    }

    // ========================================================================
    // 体育市场 SSE 广播 (仅当启用时) - 使用统一节流广播
    // ========================================================================
    if (sportsService) {
        const SPORTS_BROADCAST_MS = 500;
        serialSchedulerStops.push(createSerialScheduler('SportsBroadcast', SPORTS_BROADCAST_MS, async () => {
            const sportsData = JSON.stringify(sportsService!.getSSEDataIncremental());
            markDirty('sports', sportsData);
        }, { warnThresholdMs: SPORTS_BROADCAST_MS * 5, runImmediately: true }));
    }

    if (sportsService) {
        // 两层探测：
        //   - SportsActiveTaskProbe (30s):    只查有活跃 sports task 的 conditionId，紧盯实际敞口
        //   - SportsNearStartRefresh (5min):  按窗口扫描兜底，覆盖刚要开赛但任务还没建的市场
        const SPORTS_ACTIVE_PROBE_MS = 30 * 1000;
        const SPORTS_NEAR_START_REFRESH_MS = 5 * 60 * 1000;
        const SPORTS_NEAR_START_WINDOW_MS = 3 * 60 * 60 * 1000;
        const formatSportsTime = (value?: string) => {
            if (!value) return 'unknown';
            const ms = Date.parse(value);
            if (!Number.isFinite(ms)) return value;
            return new Date(ms).toLocaleString('zh-CN');
        };

        type ProbeResult = Awaited<ReturnType<NonNullable<typeof sportsService>['probeNearStartMetadata']>>;

        async function handleProbeResult(result: ProbeResult, source: 'SportsActiveTaskProbe' | 'SportsNearStartRefresh') {
            if (result.updates.length === 0) {
                return;
            }

            const allActiveSportsTasks = taskService.getTasks({}).filter(task => task.isSportsMarket);
            const activeTasksByConditionId = new Map<string, Task[]>();
            for (const task of allActiveSportsTasks) {
                const list = activeTasksByConditionId.get(task.polymarketConditionId) || [];
                list.push(task);
                activeTasksByConditionId.set(task.polymarketConditionId, list);
            }

            for (const change of result.changes) {
                const affectedTasks = activeTasksByConditionId.get(change.conditionId) || [];
                if (affectedTasks.length === 0) {
                    continue;
                }

                const reason = change.nextLive
                    ? `体育赛事已进入 LIVE，自动取消任务（比赛: ${change.title}，原开赛: ${formatSportsTime(change.previousGameStartTime)}，最新开赛: ${formatSportsTime(change.nextGameStartTime)}）`
                    : `体育比赛时间变更，自动取消任务（比赛: ${change.title}，原开赛: ${formatSportsTime(change.previousGameStartTime)} → 最新开赛: ${formatSportsTime(change.nextGameStartTime)}）`;
                const cancelReason = change.nextLive ? 'SPORTS_EVENT_LIVE' : 'SPORTS_START_TIME_CHANGED';

                console.warn(`[${source}] conditionId=${change.conditionId} tasks=${affectedTasks.length} reason=${reason}`);

                for (const task of affectedTasks) {
                    try {
                        await taskExecutor.cancelTask(task.id, {
                            reason,
                            cancelReason,
                        });
                    } catch (error: any) {
                        console.warn(`[${source}] cancel task failed: task=${task.id}, error=${error?.message || error}`);
                    }
                }

                const tg = getTelegramNotifier();
                if (tg) {
                    const lines = [
                        `🚨 <b>体育任务批量撤单</b>`,
                        ``,
                        `<b>比赛:</b> ${change.title}`,
                        `<b>任务数:</b> ${affectedTasks.length}`,
                        `<b>原因:</b> ${reason}`,
                        `<b>任务:</b>`,
                        ...affectedTasks.slice(0, 10).map(task => `• <code>${task.id}</code>`),
                    ];
                    if (affectedTasks.length > 10) {
                        lines.push(`• 其余 ${affectedTasks.length - 10} 个任务已撤单`);
                    }
                    tg.sendText(lines.join('\n')).catch((error: any) => {
                        console.warn(`[${source}] summary TG failed: ${error?.message || error}`);
                    });
                }
            }

            sportsService!.applyNearStartMetadataUpdates(result.updates);
        }

        // 高频层：仅 active sports task 的 conditionId (30s 一次)
        let activeTaskProbeTickCount = 0;
        serialSchedulerStops.push(createSerialScheduler('SportsActiveTaskProbe', SPORTS_ACTIVE_PROBE_MS, async () => {
            const activeSportsTasks = taskService.getTasks({}).filter(task => task.isSportsMarket);
            const filter = new Set<string>();
            for (const task of activeSportsTasks) {
                if (task.polymarketConditionId) filter.add(task.polymarketConditionId);
            }
            activeTaskProbeTickCount++;
            // 空 filter 直接跳过，不发请求 (但仍打 tick 日志便于诊断 scheduler 活性)
            if (filter.size === 0) {
                if (activeTaskProbeTickCount % 10 === 1) {
                    console.log(`[SportsActiveTaskProbe] tick #${activeTaskProbeTickCount}: no active sports tasks, skipping`);
                }
                return;
            }
            const result = await sportsService!.probeNearStartMetadata(SPORTS_NEAR_START_WINDOW_MS, filter);
            console.log(`[SportsActiveTaskProbe] tick #${activeTaskProbeTickCount}: probed ${filter.size} conditions, updates=${result.updates.length}, changes=${result.changes.length}`);
            await handleProbeResult(result, 'SportsActiveTaskProbe');
        }, { warnThresholdMs: SPORTS_ACTIVE_PROBE_MS * 0.5, runImmediately: true }));

        // 低频层：按窗口扫所有未来 3h 内市场，兜底新建任务前的赛前检测 (5min 一次)
        serialSchedulerStops.push(createSerialScheduler('SportsNearStartRefresh', SPORTS_NEAR_START_REFRESH_MS, async () => {
            const result = await sportsService!.probeNearStartMetadata(SPORTS_NEAR_START_WINDOW_MS);
            await handleProbeResult(result, 'SportsNearStartRefresh');
        }, { warnThresholdMs: SPORTS_NEAR_START_REFRESH_MS * 0.5, runImmediately: true }));
    }

    // Sports incremental scan (3 hours — 重新获取新的 72h 窗口内比赛)
    if (sportsService) {
        const SPORTS_INCREMENTAL_SCAN_MS = 3 * 60 * 60 * 1000;
        serialSchedulerStops.push(createSerialScheduler('SportsIncrementalScan', SPORTS_INCREMENTAL_SCAN_MS, async () => {
            await sportsService!.scanIncremental();
        }, { warnThresholdMs: SPORTS_INCREMENTAL_SCAN_MS * 0.5, runImmediately: false }));
    }

    // ========================================================================
    // Predict WS 健康日志 (30秒，WS 模式下输出统计)
    // ========================================================================
    if (usePredictWsMode) {
        const WS_HEALTH_LOG_MS = 30000;
        serialSchedulerStops.push(createSerialScheduler('PredictWsHealth', WS_HEALTH_LOG_MS, async () => {
            const cache = getPredictOrderbookCache();
            if (cache) {
                const stats = cache.getStats();
                console.log(`[PredictWS] 健康: connected=${stats.wsConnected}, subscriptions=${stats.wsSubscriptions}, cache=${stats.cacheSize}, wsUpdates=${stats.wsUpdates}, restFetches=${stats.restFetches}`);
            }
        }, { runImmediately: false }));
    }

    if (DASHBOARD_PREDICT_ORDERBOOK_MODE === 'ws' || POLY_ORDERBOOK_SOURCE !== 'rest') {
        serialSchedulerStops.push(createSerialScheduler('WsHealthMonitor', WS_HEALTH_CHECK_MS, handleWsHealthCheck, {
            warnThresholdMs: WS_HEALTH_CHECK_MS * 3,
            runImmediately: true,
        }));
    }

    // ========================================================================
    // 账户数据 SSE 广播 (5秒，串行调度，立即首发) - 使用统一节流广播
    // ========================================================================
    const ACCOUNT_BROADCAST_MS = 5000;
    serialSchedulerStops.push(createSerialScheduler('AccountBroadcast', ACCOUNT_BROADCAST_MS, async () => {
        const accountsData = JSON.stringify(await getAccountData());
        markDirty('accounts', accountsData);

        // All 市场扫描未启用时，延迟指标不会被主扫描循环更新，在此补充
        if (!allMarketsEnabled) {
            const pRestLat = getPredictOrderbookCache()?.getRestLatency();
            const pmRestLat = getPolymarketApiLatency();
            if (pRestLat) dashboardData.stats.latency.predict = pRestLat;
            if (pmRestLat) dashboardData.stats.latency.polymarket = pmRestLat;
            dashboardData.stats.connectionStatus.polymarketWs = getPolymarketWsStatus();
            dashboardData.stats.connectionStatus.predictWs = getPredictOrderbookCache()?.isWsConnected() ? 'connected' : 'disconnected';
            dashboardData.stats.connectionStatus.bscWss = (() => { try { return getBscOrderWatcher().isConnected() ? 'connected' : 'disconnected'; } catch { return 'disconnected' as const; } })();
            const statsData = JSON.stringify(dashboardData.stats);
            markDirty('stats', statsData);
        }
    }, { warnThresholdMs: ACCOUNT_BROADCAST_MS * 2, runImmediately: true }));

    // ========================================================================
    // 平仓机会 SSE 广播 (30 秒，串行调度，立即首发) - 使用统一节流广播
    // 注意：calculateCloseOpportunities 需要多次 API 调用；
    // 平仓机会无套利窗口竞速性，30 秒重算一次足够，避免对 GraphQL/CLOB 持续打压。
    // ========================================================================
    const HEDGE_BROADCAST_MS = Number(process.env.HEDGE_BROADCAST_MS || 30000);
    {
        const subscribedCloseTokenIds = new Set<string>();  // 已订阅的平仓 tokenIds
        serialSchedulerStops.push(createSerialScheduler('HedgeBroadcast', HEDGE_BROADCAST_MS, async () => {
            try {
                cachedCloseOpportunities = await calculateCloseOpportunities();
                lastCloseOpportunitiesUpdate = Date.now();
                markDirty('closeOpportunities', JSON.stringify(cachedCloseOpportunities));

                // 订阅平仓 tokenIds 到 WS（确保实时数据）
                if (polymarketWsClient && cachedCloseOpportunities.length > 0) {
                    const newTokenIds: string[] = [];
                    for (const opp of cachedCloseOpportunities) {
                        // 订阅 YES 和 NO tokenId（平仓需要卖出，需要看 bids）
                        if (opp.polymarketYesTokenId && !subscribedCloseTokenIds.has(opp.polymarketYesTokenId)) {
                            newTokenIds.push(opp.polymarketYesTokenId);
                            subscribedCloseTokenIds.add(opp.polymarketYesTokenId);
                        }
                        if (opp.polymarketNoTokenId && !subscribedCloseTokenIds.has(opp.polymarketNoTokenId)) {
                            newTokenIds.push(opp.polymarketNoTokenId);
                            subscribedCloseTokenIds.add(opp.polymarketNoTokenId);
                        }
                    }
                    if (newTokenIds.length > 0) {
                        polymarketWsClient.subscribe(newTokenIds);
                        console.log(`[HedgeService] 订阅 ${newTokenIds.length} 个平仓 tokenIds 到 WS`);
                    }
                }
            } catch (error) {
                console.warn('[HedgeService] 计算平仓机会失败:', error);
            }
        }, { warnThresholdMs: HEDGE_BROADCAST_MS * 3, runImmediately: true }));
    }

    if (sportsService) {
        console.log(`⏱️  体育市场刷新: Polymarket WS 事件驱动(100ms节流) + REST回退, Predict 500ms, SSE广播 500ms`);
        console.log(`⏱️  体育近期开赛元数据刷新: 60s（仅检查 1 小时内开赛比赛的时间与 LIVE 状态）`);
    }
    console.log(`⏱️  账户数据 SSE 广播: ${ACCOUNT_BROADCAST_MS}ms`);
    console.log(`⏱️  平仓机会 SSE 广播: ${HEDGE_BROADCAST_MS}ms`);
    console.log(`✅ SSE 广播使用统一节流调度器 (${BROADCAST_THROTTLE_MS}ms) + 背压处理\n`);
}

/**
 * 设置优雅关闭处理程序
 * 在 SIGINT (Ctrl+C) 或 SIGTERM 时暂停所有任务
 */
function setupGracefulShutdown(): void {
    let isShuttingDown = false;
    const SHUTDOWN_TIMEOUT_MS = 60000;  // 60 秒整体超时（可能需要取消挂单）

    const gracefulShutdown = async (signal: string) => {
        if (isShuttingDown) {
            console.log('\n⚠️  已在关闭中，请稍候...');
            return;
        }
        isShuttingDown = true;
        shutdownRequested = true;

        console.log(`\n🛑 收到 ${signal} 信号，开始优雅关闭...`);
        console.log(`[Shutdown] 当前时间: ${new Date().toISOString()}`);

        // 保持事件循环活跃，避免异步关停链条中途“自然退出”
        const keepAlive = setInterval(() => { /* noop */ }, 250);

        // 设置整体超时保护
        const forceExitTimeout = setTimeout(() => {
            console.error(`\n⚠️  关闭超时 (${SHUTDOWN_TIMEOUT_MS / 1000}s)，强制退出...`);
            clearInterval(keepAlive);
            process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS);

        try {
            // 1) 停止后台定时器，避免关停期间继续触发扫描/刷新/广播
            console.log('[Shutdown] 停止轮询/刷新/广播定时器...');
            if (mainPollInterval) clearInterval(mainPollInterval);
            if (predictRefreshInterval) clearInterval(predictRefreshInterval);
            if (polyRefreshInterval) clearInterval(polyRefreshInterval);
            if (boostRefreshInterval) clearInterval(boostRefreshInterval);
            mainPollInterval = null;
            predictRefreshInterval = null;
            polyRefreshInterval = null;
            boostRefreshInterval = null;
            if (wsDisconnectTimer) clearTimeout(wsDisconnectTimer);
            if (wsResumeTimer) clearTimeout(wsResumeTimer);
            wsDisconnectTimer = null;
            wsResumeTimer = null;
            wsPausedTaskIds.clear();
            wsPauseActive = false;
            wsPauseInProgress = false;
            lastWsHealthy = null;

            for (const stop of serialSchedulerStops.splice(0)) {
                try { stop(); } catch { /* ignore */ }
            }

            // 1.1) 停止余额守卫
            try { balanceGuard?.stop(); } catch { /* ignore */ }

            // 1.2) 停止 Auto-Boost 轮询 (两个 runner)
            try { ppFarmerAllRunner.shutdown(); } catch { /* ignore */ }
            try { ppFarmerSportsRunner.shutdown(); } catch { /* ignore */ }

            // 2) 关闭 SSE 客户端，避免 server.close 被长连接阻塞
            for (const client of sseClients.keys()) {
                try { client.end(); } catch { /* ignore */ }
            }
            sseClients.clear();

            // 3) 停止接受新请求
            if (httpServer) {
                console.log('[Shutdown] 关闭 HTTP 服务器...');
                await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
                httpServer = null;
            }

            // 4) 断开 WS（防止重连/后台心跳保活）
            if (polymarketWsClient) {
                try {
                    polymarketWsClient.disconnect({ clearListeners: true });
                } catch { /* ignore */ }
                polymarketWsClient = null;
            }

            // 4.1) 停止 WS 订单通知服务
            try {
                stopWsOrderNotifier();
            } catch { /* ignore */ }

            // 4.1.1) 停止 Polymarket User WS (订单状态监听)
            try {
                destroyPolymarketUserWsClient();
            } catch { /* ignore */ }

            // 4.2) 停止 BSC 通知/服务（避免后台重连/心跳保活）
            try { stopBscOrderNotifier(); } catch { /* ignore */ }
            try { stopBscOrderWatcher(); } catch { /* ignore */ }
            try { stopPredictOrderWatcher(); } catch { /* ignore */ }
            try { stopTokenMarketCache(); } catch { /* ignore */ }

            // 4.3) 停止 Predict 订单簿 WS 缓存
            try { stopPredictOrderbookCache(); } catch { /* ignore */ }

            // 4.5) 停止自动赎回服务
            try { stopAutoRedeem(); } catch { /* ignore */ }

            // 5) 暂停所有运行中的任务并取消挂单（确保取消请求已发送/超时返回）
            console.log('[Shutdown] 开始暂停任务并取消挂单...');
            await taskExecutor.shutdown({ concurrency: 4, timeoutMs: SHUTDOWN_TIMEOUT_MS - 5000 });
            console.log('[Shutdown] taskExecutor.shutdown() 完成');

            // 6) 刷新并关闭 TaskLogger，确保关停期间的取消/暂停日志落盘
            try {
                await getTaskLogger().close();
            } catch { /* ignore */ }

            // 7) 给 stdout 刷新一个短窗口
            await new Promise(resolve => setTimeout(resolve, 200));

            clearTimeout(forceExitTimeout);
            clearInterval(keepAlive);
            console.log('✅ Dashboard 已安全关闭');

            // 不要用 process.exit() 立即硬退出，否则可能中断尚未完全刷新的 I/O。
            // 让 Node 自然退出：清理所有 handle 后事件循环会自动结束。
            process.exitCode = 0;
            return;
        } catch (error: any) {
            clearTimeout(forceExitTimeout);
            clearInterval(keepAlive);
            console.error('\n❌ 关闭过程出错:', error.message);
            process.exitCode = 1;
            return;
        }
    };

    // Windows 上 SIGTERM 可能不可用，主要依赖 SIGINT (Ctrl+C)
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // Windows 特殊处理
    if (process.platform === 'win32') {
        // readline 接口用于捕获 Windows 上的 Ctrl+C
        import('readline').then(readline => {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            rl.on('SIGINT', () => process.emit('SIGINT' as any));
        }).catch(() => { /* ignore */ });
    }

    // ---- 崩溃防护: uncaughtException / unhandledRejection ----
    // 注意: uncaughtException 处理器不使用 async/await — 事件循环可能已损坏
    process.on('uncaughtException', (err) => {
        console.error(`\n🔥 uncaughtException: ${err.message}`);
        console.error(err.stack);

        // 如果已在优雅关闭流程中，直接退出避免冲突
        if (isShuttingDown) {
            console.error('[Emergency] 关闭期间崩溃，立即退出');
            process.exit(1);
        }

        // 强制退出定时器 (5s 后无论如何退出，防止进程挂起)
        setTimeout(() => {
            console.error('[Emergency] 强制退出');
            process.exit(1);
        }, 5000).unref();

        // fire-and-forget: 暂停所有任务 (触发取消挂单；若进程被拉起，启动清理会批量取消任务与关联订单)
        taskExecutor.pauseTasks('uncaughtException 崩溃', { concurrency: 8, timeoutMs: 4000 })
            .catch(e => console.error(`[Emergency] 暂停任务异常: ${e?.message}`));

        // fire-and-forget: TG 置顶告警
        try {
            const tg = getTelegramNotifier();
            if (tg) {
                tg.sendAndPin(`🔥 Dashboard 崩溃!\n\nuncaughtException: ${err.message}\n\n已尝试暂停所有任务并撤单，PM2 将自动重启`)
                    .catch(() => { /* ignore */ });
            }
        } catch { /* ignore */ }
    });

    process.on('unhandledRejection', (reason: any) => {
        console.error(`\n⚠️ unhandledRejection:`, reason instanceof Error ? reason.message : reason);
        if (reason instanceof Error && reason.stack) {
            console.error(reason.stack);
        }
        // 不退出进程，仅记录
    });

    console.log('📌 已注册优雅关闭处理 (Ctrl+C 暂停所有任务)\n');
}

main().catch(console.error);
