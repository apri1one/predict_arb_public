/**
 * Hedge 服务 - 计算可平仓机会
 *
 * 功能：
 * 1. 获取双腿持仓（Predict + Polymarket）
 * 2. 按 polymarketConditionId 匹配双腿
 * 3. 计算 T-T / M-T 平仓收益
 *
 * 镜面对称：
 * - 开仓 BUY (PolyMaker / arb-service)：双边买入
 * - 平仓 SELL (本模块)：双边卖出
 *   - T-T 走 task-executor SELL+TAKER 分支
 *   - M-T 走 task-executor SELL+PREDICT_MAKER 分支
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { calculatePredictFee } from '../../trading/depth-calculator.js';
import { getPolyOrderbookProvider, getPredictOrderbookProvider, getPredictApiKeyProvider } from './providers.js';
import { getPredictSlug, getPolymarketSlug, generatePredictSlug } from '../url-mapper.js';
import type { PositionLeg, ClosePosition, CloseOpportunity, ArbSide, UnmatchedPosition, CloseDepthAnalysis, DepthLevel } from '../types.js';
import { getSportsService } from '../sports-service.js';
import type { SportsMatchedMarket } from '../sports-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Debug 开关
// ============================================================================
const HEDGE_SERVICE_DEBUG = process.env.HEDGE_SERVICE_DEBUG === 'true' || process.env.CLOSE_SERVICE_DEBUG === 'true';

// ============================================================================
// 类型定义
// ============================================================================

interface CachedMarketMatch {
    predict: {
        id: number;
        title: string;
        question: string;
        conditionId: string;
        feeRateBps?: number;
        categorySlug?: string;   // Predict 事件级 slug（如 "how-many-fed-rate-cuts-in-2026"）
    };
    polymarket: {
        question: string;
        conditionId: string;
        active: boolean;
        closed: boolean;
        acceptingOrders: boolean;
    };
    inverted?: boolean;
}

interface ExtendedPredictPosition {
    marketId: number;
    title: string;
    side: 'YES' | 'NO';
    shares: number;
    avgPrice: number;        // 0-1 格式
    costPerShare: number;    // 每股成本
    polymarketConditionId?: string;  // 映射的 Polymarket conditionId
    feeRateBps?: number;

    // Sports 字段
    isSportsMarket?: boolean;
    /** 持仓在体育子市场里属于哪一边（away/home），用于配对 */
    sportsRole?: 'away' | 'home';
    /** 持仓的 outcome 原始名（队名或 "Draw"） */
    outcomeName?: string;
    polymarketAwayTokenId?: string;
    polymarketHomeTokenId?: string;
    /** 当前持仓对应的对冲 token (即 sportsRole==='away' ? awayTokenId : homeTokenId) */
    polymarketTokenId?: string;
    negRisk?: boolean;
    tickSize?: number;
    gameStartTime?: string;
    eventTitle?: string;
    selectionLabel?: string;
    predictSlug?: string;
    polymarketSlug?: string;
}

interface ExtendedPolyPosition {
    conditionId: string;
    tokenId: string;
    title: string;
    side: 'YES' | 'NO';
    shares: number;
    avgPrice: number;
    costPerShare: number;
    /** 体育持仓的 outcome 原始名（队名 / "Draw"） */
    outcomeName?: string;
}

interface OrderbookLevel {
    price: number;
    size: number;
}

interface Orderbook {
    bids: OrderbookLevel[];
    asks: OrderbookLevel[];
}

// ============================================================================
// 订单簿提供者类型（实际 setter/getter 在 providers.ts）
// ============================================================================

interface PolymarketMarketDetail {
    conditionId: string;
    yesTokenId: string;
    noTokenId: string;
    negRisk: boolean;
    tickSize: number;
}

// ============================================================================
// 缓存与映射
// ============================================================================

// Sports 映射: 一个 SportsMatchedMarket 同时把 awayMarketId 和 homeMarketId
// 映射到自己（含 sportsRole 标识），让我们能从 Predict 持仓 marketId 反查
interface SportsMappingEntry {
    sportsMarket: SportsMatchedMarket;
    sportsRole: 'away' | 'home';  // 该 predictMarketId 对应 away 还是 home
}
let predictIdToSportsMarket: Map<number, SportsMappingEntry> = new Map();
let sportsMappingLastBuiltAt = 0;
const SPORTS_MAPPING_TTL_MS = 30_000;  // 30s 重建一次

function rebuildSportsMapping(): void {
    const map = new Map<number, SportsMappingEntry>();
    let svc;
    try { svc = getSportsService(); } catch { svc = null; }
    if (svc) {
        const markets = svc.getMarkets();
        for (const m of markets) {
            // 注意: 同一个 SportsMatchedMarket 实例会同时映射 awayMarketId 和 homeMarketId
            if (m.predictAwayMarketId) {
                map.set(m.predictAwayMarketId, { sportsMarket: m, sportsRole: 'away' });
            }
            if (m.predictHomeMarketId && m.predictHomeMarketId !== m.predictAwayMarketId) {
                map.set(m.predictHomeMarketId, { sportsMarket: m, sportsRole: 'home' });
            }
        }
    }
    predictIdToSportsMarket = map;
    sportsMappingLastBuiltAt = Date.now();
}

function getSportsMappingFor(predictMarketId: number): SportsMappingEntry | undefined {
    if (Date.now() - sportsMappingLastBuiltAt > SPORTS_MAPPING_TTL_MS) {
        rebuildSportsMapping();
    }
    return predictIdToSportsMarket.get(predictMarketId);
}

