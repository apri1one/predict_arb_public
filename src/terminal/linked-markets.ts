/**
 * Display Cross-Platform Markets: Predict <-> Polymarket
 * Two arbitrage calculation methods:
 * 1. Taker: predict_yes_ask + polymarket_no_ask + predict_fee <= 100
 * 2. Maker: predict_yes_bid + polymarket_no_ask <= 100
 */

import * as fs from 'fs';
import * as path from 'path';

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

interface PredictMarket {
    id: number;
    title: string;
    status: string;
    polymarketConditionIds: string[];
    feeRateBps: number;  // Fee in basis points, e.g. 200 = 2%
}

interface PredictOrderBook {
    bids: [number, number][];
    asks: [number, number][];
}

interface PolyBook {
    bids: { price: string; size: string }[];
    asks: { price: string; size: string }[];
}

interface PolyMarket {
    question: string;
    conditionId: string;
    clobTokenIds: string;  // JSON array with [YES_token, NO_token]
}

// Known event slugs
const KNOWN_SLUGS = [
    'boxing-jake-paul-vs-anthony-joshua-third-option-included',
    'epstein-files',
    'bitcoin-100k',
    'avatar-3',
];

// Get Polymarket market info
async function getPolymarketMarket(conditionId: string): Promise<PolyMarket | null> {
    const allMarkets: PolyMarket[] = [];

    try {
        const eventsRes = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&limit=200');
        const events = await eventsRes.json() as any[];
        for (const event of events) {
            if (event.markets) {
                for (const m of event.markets) {
                    if (m.conditionId) {
                        allMarkets.push({
                            question: m.question,
                            conditionId: m.conditionId,
                            clobTokenIds: m.clobTokenIds
                        });
                    }
                }
            }
        }
    } catch (error) {
        console.error('[Polymarket] Failed to fetch events:', error);
    }

    for (const slug of KNOWN_SLUGS) {
        try {
            const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
            const events = await res.json() as any[];
            for (const event of events) {
                if (event.markets) {
                    for (const m of event.markets) {
                        if (m.conditionId && !allMarkets.find(x => x.conditionId === m.conditionId)) {
                            allMarkets.push({
                                question: m.question,
                                conditionId: m.conditionId,
                                clobTokenIds: m.clobTokenIds
                            });
                        }
                    }
                }
            }
        } catch { }
    }

    return allMarkets.find(m => m.conditionId?.toLowerCase() === conditionId.toLowerCase()) || null;
}

// Get Polymarket orderbook for a specific token
async function getPolyOrderbook(tokenId: string): Promise<{ bestBid: number; bestAsk: number; bidSize: number; askSize: number } | null> {
    try {
        const res = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
        if (!res.ok) return null;

        const book = await res.json() as PolyBook;
        const bids = book.bids || [];
        const asks = book.asks || [];

        // Polymarket: bids sorted ascending, asks sorted descending
        // Best bid = last in bids, Best ask = last in asks
        const bestBidEntry = bids.length > 0 ? bids[bids.length - 1] : null;
        const bestAskEntry = asks.length > 0 ? asks[asks.length - 1] : null;

        return {
            bestBid: bestBidEntry ? parseFloat(bestBidEntry.price) : 0,
            bestAsk: bestAskEntry ? parseFloat(bestAskEntry.price) : 0,
            bidSize: bestBidEntry ? parseFloat(bestBidEntry.size) : 0,
            askSize: bestAskEntry ? parseFloat(bestAskEntry.size) : 0
        };
    } catch (error) {
        console.error('[Polymarket] Failed to fetch orderbook:', error);
    }
    return null;
}

/**
 * Calculate Predict taker fee
 * Formula: fee = BaseFee% × min(Price, 1 - Price) × (1 - rebate)
 * Predict 有 10% 返点，实际费率 = 名义费率 × 0.9
 */
const FEE_REBATE_PERCENT = 0.10;  // 10% 返点

function calculatePredictTakerFee(price: number, feeRateBps: number): number {
    const baseFeePercent = feeRateBps / 10000;  // bps to decimal
    const minPrice = Math.min(price, 1 - price);
    const grossFee = baseFeePercent * minPrice;
    return grossFee * (1 - FEE_REBATE_PERCENT);  // 扣除 10% 返点
}

