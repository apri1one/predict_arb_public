/**
 * 任务日志系统 - 类型定义
 *
 * 功能：记录任务执行过程中的所有关键事件和订单簿快照
 * 版本：1.0.0
 */

import { TaskStatus } from '../types.js';

// ============================================================================
// 常量
// ============================================================================

/** 日志 Schema 版本 */
export const LOG_SCHEMA_VERSION = '1.0.0';

// ============================================================================
// 集中管理的枚举 (Single Source of Truth)
// ============================================================================

/**
 * 成本守护停止原因
 * 前端/日志消费方应对未知值做 fallback 处理
 */
export type CostGuardStopReason =
    | 'COST_EXCEEDED'      // 成本超限 (旧)
    | 'COST_INVALID'       // 成本失效 (新，事件驱动触发)
    | 'ORDER_FILLED'       // 订单全部成交
    | 'ORDER_CANCELLED'    // 订单被取消
    | 'TASK_COMPLETED';    // 任务正常完成

/**
 * 成本检查触发来源
 */
export type CostCheckTriggerSource =
    | 'WS_EVENT'           // WebSocket 订单簿更新事件
    | 'POLLING_FALLBACK';  // 轮询降级

/**
 * 任务取消原因
 * 前端/日志消费方应对未知值做 fallback 处理
 */
export type TaskCancelReason =
    | 'ORDER_TIMEOUT'      // 订单超时
    | 'COST_INVALID'       // 成本失效
    | 'USER_CANCELLED'     // 用户取消
    | 'BALANCE_GUARD'      // 余额守护批量取消
    | 'SPORTS_START_TIME_CHANGED' // 体育比赛时间变更
    | 'SPORTS_EVENT_LIVE'; // 体育赛事已进入 LIVE

/** 事件优先级 */
export type EventPriority = 'CRITICAL' | 'INFO' | 'SNAPSHOT';

/** 优先级映射 - 用于队列满时丢弃策略 */
export const PRIORITY_LEVEL: Record<EventPriority, number> = {
    CRITICAL: 3,  // 绝不丢弃
    INFO: 2,      // 尽量保留
    SNAPSHOT: 1,  // 可丢弃
};

// ============================================================================
// 基础类型
// ============================================================================

/**
 * 结构化错误信息
 */
export interface StructuredError {
    errorType: string;           // 错误类型 (如 'NetworkError', 'ValidationError')
    message: string;             // 错误消息
    stack?: string;              // 堆栈跟踪
    httpStatus?: number;         // HTTP 状态码
    responseBody?: string;       // 响应体 (脱敏后)
    code?: string;               // 错误码
}

/**
 * 基础日志事件
 */
export interface BaseLogEvent {
    // 时间与标识
    timestamp: number;           // Unix ms
    taskId: string;
    sequence: number;            // 事件序号 (任务内递增)

    // 版本信息
    logSchemaVersion: string;    // 日志 schema 版本

    // 关联字段 - 用于跨阶段串联
    runId?: string;              // 本次执行运行ID
    executorId?: string;         // 执行器实例ID
    attemptId?: string;          // 重试尝试ID
    orderId?: string;            // 关联订单ID
    orderHash?: string;          // 关联订单hash

    // 优先级
    priority: EventPriority;
}

// ============================================================================
// 任务生命周期事件
// ============================================================================

export type TaskLifecycleEventType =
    | 'TASK_CREATED'
    | 'TASK_STARTED'
    | 'TASK_PAUSED'
    | 'TASK_RESUMED'
    | 'TASK_COMPLETED'
    | 'TASK_FAILED'
    | 'TASK_CANCELLED'
    | 'DEPTH_RESTORED'
    | 'DELAYED_FILL_DETECTED'
    | 'FORCE_HEDGE_TRIGGERED'
    | 'RESIDUAL_HEDGE_ATTEMPTED'    // 外部取消后尝试补对冲（含跳过/触发）
    | 'DUST_RESIDUAL_COMPLETED';    // 残余 notional 低于 dust 阈值，转为 COMPLETED

