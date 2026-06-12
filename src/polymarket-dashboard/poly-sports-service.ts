/**
 * Polymarket Sports Service
 *
 * 数据获取方式参考原 sports-service.ts:
 * - GET /markets?sports_market_types=moneyline&tag_id=X  (各运动 tag)
 * - GET /markets?sports_market_types=moneyline&limit=500  (broad 分页兜底)
 * - isVsHeadToHead 过滤: events[0].title 必须包含 "vs"
 * - 足球三方: 按 event slug 分组 3 个子市场
 * - 订单簿: 批量 POST /books
 */

import { PolymarketRestClient } from '../polymarket/rest-client.js';
import type {
    PolySportType,
    PolySportsMarket,
    PolySportsSelection,
    PolySportsSSE,
    PolySportsStats,
} from './types.js';

// ============================================================================
// 配置
// ============================================================================

const MARKET_REFRESH_INTERVAL = 60_000;
const ORDERBOOK_REFRESH_INTERVAL = 2_000;
const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const FETCH_TIMEOUT_MS = 10_000;
const BROAD_LIMIT = 500;
const BROAD_MAX_PAGES = 6;

/** Polymarket tag_id 映射 */
const POLY_SPORT_TAG_IDS: Record<string, number> = {
    nba: 745,
    nhl: 899,
    football: 82,    // EPL; 其他联赛通过 broad 覆盖
    lol: 65,
};

/** slug 前缀 → sport 映射 (broad 搜索用) — 仅已知运动 */
const SLUG_SPORT_MAP: [RegExp, PolySportType][] = [
    [/^nba-/, 'nba'],
    [/^nhl-/, 'nhl'],
    [/^(epl|la-liga|serie-a|bundesliga|ligue-1|soccer|ucl|mls|copa)-/, 'football'],
    [/^lol-/, 'lol'],
    [/^cs2?-/, 'cs2'],
    [/^dota-/, 'dota2'],
];

/** 忽略的 slug 前缀 (大学体育/UFC/板球/其他非目标) */
const IGNORED_SLUG_PREFIXES = /^(cbb|cwbb|cfb|ncaa|ufc|wbc|cricc|shl|snhl|khl|ahl|dehl|cehl|wll|pll|bknbl|euroleague|crint)-/;

// ============================================================================
// Gamma Market 原始类型 (markets endpoint 返回)
// ============================================================================

interface GammaMarket {
    id: string;
    question: string;
    conditionId: string;
    slug: string;
    outcomes: string;           // JSON: '["Heat","Bulls"]' 或 '["Yes","No"]'
    outcomePrices: string;      // JSON: '["0.45","0.55"]'
    clobTokenIds: string;       // JSON: '["token1","token2"]'
    endDate: string;
    volume: string;
    liquidity: string;
    active: boolean;
    closed: boolean;
    gameStartTime?: string;
    neg_risk?: boolean;
    negRisk?: boolean;
    groupItemTitle?: string;
    events?: Array<{
        title?: string;
        slug?: string;
    }>;
}

// ============================================================================
// 工具函数
// ============================================================================

function safeParseJSON<T>(str: string | null | undefined): T | null {
    if (!str) return null;
    try { return JSON.parse(str); }
    catch { return null; }
}

function detectSportFromSlug(slug: string): PolySportType | null {
    const s = slug.toLowerCase();
    // 先检查是否是已知的忽略 slug
    if (IGNORED_SLUG_PREFIXES.test(s)) return null;
    for (const [re, sport] of SLUG_SPORT_MAP) {
        if (re.test(s)) return sport;
    }
    return null;
}

function isVsHeadToHead(market: GammaMarket): boolean {
    const eventTitle = (market.events?.[0]?.title || '').trim();
    if (!eventTitle) return false;
    return /\bvs\.?\s+/i.test(eventTitle) || /\s@\s/.test(eventTitle);
}

async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
    }
}

// ============================================================================
// PolySportsService
// ============================================================================

export class PolySportsService {
    private polyClient: PolymarketRestClient;
    private markets = new Map<string, PolySportsMarket>();
    private lastBroadcastSnapshots = new Map<string, string>();

    private marketRefreshTimer: ReturnType<typeof setInterval> | null = null;
    private orderbookRefreshTimer: ReturnType<typeof setInterval> | null = null;
    private onUpdate: ((data: PolySportsSSE) => void) | null = null;

    constructor() {
        this.polyClient = new PolymarketRestClient();
    }