function normalizeSportsName(value?: string): string {
    return (value || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function isSameSportsName(outcomeName: string, teamName?: string): boolean {
    const outcome = normalizeSportsName(outcomeName);
    const team = normalizeSportsName(teamName);
    if (!outcome || !team) return false;
    return outcome === team || outcome.includes(team) || team.includes(outcome);
}

function inferSportsRoleFromOutcome(
    market: SportsMatchedMarket,
    outcomeName: string,
    fallback: 'away' | 'home',
): 'away' | 'home' {
    if (isSameSportsName(outcomeName, market.awayTeam)) return 'away';
    if (isSameSportsName(outcomeName, market.homeTeam)) return 'home';
    return fallback;
}

function getSportsPredictSide(market: SportsMatchedMarket, role: 'away' | 'home'): 'YES' | 'NO' {
    return market.predictAwayMarketId === market.predictHomeMarketId
        ? (role === 'away' ? 'YES' : 'NO')
        : 'YES';
}

let cachedMatches: CachedMarketMatch[] | null = null;
let predictIdToConditionId: Map<number, string> = new Map();
let conditionIdToPredictId: Map<string, number> = new Map();
let conditionIdToFeeRate: Map<string, number> = new Map();
let conditionIdToInverted: Map<string, boolean> = new Map();
let predictIdToQuestion: Map<number, string> = new Map();  // 完整问题标题
let predictIdToCategorySlug: Map<number, string> = new Map();  // Predict 事件级 slug
let polyMarketDetailCache: Map<string, PolymarketMarketDetail> = new Map();

/**
 * 加载市场匹配缓存
 */
function loadMarketMatches(): CachedMarketMatch[] {
    if (cachedMatches) return cachedMatches;

    const cachePaths = [
        // 相对当前文件 src/dashboard/hedge-mode/service.ts -> 项目根
        path.resolve(__dirname, '..', '..', '..', 'polymarket-match-result.json'),
        path.join(process.cwd(), 'polymarket-match-result.json'),
        path.join(process.cwd(), 'bot', 'polymarket-match-result.json'),
        path.resolve(__dirname, '..', '..', '..', '..', 'polymarket-match-result.json'),
    ];

    for (const cachePath of cachePaths) {
        try {
            if (fs.existsSync(cachePath)) {
                const content = fs.readFileSync(cachePath, 'utf-8');
                const data = JSON.parse(content) as { matches: CachedMarketMatch[] };
                if (data.matches && data.matches.length > 0) {
                    cachedMatches = data.matches;

                    // 构建双向映射
                    for (const match of data.matches) {
                        const predictId = match.predict.id;
                        const conditionId = match.polymarket.conditionId.toLowerCase();
                        predictIdToConditionId.set(predictId, conditionId);
                        conditionIdToPredictId.set(conditionId, predictId);
                        if (match.predict.feeRateBps) {
                            conditionIdToFeeRate.set(conditionId, match.predict.feeRateBps);
                        }
                        // 记录 inverted 状态
                        conditionIdToInverted.set(conditionId, match.inverted === true);
                        // 记录完整问题标题 (优先使用 question，回退到 title)
                        predictIdToQuestion.set(predictId, match.predict.question || match.predict.title);
                        // 记录事件级 slug（用于 URL 导航；同一 categorySlug 可能对应多个子市场）
                        if (match.predict.categorySlug) {
                            predictIdToCategorySlug.set(predictId, match.predict.categorySlug);
                        }
                    }

                    console.log(`[HedgeService] 加载 ${data.matches.length} 个市场映射`);
                    return cachedMatches;
                }
            }
        } catch (e) {
            // 忽略
        }
    }

    console.warn('[HedgeService] 未找到市场匹配缓存');
    return [];
}

/**
 * 刷新市场映射缓存
 */
export function refreshMarketMatches(): void {
    cachedMatches = null;
    predictIdToConditionId.clear();
    conditionIdToPredictId.clear();
    conditionIdToFeeRate.clear();
    conditionIdToInverted.clear();
    predictIdToQuestion.clear();
    predictIdToCategorySlug.clear();
    loadMarketMatches();
}

// ============================================================================
// 持仓查询与扩展
// ============================================================================

/**
 * 获取 Predict 扩展持仓（含 marketId 和 conditionId 映射）
 *
 * 默认 30 秒刷新一次：平仓机会无套利窗口竞速性，且 GraphQL/data-api 都是慢调用。
 * 订单成交事件 (orderFilled) 会传 force=true 立即刷新，不受此节流影响。
 */
const HEDGE_POSITIONS_REFRESH_MS = Number(process.env.HEDGE_POSITIONS_REFRESH_MS || process.env.CLOSE_POSITIONS_REFRESH_MS || 30000);
let lastPositionsRefresh = 0;
let cachedPredictPositions: ExtendedPredictPosition[] = [];
let cachedPolyPositions: ExtendedPolyPosition[] = [];
let positionsRefreshInFlight: Promise<void> | null = null;

type PositionFetchResult<T> = {
    positions: T[];
    ok: boolean;
};

async function fetchExtendedPredictPositions(): Promise<PositionFetchResult<ExtendedPredictPosition>> {
    const SMART_WALLET = process.env.PREDICT_SMART_WALLET_ADDRESS;

    if (!SMART_WALLET) {
        console.warn('[HedgeService] 未配置 PREDICT_SMART_WALLET_ADDRESS');
        return { positions: [], ok: false };
    }

    loadMarketMatches();

    try {
        const extended: ExtendedPredictPosition[] = [];

        // 使用 GraphQL API 获取持仓（含 averageBuyPriceUsd 成本字段）
        const graphqlRes = await fetch('https://graphql.predict.fun/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: `query {
                    account(address: "${SMART_WALLET}") {
                        positions {
                            edges {
                                node {
                                    id
                                    shares
                                    averageBuyPriceUsd
                                    valueUsd
                                    pnlUsd
                                    market { id title question }
                                    outcome { name }
                                }
                            }
                        }
                    }
                }`
            }),
            signal: AbortSignal.timeout(8000),
        });

        if (!graphqlRes.ok) {
            const errText = await graphqlRes.text().catch(() => '');
            console.warn('[HedgeService] GraphQL 请求失败:', graphqlRes.status, errText);
            return { positions: [], ok: false };
        }

        const graphqlData = await graphqlRes.json() as any;
        const edges = graphqlData?.data?.account?.positions?.edges || [];

        for (const edge of edges) {
            const node = edge.node;
            if (!node) continue;

            // shares 是 wei 字符串
            const sharesWei = BigInt(node.shares || '0');
            const shares = Number(sharesWei) / 1e18;
            if (shares <= 0) continue;

            const marketIdRaw = node.market?.id;
            if (!marketIdRaw) continue;
            const marketId = Number(marketIdRaw);  // 转换为数字，与映射中的键类型一致
            if (isNaN(marketId)) continue;

            const outcomeRaw = node.outcome?.name || '';
            const outcomeUpper = outcomeRaw.toUpperCase();
            const isBinary = outcomeUpper === 'YES' || outcomeUpper === 'NO';

            // averageBuyPriceUsd 是 0-1 格式的实际成本价
            const avgPriceRaw = Number(node.averageBuyPriceUsd || 0);
            const avgPrice = avgPriceRaw;

            // ====== 体育市场分支：outcome 不是 YES/NO（队名/Draw），从 SportsService 拿映射 ======
            if (!isBinary) {
                const sportsEntry = getSportsMappingFor(marketId);
                if (!sportsEntry) continue;  // 非已知体育市场，跳过

                const sm = sportsEntry.sportsMarket;
                const role = inferSportsRoleFromOutcome(sm, outcomeRaw, sportsEntry.sportsRole);
                const side = getSportsPredictSide(sm, role);
                // 队名 outcome 要从队名反推 away/home；单市场结构里 home = Predict NO。
                const polyTokenId = role === 'away' ? sm.polymarketAwayTokenId : sm.polymarketHomeTokenId;
                extended.push({
                    marketId,
                    title: sm.eventTitle || sm.predictTitle || node.market?.question || `Market #${marketId}`,
                    side,
                    shares: Math.round(shares * 100) / 100,
                    avgPrice,
                    costPerShare: avgPrice,
                    polymarketConditionId: sm.polymarketConditionId,
                    feeRateBps: sm.feeRateBps,
                    isSportsMarket: true,
                    sportsRole: role,
                    outcomeName: outcomeRaw,
                    polymarketAwayTokenId: sm.polymarketAwayTokenId,
                    polymarketHomeTokenId: sm.polymarketHomeTokenId,
                    polymarketTokenId: polyTokenId,
                    negRisk: sm.negRisk,
                    tickSize: sm.tickSize,
                    gameStartTime: sm.gameStartTime,
                    eventTitle: sm.eventTitle,
                    selectionLabel: sm.selectionLabel,
                    predictSlug: sm.predictSlug,
                    polymarketSlug: sm.polymarketSlug,
                });
                continue;
            }

            let conditionId = predictIdToConditionId.get(marketId);
            let feeRateBps = conditionId ? conditionIdToFeeRate.get(conditionId) : undefined;

            // binary 持仓但 conditionId 缺失 (binary 套利映射没覆盖) → 尝试 sports 映射
            // 例: 足球三选 selection 子市场是 binary YES/NO，但走 SportsService 体系
            if (!conditionId) {
                const sportsEntry = getSportsMappingFor(marketId);
                if (sportsEntry) {
                    const sm = sportsEntry.sportsMarket;
                    const role = sportsEntry.sportsRole;
                    const polyTokenId = role === 'away' ? sm.polymarketAwayTokenId : sm.polymarketHomeTokenId;
                    extended.push({
                        marketId,
                        title: sm.eventTitle || sm.predictTitle || node.market?.question || `Market #${marketId}`,
                        side: outcomeUpper as 'YES' | 'NO',
                        shares: Math.round(shares * 100) / 100,
                        avgPrice,
                        costPerShare: avgPrice,
                        polymarketConditionId: sm.polymarketConditionId,
                        feeRateBps: sm.feeRateBps || 200,
                        isSportsMarket: true,
                        sportsRole: role,
                        outcomeName: outcomeRaw,
                        polymarketAwayTokenId: sm.polymarketAwayTokenId,
                        polymarketHomeTokenId: sm.polymarketHomeTokenId,
                        polymarketTokenId: polyTokenId,
                        negRisk: sm.negRisk,
                        tickSize: sm.tickSize,
                        gameStartTime: sm.gameStartTime,
                        eventTitle: sm.eventTitle,
                        selectionLabel: sm.selectionLabel,
                        predictSlug: sm.predictSlug,
                        polymarketSlug: sm.polymarketSlug,
                    });
                    continue;
                }
            }

            const fullTitle = predictIdToQuestion.get(marketId) || node.market?.question || node.market?.title || `Market #${marketId}`;

            extended.push({
                marketId,
                title: fullTitle,
                side: outcomeUpper as 'YES' | 'NO',
                shares: Math.round(shares * 100) / 100,
                avgPrice,
                costPerShare: avgPrice,
                polymarketConditionId: conditionId,
                feeRateBps: feeRateBps || 200
            });
        }

        console.log(`[HedgeService] GraphQL 获取 Predict 持仓成功: ${extended.length} 个`);
        return { positions: extended, ok: true };
    } catch (error) {
        console.error('[HedgeService] 获取 Predict 持仓失败:', error);
        return { positions: [], ok: false };
    }
}


