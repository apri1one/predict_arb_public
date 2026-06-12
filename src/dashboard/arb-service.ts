import { ServerResponse } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ArbOpportunity, SystemStats, MarketInfo, AccountBalance, CloseOpportunity } from './types.js';
import { calculateDepth, type DepthResult } from '../trading/depth-calculator.js';
import { PolymarketWebSocketClient } from '../polymarket/ws-client.js';
import { getPredictOrderbookCache } from '../services/predict-orderbook-cache.js';
import { calculateCloseOpportunities } from './hedge-mode/index.js';
import { getAccountData } from './account-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PREDICT_ORDERBOOK_MODE = (process.env.DASHBOARD_PREDICT_ORDERBOOK_MODE || 'ws').toLowerCase();
const PREDICT_WS_ONLY = DASHBOARD_PREDICT_ORDERBOOK_MODE === 'ws';

// ============================================================================
// 类型定义
// ============================================================================

interface CachedMarketMatch {
    predict: {
        id: number;
        title: string;
        question: string;
        conditionId: string;
        feeRateBps?: number;  // 从 API 获取的费率
    };
    polymarket: {
        question: string;
        conditionId: string;
        active: boolean;
        closed: boolean;
        acceptingOrders: boolean;
    };
    inverted?: boolean;
    invertedReason?: string;
}

interface MarketData {
    predictMarket: {
        id: number;
        title: string;
        status: string;
        polymarketConditionIds: string[];
        feeRateBps: number;
    };
    polyMarket: {
        question: string;
        conditionId: string;
        volume?: number;
    } | null;
    polyYesTokenId: string | null;
    isInverted: boolean;
    isSettled: boolean;
    depth: DepthResult | null;
    lastUpdate: number;
    error: string | null;
    predictVolume?: number;
    polyVolume?: number;
}

// ============================================================================
// API Key 管理 - 优先使用扫描专用 Key
// ============================================================================

function getScanApiKeys(): string[] {
    const keys: string[] = [];

    // 优先使用扫描专用 Key: PREDICT_API_KEY_SCAN, PREDICT_API_KEY_SCAN_2, ...
    if (process.env.PREDICT_API_KEY_SCAN) keys.push(process.env.PREDICT_API_KEY_SCAN);
    if (process.env.PREDICT_API_KEY_SCAN_2) keys.push(process.env.PREDICT_API_KEY_SCAN_2);
    if (process.env.PREDICT_API_KEY_SCAN_3) keys.push(process.env.PREDICT_API_KEY_SCAN_3);
    if (process.env.PREDICT_API_KEY_SCAN_4) keys.push(process.env.PREDICT_API_KEY_SCAN_4);

    // 如果没有扫描专用 Key，回退到主 Key (最后手段)
    if (keys.length === 0) {
        if (process.env.PREDICT_API_KEY) keys.push(process.env.PREDICT_API_KEY);
    }

    return keys;
}

// ============================================================================
// ArbScannerService
// ============================================================================

export class ArbScannerService {
    private sseClients: Set<ServerResponse> = new Set();
    private opportunities: ArbOpportunity[] = [];
    private closeOpportunities: CloseOpportunity[] = [];
    private markets: MarketInfo[] = [];
    private marketDataList: MarketData[] = [];
    private polyWsClient: PolymarketWebSocketClient | null = null;
    private apiKeys: string[] = [];
    private currentKeyIndex = 0;
    private updateInterval: NodeJS.Timeout | null = null;
    private accountUpdateInterval: NodeJS.Timeout | null = null;  // 账户数据刷新定时器
    private isRunning = false;
    private isUpdating = false;  // 防止并发重入
    private isUpdatingAccounts = false;  // 账户更新锁

    private stats: SystemStats = {
        latency: { predict: 0, polymarket: 0 },
        connectionStatus: { polymarketWs: 'disconnected', predictApi: 'ok' },
        lastFullUpdate: new Date().toISOString(),
        marketsMonitored: 0,
        refreshInterval: 3000,
        arbStats: {
            makerCount: 0,
            takerCount: 0,
            avgProfit: 0,
            maxProfit: 0,
            totalDepth: 0
        },
        dataVersion: 0
    };

    private predictAccount: AccountBalance = {
        total: 0,
        available: 0,
        portfolio: 0,
        positions: []
    };

    private polymarketAccount: AccountBalance = {
        total: 0,
        available: 0,
        portfolio: 0,
        positions: []
    };

