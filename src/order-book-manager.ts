/**
 * Unified Order Book Manager
 * 
 * Aggregates and normalizes order book data from both Polymarket and Predict
 * Provides a unified interface for arbitrage detection
 */

import { PolymarketClient, type NormalizedOrderBook as PolymarketOrderBook } from './polymarket/index.js';
import { PredictClient, type NormalizedOrderBook as PredictOrderBook } from './predict/index.js';

// ============================================================================
// Types
// ============================================================================

export type Platform = 'polymarket' | 'predict';

export interface UnifiedOrderBook {
    platform: Platform;
    marketId: string;
    assetId: string;
    updateTimestampMs: number;
    yesAsks: [number, number][]; // [price, quantity] - sell YES
    yesBids: [number, number][]; // [price, quantity] - buy YES
    noAsks: [number, number][];  // [price, quantity] - sell NO (derived)
    noBids: [number, number][];  // [price, quantity] - buy NO (derived)
    bestYesBid: number | null;
    bestYesAsk: number | null;
    bestNoBid: number | null;
    bestNoAsk: number | null;
    yesSpread: number | null;
    noSpread: number | null;
}

export interface MarketPair {
    polymarketTokenId: string;  // Polymarket CLOB token ID
    predictMarketId: number;    // Predict market ID
    description?: string;
}

export interface ArbitrageOpportunity {
    type: 'yes_arb' | 'no_arb' | 'cross_arb';
    buyPlatform: Platform;
    sellPlatform: Platform;
    buyPrice: number;
    sellPrice: number;
    profit: number; // As percentage
    maxQuantity: number;
    estimatedValue: number;
    timestamp: number;
}

export type OrderBookUpdateCallback = (book: UnifiedOrderBook) => void;
export type ArbitrageCallback = (opportunity: ArbitrageOpportunity) => void;

// ============================================================================
// Manager Configuration
// ============================================================================

export interface OrderBookManagerConfig {
    // Polymarket config
    polymarketWsUrl?: string;

    // Predict config
    predictApiKey?: string;
    predictPollingInterval?: number;

    // Arbitrage detection
    minProfitThreshold?: number; // Minimum profit % to trigger (default: 0.5%)
    autoDetectArbitrage?: boolean;
}

// ============================================================================
// Unified Order Book Manager
// ============================================================================

export class OrderBookManager {
    private polymarket: PolymarketClient;
    private predict: PredictClient;

    // Unified order books cache
    private orderBooks: Map<string, UnifiedOrderBook> = new Map();

    // Market pair mappings
    private marketPairs: Map<string, MarketPair> = new Map();
    private polymarketToKey: Map<string, string> = new Map();
    private predictToKey: Map<number, string> = new Map();

    // Configuration
    private minProfitThreshold: number;
    private autoDetectArbitrage: boolean;

    // Callbacks
    private onOrderBookUpdate: OrderBookUpdateCallback | null = null;
    private onArbitrage: ArbitrageCallback | null = null;

    constructor(config: OrderBookManagerConfig = {}) {
        this.polymarket = new PolymarketClient({
            wsUrl: config.polymarketWsUrl,
        });

        this.predict = new PredictClient({
            apiKey: config.predictApiKey,
            pollingInterval: config.predictPollingInterval ?? 100,
        });

        this.minProfitThreshold = config.minProfitThreshold ?? 0.005; // 0.5%
        this.autoDetectArbitrage = config.autoDetectArbitrage ?? true;

        this.setupHandlers();
    }

    // ============================================================================
    // Setup
    // ============================================================================

    private setupHandlers(): void {
        // Polymarket WebSocket updates
        this.polymarket.setHandlers({
            onOrderBookUpdate: (book) => {
                const key = this.polymarketToKey.get(book.assetId);
                if (key) {
                    this.updateFromPolymarket(key, book);
                }
            },
        });

        // Predict polling updates
        this.predict.onOrderBook((book) => {
            const marketId = parseInt(book.marketId, 10);
            const key = this.predictToKey.get(marketId);
            if (key) {
                this.updateFromPredict(key, book);
            }
        });
    }

    // ============================================================================
    // Event Handlers
    // ============================================================================