/**
 * 获取 Polymarket 扩展持仓（含 conditionId 和 tokenId）
 */
async function fetchExtendedPolyPositions(): Promise<PositionFetchResult<ExtendedPolyPosition>> {
    const POLYMARKET_PROXY_ADDRESS = process.env.POLYMARKET_PROXY_ADDRESS;
    if (!POLYMARKET_PROXY_ADDRESS) return { positions: [], ok: false };

    try {
        const positionsUrl = `https://data-api.polymarket.com/positions?user=${POLYMARKET_PROXY_ADDRESS}&sizeThreshold=0.01`;
        const res = await fetch(positionsUrl, { signal: AbortSignal.timeout(5000) });

        if (!res.ok) return { positions: [], ok: false };

        const positionsData = await res.json() as any[];
        const extended: ExtendedPolyPosition[] = [];

        if (Array.isArray(positionsData)) {
            for (const pos of positionsData) {
                const size = parseFloat(pos.size || '0');
                if (size <= 0) continue;

                const redeemable = pos.redeemable === true;
                if (redeemable) continue;

                const conditionId = (pos.conditionId || pos.condition_id || '').toLowerCase();
                const tokenId = pos.asset || pos.token_id || '';
                const outcomeRaw = pos.outcome || 'YES';
                const outcome = outcomeRaw.toUpperCase();

                if (!conditionId) continue;

                const avgPrice = parseFloat(pos.avgPrice || '0');

                extended.push({
                    conditionId,
                    tokenId,
                    title: pos.title || 'Unknown',
                    side: outcome as 'YES' | 'NO',
                    shares: Math.round(size * 100) / 100,
                    avgPrice,
                    costPerShare: avgPrice,
                    outcomeName: outcomeRaw,
                });
            }
        }

        console.log(`[HedgeService] 获取 Polymarket 持仓成功: ${extended.length} 个`);
        return { positions: extended, ok: true };
    } catch (error) {
        console.error('[HedgeService] 获取 Polymarket 持仓失败:', error);
        return { positions: [], ok: false };
    }
}
async function refreshPositions(force: boolean = false): Promise<void> {
    const now = Date.now();
    // 如果缓存为空，强制刷新
    const cacheEmpty = cachedPredictPositions.length === 0 && cachedPolyPositions.length === 0;
    if (!force && !cacheEmpty && now - lastPositionsRefresh < HEDGE_POSITIONS_REFRESH_MS) return;
    if (positionsRefreshInFlight) return positionsRefreshInFlight;

    positionsRefreshInFlight = (async () => {
        const [predictRes, polyRes] = await Promise.all([
            fetchExtendedPredictPositions(),
            fetchExtendedPolyPositions(),
        ]);

        if (predictRes.ok) {
            cachedPredictPositions = predictRes.positions;
        }
        if (polyRes.ok) {
            cachedPolyPositions = polyRes.positions;
        }

        lastPositionsRefresh = Date.now();
    })();

    try {
        await positionsRefreshInFlight;
    } finally {
        positionsRefreshInFlight = null;
    }
}

