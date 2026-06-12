/**
 * Arbitrage Calculator
 * 
 * Core calculations for arbitrage detection including:
 * - Price spread analysis
 * - Slippage estimation
 * - Fee calculation
 * - Profit computation
 */

import type {
    OrderBookLevel,
    ArbitrageLeg,
    FeeStructure,
} from './types.js';

// ============================================================================
// Price Calculation Utilities
// ============================================================================

/**
 * Calculate the average fill price for a given quantity
 * consuming multiple order book levels
 */
export function calculateAverageFillPrice(
    levels: OrderBookLevel[],
    quantity: number,
    isBuy: boolean
): { avgPrice: number; filledQty: number; levelsUsed: number; totalCost: number } {
    if (levels.length === 0) {
        return { avgPrice: 0, filledQty: 0, levelsUsed: 0, totalCost: 0 };
    }

    let remainingQty = quantity;
    let totalCost = 0;
    let levelsUsed = 0;

    for (const level of levels) {
        if (remainingQty <= 0) break;

        const fillQty = Math.min(remainingQty, level.quantity);
        totalCost += fillQty * level.price;
        remainingQty -= fillQty;
        levelsUsed++;
    }

    const filledQty = quantity - Math.max(0, remainingQty);
    const avgPrice = filledQty > 0 ? totalCost / filledQty : 0;

    return { avgPrice, filledQty, levelsUsed, totalCost };
}

/**
 * Calculate slippage from mid-price to execution price
 */
export function calculateSlippage(midPrice: number, executionPrice: number): number {
    if (midPrice === 0) return 0;
    return Math.abs(executionPrice - midPrice) / midPrice;
}

/**
 * Estimate the maximum quantity that can be filled at a given price
 */
export function getAvailableQuantityAtPrice(
    levels: OrderBookLevel[],
    maxPrice: number,
    isBuy: boolean
): number {
    let availableQty = 0;

    for (const level of levels) {
        if (isBuy) {
            // For buying, we can fill if level price <= maxPrice
            if (level.price <= maxPrice) {
                availableQty += level.quantity;
            } else {
                break; // Prices are sorted, no need to continue
            }
        } else {
            // For selling, we can fill if level price >= maxPrice  
            if (level.price >= maxPrice) {
                availableQty += level.quantity;
            } else {
                break;
            }
        }
    }

    return availableQty;
}

// ============================================================================
// Fee Calculations
// ============================================================================

/**
 * Predict.fun fee calculation
 * From: https://docs.predict.fun/the-basics/predict-fees-and-limits#fees
 * 
 * Maker fee: 0%
 * Taker fee formula: Raw Fee = BaseFee × min(price, 1 - price) × quantity
 * Where BaseFee = 2% (or 1.8% with 10% discount - default)
 */
const PREDICT_BASE_FEE = 0.02; // 2%
const PREDICT_DISCOUNT = 0.9; // 10% discount = multiply by 0.9

/**
 * Calculate Predict taker fee per share based on price
 * Formula: feePerShare = BaseFee × min(price, 1 - price)
 * 
 * With 10% discount (default): BaseFee = 1.8%
 * 
 * Examples (with discount):
 * - price = 0.20 → fee = 0.018 × 0.20 = $0.0036 per share (1.8% of price)
 * - price = 0.50 → fee = 0.018 × 0.50 = $0.009 per share (1.8% of price)
 * - price = 0.60 → fee = 0.018 × 0.40 = $0.0072 per share (1.2% of price)
 * - price = 0.80 → fee = 0.018 × 0.20 = $0.0036 per share (0.45% of price)
 */
export function getPredictFeePerShare(price: number, hasDiscount: boolean = true): number {
    const baseFee = hasDiscount ? PREDICT_BASE_FEE * PREDICT_DISCOUNT : PREDICT_BASE_FEE;
    return baseFee * Math.min(price, 1 - price);
}

/**
 * Get Predict taker fee rate (as percentage of cost)
 * Formula: feeRate = feePerShare / price = BaseFee × min(price, 1-price) / price
 */
export function getPredictTakerFeeRate(price: number, hasDiscount: boolean = true): number {
    if (price <= 0 || price >= 1) return 0;
    const feePerShare = getPredictFeePerShare(price, hasDiscount);
    return feePerShare / price;
}

/**
 * Calculate Predict trading fee
 * Maker: 0%, Taker: formula-based
 * 
 * Formula: totalFee = BaseFee × min(price, 1-price) × quantity
 * Default includes 10% discount (BaseFee = 1.8%)
 */
export function calculatePredictFee(
    price: number,
    quantity: number,
    isMaker: boolean,
    hasDiscount: boolean = true
): number {
    if (isMaker) return 0; // Makers pay no fee

    return getPredictFeePerShare(price, hasDiscount) * quantity;
}

/**
 * Calculate trading fees for a leg (legacy function for compatibility)
 */
