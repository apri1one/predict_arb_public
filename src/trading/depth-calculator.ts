/**
 * Depth Calculator
 * 
 * Calculates the maximum arbitrage quantity available at current prices
 * 计算当前价格下可套利的最大数量
 */

export interface OrderBookLevel {
    price: number;
    size: number;
}

export interface DepthResult {
    // Can we arbitrage?
    hasArbitrage: boolean;

    // Prices
    predictYesBid: number;    // Best bid price on Predict (for MAKER mode)
    predictYesAsk: number;    // Best ask price on Predict (for TAKER mode)
    polymarketNoAsk: number;  // Best ask price for NO on Polymarket

    // Costs
    makerCost: number;        // predict_yes_bid + polymarket_no_ask
    takerCost: number;        // predict_yes_ask + polymarket_no_ask + fee
    predictFee: number;       // Taker fee on Predict

    // Profits
    makerProfit: number;      // 1 - makerCost (per share)
    takerProfit: number;      // 1 - takerCost (per share)

    // Depth-aware quantities (max shares available at these prices)
    makerMaxQuantity: number;
    takerMaxQuantity: number;

    // Detailed breakdown
    predictYesBidDepth: number;   // Shares available at bid
    predictYesAskDepth: number;   // Shares available at ask
    polymarketNoAskDepth: number; // Shares available at NO ask
}

/**
 * Calculate Predict taker fee per share
 * Formula: BaseFee% × min(Price, 1 - Price) × (1 - rebate)
 *
 * Predict 有 10% 返点，实际费率 = 名义费率 × 0.9
 * 例如: feeRateBps=200 (2%), 实际费率=1.8%
 */
const FEE_REBATE_PERCENT = 0.10;  // 10% 返点

export function calculatePredictFee(price: number, feeRateBps: number): number {
    const baseFeePercent = feeRateBps / 10000;
    const minPrice = Math.min(price, 1 - price);
    const grossFee = baseFeePercent * minPrice;
    return grossFee * (1 - FEE_REBATE_PERCENT);  // 扣除 10% 返点
}

/**
 * Calculate arbitrage depth and quantities
 */
export function calculateDepth(
    predictYesBids: OrderBookLevel[],
    predictYesAsks: OrderBookLevel[],
    polymarketNoAsks: OrderBookLevel[],
    feeRateBps: number = 200,
    maxPosition: number = Infinity
): DepthResult {
    // Get best prices
    const predictYesBid = predictYesBids[0]?.price || 0;
    const predictYesAsk = predictYesAsks[0]?.price || 0;
    const polymarketNoAsk = polymarketNoAsks[0]?.price || 0;

    // Get depths at best prices
    const predictYesBidDepth = predictYesBids[0]?.size || 0;
    const predictYesAskDepth = predictYesAsks[0]?.size || 0;
    const polymarketNoAskDepth = polymarketNoAsks[0]?.size || 0;

    // Calculate costs (使用固定精度避免浮点误差)
    const predictFee = calculatePredictFee(predictYesAsk, feeRateBps);
    const makerCost = Number((predictYesBid + polymarketNoAsk).toFixed(4));
    const takerCost = Number((predictYesAsk + polymarketNoAsk + predictFee).toFixed(4));

    // Calculate profits
    const makerProfit = Number((1 - makerCost).toFixed(4));
    const takerProfit = Number((1 - takerCost).toFixed(4));

    // Check if arbitrage exists (使用 epsilon 比较)
    const EPSILON = 0.0001;
    const hasArbitrage = makerCost < 1 + EPSILON || takerCost < 1 + EPSILON;

    // Calculate max quantities
    // Maker: 只看 Polymarket 对冲端深度（我们在 Predict 挂单，PM 有多少 NO 卖单决定能挂多少）
    // 使用 EPSILON 比较，makerCost <= 1 时有套利（cost=1 时有积分奖励）
    const makerMaxQuantity = hasArbitrage && makerCost < 1 + EPSILON
        ? Math.min(polymarketNoAskDepth, maxPosition)
        : 0;

    // Taker: 取两边较小值（需要同时吃两边的单）
    // Taker 需要 takerCost < 1 才有真实利润
    const takerMaxQuantity = hasArbitrage && takerCost < 1 - EPSILON
        ? Math.min(predictYesAskDepth, polymarketNoAskDepth, maxPosition)
        : 0;

    return {
        hasArbitrage,
        predictYesBid,
        predictYesAsk,
        polymarketNoAsk,
        makerCost,
        takerCost,
        predictFee,
        makerProfit,
        takerProfit,
        makerMaxQuantity,
        takerMaxQuantity,
        predictYesBidDepth,
        predictYesAskDepth,
        polymarketNoAskDepth,
    };
}

