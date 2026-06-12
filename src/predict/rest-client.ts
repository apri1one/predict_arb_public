/**
 * Predict.fun REST API Client
 *
 * Provides access to Predict.fun API endpoints:
 * - Public: Markets, Order Books, Stats
 * - Authenticated: Orders, Positions, Account
 *
 * API Documentation: https://dev.predict.fun/
 *
 * NOTE: Requires API Key from https://predict.fun/settings/api
 */

import { ethers } from 'ethers';
import { getBscRpcUrl } from '../config/bsc-rpc.js';
import type {
    ApiResponse,
    PaginatedResponse,
    PredictMarket,
    PredictOrderBook,
    NormalizedOrderBook,
    MarketStats,
    LastSale,
    PredictOrder,
    OrderMatch,
    AuthMessage,
    AuthToken,
    PredictAccount,
    GetMarketsParams,
    GetOrdersParams,
    GetMatchesParams,
    PredictClientOptions,
} from './types.js';

// Default configuration
const DEFAULT_BASE_URL = 'https://api.predict.fun';
const DEFAULT_REQUEST_TIMEOUT = 10000; // 10 seconds
const DEFAULT_MAX_RETRIES = 3;

// Custom errors
export class PredictApiError extends Error {
    constructor(
        message: string,
        public statusCode?: number,
        public response?: unknown
    ) {
        super(message);
        this.name = 'PredictApiError';
    }
}

export class MissingApiKeyError extends PredictApiError {
    constructor() {
        super(
            'API Key is required. Get your API key from https://predict.fun/settings/api\n' +
            'Then set it via PREDICT_API_KEY environment variable or pass it to the client constructor.'
        );
        this.name = 'MissingApiKeyError';
    }
}

export class PredictRestClient {
    private readonly baseUrl: string;
    private readonly apiKey: string | undefined;
    private readonly requestTimeout: number;
    private readonly maxRetries: number;

    // JWT token for authenticated requests
    private jwtToken: string | null = null;
    private jwtExpiresAt: Date | null = null;

    constructor(options: PredictClientOptions = {}) {
        this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
        this.apiKey = options.apiKey || process.env.PREDICT_API_KEY;
        this.requestTimeout = options.requestTimeout || DEFAULT_REQUEST_TIMEOUT;
        this.maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
    }

    // ============================================================================
    // Private Helpers
    // ============================================================================

    private requireApiKey(): void {
        if (!this.apiKey) {
            throw new MissingApiKeyError();
        }
    }