export function calculateTradingFee(
    cost: number,
    platform: 'polymarket' | 'predict',
    isMaker: boolean,
    fees: FeeStructure,
    price?: number // Optional price for Predict price-based fees
): number {
    if (platform === 'polymarket') {
        const platformFees = fees.polymarket;
        const feeRate = isMaker ? platformFees.makerFee : platformFees.takerFee;
        return cost * feeRate;
    }

    // For Predict, use price-based fee if price is provided
    if (platform === 'predict' && price !== undefined) {
        if (isMaker) return 0;
        const feeRate = getPredictTakerFeeRate(price, false);
        return cost * feeRate;
    }

    // Fallback to simple fee structure
    const platformFees = fees[platform];
    const feeRate = isMaker ? platformFees.makerFee : platformFees.takerFee;
    return cost * feeRate;
}

/**
 * Calculate total fees for all legs
 */
export function calculateTotalFees(legs: ArbitrageLeg[], fees: FeeStructure): number {
    return legs.reduce((total, leg) => total + leg.fees, 0);
}

// ============================================================================
// Depth Analysis
// ============================================================================

/**
 * Calculate depth score (0-100) based on liquidity quality
 * Higher score = better liquidity
 */
export function calculateDepthScore(
    levels: OrderBookLevel[],
    targetQuantity: number
): number {
    if (levels.length === 0) return 0;

    let cumulativeQty = 0;
    let priceDeviation = 0;
    const basePrice = levels[0].price;

    for (const level of levels) {
        cumulativeQty += level.quantity;

        // Track how much price deviates as we go deeper
        const deviation = Math.abs(level.price - basePrice) / basePrice;
        priceDeviation = Math.max(priceDeviation, deviation);

        if (cumulativeQty >= targetQuantity) break;
    }

    // Score based on:
    // 1. Can we fill the target quantity? (50 points)
    const fillScore = Math.min(50, (cumulativeQty / targetQuantity) * 50);

    // 2. How tight is the price across levels? (30 points)
    // Lower deviation = higher score
    const tightnessScore = Math.max(0, 30 - (priceDeviation * 300));

    // 3. Number of levels available (20 points)
    const depthPoints = Math.min(20, levels.length * 2);

    return Math.round(fillScore + tightnessScore + depthPoints);
}

// ============================================================================
// Spread Analysis
// ============================================================================

/**
 * Calculate bid-ask spread
 */
export function calculateSpread(
    bids: OrderBookLevel[],
    asks: OrderBookLevel[]
): { bidPrice: number; askPrice: number; spread: number; spreadPercent: number } {
    const bidPrice = bids.length > 0 ? bids[0].price : 0;
    const askPrice = asks.length > 0 ? asks[0].price : 0;
    const spread = askPrice - bidPrice;
    const midPrice = (bidPrice + askPrice) / 2;
    const spreadPercent = midPrice > 0 ? spread / midPrice : 0;

    return { bidPrice, askPrice, spread, spreadPercent };
}

/**
 * Calculate mid-price
 */
export function calculateMidPrice(bids: OrderBookLevel[], asks: OrderBookLevel[]): number {
    const bidPrice = bids.length > 0 ? bids[0].price : 0;
    const askPrice = asks.length > 0 ? asks[0].price : 0;

    if (bidPrice === 0 && askPrice === 0) return 0;
    if (bidPrice === 0) return askPrice;
    if (askPrice === 0) return bidPrice;

    return (bidPrice + askPrice) / 2;
}

// ============================================================================
// Binary Market Calculations
// ============================================================================

/**
 * For binary markets, calculate the implied probability
 * Given YES and NO prices
 */
export function calculateImpliedProbability(
    yesPrice: number,
    noPrice: number
): { yesProbability: number; noProbability: number; overround: number } {
    const total = yesPrice + noPrice;
    const yesProbability = total > 0 ? yesPrice / total : 0;
    const noProbability = total > 0 ? noPrice / total : 0;
    const overround = total - 1; // Positive = edge for house, Negative = edge for us

    return { yesProbability, noProbability, overround };
}

/**
 * Check if buying YES + NO on the same platform is profitable
 * Return: negative = profitable (we pay less than 1)
 */
export function calculateSamePlatformBinaryArb(
    yesAskPrice: number,
    noAskPrice: number
): { totalCost: number; profit: number; profitPercent: number } {
    const totalCost = yesAskPrice + noAskPrice;
    const profit = 1 - totalCost; // Guaranteed payout is 1
    const profitPercent = profit / totalCost;

    return { totalCost, profit, profitPercent };
}

/**
 * Check cross-platform binary arbitrage
 * Buy YES on one platform, buy NO on another
 */