    async start(onUpdate: (data: PolySportsSSE) => void): Promise<void> {
        this.onUpdate = onUpdate;
        console.log('[PolySports] 启动赛事服务...');

        await this.fetchMarkets();
        await this.refreshOrderbooks();
        this.broadcast(true);

        this.marketRefreshTimer = setInterval(() => {
            this.fetchMarkets().catch(e => console.error('[PolySports] 市场刷新失败:', e.message));
        }, MARKET_REFRESH_INTERVAL);

        this.orderbookRefreshTimer = setInterval(() => {
            this.refreshOrderbooks()
                .then(() => this.broadcast(false))
                .catch(e => console.error('[PolySports] 订单簿刷新失败:', e.message));
        }, ORDERBOOK_REFRESH_INTERVAL);

        console.log(`[PolySports] 服务已启动: ${this.markets.size} 个赛事`);
    }

    stop(): void {
        if (this.marketRefreshTimer) clearInterval(this.marketRefreshTimer);
        if (this.orderbookRefreshTimer) clearInterval(this.orderbookRefreshTimer);
        this.marketRefreshTimer = null;
        this.orderbookRefreshTimer = null;
    }

    getSnapshot(): PolySportsSSE {
        return {
            snapshot: true,
            updated: Array.from(this.markets.values()),
            removed: [],
            stats: this.getStats(),
            lastUpdate: Date.now(),
        };
    }

    getAllMarkets(): PolySportsMarket[] {
        return Array.from(this.markets.values());
    }

    // ========================================================================
    // 市场获取 (参考原 fetchPolymarketSportsMarkets)
    // ========================================================================

    private async fetchMarkets(): Promise<void> {
        const startTime = Date.now();
        const allRawMarkets: GammaMarket[] = [];

        // 1. 并发请求各 tag
        const tagIds = Object.entries(POLY_SPORT_TAG_IDS);
        const tagResults: { name: string; count: number }[] = [];

        const tagFetches = tagIds.map(async ([sport, tagId]) => {
            try {
                const url = `${GAMMA_BASE}/markets?active=true&closed=false&limit=50&tag_id=${tagId}&sports_market_types=moneyline`;
                const res = await fetchWithTimeout(url);
                if (!res.ok) {
                    tagResults.push({ name: sport, count: 0 });
                    return [];
                }
                const markets = await res.json() as GammaMarket[];
                tagResults.push({ name: sport, count: markets.length });
                return markets;
            } catch (e: any) {
                tagResults.push({ name: sport, count: 0 });
                console.warn(`[PolySports] Tag ${sport} 获取失败: ${e.message}`);
                return [];
            }
        });

        const tagMarkets = (await Promise.all(tagFetches)).flat();
        allRawMarkets.push(...tagMarkets);

        // 2. Broad 分页兜底 (覆盖无 tag 的电竞/大学篮球等)
        let broadCount = 0;
        for (let page = 0; page < BROAD_MAX_PAGES; page++) {
            try {
                const offset = page * BROAD_LIMIT;
                const url = `${GAMMA_BASE}/markets?active=true&closed=false&limit=${BROAD_LIMIT}&offset=${offset}&sports_market_types=moneyline`;
                const res = await fetchWithTimeout(url);
                if (!res.ok) break;
                const pageMarkets = await res.json() as GammaMarket[];
                if (!Array.isArray(pageMarkets) || pageMarkets.length === 0) break;
                allRawMarkets.push(...pageMarkets);
                broadCount += pageMarkets.length;
                if (pageMarkets.length < BROAD_LIMIT) break;
            } catch (e: any) {
                console.warn(`[PolySports] Broad page ${page} 获取失败: ${e.message}`);
                break;
            }
        }

        const tagSummary = tagResults.map(r => `${r.name}:${r.count}`).join(', ');
        console.log(`[PolySports] 原始: tags(${tagSummary}) broad:${broadCount}`);

        // 3. 去重 (by id)
        const deduped = Array.from(new Map(allRawMarkets.map(m => [m.id, m])).values());

        // 4. 只保留 vs head-to-head 对阵
        const vsMarkets = deduped.filter(m => isVsHeadToHead(m));
        console.log(`[PolySports] 去重后: ${deduped.length} → vs过滤: ${vsMarkets.length}`);

        // 5. 构建市场 Map
        const newMarkets = new Map<string, PolySportsMarket>();
        this.buildMarkets(vsMarkets, newMarkets);

        // 保留旧订单簿
        const removedIds: string[] = [];
        for (const id of this.markets.keys()) {
            if (!newMarkets.has(id)) {
                removedIds.push(id);
                this.lastBroadcastSnapshots.delete(id);
            }
        }

        for (const [id, market] of newMarkets) {
            const old = this.markets.get(id);
            if (old) {
                market.orderbook = old.orderbook;
                market.lastUpdated = old.lastUpdated;
                if (old.selections && market.selections) {
                    for (let i = 0; i < market.selections.length && i < old.selections.length; i++) {
                        const os = old.selections[i];
                        const ns = market.selections[i];
                        if (os.conditionId === ns.conditionId) {
                            ns.bid = os.bid;
                            ns.ask = os.ask;
                            ns.bidDepth = os.bidDepth;
                            ns.askDepth = os.askDepth;
                        }
                    }
                }
            }
        }

        this.markets = newMarkets;

        // 统计
        const typeCounts: Record<string, number> = {};
        for (const m of this.markets.values()) {
            typeCounts[m.marketType] = (typeCounts[m.marketType] || 0) + 1;
        }
        const typeStr = Object.entries(typeCounts).map(([k, v]) => `${k}:${v}`).join(', ');
        console.log(`[PolySports] 最终: ${this.markets.size} 个赛事 [${typeStr}] (${Date.now() - startTime}ms)`);

        if (removedIds.length > 0) {
            this.onUpdate?.({ snapshot: false, updated: [], removed: removedIds, stats: this.getStats(), lastUpdate: Date.now() });
        }
    }

