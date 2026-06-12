import type {
    ArbOpportunity,
    ArbSide,
    AutoTaskPreviewItem,
    AutoTaskPreviewResult,
    AutoTaskPreviewScope,
    AutoTaskPreviewSource,
} from './types.js';
import type { SportsArbOpportunity, SportsMatchedMarket } from './sports-types.js';

const MIN_AUTO_DEPTH_SHARES = 100;
const MIN_AUTO_PRICE = 0.2;
const MAX_AUTO_PRICE = 0.8;
const SPORTS_START_BUFFER_MS = 5 * 60 * 1000;
const SPORTS_EXPIRY_OFFSET_MS = 3 * 60 * 1000;
const NON_SPORTS_EXPIRY_OFFSET_MS = 24 * 60 * 60 * 1000;
const POLY_MIN_NOTIONAL_USD = 1;
const SPORTS_ZERO_PROFIT_EPSILON = 0.0001;

export interface PreviewSeed {
    id: string;
    source: AutoTaskPreviewSource;
    strategy?: 'PREDICT_MAKER' | 'POLY_MAKER';
    marketId: number;
    title: string;
    arbSide: ArbSide;
    predictBidPrice: number;
    predictAskPrice?: number;       // Predict YES ASK（用于 spread 检查）
    polyBidPrice?: number;
    polymarketHedgePrice: number;
    maxQuantity: number;
    estimatedProfit: number;
    profitPercent: number;
    isSportsMarket: boolean;
    endDate?: string;
    gameStartTime?: string;
    predictSlug?: string;
    polymarketSlug?: string;
    polymarketConditionId: string;
    polymarketNoTokenId: string;
    polymarketYesTokenId: string;
    isInverted: boolean;
    tickSize: number;
    negRisk: boolean;
    feeRateBps?: number;
    // PP 奖励档位 (用于 PP-farmer 收益率筛选)
    pointsTier?: number;
    pointsYield?: number;
}

interface RankedSeed {
    seed: PreviewSeed;
    budgetRatio: number;
    desiredQuantity: number;
    minimumPolyQuantity: number;
    expiresAt: number;
    eventTime: number;
    maxQuantity: number;
}

export interface GenerateAutoTaskPreviewParams {
    opportunities: ArbOpportunity[];
    sportsMarkets: SportsMatchedMarket[];
    source?: AutoTaskPreviewScope;
    accounts: {
        predict?: { available?: number };
        polymarket?: { available?: number };
    };
    hasActiveTask: (marketId: number, type: 'BUY' | 'SELL', arbSide: ArbSide, strategy?: 'PREDICT_MAKER' | 'POLY_MAKER') => boolean;
    now?: number;
}

function incrementReason(target: Record<string, number>, reason: string): void {
    target[reason] = (target[reason] || 0) + 1;
}

