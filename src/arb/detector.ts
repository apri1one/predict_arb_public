/**
 * Arbitrage Detector
 * 
 * Main arbitrage detection engine that:
 * 1. Monitors order books from both platforms
 * 2. Detects various types of arbitrage opportunities
 * 3. Calculates profitability including fees and slippage
 * 4. Filters based on risk and size constraints
 * 5. Emits executable opportunities
 */

import type {
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

import {
    calculateAverageFillPrice,
    calculateSlippage,
    calculateDepthScore,
    calculateMidPrice,
    calculateSamePlatformBinaryArb,
    calculateCrossPlatformBinaryArb,
    calculateLatencyRisk,
    estimateExecutionRisk,
    calculatePositionSize,
    calculateTradingFee,
} from './calculator.js';

// Default configuration
const DEFAULT_CONFIG: ArbitrageConfig = {
    minNetProfitPercent: 0.005,      // 0.5% minimum
    minNetProfitAbsolute: 1,         // $1 minimum
    maxSlippagePercent: 0.01,        // 1% max slippage
    minDepthScore: 30,               // Minimum liquidity score
    maxLatencyRiskMs: 500,           // 500ms max data age
    maxPositionSize: 1000,           // $1000 max per trade
    minPositionSize: 10,             // $10 minimum
    opportunityValidityMs: 5000,     // 5 second validity
    fees: {
        polymarket: { makerFee: 0, takerFee: 0 },       // Polymarket has 0% fees currently
        predict: { makerFee: 0.001, takerFee: 0.002 },  // 0.1% maker, 0.2% taker
    },
};

// Generate unique opportunity ID
let opportunityCounter = 0;
function generateOpportunityId(): string {
    return `arb_${Date.now()}_${++opportunityCounter}`;
}

export class ArbitrageDetector {
    private config: ArbitrageConfig;
    private callbacks: ArbitrageCallback[] = [];

    // Track active opportunities
    private activeOpportunities: Map<string, ArbitrageOpportunity> = new Map();

    // Market pair data
    private marketBooks: Map<string, UnifiedMarketBook> = new Map();

    constructor(config: Partial<ArbitrageConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };

        // Merge fee structure
        if (config.fees) {
            this.config.fees = {
                polymarket: { ...DEFAULT_CONFIG.fees.polymarket, ...config.fees.polymarket },
                predict: { ...DEFAULT_CONFIG.fees.predict, ...config.fees.predict },
            };
        }
    }

    // ============================================================================
    // Event Handling
    // ============================================================================

    /**
     * Register callback for arbitrage events
     */
    onEvent(callback: ArbitrageCallback): void {
        this.callbacks.push(callback);
    }

    /**
     * Remove callback
     */
    offEvent(callback: ArbitrageCallback): void {
        const index = this.callbacks.indexOf(callback);
        if (index !== -1) {
            this.callbacks.splice(index, 1);
        }
    }

    private emit(event: ArbitrageEvent): void {
        for (const callback of this.callbacks) {
            try {
                callback(event);
            } catch (error) {
                console.error('[ArbitrageDetector] Callback error:', error);
            }
        }
    }

    // ============================================================================
    // Market Data Management
    // ============================================================================

    /**
     * Update order book data for a market pair
     */
    updateMarketBook(
        pairId: string,
        platform: 'polymarket' | 'predict',
        yesBook: { bids: [number, number][]; asks: [number, number][] },
        noBook?: { bids: [number, number][]; asks: [number, number][] }
    ): void {
        let marketBook = this.marketBooks.get(pairId);

        if (!marketBook) {
            marketBook = { polymarket: null, predict: null };
            this.marketBooks.set(pairId, marketBook);
        }

        // Convert to OrderBookLevel format
        const toLevel = (levels: [number, number][]): OrderBookLevel[] =>
            levels.map(([price, quantity]) => ({ price, quantity, platform }));

        // For binary markets, NO prices are derived: NO = 1 - YES
        const deriveNo = (yesBids: [number, number][], yesAsks: [number, number][]): {
            noBids: [number, number][];
            noAsks: [number, number][];
        } => ({
            // YES bid = NO ask (at 1 - price)
            noAsks: yesBids.map(([p, q]) => [1 - p, q] as [number, number]),
            // YES ask = NO bid (at 1 - price)
            noBids: yesAsks.map(([p, q]) => [1 - p, q] as [number, number]),
        });

        const derived = noBook ? null : deriveNo(yesBook.bids, yesBook.asks);

        marketBook[platform] = {
            yesBids: toLevel(yesBook.bids),
            yesAsks: toLevel(yesBook.asks),
            noBids: noBook ? toLevel(noBook.bids) : toLevel(derived!.noBids),
            noAsks: noBook ? toLevel(noBook.asks) : toLevel(derived!.noAsks),
            lastUpdate: Date.now(),
        };

        // Trigger detection
        this.detectArbitrage(pairId);

        this.emit({ type: 'market_update', timestamp: Date.now() });
    }

    /**
     * Get current market book for a pair
     */
    getMarketBook(pairId: string): UnifiedMarketBook | undefined {
        return this.marketBooks.get(pairId);
    }

    // ============================================================================
    // Arbitrage Detection
    // ============================================================================

    /**
     * Main detection entry point
     */
    detectArbitrage(pairId: string): void {
        const book = this.marketBooks.get(pairId);
        if (!book) return;

        const opportunities: ArbitrageOpportunity[] = [];

        // 1. Same-platform binary arbitrage
        if (book.polymarket) {
            const opp = this.detectSamePlatformBinaryArb(pairId, 'polymarket', book.polymarket);
            if (opp) opportunities.push(opp);
        }
        if (book.predict) {
            const opp = this.detectSamePlatformBinaryArb(pairId, 'predict', book.predict);
            if (opp) opportunities.push(opp);
        }

        // 2. Cross-platform binary arbitrage
        if (book.polymarket && book.predict) {
            const opp = this.detectCrossPlatformBinaryArb(pairId, book);
            if (opp) opportunities.push(opp);
        }

        // 3. Cross-platform same-side arbitrage
        if (book.polymarket && book.predict) {
            const yesOpp = this.detectCrossPlatformSamesSideArb(pairId, 'YES', book);
            if (yesOpp) opportunities.push(yesOpp);

            const noOpp = this.detectCrossPlatformSamesSideArb(pairId, 'NO', book);
            if (noOpp) opportunities.push(noOpp);
        }

        // Process and emit valid opportunities
        for (const opp of opportunities) {
            if (opp.isExecutable && opp.netProfit > 0) {
                this.processOpportunity(opp);
            }
        }

        // Clean up expired opportunities
        this.cleanupExpiredOpportunities();
    }

    // ============================================================================
    // Detection Strategies
    // ============================================================================

    /**
     * Detect same-platform binary arbitrage (YES + NO < 1)
     */
    private detectSamePlatformBinaryArb(
        pairId: string,
        platform: 'polymarket' | 'predict',
        book: NonNullable<UnifiedMarketBook['polymarket']>
    ): ArbitrageOpportunity | null {
        if (book.yesAsks.length === 0 || book.noAsks.length === 0) {
            return null;
        }

        const yesBestAsk = book.yesAsks[0];
        const noBestAsk = book.noAsks[0];

        // Calculate basic profitability
        const { totalCost, profit, profitPercent } = calculateSamePlatformBinaryArb(
            yesBestAsk.price,
            noBestAsk.price
        );

        if (profit <= 0) return null;

        // Calculate quantity limited by both sides
        const maxQty = Math.min(yesBestAsk.quantity, noBestAsk.quantity);

        // Size the position
        const targetQty = calculatePositionSize(
            maxQty,
            this.config.maxPositionSize,
            this.config.minPositionSize,
            profitPercent,
            0 // Will calculate risk below
        );

        if (targetQty <= 0) return null;

        // Calculate actual fill with depth
        const yesFill = calculateAverageFillPrice(book.yesAsks, targetQty, true);
        const noFill = calculateAverageFillPrice(book.noAsks, targetQty, true);

        // Calculate fees
        const yesFee = calculateTradingFee(yesFill.totalCost, platform, false, this.config.fees);
        const noFee = calculateTradingFee(noFill.totalCost, platform, false, this.config.fees);
        const totalFees = yesFee + noFee;

        // Calculate actual profit
        const actualCost = yesFill.totalCost + noFill.totalCost + totalFees;
        const payout = Math.min(yesFill.filledQty, noFill.filledQty); // Guaranteed payout
        const grossProfit = payout - (yesFill.totalCost + noFill.totalCost);
        const netProfit = payout - actualCost;
        const netProfitPercent = netProfit / actualCost;

        // Check thresholds
        if (netProfitPercent < this.config.minNetProfitPercent) return null;
        if (netProfit < this.config.minNetProfitAbsolute) return null;

        // Calculate risk metrics
        const depthScore = Math.min(
            calculateDepthScore(book.yesAsks, targetQty),
            calculateDepthScore(book.noAsks, targetQty)
        );
        const latencyRisk = calculateLatencyRisk(book.lastUpdate, book.lastUpdate, this.config.maxLatencyRiskMs);
        const slippage = Math.max(
            calculateSlippage(yesBestAsk.price, yesFill.avgPrice),
            calculateSlippage(noBestAsk.price, noFill.avgPrice)
        );

        const { riskScore, isExecutable, reason } = estimateExecutionRisk(
            depthScore,
            latencyRisk,
            slippage,
            netProfitPercent
        );

        // Build legs
        const legs: ArbitrageLeg[] = [
            {
                platform,
                marketId: pairId,
                side: 'YES',
                action: 'BUY',
                price: yesFill.avgPrice,
                quantity: yesFill.filledQty,
                cost: yesFill.totalCost,
                fees: yesFee,
                levels: yesFill.levelsUsed,
            },
            {
                platform,
                marketId: pairId,
                side: 'NO',
                action: 'BUY',
                price: noFill.avgPrice,
                quantity: noFill.filledQty,
                cost: noFill.totalCost,
                fees: noFee,
                levels: noFill.levelsUsed,
            },
        ];

        return {
            id: generateOpportunityId(),
            type: 'same_platform_binary',
            legs,
            grossProfit,
            totalFees,
            netProfit,
            profitPercentage: netProfitPercent,
            roi: netProfitPercent * 100,
            maxQuantity: Math.min(yesFill.filledQty, noFill.filledQty),
            totalCost: actualCost,
            estimatedValue: payout,
            slippage,
            depthScore,
            latencyRisk,
            detectedAt: Date.now(),
            expiresAt: Date.now() + this.config.opportunityValidityMs,
            isExecutable,
            reason,
        };
    }

    /**
     * Detect cross-platform binary arbitrage
     * Buy YES on one platform, buy NO on other platform
     */
    private detectCrossPlatformBinaryArb(
        pairId: string,
        book: UnifiedMarketBook
    ): ArbitrageOpportunity | null {
        if (!book.polymarket || !book.predict) return null;
        if (book.polymarket.yesAsks.length === 0 || book.predict.yesAsks.length === 0) return null;
        if (book.polymarket.noAsks.length === 0 || book.predict.noAsks.length === 0) return null;

        // Find best combination
        const result = calculateCrossPlatformBinaryArb(
            { yesAsk: book.polymarket.yesAsks[0].price, noAsk: book.polymarket.noAsks[0].price },
            { yesAsk: book.predict.yesAsks[0].price, noAsk: book.predict.noAsks[0].price }
        );

        if (result.bestStrategy === 'none' || result.profit <= 0) return null;

        // Determine which platform for which side
        let yesPlatform: 'polymarket' | 'predict';
        let noPlatform: 'polymarket' | 'predict';

        if (result.bestStrategy === 'yes1_no2') {
            yesPlatform = 'polymarket';
            noPlatform = 'predict';
        } else {
            yesPlatform = 'predict';
            noPlatform = 'polymarket';
        }

        const yesBook = book[yesPlatform]!;
        const noBook = book[noPlatform]!;

        // Calculate quantity
        const maxQty = Math.min(
            yesBook.yesAsks[0].quantity,
            noBook.noAsks[0].quantity
        );

        const targetQty = calculatePositionSize(
            maxQty,
            this.config.maxPositionSize,
            this.config.minPositionSize,
            result.profitPercent,
            0
        );

        if (targetQty <= 0) return null;

        // Calculate fills
        const yesFill = calculateAverageFillPrice(yesBook.yesAsks, targetQty, true);
        const noFill = calculateAverageFillPrice(noBook.noAsks, targetQty, true);

        // Calculate fees
        const yesFee = calculateTradingFee(yesFill.totalCost, yesPlatform, false, this.config.fees);
        const noFee = calculateTradingFee(noFill.totalCost, noPlatform, false, this.config.fees);
        const totalFees = yesFee + noFee;

        // Calculate profits
        const actualCost = yesFill.totalCost + noFill.totalCost + totalFees;
        const payout = Math.min(yesFill.filledQty, noFill.filledQty);
        const grossProfit = payout - (yesFill.totalCost + noFill.totalCost);
        const netProfit = payout - actualCost;
        const netProfitPercent = netProfit / actualCost;

        if (netProfitPercent < this.config.minNetProfitPercent) return null;
        if (netProfit < this.config.minNetProfitAbsolute) return null;

        // Risk metrics
        const depthScore = Math.min(
            calculateDepthScore(yesBook.yesAsks, targetQty),
            calculateDepthScore(noBook.noAsks, targetQty)
        );
        const latencyRisk = calculateLatencyRisk(
            yesBook.lastUpdate,
            noBook.lastUpdate,
            this.config.maxLatencyRiskMs
        );
        const slippage = Math.max(
            calculateSlippage(yesBook.yesAsks[0].price, yesFill.avgPrice),
            calculateSlippage(noBook.noAsks[0].price, noFill.avgPrice)
        );

        const { riskScore, isExecutable, reason } = estimateExecutionRisk(
            depthScore,
            latencyRisk,
            slippage,
            netProfitPercent
        );

        const legs: ArbitrageLeg[] = [
            {
                platform: yesPlatform,
                marketId: pairId,
                side: 'YES',
                action: 'BUY',
                price: yesFill.avgPrice,
                quantity: yesFill.filledQty,
                cost: yesFill.totalCost,
                fees: yesFee,
                levels: yesFill.levelsUsed,
            },
            {
                platform: noPlatform,
                marketId: pairId,
                side: 'NO',
                action: 'BUY',
                price: noFill.avgPrice,
                quantity: noFill.filledQty,
                cost: noFill.totalCost,
                fees: noFee,
                levels: noFill.levelsUsed,
            },
        ];

        return {
            id: generateOpportunityId(),
            type: 'cross_platform_binary',
            legs,
            grossProfit,
            totalFees,
            netProfit,
            profitPercentage: netProfitPercent,
            roi: netProfitPercent * 100,
            maxQuantity: Math.min(yesFill.filledQty, noFill.filledQty),
            totalCost: actualCost,
            estimatedValue: payout,
            slippage,
            depthScore,
            latencyRisk,
            detectedAt: Date.now(),
            expiresAt: Date.now() + this.config.opportunityValidityMs,
            isExecutable,
            reason,
        };
    }

    /**
     * Detect cross-platform same-side arbitrage
     * Buy YES/NO on one platform (cheaper), sell on other (more expensive)
     */
    private detectCrossPlatformSamesSideArb(
        pairId: string,
        side: 'YES' | 'NO',
        book: UnifiedMarketBook
    ): ArbitrageOpportunity | null {
        if (!book.polymarket || !book.predict) return null;

        const polyAsks = side === 'YES' ? book.polymarket.yesAsks : book.polymarket.noAsks;
        const polyBids = side === 'YES' ? book.polymarket.yesBids : book.polymarket.noBids;
        const predAsks = side === 'YES' ? book.predict.yesAsks : book.predict.noAsks;
        const predBids = side === 'YES' ? book.predict.yesBids : book.predict.noBids;

        if (polyAsks.length === 0 || polyBids.length === 0) return null;
        if (predAsks.length === 0 || predBids.length === 0) return null;

        // Check both directions
        // Direction 1: Buy on Polymarket, Sell on Predict
        const spread1 = predBids[0].price - polyAsks[0].price;

        // Direction 2: Buy on Predict, Sell on Polymarket
        const spread2 = polyBids[0].price - predAsks[0].price;

        if (spread1 <= 0 && spread2 <= 0) return null;

        let buyPlatform: 'polymarket' | 'predict';
        let sellPlatform: 'polymarket' | 'predict';
        let buyAsks: OrderBookLevel[];
        let sellBids: OrderBookLevel[];
        let buyBook: NonNullable<UnifiedMarketBook['polymarket']>;
        let sellBook: NonNullable<UnifiedMarketBook['polymarket']>;

        if (spread1 > spread2) {
            buyPlatform = 'polymarket';
            sellPlatform = 'predict';
            buyAsks = polyAsks;
            sellBids = predBids;
            buyBook = book.polymarket;
            sellBook = book.predict;
        } else {
            buyPlatform = 'predict';
            sellPlatform = 'polymarket';
            buyAsks = predAsks;
            sellBids = polyBids;
            buyBook = book.predict;
            sellBook = book.polymarket;
        }

        const spread = Math.max(spread1, spread2);
        const profitPercent = spread / buyAsks[0].price;

        if (profitPercent < this.config.minNetProfitPercent) return null;

        // Calculate quantity
        const maxQty = Math.min(buyAsks[0].quantity, sellBids[0].quantity);
        const targetQty = calculatePositionSize(
            maxQty,
            this.config.maxPositionSize,
            this.config.minPositionSize,
            profitPercent,
            0
        );

        if (targetQty <= 0) return null;

        // Calculate fills
        const buyFill = calculateAverageFillPrice(buyAsks, targetQty, true);
        const sellFill = calculateAverageFillPrice(sellBids, targetQty, false);

        // Calculate fees
        const buyFee = calculateTradingFee(buyFill.totalCost, buyPlatform, false, this.config.fees);
        const sellFee = calculateTradingFee(sellFill.totalCost, sellPlatform, false, this.config.fees);
        const totalFees = buyFee + sellFee;

        // Calculate profits
        const grossProfit = sellFill.totalCost - buyFill.totalCost;
        const netProfit = grossProfit - totalFees;
        const netProfitPercent = netProfit / buyFill.totalCost;

        if (netProfitPercent < this.config.minNetProfitPercent) return null;
        if (netProfit < this.config.minNetProfitAbsolute) return null;

        // Risk metrics
        const depthScore = Math.min(
            calculateDepthScore(buyAsks, targetQty),
            calculateDepthScore(sellBids, targetQty)
        );
        const latencyRisk = calculateLatencyRisk(
            buyBook.lastUpdate,
            sellBook.lastUpdate,
            this.config.maxLatencyRiskMs
        );
        const slippage = Math.max(
            calculateSlippage(buyAsks[0].price, buyFill.avgPrice),
            calculateSlippage(sellBids[0].price, sellFill.avgPrice)
        );

        const { riskScore, isExecutable, reason } = estimateExecutionRisk(
            depthScore,
            latencyRisk,
            slippage,
            netProfitPercent
        );

        const legs: ArbitrageLeg[] = [
            {
                platform: buyPlatform,
                marketId: pairId,
                side,
                action: 'BUY',
                price: buyFill.avgPrice,
                quantity: buyFill.filledQty,
                cost: buyFill.totalCost,
                fees: buyFee,
                levels: buyFill.levelsUsed,
            },
            {
                platform: sellPlatform,
                marketId: pairId,
                side,
                action: 'SELL',
                price: sellFill.avgPrice,
                quantity: sellFill.filledQty,
                cost: sellFill.totalCost,
                fees: sellFee,
                levels: sellFill.levelsUsed,
            },
        ];

        return {
            id: generateOpportunityId(),
            type: side === 'YES' ? 'cross_platform_yes' : 'cross_platform_no',
            legs,
            grossProfit,
            totalFees,
            netProfit,
            profitPercentage: netProfitPercent,
            roi: netProfitPercent * 100,
            maxQuantity: Math.min(buyFill.filledQty, sellFill.filledQty),
            totalCost: buyFill.totalCost + buyFee,
            estimatedValue: sellFill.totalCost - sellFee,
            slippage,
            depthScore,
            latencyRisk,
            detectedAt: Date.now(),
            expiresAt: Date.now() + this.config.opportunityValidityMs,
            isExecutable,
            reason,
        };
    }

    // ============================================================================
    // Opportunity Management
    // ============================================================================

    private processOpportunity(opportunity: ArbitrageOpportunity): void {
        // Check if we already have this opportunity (similar characteristics)
        const existingKey = this.findSimilarOpportunity(opportunity);

        if (existingKey) {
            // Update existing opportunity
            this.activeOpportunities.set(existingKey, opportunity);
        } else {
            // New opportunity
            this.activeOpportunities.set(opportunity.id, opportunity);
            this.emit({
                type: 'opportunity_detected',
                opportunity,
                timestamp: Date.now(),
            });
        }
    }

    private findSimilarOpportunity(opp: ArbitrageOpportunity): string | null {
        for (const [key, existing] of this.activeOpportunities) {
            if (
                existing.type === opp.type &&
                existing.legs.length === opp.legs.length &&
                existing.legs[0].platform === opp.legs[0].platform &&
                existing.legs[0].side === opp.legs[0].side
            ) {
                return key;
            }
        }
        return null;
    }

    private cleanupExpiredOpportunities(): void {
        const now = Date.now();

        for (const [key, opp] of this.activeOpportunities) {
            if (now >= opp.expiresAt) {
                this.activeOpportunities.delete(key);
                this.emit({
                    type: 'opportunity_expired',
                    opportunity: opp,
                    timestamp: now,
                });
            }
        }
    }

    /**
     * Get all active opportunities
     */
    getActiveOpportunities(): ArbitrageOpportunity[] {
        this.cleanupExpiredOpportunities();
        return [...this.activeOpportunities.values()];
    }

    /**
     * Get best opportunity by profit
     */
    getBestOpportunity(): ArbitrageOpportunity | null {
        const opportunities = this.getActiveOpportunities()
            .filter(o => o.isExecutable)
            .sort((a, b) => b.netProfit - a.netProfit);

        return opportunities.length > 0 ? opportunities[0] : null;
    }

    /**
     * Mark opportunity as executed
     */
    markExecuted(opportunityId: string): void {
        const opp = this.activeOpportunities.get(opportunityId);
        if (opp) {
            this.activeOpportunities.delete(opportunityId);
            this.emit({
                type: 'opportunity_executed',
                opportunity: opp,
                timestamp: Date.now(),
            });
        }
    }

    // ============================================================================
    // Statistics
    // ============================================================================

    getStats(): {
        activeCount: number;
        executableCount: number;
        totalPotentialProfit: number;
        bestProfitPercent: number;
        marketPairsMonitored: number;
    } {
        const opportunities = this.getActiveOpportunities();
        const executable = opportunities.filter(o => o.isExecutable);

        return {
            activeCount: opportunities.length,
            executableCount: executable.length,
            totalPotentialProfit: executable.reduce((sum, o) => sum + o.netProfit, 0),
            bestProfitPercent: executable.length > 0
                ? Math.max(...executable.map(o => o.profitPercentage))
                : 0,
            marketPairsMonitored: this.marketBooks.size,
        };
    }
}

// ============================================================================
// Factory
// ============================================================================

export function createArbitrageDetector(config?: Partial<ArbitrageConfig>): ArbitrageDetector {
    return new ArbitrageDetector(config);
}
