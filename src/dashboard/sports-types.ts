/**
 * Sports Market Types
 *
 * 体育市场套利相关类型定义
 */

import type { ArbOpportunity } from './types.js';

// ============================================================================
// Polymarket Sports API Types
// ============================================================================

export interface PolySportsMetadata {
    id: number;
    sport: string;
    image: string;
    resolution: string;
    ordering: string;
    tags: string;
    series: string;
}

export interface PolyMarket {
    id: string;
    question: string;
    conditionId: string;
    slug: string;
    outcomes: string;           // JSON string: '["Heat", "Bulls"]' 或 '["Yes", "No"]' (足球等三方市场)
    outcomePrices: string;      // JSON string: '["0.45", "0.55"]'
    clobTokenIds: string;       // JSON string: '["token1", "token2"]'
    endDate: string;
    liquidity: string;
    volume: string;
    active: boolean;
    closed: boolean;
    gameStartTime?: string;
    neg_risk?: boolean;
    groupItemTitle?: string;    // Gamma API: 球队名 (如 "Manchester United FC") 或 "Draw (...)"
    events?: Array<{            // Gamma API: 父事件信息
        title?: string;         // 如 "Manchester United FC vs. Tottenham Hotspur FC"
        slug?: string;          // 如 "epl-mun-tot-2026-02-07"
        startTime?: string;
        live?: boolean;
        ended?: boolean;
        period?: string;
        score?: string;
    }>;
}

// ============================================================================
// Predict Sports Market Types
// ============================================================================

export interface PredictMarket {
    id: number;
    title: string;
    categorySlug: string;
    status: string;
    outcomes: Array<{
        name: string;
        tokenId?: string;
    }>;
    polymarketConditionIds?: string[];
    feeRateBps: number;
    isNegRisk?: boolean;
    tickSize?: number;
}

export interface PredictOrderBook {
    bids: Array<[number, number]>;  // [price, size]
    asks: Array<[number, number]>;
}

// ============================================================================
// Sports Matching Types
// ============================================================================

export type SportType = 'nba' | 'nfl' | 'nhl' | 'mlb' | 'epl' | 'mma' | 'lol' | 'dota' | 'cs';

export type MatchMethod = 'conditionId' | 'slug' | 'nba-slug' | 'title';

export type SportsSelectionKind = 'teamA' | 'draw' | 'teamB' | 'match' | 'game1' | 'game2' | 'unknown';

export interface MatchedMarket {
    predictId: number;
    predictTitle: string;
    predictCategorySlug: string;
    polymarketId: string;
    polymarketQuestion: string;
    polymarketConditionId: string;
    polymarketSlug: string;
    polymarketLiquidity: number;
    polymarketVolume: number;
    predictVolume: number;
    matchMethod: MatchMethod;
}

// ============================================================================
// Sports Arbitrage Types
// ============================================================================

/**
 * 体育市场订单簿 (两个队伍的订单簿)
 *
 * NBA 结构: Predict 一场比赛 = 2 个独立市场 (Away YES/NO, Home YES/NO)
 * 其他体育: Predict 一场比赛 = 1 个市场 (outcomes[0]=Away, outcomes[1]=Home)
 */
export interface SportsOrderBook {
    // Predict 订单簿
    // NBA: 来自两个独立市场的 YES 订单簿
    // 其他: 来自单个市场的 outcomes[0]，主队通过反演
    predict: {
        awayBid: number;       // 客队买一价 (NBA: Away市场 YES bid)
        awayAsk: number;       // 客队卖一价 (NBA: Away市场 YES ask)
        awayBidDepth: number;  // 客队买一深度
        awayAskDepth: number;  // 客队卖一深度
        homeBid: number;       // 主队买一价 (NBA: Home市场 YES bid)
        homeAsk: number;       // 主队卖一价 (NBA: Home市场 YES ask)
        homeBidDepth: number;  // 主队买一深度
        homeAskDepth: number;  // 主队卖一深度
        /** 客队市场前 N 档原始 levels（PP yield 公式专用，按 1, 1/3, 1/9 加权累加） */
        awayBidLevels?: [number, number][];
        awayAskLevels?: [number, number][];
    };

    // Polymarket 订单簿 (两个 token 独立获取)
    polymarket: {
        awayBid: number;       // 客队买一价
        awayAsk: number;       // 客队卖一价
        awayBidDepth: number;
        awayAskDepth: number;
        homeBid: number;       // 主队买一价
        homeAsk: number;       // 主队卖一价
        homeBidDepth: number;
        homeAskDepth: number;
    };
}

