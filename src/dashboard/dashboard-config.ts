/**
 * Dashboard 不可变配置常量
 *
 * 从 start-dashboard.ts 提取，集中管理所有配置常量。
 * 所有 process.env 读取在模块顶层求值是安全的——当前 .env 中未定义这些变量，
 * 均使用硬编码默认值。若未来 .env 中新增这些变量，需改为 lazy getter。
 */

// ============================================================================
// 基础轮询
// ============================================================================

export const POLL_INTERVAL_MS = 30000;  // 主轮询间隔 (兜底用)
export const ENABLE_SPORTS_SERVICE = true;  // 体育市场开关
export const ENABLE_ALL_MARKETS = process.env.ENABLE_ALL_MARKETS !== 'false';  // All 市场开关 (默认启用，可通过 ENABLE_ALL_MARKETS=false 关闭)
export const ENABLE_ARB_TG_NOTIFICATION = false;  // 套利机会 TG 通知开关

// ============================================================================
// 数据源模式
// ============================================================================

// DASHBOARD_PREDICT_ORDERBOOK_MODE: ws | legacy
//   ws: WS 订阅 + 统一缓存 (实时，推荐)
//   legacy: REST 轮询 (兼容模式)
export const DASHBOARD_PREDICT_ORDERBOOK_MODE = (process.env.DASHBOARD_PREDICT_ORDERBOOK_MODE || 'ws') as 'ws' | 'legacy';
export const POLY_ORDERBOOK_SOURCE = (process.env.POLY_ORDERBOOK_SOURCE || 'ws').toLowerCase();

// ============================================================================
// 缓存与过期
// ============================================================================

// UI 展示用 (允许 30s 过期，保持连续性)
export const PREDICT_ORDERBOOK_STALE_MS = Number(process.env.PREDICT_ORDERBOOK_STALE_MS) || 30000;
// 计算/交易用 (严格 10s 过期，防止用过期数据计算利润)
export const CALC_ORDERBOOK_STALE_MS = Number(process.env.CALC_ORDERBOOK_STALE_MS) || 10000;
export const PREDICT_ORDERBOOK_WARM_ON_SUBSCRIBE = process.env.PREDICT_ORDERBOOK_WARM_ON_SUBSCRIBE !== 'false';

// Polymarket token ID 缓存 TTL
export const CACHE_TTL_MS = 5 * 60 * 1000;

// 机会缓存过期时间 (确保在全量扫描期间不丢失)
export const CACHE_EXPIRY_MS = 5 * 60 * 1000; // 5分钟后过期

// REST 全量重扫间隔 (覆盖 WS 长时间无推送的长尾市场，强制走 REST 刷新缓存)
export const FULL_RESCAN_INTERVAL_MS = Number(process.env.FULL_RESCAN_INTERVAL_MS) || 30 * 60 * 1000;

// Predict 订单簿缓存有效期 (主轮询 1 秒，留 1 秒容错)
export const PREDICT_CACHE_TTL_MS = 2000;

// Polymarket WS 数据过期判定
export const POLY_WS_STALE_MS = 15000;

// REST fetch 超时
export const FETCH_TIMEOUT_MS = 10000; // 10秒

// ============================================================================
// WS 健康与断连处理
// ============================================================================

// 注意：健康检查分为"连接健康"和"数据新鲜度"两层
//   - 连接健康：WS 物理连接是否存活 (用于任务暂停/恢复)
//   - 数据新鲜度：订单簿数据是否在阈值内 (用于计算是否参与)
export const WS_HEALTH_CHECK_MS = Number(process.env.DASHBOARD_WS_HEALTH_CHECK_MS) || 5000;
export const WS_DISCONNECT_PAUSE_MS = Number(process.env.DASHBOARD_WS_DISCONNECT_PAUSE_MS) || 30000;
export const WS_RECONNECT_RESUME_DELAY_MS = Number(process.env.DASHBOARD_WS_RECONNECT_RESUME_DELAY_MS) || 3000;

// ============================================================================
// Hybrid 兜底轮询
// ============================================================================

// 注意：Hybrid 仅用于"订阅预热/连接断开时保持缓存"，不用于计算数据源
// 计算数据源严格遵循 WS-only 或 legacy 模式
export const HYBRID_FALLBACK_ENABLED = process.env.HYBRID_FALLBACK_ENABLED !== 'false';
export const HYBRID_FALLBACK_INTERVAL_MS = Number(process.env.HYBRID_FALLBACK_INTERVAL_MS) || 5000;