async function getCachedPositions(force: boolean = false): Promise<{
    predictPositions: ExtendedPredictPosition[];
    polyPositions: ExtendedPolyPosition[];
}> {
    await refreshPositions(force);
    return {
        predictPositions: cachedPredictPositions,
        polyPositions: cachedPolyPositions,
    };
}




// ============================================================================
// 订单簿查询
// ============================================================================

/**
 * 获取 Predict 订单簿
 * 优先使用 WS 缓存，缓存未命中时使用 REST fallback
 */
async function fetchPredictOrderbook(marketId: number): Promise<Orderbook | null> {
    // 优先使用 WS 缓存
    const predictProvider = getPredictOrderbookProvider();
    if (predictProvider) {
        const cached = predictProvider(marketId);
        if (cached && (cached.bids.length > 0 || cached.asks.length > 0)) {
            return cached;
        }
    }

    // REST fallback: 缓存未命中时从 Predict API 获取
    const apiKey = getPredictApiKeyProvider()?.();
    if (!apiKey) return null;

    try {
        const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}/orderbook`, {
            headers: { 'x-api-key': apiKey },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;

        const data = await res.json() as any;
        const rawBids: [number, number][] = data.data?.bids || [];
        const rawAsks: [number, number][] = data.data?.asks || [];

        const bids: OrderbookLevel[] = rawBids
            .map(([price, size]) => ({ price, size }))
            .filter(b => b.size > 0);
        const asks: OrderbookLevel[] = rawAsks
            .map(([price, size]) => ({ price, size }))
            .filter(a => a.size > 0);

        bids.sort((a, b) => b.price - a.price);
        asks.sort((a, b) => a.price - b.price);

        if (bids.length > 0 || asks.length > 0) {
            if (HEDGE_SERVICE_DEBUG) {
                console.log(`[HedgeService] REST fallback 获取 Predict 订单簿: marketId=${marketId}, bids=${bids.length}, asks=${asks.length}`);
            }
            return { bids, asks };
        }
    } catch {
        // ignore
    }

    return null;
}

/**
 * 获取 Polymarket 订单簿
 * 优先使用 WS 缓存，缓存未命中时使用 REST fallback
 */
async function fetchPolyOrderbook(tokenId: string): Promise<Orderbook | null> {
    if (!tokenId) return null;

    // 优先使用 WS 缓存
    const polyProvider = getPolyOrderbookProvider();
    if (polyProvider) {
        const wsBook = polyProvider(tokenId);
        if (wsBook && (wsBook.bids.length > 0 || wsBook.asks.length > 0)) {
            return wsBook;
        }
    }

    // REST fallback: 缓存未命中时从 CLOB API 获取
    try {
        const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`, {
            signal: AbortSignal.timeout(3000)
        });
        if (!res.ok) return null;

        const data = await res.json() as any;
        const bids: OrderbookLevel[] = (data.bids || []).map((b: any) => ({
            price: parseFloat(b.price || '0'),
            size: parseFloat(b.size || '0')
        })).filter((b: OrderbookLevel) => b.size > 0);
        const asks: OrderbookLevel[] = (data.asks || []).map((a: any) => ({
            price: parseFloat(a.price || '0'),
            size: parseFloat(a.size || '0')
        })).filter((a: OrderbookLevel) => a.size > 0);

        // 按价格排序
        bids.sort((a, b) => b.price - a.price);  // 买单从高到低
        asks.sort((a, b) => a.price - b.price);  // 卖单从低到高

        if (bids.length > 0 || asks.length > 0) {
            if (HEDGE_SERVICE_DEBUG) {
                console.log(`[HedgeService] REST fallback 获取 Poly 订单簿: tokenId=${tokenId.slice(0, 10)}..., bids=${bids.length}, asks=${asks.length}`);
            }
            return { bids, asks };
        }
    } catch {
        // ignore
    }

    return null;
}

// ============================================================================
// 市场详情查询
// ============================================================================

/**
 * 获取 Polymarket 市场详情（含 token IDs 和 negRisk）
 */
async function fetchPolymarketMarketDetail(conditionId: string): Promise<PolymarketMarketDetail | null> {
    const key = conditionId.toLowerCase();
    if (polyMarketDetailCache.has(key)) {
        return polyMarketDetailCache.get(key)!;
    }

    try {
        const res = await fetch(`https://clob.polymarket.com/markets/${conditionId}`, {
            signal: AbortSignal.timeout(3000)
        });

        if (!res.ok) return null;

        const data = await res.json() as any;

        // Polymarket CLOB API 返回 tokens 数组: [{token_id, outcome}]
        const tokens = data.tokens || [];
        let yesTokenId = '';
        let noTokenId = '';
        for (const t of tokens) {
            const outcome = (t.outcome || '').toUpperCase();
            if (outcome === 'YES') yesTokenId = t.token_id;
            if (outcome === 'NO') noTokenId = t.token_id;
        }

        const detail: PolymarketMarketDetail = {
            conditionId: key,
            yesTokenId,
            noTokenId,
            negRisk: data.neg_risk === true,
            tickSize: parseFloat(data.minimum_tick_size || '0.01')
        };

        polyMarketDetailCache.set(key, detail);
        return detail;
    } catch {
        return null;
    }
}

// ============================================================================
// 平仓收益计算
// ============================================================================

// 使用 depth-calculator.ts 中的 calculatePredictFee，已包含 10% rebate

function isSportsBinarySelection(predictPos: ExtendedPredictPosition): boolean {
    const outcome = predictPos.outcomeName?.toUpperCase();
    return Boolean(predictPos.isSportsMarket && (outcome === 'YES' || outcome === 'NO'));
}

function getPolyPositionKey(pos: ExtendedPolyPosition): string {
    return `${pos.conditionId.toLowerCase()}-${pos.tokenId || pos.side}`;
}