    private async fetch<T>(
        endpoint: string,
        options: RequestInit = {},
        requireAuth = false
    ): Promise<T> {
        if (requireAuth) {
            this.requireApiKey();
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...options.headers as Record<string, string>,
        };

        // Add API Key header if available
        if (this.apiKey) {
            headers['X-API-Key'] = this.apiKey;
        }

        // Add JWT token for authenticated requests
        if (requireAuth && this.jwtToken && this.jwtExpiresAt && this.jwtExpiresAt > new Date()) {
            headers['Authorization'] = `Bearer ${this.jwtToken}`;
        }

        const url = `${this.baseUrl}${endpoint}`;

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
                headers,
            });

            if (!response.ok) {
                const errorText = await response.text();
                let errorData: unknown;
                try {
                    errorData = JSON.parse(errorText);
                } catch {
                    errorData = errorText;
                }
                throw new PredictApiError(
                    `HTTP ${response.status}: ${response.statusText}`,
                    response.status,
                    errorData
                );
            }

            return response.json() as Promise<T>;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private buildQueryString(params: object): string {
        const searchParams = new URLSearchParams();

        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) {
                searchParams.append(key, String(value));
            }
        }

        const queryString = searchParams.toString();
        return queryString ? `?${queryString}` : '';
    }

    // ============================================================================
    // Public API - Markets
    // ============================================================================

    /**
     * Get list of markets
     */
    async getMarkets(params: GetMarketsParams = {}): Promise<PredictMarket[]> {
        const query = this.buildQueryString(params);
        const response = await this.fetch<ApiResponse<PredictMarket[]>>(`/v1/markets${query}`);
        return response.data;
    }

    /**
     * Get market by ID
     */
    async getMarket(marketId: number): Promise<PredictMarket> {
        const response = await this.fetch<ApiResponse<PredictMarket>>(`/v1/markets/${marketId}`);
        return response.data;
    }

    /**
     * Get order book for a market
     * 
     * IMPORTANT: All prices in the order book are for YES outcome only
     * To get NO price: NO_price = 1 - YES_price
     */
    async getOrderBook(marketId: number): Promise<PredictOrderBook> {
        const response = await this.fetch<ApiResponse<PredictOrderBook>>(`/v1/markets/${marketId}/orderbook`);
        return response.data;
    }

    /**
     * Get normalized order book (compatible with Polymarket format)
     * Fetches market metadata to get accurate isNegRisk value
     */
    async getNormalizedOrderBook(marketId: number): Promise<NormalizedOrderBook> {
        const [book, market] = await Promise.all([
            this.getOrderBook(marketId),
            this.getMarket(marketId)
        ]);
        return this.normalizeOrderBook(book, market.isNegRisk);
    }

    /**
     * Convert raw order book to normalized format
     * @param book - Raw order book from API
     * @param isNegRisk - Whether this is a NegRisk market (affects token ID calculation)
     */
    normalizeOrderBook(book: PredictOrderBook, isNegRisk: boolean = false): NormalizedOrderBook {
        return {
            marketId: String(book.marketId),
            assetId: String(book.marketId), // Using marketId as assetId for Predict
            updateTimestampMs: book.updateTimestampMs,
            asks: book.asks,
            bids: book.bids,
            minOrderSize: 1, // Default, not provided by API
            tickSize: 0.001, // Default tick size
            isNegRisk,
        };
    }

    /**
     * Get last sale for a market
     */
    async getLastSale(marketId: number): Promise<LastSale> {
        const response = await this.fetch<ApiResponse<LastSale>>(`/v1/markets/${marketId}/last-sale`);
        return response.data;
    }

    /**
     * Get market statistics
     */
    async getMarketStats(marketId: number): Promise<MarketStats> {
        const response = await this.fetch<ApiResponse<MarketStats>>(`/v1/markets/${marketId}/stats`);
        return response.data;
    }

    // ============================================================================
    // Public API - Categories
    // ============================================================================

    /**
     * Get list of categories
     */
    async getCategories(): Promise<{ slug: string; name: string; count: number }[]> {
        const response = await this.fetch<ApiResponse<{ slug: string; name: string; count: number }[]>>('/v1/categories');
        return response.data;
    }

    // ============================================================================
    // Public API - Order Matches
    // ============================================================================

    /**
     * Get order match events (trades)
     */
    async getOrderMatches(params: GetMatchesParams = {}): Promise<OrderMatch[]> {
        const query = this.buildQueryString(params);
        const response = await this.fetch<ApiResponse<OrderMatch[]>>(`/v1/orders/matches${query}`);
        return response.data;
    }

    /**
     * Get markets with recent trading activity
     * Uses order matches to find markets that have active orderbooks
     * This is the recommended way to find tradeable markets
     */
    async getActiveMarkets(limit = 50): Promise<PredictMarket[]> {
        const matches = await this.getOrderMatches({ limit });

        // Extract unique markets from recent trades
        const marketMap = new Map<number, PredictMarket>();
        for (const match of matches) {
            if (match.market && !marketMap.has(match.market.id)) {
                marketMap.set(match.market.id, match.market);
            }
        }

        return Array.from(marketMap.values());
    }

    /**
     * Get markets that have non-empty orderbooks
     * Tests each market's orderbook and returns only those with active orders
     * @param markets - Markets to test (if not provided, uses getActiveMarkets)
     */
    async getMarketsWithOrderbooks(markets?: PredictMarket[]): Promise<{ market: PredictMarket; orderbook: PredictOrderBook }[]> {
        const marketsToTest = markets || await this.getActiveMarkets();
        const results: { market: PredictMarket; orderbook: PredictOrderBook }[] = [];

        for (const market of marketsToTest) {
            try {
                const orderbook = await this.getOrderBook(market.id);
                if (orderbook.bids.length > 0 || orderbook.asks.length > 0) {
                    results.push({ market, orderbook });
                }
            } catch {
                // Skip markets without accessible orderbooks
            }
        }

        return results;
    }

    /**
     * Get markets that are linked to Polymarket
     * Returns markets with polymarketConditionIds populated
     */
    async getPolymarketLinkedMarkets(): Promise<PredictMarket[]> {
        const markets = await this.getActiveMarkets();
        return markets.filter(m => m.polymarketConditionIds && m.polymarketConditionIds.length > 0);
    }

    // ============================================================================
    // Authenticated API - Authentication
    // ============================================================================

    /**
     * Get message to sign for authentication
     * Requires API Key
     */
    async getAuthMessage(address: string): Promise<AuthMessage> {
        this.requireApiKey();
        const response = await this.fetch<ApiResponse<AuthMessage>>(
            `/v1/auth/message?address=${encodeURIComponent(address)}`,
            {},
            true
        );
        return response.data;
    }

    /**
     * Authenticate with signed message to get JWT token
     * Requires API Key
     */
    async authenticate(address: string, signature: string): Promise<AuthToken> {
        this.requireApiKey();
        const response = await this.fetch<ApiResponse<AuthToken>>(
            '/v1/auth',
            {
                method: 'POST',
                body: JSON.stringify({ address, signature }),
            },
            true
        );

        // Store JWT token for future authenticated requests
        this.jwtToken = response.data.token;
        this.jwtExpiresAt = new Date(response.data.expiresAt);

        return response.data;
    }

    /**
     * Set JWT token directly (if you already have one)
     */
    setJwtToken(token: string, expiresAt: Date): void {
        this.jwtToken = token;
        this.jwtExpiresAt = expiresAt;
    }

    /**
     * Check if currently authenticated with valid JWT
     */
    isAuthenticated(): boolean {
        return !!(this.jwtToken && this.jwtExpiresAt && this.jwtExpiresAt > new Date());
    }

    // ============================================================================
    // Authenticated API - Orders
    // ============================================================================

    /**
     * Get user's orders
     * Requires JWT authentication
     */
    async getOrders(params: GetOrdersParams = {}): Promise<PredictOrder[]> {
        const query = this.buildQueryString(params);
        const response = await this.fetch<ApiResponse<PredictOrder[]>>(
            `/v1/orders${query}`,
            {},
            true
        );
        return response.data;
    }

    /**
     * Get order by hash
     * Requires JWT authentication
     */
    async getOrder(orderHash: string): Promise<PredictOrder> {
        const response = await this.fetch<ApiResponse<PredictOrder>>(
            `/v1/orders/${orderHash}`,
            {},
            true
        );
        return response.data;
    }

    // ============================================================================
    // Authenticated API - Account
    // ============================================================================

    /**
     * Get account information
     * Requires JWT authentication
     */
    async getAccount(): Promise<PredictAccount> {
        const response = await this.fetch<ApiResponse<PredictAccount>>(
            '/v1/account',
            {},
            true
        );
        return response.data;
    }

    // ============================================================================
    // Utility Methods
    // ============================================================================

    /**
     * Check if API Key is configured
     */
    hasApiKey(): boolean {
        return !!this.apiKey;
    }

    /**
     * Calculate NO price from YES price
     * Predict order books only contain YES prices
     */
    static calculateNoPrice(yesPrice: number): number {
        return 1 - yesPrice;
    }

    /**
     * Convert YES order book to NO perspective
     * - YES bids become NO asks (at 1 - price)
     * - YES asks become NO bids (at 1 - price)
     */
    static convertToNoOrderBook(yesBook: PredictOrderBook): PredictOrderBook {
        return {
            marketId: yesBook.marketId,
            updateTimestampMs: yesBook.updateTimestampMs,
            // YES bids = NO asks (buyer of YES is seller of NO)
            asks: yesBook.bids.map(([price, qty]) => [1 - price, qty] as [number, number]),
            // YES asks = NO bids (seller of YES is buyer of NO)
            bids: yesBook.asks.map(([price, qty]) => [1 - price, qty] as [number, number]),
        };
    }

    /**
     * Get best bid/ask prices from order book
     */
    static getBestPrices(book: PredictOrderBook): { bestBid: number | null; bestAsk: number | null; spread: number | null } {
        const bestBid = book.bids.length > 0 ? book.bids[0][0] : null;
        const bestAsk = book.asks.length > 0 ? book.asks[0][0] : null;
        const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

        return { bestBid, bestAsk, spread };
    }

    // ============================================================================
    // Balance Query (On-chain)
    // ============================================================================

    /**
     * Get smart wallet balance by querying BSC blockchain directly
     * Note: Predict API does not provide balance query endpoint
     *
     * @param smartWalletAddress - Predict smart wallet address (from env: PREDICT_SMART_WALLET_ADDRESS)
     * @param provider - Optional ethers provider (defaults to BSC mainnet)
     * @returns Object with balances for USDT, USDC, BUSD, and BNB
     */
    async getSmartWalletBalance(
        smartWalletAddress: string = process.env.PREDICT_SMART_WALLET_ADDRESS || '',
        provider?: ethers.JsonRpcProvider
    ): Promise<{
        address: string;
        balances: {
            USDT: string;
            USDC: string;
            BUSD: string;
            BNB: string;
        };
        totalUSD: number;
    }> {
        if (!smartWalletAddress) {
            throw new Error('Smart wallet address is required. Set PREDICT_SMART_WALLET_ADDRESS in .env');
        }

        // Use provided provider or default to BSC mainnet (using optimized RPC config)
        const rpcProvider = provider || new ethers.JsonRpcProvider(getBscRpcUrl());

        // Token addresses on BSC
        const tokens = {
            USDT: '0x55d398326f99059fF775485246999027B3197955',
            USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
            BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
        };

        const erc20ABI = [
            'function balanceOf(address account) view returns (uint256)',
            'function decimals() view returns (uint8)',
        ];

        const balances = {
            USDT: '0',
            USDC: '0',
            BUSD: '0',
            BNB: '0',
        };

        let totalUSD = 0;

        // Query BNB balance
        const bnbBalance = await rpcProvider.getBalance(smartWalletAddress);
        balances.BNB = ethers.formatEther(bnbBalance);
        totalUSD += parseFloat(balances.BNB) * 600; // Rough BNB price estimate

        // Query stablecoin balances
        for (const [symbol, address] of Object.entries(tokens)) {
            try {
                const contract = new ethers.Contract(address, erc20ABI, rpcProvider);
                const balance = await contract.balanceOf(smartWalletAddress);
                const decimals = await contract.decimals();
                const balanceFormatted = ethers.formatUnits(balance, decimals);
                balances[symbol as keyof typeof balances] = balanceFormatted;
                totalUSD += parseFloat(balanceFormatted);
            } catch (error) {
                console.error(`Failed to query ${symbol} balance:`, error);
            }
        }

        return {
            address: smartWalletAddress,
            balances,
            totalUSD,
        };
    }

    /**
     * Get authorization status for Predict exchange contracts
     *
     * @param smartWalletAddress - Predict smart wallet address
     * @param provider - Optional ethers provider
     * @returns Authorization status for each exchange contract
     */
    async getExchangeAuthorizations(
        smartWalletAddress: string = process.env.PREDICT_SMART_WALLET_ADDRESS || '',
        provider?: ethers.JsonRpcProvider
    ): Promise<{
        CTF_EXCHANGE: { USDT: boolean; USDC: boolean; BUSD: boolean };
        YIELD_BEARING_CTF_EXCHANGE: { USDT: boolean; USDC: boolean; BUSD: boolean };
        NEG_RISK_CTF_EXCHANGE: { USDT: boolean; USDC: boolean; BUSD: boolean };
        YIELD_BEARING_NEG_RISK_CTF_EXCHANGE: { USDT: boolean; USDC: boolean; BUSD: boolean };
    }> {
        if (!smartWalletAddress) {
            throw new Error('Smart wallet address is required. Set PREDICT_SMART_WALLET_ADDRESS in .env');
        }

        const rpcProvider = provider || new ethers.JsonRpcProvider(getBscRpcUrl());

        const tokens = {
            USDT: '0x55d398326f99059fF775485246999027B3197955',
            USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
            BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
        };

        const exchanges = {
            CTF_EXCHANGE: '0x8BC070BEdAB741406F4B1Eb65A72bee27894B689',
            YIELD_BEARING_CTF_EXCHANGE: '0x6bEb5a40C032AFc305961162d8204CDA16DECFa5',
            NEG_RISK_CTF_EXCHANGE: '0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A',
            YIELD_BEARING_NEG_RISK_CTF_EXCHANGE: '0x8A289d458f5a134bA40015085A8F50Ffb681B41d',
        };

        const erc20ABI = ['function allowance(address owner, address spender) view returns (uint256)'];

        const result: any = {};

        for (const [exchangeName, exchangeAddress] of Object.entries(exchanges)) {
            result[exchangeName] = {};
            for (const [symbol, tokenAddress] of Object.entries(tokens)) {
                try {
                    const contract = new ethers.Contract(tokenAddress, erc20ABI, rpcProvider);
                    const allowance = await contract.allowance(smartWalletAddress, exchangeAddress);
                    result[exchangeName][symbol] = allowance > 0n;
                } catch {
                    result[exchangeName][symbol] = false;
                }
            }
        }

        return result;
    }
}
