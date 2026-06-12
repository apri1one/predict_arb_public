/**
 * Sports Market Service
 *
 * 体育市场匹配 + 套利计算服务
 *
 * 功能：
 * 1. 定期扫描 Predict/Polymarket 体育市场
 * 2. 匹配两平台的市场 (conditionId / slug)
 * 3. 获取订单簿并计算套利机会
 * 4. 一致性校验 (互斥性约束)
 * 5. 通过 SSE 广播数据
 */

import fs from 'fs';
import path from 'path';
import { PredictRestClient } from '../predict/rest-client.js';
import { PolymarketRestClient } from '../polymarket/rest-client.js';
import type { OrderBookSummary, NormalizedOrderBook } from '../polymarket/types.js';
import { PolymarketWebSocketClient } from '../polymarket/ws-client.js';
import { calculatePredictFee } from '../trading/depth-calculator.js';
import { computePointsYieldTuples } from '../trading/pp-yield.js';
import { getPredictSlug, getPredictSlugByTitle } from './url-mapper.js';
import { getPredictOrderbookCache } from '../services/predict-orderbook-cache.js';
import { isMarketBoosted } from './boost-cache.js';
import { getMarketRewardInfo } from './rewards-cache.js';
import { isSameTeam, toCanonicalTeam } from './team-name-mapper.js';

const SPORTS_MATCH_CACHE_FILE = path.join(process.cwd(), 'data', 'sports-match-cache.json');

// ============================================================================
// Predict 订单簿 Provider (WS 模式支持)
// ============================================================================

type PredictOrderbookProvider = (marketId: number) => { bids: [number, number][]; asks: [number, number][] } | null;
let predictOrderbookProvider: PredictOrderbookProvider | null = null;

/**
 * 设置 Predict 订单簿 provider（供 start-dashboard 注入）
 * WS 模式下使用统一缓存，Legacy 模式下为 null（使用 REST）
 */
export function setSportsPredictOrderbookProvider(provider: PredictOrderbookProvider | null): void {
    predictOrderbookProvider = provider;
    console.log(`[SportsService] Predict 订单簿 provider ${provider ? '已注入' : '已清除'}`);
}
import type {
    SportsMatchedMarket,
    SportsArbOpportunity,
    SportsOrderBook,
    SportsSSEData,
    SportsSSEDataLight,
    SportsSSEMarketLight,
    SportsSSEIncremental,
    PolyMarket,
    SportType,
    MatchMethod,
    MatchedMarket,
    SportsSelectionKind,
} from './sports-types.js';
import { POLY_SPORTS_TAGS, POLY_SPORTS_SERIES, SPORTS_KEYWORDS, CONSISTENCY_EPSILON, NBA_CITY_TO_ABBR, NBA_ABBR_TO_TEAM } from './sports-types.js';

// ============================================================================
// Sports 专用 API Key 轮换器
// ============================================================================

class SportsApiKeyRotator {
    private keys: string[] = [];
    private index: number = 0;
    private lastSignature: string | null = null;

    private loadFromEnv(): void {
        const loaded: string[] = [];

        // 加载体育市场专用 API keys (PREDICT_API_KEY_SPORTS_1, _2, _3)
        for (let i = 1; i <= 10; i++) {
            const key = process.env[`PREDICT_API_KEY_SPORTS_${i}`];
            if (key) loaded.push(key);
        }
        // 如果没有专用 key，回退到 SCAN keys
        if (loaded.length === 0) {
            const scanKey = process.env['PREDICT_API_KEY_SCAN'];
            if (scanKey) loaded.push(scanKey);
            for (let i = 2; i <= 10; i++) {
                const key = process.env[`PREDICT_API_KEY_SCAN_${i}`];
                if (key) loaded.push(key);
            }
        }
        // 最后回退到主 key
        if (loaded.length === 0) {
            const mainKey = process.env['PREDICT_API_KEY'];
            if (mainKey) loaded.push(mainKey);
        }

        const signature = loaded.join('|');
        this.keys = loaded;
        if (this.index >= this.keys.length) this.index = 0;

        // 仅在变化时输出，避免在 .env 尚未加载时打印 0 keys
        if (this.lastSignature !== signature) {
            this.lastSignature = signature;
            console.log(`[SportsService] API Keys loaded: ${this.keys.length} keys for parallel scanning`);
        }
    }

    getNextKey(): string {
        this.loadFromEnv();
        if (this.keys.length === 0) {
            throw new Error('No API keys available for sports scanning');
        }
        const key = this.keys[this.index];
        this.index = (this.index + 1) % this.keys.length;
        return key;
    }

    getAllKeys(): string[] {
        this.loadFromEnv();
        return [...this.keys];
    }

    getKeyCount(): number {
        this.loadFromEnv();
        return this.keys.length;
    }
}

const sportsApiKeys = new SportsApiKeyRotator();

// ============================================================================
// Types
// ============================================================================

interface InternalMatchedMarket extends MatchedMarket {
    predictMarket: any;  // PredictMarket from API (非 NBA)
    polyMarket: PolyMarket;
    eventKey?: string;
    eventTitle?: string;
    isThreeWayEvent?: boolean;
    selectionKind?: SportsSelectionKind;
    selectionLabel?: string;
    selectionCanonical?: string;

    // NBA 双市场支持
    isNbaMultiMarket?: boolean;         // 是否是 NBA 多市场结构
    predictAwayMarket?: any;            // NBA 客队获胜市场
    predictHomeMarket?: any;            // NBA 主队获胜市场
}

interface SlugGroupMeta {
    count: number;
    hasDraw: boolean;
    // 电竞三市场盘：同一 slug 下含 Match Winner + Game 1 Winner + Game 2 Winner
    hasMatchWinner: boolean;
    hasGame1: boolean;
    hasGame2: boolean;
}

/** Polymarket 订单簿幽灵深度追踪 (per-token) */
interface PhantomTracker {
    prevBestAskSize: number;
    prevBestBidSize: number;
    askFlipCount: number;
    bidFlipCount: number;
    askWindowStart: number;
    bidWindowStart: number;
    askPhantom: boolean;
    bidPhantom: boolean;
    lastAskFlipTime: number;
    lastBidFlipTime: number;
}

const PHANTOM_WINDOW_MS = 10_000;
const PHANTOM_FLIP_THRESHOLD = 6;
const PHANTOM_DUST_SIZE = 5;
const PHANTOM_SIZE_DROP_RATIO = 0.1;
const PHANTOM_RECOVERY_MS = 60_000;

// ============================================================================
// Sports Service
// ============================================================================

export class SportsService {
    private predictClient: PredictRestClient;
    private polyClient: PolymarketRestClient;
    private cachedMarkets: SportsMatchedMarket[] = [];
    private matchedMarketsCache: InternalMatchedMarket[] = [];  // 已匹配市场缓存
    private orderbookCache: Map<number, SportsOrderBook> = new Map();  // 订单簿缓存 (防止 API 失败时卡片消失)

    // 分离的订单簿缓存 (支持不同刷新频率)
    private predictOrderbookCache: Map<number, { bids: [number, number][]; asks: [number, number][] }> = new Map();
    private polyOrderbookCache: Map<string, { bids: [number, number][]; asks: [number, number][] }> = new Map();

    private lastUpdateTime: number = 0;
    private isScanning: boolean = false;
    private isRefreshing: boolean = false;
    private isRefreshingPoly: boolean = false;
    private isRefreshingPredict: boolean = false;

    // 刷新计数器 (用于日志)
    private polyRefreshCount: number = 0;
    private phantomTrackers: Map<string, PhantomTracker> = new Map();

    // 多选事件市场 ID (非对阵，走主市场 WS 链路，不进入体育面板)
    private liveOnlySportsMarketIds: Set<number> = new Set();
    private predictRefreshCount: number = 0;
    // WS miss/空簿时触发一次 REST 补热，避免长期显示 100/0
    private predictRestWarmupAt: Map<number, number> = new Map();

    // Polymarket REST 延迟追踪
    private polyRestLatencySum: number = 0;
    private polyRestLatencyCount: number = 0;

    // WS 订单簿订阅
    private polyWsClient: PolymarketWebSocketClient | null = null;
    private polyWsListenerId: string | null = null;
    private polyWsSubscribedTokens: Set<string> = new Set();
    /** 活跃任务正在使用的 token (由 task-executor 注册/注销) — REST 兜底只刷这些 */
    private activeTaskTokens: Set<string> = new Set();
    /** WS 断线时启动的 REST 兜底轮询 timer（在线时为 null） */
    private polyRestFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    /** REST 兜底轮询间隔，默认 1.5s */
    private polyRestFallbackIntervalMs = Number(process.env.SPORTS_POLY_REST_FALLBACK_MS) || 1500;
    private polyWsUpdateCount: number = 0;
    private polyWsLastUpdateTime: number = 0;
    private polyWsStartTime: number = 0;
    private lastPolyRestRefreshTime: number = 0;
    private polyWsRebuildTimer: ReturnType<typeof setTimeout> | null = null;
    private polyWsRebuildCallback: (() => void) | null = null;

    /**
     * 获取 Polymarket REST 平均延迟（ms），读取后重置
     */
    getPolyRestLatency(): number {
        if (this.polyRestLatencyCount === 0) return 0;
        const avg = Math.round(this.polyRestLatencySum / this.polyRestLatencyCount);
        this.polyRestLatencySum = 0;
        this.polyRestLatencyCount = 0;
        return avg;
    }

    /** TG 告警回调 (由 start-dashboard 注入) */
    private alertCallback: ((msg: string) => void) | null = null;

    constructor() {
        this.predictClient = new PredictRestClient();
        this.polyClient = new PolymarketRestClient();
    }

    /** 注入 TG 告警回调 */
    setAlertCallback(cb: (msg: string) => void): void {
        this.alertCallback = cb;
    }

    /** 注入 Poly WS rebuild 后的回调 (用于触发 SSE 广播) */
    setPolyWsRebuildCallback(cb: () => void): void {
        this.polyWsRebuildCallback = cb;
    }

    /** 发送 TG 告警 */
    private sendAlert(msg: string): void {
        if (this.alertCallback) this.alertCallback(msg);
    }

    // ========================================================================
    // Polymarket WS 订单簿订阅
    // ========================================================================

    /**
     * 创建独立 WS 连接并启动体育市场订单簿订阅
     * 使用独立连接避免与主市场 WS 的 token 叠加导致总量过大断连
     */
    async initWsSubscription(_mainWsClient?: PolymarketWebSocketClient): Promise<void> {
        // 创建独立 WS 连接 (不与主市场共享)
        this.polyWsClient = new PolymarketWebSocketClient({
            maxReconnectAttempts: Infinity,
        });

        this.polyWsClient.setHandlers({
            onConnect: () => {
                console.log('[Sports] WS 已连接');
                this.stopPolyRestFallback('WS connected');
            },
            onDisconnect: (code, reason) => {
                console.warn(`[Sports] WS 断连 (${code} ${reason})`);
                this.sendAlert(`⚠️ Sports WS 断连 (${code} ${reason})`);
                this.startPolyRestFallback(`WS disconnect ${code}`);
            },
        });

        // 注册 listener：WS 更新 → 同步到 polyOrderbookCache → 节流 rebuild
        this.polyWsListenerId = this.polyWsClient.addOrderBookListener((book: NormalizedOrderBook) => {
            if (!book.assetId) return;
            // 写入与 REST 相同的缓存格式
            this.polyOrderbookCache.set(book.assetId, {
                bids: book.bids,
                asks: book.asks,
            });
            this.polyWsUpdateCount++;
            this.polyWsLastUpdateTime = Date.now();

            // 节流 rebuild: 合并同一批次的 WS 更新，100ms 内只 rebuild 一次
            if (!this.polyWsRebuildTimer) {
                this.polyWsRebuildTimer = setTimeout(() => {
                    this.polyWsRebuildTimer = null;
                    this.rebuildMarketsFromCache();
                    this.polyWsRebuildCallback?.();
                }, 100);
            }
        });

        this.polyWsStartTime = Date.now();

        // 延迟 3 秒后连接，避免与主 WS 同时竞争连接
        await new Promise(r => setTimeout(r, 3000));

        try {
            await this.polyWsClient.connect();
        } catch (err: any) {
            console.error(`[Sports] WS 连接失败: ${err.message}, 退回 REST-only`);
            this.polyWsClient = null;
            return;
        }

        // 订阅当前所有已匹配市场的 tokens
        this.subscribeAllMatchedTokens();

        console.log(`[Sports] WS 订单簿订阅已初始化 (独立连接, listener=${this.polyWsListenerId})`);
    }

    /**
     * 全量订阅所有已匹配市场的 Polymarket tokens
     */
    private subscribeAllMatchedTokens(): void {
        if (!this.polyWsClient) return;

        const tokenIds: string[] = [];
        for (const match of this.matchedMarketsCache) {
            let clobTokenIds: string[];
            try {
                clobTokenIds = JSON.parse(match.polyMarket.clobTokenIds || '[]') as string[];
            } catch { continue; }
            if (clobTokenIds.length < 2) continue;
            for (const tid of clobTokenIds) {
                if (!this.polyWsSubscribedTokens.has(tid)) {
                    tokenIds.push(tid);
                    this.polyWsSubscribedTokens.add(tid);
                }
            }
        }

        if (tokenIds.length > 0) {
            this.polyWsClient.subscribe(tokenIds);
            console.log(`[Sports] WS 订阅 ${tokenIds.length} 个体育 tokens (总计 ${this.polyWsSubscribedTokens.size})`);
        }
    }

    /**
     * 新市场匹配后追加 WS 订阅 (由 matchMarkets 调用)
     */
    private subscribeNewTokens(newMatches: InternalMatchedMarket[]): void {
        if (!this.polyWsClient) return;

        const tokenIds: string[] = [];
        for (const match of newMatches) {
            let clobTokenIds: string[];
            try {
                clobTokenIds = JSON.parse(match.polyMarket.clobTokenIds || '[]') as string[];
            } catch { continue; }
            for (const tid of clobTokenIds) {
                if (!this.polyWsSubscribedTokens.has(tid)) {
                    tokenIds.push(tid);
                    this.polyWsSubscribedTokens.add(tid);
                }
            }
        }

        if (tokenIds.length > 0) {
            this.polyWsClient.subscribe(tokenIds);
            console.log(`[Sports] WS 追加订阅 ${tokenIds.length} 个新 tokens (总计 ${this.polyWsSubscribedTokens.size})`);
        }
    }

    /**
     * WS 是否已连接且活跃
     */
    isWsConnected(): boolean {
        return !!this.polyWsClient && this.polyWsClient.isConnected();
    }

    /**
     * 注册活跃任务的 token (task-executor 在 runWithPriceGuard 入口调用)
     * REST 兜底只刷新被注册的 token，避免 WS 断线时对全量订阅 burst REST
     */
    addActiveTaskToken(tokenId: string): void {
        if (!tokenId) return;
        this.activeTaskTokens.add(tokenId);
        // 如果当前 WS 已断且兜底未启动，立刻补一次刷新
        if (!this.isWsConnected() && this.polyRestFallbackTimer === null) {
            this.startPolyRestFallback('active token added during WS disconnect');
        }
    }

    /**
     * 注销活跃任务的 token (task-executor finally 调用)
     */
    removeActiveTaskToken(tokenId: string): void {
        if (!tokenId) return;
        this.activeTaskTokens.delete(tokenId);
    }

    /**
     * WS 断线时启动 REST 兜底轮询：批量 GET 活跃任务 token 的 orderbook，写入 polyOrderbookCache
     * onConnect 触发时停止
     */
    private startPolyRestFallback(reason: string): void {
        if (this.polyRestFallbackTimer !== null) return;
        console.warn(`[Sports] 启动 REST 兜底轮询 (${reason}, interval=${this.polyRestFallbackIntervalMs}ms)`);

        const tick = async () => {
            // WS 已恢复或被显式停止
            if (this.polyRestFallbackTimer === null) return;
            if (this.isWsConnected()) {
                this.stopPolyRestFallback('WS connected');
                return;
            }

            const tokens = Array.from(this.activeTaskTokens);
            if (tokens.length === 0) {
                // 无活跃任务，下一轮再检查
                this.polyRestFallbackTimer = setTimeout(tick, this.polyRestFallbackIntervalMs);
                return;
            }

            try {
                const books = await this.polyClient.getOrderBooks(tokens);
                let updated = 0;
                for (const book of books) {
                    if (!book || !book.asset_id) continue;
                    const bids = (book.bids || [])
                        .map((level: any) => [parseFloat(level.price), parseFloat(level.size)] as [number, number])
                        .filter(([, size]: [number, number]) => size > 0)
                        .sort((a: [number, number], b: [number, number]) => b[0] - a[0]);
                    const asks = (book.asks || [])
                        .map((level: any) => [parseFloat(level.price), parseFloat(level.size)] as [number, number])
                        .filter(([, size]: [number, number]) => size > 0)
                        .sort((a: [number, number], b: [number, number]) => a[0] - b[0]);
                    if (bids.length > 0 || asks.length > 0) {
                        this.polyOrderbookCache.set(book.asset_id, { bids, asks });
                        updated++;
                    }
                }
                if (updated > 0) {
                    // 触发 SSE 广播 (与 WS 路径同款)
                    this.rebuildMarketsFromCache();
                    this.polyWsRebuildCallback?.();
                }
            } catch (err: any) {
                console.warn(`[Sports] REST 兜底失败: ${err?.message || err}`);
            }

            if (this.polyRestFallbackTimer !== null) {
                this.polyRestFallbackTimer = setTimeout(tick, this.polyRestFallbackIntervalMs);
            }
        };

        // 立即首发，不等第一个 interval
        this.polyRestFallbackTimer = setTimeout(tick, 0);
    }

