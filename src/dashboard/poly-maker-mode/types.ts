/**
 * Poly Maker Mode 类型定义
 *
 * Poly Maker 模式核心区别：
 * - 挂单平台: Polymarket GTC (被动 Maker) vs 现有的 Predict LIMIT
 * - 对冲平台: Predict LIMIT@Ask (模拟 Taker) vs 现有的 Polymarket IOC
 * - 成交监听: User WS OrderEvent + REST vs BSC WSS + Predict WS + REST
 * - 价格守护: 监控 Predict ask vs 监控 Polymarket ask
 */

import type { Task } from '../types.js';

// ============================================================================
// 执行上下文
// ============================================================================

export interface PolyMakerContext {
    task: Task;
    signal: AbortSignal;
    abortController: AbortController;

    // ====== Polymarket GTC 挂单追踪 ======
    currentPolyOrderId?: string;

    // ====== 成交追踪 (User WS + REST 双通道) ======
    /** User WS OrderEvent.size_matched (delta 模式累计) */
    wsFilledQty: number;
    /** REST getOrderStatus 累计 */
    restFilledQty: number;
    /** 有效成交量 = baseFilledQty + max(ws, rest)，跨订单单调递增 */
    totalPolyFilled: number;
    /** switchOrder 时快照的已成交基数，保证跨订单单调性 */
    baseFilledQty: number;

    // ====== 对冲追踪 (Predict 侧) ======
    /** 已在 Predict 对冲的实际到账量 (扣除 fee 后) */
    totalHedged: number;
    /** 对冲价格累计 (用于计算加权均价) */
    hedgePriceSum: number;

    // ====== 累计对冲 (Predict 最小订单 ~$0.9) ======
    /** 待对冲累计数量 */
    pendingHedgeQty: number;
    /** 最后一次对冲价格估算 */
    lastHedgePriceEstimate: number;

    // ====== 价格守护 ======
    priceGuardAbort?: AbortController;
    isPaused: boolean;
    pauseCount: number;
    pausedSince?: number;

    // ====== 深度监控 ======
    depthCheckPending?: boolean;
    isDepthAdjusting?: boolean;
    depthPausedChecks: number;

    // ====== 对冲互斥 ======
    isHedgingInProgress?: boolean;

    // ====== e2e 打点 ======
    /** 最近一次 fill / terminal 事件的本地接收时刻 (ms)，用于 e2e 延迟统计 */
    lastFillRecvTs?: number;

    // ====== WS 去重 (delta 模式) ======
    /** 已知最大 size_matched 值，delta = current - prev */
    lastKnownSizeMatched: number;

    // ====== 取消控制 ======
    /** 我们主动触发的 GTC 取消标记 (区分外部取消) */
    cancelledByUs?: boolean;

    // ====== 对冲聚合指标 ======
    /**
     * 对冲聚合指标（对齐 PREDICT_MAKER fastHedgeMetrics，并扩展 p95）
     * 首次对冲完成/失败时 lazy init
     */
    hedgeMetrics?: {
        /** 成功完成次数 (HEDGE_COMPLETED) */
        completedCount: number;
        /** 失败次数 (HEDGE_FAILED) */
        failedCount: number;
        /** 函数内部耗时累计 (ms) */
        totalElapsedMs: number;
        /** fill→确认 e2e 累计 (ms) */
        totalE2eMs: number;
        /** elapsedMs 样本数 */
        elapsedSamples: number;
        /** e2eMs 样本数 */
        e2eSamples: number;
        /** 总重试次数累计 */
        totalRetries: number;
        /** 保留最近 100 个 e2e 样本用于 p95 */
        e2eRing: number[];
    };
}

// ============================================================================
// 价格守护配置
// ============================================================================

export interface PredictPriceGuardConfig {
    /** Predict 市场 ID */
    predictMarketId: number;
    /** arbSide: 决定监控 YES ask 还是 NO ask */
    arbSide: 'YES' | 'NO';
    /** 最大可接受 Predict ask = (1 - polyBidPrice) + slippageTolerance */
    maxPredictAsk: number;
    /** 价格无效回调 */
    onPriceInvalid: (currentAsk: number) => void | Promise<void>;
    /** 价格恢复回调 */
    onPriceValid: (currentAsk: number) => void | Promise<void>;
    /** 所需数量 (用于深度判断, 可选) */
    requiredQty?: number;
    /** 动态所需数量（恢复/部分成交后优先使用） */
    getRequiredQty?: () => number;
    /** 深度不足回调 (可选) */
    onDepthInsufficient?: (availableDepth: number, requiredQty: number) => void | Promise<void>;
    /** 深度恢复回调 (可选) */
    onDepthRecovered?: (availableDepth: number) => void | Promise<void>;
    /** PAUSED 超时自动失败回调 (可选, pausedMinutes = 已暂停分钟数) */
    onAutoFail?: (pausedMinutes: number) => void | Promise<void>;
    /** 幽灵深度检测回调 (30s 内深度翻转 >= 6 次) */
    onDepthUnstable?: (flipCount: number) => void | Promise<void>;
}

export interface PredictPriceGuardState {
    isValid: boolean;
    currentAsk: number;
    maxAllowedAsk: number;
    availableDepth: number;
    timestamp: number;
}

// ============================================================================
// 成交监听事件
// ============================================================================

export interface PolyFillEvent {
    /** 本次增量 */
    delta: number;
    /** 累计成交量 */
    total: number;
    /** 来源 */
    source: 'WS' | 'REST';
    /** 时间戳 */
    timestamp: number;
}

export interface PolyOrderTerminalEvent {
    /** 终态类型 */
    type: 'MATCHED' | 'CANCELLED';
    /** 最终成交量 */
    filledQty: number;
    /** 是否由我们触发的取消 */
    cancelledByUs: boolean;
}

export interface PolyTradeFailedEvent {
    /** 关联的 maker orderId */
    orderId: string;
    /** 失败的 matched_amount */
    matchedAmount: string;
    /** taker_order_id (用于排查) */
    takerOrderId: string;
    /** 时间戳 */
    timestamp: number;
}

// ============================================================================
// 对冲结果
// ============================================================================

export interface PredictHedgeResult {
    success: boolean;
    /** 实际到账量 (扣除 fee) */
    actualReceived: number;
    /** 下单的 gross 数量 (含 fee 补偿) */
    grossQty: number;
    /** 成交均价 */
    avgPrice: number;
    /** 订单 hash */
    orderHash?: string;
    /** 错误信息 */
    error?: string;
}

// ============================================================================
// 依赖注入
// ============================================================================

export interface PolyMakerExecutorDeps {
    predictTrader: import('../predict-trader.js').PredictTrader;
    polyTrader: import('../polymarket-trader.js').PolymarketTrader;
    taskLogger: import('../task-logger/index.js').TaskLogger;
    updateTask: (taskId: string, updates: Partial<Task>) => void;
    getTask: (taskId: string) => Task | undefined;
    /** 体育 WS 订单簿提供者 (直接查缓存，无 REST fallback) */
    polyWsOrderbookProvider?: (tokenId: string) => { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null;
}
