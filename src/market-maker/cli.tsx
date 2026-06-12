/**
 * Predict 做市模块 - CLI 入口
 *
 * 启动流程：扫描市场 → 选择市场 → 开始做市 → 监控面板
 *
 * 运行: npm run market-maker
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';

// 加载根目录的 .env 文件
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const BOT_DIR = path.resolve(__dirname, '../..');

import { MultiMarketMaker, type GlobalStats } from './multi-engine.js';
import { scanMarkets, selectMarkets, convertToConfigs, displayMarketList } from './market-selector.js';
import type { MarketInfo, SelectedMarket } from './market-selector.js';
import { createTradingClient, TradingClient } from './trading-client.js';
import type { MarketState, Fill, MarketMakerConfig, MarketMakerStrategy } from './types.js';
import { TelegramNotifier } from '../notification/telegram.js';
import { loadConfig, saveConfig, formatConfigSummary, DEFAULT_GLOBAL_CONFIG, type SavedConfig } from './config.js';
import EventEmitter from 'events';
import { render } from 'ink';
import { MarketMakerUI, type UISnapshot } from './ui.js';

// ============================================================================
// ANSI 颜色和控制
// ============================================================================

const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
};

// ============================================================================
// 环境变量
// ============================================================================

const apiKey = process.env.PREDICT_API_KEY || '';
const scanApiKey = process.env.PREDICT_API_KEY_SCAN || process.env.PREDICT_API_KEY || '';
const baseUrl = process.env.PREDICT_API_BASE_URL || 'https://api.predict.fun';
const signerPrivateKey = process.env.PREDICT_SIGNER_PRIVATE_KEY || '';

if (!apiKey) {
    console.error(`${c.red}错误: 请设置 PREDICT_API_KEY${c.reset}`);
    process.exit(1);
}

if (!scanApiKey) {
    console.error(`${c.red}错误: 请设置 PREDICT_API_KEY_SCAN 或 PREDICT_API_KEY${c.reset}`);
    process.exit(1);
}

if (!signerPrivateKey) {
    console.error(`${c.red}错误: 请设置 PREDICT_SIGNER_PRIVATE_KEY${c.reset}`);
    process.exit(1);
}

// ============================================================================
// 全局交易客户端
// ============================================================================

let tradingClient: TradingClient | null = null;

// ============================================================================
// 状态存储
// ============================================================================

let multiMaker: MultiMarketMaker | null = null;
const fills: Fill[] = [];
const configByMarketId: Map<number, MarketMakerConfig> = new Map();
const uiEmitter = new EventEmitter();
let uiInstance: ReturnType<typeof render> | null = null;

// ============================================================================
// Telegram 通知（可选）
// ============================================================================

let tg: TelegramNotifier | null = null;
const lastTgErrorAt: Map<string, number> = new Map(); // key = `${marketId}:${message}`
const lastStatusByMarket: Map<number, string> = new Map();

function isTgEnabled(): boolean {
    const token = process.env.TELEGRAM_BOT_TOKEN || '';
    const chatId = process.env.TELEGRAM_CHAT_ID || '';
    const enabledEnv = (process.env.MM_TG_ENABLED || '').trim();
    const enabled = enabledEnv
        ? (enabledEnv === '1' || enabledEnv.toLowerCase() === 'true')
        : Boolean(token && chatId);
    return enabled && Boolean(token && chatId);
}

function initTelegram(): void {
    if (!isTgEnabled()) return;
    tg = new TelegramNotifier({
        botToken: process.env.TELEGRAM_BOT_TOKEN || '',
        chatId: process.env.TELEGRAM_CHAT_ID || '',
        enabled: true,
    });
}

async function tgSend(text: string): Promise<void> {
    if (!tg) return;
    try {
        // 转义 HTML 特殊字符，避免 Telegram 解析错误
        const escaped = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        const trimmed = escaped.length > 3500 ? escaped.slice(0, 3500) + '...' : escaped;
        await tg.sendText(trimmed);
    } catch {
        // ignore
    }
}

function formatCentsPlain(price: number): string {
    return `${(price * 100).toFixed(1)}¢`;
}

// ============================================================================
// 错误日志留存（避免刷新清屏覆盖）
// ============================================================================

type ErrorEntry = {
    time: Date;
    marketId: number | null;
    message: string;
};

const recentErrors: ErrorEntry[] = [];
const MAX_ERRORS = 50;
const RUN_START_TIME = new Date();
const LOG_DIR = path.resolve(BOT_DIR, 'logs', 'market-maker');

function formatLocalTimestampForFilename(date: Date): string {
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const mi = pad(date.getMinutes());
    const ss = pad(date.getSeconds());
    const ms = pad(date.getMilliseconds(), 3);
    return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}.${ms}`;
}

try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {
    // ignore
}

const LOG_FILE = path.resolve(LOG_DIR, `${formatLocalTimestampForFilename(RUN_START_TIME)}.log`);

function formatLocalTimestamp(date: Date): string {
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const mi = pad(date.getMinutes());
    const ss = pad(date.getSeconds());
    const ms = pad(date.getMilliseconds(), 3);

    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMinutes);
    const offH = pad(Math.floor(abs / 60));
    const offM = pad(abs % 60);

    // e.g. 2025-12-27 15:29:23.123+08:00
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms}${sign}${offH}:${offM}`;
}

function recordError(entry: ErrorEntry): void {
    recentErrors.push(entry);
    if (recentErrors.length > MAX_ERRORS) {
        recentErrors.splice(0, recentErrors.length - MAX_ERRORS);
    }

    const line = `[${formatLocalTimestamp(entry.time)}]` +
        (entry.marketId !== null ? ` [${entry.marketId}]` : '') +
        ` ${entry.message}\r\n`;

    try {
        fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch {
        // 忽略写入失败
    }

    pushUISnapshot();
}

function appendLogLine(level: 'INFO' | 'OBS', marketId: number | null, message: string): void {
    const line = `[${formatLocalTimestamp(new Date())}]` +
        (marketId !== null ? ` [${marketId}]` : '') +
        ` [${level}] ${message}\r\n`;
    try {
        fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch {
        // ignore
    }
}

function logObs(event: string, marketId: number | null, data: Record<string, unknown> = {}): void {
    appendLogLine('OBS', marketId, JSON.stringify({ event, ...data }));
}

function extractMarketIdFromLog(args: unknown[]): number | null {
    const text = args.map(a => {
        if (a instanceof Error) return a.message;
        return String(a);
    }).join(' ');
    const m = text.match(/\[MM\s+(\d+)\]/);
    return m ? Number(m[1]) : null;
}

// 将 console.error / console.warn 也写入 recentErrors + market-maker.log，
// 避免 dashboard 清屏导致“错误日志被刷掉”的观感。
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
    recordError({
        time: new Date(),
        marketId: extractMarketIdFromLog(args),
        message: args.map(a => a instanceof Error ? (a.stack ?? a.message) : String(a)).join(' '),
    });
    originalConsoleError(...(args as any[]));
};

const originalConsoleWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
    recordError({
        time: new Date(),
        marketId: extractMarketIdFromLog(args),
        message: `WARN: ${args.map(a => a instanceof Error ? (a.message) : String(a)).join(' ')}`,
    });
    originalConsoleWarn(...(args as any[]));
};

process.on('unhandledRejection', (reason) => {
    recordError({
        time: new Date(),
        marketId: null,
        message: `UnhandledRejection: ${String(reason)}`,
    });
});

process.on('uncaughtException', (error) => {
    recordError({
        time: new Date(),
        marketId: null,
        message: `UncaughtException: ${(error as Error)?.message ?? String(error)}`,
    });
});

// ============================================================================
// React 渲染支持
// ============================================================================

const EMPTY_STATS: GlobalStats = {
    totalMarkets: 0,
    runningMarkets: 0,
    totalFills: 0,
    totalVolume: 0,
    totalRealizedPnL: 0,
    startTime: null,
};

function buildUISnapshot(): UISnapshot {
    const stats = multiMaker?.getGlobalStats() ?? EMPTY_STATS;
    const marketsRaw = multiMaker?.getAllStates() ?? [];
    const markets = marketsRaw.map(m => {
        const cfg = configByMarketId.get(m.marketId);
        return {
            ...m,
            outcome: (cfg?.outcome ?? 'YES') as 'YES' | 'NO',
            maxShares: cfg?.maxShares ?? 0,
        };
    });
    return {
        timestamp: Date.now(),
        globalStats: stats,
        markets,
        fills: [...fills],
        errors: [...recentErrors],
        logFile: LOG_FILE,
    };
}

function pushUISnapshot(): void {
    uiEmitter.emit('update', buildUISnapshot());
}

// ============================================================================
// 价格运行区间（可选）：通过环境变量设置
// ============================================================================

function parsePriceBound(raw: string | undefined): number | undefined {
    if (!raw) return undefined;
    const v = Number.parseFloat(raw.replace(',', '.'));
    if (!Number.isFinite(v)) return undefined;
    // 允许输入 cents（例如 72.3），自动转换为 0-1 区间
    const normalized = v > 1 ? v / 100 : v;
    if (!Number.isFinite(normalized) || normalized <= 0 || normalized >= 1) return undefined;
    return normalized;
}

function getPerMarketEnv(marketId: number, key: string): string | undefined {
    return process.env[`${key}_${marketId}`] ?? process.env[key];
}

// ============================================================================
// 策略选择
// ============================================================================

import * as readline from 'readline';

async function selectStrategy(): Promise<MarketMakerStrategy> {
    // 如果环境变量已设置，直接使用
    const envStrategy = (process.env.MM_STRATEGY || '').toUpperCase();
    if (envStrategy === 'SCALP' || envStrategy === 'FOLLOW') {
        return envStrategy as MarketMakerStrategy;
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        console.log(`\n${c.bold}${c.cyan}═══ 选择策略模式 ═══${c.reset}\n`);
        console.log(`  ${c.cyan}1${c.reset}  跟随模式 (FOLLOW) - 卖出价 = 卖一价`);
        console.log(`      ${c.dim}跟随市场最优卖价，适合流动性较好的市场${c.reset}\n`);
        console.log(`  ${c.cyan}2${c.reset}  剥头皮 (SCALP) - 卖出价 = 买一价 + 1 tick`);
        console.log(`      ${c.dim}Maker 0 手续费，每笔成交净赚 1 tick${c.reset}\n`);

        rl.question(`${c.cyan}请选择 [1/2]: ${c.reset}`, (answer) => {
            rl.close();
            const choice = answer.trim();
            if (choice === '2' || choice.toLowerCase() === 'scalp') {
                console.log(`\n${c.green}✓ 已选择: 剥头皮模式 (SCALP)${c.reset}\n`);
                resolve('SCALP');
            } else {
                console.log(`\n${c.green}✓ 已选择: 跟随模式 (FOLLOW)${c.reset}\n`);
                resolve('FOLLOW');
            }
        });
    });
}

// ============================================================================
// 配置恢复
// ============================================================================

interface RestoredConfig {
    configs: MarketMakerConfig[];
    strategy: MarketMakerStrategy;
}

/**
 * 检查是否有上次保存的配置，询问用户是否恢复
 */
