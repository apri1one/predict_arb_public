/**
 * Boost 市场缓存
 *
 * 通过 Predict REST API 查询各市场的 isBoosted / boostStartsAt / boostEndsAt 字段，
 * 标记当前处于 boost 状态的市场。
 *
 * 独立模块避免 start-dashboard ↔ sports-service 循环导入。
 */

const BATCH_SIZE = 30;
const BATCH_DELAY_MS = 200;
const PER_MARKET_TIMEOUT_MS = 5000;

/** 市场 ID → boost 时间范围 */
const boostCache = new Map<number, { startTime: string; endTime: string }>();

/** 用于获取市场 ID 列表的回调 */
let marketIdProvider: (() => number[]) | null = null;

/** 注册市场 ID 提供者（dashboard 启动时调用一次） */
export function setBoostMarketIdProvider(provider: () => number[]): void {
    marketIdProvider = provider;
}

/** 通过 REST API 批量查询市场 boost 状态 */
export async function fetchBoostData(): Promise<void> {
    const marketIds = marketIdProvider?.() ?? [];
    if (marketIds.length === 0) {
        console.log('[Boost] No market IDs to query');
        return;
    }

    try {
        const apiKey = process.env.PREDICT_API_KEY || '';
        if (!apiKey) {
            console.warn('[Boost] PREDICT_API_KEY not set, skipping');
            return;
        }

        const newCache = new Map<number, { startTime: string; endTime: string }>();
        let queriedCount = 0;
        let errorCount = 0;

        for (let i = 0; i < marketIds.length; i += BATCH_SIZE) {
            const batch = marketIds.slice(i, i + BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(async (id) => {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), PER_MARKET_TIMEOUT_MS);
                    try {
                        const res = await fetch(`https://api.predict.fun/v1/markets/${id}`, {
                            headers: {
                                'x-api-key': apiKey,
                                'User-Agent': 'Mozilla/5.0',
                            },
                            signal: controller.signal,
                        });
                        if (!res.ok) return null;
                        const body = await res.json() as { data?: { isBoosted?: boolean; boostStartsAt?: string | null; boostEndsAt?: string | null } };
                        const market = body.data;
                        if (market?.isBoosted && market.boostStartsAt && market.boostEndsAt) {
                            return { id, startTime: market.boostStartsAt, endTime: market.boostEndsAt };
                        }
                        return null;
                    } finally {
                        clearTimeout(timeoutId);
                    }
                })
            );

            for (const result of results) {
                queriedCount++;
                if (result.status === 'fulfilled' && result.value) {
                    newCache.set(result.value.id, { startTime: result.value.startTime, endTime: result.value.endTime });
                } else if (result.status === 'rejected') {
                    errorCount++;
                }
            }

            if (i + BATCH_SIZE < marketIds.length) {
                await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
            }
        }

        // 替换缓存
        boostCache.clear();
        for (const [id, data] of newCache) {
            boostCache.set(id, data);
        }

        const suffix = errorCount > 0 ? ` (${errorCount} errors)` : '';
        console.log(`[Boost] Refreshed: ${boostCache.size} boosted / ${queriedCount} queried${suffix}`);
    } catch (err: any) {
        console.warn(`[Boost] Fetch error: ${err.message}`);
    }
}

/** 检查市场是否当前处于 boost 状态 */
export function isMarketBoosted(marketId: number): { boosted: boolean; boostStartTime?: string; boostEndTime?: string } {
    const data = boostCache.get(marketId);
    if (!data) return { boosted: false };
    // 只要 endTime 尚未过期就视为 boosted（包括尚未开始的）
    const end = new Date(data.endTime).getTime();
    if (Date.now() <= end) {
        return { boosted: true, boostStartTime: data.startTime, boostEndTime: data.endTime };
    }
    return { boosted: false };
}

/** 获取 boostCache (只读访问) */
export function getBoostCache(): ReadonlyMap<number, { startTime: string; endTime: string }> {
    return boostCache;
}
