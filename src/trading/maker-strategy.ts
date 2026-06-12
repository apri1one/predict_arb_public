/**
 * Maker Strategy
 * 
 * Core arbitrage strategy:
 * 1. Scan orderbooks for arbitrage opportunities
 * 2. Place limit order at Predict YES bid price
 * 3. Monitor order status and price changes
 * 4. If price changes unfavorably, cancel order
 * 5. If order fills, immediately buy NO on Polymarket
 */

import * as fs from 'fs';
import * as path from 'path';
import { TelegramNotifier, type TelegramConfig } from '../notification/telegram.js';
import { calculateDepth, type DepthResult, type OrderBookLevel } from './depth-calculator.js';
import { type TradingConfig, DEFAULT_CONFIG, loadConfigFromEnv } from './config.js';

// Load env
function loadEnv() {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) process.env[match[1].trim()] = match[2].trim();
        }
    }
}

loadEnv();

export interface MarketPair {
    name: string;
    predictMarketId: number;
    predictFeeRateBps: number;
    polymarketTokenIdYes: string;
    polymarketTokenIdNo: string;
}

export interface OrderStatus {
    orderId: string;
    status: 'PENDING' | 'OPEN' | 'PARTIAL' | 'FILLED' | 'CANCELLED';
    filledQuantity: number;
    price: number;
    quantity: number;
}

export interface StrategyState {
    isRunning: boolean;
    currentMarket: MarketPair | null;
    currentOrder: OrderStatus | null;
    lastDepthResult: DepthResult | null;
    tradesExecuted: number;
    totalProfit: number;
}

export class MakerStrategy {
    private config: TradingConfig;
    private notifier: TelegramNotifier;
    private state: StrategyState;
    private pollIntervalId: NodeJS.Timeout | null = null;
    private apiKey: string;

    constructor(config: Partial<TradingConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...loadConfigFromEnv(), ...config };
        this.apiKey = process.env.PREDICT_API_KEY || '';

        this.notifier = new TelegramNotifier({
            botToken: this.config.telegramBotToken,
            chatId: this.config.telegramChatId,
            enabled: this.config.telegramEnabled,
        });

