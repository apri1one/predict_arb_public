/**
 * Predict 做市模块 - 市场选择器
 *
 * 交互式选择要做市的市场
 */

import * as readline from 'readline';
import type { MarketMakerConfig, MarketMakerStrategy, OutcomeChoice } from './types.js';
import { mergeMarketConfig } from './config.js';

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
    cyan: '\x1b[36m',
};

// ============================================================================
// 市场信息
// ============================================================================

export interface MarketInfo {
    id: number;
    title: string;
    question: string;
    status: string;
    feeRateBps: number;
    isNegRisk: boolean;
    isYieldBearing: boolean;
    conditionId: string;
    tokenIdYes: string;       // 计算得出
    volume24h?: number;
    bestBid?: number;
    bestAsk?: number;
    outcomeNames?: string[];  // 各个 outcome 的名称 (index 0 = YES, index 1 = NO)
    decimalPrecision?: 2 | 3; // 价格精度 (2=0.01, 3=0.001)
}

export interface SelectedMarket {
    market: MarketInfo;
    maxShares: number;
    outcome: OutcomeChoice;
    // 价格运行区间（可选，0-1；也支持用户输入 cents 后自动 /100）
    maxBuyPrice?: number;
    minSellPrice?: number;
    // 最大价差阈值（可选，单位：美分）
    maxSpreadCents?: number;
}

// ============================================================================
// 市场扫描
// ============================================================================

export async function scanMarkets(
    apiKey: string,
    baseUrl: string = 'https://api.predict.fun'
): Promise<MarketInfo[]> {
    const markets: MarketInfo[] = [];
    let cursor: string | null = null;

    console.log(`${c.cyan}扫描 Predict 市场...${c.reset}`);

    while (true) {
        const url = cursor
            ? `${baseUrl}/v1/markets?first=150&after=${cursor}`
            : `${baseUrl}/v1/markets?first=150`;

        const res = await fetch(url, {
            headers: { 'x-api-key': apiKey },
        });

        if (!res.ok) {
            console.error(`${c.red}API 错误: ${res.status} ${res.statusText}${c.reset}`);
            const text = await res.text();
            console.error(`${c.dim}响应: ${text.slice(0, 200)}${c.reset}`);
            break;
        }

        // 使用与 arb-monitor 相同的响应结构
        const data = await res.json() as {
            success?: boolean;
            data?: any[];
            cursor?: string;
        };

        // 检查数据是否存在
        if (!data.success || !data.data) {
            console.error(`${c.red}API 返回失败${c.reset}`);
            console.error(`${c.dim}响应: ${JSON.stringify(data).slice(0, 200)}${c.reset}`);
            break;
        }

        for (const m of data.data) {
            // 跳过已结算的市场
            if (m.status === 'RESOLVED' || m.status === 'CANCELLED') continue;

            // 提取 outcome 名称
            const outcomeNames = m.outcomes?.map((o: { name: string }) => o.name) || ['Yes', 'No'];

            markets.push({
                id: m.id,
                title: m.title,
                question: m.question || m.title,
                status: m.status,
                feeRateBps: m.feeRateBps || 200,
                isNegRisk: m.isNegRisk || false,
                isYieldBearing: m.isYieldBearing || false,
                conditionId: m.conditionId || '',
                tokenIdYes: '', // 需要后续计算
                outcomeNames,
                decimalPrecision: m.decimalPrecision || 2,  // 价格精度 (默认 2)
            });
        }

        process.stdout.write(`\r${c.dim}  已扫描 ${markets.length} 个市场...${c.reset}`);

        // 检查是否有下一页
        if (!data.cursor || data.data.length < 150) {
            break;
        }
        cursor = data.cursor;
    }

    console.log(`\n${c.green}扫描完成: ${markets.length} 个市场${c.reset}`);
    return markets;
}

// ============================================================================
// 交互式选择
// ============================================================================

