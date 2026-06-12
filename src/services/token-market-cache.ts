/**
 * Token ID → 市场映射缓存服务
 *
 * 功能:
 * - 从 Predict API 加载市场数据
 * - 维护 Token ID (onChainId) → 市场信息的映射
 * - 定期刷新缓存
 *
 * 可靠性:
 * - 429 重试不消耗页码（page--）
 * - 用新 Map 构建完再 swap，避免刷新中脏读
 */

import { EventEmitter } from 'events';

const PREDICT_API_BASE = 'https://api.predict.fun';
const CACHE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_MARKETS_PER_PAGE = 100;
const MAX_PAGES = 20;
const MAX_429_RETRIES = 3;

export interface MarketTokenInfo {
    marketId: number;
    title: string;
    yesTokenId: string;
    noTokenId: string;
    yesName?: string;   // outcome 名称 (体育市场为队名，如 "Wizards")
    noName?: string;
    status: string;
    conditionId?: string;
    isNegRisk?: boolean;
    isYieldBearing?: boolean;
    feeRateBps?: number;
}

export interface TokenLookupResult {
    market: MarketTokenInfo;
    side: 'YES' | 'NO';
}

export class TokenMarketCache extends EventEmitter {
    private tokenToMarket = new Map<string, MarketTokenInfo>();
    private marketById = new Map<number, MarketTokenInfo>();
    private apiKey: string;
    private refreshTimer: NodeJS.Timeout | null = null;
    private isLoading = false;
    private lastRefreshTime = 0;
    private stats = {
        totalMarkets: 0,
        registeredMarkets: 0,
        tokenMappings: 0,
        lastRefreshDuration: 0,
    };

    constructor(apiKey?: string) {
        super();
        this.apiKey = apiKey || process.env.PREDICT_API_KEY || '';
    }

    async start(): Promise<void> {
        await this.refresh();
        this.refreshTimer = setInterval(() => {
            this.refresh().catch(err => console.warn('[TokenMarketCache] refresh failed:', err?.message || err));
        }, CACHE_REFRESH_INTERVAL_MS);
    }

