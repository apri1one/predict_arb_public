/**
 * Predict 做市模块 - 类型定义
 */

// ============================================================================
// 市场配置
// ============================================================================

export type MarketMakerStrategy = 'FOLLOW' | 'SCALP';
export type OutcomeChoice = 'YES' | 'NO';

export interface MarketMakerConfig {
    marketId: number;
    title: string;
    tokenId: string;              // Token ID (根据 outcome 选择计算得出)
    outcome: OutcomeChoice;       // 做市方向: YES 或 NO
    feeRateBps: number;           // 手续费基点
    isNegRisk: boolean;
    isYieldBearing: boolean;
    maxShares: number;            // 该市场最大持仓
    minOrderSize: number;         // 最小订单数量 (默认 1)
    tickSize: number;             // 最小价格精度 (从 API decimalPrecision 计算: 0.01 或 0.001)
    strategy: MarketMakerStrategy; // 策略模式: FOLLOW=跟随卖一, SCALP=剥头皮(买一+1tick)

    // 价格运行区间（可选）
    // - 买一价不高于 maxBuyPrice，否则暂停下单
    // - 卖一价不低于 minSellPrice，否则暂停下单
    // 单位：0-1（例如 0.723 表示 72.3¢）
    maxBuyPrice?: number;
    minSellPrice?: number;

    // 最大价差阈值（可选）
    // 当 spread >= maxSpreadCents 时，暂停买单但保留卖单
    // 单位：美分（例如 5 表示 5¢）
    maxSpreadCents?: number;

    // SCALP 策略: 最大卖单数量（默认 10）
    maxScalpSellOrders?: number;
}

export interface GlobalConfig {
    pollIntervalMs: number;       // 轮询间隔 (默认 1000ms)
    minAdjustIntervalMs: number;  // 最小调整间隔 (默认 500ms)
    maxRetries: number;           // 最大重试次数
    retryDelayMs: number;         // 重试延迟

    // 风控参数
    minSpread: number;            // 最小价差（<=0 表示关闭）
    minOrderValueUsd: number;     // 最小订单金额 (默认 0.9 USD)
    maxConsecutiveErrors: number; // 连续错误阈值，超过则暂停 (默认 5)
    emergencyStop: boolean;       // 紧急停止开关
    sizeEpsilon: number;          // Delta 失衡保护：尺寸比较容差 (默认 0.1)
}

// ============================================================================
// 持仓查询选项
// ============================================================================

/**
 * 用于链上/链下持仓查询的市场属性（会影响合约地址选择）
 */
export interface PositionQueryOptions {
    isNegRisk: boolean;
    isYieldBearing: boolean;
}

// ============================================================================
// 市场状态
// ============================================================================

export interface MarketState {
    marketId: number;
    title: string;
    position: number;                    // 当前持仓
    activeBuyOrder: ActiveOrder | null;
    activeSellOrder: ActiveOrder | null; // FOLLOW 策略使用

    // SCALP 策略的多卖单管理
    scalpSellOrders: ScalpSellOrder[];      // 多卖单列表
    pendingSellOrders: PendingSellOrder[];  // 待挂卖单队列

    lastBestBid: number;
    lastBestAsk: number;
    lastSpread: number;
    lastUpdateMs: number;
    status: MarketStatus;
    errorMessage?: string;
}

export type MarketStatus =
    | 'idle'           // 空闲，等待启动
    | 'initializing'   // 初始化中
    | 'running'        // 运行中
    | 'adjusting'      // 调整订单中
    | 'range_paused'   // 价格越界暂停（仍会轮询，回到区间后自动恢复）
    | 'paused'         // 暂停
    | 'error';         // 错误

// ============================================================================
// 订单相关
// ============================================================================

export interface ActiveOrder {
    id: string;             // API 订单 ID（用于撤单）
    hash: string;           // 订单哈希
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
    filledQuantity: number;
    status: OrderStatus;
    createdAt: Date;
}

/**
 * SCALP 策略的卖单（带成本记录）
 * 用于多卖单管理，每个卖单记录对应的买入成本
 */
export interface ScalpSellOrder extends ActiveOrder {
    /** 对应的买入成交价（用于计算利润） */
    costPrice: number;
    /** 对应的买入成交量 */
    costQuantity: number;
}

/**
 * 待挂卖单队列项
 * 买入成交后先入队，下一个 tick 再实际挂单
 */