    constructor() {
        this.apiKeys = getScanApiKeys();
        console.log(`🔑 [SCAN] 加载了 ${this.apiKeys.length} 个扫描用 API Key`);
    }

    private getNextApiKey(): string {
        if (this.apiKeys.length === 0) return '';
        const key = this.apiKeys[this.currentKeyIndex];
        this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
        return key;
    }

    // ========================================================================
    // SSE 客户端管理
    // ========================================================================

    public addClient(res: ServerResponse) {
        this.sseClients.add(res);
        // 立即发送当前状态
        this.sendEvent(res, 'opportunity', this.opportunities);
        this.sendEvent(res, 'stats', this.stats);
        this.sendEvent(res, 'accounts', {
            predict: this.predictAccount,
            polymarket: this.polymarketAccount
        });
    }

    public removeClient(res: ServerResponse) {
        this.sseClients.delete(res);
    }

    private broadcastToClients() {
        const oppsData = JSON.stringify(this.opportunities);
        const statsData = JSON.stringify(this.stats);
        const accountsData = JSON.stringify({
            predict: this.predictAccount,
            polymarket: this.polymarketAccount
        });
        const closeOppsData = JSON.stringify(this.closeOpportunities);

        for (const client of this.sseClients) {
            this.sendEvent(client, 'opportunity', oppsData, false);
            this.sendEvent(client, 'stats', statsData, false);
            this.sendEvent(client, 'accounts', accountsData, false);
            this.sendEvent(client, 'closeOpportunities', closeOppsData, false);
        }
    }

    private sendEvent(client: ServerResponse, event: string, data: any, stringify = true) {
        try {
            const payload = stringify ? JSON.stringify(data) : data;
            client.write(`event: ${event}\n`);
            client.write(`data: ${payload}\n\n`);
        } catch (e) {
            // Client might be disconnected
            this.sseClients.delete(client);
        }
    }

    // ========================================================================
    // 账户数据刷新
    // ========================================================================

    /**
     * 刷新账户余额和持仓数据
     * 独立于市场数据更新，使用更短的刷新间隔
     */
    private async refreshAccounts(): Promise<void> {
        if (this.isUpdatingAccounts) return;
        this.isUpdatingAccounts = true;

        try {
            const accountData = await getAccountData();

            // 更新 Predict 账户
            this.predictAccount = {
                total: accountData.predict.total,
                available: accountData.predict.available,
                portfolio: accountData.predict.portfolio,
                positions: accountData.predict.positions.map(p => ({
                    market: p.market,
                    side: (p.side.toUpperCase() === 'YES' || p.side.toUpperCase() === 'NO')
                        ? p.side.toUpperCase() as 'YES' | 'NO'
                        : 'YES',  // 默认 YES (多选项市场)
                    qty: p.qty,
                    avgPrice: p.avgPrice
                }))
            };

            // 更新 Polymarket 账户
            this.polymarketAccount = {
                total: accountData.polymarket.total,
                available: accountData.polymarket.available,
                portfolio: accountData.polymarket.portfolio,
                positions: accountData.polymarket.positions.map(p => ({
                    market: p.market,
                    side: (p.side.toUpperCase() === 'YES' || p.side.toUpperCase() === 'NO')
                        ? p.side.toUpperCase() as 'YES' | 'NO'
                        : 'YES',
                    qty: p.qty,
                    avgPrice: p.avgPrice
                }))
            };

            // 广播账户更新
            const accountsData = JSON.stringify({
                predict: this.predictAccount,
                polymarket: this.polymarketAccount
            });
            for (const client of this.sseClients) {
                this.sendEvent(client, 'accounts', accountsData, false);
            }
        } catch (e) {
            console.warn('[ArbService] 账户刷新失败:', (e as Error).message);
        } finally {
            this.isUpdatingAccounts = false;
        }
    }

    /**
     * 启动账户数据定期刷新
     * 默认每 5 秒刷新一次 (可通过环境变量 ACCOUNT_REFRESH_INTERVAL_MS 配置)
     */
    private startAccountRefresh(): void {
        const interval = Number(process.env.ACCOUNT_REFRESH_INTERVAL_MS) || 5000;
        console.log(`💰 账户刷新间隔: ${interval}ms`);

        // 立即执行一次
        this.refreshAccounts();

        // 定期刷新
        this.accountUpdateInterval = setInterval(() => {
            this.refreshAccounts();
        }, interval);
    }

    // ========================================================================
    // 启动真实数据模式
    // ========================================================================