/**
 * 体育市场套利机会 (单方向)
 */
export interface SportsArbOpportunity {
    // 套利方向: 买客队还是买主队
    direction: 'away' | 'home';

    // 模式: P.(Predict挂单) / M.(Poly挂单) / T-T(双吃单)
    mode: 'PREDICT_MAKER' | 'TAKER' | 'POLY_MAKER';

    // 成本和利润
    cost: number;              // 总成本 (< 1 表示有利润)
    profit: number;            // 1 - cost
    profitPercent: number;     // profit * 100

    // 价格明细
    predictPrice: number;      // Predict 买入价格
    polyHedgePrice: number;    // Polymarket 对冲买入价格
    predictFee: number;        // Predict 手续费 (Taker 模式)

    // 深度
    maxQuantity: number;       // 最大可套利数量
    predictDepth: number;      // Predict 端深度
    polyDepth: number;         // Polymarket 对冲端深度

    // 是否有效 (profit > 0)
    isValid: boolean;
}

/**
 * 体育市场完整套利信息
 *
 * 每场比赛计算 4 个套利机会 (2方向 × 2模式)，但根据互斥性原理，
 * 同一时刻只有一个方向可能有利润
 *
 * NBA 特殊结构: Predict 一场比赛 = 2 个独立市场
 * - predictAwayMarketId: 客队获胜市场 (买 YES = 买客队)
 * - predictHomeMarketId: 主队获胜市场 (买 YES = 买主队)
 */
export interface SportsMatchedMarket {
    // 匹配信息 (NBA: 使用客队市场 ID 作为主 ID)
    predictMarketId: number;
    predictTitle: string;
    predictCategorySlug: string;
    predictSlug?: string;           // URL slug (从缓存获取)
    polymarketConditionId: string;
    polymarketQuestion: string;
    polymarketSlug: string;
    eventKey?: string;                // 事件键（默认 categorySlug）
    eventTitle?: string;              // 事件标题（优先 Poly events[0].title）
    isThreeWayEvent?: boolean;        // 是否足球三项盘（同 slug 3 个子市场且含 draw）
    selectionKind?: SportsSelectionKind;   // 当前子市场属于 teamA/draw/teamB
    selectionLabel?: string;          // 当前子市场展示名（如 "Oviedo" / "Draw"）
    selectionCanonical?: string;      // 当前子市场 canonical 名（用于分组归并）

    // NBA 双市场 ID (其他体育类型两个值相同)
    predictAwayMarketId: number;    // 客队获胜市场 ID
    predictHomeMarketId: number;    // 主队获胜市场 ID

    // 比赛信息
    sport: SportType;
    homeTeam: string;
    awayTeam: string;
    gameDate?: string;
    gameStartTime?: string;

    // Token 映射 (用于创建任务)
    polymarketAwayTokenId: string;   // 客队 token (outcomes[0])
    polymarketHomeTokenId: string;   // 主队 token (outcomes[1])
    negRisk: boolean;
    tickSize: number;
    feeRateBps: number;

    // 订单簿数据
    orderbook: SportsOrderBook;

    // 4 个套利机会 (实际只有最多 2 个有效，因为方向互斥)
    awayMT?: SportsArbOpportunity;   // 买客队，M-T
    awayTT?: SportsArbOpportunity;   // 买客队，T-T
    homeMT?: SportsArbOpportunity;   // 买主队，M-T
    homeTT?: SportsArbOpportunity;   // 买主队，T-T

    // 最佳机会 (用于前端快速显示)
    bestOpportunity?: {
        direction: 'away' | 'home';
        mode: 'PREDICT_MAKER' | 'TAKER' | 'POLY_MAKER';
        profitPercent: number;
    };

    // 一致性校验结果
    consistency: {
        isValid: boolean;           // 是否通过一致性校验
        bothDirectionsProfitable: boolean;  // 是否两个方向都有利润 (异常)
        warning?: string;
    };

    // 状态
    // Boost state
    boosted?: boolean;
    boostStartTime?: string;
    boostEndTime?: string;

