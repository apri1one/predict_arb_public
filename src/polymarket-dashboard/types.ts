/**
 * Polymarket Sports Dashboard — 专用类型
 *
 * 纯 Polymarket 数据源，无 Predict 依赖
 */

// ============================================================================
// 运动类型
// ============================================================================

export type PolySportType = 'nba' | 'nhl' | 'football' | 'lol' | 'cs2' | 'dota2';

// ============================================================================
// 赛事市场
// ============================================================================

export type PolyMarketType = 'moneyline' | 'three-way' | 'futures' | 'outright';

export interface PolySportsMarket {
    conditionId: string;
    question: string;
    slug: string;
    sport: PolySportType;
    homeTeam: string;
    awayTeam: string;
    gameStartTime?: string;

    // 市场类型
    marketType: PolyMarketType;

    // Token (moneyline binary only)
    awayTokenId: string;        // clobTokenIds[0]
    homeTokenId: string;        // clobTokenIds[1]
    negRisk: boolean;
    tickSize: number;

    // 赔率 (来自 outcomePrices 或订单簿)
    awayPrice: number;
    homePrice: number;

    // 订单簿 (moneyline binary only)
    orderbook: PolySportsOrderbook;

    // 元数据
    volume: number;
    liquidity: number;
    eventTitle?: string;
    eventSlug?: string;

    // 多选 (three-way / futures / outright)
    isThreeWay?: boolean;
    selections?: PolySportsSelection[];

    lastUpdated: number;
}

export interface PolySportsOrderbook {
    awayBid: number; awayAsk: number;
    awayBidDepth: number; awayAskDepth: number;
    homeBid: number; homeAsk: number;
    homeBidDepth: number; homeAskDepth: number;
}

export interface PolySportsSelection {
    label: string;          // "Home"/"Draw"/"Away"
    conditionId: string;
    tokenId: string;
    price: number;
    bid: number; ask: number;
    bidDepth: number; askDepth: number;
}

// ============================================================================
// SSE 推送类型
// ============================================================================

export interface PolySportsSSE {
    snapshot?: boolean;
    updated: PolySportsMarket[];
    removed: string[];          // conditionId 列表
    stats: PolySportsStats;
    balance?: number;
    lastUpdate: number;
}

export interface PolySportsStats {
    total: number;
    bySport: Record<PolySportType, number>;
}

// ============================================================================
// 下单类型
// ============================================================================

export interface PolyOrderRequest {
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
    negRisk: boolean;
    orderType?: 'GTC' | 'GTD' | 'FOK' | 'FAK' | 'IOC';
}

export interface PolyOrderResponse {
    success: boolean;
    orderId?: string;
    error?: string;
}

// ============================================================================
// Tag 映射
// ============================================================================

export const POLY_SPORT_TAGS: Partial<Record<PolySportType, number[]>> = {
    nba: [745],
    nhl: [899],
    football: [82],
    lol: [65],
    cs2: [],
    dota2: [],
};

export const POLY_SPORT_TAG_SLUGS: Partial<Record<PolySportType, string[]>> = {
    nba: ['basketball'],
    nhl: ['hockey'],
    football: ['soccer'],
    lol: ['league-of-legends'],
};