export async function selectMarkets(
    markets: MarketInfo[],
    defaultMaxShares: number = 100
): Promise<SelectedMarket[]> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const question = (prompt: string): Promise<string> => {
        return new Promise(resolve => rl.question(prompt, resolve));
    };

    const selected: SelectedMarket[] = [];

    console.log(`\n${c.bold}${c.cyan}═══ 市场选择 ═══${c.reset}`);
    console.log(`${c.dim}输入市场ID或搜索关键词，输入 'done' 完成选择${c.reset}\n`);

    const parsePriceBound = (raw: string): number | undefined => {
        const v = Number.parseFloat(raw.trim().replace(',', '.'));
        if (!Number.isFinite(v)) return undefined;
        const normalized = v > 1 ? v / 100 : v;
        if (!Number.isFinite(normalized) || normalized <= 0 || normalized >= 1) return undefined;
        return normalized;
    };

    while (true) {
        const input = await question(`${c.cyan}> ${c.reset}`);
        const trimmed = input.trim().toLowerCase();

        if (trimmed === 'done' || trimmed === 'd' || trimmed === '') {
            if (selected.length === 0) {
                console.log(`${c.yellow}请至少选择一个市场${c.reset}`);
                continue;
            }
            break;
        }

        if (trimmed === 'list' || trimmed === 'l') {
            // 显示已选择的市场
            if (selected.length === 0) {
                console.log(`${c.dim}未选择任何市场${c.reset}`);
            } else {
                console.log(`\n${c.bold}已选择的市场:${c.reset}`);
                for (const s of selected) {
                    const outcomeColor = s.outcome === 'YES' ? c.green : c.red;
                    const bounds =
                        (s.minSellPrice !== undefined || s.maxBuyPrice !== undefined)
                            ? ` 区间=[${(s.minSellPrice ?? '-').toString()}..${(s.maxBuyPrice ?? '-').toString()}]`
                            : '';
                    const spread = s.maxSpreadCents !== undefined ? ` spread<${s.maxSpreadCents}c` : '';
                    console.log(`  ${c.cyan}[${s.market.id}]${c.reset} ${s.market.title} [${outcomeColor}${s.outcome}${c.reset}] - ${s.maxShares} shares${bounds}${spread}`);
                }
                console.log();
            }
            continue;
        }

        if (trimmed === 'help' || trimmed === 'h') {
            console.log(`
${c.bold}命令:${c.reset}
  ${c.cyan}<市场ID>${c.reset}     选择指定ID的市场
  ${c.cyan}<关键词>${c.reset}     搜索市场
  ${c.cyan}list${c.reset}         显示已选择的市场
  ${c.cyan}done${c.reset}         完成选择
  ${c.cyan}help${c.reset}         显示帮助
`);
            continue;
        }

        // 尝试作为 ID
        const marketId = parseInt(trimmed);
        if (!isNaN(marketId)) {
            const market = markets.find(m => m.id === marketId);
            if (market) {
                // 检查是否已选择
                if (selected.some(s => s.market.id === marketId)) {
                    console.log(`${c.yellow}市场已选择${c.reset}`);
                    continue;
                }

                // 询问做市方向 - 显示实际的 outcome 名称
                const names = market.outcomeNames || ['Yes', 'No'];
                const name1 = names[0] || 'Yes';
                const name2 = names[1] || 'No';
                console.log(`\n  ${c.cyan}1${c.reset} ${c.green}${name1}${c.reset}  ${c.cyan}2${c.reset} ${c.red}${name2}${c.reset}`);
                const outcomeInput = await question(`  做市方向 [1/2] (默认 1): `);
                const outcome: OutcomeChoice = outcomeInput.trim() === '2' ? 'NO' : 'YES';
                const selectedName = outcome === 'YES' ? name1 : name2;

                // 询问最大持仓
                const sharesInput = await question(`  最大持仓 (默认 ${defaultMaxShares}): `);
                const maxShares = parseInt(sharesInput) || defaultMaxShares;

                // 可选：价格运行区间
                console.log(`${c.dim}  可选：设置做市价格运行区间（超出则暂停下单，回到区间自动恢复）${c.reset}`);
                console.log(`${c.dim}  - 买一价不高于：输入 0-1 或 72.3(¢)，回车跳过${c.reset}`);
                console.log(`${c.dim}  - 卖一价不低于：输入 0-1 或 72.3(¢)，回车跳过${c.reset}`);

                const maxBuyInput = await question(`  买一价上限 (可选): `);
                const minSellInput = await question(`  卖一价下限 (可选): `);

                // 最大价差阈值
                console.log(`${c.dim}  - 最大价差：价差超过此值时暂停买单，输入美分数（如 5 表示 5¢），回车跳过${c.reset}`);
                const maxSpreadInput = await question(`  最大价差 (可选): `);

                const maxBuyPrice = maxBuyInput.trim() ? parsePriceBound(maxBuyInput) : undefined;
                const minSellPrice = minSellInput.trim() ? parsePriceBound(minSellInput) : undefined;

                // 解析 maxSpreadCents
                let maxSpreadCents: number | undefined;
                if (maxSpreadInput.trim()) {
                    const v = Number.parseFloat(maxSpreadInput.trim());
                    if (Number.isFinite(v) && v > 0) {
                        maxSpreadCents = v;
                    } else {
                        console.log(`${c.yellow}  最大价差输入无效，已忽略: ${maxSpreadInput.trim()}${c.reset}`);
                    }
                }

                if (maxBuyInput.trim() && maxBuyPrice === undefined) {
                    console.log(`${c.yellow}  买一价上限输入无效，已忽略: ${maxBuyInput.trim()}${c.reset}`);
                }
                if (minSellInput.trim() && minSellPrice === undefined) {
                    console.log(`${c.yellow}  卖一价下限输入无效，已忽略: ${minSellInput.trim()}${c.reset}`);
                }

                if (maxBuyPrice !== undefined && minSellPrice !== undefined && minSellPrice > maxBuyPrice) {
                    console.log(`${c.yellow}  区间无效（卖价下限 > 买价上限），已忽略本次区间设置${c.reset}`);
                    selected.push({ market, maxShares, outcome, maxSpreadCents });
                } else {
                    selected.push({ market, maxShares, outcome, maxBuyPrice, minSellPrice, maxSpreadCents });
                }

                const outcomeColor = outcome === 'YES' ? c.green : c.red;
                console.log(`${c.green}✓ 已添加: ${market.title} [${outcomeColor}${selectedName}${c.reset}${c.green}] (${maxShares} shares)${c.reset}`);
            } else {
                console.log(`${c.red}未找到市场 ID: ${marketId}${c.reset}`);
            }
            continue;
        }

        // 作为搜索关键词
        const keyword = trimmed;
        const results = markets.filter(m =>
            m.title.toLowerCase().includes(keyword) ||
            m.question.toLowerCase().includes(keyword)
        );

        if (results.length === 0) {
            console.log(`${c.dim}未找到匹配的市场${c.reset}`);
        } else if (results.length > 20) {
            console.log(`${c.yellow}找到 ${results.length} 个结果，请使用更精确的关键词${c.reset}`);
            // 只显示前 10 个
            for (const m of results.slice(0, 10)) {
                console.log(`  ${c.cyan}[${m.id}]${c.reset} ${m.title.slice(0, 50)}...`);
            }
        } else {
            console.log(`\n${c.bold}搜索结果 (${results.length}):${c.reset}`);
            for (const m of results) {
                const isSelected = selected.some(s => s.market.id === m.id);
                const prefix = isSelected ? `${c.green}✓${c.reset}` : ' ';
                console.log(`${prefix} ${c.cyan}[${m.id}]${c.reset} ${m.title}`);
            }
            console.log();
        }
    }

    rl.close();

    console.log(`\n${c.bold}${c.green}已选择 ${selected.length} 个市场${c.reset}`);
    return selected;
}

