/**
 * Predict.fun PP 奖励档位缓存
 *
 * 通过 https://api.predict.fun/v1/markets?hasActiveRewards=true 拉取所有当前
 * 有活跃奖励的市场，提供 marketId → tier/hourlyRate 查询。
 *
 * 默认每小时刷新一次。
 *
 * 字段含义见 src/predict/predict-rewards.ts
 *
 * 注：原通过 graphql.predict.fun 拉取，但官方已变更 schema（移除 input/slug/tier
 * 等字段），改用新增的 REST `rewards` 字段。
 */

import { tierFromHourlyRate, computeRewardAdvice, type RewardWindow } from '../predict/predict-rewards.js';

const REST_BASE = 'https://api.predict.fun';
const PER_PAGE = 100;
const MAX_PAGES = 30;
const FETCH_TIMEOUT_MS = 15000;

interface CachedReward {
    rewardTimings: RewardWindow[];
    nearMidpointLiquidityUsd: number | null;
    feeMultiplier: boolean;
    /** PP 有效价差半宽 (价格单位 0..1)，例如 0.06 = ±6¢；缺失时 undefined */
    spreadThreshold?: number;
}

const rewardCache = new Map<number, CachedReward>();
let lastRefreshAt = 0;
let lastRefreshError: string | null = null;

interface RestSchedule {
    hourlyRate: number;
    startsAt: string;
    endsAt: string;
}

interface RestMarket {
    id: number | string;
    rewards?: { current?: RestSchedule | null; schedule?: RestSchedule[] };
    spreadThreshold?: number | string;   // 已是 0..1 价格单位 (例如 0.06 = ±6¢)
}

interface RestMarketsResponse {
    success: boolean;
    cursor?: string | null;
    data: RestMarket[];
}