export interface TaskLifecyclePayload {
    status: TaskStatus;
    previousStatus?: TaskStatus;
    reason?: string;
    error?: StructuredError;
    // 创建时包含决策依据
    arbOpportunity?: ArbOpportunitySnapshot;
    taskConfig?: TaskConfigSnapshot;
    // 完成时包含结果
    profit?: number;
    profitPercent?: number;
    duration?: number;
    lossHedge?: boolean;  // 是否通过亏损对冲完成
    hedgeSlippageTicks?: number;
    hedgeSlippagePercent?: number;
    // 取消时包含订单信息
    cancelledOrderHash?: string;
    cancelledPolyOrderId?: string;
    // API 返回的取消原因 (如有)
    cancelReason?: string;
    // 延迟统计 (ms)
    latency?: {
        predictSubmitToFirstStatus?: number;  // Predict: 下单到首次获取状态
        predictSubmitToFill?: number;         // Predict: 下单到成交
        polySubmitToFill?: number;            // Polymarket: 下单到成交
        totalTaskTime?: number;               // 任务总时长
        statusFetchAttempts?: number;         // 状态获取尝试次数
    };
}

export interface TaskLifecycleEvent extends BaseLogEvent {
    type: TaskLifecycleEventType;
    payload: TaskLifecyclePayload;
}

// ============================================================================
// 订单事件
// ============================================================================

export type OrderEventType =
    | 'ORDER_SUBMITTED'
    | 'ORDER_PENDING'
    | 'ORDER_PARTIAL_FILL'
    | 'ORDER_FILLED'
    | 'ORDER_CANCELLED'
    | 'ORDER_EXPIRED'
    | 'ORDER_FAILED'
    | 'TRADE_SETTLEMENT_FAILED';

export interface OrderEventPayload {
    platform: 'predict' | 'polymarket';
    orderId: string;             // hash or orderId
    side: 'BUY' | 'SELL';
    outcome?: 'YES' | 'NO';      // YES/NO 方向标识
    outcomeName?: string;        // 方向/选项显示名（如球队名、Draw）
    price: number;
    quantity: number;
    filledQty: number;
    remainingQty: number;
    avgPrice: number;
    error?: StructuredError;
    // 市场信息 (用于通知显示)
    title?: string;              // 市场标题
    // 订单簿快照引用
    orderbookSnapshotSeq?: number;
    // 延迟统计 (ms)
    latency?: {
        submitToFirstStatus?: number;   // 下单到首次获取状态的延迟
        submitToFill?: number;          // 下单到成交的延迟
        statusFetchAttempts?: number;   // 状态获取尝试次数
    };
    // 调整原因 (深度调整/价格恢复等 resubmit 场景)
    adjustReason?: string;
    // 取消原因 (如有)
    cancelReason?: string;
    // 原始 API 响应 (用于调试)
    rawResponse?: Record<string, unknown>;
}

export interface OrderEvent extends BaseLogEvent {
    type: OrderEventType;
    payload: OrderEventPayload;
}

// ============================================================================
// 价格守护事件
// ============================================================================

export type PriceGuardEventType =
    | 'PRICE_GUARD_TRIGGERED'
    | 'PRICE_GUARD_RESUMED';

export type DepthGuardEventType =
    | 'DEPTH_GUARD_TRIGGERED'
    | 'DEPTH_GUARD_RESUMED';

// ============================================================================
// Taker 模式成本守护事件
// ============================================================================

export type CostGuardEventType =
    | 'COST_GUARD_STARTED'      // 成本守护启动
    | 'COST_GUARD_TRIGGERED'    // 成本失效触发 (totalCost >= maxTotalCost)
    | 'COST_GUARD_STOPPED';     // 成本守护停止

export interface CostGuardPayload {
    maxTotalCost: number;        // 最大允许成本阈值
    predictMarketId: number;
    polymarketTokenId: string;   // 对冲 token ID
    feeRateBps: number;
    pollInterval?: number;       // 轮询间隔 ms
    // 触发时包含
    currentCost?: number;
    predictAsk?: number;
    polyAsk?: number;
    fee?: number;
    reason?: CostGuardStopReason;  // 使用集中管理的枚举
    // 事件驱动相关
    eventDriven?: boolean;       // 是否使用事件驱动模式
    triggeredBy?: CostCheckTriggerSource;  // 使用集中管理的枚举
    bscWssEnabled?: boolean;     // Predict 链上 WSS 是否启用（用于加速成交检测）
}

export interface CostGuardEvent extends BaseLogEvent {
    type: CostGuardEventType;
    payload: CostGuardPayload;
}

// ============================================================================
// Taker 模式专用事件
// ============================================================================