export interface PendingSellOrder {
    /** 买入成交价 */
    buyPrice: number;
    /** 买入成交量 */
    buyQuantity: number;
    /** 创建时间 */
    createdAt: Date;
}

export type OrderStatus =
    | 'OPEN'
    | 'PARTIALLY_FILLED'
    | 'FILLED'
    | 'CANCELLED'
    | 'EXPIRED';

// API /v1/orders/{hash} 可能返回 INVALIDATED
export type OrderStatusFromAPI =
    | 'OPEN'
    | 'PARTIALLY_FILLED'
    | 'FILLED'
    | 'CANCELLED'
    | 'EXPIRED'
    | 'INVALIDATED';

export interface OrderStatusResult {
    found: boolean;
    status?: OrderStatusFromAPI;
    amountFilled?: string;
}

export interface OrderDelta {
    action: 'PLACE' | 'CANCEL' | 'REPLACE' | 'NONE';
    side: 'BUY' | 'SELL';
    currentOrder: ActiveOrder | null;
    targetPrice: number;
    targetQuantity: number;
    reason?: string;
}

// ============================================================================
// 成交记录
// ============================================================================

export interface Fill {
    orderId: string;
    marketId: number;
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
    filledAt: Date;
}

// ============================================================================
// 价格快照
// ============================================================================

export interface PriceSnapshot {
    marketId: number;
    bestBid: number;
    bestBidSize: number;
    bestAsk: number;
    bestAskSize: number;
    spread: number;
    spreadPercent: number;
    timestamp: Date;
}

// ============================================================================
// 统计信息
// ============================================================================

export interface TradingStats {
    marketId: number;
    totalBuys: number;
    totalSells: number;
    totalBuyVolume: number;      // 买入总量
    totalSellVolume: number;     // 卖出总量
    totalBuyValue: number;       // 买入总价值 (USD)
    totalSellValue: number;      // 卖出总价值 (USD)
    realizedPnL: number;         // 已实现盈亏（基于 FIFO 成本计算）
    unrealizedPnL: number;       // 未实现盈亏（持仓 * (当前价 - 平均成本)）
    totalPnL: number;            // 总盈亏 = 已实现 + 未实现
    avgBuyPrice: number;         // 平均买入价（加权成本）
    avgSellPrice: number;        // 平均卖出价
    inventoryCost: number;       // 当前持仓成本（用于计算未实现盈亏）
    orderAdjustments: number;    // 订单调整次数
    startTime: Date;
    lastTradeTime: Date | null;
}

// ============================================================================
// 事件回调
// ============================================================================

export interface MarketMakerEvents {
    onStateChange?: (marketId: number, state: MarketState) => void;
    onFill?: (fill: Fill) => void;
    onError?: (marketId: number, error: Error) => void;
    onOrderPlaced?: (marketId: number, order: ActiveOrder) => void;
    onOrderCancelled?: (marketId: number, orderId: string) => void;
    onPriceUpdate?: (snapshot: PriceSnapshot) => void;
}

// ============================================================================
// API 响应类型 (从 predict 模块导入的简化版)
// ============================================================================

export interface PredictOrderBookLevel {
    price: number;
    size: number;
}

export interface PredictOrderBook {
    marketId: number;
    bids: [number, number][];  // [price, size]
    asks: [number, number][];
}

/**
 * API 返回的订单结构（嵌套）
 * GET /v1/orders 返回 { id, order: PredictOrderData }
 */
export interface PredictOrderResponse {
    id: string;              // 订单 ID（用于撤单）
    order: PredictOrderData;
}

/**
 * 订单数据（嵌套在 order 字段内）
 */
export interface PredictOrderData {
    hash: string;
    marketId: number;
    outcomeId: number;
    maker: string;
    side: 'BUY' | 'SELL';
    price: number;           // 0-1 范围
    quantity: number;        // 实际数量（非 wei）
    quantityFilled: number;
    status: OrderStatusFromAPI;
    createdAt: string;
}

/**
 * @deprecated 使用 PredictOrderResponse
 */
export interface PredictOrder {
    hash: string;
    marketId: number;
    outcomeId: number;
    maker: string;
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
    quantityFilled: number;
    status: 'OPEN' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'EXPIRED';
    createdAt: string;
}

export interface PredictPosition {
    marketId: number;
    outcomeId: number;
    quantity: number;
    avgPrice: number;
}

// Declaration merge: extra optional fields for MarketMakerConfig.
export interface MarketMakerConfig {
    positionPrecisionDecimals?: number;
}