async function fetchMarketsPage(cursor: string | null, apiKey: string): Promise<RestMarketsResponse> {
    const params = new URLSearchParams({ hasActiveRewards: 'true', first: String(PER_PAGE) });
    if (cursor) params.set('after', cursor);
    const url = `${REST_BASE}/v1/markets?${params}`;
    const res = await fetch(url, {
        headers: { 'X-API-Key': apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Predict REST HTTP ${res.status}`);
    return await res.json() as RestMarketsResponse;
}

function mapScheduleToWindows(schedule: RestSchedule[] | undefined): RewardWindow[] {
    if (!schedule) return [];
    return schedule.map(s => ({
        startTime: s.startsAt,
        endTime: s.endsAt,
        hourlyRate: s.hourlyRate,
    }));
}

/** 全量刷新所有当前有活跃奖励的市场；返回新出现 reward 的 marketId 集合（与上一轮相比） */
export async function fetchRewardData(): Promise<Set<number>> {
    const start = Date.now();
    const apiKey = process.env.PREDICT_API_KEY || '';
    if (!apiKey) {
        lastRefreshError = 'PREDICT_API_KEY not set';
        console.warn('[Rewards] PREDICT_API_KEY not set, skipping reward fetch');
        return new Set();
    }

    const newCache = new Map<number, CachedReward>();
    const newlyRewarded = new Set<number>();
    let cursor: string | null = null;
    let page = 0;
    let totalFetched = 0;

    try {
        for (page = 0; page < MAX_PAGES; page++) {
            const json = await fetchMarketsPage(cursor, apiKey);
            const data = json.data || [];

            for (const m of data) {
                const id = Number(m.id);
                if (!Number.isFinite(id)) continue;
                totalFetched++;
                const timings = mapScheduleToWindows(m.rewards?.schedule);
                if (timings.length > 0) {
                    const st = m.spreadThreshold != null ? Number(m.spreadThreshold) : undefined;
                    newCache.set(id, {
                        rewardTimings: timings,
                        nearMidpointLiquidityUsd: null,
                        feeMultiplier: false,
                        spreadThreshold: Number.isFinite(st) ? st : undefined,
                    });
                    if (!rewardCache.has(id)) {
                        newlyRewarded.add(id);
                    }
                }
            }

            if (!json.cursor) break;
            cursor = json.cursor;
        }

        rewardCache.clear();
        for (const [id, data] of newCache) rewardCache.set(id, data);
        lastRefreshAt = Date.now();
        lastRefreshError = null;
        console.log(`[Rewards] Refreshed: ${rewardCache.size} markets with rewards / ${totalFetched} fetched, ${Date.now() - start}ms (${page + 1} pages, +${newlyRewarded.size} new)`);
    } catch (err: any) {
        lastRefreshError = err.message;
        console.warn(`[Rewards] Fetch error after ${page + 1} pages: ${err.message}`);
    }
    return newlyRewarded;
}

/** 查询当前缓存中所有有 reward 的 marketId 集合（只读） */
export function getRewardedMarketIds(): Set<number> {
    return new Set(rewardCache.keys());
}

/** 是否有任意 reward 数据（用于启动 gating） */
export function hasMarketReward(marketId: number): boolean {
    return rewardCache.has(marketId);
}

/** 公开的市场奖励信息 (用于注入 ArbOpportunity / SportsMatchedMarket) */
export interface MarketRewardInfo {
    /** 当前活跃 tier (1-5)，0 表示无活跃奖励 */
    tier: number;
    /** 当前活跃 hourlyRate */
    hourlyRate: number;
    /** 建议挂单到此时间 (ISO) — tier 下降/断档/无后续窗口的时刻 */
    expiresAt: string | null;
    /** 下一窗口 tier (若有) */
    nextTier?: number;
    /** 下一窗口 hourlyRate */
    nextHourlyRate?: number;
    /** 下一窗口开始时间 (ISO) */
    nextStartsAt?: string;
    /** PP 有效价差半宽 (价格单位 0..1)，例如 0.06 = ±6¢；缺失时 undefined */
    spreadThreshold?: number;
}

/** 查市场奖励信息，无数据返回 null */
export function getMarketRewardInfo(marketId: number, now: Date = new Date()): MarketRewardInfo | null {
    const cached = rewardCache.get(marketId);
    if (!cached) return null;

    const advice = computeRewardAdvice(cached.rewardTimings, now, /* minTier 在前端展示侧不过滤 */ 0);
    if (advice.activeTier === 0 && !advice.eligible) {
        // 仍可能有未来窗口，找最近的下一段
        const sorted = cached.rewardTimings
            .map(w => ({ ...w, startMs: new Date(w.startTime).getTime(), endMs: new Date(w.endTime).getTime() }))
            .sort((a, b) => a.startMs - b.startMs);
        const future = sorted.find(w => w.startMs > now.getTime());
        if (future) {
            return {
                tier: 0,
                hourlyRate: 0,
                expiresAt: null,
                nextTier: tierFromHourlyRate(future.hourlyRate),
                nextHourlyRate: future.hourlyRate,
                nextStartsAt: future.startTime,
                spreadThreshold: cached.spreadThreshold,
            };
        }
        return null;
    }

    // 找下一窗口（无论 tier 升降）
    const sorted = cached.rewardTimings
        .map(w => ({ ...w, startMs: new Date(w.startTime).getTime(), endMs: new Date(w.endTime).getTime() }))
        .sort((a, b) => a.startMs - b.startMs);
    const active = sorted.find(w => w.startMs <= now.getTime() && now.getTime() < w.endMs);
    const next = active ? sorted.find(w => w.startMs >= active.endMs) : sorted.find(w => w.startMs > now.getTime());

    return {
        tier: advice.activeTier,
        hourlyRate: advice.activeHourlyRate,
        expiresAt: advice.expirationMs > 0 ? new Date(advice.expirationMs).toISOString() : null,
        nextTier: next ? tierFromHourlyRate(next.hourlyRate) : undefined,
        nextHourlyRate: next?.hourlyRate,
        nextStartsAt: next?.startTime,
        spreadThreshold: cached.spreadThreshold,
    };
}

/** 缓存只读访问 */
export function getRewardCacheSize(): number {
    return rewardCache.size;
}

export function getRewardCacheStats(): { size: number; lastRefreshAt: number; lastRefreshError: string | null } {
    return { size: rewardCache.size, lastRefreshAt, lastRefreshError };
}
