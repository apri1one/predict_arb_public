/**
 * Predict 套利监控面板 CLI
 *
 * 实时显示所有可套利市场的价格和套利机会
 * 使用 depth-calculator.ts 进行深度感知计算
 *
 * Usage: npm run arb-monitor
 *    或: npx tsx src/terminal/arb-monitor.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { calculateDepth, type DepthResult } from '../trading/depth-calculator.js';
import { PolymarketWebSocketClient } from '../polymarket/ws-client.js';

// ESM 兼容的 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// ANSI 颜色
// ============================================================================

const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    white: '\x1b[37m',
};

// ============================================================================
// 环境加载
// ============================================================================

function loadEnv() {
    // 尝试多个路径（优先当前工作目录）
    const possiblePaths = [
        path.join(process.cwd(), '.env'),
        path.resolve(__dirname, '..', '..', '.env'),
    ];

    for (const envPath of possiblePaths) {
        try {
            if (fs.existsSync(envPath)) {
                const content = fs.readFileSync(envPath, 'utf-8');
                for (const line of content.split('\n')) {
                    const match = line.trim().match(/^([^#=]+)=(.*)$/);
                    if (match) {
                        const key = match[1].trim();
                        const value = match[2].trim();
                        if (!process.env[key]) {
                            process.env[key] = value;
                        }
                    }
                }
                return;
            }
        } catch (e) {
            // 忽略
        }
    }
}

loadEnv();

function clearScreen(): void {
    // 只在非 DEBUG 模式清屏
    if (!process.env.DEBUG) {
        process.stdout.write('\x1b[2J\x1b[H');
    }
}

function hideCursor(): void {
    process.stdout.write('\x1b[?25l');
}

function showCursor(): void {
    process.stdout.write('\x1b[?25h');
}

// ============================================================================
// 类型定义
// ============================================================================

interface PredictMarket {
    id: number;
    title: string;
    status: string;
    polymarketConditionIds: string[];
    feeRateBps: number;
}

interface PolyMarket {
    question: string;
    conditionId: string;
    clobTokenIds: string; // JSON: [YES_token, NO_token]
}

// 缓存文件中的市场匹配格式
interface CachedMarketMatch {
    predict: {
        id: number;
        title: string;
        question: string;
        conditionId: string;
    };
    polymarket: {
        question: string;
        conditionId: string;
        active: boolean;
        closed: boolean;
        acceptingOrders: boolean;
    };
    inverted?: boolean;  // 问题方向相反的市场
    invertedReason?: string;
}

interface MarketData {
    predictMarket: PredictMarket;
    polyMarket: PolyMarket | null;
    polyYesTokenId: string | null;  // 使用 YES token，推导 NO 价格
    isInverted: boolean;  // 问题方向相反的市场
    isSettled: boolean;   // 市场已结算
    depth: DepthResult | null;
    lastUpdate: number;
    error: string | null;
}

interface Stats {
    totalMarkets: number;
    loadedMarkets: number;
    takerArbs: number;
    makerArbs: number;
    maxTakerProfit: number;
    maxMakerProfit: number;
    predictLatency: number;
    polymarketLatency: number;
    updateCount: number;
}

// ============================================================================
// 全局状态
// ============================================================================

// 支持多 API Key 轮换（PREDICT_API_KEY, PREDICT_API_KEY_2, PREDICT_API_KEY_3...）
const apiKeys: string[] = [];
if (process.env.PREDICT_API_KEY) apiKeys.push(process.env.PREDICT_API_KEY);
if (process.env.PREDICT_API_KEY_2) apiKeys.push(process.env.PREDICT_API_KEY_2);
if (process.env.PREDICT_API_KEY_3) apiKeys.push(process.env.PREDICT_API_KEY_3);

let currentKeyIndex = 0;
function getNextApiKey(): string {
    if (apiKeys.length === 0) return '';
    const key = apiKeys[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
    return key;
}

const predictUrl = 'https://api.predict.fun';

// Polymarket WebSocket 客户端
let polyWsClient: PolymarketWebSocketClient | null = null;

let marketDataList: MarketData[] = [];
let stats: Stats = {
    totalMarkets: 0,
    loadedMarkets: 0,
    takerArbs: 0,
    makerArbs: 0,
    maxTakerProfit: 0,
    maxMakerProfit: 0,
    predictLatency: 0,
    polymarketLatency: 0,
    updateCount: 0,
};

// ============================================================================
// 数据获取
// ============================================================================

/**
 * 获取 Predict 订单簿
 */
