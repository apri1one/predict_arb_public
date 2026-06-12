/**
 * Polymarket REST API Client
 * 
 * Provides access to:
 * - CLOB API: Order book, prices, spreads, midpoints
 * - Gamma API: Markets, events, condition IDs
 */

import type {
    OrderBookSummary,
    NormalizedOrderBook,
    PriceResponse,
    PricesResponse,
    MidpointResponse,
    SpreadsResponse,
    PriceHistoryResponse,
    BookRequest,
    PriceRequest,
    PolymarketMarket,
    PolymarketEvent,
    PolymarketClientOptions,
} from './types.js';

// Default configuration
const DEFAULT_CLOB_BASE_URL = 'https://clob.polymarket.com';
const DEFAULT_GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';
const DEFAULT_REQUEST_TIMEOUT = 10000; // 10 seconds

export class PolymarketRestClient {
    private readonly clobBaseUrl: string;
    private readonly gammaBaseUrl: string;
    private readonly requestTimeout: number;

    constructor(options: PolymarketClientOptions = {}) {
        this.clobBaseUrl = options.clobBaseUrl || DEFAULT_CLOB_BASE_URL;
        this.gammaBaseUrl = options.gammaBaseUrl || DEFAULT_GAMMA_BASE_URL;
        this.requestTimeout = options.requestTimeout || DEFAULT_REQUEST_TIMEOUT;
    }

    // ============================================================================
    // Private Helpers
    // ============================================================================