async function main() {
    const apiKey = process.env.PREDICT_API_KEY!;
    const predictUrl = 'https://api.predict.fun';

    console.log('================================================================================');
    console.log('           CROSS-PLATFORM ARBITRAGE: Predict <-> Polymarket');
    console.log('           ' + new Date().toLocaleString());
    console.log('================================================================================');
    console.log('\n  Arbitrage Formulas:');
    console.log('  [TAKER] predict_yes_ask + poly_no_ask + predict_fee <= 100');
    console.log('  [MAKER] predict_yes_bid + poly_no_ask <= 100');

    // 1. Get active Predict markets with Polymarket links
    console.log('\n[1] Fetching Predict markets with active trades...');
    const matchRes = await fetch(`${predictUrl}/v1/orders/matches?first=100`, {
        headers: { 'x-api-key': apiKey }
    });
    const matchData = await matchRes.json() as { data?: { market: PredictMarket }[] };

    const linkedMarkets: PredictMarket[] = [];
    const seen = new Set<number>();
    for (const m of matchData.data || []) {
        if (m.market && !seen.has(m.market.id) && m.market.polymarketConditionIds?.length > 0) {
            seen.add(m.market.id);
            linkedMarkets.push(m.market);
        }
    }
    console.log(`    Found ${linkedMarkets.length} markets with Polymarket links`);

    // 2. Display comparison
    console.log('\n================================================================================');
    console.log('                      ORDERBOOK & ARBITRAGE ANALYSIS');
    console.log('================================================================================\n');

    let takerArbCount = 0;
    let makerArbCount = 0;

    for (const market of linkedMarkets) {
        const conditionId = market.polymarketConditionIds[0];
        const feeRateBps = market.feeRateBps || 200;  // Default 2% if not specified

        console.log(`[MARKET] ${market.title}`);
        console.log(`  Predict ID: ${market.id} | Fee: ${feeRateBps / 100}%`);

        // Get Predict orderbook
        let pYesBid = 0, pYesAsk = 0, pBidSize = 0, pAskSize = 0;
        try {
            const obRes = await fetch(`${predictUrl}/v1/markets/${market.id}/orderbook`, {
                headers: { 'x-api-key': apiKey }
            });
            if (obRes.ok) {
                const data = await obRes.json() as { data: PredictOrderBook };
                const pBook = data.data;
                if (pBook.bids?.length > 0) {
                    pYesBid = pBook.bids[0][0];
                    pBidSize = pBook.bids[0][1];
                }
                if (pBook.asks?.length > 0) {
                    pYesAsk = pBook.asks[0][0];
                    pAskSize = pBook.asks[0][1];
                }
            }
        } catch (error) {
            console.error('[Predict] Failed to fetch orderbook:', error);
        }

        // Get Polymarket market
        const polyMarket = await getPolymarketMarket(conditionId);
        let pmNoAsk = 0, pmNoBid = 0, pmNoAskSize = 0;

        if (polyMarket) {
            console.log(`  Polymarket: ${polyMarket.question.slice(0, 50)}...`);

            // Get NO token orderbook (second token in clobTokenIds)
            try {
                const tokenIds = JSON.parse(polyMarket.clobTokenIds);
                if (tokenIds.length >= 2) {
                    const noBook = await getPolyOrderbook(tokenIds[1]);
                    if (noBook) {
                        pmNoBid = noBook.bestBid;
                        pmNoAsk = noBook.bestAsk;
                        pmNoAskSize = noBook.askSize;
                    }
                }
            } catch (error) {
                console.error('[Polymarket] Failed to parse token IDs or fetch orderbook:', error);
            }
        } else {
            console.log(`  Polymarket: [NOT FOUND]`);
        }

        // Display orderbook comparison
        console.log('');
        console.log('  +-------------------------------+-------------------------------+');
        console.log('  |      PREDICT YES [c]          |      POLYMARKET NO [c]        |');
        console.log('  +-------------------------------+-------------------------------+');

        const pBidStr = pYesBid > 0 ? `${(pYesBid * 100).toFixed(1)}c x ${pBidSize.toFixed(0)}` : '---';
        const pmBidStr = pmNoBid > 0 ? `${(pmNoBid * 100).toFixed(1)}c x ---` : '---';
        console.log(`  | Best Bid: ${pBidStr.padEnd(18)} | Best Bid: ${pmBidStr.padEnd(18)} |`);

        const pAskStr = pYesAsk > 0 ? `${(pYesAsk * 100).toFixed(1)}c x ${pAskSize.toFixed(0)}` : '---';
        const pmAskStr = pmNoAsk > 0 ? `${(pmNoAsk * 100).toFixed(1)}c x ${pmNoAskSize.toFixed(0)}` : '---';
        console.log(`  | Best Ask: ${pAskStr.padEnd(18)} | Best Ask: ${pmAskStr.padEnd(18)} |`);
        console.log('  +-------------------------------+-------------------------------+');

        // Arbitrage calculations
        if (pYesBid > 0 && pYesAsk > 0 && pmNoAsk > 0) {
            console.log('');
            console.log('  [ARBITRAGE ANALYSIS]');

            // Calculate Predict taker fee for the YES ask price
            const predictFee = calculatePredictTakerFee(pYesAsk, feeRateBps);

            // Method 1: TAKER - Buy YES at ask on Predict + Buy NO at ask on Polymarket + fee
            const takerCost = pYesAsk + pmNoAsk + predictFee;
            const takerProfit = (1 - takerCost) * 100;

            console.log(`    [TAKER] Buy YES@Predict(${(pYesAsk * 100).toFixed(1)}c) + NO@Poly(${(pmNoAsk * 100).toFixed(1)}c) + Fee(${(predictFee * 100).toFixed(2)}c)`);
            console.log(`            Total Cost: ${(takerCost * 100).toFixed(1)}c  ${takerCost < 1 ? `>>> PROFIT: ${takerProfit.toFixed(2)}% <<<` : '(No arb)'}`);

            if (takerCost < 1) takerArbCount++;

            // Method 2: MAKER - Place limit order at bid on Predict + Buy NO at ask on Polymarket
            const makerCost = pYesBid + pmNoAsk;  // No fee for maker
            const makerProfit = (1 - makerCost) * 100;

            console.log(`    [MAKER] Limit YES@Predict(${(pYesBid * 100).toFixed(1)}c) + NO@Poly(${(pmNoAsk * 100).toFixed(1)}c)`);
            console.log(`            Total Cost: ${(makerCost * 100).toFixed(1)}c  ${makerCost < 1 ? `>>> PROFIT: ${makerProfit.toFixed(2)}% <<<` : '(No arb)'}`);

            if (makerCost < 1) makerArbCount++;
        }

        console.log('\n' + '-'.repeat(80) + '\n');
    }

    console.log('================================================================================');
    console.log(`  SUMMARY:`);
    console.log(`    ${linkedMarkets.length} markets with Polymarket links`);
    console.log(`    ${takerArbCount} TAKER arbitrage opportunities`);
    console.log(`    ${makerArbCount} MAKER arbitrage opportunities`);
    console.log('================================================================================');
}

main().catch(console.error);
