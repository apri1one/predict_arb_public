/**
 * Predict.fun GraphQL 奖励档位查询与 expiration 推荐
 *
 * 数据源: https://graphql.predict.fun/graphql (无需鉴权)
 * 字段:   Market.rewardTimings[].hourlyRate (1..N PP/hr)
 *         前端把 hourlyRate 映射为 1-5 星 tier (查表)
 *
 * 策略:
 *   - 只挂 tier >= minTier 的市场 (默认 minTier=3)
 *   - expiration 推到「未来第一个 tier 下降 / 时间断档 / 计划结束」的时刻
 *   - 任务/订单到这个时刻自动撤掉，避免在低 tier 时段空挂浪费深度
 */

const GRAPHQL_ENDPOINT = 'https://graphql.predict.fun/graphql';

export interface RewardWindow {
    startTime: string; // ISO
    endTime: string;
    hourlyRate: number;
    granularity?: string;
}

export interface RewardAdvice {
    eligible: boolean;
    activeTier: number;        // 0 表示当前无活跃奖励窗口
    activeHourlyRate: number;
    expirationMs: number;      // unix ms; 0 表示不挂
    reason: string;
}

/** hourlyRate → tier (前端硬编码的查找表) */
export function tierFromHourlyRate(hr: number): number {
    if (hr <= 0) return 0;
    if (hr <= 120) return 1;
    if (hr <= 250) return 2;
    if (hr <= 1000) return 3;
    if (hr <= 2500) return 4;
    return 5;
}

/**
 * 给定一个市场的 reward 窗口数组，计算挂单建议
 *
 * @param windows  Market.rewardTimings (任意顺序)
 * @param now      当前时间
 * @param minTier  最低接受 tier (默认 3)
 * @returns        eligible + 建议的 expiration
 */
export function computeRewardAdvice(
    windows: RewardWindow[],
    now: Date = new Date(),
    minTier: number = 3,
): RewardAdvice {
    if (!windows || windows.length === 0) {
        return { eligible: false, activeTier: 0, activeHourlyRate: 0, expirationMs: 0, reason: 'no reward timings' };
    }

    const wins = windows
        .map(w => ({ start: new Date(w.startTime).getTime(), end: new Date(w.endTime).getTime(), hourlyRate: w.hourlyRate }))
        .sort((a, b) => a.start - b.start);

    const nowMs = now.getTime();
    const active = wins.find(w => w.start <= nowMs && nowMs < w.end);
    if (!active) {
        return { eligible: false, activeTier: 0, activeHourlyRate: 0, expirationMs: 0, reason: 'no active reward window' };
    }

    const activeTier = tierFromHourlyRate(active.hourlyRate);
    if (activeTier < minTier) {
        return {
            eligible: false,
            activeTier,
            activeHourlyRate: active.hourlyRate,
            expirationMs: 0,
            reason: `current tier ${activeTier}★ < minTier ${minTier}★`,
        };
    }

    // 从 active.end 向后扫描，找第一个 (a) 不连续 / (b) tier 下降 / (c) 没有更多窗口
    let lastEnd = active.end;
    for (const w of wins) {
        if (w.start < lastEnd) continue; // 已经覆盖
        if (w.start > lastEnd) break;     // 时间断档 → 实际 tier 跌到 0
        const t = tierFromHourlyRate(w.hourlyRate);
        if (t < activeTier) break;        // 下一窗口 tier 下降
        lastEnd = w.end;                  // 同 tier 或更高，继续延伸
    }

    return {
        eligible: true,
        activeTier,
        activeHourlyRate: active.hourlyRate,
        expirationMs: lastEnd,
        reason: `holds at ≥${activeTier}★ until ${new Date(lastEnd).toISOString()}`,
    };
}

// ============================================================================
// GraphQL 拉取
// ============================================================================

export interface MarketReward {
    id: string;
    title: string;
    rewardTimings: RewardWindow[];
    nearMidpointLiquidityUsd: number | null;
    feeMultiplier: boolean;
    categorySlug?: string;
}

async function gql(query: string): Promise<any> {
    const res = await fetch(GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(10000),
    });
    const json = await res.json() as any;
    if (json.errors) throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
    return json.data;
}

/** 拉单个市场的奖励信息 */
export async function fetchMarketRewards(marketId: string | number): Promise<MarketReward | null> {
    const data = await gql(`{
        market(id:"${marketId}"){
            id title
            rewardTimings { granularity startTime endTime hourlyRate }
            nearMidpointLiquidityUsd
            feeMultiplier
            category { slug }
        }
    }`);
    const m = data?.market;
    if (!m) return null;
    return {
        id: m.id,
        title: m.title,
        rewardTimings: m.rewardTimings || [],
        nearMidpointLiquidityUsd: m.nearMidpointLiquidityUsd ?? null,
        feeMultiplier: !!m.feeMultiplier,
        categorySlug: m.category?.slug,
    };
}

/** 批量拉所有未结算的体育市场 (sports tag id=4) */
export async function fetchAllSportsRewards(maxPages: number = 30): Promise<MarketReward[]> {
    const all: MarketReward[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page++) {
        const after = cursor ? `, after: "${cursor}"` : '';
        const data = await gql(`{
            markets(
                filter: { tag: "4", isResolved: false }
                pagination: { first: 100${after} }
            ) {
                edges {
                    node {
                        id title
                        rewardTimings { granularity startTime endTime hourlyRate }
                        nearMidpointLiquidityUsd
                        feeMultiplier
                        category { slug }
                    }
                }
                pageInfo { hasNextPage endCursor }
            }
        }`);
        for (const e of data.markets.edges) {
            const n = e.node;
            all.push({
                id: n.id,
                title: n.title,
                rewardTimings: n.rewardTimings || [],
                nearMidpointLiquidityUsd: n.nearMidpointLiquidityUsd ?? null,
                feeMultiplier: !!n.feeMultiplier,
                categorySlug: n.category?.slug,
            });
        }
        if (!data.markets.pageInfo.hasNextPage) break;
        cursor = data.markets.pageInfo.endCursor;
    }
    return all;
}

/** 一站式：拿单市场建议 */
export async function getMarketRewardAdvice(
    marketId: string | number,
    minTier: number = 3,
    now: Date = new Date(),
): Promise<{ market: MarketReward; advice: RewardAdvice } | null> {
    const market = await fetchMarketRewards(marketId);
    if (!market) return null;
    const advice = computeRewardAdvice(market.rewardTimings, now, minTier);
    return { market, advice };
}