    public async start() {
        if (this.apiKeys.length === 0) {
            console.error('❌ 错误: 未配置 PREDICT_API_KEY，无法启动');
            console.log('请在 .env 文件中设置 PREDICT_API_KEY');
            throw new Error('PREDICT_API_KEY is required');
        }

        console.log('🚀 启动 Live 模式');
        this.isRunning = true;

        // 初始化 WebSocket 客户端
        await this.initPolymarketWs();

        // 加载市场数据
        await this.initializeMarkets();

        // 开始定期更新
        const refreshInterval = this.calculateRefreshInterval();
        this.stats.refreshInterval = refreshInterval;

        console.log(`⏱️  刷新间隔: ${refreshInterval}ms (${this.marketDataList.length} 个市场)`);

        // 使用递归 setTimeout 替代 setInterval，防止并发重入
        const scheduleNextUpdate = () => {
            if (!this.isRunning) return;

            this.updateInterval = setTimeout(async () => {
                if (this.isUpdating) {
                    console.warn('⚠️  上一轮更新未完成，跳过本次');
                    scheduleNextUpdate();
                    return;
                }

                this.isUpdating = true;
                try {
                    await this.updateAllMarkets();
                    this.convertToOpportunities();
                    await this.updateCloseOpportunities();
                    this.broadcastToClients();
                } catch (e) {
                    console.error('更新出错:', e);
                } finally {
                    this.isUpdating = false;
                    scheduleNextUpdate();
                }
            }, refreshInterval);
        };

        // 立即执行一次更新，然后开始定时调度
        this.isUpdating = true;
        try {
            await this.updateAllMarkets();
            this.convertToOpportunities();
            await this.updateCloseOpportunities();
            this.broadcastToClients();
        } finally {
            this.isUpdating = false;
        }

        scheduleNextUpdate();

        // 启动账户数据独立刷新 (更短间隔)
        this.startAccountRefresh();
    }

    private calculateRefreshInterval(): number {
        // 基于市场数量动态计算刷新间隔
        // 每个市场需要约 250ms 的 API 调用时间
        const marketCount = this.marketDataList.length;
        return Math.max(marketCount * 250, 3000);
    }

    private async initPolymarketWs() {
        try {
            this.polyWsClient = new PolymarketWebSocketClient();

            this.polyWsClient.setHandlers({
                onConnect: () => {
                    console.log('📡 Polymarket WebSocket 已连接');
                    this.stats.connectionStatus.polymarketWs = 'connected';
                },
                onDisconnect: () => {
                    console.log('❌ Polymarket WebSocket 断开');
                    this.stats.connectionStatus.polymarketWs = 'disconnected';
                },
                onError: (error) => {
                    console.log('⚠️  Polymarket WebSocket 错误:', error.message);
                    this.stats.connectionStatus.polymarketWs = 'reconnecting';
                }
            });

            await this.polyWsClient.connect();
        } catch (e) {
            console.log('⚠️  Polymarket WebSocket 连接失败，使用 REST API');
            this.stats.connectionStatus.polymarketWs = 'disconnected';
        }
    }

    private async initializeMarkets() {
        // 启动时自动全量扫描
        console.log('🔍 启动全量市场扫描...');
        const scannedMatches = await this.scanAllMarkets();

        if (scannedMatches.length > 0) {
            // 保存扫描结果到缓存
            this.saveCacheFile(scannedMatches);
            console.log(`📂 扫描到 ${scannedMatches.length} 个市场，初始化中...`);

            for (const match of scannedMatches) {
                if (!match.polymarket.active || match.polymarket.closed || !match.polymarket.acceptingOrders) {
                    continue;
                }

                const conditionId = match.polymarket.conditionId;
                const marketInfo = await this.getPolymarketMarketInfo(conditionId);

                if (marketInfo.isSettled) {
                    continue;
                }

                this.marketDataList.push({
                    predictMarket: {
                        id: match.predict.id,
                        title: match.predict.title,
                        status: 'active',
                        polymarketConditionIds: [conditionId],
                        feeRateBps: match.predict.feeRateBps || 200
                    },
                    polyMarket: {
                        question: match.polymarket.question,
                        conditionId: conditionId,
                        volume: 0
                    },
                    polyYesTokenId: marketInfo.tokenId,
                    isInverted: match.inverted === true,
                    isSettled: false,
                    depth: null,
                    lastUpdate: 0,
                    error: marketInfo.tokenId ? null : 'Token ID 获取失败'
                });

                // 订阅 WebSocket
                if (marketInfo.tokenId && this.polyWsClient?.isConnected()) {
                    this.polyWsClient.subscribe([marketInfo.tokenId]);
                }

                await new Promise(r => setTimeout(r, 50));
            }

            this.stats.marketsMonitored = this.marketDataList.length;

            // 获取 volume 数据
            await Promise.all([
                this.fetchPolymarketVolumes(),
                this.fetchPredictVolumes()
            ]);

            console.log(`✅ 初始化完成: ${this.marketDataList.length} 个市场`);
        } else {
            console.log('⚠️  未扫描到任何有效市场');
        }
    }

