/**
 * Predict-Polymarket Arbitrage Trading Bot
 * 
 * Main entry point and exports
 */

// Polymarket Client
export {
    PolymarketClient,
    PolymarketRestClient,
    PolymarketWebSocketClient,
    createPolymarketClient,
    createWebSocketClient,
} from './polymarket/index.js';

export type {
    NormalizedOrderBook as PolymarketOrderBook,
    OrderBookSummary,
    PolymarketMarket,
    PolymarketEvent,
    PolymarketClientOptions,
    WebSocketClientConfig,
    WebSocketEventHandlers,
} from './polymarket/index.js';

// Predict Client
export {
    PredictClient,
    PredictRestClient,
    PredictApiError,
    MissingApiKeyError,
    createPredictClient,
} from './predict/index.js';

export type {
    NormalizedOrderBook as PredictOrderBook,
    PredictMarket,
    PredictOrder,
    OrderMatch,
    PredictClientOptions,
    GetMarketsParams,
    GetOrdersParams,
} from './predict/index.js';

// Order Book Manager
export {
    OrderBookManager,
    createOrderBookManager,
} from './order-book-manager.js';

export type {
    Platform,
    UnifiedOrderBook,
    MarketPair,
    ArbitrageOpportunity,
    OrderBookManagerConfig,
    OrderBookUpdateCallback,
    ArbitrageCallback,
} from './order-book-manager.js';