    stop(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    isReady(): boolean {
        return this.tokenToMarket.size > 0;
    }

    getStats(): typeof this.stats & { lastRefreshTime: number } {
        return { ...this.stats, lastRefreshTime: this.lastRefreshTime };
    }

    exportTokenMappings(): MarketTokenInfo[] {
        const seen = new Set<number>();
        const result: MarketTokenInfo[] = [];
        for (const market of this.tokenToMarket.values()) {
            if (seen.has(market.marketId)) continue;
            seen.add(market.marketId);
            result.push(market);
        }
        return result;
    }

    getMarketByTokenId(tokenId: string): TokenLookupResult | null {
        const market = this.tokenToMarket.get(tokenId);
        if (!market) return null;
        const side = market.yesTokenId === tokenId ? 'YES' : 'NO';
        return { market, side };
    }

    async refresh(): Promise<void> {
        if (this.isLoading) return;
        if (!this.apiKey) {
            console.warn('[TokenMarketCache] PREDICT_API_KEY 未设置，跳过刷新');
            return;
        }

        this.isLoading = true;
        const startTime = Date.now();

        const newTokenToMarket = new Map<string, MarketTokenInfo>();
        const newMarketById = new Map<number, MarketTokenInfo>();

        let completed = true;

        try {
            let cursor = '';
            let totalMarkets = 0;
            let registeredCount = 0;
            let retryCount = 0;

            for (let page = 0; page < MAX_PAGES; page++) {
                const url = `${PREDICT_API_BASE}/v1/markets?first=${MAX_MARKETS_PER_PAGE}&status=OPEN${cursor ? '&after=' + cursor : ''}`;
                const resp = await fetch(url, { headers: { 'x-api-key': this.apiKey } });

                if (!resp.ok) {
                    if (resp.status === 429) {
                        retryCount++;
                        if (retryCount > MAX_429_RETRIES) {
                            completed = false;
                            break;
                        }
                        await new Promise(r => setTimeout(r, 2000 * retryCount));
                        page--; // 重试同一页
                        continue;
                    }
                    throw new Error(`Predict API error: ${resp.status}`);
                }

                retryCount = 0;

                const data = await resp.json() as { data?: any[]; cursor?: string };
                const markets = Array.isArray(data.data) ? data.data : [];
                if (markets.length === 0) break;

                for (const market of markets) {
                    const info = this.parseMarket(market);
                    if (!info) continue;
                    newMarketById.set(info.marketId, info);
                    if (info.yesTokenId) newTokenToMarket.set(info.yesTokenId, info);
                    if (info.noTokenId) newTokenToMarket.set(info.noTokenId, info);
                    totalMarkets++;
                    if (info.status === 'REGISTERED') registeredCount++;
                }

                cursor = data.cursor || '';
                if (!cursor) break;

                await new Promise(r => setTimeout(r, 50));
            }

            if (completed && totalMarkets > 0) {
                this.tokenToMarket = newTokenToMarket;
                this.marketById = newMarketById;
                this.stats.totalMarkets = totalMarkets;
                this.stats.registeredMarkets = registeredCount;
                this.stats.tokenMappings = this.tokenToMarket.size;
                this.stats.lastRefreshDuration = Date.now() - startTime;
                this.lastRefreshTime = Date.now();
                this.emit('refreshed', this.stats);
            } else if (!completed) {
                console.warn('[TokenMarketCache] 刷新未完成（429 超限或中断），保留旧缓存');
            }
        } catch (err) {
            this.emit('error', err);
        } finally {
            this.isLoading = false;
        }
    }

    private parseMarket(market: any): MarketTokenInfo | null {
        const outcomes = market.outcomes || [];
        let yesTokenId = '';
        let noTokenId = '';
        let yesName = '';
        let noName = '';

        for (const outcome of outcomes) {
            const name = (outcome.name || outcome.outcome || '').toLowerCase();
            const rawName = outcome.name || outcome.outcome || '';
            const tokenId = outcome.onChainId || outcome.tokenId || '';
            if (name === 'yes' || name === 'up') { yesTokenId = tokenId; yesName = rawName; }
            else if (name === 'no' || name === 'down') { noTokenId = tokenId; noName = rawName; }
        }

        // Fallback: 体育等市场的 outcome name 是队名而非 Yes/No，
        // 使用 indexSet 识别 (CTF: indexSet 1=YES, 2=NO)
        // 与 predict-trader.ts 的 getMarketInfo 保持一致
        if (!yesTokenId || !noTokenId) {
            for (const outcome of outcomes) {
                const tokenId = outcome.onChainId || outcome.tokenId || '';
                const rawName = outcome.name || outcome.outcome || '';
                if (!tokenId) continue;
                if (outcome.indexSet === 1 && !yesTokenId) { yesTokenId = tokenId; yesName = rawName; }
                else if (outcome.indexSet === 2 && !noTokenId) { noTokenId = tokenId; noName = rawName; }
            }
        }

        const marketId = Number(market.id);
        if (!Number.isFinite(marketId) || marketId <= 0) return null;

        return {
            marketId,
            title: market.title || market.question || '',
            yesTokenId,
            noTokenId,
            yesName: yesName || undefined,
            noName: noName || undefined,
            status: market.status || '',
            conditionId: market.conditionId,
            isNegRisk: market.isNegRisk,
            isYieldBearing: market.isYieldBearing,
            feeRateBps: market.feeRateBps,
        };
    }
}

let globalCache: TokenMarketCache | null = null;

export function getTokenMarketCache(apiKey?: string): TokenMarketCache {
    if (!globalCache) {
        globalCache = new TokenMarketCache(apiKey);
    }
    return globalCache;
}

export function stopTokenMarketCache(): void {
    if (globalCache) {
        globalCache.stop();
        globalCache = null;
    }
}

