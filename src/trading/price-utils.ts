/**
 * 价格工具函数
 *
 * 提供价格对齐、精度处理等通用工具
 * 用于确保下单价格符合交易所精度要求
 */

// Re-export fee calculation from depth-calculator (统一入口)
export { calculatePredictFee } from './depth-calculator.js';

// ============================================================================
// 价格精度处理
// ============================================================================

/**
 * 浮点误差回正
 * 处理 0.299999999 → 0.30 或 0.300000001 → 0.30
 *
 * @param value - 原始值
 * @param tickSize - 最小精度 (如 0.001)
 * @returns 对齐后的值
 */
export function roundToTick(value: number, tickSize: number = 0.001): number {
    // 放大到整数域，避免浮点误差
    const scale = 1 / tickSize;  // 1000 for tickSize=0.001
    const scaled = Math.round(value * scale);
    return scaled / scale;
}

/**
 * 价格向下对齐到 tickSize
 * 买单向下取整，确保不超出预算
 *
 * @param price - 原始价格
 * @param tickSize - 最小精度 (如 0.001)
 * @returns 向下对齐后的价格
 *
 * @example
 * alignPriceDown(0.3049, 0.001) → 0.304
 * alignPriceDown(0.30499999, 0.001) → 0.304
 * alignPriceDown(0.559999999, 0.01) → 0.56  (浮点误差不会错误降一档)
 */
export function alignPriceDown(price: number, tickSize: number = 0.001): number {
    // 先回正，处理浮点误差
    const rounded = roundToTick(price, tickSize);

    // 若回正后超出原值，向下取一格
    // 容忍 1% tickSize 的误差
    if (rounded > price + tickSize * 0.01) {
        return rounded - tickSize;
    }

    // roundToTick 已消除浮点误差，直接用 rounded
    // 避免 Math.floor 在浮点边界 (如 0.559999999) 错误降档
    return rounded;
}

/**
 * 价格向上对齐到 tickSize
 * 卖单向上取整，确保不低于预期收入
 *
 * @param price - 原始价格
 * @param tickSize - 最小精度 (如 0.001)
 * @returns 向上对齐后的价格
 *
 * @example
 * alignPriceUp(0.3001, 0.001) → 0.301
 * alignPriceUp(0.30000001, 0.001) → 0.300  (浮点误差不会错误升一档)
 * alignPriceUp(0.560000001, 0.01) → 0.56   (浮点误差不会错误升一档)
 */
export function alignPriceUp(price: number, tickSize: number = 0.001): number {
    // 先回正，处理浮点误差
    const rounded = roundToTick(price, tickSize);

    // 若回正后低于原值，向上取一格
    // 容忍 1% tickSize 的误差
    if (rounded < price - tickSize * 0.01) {
        return rounded + tickSize;
    }

    // roundToTick 已消除浮点误差，直接用 rounded
    // 避免 Math.ceil 在浮点边界 (如 0.560000001) 错误升档
    return rounded;
}

// ============================================================================
// 数量精度处理
// ============================================================================

/**
 * 数量精度对齐
 * Predict 数量精度通常为整数
 *
 * @param qty - 原始数量
 * @returns 向下取整后的数量 (避免超量)
 */
export function alignQuantity(qty: number): number {
    return Math.floor(qty);
}

/**
 * 数量精度对齐 (指定精度)
 *
 * @param qty - 原始数量
 * @param precision - 精度 (小数位数)
 * @returns 向下对齐后的数量
 */
export function alignQuantityWithPrecision(qty: number, precision: number = 0): number {
    const scale = Math.pow(10, precision);
    return Math.floor(qty * scale) / scale;
}

/**
 * 验证两端 shares 是否对齐
 * 用于检查 Predict 成交量和 Polymarket 对冲量是否一致
 *
 * @param predictQty - Predict 成交数量
 * @param polyQty - Polymarket 对冲数量
 * @returns { aligned: 是否对齐, difference: 差异量 }
 */
export function validateSharesAlignment(
    predictQty: number,
    polyQty: number
): { aligned: boolean; difference: number } {
    const diff = Math.abs(predictQty - polyQty);
    return { aligned: diff < 1, difference: diff };
}

// ============================================================================
// 成本计算工具
// ============================================================================

/**
 * 计算 Taker 总成本
 *
 * @param predictAsk - Predict ask 价格
 * @param polyAsk - Polymarket 对冲 ask 价格
 * @param feeRateBps - 费率 (基点)
 * @returns 总成本
 */
export function calculateTotalCost(
    predictAsk: number,
    polyAsk: number,
    feeRateBps: number
): number {
    const { calculatePredictFee } = require('./depth-calculator.js');
    const fee = calculatePredictFee(predictAsk, feeRateBps);
    return predictAsk + polyAsk + fee;
}

/**
 * 反推 Polymarket 最大对冲价格
 *
 * 公式: polymarketMaxAsk = maxTotalCost - predictAsk - fee
 *
 * @param predictAsk - Predict ask 价格
 * @param maxTotalCost - 最大允许总成本 (如 0.995)
 * @param feeRateBps - 费率 (基点)
 * @returns Polymarket 最大对冲价格
 * @throws 若计算结果 <= 0，抛出错误
 */
export function calculatePolymarketMaxAsk(
    predictAsk: number,
    maxTotalCost: number,
    feeRateBps: number
): number {
    const { calculatePredictFee } = require('./depth-calculator.js');
    const fee = calculatePredictFee(predictAsk, feeRateBps);
    const polymarketMaxAsk = maxTotalCost - predictAsk - fee;

    if (polymarketMaxAsk <= 0) {
        throw new Error(
            `Invalid maxTotalCost: polymarketMaxAsk=${polymarketMaxAsk.toFixed(4)} <= 0. ` +
            `predictAsk=${predictAsk.toFixed(4)}, fee=${fee.toFixed(4)}, maxTotalCost=${maxTotalCost}`
        );
    }

    return polymarketMaxAsk;
}

// ============================================================================
// 验证工具
// ============================================================================

/**
 * 验证价格范围
 * Predict 价格范围: 0.01 - 0.99
 *
 * @param price - 待验证价格
 * @returns 是否在有效范围内
 */
export function isValidPrice(price: number): boolean {
    return price >= 0.01 && price <= 0.99;
}

/**
 * 验证 Taker 成本是否有效
 *
 * @param totalCost - 当前总成本
 * @param maxTotalCost - 最大允许成本 (默认 1)
 * @returns 是否有效 (totalCost <= maxTotalCost 即不亏钱)
 */
export function isCostValid(totalCost: number, maxTotalCost: number): boolean {
    return totalCost <= maxTotalCost;
}

/**
 * 验证数量是否有效
 *
 * @param qty - 待验证数量
 * @param minQty - 最小数量，默认 1
 * @returns 是否有效
 */
export function isValidQuantity(qty: number, minQty: number = 1): boolean {
    return qty >= minQty && Number.isFinite(qty);
}
