/**
 * Trading Module - Main Entry
 */

export { TradingConfig, DEFAULT_CONFIG, loadConfigFromEnv } from './config.js';

export {
    calculateDepth,
    calculateCumulativeDepth,
    calculatePredictFee,
    formatDepthResult,
    type DepthResult,
    type OrderBookLevel,
} from './depth-calculator.js';

export {
    MakerStrategy,
    createMakerStrategy,
    type MarketPair,
    type OrderStatus,
    type StrategyState,
} from './maker-strategy.js';
