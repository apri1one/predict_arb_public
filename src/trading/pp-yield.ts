/**
 * Predict PP yield 计算（前 3 档加权 + spreadThreshold 范围过滤）
 *
 * 公式：
 *   mid = (bid1 + ask1) / 2
 *   eligible(price) = |price - mid| ≤ spreadThreshold   (price 单位 0..1)
 *   S = Σ_{i=1..3} [ (bid_i_sz if eligible(bid_i_p) else 0)
 *                  + (ask_i_sz if eligible(ask_i_p) else 0) ] × (1/3)^(i-1)
 *   pointsYield = hourlyRate / S          单位 PP/hr/share
 *
 * 仅算 Predict 一侧（YES 或 NO 任一即可；NO 侧由 YES 反演，权重相同）。
 * 缺档（无 bid2/ask3 等）该档贡献 0。
 * spreadThreshold 缺失或 ≤0 时直接返回 null（无法判断范围）。
 */

const WEIGHTS = [1, 1 / 3, 1 / 9];

export interface OrderLevel { price: number; size: number; }

export function computePointsYield(
    bids: OrderLevel[],
    asks: OrderLevel[],
    spreadThreshold: number | undefined | null,
    hourlyRate: number | undefined | null,
): number | null {
    if (!hourlyRate || hourlyRate <= 0) return null;
    if (!spreadThreshold || spreadThreshold <= 0) return null;
    const bid1 = bids[0]?.price;
    const ask1 = asks[0]?.price;
    if (bid1 == null || ask1 == null) return null;

    const mid = (bid1 + ask1) / 2;
    const tol = spreadThreshold + 1e-9;
    let S = 0;
    for (let i = 0; i < 3; i++) {
        const b = bids[i], a = asks[i];
        const bIn = b != null && Math.abs(b.price - mid) <= tol;
        const aIn = a != null && Math.abs(a.price - mid) <= tol;
        const bs = bIn ? b!.size : 0;
        const as = aIn ? a!.size : 0;
        S += (bs + as) * WEIGHTS[i];
    }
    if (S <= 0) return null;
    return hourlyRate / S;
}

/** 元组形式 (price, size) 的便捷重载 — 与 PredictOrderbookCache 的格式对齐 */
export function computePointsYieldTuples(
    bids: [number, number][],
    asks: [number, number][],
    spreadThreshold: number | undefined | null,
    hourlyRate: number | undefined | null,
): number | null {
    return computePointsYield(
        bids.map(([price, size]) => ({ price, size })),
        asks.map(([price, size]) => ({ price, size })),
        spreadThreshold,
        hourlyRate,
    );
}
