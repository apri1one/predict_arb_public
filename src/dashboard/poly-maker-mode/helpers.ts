import type { Task } from '../types.js';

/** Predict 10% fee 返点 */
export const FEE_REBATE_PERCENT = 0.10;

/** 最小对冲数量 (shares) — Predict 最小订单 ~$0.9 */
export const MIN_HEDGE_QTY = 1;

/** 最小对冲名义金额 ($) */
export const MIN_HEDGE_NOTIONAL = 0.9;

/** Predict tick size */
export const PREDICT_TICK = 0.01;

/**
 * 计算 Predict BUY 实际到账量 (扣除 fee 后)
 */
export function calculateActualSharesReceived(
    filledQty: number,
    price: number,
    feeRateBps: number,
): number {
    if (filledQty <= 0 || price <= 0 || price >= 1) return filledQty;

    const baseFeePercent = feeRateBps / 10000;
    const minPrice = Math.min(price, 1 - price);
    const feePerShare = baseFeePercent * minPrice * (1 - FEE_REBATE_PERCENT);
    const feeAsSharePercent = feePerShare / price;
    const actualShares = filledQty * (1 - feeAsSharePercent);

    return Math.floor(actualShares * 10) / 10;
}

/**
 * 计算 Predict 对冲保本价
 */
export function computePredictBreakevenAsk(polyBidPrice: number): number {
    return Number((1 - polyBidPrice).toFixed(6));
}

/**
 * 计算 Predict 对冲允许的最大 ask
 *
 * 保证最大亏损不超过滑点容忍：
 *   polyBid + predictAsk <= 1 + slippageTolerance
 */
export function computeMaxPredictAsk(polyBidPrice: number, slippageTolerance: number): number {
    return Number((computePredictBreakevenAsk(polyBidPrice) + Math.max(0, slippageTolerance || 0)).toFixed(6));
}

/**
 * 对冲 LIMIT 重试的价格上限
 * 与价格守护保持一致：保本价 + 滑点容忍。
 */
export function computePredictHedgeCap(polyBidPrice: number, slippageTolerance: number): number {
    return computeMaxPredictAsk(polyBidPrice, slippageTolerance);
}

/**
 * 获取 POLY_MAKER 模式下 Predict 对冲方向
 *
 * arbSide 表示 Poly 主仓/挂单方向：
 * - arbSide=YES -> Predict 对冲买 NO
 * - arbSide=NO  -> Predict 对冲买 YES
 */
export function getPolyMakerPredictOutcome(arbSide: Task['arbSide'] | undefined): 'YES' | 'NO' {
    return (arbSide || 'YES') === 'YES' ? 'NO' : 'YES';
}

/**
 * 获取 Poly Maker 模式的挂单/对冲 tokenId
 */
export function getPolyMakerHedgeTokenId(task: Pick<Task, 'arbSide' | 'isInverted' | 'polymarketYesTokenId' | 'polymarketNoTokenId'>): string {
    const arbSide = task.arbSide || 'YES';

    // POLY_MAKER: Poly 挂单买本方 token (不是对面)
    // arbSide=YES (away) -> 挂单买 YES token (away)
    // arbSide=NO  (home) -> 挂单买 NO token  (home)
    if (arbSide === 'YES') {
        return task.isInverted ? task.polymarketNoTokenId : task.polymarketYesTokenId;
    }

    return task.isInverted ? task.polymarketYesTokenId : task.polymarketNoTokenId;
}

/**
 * 计算是否应触发对冲
 */
export function checkPolyMakerShouldHedge(
    pendingHedgeQty: number,
    unhedged: number,
    isTerminal: boolean,
): { shouldHedge: boolean; hedgeQty: number; nextPendingHedgeQty: number } {
    const totalUnhedged = unhedged + pendingHedgeQty;

    if (totalUnhedged < MIN_HEDGE_QTY && !isTerminal) {
        return { shouldHedge: false, hedgeQty: 0, nextPendingHedgeQty: pendingHedgeQty };
    }

    if (isTerminal && totalUnhedged > 0) {
        return { shouldHedge: true, hedgeQty: totalUnhedged, nextPendingHedgeQty: 0 };
    }

    if (totalUnhedged >= MIN_HEDGE_QTY) {
        return { shouldHedge: true, hedgeQty: totalUnhedged, nextPendingHedgeQty: 0 };
    }

    return { shouldHedge: false, hedgeQty: 0, nextPendingHedgeQty: pendingHedgeQty };
}