function findMatchingPolyPosition(
    predictPos: ExtendedPredictPosition,
    polyPositionsForMarket: ExtendedPolyPosition[],
    conditionId: string,
): ExtendedPolyPosition | undefined {
    if (predictPos.isSportsMarket && !isSportsBinarySelection(predictPos)) {
        // 队名 outcome (NBA / LoL / Dota / 等): away ↔ home token 互补
        const expectedPolyTokenId = predictPos.sportsRole === 'away'
            ? predictPos.polymarketHomeTokenId
            : predictPos.polymarketAwayTokenId;
        return polyPositionsForMarket.find(p => p.tokenId === expectedPolyTokenId);
    }

    if (isSportsBinarySelection(predictPos)) {
        // 足球三选 selection 子市场: Predict 子市场是 binary YES/NO,
        // Polymarket 同 conditionId 也是 binary YES/NO → 反向匹配
        return polyPositionsForMarket.find(p => {
            const polyOut = (p.outcomeName || p.side).toUpperCase();
            const predOut = (predictPos.outcomeName || predictPos.side).toUpperCase();
            return (predOut === 'YES' && polyOut === 'NO') || (predOut === 'NO' && polyOut === 'YES');
        });
    }

    const isInverted = conditionIdToInverted.get(conditionId) || false;
    return polyPositionsForMarket.find(p => {
        if (isInverted) {
            return p.side === predictPos.side;
        }
        return (predictPos.side === 'YES' && p.side === 'NO') ||
            (predictPos.side === 'NO' && p.side === 'YES');
    });
}

/**
 * 匹配双腿持仓，生成 ClosePosition 列表
 *
 * 匹配规则（根据 isInverted）：
 * - 正常市场 (isInverted=false): Predict YES ↔ Poly NO (反向匹配)
 * - 反向市场 (isInverted=true): Predict YES ↔ Poly YES (同向匹配，因含义相反)
 */
async function matchPositions(forcePositionsRefresh: boolean = false): Promise<ClosePosition[]> {
    const { predictPositions, polyPositions } = await getCachedPositions(forcePositionsRefresh);

    if (HEDGE_SERVICE_DEBUG) {
        console.log(`[HedgeService] 持仓数量: Predict=${predictPositions.length}, Polymarket=${polyPositions.length}`);
    }

    const closePositions: ClosePosition[] = [];

    // 按 conditionId 分组 Polymarket 持仓
    const polyByCondition = new Map<string, ExtendedPolyPosition[]>();
    for (const pos of polyPositions) {
        const key = pos.conditionId.toLowerCase();
        if (!polyByCondition.has(key)) {
            polyByCondition.set(key, []);
        }
        polyByCondition.get(key)!.push(pos);
    }

    if (HEDGE_SERVICE_DEBUG) {
        console.log(`[HedgeService] Polymarket 按 conditionId 分组: ${polyByCondition.size} 个事件`);
    }

    // 匹配 Predict 持仓
    for (const predictPos of predictPositions) {
        if (!predictPos.polymarketConditionId) {
            if (HEDGE_SERVICE_DEBUG) {
                console.log(`[HedgeService] 跳过 Predict 持仓 (无 conditionId): ${predictPos.title}`);
            }
            continue;
        }

        const conditionId = predictPos.polymarketConditionId.toLowerCase();
        const polyPositionsForMarket = polyByCondition.get(conditionId);
        if (!polyPositionsForMarket || polyPositionsForMarket.length === 0) {
            if (HEDGE_SERVICE_DEBUG) {
                console.log(`[HedgeService] 跳过 Predict 持仓 (无 Poly 持仓): ${predictPos.title} [${predictPos.side}]`);
            }
            continue;
        }

        // 获取该市场的 inverted 状态
        const isInverted = conditionIdToInverted.get(conditionId) || false;

        if (HEDGE_SERVICE_DEBUG) {
            console.log(`[HedgeService] 匹配 Predict ${predictPos.side} (isInverted=${isInverted}, sports=${!!predictPos.isSportsMarket}), Poly 候选: ${polyPositionsForMarket.map(p => p.outcomeName || p.side).join(',')}`);
        }

        const matchedPolyPos = findMatchingPolyPosition(predictPos, polyPositionsForMarket, conditionId);

        if (!matchedPolyPos) {
            if (HEDGE_SERVICE_DEBUG) {
                console.log(`[HedgeService] 未找到匹配的 Poly 持仓: Predict ${predictPos.side}, isInverted=${isInverted}, sports=${!!predictPos.isSportsMarket}`);
            }
            continue;
        }

        if (HEDGE_SERVICE_DEBUG) {
            console.log(`[HedgeService] 匹配成功: Predict ${predictPos.outcomeName || predictPos.side} ↔ Poly ${matchedPolyPos.outcomeName || matchedPolyPos.side}`);
        }

        const matchedShares = Math.min(predictPos.shares, matchedPolyPos.shares);
        if (matchedShares <= 0) continue;

        // 计算成本
        const predictCost = predictPos.costPerShare * matchedShares;
        const polyCost = matchedPolyPos.costPerShare * matchedShares;
        const entryCostTotal = predictCost + polyCost;
        const entryCostPerShare = entryCostTotal / matchedShares;

        const arbSide: ArbSide = predictPos.side;  // 套利方向 = Predict 持仓方向 (sports: 都是 'YES'，由 sportsRole 区分 away/home)

        const predictLeg: PositionLeg = {
            polymarketConditionId: conditionId,
            predictMarketId: predictPos.marketId,
            platform: 'predict',
            side: predictPos.side,
            shares: predictPos.shares,
            avgPrice: predictPos.avgPrice,
            costPerShare: predictPos.costPerShare,
            title: predictPos.title,
            outcomeName: predictPos.outcomeName,
        };

        const polymarketLeg: PositionLeg = {
            polymarketConditionId: conditionId,
            platform: 'polymarket',
            side: matchedPolyPos.side,
            shares: matchedPolyPos.shares,
            avgPrice: matchedPolyPos.avgPrice,
            costPerShare: matchedPolyPos.costPerShare,
            tokenId: matchedPolyPos.tokenId,
            title: matchedPolyPos.title,
            outcomeName: matchedPolyPos.outcomeName,
        };

        closePositions.push({
            polymarketConditionId: conditionId,
            predictMarketId: predictPos.marketId,
            title: predictPos.title,
            arbSide,
            predictLeg,
            polymarketLeg,
            matchedShares,
            entryCostTotal,
            entryCostPerShare,
            // Sports 元数据
            isSportsMarket: predictPos.isSportsMarket,
            gameStartTime: predictPos.gameStartTime,
            eventTitle: predictPos.eventTitle,
            selectionLabel: predictPos.selectionLabel,
            sportsRole: predictPos.sportsRole,
        });
    }

    return closePositions;
}