    // PP 奖励档位 (来自 rewards-cache → graphql.predict.fun)
    pointsTier?: number;          // 当前活跃 tier (1-5), 0/缺省 = 无活跃奖励
    pointsHourlyRate?: number;    // 当前 PP/hr
    pointsExpiresAt?: string;     // 建议挂单到此时间 (ISO)
    pointsNextTier?: number;      // 下一窗口 tier
    pointsNextHourlyRate?: number;
    pointsNextStartsAt?: string;
    pointsYield?: number;    // hourlyRate / best bid+ask notional (越大越好挂)

    polymarketLiquidity: number;
    polymarketVolume: number;
    predictVolume: number;
    lastUpdated: number;
}

/**
 * 体育市场创建任务参数
 */
export interface SportsCreateTaskParams {
    // 市场信息
    marketId: number;
    title: string;
    polymarketConditionId: string;

    // 套利方向和模式
    direction: 'away' | 'home';     // 买客队还是买主队
    mode: 'PREDICT_MAKER' | 'TAKER';        // M-T 或 T-T

    // 转换为标准 arbSide
    // direction='away' → arbSide='YES' (买 outcomes[0])
    // direction='home' → arbSide='NO' (买 outcomes[1])

    // Token 映射
    polymarketYesTokenId: string;   // = awayTokenId
    polymarketNoTokenId: string;    // = homeTokenId

    // 价格
    predictPrice: number;           // Maker: bid, Taker: ask
    polymarketMaxAsk: number;       // 对冲买入价上限

    // 配置
    quantity: number;
    negRisk: boolean;
    tickSize: number;
    feeRateBps: number;
}

// ============================================================================
// SSE Event Types
// ============================================================================

export interface SportsSSEData {
    markets: SportsMatchedMarket[];
    stats: {
        totalMatched: number;
        withArbitrage: number;
        avgProfit: number;
        maxProfit: number;
    };
    lastUpdate: number;
}

// ============================================================================
// Constants
// ============================================================================

export const POLY_SPORTS_TAGS: Record<SportType, number> = {
    nba: 745,
    nfl: 450,
    nhl: 899,
    mlb: 1,      // placeholder
    epl: 82,
    mma: 1,      // placeholder
    lol: 65,
    dota: 1,     // placeholder - 通过 series 拉取 (POLY_SPORTS_SERIES)
    cs: 1,       // placeholder - 通过 series 拉取 (POLY_SPORTS_SERIES)
};

// Polymarket 电竞市场没有 tag，用 events.series.id 标识
// 通过 gamma-api/events?series_id=X 批量拉取，避免逐个 conditionId 反查 CLOB API
export const POLY_SPORTS_SERIES: Partial<Record<SportType, number>> = {
    dota: 10309,  // Dota 2
    cs: 10310,    // Counter Strike
};

export const SPORTS_KEYWORDS: string[] = [
    'nba', 'nfl', 'nhl', 'mlb', 'epl', 'soccer', 'tennis', 'mma', 'ufc', 'lol', 'dota', 'cs',
    // 足球联赛关键词（覆盖 categorySlug 里不含 epl/soccer 的场景）
    'la-liga', 'laliga', 'lal-', 'la liga', 'serie-a', 'bundesliga', 'ligue-1', 'premier-league'
];

// NBA 城市名 -> 缩写 (用于匹配 Predict "X-at-Y" 格式)
export const NBA_CITY_TO_ABBR: Record<string, string> = {
    'atlanta': 'atl',
    'boston': 'bos',
    'brooklyn': 'bkn',
    'charlotte': 'cha',
    'chicago': 'chi',
    'cleveland': 'cle',
    'dallas': 'dal',
    'denver': 'den',
    'detroit': 'det',
    'golden-state': 'gsw',
    'houston': 'hou',
    'indiana': 'ind',
    'la-clippers': 'lac',
    'la-lakers': 'lal',
    'los-angeles': 'lal',
    'memphis': 'mem',
    'miami': 'mia',
    'milwaukee': 'mil',
    'minnesota': 'min',
    'new-orleans': 'nop',
    'new-york': 'nyk',
    'oklahoma-city': 'okc',
    'orlando': 'orl',
    'philadelphia': 'phi',
    'phoenix': 'phx',
    'portland': 'por',
    'sacramento': 'sac',
    'san-antonio': 'sas',
    'toronto': 'tor',
    'utah': 'uta',
    'washington': 'was',
};