async function checkAndRestoreConfig(): Promise<RestoredConfig | null> {
    // 环境变量跳过恢复询问
    const skipRestore = (process.env.MM_SKIP_RESTORE || '').trim();
    if (skipRestore === '1' || skipRestore.toLowerCase() === 'true') {
        return null;
    }

    const saved = loadConfig(BOT_DIR);
    if (!saved || !saved.markets || saved.markets.length === 0) {
        return null;
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        console.log(`\n${c.bold}${c.yellow}═══ 检测到上次配置 ═══${c.reset}\n`);
        console.log(formatConfigSummary(saved));
        console.log();

        rl.question(`${c.cyan}是否恢复上次配置? [Y/n]: ${c.reset}`, (answer) => {
            rl.close();
            const choice = answer.trim().toLowerCase();

            if (choice === '' || choice === 'y' || choice === 'yes') {
                console.log(`\n${c.green}✓ 已恢复上次配置${c.reset}\n`);
                resolve({
                    configs: saved.markets,
                    strategy: saved.strategy,
                });
            } else {
                console.log(`\n${c.dim}跳过恢复，进入新配置流程${c.reset}\n`);
                resolve(null);
            }
        });
    });
}

// ============================================================================
// 主程序
// ============================================================================

async function main(): Promise<void> {
    console.log(`${c.bold}${c.cyan}═══════════════════════════════════════════════════════════${c.reset}`);
    console.log(`${c.bold}${c.cyan}                  PREDICT 做市机器人                        ${c.reset}`);
    console.log(`${c.bold}${c.cyan}═══════════════════════════════════════════════════════════${c.reset}\n`);

    try {
        initTelegram();

        // 0. 检查是否恢复上次配置
        const restored = await checkAndRestoreConfig();

        let configs: MarketMakerConfig[];
        let strategy: MarketMakerStrategy;

        if (restored) {
            // 使用恢复的配置
            configs = restored.configs;
            strategy = restored.strategy;

            // 初始化交易客户端（用于后续交易）
            console.log(`${c.cyan}初始化交易客户端...${c.reset}`);
            tradingClient = createTradingClient();
            await tradingClient.init();

            // 显示余额
            const balance = await tradingClient.getBalance();
            console.log(`${c.green}USDT 余额: ${balance.toFixed(2)}${c.reset}\n`);
        } else {
            // 1. 选择策略模式
            strategy = await selectStrategy();

            // 2. 初始化交易客户端
            console.log(`${c.cyan}初始化交易客户端...${c.reset}`);
            tradingClient = createTradingClient();
            await tradingClient.init();

            // 显示余额
            const balance = await tradingClient.getBalance();
            console.log(`${c.green}USDT 余额: ${balance.toFixed(2)}${c.reset}\n`);

            let selectedMarkets: SelectedMarket[] = [];

            // 3. 选择市场（支持非交互模式：MM_MARKETS=696,743 MM_MAX_SHARES=100）
            const envMarkets = (process.env.MM_MARKETS || '').trim();
            if (envMarkets) {
                const ids = envMarkets
                    .split(',')
                    .map(s => s.trim())
                    .filter(Boolean)
                    .map(s => Number(s))
                    .filter(n => Number.isFinite(n) && n > 0);

                if (ids.length === 0) {
                    throw new Error(`MM_MARKETS 格式错误: ${envMarkets}`);
                }

                const defaultMaxShares = Number(process.env.MM_MAX_SHARES || '100');
                const fetchMarket = async (marketId: number): Promise<MarketInfo> => {
                    const res = await fetch(`${baseUrl}/v1/markets/${marketId}`, {
                        headers: { 'x-api-key': scanApiKey },
                    });
                    if (!res.ok) {
                        throw new Error(`获取市场 ${marketId} 失败: ${res.status}`);
                    }
                    const data = await res.json() as any;
                    const m = data.data;
                    const outcomes: Array<{ name: string; onChainId: string }> = m?.outcomes || [];
                    const yes = outcomes.find(o => o.name === 'Yes') || outcomes[0];
                    const outcomeNames = outcomes.map(o => o.name);

                    return {
                        id: m.id,
                        title: m.title || '',
                        question: m.question || '',
                        status: m.status || '',
                        feeRateBps: m.feeRateBps || 0,
                        isNegRisk: Boolean(m.isNegRisk),
                        isYieldBearing: Boolean(m.isYieldBearing),
                        conditionId: m.conditionId || '',
                        tokenIdYes: yes?.onChainId || '',
                        volume24h: m.volume24h,
                        outcomeNames,
                    };
                };

                // 默认 outcome（可通过 MM_OUTCOME=NO 覆盖）
                const defaultOutcome = (process.env.MM_OUTCOME || 'YES').toUpperCase() === 'NO' ? 'NO' : 'YES';

                for (const marketId of ids) {
                    const market = await fetchMarket(marketId);
                    const perMarketEnv = process.env[`MM_MAX_SHARES_${marketId}`];
                    const maxShares = Number(perMarketEnv || defaultMaxShares) || defaultMaxShares;
                    // 支持单独设置每个市场的 outcome: MM_OUTCOME_696=NO
                    const perMarketOutcome = process.env[`MM_OUTCOME_${marketId}`];
                    const outcome = perMarketOutcome
                        ? (perMarketOutcome.toUpperCase() === 'NO' ? 'NO' : 'YES') as import('./types.js').OutcomeChoice
                        : defaultOutcome as import('./types.js').OutcomeChoice;
                    selectedMarkets.push({ market, maxShares, outcome });
                }

                console.log(`${c.green}已从环境变量选择 ${selectedMarkets.length} 个市场: ${ids.join(', ')}${c.reset}\n`);
            } else {
                // 3a. 扫描市场（使用扫描专用 API Key）
                const markets = await scanMarkets(scanApiKey, baseUrl);

                if (markets.length === 0) {
                    console.log(`${c.red}未找到活跃市场${c.reset}`);
                    process.exit(0);
                }

                // 3b. 显示市场列表
                displayMarketList(markets);

                // 3c. 选择市场
                selectedMarkets = await selectMarkets(markets, 100);
            }

            if (selectedMarkets.length === 0) {
                console.log(`${c.yellow}未选择任何市场，退出${c.reset}`);
                process.exit(0);
            }

            // 4. 转换为配置（使用交易客户端获取 Token ID 和 TickSize）
            const getTokenId = async (marketId: number, outcome: import('./types.js').OutcomeChoice) => {
                return tradingClient!.getTokenId(marketId, outcome);
            };
            const getTickSize = async (marketId: number) => {
                return tradingClient!.getMarketTickSize(marketId);
            };
            configs = await convertToConfigs(selectedMarkets, getTokenId, strategy, getTickSize);

            if (configs.length === 0) {
                console.log(`${c.red}配置生成失败${c.reset}`);
                process.exit(1);
            }

            // 保存配置供下次使用
            try {
                saveConfig({
                    global: DEFAULT_GLOBAL_CONFIG,
                    markets: configs,
                    strategy,
                    savedAt: new Date().toISOString(),
                }, BOT_DIR);
                console.log(`${c.dim}配置已保存，下次启动可快速恢复${c.reset}\n`);
            } catch (saveErr) {
                console.warn(`${c.yellow}配置保存失败: ${(saveErr as Error)?.message}${c.reset}`);
            }
        }

        // 5. 创建多市场管理器（使用交易客户端的依赖）
        const dependencies = tradingClient.createDependencies();

        // 价格运行区间（可选）：MM_MIN_SELL_PRICE / MM_MAX_BUY_PRICE
        // 支持按市场覆盖：MM_MIN_SELL_PRICE_696 / MM_MAX_BUY_PRICE_696
        // 最大价差阈值（可选）：MM_MAX_SPREAD_CENTS / MM_MAX_SPREAD_CENTS_696
        for (const cfg of configs) {
            const rawMinSell = getPerMarketEnv(cfg.marketId, 'MM_MIN_SELL_PRICE');
            const rawMaxBuy = getPerMarketEnv(cfg.marketId, 'MM_MAX_BUY_PRICE');
            const rawMaxSpread = getPerMarketEnv(cfg.marketId, 'MM_MAX_SPREAD_CENTS');
            const minSell = parsePriceBound(rawMinSell);
            const maxBuy = parsePriceBound(rawMaxBuy);

            // 解析 maxSpreadCents（美分单位，例如 5 表示 5¢）
            let maxSpreadCents: number | undefined;
            if (rawMaxSpread) {
                const v = Number.parseFloat(rawMaxSpread);
                if (Number.isFinite(v) && v > 0) {
                    maxSpreadCents = v;
                } else {
                    console.warn(`[MM ${cfg.marketId}] MM_MAX_SPREAD_CENTS 无效: ${rawMaxSpread}`);
                }
            }

            if (rawMinSell && minSell === undefined) {
                console.warn(`[MM ${cfg.marketId}] MM_MIN_SELL_PRICE 无效: ${rawMinSell}`);
            }
            if (rawMaxBuy && maxBuy === undefined) {
                console.warn(`[MM ${cfg.marketId}] MM_MAX_BUY_PRICE 无效: ${rawMaxBuy}`);
            }

            if (minSell !== undefined) cfg.minSellPrice = minSell;
            if (maxBuy !== undefined) cfg.maxBuyPrice = maxBuy;
            if (maxSpreadCents !== undefined) cfg.maxSpreadCents = maxSpreadCents;

            configByMarketId.set(cfg.marketId, cfg);
            if (minSell !== undefined || maxBuy !== undefined || maxSpreadCents !== undefined) {
                logObs('BOUNDS', cfg.marketId, {
                    minSellPrice: minSell ?? null,
                    maxBuyPrice: maxBuy ?? null,
                    maxSpreadCents: maxSpreadCents ?? null,
                });
            }
        }

        // 可观测性：价格快照日志节流（默认 10s/市场）
        const priceLogEveryMs = Math.max(1000, Number(process.env.MM_OBS_PRICE_EVERY_MS || '10000'));
        const lastPriceLogAt: Map<number, number> = new Map();

        multiMaker = new MultiMarketMaker(
            dependencies,
            { pollIntervalMs: 1000 },
            {
                onMarketStateChange: (marketId, state) => {
                    const prevKey = lastStatusByMarket.get(marketId) ?? '';
                    const prevStatus = prevKey.split('|', 1)[0];
                    const nextKey = `${state.status}|${state.errorMessage ?? ''}`;
                    if (prevKey === nextKey) return;
                    lastStatusByMarket.set(marketId, nextKey);

                    logObs('STATE_CHANGE', marketId, {
                        status: state.status,
                        position: state.position,
                        bestBid: state.lastBestBid,
                        bestAsk: state.lastBestAsk,
                        spread: state.lastSpread,
                        errorMessage: state.errorMessage ?? null,
                    });

                    if (state.status === 'error' || state.status === 'paused' || state.status === 'range_paused') {
                        void tgSend(
                            `[MM ${marketId}] 状态=${state.status} 持仓=${state.position} 买一=${formatCentsPlain(state.lastBestBid)} 卖一=${formatCentsPlain(state.lastBestAsk)}` +
                            (state.errorMessage ? `\n原因: ${state.errorMessage}` : '')
                        );
                    } else if (prevStatus && (prevStatus === 'paused' || prevStatus === 'error' || prevStatus === 'range_paused') && state.status === 'running') {
                        void tgSend(`[MM ${marketId}] 已恢复运行`);
                    }

                    pushUISnapshot();
                },
                onFill: (fill) => {
                    fills.push(fill);
                    // 只保留最近 100 条
                    if (fills.length > 100) {
                        fills.shift();
                    }

                    const title = multiMaker?.getMarketState(fill.marketId)?.title ?? String(fill.marketId);
                    logObs('FILL', fill.marketId, {
                        side: fill.side,
                        price: fill.price,
                        quantity: fill.quantity,
                        filledAt: fill.filledAt.toISOString(),
                        orderId: fill.orderId,
                        title,
                    });
                    void tgSend(`[MM ${fill.marketId}] 成交 ${fill.side} ${fill.quantity} @ ${formatCentsPlain(fill.price)}\n市场: ${title}`);

                    pushUISnapshot();
                },
                onOrderPlaced: (marketId, order) => {
                    logObs('ORDER_PLACED', marketId, {
                        side: order.side,
                        price: order.price,
                        quantity: order.quantity,
                        orderId: order.id,
                        orderHash: order.hash,
                    });
                },
                onOrderCancelled: (marketId, orderId) => {
                    logObs('ORDER_CANCELLED', marketId, { orderId });
                },
                onPriceUpdate: (snapshot) => {
                    const last = lastPriceLogAt.get(snapshot.marketId) ?? 0;
                    const now = Date.now();
                    if (now - last < priceLogEveryMs) return;
                    lastPriceLogAt.set(snapshot.marketId, now);
                    logObs('PRICE', snapshot.marketId, {
                        bestBid: snapshot.bestBid,
                        bestBidSize: snapshot.bestBidSize,
                        bestAsk: snapshot.bestAsk,
                        bestAskSize: snapshot.bestAskSize,
                        spread: snapshot.spread,
                        spreadPercent: snapshot.spreadPercent,
                        ts: snapshot.timestamp.toISOString(),
                    });
                },
                onMarketError: (marketId, error) => {
                    recordError({
                        time: new Date(),
                        marketId,
                        message: error.message,
                    });

                    // throttle: same error per market per 60s
                    const key = `${marketId}:${error.message}`;
                    const now = Date.now();
                    const last = lastTgErrorAt.get(key) ?? 0;
                    if (now - last >= 60_000) {
                        lastTgErrorAt.set(key, now);
                        void tgSend(`[MM ${marketId}] 错误: ${error.message}`);
                    }

                    pushUISnapshot();
                },
            }
        );

        // 可观测性：定期写入状态快照（默认 15s，可通过 MM_OBS_SNAPSHOT_SEC 调整）
        const snapshotSec = Math.max(1, Number(process.env.MM_OBS_SNAPSHOT_SEC || '15'));
        const snapshotTimer = setInterval(() => {
            if (!multiMaker) return;
            const states = multiMaker.getAllStates();
            for (const st of states) {
                const cfg = configByMarketId.get(st.marketId);
                logObs('STATE', st.marketId, {
                    status: st.status,
                    position: st.position,
                    bestBid: st.lastBestBid,
                    bestAsk: st.lastBestAsk,
                    spread: st.lastSpread,
                    buyOrder: st.activeBuyOrder ? { id: st.activeBuyOrder.id, price: st.activeBuyOrder.price, qty: st.activeBuyOrder.quantity, filled: st.activeBuyOrder.filledQuantity } : null,
                    sellOrder: st.activeSellOrder ? { id: st.activeSellOrder.id, price: st.activeSellOrder.price, qty: st.activeSellOrder.quantity, filled: st.activeSellOrder.filledQuantity } : null,
                    bounds: cfg ? { minSellPrice: cfg.minSellPrice ?? null, maxBuyPrice: cfg.maxBuyPrice ?? null } : null,
                    errorMessage: st.errorMessage ?? null,
                });
            }
        }, snapshotSec * 1000);
        snapshotTimer.unref?.();

        // 6. 添加市场
        for (const config of configs) {
            multiMaker.addMarket(config);
        }

        // 7. 启动
        console.log(`\n${c.cyan}正在启动做市引擎...${c.reset}\n`);
        await multiMaker.start();

        void tgSend(
            `[MM] 已启动 strategy=${strategy} markets=${configs.length}\n` +
            configs.map(cfg => {
                const bounds = (cfg.minSellPrice !== undefined || cfg.maxBuyPrice !== undefined)
                    ? ` bounds=[${cfg.minSellPrice ?? '-'}..${cfg.maxBuyPrice ?? '-'}]`
                    : '';
                const spread = cfg.maxSpreadCents !== undefined ? ` spread<${cfg.maxSpreadCents}c` : '';
                return `[${cfg.marketId}] ${cfg.title} ${cfg.outcome} ${cfg.strategy} max=${cfg.maxShares}${bounds}${spread}`;
            }).join('\n')
        );

        // 8. 启动监控面板 (React)
        pushUISnapshot();
        uiInstance = render(<MarketMakerUI emitter={uiEmitter} initialSnapshot={buildUISnapshot()} />);
        const uiTimer = setInterval(() => pushUISnapshot(), 1000);
        uiTimer.unref?.();

        // 9. 处理退出
        process.on('SIGINT', async () => {
            clearInterval(uiTimer);
            uiInstance?.unmount();

            console.log(`\n\n${c.cyan}正在停止...${c.reset}`);

            if (multiMaker) {
                await multiMaker.stop();
            }

            await tgSend('[MM] 已停止 (SIGINT)');
            console.log(`${c.green}已安全退出${c.reset}`);
            process.exit(0);
        });

        // 保持运行
        await new Promise(() => { });

    } catch (error) {
        recordError({
            time: new Date(),
            marketId: null,
            message: `Fatal: ${(error as Error)?.message ?? String(error)}`,
        });
        await tgSend(`[MM] Fatal: ${(error as Error)?.message ?? String(error)}`);
        console.error(`${c.red}错误:${c.reset}`, error);
        process.exit(1);
    }
}

main();
