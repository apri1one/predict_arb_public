/**
 * Taker Mode 类型定义
 *
 * Taker 模式核心区别：
 * - 订单价格: LIMIT @ ask (主动吃单) vs PREDICT_MAKER 的 bid (被动挂单)
 * - 成交速度: 快速主动成交 vs 等待被动成交
 * - 价格守护: 监控总成本 vs 监控 Poly ask 上涨
 * - 撤单策略: 超时/成本失效直接 cancel + end (无 PAUSED)
 */

import type { Task, TaskStrategy } from '../types.js';

// ============================================================================
// 成本守护配置
// ============================================================================

/**
 * 成本守护配置
 * 用于实时监控 totalCost = predictAsk + polyAsk + fee
 */
export interface CostGuardConfig {
    /** Predict 市场 ID */
    predictMarketId: number;

    /** Polymarket 对冲 token ID (通过 getHedgeTokenId 获取) */
    polymarketTokenId: string;

    /** 最大总成本阈值 (默认 1，totalCost <= 1 即不亏钱) */
    maxTotalCost: number;

    /** 费率 (基点，如 200 = 2%) */
    feeRateBps: number;

    /** 轮询间隔 (ms)，默认 300 */
    pollInterval?: number;

    /** 成本失效回调 */
    onCostExceeded: (state: CostGuardState) => void | Promise<void>;
}

/**
 * 成本守护状态
 */
export interface CostGuardState {
    /** 成本是否有效 (totalCost < maxTotalCost) */
    isValid: boolean;

    /** 当前总成本 */
    currentCost: number;

    /** Predict ask 价格 */
    predictAsk: number;

    /** Polymarket 对冲 ask 价格 */
    polyAsk: number;

    /** 预估手续费 */
    fee: number;

    /** 检查时间戳 */
    timestamp: number;
}

// ============================================================================
// Taker 执行器配置
// ============================================================================

/**
 * Taker 执行配置
 */
export interface TakerConfig {
    /** Predict 市场 ID */
    predictMarketId: number;

    /** Polymarket 对冲 token ID */
    polymarketTokenId: string;

    /** 下单价格 (ask) */
    predictAskPrice: number;

    /** 最大总成本阈值 */
    maxTotalCost: number;

    /** 反推的 Poly 对冲最大 ask */
    polymarketMaxAsk: number;

    /** 费率 (基点) */
    feeRateBps: number;

    /** 订单超时 (ms)，默认 10000 */
    orderTimeout: number;

    /** 价格精度 (如 0.001) */
    tickSize: number;

    /** 对冲最大重试次数 */
    maxHedgeRetries: number;
}

/**
 * Taker 执行上下文 (运行时状态)
 */
export interface TakerContext {
    /** 任务引用 */
    task: Task;

    /** 当前订单 hash */
    currentOrderHash?: string;

    // ====== 成交量追踪 (WSS-first 架构) ======

    /**
     * WSS 累计成交量 (BSC 链上事件增量累加)
     * - 每个 OrderFilled 事件的 takerAmountFilled 是增量
     * - 通过 wssFillEvents 去重后累加
     */
    wssFilledQty: number;

    /**
     * WSS 成交事件去重集合
     * key: `${txHash}:${logIndex}`
     */
    wssFillEvents: Set<string>;

    /**
     * REST API 返回的累计成交量
     * - 来自 predictTrader.getOrderStatus().filledQty
     * - 作为 WSS 的兜底/对账数据源
     */
    restFilledQty: number;

    /**
     * 合并后的有效成交量 (用于决策)
     * = max(wssFilledQty, restFilledQty)
     * 单调不减，始终取最大值
     */
    totalPredictFilled: number;

    /** 累计对冲量 */
    totalHedged: number;

    /** 对冲价格累计 (用于计算平均价) */
    hedgePriceSum: number;

    // ====== 累计对冲机制 (Polymarket $1 最小订单) ======

    /** 待对冲累计数量 (等待达到 $1 名义阈值) */
    pendingHedgeQty: number;

    /** 最后一次对冲价格估算 (用于计算名义金额) */
    lastHedgePriceEstimate: number;

    /** 取消控制器 */
    abortController: AbortController;

    /** 取消信号 */
    signal: AbortSignal;

    /** 任务开始时间 */
    startTime: number;

    // ====== 状态预获取相关 ======

    /** 是否收到过有效的订单状态响应 */
    hasReceivedValidStatus: boolean;

    /** 首次收到有效状态的时间戳 */
    firstValidStatusTime?: number;

    /** 状态获取尝试次数 */
    statusFetchAttempts: number;

    /** 状态获取失败次数 (连续) */
    statusFetchFailures: number;

    // ====== 延迟统计相关 ======

    /** Predict 下单时间戳 */
    predictSubmitTime?: number;

    /** Polymarket 下单时间戳 */
    polySubmitTime?: number;

    /** Predict 首次成交时间戳 (REST 检测到) */
    predictFirstFillTime?: number;

    /** Polymarket 首次成交时间戳 */
    polyFirstFillTime?: number;

    /** WSS 首次成交时间戳 (BSC 链上事件) */
    wssFirstFillTime?: number;
}

// ============================================================================
// 订单簿缓存
// ============================================================================

/**
 * 缓存的订单簿数据
 */
export interface CachedOrderBook {
    /** 订单簿数据 */
    data: {
        bids: [number, number][];  // [price, qty]
        asks: [number, number][];
    };

    /** 缓存时间戳 */
    timestamp: number;

    /** 数据来源 */
    source: 'WS' | 'REST';
}

/**
 * 订单簿缓存配置
 */
export interface OrderbookCacheConfig {
    /** 缓存有效期 (ms)，默认 500 */
    ttlMs: number;

    /** 过期警告阈值 (ms)，默认 1000 */
    staleThresholdMs: number;

    /** 最大容忍过期 (ms)，默认 2000 */
    maxStaleMs: number;
}

// ============================================================================
// 执行结果
// ============================================================================

/**
 * Taker 订单结果
 */
export interface TakerOrderResult {
    /** 是否成功 */
    success: boolean;

    /** 订单 hash */
    hash?: string;

    /** 错误信息 */
    error?: string;

    /** 成交量 */
    filledQty?: number;

    /** 平均成交价 */
    avgPrice?: number;
}

/**
 * 对冲结果
 */
export interface HedgeResult {
    /** 成交量 */
    filledQty: number;

    /** 平均成交价 */
    avgPrice: number;

    /** 订单 ID */
    orderId?: string;

    /** 是否完全成交 */
    isComplete: boolean;
}

/**
 * 取消原因
 */
export type CancelReason = 'ORDER_TIMEOUT' | 'COST_INVALID' | 'USER_CANCELLED' | 'BALANCE_GUARD' | 'SPORTS_START_TIME_CHANGED' | 'SPORTS_EVENT_LIVE';

// ============================================================================
// 价格工具类型
// ============================================================================

/**
 * 价格对齐方向
 */
export type AlignDirection = 'UP' | 'DOWN';

/**
 * 对冲价格来源
 */
export type HedgePriceSource = 'WS_CACHE' | 'REST_FALLBACK';

// ============================================================================
// 工具函数类型
// ============================================================================

/**
 * 获取对冲 token ID 的函数类型
 */
export type GetHedgeTokenIdFn = (task: Task) => string;

/**
 * 计算 Predict 费用的函数类型
 */
export type CalculatePredictFeeFn = (price: number, feeRateBps: number) => number;