function parseTimeMs(value?: string): number | null {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function floorShares(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(0, Math.floor(value + 1e-9));
}

function calculateBudgetRatio(price: number): number {
    const distanceFromMid = Math.min(Math.abs(price - 0.5), 0.3);
    const ratio = 0.5 - ((distanceFromMid / 0.3) * 0.2);
    return Math.max(0, Math.min(0.5, Number(ratio.toFixed(4))));
}

function isLiveMakerOpportunity(opportunity: ArbOpportunity): boolean {
    return opportunity.strategy === 'PREDICT_MAKER';
}

function isSportsMakerOpportunity(opportunity?: SportsArbOpportunity): opportunity is SportsArbOpportunity {
    return Boolean(opportunity);
}

function buildSportsTaskTitle(market: SportsMatchedMarket, arbSide: ArbSide): string {
    const hasSelectionTitle = Boolean(market.isThreeWayEvent || market.selectionKind || market.selectionLabel);
    if (hasSelectionTitle) {
        const prefix = market.eventTitle || market.predictTitle;
        const selectionName = market.selectionKind === 'draw'
            ? 'Draw'
            : market.selectionLabel || market.predictTitle;
        return `${prefix} - ${selectionName}`;
    }

    const teamName = arbSide === 'YES' ? market.awayTeam : market.homeTeam;
    return `${market.predictTitle} - Buy ${teamName}`;
}

export function buildSportsSeeds(markets: SportsMatchedMarket[]): PreviewSeed[] {
    const seeds: PreviewSeed[] = [];

    for (const market of markets) {
        const marketId = market.predictAwayMarketId || market.predictMarketId;

        // Predict YES 卖一（用于 spread 检查）：away 任务的 ask = away orderbook ask
        const awayAsk = market.orderbook?.predict?.awayAsk;
        // home（NO）任务的 ask = 1 - awayBid
        const homeAsk = (typeof market.orderbook?.predict?.awayBid === 'number')
            ? 1 - market.orderbook.predict.awayBid
            : undefined;

        if (isSportsMakerOpportunity(market.awayMT)) {
            seeds.push({
                id: `sports:${marketId}:YES`,
                source: 'sports',
                marketId,
                title: buildSportsTaskTitle(market, 'YES'),
                arbSide: 'YES',
                predictBidPrice: market.awayMT.predictPrice,
                predictAskPrice: awayAsk,
                polymarketHedgePrice: market.awayMT.polyHedgePrice,
                maxQuantity: market.awayMT.maxQuantity,
                estimatedProfit: market.awayMT.profit * market.awayMT.maxQuantity,
                profitPercent: market.awayMT.profitPercent,
                isSportsMarket: true,
                gameStartTime: market.gameStartTime,
                predictSlug: market.predictSlug,
                polymarketSlug: market.polymarketSlug,
                polymarketConditionId: market.polymarketConditionId,
                polymarketNoTokenId: market.polymarketHomeTokenId,
                polymarketYesTokenId: market.polymarketAwayTokenId,
                isInverted: false,
                tickSize: market.tickSize,
                negRisk: market.negRisk,
                feeRateBps: market.feeRateBps,
                pointsTier: market.pointsTier,
                pointsYield: market.pointsYield,
            });
        }

        if (isSportsMakerOpportunity(market.homeMT)) {
            seeds.push({
                id: `sports:${marketId}:NO`,
                source: 'sports',
                marketId,
                title: buildSportsTaskTitle(market, 'NO'),
                arbSide: 'NO',
                predictBidPrice: market.homeMT.predictPrice,
                predictAskPrice: homeAsk,
                polymarketHedgePrice: market.homeMT.polyHedgePrice,
                maxQuantity: market.homeMT.maxQuantity,
                estimatedProfit: market.homeMT.profit * market.homeMT.maxQuantity,
                profitPercent: market.homeMT.profitPercent,
                isSportsMarket: true,
                gameStartTime: market.gameStartTime,
                predictSlug: market.predictSlug,
                polymarketSlug: market.polymarketSlug,
                polymarketConditionId: market.polymarketConditionId,
                polymarketNoTokenId: market.polymarketHomeTokenId,
                polymarketYesTokenId: market.polymarketAwayTokenId,
                isInverted: false,
                tickSize: market.tickSize,
                negRisk: market.negRisk,
                feeRateBps: market.feeRateBps,
                pointsTier: market.pointsTier,
                pointsYield: market.pointsYield,
            });
        }
    }

    return seeds;
}

function buildSportsPolyMakerSeeds(markets: SportsMatchedMarket[]): PreviewSeed[] {
    const seeds: PreviewSeed[] = [];

    for (const market of markets) {
        const marketId = market.predictAwayMarketId || market.predictMarketId;

        if (isSportsMakerOpportunity(market.awayTT)) {
            seeds.push({
                id: `poly-maker:${marketId}:YES`,
                source: 'sports',
                strategy: 'POLY_MAKER',
                marketId,
                title: buildSportsTaskTitle(market, 'YES'),
                arbSide: 'YES',
                predictBidPrice: market.awayTT.predictPrice,
                polyBidPrice: market.awayTT.polyHedgePrice,
                polymarketHedgePrice: market.awayTT.polyHedgePrice,
                maxQuantity: market.awayTT.maxQuantity,
                estimatedProfit: market.awayTT.profit * market.awayTT.maxQuantity,
                profitPercent: market.awayTT.profitPercent,
                isSportsMarket: true,
                gameStartTime: market.gameStartTime,
                predictSlug: market.predictSlug,
                polymarketSlug: market.polymarketSlug,
                polymarketConditionId: market.polymarketConditionId,
                polymarketNoTokenId: market.polymarketHomeTokenId,
                polymarketYesTokenId: market.polymarketAwayTokenId,
                isInverted: false,
                tickSize: market.tickSize,
                negRisk: market.negRisk,
                feeRateBps: market.feeRateBps,
            });
        }

        if (isSportsMakerOpportunity(market.homeTT)) {
            seeds.push({
                id: `poly-maker:${marketId}:NO`,
                source: 'sports',
                strategy: 'POLY_MAKER',
                marketId,
                title: buildSportsTaskTitle(market, 'NO'),
                arbSide: 'NO',
                predictBidPrice: market.homeTT.predictPrice,
                polyBidPrice: market.homeTT.polyHedgePrice,
                polymarketHedgePrice: market.homeTT.polyHedgePrice,
                maxQuantity: market.homeTT.maxQuantity,
                estimatedProfit: market.homeTT.profit * market.homeTT.maxQuantity,
                profitPercent: market.homeTT.profitPercent,
                isSportsMarket: true,
                gameStartTime: market.gameStartTime,
                predictSlug: market.predictSlug,
                polymarketSlug: market.polymarketSlug,
                polymarketConditionId: market.polymarketConditionId,
                polymarketNoTokenId: market.polymarketHomeTokenId,
                polymarketYesTokenId: market.polymarketAwayTokenId,
                isInverted: false,
                tickSize: market.tickSize,
                negRisk: market.negRisk,
                feeRateBps: market.feeRateBps,
            });
        }
    }

    return seeds;
}

export function buildLiveSeeds(opportunities: ArbOpportunity[], sportsMarkets: SportsMatchedMarket[]): PreviewSeed[] {
    const sportsMarketIds = new Set<number>();
    for (const market of sportsMarkets) {
        for (const marketId of [market.predictMarketId, market.predictAwayMarketId, market.predictHomeMarketId]) {
            if (Number.isFinite(marketId)) {
                sportsMarketIds.add(marketId);
            }
        }
    }

    return opportunities
        .filter((opp) => isLiveMakerOpportunity(opp))
        .filter((opp) => !sportsMarketIds.has(opp.marketId))
        .filter((opp) => !(opp.title && / vs\.? /i.test(opp.title)))
        .map((opp) => ({
            id: `live:${opp.marketId}:${opp.side}`,
            source: 'all',
            marketId: opp.marketId,
            title: opp.title,
            arbSide: opp.side,
            predictBidPrice: opp.predictBid || opp.predictPrice,
            predictAskPrice: opp.predictAsk,
            polymarketHedgePrice: opp.polymarketPrice,
            maxQuantity: opp.maxQuantity,
            estimatedProfit: opp.estimatedProfit,
            profitPercent: opp.profitPercent,
            isSportsMarket: false,
            endDate: opp.endDate,
            predictSlug: opp.predictSlug,
            polymarketSlug: opp.polymarketSlug,
            polymarketConditionId: opp.polymarketConditionId,
            polymarketNoTokenId: opp.polymarketNoTokenId,
            polymarketYesTokenId: opp.polymarketYesTokenId,
            isInverted: opp.isInverted,
            tickSize: opp.tickSize,
            negRisk: opp.negRisk,
            feeRateBps: opp.feeRateBps,
            pointsTier: opp.pointsTier,
            pointsYield: opp.pointsYield,
        }));
}

export function generateAutoTaskPreview(params: GenerateAutoTaskPreviewParams): AutoTaskPreviewResult {
    const now = params.now ?? Date.now();
    const source = params.source || 'mixed';
    const skipped: Record<string, number> = {};
    const warnings: string[] = [];
    const predictAvailable = Math.max(0, Number(params.accounts.predict?.available || 0));
    const polymarketAvailable = Math.max(0, Number(params.accounts.polymarket?.available || 0));

    if (predictAvailable <= 0) {
        warnings.push('Predict 可用余额为 0，预览结果可能不可执行。');
    }
    if (polymarketAvailable <= 0) {
        warnings.push('Polymarket 可用余额为 0；任务仍会预览，但若立即满成交将无法完成对冲。');
    }
    warnings.push('当前预览按“可创建任务池”生成，不使用 Polymarket 总余额做候选数量裁剪。');

    const rawSeeds = source === 'all'
        ? buildLiveSeeds(params.opportunities, params.sportsMarkets)
        : source === 'sports'
            ? buildSportsSeeds(params.sportsMarkets)
            : source === 'poly-maker'
                ? buildSportsPolyMakerSeeds(params.sportsMarkets)
                : [
                    ...buildLiveSeeds(params.opportunities, params.sportsMarkets),
                    ...buildSportsSeeds(params.sportsMarkets),
                ];

    // 去重 key 不含 strategy: 同 marketId + arbSide 只保留利润最高的策略
    // 防止同一方向同时存在 PREDICT_MAKER 和 POLY_MAKER (negRisk 自成交风险)
    const dedupedSeeds = new Map<string, PreviewSeed>();
    for (const seed of rawSeeds) {
        const key = `${seed.marketId}:${seed.arbSide}`;
        const existing = dedupedSeeds.get(key);
        if (!existing || seed.estimatedProfit > existing.estimatedProfit) {
            dedupedSeeds.set(key, seed);
        }
    }

    const considered = dedupedSeeds.size;
    const rankedSeeds: RankedSeed[] = [];

    for (const seed of dedupedSeeds.values()) {
        if (!Number.isFinite(seed.profitPercent)) {
            incrementReason(skipped, 'invalid_profit');
            continue;
        }
        if (seed.source === 'all' && seed.profitPercent <= 0) {
            incrementReason(skipped, 'live_profit_non_positive');
            continue;
        }
        if (seed.source === 'sports' && seed.profitPercent < -SPORTS_ZERO_PROFIT_EPSILON) {
            incrementReason(skipped, 'sports_profit_negative');
            continue;
        }
        if (!Number.isFinite(seed.predictBidPrice) || !Number.isFinite(seed.polymarketHedgePrice) || seed.predictBidPrice <= 0 || seed.polymarketHedgePrice <= 0) {
            incrementReason(skipped, 'invalid_price');
            continue;
        }
        if (seed.predictBidPrice < MIN_AUTO_PRICE || seed.predictBidPrice > MAX_AUTO_PRICE) {
            incrementReason(skipped, 'price_out_of_range');
            continue;
        }
        if (params.hasActiveTask(seed.marketId, 'BUY', seed.arbSide)) {
            incrementReason(skipped, 'active_task_exists');
            continue;
        }

        let expiresAt: number | null = null;
        let eventTime: number | null = null;
        if (seed.isSportsMarket) {
            const startMs = parseTimeMs(seed.gameStartTime);
            if (!startMs) {
                incrementReason(skipped, 'missing_game_start_time');
                continue;
            }
            if (startMs - now < SPORTS_START_BUFFER_MS) {
                incrementReason(skipped, 'sports_starting_soon');
                continue;
            }
            eventTime = startMs;
            expiresAt = startMs - SPORTS_EXPIRY_OFFSET_MS;
        } else {
            const endMs = parseTimeMs(seed.endDate);
            if (!endMs) {
                incrementReason(skipped, 'missing_end_date');
                continue;
            }
            eventTime = endMs;
            expiresAt = endMs - NON_SPORTS_EXPIRY_OFFSET_MS;
        }

        if (!expiresAt || expiresAt <= now || !eventTime) {
            incrementReason(skipped, 'expiry_already_passed');
            continue;
        }

        const budgetRatio = calculateBudgetRatio(seed.predictBidPrice);
        const predictBudgetQuantity = floorShares((predictAvailable * budgetRatio) / seed.predictBidPrice);
        if (predictBudgetQuantity <= 0) {
            incrementReason(skipped, 'predict_budget_too_small');
            continue;
        }
        const polymarketBudgetQuantity = floorShares((polymarketAvailable * budgetRatio) / seed.polymarketHedgePrice);
        if (polymarketBudgetQuantity <= 0) {
            incrementReason(skipped, 'polymarket_task_budget_too_small');
            continue;
        }
        const desiredQuantity = Math.min(predictBudgetQuantity, polymarketBudgetQuantity);

        const maxQuantity = floorShares(seed.maxQuantity);
        if (maxQuantity < MIN_AUTO_DEPTH_SHARES) {
            incrementReason(skipped, 'depth_below_100');
            continue;
        }

        const minimumPolyQuantity = Math.max(1, Math.ceil(POLY_MIN_NOTIONAL_USD / seed.polymarketHedgePrice));
        const soloQuantity = Math.min(maxQuantity, desiredQuantity);
        if (soloQuantity < minimumPolyQuantity) {
            incrementReason(skipped, 'below_polymarket_minimum');
            continue;
        }

        rankedSeeds.push({
            seed,
            budgetRatio,
            desiredQuantity,
            minimumPolyQuantity,
            expiresAt,
            eventTime,
            maxQuantity,
        });
    }

    rankedSeeds.sort((a, b) => {
        if (a.eventTime !== b.eventTime) return a.eventTime - b.eventTime;
        if (a.expiresAt !== b.expiresAt) return a.expiresAt - b.expiresAt;
        if (b.seed.profitPercent !== a.seed.profitPercent) return b.seed.profitPercent - a.seed.profitPercent;
        if (b.maxQuantity !== a.maxQuantity) return b.maxQuantity - a.maxQuantity;
        return a.seed.title.localeCompare(b.seed.title);
    });

    const candidates: AutoTaskPreviewItem[] = [];

    for (const ranked of rankedSeeds) {
        const quantity = Math.min(ranked.maxQuantity, ranked.desiredQuantity);

        const predictOrderValue = Number((quantity * ranked.seed.predictBidPrice).toFixed(4));
        const polymarketHedgeValue = Number((quantity * ranked.seed.polymarketHedgePrice).toFixed(4));
        const estimatedProfit = ranked.seed.maxQuantity > 0
            ? Number(((ranked.seed.estimatedProfit / ranked.seed.maxQuantity) * quantity).toFixed(4))
            : 0;

        candidates.push({
            id: ranked.seed.id,
            source: ranked.seed.source,
            marketId: ranked.seed.marketId,
            title: ranked.seed.title,
            arbSide: ranked.seed.arbSide,
            quantity,
            maxQuantity: ranked.maxQuantity,
            predictBidPrice: ranked.seed.predictBidPrice,
            polymarketHedgePrice: ranked.seed.polymarketHedgePrice,
            budgetRatio: ranked.budgetRatio,
            predictOrderValue,
            polymarketHedgeValue,
            estimatedProfit,
            profitPercent: ranked.seed.profitPercent,
            expiresAt: ranked.expiresAt,
            endDate: ranked.seed.endDate,
            gameStartTime: ranked.seed.gameStartTime,
            isSportsMarket: ranked.seed.isSportsMarket,
            predictSlug: ranked.seed.predictSlug,
            polymarketSlug: ranked.seed.polymarketSlug,
            polymarketConditionId: ranked.seed.polymarketConditionId,
            polymarketNoTokenId: ranked.seed.polymarketNoTokenId,
            polymarketYesTokenId: ranked.seed.polymarketYesTokenId,
            isInverted: ranked.seed.isInverted,
            tickSize: ranked.seed.tickSize,
            negRisk: ranked.seed.negRisk,
            feeRateBps: ranked.seed.feeRateBps,
            ...(ranked.seed.strategy ? { strategy: ranked.seed.strategy } : {}),
            ...(ranked.seed.polyBidPrice != null ? { polyBidPrice: ranked.seed.polyBidPrice } : {}),
        });
    }

    const totalQuantity = candidates.reduce((sum, item) => sum + item.quantity, 0);
    const totalPredictValue = Number(candidates.reduce((sum, item) => sum + item.predictOrderValue, 0).toFixed(4));
    const totalPolymarketValue = Number(candidates.reduce((sum, item) => sum + item.polymarketHedgeValue, 0).toFixed(4));

    return {
        generatedAt: now,
        source,
        summary: {
            considered,
            generated: candidates.length,
            totalQuantity,
            totalPredictValue,
            totalPolymarketValue,
            predictAvailable,
            polymarketAvailable,
            skipped,
        },
        candidates,
        warnings,
    };
}
