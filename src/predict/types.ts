/**
 * Predict.fun API Type Definitions
 * 
 * Types for interacting with Predict REST API
 */

// ============================================================================
// Order Book Types
// ============================================================================

/**
 * Raw order book response from Predict API
 * Note: All prices are for YES outcome only
 * NO price = 1 - YES price
 */
export interface PredictOrderBook {
    marketId: number;
    updateTimestampMs: number;
    asks: [number, number][]; // [price, quantity] - YES sell orders
    bids: [number, number][]; // [price, quantity] - YES buy orders
}

/**
 * Normalized order book format (compatible with Polymarket)
 */
export interface NormalizedOrderBook {
    marketId: string;
    assetId: string;
    updateTimestampMs: number;
    asks: [number, number][]; // [price, quantity]
    bids: [number, number][]; // [price, quantity]
    minOrderSize: number;
    tickSize: number;
    isNegRisk: boolean;
}

// ============================================================================
// Market Types
// ============================================================================

// Actual API status values (not documented but observed)
export type MarketStatus =
    | 'REGISTERED'      // Market is registered and can have orderbook/trades
    | 'PRICE_PROPOSED'  // Resolution price proposed
    | 'PRICE_DISPUTED'  // Resolution disputed
    | 'PAUSED'          // Trading paused
    | 'UNPAUSED'        // Trading resumed
    | 'RESOLVED';       // Market resolved/settled

export type MarketCategory = 'crypto' | 'sports' | 'politics' | 'entertainment' | 'science' | 'other';

export interface MarketOutcome {
    name: string;
    indexSet: number;
    onChainId: string;
    status: 'WON' | 'LOST' | null;
}

export interface PredictMarket {
    id: number;
    title: string;
    question: string;
    description: string;
    imageUrl: string;
    status: MarketStatus;
    isNegRisk: boolean;
    isYieldBearing: boolean;
    feeRateBps: number;
    resolution: MarketOutcome | null;
    oracleQuestionId: string;
    conditionId: string;
    resolverAddress: string;
    outcomes: MarketOutcome[];
    questionIndex: number | null;
    spreadThreshold: number;
    shareThreshold: number;
    polymarketConditionIds: string[];  // Link to Polymarket!
    kalshiMarketTicker: string | null;
    categorySlug: string;
    createdAt: string;
    decimalPrecision: 2 | 3;

    // Boost state (from REST API)
    isBoosted?: boolean;
    boostStartsAt?: string | null;
    boostEndsAt?: string | null;

    // Backwards-compat fields (kept optional so older consumers keep compiling)
    volume?: number;
    liquidity?: number;
    resolutionDate?: string | null;
    endDate?: string | null;
    lastPrice?: number;
    category?: string;
}

export interface MarketStats {
    marketId: number;
    volume24h: number;
    volume7d: number;
    volume30d: number;
    volumeTotal: number;
    liquidity: number;
    tradeCount24h: number;
    tradeCount7d: number;
}

export interface LastSale {
    marketId: number;
    price: number;
    quantity: number;
    side: 'BUY' | 'SELL';
    timestamp: string;
    transactionHash: string | null;
}

// ============================================================================
// Order Types
// ============================================================================

export type OrderSide = 'BUY' | 'SELL';
export type OrderStatus = 'OPEN' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'EXPIRED';
export type OrderType = 'LIMIT' | 'MARKET';

export interface PredictOrder {
    hash: string;
    marketId: number;
    outcomeId: number;
    maker: string;
    side: OrderSide;
    price: number;
    quantity: number;
    quantityFilled: number;
    status: OrderStatus;
    type: OrderType;
    createdAt: string;
    expiresAt: string | null;
    signature: string;
}

export interface OrderMatchParticipant {
    quoteType: 'Ask' | 'Bid';
    amount: string;
    price: string;
    outcome: MarketOutcome;
    signer: string;
}

export interface OrderMatch {
    market: PredictMarket;
    taker: OrderMatchParticipant;
    amountFilled: string;
    priceExecuted: string;
    makers: OrderMatchParticipant[];
    transactionHash: string;
    executedAt: string;
}

// ============================================================================
// Authentication Types
// ============================================================================

export interface AuthMessage {
    message: string;
    nonce: string;
    issuedAt: string;
    expiresAt: string;
}

export interface AuthToken {
    token: string;
    expiresAt: string;
    address: string;
}

// ============================================================================
// Account Types
// ============================================================================

export interface PredictAccount {
    address: string;
    predictAccountAddress: string | null;
    createdAt: string;
    positions: Position[];
}

export interface Position {
    marketId: number;
    outcomeId: number;
    quantity: number;
    averagePrice: number;
    currentPrice: number | null;
    profitLoss: number | null;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface ApiResponse<T> {
    success: boolean;
    data: T;
    error?: string;
}

export interface PaginatedResponse<T> {
    success: boolean;
    data: T[];
    pagination: {
        page: number;
        pageSize: number;
        total: number;
        hasMore: boolean;
    };
}

// ============================================================================
// Request Types
// ============================================================================

export interface GetMarketsParams {
    status?: MarketStatus;
    category?: MarketCategory;
    limit?: number;
    offset?: number;
    orderBy?: 'volume' | 'liquidity' | 'createdAt' | 'endDate';
    orderDir?: 'asc' | 'desc';
    search?: string;
}

export interface GetOrdersParams {
    marketId?: number;
    status?: OrderStatus;
    side?: OrderSide;
    limit?: number;
    offset?: number;
}

export interface GetMatchesParams {
    marketId?: number;
    category?: MarketCategory;
    minValue?: number;
    limit?: number;
    offset?: number;
}

// ============================================================================
// Client Options
// ============================================================================

export interface PredictClientOptions {
    baseUrl?: string;
    apiKey?: string;
    requestTimeout?: number;
    maxRetries?: number;
}

export interface AuthenticatedClientOptions extends PredictClientOptions {
    privateKey?: string;
    predictAccount?: string;
}

// ============================================================================
// Callback Types
// ============================================================================

export type OrderBookCallback = (book: NormalizedOrderBook) => void;
export type PriceCallback = (marketId: number, price: number, side: OrderSide) => void;