export function calculateCrossPlatformBinaryArb(
    platform1YesAsk: number,
    platform2NoAsk: number
): { totalCost: number; profit: number; profitPercent: number };
export function calculateCrossPlatformBinaryArb(
    platform1: { yesAsk: number; noAsk: number },
    platform2: { yesAsk: number; noAsk: number }
): {
    bestStrategy: 'yes1_no2' | 'no1_yes2' | 'none';
    totalCost: number;
    profit: number;
    profitPercent: number;
};
export function calculateCrossPlatformBinaryArb(
    arg1: number | { yesAsk: number; noAsk: number },
    arg2: number | { yesAsk: number; noAsk: number }
): { totalCost: number; profit: number; profitPercent: number; bestStrategy?: string } {
    if (typeof arg1 === 'number' && typeof arg2 === 'number') {
        const totalCost = arg1 + arg2;
        const profit = 1 - totalCost;
        const profitPercent = profit / totalCost;
        return { totalCost, profit, profitPercent };
    }

    const p1 = arg1 as { yesAsk: number; noAsk: number };
    const p2 = arg2 as { yesAsk: number; noAsk: number };

    // Strategy 1: Buy YES on platform1, buy NO on platform2
    const cost1 = p1.yesAsk + p2.noAsk;
    const profit1 = 1 - cost1;

    // Strategy 2: Buy NO on platform1, buy YES on platform2
    const cost2 = p1.noAsk + p2.yesAsk;
    const profit2 = 1 - cost2;

    if (profit1 > profit2 && profit1 > 0) {
        return { bestStrategy: 'yes1_no2', totalCost: cost1, profit: profit1, profitPercent: profit1 / cost1 };
    } else if (profit2 > 0) {
        return { bestStrategy: 'no1_yes2', totalCost: cost2, profit: profit2, profitPercent: profit2 / cost2 };
    }

    return { bestStrategy: 'none', totalCost: 0, profit: 0, profitPercent: 0 };
}

// ============================================================================
// Risk Calculations
// ============================================================================

/**
 * Calculate latency risk score (0-100)
 * Based on how stale the data is
 */
export function calculateLatencyRisk(
    polymarketLastUpdate: number,
    predictLastUpdate: number,
    maxAgeMs: number
): number {
    const now = Date.now();
    const polyAge = now - polymarketLastUpdate;
    const predictAge = now - predictLastUpdate;
    const maxAge = Math.max(polyAge, predictAge);

    if (maxAge >= maxAgeMs) return 100;
    return Math.round((maxAge / maxAgeMs) * 100);
}

/**
 * Estimate execution risk based on various factors
 */
export function estimateExecutionRisk(
    depthScore: number,
    latencyRisk: number,
    slippage: number,
    profitMargin: number
): { riskScore: number; isExecutable: boolean; reason?: string } {
    // Weight factors
    const depthWeight = 0.3;
    const latencyWeight = 0.3;
    const slippageWeight = 0.2;
    const marginWeight = 0.2;

    // Convert to risk scores (higher = worse)
    const depthRisk = 100 - depthScore;
    const slippageRisk = Math.min(100, slippage * 1000); // 10% slippage = 100 risk
    const marginRisk = profitMargin < 0.005 ? 80 : profitMargin < 0.01 ? 50 : 20;

    const riskScore = Math.round(
        depthRisk * depthWeight +
        latencyRisk * latencyWeight +
        slippageRisk * slippageWeight +
        marginRisk * marginWeight
    );

    let isExecutable = true;
    let reason: string | undefined;

    if (riskScore > 70) {
        isExecutable = false;
        reason = 'Risk score too high';
    } else if (depthScore < 20) {
        isExecutable = false;
        reason = 'Insufficient liquidity';
    } else if (latencyRisk > 80) {
        isExecutable = false;
        reason = 'Data too stale';
    } else if (slippage > 0.05) {
        isExecutable = false;
        reason = 'Slippage too high';
    }

    return { riskScore, isExecutable, reason };
}

// ============================================================================
// Position Sizing
// ============================================================================

/**
 * Calculate optimal position size based on Kelly Criterion
 * Simplified version for binary outcomes
 */
export function calculateKellySize(
    winProbability: number,
    winPayoff: number,
    lossPortion: number = 1,
    kellyFraction: number = 0.25  // Use quarter-Kelly for safety
): number {
    if (winProbability <= 0 || winPayoff <= 0) return 0;

    // Kelly formula: (bp - q) / b
    // where b = odds received on the bet
    // p = probability of winning
    // q = probability of losing (1 - p)
    const b = winPayoff / lossPortion;
    const p = winProbability;
    const q = 1 - p;

    const kellyBet = (b * p - q) / b;

    // Apply fraction and ensure non-negative
    return Math.max(0, kellyBet * kellyFraction);
}

/**
 * Calculate position size based on risk limits
 */
export function calculatePositionSize(
    availableLiquidity: number,
    maxPositionSize: number,
    minPositionSize: number,
    profitPercent: number,
    riskScore: number
): number {
    // Start with available liquidity
    let size = availableLiquidity;

    // Cap at max position size
    size = Math.min(size, maxPositionSize);

    // Reduce based on risk score
    const riskMultiplier = Math.max(0.1, 1 - (riskScore / 100));
    size *= riskMultiplier;

    // Increase for higher profit opportunities
    if (profitPercent > 0.02) {
        size *= 1.2; // 20% boost for good opportunities
    }

    // Ensure minimum
    if (size < minPositionSize) {
        return 0; // Not worth executing
    }

    return Math.round(size * 100) / 100; // Round to 2 decimals
}