export type TakerEventType =
    | 'ORDER_TIMEOUT'            // 订单超时
    | 'FORCED_FILL_REFRESH'      // cancel 前强制刷新成交量
    | 'HEDGE_PRICE_SOURCE'       // 对冲取价来源 (WS_CACHE / REST_FALLBACK)
    | 'HEDGE_PRICE_INVALID'      // 对冲价格超出 polymarketMaxAsk
    | 'SHARES_MISALIGNMENT'      // Predict/Polymarket shares 不对齐
    | 'IOC_FORCE_CANCEL';        // IOC 安全阀: poll 超时后主动取消订单

export interface TakerEventPayload {
    // ORDER_TIMEOUT
    orderHash?: string;
    timeoutMs?: number;
    filledQty?: number;
    remainingQty?: number;

    // FORCED_FILL_REFRESH
    previousFilled?: number;
    actualFilled?: number;

    // HEDGE_PRICE_SOURCE
    source?: 'WS_CACHE' | 'REST_FALLBACK';
    price?: number;
    cacheAgeMs?: number;
    side?: 'BUY' | 'SELL';  // 对冲方向 (BUY=开仓, SELL=平仓)

    // HEDGE_PRICE_INVALID
    hedgePrice?: number;
    maxAllowed?: number;   // BUY 时的最高可接受价格
    minAllowed?: number;   // SELL 时的最低可接受价格

    // SHARES_MISALIGNMENT
    predictFilled?: number;
    polyHedged?: number;
    difference?: number;

    // IOC_FORCE_CANCEL
    orderId?: string;            // Polymarket orderId
    statusBeforeCancel?: string; // cancel 前的状态 (LIVE/unknown)
    statusAfterCancel?: string;  // cancel 后刷新的状态
    finalFilledQty?: number;     // cancel 后最终确认的成交量
}

export interface TakerEvent extends BaseLogEvent {
    type: TakerEventType;
    payload: TakerEventPayload;
}

export interface PriceGuardPayload {
    polymarketTokenId: string;
    triggerPrice: number;        // 触发时的 Polymarket 价格
    thresholdPrice: number;      // 阈值价格
    predictPrice: number;
    arbValid: boolean;
    pauseCount: number;
}

export interface PriceGuardEvent extends BaseLogEvent {
    type: PriceGuardEventType;
    payload: PriceGuardPayload;
}

export interface DepthGuardPayload {
    predictMarketId: number;
    arbSide: 'YES' | 'NO';
    availableDepth: number;
    requiredDepth: number;
    pauseCount: number;
    currentAsk?: number;
    maxAllowedAsk?: number;
}

export interface DepthGuardEvent extends BaseLogEvent {
    type: DepthGuardEventType;
    payload: DepthGuardPayload;
}

// ============================================================================
// 对冲事件
// ============================================================================

export type HedgeEventType =
    | 'HEDGE_STARTED'
    | 'HEDGE_ATTEMPT'
    | 'HEDGE_PARTIAL'
    | 'HEDGE_COMPLETED'
    | 'HEDGE_FAILED'
    | 'HEDGE_SKIPPED'           // 数量低于最小阈值，跳过对冲
    // 亏损对冲 (Loss Hedge) 事件
    | 'LOSS_HEDGE_STARTED'      // 进入亏损对冲模式
    | 'LOSS_HEDGE_WAITING'      // 等待价格回落
    | 'LOSS_HEDGE_ATTEMPT'      // 亏损对冲尝试
    | 'LOSS_HEDGE_PARTIAL'      // 亏损对冲部分成交
    | 'LOSS_HEDGE_COMPLETED'    // 亏损对冲完成
    | 'LOSS_HEDGE_FAILED';      // 亏损对冲失败

export interface HedgePayload {
    hedgeQty: number;            // 本次对冲数量
    totalHedged: number;         // 累计对冲
    totalPredictFilled?: number;
    avgHedgePrice?: number;
    retryCount?: number;
    error?: StructuredError;
    reason?: string;             // HEDGE_SKIPPED 原因
    // 市场信息 (用于通知显示)
    title?: string;              // 市场标题
    side?: 'BUY' | 'SELL';       // 对冲方向
    outcome?: 'YES' | 'NO';      // 对冲 outcome
    // 订单对账 (Polymarket orderId)
    orderId?: string;            // Polymarket orderId，用于审计和对账
    orderStatus?: string;        // 订单最终状态: MATCHED=全部成交, CANCELLED=IOC 部分/未成交后取消
    // 成本信息 (用于 HEDGE_COMPLETED)
    avgPredictPrice?: number;    // Predict 平均成交价
    avgTotalCost?: number;       // 平均总成本/share (Predict + Polymarket)
    // 订单簿快照引用
    orderbookSnapshotSeq?: number;
    // 亏损对冲 (Loss Hedge) 相关字段
    maxAllowedPrice?: number;    // 最大允许价格 (maxAsk + 2%)
    originalMaxAsk?: number;     // 原始 maxAsk
    currentPrice?: number;       // 当前价格
    hedgePrice?: number;         // 对冲价格
    priceSource?: string;        // 价格来源 (WS/REST)
    waitCount?: number;          // 等待次数
    totalWaitCount?: number;     // 总等待次数
    elapsedMs?: number;          // 总耗时 (ms)
}

