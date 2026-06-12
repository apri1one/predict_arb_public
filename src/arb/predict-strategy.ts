/**
 * Predict Market Strategy
 * 
 * Specialized strategies for Predict.fun markets:
 * 
 * 1. **Binary Arbitrage** - Buy YES + NO when total < 1
 * 2. **Price Discovery** - Use Polymarket prices as reference signals
 * 3. **Market Making** - Provide liquidity with smart pricing
 * 4. **Momentum Trading** - Trade on price movements
 * 
 * NOTE: Polymarket is used as a REFERENCE for price discovery,
 *       but actual trading happens on Predict only.
 */

import type {
    OrderBookLevel,
    FeeStructure,
} from './types.js';

import {
    calculateAverageFillPrice,
    calculateDepthScore,
    calculateSpread,
    calculateMidPrice,
    calculateSamePlatformBinaryArb,
    calculateKellySize,
    calculatePositionSize,
    calculateTradingFee,
} from './calculator.js';

// ============================================================================
// Types
// ============================================================================

export interface PredictOrderBook {
    marketId: number;
    yesBids: OrderBookLevel[];
    yesAsks: OrderBookLevel[];
    noBids: OrderBookLevel[];
    noAsks: OrderBookLevel[];
    lastUpdate: number;
}

export interface PolymarketReference {
    yesPrice: number;        // Polymarket YES mid-price
    noPrice: number;         // Polymarket NO mid-price (1 - YES)
    spread: number;          // Polymarket spread
    volume24h?: number;      // 24h volume for confidence
    lastUpdate: number;
}

export interface TradeSignal {
    type: 'BUY' | 'SELL' | 'HOLD';
    side: 'YES' | 'NO';
    confidence: number;      // 0-100
    targetPrice: number;
    quantity: number;
    reason: string;
    urgency: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface StrategyResult {
    signals: TradeSignal[];
    opportunities: PredictOpportunity[];
    marketAnalysis: MarketAnalysis;
}

export interface PredictOpportunity {
    id: string;
    type: 'binary_arb' | 'price_gap' | 'momentum' | 'market_making';
    side: 'YES' | 'NO' | 'BOTH';
    action: 'BUY' | 'SELL' | 'PROVIDE_LIQUIDITY';

    // Pricing
    currentPrice: number;
    targetPrice: number;
    fairValue: number;        // Based on Polymarket reference

    // Profitability
    expectedProfit: number;
    expectedProfitPercent: number;

    // Sizing
    recommendedQuantity: number;
    maxQuantity: number;

    // Risk
    riskScore: number;
    confidence: number;

    // Details
    reason: string;
    expiresAt: number;
}

export interface MarketAnalysis {
    marketId: number;

    // Pricing
    predictYesMid: number;
    predictNoMid: number;
    polymarketYesMid: number | null;

    // Spreads
    predictYesSpread: number;
    predictNoSpread: number;

    // Price gap (if reference available)
    priceGap: number | null;          // Predict - Polymarket
    priceGapPercent: number | null;

    // Implied probability
    predictYesProbability: number;
    polymarketYesProbability: number | null;

    // Binary arb opportunity
    binaryArbProfit: number;
    hasBinaryArb: boolean;

    // Liquidity
    yesDepthScore: number;
    noDepthScore: number;

    // Timestamp
    analysisTime: number;
}

export interface StrategyConfig {
    // Binary arbitrage
    minBinaryArbProfit: number;       // Min profit % (default: 0.3%)

    // Price gap trading
    minPriceGap: number;              // Min gap vs Polymarket (default: 2%)
    priceGapConfidenceThreshold: number; // Min confidence (default: 60)

    // Market making
    targetSpread: number;             // Target bid-ask spread (default: 2%)
    maxInventory: number;             // Max position per side

    // Position sizing
    maxPositionSize: number;          // Max $ per trade
    minPositionSize: number;          // Min $ per trade
    kellyFraction: number;            // Kelly criterion fraction (default: 0.25)