    /**
     * Set callback for order book updates
     */
    setOnOrderBookUpdate(callback: OrderBookUpdateCallback): void {
        this.onOrderBookUpdate = callback;
    }

    /**
     * Set callback for arbitrage opportunities
     */
    setOnArbitrage(callback: ArbitrageCallback): void {
        this.onArbitrage = callback;
    }

    // ============================================================================
    // Market Pair Registration
    // ============================================================================

    /**
     * Register a market pair for cross-platform monitoring
     */
    registerMarketPair(pair: MarketPair): void {
        const key = `${pair.polymarketTokenId}:${pair.predictMarketId}`;
        this.marketPairs.set(key, pair);
        this.polymarketToKey.set(pair.polymarketTokenId, key);
        this.predictToKey.set(pair.predictMarketId, key);
    }

    /**
     * Register multiple market pairs
     */
    registerMarketPairs(pairs: MarketPair[]): void {
        for (const pair of pairs) {
            this.registerMarketPair(pair);
        }
    }

    /**
     * Unregister a market pair
     */
    unregisterMarketPair(polymarketTokenId: string, predictMarketId: number): void {
        const key = `${polymarketTokenId}:${predictMarketId}`;
        this.marketPairs.delete(key);
        this.polymarketToKey.delete(polymarketTokenId);
        this.predictToKey.delete(predictMarketId);
        this.orderBooks.delete(key);
    }

    // ============================================================================
    // Connection Management
    // ============================================================================

    /**
     * Start monitoring all registered markets
     */
    async start(): Promise<void> {
        console.log('[Manager] Starting order book monitoring...');

        // Get all token IDs and market IDs
        const polymarketTokens: string[] = [];
        const predictMarketIds: number[] = [];

        for (const pair of this.marketPairs.values()) {
            polymarketTokens.push(pair.polymarketTokenId);
            predictMarketIds.push(pair.predictMarketId);
        }

        // Connect to Polymarket WebSocket
        if (polymarketTokens.length > 0) {
            await this.polymarket.connect();
            this.polymarket.subscribeToTokens(polymarketTokens);
            console.log(`[Manager] Subscribed to ${polymarketTokens.length} Polymarket tokens`);
        }

        // Start Predict polling
        if (predictMarketIds.length > 0) {
            this.predict.subscribe(predictMarketIds);
            console.log(`[Manager] Polling ${predictMarketIds.length} Predict markets`);
        }
    }

    /**
     * Stop monitoring
     */
    stop(): void {
        console.log('[Manager] Stopping order book monitoring...');
        this.polymarket.disconnect();
        this.predict.stopPolling();
    }

    // ============================================================================
    // Order Book Access
    // ============================================================================

    /**
     * Get unified order book for a market pair
     */
    getOrderBook(key: string): UnifiedOrderBook | undefined {
        return this.orderBooks.get(key);
    }

    /**
     * Get all unified order books
     */
    getAllOrderBooks(): Map<string, UnifiedOrderBook> {
        return new Map(this.orderBooks);
    }

    // ============================================================================
    // Private Update Methods
    // ============================================================================

    private updateFromPolymarket(key: string, book: PolymarketOrderBook): void {
        let unified = this.orderBooks.get(key);

        if (!unified) {
            unified = this.createEmptyUnifiedBook('polymarket', key, book.assetId);
        }

        // Update Polymarket side
        unified.platform = 'polymarket';
        unified.updateTimestampMs = book.updateTimestampMs;
        unified.yesAsks = book.asks;
        unified.yesBids = book.bids;

        // Calculate derived NO prices
        this.calculateNoPrices(unified);
        this.calculateBestPrices(unified);

        this.orderBooks.set(key, unified);
        this.onOrderBookUpdate?.(unified);

        if (this.autoDetectArbitrage) {
            this.detectArbitrage(key);
        }
    }