    // ========================================================================
    // 构建市场 — 按事件分组三方，binary 直出
    // ========================================================================

    private buildMarkets(rawMarkets: GammaMarket[], out: Map<string, PolySportsMarket>): void {
        // 按 event slug 分组 (三方足球市场共享 event slug)
        const eventGroups = new Map<string, GammaMarket[]>();
        const standaloneMarkets: GammaMarket[] = [];

        const now = Date.now();

        for (const m of rawMarkets) {
            if (m.closed) continue;
            // 过滤已过期市场: endDate 或 gameStartTime 在过去超过 6 小时
            const endTime = m.endDate ? new Date(m.endDate).getTime() : 0;
            const startTime = m.gameStartTime ? new Date(m.gameStartTime).getTime() : 0;
            const latestTime = Math.max(endTime, startTime);
            if (latestTime > 0 && latestTime < now - 6 * 3600_000) continue;
            const isNegRisk = m.neg_risk || m.negRisk || false;

            if (isNegRisk) {
                // 先检查是否是已知运动
                if (!detectSportFromSlug(m.slug)) continue;
                // negRisk 市场属于三方事件 — 按 event slug 分组
                const eventSlug = m.events?.[0]?.slug || m.slug;
                // 提取事件前缀 (去掉末尾的 -team/-draw 后缀): epl-ast-che-2026-03-04-ast → epl-ast-che-2026-03-04
                const baseSlug = this.getEventBaseSlug(eventSlug);
                if (!eventGroups.has(baseSlug)) {
                    eventGroups.set(baseSlug, []);
                }
                eventGroups.get(baseSlug)!.push(m);
            } else {
                // 非 negRisk = binary moneyline
                standaloneMarkets.push(m);
            }
        }

        // 处理 binary moneyline
        for (const m of standaloneMarkets) {
            const key = m.conditionId;
            if (out.has(key)) continue;

            const outcomes = safeParseJSON<string[]>(m.outcomes) || [];
            const prices = safeParseJSON<number[]>(m.outcomePrices) || [];
            const tokenIds = safeParseJSON<string[]>(m.clobTokenIds) || [];
            if (tokenIds.length < 2) continue;

            const sport = detectSportFromSlug(m.slug);
            if (!sport) continue; // 跳过未知运动 (大学体育/UFC/板球等)

            out.set(key, {
                conditionId: key,
                question: m.question || '',
                slug: m.slug || '',
                sport,
                marketType: 'moneyline',
                homeTeam: outcomes[1]?.trim() || 'Home',
                awayTeam: outcomes[0]?.trim() || 'Away',
                gameStartTime: m.gameStartTime || m.endDate || undefined,
                awayTokenId: tokenIds[0],
                homeTokenId: tokenIds[1],
                negRisk: false,
                tickSize: 0.01,
                awayPrice: prices[0] || 0,
                homePrice: prices[1] || 0,
                orderbook: { awayBid: 0, awayAsk: 0, awayBidDepth: 0, awayAskDepth: 0, homeBid: 0, homeAsk: 0, homeBidDepth: 0, homeAskDepth: 0 },
                volume: parseFloat(m.volume || '0') || 0,
                liquidity: parseFloat(m.liquidity || '0') || 0,
                eventTitle: m.events?.[0]?.title || m.question || undefined,
                eventSlug: m.events?.[0]?.slug || m.slug || undefined,
                lastUpdated: Date.now(),
            });
        }

        // 处理三方事件分组
        for (const [baseSlug, group] of eventGroups) {
            if (group.length < 2) continue; // 三方至少 2 个子市场

            const primaryMarket = group[0];
            const eventTitle = primaryMarket.events?.[0]?.title || primaryMarket.question || '';
            const sport = detectSportFromSlug(primaryMarket.slug);
            if (!sport) continue; // 跳过未知运动

            // 从 event title 解析队名
            const vsMatch = eventTitle.match(/^(.+?)\s+vs\.?\s+(.+?)$/i);
            const homeTeam = vsMatch ? vsMatch[1].trim() : 'Home';
            const awayTeam = vsMatch ? vsMatch[2].trim() : 'Away';

            const selections: PolySportsSelection[] = [];
            let totalVolume = 0;
            let totalLiquidity = 0;

            for (const m of group) {
                const tokenIds = safeParseJSON<string[]>(m.clobTokenIds) || [];
                if (tokenIds.length < 2) continue;
                const prices = safeParseJSON<number[]>(m.outcomePrices) || [];

                const label = m.groupItemTitle || m.question || 'Unknown';

                selections.push({
                    label,
                    conditionId: m.conditionId,
                    tokenId: tokenIds[0], // YES token
                    price: prices[0] || 0,
                    bid: 0, ask: 0,
                    bidDepth: 0, askDepth: 0,
                });

                totalVolume += parseFloat(m.volume || '0') || 0;
                totalLiquidity += parseFloat(m.liquidity || '0') || 0;
            }

            // 排序: Home, Draw, Away
            selections.sort((a, b) => {
                const order = (s: PolySportsSelection) => {
                    const l = s.label.toLowerCase();
                    if (l.includes('draw') || l.includes('tie')) return 1;
                    // homeTeam 在前
                    if (l.includes(homeTeam.toLowerCase()) || l.startsWith(homeTeam.split(' ')[0].toLowerCase())) return 0;
                    return 2;
                };
                return order(a) - order(b);
            });

            const isThreeWay = group.length === 3 && selections.some(s =>
                s.label.toLowerCase().includes('draw') || s.label.toLowerCase().includes('tie')
            );

            const eventKey = `event-${baseSlug}`;
            out.set(eventKey, {
                conditionId: eventKey,
                question: eventTitle,
                slug: baseSlug,
                sport,
                marketType: isThreeWay ? 'three-way' : 'futures',
                homeTeam,
                awayTeam,
                gameStartTime: primaryMarket.gameStartTime || primaryMarket.endDate || undefined,
                awayTokenId: '',
                homeTokenId: '',
                negRisk: true,
                tickSize: 0.01,
                awayPrice: 0,
                homePrice: 0,
                orderbook: { awayBid: 0, awayAsk: 0, awayBidDepth: 0, awayAskDepth: 0, homeBid: 0, homeAsk: 0, homeBidDepth: 0, homeAskDepth: 0 },
                volume: totalVolume,
                liquidity: totalLiquidity,
                eventTitle: eventTitle || undefined,
                eventSlug: baseSlug || undefined,
                isThreeWay,
                selections,
                lastUpdated: Date.now(),
            });
        }
    }