/**
 * 计算多档深度分析
 * 遍历 Predict 和 Polymarket 订单簿的多档，计算每档的盈利情况
 */
function calculateDepthAnalysis(
    predictBids: OrderbookLevel[],
    polyBids: OrderbookLevel[],
    entryCostPerShare: number,
    feeRateBps: number,
    matchedShares: number,
    arbSide: ArbSide
): CloseDepthAnalysis {
    const predictLevels: DepthLevel[] = [];
    let cumulativePredict = 0;
    let maxProfitableShares = 0;
    let totalProfit = 0;
    let weightedPriceSum = 0;

    // 遍历 Predict 订单簿各档
    for (let i = 0; i < predictBids.length && i < 10; i++) {
        const predictLevel = predictBids[i];
        if (!predictLevel || predictLevel.size <= 0) continue;

        const predictPrice = predictLevel.price;
        const predictFee = calculatePredictFee(predictPrice, feeRateBps);

        // 找到对应的 Poly 档位
        // 对于当前档位的 Predict 卖出量，找到能支撑的 Poly 买入价格
        // 策略：使用能覆盖 "当前累计量 + 本档可用量" 的 Poly 档位
        let polyPrice = 0;
        let polySize = 0;
        let cumulativePoly = 0;

        // 本档实际可用量（不超过持仓上限）
        const effectivePredictSize = Math.min(predictLevel.size, matchedShares - cumulativePredict);
        const targetCumulative = cumulativePredict + effectivePredictSize;

        for (const polyLevel of polyBids) {
            if (polyLevel && polyLevel.size > 0) {
                // 记录当前档位信息
                polyPrice = polyLevel.price;
                polySize = polyLevel.size;
                cumulativePoly += polyLevel.size;

                // 当 Poly 累计深度足够覆盖目标量时，使用当前档位价格
                if (cumulativePoly >= targetCumulative) {
                    break;
                }
            }
        }

        // 如果没有 Poly 深度，使用买一价
        if (polyPrice === 0 && polyBids.length > 0 && polyBids[0]) {
            polyPrice = polyBids[0].price;
            polySize = polyBids[0].size;
        }

        // 计算当前档的每股利润
        const profitPerShare = (predictPrice - predictFee) + polyPrice - entryCostPerShare;
        const isProfitable = profitPerShare > 0;

        cumulativePredict += predictLevel.size;

        // 只累计到持仓上限
        const effectiveSize = Math.min(predictLevel.size, matchedShares - (cumulativePredict - predictLevel.size));
        if (effectiveSize <= 0) break;

        predictLevels.push({
            price: predictPrice,
            size: predictLevel.size,
            cumulativeSize: Math.min(cumulativePredict, matchedShares),
            profitPerShare,
            isProfitable,
            polyPrice,
            polySize
        });

        // 累计盈利档位
        if (isProfitable) {
            const profitableSize = Math.min(effectiveSize, polySize);
            maxProfitableShares += profitableSize;
            totalProfit += profitPerShare * profitableSize;
            weightedPriceSum += predictPrice * profitableSize;
        }
    }

    // 计算盈亏平衡价格
    // profit = (predictPrice - fee) + polyBid - entryCost = 0
    // predictPrice - fee = entryCost - polyBid
    const polyBid = polyBids[0]?.price || 0;
    const breakEvenPriceRaw = entryCostPerShare - polyBid;
    // 考虑手续费的盈亏平衡价格（需要反推）
    // profit = price - fee(price) + polyBid - entryCost = 0
    // price - fee(price) = entryCost - polyBid
    // 用已有的 calculatePredictFee 迭代一次反推（比固定 0.5 精确得多）
    const estFee = calculatePredictFee(Math.max(breakEvenPriceRaw, 0.01), feeRateBps);
    const breakEvenPrice = breakEvenPriceRaw + estFee;

    // 限制可盈利数量不超过持仓
    maxProfitableShares = Math.min(maxProfitableShares, matchedShares);

    // 计算平均成交价
    const avgProfitPrice = maxProfitableShares > 0 ? weightedPriceSum / maxProfitableShares : 0;

    // Polymarket 各档分析（简化版本，主要用于展示）
    const polyLevels: DepthLevel[] = [];
    let cumulativePoly = 0;
    for (let i = 0; i < polyBids.length && i < 10; i++) {
        const polyLevel = polyBids[i];
        if (!polyLevel || polyLevel.size <= 0) continue;

        cumulativePoly += polyLevel.size;
        polyLevels.push({
            price: polyLevel.price,
            size: polyLevel.size,
            cumulativeSize: cumulativePoly,
            profitPerShare: 0,  // Poly 侧不单独计算利润
            isProfitable: true,
            polyPrice: polyLevel.price,
            polySize: polyLevel.size
        });
    }

    return {
        predictLevels,
        polyLevels,
        maxProfitableShares,
        avgProfitPrice,
        totalProfit,
        breakEvenPrice
    };
}

/**
 * 计算平仓机会
 */
