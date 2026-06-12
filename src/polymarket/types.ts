/**
 * Polymarket Client Type Definitions
 * 
 * Types for interacting with Polymarket CLOB API and WebSocket
 */

// ============================================================================
// Order Book Types
// ============================================================================

export interface OrderLevel {
    price: string;
    size: string;
}

export interface OrderBookSummary {
    market: string;
    asset_id: string;
    timestamp: string;
    hash: string;
    bids: OrderLevel[];
    asks: OrderLevel[];
    min_order_size: string;
    tick_size: string;
    neg_risk: boolean;
}

// Normalized order book format (compatible with Predict)
export interface NormalizedOrderBook {
    assetId: string;
    marketId: string;
    updateTimestampMs: number;
    asks: [number, number][]; // [price, quantity]
    bids: [number, number][]; // [price, quantity]
    minOrderSize: number;
    tickSize: number;
    isNegRisk: boolean;
}

// ============================================================================
// Price Types
// ============================================================================

export interface PriceResponse {
    price: string;
}

export interface PricesResponse {
    [tokenId: string]: {
        BUY?: string;
        SELL?: string;
    };
}

export interface MidpointResponse {
    mid: string;
}

export interface SpreadsResponse {
    [tokenId: string]: string;
}

export interface PriceHistoryPoint {
    t: number; // UTC timestamp
    p: number; // Price
}

export interface PriceHistoryResponse {
    history: PriceHistoryPoint[];
}

// ============================================================================
// Market Types (Gamma API)
// ============================================================================

export interface PolymarketMarket {
    id: string;
    question: string | null;
    conditionId: string;
    slug: string | null;
    description: string | null;
    outcomes: string | null; // JSON string: '["Yes", "No"]'
    outcomePrices: string | null; // JSON string: '[0.65, 0.35]'
    volume: string | null;
    liquidity: string | null;
    active: boolean | null;
    closed: boolean | null;
    enableOrderBook: boolean | null;
    clobTokenIds: string | null; // JSON string: '["token_yes_id", "token_no_id"]'
    marketMakerAddress: string;
    endDate: string | null;
    startDate: string | null;
    image: string | null;
    negRisk?: boolean;
    volumeNum: number | null;
    liquidityNum: number | null;
    bestBid: number | null;
    bestAsk: number | null;
    lastTradePrice: number | null;
}

export interface PolymarketEvent {
    id: string;
    title: string | null;
    slug: string | null;
    description: string | null;
    active: boolean | null;
    closed: boolean | null;
    markets: PolymarketMarket[];
    volume: number | null;
    liquidity: number | null;
    negRisk: boolean | null;
}

// ============================================================================
// WebSocket Types
// ============================================================================

export type WebSocketChannelType = 'market' | 'user';

export interface WebSocketMarketSubscription {
    type: 'market';
    assets_ids: string[];
}

export interface WebSocketUserSubscription {
    type: 'user';
    markets: string[];
    auth: WebSocketAuth;
}

export interface WebSocketAuth {
    apiKey: string;
    secret: string;
    passphrase: string;
}

export interface WebSocketOrderBookUpdate {
    event_type: 'book';
    asset_id: string;
    market: string;
    timestamp: string;
    hash: string;
    bids: OrderLevel[];
    asks: OrderLevel[];
}

export interface WebSocketPriceChange {
    price: string;
    side: 'buy' | 'sell' | 'BUY' | 'SELL';
    asset_id?: string;
    size?: string;
    hash?: string;
    best_bid?: string;
    best_ask?: string;
}

export interface WebSocketTradeUpdate {
    event_type: 'last_trade_price' | 'price_change';
    asset_id: string;
    market?: string;
    changes?: WebSocketPriceChange[];
    price_changes?: WebSocketPriceChange[];
    price?: string;
    side?: 'BUY' | 'SELL' | 'buy' | 'sell';
    size?: string;
    timestamp?: string;
}

// Initial subscription response is an array of asset data
export type WebSocketInitialResponse = Array<{
    asset_id?: string;
    market?: string;
    bids?: OrderLevel[];
    asks?: OrderLevel[];
}>;

export type WebSocketMessage =
    | WebSocketOrderBookUpdate
    | WebSocketTradeUpdate
    | WebSocketInitialResponse
    | { event_type: string };

// ============================================================================
// Request Types
// ============================================================================

export interface BookRequest {
    token_id: string;
}

export interface PriceRequest {
    token_id: string;
    side: 'BUY' | 'SELL';
}

// ============================================================================
// Client Options
// ============================================================================

export interface PolymarketClientOptions {
    clobBaseUrl?: string;
    gammaBaseUrl?: string;
    wsUrl?: string;
    apiKey?: string;
    apiSecret?: string;
    apiPassphrase?: string;
    requestTimeout?: number;
}

export interface WebSocketClientOptions {
    url: string;
    pingInterval?: number;
    reconnectDelay?: number;
    maxReconnectAttempts?: number;
    onMessage?: (message: WebSocketMessage) => void;
    onConnect?: () => void;
    onDisconnect?: () => void;
    onError?: (error: Error) => void;
}

// ============================================================================
// Callback Types
// ============================================================================

export type OrderBookCallback = (book: NormalizedOrderBook) => void;
export type PriceCallback = (assetId: string, price: number, side: 'BUY' | 'SELL') => void;
export type TradeCallback = (assetId: string, price: number, size: number, side: 'BUY' | 'SELL') => void;