// ============================================================================
// NO 端套利深度计算
// ============================================================================

export interface NoSideDepthResult {
    // Can we arbitrage?
    hasArbitrage: boolean;

    // NO 端价格 (反演自 YES)
    predictNoBid: number;     // 1 - predict_yes_ask
    predictNoAsk: number;     // 1 - predict_yes_bid
    polymarketYesAsk: number; // 1 - polymarket_no_bid

    // Costs
    makerCost: number;        // predict_no_bid + polymarket_yes_ask
    takerCost: number;        // predict_no_ask + polymarket_yes_ask + fee
    predictFee: number;       // Taker fee on Predict (NO 端)

    // Profits
    makerProfit: number;      // 1 - makerCost
    takerProfit: number;      // 1 - takerCost

    // Depth-aware quantities
    makerMaxQuantity: number;
    takerMaxQuantity: number;

    // 原始 YES 端深度 (用于参考)
    predictYesAskDepth: number;   // = predict_no_bid 深度
    predictYesBidDepth: number;   // = predict_no_ask 深度
    polymarketNoBidDepth: number; // = polymarket_yes_ask 深度
}

/**
 * Calculate NO-side arbitrage depth
 *
 * NO 端套利公式:
 * - MAKER: predict_no_bid + polymarket_yes_ask < 1
 * - TAKER: predict_no_ask + polymarket_yes_ask + fee < 1
 *
 * 所有价格从 YES 端反演:
 * - predict_no_bid = 1 - predict_yes_ask
 * - predict_no_ask = 1 - predict_yes_bid
 * - polymarket_yes_ask = 1 - polymarket_no_bid
 */
export function calculateNoSideDepth(
    predictYesBids: OrderBookLevel[],
    predictYesAsks: OrderBookLevel[],
    polymarketNoBids: OrderBookLevel[],  // 注意：传入 NO 的 bids，用于反演 YES ask
    feeRateBps: number = 200,
    maxPosition: number = Infinity
): NoSideDepthResult {
    // 获取 YES 端最优价格
    const predictYesBid = predictYesBids[0]?.price || 0;
    const predictYesAsk = predictYesAsks[0]?.price || 1;
    const polymarketNoBid = polymarketNoBids[0]?.price || 0;

    // 获取 YES 端深度
    const predictYesBidDepth = predictYesBids[0]?.size || 0;
    const predictYesAskDepth = predictYesAsks[0]?.size || 0;
    const polymarketNoBidDepth = polymarketNoBids[0]?.size || 0;

    // 反演 NO 端价格 (使用固定精度避免浮点误差)
    const predictNoBid = Number((1 - predictYesAsk).toFixed(4));      // 在 Predict 买 NO 的价格
    const predictNoAsk = Number((1 - predictYesBid).toFixed(4));      // 在 Predict 卖 NO 的价格
    const polymarketYesAsk = Number((1 - polymarketNoBid).toFixed(4)); // 在 Polymarket 买 YES 的价格

    // 计算 NO 端费用（基于 NO Ask 价格）
    const predictFee = calculatePredictFee(predictNoAsk, feeRateBps);

    // 计算成本 (使用固定精度避免浮点误差)
    const makerCost = Number((predictNoBid + polymarketYesAsk).toFixed(4));
    const takerCost = Number((predictNoAsk + polymarketYesAsk + predictFee).toFixed(4));

    // 计算利润
    const makerProfit = Number((1 - makerCost).toFixed(4));
    const takerProfit = Number((1 - takerCost).toFixed(4));

    // 检查是否存在套利 (使用 epsilon 比较)
    const EPSILON = 0.0001;
    const hasArbitrage = makerCost < 1 + EPSILON || takerCost < 1 + EPSILON;

    // 计算最大数量
    // Maker: 在 Predict 挂 NO 买单，在 Polymarket 买 YES 对冲
    // 深度受限于 polymarket_yes_ask 深度 = polymarket_no_bid 深度
    // 使用 EPSILON 比较，makerCost <= 1 时有套利（cost=1 时有积分奖励）
    const makerMaxQuantity = hasArbitrage && makerCost < 1 + EPSILON
        ? Math.min(polymarketNoBidDepth, maxPosition)
        : 0;

    // Taker: 在 Predict 吃 NO 卖单，在 Polymarket 吃 YES 卖单
    // predict_no_ask 深度 = predict_yes_bid 深度
    // polymarket_yes_ask 深度 = polymarket_no_bid 深度
    // Taker 需要 takerCost < 1 才有真实利润
    const takerMaxQuantity = hasArbitrage && takerCost < 1 - EPSILON
        ? Math.min(predictYesBidDepth, polymarketNoBidDepth, maxPosition)
        : 0;

    return {
        hasArbitrage,
        predictNoBid,
        predictNoAsk,
        polymarketYesAsk,
        makerCost,
        takerCost,
        predictFee,
        makerProfit,
        takerProfit,
        makerMaxQuantity,
        takerMaxQuantity,
        predictYesAskDepth,
        predictYesBidDepth,
        polymarketNoBidDepth,
    };
}