// ============================================================================
// WS 驱动计算
// ============================================================================

// true: 主扫描只更新市场列表，计算完全由 WS 触发
// false: 主扫描也参与计算 (兼容模式)
export const WS_DRIVEN_CALCULATION = process.env.WS_DRIVEN_CALCULATION !== 'false';

// ============================================================================
// SSE 背压
// ============================================================================

export const BACKPRESSURE_DRAIN_TIMEOUT_MS = 5000;  // drain 等待超时时间 (SSH 隧道需要更长时间)
export const BACKPRESSURE_MAX_TIMEOUT_COUNT = 5;    // 最大连续超时次数 (安全网，正常情况不应触发)
export const BACKPRESSURE_LOG_INTERVAL_MS = 10000;  // 背压日志限流间隔（10秒）

// ============================================================================
// 广播节流
// ============================================================================

export const BROADCAST_THROTTLE_MS = 200;  // 200ms 节流间隔 (减少背压)
export const OPPORTUNITY_THROTTLE_MS = 2000;  // opportunity 独立 2s 节流 (payload ~500KB，降频减少背压)
export const SPORTS_RECOMPUTE_THROTTLE_MS = 200;  // 体育重算节流
export const CLOSE_RECOMPUTE_THROTTLE_MS = 200;   // 平仓重算节流
export const WS_UPDATE_THROTTLE_MS = 50;  // 50ms 节流（接近实时）
export const PREDICT_WS_UPDATE_THROTTLE_MS = 50;  // 50ms 节流

// ============================================================================
// 敞口检测
// ============================================================================

export const EXPOSURE_CHECK_INTERVAL_MS = 30_000; // 每 30s 轮询一次
export const EXPOSURE_THRESHOLD = 10; // shares 阈值
export const HEDGE_GRACE_PERIOD_MS = 60_000; // 对冲中的任务给予 60s 宽限期，避免对冲刚启动就误报

// ============================================================================
// Boost
// ============================================================================

export const BOOST_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// ============================================================================
// HTTP
// ============================================================================

export const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1MB

// ============================================================================
// 任务状态集合
// ============================================================================

// 正在对冲中的状态，刚进入时给予宽限期
export const HEDGING_STATUSES = new Set(['HEDGING', 'HEDGE_PENDING', 'HEDGE_IN_PROGRESS', 'HEDGE_RETRY']);

// 只有这些状态的任务才可能产生真正的未对冲敞口
export const EXPOSURE_ACTIVE_STATUSES = new Set([
    'EXECUTING',
    'PREDICT_SUBMITTED',
    'PARTIALLY_FILLED',
    'FILL_COMPLETED',
    'HEDGING',
    'HEDGE_PENDING',
    'HEDGE_RETRY',
    'HEDGE_IN_PROGRESS',
    'PAUSED',
    'HEDGE_FAILED',
]);

export const BATCH_TASK_READY_EVENT_TYPES = new Set([
    'TASK_STARTED',
    'ORDER_SUBMITTED',
    'TASK_PAUSED',
    'TASK_FAILED',
    'TASK_CANCELLED',
    'TASK_COMPLETED',
]);

// ============================================================================
// API Key / 通知冷却
// ============================================================================

export const API_KEY_LOG_INTERVAL_MS = 60000;
export const WS_NOTIFY_COOLDOWN_MS = 60_000;

// ============================================================================
// 对冲滑点容忍
// ============================================================================

// 对冲时允许的最大滑点 (tick 数，1 tick = 0.01)
// 用于 Predict 成交后 Polymarket 对冲下单的价格放宽
// 例: 3 = 允许比任务配置价格偏移 0.03 (3¢)
export const HEDGE_SLIPPAGE_TICKS = Number(process.env.HEDGE_SLIPPAGE_TICKS) || 3;

// POLY_MAKER: Polymarket 成交后，Predict LIMIT 对冲允许的最大滑点
// Predict 不支持 IOC，因此用 LIMIT 重试 + 成本价 GTC 保底
// 默认 3 ticks = 0.03
export const POLY_MAKER_PREDICT_HEDGE_SLIPPAGE_TICKS =
    Number(process.env.POLY_MAKER_PREDICT_HEDGE_SLIPPAGE_TICKS) || HEDGE_SLIPPAGE_TICKS;