export async function calculateCloseOpportunities(forcePositionsRefresh: boolean = false): Promise<CloseOpportunity[]> {
    const closePositions = await matchPositions(forcePositionsRefresh);
    const opportunities: CloseOpportunity[] = [];

    for (const pos of closePositions) {
        // 体育市场: 元数据从 sports-service 拿，不调 fetchPolymarketMarketDetail（CLOB API 对体育非二元市场不一定准）
        // binary 市场: 走原有 fetchPolymarketMarketDetail
        const sportsEntry = pos.isSportsMarket
            ? getSportsMappingFor(pos.predictMarketId)
            : undefined;

        const [predictBook, polyBook, marketDetail] = await Promise.all([
            fetchPredictOrderbook(pos.predictMarketId),
            fetchPolyOrderbook(pos.polymarketLeg.tokenId || ''),
            sportsEntry ? Promise.resolve(null as any) : fetchPolymarketMarketDetail(pos.polymarketConditionId),
        ]);

        // 解析 token IDs / negRisk / tickSize 来源
        let yesTokenId: string;
        let noTokenId: string;
        let negRiskFlag: boolean;
        let tickSize: number;
        if (sportsEntry) {
            const sm = sportsEntry.sportsMarket;
            yesTokenId = sm.polymarketAwayTokenId;  // 体育约定: YES = away
            noTokenId = sm.polymarketHomeTokenId;   // 体育约定: NO = home
            negRiskFlag = sm.negRisk;
            tickSize = sm.tickSize;
        } else {
            if (!marketDetail || !marketDetail.yesTokenId || !marketDetail.noTokenId) {
                continue;  // binary 市场拿不到详情则跳过
            }
            yesTokenId = marketDetail.yesTokenId;
            noTokenId = marketDetail.noTokenId;
            negRiskFlag = marketDetail.negRisk;
            tickSize = marketDetail.tickSize;
        }

        // 获取费率
        const feeRateBps = sportsEntry
            ? (sportsEntry.sportsMarket.feeRateBps || 200)
            : (conditionIdToFeeRate.get(pos.polymarketConditionId) || 200);

        // 根据 arbSide 计算正确的价格
        // arbSide='YES': Predict 持有 YES，需要卖 YES (看 YES bids)
        // arbSide='NO': Predict 持有 NO，需要卖 NO (NO bid = 1 - YES ask)
        let predictBid: number;
        let predictBidDepth: number;
        let predictAsk: number;  // M-T 模式挂单价
        let predictBids: OrderbookLevel[] = [];  // 多档 bid 数据

        if (predictBook) {
            if (pos.arbSide === 'YES') {
                // 卖 YES: 直接用 YES 订单簿
                predictBid = predictBook.bids[0]?.price || 0;
                predictBidDepth = predictBook.bids[0]?.size || 0;
                predictAsk = predictBook.asks[0]?.price || 1;
                predictBids = predictBook.bids || [];
            } else {
                // 卖 NO: NO bid = 1 - YES ask, NO ask = 1 - YES bid
                const yesAsk = predictBook.asks[0]?.price || 1;
                const yesBid = predictBook.bids[0]?.price || 0;
                const yesAskDepth = predictBook.asks[0]?.size || 0;
                predictBid = 1 - yesAsk;  // 卖 NO 时吃单价格
                predictBidDepth = yesAskDepth;  // 深度对应 YES ask 深度
                predictAsk = 1 - yesBid;  // 卖 NO 时挂单价格
                // 转换 YES asks 为 NO bids (价格倒转，按价格升序变为降序)
                predictBids = (predictBook.asks || [])
                    .map(ask => ({ price: 1 - ask.price, size: ask.size }))
                    .sort((a, b) => b.price - a.price);  // NO bids 降序排列
            }
        } else {
            // 无订单簿时使用默认值
            predictBid = 0;
            predictBidDepth = 0;
            predictAsk = 1;
        }

        const polyBid = polyBook?.bids[0]?.price || 0;
        const polyBidDepth = polyBook?.bids[0]?.size || 0;
        const polyBids = polyBook?.bids || [];

        // 多档深度分析
        const depthAnalysis = calculateDepthAnalysis(
            predictBids,
            polyBids,
            pos.entryCostPerShare,
            feeRateBps,
            pos.matchedShares,
            pos.arbSide
        );

        // T-T 计算 (使用正确的价格计算费用)
        const predictFeeTT = calculatePredictFee(predictBid, feeRateBps);
        const ttProfitPerShare = (predictBid - predictFeeTT) + polyBid - pos.entryCostPerShare;
        const ttMinPolyBid = pos.entryCostPerShare - (predictBid - predictFeeTT);

        // M-T 计算 (Maker 无手续费)
        const mtProfitPerShare = predictAsk + polyBid - pos.entryCostPerShare;
        const mtMinPolyBid = pos.entryCostPerShare - predictAsk;

        // 最大可卖量（考虑多档深度）
        // T-T: 使用多档分析的 maxProfitableShares (累计所有盈利档位)
        const maxCloseShares = depthAnalysis.maxProfitableShares > 0
            ? depthAnalysis.maxProfitableShares
            : Math.min(pos.matchedShares, predictBidDepth, polyBidDepth);  // 回退到买一价深度
        // M-T: Maker 模式不受 Predict Bid 深度限制，只受 Poly Bid 深度限制
        // 计算 Poly 多档累计深度
        const polyTotalDepth = polyBids.reduce((sum, level) => sum + (level?.size || 0), 0);
        const mtMaxCloseShares = Math.min(pos.matchedShares, polyTotalDepth || polyBidDepth);

        // URL 导航字段（与 OpportunityCard 同口径）：
        // - Predict：优先 categorySlug（事件级），回退到子市场 slug，再回退到 title 生成
        // - Polymarket：使用 getPolymarketSlug 拿到 eventSlug/marketSlug 完整路径
        const predictSlug =
            predictIdToCategorySlug.get(pos.predictMarketId)
            || getPredictSlug(pos.predictMarketId)
            || generatePredictSlug(pos.title);
        const polymarketSlug = getPolymarketSlug(pos.polymarketConditionId);

        opportunities.push({
            polymarketConditionId: pos.polymarketConditionId,
            predictMarketId: pos.predictMarketId,
            title: pos.title,
            arbSide: pos.arbSide,
            matchedShares: pos.matchedShares,
            maxCloseShares,

            // 市场详情字段（用于创建任务）- 已校验存在
            polymarketYesTokenId: yesTokenId,
            polymarketNoTokenId: noTokenId,
            negRisk: negRiskFlag,
            tickSize,
            isInverted: pos.isSportsMarket
                ? false  // 体育统一约定 YES=away/NO=home，无 inverted 概念
                : (conditionIdToInverted.get(pos.polymarketConditionId) || false),

            // URL 导航字段（用 url-mapper 缓存）
            predictSlug: pos.isSportsMarket
                ? (sportsEntry?.sportsMarket.predictSlug || predictSlug)
                : predictSlug,
            polymarketSlug: pos.isSportsMarket
                ? (sportsEntry?.sportsMarket.polymarketSlug || polymarketSlug)
                : polymarketSlug,

            // Sports 元数据
            isSportsMarket: pos.isSportsMarket,
            gameStartTime: pos.gameStartTime,
            eventTitle: pos.eventTitle,
            selectionLabel: pos.selectionLabel,
            sportsRole: pos.sportsRole,

            tt: {
                predictBid,
                predictBidDepth,
                polyBid,
                polyBidDepth,
                predictFee: predictFeeTT,
                estProfitPerShare: ttProfitPerShare,
                // 用 matchedShares 计算总利润，便于与 M-T 公平比较
                estProfitTotal: ttProfitPerShare * pos.matchedShares,
                estProfitPct: pos.entryCostPerShare > 0
                    ? (ttProfitPerShare / pos.entryCostPerShare) * 100
                    : 0,
                minPolyBid: ttMinPolyBid,
                isValid: ttProfitPerShare > 0
            },

            mt: {
                predictAsk,
                polyBid,
                polyBidDepth,
                maxCloseShares: mtMaxCloseShares,  // M-T 不受 Predict Bid 深度限制
                estProfitPerShare: mtProfitPerShare,
                // 用 matchedShares 计算总利润，便于与 T-T 公平比较
                estProfitTotal: mtProfitPerShare * pos.matchedShares,
                estProfitPct: pos.entryCostPerShare > 0
                    ? (mtProfitPerShare / pos.entryCostPerShare) * 100
                    : 0,
                minPolyBid: mtMinPolyBid,
                isValid: mtProfitPerShare > 0
            },

            // 多档深度分析
            depthAnalysis,

            feeRateBps,
            entryCostPerShare: pos.entryCostPerShare,
            lastUpdate: Date.now()
        });
    }

    // 按利润排序
    opportunities.sort((a, b) => {
        const aProfit = Math.max(a.tt.estProfitTotal, a.mt.estProfitTotal);
        const bProfit = Math.max(b.tt.estProfitTotal, b.mt.estProfitTotal);
        return bProfit - aProfit;
    });

    return opportunities;
}