    private stopPolyRestFallback(reason: string): void {
        if (this.polyRestFallbackTimer === null) return;
        clearTimeout(this.polyRestFallbackTimer);
        this.polyRestFallbackTimer = null;
        console.log(`[Sports] 停止 REST 兜底轮询 (${reason})`);
    }

    /**
     * 获取体育市场独立 WS 客户端 (供 task-executor 深度/价格守护注册 listener)
     */
    getWsClient(): PolymarketWebSocketClient | null {
        return this.polyWsClient;
    }

    /**
     * WS 状态统计 (供前端展示)
     */
    getWsStats(): {
        connected: boolean;
        subscribedTokens: number;
        updateCount: number;
        lastUpdateTime: number;
        updatesPerSecond: number;
    } {
        const now = Date.now();
        const elapsedSec = Math.max(1, (now - this.polyWsStartTime) / 1000);
        return {
            connected: this.isWsConnected(),
            subscribedTokens: this.polyWsSubscribedTokens.size,
            updateCount: this.polyWsUpdateCount,
            lastUpdateTime: this.polyWsLastUpdateTime,
            updatesPerSecond: this.polyWsStartTime > 0
                ? Math.round(this.polyWsUpdateCount / elapsedSec * 10) / 10
                : 0,
        };
    }

    /**
     * 过滤 72 小时窗口外的市场
     * 保留：now - 2h (刚结束的比赛仍可平仓) ≤ endDate ≤ now + 48h
     */
    private filterByTimeWindow(markets: InternalMatchedMarket[]): InternalMatchedMarket[] {
        const now = Date.now();
        const PAST_BUFFER_MS = 2 * 60 * 60 * 1000;    // 已结束 2h 内仍保留
        const FUTURE_WINDOW_MS = 48 * 60 * 60 * 1000;  // 未来 48h
        const minTime = now - PAST_BUFFER_MS;
        const maxTime = now + FUTURE_WINDOW_MS;

        const filtered = markets.filter(m => {
            // Polymarket endDate 常被设为"当日 00:00 UTC"（CS2/Dota2 尤甚），
            // 比实际比赛时间早数小时，会被 minTime 误剔。优先用 gameStartTime。
            const refStr = m.polyMarket?.gameStartTime || m.polyMarket?.endDate;
            if (!refStr) return true; // 无日期的保留（保守）
            const refTime = new Date(refStr).getTime();
            if (isNaN(refTime)) return true;
            return refTime >= minTime && refTime <= maxTime;
        });

        if (filtered.length < markets.length) {
            console.log(`[SportsService] 48h 窗口过滤: ${markets.length} → ${filtered.length} (移除 ${markets.length - filtered.length} 个远期/过期市场)`);
        }
        return filtered;
    }

    /**
     * 持久化匹配结果到文件 (不含订单簿，仅市场元信息)
     */
    private saveMatchCache(): void {
        try {
            if (this.matchedMarketsCache.length === 0) return;
            fs.writeFileSync(SPORTS_MATCH_CACHE_FILE, JSON.stringify(this.matchedMarketsCache, null, 2));
        } catch { /* 静默 */ }
    }