// ============================================================================
// 转换为配置
// ============================================================================

export async function convertToConfigs(
    selectedMarkets: SelectedMarket[],
    getTokenId: (marketId: number, outcome: OutcomeChoice) => Promise<string>,
    strategy: MarketMakerStrategy = 'FOLLOW',
    getTickSize?: (marketId: number) => Promise<number>
): Promise<MarketMakerConfig[]> {
    const configs: MarketMakerConfig[] = [];

    console.log(`\n${c.dim}计算 Token IDs...${c.reset}`);
    console.log(`${c.dim}策略模式: ${strategy === 'SCALP' ? '剥头皮 (SCALP)' : '跟随 (FOLLOW)'}${c.reset}`);

    for (const s of selectedMarkets) {
        try {
            const tokenId = await getTokenId(s.market.id, s.outcome);

            // 获取 tickSize：优先使用 getTickSize 回调，否则从 decimalPrecision 计算
            let tickSize: number;
            if (getTickSize) {
                tickSize = await getTickSize(s.market.id);
                console.log(`  ${c.dim}Market ${s.market.id} tickSize=${tickSize}${c.reset}`);
            } else {
                const decimalPrecision = s.market.decimalPrecision ?? 2;
                tickSize = Math.pow(10, -decimalPrecision);
            }

            const config = mergeMarketConfig(
                {
                    maxShares: s.maxShares,
                    feeRateBps: s.market.feeRateBps,
                    isNegRisk: s.market.isNegRisk,
                    isYieldBearing: s.market.isYieldBearing,
                    strategy,
                    outcome: s.outcome,
                    maxBuyPrice: s.maxBuyPrice,
                    minSellPrice: s.minSellPrice,
                    maxSpreadCents: s.maxSpreadCents,
                    tickSize,  // 使用实际精度
                },
                s.market.id,
                s.market.title,
                tokenId
            );

            configs.push(config);
            const outcomeColor = s.outcome === 'YES' ? c.green : c.red;
            console.log(`  ${c.green}✓${c.reset} ${s.market.id}: ${s.market.title} [${outcomeColor}${s.outcome}${c.reset}]`);
        } catch (error) {
            console.error(`  ${c.red}✗${c.reset} ${s.market.id}: 获取 TokenId 失败`);
        }
    }

    return configs;
}