/**
 * 获取可平仓持仓列表
 */
export async function getClosePositions(): Promise<ClosePosition[]> {
    return matchPositions(false);
}

/**
 * 获取所有持仓对应的市场 ID（供 WS 订阅使用）
 * 返回 Predict marketId 列表和 Polymarket tokenId 列表
 */
export async function getPositionMarketIds(): Promise<{
    predictMarketIds: number[];
    polymarketTokenIds: string[];
}> {
    const { predictPositions, polyPositions } = await getCachedPositions(false);

    const predictMarketIds = predictPositions
        .map(p => p.marketId)
        .filter((id): id is number => typeof id === 'number' && id > 0);

    const polymarketTokenIds = polyPositions
        .map(p => p.tokenId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);

    return {
        predictMarketIds: [...new Set(predictMarketIds)],
        polymarketTokenIds: [...new Set(polymarketTokenIds)],
    };
}

/**
 * 获取未匹配的单腿持仓
 * 返回只在一个平台有持仓的情况
 */
export async function getUnmatchedPositions(): Promise<UnmatchedPosition[]> {
    const { predictPositions, polyPositions } = await getCachedPositions(false);
    loadMarketMatches();

    const unmatched: UnmatchedPosition[] = [];

    // 记录已匹配的持仓（用于排除）
    const matchedPredictKeys = new Set<string>();  // marketId-side
    const matchedPolyKeys = new Set<string>();     // conditionId-tokenId

    // 按 conditionId 分组 Polymarket 持仓
    const polyByCondition = new Map<string, ExtendedPolyPosition[]>();
    for (const pos of polyPositions) {
        const key = pos.conditionId.toLowerCase();
        if (!polyByCondition.has(key)) {
            polyByCondition.set(key, []);
        }
        polyByCondition.get(key)!.push(pos);
    }

    // 遍历 Predict 持仓，找出未匹配的
    for (const predictPos of predictPositions) {
        const conditionId = predictPos.polymarketConditionId?.toLowerCase();

        // 情况1: 无 conditionId 映射
        if (!conditionId) {
            unmatched.push({
                platform: 'predict',
                marketId: predictPos.marketId,
                title: predictPos.title,
                side: predictPos.side,
                shares: predictPos.shares,
                avgPrice: predictPos.avgPrice,
                reason: 'no_mapping'
            });
            continue;
        }

        const polyPositionsForMarket = polyByCondition.get(conditionId);

        // 情况2: 无 Poly 持仓
        if (!polyPositionsForMarket || polyPositionsForMarket.length === 0) {
            unmatched.push({
                platform: 'predict',
                marketId: predictPos.marketId,
                conditionId,
                title: predictPos.title,
                side: predictPos.side,
                shares: predictPos.shares,
                avgPrice: predictPos.avgPrice,
                reason: 'no_counterpart'
            });
            continue;
        }

        const matchedPolyPos = findMatchingPolyPosition(predictPos, polyPositionsForMarket, conditionId);

        if (!matchedPolyPos) {
            // 情况3: 方向不匹配
            unmatched.push({
                platform: 'predict',
                marketId: predictPos.marketId,
                conditionId,
                title: predictPos.title,
                side: predictPos.side,
                shares: predictPos.shares,
                avgPrice: predictPos.avgPrice,
                reason: 'direction_mismatch'
            });
        } else {
            // 匹配成功，记录
            matchedPredictKeys.add(`${predictPos.marketId}-${predictPos.side}`);
            matchedPolyKeys.add(getPolyPositionKey(matchedPolyPos));
        }
    }

    // 遍历 Polymarket 持仓，找出未匹配的
    for (const polyPos of polyPositions) {
        const conditionId = polyPos.conditionId.toLowerCase();
        const polyKey = getPolyPositionKey(polyPos);

        // 跳过已匹配的
        if (matchedPolyKeys.has(polyKey)) continue;

        // 检查是否有对应的 Predict 市场
        const predictId = conditionIdToPredictId.get(conditionId);
        const hasPredictMapping = predictId !== undefined
            || predictPositions.some(p => p.polymarketConditionId?.toLowerCase() === conditionId);
        if (!hasPredictMapping) {
            unmatched.push({
                platform: 'polymarket',
                conditionId,
                tokenId: polyPos.tokenId,
                title: polyPos.title,
                side: polyPos.side,
                shares: polyPos.shares,
                avgPrice: polyPos.avgPrice,
                reason: 'no_mapping'
            });
            continue;
        }

        // 有映射但无 Predict 持仓或方向不匹配
        const predictPos = predictPositions.find(p => {
            if (p.polymarketConditionId?.toLowerCase() !== conditionId) return false;
            if (predictId !== undefined && p.marketId !== predictId) return false;
            return findMatchingPolyPosition(p, [polyPos], conditionId) === polyPos;
        });

        if (!predictPos) {
            unmatched.push({
                platform: 'polymarket',
                conditionId,
                tokenId: polyPos.tokenId,
                title: polyPos.title,
                side: polyPos.side,
                shares: polyPos.shares,
                avgPrice: polyPos.avgPrice,
                reason: 'no_counterpart'
            });
        }
    }

    return unmatched;
}