    private async fetch<T>(url: string, options: RequestInit = {}): Promise<T> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    ...options.headers,
                },
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            return response.json() as Promise<T>;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    // ============================================================================
    // CLOB API - Order Book
    // ============================================================================

    /**
     * Get order book for a single token
     */
    async getOrderBook(tokenId: string): Promise<OrderBookSummary> {
        const url = `${this.clobBaseUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
        return this.fetch<OrderBookSummary>(url);
    }

    /**
     * Get order books for multiple tokens (batch)
     * @param tokenIds - Array of token IDs (max 500)
     */
    async getOrderBooks(tokenIds: string[]): Promise<OrderBookSummary[]> {
        if (tokenIds.length > 500) {
            throw new Error(`getOrderBooks: ${tokenIds.length} tokens 超过 Polymarket API 500 上限，需要减少体育市场数量`);
        }

        const url = `${this.clobBaseUrl}/books`;
        const body: BookRequest[] = tokenIds.map(token_id => ({ token_id }));

        return this.fetch<OrderBookSummary[]>(url, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    }

    /**
     * Get normalized order book (compatible with Predict format)
     */
    async getNormalizedOrderBook(tokenId: string): Promise<NormalizedOrderBook> {
        const book = await this.getOrderBook(tokenId);
        return this.normalizeOrderBook(book);
    }

    /**
     * Convert raw order book to normalized format
     *
     * Polymarket API 返回的订单簿排序不一定是最佳价格优先，需要重新排序：
     * - asks: 按价格升序 (最低价/最佳卖价在前)
     * - bids: 按价格降序 (最高价/最佳买价在前)
     */
    normalizeOrderBook(book: OrderBookSummary): NormalizedOrderBook {
        // 解析并排序 asks (升序 - 最低价在前)
        const asks = book.asks
            .map(level => [parseFloat(level.price), parseFloat(level.size)] as [number, number])
            .sort((a, b) => a[0] - b[0]);

        // 解析并排序 bids (降序 - 最高价在前)
        const bids = book.bids
            .map(level => [parseFloat(level.price), parseFloat(level.size)] as [number, number])
            .sort((a, b) => b[0] - a[0]);

        return {
            assetId: book.asset_id,
            marketId: book.market,
            updateTimestampMs: new Date(book.timestamp).getTime(),
            asks,
            bids,
            minOrderSize: parseFloat(book.min_order_size),
            tickSize: parseFloat(book.tick_size),
            isNegRisk: book.neg_risk,
        };
    }

    // ============================================================================
    // CLOB API - Pricing
    // ============================================================================

    /**
     * Get price for a specific token and side
     */
    async getPrice(tokenId: string, side: 'BUY' | 'SELL'): Promise<number> {
        const url = `${this.clobBaseUrl}/price?token_id=${encodeURIComponent(tokenId)}&side=${side}`;
        const response = await this.fetch<PriceResponse>(url);
        return parseFloat(response.price);
    }

    /**
     * Get prices for multiple tokens (batch)
     * @param requests - Array of { token_id, side } (max 500)
     */
    async getPrices(requests: PriceRequest[]): Promise<PricesResponse> {
        if (requests.length > 500) {
            throw new Error('Maximum 500 requests per batch');
        }

        const url = `${this.clobBaseUrl}/prices`;
        return this.fetch<PricesResponse>(url, {
            method: 'POST',
            body: JSON.stringify(requests),
        });
    }

    /**
     * Get midpoint price for a token
     */
    async getMidpoint(tokenId: string): Promise<number> {
        const url = `${this.clobBaseUrl}/midpoint?token_id=${encodeURIComponent(tokenId)}`;
        const response = await this.fetch<MidpointResponse>(url);
        return parseFloat(response.mid);
    }

    /**
     * Get spreads for multiple tokens
     * @param tokenIds - Array of token IDs (max 500)
     */
    async getSpreads(tokenIds: string[]): Promise<SpreadsResponse> {
        if (tokenIds.length > 500) {
            throw new Error('Maximum 500 token IDs per request');
        }

        const url = `${this.clobBaseUrl}/spreads`;
        const body: BookRequest[] = tokenIds.map(token_id => ({ token_id }));

        return this.fetch<SpreadsResponse>(url, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    }

    /**
     * Get price history for a token
     */
    async getPriceHistory(
        tokenId: string,
        options?: {
            startTs?: number;
            endTs?: number;
            interval?: '1m' | '1w' | '1d' | '6h' | '1h' | 'max';
            fidelity?: number;
        }
    ): Promise<PriceHistoryResponse> {
        const params = new URLSearchParams({ market: tokenId });

        if (options?.startTs) params.append('startTs', options.startTs.toString());
        if (options?.endTs) params.append('endTs', options.endTs.toString());
        if (options?.interval) params.append('interval', options.interval);
        if (options?.fidelity) params.append('fidelity', options.fidelity.toString());

        const url = `${this.clobBaseUrl}/prices-history?${params.toString()}`;
        return this.fetch<PriceHistoryResponse>(url);
    }

    // ============================================================================
    // Gamma API - Markets
    // ============================================================================

    /**
     * Get list of markets
     */
    async getMarkets(options?: {
        limit?: number;
        offset?: number;
        active?: boolean;
        closed?: boolean;
        conditionIds?: string[];
        clobTokenIds?: string[];
        tagId?: number;
        sportsMarketTypes?: string;
    }): Promise<PolymarketMarket[]> {
        const params = new URLSearchParams();

        if (options?.limit) params.append('limit', options.limit.toString());
        if (options?.offset) params.append('offset', options.offset.toString());
        if (options?.active !== undefined) params.append('active', options.active.toString());
        if (options?.closed !== undefined) params.append('closed', options.closed.toString());
        if (options?.conditionIds) {
            options.conditionIds.forEach(id => params.append('condition_ids', id));
        }
        if (options?.clobTokenIds) {
            options.clobTokenIds.forEach(id => params.append('clob_token_ids', id));
        }
        if (options?.tagId) params.append('tag_id', options.tagId.toString());
        if (options?.sportsMarketTypes) params.append('sports_market_types', options.sportsMarketTypes);

        const url = `${this.gammaBaseUrl}/markets?${params.toString()}`;
        return this.fetch<PolymarketMarket[]>(url);
    }

    /**
     * Get market by ID
     */
    async getMarket(id: string): Promise<PolymarketMarket> {
        const url = `${this.gammaBaseUrl}/markets/${id}`;
        return this.fetch<PolymarketMarket>(url);
    }

    /**
     * Get market by slug
     */
    async getMarketBySlug(slug: string): Promise<PolymarketMarket> {
        const url = `${this.gammaBaseUrl}/markets/slug/${encodeURIComponent(slug)}`;
        return this.fetch<PolymarketMarket>(url);
    }

    /**
     * Get market by condition ID
     */
    async getMarketByConditionId(conditionId: string): Promise<PolymarketMarket | null> {
        const markets = await this.getMarkets({ conditionIds: [conditionId] });
        return markets.length > 0 ? markets[0] : null;
    }

    // ============================================================================
    // Gamma API - Events
    // ============================================================================

    /**
     * Get list of events
     */
    async getEvents(options?: {
        limit?: number;
        offset?: number;
        active?: boolean;
        closed?: boolean;
        tagSlug?: string;
    }): Promise<PolymarketEvent[]> {
        const params = new URLSearchParams();

        if (options?.limit) params.append('limit', options.limit.toString());
        if (options?.offset) params.append('offset', options.offset.toString());
        if (options?.active !== undefined) params.append('active', options.active.toString());
        if (options?.closed !== undefined) params.append('closed', options.closed.toString());
        if (options?.tagSlug) params.append('tag_slug', options.tagSlug);

        const url = `${this.gammaBaseUrl}/events?${params.toString()}`;
        return this.fetch<PolymarketEvent[]>(url);
    }

    /**
     * Get event by ID
     */
    async getEvent(id: string): Promise<PolymarketEvent> {
        const url = `${this.gammaBaseUrl}/events/${id}`;
        return this.fetch<PolymarketEvent>(url);
    }

    /**
     * Get event by slug
     */
    async getEventBySlug(slug: string): Promise<PolymarketEvent> {
        const url = `${this.gammaBaseUrl}/events/slug/${encodeURIComponent(slug)}`;
        return this.fetch<PolymarketEvent>(url);
    }

    // ============================================================================
    // Utility Methods
    // ============================================================================

    /**
     * Parse CLOB token IDs from market
     */
    parseTokenIds(market: PolymarketMarket): { yes: string; no: string } | null {
        if (!market.clobTokenIds) return null;

        try {
            const tokenIds = JSON.parse(market.clobTokenIds) as string[];
            if (tokenIds.length >= 2) {
                return { yes: tokenIds[0], no: tokenIds[1] };
            }
        } catch {
            console.error('Failed to parse clobTokenIds:', market.clobTokenIds);
        }

        return null;
    }

    /**
     * Parse outcomes from market
     */
    parseOutcomes(market: PolymarketMarket): string[] {
        if (!market.outcomes) return [];

        try {
            return JSON.parse(market.outcomes) as string[];
        } catch {
            return [];
        }
    }

    /**
     * Parse outcome prices from market
     */
    parseOutcomePrices(market: PolymarketMarket): number[] {
        if (!market.outcomePrices) return [];

        try {
            return JSON.parse(market.outcomePrices) as number[];
        } catch {
            return [];
        }
    }
}
