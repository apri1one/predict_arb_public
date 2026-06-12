/**
 * Sports Market Matcher
 *
 * 匹配 Predict 和 Polymarket 的体育市场
 *
 * Polymarket Sports API:
 * - /sports: 获取所有体育类型元数据（包含 tag_id、series）
 * - /sports/market-types: 获取市场类型（moneyline, spreads, totals 等）
 * - /markets?tag_id={tagId}&sports_market_types={type}: 获取特定体育市场
 *
 * 主要体育 Tag IDs:
 * - NBA: 745 (series: 10345)
 * - NFL: 450 (series: 10187)
 * - NHL: 899 (series: 10346)
 * - MLB: n/a (series: 3)
 * - EPL: 82 (series: 10188)
 * - MMA/UFC: n/a (series: 10500)
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { PredictRestClient } from '../predict/rest-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(process.cwd(), '.env') });

// ============================================================================
// Types
// ============================================================================

interface PolySportsMetadata {
    id: number;
    sport: string;
    image: string;
    resolution: string;
    ordering: string;
    tags: string;
    series: string;
}

interface PolyMarket {
    id: string;
    question: string;
    conditionId: string;
    slug: string;
    outcomes: string;
    outcomePrices: string;
    clobTokenIds: string;
    endDate: string;
    liquidity: string;
    volume: string;
    active: boolean;
    closed: boolean;
    gameStartTime?: string;
}

interface MatchedMarket {
    predictId: number;
    predictTitle: string;
    predictCategorySlug: string;
    polymarketId: string;
    polymarketQuestion: string;
    polymarketConditionId: string;
    polymarketSlug: string;
    polymarketLiquidity: number;
    matchMethod: 'conditionId' | 'slug' | 'title';
}

// ============================================================================
// Polymarket Sports API
// ============================================================================

const POLY_SPORTS_TAGS: Record<string, number> = {
    nba: 745,
    nfl: 450,
    nhl: 899,
    epl: 82,
    ncaab: 1,  // NCAA Basketball shares tag 1
    lol: 65,   // League of Legends
};

const SPORTS_MARKET_TYPES = [
    'moneyline',      // 输赢
    'spreads',        // 让分
    'totals',         // 大小分
    'first_half_moneyline',
];

async function getPolySportsMetadata(): Promise<PolySportsMetadata[]> {
    const res = await fetch('https://gamma-api.polymarket.com/sports');
    return res.json() as Promise<PolySportsMetadata[]>;
}

async function getPolyMarkets(params: {
    tagId?: number;
    marketTypes?: string[];
    limit?: number;
}): Promise<PolyMarket[]> {
    let url = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=${params.limit || 100}`;

    if (params.tagId) {
        url += `&tag_id=${params.tagId}`;
    }

    if (params.marketTypes && params.marketTypes.length > 0) {
        url += `&sports_market_types=${params.marketTypes.join(',')}`;
    }

    const res = await fetch(url);
    return res.json() as Promise<PolyMarket[]>;
}

// ============================================================================
// Matching Logic
// ============================================================================

function matchByConditionId(
    predictMarkets: any[],
    polyMarkets: PolyMarket[]
): MatchedMarket[] {
    const matches: MatchedMarket[] = [];

    for (const pm of polyMarkets) {
        const matched = predictMarkets.find(m =>
            m.polymarketConditionIds?.includes(pm.conditionId)
        );

        if (matched) {
            matches.push({
                predictId: matched.id,
                predictTitle: matched.title,
                predictCategorySlug: matched.categorySlug,
                polymarketId: pm.id,
                polymarketQuestion: pm.question,
                polymarketConditionId: pm.conditionId,
                polymarketSlug: pm.slug,
                polymarketLiquidity: parseFloat(pm.liquidity),
                matchMethod: 'conditionId',
            });
        }
    }

    return matches;
}

function parsePolySlug(slug: string): { sport: string; team1: string; team2: string; date: string } | null {
    // Format: nba-mia-chi-2026-01-08
    const match = slug.match(/^([a-z]+)-([a-z]{2,4})-([a-z]{2,4})-(\d{4}-\d{2}-\d{2})$/i);
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

function matchBySlugPattern(
    predictMarkets: any[],
    polyMarkets: PolyMarket[]
): MatchedMarket[] {
    const matches: MatchedMarket[] = [];

    for (const pm of polyMarkets) {
        const parsed = parsePolySlug(pm.slug);
        if (!parsed) continue;

        // Predict categorySlug format: nba-sas-nyk-2025-12-16 or lol-tes-jdg-2026-01-14
        const dateCompact = parsed.date.replace(/-/g, '');

        const matched = predictMarkets.find(m => {
            const cat = (m.categorySlug || '').toLowerCase();
            return cat.includes(parsed.team1) &&
                   cat.includes(parsed.team2) &&
                   (cat.includes(parsed.date) || cat.includes(dateCompact));
        });

        if (matched && !matches.some(x => x.predictId === matched.id && x.polymarketId === pm.id)) {
            matches.push({
                predictId: matched.id,
                predictTitle: matched.title,
                predictCategorySlug: matched.categorySlug,
                polymarketId: pm.id,
                polymarketQuestion: pm.question,
                polymarketConditionId: pm.conditionId,
                polymarketSlug: pm.slug,
                polymarketLiquidity: parseFloat(pm.liquidity),
                matchMethod: 'slug',
            });
        }
    }

    return matches;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    const args = process.argv.slice(2);
    const sport = args[0]?.toLowerCase() || 'all';

    const client = new PredictRestClient();

    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║          Sports Market Matcher - Predict ↔ Polymarket       ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    // 1. 获取 Polymarket 体育元数据
    console.log('📊 Polymarket Sports Metadata:');
    const sportsMetadata = await getPolySportsMetadata();
    const mainSports = sportsMetadata.filter(s =>
        ['nba', 'nfl', 'nhl', 'mlb', 'epl', 'mma', 'lol'].includes(s.sport)
    );
    for (const s of mainSports) {
        const tagIds = s.tags.split(',').slice(0, 3).join(',');
        console.log(`   ${s.sport.toUpperCase().padEnd(5)} | tag_id in [${tagIds}] | series: ${s.series}`);
    }

    // 2. 获取 Predict 活跃市场
    console.log('\n📈 Fetching Predict active markets...');
    const predictMarkets = await client.getActiveMarkets(200);
    const linkedMarkets = predictMarkets.filter(m =>
        m.polymarketConditionIds && m.polymarketConditionIds.length > 0
    );

    const sportsKeywords = ['nba', 'nfl', 'nhl', 'mlb', 'epl', 'soccer', 'tennis', 'mma', 'ufc', 'match', 'lol', 'dota', 'cs'];
    const predictSportsMarkets = predictMarkets.filter(m => {
        const cat = (m.categorySlug || '').toLowerCase();
        const title = (m.title || '').toLowerCase();
        return sportsKeywords.some(k => cat.includes(k) || title.includes(k));
    });

    console.log(`   Total active: ${predictMarkets.length}`);
    console.log(`   With Poly link: ${linkedMarkets.length}`);
    console.log(`   Sports markets: ${predictSportsMarkets.length}`);

    // 3. 显示 Predict 体育市场
    if (predictSportsMarkets.length > 0) {
        console.log('\n📋 Predict Sports Markets:');
        console.log('─'.repeat(70));
        for (const m of predictSportsMarkets) {
            const polyIds = m.polymarketConditionIds?.length > 0
                ? `✓ Poly: ${m.polymarketConditionIds[0].slice(0, 20)}...`
                : '✗ No Poly link';
            console.log(`   [${m.id}] ${m.title}`);
            console.log(`         ${m.categorySlug} | ${m.status} | ${polyIds}`);
        }
    }

    // 4. 获取 Polymarket 体育市场
    const tagIds = sport === 'all'
        ? Object.values(POLY_SPORTS_TAGS)
        : [POLY_SPORTS_TAGS[sport] || 745];

    let allPolyMarkets: PolyMarket[] = [];

    console.log('\n📋 Fetching Polymarket sports markets...');
    for (const tagId of tagIds) {
        const markets = await getPolyMarkets({
            tagId,
            marketTypes: ['moneyline'],
            limit: 50,
        });
        allPolyMarkets = [...allPolyMarkets, ...markets];
    }

    // 去重
    const uniquePolyMarkets = Array.from(
        new Map(allPolyMarkets.map(m => [m.id, m])).values()
    );

    console.log(`   Total Polymarket sports markets: ${uniquePolyMarkets.length}`);

    // 5. 执行匹配
    console.log('\n🔗 Matching markets...');
    console.log('─'.repeat(70));

    // 方法 A: conditionId 匹配
    const conditionMatches = matchByConditionId(linkedMarkets, uniquePolyMarkets);
    console.log(`   Method A (conditionId): ${conditionMatches.length} matches`);

    // 方法 B: slug 模式匹配
    const slugMatches = matchBySlugPattern(predictSportsMarkets, uniquePolyMarkets);
    console.log(`   Method B (slug pattern): ${slugMatches.length} matches`);

    // 合并结果
    const allMatches = [...conditionMatches, ...slugMatches];
    const uniqueMatches = Array.from(
        new Map(allMatches.map(m => [`${m.predictId}-${m.polymarketId}`, m])).values()
    );

    console.log(`   Total unique matches: ${uniqueMatches.length}`);

    // 6. 显示匹配结果
    if (uniqueMatches.length > 0) {
        console.log('\n✅ Matched Markets:');
        console.log('═'.repeat(70));
        for (const match of uniqueMatches) {
            console.log(`   Predict [${match.predictId}]: ${match.predictTitle}`);
            console.log(`   Poly    [${match.polymarketId}]: ${match.polymarketQuestion}`);
            console.log(`   Method: ${match.matchMethod} | Liq: $${match.polymarketLiquidity.toFixed(0)}`);
            console.log(`   ConditionId: ${match.polymarketConditionId}`);
            console.log('─'.repeat(70));
        }
    } else {
        console.log('\n⚠️  No matches found.');
        console.log('   This may be because:');
        console.log('   - Predict has no active sports markets currently');
        console.log('   - Markets are not yet linked via polymarketConditionIds');
        console.log('   - Date/team format mismatch between platforms');
    }

    // 7. 显示未匹配的 Polymarket 市场（前 10 个）
    console.log('\n📊 Unmatched Polymarket Markets (sample):');
    console.log('─'.repeat(70));
    const unmatchedPoly = uniquePolyMarkets
        .filter(pm => !uniqueMatches.some(m => m.polymarketId === pm.id))
        .sort((a, b) => parseFloat(b.liquidity) - parseFloat(a.liquidity))
        .slice(0, 10);

    for (const pm of unmatchedPoly) {
        console.log(`   [${pm.id}] ${pm.question}`);
        console.log(`         ${pm.slug} | $${parseFloat(pm.liquidity).toFixed(0)} liquidity`);
    }
}

main().catch(console.error);