// ============================================================================
// 快速选择（通过 ID 列表）
// ============================================================================

export function quickSelect(
    markets: MarketInfo[],
    marketIds: number[],
    defaultMaxShares: number = 100,
    defaultOutcome: OutcomeChoice = 'YES'
): SelectedMarket[] {
    const selected: SelectedMarket[] = [];

    for (const id of marketIds) {
        const market = markets.find(m => m.id === id);
        if (market) {
            selected.push({ market, maxShares: defaultMaxShares, outcome: defaultOutcome });
        }
    }

    return selected;
}

// ============================================================================
// 事件分组
// ============================================================================

export interface EventGroup {
    question: string;
    markets: MarketInfo[];
    isBinary: boolean;  // 二元事件 (YES/NO) 还是多选事件
}

/**
 * 按事件分组市场
 */
export function groupByEvent(markets: MarketInfo[]): EventGroup[] {
    const eventMap = new Map<string, MarketInfo[]>();

    for (const market of markets) {
        const key = market.question || `market-${market.id}`;
        if (!eventMap.has(key)) {
            eventMap.set(key, []);
        }
        eventMap.get(key)!.push(market);
    }

    const events: EventGroup[] = [];
    for (const [question, marketList] of eventMap) {
        events.push({
            question,
            markets: marketList,
            isBinary: marketList.length === 1,
        });
    }

    return events;
}

// ============================================================================
// 简化的市场列表显示（按事件分组）
// ============================================================================

export function displayMarketList(markets: MarketInfo[], limit: number = Infinity): void {
    const events = groupByEvent(markets);

    console.log(`\n${c.bold}${c.cyan}═══ 事件列表 (${events.length} 个事件, ${markets.length} 个市场) ═══${c.reset}\n`);

    let displayed = 0;
    for (const event of events) {
        if (displayed >= limit) break;

        const questionShort = event.question.length > 70 ? event.question.slice(0, 67) + '...' : event.question;

        if (event.isBinary) {
            // 二元事件
            const market = event.markets[0];
            console.log(`${c.green}[二元]${c.reset} ${c.cyan}ID:${market.id}${c.reset} ${questionShort}`);
        } else {
            // 多选事件
            console.log(`${c.yellow}[多选]${c.reset} ${questionShort} ${c.dim}(${event.markets.length} 个选项)${c.reset}`);
            for (const m of event.markets) {
                const optionShort = m.title.length > 50 ? m.title.slice(0, 47) + '...' : m.title;
                console.log(`    ${c.cyan}ID:${m.id}${c.reset} ${optionShort}`);
            }
        }
        console.log();
        displayed++;
    }

    if (events.length > limit) {
        console.log(`${c.dim}... 还有 ${events.length - limit} 个事件${c.reset}\n`);
    }
}