    private updateFromPredict(key: string, book: PredictOrderBook): void {
        let unified = this.orderBooks.get(key);

        if (!unified) {
            unified = this.createEmptyUnifiedBook('predict', key, book.assetId);
        }

        // Update Predict side
        unified.platform = 'predict';
        unified.updateTimestampMs = book.updateTimestampMs;
        unified.yesAsks = book.asks;
        unified.yesBids = book.bids;

        // Calculate derived NO prices
        this.calculateNoPrices(unified);
        this.calculateBestPrices(unified);

        this.orderBooks.set(key, unified);
        this.onOrderBookUpdate?.(unified);

        if (this.autoDetectArbitrage) {
            this.detectArbitrage(key);
        }
    }

    private createEmptyUnifiedBook(platform: Platform, key: string, assetId: string): UnifiedOrderBook {
        return {
            platform,
            marketId: key.split(':')[1] || key,
            assetId,
            updateTimestampMs: 0,
            yesAsks: [],
            yesBids: [],
            noAsks: [],
            noBids: [],
            bestYesBid: null,
            bestYesAsk: null,
            bestNoBid: null,
            bestNoAsk: null,
            yesSpread: null,
            noSpread: null,
        };
    }

    private calculateNoPrices(book: UnifiedOrderBook): void {
        // NO ask = 1 - YES bid (someone willing to sell NO at this price)
        book.noAsks = book.yesBids.map(([price, qty]) => [1 - price, qty] as [number, number]);

        // NO bid = 1 - YES ask (someone willing to buy NO at this price)
        book.noBids = book.yesAsks.map(([price, qty]) => [1 - price, qty] as [number, number]);
    }

    private calculateBestPrices(book: UnifiedOrderBook): void {
        book.bestYesBid = book.yesBids.length > 0 ? book.yesBids[0][0] : null;
        book.bestYesAsk = book.yesAsks.length > 0 ? book.yesAsks[0][0] : null;
        book.bestNoBid = book.noBids.length > 0 ? book.noBids[0][0] : null;
        book.bestNoAsk = book.noAsks.length > 0 ? book.noAsks[0][0] : null;

        book.yesSpread = (book.bestYesBid !== null && book.bestYesAsk !== null)
            ? book.bestYesAsk - book.bestYesBid
            : null;

        book.noSpread = (book.bestNoBid !== null && book.bestNoAsk !== null)
            ? book.bestNoAsk - book.bestNoBid
            : null;
    }

    // ============================================================================
    // Arbitrage Detection
    // ============================================================================

    private detectArbitrage(key: string): void {
        // For cross-platform arbitrage, we need both platforms' data
        // This is a placeholder - full implementation would compare across platforms

        const book = this.orderBooks.get(key);
        if (!book) return;

        // Simple same-platform arbitrage check: YES + NO < 1
        // This shouldn't happen on a single platform but is the basic check

        if (book.bestYesAsk !== null && book.bestNoAsk !== null) {
            const totalCost = book.bestYesAsk + book.bestNoAsk;

            if (totalCost < 1) {
                const profit = (1 - totalCost) / totalCost;

                if (profit >= this.minProfitThreshold) {
                    const opportunity: ArbitrageOpportunity = {
                        type: 'cross_arb',
                        buyPlatform: book.platform,
                        sellPlatform: book.platform,
                        buyPrice: totalCost,
                        sellPrice: 1,
                        profit,
                        maxQuantity: Math.min(
                            book.yesAsks[0]?.[1] ?? 0,
                            book.noAsks[0]?.[1] ?? 0
                        ),
                        estimatedValue: profit * Math.min(
                            book.yesAsks[0]?.[1] ?? 0,
                            book.noAsks[0]?.[1] ?? 0
                        ),
                        timestamp: Date.now(),
                    };

                    this.onArbitrage?.(opportunity);
                }
            }
        }
    }

    // ============================================================================
    // Statistics
    // ============================================================================

    /**
     * Get manager statistics
     */
    getStats(): {
        registeredPairs: number;
        cachedBooks: number;
        polymarketConnected: boolean;
        predictPolling: boolean;
    } {
        return {
            registeredPairs: this.marketPairs.size,
            cachedBooks: this.orderBooks.size,
            polymarketConnected: this.polymarket.isConnected(),
            predictPolling: this.predict.isPolling(),
        };
    }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createOrderBookManager(config?: OrderBookManagerConfig): OrderBookManager {
    return new OrderBookManager(config);
}
