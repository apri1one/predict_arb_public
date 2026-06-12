/**
 * Predict 做市模块 - 导出
 */

// 类型
export type {
    MarketMakerConfig,
    GlobalConfig,
    MarketState,
    ActiveOrder,
    OrderDelta,
    PriceSnapshot,
    Fill,
    TradingStats,
    MarketMakerEvents,
    PredictOrder,
    PredictPosition,
} from './types.js';

// 配置
export {
    DEFAULT_GLOBAL_CONFIG,
    DEFAULT_MARKET_CONFIG,
    validateMarketConfig,
    validateGlobalConfig,
    mergeMarketConfig,
    mergeGlobalConfig,
    saveConfig,
    loadConfig,
    getConfigFilePath,
    formatConfigSummary,
    type SavedConfig,
} from './config.js';

// 引擎
export {
    MarketMakerEngine,
    type EngineDependencies,
    type PlaceOrderParams,
} from './engine.js';

// 多市场管理器
export {
    MultiMarketMaker,
    type GlobalStats,
    type MultiMarketMakerEvents,
} from './multi-engine.js';

// 市场选择器
export {
    scanMarkets,
    selectMarkets,
    convertToConfigs,
    quickSelect,
    displayMarketList,
    groupByEvent,
    type MarketInfo,
    type SelectedMarket,
    type EventGroup,
} from './market-selector.js';

// 交易客户端
export {
    TradingClient,
    createTradingClient,
    type TradingClientConfig,
} from './trading-client.js';