    /**
     * 提取事件 base slug (去掉末尾的 selection 后缀)
     * epl-ast-che-2026-03-04-ast → epl-ast-che-2026-03-04
     * epl-ast-che-2026-03-04-draw → epl-ast-che-2026-03-04
     * la-liga-ath-ovi-2026-02-15-draw → la-liga-ath-ovi-2026-02-15
     */
    private getEventBaseSlug(slug: string): string {
        // 如果 event slug 存在且包含日期, 截取到日期部分
        const dateMatch = slug.match(/^(.+?-\d{4}-\d{2}-\d{2})(?:-.+)?$/);
        if (dateMatch) return dateMatch[1];
        return slug;
    }

    // ========================================================================
    // 订单簿刷新
    // ========================================================================

    async refreshOrderbooks(): Promise<void> {
        const tokenIds: string[] = [];
        const tokenToMarket = new Map<string, { marketId: string; side: 'away' | 'home'; selectionIdx?: number }>();

        for (const [id, market] of this.markets) {
            if (market.selections && market.selections.length > 0) {
                for (let i = 0; i < market.selections.length; i++) {
                    const sel = market.selections[i];
                    if (sel.tokenId) {
                        tokenIds.push(sel.tokenId);
                        tokenToMarket.set(sel.tokenId, { marketId: id, side: 'away', selectionIdx: i });
                    }
                }
            } else {
                if (market.awayTokenId) {
                    tokenIds.push(market.awayTokenId);
                    tokenToMarket.set(market.awayTokenId, { marketId: id, side: 'away' });
                }
                if (market.homeTokenId) {
                    tokenIds.push(market.homeTokenId);
                    tokenToMarket.set(market.homeTokenId, { marketId: id, side: 'home' });
                }
            }
        }

        if (tokenIds.length === 0) return;

        try {
            const chunks: string[][] = [];
            for (let i = 0; i < tokenIds.length; i += 500) {
                chunks.push(tokenIds.slice(i, i + 500));
            }

            const allBooks = (await Promise.all(
                chunks.map(chunk => this.polyClient.getOrderBooks(chunk))
            )).flat();

            for (const book of allBooks) {
                const normalized = this.polyClient.normalizeOrderBook(book);
                const mapping = tokenToMarket.get(book.asset_id);
                if (!mapping) continue;

                const market = this.markets.get(mapping.marketId);
                if (!market) continue;

                const bestBid = normalized.bids[0]?.[0] || 0;
                const bestAsk = normalized.asks[0]?.[0] || 0;
                const bidDepth = normalized.bids.reduce((sum, [, size]) => sum + size, 0);
                const askDepth = normalized.asks.reduce((sum, [, size]) => sum + size, 0);

                if (normalized.tickSize > 0) market.tickSize = normalized.tickSize;

                if (market.selections && mapping.selectionIdx !== undefined) {
                    const sel = market.selections[mapping.selectionIdx];
                    if (sel) {
                        sel.bid = bestBid;
                        sel.ask = bestAsk;
                        sel.bidDepth = bidDepth;
                        sel.askDepth = askDepth;
                        if (bestAsk > 0 && bestAsk < 1) sel.price = bestAsk;
                    }
                } else if (mapping.side === 'away') {
                    market.orderbook.awayBid = bestBid;
                    market.orderbook.awayAsk = bestAsk;
                    market.orderbook.awayBidDepth = bidDepth;
                    market.orderbook.awayAskDepth = askDepth;
                    if (bestAsk > 0 && bestAsk < 1) market.awayPrice = bestAsk;
                } else {
                    market.orderbook.homeBid = bestBid;
                    market.orderbook.homeAsk = bestAsk;
                    market.orderbook.homeBidDepth = bidDepth;
                    market.orderbook.homeAskDepth = askDepth;
                    if (bestAsk > 0 && bestAsk < 1) market.homePrice = bestAsk;
                }

                market.lastUpdated = Date.now();
            }
        } catch (e: any) {
            console.error(`[PolySports] 订单簿批量获取失败: ${e.message}`);
        }
    }