        this.state = {
            isRunning: false,
            currentMarket: null,
            currentOrder: null,
            lastDepthResult: null,
            tradesExecuted: 0,
            totalProfit: 0,
        };
    }

    // ============================================================================
    // Public Methods
    // ============================================================================

    /**
     * Start the strategy for a specific market pair
     */
    async start(market: MarketPair): Promise<void> {
        if (this.state.isRunning) {
            console.log('[MAKER] Already running');
            return;
        }

        console.log(`[MAKER] Starting strategy for ${market.name}`);
        this.state.isRunning = true;
        this.state.currentMarket = market;

        await this.notifier.alertStartup('MAKER_STRATEGY (REAL)', 1);

        // Start polling loop
        this.pollIntervalId = setInterval(async () => {
            try {
                await this.tick();
            } catch (error) {
                console.error('[MAKER] Tick error:', error);
                await this.notifier.alertError({
                    operation: 'Strategy Tick',
                    platform: 'BOTH',
                    marketName: market.name,
                    error: String(error),
                    requiresManualIntervention: false,
                });
            }
        }, this.config.orderbookPollIntervalMs);

        console.log('[MAKER] Strategy started');
    }

    /**
     * Stop the strategy
     */
    async stop(reason: string = 'Manual stop'): Promise<void> {
        if (!this.state.isRunning) return;

        console.log(`[MAKER] Stopping: ${reason}`);
        this.state.isRunning = false;

        if (this.pollIntervalId) {
            clearInterval(this.pollIntervalId);
            this.pollIntervalId = null;
        }

        // Cancel any open order
        if (this.state.currentOrder?.status === 'OPEN') {
            console.log('[MAKER] Cancelling open order...');
            // TODO: Implement order cancellation via API
        }

        await this.notifier.alertShutdown(reason);
    }

    /**
     * Get current state
     */
    getState(): StrategyState {
        return { ...this.state };
    }

    // ============================================================================
    // Core Strategy Logic
    // ============================================================================

    private async tick(): Promise<void> {
        if (!this.state.currentMarket) return;

        const market = this.state.currentMarket;

        // 1. Fetch orderbooks from both platforms
        // Use YES token for Polymarket - we derive NO prices from it
        const [predictBook, polyNoBook] = await Promise.all([
            this.fetchPredictOrderbook(market.predictMarketId),
            this.fetchPolymarketOrderbook(market.polymarketTokenIdYes), // YES token, derive NO prices
        ]);

        if (!predictBook || !polyNoBook) {
            console.log('[MAKER] Failed to fetch orderbooks');
            return;
        }

        // 2. Calculate depth and arbitrage opportunity
        const depth = calculateDepth(
            predictBook.bids,
            predictBook.asks,
            polyNoBook.asks,
            market.predictFeeRateBps,
            this.config.maxPositionPerMarket
        );

        this.state.lastDepthResult = depth;

        // 3. Check if we have an open order
        if (this.state.currentOrder?.status === 'OPEN') {
            await this.handleOpenOrder(depth, market);
            return;
        }

        // 4. Check for new arbitrage opportunity (MAKER mode)
        if (depth.makerProfit >= this.config.minProfitPercent / 100 && depth.makerMaxQuantity > 0) {
            console.log(`[MAKER] Arbitrage found! Profit: ${(depth.makerProfit * 100).toFixed(2)}%, Qty: ${depth.makerMaxQuantity}`);

            await this.notifier.alertArbitrage({
                marketName: market.name,
                predictMarketId: market.predictMarketId,
                mode: 'PREDICT_MAKER',
                predictYesPrice: depth.predictYesBid,
                polymarketNoPrice: depth.polymarketNoAsk,
                totalCost: depth.makerCost,
                profitPercent: depth.makerProfit * 100,
                maxQuantity: depth.makerMaxQuantity,
            });

            // Place limit order at bid price
            await this.placePredictOrder(market, depth.predictYesBid, depth.makerMaxQuantity);
        }
    }

    private async handleOpenOrder(depth: DepthResult, market: MarketPair): Promise<void> {
        const order = this.state.currentOrder!;

        // Check if arbitrage still exists
        const newMakerCost = order.price + depth.polymarketNoAsk;

        if (newMakerCost >= 1) {
            // Arbitrage disappeared! Cancel order
            console.log(`[MAKER] Arbitrage disappeared! Cost: ${(newMakerCost * 100).toFixed(1)}c >= 100c`);

            await this.notifier.alertPriceChange(
                market.name,
                this.state.lastDepthResult?.makerCost || 0,
                newMakerCost,
                'ORDER CANCELLED - Arbitrage disappeared'
            );

            // TODO: Cancel order via API
            this.state.currentOrder = null;
            return;
        }

        // Check order status
        // TODO: Check order status via API
        // For now, simulate checking...
        console.log(`[MAKER] Order open at ${(order.price * 100).toFixed(1)}c, cost still ${(newMakerCost * 100).toFixed(1)}c`);
    }

    private async placePredictOrder(market: MarketPair, price: number, quantity: number): Promise<void> {
        console.log(`[MAKER] Placing order: BUY ${quantity} YES @ ${(price * 100).toFixed(1)}c`);

        // TODO: Implement actual order placement via Predict API
        // For now, create a mock order
        this.state.currentOrder = {
            orderId: `mock-${Date.now()}`,
            status: 'OPEN',
            filledQuantity: 0,
            price,
            quantity,
        };

        await this.notifier.alertOrder({
            type: 'PLACED',
            platform: 'PREDICT',
            marketName: market.name,
            action: 'BUY',
            side: 'YES',
            price,
            quantity,
        });
    }

    // ============================================================================
    // API Methods
    // ============================================================================

    private async fetchPredictOrderbook(marketId: number): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null> {
        try {
            const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}/orderbook`, {
                headers: { 'x-api-key': this.apiKey }
            });
            if (!res.ok) return null;

            const data = await res.json() as { data: { bids: [number, number][]; asks: [number, number][] } };

            return {
                bids: data.data.bids.map(([price, size]) => ({ price, size })),
                asks: data.data.asks.map(([price, size]) => ({ price, size })),
            };
        } catch {
            return null;
        }
    }

    private async fetchPolymarketOrderbook(tokenId: string): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null> {
        try {
            // Fetch YES token orderbook
            const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
            if (!res.ok) return null;

            const data = await res.json() as { bids: any[]; asks: any[] };

            // Polymarket orderbook: bids sorted ascending, asks sorted descending
            // Best YES bid = last in bids array
            const yesBids = (data.bids || []).map((l: any) => ({
                price: parseFloat(l.price),
                size: parseFloat(l.size),
            }));

            const yesAsks = (data.asks || []).map((l: any) => ({
                price: parseFloat(l.price),
                size: parseFloat(l.size),
            }));

            // Convert to NO orderbook:
            // YES Bid = someone buying YES = someone SELLING NO
            // So: NO Ask = 1 - YES Bid
            const noAsks = yesBids.map(level => ({
                price: 1 - level.price,
                size: level.size,
            }));
            // Sort ascending (lowest/best ask first)
            noAsks.sort((a, b) => a.price - b.price);

            // YES Ask = someone selling YES = someone BUYING NO  
            // So: NO Bid = 1 - YES Ask
            const noBids = yesAsks.map(level => ({
                price: 1 - level.price,
                size: level.size,
            }));
            // Sort descending (highest/best bid first)
            noBids.sort((a, b) => b.price - a.price);

            return { bids: noBids, asks: noAsks };
        } catch {
            return null;
        }
    }
}

// Factory function
export function createMakerStrategy(config?: Partial<TradingConfig>): MakerStrategy {
    return new MakerStrategy(config);
}