/**
 * Calculate cumulative depth at multiple price levels
 * Returns how many shares can be bought/sold up to a given slippage
 *
 * @param levels - Order book levels (asks for buying, bids for selling)
 * @param side - 'BUY' for buying (asks), 'SELL' for selling (bids)
 * @param maxSlippagePercent - Maximum acceptable price deviation
 */
export function calculateCumulativeDepth(
    levels: OrderBookLevel[],
    side: 'BUY' | 'SELL',
    maxSlippagePercent: number = 1
): { totalQuantity: number; avgPrice: number } {
    if (levels.length === 0) {
        return { totalQuantity: 0, avgPrice: 0 };
    }

    const bestPrice = levels[0].price;

    // For BUY (asks): worse price = higher price, maxPrice = best * (1 + slippage)
    // For SELL (bids): worse price = lower price, minPrice = best * (1 - slippage)
    const priceLimit = side === 'BUY'
        ? bestPrice * (1 + maxSlippagePercent / 100)
        : bestPrice * (1 - maxSlippagePercent / 100);

    let totalQuantity = 0;
    let totalValue = 0;

    for (const level of levels) {
        // Check if price exceeds slippage limit
        const exceedsLimit = side === 'BUY'
            ? level.price > priceLimit
            : level.price < priceLimit;

        if (exceedsLimit) break;

        totalQuantity += level.size;
        totalValue += level.price * level.size;
    }

    return {
        totalQuantity,
        avgPrice: totalQuantity > 0 ? totalValue / totalQuantity : 0,
    };
}

/**
 * Format depth result for display
 */
export function formatDepthResult(result: DepthResult): string {
    const lines: string[] = [];

    lines.push('=== ARBITRAGE DEPTH ANALYSIS ===');
    lines.push('');
    lines.push('Prices:');
    lines.push(`  Predict YES Bid: ${(result.predictYesBid * 100).toFixed(1)}c`);
    lines.push(`  Predict YES Ask: ${(result.predictYesAsk * 100).toFixed(1)}c`);
    lines.push(`  Polymarket NO Ask: ${(result.polymarketNoAsk * 100).toFixed(1)}c`);
    lines.push('');
    lines.push('Costs:');
    lines.push(`  MAKER: ${(result.makerCost * 100).toFixed(2)}c (profit: ${(result.makerProfit * 100).toFixed(2)}%)`);
    lines.push(`  TAKER: ${(result.takerCost * 100).toFixed(2)}c (profit: ${(result.takerProfit * 100).toFixed(2)}%)`);
    lines.push(`  Predict Fee: ${(result.predictFee * 100).toFixed(2)}c`);
    lines.push('');
    lines.push('Available Depth:');
    lines.push(`  Predict Bid: ${result.predictYesBidDepth.toFixed(0)} shares`);
    lines.push(`  Predict Ask: ${result.predictYesAskDepth.toFixed(0)} shares`);
    lines.push(`  Polymarket NO: ${result.polymarketNoAskDepth.toFixed(0)} shares`);
    lines.push('');
    lines.push(`Max Quantities:`);
    lines.push(`  MAKER: ${result.makerMaxQuantity.toFixed(0)} shares`);
    lines.push(`  TAKER: ${result.takerMaxQuantity.toFixed(0)} shares`);

    return lines.join('\n');
}