    // ========================================================================
    // SSE 推送
    // ========================================================================

    private broadcast(isSnapshot: boolean): void {
        if (!this.onUpdate) return;

        if (isSnapshot) {
            this.lastBroadcastSnapshots.clear();
            const allMarkets = Array.from(this.markets.values());
            for (const m of allMarkets) {
                this.lastBroadcastSnapshots.set(m.conditionId, JSON.stringify(m));
            }
            this.onUpdate({ snapshot: true, updated: allMarkets, removed: [], stats: this.getStats(), lastUpdate: Date.now() });
        } else {
            const updated: PolySportsMarket[] = [];
            for (const [id, market] of this.markets) {
                const json = JSON.stringify(market);
                if (this.lastBroadcastSnapshots.get(id) !== json) {
                    updated.push(market);
                    this.lastBroadcastSnapshots.set(id, json);
                }
            }
            if (updated.length > 0) {
                this.onUpdate({ snapshot: false, updated, removed: [], stats: this.getStats(), lastUpdate: Date.now() });
            }
        }
    }

    private getStats(): PolySportsStats {
        const bySport: Record<PolySportType, number> = { nba: 0, nhl: 0, football: 0, lol: 0, cs2: 0, dota2: 0 };
        for (const m of this.markets.values()) {
            bySport[m.sport] = (bySport[m.sport] || 0) + 1;
        }
        return { total: this.markets.size, bySport };
    }
}
