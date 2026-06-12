/**
 * Polymarket Client - Main Entry Point
 * 
 * Unified client combining REST API and WebSocket for real-time order book monitoring
 */

import { PolymarketRestClient } from './rest-client.js';
import { PolymarketWebSocketClient, createWebSocketClient, type WebSocketClientConfig, type WebSocketEventHandlers } from './ws-client.js';
import type {
    NormalizedOrderBook,
    PolymarketMarket,
    PolymarketEvent,
    PolymarketClientOptions,
} from './types.js';

export interface PolymarketClientConfig extends PolymarketClientOptions, WebSocketClientConfig { }

export class PolymarketClient {
    public readonly rest: PolymarketRestClient;
    public readonly ws: PolymarketWebSocketClient;

    // Market cache for quick lookups
    private marketCache: Map<string, PolymarketMarket> = new Map();
    private tokenToMarketMap: Map<string, string> = new Map(); // tokenId -> conditionId

    constructor(config: PolymarketClientConfig = {}) {
        this.rest = new PolymarketRestClient(config);
        this.ws = new PolymarketWebSocketClient(config);
    }

    // ============================================================================
    // Lifecycle
    // ============================================================================

    /**
     * Connect to WebSocket for real-time updates
     */
    async connect(): Promise<void> {
        await this.ws.connect();
    }

    /**
     * Disconnect from WebSocket
     */
    disconnect(): void {
        this.ws.disconnect();
    }

    /**
     * Set WebSocket event handlers
     */
    setHandlers(handlers: WebSocketEventHandlers): void {
        this.ws.setHandlers(handlers);
    }

    // ============================================================================
    // Market Discovery & Subscription
    // ============================================================================

    /**
     * Load and cache markets for quick lookups
     */
    async loadMarkets(options?: { active?: boolean; limit?: number }): Promise<PolymarketMarket[]> {
        const markets = await this.rest.getMarkets({
            active: options?.active ?? true,
            limit: options?.limit ?? 100,
        });

        // Cache markets
        for (const market of markets) {
            this.marketCache.set(market.conditionId, market);

            // Map token IDs to condition ID
            const tokenIds = this.rest.parseTokenIds(market);
            if (tokenIds) {
                this.tokenToMarketMap.set(tokenIds.yes, market.conditionId);
                this.tokenToMarketMap.set(tokenIds.no, market.conditionId);
            }
        }

        return markets;
    }

    /**
     * Subscribe to order book updates for specific markets by condition ID
     */
    async subscribeToMarkets(conditionIds: string[]): Promise<void> {
        const allTokenIds: string[] = [];

        for (const conditionId of conditionIds) {
            let market = this.marketCache.get(conditionId);

            if (!market) {
                market = await this.rest.getMarketByConditionId(conditionId) ?? undefined;
                if (market) {
                    this.marketCache.set(conditionId, market);
                }
            }

            if (market) {
                const tokenIds = this.rest.parseTokenIds(market);
                if (tokenIds) {
                    allTokenIds.push(tokenIds.yes, tokenIds.no);
                    this.tokenToMarketMap.set(tokenIds.yes, conditionId);
                    this.tokenToMarketMap.set(tokenIds.no, conditionId);
                }
            }
        }

        if (allTokenIds.length > 0) {
            this.ws.subscribe(allTokenIds);
        }
    }

    /**
     * Subscribe to order book updates by token IDs directly
     */
    subscribeToTokens(tokenIds: string[]): void {
        this.ws.subscribe(tokenIds);
    }

    // ============================================================================
    // Order Book Access
    // ============================================================================

    /**
     * Get order book for a token (from WebSocket cache if available, otherwise REST)
     */
    async getOrderBook(tokenId: string, forceRefresh = false): Promise<NormalizedOrderBook | null> {
        // Try WebSocket cache first
        if (!forceRefresh && this.ws.isConnected()) {
            const cached = this.ws.getOrderBook(tokenId);
            if (cached) return cached;
        }

        // Fall back to REST
        try {
            return await this.rest.getNormalizedOrderBook(tokenId);
        } catch (error) {
            console.error(`Failed to get order book for ${tokenId}:`, error);
            return null;
        }
    }

    /**
     * Get order books for both YES and NO tokens of a market
     */
    async getMarketOrderBooks(conditionId: string): Promise<{
        yes: NormalizedOrderBook | null;
        no: NormalizedOrderBook | null;
    }> {
        const market = this.marketCache.get(conditionId)
            ?? await this.rest.getMarketByConditionId(conditionId);

        if (!market) {
            return { yes: null, no: null };
        }

        const tokenIds = this.rest.parseTokenIds(market);
        if (!tokenIds) {
            return { yes: null, no: null };
        }

        const [yes, no] = await Promise.all([
            this.getOrderBook(tokenIds.yes),
            this.getOrderBook(tokenIds.no),
        ]);

        return { yes, no };
    }

    /**
     * Get all cached order books from WebSocket
     */
    getCachedOrderBooks(): Map<string, NormalizedOrderBook> {
        return this.ws.getAllOrderBooks();
    }

    // ============================================================================
    // Market Data Access
    // ============================================================================

    /**
     * Get market by condition ID (from cache or API)
     */
    async getMarket(conditionId: string): Promise<PolymarketMarket | null> {
        const cached = this.marketCache.get(conditionId);
        if (cached) return cached;

        const market = await this.rest.getMarketByConditionId(conditionId);
        if (market) {
            this.marketCache.set(conditionId, market);
        }
        return market;
    }

    /**
     * Get market associated with a token ID
     */
    async getMarketByTokenId(tokenId: string): Promise<PolymarketMarket | null> {
        const conditionId = this.tokenToMarketMap.get(tokenId);
        if (conditionId) {
            return this.getMarket(conditionId);
        }

        // Search in API
        const markets = await this.rest.getMarkets({ clobTokenIds: [tokenId] });
        if (markets.length > 0) {
            const market = markets[0];
            this.marketCache.set(market.conditionId, market);
            this.tokenToMarketMap.set(tokenId, market.conditionId);
            return market;
        }

        return null;
    }

    // ============================================================================
    // Connection Status
    // ============================================================================

    /**
     * Check if WebSocket is connected
     */
    isConnected(): boolean {
        return this.ws.isConnected();
    }

    /**
     * Get WebSocket connection state
     */
    getConnectionState(): string {
        return this.ws.getState();
    }

    /**
     * Get list of subscribed token IDs
     */
    getSubscribedTokens(): string[] {
        return this.ws.getSubscribedAssets();
    }

    /**
     * WebSocket 健康快照 (供敞口告警等诊断使用)
     */
    getWsHealthSnapshot() {
        return this.ws.getHealthSnapshot();
    }
}

// ============================================================================
// Re-exports
// ============================================================================

export { PolymarketRestClient } from './rest-client.js';
export { PolymarketWebSocketClient, createWebSocketClient, type WebSocketClientConfig, type WebSocketEventHandlers } from './ws-client.js';
export * from './types.js';

// ============================================================================
// Factory function
// ============================================================================

export function createPolymarketClient(config?: PolymarketClientConfig): PolymarketClient {
    return new PolymarketClient(config);
}