    /**
     * 从文件加载匹配结果缓存 (API 故障时恢复用)
     */
    private loadMatchCache(): InternalMatchedMarket[] {
        try {
            if (!fs.existsSync(SPORTS_MATCH_CACHE_FILE)) return [];
            const data = JSON.parse(fs.readFileSync(SPORTS_MATCH_CACHE_FILE, 'utf-8'));
            if (!Array.isArray(data) || data.length === 0) return [];
            // 验证缓存时效 (最多 24 小时)
            const stat = fs.statSync(SPORTS_MATCH_CACHE_FILE);
            if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) return [];
            return data;
        } catch { return []; }
    }

    /**
     * 是否已完成初始匹配
     */
    hasMatchedMarkets(): boolean {
        return this.matchedMarketsCache.length > 0;
    }

    // ============================================================================
    // Public API
    // ============================================================================

    /**
     * 获取当前缓存的体育市场数据
     */
    getMarkets(): SportsMatchedMarket[] {
        return this.cachedMarkets;
    }

    /**
     * 获取多选事件体育市场 ID（走主市场 WS 链路，不进入体育面板）
     */
    getLiveOnlySportsMarketIds(): number[] {
        return Array.from(this.liveOnlySportsMarketIds);
    }

    private parseGameStartMs(value?: string): number | null {
        if (!value) return null;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    private getMarketLiveStatus(polyMarket: PolyMarket | null | undefined): boolean {
        return polyMarket?.events?.[0]?.live === true;
    }

    async probeNearStartMetadata(
        windowMs: number,
        conditionIdFilter?: Set<string>,
    ): Promise<{
        updates: Array<{ conditionId: string; gameStartTime?: string; live: boolean; ended: boolean; period?: string; score?: string }>;
        changes: Array<{
            conditionId: string;
            predictIds: number[];
            title: string;
            previousGameStartTime?: string;
            nextGameStartTime?: string;
            previousLive: boolean;
            nextLive: boolean;
        }>;
    }> {
        if (this.matchedMarketsCache.length === 0) {
            return { updates: [], changes: [] };
        }

        // 传了 filter 时，filter 决定要查哪些 condition：空 Set → 一个不查（active scheduler 在空闲态用这种语义）
        // 传了非空 filter → 仅查 filter 内的 conditionId，忽略 windowMs（active task 优先级高于窗口）
        if (conditionIdFilter && conditionIdFilter.size === 0) {
            return { updates: [], changes: [] };
        }

        const now = Date.now();
        const byConditionId = new Map<string, InternalMatchedMarket[]>();
        for (const match of this.matchedMarketsCache) {
            const conditionId = match.polymarketConditionId;
            if (!conditionId) continue;

            if (conditionIdFilter) {
                if (!conditionIdFilter.has(conditionId)) continue;
            } else {
                const startMs = this.parseGameStartMs(match.polyMarket?.gameStartTime);
                if (startMs === null) continue;
                if (startMs > now + windowMs) continue;
            }

            const list = byConditionId.get(conditionId) || [];
            list.push(match);
            byConditionId.set(conditionId, list);
        }

        if (byConditionId.size === 0) {
            return { updates: [], changes: [] };
        }

        const conditionIds = Array.from(byConditionId.keys());
        const updates: Array<{ conditionId: string; gameStartTime?: string; live: boolean; ended: boolean; period?: string; score?: string }> = [];
        const changes: Array<{
            conditionId: string;
            predictIds: number[];
            title: string;
            previousGameStartTime?: string;
            nextGameStartTime?: string;
            previousLive: boolean;
            nextLive: boolean;
        }> = [];

        const BATCH_SIZE = 20;
        for (let i = 0; i < conditionIds.length; i += BATCH_SIZE) {
            const batch = conditionIds.slice(i, i + BATCH_SIZE);
            let latestMarkets: PolyMarket[] = [];
            try {
                latestMarkets = await this.polyClient.getMarkets({ conditionIds: batch }) as unknown as PolyMarket[];
            } catch (error: any) {
                console.warn(`[SportsService] probeNearStartMetadata failed: batch=${batch.length}, error=${error?.message || error}`);
                continue;
            }

            const latestByConditionId = new Map<string, PolyMarket>();
            for (const market of latestMarkets) {
                if (market?.conditionId) {
                    latestByConditionId.set(market.conditionId, market);
                }
            }

            for (const conditionId of batch) {
                const latest = latestByConditionId.get(conditionId);
                if (!latest) continue;

                const nextGameStartTime = latest.gameStartTime;
                const nextLive = this.getMarketLiveStatus(latest);
                const nextEnded = latest.events?.[0]?.ended === true;
                const nextPeriod = latest.events?.[0]?.period;
                const nextScore = latest.events?.[0]?.score;

                updates.push({
                    conditionId,
                    gameStartTime: nextGameStartTime,
                    live: nextLive,
                    ended: nextEnded,
                    period: nextPeriod,
                    score: nextScore,
                });

                const existingMatches = byConditionId.get(conditionId) || [];
                if (existingMatches.length === 0) continue;

                const previousGameStartTime = existingMatches[0].polyMarket?.gameStartTime;
                const previousLive = this.getMarketLiveStatus(existingMatches[0].polyMarket);

                const prevStartMs = this.parseGameStartMs(previousGameStartTime);
                const nextStartMs = this.parseGameStartMs(nextGameStartTime);
                const timeChanged = nextGameStartTime !== undefined
                    && (
                        (prevStartMs !== null && nextStartMs !== null && prevStartMs !== nextStartMs)
                        || (prevStartMs === null && nextStartMs !== null)
                        || (prevStartMs !== null && nextStartMs === null)
                        || (prevStartMs === null && nextStartMs === null && previousGameStartTime !== nextGameStartTime)
                    );

                // 只在 live 状态翻转 (false→true) 或开赛时间改变时通知，避免持续 LIVE 期间每分钟重复触发批量撤单
                const liveFlipped = nextLive && !previousLive;
                if (timeChanged || liveFlipped) {
                    changes.push({
                        conditionId,
                        predictIds: existingMatches.map(match => match.predictId),
                        title: existingMatches[0].predictTitle || existingMatches[0].polyMarket?.question || conditionId,
                        previousGameStartTime,
                        nextGameStartTime,
                        previousLive,
                        nextLive,
                    });
                }
            }
        }

        return { updates, changes };
    }

    applyNearStartMetadataUpdates(
        updates: Array<{ conditionId: string; gameStartTime?: string; live: boolean; ended: boolean; period?: string; score?: string }>
    ): void {
        if (updates.length === 0) return;

        const updateMap = new Map(updates.map(update => [update.conditionId, update]));
        let changed = false;

        for (const match of this.matchedMarketsCache) {
                const update = updateMap.get(match.polymarketConditionId);
                if (!update) continue;

            if (update.gameStartTime !== undefined) {
                match.polyMarket.gameStartTime = update.gameStartTime;
            }
            if (!Array.isArray(match.polyMarket.events) || match.polyMarket.events.length === 0) {
                match.polyMarket.events = [{}];
            }
            match.polyMarket.events[0] = {
                ...match.polyMarket.events[0],
                live: update.live,
                ended: update.ended,
                period: update.period,
                score: update.score,
                ...(update.gameStartTime !== undefined ? { startTime: update.gameStartTime } : {}),
            };
            changed = true;
        }

        this.cachedMarkets = this.cachedMarkets.map((market) => {
            const update = updateMap.get(market.polymarketConditionId);
            if (!update) return market;
            return {
                ...market,
                gameStartTime: update.gameStartTime ?? market.gameStartTime,
            };
        });

        if (changed) {
            this.lastUpdateTime = Date.now();
            this.saveMatchCache();
        }
    }

    private hasBookDepth(book: { bids: [number, number][]; asks: [number, number][] } | null | undefined): boolean {
        if (!book) return false;
        return (Array.isArray(book.bids) && book.bids.length > 0) || (Array.isArray(book.asks) && book.asks.length > 0);
    }

    private shouldWarmPredictRest(marketId: number, now: number): boolean {
        const lastAt = this.predictRestWarmupAt.get(marketId) || 0;
        // 10 秒冷却，避免在 WS 冷启动阶段频繁打 REST
        const COOLDOWN_MS = 10000;
        if (now - lastAt < COOLDOWN_MS) return false;
        this.predictRestWarmupAt.set(marketId, now);
        return true;
    }

    /**
     * 获取 SSE 广播数据
     */
    getSSEData(): SportsSSEData {
        const markets = this.cachedMarkets;
        const withArb = markets.filter(m =>
            m.bestOpportunity && m.bestOpportunity.profitPercent > 0
        );

        const profits = withArb.map(m => m.bestOpportunity!.profitPercent);
        const avgProfit = profits.length > 0
            ? profits.reduce((a, b) => a + b, 0) / profits.length
            : 0;
        const maxProfit = profits.length > 0 ? Math.max(...profits) : 0;

        return {
            markets,
            stats: {
                totalMatched: markets.length,
                withArbitrage: withArb.length,
                avgProfit,
                maxProfit,
            },
            lastUpdate: this.lastUpdateTime,
        };
    }

    /** 轻量 SSE 数据（剥离前端不需要的字段，减少 ~90% 体积） */
    getSSEDataLight(): SportsSSEDataLight {
        const full = this.getSSEData();
        return {
            markets: this.buildLightMarkets(full.markets),
            stats: full.stats,
            lastUpdate: full.lastUpdate,
        };
    }

    /** 提取轻量市场列表（DRY：getSSEDataLight 和增量方法共用） */
    private buildLightMarkets(markets: SportsMatchedMarket[]): SportsSSEMarketLight[] {
        return markets.map(m => ({
            predictMarketId: m.predictMarketId,
            predictAwayMarketId: m.predictAwayMarketId,
            predictHomeMarketId: m.predictHomeMarketId,
            predictTitle: m.predictTitle,
            polymarketConditionId: m.polymarketConditionId,
            predictSlug: m.predictSlug,
            polymarketSlug: m.polymarketSlug,
            eventKey: m.eventKey,
            eventTitle: m.eventTitle,
            isThreeWayEvent: m.isThreeWayEvent,
            selectionKind: m.selectionKind,
            selectionLabel: m.selectionLabel,
            sport: m.sport,
            homeTeam: m.homeTeam,
            awayTeam: m.awayTeam,
            gameStartTime: m.gameStartTime,
            polymarketAwayTokenId: m.polymarketAwayTokenId,
            polymarketHomeTokenId: m.polymarketHomeTokenId,
            negRisk: m.negRisk,
            tickSize: m.tickSize,
            feeRateBps: m.feeRateBps,
            awayMT: m.awayMT,
            awayTT: m.awayTT,
            homeMT: m.homeMT,
            homeTT: m.homeTT,
            bestOpportunity: m.bestOpportunity,
            consistency: m.consistency,
            boosted: m.boosted,
            boostStartTime: m.boostStartTime,
            boostEndTime: m.boostEndTime,
            pointsTier: m.pointsTier,
            pointsHourlyRate: m.pointsHourlyRate,
            pointsExpiresAt: m.pointsExpiresAt,
            pointsNextTier: m.pointsNextTier,
            pointsNextHourlyRate: m.pointsNextHourlyRate,
            pointsNextStartsAt: m.pointsNextStartsAt,
            pointsYield: m.pointsYield,
            predictVolume: m.predictVolume,
            polymarketVolume: m.polymarketVolume,
        }));
    }

    // 增量推送 diff 状态
    private lastBroadcastedSnapshots = new Map<number, string>();

    /**
     * 获取增量 SSE 数据（仅发送变化的市场）
     */
    getSSEDataIncremental(): SportsSSEIncremental {
        const full = this.getSSEData();
        const lightMarkets = this.buildLightMarkets(full.markets);
        const currentIds = new Set<number>();
        const updated: SportsSSEMarketLight[] = [];

        for (const m of lightMarkets) {
            currentIds.add(m.predictMarketId);
            const json = JSON.stringify(m);
            const prev = this.lastBroadcastedSnapshots.get(m.predictMarketId);
            if (prev !== json) {
                updated.push(m);
                this.lastBroadcastedSnapshots.set(m.predictMarketId, json);
            }
        }

        const removed: number[] = [];
        for (const id of this.lastBroadcastedSnapshots.keys()) {
            if (!currentIds.has(id)) {
                removed.push(id);
                this.lastBroadcastedSnapshots.delete(id);
            }
        }

        return {
            snapshot: false,
            updated,
            removed,
            stats: full.stats,
            lastUpdate: full.lastUpdate,
        };
    }

    /**
     * 获取全量 snapshot（SSE 首次连接时使用）
     */
    getSSEDataSnapshot(): SportsSSEIncremental {
        const full = this.getSSEData();
        const lightMarkets = this.buildLightMarkets(full.markets);

        return {
            snapshot: true,
            updated: lightMarkets,
            removed: [],
            stats: full.stats,
            lastUpdate: full.lastUpdate,
        };
    }

    /**
     * 执行一次完整扫描 (启动时调用一次)
     * 获取市场列表 + 匹配 + 订单簿
     */
    async scan(): Promise<SportsMatchedMarket[]> {
        if (this.isScanning) {
            console.log('[SportsService] Scan already in progress, skipping');
            return this.cachedMarkets;
        }

        this.isScanning = true;
        const startTime = Date.now();

        try {
            // 1. 获取匹配的市场
            const matchedMarkets = await this.fetchAndMatchMarkets();

            if (matchedMarkets.length === 0) {
                // API 故障时: 先检查内存缓存，再检查文件缓存
                if (this.cachedMarkets.length > 0) {
                    console.log(`[SportsService] No matches found (API may be down), keeping ${this.cachedMarkets.length} cached markets`);
                    return this.cachedMarkets;
                }
                const fileCached = this.loadMatchCache();
                if (fileCached.length > 0) {
                    console.log(`[SportsService] API down, restoring ${fileCached.length} markets from file cache`);
                    this.matchedMarketsCache = this.filterByTimeWindow(fileCached);
                    const marketsWithArb = await this.calculateArbitrage(fileCached);
                    this.cachedMarkets = marketsWithArb;
                    this.lastUpdateTime = Date.now();
                    return marketsWithArb;
                }
                console.log('[SportsService] No matched sports markets found');
                return [];
            }

            // 2. 48h 窗口过滤 + 缓存匹配结果
            const filtered = this.filterByTimeWindow(matchedMarkets);
            this.matchedMarketsCache = filtered;
            this.saveMatchCache();

            // 2.5. WS 全量订阅 (初始扫描完成后)
            this.subscribeAllMatchedTokens();

            // 3. 获取订单簿并计算套利 (体育市场使用 REST API)
            const marketsWithArb = await this.calculateArbitrage(filtered);

            // 4. 更新缓存
            this.cachedMarkets = marketsWithArb;
            this.lastUpdateTime = Date.now();

            const elapsed = Date.now() - startTime;
            const withArb = marketsWithArb.filter(m => (m.bestOpportunity?.profitPercent ?? 0) > 0);
            console.log(`[SportsService] Initial scan: ${marketsWithArb.length} markets matched, ${withArb.length} with arb, ${elapsed}ms`);

            return marketsWithArb;
        } catch (error) {
            console.error('[SportsService] Scan error:', error);
            throw error;
        } finally {
            this.isScanning = false;
        }
    }

    /**
     * 刷新已匹配市场的订单簿 (定时调用)
     * 只获取订单簿，不重新匹配市场
     */
    /**
     * Incremental scan: re-match markets and only fetch orderbooks for new ones.
     */
    async scanIncremental(): Promise<{ added: number; removed: number; total: number; elapsedMs: number }> {
        if (this.isScanning) {
            console.log('[SportsService] Incremental scan already in progress, skipping');
            return { added: 0, removed: 0, total: this.cachedMarkets.length, elapsedMs: 0 };
        }

        this.isScanning = true;
        const startTime = Date.now();

        try {
            const rawMatched = await this.fetchAndMatchMarkets();
            const matchedMarkets = this.filterByTimeWindow(rawMatched);
            if (matchedMarkets.length === 0) {
                console.warn('[SportsService] Incremental scan returned 0 markets after 48h filter, skipping cache update');
                return { added: 0, removed: 0, total: this.cachedMarkets.length, elapsedMs: Date.now() - startTime };
            }

            const prevIds = new Set(this.matchedMarketsCache.map(m => m.predictId));
            const nextIds = new Set(matchedMarkets.map(m => m.predictId));
            const newMatches = matchedMarkets.filter(m => !prevIds.has(m.predictId));
            const removedMatches = this.matchedMarketsCache.filter(m => !nextIds.has(m.predictId));

            if (removedMatches.length > 0) {
                this.pruneCaches(removedMatches);
            }

            // Update matched cache to latest set
            this.matchedMarketsCache = matchedMarkets;

            if (newMatches.length > 0) {
                await this.calculateArbitrage(newMatches);

                // Polymarket WS 追加订阅新 tokens
                this.subscribeNewTokens(newMatches);

                // 新市场补订阅 Predict WS + REST 预热
                if (predictOrderbookProvider) {
                    const newMarketIds = newMatches.map(m => m.predictId);
                    const unifiedCache = getPredictOrderbookCache();
                    if (unifiedCache) {
                        await unifiedCache.subscribeMarkets(newMarketIds);
                        // REST 预热新市场（WS 无初始快照）
                        await Promise.all(newMarketIds.map(async (id) => {
                            try {
                                await unifiedCache.getOrderbook(id);
                            } catch { /* 静默 */ }
                        }));
                        console.log(`[SportsService] 新市场 WS 订阅 + 预热: ${newMarketIds.length} 个`);
                    }
                }
            }

            // Rebuild from cache so new markets are visible
            this.rebuildMarketsFromCache();

            const elapsed = Date.now() - startTime;
            console.log(`[SportsService] Incremental scan: +${newMatches.length}, -${removedMatches.length}, total ${this.cachedMarkets.length}, ${elapsed}ms`);
            return { added: newMatches.length, removed: removedMatches.length, total: this.cachedMarkets.length, elapsedMs: elapsed };
        } catch (error) {
            console.error('[SportsService] Incremental scan error:', error);
            throw error;
        } finally {
            this.isScanning = false;
        }
    }

    private pruneCaches(removedMatches: InternalMatchedMarket[]): void {
        for (const match of removedMatches) {
            this.orderbookCache.delete(match.predictId);
            this.predictOrderbookCache.delete(match.predictId);
            this.predictRestWarmupAt.delete(match.predictId);

            if (match.isNbaMultiMarket && match.predictHomeMarket?.id) {
                this.predictOrderbookCache.delete(match.predictHomeMarket.id);
                this.predictRestWarmupAt.delete(match.predictHomeMarket.id);
            }

            try {
                const clobTokenIds = JSON.parse(match.polyMarket.clobTokenIds || '[]') as string[];
                if (clobTokenIds.length >= 2) {
                    this.polyOrderbookCache.delete(clobTokenIds[0]);
                    this.polyOrderbookCache.delete(clobTokenIds[1]);
                }
                for (const tid of clobTokenIds) {
                    this.phantomTrackers.delete(tid);
                }
            } catch {
                // Ignore malformed cache entries
            }
        }

        // 清理 predictRestWarmupAt 中 >1h 的过期条目
        const oneHourAgo = Date.now() - 60 * 60 * 1000;
        for (const [id, ts] of this.predictRestWarmupAt) {
            if (ts < oneHourAgo) this.predictRestWarmupAt.delete(id);
        }
    }


    async refreshOrderbooks(): Promise<SportsMatchedMarket[]> {
        if (this.matchedMarketsCache.length === 0) {
            // 尚未完成初始匹配，跳过
            return this.cachedMarkets;
        }

        if (this.isRefreshing) {
            return this.cachedMarkets;
        }

        this.isRefreshing = true;
        const startTime = Date.now();

        try {
            // 使用缓存的匹配结果，只刷新订单簿
            const marketsWithArb = await this.calculateArbitrage(this.matchedMarketsCache);

            // 更新缓存
            this.cachedMarkets = marketsWithArb;
            this.lastUpdateTime = Date.now();

            const elapsed = Date.now() - startTime;
            const withArb = marketsWithArb.filter(m => (m.bestOpportunity?.profitPercent ?? 0) > 0);
            console.log(`[SportsService] Orderbook refresh: ${marketsWithArb.length} markets, ${withArb.length} with arb, ${elapsed}ms`);

            return marketsWithArb;
        } catch (error) {
            console.error('[SportsService] Refresh error:', error);
            throw error;
        } finally {
            this.isRefreshing = false;
        }
    }

    /**
     * 只刷新 Polymarket 订单簿 (高频: 0.1s)
     * 使用批量 POST /books 接口，单次请求获取所有 token 的订单簿
     */
    async refreshPolymarketOrderbooks(): Promise<void> {
        if (this.matchedMarketsCache.length === 0 || this.isRefreshingPoly) {
            return;
        }

        // WS 连接时降频到 1s，断连时 100ms (由 setInterval 频率控制，此处做节流)
        const now = Date.now();
        const throttleMs = this.isWsConnected() ? 1000 : 100;
        if (now - this.lastPolyRestRefreshTime < throttleMs) return;
        this.lastPolyRestRefreshTime = now;

        this.isRefreshingPoly = true;
        let allTokenIds: string[] = [];
        try {
            // 收集所有需要刷新的 tokenId
            for (const match of this.matchedMarketsCache) {
                let clobTokenIds: string[];
                try {
                    clobTokenIds = JSON.parse(match.polyMarket.clobTokenIds || '[]') as string[];
                } catch {
                    continue;
                }
                if (clobTokenIds.length < 2) continue;
                allTokenIds.push(clobTokenIds[0], clobTokenIds[1]);
            }

            if (allTokenIds.length === 0) return;

            // 批量请求 (getOrderBooks 内部自动分批，每批 ≤500)
            const books = await this.polyClient.getOrderBooks(allTokenIds);

            // 按 asset_id 写入缓存
            for (const book of books) {
                if (!book || !book.asset_id) continue;
                const bids = book.bids
                    .map((level: any) => [parseFloat(level.price), parseFloat(level.size)] as [number, number])
                    .filter(([, size]: [number, number]) => size > 0)
                    .sort((a: [number, number], b: [number, number]) => b[0] - a[0]);
                const asks = book.asks
                    .map((level: any) => [parseFloat(level.price), parseFloat(level.size)] as [number, number])
                    .filter(([, size]: [number, number]) => size > 0)
                    .sort((a: [number, number], b: [number, number]) => a[0] - b[0]);
                if (bids.length > 0 || asks.length > 0) {
                    this.polyOrderbookCache.set(book.asset_id, { bids, asks });
                }
            }

            this.rebuildMarketsFromCache();
            this.detectPhantomDepth(books);
            this.polyRefreshCount++;

            // 每 50 次输出一次日志 (约 5 秒)
            if (this.polyRefreshCount % 50 === 0) {
                const withArb = this.cachedMarkets.filter(m => (m.bestOpportunity?.profitPercent ?? 0) > 0);
                console.log(`[Sports] Poly刷新 #${this.polyRefreshCount} | ${this.cachedMarkets.length} 市场, ${withArb.length} 有套利 (batch mode)`);
            }
        } catch (err: any) {
            const errMsg = err?.message || String(err);
            console.error(`[Sports] Poly批量刷新失败 (count=${this.polyRefreshCount}, tokens=${allTokenIds?.length ?? '?'}): ${errMsg}`);
            // 首次失败或含 "500" 上限错误时发 TG 告警
            if (this.polyRefreshCount === 0 || errMsg.includes('500') || errMsg.includes('上限')) {
                this.sendAlert(`🚨 Polymarket 订单簿刷新失败\ntokens: ${allTokenIds?.length ?? '?'}, markets: ${this.matchedMarketsCache.length}\n${errMsg}`);
            }
        } finally {
            this.isRefreshingPoly = false;
        }
    }

    /**
     * 只刷新 Predict 订单簿 (低频: 1s)
     *
     * WS 模式: 从统一缓存读取，miss/空簿时做一次 REST 补热
     * Legacy 模式: 使用多个 API key 并发请求
     */
    async refreshPredictOrderbooks(): Promise<void> {
        if (this.matchedMarketsCache.length === 0 || this.isRefreshingPredict) {
            return;
        }

        this.isRefreshingPredict = true;
        try {
            const markets = this.matchedMarketsCache;

            // WS 模式: 先读 provider；当 miss/空簿且本地无有效缓存时，用 REST 做一次补热
            if (predictOrderbookProvider) {
                let wsMissCount = 0;
                let wsCacheHitCount = 0;
                let wsEmptyBookCount = 0;
                let restWarmCount = 0;
                const restWarmCandidates = new Set<number>();
                const now = Date.now();
                for (const match of markets) {
                    const marketId = match.predictId;
                    const book = predictOrderbookProvider(marketId);
                    const cachedBook = this.predictOrderbookCache.get(marketId);
                    const hasCachedDepth = this.hasBookDepth(cachedBook);

                    if (book) {
                        wsCacheHitCount++;
                        // 仅当 WS 返回有效深度时覆盖本地缓存，避免空簿覆盖真实盘口
                        if (this.hasBookDepth(book)) {
                            this.predictOrderbookCache.set(marketId, book);
                        } else {
                            wsEmptyBookCount++;
                            if (!hasCachedDepth && this.shouldWarmPredictRest(marketId, now)) {
                                restWarmCandidates.add(marketId);
                            }
                        }
                    } else {
                        wsMissCount++;
                        if (!hasCachedDepth && this.shouldWarmPredictRest(marketId, now)) {
                            restWarmCandidates.add(marketId);
                        }
                    }
                }

                if (restWarmCandidates.size > 0) {
                    const unifiedCache = getPredictOrderbookCache();
                    if (unifiedCache) {
                        await Promise.all(Array.from(restWarmCandidates).map(async (marketId) => {
                            try {
                                const warm = await unifiedCache.getOrderbook(marketId);
                                if (!warm) return;
                                const tupleBook = {
                                    bids: (warm.bids || []).map(level => [Number(level.price), Number(level.size)] as [number, number]),
                                    asks: (warm.asks || []).map(level => [Number(level.price), Number(level.size)] as [number, number]),
                                };
                                if (this.hasBookDepth(tupleBook)) {
                                    this.predictOrderbookCache.set(marketId, tupleBook);
                                    restWarmCount++;
                                }
                            } catch {
                                // 静默失败，等待下一轮冷却后重试
                            }
                        }));
                    }
                }

                this.rebuildMarketsFromCache();
                this.predictRefreshCount++;

                // 每 60 次输出一次日志（约 10 分钟一次，减少日志刷屏）
                if (this.predictRefreshCount % 60 === 0) {
                    const withArb = this.cachedMarkets.filter(m => (m.bestOpportunity?.profitPercent ?? 0) > 0);
                    console.log(
                        `[Sports] Predict(WS) #${this.predictRefreshCount} | ${this.cachedMarkets.length} 市场, ${withArb.length} 有套利 ` +
                        `| CacheHit ${wsCacheHitCount}/${markets.length}, EmptyBook ${wsEmptyBookCount}, Miss ${wsMissCount}, RestWarm ${restWarmCount}`
                    );
                }
                return;
            }

            // Legacy 模式: REST 并发请求
            const keys = sportsApiKeys.getAllKeys();
            const keyCount = keys.length;
            if (keyCount === 0) {
                console.warn('[SportsService] No API keys available for sports scanning, skipping Predict refresh');
                return;
            }

            // 使用多 key 并发：将市场分组，每个 key 负责一组
            const promises = markets.map(async (match, index) => {
                const apiKey = keys[index % keyCount];
                try {
                    const book = await this.fetchPredictOrderbookWithKey(match.predictId, apiKey);
                    this.predictOrderbookCache.set(match.predictId, book);
                } catch (e) {
                    // 静默失败，使用缓存
                }
            });

            await Promise.all(promises);
            this.rebuildMarketsFromCache();
            this.predictRefreshCount++;

            // 每 5 次输出一次日志 (约 5 秒)
            if (this.predictRefreshCount % 5 === 0) {
                const withArb = this.cachedMarkets.filter(m => (m.bestOpportunity?.profitPercent ?? 0) > 0);
                console.log(`[Sports] Predict刷新 #${this.predictRefreshCount} | ${this.cachedMarkets.length} 市场, ${withArb.length} 有套利 (${keyCount} keys)`);
            }
        } finally {
            this.isRefreshingPredict = false;
        }
    }

    /**
     * 使用指定 API key 获取 Predict 订单簿
     */
    private async fetchPredictOrderbookWithKey(
        marketId: number,
        apiKey: string
    ): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}/orderbook`, {
            headers: { 'x-api-key': apiKey },
            signal: controller.signal,
        }).finally(() => clearTimeout(timeoutId));

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const data = await res.json() as any;
        return {
            bids: data.data?.bids || [],
            asks: data.data?.asks || [],
        };
    }

    /**
     * 从缓存重建市场数据并计算套利
     * 优先使用分离缓存，回退到合并缓存
     */
    private rebuildMarketsFromCache(): void {
        const results: SportsMatchedMarket[] = [];

        for (const match of this.matchedMarketsCache) {
            let clobTokenIds: string[];
            try {
                clobTokenIds = JSON.parse(match.polyMarket.clobTokenIds || '[]') as string[];
            } catch {
                console.warn(`[SportsService] rebuildMarketsFromCache: invalid clobTokenIds for predictId=${match.predictId}, skipping`);
                continue;
            }
            if (clobTokenIds.length < 2) continue;

            const awayTokenId = clobTokenIds[0];
            const homeTokenId = clobTokenIds[1];

            // 优先使用分离缓存
            let predictBook = this.predictOrderbookCache.get(match.predictId);
            let polyAwayBook = this.polyOrderbookCache.get(awayTokenId);
            let polyHomeBook = this.polyOrderbookCache.get(homeTokenId);

            // 如果分离缓存不全，尝试从合并缓存恢复
            if (!predictBook || !polyAwayBook || !polyHomeBook) {
                const combined = this.orderbookCache.get(match.predictId);
                if (combined) {
                    // 从合并缓存重建分离缓存
                    if (!predictBook) {
                        predictBook = {
                            bids: [[combined.predict.awayBid, combined.predict.awayBidDepth]],
                            asks: [[combined.predict.awayAsk, combined.predict.awayAskDepth]],
                        };
                        this.predictOrderbookCache.set(match.predictId, predictBook);
                    }
                    if (!polyAwayBook) {
                        polyAwayBook = {
                            bids: [[combined.polymarket.awayBid, combined.polymarket.awayBidDepth]],
                            asks: [[combined.polymarket.awayAsk, combined.polymarket.awayAskDepth]],
                        };
                        this.polyOrderbookCache.set(awayTokenId, polyAwayBook);
                    }
                    if (!polyHomeBook) {
                        polyHomeBook = {
                            bids: [[combined.polymarket.homeBid, combined.polymarket.homeBidDepth]],
                            asks: [[combined.polymarket.homeAsk, combined.polymarket.homeAskDepth]],
                        };
                        this.polyOrderbookCache.set(homeTokenId, polyHomeBook);
                    }
                }
            }

            // 对于无盘口/未命中缓存的场景，保留卡片并回退为空盘口（前端展示为 --）
            if (!predictBook) predictBook = { bids: [], asks: [] };
            if (!polyAwayBook) polyAwayBook = { bids: [], asks: [] };
            if (!polyHomeBook) polyHomeBook = { bids: [], asks: [] };

            const orderbook: SportsOrderBook = {
                predict: {
                    awayBid: predictBook.bids[0]?.[0] || 0,
                    awayAsk: predictBook.asks[0]?.[0] || 1,
                    awayBidDepth: predictBook.bids[0]?.[1] || 0,
                    awayAskDepth: predictBook.asks[0]?.[1] || 0,
                    homeBid: 1 - (predictBook.asks[0]?.[0] || 1),
                    homeAsk: 1 - (predictBook.bids[0]?.[0] || 0),
                    homeBidDepth: predictBook.asks[0]?.[1] || 0,
                    homeAskDepth: predictBook.bids[0]?.[1] || 0,
                    awayBidLevels: predictBook.bids.slice(0, 3),
                    awayAskLevels: predictBook.asks.slice(0, 3),
                },
                polymarket: {
                    awayBid: polyAwayBook.bids[0]?.[0] || 0,
                    awayAsk: polyAwayBook.asks[0]?.[0] || 1,
                    awayBidDepth: polyAwayBook.bids[0]?.[1] || 0,
                    awayAskDepth: polyAwayBook.asks[0]?.[1] || 0,
                    homeBid: polyHomeBook.bids[0]?.[0] || 0,
                    homeAsk: polyHomeBook.asks[0]?.[0] || 1,
                    homeBidDepth: polyHomeBook.bids[0]?.[1] || 0,
                    homeAskDepth: polyHomeBook.asks[0]?.[1] || 0,
                },
            };

            const market = this.buildSportsMarket(match, orderbook);
            results.push(market);
        }

        this.cachedMarkets = results;
        this.lastUpdateTime = Date.now();
    }

    // ============================================================================
    // Market Matching
    // ============================================================================

    /**
     * 使用分页 API 获取所有 Predict 市场
     * 优化：更长超时，错误时继续尝试（最多重试2次）
     */
    private async fetchAllPredictMarkets(): Promise<any[]> {
        // 使用多个 SCAN key 并发请求不同页面
        const keys = sportsApiKeys.getAllKeys();
        if (keys.length === 0) {
            console.error('[SportsService] Missing API Key for scanning');
            return [];
        }

        const allMarkets: any[] = [];
        let cursor: string | null = null;
        let page = 0;
        const maxPages = 25;
        const timeoutMs = 15000;
        const maxRetries = 2;
        let consecutiveErrors = 0;

        // 使用 status=OPEN 过滤，避免遍历大量 RESOLVED 市场
        const baseParams = 'first=100&status=OPEN';

        while (page < maxPages) {
            const url = cursor
                ? `https://api.predict.fun/v1/markets?${baseParams}&after=${cursor}`
                : `https://api.predict.fun/v1/markets?${baseParams}`;

            let success = false;
            let lastError = '';

            for (let retry = 0; retry <= maxRetries && !success; retry++) {
                const apiKey = keys[(page + retry) % keys.length];  // 轮换 key
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

                try {
                    const res = await fetch(url, {
                        headers: { 'x-api-key': apiKey },
                        signal: controller.signal,
                    }).finally(() => clearTimeout(timeoutId));

                    if (!res.ok) {
                        lastError = `HTTP ${res.status}`;
                        continue;  // 尝试下一个 key
                    }
                    const data = await res.json() as any;

                    if (!data.success) {
                        lastError = 'API returned success=false';
                        continue;
                    }

                    if (!data.data?.length) {
                        // 没有更多数据，正常结束
                        success = true;
                        cursor = null;
                        break;
                    }

                    allMarkets.push(...data.data);
                    cursor = data.cursor;
                    success = true;
                    consecutiveErrors = 0;  // 重置连续错误计数
                } catch (e: any) {
                    if (e.name === 'AbortError') {
                        lastError = `timeout (${timeoutMs}ms)`;
                    } else {
                        lastError = e.message;
                    }
                    // 继续重试
                }
            }

            if (!success) {
                consecutiveErrors++;
                console.warn(`[SportsService] Page ${page} failed after ${maxRetries + 1} attempts: ${lastError}`);
                // 连续 3 次失败才停止
                if (consecutiveErrors >= 3) {
                    console.warn(`[SportsService] Stopping after ${consecutiveErrors} consecutive page failures`);
                    break;
                }
                // 继续尝试下一页（可能跳过一些数据）
            }

            page++;
            if (!cursor) break;
        }

        console.log(`[SportsService] Fetched ${allMarkets.length} markets in ${page} pages (${keys.length} keys)`);
        return allMarkets;
    }

    private async fetchAndMatchMarkets(): Promise<InternalMatchedMarket[]> {
        // 1. 使用分页 API 获取所有 Predict 市场 (非分页 API 只返回约 25 个)
        const allMarkets = await this.fetchAllPredictMarkets();

        // 筛选活跃市场 (API 已用 status=OPEN 过滤，兼容 REGISTERED/UNPAUSED 等非 RESOLVED 状态)
        const predictMarkets = allMarkets.filter(m => m.status !== 'RESOLVED');

        // 按 categorySlug 分组统计 — 区分对阵 vs 多选事件
        // 对阵: 同一 slug 下 1-3 个子市场 (标准二元 / NBA双市场 / +draw)
        // 多选: 同一 slug 下 4+ 个子市场 (如 "NBA Champion" 30个队, "Winter Olympics" 等)
        const slugGroupCounts = new Map<string, number>();
        const slugGroupMeta = new Map<string, SlugGroupMeta>();
        for (const m of predictMarkets) {
            const slug = m.categorySlug || '';
            slugGroupCounts.set(slug, (slugGroupCounts.get(slug) || 0) + 1);

            const meta = slugGroupMeta.get(slug) ?? {
                count: 0,
                hasDraw: false,
                hasMatchWinner: false,
                hasGame1: false,
                hasGame2: false,
            };
            meta.count += 1;
            const text = `${m.title || ''} ${m.question || ''}`.toLowerCase();
            if (/\bdraw\b/i.test(text)) {
                meta.hasDraw = true;
            }
            const titleLower = (m.title || '').toLowerCase().trim();
            if (titleLower === 'match winner') meta.hasMatchWinner = true;
            if (titleLower === 'game 1 winner') meta.hasGame1 = true;
            if (titleLower === 'game 2 winner') meta.hasGame2 = true;
            slugGroupMeta.set(slug, meta);
        }

        const MATCHUP_MAX_MARKETS = 3;
        const outrightSlugs = new Set<string>();
        for (const [slug, count] of slugGroupCounts) {
            if (count > MATCHUP_MAX_MARKETS) outrightSlugs.add(slug);
        }

        // 多选体育市场 → 走 LIVE 面板 WS 链路 (只标记体育类的，供 WS 补订阅)
        const liveOnlyPredictIds = new Set<number>();
        for (const m of predictMarkets) {
            if (!outrightSlugs.has(m.categorySlug || '')) continue;
            const text = [m.title || '', m.categorySlug || ''].join(' ').toLowerCase();
            if (SPORTS_KEYWORDS.some(k => text.includes(k))) {
                liveOnlyPredictIds.add(m.id);
            }
        }
        this.liveOnlySportsMarketIds = liveOnlyPredictIds;

        // 排除所有多选事件 (非对阵)
        const sportsCandidateMarkets = predictMarkets.filter(m => !outrightSlugs.has(m.categorySlug || ''));

        const getEventSelectionMeta = (predictMarket: any, polyMarket: PolyMarket) => {
            return this.buildEventSelectionMeta(predictMarket, polyMarket, slugGroupMeta);
        };

        // 筛选体育市场 (关键词匹配)
        const predictSportsMarkets = sportsCandidateMarkets.filter(m => {
            const cat = (m.categorySlug || '').toLowerCase();
            const title = (m.title || '').toLowerCase();
            return SPORTS_KEYWORDS.some(k => cat.includes(k) || title.includes(k));
        });

        // 筛选 NBA "X-at-Y" 格式市场 (城市名匹配)
        const predictNbaMarkets = sportsCandidateMarkets.filter(m => {
            const parsed = this.parsePredictNbaSlug(m.categorySlug);
            return parsed !== null;
        });

        // 有 Polymarket 链接的市场
        const linkedMarkets = sportsCandidateMarkets.filter(m =>
            m.polymarketConditionIds && m.polymarketConditionIds.length > 0
        );

        console.log(
            `[SportsService] Predict: ${predictMarkets.length} total (paginated), ` +
            `${outrightSlugs.size} outright slugs (${liveOnlyPredictIds.size} sports markets), ` +
            `${predictSportsMarkets.length} keyword-sports, ${predictNbaMarkets.length} NBA, ${linkedMarkets.length} linked`
        );

        // 2. 获取 Polymarket 体育市场
        const polyMarkets = await this.fetchPolymarketSportsMarkets();
        console.log(`[SportsService] Polymarket: ${polyMarkets.length} sports markets`);

        // 3. 匹配
        const matches: InternalMatchedMarket[] = [];

        // 方法 A: conditionId 匹配
        for (const pm of polyMarkets) {
            const matched = linkedMarkets.find(m =>
                m.polymarketConditionIds?.includes(pm.conditionId)
            );

            if (matched) {
                // 如果 Predict title 是通用的 "Match Winner"，使用 Polymarket question 或 categorySlug
                let betterTitle = matched.title;
                if (matched.title.toLowerCase() === 'match winner') {
                    betterTitle = pm.question || this.formatCategorySlugAsTitle(matched.categorySlug) || matched.title;
                }
                matches.push({
                    predictId: matched.id,
                    predictTitle: betterTitle,
                    predictCategorySlug: matched.categorySlug,
                    polymarketId: pm.id,
                    polymarketQuestion: pm.question,
                    polymarketConditionId: pm.conditionId,
                    polymarketSlug: pm.slug,
                    polymarketLiquidity: parseFloat(pm.liquidity),
                    polymarketVolume: parseFloat(pm.volume) || 0,
                    predictVolume: matched.volume || 0,
                    matchMethod: 'conditionId',
                    predictMarket: matched,
                    polyMarket: pm,
                    ...getEventSelectionMeta(matched, pm),
                });
            }
        }

        // 方法 B: NBA 匹配 (Predict 一场比赛可能有 1 或 2 个市场)
        // 1. 按 categorySlug 分组 Predict NBA 市场
        const nbaGameGroups = new Map<string, any[]>();
        for (const m of predictNbaMarkets) {
            const slug = m.categorySlug;
            if (!nbaGameGroups.has(slug)) nbaGameGroups.set(slug, []);
            nbaGameGroups.get(slug)!.push(m);
        }

        console.log(`[SportsService] NBA games: ${nbaGameGroups.size} (grouped by categorySlug)`);

        // 2. 匹配每组 (支持单市场和双市场)
        for (const pm of polyMarkets) {
            // 跳过已匹配的
            if (matches.some(m => m.polymarketId === pm.id)) continue;

            const polyParsed = this.parsePolyNbaSlug(pm.slug);
            if (!polyParsed) continue;

            // 遍历 Predict NBA 分组
            for (const [slug, groupMarkets] of nbaGameGroups) {
                // 跳过已匹配的 Predict 分组
                if (matches.some(m => m.predictCategorySlug === slug)) continue;

                const predParsed = this.parsePredictNbaSlugWithCity(slug);
                if (!predParsed) continue;

                // 检查球队组合是否匹配 (顺序可能不同)
                const teamsMatch =
                    (predParsed.awayAbbr === polyParsed.team1 && predParsed.homeAbbr === polyParsed.team2) ||
                    (predParsed.awayAbbr === polyParsed.team2 && predParsed.homeAbbr === polyParsed.team1);

                if (!teamsMatch || groupMarkets.length < 1) continue;

                // 提取 Predict 比赛日期并验证与 Polymarket 日期是否匹配
                // 使用第一个市场来提取日期（同一场比赛的多个市场日期相同）
                const predictGameDate = this.extractPredictGameDate(groupMarkets[0]);
                const polyGameDate = polyParsed.date;

                if (!this.datesMatch(predictGameDate, polyGameDate)) {
                    // 日期不匹配，跳过这个 Polymarket 市场（可能是相同对阵的不同场次）
                    console.log(`[SportsService] Date mismatch: Predict ${slug} (${predictGameDate || 'unknown'}) vs Poly ${pm.slug} (${polyGameDate})`);
                    continue;
                }

                // 使用城市名匹配 title (Predict title 是城市名，如 "Phoenix", "Miami")
                const awayCityName = predParsed.awayCity.replace(/-/g, ' ');  // "san-antonio" -> "san antonio"
                const homeCityName = predParsed.homeCity.replace(/-/g, ' ');

                // 尝试找到客队和主队市场
                const awayMarket = groupMarkets.find(m =>
                    m.title.toLowerCase().includes(awayCityName) ||
                    m.title.toLowerCase() === awayCityName ||
                    m.title.toLowerCase().includes(predParsed.awayAbbr)
                );
                const homeMarket = groupMarkets.find(m =>
                    m.title.toLowerCase().includes(homeCityName) ||
                    m.title.toLowerCase() === homeCityName ||
                    m.title.toLowerCase().includes(predParsed.homeAbbr)
                );

                // 只需要客队市场即可匹配（主队价格通过反演）
                if (awayMarket) {
                    const awayTeamName = NBA_ABBR_TO_TEAM[predParsed.awayAbbr] || predParsed.awayAbbr.toUpperCase();
                    const homeTeamName = NBA_ABBR_TO_TEAM[predParsed.homeAbbr] || predParsed.homeAbbr.toUpperCase();

                    // NBA 双市场的 volume 合计
                    const predictVol = (awayMarket.volume || 0) + (homeMarket ? (homeMarket.volume || 0) : 0);
                    matches.push({
                        predictId: awayMarket.id,  // 使用客队市场 ID 作为主 ID
                        predictTitle: `${awayTeamName} @ ${homeTeamName}`,
                        predictCategorySlug: slug,
                        polymarketId: pm.id,
                        polymarketQuestion: pm.question,
                        polymarketConditionId: pm.conditionId,
                        polymarketSlug: pm.slug,
                        polymarketLiquidity: parseFloat(pm.liquidity),
                        polymarketVolume: parseFloat(pm.volume) || 0,
                        predictVolume: predictVol,
                        matchMethod: 'nba-slug',
                        predictMarket: awayMarket,  // 主市场设为客队市场
                        polyMarket: pm,
                        // NBA 市场信息 (可能是单市场或双市场)
                        isNbaMultiMarket: !!homeMarket,  // 有主队市场才是真正的双市场
                        predictAwayMarket: awayMarket,
                        predictHomeMarket: homeMarket || awayMarket,  // 无主队市场时用客队市场
                        ...getEventSelectionMeta(awayMarket, pm),
                    });
                    console.log(`[SportsService] NBA match: ${slug} -> ${pm.slug} (Away: ${awayMarket.id}${homeMarket ? `, Home: ${homeMarket.id}` : ' [单市场]'}) [Date: ${predictGameDate}]`);
                    break;  // 找到匹配，跳出内层循环
                }
            }
        }

        // 方法 C: 其他体育 slug 模式匹配
        for (const pm of polyMarkets) {
            // 跳过已匹配的
            if (matches.some(m => m.polymarketId === pm.id)) continue;

            const parsed = this.parsePolySlug(pm.slug);
            if (!parsed) continue;

            const dateCompact = parsed.date.replace(/-/g, '');

            const matched = predictSportsMarkets.find(m => {
                if (matches.some(x => x.predictId === m.id)) return false;  // 跳过已匹配
                const cat = (m.categorySlug || '').toLowerCase();
                return cat.includes(parsed.team1) &&
                       cat.includes(parsed.team2) &&
                       (cat.includes(parsed.date) || cat.includes(dateCompact));
            });

            if (matched) {
                // 如果 Predict title 是通用的 "Match Winner"，使用 Polymarket question 或 categorySlug
                let betterTitle = matched.title;
                if (matched.title.toLowerCase() === 'match winner') {
                    betterTitle = pm.question || this.formatCategorySlugAsTitle(matched.categorySlug) || matched.title;
                }
                matches.push({
                    predictId: matched.id,
                    predictTitle: betterTitle,
                    predictCategorySlug: matched.categorySlug,
                    polymarketId: pm.id,
                    polymarketQuestion: pm.question,
                    polymarketConditionId: pm.conditionId,
                    polymarketSlug: pm.slug,
                    polymarketLiquidity: parseFloat(pm.liquidity),
                    polymarketVolume: parseFloat(pm.volume) || 0,
                    predictVolume: matched.volume || 0,
                    matchMethod: 'slug',
                    predictMarket: matched,
                    polyMarket: pm,
                    ...getEventSelectionMeta(matched, pm),
                });
            }
        }

        // 方法 E: 足球三项盘事件标题匹配（球队别名归一化 + 日期匹配）
        // 目标场景：Predict 与 Polymarket slug 缩写不一致（如 "ath" vs "bil"）
        const threeWayPredictGroups = new Map<string, any[]>();
        for (const m of predictSportsMarkets) {
            const slug = String(m.categorySlug || '').trim();
            if (!slug) continue;
            const meta = slugGroupMeta.get(slug);
            if (!meta || meta.count !== 3 || !meta.hasDraw) continue;
            if (!threeWayPredictGroups.has(slug)) threeWayPredictGroups.set(slug, []);
            threeWayPredictGroups.get(slug)!.push(m);
        }

        if (threeWayPredictGroups.size > 0) {
            type PredictEventGroup = {
                slug: string;
                date: string;
                teamSig: string;
                markets: any[];
            };
            type PolyEventGroup = {
                key: string;
                date: string;
                teamSig: string;
                markets: PolyMarket[];
            };

            const predictEventGroups: PredictEventGroup[] = [];
            for (const [slug, groupMarkets] of threeWayPredictGroups) {
                if (!Array.isArray(groupMarkets) || groupMarkets.length === 0) continue;
                if (groupMarkets.every(m => matches.some(x => x.predictId === m.id))) continue;

                const date = this.extractDateToken(slug) || this.extractPredictGameDate(groupMarkets[0]);
                if (!date) continue;

                const teamCanonicals = Array.from(
                    new Set(
                        groupMarkets
                            .map(m => this.toSelectionCanonical(this.getPredictSelectionLabel(m)))
                            .filter(c => c && c !== 'draw')
                    )
                ).sort();
                if (teamCanonicals.length !== 2) continue;

                predictEventGroups.push({
                    slug,
                    date,
                    teamSig: teamCanonicals.join('|'),
                    markets: groupMarkets,
                });
            }

            const polyEventMap = new Map<string, PolyEventGroup>();
            for (const pm of polyMarkets) {
                if (matches.some(m => m.polymarketId === pm.id)) continue;

                const eventTitle = String(pm.events?.[0]?.title || '').trim();
                const parsedTeams = this.parseTeamsFromVsFormat(eventTitle);
                if (!parsedTeams) continue;

                const eventDate =
                    this.extractDateToken(String(pm.events?.[0]?.slug || ''))
                    || this.extractDateToken(pm.slug)
                    || this.extractDateToken(pm.endDate);
                if (!eventDate) continue;

                const teamCanonicals = Array.from(
                    new Set(
                        [toCanonicalTeam(parsedTeams.away), toCanonicalTeam(parsedTeams.home)]
                            .filter(Boolean)
                    )
                ).sort();
                if (teamCanonicals.length !== 2) continue;

                const eventKey = String(pm.events?.[0]?.slug || `${eventTitle}|${eventDate}`);
                if (!polyEventMap.has(eventKey)) {
                    polyEventMap.set(eventKey, {
                        key: eventKey,
                        date: eventDate,
                        teamSig: teamCanonicals.join('|'),
                        markets: [],
                    });
                }
                polyEventMap.get(eventKey)!.markets.push(pm);
            }

            const polyByTeamSig = new Map<string, PolyEventGroup[]>();
            for (const group of polyEventMap.values()) {
                if (!polyByTeamSig.has(group.teamSig)) polyByTeamSig.set(group.teamSig, []);
                polyByTeamSig.get(group.teamSig)!.push(group);
            }

            const usedPolyIds = new Set(matches.map(m => m.polymarketId));
            let titleMatches = 0;

            for (const predictGroup of predictEventGroups) {
                const polyCandidates = (polyByTeamSig.get(predictGroup.teamSig) || [])
                    .filter(group => this.datesMatch(predictGroup.date, group.date));
                if (polyCandidates.length === 0) continue;

                // 同队名+同日期通常只对应一个事件，命中首个候选即可
                const polyGroup = polyCandidates[0];
                const polySelectionMap = new Map<string, PolyMarket>();
                for (const pm of polyGroup.markets) {
                    if (usedPolyIds.has(pm.id)) continue;
                    const canonical = this.toSelectionCanonical(this.getPolySelectionLabel(pm));
                    if (!canonical) continue;
                    if (!polySelectionMap.has(canonical)) {
                        polySelectionMap.set(canonical, pm);
                    }
                }

                for (const predictMarket of predictGroup.markets) {
                    if (matches.some(x => x.predictId === predictMarket.id)) continue;

                    const selectionCanonical = this.toSelectionCanonical(this.getPredictSelectionLabel(predictMarket));
                    if (!selectionCanonical) continue;

                    const matchedPoly = polySelectionMap.get(selectionCanonical);
                    if (!matchedPoly) continue;

                    let betterTitle = predictMarket.title;
                    if (String(predictMarket.title || '').toLowerCase() === 'match winner') {
                        betterTitle = matchedPoly.question || this.formatCategorySlugAsTitle(predictMarket.categorySlug) || predictMarket.title;
                    }

                    matches.push({
                        predictId: predictMarket.id,
                        predictTitle: betterTitle,
                        predictCategorySlug: predictMarket.categorySlug,
                        polymarketId: matchedPoly.id,
                        polymarketQuestion: matchedPoly.question,
                        polymarketConditionId: matchedPoly.conditionId,
                        polymarketSlug: matchedPoly.slug,
                        polymarketLiquidity: parseFloat(matchedPoly.liquidity),
                        polymarketVolume: parseFloat(matchedPoly.volume) || 0,
                        predictVolume: predictMarket.volume || 0,
                        matchMethod: 'title',
                        predictMarket,
                        polyMarket: matchedPoly,
                        ...getEventSelectionMeta(predictMarket, matchedPoly),
                    });

                    usedPolyIds.add(matchedPoly.id);
                    polySelectionMap.delete(selectionCanonical);
                    titleMatches++;
                }
            }

            if (titleMatches > 0) {
                console.log(`[SportsService] Method E: ${titleMatches} matched via title/team-map`);
            }
        }

        // 方法 D: conditionId 直接匹配 (通过 CLOB API 获取 Polymarket 数据)
        // 用于 Gamma API tag 无法覆盖的体育类型 (如 Dota 2, CS2)
        // 源头不走 SPORTS_KEYWORDS 关键词过滤：Predict 的电竞 categorySlug 通常是赛事名（pgl-*/iem-*/blast-*）
        // 不含 'dota'/'cs' 字样，会被 L1554 关键词过滤剔除。改用 sportsCandidateMarkets 兜底，
        // 由方法 D 内部的 isVsHeadToHead + closed/active 检查过滤非对阵市场。
        const unmatchedSportsWithLinks = sportsCandidateMarkets.filter(m =>
            !matches.some(x => x.predictId === m.id) &&
            m.polymarketConditionIds && m.polymarketConditionIds.length > 0
        );

        if (unmatchedSportsWithLinks.length > 0) {
            console.log(`[SportsService] Method D: ${unmatchedSportsWithLinks.length} unmatched sports markets with conditionIds`);

            const clobResults = await Promise.all(
                unmatchedSportsWithLinks.map(async (m) => {
                    const conditionId = m.polymarketConditionIds![0];
                    try {
                        const res = await fetch(`https://clob.polymarket.com/markets/${conditionId}`, {
                            signal: AbortSignal.timeout(5000)
                        });
                        if (!res.ok) return null;

                        const data = await res.json() as any;
                        if (data.closed === true || data.accepting_orders === false) return null;

                        // 将 CLOB 响应转换为 PolyMarket 兼容对象
                        const tokens = data.tokens || [];
                        const polyMarket: PolyMarket = {
                            id: data.condition_id || conditionId,
                            question: data.question || '',
                            conditionId: data.condition_id || conditionId,
                            slug: data.market_slug || '',
                            outcomes: JSON.stringify(tokens.map((t: any) => t.outcome)),
                            outcomePrices: JSON.stringify(tokens.map((t: any) => String(t.price || '0'))),
                            clobTokenIds: JSON.stringify(tokens.map((t: any) => t.token_id)),
                            endDate: data.end_date_iso || '',
                            liquidity: String(data.liquidity || '0'),
                            volume: String(data.volume || '0'),
                            active: data.active !== false,
                            closed: data.closed === true,
                            gameStartTime: data.game_start_time,
                            neg_risk: data.neg_risk,
                            groupItemTitle: data.groupItemTitle || data.group_item_title,
                            events: Array.isArray(data.events)
                                ? data.events.map((e: any) => ({ title: e?.title, slug: e?.slug }))
                                : undefined,
                        };

                        if (!this.isVsHeadToHead(polyMarket)) {
                            return null;
                        }

                        let betterTitle = m.title;
                        if (m.title.toLowerCase() === 'match winner') {
                            betterTitle = polyMarket.question || this.formatCategorySlugAsTitle(m.categorySlug) || m.title;
                        }

                        return {
                            predictId: m.id,
                            predictTitle: betterTitle,
                            predictCategorySlug: m.categorySlug,
                            polymarketId: polyMarket.id,
                            polymarketQuestion: polyMarket.question,
                            polymarketConditionId: conditionId,
                            polymarketSlug: polyMarket.slug,
                            polymarketLiquidity: parseFloat(polyMarket.liquidity),
                            polymarketVolume: parseFloat(polyMarket.volume) || 0,
                            predictVolume: m.volume || 0,
                            matchMethod: 'conditionId' as MatchMethod,
                            predictMarket: m,
                            polyMarket,
                            ...getEventSelectionMeta(m, polyMarket),
                        } as InternalMatchedMarket;
                    } catch {
                        return null;
                    }
                })
            );

            const directMatches = clobResults.filter(Boolean) as InternalMatchedMarket[];
            matches.push(...directMatches);
            console.log(`[SportsService] Method D: ${directMatches.length} matched via CLOB API`);
        }

        // 输出匹配详情
        const conditionIdMatches = matches.filter(m => m.matchMethod === 'conditionId').length;
        const nbaSlugMatches = matches.filter(m => m.matchMethod === 'nba-slug').length;
        const slugMatches = matches.filter(m => m.matchMethod === 'slug').length;
        const titleMatches = matches.filter(m => m.matchMethod === 'title').length;
        console.log(`[SportsService] Matched: ${matches.length} markets (conditionId: ${conditionIdMatches}, nba-slug: ${nbaSlugMatches}, slug: ${slugMatches}, title: ${titleMatches})`);

        // 4. 获取 Predict volume 数据 (单独 API 调用)
        await this.fetchPredictVolumeStats(matches);

        return matches;
    }

    /**
     * 获取 Predict 市场 volume 数据
     * 由于 /v1/markets 列表接口不返回 volume，需要单独调用 /v1/markets/{id}/stats
     */
    private async fetchPredictVolumeStats(matches: InternalMatchedMarket[]): Promise<void> {
        if (matches.length === 0) return;

        const keys = sportsApiKeys.getAllKeys();
        if (keys.length === 0) return;

        // 收集需要查询的市场 ID (去重)
        const marketIds = new Set<number>();
        for (const m of matches) {
            marketIds.add(m.predictId);
            // NBA 双市场: 添加主队市场 ID (如果存在且不同)
            if (m.isNbaMultiMarket && m.predictHomeMarket && m.predictHomeMarket.id !== m.predictId) {
                marketIds.add(m.predictHomeMarket.id);
            }
        }

        const idList = Array.from(marketIds);
        const volumeMap = new Map<number, number>();

        // 并发请求 volume (使用多 key 轮换)
        const timeoutMs = 3000;
        const batchSize = 10;  // 每批并发请求数

        for (let i = 0; i < idList.length; i += batchSize) {
            const batch = idList.slice(i, i + batchSize);
            const results = await Promise.all(batch.map(async (marketId, idx) => {
                const apiKey = keys[(i + idx) % keys.length];
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                    const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}/stats`, {
                        headers: { 'x-api-key': apiKey },
                        signal: controller.signal,
                    }).finally(() => clearTimeout(timeoutId));

                    if (!res.ok) return { marketId, volume: 0 };
                    const data = await res.json() as any;
                    return { marketId, volume: data.data?.volumeTotalUsd || 0 };
                } catch {
                    return { marketId, volume: 0 };
                }
            }));

            for (const r of results) {
                volumeMap.set(r.marketId, r.volume);
            }
        }

        // 更新匹配市场的 volume
        for (const m of matches) {
            const vol = volumeMap.get(m.predictId) || 0;
            // NBA 双市场: 合计两个市场的 volume
            if (m.isNbaMultiMarket && m.predictHomeMarket && m.predictHomeMarket.id !== m.predictId) {
                const vol2 = volumeMap.get(m.predictHomeMarket.id) || 0;
                m.predictVolume = vol + vol2;
            } else {
                m.predictVolume = vol;
            }
        }

        console.log(`[SportsService] Fetched volume for ${volumeMap.size} markets`);
    }

    /**
     * 解析 Predict NBA slug: "chicago-at-houston" -> { away: 'chi', home: 'hou' }
     */
    private parsePredictNbaSlug(slug: string): { away: string; home: string } | null {
        if (!slug) return null;
        const match = slug.toLowerCase().match(/^([a-z-]+)-at-([a-z-]+)$/);
        if (!match) return null;

        const awayCity = match[1];
        const homeCity = match[2];

        const awayAbbr = NBA_CITY_TO_ABBR[awayCity];
        const homeAbbr = NBA_CITY_TO_ABBR[homeCity];

        if (!awayAbbr || !homeAbbr) return null;

        return { away: awayAbbr, home: homeAbbr };
    }

    /**
     * 解析 Predict NBA slug 并返回城市名: "chicago-at-houston" -> { awayCity, homeCity, awayAbbr, homeAbbr }
     */
    private parsePredictNbaSlugWithCity(slug: string): { awayCity: string; homeCity: string; awayAbbr: string; homeAbbr: string } | null {
        if (!slug) return null;
        const match = slug.toLowerCase().match(/^([a-z-]+)-at-([a-z-]+)$/);
        if (!match) return null;

        const awayCity = match[1];
        const homeCity = match[2];

        const awayAbbr = NBA_CITY_TO_ABBR[awayCity];
        const homeAbbr = NBA_CITY_TO_ABBR[homeCity];

        if (!awayAbbr || !homeAbbr) return null;

        return { awayCity, homeCity, awayAbbr, homeAbbr };
    }

    /**
     * 解析 Polymarket NBA slug: "nba-chi-hou-2026-01-13" -> { team1: 'chi', team2: 'hou', date: '2026-01-13' }
     */
    private parsePolyNbaSlug(slug: string): { team1: string; team2: string; date: string } | null {
        if (!slug) return null;
        const match = slug.toLowerCase().match(/^nba-([a-z]{3})-([a-z]{3})-(\d{4}-\d{2}-\d{2})$/);
        if (!match) return null;

        return {
            team1: match[1],
            team2: match[2],
            date: match[3],
        };
    }

    /**
     * 从 Predict 市场提取比赛日期
     * 优先级: kalshiMarketTicker > description > categorySlug 后缀
     *
     * @returns 日期字符串 'YYYY-MM-DD' 或 null
     */
    private extractPredictGameDate(market: any): string | null {
        // 1. 从 kalshiMarketTicker 解析
        // 格式: KXNBAGAME-26JAN15MEMORL-MEM -> 2026-01-15
        // 格式: KXNFLGAME-26JAN18LACHI-LA -> 2026-01-18
        const ticker = market.kalshiMarketTicker;
        if (ticker) {
            const tickerMatch = ticker.match(/(\d{2})([A-Z]{3})(\d{2})/i);
            if (tickerMatch) {
                const year = 2000 + parseInt(tickerMatch[1], 10);
                const monthStr = tickerMatch[2].toUpperCase();
                const day = parseInt(tickerMatch[3], 10);

                const monthMap: Record<string, number> = {
                    'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
                    'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
                };
                const month = monthMap[monthStr];
                if (month) {
                    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                }
            }
        }

        // 2. 从 description 解析
        // 格式: "originally scheduled for Jan 15, 2026"
        // 格式: "January 15, 2026"
        const desc = market.description;
        if (desc) {
            // 匹配 "Jan 15, 2026" 或 "January 15, 2026" 格式
            const descMatch = desc.match(/(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})/i);
            if (descMatch) {
                const monthStr = descMatch[1].substring(0, 3).toUpperCase();
                const day = parseInt(descMatch[2], 10);
                const year = parseInt(descMatch[3], 10);

                const monthMap: Record<string, number> = {
                    'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
                    'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
                };
                const month = monthMap[monthStr];
                if (month) {
                    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                }
            }
        }

        // 3. 从 categorySlug 后缀解析
        // 格式: "miami-at-chicago-jan8" -> 假设当前年份
        // 格式: "dallas-at-utah-jan15"
        const slug = market.categorySlug;
        if (slug) {
            const slugMatch = slug.match(/-([a-z]{3})(\d{1,2})$/i);
            if (slugMatch) {
                const monthStr = slugMatch[1].toUpperCase();
                const day = parseInt(slugMatch[2], 10);

                const monthMap: Record<string, number> = {
                    'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
                    'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
                };
                const month = monthMap[monthStr];
                if (month) {
                    // 使用当前年份（体育赛事通常是近期的）
                    const year = new Date().getFullYear();
                    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                }
            }
        }

        return null;
    }

    /**
     * 检查两个日期是否匹配（允许 ±1 天的时区容差）
     *
     * Polymarket slug 使用美东日期，而 Predict 可能使用不同时区
     * 例如: 美东 1月15日晚上的比赛可能在 UTC 是 1月16日
     */
    private datesMatch(predictDate: string | null, polyDate: string): boolean {
        if (!predictDate) {
            // 无法获取 Predict 日期时，不进行日期过滤（保持向后兼容）
            return true;
        }

        // 解析日期
        const pred = new Date(predictDate + 'T12:00:00Z');
        const poly = new Date(polyDate + 'T12:00:00Z');

        // 计算差异（毫秒）
        const diffMs = Math.abs(pred.getTime() - poly.getTime());
        const diffDays = diffMs / (1000 * 60 * 60 * 24);

        // 允许 ±1 天的容差（处理时区差异）
        return diffDays <= 1;
    }

    private extractDateToken(text: string): string | null {
        const value = String(text || '');
        const match = value.match(/(\d{4}-\d{2}-\d{2})/);
        return match ? match[1] : null;
    }

    private isDrawSelectionText(text: string): boolean {
        return /\bdraw\b/i.test(String(text || '').trim());
    }

    private getPredictSelectionLabel(predictMarket: any): string {
        const rawTitle = String(predictMarket?.title || '').trim();
        const lowered = rawTitle.toLowerCase();
        const generic = new Set(['yes', 'no', 'match winner']);

        if (rawTitle && !generic.has(lowered)) {
            return rawTitle;
        }

        const question = String(predictMarket?.question || '').trim();
        if (this.isDrawSelectionText(question)) {
            return 'Draw';
        }

        const willWinMatch = question.match(/^will\s+(.+?)\s+win/i);
        if (willWinMatch?.[1]) {
            return willWinMatch[1].trim();
        }

        return rawTitle || question || 'Unknown';
    }

    private getPolySelectionLabel(polyMarket: PolyMarket): string {
        const groupItem = String(polyMarket.groupItemTitle || '').trim();
        if (groupItem) {
            if (this.isDrawSelectionText(groupItem)) {
                return 'Draw';
            }
            return groupItem.replace(/^team\s*:\s*/i, '').trim();
        }

        const question = String(polyMarket.question || '').trim();
        if (this.isDrawSelectionText(question)) {
            return 'Draw';
        }

        const willWinMatch = question.match(/^will\s+(.+?)\s+win/i);
        if (willWinMatch?.[1]) {
            return willWinMatch[1].trim();
        }

        return question || 'Unknown';
    }

    private toSelectionCanonical(label: string): string {
        if (this.isDrawSelectionText(label)) return 'draw';
        return toCanonicalTeam(label);
    }

    private async fetchPolymarketSportsMarkets(): Promise<PolyMarket[]> {
        const tagIds = Object.values(POLY_SPORTS_TAGS).filter(id => id > 1);  // 排除 placeholder
        const timeoutMs = 10000;  // 增加超时时间

        // 并发请求所有 tag，记录每个 tag 的获取结果
        const tagResults: { tagId: number; count: number }[] = [];
        const results = await Promise.all(tagIds.map(async (tagId) => {
            try {
                const url = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50&tag_id=${tagId}&sports_market_types=moneyline`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timeoutId));
                if (!res.ok) {
                    console.warn(`[SportsService] Polymarket tag ${tagId} failed: HTTP ${res.status}`);
                    tagResults.push({ tagId, count: 0 });
                    return [];
                }
                const markets = await res.json() as PolyMarket[];
                tagResults.push({ tagId, count: markets.length });
                return markets;
            } catch (error: any) {
                const msg = error.name === 'AbortError' ? 'timeout' : error.message;
                console.warn(`[SportsService] Polymarket tag ${tagId} error: ${msg}`);
                tagResults.push({ tagId, count: 0 });
                return [];
            }
        }));

        // 额外拉取 moneyline 全量分页（offset），覆盖未纳入固定 tag 的联赛
        const BROAD_LIMIT = 500;
        const BROAD_MAX_PAGES = 12; // 兜底上限，避免异常分页导致无限拉取
        let broadMarkets: PolyMarket[] = [];
        let broadPages = 0;
        for (let page = 0; page < BROAD_MAX_PAGES; page++) {
            const offset = page * BROAD_LIMIT;
            const broadUrl = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${BROAD_LIMIT}&offset=${offset}&sports_market_types=moneyline`;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                const res = await fetch(broadUrl, { signal: controller.signal }).finally(() => clearTimeout(timeoutId));
                if (!res.ok) {
                    console.warn(`[SportsService] Polymarket broad page ${page} failed: HTTP ${res.status}`);
                    break;
                }

                const pageMarkets = await res.json() as PolyMarket[];
                if (!Array.isArray(pageMarkets) || pageMarkets.length === 0) {
                    break;
                }

                broadMarkets.push(...pageMarkets);
                broadPages++;

                if (pageMarkets.length < BROAD_LIMIT) {
                    break;
                }
            } catch (error: any) {
                const msg = error.name === 'AbortError' ? 'timeout' : error.message;
                console.warn(`[SportsService] Polymarket broad page ${page} error: ${msg}`);
                break;
            }
        }

        // 输出每个 tag 的结果
        const tagSummary = tagResults.map(r => `${r.tagId}:${r.count}`).join(', ');
        console.log(`[SportsService] Polymarket tags: ${tagSummary} | broad:${broadMarkets.length}(${broadPages}p)`);

        // 电竞 series 分支：Dota/CS 在 Polymarket 没有 tag，通过 events?series_id 批量拉取
        const seriesMarkets = await this.fetchPolymarketEsportsViaSeries(timeoutMs);

        // 合并并去重
        const allMarkets = [...results.flat(), ...broadMarkets, ...seriesMarkets];
        const deduped = Array.from(new Map(allMarkets.map(m => [m.id, m])).values());
        const vsMarkets = deduped.filter(m => this.isVsHeadToHead(m));
        const dropped = deduped.length - vsMarkets.length;
        if (dropped > 0) {
            console.log(`[SportsService] Polymarket vs-filter: kept ${vsMarkets.length}, dropped ${dropped}`);
        }
        return vsMarkets;
    }

    /**
     * 拉取 Polymarket 电竞市场（Dota 2 / CS2）
     * 这些市场没有 tag，必须通过 events?series_id=X 批量拉取后展平 markets
     * 过滤 sportsMarketType ∈ {moneyline, child_moneyline}（Match Winner + Game 1/2 Winner）
     */
    private async fetchPolymarketEsportsViaSeries(timeoutMs: number): Promise<PolyMarket[]> {
        const seriesIds = Object.values(POLY_SPORTS_SERIES).filter((v): v is number => typeof v === 'number');
        if (seriesIds.length === 0) return [];

        const EVENTS_LIMIT = 100;
        const MAX_PAGES = 6;  // 兜底 600 events / series
        const ALLOWED_TYPES = new Set(['moneyline', 'child_moneyline']);

        const allFlat: PolyMarket[] = [];
        const summary: string[] = [];

        for (const seriesId of seriesIds) {
            let pageCount = 0;
            let activeOnSeries = 0;
            for (let page = 0; page < MAX_PAGES; page++) {
                const offset = page * EVENTS_LIMIT;
                const url = `https://gamma-api.polymarket.com/events?series_id=${seriesId}&closed=false&limit=${EVENTS_LIMIT}&offset=${offset}&order=startDate&ascending=false`;
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                    const res = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timeoutId));
                    if (!res.ok) {
                        console.warn(`[SportsService] Polymarket series ${seriesId} page ${page} failed: HTTP ${res.status}`);
                        break;
                    }
                    const events = await res.json() as any[];
                    if (!Array.isArray(events) || events.length === 0) break;

                    for (const ev of events) {
                        const eventTitle = ev?.title || '';
                        const eventSlug = ev?.slug || '';
                        for (const m of (ev?.markets || [])) {
                            if (!m?.active || m?.closed) continue;
                            if (!ALLOWED_TYPES.has(m?.sportsMarketType)) continue;
                            // 把 event 信息注入 market.events 数组，让 isVsHeadToHead / buildEventSelectionMeta 能读到
                            const enriched: PolyMarket = {
                                id: String(m.id),
                                question: m.question || '',
                                conditionId: m.conditionId,
                                slug: m.slug || '',
                                outcomes: typeof m.outcomes === 'string' ? m.outcomes : JSON.stringify(m.outcomes || []),
                                outcomePrices: typeof m.outcomePrices === 'string' ? m.outcomePrices : JSON.stringify(m.outcomePrices || []),
                                clobTokenIds: typeof m.clobTokenIds === 'string' ? m.clobTokenIds : JSON.stringify(m.clobTokenIds || []),
                                endDate: m.endDate || '',
                                liquidity: String(m.liquidity ?? m.liquidityNum ?? '0'),
                                volume: String(m.volume ?? m.volumeNum ?? '0'),
                                active: m.active !== false,
                                closed: m.closed === true,
                                gameStartTime: m.gameStartTime,
                                neg_risk: m.negRisk === true,
                                groupItemTitle: m.groupItemTitle,
                                events: [{ title: eventTitle, slug: eventSlug }],
                            };
                            allFlat.push(enriched);
                            activeOnSeries++;
                        }
                    }
                    pageCount++;
                    if (events.length < EVENTS_LIMIT) break;
                } catch (error: any) {
                    const msg = error.name === 'AbortError' ? 'timeout' : error.message;
                    console.warn(`[SportsService] Polymarket series ${seriesId} page ${page} error: ${msg}`);
                    break;
                }
            }
            summary.push(`${seriesId}:${activeOnSeries}(${pageCount}p)`);
        }

        console.log(`[SportsService] Polymarket series: ${summary.join(', ')} | total active markets: ${allFlat.length}`);
        return allFlat;
    }

    private parsePolySlug(slug: string): { sport: string; team1: string; team2: string; date: string } | null {
        // Format variants:
        // 1) nba-mia-chi-2026-01-08
        // 2) epl-wol-ars-2026-02-18-wol
        // 3) la-liga-ath-ovi-2026-02-15-draw
        const match = slug.match(/^([a-z]+(?:-[a-z]+)*)-([a-z0-9]{2,10})-([a-z0-9]{2,10})-(\d{4}-\d{2}-\d{2})(?:-[a-z0-9-]+)?$/i);
        if (match) {
            return {
                sport: match[1].toLowerCase(),
                team1: match[2].toLowerCase(),
                team2: match[3].toLowerCase(),
                date: match[4],
            };
        }
        return null;
    }

    // ============================================================================
    // Arbitrage Calculation
    // ============================================================================

    private async calculateArbitrage(matches: InternalMatchedMarket[]): Promise<SportsMatchedMarket[]> {
        const results: SportsMatchedMarket[] = [];

        // 并行获取所有订单簿
        const orderbookPromises = matches.map(async (match) => {
            try {
                const orderbook = await this.fetchOrderBooks(match);
                // 成功获取，更新缓存
                this.orderbookCache.set(match.predictId, orderbook);
                return { match, orderbook, fromCache: false };
            } catch (error) {
                // 获取失败，尝试使用缓存 (不逐个输出日志，最后汇总)
                const cached = this.orderbookCache.get(match.predictId);
                if (cached) {
                    return { match, orderbook: cached, fromCache: true };
                }
                // 无缓存时才报错
                console.error(`[SportsService] No cache for ${match.predictId}`);
                return null;
            }
        });

        const orderbookResults = await Promise.all(orderbookPromises);

        let fromCacheCount = 0;
        for (const result of orderbookResults) {
            if (!result) continue;

            const { match, orderbook, fromCache } = result;
            if (fromCache) fromCacheCount++;
            const market = this.buildSportsMarket(match, orderbook);
            results.push(market);
        }

        if (fromCacheCount > 0) {
            console.log(`[SportsService] ${fromCacheCount}/${results.length} markets using cached orderbook`);
        }

        return results;
    }

    private async fetchOrderBooks(match: InternalMatchedMarket): Promise<SportsOrderBook> {
        // 解析 Polymarket token IDs
        let clobTokenIds: string[];
        try {
            clobTokenIds = JSON.parse(match.polyMarket.clobTokenIds || '[]') as string[];
        } catch {
            throw new Error(`Invalid clobTokenIds JSON for ${match.polymarketId}`);
        }
        if (clobTokenIds.length < 2) {
            throw new Error(`Invalid clobTokenIds for ${match.polymarketId}`);
        }

        const awayTokenId = clobTokenIds[0];  // outcomes[0] = 客队
        const homeTokenId = clobTokenIds[1];  // outcomes[1] = 主队

        // 分别获取订单簿，记录具体哪个 API 失败
        let predictBook: { bids: [number, number][]; asks: [number, number][] } | null = null;
        let polyAwayBook: { bids: [number, number][]; asks: [number, number][] } | null = null;
        let polyHomeBook: { bids: [number, number][]; asks: [number, number][] } | null = null;
        const emptyBook = { bids: [] as [number, number][], asks: [] as [number, number][] };

        try {
            predictBook = await this.predictClient.getOrderBook(match.predictId);
        } catch {
            // REST 失败时优先使用 WS provider/缓存，最后回退为空盘口
            predictBook = predictOrderbookProvider?.(match.predictId) || this.predictOrderbookCache.get(match.predictId) || null;
        }
        if (predictBook) {
            this.predictOrderbookCache.set(match.predictId, predictBook);
        } else {
            predictBook = emptyBook;
        }

        [polyAwayBook, polyHomeBook] = await Promise.all([
            this.getPolyOrderBook(awayTokenId),
            this.getPolyOrderBook(homeTokenId),
        ]);
        if (polyAwayBook) {
            this.polyOrderbookCache.set(awayTokenId, polyAwayBook);
        } else {
            polyAwayBook = this.polyOrderbookCache.get(awayTokenId) || emptyBook;
        }
        if (polyHomeBook) {
            this.polyOrderbookCache.set(homeTokenId, polyHomeBook);
        } else {
            polyHomeBook = this.polyOrderbookCache.get(homeTokenId) || emptyBook;
        }

        // 构建订单簿数据
        const predAwayBid = predictBook.bids[0]?.[0] || 0;
        const predAwayAsk = predictBook.asks[0]?.[0] || 1;
        const predAwayBidDepth = predictBook.bids[0]?.[1] || 0;
        const predAwayAskDepth = predictBook.asks[0]?.[1] || 0;

        // Polymarket 客队订单簿 (直接获取)
        const polyAwayBid = polyAwayBook.bids[0]?.[0] || 0;
        const polyAwayAsk = polyAwayBook.asks[0]?.[0] || 1;
        const polyAwayBidDepth = polyAwayBook.bids[0]?.[1] || 0;
        const polyAwayAskDepth = polyAwayBook.asks[0]?.[1] || 0;

        // Polymarket 主队订单簿 (直接获取，不用反演)
        const polyHomeBid = polyHomeBook.bids[0]?.[0] || 0;
        const polyHomeAsk = polyHomeBook.asks[0]?.[0] || 1;
        const polyHomeBidDepth = polyHomeBook.bids[0]?.[1] || 0;
        const polyHomeAskDepth = polyHomeBook.asks[0]?.[1] || 0;

        return {
            predict: {
                awayBid: predAwayBid,
                awayAsk: predAwayAsk,
                awayBidDepth: predAwayBidDepth,
                awayAskDepth: predAwayAskDepth,
                // Predict 主队价格通过反演 (单市场结构)
                homeBid: 1 - predAwayAsk,
                homeAsk: 1 - predAwayBid,
                homeBidDepth: predAwayAskDepth,
                homeAskDepth: predAwayBidDepth,
                // 多档原始 levels (PP yield 新公式专用)
                awayBidLevels: predictBook.bids.slice(0, 3),
                awayAskLevels: predictBook.asks.slice(0, 3),
            },
            polymarket: {
                // Polymarket 直接使用两个独立订单簿的数据
                awayBid: polyAwayBid,
                awayAsk: polyAwayAsk,
                awayBidDepth: polyAwayBidDepth,
                awayAskDepth: polyAwayAskDepth,
                homeBid: polyHomeBid,
                homeAsk: polyHomeAsk,
                homeBidDepth: polyHomeBidDepth,
                homeAskDepth: polyHomeAskDepth,
            },
        };
    }

    /**
     * 获取 Polymarket 订单簿 (体育市场使用 REST API)
     */
    private async getPolyOrderBook(tokenId: string): Promise<{ bids: [number, number][]; asks: [number, number][] } | null> {
        const restStart = Date.now();
        try {
            const book = await this.polyClient.getOrderBook(tokenId);
            // 记录 REST 延迟
            this.polyRestLatencySum += Date.now() - restStart;
            this.polyRestLatencyCount++;

            if (book && book.bids && book.asks) {
                // 解析 REST 响应格式
                const bids = book.bids
                    .map((level: any) => [parseFloat(level.price), parseFloat(level.size)] as [number, number])
                    .filter(([price, size]: [number, number]) => size > 0)
                    .sort((a: [number, number], b: [number, number]) => b[0] - a[0]);
                const asks = book.asks
                    .map((level: any) => [parseFloat(level.price), parseFloat(level.size)] as [number, number])
                    .filter(([price, size]: [number, number]) => size > 0)
                    .sort((a: [number, number], b: [number, number]) => a[0] - b[0]);

                if (bids.length > 0 || asks.length > 0) {
                    return { bids, asks };
                }
            }
        } catch {
            // REST 失败，静默忽略
        }
        return null;
    }

    private buildSportsMarket(match: InternalMatchedMarket, orderbook: SportsOrderBook): SportsMatchedMarket {
        const { predictMarket, polyMarket } = match;

        // 解析队伍名称
        let awayTeam: string;
        let homeTeam: string;

        // 尝试解析 NBA 市场 (使用缩写->球队名映射)
        const nbaParsed = this.parsePredictNbaSlug(match.predictCategorySlug);
        if (nbaParsed) {
            awayTeam = NBA_ABBR_TO_TEAM[nbaParsed.away] || nbaParsed.away.toUpperCase();
            homeTeam = NBA_ABBR_TO_TEAM[nbaParsed.home] || nbaParsed.home.toUpperCase();
        } else {
            // 非 NBA 市场: 多级回退提取球队名
            // Predict outcomes 通常是 "Yes"/"No"，不含球队信息
            // 足球 (EPL) Polymarket 三方市场拆成独立二元市场 ("Will X win?")，outcomes 也是 ["Yes","No"]
            let polyOutcomes: string[] = [];
            try {
                polyOutcomes = JSON.parse(polyMarket.outcomes || '[]') as string[];
            } catch { /* ignore */ }

            const predictOutcomes = predictMarket.outcomes || [];
            const predictName0 = predictOutcomes[0]?.name || '';
            const predictName1 = predictOutcomes[1]?.name || '';

            // 辅助: 判断 outcome 名称是否有意义 (不是 "Yes"/"No")
            const isGenericOutcome = (name: string) => {
                const lower = name.toLowerCase();
                return lower === 'yes' || lower === 'no';
            };

            const polyOutcomesUseful = polyOutcomes.length >= 2
                && !isGenericOutcome(polyOutcomes[0])
                && !isGenericOutcome(polyOutcomes[1]);
            const predictNamesUseful = predictName0 && predictName1
                && !isGenericOutcome(predictName0)
                && !isGenericOutcome(predictName1);

            if (polyOutcomesUseful) {
                // Polymarket outcomes 有实际球队名 (如 ["Spirit", "FaZe"])
                awayTeam = polyOutcomes[0];
                homeTeam = polyOutcomes[1];
            } else if (predictNamesUseful) {
                awayTeam = predictName0;
                homeTeam = predictName1;
            } else {
                // Polymarket outcomes 是 "Yes"/"No" (如足球三方市场拆分)
                // 尝试从 groupItemTitle、question、Predict title、categorySlug 提取球队名
                const extracted = this.extractTeamNamesFromContext(
                    polyMarket,
                    match.predictTitle,
                    match.predictCategorySlug
                );
                awayTeam = extracted.away;
                homeTeam = extracted.home;
            }
        }

        // 解析 token IDs
        let clobTokenIds: string[];
        try {
            clobTokenIds = JSON.parse(polyMarket.clobTokenIds || '[]') as string[];
        } catch {
            clobTokenIds = [];
        }
        const awayTokenId = clobTokenIds[0] || '';
        const homeTokenId = clobTokenIds[1] || '';

        // 市场配置
        const feeRateBps = predictMarket.feeRateBps || 200;
        const tickSize = predictMarket.tickSize || 0.01;
        let negRisk = polyMarket.neg_risk === true;
        // 多选市场 negRisk 强制校正
        // 1. outcomes > 2 的市场在 Polymarket 上必须是 negRisk
        let outcomes: string[] = [];
        try { outcomes = JSON.parse(polyMarket.outcomes || '[]'); } catch {}
        if (outcomes.length > 2 && !negRisk) {
            console.warn(`[SportsService] negRisk forced to true: ${polyMarket.conditionId} has ${outcomes.length} outcomes but neg_risk=${polyMarket.neg_risk}`);
            negRisk = true;
        }
        // 2. 足球三方事件的子市场 outcomes=["Yes","No"] (长度2) 不触发上面的校正，
        //    但它们属于 negRisk 多选事件，必须使用 NEG_RISK_CTF_EXCHANGE 签名
        //    电竞三市场盘 (Dota Match+G1+G2) 也是 isThreeWayEvent=true 但 isNegRisk=false，
        //    用 Predict 端 isNegRisk 作权威避免误强制
        if (match.isThreeWayEvent && !negRisk && predictMarket.isNegRisk === true) {
            negRisk = true;
        }

        // 计算 4 个套利机会 (MT=Predict挂单, TT=Polymarket挂单)
        const awayMT = this.calculateOpportunity('away', 'PREDICT_MAKER', orderbook, feeRateBps);
        const awayTT = this.calculateOpportunity('away', 'POLY_MAKER', orderbook, feeRateBps);
        const homeMT = this.calculateOpportunity('home', 'PREDICT_MAKER', orderbook, feeRateBps);
        const homeTT = this.calculateOpportunity('home', 'POLY_MAKER', orderbook, feeRateBps);

        // 一致性校验 (互斥性约束)
        const consistency = this.checkConsistency(awayMT, awayTT, homeMT, homeTT);

        // 找出最佳机会
        const allOpps = [awayMT, awayTT, homeMT, homeTT].filter(o => o.isValid);
        const bestOpp = allOpps.length > 0
            ? allOpps.reduce((best, curr) =>
                curr.profitPercent > best.profitPercent ? curr : best
            )
            : undefined;

        // 检测体育类型 (NBA 使用 slug 格式检测)
        const sport = this.detectSport(match.predictCategorySlug, polyMarket.slug, nbaParsed !== null);

        // NBA 双市场 ID 设置
        // - NBA: predictAwayMarketId = 客队市场, predictHomeMarketId = 主队市场
        // - 其他: 两个 ID 相同 (单市场结构)
        const predictAwayMarketId = match.isNbaMultiMarket && match.predictAwayMarket
            ? match.predictAwayMarket.id
            : match.predictId;
        const predictHomeMarketId = match.isNbaMultiMarket && match.predictHomeMarket
            ? match.predictHomeMarket.id
            : match.predictId;

        // Boost: check main/away/home market ids
        const boostMain = isMarketBoosted(match.predictId);
        const boostAway = predictAwayMarketId !== match.predictId ? isMarketBoosted(predictAwayMarketId) : { boosted: false };
        const boostHome = predictHomeMarketId !== match.predictId ? isMarketBoosted(predictHomeMarketId) : { boosted: false };
        const isBoosted = boostMain.boosted || boostAway.boosted || boostHome.boosted;
        const boostSource = boostMain.boosted ? boostMain : (boostAway.boosted ? boostAway : (boostHome.boosted ? boostHome : undefined));
        const boostStart = boostSource?.boostStartTime;
        const boostEnd = boostSource?.boostEndTime;

        // PP 奖励档位: 优先取 main，再 away，再 home (NBA 双市场两侧通常一致)
        const rewardMain = getMarketRewardInfo(match.predictId);
        const rewardAway = predictAwayMarketId !== match.predictId ? getMarketRewardInfo(predictAwayMarketId) : null;
        const rewardHome = predictHomeMarketId !== match.predictId ? getMarketRewardInfo(predictHomeMarketId) : null;
        const reward = rewardMain ?? rewardAway ?? rewardHome ?? null;

        // 查找 Predict slug
        // 对于体育市场，优先使用 categorySlug (如果是有效的 slug 格式)
        let predictSlug: string | undefined;
        const catSlug = match.predictCategorySlug;

        // 1. 对于非 NBA 市场 (LoL 等)，categorySlug 本身就是有效的 URL slug
        //    例如: "lol-lgd-up-2026-01-15" -> predict.fun/market/lol-lgd-up-2026-01-15
        if (catSlug && catSlug.includes('-') && !catSlug.includes('-at-')) {
            predictSlug = catSlug;
        }

        // 2. 对于 NBA 市场 (categorySlug 是 "X-at-Y" 格式)
        //    尝试从 browser-slugs.json 查找 "City at City" 格式
        if (!predictSlug && catSlug?.includes('-at-')) {
            const cityFormat = this.formatCategorySlugAsTitle(catSlug);
            if (cityFormat) {
                predictSlug = getPredictSlugByTitle(cityFormat);
            }
        }

        // 3. 回退到市场 ID 缓存查找 (排除通用的 "match-winner")
        if (!predictSlug) {
            const cached = getPredictSlug(match.predictId);
            if (cached && cached !== 'match-winner') {
                predictSlug = cached;
            }
        }

        return {
            predictMarketId: match.predictId,  // 主 ID (客队市场 ID)
            predictTitle: match.predictTitle,
            predictCategorySlug: match.predictCategorySlug,
            predictSlug,
            polymarketConditionId: match.polymarketConditionId,
            polymarketQuestion: match.polymarketQuestion,
            polymarketSlug: match.polymarketSlug,
            eventKey: match.eventKey || match.predictCategorySlug,
            eventTitle: match.eventTitle || polyMarket.events?.[0]?.title || match.predictTitle,
            isThreeWayEvent: match.isThreeWayEvent,
            selectionKind: match.selectionKind,
            selectionLabel: match.selectionLabel,
            selectionCanonical: match.selectionCanonical,

            // NBA 双市场 ID
            predictAwayMarketId,
            predictHomeMarketId,

            sport,
            homeTeam,
            awayTeam,
            gameDate: polyMarket.endDate,
            gameStartTime: polyMarket.gameStartTime,

            polymarketAwayTokenId: awayTokenId,
            polymarketHomeTokenId: homeTokenId,
            negRisk,
            tickSize,
            feeRateBps,

            orderbook,

            awayMT,
            awayTT,
            homeMT,
            homeTT,

            bestOpportunity: bestOpp ? {
                direction: bestOpp.direction,
                mode: bestOpp.mode,
                profitPercent: bestOpp.profitPercent,
            } : undefined,

            consistency,

            boosted: isBoosted || undefined,
            boostStartTime: boostStart,
            boostEndTime: boostEnd,

            // PP 奖励档位 (来自 graphql.predict.fun)
            pointsTier: reward?.tier,
            pointsHourlyRate: reward?.hourlyRate,
            pointsExpiresAt: reward?.expiresAt ?? undefined,
            pointsNextTier: reward?.nextTier,
            pointsNextHourlyRate: reward?.nextHourlyRate,
            pointsNextStartsAt: reward?.nextStartsAt,
            // 新公式：前 3 档加权累加 shares (1, 1/3, 1/9)，仅 |price-mid| ≤ spreadThreshold 内的档位计入
            //   pointsYield = hourlyRate / weightedShares    单位 PP/hr/share
            // 与 start-dashboard / src/trading/pp-yield.ts 共享同一实现
            pointsYield: computePointsYieldTuples(
                orderbook.predict.awayBidLevels ?? [],
                orderbook.predict.awayAskLevels ?? [],
                reward?.spreadThreshold,
                reward?.hourlyRate,
            ) ?? undefined,

            polymarketLiquidity: match.polymarketLiquidity,
            polymarketVolume: match.polymarketVolume || 0,
            predictVolume: match.predictVolume || 0,
            lastUpdated: Date.now(),
        };
    }

    private calculateOpportunity(
        direction: 'away' | 'home',
        mode: 'PREDICT_MAKER' | 'TAKER' | 'POLY_MAKER',
        orderbook: SportsOrderBook,
        feeRateBps: number
    ): SportsArbOpportunity {
        const pred = orderbook.predict;
        const poly = orderbook.polymarket;

        let predictPrice: number;
        let polyHedgePrice: number;
        let predictFee = 0;
        let predictDepth: number;
        let polyDepth: number;

        if (direction === 'away') {
            // PREDICT_MAKER/TAKER: 买客队 (Predict) + 买主队 (Poly)
            // POLY_MAKER: Poly 挂单买客队 + Predict 对冲买主队
            if (mode === 'PREDICT_MAKER') {
                // P. 模式: Predict 挂单(bid) + Poly 吃单(ask)
                predictPrice = pred.awayBid;
                polyHedgePrice = poly.homeAsk;
                predictDepth = pred.awayBidDepth;
                polyDepth = poly.homeAskDepth;
            } else if (mode === 'POLY_MAKER') {
                // M. 模式: Poly 挂单买客队(bid) + Predict 对冲买主队(ask)
                // direction 代表 Poly 挂单买哪个队
                // 公式: cost = predictAsk(home) + polyBid(away), 不含 fee
                predictPrice = pred.homeAsk;  // Predict 对冲买主队 (= 1 - pred.awayBid)
                polyHedgePrice = poly.awayBid;  // Poly 挂单买客队 BID
                // 深度: Predict 对冲端(home ask) + Poly 挂单端(away bid)
                predictDepth = pred.awayBidDepth;   // home ask depth = away bid depth
                polyDepth = poly.awayBidDepth;
            } else {
                // TAKER: Predict 吃单(ask) + Poly 吃单(ask)
                predictPrice = pred.awayAsk;
                polyHedgePrice = poly.homeAsk;
                predictFee = calculatePredictFee(predictPrice, feeRateBps);
                predictDepth = pred.awayAskDepth;
                polyDepth = poly.homeAskDepth;
            }
        } else {
            // PREDICT_MAKER/TAKER: 买主队 (Predict) + 买客队 (Poly)
            // POLY_MAKER: Poly 挂单买主队 + Predict 对冲买客队
            if (mode === 'PREDICT_MAKER') {
                // P. 模式: Predict 挂单(bid) + Poly 吃单(ask)
                predictPrice = pred.homeBid;  // = 1 - pred.awayAsk
                polyHedgePrice = poly.awayAsk;
                predictDepth = pred.awayAskDepth;  // 主队 bid 深度 = 客队 ask 深度
                polyDepth = poly.awayAskDepth;
            } else if (mode === 'POLY_MAKER') {
                // M. 模式: Poly 挂单买主队(bid) + Predict 对冲买客队(ask)
                // direction 代表 Poly 挂单买哪个队
                // 公式: cost = predictAsk(away) + polyBid(home), 不含 fee
                predictPrice = pred.awayAsk;  // Predict 对冲买客队
                polyHedgePrice = poly.homeBid;  // Poly 挂单买主队 BID
                // 深度: Predict 对冲端(away ask) + Poly 挂单端(home bid)
                predictDepth = pred.homeAskDepth;   // away ask depth = home bid depth... 不对
                polyDepth = poly.homeBidDepth;
            } else {
                // TAKER: Predict 吃单(ask) + Poly 吃单(ask)
                predictPrice = pred.homeAsk;  // = 1 - pred.awayBid
                polyHedgePrice = poly.awayAsk;
                predictFee = calculatePredictFee(predictPrice, feeRateBps);
                predictDepth = pred.awayBidDepth;  // 主队 ask 深度 = 客队 bid 深度
                polyDepth = poly.awayAskDepth;
            }
        }

        // 使用固定精度计算避免浮点误差 (保留4位小数)
        const cost = Number((predictPrice + polyHedgePrice + predictFee).toFixed(4));
        const profit = Number((1 - cost).toFixed(4));
        const profitPercent = profit * 100;
        // P. 模式 profit >= 0 即有效 (有积分奖励)
        // M. 模式 profit >= 0 即有效 (Poly 挂单 + Predict 吃单)
        // T-T 模式需要 profit > 0
        const EPSILON = 0.0001;
        const isValid = (mode === 'PREDICT_MAKER' || mode === 'POLY_MAKER') ? profit >= -EPSILON : profit > EPSILON;

        // 最大数量: Maker 模式看对冲端深度，其他取两边较小值
        const maxQuantity = (mode === 'PREDICT_MAKER')
            ? polyDepth  // P. 模式只看 Poly 对冲端深度
            : (mode === 'POLY_MAKER')
                ? predictDepth  // M. 模式只看 Predict 对冲端深度
                : Math.min(predictDepth, polyDepth);  // Taker 模式取两边较小值

        return {
            direction,
            mode,
            cost,
            profit,
            profitPercent,
            predictPrice,
            polyHedgePrice,
            predictFee,
            maxQuantity,
            predictDepth,
            polyDepth,
            isValid,
        };
    }

    private checkConsistency(
        awayMT: SportsArbOpportunity,
        awayTT: SportsArbOpportunity,
        homeMT: SportsArbOpportunity,
        homeTT: SportsArbOpportunity
    ): SportsMatchedMarket['consistency'] {
        // 检查同模式下两个方向的成本之和是否 < 1
        // 体育市场互斥性: Away 赢 + Home 赢 = 100%，所以 cost_away + cost_home 应该 >= 1
        // 只有当 cost_away + cost_home < 1 (严格小于) 时，才是真正的"两边都有利润"异常
        // 允许 cost_away + cost_home = 1 (sum <= 1 是正常的)
        const mtSumCost = awayMT.cost + homeMT.cost;
        const ttSumCost = awayTT.cost + homeTT.cost;

        // 只有当成本之和严格小于 1 - ε 时才视为异常
        const mtBothProfitable = mtSumCost < (1 - CONSISTENCY_EPSILON);
        const ttBothProfitable = ttSumCost < (1 - CONSISTENCY_EPSILON);

        const bothDirectionsProfitable = mtBothProfitable || ttBothProfitable;

        let warning: string | undefined;
        if (bothDirectionsProfitable) {
            warning = `Both directions appear profitable (MT sum: ${mtSumCost.toFixed(4)}, TT sum: ${ttSumCost.toFixed(4)}) - possible data anomaly or mapping error`;
        }

        return {
            isValid: !bothDirectionsProfitable,
            bothDirectionsProfitable,
            warning,
        };
    }

    /**
     * 把 categorySlug "cleveland-at-philadelphia" 转换为 "Cleveland at Philadelphia"
     * 用于匹配 browser-slugs.json 中的 NBA/NHL 标题格式
     */
    private formatCategorySlugAsTitle(slug: string): string | null {
        const atIndex = slug.indexOf('-at-');
        if (atIndex === -1) return null;

        // 提取客队城市和主队城市
        const awayCity = slug.substring(0, atIndex)
            .split('-')
            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
        const homeCity = slug.substring(atIndex + 4)  // skip '-at-'
            .split('-')
            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');

        return `${awayCity} at ${homeCity}`;
    }

    /**
     * 从 categorySlug 解析队伍名称
     * 支持格式: "sport-team1-team2-YYYY-MM-DD" (如 "lol-lgd-up-2026-01-15", "cs2-spirit-faze-2026-01-15")
     * 和 "team1-vs-team2" / "team1-team2-YYYY-MM-DD" 等变体
     */
    /**
     * 从多个上下文字段提取球队名（用于 outcomes 是 "Yes"/"No" 的场景）
     *
     * 足球等三方市场: Polymarket 拆成独立二元市场 ("Will X win?")，outcomes=["Yes","No"]
     * 需要从 groupItemTitle、question、title、slug 等字段还原球队信息
     */
    /**
     * 从多个上下文字段提取球队名（用于 outcomes 是 "Yes"/"No" 的场景）
     *
     * 典型场景: 足球三方市场 (Polymarket 拆成 "Will X win?" 独立市场)
     * 数据来源优先级:
     *   1. Polymarket events[0].title ("Team A vs. Team B")
     *   2. Predict title 中的 "vs"/"@" 格式
     *   3. Polymarket question 中的 "vs" 格式
     *   4. categorySlug 解析 (缩写回退)
     *   5. predictTitle 作为单球队名
     */
    private extractTeamNamesFromContext(
        polyMarket: PolyMarket,
        predictTitle: string,
        categorySlug: string
    ): { away: string; home: string } {
        // 1. Polymarket events[0].title (最可靠，如 "Manchester United FC vs. Tottenham Hotspur FC")
        const eventTitle = polyMarket.events?.[0]?.title;
        if (eventTitle) {
            const vsFromEvent = this.parseTeamsFromVsFormat(eventTitle);
            if (vsFromEvent) return vsFromEvent;
        }

        // 2. Predict title 中的 "vs"/"@" 格式
        const vsFromTitle = this.parseTeamsFromVsFormat(predictTitle);
        if (vsFromTitle) return vsFromTitle;

        // 3. Polymarket question 中的 "vs" 格式
        //    如: "Will Manchester United FC vs. Tottenham Hotspur FC end in a draw?"
        const vsFromQuestion = this.parseTeamsFromVsFormat(polyMarket.question);
        if (vsFromQuestion) return vsFromQuestion;

        // 4. categorySlug 解析 (如 "epl-tot-mun-2026-02-07")
        const slugTeams = this.parseTeamsFromSlug(categorySlug);
        if (slugTeams) return slugTeams;

        // 5. predictTitle 作为单球队名 (如 "Manchester United")
        //    跳过 "Draw"、"Match Winner" 等通用标题
        const genericTitles = ['draw', 'match winner', 'yes', 'no'];
        if (predictTitle && !genericTitles.includes(predictTitle.toLowerCase())) {
            // groupItemTitle 可能有更完整的名字
            const groupTitle = polyMarket.groupItemTitle;
            if (groupTitle && !groupTitle.toLowerCase().startsWith('draw')) {
                return { away: groupTitle, home: predictTitle };
            }
            return { away: predictTitle, home: '' };
        }

        // 6. groupItemTitle 回退
        const groupTitle = polyMarket.groupItemTitle;
        if (groupTitle && !groupTitle.toLowerCase().startsWith('draw')) {
            return { away: groupTitle, home: '' };
        }

        return { away: predictTitle || 'Team 1', home: 'Team 2' };
    }

    /**
     * 从 "Team A vs Team B" / "Team A vs. Team B" / "Team A @ Team B" 格式解析球队名
     */
    private parseTeamsFromVsFormat(text: string): { away: string; home: string } | null {
        if (!text) return null;
        // "X vs Y", "X vs. Y", "X @ Y" — 贪婪匹配到行尾再清理
        const match = text.match(/^(.+?)\s+(?:vs\.?|@)\s+(.+)$/i);
        if (match && match[1] && match[2]) {
            const away = match[1].trim();
            // 清理 home 部分的尾部噪音 (日期、问号、"end in a draw" 等)
            let home = match[2]
                .replace(/\s+end\s+in\s+a\s+draw.*$/i, '')
                .replace(/\s+on\s+\d{4}.*$/i, '')
                .replace(/\?$/, '')
                .trim();
            if (away && home) return { away, home };
        }
        return null;
    }

    private parseTeamsFromSlug(slug: string): { away: string; home: string } | null {
        if (!slug) return null;

        // 格式 1: "X-at-Y" (NBA 城市格式，由 formatCategorySlugAsTitle 处理)
        // 这里不处理，由 nbaParsed 分支覆盖

        // 格式 2: "sport-team1-team2-YYYY-MM-DD"
        // 先移除尾部日期
        const dateStripped = slug.replace(/-\d{4}-\d{2}-\d{2}$/, '');
        if (!dateStripped || dateStripped === slug.replace(/-/g, '')) return null;

        // 尝试分割: 第一段可能是体育类型前缀
        const parts = dateStripped.split('-');
        if (parts.length < 2) return null;

        // 已知的体育类型前缀
        const sportPrefixes = ['nba', 'nfl', 'nhl', 'mlb', 'epl', 'mma', 'lol', 'dota', 'dota2', 'cs', 'cs2', 'csgo', 'ufc', 'soccer'];
        const firstPart = parts[0].toLowerCase();

        let teamParts: string[];
        if (sportPrefixes.includes(firstPart)) {
            // 第一段是体育类型，剩余是队伍
            teamParts = parts.slice(1);
        } else {
            teamParts = parts;
        }

        if (teamParts.length < 2) return null;

        // 过滤 "vs" 连接词
        const filtered = teamParts.filter(p => p.toLowerCase() !== 'vs');
        if (filtered.length < 2) return null;

        // 简单二分: 前半=away, 后半=home
        const mid = Math.ceil(filtered.length / 2);
        const away = filtered.slice(0, mid).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        const home = filtered.slice(mid).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

        return { away, home };
    }

    /**
     * 仅保留对阵盘：优先使用 Polymarket events[0].title 判定是否包含 "vs"/"@"
     * events 缺失时 fallback 到 question（Method D 走 CLOB API 时 events 字段为空）
     */
    private isVsHeadToHead(polyMarket: PolyMarket): boolean {
        const eventTitle = (polyMarket.events?.[0]?.title || '').trim();
        const text = eventTitle || (polyMarket.question || '').trim();
        if (!text) return false;
        return /\bvs\.?\s+/i.test(text) || /\s@\s/.test(text);
    }

    /**
     * 构建事件级元信息（供前端三项盘分组）
     */
    private buildEventSelectionMeta(
        predictMarket: any,
        polyMarket: PolyMarket,
        slugGroupMeta: Map<string, SlugGroupMeta>
    ): Pick<InternalMatchedMarket, 'eventKey' | 'eventTitle' | 'isThreeWayEvent' | 'selectionKind' | 'selectionLabel' | 'selectionCanonical'> {
        const categorySlug = String(predictMarket?.categorySlug || '').trim();
        const groupMeta = slugGroupMeta.get(categorySlug);
        const isFootballThreeWay = !!groupMeta && groupMeta.count === 3 && groupMeta.hasDraw;
        const isEsportsThreeWay = !!groupMeta
            && groupMeta.count === 3
            && groupMeta.hasMatchWinner
            && groupMeta.hasGame1
            && groupMeta.hasGame2;
        const isThreeWayEvent = isFootballThreeWay || isEsportsThreeWay;

        const primaryEventTitle = String(polyMarket.events?.[0]?.title || '').trim();
        const eventTitle = primaryEventTitle || String(polyMarket.question || '').trim() || String(predictMarket?.title || '').trim();
        const eventKey = categorySlug || String(polyMarket.events?.[0]?.slug || '').trim() || polyMarket.conditionId || polyMarket.id;

        const rawTitle = String(predictMarket?.title || '').trim();
        const rawTitleLower = rawTitle.toLowerCase();
        const groupItemTitle = String(polyMarket.groupItemTitle || '').trim();
        const genericTitleSet = new Set(['yes', 'no', 'match winner']);

        let selectionLabel = rawTitle;
        if (!selectionLabel || genericTitleSet.has(selectionLabel.toLowerCase())) {
            selectionLabel = groupItemTitle || selectionLabel || 'Unknown';
        }

        let selectionKind: SportsSelectionKind = 'unknown';

        if (isEsportsThreeWay) {
            // 电竞三市场：根据 Predict market.title 区分 Match / Game 1 / Game 2
            if (rawTitleLower === 'match winner') selectionKind = 'match';
            else if (rawTitleLower === 'game 1 winner') selectionKind = 'game1';
            else if (rawTitleLower === 'game 2 winner') selectionKind = 'game2';
        } else {
            const drawHintText = `${selectionLabel} ${predictMarket?.question || ''} ${polyMarket.question || ''} ${groupItemTitle}`.toLowerCase();
            if (/\bdraw\b/i.test(drawHintText)) {
                selectionKind = 'draw';
            } else if (isFootballThreeWay) {
                const parsedTeams =
                    this.parseTeamsFromVsFormat(primaryEventTitle)
                    || this.parseTeamsFromVsFormat(String(polyMarket.question || ''))
                    || this.parseTeamsFromSlug(categorySlug);

                if (parsedTeams) {
                    if (isSameTeam(selectionLabel, parsedTeams.away) || (groupItemTitle && isSameTeam(groupItemTitle, parsedTeams.away))) {
                        selectionKind = 'teamA';
                    } else if (isSameTeam(selectionLabel, parsedTeams.home) || (groupItemTitle && isSameTeam(groupItemTitle, parsedTeams.home))) {
                        selectionKind = 'teamB';
                    }
                }
            }
        }

        const canonicalBase = selectionKind === 'draw'
            ? 'draw'
            : (selectionKind === 'match' || selectionKind === 'game1' || selectionKind === 'game2'
                ? selectionKind
                : toCanonicalTeam(selectionLabel || groupItemTitle));

        return {
            eventKey: eventKey || categorySlug,
            eventTitle,
            isThreeWayEvent,
            selectionKind,
            selectionLabel,
            selectionCanonical: canonicalBase || undefined,
        };
    }

    private detectSport(categorySlug: string, polySlug: string, isNbaBySlug: boolean = false): SportType {
        // 如果通过 slug 格式解析已确认是 NBA，直接返回
        if (isNbaBySlug) return 'nba';

        const slug = (categorySlug + ' ' + polySlug).toLowerCase();

        // 优先识别足球联赛，避免 "la-liga" 被 "league" 误判为 lol
        if (
            slug.includes('epl')
            || slug.includes('soccer')
            || slug.includes('premier')
            || slug.includes('la-liga')
            || slug.includes('lal-')
            || slug.includes('serie-a')
            || slug.includes('bundesliga')
            || slug.includes('ligue-1')
            || slug.includes('laliga')
        ) {
            return 'epl';
        }

        if (slug.includes('nba') || slug.includes('basketball')) return 'nba';
        if (slug.includes('nfl') || slug.includes('football')) return 'nfl';
        if (slug.includes('nhl') || slug.includes('hockey')) return 'nhl';
        if (slug.includes('mlb') || slug.includes('baseball')) return 'mlb';
        if (slug.includes('mma') || slug.includes('ufc')) return 'mma';
        if (slug.includes('lol') || slug.includes('league')) return 'lol';
        if (slug.includes('dota')) return 'dota';
        if (slug.includes('cs2') || slug.includes('csgo') || slug.includes('counter-strike')) return 'cs';

        return 'nba';  // 默认
    }

    /**
     * 获取 Polymarket 订单簿缓存 (供价格守护同步 0.1s 轮询数据)
     */
    getPolyOrderbookFromCache(tokenId: string): { bids: [number, number][]; asks: [number, number][] } | null {
        return this.polyOrderbookCache.get(tokenId) ?? null;
    }

    // ========================================================================
    // Polymarket 幽灵深度检测
    // ========================================================================

    /**
     * 逐 token 对比 best ask/bid 深度变化，检测幽灵流动性
     */
    private detectPhantomDepth(books: OrderBookSummary[]): void {
        const now = Date.now();
        for (const book of books) {
            if (!book || !book.asset_id) continue;
            const tokenId = book.asset_id;

            let tracker = this.phantomTrackers.get(tokenId);
            if (!tracker) {
                // 首个快照：初始化 tracker，不检测
                const bestAskSize = book.asks.length > 0 ? parseFloat(book.asks[0].size) : 0;
                const bestBidSize = book.bids.length > 0 ? parseFloat(book.bids[0].size) : 0;
                this.phantomTrackers.set(tokenId, {
                    prevBestAskSize: bestAskSize,
                    prevBestBidSize: bestBidSize,
                    askFlipCount: 0,
                    bidFlipCount: 0,
                    askWindowStart: now,
                    bidWindowStart: now,
                    askPhantom: false,
                    bidPhantom: false,
                    lastAskFlipTime: 0,
                    lastBidFlipTime: 0,
                });
                continue;
            }

            // 取当前 best ask/bid size
            const currentAskSize = book.asks.length > 0 ? parseFloat(book.asks[0].size) : 0;
            const currentBidSize = book.bids.length > 0 ? parseFloat(book.bids[0].size) : 0;

            // 对 ask 和 bid 分别检测
            this.updatePhantomSide(tracker, 'ask', currentAskSize, tracker.prevBestAskSize, now, tokenId);
            this.updatePhantomSide(tracker, 'bid', currentBidSize, tracker.prevBestBidSize, now, tokenId);

            // 更新 prev
            tracker.prevBestAskSize = currentAskSize;
            tracker.prevBestBidSize = currentBidSize;
        }
    }

    /**
     * 单侧幽灵深度翻转检测
     */
    private updatePhantomSide(
        tracker: PhantomTracker,
        side: 'ask' | 'bid',
        currentSize: number,
        prevSize: number,
        now: number,
        tokenId: string,
    ): void {
        const flipCountKey = side === 'ask' ? 'askFlipCount' : 'bidFlipCount';
        const phantomKey = side === 'ask' ? 'askPhantom' : 'bidPhantom';
        const lastFlipKey = side === 'ask' ? 'lastAskFlipTime' : 'lastBidFlipTime';
        const windowStartKey = side === 'ask' ? 'askWindowStart' : 'bidWindowStart';

        // 1. phantom 恢复检测 (最高优先级，不受窗口过期阻断)
        if (tracker[phantomKey] && tracker[lastFlipKey] > 0 && (now - tracker[lastFlipKey] > PHANTOM_RECOVERY_MS)) {
            tracker[phantomKey] = false;
            tracker[flipCountKey] = 0;
            tracker[windowStartKey] = now;
            return;
        }

        // 2. 窗口过期 → 重置
        if (now - tracker[windowStartKey] > PHANTOM_WINDOW_MS) {
            tracker[flipCountKey] = 0;
            tracker[windowStartKey] = now;
            return;
        }

        // 3. 翻转检测
        const had = prevSize > PHANTOM_DUST_SIZE;
        const has = currentSize > PHANTOM_DUST_SIZE;
        const isFlip = (had !== has) || (had && has && currentSize / prevSize < PHANTOM_SIZE_DROP_RATIO);

        if (isFlip) {
            tracker[flipCountKey]++;
            tracker[lastFlipKey] = now;
        }

        // 4. 达到阈值 → 标记 phantom
        if (tracker[flipCountKey] >= PHANTOM_FLIP_THRESHOLD && !tracker[phantomKey]) {
            tracker[phantomKey] = true;
            tracker[lastFlipKey] = now;
            console.warn(`[Sports][PhantomDetect] token=${tokenId} side=${side} 检测到幽灵深度 (${tracker[flipCountKey]} flips in window)`);
        }
    }

    /**
     * 查询某 token 某侧是否为幽灵深度
     * BUY 方向吃 ask 侧 → askPhantom, SELL 方向吃 bid 侧 → bidPhantom
     */
    isTokenPhantom(tokenId: string, side: 'BUY' | 'SELL'): boolean {
        const tracker = this.phantomTrackers.get(tokenId);
        if (!tracker) return false;
        return side === 'BUY' ? tracker.askPhantom : tracker.bidPhantom;
    }

    /**
     * IOC 成交反馈: 强制标记某侧为幽灵深度
     */
    reportPhantomFromIOC(tokenId: string, side: 'BUY' | 'SELL'): void {
        const now = Date.now();
        let tracker = this.phantomTrackers.get(tokenId);
        if (!tracker) {
            tracker = {
                prevBestAskSize: 0,
                prevBestBidSize: 0,
                askFlipCount: 0,
                bidFlipCount: 0,
                askWindowStart: now,
                bidWindowStart: now,
                askPhantom: false,
                bidPhantom: false,
                lastAskFlipTime: 0,
                lastBidFlipTime: 0,
            };
            this.phantomTrackers.set(tokenId, tracker);
        }
        if (side === 'BUY') {
            tracker.askPhantom = true;
            tracker.lastAskFlipTime = now;
        } else {
            tracker.bidPhantom = true;
            tracker.lastBidFlipTime = now;
        }
        console.warn(`[Sports][PhantomIOC] token=${tokenId} side=${side} IOC 反馈强制标记幽灵深度`);
    }
}

// ============================================================================
// Singleton Export
// ============================================================================

let sportsServiceInstance: SportsService | null = null;

export function getSportsService(): SportsService {
    if (!sportsServiceInstance) {
        sportsServiceInstance = new SportsService();
    }
    return sportsServiceInstance;
}
