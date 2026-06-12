/**
 * Auto PP-Farmer 候选筛选与预算分配
 *
 * 与 auto-task-preview 的关键差异：
 * 1. 仅保留有活跃 PP（pointsTier > 0）且收益率 >= 用户阈值的市场
 * 2. Predict spread < 6¢ (≥6¢ 即使挂单也无 PP 奖励)
 * 3. ALL 市场要求 endDate >= 3 天后；Sports 不限 endDate（已有开赛前缓冲规则）
 * 4. 可挂深度 >= 100 shares（已有 MIN_SHARES）
 * 5. 策略固定为 PREDICT_MAKER（只挂 Predict 一侧）
 * 6. 全局预算池 = min(两平台余额) × 50%，所有候选共享
 */

import { buildLiveSeeds, buildSportsSeeds, type PreviewSeed } from '../auto-task-preview.js';
import type { ArbOpportunity, ArbSide, AutoTaskPreviewItem } from '../types.js';
import type { SportsMatchedMarket } from '../sports-types.js';

const MIN_SHARES = 100;
const MAX_BUDGET_POOL_RATIO = 0.5;
const DEFAULT_BUDGET_POOL_RATIO = 0.5;
const SPORTS_START_BUFFER_MS = 5 * 60 * 1000;
const SPORTS_EXPIRY_OFFSET_MS = 3 * 60 * 1000;
const NON_SPORTS_EXPIRY_OFFSET_MS = 24 * 60 * 60 * 1000;
const NON_SPORTS_MIN_END_DATE_MS = 3 * 24 * 60 * 60 * 1000;  // 至少 3 天后结算
const SPORTS_ZERO_PROFIT_EPSILON = 0.0001;
const POLY_MIN_NOTIONAL_USD = 1;
const PREDICT_SPREAD_LIMIT = 0.06;  // 6¢；spread ≥ 6¢ 时挂单无 PP 奖励
const PREDICT_MIN_BID_PRICE = 0.15;  // 价格 < 15¢ 时不挂：低价位下 Predict 挂单 notional 太小，PP 不划算
const PREDICT_MAX_BID_PRICE = 0.85;  // 价格 > 85¢ 时不挂：高价位对称同理，且边缘市场反向风险大
const DEFAULT_YIELD_THRESHOLD = 0.001;  // 默认收益率门槛 (×100 显示 0.1)

type HasActiveTaskFn = (
    marketId: number,
    type: 'BUY' | 'SELL',
    arbSide: ArbSide,
    strategy?: 'PREDICT_MAKER' | 'POLY_MAKER'
) => boolean;

export interface SelectPpFarmerParams {
    opportunities: ArbOpportunity[];
    sportsMarkets: SportsMatchedMarket[];
    predictAvailable: number;
    polymarketAvailable: number;
    hasActiveTask: HasActiveTaskFn;
    /** 收益率阈值（仅当 pointsYield >= 阈值才挂） */
    yieldThreshold?: number;
    /** 候选源筛选: 'all'=非体育套利, 'sports'=体育, 'mixed'=两者(默认) */
    source?: 'all' | 'sports' | 'mixed';
    /** 资金池占比 [0, 0.5]，默认 0.5 */
    budgetPoolRatio?: number;
    /** 排除清单：包含的 marketId 不会成为候选（用户在 All 面板归档的市场） */
    archivedMarketIds?: Set<number>;
    now?: number;
}

export interface PpFarmerSelection {
    candidates: AutoTaskPreviewItem[];
    skipped: Record<string, number>;
    considered: number;
    qualified: number;
    poolUsdc: number;
    remainingUsdc: number;
    yieldThreshold: number;
    source: 'all' | 'sports' | 'mixed';
    budgetPoolRatio: number;
}

interface RankedFarmSeed {
    seed: PreviewSeed;
    eventTime: number;
    expiresAt: number;
    maxQuantity: number;
}