export interface HedgeEvent extends BaseLogEvent {
    type: HedgeEventType;
    payload: HedgePayload;
}

// ============================================================================
// UNWIND 事件
// ============================================================================

export type UnwindEventType =
    | 'UNWIND_STARTED'
    | 'UNWIND_ATTEMPT'
    | 'UNWIND_PARTIAL'
    | 'UNWIND_COMPLETED'
    | 'UNWIND_FAILED';

export interface UnwindPayload {
    unhedgedQty: number;
    unwoundQty: number;
    estimatedLoss: number;
    retryCount: number;
    error?: StructuredError;
}

export interface UnwindEvent extends BaseLogEvent {
    type: UnwindEventType;
    payload: UnwindPayload;
}

// ============================================================================
// 统一事件类型
// ============================================================================

export type TaskLogEvent =
    | TaskLifecycleEvent
    | OrderEvent
    | PriceGuardEvent
    | DepthGuardEvent
    | CostGuardEvent
    | TakerEvent
    | HedgeEvent
    | UnwindEvent;

export type TaskLogEventType =
    | TaskLifecycleEventType
    | OrderEventType
    | PriceGuardEventType
    | DepthGuardEventType
    | CostGuardEventType
    | TakerEventType
    | HedgeEventType
    | UnwindEventType;

/** 事件类型到优先级的映射 */
export const EVENT_PRIORITY_MAP: Record<TaskLogEventType, EventPriority> = {
    // 生命周期 - CRITICAL
    TASK_CREATED: 'CRITICAL',
    TASK_STARTED: 'CRITICAL',
    TASK_PAUSED: 'CRITICAL',
    TASK_RESUMED: 'CRITICAL',
    TASK_COMPLETED: 'CRITICAL',
    TASK_FAILED: 'CRITICAL',
    TASK_CANCELLED: 'CRITICAL',
    DEPTH_RESTORED: 'CRITICAL',
    DELAYED_FILL_DETECTED: 'CRITICAL',
    FORCE_HEDGE_TRIGGERED: 'CRITICAL',
    RESIDUAL_HEDGE_ATTEMPTED: 'CRITICAL',
    DUST_RESIDUAL_COMPLETED: 'CRITICAL',
    // 订单 - CRITICAL
    ORDER_SUBMITTED: 'CRITICAL',
    ORDER_PENDING: 'INFO',
    ORDER_PARTIAL_FILL: 'INFO',
    ORDER_FILLED: 'CRITICAL',
    ORDER_CANCELLED: 'CRITICAL',
    ORDER_EXPIRED: 'CRITICAL',
    ORDER_FAILED: 'CRITICAL',
    TRADE_SETTLEMENT_FAILED: 'CRITICAL',
    // 价格守护 - CRITICAL
    PRICE_GUARD_TRIGGERED: 'CRITICAL',
    PRICE_GUARD_RESUMED: 'CRITICAL',
    DEPTH_GUARD_TRIGGERED: 'CRITICAL',
    DEPTH_GUARD_RESUMED: 'CRITICAL',
    // Taker 成本守护 - CRITICAL
    COST_GUARD_STARTED: 'CRITICAL',
    COST_GUARD_TRIGGERED: 'CRITICAL',
    COST_GUARD_STOPPED: 'INFO',
    // Taker 专用事件
    ORDER_TIMEOUT: 'CRITICAL',
    FORCED_FILL_REFRESH: 'INFO',
    HEDGE_PRICE_SOURCE: 'INFO',
    HEDGE_PRICE_INVALID: 'CRITICAL',
    SHARES_MISALIGNMENT: 'CRITICAL',
    IOC_FORCE_CANCEL: 'CRITICAL',
    // 对冲 - CRITICAL
    HEDGE_STARTED: 'CRITICAL',
    HEDGE_ATTEMPT: 'INFO',
    HEDGE_PARTIAL: 'INFO',
    HEDGE_COMPLETED: 'CRITICAL',
    HEDGE_FAILED: 'CRITICAL',
    HEDGE_SKIPPED: 'INFO',
    // 亏损对冲 (Loss Hedge) - CRITICAL
    LOSS_HEDGE_STARTED: 'CRITICAL',
    LOSS_HEDGE_WAITING: 'INFO',
    LOSS_HEDGE_ATTEMPT: 'INFO',
    LOSS_HEDGE_PARTIAL: 'INFO',
    LOSS_HEDGE_COMPLETED: 'CRITICAL',
    LOSS_HEDGE_FAILED: 'CRITICAL',
    // UNWIND - CRITICAL
    UNWIND_STARTED: 'CRITICAL',
    UNWIND_ATTEMPT: 'INFO',
    UNWIND_PARTIAL: 'INFO',
    UNWIND_COMPLETED: 'CRITICAL',
    UNWIND_FAILED: 'CRITICAL',
};