    // Risk
    maxExposure: number;              // Max total exposure
    stopLossPercent: number;          // Stop loss threshold

    // Fees
    fees: FeeStructure;

    // Reference age
    maxReferenceAgeMs: number;        // Max age for Polymarket reference
}

const DEFAULT_CONFIG: StrategyConfig = {
    minBinaryArbProfit: 0.003,
    minPriceGap: 0.02,
    priceGapConfidenceThreshold: 60,
    targetSpread: 0.02,
    maxInventory: 1000,
    maxPositionSize: 500,
    minPositionSize: 10,
    kellyFraction: 0.25,
    maxExposure: 5000,
    stopLossPercent: 0.1,
    fees: {
        polymarket: { makerFee: 0, takerFee: 0 },
        predict: { makerFee: 0.001, takerFee: 0.002 },
    },
    maxReferenceAgeMs: 30000,  // 30 seconds
};

// ============================================================================
// Strategy Class
// ============================================================================

export class PredictStrategy {
    private config: StrategyConfig;
    private referenceCache: Map<number, PolymarketReference> = new Map();

    constructor(config: Partial<StrategyConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    // ============================================================================
    // Reference Data
    // ============================================================================

    /**
     * Update Polymarket reference price for a market
     * This is used for price discovery, not trading
     */
    updateReference(marketId: number, reference: PolymarketReference): void {
        this.referenceCache.set(marketId, reference);
    }

    /**
     * Get reference price (if not stale)
     */
    getReference(marketId: number): PolymarketReference | null {
        const ref = this.referenceCache.get(marketId);
        if (!ref) return null;

        const age = Date.now() - ref.lastUpdate;
        if (age > this.config.maxReferenceAgeMs) {
            return null; // Too old, don't use
        }

        return ref;
    }

    // ============================================================================
    // Main Analysis
    // ============================================================================

    /**
     * Analyze a Predict market and generate trading signals
     */
    analyze(book: PredictOrderBook, reference?: PolymarketReference): StrategyResult {
        // Update reference if provided
        if (reference) {
            this.updateReference(book.marketId, reference);
        }

        const ref = this.getReference(book.marketId);

        // Perform market analysis
        const analysis = this.analyzeMarket(book, ref);

        // Generate opportunities
        const opportunities: PredictOpportunity[] = [];

        // 1. Check binary arbitrage (YES + NO < 1)
        const binaryArb = this.findBinaryArbitrage(book, analysis);
        if (binaryArb) opportunities.push(binaryArb);

        // 2. Check price gap (vs Polymarket)
        if (ref) {
            const priceGap = this.findPriceGapOpportunity(book, analysis, ref);
            if (priceGap) opportunities.push(priceGap);
        }

        // 3. Market making opportunities
        const mmOpps = this.findMarketMakingOpportunities(book, analysis, ref);
        opportunities.push(...mmOpps);

        // Generate trade signals
        const signals = this.generateSignals(opportunities, analysis);

        return {
            signals,
            opportunities,
            marketAnalysis: analysis,
        };
    }

    // ============================================================================
    // Market Analysis
    // ============================================================================

    private analyzeMarket(book: PredictOrderBook, ref: PolymarketReference | null): MarketAnalysis {
        // Calculate Predict prices
        const yesSpreadInfo = calculateSpread(book.yesBids, book.yesAsks);
        const noSpreadInfo = calculateSpread(book.noBids, book.noAsks);

        const predictYesMid = calculateMidPrice(book.yesBids, book.yesAsks);
        const predictNoMid = calculateMidPrice(book.noBids, book.noAsks);

        // Calculate binary arb
        const yesAsk = book.yesAsks.length > 0 ? book.yesAsks[0].price : 1;
        const noAsk = book.noAsks.length > 0 ? book.noAsks[0].price : 1;
        const { profit: binaryArbProfit, profitPercent: binaryArbPercent } =
            calculateSamePlatformBinaryArb(yesAsk, noAsk);

        // Calculate reference gap
        let priceGap: number | null = null;
        let priceGapPercent: number | null = null;

        if (ref) {
            priceGap = predictYesMid - ref.yesPrice;
            priceGapPercent = ref.yesPrice > 0 ? priceGap / ref.yesPrice : null;
        }

        // Depth scores
        const targetQty = this.config.minPositionSize * 10; // Use 10x min as reference
        const yesDepthScore = Math.min(
            calculateDepthScore(book.yesBids, targetQty),
            calculateDepthScore(book.yesAsks, targetQty)
        );
        const noDepthScore = Math.min(
            calculateDepthScore(book.noBids, targetQty),
            calculateDepthScore(book.noAsks, targetQty)
        );

        return {
            marketId: book.marketId,
            predictYesMid,
            predictNoMid,
            polymarketYesMid: ref?.yesPrice ?? null,
            predictYesSpread: yesSpreadInfo.spreadPercent,
            predictNoSpread: noSpreadInfo.spreadPercent,
            priceGap,
            priceGapPercent,
            predictYesProbability: predictYesMid,
            polymarketYesProbability: ref?.yesPrice ?? null,
            binaryArbProfit,
            hasBinaryArb: binaryArbProfit > 0 && binaryArbPercent >= this.config.minBinaryArbProfit,
            yesDepthScore,
            noDepthScore,
            analysisTime: Date.now(),
        };
    }

    // ============================================================================
    // Strategy: Binary Arbitrage
    // ============================================================================

    /**
     * Find binary arbitrage: Buy YES + NO when combined cost < 1
     */
    private findBinaryArbitrage(book: PredictOrderBook, analysis: MarketAnalysis): PredictOpportunity | null {
        if (!analysis.hasBinaryArb) return null;

        const yesAsk = book.yesAsks[0];
        const noAsk = book.noAsks[0];

        if (!yesAsk || !noAsk) return null;

        // Calculate max quantity
        const maxQty = Math.min(yesAsk.quantity, noAsk.quantity);

        // Size the position
        const profitPercent = analysis.binaryArbProfit / (yesAsk.price + noAsk.price);
        const recommendedQty = calculatePositionSize(
            maxQty,
            this.config.maxPositionSize,
            this.config.minPositionSize,
            profitPercent,
            0
        );

        if (recommendedQty <= 0) return null;

        // Calculate expected profit
        const totalCost = (yesAsk.price + noAsk.price) * recommendedQty;
        const fees = calculateTradingFee(totalCost, 'predict', false, this.config.fees);
        const expectedProfit = (recommendedQty * 1) - totalCost - fees; // Payout is 1 per share

        if (expectedProfit < 0) return null;

        return {
            id: `binary_${book.marketId}_${Date.now()}`,
            type: 'binary_arb',
            side: 'BOTH',
            action: 'BUY',
            currentPrice: yesAsk.price + noAsk.price,
            targetPrice: 1,  // Guaranteed payout
            fairValue: 1,
            expectedProfit,
            expectedProfitPercent: expectedProfit / totalCost,
            recommendedQuantity: recommendedQty,
            maxQuantity: maxQty,
            riskScore: 10,  // Very low risk - guaranteed profit
            confidence: 95,
            reason: `Binary arbitrage: Buy YES@${yesAsk.price.toFixed(3)} + NO@${noAsk.price.toFixed(3)} = ${(yesAsk.price + noAsk.price).toFixed(3)} < 1`,
            expiresAt: Date.now() + 5000,
        };
    }

    // ============================================================================
    // Strategy: Price Gap (vs Polymarket)
    // ============================================================================

    /**
     * Find price gap opportunities using Polymarket as reference
     * If Predict price is too low vs Polymarket -> BUY
     * If Predict price is too high vs Polymarket -> SELL
     */
    private findPriceGapOpportunity(
        book: PredictOrderBook,
        analysis: MarketAnalysis,
        ref: PolymarketReference
    ): PredictOpportunity | null {
        if (analysis.priceGapPercent === null) return null;

        const gapPercent = Math.abs(analysis.priceGapPercent);
        if (gapPercent < this.config.minPriceGap) return null;

        // Determine direction
        const predictUnderpriced = analysis.priceGap! < 0;  // Predict < Polymarket
        const side: 'YES' | 'NO' = predictUnderpriced ? 'YES' : 'NO';
        const action: 'BUY' | 'SELL' = predictUnderpriced ? 'BUY' : 'SELL';

        // Get relevant order book side
        const levels = predictUnderpriced ? book.yesAsks : book.yesBids;
        if (levels.length === 0) return null;

        // Calculate confidence based on:
        // 1. Gap size (bigger = more confident)
        // 2. Reference volume (higher = more confident)
        // 3. Time since reference update (fresher = more confident)
        const gapConfidence = Math.min(100, gapPercent * 100 * 5);  // 20% gap = 100 confidence
        const volumeConfidence = ref.volume24h ? Math.min(50, ref.volume24h / 10000) : 30;
        const ageMs = Date.now() - ref.lastUpdate;
        const freshnessConfidence = Math.max(0, 50 - (ageMs / 1000));

        const confidence = Math.round((gapConfidence + volumeConfidence + freshnessConfidence) / 3);

        if (confidence < this.config.priceGapConfidenceThreshold) return null;

        // Calculate position size using Kelly
        const winProbability = confidence / 100;
        const kellySize = calculateKellySize(
            winProbability,
            gapPercent,  // Payoff is the gap we expect to close
            0.5,         // Assume 50% loss if wrong
            this.config.kellyFraction
        );

        const maxQty = levels[0].quantity;
        const recommendedQty = Math.min(
            maxQty * kellySize,
            this.config.maxPositionSize / levels[0].price
        );

        if (recommendedQty < this.config.minPositionSize / levels[0].price) return null;

        const cost = recommendedQty * levels[0].price;
        const expectedProfit = cost * gapPercent;

        return {
            id: `gap_${book.marketId}_${side}_${Date.now()}`,
            type: 'price_gap',
            side,
            action,
            currentPrice: levels[0].price,
            targetPrice: ref.yesPrice,
            fairValue: ref.yesPrice,
            expectedProfit,
            expectedProfitPercent: gapPercent,
            recommendedQuantity: recommendedQty,
            maxQuantity: maxQty,
            riskScore: 100 - confidence,
            confidence,
            reason: `Price gap: Predict ${side}@${levels[0].price.toFixed(3)} vs Polymarket@${ref.yesPrice.toFixed(3)} (${(gapPercent * 100).toFixed(1)}% gap)`,
            expiresAt: Date.now() + 10000,
        };
    }

    // ============================================================================
    // Strategy: Market Making
    // ============================================================================

    /**
     * Find market making opportunities by providing liquidity
     * Quote wider than competitors but tighter than current spread
     */
    private findMarketMakingOpportunities(
        book: PredictOrderBook,
        analysis: MarketAnalysis,
        ref: PolymarketReference | null
    ): PredictOpportunity[] {
        const opportunities: PredictOpportunity[] = [];

        // Use reference price as fair value if available
        const fairValue = ref?.yesPrice ?? analysis.predictYesMid;

        // Check if spread is wide enough to make money
        const currentSpread = analysis.predictYesSpread;
        if (currentSpread < this.config.targetSpread * 1.5) {
            // Spread too tight for market making
            return opportunities;
        }

        // Calculate quote prices
        const halfSpread = this.config.targetSpread / 2;
        const quoteBid = fairValue - halfSpread;
        const quoteAsk = fairValue + halfSpread;

        // Check if our quotes would be competitive
        const currentBestBid = book.yesBids.length > 0 ? book.yesBids[0].price : 0;
        const currentBestAsk = book.yesAsks.length > 0 ? book.yesAsks[0].price : 1;

        // Provide liquidity on bid side if profitable
        if (quoteBid > currentBestBid && quoteBid < fairValue) {
            const expectedProfit = (fairValue - quoteBid) * this.config.minPositionSize;

            opportunities.push({
                id: `mm_bid_${book.marketId}_${Date.now()}`,
                type: 'market_making',
                side: 'YES',
                action: 'PROVIDE_LIQUIDITY',
                currentPrice: currentBestBid,
                targetPrice: quoteBid,
                fairValue,
                expectedProfit,
                expectedProfitPercent: fairValue > 0 ? (fairValue - quoteBid) / quoteBid : 0,
                recommendedQuantity: this.config.minPositionSize,
                maxQuantity: this.config.maxInventory,
                riskScore: 40,
                confidence: 60,
                reason: `Market making: Quote BID@${quoteBid.toFixed(3)} (fair value: ${fairValue.toFixed(3)})`,
                expiresAt: Date.now() + 30000,
            });
        }

        // Provide liquidity on ask side if profitable
        if (quoteAsk < currentBestAsk && quoteAsk > fairValue) {
            const expectedProfit = (quoteAsk - fairValue) * this.config.minPositionSize;

            opportunities.push({
                id: `mm_ask_${book.marketId}_${Date.now()}`,
                type: 'market_making',
                side: 'YES',
                action: 'PROVIDE_LIQUIDITY',
                currentPrice: currentBestAsk,
                targetPrice: quoteAsk,
                fairValue,
                expectedProfit,
                expectedProfitPercent: quoteAsk > 0 ? (quoteAsk - fairValue) / quoteAsk : 0,
                recommendedQuantity: this.config.minPositionSize,
                maxQuantity: this.config.maxInventory,
                riskScore: 40,
                confidence: 60,
                reason: `Market making: Quote ASK@${quoteAsk.toFixed(3)} (fair value: ${fairValue.toFixed(3)})`,
                expiresAt: Date.now() + 30000,
            });
        }

        return opportunities;
    }

    // ============================================================================
    // Signal Generation
    // ============================================================================

    private generateSignals(opportunities: PredictOpportunity[], analysis: MarketAnalysis): TradeSignal[] {
        const signals: TradeSignal[] = [];

        // Sort by expected profit
        const sortedOpps = [...opportunities].sort((a, b) => b.expectedProfit - a.expectedProfit);

        for (const opp of sortedOpps) {
            if (opp.expectedProfit <= 0) continue;

            // Convert to trade signal
            let signalType: 'BUY' | 'SELL' | 'HOLD';

            if (opp.action === 'BUY') {
                signalType = 'BUY';
            } else if (opp.action === 'SELL') {
                signalType = 'SELL';
            } else {
                // Market making - depends on current inventory
                signalType = 'HOLD'; // Would need inventory tracking
            }

            const urgency: 'LOW' | 'MEDIUM' | 'HIGH' =
                opp.type === 'binary_arb' ? 'HIGH' :
                    opp.confidence > 80 ? 'HIGH' :
                        opp.confidence > 60 ? 'MEDIUM' : 'LOW';

            signals.push({
                type: signalType,
                side: opp.side === 'BOTH' ? 'YES' : opp.side, // For binary arb, report YES side
                confidence: opp.confidence,
                targetPrice: opp.targetPrice,
                quantity: opp.recommendedQuantity,
                reason: opp.reason,
                urgency,
            });
        }

        return signals;
    }

    // ============================================================================
    // Configuration
    // ============================================================================

    updateConfig(config: Partial<StrategyConfig>): void {
        this.config = { ...this.config, ...config };
    }

    getConfig(): StrategyConfig {
        return { ...this.config };
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createPredictStrategy(config?: Partial<StrategyConfig>): PredictStrategy {
    return new PredictStrategy(config);
}