export function selectPpFarmerCandidates(params: SelectPpFarmerParams): PpFarmerSelection {
    const now = params.now ?? Date.now();
    const predictAvail = Math.max(0, Number(params.predictAvailable) || 0);
    const polyAvail = Math.max(0, Number(params.polymarketAvailable) || 0);
    const source = params.source ?? 'mixed';
    const budgetPoolRatio = Number.isFinite(params.budgetPoolRatio)
        ? Math.min(MAX_BUDGET_POOL_RATIO, Math.max(0, params.budgetPoolRatio!))
        : DEFAULT_BUDGET_POOL_RATIO;
    // 每笔订单独立的资金上限：min(predict, poly) × ratio。
    // Predict resting orders 共享同一抵押 → 多个候选并行挂单不互相挤占额度。
    // 与 auto-task-preview 一致：分别按各平台余额×ratio÷价格 算 qty 上限再取 min。
    const perOrderBudget = Math.min(predictAvail, polyAvail) * budgetPoolRatio;
    const yieldThreshold = Number.isFinite(params.yieldThreshold)
        ? Math.max(0, params.yieldThreshold!)
        : DEFAULT_YIELD_THRESHOLD;
    const skipped: Record<string, number> = {};

    if (perOrderBudget <= 0) {
        return {
            candidates: [],
            skipped: { zero_balance_pool: 1 },
            considered: 0,
            qualified: 0,
            poolUsdc: 0,
            remainingUsdc: 0,
            yieldThreshold,
            source,
            budgetPoolRatio,
        };
    }

    const rawSeeds: PreviewSeed[] = source === 'all'
        ? buildLiveSeeds(params.opportunities, params.sportsMarkets)
        : source === 'sports'
            ? buildSportsSeeds(params.sportsMarkets)
            : [
                ...buildLiveSeeds(params.opportunities, params.sportsMarkets),
                ...buildSportsSeeds(params.sportsMarkets),
            ];

    const deduped = new Map<string, PreviewSeed>();
    for (const seed of rawSeeds) {
        const key = `${seed.marketId}:${seed.arbSide}`;
        const existing = deduped.get(key);
        if (!existing || seed.estimatedProfit > existing.estimatedProfit) {
            deduped.set(key, seed);
        }
    }
    const considered = deduped.size;

    const archivedIds = params.archivedMarketIds;

    const ranked: RankedFarmSeed[] = [];
    for (const seed of deduped.values()) {
        if (archivedIds && archivedIds.has(seed.marketId)) {
            inc(skipped, 'archived');
            continue;
        }
        // 1. PP 档位检查：必须有活跃 PP
        if (!seed.pointsTier || seed.pointsTier <= 0) {
            inc(skipped, 'no_active_pp');
            continue;
        }
        // 2. 收益率阈值检查
        if (!Number.isFinite(seed.pointsYield) || (seed.pointsYield || 0) < yieldThreshold) {
            inc(skipped, 'yield_below_threshold');
            continue;
        }

        // 3. 利润 / 价格基本校验
        if (!Number.isFinite(seed.profitPercent)) {
            inc(skipped, 'invalid_profit');
            continue;
        }
        if (seed.source === 'all' && seed.profitPercent <= 0) {
            inc(skipped, 'live_profit_non_positive');
            continue;
        }
        if (seed.source === 'sports' && seed.profitPercent < -SPORTS_ZERO_PROFIT_EPSILON) {
            inc(skipped, 'sports_profit_negative');
            continue;
        }
        if (
            !Number.isFinite(seed.predictBidPrice) ||
            !Number.isFinite(seed.polymarketHedgePrice) ||
            seed.predictBidPrice <= 0 ||
            seed.polymarketHedgePrice <= 0
        ) {
            inc(skipped, 'invalid_price');
            continue;
        }

        // 4. Predict spread < 6¢（spread ≥ 6¢ 即使挂单也拿不到 PP）
        if (Number.isFinite(seed.predictAskPrice) && seed.predictAskPrice! > 0) {
            const spread = seed.predictAskPrice! - seed.predictBidPrice;
            if (spread >= PREDICT_SPREAD_LIMIT) {
                inc(skipped, 'spread_too_wide');
                continue;
            }
        }

        // 4b. Predict 挂单价必须落在 [15¢, 85¢] 之间：
        //     低价端 PP notional 太小不划算；高价端反向风险大且收益受限
        if (seed.predictBidPrice < PREDICT_MIN_BID_PRICE) {
            inc(skipped, 'predict_price_below_15c');
            continue;
        }
        if (seed.predictBidPrice > PREDICT_MAX_BID_PRICE) {
            inc(skipped, 'predict_price_above_85c');
            continue;
        }

        // 5. 任务去重
        if (params.hasActiveTask(seed.marketId, 'BUY', seed.arbSide, 'PREDICT_MAKER')) {
            inc(skipped, 'active_task_exists');
            continue;
        }

        // 6. 时间窗口
        let eventTime: number;
        let expiresAt: number;
        if (seed.isSportsMarket) {
            const startMs = parseMs(seed.gameStartTime);
            if (!startMs) {
                inc(skipped, 'missing_game_start_time');
                continue;
            }
            if (startMs - now < SPORTS_START_BUFFER_MS) {
                inc(skipped, 'sports_starting_soon');
                continue;
            }
            eventTime = startMs;
            expiresAt = startMs - SPORTS_EXPIRY_OFFSET_MS;
        } else {
            const endMs = parseMs(seed.endDate);
            if (!endMs) {
                inc(skipped, 'missing_end_date');
                continue;
            }
            // ALL 市场：要求至少 3 天后才结算
            if (endMs - now < NON_SPORTS_MIN_END_DATE_MS) {
                inc(skipped, 'end_date_too_close');
                continue;
            }
            eventTime = endMs;
            expiresAt = endMs - NON_SPORTS_EXPIRY_OFFSET_MS;
        }

        if (expiresAt <= now) {
            inc(skipped, 'expiry_already_passed');
            continue;
        }

        // 7. 深度 ≥ 100
        const maxQty = floorShares(seed.maxQuantity);
        if (maxQty < MIN_SHARES) {
            inc(skipped, 'depth_below_100');
            continue;
        }

        ranked.push({ seed, eventTime, expiresAt, maxQuantity: maxQty });
    }

    const qualified = ranked.length;

    // 排序：收益率降序优先（高收益率=易拿大份额），再按结算时间升序
    ranked.sort((a, b) => {
        const aDiff = a.seed.pointsYield || 0;
        const bDiff = b.seed.pointsYield || 0;
        if (aDiff !== bDiff) return bDiff - aDiff;
        if (a.eventTime !== b.eventTime) return a.eventTime - b.eventTime;
        if (b.seed.profitPercent !== a.seed.profitPercent) return b.seed.profitPercent - a.seed.profitPercent;
        return a.seed.title.localeCompare(b.seed.title);
    });

    const candidates: AutoTaskPreviewItem[] = [];
    for (const r of ranked) {
        if (r.seed.predictBidPrice <= 0 || r.seed.polymarketHedgePrice <= 0) {
            inc(skipped, 'invalid_price');
            continue;
        }

        // 每单独立计算 qty 上限：predict 侧用 predictAvail × ratio ÷ predictBidPrice，
        // polymarket 侧用 polyAvail × ratio ÷ polyHedgePrice，再取 min。
        // 不再聚合扣减——多单挂同一抵押池在 Predict 上是允许的。
        const predictBudgetQty = Math.floor((predictAvail * budgetPoolRatio) / r.seed.predictBidPrice);
        const polymarketBudgetQty = Math.floor((polyAvail * budgetPoolRatio) / r.seed.polymarketHedgePrice);
        const qtyByBudget = Math.min(predictBudgetQty, polymarketBudgetQty);
        const qty = Math.min(r.maxQuantity, qtyByBudget);
        if (qty < MIN_SHARES) {
            inc(skipped, 'below_min_shares');
            continue;
        }

        const minPolyQty = Math.max(1, Math.ceil(POLY_MIN_NOTIONAL_USD / r.seed.polymarketHedgePrice));
        if (qty < minPolyQty) {
            inc(skipped, 'below_polymarket_minimum');
            continue;
        }

        const predictOrderValue = Number((qty * r.seed.predictBidPrice).toFixed(4));
        const polymarketHedgeValue = Number((qty * r.seed.polymarketHedgePrice).toFixed(4));
        const estimatedProfit = r.seed.maxQuantity > 0
            ? Number(((r.seed.estimatedProfit / r.seed.maxQuantity) * qty).toFixed(4))
            : 0;

        candidates.push({
            id: r.seed.id,
            source: r.seed.source,
            marketId: r.seed.marketId,
            title: r.seed.title,
            arbSide: r.seed.arbSide,
            quantity: qty,
            maxQuantity: r.maxQuantity,
            predictBidPrice: r.seed.predictBidPrice,
            polymarketHedgePrice: r.seed.polymarketHedgePrice,
            budgetRatio: budgetPoolRatio,
            predictOrderValue,
            polymarketHedgeValue,
            estimatedProfit,
            profitPercent: r.seed.profitPercent,
            expiresAt: r.expiresAt,
            endDate: r.seed.endDate,
            gameStartTime: r.seed.gameStartTime,
            isSportsMarket: r.seed.isSportsMarket,
            predictSlug: r.seed.predictSlug,
            polymarketSlug: r.seed.polymarketSlug,
            polymarketConditionId: r.seed.polymarketConditionId,
            polymarketNoTokenId: r.seed.polymarketNoTokenId,
            polymarketYesTokenId: r.seed.polymarketYesTokenId,
            isInverted: r.seed.isInverted,
            tickSize: r.seed.tickSize,
            negRisk: r.seed.negRisk,
            feeRateBps: r.seed.feeRateBps,
        });
    }

    return {
        candidates,
        skipped,
        considered,
        qualified,
        poolUsdc: Number(perOrderBudget.toFixed(4)),
        remainingUsdc: 0,
        yieldThreshold,
        source,
        budgetPoolRatio,
    };
}

function inc(target: Record<string, number>, reason: string): void {
    target[reason] = (target[reason] || 0) + 1;
}

function parseMs(value?: string): number | null {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function floorShares(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(0, Math.floor(value + 1e-9));
}