/** 需要发送通知的事件类型 */
export const NOTIFY_EVENTS: Set<TaskLogEventType> = new Set([
    'TASK_STARTED',
    'ORDER_SUBMITTED',
    'ORDER_PARTIAL_FILL',
    'ORDER_FILLED',
    'PRICE_GUARD_TRIGGERED',
    'PRICE_GUARD_RESUMED',
    'DEPTH_GUARD_TRIGGERED',
    'DEPTH_GUARD_RESUMED',
    // Taker 模式通知
    'COST_GUARD_TRIGGERED',
    'ORDER_TIMEOUT',
    'HEDGE_PRICE_INVALID',
    'SHARES_MISALIGNMENT',
    // 对冲
    'HEDGE_STARTED',
    'HEDGE_COMPLETED',
    'HEDGE_FAILED',
    'UNWIND_STARTED',
    'UNWIND_COMPLETED',
    'UNWIND_FAILED',
    'TASK_FAILED',
    'TASK_COMPLETED',
    'TASK_CANCELLED',
    'DELAYED_FILL_DETECTED',
    'RESIDUAL_HEDGE_ATTEMPTED',
    'DUST_RESIDUAL_COMPLETED',
]);

// ============================================================================
// 订单簿快照
// ============================================================================

export type SnapshotTrigger =
    | 'task_created'
    | 'order_submit'
    | 'order_fill'
    | 'price_guard'
    | 'hedge_start'
    | 'exposure_alert';

/**
 * 精简的订单簿数据 (只保留前N档)
 */
export interface TrimmedOrderBook {
    bids: [number, number][];    // [price, qty]
    asks: [number, number][];
    bestBid: number | null;
    bestAsk: number | null;
    spread: number | null;
    latencyMs: number;           // 数据延迟
}

/**
 * 套利指标
 */
export interface ArbMetrics {
    totalCost: number;           // predictPrice + polyPrice + fees
    profitPercent: number;
    isValid: boolean;
    maxDepth: number;            // 可执行深度
}

/**
 * Polymarket WS 健康快照 (仅 exposure_alert 等诊断触发时附带)
 */
export interface PolyWsHealth {
    state: string;
    connected: boolean;
    subscriptions: number;
    lastMessageAt: number;
    messageLagMs: number;         // -1 表示从未收到消息
    totalMessages: number;
    totalReconnects: number;
    connectedSince: number;
    connectedDurationMs: number;
}

/**
 * 订单簿快照
 */
export interface OrderBookSnapshot {
    timestamp: number;
    taskId: string;
    sequence: number;            // 快照序号
    trigger: SnapshotTrigger;
    logSchemaVersion: string;

    predict: TrimmedOrderBook | null;
    polymarket: TrimmedOrderBook | null;

    arbMetrics: ArbMetrics;

    // 仅 exposure_alert 等诊断快照携带
    exposure?: number;
    polyWs?: PolyWsHealth;

    // 优先级
    priority: EventPriority;
}

// ============================================================================
// 任务配置快照 (创建时的决策依据)
// ============================================================================

/**
 * 套利机会快照
 */