// NBA 缩写 -> 球队名
export const NBA_ABBR_TO_TEAM: Record<string, string> = {
    'atl': 'Hawks',
    'bos': 'Celtics',
    'bkn': 'Nets',
    'cha': 'Hornets',
    'chi': 'Bulls',
    'cle': 'Cavaliers',
    'dal': 'Mavericks',
    'den': 'Nuggets',
    'det': 'Pistons',
    'gsw': 'Warriors',
    'hou': 'Rockets',
    'ind': 'Pacers',
    'lac': 'Clippers',
    'lal': 'Lakers',
    'mem': 'Grizzlies',
    'mia': 'Heat',
    'mil': 'Bucks',
    'min': 'Timberwolves',
    'nop': 'Pelicans',
    'nyk': 'Knicks',
    'okc': 'Thunder',
    'orl': 'Magic',
    'phi': '76ers',
    'phx': 'Suns',
    'por': 'Trail Blazers',
    'sac': 'Kings',
    'sas': 'Spurs',
    'tor': 'Raptors',
    'uta': 'Jazz',
    'was': 'Wizards',
};

// 一致性校验阈值
export const CONSISTENCY_EPSILON = 0.001;  // 如果两个方向都 cost < 1 - ε，视为异常

// ============================================================================
// SSE Light Types (轻量版，减少 ~90% 体积)
// ============================================================================

/**
 * SSE 轻量版市场数据（剥离前端不需要的字段，~300B/market vs ~8KB/market）
 * IMPORTANT: 新增 SportsMatchedMarket 中前端 SSE 需要的字段时，
 * 必须同步添加到此类型和 getSSEDataLight() 的映射中。
 * REST 端点 GET /api/sports 使用 getSSEData()（完整数据）不受影响。
 */
export interface SportsSSEMarketLight {
    // 标识 & 匹配
    predictMarketId: number;
    predictAwayMarketId: number;
    predictHomeMarketId: number;
    predictTitle: string;
    polymarketConditionId: string;
    predictSlug?: string;
    polymarketSlug: string;

    // 足球三方事件（前端分组必需）
    eventKey?: string;
    eventTitle?: string;
    isThreeWayEvent?: boolean;
    selectionKind?: SportsSelectionKind;
    selectionLabel?: string;

    // 比赛信息
    sport: SportType;
    homeTeam: string;
    awayTeam: string;
    gameStartTime?: string;

    // Token 映射（创建任务必需）
    polymarketAwayTokenId: string;
    polymarketHomeTokenId: string;
    negRisk: boolean;
    tickSize: number;
    feeRateBps: number;

    // 套利机会
    awayMT?: SportsArbOpportunity;
    awayTT?: SportsArbOpportunity;
    homeMT?: SportsArbOpportunity;
    homeTT?: SportsArbOpportunity;
    bestOpportunity?: {
        direction: 'away' | 'home';
        mode: 'PREDICT_MAKER' | 'TAKER' | 'POLY_MAKER';
        profitPercent: number;
    };

    // 校验
    consistency: {
        isValid: boolean;
        bothDirectionsProfitable: boolean;
        warning?: string;
    };

    // Boost
    boosted?: boolean;
    boostStartTime?: string;
    boostEndTime?: string;

    // PP 奖励档位
    pointsTier?: number;
    pointsHourlyRate?: number;
    pointsExpiresAt?: string;
    pointsNextTier?: number;
    pointsNextHourlyRate?: number;
    pointsNextStartsAt?: string;
    pointsYield?: number;    // hourlyRate / best bid+ask notional

    // 成交量（前端详情面板使用）
    predictVolume: number;
    polymarketVolume: number;
}

export interface SportsSSEDataLight {
    markets: SportsSSEMarketLight[];
    stats: {
        totalMatched: number;
        withArbitrage: number;
        avgProfit: number;
        maxProfit: number;
    };
    lastUpdate: number;
}

// ============================================================================
// SSE Incremental Push Types (增量推送)
// ============================================================================

/**
 * 体育 SSE 增量推送数据
 * - snapshot=true 时 updated 包含全量市场列表（首次连接/重连）
 * - snapshot=false 时 updated 仅包含有变化的市场，removed 包含已删除的市场 ID
 */
export interface SportsSSEIncremental {
    snapshot?: boolean;
    updated: SportsSSEMarketLight[];
    removed: number[];
    stats: {
        totalMatched: number;
        withArbitrage: number;
        avgProfit: number;
        maxProfit: number;
    };
    lastUpdate: number;
}
