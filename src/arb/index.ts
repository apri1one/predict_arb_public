/**
 * Arbitrage Module - Main Entry
 * 
 * Exports all arbitrage detection and calculation utilities
 */

// Types
export type {
    ArbitrageType,
    ArbitrageOpportunity,
    ArbitrageLeg,
    ArbitrageConfig,
    ArbitrageEvent,
    ArbitrageCallback,
    UnifiedMarketBook,
    OrderBookLevel,
    FeeStructure,
} from './types.js';

// Calculator utilities
export {
    calculateAverageFillPrice,
    calculateSlippage,
    getAvailableQuantityAtPrice,
    // Predict fee functions
    getPredictFeePerShare,
    getPredictTakerFeeRate,
    calculatePredictFee,
    // Legacy fee functions
    calculateTradingFee,
    calculateTotalFees,
    // Other utilities
    calculateDepthScore,
    calculateSpread,
    calculateMidPrice,
    calculateImpliedProbability,
    calculateSamePlatformBinaryArb,
    calculateCrossPlatformBinaryArb,
    calculateLatencyRisk,
    estimateExecutionRisk,
    calculateKellySize,
    calculatePositionSize,
} from './calculator.js';

// Detector
export {
    ArbitrageDetector,
    createArbitrageDetector,
} from './detector.js';

// Predict-specific strategy (main focus)
export {
    PredictStrategy,
    createPredictStrategy,
    type PredictOrderBook,
    type PolymarketReference,
    type TradeSignal,
    type StrategyResult,
    type PredictOpportunity,
    type MarketAnalysis,
    type StrategyConfig,
} from './predict-strategy.js';
