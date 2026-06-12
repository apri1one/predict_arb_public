/**
 * 扫描所有 Predict 市场，找出有 Polymarket 链接的市场
 * 优先使用列表 API (/v1/markets)，仅在需要时才扫描 ID 范围
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) process.env[match[1].trim()] = match[2].trim();
        }
    }
}

loadEnv();

// 使用多个 API Key 轮换 (支持 SCAN_1 到 SCAN_10)
const apiKeys: string[] = [];
const scan1 = process.env.PREDICT_API_KEY_SCAN_1 || process.env.PREDICT_API_KEY_SCAN;
if (scan1) apiKeys.push(scan1);
for (let i = 2; i <= 10; i++) {
    const key = process.env[`PREDICT_API_KEY_SCAN_${i}`];
    if (key) apiKeys.push(key);
}
// Fallback: 主 key
if (apiKeys.length === 0) {
    const fallback = process.env.PREDICT_API_KEY;
    if (fallback) apiKeys.push(fallback);
}

let keyIndex = 0;
function getNextApiKey(): string {
    const key = apiKeys[keyIndex % apiKeys.length];
    keyIndex++;
    return key;
}

interface MarketMatch {
    predict: {
        id: number;
        title: string;
        question: string;
        conditionId: string;
        feeRateBps?: number;
        categorySlug?: string;
    };
    polymarket: {
        question: string;
        conditionId: string;
        active: boolean;
        closed: boolean;
        acceptingOrders: boolean;
        // 预缓存: 启动时无需再调 Polymarket API
        yesTokenId?: string;
        noTokenId?: string;
        tokenId?: string;       // Legacy: noTokenId || yesTokenId
        negRisk?: boolean;
        tickSize?: number;
        slug?: string;
    };
}

async function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

async function checkMarketForPolymarket(id: number): Promise<MarketMatch | null> {
    try {
        const res = await fetch(`https://api.predict.fun/v1/markets/${id}`, {
            headers: { 'x-api-key': getNextApiKey() }
        });

        if (!res.ok) return null;

        const data = await res.json() as any;
        const m = data.data;

        // 跳过不存在或已解决的市场
        if (!m || m.status !== 'REGISTERED') {
            return null;
        }

        if (!m.polymarketConditionIds || m.polymarketConditionIds.length === 0) {
            return null;
        }

        const conditionId = m.polymarketConditionIds[0];
        if (!conditionId || conditionId === '') return null;

        // 验证 Polymarket 市场是否存在且活跃
        const pmRes = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
        if (!pmRes.ok) return null;

        const pmData = await pmRes.json() as any;

        // 跳过已关闭或不接受订单的市场
        const isClosed = pmData.closed === true;
        const acceptingOrders = pmData.accepting_orders !== false;
        if (isClosed || !acceptingOrders) {
            return null;
        }

        // 检测 inverted 市场（问题方向相反）
        const predictQuestion = (m.question || m.title).toLowerCase();
        const pmQuestion = (pmData.question || '').toLowerCase();
        let inverted = false;
        let invertedReason = '';

        // FED 利率市场: Predict 问"会变吗", PM 问"不会变吗"
        if (predictQuestion.includes('change') && pmQuestion.includes('no change')) {
            inverted = true;
            invertedReason = "Predict问'会变吗'，Polymarket问'不会变吗'，方向相反";
        }

        // 提取 Polymarket token 信息
        let yesTokenId: string | undefined;
        let noTokenId: string | undefined;
        if (pmData.tokens && pmData.tokens.length > 0) {
            for (const token of pmData.tokens) {
                if (token.outcome?.toLowerCase() === 'yes') yesTokenId = token.token_id;
                else if (token.outcome?.toLowerCase() === 'no') noTokenId = token.token_id;
            }
            if (!yesTokenId && pmData.tokens[0]) yesTokenId = pmData.tokens[0].token_id;
            if (!noTokenId && pmData.tokens[1]) noTokenId = pmData.tokens[1].token_id;
        }

        const result: MarketMatch & { inverted?: boolean; invertedReason?: string } = {
            predict: {
                id: m.id,
                title: m.title,
                question: m.question || m.title,
                conditionId: conditionId,
                feeRateBps: m.feeRateBps || 200,
                categorySlug: m.categorySlug
            },
            polymarket: {
                question: pmData.question || m.title,
                conditionId: conditionId,
                active: true,
                closed: false,
                acceptingOrders: true,
                yesTokenId,
                noTokenId,
                tokenId: noTokenId || yesTokenId,
                negRisk: pmData.neg_risk === true,
                tickSize: parseFloat(pmData.minimum_tick_size || '0.01'),
                slug: pmData.market_slug || undefined,
            }
        };

        if (inverted) {
            result.inverted = true;
            result.invertedReason = invertedReason;
        }

        return result;
    } catch {
        return null;
    }
}

async function fetchAllMarkets(): Promise<any[]> {
    const allMarkets: any[] = [];
    let cursor: string | null = null;
    let page = 1;
    const pageSize = 100;

    console.log('📋 从列表 API 获取市场 (status=OPEN, 前置过滤已结算市场)...\n');

    while (true) {
        try {
            // status=OPEN: API 层过滤掉 RESOLVED 历史市场 (全量 36500+ → 活跃数百, 页数砍 95%+)
            // OPEN 含 REGISTERED/PAUSED 等中间态, 下游仍按 status === 'REGISTERED' 细筛
            const url = cursor
                ? `https://api.predict.fun/v1/markets?first=${pageSize}&status=OPEN&after=${cursor}`
                : `https://api.predict.fun/v1/markets?first=${pageSize}&status=OPEN`;

            const res = await fetch(url, {
                headers: { 'x-api-key': getNextApiKey() }
            });

            if (!res.ok) {
                console.error(`  ❌ API 错误: ${res.status} ${res.statusText}`);
                break;
            }

            const data = await res.json() as any;

            if (!data.success) {
                console.error(`  ❌ API 返回失败`);
                break;
            }

            const markets = data.data || [];

            if (markets.length === 0) break;

            allMarkets.push(...markets);
            console.log(`  页 ${page}: ${markets.length} 个市场 (总计: ${allMarkets.length})`);

            // 检查是否有下一页
            if (!data.cursor) break;

            cursor = data.cursor;
            page++;
            await sleep(50);
        } catch (error) {
            console.error(`  ❌ 获取第 ${page} 页失败:`, error);
            break;
        }
    }

    console.log(`\n✅ 共获取 ${allMarkets.length} 个市场\n`);
    return allMarkets;
}

async function main() {
    console.log('=== 扫描所有 Predict 市场的 Polymarket 链接 ===\n');
    console.log(`使用 ${apiKeys.length} 个 API Key 轮换\n`);

    // 先从列表 API 获取所有市场
    const allMarkets = await fetchAllMarkets();

    console.log('🔍 筛选有 Polymarket 链接的市场...\n');

    // 预筛选：只处理有 polymarketConditionIds 且活跃的市场
    const marketsToCheck = allMarkets.filter(m =>
        m.polymarketConditionIds?.length > 0 && m.status === 'REGISTERED'
    );
    console.log(`  预筛选后需检查: ${marketsToCheck.length} 个市场\n`);

    const matches: MarketMatch[] = [];
    let checked = 0;

    // 并发扫描：使用 worker 池模式，30 并发
    const CONCURRENCY = 30;
    let taskIdx = 0;

    async function worker(): Promise<(MarketMatch | null)[]> {
        const results: (MarketMatch | null)[] = [];
        while (true) {
            const myIdx = taskIdx++;
            if (myIdx >= marketsToCheck.length) return results;
            const m = marketsToCheck[myIdx];  // 列表 API 已包含完整数据，无需再调详情

            try {
                const conditionId = m.polymarketConditionIds?.[0];
                if (!conditionId) { results.push(null); checked++; continue; }

                // 只需验证 Polymarket 市场
                const pmRes = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
                if (!pmRes.ok) { results.push(null); checked++; continue; }

                const pmData = await pmRes.json() as any;
                if (pmData.closed === true || pmData.accepting_orders === false) { results.push(null); checked++; continue; }

                // 检测 inverted 市场（问题方向相反）
                const predictQuestion = (m.question || m.title || '').toLowerCase();
                const pmQuestion = (pmData.question || '').toLowerCase();
                let inverted = false;
                let invertedReason = '';

                // FED 利率市场: Predict 问"会变吗", PM 问"不会变吗" (或反过来)
                if (predictQuestion.includes('change') && pmQuestion.includes('no change')) {
                    inverted = true;
                    invertedReason = "Predict问'会变吗'，Polymarket问'不会变吗'，方向相反";
                } else if (predictQuestion.includes('no change') && pmQuestion.includes('change') && !pmQuestion.includes('no change')) {
                    inverted = true;
                    invertedReason = "Predict问'不会变吗'，Polymarket问'会变吗'，方向相反";
                }

                // 提取 Polymarket token 信息 (预缓存，启动时无需再调 API)
                let yesTokenId: string | undefined;
                let noTokenId: string | undefined;
                if (pmData.tokens && pmData.tokens.length > 0) {
                    for (const token of pmData.tokens) {
                        if (token.outcome?.toLowerCase() === 'yes') yesTokenId = token.token_id;
                        else if (token.outcome?.toLowerCase() === 'no') noTokenId = token.token_id;
                    }
                    if (!yesTokenId && pmData.tokens[0]) yesTokenId = pmData.tokens[0].token_id;
                    if (!noTokenId && pmData.tokens[1]) noTokenId = pmData.tokens[1].token_id;
                }

                const result: MarketMatch & { inverted?: boolean; invertedReason?: string } = {
                    predict: {
                        id: m.id,
                        title: m.title || m.question,
                        question: m.question,
                        conditionId: m.conditionId,
                        feeRateBps: m.feeRateBps,
                        categorySlug: m.categorySlug,  // 用于获取 Predict endsAt
                    },
                    polymarket: {
                        question: pmData.question || '',
                        conditionId,
                        active: pmData.active !== false,
                        closed: pmData.closed === true,
                        acceptingOrders: pmData.accepting_orders !== false,
                        yesTokenId,
                        noTokenId,
                        tokenId: noTokenId || yesTokenId,
                        negRisk: pmData.neg_risk === true,
                        tickSize: parseFloat(pmData.minimum_tick_size || '0.01'),
                        slug: pmData.market_slug || undefined,
                    }
                };

                if (inverted) {
                    result.inverted = true;
                    result.invertedReason = invertedReason;
                }

                results.push(result as MarketMatch);
                checked++;
                if (result) {
                    console.log(`    ✓ [${result.predict.id}] ${result.predict.title.substring(0, 50)}`);
                }
                process.stdout.write(`\r  进度: ${checked}/${marketsToCheck.length} | 已找到: ${matches.length + results.filter(Boolean).length}   `);
            } catch {
                results.push(null);
                checked++;
            }
        }
        return results;
    }

    // 启动 worker 池
    const workerResults = await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, marketsToCheck.length) }, () => worker())
    );

    // 收集结果
    for (const wr of workerResults) {
        for (const match of wr) {
            if (match) matches.push(match);
        }
    }

    console.log('\n');

    // 保存结果
    const outputPath = path.join(__dirname, '..', '..', 'polymarket-match-result.json');

    // 安全保护: 扫描结果为空时不覆盖已有的有效缓存 (防止 API 故障导致数据丢失)
    if (matches.length === 0 && fs.existsSync(outputPath)) {
        try {
            const existing = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
            if (existing.matches && existing.matches.length > 0) {
                console.log(`\n⚠️  扫描结果为空但已有 ${existing.matches.length} 个缓存市场，跳过覆盖`);
                console.log(`\n=== 扫描完成 (保留缓存) ===`);
                console.log(`  扫描 ID 数: ${checked}`);
                console.log(`  有 Polymarket 链接且活跃: 0 (API 可能故障)`);
                return;
            }
        } catch { /* 缓存解析失败，正常覆盖 */ }
    }

    const result = {
        timestamp: new Date().toISOString(),
        summary: {
            total: checked,
            matched: matches.length,
            failed: 0
        },
        matches: matches
    };

    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(`结果已保存到: ${outputPath}`);
    console.log(`\n=== 扫描完成 ===`);
    console.log(`  扫描 ID 数: ${checked}`);
    console.log(`  有 Polymarket 链接且活跃: ${matches.length}`);

    // 显示找到的市场
    console.log('\n=== 找到的市场 ===\n');
    for (const m of matches) {
        const status = m.polymarket.active && !m.polymarket.closed ? '活跃' : '已关闭';
        console.log(`  [${m.predict.id}] ${m.predict.title.substring(0, 50)} (${status})`);
    }
}

main().catch(console.error);
