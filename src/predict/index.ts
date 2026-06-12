/**
 * Predict.fun Client - Main Entry Point
 * 
 * REST API client for Predict.fun prediction markets
 * 
 * Features:
 * - Market data and order books
 * - Order management (with SDK integration)
 * - Automatic polling for pseudo-real-time updates
 * 
 * NOTE: Predict does NOT have a WebSocket API.
 * For real-time data, use the polling mechanism provided.
 */

import { PredictRestClient, PredictApiError, MissingApiKeyError } from './rest-client.js';
import type {
    PredictMarket,
    PredictOrderBook,
    NormalizedOrderBook,
    PredictClientOptions,
    OrderBookCallback,
} from './types.js';

export interface PredictClientConfig extends PredictClientOptions {
    pollingInterval?: number; // Polling interval in ms (default: 100ms)
    autoConnect?: boolean;
}

type PollingState = 'stopped' | 'running' | 'paused';

export class PredictClient {
    public readonly rest: PredictRestClient;

    // Polling configuration
    private readonly pollingInterval: number;
    private pollingState: PollingState = 'stopped';
    private pollingTimer: ReturnType<typeof setTimeout> | null = null;

    // Subscribed markets
    private subscribedMarkets: Set<number> = new Set();

    // Order book cache
    private orderBooks: Map<number, NormalizedOrderBook> = new Map();

    // Event handlers
    private onOrderBookUpdate: OrderBookCallback | null = null;
    private onError: ((error: Error) => void) | null = null;

    // Statistics
    private pollCount = 0;
    private lastPollTime = 0;
    private totalLatency = 0;

    constructor(config: PredictClientConfig = {}) {
        this.rest = new PredictRestClient(config);
        this.pollingInterval = config.pollingInterval ?? 100; // 100ms default for low latency
    }

    // ============================================================================
    // Event Handlers
    // ============================================================================

    /**
     * Set callback for order book updates
     */
    onOrderBook(callback: OrderBookCallback): void {
        this.onOrderBookUpdate = callback;
    }

    /**
     * Set callback for errors
     */
    onPollingError(callback: (error: Error) => void): void {
        this.onError = callback;
    }

    // ============================================================================
    // Subscription Management
    // ============================================================================

    /**
     * Subscribe to market order book updates
     */
    subscribe(marketIds: number[]): void {
        for (const id of marketIds) {
            this.subscribedMarkets.add(id);
        }

        // Start polling if not already running
        if (this.pollingState === 'stopped' && this.subscribedMarkets.size > 0) {
            this.startPolling();
        }
    }

    /**
     * Unsubscribe from market updates
     */
    unsubscribe(marketIds: number[]): void {
        for (const id of marketIds) {
            this.subscribedMarkets.delete(id);
            this.orderBooks.delete(id);
        }

        // Stop polling if no subscriptions
        if (this.subscribedMarkets.size === 0) {
            this.stopPolling();
        }
    }

    /**
     * Get list of subscribed market IDs
     */
    getSubscribedMarkets(): number[] {
        return [...this.subscribedMarkets];
    }

    // ============================================================================
    // Polling Control
    // ============================================================================

    /**
     * Start order book polling
     */
    startPolling(): void {
        if (this.pollingState === 'running') return;

        this.pollingState = 'running';
        this.pollCount = 0;
        this.totalLatency = 0;
        console.log(`[Predict] Starting polling (interval: ${this.pollingInterval}ms)`);
        this.schedulePoll();
    }

    /**
     * Stop polling
     */
    stopPolling(): void {
        this.pollingState = 'stopped';
        if (this.pollingTimer) {
            clearTimeout(this.pollingTimer);
            this.pollingTimer = null;
        }
        console.log(`[Predict] Polling stopped (total polls: ${this.pollCount})`);
    }

    /**
     * Pause polling temporarily
     */
    pausePolling(): void {
        if (this.pollingState === 'running') {
            this.pollingState = 'paused';
            if (this.pollingTimer) {
                clearTimeout(this.pollingTimer);
                this.pollingTimer = null;
            }
            console.log('[Predict] Polling paused');
        }
    }

    /**
     * Resume polling
     */
    resumePolling(): void {
        if (this.pollingState === 'paused') {
            this.pollingState = 'running';
            this.schedulePoll();
            console.log('[Predict] Polling resumed');
        }
    }

    /**
     * Check if polling is active
     */
    isPolling(): boolean {
        return this.pollingState === 'running';
    }

    // ============================================================================
    // Order Book Access
    // ============================================================================

    /**
     * Get cached order book for a market
     */
    getOrderBook(marketId: number): NormalizedOrderBook | undefined {
        return this.orderBooks.get(marketId);
    }

    /**
     * Get all cached order books
     */
    getAllOrderBooks(): Map<number, NormalizedOrderBook> {
        return new Map(this.orderBooks);
    }

    /**
     * Force refresh order book for a market
     */
    async refreshOrderBook(marketId: number): Promise<NormalizedOrderBook | null> {
        try {
            const book = await this.rest.getNormalizedOrderBook(marketId);
            this.orderBooks.set(marketId, book);
            this.onOrderBookUpdate?.(book);
            return book;
        } catch (error) {
            this.onError?.(error as Error);
            return null;
        }
    }

    // ============================================================================
    // Statistics
    // ============================================================================

    /**
     * Get polling statistics
     */
    getStats(): {
        pollCount: number;
        avgLatency: number;
        subscribedCount: number;
        cachedCount: number;
        pollingState: PollingState;
    } {
        return {
            pollCount: this.pollCount,
            avgLatency: this.pollCount > 0 ? this.totalLatency / this.pollCount : 0,
            subscribedCount: this.subscribedMarkets.size,
            cachedCount: this.orderBooks.size,
            pollingState: this.pollingState,
        };
    }

    // ============================================================================
    // Private Methods
    // ============================================================================

    private schedulePoll(): void {
        if (this.pollingState !== 'running') return;

        this.pollingTimer = setTimeout(async () => {
            await this.pollOrderBooks();
            this.schedulePoll();
        }, this.pollingInterval);
    }

    private async pollOrderBooks(): Promise<void> {
        if (this.subscribedMarkets.size === 0) return;

        const startTime = Date.now();
        this.pollCount++;

        // Poll all subscribed markets in parallel
        const promises = [...this.subscribedMarkets].map(async (marketId) => {
            try {
                const book = await this.rest.getNormalizedOrderBook(marketId);

                // Check if order book has changed
                const cached = this.orderBooks.get(marketId);
                const hasChanged = !cached ||
                    cached.updateTimestampMs !== book.updateTimestampMs ||
                    JSON.stringify(cached.bids) !== JSON.stringify(book.bids) ||
                    JSON.stringify(cached.asks) !== JSON.stringify(book.asks);

                if (hasChanged) {
                    this.orderBooks.set(marketId, book);
                    this.onOrderBookUpdate?.(book);
                }
            } catch (error) {
                // Don't stop polling on individual market errors
                if (this.pollCount <= 3) {
                    console.error(`[Predict] Error polling market ${marketId}:`, error);
                }
                this.onError?.(error as Error);
            }
        });

        await Promise.all(promises);

        const latency = Date.now() - startTime;
        this.totalLatency += latency;
        this.lastPollTime = latency;
    }
}

// ============================================================================
// Re-exports
// ============================================================================

export { PredictRestClient, PredictApiError, MissingApiKeyError } from './rest-client.js';
export * from './types.js';

// ============================================================================
// Factory function
// ============================================================================

export function createPredictClient(config?: PredictClientConfig): PredictClient {
    return new PredictClient(config);
}