async function getPredictOrderbook(marketId: number): Promise<{ bids: [number, number][]; asks: [number, number][] } | null> {
    try {
        const res = await fetch(`${predictUrl}/v1/markets/${marketId}/orderbook`, {
            headers: { 'x-api-key': getNextApiKey() }
        });
        if (!res.ok) return null;
        const data = await res.json() as { data: { bids: [number, number][]; asks: [number, number][] } };
        return data.data;
    } catch {
        return null;
    }
}

/**
 * 从 WebSocket 缓存获取 Polymarket 订单簿
 */
function getPolymarketOrderbookFromWs(tokenId: string): { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null {
    if (!polyWsClient || !polyWsClient.isConnected()) return null;

    const cached = polyWsClient.getOrderBook(tokenId);
    if (!cached) return null;

    // 转换格式: [price, size] -> { price, size }
    const bids = cached.bids.map(([price, size]) => ({ price, size }));
    const asks = cached.asks.map(([price, size]) => ({ price, size }));

    // 确保排序: bids 降序, asks 升序
    bids.sort((a, b) => b.price - a.price);
    asks.sort((a, b) => a.price - b.price);

    return { bids, asks };
}

/**
 * 获取 Polymarket 订单簿 (REST API 作为备用)
 */
async function getPolymarketOrderbookRest(tokenId: string): Promise<{ bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null> {
    try {
        const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
        if (!res.ok) return null;

        const book = await res.json() as { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] };

        // 转换为数值格式
        const bids = (book.bids || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));
        const asks = (book.asks || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));

        // Polymarket 排序: bids 升序, asks 降序
        // 需要转换为标准格式: bids 降序, asks 升序
        bids.sort((a, b) => b.price - a.price);
        asks.sort((a, b) => a.price - b.price);

        return { bids, asks };
    } catch {
        return null;
    }
}

/**
 * 使用 CLOB API 获取 Polymarket 市场信息
 * 返回 token ID 和结算状态
 */