    /**
     * 从 Gamma API 批量获取 Polymarket 市场的 volume 数据
     */
    private async fetchPolymarketVolumes(): Promise<void> {
        try {
            // 获取所有活跃市场
            const res = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500');
            if (!res.ok) return;

            const markets = await res.json() as Array<{
                conditionId?: string;
                volumeNum?: number;
            }>;

            // 创建 conditionId -> volumeNum 映射
            const volumeMap = new Map<string, number>();
            for (const m of markets) {
                if (m.conditionId && m.volumeNum) {
                    volumeMap.set(m.conditionId, m.volumeNum);
                }
            }

            // 更新 marketDataList 中的 polyVolume
            let updated = 0;
            for (const data of this.marketDataList) {
                const conditionId = data.polyMarket?.conditionId;
                if (conditionId && volumeMap.has(conditionId)) {
                    data.polyVolume = volumeMap.get(conditionId);
                    updated++;
                }
            }

            console.log(`📊 已获取 ${updated}/${this.marketDataList.length} 个 Polymarket volume`);
        } catch (e) {
            console.log('⚠️  获取 Polymarket volume 数据失败');
        }
    }

    /**
     * 从 Predict API 批量获取市场的 volume 数据
     */
    private async fetchPredictVolumes(): Promise<void> {
        if (this.marketDataList.length === 0 || this.apiKeys.length === 0) return;

        try {
            const volumeMap = new Map<number, number>();
            const marketIds = this.marketDataList.map(d => d.predictMarket.id);
            const batchSize = Math.min(this.apiKeys.length * 3, 10);

            for (let i = 0; i < marketIds.length; i += batchSize) {
                const batch = marketIds.slice(i, i + batchSize);
                const results = await Promise.all(batch.map(async (marketId, idx) => {
                    const apiKey = this.apiKeys[(i + idx) % this.apiKeys.length];
                    try {
                        const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}/stats`, {
                            headers: { 'x-api-key': apiKey }
                        });
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

            // 更新 marketDataList 中的 predictVolume
            let updated = 0;
            for (const data of this.marketDataList) {
                const vol = volumeMap.get(data.predictMarket.id);
                if (vol !== undefined && vol > 0) {
                    data.predictVolume = vol;
                    updated++;
                }
            }

            console.log(`📊 已获取 ${updated}/${this.marketDataList.length} 个 Predict volume`);
        } catch (e) {
            console.log('⚠️  获取 Predict volume 数据失败');
        }
    }

    /**
     * 全量扫描 Predict 市场，找出有 Polymarket 链接的活跃市场
     */
    private async scanAllMarkets(): Promise<CachedMarketMatch[]> {
        const matches: CachedMarketMatch[] = [];
        const normalize = (text: string): string =>
            String(text || '')
                .toLowerCase()
                .replace(/[’']/g, "'")
                .replace(/[^a-z0-9\s]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

        const tryFixAnyOtherToAnother = async (
            predictQuestionRaw: string,
            pmMarketSlug: string | undefined
        ): Promise<{ conditionId: string; question: string } | null> => {
            if (!pmMarketSlug) return null;

            const predictQuestion = String(predictQuestionRaw || '');
            if (!/\bany other\b/i.test(predictQuestion)) return null;

            // 通过 polymarket.com/market/{slug} 的 307 Location 反推出 event slug
            let eventSlug: string | null = null;
            try {
                const res = await fetch(`https://polymarket.com/market/${pmMarketSlug}`, {
                    method: 'HEAD',
                    redirect: 'manual',
                });
                const loc = res.headers.get('location') || '';
                const m = loc.match(/^\/event\/([^/]+)\/[^/]+/);
                if (m?.[1]) eventSlug = m[1];
            } catch {
                return null;
            }
            if (!eventSlug) return null;

            // 拉取该 event 下所有 markets，查找 “another player / any other” 对应的 market
            try {
                const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(eventSlug)}`);
                if (!res.ok) return null;
                const events = await res.json() as Array<{ markets?: Array<{ conditionId: string; question?: string }> }>;
                const markets = events[0]?.markets || [];
                if (markets.length === 0) return null;

                const targetNorm = normalize(predictQuestion).replace(/\bany other\b/g, 'another');
                const hit = markets.find((x) => normalize(x.question || '').replace(/\bany other\b/g, 'another') === targetNorm);
                if (!hit?.conditionId) return null;
                return { conditionId: hit.conditionId, question: hit.question || '' };
            } catch {
                return null;
            }
        };

        // 1. 获取所有市场列表
        console.log('  📋 获取 Predict 市场列表...');
        const allMarkets = await this.fetchPredictMarketList();
        console.log(`  📋 共 ${allMarkets.length} 个市场`);

        // 2. 筛选有 polymarketConditionIds 的活跃市场
        const marketsToCheck = allMarkets.filter((m: any) =>
            m.polymarketConditionIds?.length > 0 && m.status === 'REGISTERED'
        );
        console.log(`  🔗 ${marketsToCheck.length} 个有 Polymarket 链接`);

        if (marketsToCheck.length === 0) {
            return matches;
        }

        // 3. Worker 池并发验证（30 并发，Predict + Polymarket 并行请求）
        const CONCURRENCY = 30;
        let checked = 0;
        let taskIdx = 0;

        const scanWorker = async (): Promise<(CachedMarketMatch | null)[]> => {
            const results: (CachedMarketMatch | null)[] = [];
            while (true) {
                const myIdx = taskIdx++;
                if (myIdx >= marketsToCheck.length) return results;
                const m = marketsToCheck[myIdx] as any;  // 列表 API 已包含完整数据

                try {
                    let conditionId = m.polymarketConditionIds?.[0];
                    if (!conditionId) { checked++; continue; }

                    // 只需验证 Polymarket 市场（Predict 数据已从列表获取）
                    const pmRes = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
                    if (!pmRes.ok) { checked++; continue; }

                    let pmData = await pmRes.json() as any;
                    if (pmData.closed === true || pmData.accepting_orders === false) { checked++; continue; }

                    // 修复少量 “any other” 市场被错误链接到具体选手/标的的情况
                    const predictQuestionRaw = String(m.question || m.title || '');
                    const pmQuestionRaw = String(pmData.question || '');
                    if (/\bany other\b/i.test(predictQuestionRaw) && !/\b(any other|another)\b/i.test(pmQuestionRaw)) {
                        const fixed = await tryFixAnyOtherToAnother(predictQuestionRaw, pmData.market_slug);
                        if (fixed && fixed.conditionId && fixed.conditionId !== conditionId) {
                            const fixedRes = await fetch(`https://clob.polymarket.com/markets/${fixed.conditionId}`);
                            if (fixedRes.ok) {
                                const fixedData = await fixedRes.json() as any;
                                if (fixedData.closed !== true && fixedData.accepting_orders !== false) {
                                    console.log(`\n  🔧 [FixLink] Predict#${m.id} “${m.title}” conditionId override: ${conditionId.slice(0, 10)}… -> ${fixed.conditionId.slice(0, 10)}…`);
                                    conditionId = fixed.conditionId;
                                    pmData = fixedData;
                                }
                            }
                        }
                    }

                    // 检测 inverted 市场
                    const predictQuestion = (m.question || m.title || '').toLowerCase();
                    const pmQuestion = (pmData.question || '').toLowerCase();
                    let inverted = false;
                    let invertedReason = '';

                    if (predictQuestion.includes('change') && pmQuestion.includes('no change')) {
                        inverted = true;
                        invertedReason = 'Predict asks change, Polymarket asks no change';
                    } else if (predictQuestion.includes('no change') && pmQuestion.includes('change') && !pmQuestion.includes('no change')) {
                        inverted = true;
                        invertedReason = 'Predict asks no change, Polymarket asks change';
                    }

                    const result: CachedMarketMatch = {
                        predict: {
                            id: m.id,
                            title: m.title || m.question,
                            question: m.question,
                            conditionId: m.conditionId,
                            feeRateBps: m.feeRateBps
                        },
                        polymarket: {
                            question: pmData.question || '',
                            conditionId,
                            active: pmData.active !== false,
                            closed: pmData.closed === true,
                            acceptingOrders: pmData.accepting_orders !== false
                        }
                    };

                    if (inverted) {
                        result.inverted = true;
                        result.invertedReason = invertedReason;
                    }

                    results.push(result);
                    checked++;
                    process.stdout.write(`\r  🔍 扫描进度: ${checked}/${marketsToCheck.length} | 有效: ${matches.length + results.filter(Boolean).length}   `);
                } catch {
                    checked++;
                }
            }
            return results;
        };

        const workerResults = await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, marketsToCheck.length) }, () => scanWorker())
        );

        for (const wr of workerResults) {
            for (const match of wr) {
                if (match) matches.push(match);
            }
        }

        console.log('');  // 换行
        return matches;
    }

    /**
     * 获取 Predict 市场列表（分页）
     */
    private async fetchPredictMarketList(): Promise<any[]> {
        const allMarkets: any[] = [];
        let cursor: string | null = null;
        const pageSize = 100;

        while (true) {
            try {
                const url = cursor
                    ? `https://api.predict.fun/v1/markets?first=${pageSize}&after=${cursor}`
                    : `https://api.predict.fun/v1/markets?first=${pageSize}`;

                const res = await fetch(url, {
                    headers: { 'x-api-key': this.getNextApiKey() }
                });

                if (!res.ok) break;

                const data = await res.json() as any;
                if (!data.success) break;

                const markets = data.data || [];
                if (markets.length === 0) break;

                allMarkets.push(...markets);

                if (!data.cursor) break;
                cursor = data.cursor;

                await new Promise(r => setTimeout(r, 50));
            } catch {
                break;
            }
        }

        return allMarkets;
    }

    /**
     * 保存扫描结果到缓存文件
     */
    private saveCacheFile(matches: CachedMarketMatch[]): void {
        const cachePath = path.resolve(__dirname, '..', '..', 'polymarket-match-result.json');
        const result = {
            timestamp: new Date().toISOString(),
            summary: {
                total: matches.length,
                matched: matches.length,
                failed: 0
            },
            matches
        };

        try {
            fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
            console.log(`  💾 缓存已更新: ${cachePath}`);
        } catch (e) {
            console.warn(`  ⚠️  缓存保存失败:`, e);
        }
    }

    private loadCachedMarkets(): CachedMarketMatch[] | null {
        const cachePaths = [
            path.resolve(__dirname, '..', '..', 'polymarket-match-result.json'),
            path.join(process.cwd(), 'polymarket-match-result.json'),
            path.join(process.cwd(), 'bot', 'polymarket-match-result.json'),
            path.resolve(__dirname, '..', '..', '..', 'polymarket-match-result.json'),
        ];

        for (const cachePath of cachePaths) {
            try {
                if (fs.existsSync(cachePath)) {
                    const content = fs.readFileSync(cachePath, 'utf-8');
                    const data = JSON.parse(content) as { matches: CachedMarketMatch[] };
                    if (data.matches && data.matches.length > 0) {
                        return data.matches;
                    }
                }
            } catch (e) {
                // 忽略
            }
        }
        return null;
    }

    private async getPolymarketMarketInfo(conditionId: string): Promise<{ tokenId: string | null; isSettled: boolean }> {
        try {
            const res = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
            if (!res.ok) return { tokenId: null, isSettled: true };

            const data = await res.json() as {
                tokens?: { token_id: string; outcome: string }[];
                closed?: boolean;
                accepting_orders?: boolean;
            };

            const isSettled = data.closed === true || data.accepting_orders === false;
            const tokenId = data.tokens && data.tokens.length > 0 ? data.tokens[0].token_id : null;

            return { tokenId, isSettled };
        } catch {
            return { tokenId: null, isSettled: true };
        }
    }

    private async updateAllMarkets() {
        let predictLatencySum = 0;
        let predictCount = 0;
        let polyLatencySum = 0;
        let polyCount = 0;

        for (const data of this.marketDataList) {
            if (!data.polyYesTokenId) continue;

            // 获取 Predict 订单簿
            const predictBook = await this.getPredictOrderbook(data.predictMarket.id);

            // 获取 Polymarket 订单簿
            // WS-only 激进模式：只使用 WS 缓存，不回退到 REST
            const polyYesBook = this.getPolymarketOrderbookFromWs(data.polyYesTokenId);

            // 计算深度
            if (predictBook && polyYesBook) {
                const predictYesBids = predictBook.bids.map(([price, size]) => ({ price, size }));
                const predictYesAsks = predictBook.asks.map(([price, size]) => ({ price, size }));

                let polyHedgeAsks: { price: number; size: number }[];

                if (data.isInverted) {
                    polyHedgeAsks = polyYesBook.asks.map(level => ({
                        price: level.price,
                        size: level.size
                    }));
                } else {
                    polyHedgeAsks = polyYesBook.bids.map(level => ({
                        price: 1 - level.price,
                        size: level.size
                    }));
                    polyHedgeAsks.sort((a, b) => a.price - b.price);
                }

                data.depth = calculateDepth(
                    predictYesBids,
                    predictYesAsks,
                    polyHedgeAsks,
                    data.predictMarket.feeRateBps || 200
                );

                data.error = null;
            } else {
                data.depth = null;
                data.error = !predictBook ? 'Predict 无数据' : 'Polymarket 无数据';
            }

            data.lastUpdate = Date.now();
        }

        // 从实际 REST 请求获取延迟
        const pRestLatency = getPredictOrderbookCache()?.getRestLatency();
        if (pRestLatency) this.stats.latency.predict = pRestLatency;
        this.stats.lastFullUpdate = new Date().toISOString();
    }

    private async getPredictOrderbook(marketId: number): Promise<{ bids: [number, number][]; asks: [number, number][] } | null> {
        if (PREDICT_WS_ONLY) {
            const cache = getPredictOrderbookCache();
            const cached = cache?.getOrderbookSync(marketId);
            if (!cached || cached.source !== 'ws') {
                return null;
            }
            return {
                bids: cached.bids.map(l => [l.price, l.size]),
                asks: cached.asks.map(l => [l.price, l.size]),
            };
        }
        try {
            const res = await fetch(`https://api.predict.fun/v1/markets/${marketId}/orderbook`, {
                headers: { 'x-api-key': this.getNextApiKey() }
            });
            if (!res.ok) {
                if (res.status === 429) {
                    this.stats.connectionStatus.predictApi = 'rate_limited';
                }
                return null;
            }
            this.stats.connectionStatus.predictApi = 'ok';
            const data = await res.json() as { data: { bids: [number, number][]; asks: [number, number][] } };
            return data.data;
        } catch {
            this.stats.connectionStatus.predictApi = 'error';
            return null;
        }
    }

    private getPolymarketOrderbookFromWs(tokenId: string): { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null {
        if (!this.polyWsClient || !this.polyWsClient.isConnected()) return null;

        const cached = this.polyWsClient.getOrderBook(tokenId);
        if (!cached) return null;

        const bids = cached.bids.map(([price, size]) => ({ price, size }));
        const asks = cached.asks.map(([price, size]) => ({ price, size }));

        bids.sort((a, b) => b.price - a.price);
        asks.sort((a, b) => a.price - b.price);

        return { bids, asks };
    }

    private async getPolymarketOrderbookRest(tokenId: string): Promise<{ bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null> {
        try {
            const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
            if (!res.ok) return null;

            const book = await res.json() as { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] };

            const bids = (book.bids || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));
            const asks = (book.asks || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));

            bids.sort((a, b) => b.price - a.price);
            asks.sort((a, b) => a.price - b.price);

            return { bids, asks };
        } catch {
            return null;
        }
    }

    private convertToOpportunities() {
        // 使用 Map 保持市场顺序稳定，避免卡片跳动
        const oppMap = new Map<string, any>();

        for (const data of this.marketDataList) {
            if (!data.polyYesTokenId) continue;

            const depth = data.depth;
            const marketId = data.predictMarket.id;

            // 即使没有套利机会也显示市场，但区分状态
            const hasMakerArb = depth && depth.makerCost < 1 && depth.makerProfit > 0;
            const hasTakerArb = depth && depth.takerCost < 1 && depth.takerProfit > 0;
            const hasArb = hasMakerArb || hasTakerArb;

            // 为每个市场生成两个条目：PREDICT_MAKER 和 TAKER
            if (depth) {
                // PREDICT_MAKER 条目
                if (hasMakerArb) {
                    oppMap.set(`${marketId}-PREDICT_MAKER`, {
                        marketId,
                        title: data.predictMarket.title,
                        strategy: 'PREDICT_MAKER',
                        profitPercent: +(depth.makerProfit * 100).toFixed(2),
                        maxQuantity: Math.floor(depth.makerMaxQuantity),
                        estimatedProfit: +(depth.makerProfit * 100 * depth.makerMaxQuantity / 100).toFixed(2),
                        // 使用正确的字段名 (匹配 ArbOpportunity 接口)
                        predictBid: depth.predictYesBid,
                        predictAsk: depth.predictYesAsk,
                        predictPrice: depth.predictYesBid,
                        polymarketPrice: depth.polymarketNoAsk,
                        makerCost: +(depth.makerCost * 100).toFixed(2),
                        takerCost: +(depth.takerCost * 100).toFixed(2),
                        predictFee: +(depth.predictFee * 100).toFixed(2),
                        totalCost: +(depth.makerCost * 100).toFixed(1),
                        depth: {
                            predict: Math.floor(depth.predictYesBidDepth || 0),
                            polymarket: Math.floor(depth.polymarketNoAskDepth || 0)
                        },
                        lastUpdate: data.lastUpdate,
                        isInverted: data.isInverted,
                        polyVolume: data.polyVolume,
                        predictVolume: data.predictVolume
                    });
                }

                // TAKER 条目
                if (hasTakerArb) {
                    oppMap.set(`${marketId}-TAKER`, {
                        marketId,
                        title: data.predictMarket.title,
                        strategy: 'TAKER',
                        profitPercent: +(depth.takerProfit * 100).toFixed(2),
                        maxQuantity: Math.floor(depth.takerMaxQuantity),
                        estimatedProfit: +(depth.takerProfit * 100 * depth.takerMaxQuantity / 100).toFixed(2),
                        // 使用正确的字段名 (匹配 ArbOpportunity 接口)
                        predictBid: depth.predictYesBid,
                        predictAsk: depth.predictYesAsk,
                        predictPrice: depth.predictYesAsk,  // Taker 用 ask 价格
                        polymarketPrice: depth.polymarketNoAsk,
                        makerCost: +(depth.makerCost * 100).toFixed(2),
                        takerCost: +(depth.takerCost * 100).toFixed(2),
                        predictFee: +(depth.predictFee * 100).toFixed(2),
                        totalCost: +(depth.takerCost * 100).toFixed(1),
                        depth: {
                            predict: Math.floor(depth.predictYesAskDepth || 0),
                            polymarket: Math.floor(depth.polymarketNoAskDepth || 0)
                        },
                        lastUpdate: data.lastUpdate,
                        isInverted: data.isInverted,
                        polyVolume: data.polyVolume,
                        predictVolume: data.predictVolume
                    });
                }
            }
        }

        // 转换为数组，按 marketId 排序保持稳定顺序
        this.opportunities = Array.from(oppMap.values()).sort((a, b) => a.marketId - b.marketId);
        this.updateStats();
    }

    private updateStats() {
        this.stats.arbStats.makerCount = this.opportunities.filter(o => o.strategy === 'PREDICT_MAKER').length;
        this.stats.arbStats.takerCount = this.opportunities.filter(o => o.strategy === 'TAKER').length;
        this.stats.arbStats.avgProfit = this.opportunities.length > 0
            ? +(this.opportunities.reduce((acc, cur) => acc + cur.profitPercent, 0) / this.opportunities.length).toFixed(2)
            : 0;
        this.stats.arbStats.maxProfit = this.opportunities.length > 0
            ? Math.max(...this.opportunities.map(o => o.profitPercent))
            : 0;
        this.stats.arbStats.totalDepth = this.opportunities.reduce(
            (acc, cur) => acc + cur.depth.predict + cur.depth.polymarket, 0
        );
    }

    /**
     * 更新平仓机会 (每 N 次更新执行一次，避免频繁查询持仓)
     */
    private closeOpportunityUpdateCounter = 0;
    private async updateCloseOpportunities() {
        // 每 3 次套利更新，执行一次平仓机会更新 (约 10-15 秒)
        this.closeOpportunityUpdateCounter++;
        if (this.closeOpportunityUpdateCounter < 3) {
            return;
        }
        this.closeOpportunityUpdateCounter = 0;

        try {
            this.closeOpportunities = await calculateCloseOpportunities();
        } catch (e) {
            console.error('更新平仓机会出错:', e);
        }
    }

    // ========================================================================
    // Public API
    // ========================================================================

    public getOpportunities() { return this.opportunities; }
    public getCloseOpportunities() { return this.closeOpportunities; }
    public getStats() { return this.stats; }
    public getMarkets() { return this.markets; }
    public getAccounts() {
        return {
            predict: this.predictAccount,
            polymarket: this.polymarketAccount
        };
    }

    public stop() {
        this.isRunning = false;
        if (this.updateInterval) {
            clearTimeout(this.updateInterval);  // 改用 clearTimeout
            this.updateInterval = null;
        }
        if (this.accountUpdateInterval) {
            clearInterval(this.accountUpdateInterval);
            this.accountUpdateInterval = null;
        }
        if (this.polyWsClient) {
            this.polyWsClient.disconnect();
            this.polyWsClient = null;
        }
    }
}