export interface ArbOpportunitySnapshot {
    strategy: 'PREDICT_MAKER' | 'TAKER' | 'POLY_MAKER';
    profitPercent: number;
    maxQuantity: number;
    predictPrice: number;
    predictBid: number;
    predictAsk: number;
    polymarketPrice: number;
    polymarketMaxAsk: number;
    feeRateBps: number;
    depth: {
        predict: number;
        polymarket: number;
    };
    isInverted: boolean;
}

/**
 * 任务配置快照
 */
export interface TaskConfigSnapshot {
    type: 'BUY' | 'SELL';
    marketId: number;
    title: string;
    predictPrice: number;
    polymarketMaxAsk?: number;
    polymarketMinBid?: number;
    quantity: number;
    polymarketConditionId: string;
    polymarketNoTokenId: string;
    polymarketYesTokenId: string;
    isInverted: boolean;
    feeRateBps: number;
    tickSize: number;
    negRisk: boolean;      // Polymarket negRisk 市场标志
    // 套利方向
    arbSide: 'YES' | 'NO';
    // 策略类型
    strategy?: 'PREDICT_MAKER' | 'TAKER' | 'POLY_MAKER';
    predictAskPrice?: number;      // Taker: 下单时的 ask 价格
    maxTotalCost?: number;         // Taker: 最大总成本阈值
    polyBidPrice?: number;         // POLY_MAKER: Polymarket 挂单价格
}

// ============================================================================
// 任务汇总
// ============================================================================

export interface TaskSummary {
    taskId: string;
    type: 'BUY' | 'SELL';
    marketId: number;
    title: string;
    logSchemaVersion: string;

    // 执行结果
    status: TaskStatus;
    isSuccess: boolean;

    // Taker 模式字段
    strategy: 'PREDICT_MAKER' | 'TAKER' | 'POLY_MAKER';
    cancelReason?: TaskCancelReason;  // 使用集中管理的枚举
    maxTotalCost?: number;       // Taker: 最大成本阈值
    avgTotalCost?: number;       // Taker: 实际成交成本
    costGuardTriggerCount?: number;
    orderTimeoutCount?: number;

    // 统计
    totalEvents: number;
    totalSnapshots: number;
    eventCounts: Record<string, number>;

    // 时间
    startTime: number;
    endTime: number;
    durationMs: number;

    // 成交
    predictFilledQty: number;
    polyFilledQty: number;
    hedgedQty: number;
    avgPredictPrice: number;
    avgPolymarketPrice: number;

    // 盈亏
    actualProfit: number;
    profitPercent: number;
    unwindLoss: number;

    // 风控
    pauseCount: number;
    hedgeRetryCount: number;

    // 时间线摘要
    timeline: {
        timestamp: number;
        event: string;
        detail?: string;
    }[];

    generatedAt: number;
}

// ============================================================================
// 日志服务配置
// ============================================================================

export interface TaskLoggerConfig {
    /** 基础目录 */
    baseDir: string;

    /** 是否启用异步队列 */
    asyncQueue: boolean;

    /** 队列配置 */
    queue: {
        /** 最大队列长度 */
        maxSize: number;
        /** 批量 flush 阈值 (条数) */
        flushThreshold: number;
        /** 批量 flush 间隔 (ms) */
        flushIntervalMs: number;
    };

    /** 快照配置 */
    snapshot: {
        /** 是否启用快照 */
        enabled: boolean;
        /** 保留前N档深度 */
        depthLimit: number;
        /** 最小快照间隔 (ms) - 避免高频 */
        minIntervalMs: number;
    };

    /** 保留配置 */
    retention: {
        /** 保留天数 */
        days: number;
        /** 是否压缩归档 */
        compress: boolean;
    };

    /** 脱敏配置 */
    sanitize: {
        /** 是否启用脱敏 */
        enabled: boolean;
        /** 需要脱敏的字段 */
        fields: string[];
    };

    /** 通知配置 */
    notify: {
        /** 是否启用通知 */
        enabled: boolean;
    };
}

/** 默认配置 */
export const DEFAULT_LOGGER_CONFIG: TaskLoggerConfig = {
    baseDir: './data/logs/tasks',
    asyncQueue: true,
    queue: {
        maxSize: 1000,
        flushThreshold: 100,
        flushIntervalMs: 500,
    },
    snapshot: {
        enabled: true,
        depthLimit: 5,
        minIntervalMs: 100,
    },
    retention: {
        days: 7,
        compress: false,
    },
    sanitize: {
        enabled: true,
        fields: ['apiKey', 'privateKey', 'secret', 'passphrase'],
    },
    notify: {
        enabled: true,
    },
};