async function getPolymarketMarketInfo(conditionId: string): Promise<{ tokenId: string | null; isSettled: boolean }> {
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

// 兼容旧代码的包装函数
async function getPolymarketTokenId(conditionId: string): Promise<string | null> {
    const info = await getPolymarketMarketInfo(conditionId);
    return info.tokenId;
}

/**
 * 从缓存文件加载市场匹配数据
 */
function loadCachedMarkets(): CachedMarketMatch[] | null {
    const cachePaths = [
        path.join(process.cwd(), 'polymarket-match-result.json'),
        path.join(process.cwd(), '..', 'polymarket-match-result.json'),
        path.resolve(__dirname, '..', '..', 'polymarket-match-result.json'),
    ];

    for (const cachePath of cachePaths) {
        try {
            if (fs.existsSync(cachePath)) {
                const content = fs.readFileSync(cachePath, 'utf-8');
                const data = JSON.parse(content) as { matches: CachedMarketMatch[] };
                if (data.matches && data.matches.length > 0) {
                    console.log(`${c.dim}  从缓存加载: ${cachePath}${c.reset}`);
                    return data.matches;
                }
            }
        } catch (e) {
            // 忽略
        }
    }
    return null;
}

/**
 * 初始化市场列表
 * 优先使用缓存文件，避免 API 限流
 */
async function initializeMarkets(): Promise<void> {
    // 1. 尝试从缓存加载
    const cachedMatches = loadCachedMarkets();

    if (cachedMatches && cachedMatches.length > 0) {
        console.log(`${c.cyan}从缓存加载 ${cachedMatches.length} 个市场...${c.reset}`);

        for (const match of cachedMatches) {
            // 只处理活跃且接受订单的市场
            if (!match.polymarket.active || match.polymarket.closed || !match.polymarket.acceptingOrders) {
                continue;
            }

            const conditionId = match.polymarket.conditionId;

            // 获取市场信息（token ID 和结算状态）
            const marketInfo = await getPolymarketMarketInfo(conditionId);

            // 跳过已结算的市场
            if (marketInfo.isSettled) {
                process.stdout.write(`\r${c.dim}  跳过已结算: ${match.predict.title.slice(0, 30)}${c.reset}\n`);
                continue;
            }

            const polyYesTokenId = marketInfo.tokenId;

            marketDataList.push({
                predictMarket: {
                    id: match.predict.id,
                    title: match.predict.title,
                    status: 'active',
                    polymarketConditionIds: [conditionId],
                    feeRateBps: 200 // 默认 2%
                },
                polyMarket: {
                    question: match.polymarket.question,
                    conditionId: conditionId,
                    clobTokenIds: '[]'
                },
                polyYesTokenId,
                isInverted: match.inverted === true,
                isSettled: false,
                depth: null,
                lastUpdate: 0,
                error: polyYesTokenId ? null : 'Token ID 获取失败'
            });

            process.stdout.write(`\r${c.dim}  已处理 ${marketDataList.length}/${cachedMatches.length}${c.reset}`);

            // 稍微延迟避免请求过快
            await new Promise(r => setTimeout(r, 100));
        }

        console.log(); // 换行
        stats.totalMarkets = marketDataList.length;
        stats.loadedMarkets = marketDataList.filter(m => m.polyYesTokenId).length;
        console.log(`${c.green}初始化完成: ${stats.loadedMarkets}/${stats.totalMarkets} 个市场可监控${c.reset}\n`);
        return;
    }

    // 2. 无缓存时，从 API 获取
    console.log(`${c.cyan}正在获取 Predict 市场...${c.reset}`);

    const allMarkets: PredictMarket[] = [];
    let cursor: string | null = null;

    try {
        while (true) {
            const url = cursor
                ? `${predictUrl}/v1/markets?first=150&after=${cursor}`
                : `${predictUrl}/v1/markets?first=150`;

            const marketsRes = await fetch(url, {
                headers: { 'x-api-key': getNextApiKey() }
            });

            if (!marketsRes.ok) {
                const errorText = await marketsRes.text();
                console.log(`${c.red}API 错误: ${marketsRes.status}${c.reset}`);
                console.log(`${c.dim}${errorText.slice(0, 200)}${c.reset}`);
                break;
            }

            const marketsData = await marketsRes.json() as { success?: boolean; data?: PredictMarket[]; cursor?: string };

            if (!marketsData.success || !marketsData.data) {
                break;
            }

            allMarkets.push(...marketsData.data);
            process.stdout.write(`\r${c.dim}  已获取 ${allMarkets.length} 个市场...${c.reset}`);

            if (!marketsData.cursor || marketsData.data.length < 150) {
                break;
            }
            cursor = marketsData.cursor;
        }
        console.log();
    } catch (e) {
        console.log(`${c.red}获取市场失败: ${e}${c.reset}`);
        return;
    }

    console.log(`${c.dim}  获取到 ${allMarkets.length} 个 Predict 市场${c.reset}`);

    const linkedMarkets = allMarkets.filter(m =>
        m.polymarketConditionIds &&
        m.polymarketConditionIds.length > 0 &&
        m.polymarketConditionIds[0] !== ''
    );

    console.log(`${c.green}  其中 ${linkedMarkets.length} 个有 Polymarket 链接${c.reset}`);
    console.log(`${c.cyan}正在获取 Polymarket token IDs...${c.reset}`);

    for (const market of linkedMarkets) {
        const conditionId = market.polymarketConditionIds[0];

        // 使用 CLOB API 获取 token ID
        const polyYesTokenId = await getPolymarketTokenId(conditionId);

        marketDataList.push({
            predictMarket: market,
            polyMarket: {
                question: market.title,
                conditionId: conditionId,
                clobTokenIds: '[]'
            },
            polyYesTokenId,
            isInverted: false,  // API 获取时默认不反转，需要手动检查
            isSettled: false,
            depth: null,
            lastUpdate: 0,
            error: polyYesTokenId ? null : 'Token ID 获取失败'
        });

        process.stdout.write(`\r${c.dim}  已处理 ${marketDataList.length}/${linkedMarkets.length}${c.reset}`);

        // 延迟避免限流
        await new Promise(r => setTimeout(r, 100));
    }

    console.log();
    stats.totalMarkets = marketDataList.length;
    stats.loadedMarkets = marketDataList.filter(m => m.polyYesTokenId).length;

    console.log(`${c.green}初始化完成: ${stats.loadedMarkets}/${stats.totalMarkets} 个市场可监控${c.reset}\n`);
}

/**
 * 更新所有市场数据
 */
async function updateAllMarkets(): Promise<void> {
    let predictLatencySum = 0;
    let predictCount = 0;
    let polyLatencySum = 0;
    let polyCount = 0;

    let takerArbs = 0;
    let makerArbs = 0;
    let maxTakerProfit = 0;
    let maxMakerProfit = 0;

    for (const data of marketDataList) {
        if (!data.polyYesTokenId) continue;

        // 获取 Predict 订单簿
        const pStart = Date.now();
        const predictBook = await getPredictOrderbook(data.predictMarket.id);
        predictLatencySum += Date.now() - pStart;
        predictCount++;

        // 获取 Polymarket YES 订单簿 (优先 WebSocket，备用 REST)
        const pmStart = Date.now();
        let polyYesBook = getPolymarketOrderbookFromWs(data.polyYesTokenId);
        if (!polyYesBook) {
            // WebSocket 无数据，使用 REST API
            polyYesBook = await getPolymarketOrderbookRest(data.polyYesTokenId);
        }
        polyLatencySum += Date.now() - pmStart;
        polyCount++;

        // 计算深度
        if (predictBook && polyYesBook) {
            const predictYesBids = predictBook.bids.map(([price, size]) => ({ price, size }));
            const predictYesAsks = predictBook.asks.map(([price, size]) => ({ price, size }));

            let polyHedgeAsks: { price: number; size: number }[];

            if (data.isInverted) {
                // Inverted 市场: Predict YES + Polymarket YES = 对冲
                // 使用 Polymarket YES Ask 价格
                polyHedgeAsks = polyYesBook.asks.map((level: { price: number; size: number }) => ({
                    price: level.price,
                    size: level.size
                }));
                // asks 已经按升序排列
            } else {
                // 正常市场: Predict YES + Polymarket NO = 对冲
                // NO Ask = 1 - YES Bid (买 NO = 对手卖 NO = 对手买 YES)
                polyHedgeAsks = polyYesBook.bids.map((level: { price: number; size: number }) => ({
                    price: 1 - level.price,
                    size: level.size
                }));
                // 排序：asks 按价格升序（最低在前）
                polyHedgeAsks.sort((a, b) => a.price - b.price);
            }

            data.depth = calculateDepth(
                predictYesBids,
                predictYesAsks,
                polyHedgeAsks,
                data.predictMarket.feeRateBps || 200
            );

            if (data.depth.takerCost < 1 && data.depth.takerProfit > 0) {
                takerArbs++;
                if (data.depth.takerProfit > maxTakerProfit) {
                    maxTakerProfit = data.depth.takerProfit;
                }
            }

            if (data.depth.makerCost < 1 && data.depth.makerProfit > 0) {
                makerArbs++;
                if (data.depth.makerProfit > maxMakerProfit) {
                    maxMakerProfit = data.depth.makerProfit;
                }
            }

            data.error = null;
        } else {
            data.depth = null;
            data.error = !predictBook ? 'Predict 无数据' : 'Polymarket 无数据';
        }

        data.lastUpdate = Date.now();
    }

    stats.predictLatency = predictCount > 0 ? Math.round(predictLatencySum / predictCount) : 0;
    stats.polymarketLatency = polyCount > 0 ? Math.round(polyLatencySum / polyCount) : 0;
    stats.takerArbs = takerArbs;
    stats.makerArbs = makerArbs;
    stats.maxTakerProfit = maxTakerProfit * 100;
    stats.maxMakerProfit = maxMakerProfit * 100;
    stats.updateCount++;
}

// ============================================================================
// CLI 渲染
// ============================================================================

function formatPrice(price: number | undefined): string {
    if (price === undefined || price === 0) return '  --- ';
    return `${(price * 100).toFixed(1)}c`.padStart(6);
}

function formatSize(size: number | undefined): string {
    if (size === undefined || size === 0) return '    0';
    if (size >= 1000) return `${(size / 1000).toFixed(1)}K`.padStart(5);
    return `${size.toFixed(0)}`.padStart(5);
}

function render(): void {
    clearScreen();

    const time = new Date().toLocaleTimeString('zh-CN');
    const width = 130;

    // 标题栏
    console.log(`${c.bold}${c.cyan}╔${'═'.repeat(width - 2)}╗${c.reset}`);
    const title = `PREDICT-POLYMARKET 套利监控`;
    const titleInfo = `更新: ${time} │ P:${stats.predictLatency}ms PM:${stats.polymarketLatency}ms │ #${stats.updateCount}`;
    const padding = width - title.length - titleInfo.length - 10;
    console.log(`${c.cyan}║${c.reset}  ${c.bold}${title}${c.reset}  │  ${c.dim}${titleInfo}${c.reset}${' '.repeat(Math.max(0, padding))}${c.cyan}║${c.reset}`);
    console.log(`${c.cyan}╠${'═'.repeat(width - 2)}╣${c.reset}`);

    // 表头 - 分别显示 Maker 和 Taker 利润
    console.log(`${c.cyan}║${c.reset}${c.bold} #  │ 市场名称                       │ P-Bid  │ P-Ask  │ PM-Hdg │ Maker利润  │ Taker利润  │ 可挂    │ 可吃    ${c.reset}${c.cyan}║${c.reset}`);
    console.log(`${c.cyan}╠${'═'.repeat(width - 2)}╣${c.reset}`);

    // 数据行 - 按利润排序，只显示有订单簿数据的市场
    const sortedData = [...marketDataList]
        .filter(d => d.polyYesTokenId && d.depth && d.depth.predictYesBid > 0) // 只显示有实际数据的
        .sort((a, b) => {
            const aProfit = a.depth?.makerProfit ?? -999;
            const bProfit = b.depth?.makerProfit ?? -999;
            return bProfit - aProfit;
        });

    let rowNum = 1;
    const maxRows = 30;

    for (const data of sortedData.slice(0, maxRows)) {
        const d = data.depth;
        // 如果是 inverted 市场，在标题前加 [↔] 标记
        const invertedMark = data.isInverted ? '[↔]' : '';
        const maxTitleLen = data.isInverted ? 26 : 30;
        const titleText = data.predictMarket.title.length > maxTitleLen
            ? data.predictMarket.title.slice(0, maxTitleLen - 3) + '...'
            : data.predictMarket.title;
        const title = (invertedMark + titleText).padEnd(30);

        const num = String(rowNum).padStart(2);

        if (d && d.predictYesBid > 0 && d.polymarketNoAsk > 0) {
            // Maker 利润
            let makerProfitStr: string;
            let makerSizeStr: string;
            let indicator = ' ';

            if (d.makerCost < 1 && d.makerProfit > 0) {
                makerProfitStr = `${c.green}+${(d.makerProfit * 100).toFixed(2)}%${c.reset}`;
                makerSizeStr = formatSize(d.makerMaxQuantity);
                indicator = '★';
            } else {
                makerProfitStr = `${c.red}${((1 - d.makerCost) * 100).toFixed(2)}%${c.reset}`;
                makerSizeStr = '    -';
            }

            // Taker 利润
            let takerProfitStr: string;
            let takerSizeStr: string;

            if (d.takerCost < 1 && d.takerProfit > 0) {
                takerProfitStr = `${c.green}+${(d.takerProfit * 100).toFixed(2)}%${c.reset}`;
                takerSizeStr = formatSize(d.takerMaxQuantity);
                if (indicator !== '★') indicator = '◆';
            } else {
                takerProfitStr = `${c.red}${((1 - d.takerCost) * 100).toFixed(2)}%${c.reset}`;
                takerSizeStr = '    -';
            }

            console.log(`${c.cyan}║${c.reset}${indicator}${num} │ ${title} │${formatPrice(d.predictYesBid)} │${formatPrice(d.predictYesAsk)} │${formatPrice(d.polymarketNoAsk)} │ ${makerProfitStr.padStart(18)} │ ${takerProfitStr.padStart(18)} │${makerSizeStr.padStart(8)} │${takerSizeStr.padStart(8)} ${c.cyan}║${c.reset}`);
        } else {
            // 无数据
            const errMsg = data.error || '加载中...';
            console.log(`${c.cyan}║${c.reset} ${c.dim}${num} │ ${title} │  ---  │  ---  │  ---  │     ---    │     ---    │    --- │    --- ${c.reset}${c.cyan}║${c.reset}`);
        }

        rowNum++;
    }

    // 填充空行
    while (rowNum <= 10) {
        console.log(`${c.cyan}║${c.reset}${' '.repeat(width - 2)}${c.cyan}║${c.reset}`);
        rowNum++;
    }

    // 统计栏
    console.log(`${c.cyan}╠${'═'.repeat(width - 2)}╣${c.reset}`);

    const takerColor = stats.takerArbs > 0 ? c.green : c.yellow;
    const makerColor = stats.makerArbs > 0 ? c.green : c.yellow;
    const wsStatus = polyWsClient?.isConnected() ? `${c.green}WS${c.reset}` : `${c.dim}REST${c.reset}`;
    const activeCount = marketDataList.filter(d => d.depth && d.depth.predictYesBid > 0).length;

    const statsLine = `TAKER: ${takerColor}${stats.takerArbs}${c.reset}个 (${stats.maxTakerProfit.toFixed(2)}%)` +
        `  │  MAKER: ${makerColor}${stats.makerArbs}${c.reset}个 (${stats.maxMakerProfit.toFixed(2)}%)` +
        `  │  PM:${wsStatus}  │  活跃: ${activeCount}/${stats.totalMarkets}`;
    const statsPadding = width - statsLine.length + 30;
    console.log(`${c.cyan}║${c.reset}  ${statsLine}${' '.repeat(Math.max(0, statsPadding))}${c.cyan}║${c.reset}`);

    console.log(`${c.cyan}╚${'═'.repeat(width - 2)}╝${c.reset}`);

    // 操作提示
    console.log();
    console.log(`${c.dim}[Ctrl+C] 退出  │  刷新: 3s  │  ★ = Maker套利  ◆ = Taker套利  │  [↔] = 方向相反${c.reset}`);
    console.log(`${c.dim}Maker: P-Bid + PM-Hedge < 1 (挂单)  │  Taker: P-Ask + PM-Hedge + Fee < 1 (吃单)${c.reset}`);
}

// ============================================================================
// 主程序
// ============================================================================

async function main(): Promise<void> {
    console.log(`${c.bold}${c.cyan}Predict-Polymarket 套利监控面板${c.reset}`);
    console.log(`${c.dim}${'─'.repeat(50)}${c.reset}\n`);

    if (apiKeys.length === 0) {
        console.log(`${c.red}错误: 未设置 PREDICT_API_KEY${c.reset}`);
        console.log(`${c.dim}请在 .env 文件中配置 PREDICT_API_KEY${c.reset}`);
        process.exit(1);
    }

    console.log(`${c.dim}API Keys: ${apiKeys.length} 个 (轮换模式)${c.reset}\n`);

    try {
        await initializeMarkets();

        if (marketDataList.length === 0) {
            console.log(`${c.yellow}警告: 未找到跨平台市场${c.reset}`);
            process.exit(0);
        }

        // 初始化 Polymarket WebSocket
        const tokenIds = marketDataList
            .filter(m => m.polyYesTokenId)
            .map(m => m.polyYesTokenId!);

        if (tokenIds.length > 0) {
            console.log(`${c.cyan}连接 Polymarket WebSocket...${c.reset}`);
            polyWsClient = new PolymarketWebSocketClient();

            polyWsClient.setHandlers({
                onConnect: () => {
                    console.log(`${c.green}WebSocket 已连接${c.reset}`);
                },
                onDisconnect: (code, reason) => {
                    console.log(`${c.yellow}WebSocket 断开: ${code} ${reason}${c.reset}`);
                },
                onError: (err) => {
                    console.log(`${c.red}WebSocket 错误: ${err.message}${c.reset}`);
                }
            });

            try {
                await polyWsClient.connect();
                polyWsClient.subscribe(tokenIds);
                console.log(`${c.dim}已订阅 ${tokenIds.length} 个市场${c.reset}`);

                // 等待初始数据
                await new Promise(r => setTimeout(r, 2000));
            } catch (wsErr) {
                console.log(`${c.yellow}WebSocket 连接失败，使用 REST API${c.reset}`);
                polyWsClient = null;
            }
        }

        hideCursor();

        // 首次更新
        await updateAllMarkets();
        render();

        // 定期更新 (3秒)
        const updateInterval = setInterval(async () => {
            try {
                await updateAllMarkets();
                render();
            } catch (e) {
                // 忽略更新错误
            }
        }, 3000);

        // 处理退出
        process.on('SIGINT', () => {
            clearInterval(updateInterval);
            if (polyWsClient) {
                polyWsClient.disconnect();
            }
            showCursor();
            console.log('\n\n再见！');
            process.exit(0);
        });

        // 保持运行
        await new Promise(() => { });

    } catch (error) {
        showCursor();
        console.error(`${c.red}错误:${c.reset}`, error);
        process.exit(1);
    }
}

main();
