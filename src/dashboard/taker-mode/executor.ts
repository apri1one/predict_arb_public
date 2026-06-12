/**
 * Taker Mode Executor - Taker 模式执行器
 *
 * 核心流程:
 * 1. 获取最新 ask 价格，验证 totalCost < maxTotalCost
 * 2. 下单 @ ask 价格 (LIMIT，模拟 Taker)
 * 3. 启动成本守护 (合并到轮询)
 * 4. 启动超时定时器 (默认 10s)
 * 5. 轮询成交状态 + 增量对冲
 * 6. 若有剩余量，用 remainingQty 继续
 *
 * 关键优化:
 * - 无 PAUSED 状态，成本失效/超时直接 cancel + end
 * - cancel 前强制刷新成交量，避免丢失部分成交
 * - 对冲取价优先使用 WS 缓存
 */

import { EventEmitter } from 'events';
import type { Task, TaskStatus } from '../types.js';
import type {
    TakerContext,
    HedgeResult,
    CancelReason,
    HedgePriceSource,
} from './types.js';
import { alignPriceDown, alignPriceUp, alignQuantity, calculatePredictFee, validateSharesAlignment } from '../../trading/price-utils.js';
import { OrderbookCache, predictCacheKey, polyCacheKey } from '../orderbook-cache.js';
import type { PredictTrader } from '../predict-trader.js';
import type { PolymarketTrader } from '../polymarket-trader.js';
import type { TaskLogger } from '../task-logger/index.js';
import type { PolymarketWebSocketClient } from '../../polymarket/ws-client.js';
import type { NormalizedOrderBook } from '../../polymarket/types.js';
import { getBscOrderWatcher, getSharesFromFillEvent, type BscOrderWatcher, type OrderFilledEvent } from '../../services/bsc-order-watcher.js';

// ============================================================================
// 常量 (支持环境变量配置)
// ============================================================================

// 从环境变量读取，便于调优
// 基于真实延迟测试: 下单到首次获取状态需要 5-11 秒
const DEFAULT_ORDER_TIMEOUT = Number(process.env.TAKER_ORDER_TIMEOUT_MS) || 20000;      // 默认订单超时 20s (测试显示 5-11s)
const DEFAULT_POLL_INTERVAL = Number(process.env.TAKER_POLL_INTERVAL_MS) || 500;        // 成交状态轮询间隔 500ms
const DEFAULT_MAX_HEDGE_RETRIES = Number(process.env.TAKER_MAX_HEDGE_RETRIES) || 3;     // 默认对冲重试次数
const ORDERBOOK_RETRY_DELAY = Number(process.env.ORDERBOOK_RETRY_DELAY_MS) || 300;      // 订单簿获取重试延迟 300ms
const HEDGE_WAIT_DELAY = Number(process.env.TAKER_HEDGE_WAIT_MS) || 300;                // 对冲后等待 300ms
const WS_CACHE_MAX_AGE = 2000;            // WS 缓存最大有效期 2s
const DEFAULT_TICK_SIZE = 0.01;           // Predict 价格精度 (最多2位小数)

// 状态预获取相关常量
const STATUS_FETCH_TIMEOUT = Number(process.env.STATUS_FETCH_TIMEOUT_MS) || 15000;      // 首次状态获取超时 15s
const MAX_STATUS_FETCH_FAILURES = 30;      // 最大连续失败次数 (30 * 500ms = 15s)

// Polymarket 最小订单阈值 (Polymarket 最小订单 $1，按最低价格 $0.50 计算约 2 shares)
const MIN_HEDGE_THRESHOLD = Number(process.env.MIN_HEDGE_THRESHOLD) || 2;  // 低于此数量视为对冲完成

// Polymarket 最小订单名义金额阈值 ($1)
// 小额成交先累计，避免 Polymarket 400 "invalid amounts" 拒单
const MIN_HEDGE_NOTIONAL = Number(process.env.MIN_HEDGE_NOTIONAL) || 1.0;  // USD

// Fee 相关常量
const FEE_REBATE_PERCENT = 0.10;  // Predict 10% 返点

// 事件驱动价格保护常量
const COST_CHECK_THROTTLE_MS = Number(process.env.COST_CHECK_THROTTLE_MS) || 200;  // 成本检查节流 200ms
const COST_CHECK_FALLBACK_INTERVAL = 5;  // 无 WS 时的轮询降级间隔 (每 N 次轮询)

// IOC 安全阀: cancel 后轮询确认终态
const IOC_RESOLVE_TIMEOUT_MS = Math.max(Number(process.env.IOC_RESOLVE_TIMEOUT_MS) || 3000, 500);      // 最大等待 3s，下限 500ms
const IOC_RESOLVE_INTERVAL_MS = Math.max(Number(process.env.IOC_RESOLVE_INTERVAL_MS) || 500, 100);     // 每 500ms 检查一次，下限 100ms

// 亏损对冲 (Loss Hedge) 相关常量
const LOSS_HEDGE_MAX_PRICE_DEVIATION = Number(process.env.LOSS_HEDGE_MAX_PRICE_DEVIATION) || 0.02;  // 最大价格偏离 2%
const LOSS_HEDGE_WAIT_INTERVAL_MS = Number(process.env.LOSS_HEDGE_WAIT_INTERVAL_MS) || 5000;  // 等待价格回落间隔 5s
const LOSS_HEDGE_MAX_WAIT_TIME_MS = Number(process.env.LOSS_HEDGE_MAX_WAIT_TIME_MS) || 1800000;  // 最大等待时间 30 分钟
const LOSS_HEDGE_MAX_RETRIES = Number(process.env.LOSS_HEDGE_MAX_RETRIES) || 50;  // 亏损对冲最大重试次数

/**
 * 计算实际到账的 shares（扣除 Taker fee）
 * 使用两位小数精度（向下取整）
 *
 * @param filledQty - API 返回的撮合数量
 * @param price - 成交价格
 * @param feeRateBps - 费率 (基点)
 * @returns 实际到账的 shares 数量（两位小数）
 */
function calculateActualSharesReceived(
    filledQty: number,
    price: number,
    feeRateBps: number
): number {
    if (filledQty <= 0 || price <= 0 || price >= 1) return filledQty;

    // fee per share (USDC) = feeRateBps / 10000 × min(price, 1-price) × (1 - rebate)
    const baseFeePercent = feeRateBps / 10000;
    const minPrice = Math.min(price, 1 - price);
    const feePerShare = baseFeePercent * minPrice * (1 - FEE_REBATE_PERCENT);

    // 转换为 shares 比例: fee% = feePerShare / price
    const feeAsSharePercent = feePerShare / price;

    // 实际到账 = 撮合数量 × (1 - fee%)
    const actualShares = filledQty * (1 - feeAsSharePercent);

    // 向下取整到一位小数 (例如 9.9477 → 9.9)
    return Math.floor(actualShares * 10) / 10;
}

// ============================================================================
// 类型
// ============================================================================

export interface TakerExecutorDeps {
    predictTrader: PredictTrader;
    polyTrader: PolymarketTrader;
    taskLogger: TaskLogger;
    polyWsClient?: PolymarketWebSocketClient;
    updateTask: (taskId: string, updates: Partial<Task>) => void;
    getTask: (taskId: string) => Task | undefined;
}

// ============================================================================
// TakerExecutor 类
// ============================================================================

export class TakerExecutor extends EventEmitter {
    private predictTrader: PredictTrader;
    private polyTrader: PolymarketTrader;
    private taskLogger: TaskLogger;
    private polyWsClient?: PolymarketWebSocketClient;
    private updateTask: (taskId: string, updates: Partial<Task>) => void;
    private getTask: (taskId: string) => Task | undefined;
    private orderbookCache: OrderbookCache;

    constructor(deps: TakerExecutorDeps) {
        super();
        this.predictTrader = deps.predictTrader;
        this.polyTrader = deps.polyTrader;
        this.taskLogger = deps.taskLogger;
        this.polyWsClient = deps.polyWsClient;
        this.updateTask = deps.updateTask;
        this.getTask = deps.getTask;
        this.orderbookCache = new OrderbookCache({
            ttlMs: 500,
            staleThresholdMs: 1000,
            maxStaleMs: 2000,
        });
    }

    setPolymarketWsClient(client: PolymarketWebSocketClient | null): void {
        this.polyWsClient = client ?? undefined;
    }

    // ========================================================================
    // 主入口
    // ========================================================================

    /**
     * 执行 Taker BUY 任务
     * 核心流程：下单 → 成本守护 → 超时撤单 → 增量对冲
     */
    async executeTakerBuy(ctx: TakerContext): Promise<void> {
        const { task, signal } = ctx;
        const hedgeTokenId = this.getHedgeTokenId(task);

        // 1. 计算剩余数量（关键：避免超量）
        const remainingQty = task.quantity - ctx.totalPredictFilled;
        if (remainingQty <= 0) {
            console.log(`[TakerExecutor] Task ${task.id}: No remaining quantity`);
            return;
        }

        // 2. 获取最新价格并验证成本（带重试 + fallback 到任务存储价格）
        let costCheck: Awaited<ReturnType<typeof this.getCurrentCost>> | null = null;
        const maxRetries = 3;
        for (let i = 0; i < maxRetries; i++) {
            costCheck = await this.getCurrentCost(
                task,
                hedgeTokenId,
                task.feeRateBps || 200
            );

            // 调试日志：显示获取到的实际值
            console.log(`[TakerExecutor] Task ${task.id}: Cost check attempt ${i + 1}/${maxRetries}: ` +
                `arbSide=${task.arbSide}, hedgeTokenId=${hedgeTokenId.slice(0, 20)}..., ` +
                `predictAsk=${costCheck.predictAsk}, polyAsk=${costCheck.polyAsk}, ` +
                `totalCost=${costCheck.totalCost}, isNaN=${isNaN(costCheck.totalCost)}`);

            // 检查是否获取到有效数据（排除默认值 1）
            const isValidData = !isNaN(costCheck.totalCost) &&
                costCheck.predictAsk > 0 && costCheck.predictAsk < 1 &&
                costCheck.polyAsk > 0 && costCheck.polyAsk < 1;

            if (isValidData) {
                console.log(`[TakerExecutor] Task ${task.id}: Valid orderbook data obtained`);
                break;
            }

            // Rate limit 或网络问题，等待后重试
            console.log(`[TakerExecutor] Task ${task.id}: Orderbook fetch failed (attempt ${i + 1}/${maxRetries}), retrying in ${ORDERBOOK_RETRY_DELAY}ms...`);
            await this.delay(ORDERBOOK_RETRY_DELAY);
        }

        // Fallback 到任务创建时存储的价格（当订单簿获取失败或返回默认值 1 时）
        const needFallback = !costCheck || isNaN(costCheck.totalCost) ||
            costCheck.predictAsk >= 1 || costCheck.polyAsk >= 1;

        if (needFallback) {
            if (task.predictAskPrice && task.polymarketMaxAsk) {
                const fee = calculatePredictFee(task.predictAskPrice, task.feeRateBps || 200);
                // 反推 polyAsk: polymarketMaxAsk = maxTotalCost - predictAsk - fee
                // 使用 maxTotalCost 的 90% 作为保守估计的 polyAsk
                const estimatedPolyAsk = (task.maxTotalCost || 0.99) - task.predictAskPrice - fee - 0.01;
                const polyAsk = Math.min(estimatedPolyAsk, task.polymarketMaxAsk);
                costCheck = {
                    predictAsk: task.predictAskPrice,
                    polyAsk,
                    fee,
                    totalCost: task.predictAskPrice + polyAsk + fee,
                    isValid: true,
                };
                console.log(`[TakerExecutor] Task ${task.id}: Using fallback prices from task: predictAsk=${task.predictAskPrice}, polyAsk=${polyAsk.toFixed(4)}`);
            } else {
                throw new Error('Failed to fetch orderbook and no fallback prices available');
            }
        }

        // 类型断言：此时 costCheck 一定有值（否则上面会 throw）
        const validCostCheck = costCheck!;

        if (!validCostCheck.isValid || validCostCheck.totalCost > (task.maxTotalCost || 1)) {
            throw new Error(
                `Cost invalid: ${validCostCheck.totalCost.toFixed(4)} > ${task.maxTotalCost}`
            );
        }

        // 3. 价格对齐 tickSize (避免被拒单)
        // 注意: task.tickSize 是 Polymarket 的 tickSize，Predict 有自己的 priceDecimals
        const priceDecimals = await this.predictTrader.getPriceDecimals(task.marketId);
        const predictTickSize = Math.pow(10, -priceDecimals); // 2位小数=0.01, 3位小数=0.001
        // TAKER BUY: 使用 alignPriceUp 确保价格 >= ask，实现真正的吃单
        const alignedPrice = alignPriceUp(validCostCheck.predictAsk, predictTickSize);
        const alignedQty = alignQuantity(remainingQty);

        if (alignedQty <= 0) {
            console.log(`[TakerExecutor] Task ${task.id}: Aligned quantity is 0`);
            return;
        }

        // 对齐后重新计算成本（BUY: predictAsk = buyPrice）
        const alignedPredictAsk = alignedPrice;
        const alignedFee = calculatePredictFee(alignedPredictAsk, task.feeRateBps || 200);
        const alignedTotalCost = alignedPredictAsk + validCostCheck.polyAsk + alignedFee;

        if (alignedTotalCost > (task.maxTotalCost || 1)) {
            throw new Error(
                `Cost invalid after alignment: ${alignedTotalCost.toFixed(4)} > ${task.maxTotalCost}`
            );
        }

        // 4. 记录下单前快照
        await this.taskLogger.captureOrderBookSnapshot(
            task.id,
            'order_submit',
            {
                bids: [],
                asks: [[alignedPredictAsk, alignedQty]],
                updateTimestampMs: Date.now(),
            },
            {
                bids: [],
                asks: [[validCostCheck.polyAsk, alignedQty]],
                updateTimestampMs: Date.now(),
            },
            {
                totalCost: alignedTotalCost,
                profitPercent: (1 - alignedTotalCost) * 100,
                isValid: true,
                maxDepth: alignedQty,
            }
        );

        // 5. 提交 LIMIT @ ask
        // 根据套利方向选择 token: YES端买YES, NO端买NO
        ctx.predictSubmitTime = Date.now();
        const result = await this.predictTrader.placeOrder({
            marketId: task.marketId,
            side: 'BUY',
            price: alignedPrice,
            quantity: alignedQty,
            outcome: task.arbSide || 'YES',
        });

        if (!result.success || !result.hash) {
            await this.taskLogger.logOrderEvent(task.id, 'ORDER_FAILED', {
                platform: 'predict',
                orderId: '',
                side: 'BUY',
                outcome: task.arbSide || 'YES',
                price: alignedPrice,
                quantity: alignedQty,
                filledQty: 0,
                remainingQty: alignedQty,
                avgPrice: 0,
                title: task.title,
                error: { errorType: 'OrderSubmitFailed', message: result.error || 'Unknown error' },
            });
            throw new Error(`Taker order failed: ${result.error}`);
        }

        ctx.currentOrderHash = result.hash;
        this.updateTask(task.id, {
            status: 'PREDICT_SUBMITTED',
            currentOrderHash: result.hash,
        });

        await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
            platform: 'predict',
            orderId: result.hash,
            side: 'BUY',
            outcome: task.arbSide || 'YES',  // YES端买YES, NO端买NO
            price: alignedPrice,
            quantity: alignedQty,
            filledQty: 0,
            remainingQty: alignedQty,
            avgPrice: 0,
            title: task.title,
        });

        // 6. 运行成本守护 + 超时监控 + 成交监控
        await this.runWithCostGuard(ctx, hedgeTokenId, alignedPrice, alignedQty);
    }

    /**
     * 执行 SELL 任务（统一平仓逻辑）
     *
     * 核心思路:
     * - 用户指定卖出价格 (task.predictPrice)，可以高于 best bid（挂单等待）
     * - 风控条件: polymarket_bid >= 1 - predict_sell_price
     * - 不满足时暂停，等待 Polymarket bid 回升
     * - Predict 成交后，Polymarket 以 best bid 卖出对冲
     *
     * 套利方向:
     * - YES 端套利: Predict 卖 YES + Polymarket 卖 NO
     * - NO 端套利: Predict 卖 NO + Polymarket 卖 YES
     */
    async executeTakerSell(ctx: TakerContext): Promise<void> {
        const { task, signal } = ctx;
        const hedgeTokenId = this.getHedgeTokenId(task);

        // 0. 验证 Polymarket 持仓是否足够
        const polyPosition = await this.validatePolymarketPosition(task, hedgeTokenId);
        if (!polyPosition.valid) {
            const errMsg = `Polymarket position insufficient: expected ${task.quantity} shares of ${polyPosition.outcome}, but have ${polyPosition.actualShares}`;
            console.error(`[TakerExecutor] Task ${task.id}: ${errMsg}`);
            this.updateTask(task.id, { status: 'FAILED' });
            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                status: 'FAILED',
                error: { errorType: 'PositionValidationFailed', message: errMsg },
            });
            throw new Error(errMsg);
        }

        // 1. 计算剩余数量
        const remainingQty = task.quantity - ctx.totalPredictFilled;
        if (remainingQty <= 0) {
            console.log(`[TakerExecutor] Task ${task.id}: No remaining quantity`);
            return;
        }

        // 2. 获取用户设定的卖出价格
        // 优先使用 predictPrice (用户设定)，否则获取当前 best bid
        let sellPrice = task.predictPrice;
        if (!sellPrice || sellPrice <= 0) {
            // 获取当前 best bid 作为默认卖出价格
            // 订单簿格式: bids/asks = [[price, size], ...]
            const predictBook = await this.predictTrader.getOrderbook(task.marketId);
            const arbSide = task.arbSide || 'YES';
            if (arbSide === 'YES') {
                // YES 端: 卖 YES，取 YES bid[0][0]
                sellPrice = predictBook?.bids?.[0]?.[0] || 0;
            } else {
                // NO 端: 卖 NO = 1 - YES ask
                const yesAsk = predictBook?.asks?.[0]?.[0] || 1;
                sellPrice = 1 - yesAsk;
            }
        }

        if (sellPrice <= 0) {
            throw new Error('Cannot determine sell price: no bids available');
        }

        // 对齐价格 (使用市场实际精度)
        const priceDecimals = await this.predictTrader.getPriceDecimals(task.marketId);
        const predictTickSize = Math.pow(10, -priceDecimals); // 2位小数=0.01, 3位小数=0.001
        const alignedPrice = alignPriceDown(sellPrice, predictTickSize);
        const alignedQty = alignQuantity(remainingQty);

        if (alignedQty <= 0) {
            console.log(`[TakerExecutor] Task ${task.id}: Aligned quantity is 0`);
            return;
        }

        // 3. 风控检查: polymarket_bid >= minPolyBid (必须由用户设定)
        if (!task.polymarketMinBid || task.polymarketMinBid <= 0) {
            throw new Error('polymarketMinBid is required for SELL tasks');
        }
        const minPolyBid = task.polymarketMinBid;
        console.log(`[TakerExecutor] Task ${task.id}: SELL @ ${alignedPrice}, minPolyBid required: ${minPolyBid.toFixed(4)}`);

        // 4. 初始风控验证
        const { price: currentPolyBid } = await this.getHedgePrice(hedgeTokenId, 'SELL');
        if (currentPolyBid < minPolyBid) {
            console.log(`[TakerExecutor] Task ${task.id}: Poly bid ${currentPolyBid} < minRequired ${minPolyBid}, waiting...`);
            this.updateTask(task.id, { status: 'PAUSED' });
            await this.taskLogger.logTakerEvent(task.id, 'HEDGE_PRICE_INVALID', {
                hedgePrice: currentPolyBid,
                minAllowed: minPolyBid,
                side: 'SELL',
            });
            // 不抛异常，进入等待循环
        }

        // 5. 记录下单前快照
        await this.taskLogger.captureOrderBookSnapshot(
            task.id,
            'order_submit',
            {
                bids: [[alignedPrice, alignedQty]],
                asks: [],
                updateTimestampMs: Date.now(),
            },
            {
                bids: [[currentPolyBid, alignedQty]],
                asks: [],
                updateTimestampMs: Date.now(),
            },
            {
                totalCost: 0,
                profitPercent: (alignedPrice + currentPolyBid - 1) * 100,
                isValid: currentPolyBid >= minPolyBid,
                maxDepth: alignedQty,
            }
        );

        // 6. 提交 Predict SELL 订单
        const predictOutcome = task.arbSide || 'YES';
        ctx.predictSubmitTime = Date.now();
        const result = await this.predictTrader.placeOrder({
            marketId: task.marketId,
            side: 'SELL',
            price: alignedPrice,
            quantity: alignedQty,
            outcome: predictOutcome,
        });

        if (!result.success || !result.hash) {
            await this.taskLogger.logOrderEvent(task.id, 'ORDER_FAILED', {
                platform: 'predict',
                orderId: '',
                side: 'SELL',
                outcome: predictOutcome,
                price: alignedPrice,
                quantity: alignedQty,
                filledQty: 0,
                remainingQty: alignedQty,
                avgPrice: 0,
                title: task.title,
                error: { errorType: 'OrderSubmitFailed', message: result.error || 'Unknown error' },
            });
            throw new Error(`SELL order failed: ${result.error}`);
        }

        ctx.currentOrderHash = result.hash;
        this.updateTask(task.id, {
            status: 'PREDICT_SUBMITTED',
            currentOrderHash: result.hash,
        });

        await this.taskLogger.logOrderEvent(task.id, 'ORDER_SUBMITTED', {
            platform: 'predict',
            orderId: result.hash,
            side: 'SELL',
            outcome: predictOutcome,
            price: alignedPrice,
            quantity: alignedQty,
            filledQty: 0,
            remainingQty: alignedQty,
            avgPrice: 0,
            title: task.title,
        });

        // 7. 监控成交 + Polymarket 风控守护
        await this.runSellWithPriceGuard(ctx, hedgeTokenId, alignedPrice, alignedQty, minPolyBid);
    }

    /**
     * SELL 任务的成交监控 + 风控守护 (WSS + REST 双轨模式)
     *
     * 风控条件: polymarket_bid >= minPolyBid (= 1 - predict_sell_price)
     * 不满足时暂停，满足后恢复并补对冲
     *
     * WSS-first 架构:
     * - BSC WSS 作为快速主通道，接收链上 OrderFilled 事件
     * - REST 作为兜底/对账 + 检测订单取消状态
     */
    private async runSellWithPriceGuard(
        ctx: TakerContext,
        hedgeTokenId: string,
        orderPrice: number,
        orderQty: number,
        minPolyBid: number
    ): Promise<void> {
        const { task, signal } = ctx;
        const orderTimeout = task.orderTimeout || DEFAULT_ORDER_TIMEOUT;
        const startTime = Date.now();
        let isPaused = false;

        // ========================================================================
        // BSC WSS 成交事件处理 (WSS-first 架构)
        // ========================================================================
        let bscWssWatcher: BscOrderWatcher | null = null;
        let cancelBscWssWatch: (() => void) | null = null;
        let wssEventResolve: (() => void) | null = null;
        let wssEventPromise: Promise<void> | null = null;

        const resetWssSignal = () => {
            wssEventPromise = new Promise<void>((resolve) => {
                wssEventResolve = resolve;
            });
        };
        resetWssSignal();

        /**
         * 合并 WSS 和 REST 成交量，更新 totalPredictFilled
         * 规则: totalPredictFilled = max(wssFilledQty, restFilledQty)，单调不减
         * @returns 是否有新成交 (totalPredictFilled 增加)
         */
        const mergeFilledQty = (): boolean => {
            const merged = Math.max(ctx.wssFilledQty, ctx.restFilledQty);
            const clamped = Math.min(Math.max(0, merged), orderQty);
            if (clamped > ctx.totalPredictFilled) {
                ctx.totalPredictFilled = clamped;
                return true;
            }
            return false;
        };

        try {
            bscWssWatcher = getBscOrderWatcher();
            if (bscWssWatcher.isConnected() && ctx.currentOrderHash) {
                cancelBscWssWatch = bscWssWatcher.watchOrder(
                    ctx.currentOrderHash,
                    (event: OrderFilledEvent) => {
                        // 1. 去重: 使用 txHash:logIndex 作为唯一键
                        const dedupKey = `${event.txHash}:${event.logIndex}`;
                        if (ctx.wssFillEvents.has(dedupKey)) {
                            return;
                        }
                        ctx.wssFillEvents.add(dedupKey);

                        // 2. 累加增量（使用统一工具函数）
                        const fillDelta = getSharesFromFillEvent(event);
                        ctx.wssFilledQty += fillDelta;

                        // 3. 记录首次 WSS 成交时间
                        if (!ctx.wssFirstFillTime) {
                            ctx.wssFirstFillTime = event.timestamp;
                            console.log(`[TakerExecutor] Task ${task.id}: WSS SELL first fill at ${ctx.wssFirstFillTime - startTime}ms, delta=${fillDelta.toFixed(4)}, wssTotal=${ctx.wssFilledQty.toFixed(4)}`);
                        }

                        // 4. 唤醒主循环
                        if (wssEventResolve) {
                            wssEventResolve();
                            resetWssSignal();
                        }
                    },
                    orderTimeout + 10000
                );
                console.log(`[TakerExecutor] Task ${task.id}: BSC WSS SELL order listener enabled (WSS-first mode)`);
            }
        } catch {
            console.log(`[TakerExecutor] Task ${task.id}: BSC WSS not available for SELL, using REST-only mode`);
        }

        // 状态预获取: 立即发起第一次状态查询 (并行)
        let prefetchResult: Awaited<ReturnType<typeof this.predictTrader.getOrderStatus>> | null = null;
        const prefetchPromise = this.predictTrader.getOrderStatus(ctx.currentOrderHash!).then(r => {
            prefetchResult = r;
            return r;
        });
        console.log(`[TakerExecutor] Task ${task.id}: SELL started status prefetch at ${Date.now() - startTime}ms`);

        try {
            while (!signal.aborted) {
                const elapsed = Date.now() - startTime;
                ctx.statusFetchAttempts++;

                // 1. 检查超时 (暂停时不计超时)
                if (elapsed > orderTimeout && !isPaused) {
                    console.log(`[TakerExecutor] Task ${task.id}: SELL order timeout after ${orderTimeout}ms`);
                    await this.handleSellTimeout(ctx, hedgeTokenId, orderPrice, orderQty, minPolyBid);
                    return;
                }

                // 2. 获取 Polymarket bid 并检查风控
                const { price: currentPolyBid } = await this.getHedgePrice(hedgeTokenId, 'SELL');
                const priceValid = currentPolyBid >= minPolyBid;

                if (!priceValid && !isPaused) {
                    isPaused = true;
                    this.updateTask(task.id, { status: 'PAUSED' });
                    console.log(`[TakerExecutor] Task ${task.id}: PAUSED - Poly bid ${currentPolyBid.toFixed(4)} < min ${minPolyBid.toFixed(4)}`);
                    await this.taskLogger.logTakerEvent(task.id, 'HEDGE_PRICE_INVALID', {
                        hedgePrice: currentPolyBid,
                        minAllowed: minPolyBid,
                        side: 'SELL',
                    });
                } else if (priceValid && isPaused) {
                    isPaused = false;
                    this.updateTask(task.id, { status: 'PREDICT_SUBMITTED' });
                    console.log(`[TakerExecutor] Task ${task.id}: RESUMED - Poly bid ${currentPolyBid.toFixed(4)} >= min ${minPolyBid.toFixed(4)}`);

                    // 补对冲: 恢复后立即处理暂停期间积累的未对冲成交
                    if (ctx.totalPredictFilled > ctx.totalHedged) {
                        const unhedgedQty = ctx.totalPredictFilled - ctx.totalHedged;
                        console.log(`[TakerExecutor] Task ${task.id}: Catching up hedge for ${unhedgedQty} (accumulated during pause)`);
                        if (unhedgedQty > 0) {
                            await this.incrementalHedge(ctx, hedgeTokenId, unhedgedQty);
                            if (signal.aborted) return;
                        }
                    }

                    // 检查是否已全部成交
                    const latestStatus = await this.predictTrader.getOrderStatus(ctx.currentOrderHash!);
                    if (latestStatus && (latestStatus.status === 'FILLED' || latestStatus.remainingQty === 0)) {
                        await this.finishHedging(ctx, hedgeTokenId);
                        return;
                    }
                }

                // 3. 获取 Predict 订单状态 (REST)
                let orderStatus;
                if (ctx.statusFetchAttempts === 1 && prefetchResult !== null) {
                    orderStatus = prefetchResult;
                } else if (ctx.statusFetchAttempts === 1) {
                    orderStatus = await prefetchPromise;
                } else {
                    orderStatus = await this.predictTrader.getOrderStatus(ctx.currentOrderHash!);
                }

                // 处理状态获取失败
                if (!orderStatus) {
                    ctx.statusFetchFailures++;
                    if (!ctx.hasReceivedValidStatus && elapsed >= STATUS_FETCH_TIMEOUT) {
                        console.error(`[TakerExecutor] Task ${task.id}: SELL status fetch timeout after ${elapsed}ms`);
                        await this.handleSellTimeout(ctx, hedgeTokenId, orderPrice, orderQty, minPolyBid);
                        return;
                    }
                    if (ctx.statusFetchFailures % 10 === 0) {
                        console.warn(`[TakerExecutor] Task ${task.id}: SELL status fetch failed ${ctx.statusFetchFailures} times`);
                    }
                    // WSS 事件可打断等待
                    if (wssEventPromise) {
                        await Promise.race([this.delay(DEFAULT_POLL_INTERVAL), wssEventPromise]);
                    } else {
                        await this.delay(DEFAULT_POLL_INTERVAL);
                    }
                    continue;
                }

                // 首次收到有效状态
                if (!ctx.hasReceivedValidStatus) {
                    ctx.hasReceivedValidStatus = true;
                    ctx.firstValidStatusTime = Date.now();
                    ctx.statusFetchFailures = 0;
                    console.log(`[TakerExecutor] Task ${task.id}: SELL first valid status after ${ctx.firstValidStatusTime - startTime}ms, status=${orderStatus.status}, filled=${orderStatus.filledQty}`);
                } else {
                    ctx.statusFetchFailures = 0;
                }

                // 4. 检查订单是否被外部取消
                if (orderStatus.status === 'CANCELLED' || orderStatus.status === 'EXPIRED') {
                    const cancelReason = orderStatus.cancelReason || 'unknown';
                    console.log(`[TakerExecutor] Task ${task.id}: SELL order ${orderStatus.status}, reason: ${cancelReason}`);

                    // 刷新成交量 (取 REST 和 WSS 的最大值)
                    ctx.restFilledQty = Math.max(ctx.restFilledQty, orderStatus.filledQty);
                    mergeFilledQty();

                    await this.taskLogger.logOrderEvent(task.id, orderStatus.status === 'CANCELLED' ? 'ORDER_CANCELLED' : 'ORDER_EXPIRED', {
                        platform: 'predict',
                        orderId: ctx.currentOrderHash!,
                        side: 'SELL',
                        outcome: task.arbSide || 'YES',
                        price: orderPrice,
                        quantity: orderQty,
                        filledQty: ctx.totalPredictFilled,
                        remainingQty: orderQty - ctx.totalPredictFilled,
                        avgPrice: orderPrice,
                        title: task.title,
                        cancelReason,
                        rawResponse: orderStatus.rawResponse,
                    });

                    if (ctx.totalPredictFilled > ctx.totalHedged) {
                        console.log(`[TakerExecutor] Task ${task.id}: Order ${orderStatus.status} with ${ctx.totalPredictFilled} filled, completing hedge...`);
                        await this.finishHedging(ctx, hedgeTokenId);
                    } else if (ctx.totalPredictFilled === 0) {
                        this.updateTask(task.id, { status: 'CANCELLED' });
                        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_CANCELLED', {
                            status: 'CANCELLED',
                            reason: `Order ${orderStatus.status}: ${cancelReason}`,
                            cancelReason,
                        });
                    } else {
                        this.updateTask(task.id, { status: 'COMPLETED', completedAt: Date.now() });
                        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_COMPLETED', {
                            status: 'COMPLETED',
                            reason: `Order ${orderStatus.status} but fully hedged`,
                        });
                    }
                    return;
                }

                // 5. 合并 WSS + REST 成交量
                if (orderStatus.filledQty > ctx.restFilledQty) {
                    ctx.restFilledQty = orderStatus.filledQty;
                }
                const prevTotalFilled = ctx.totalPredictFilled;
                const hasNewFill = mergeFilledQty();

                if (hasNewFill) {
                    const newFilled = ctx.totalPredictFilled - prevTotalFilled;

                    // 记录首次成交时间
                    if (!ctx.predictFirstFillTime) {
                        ctx.predictFirstFillTime = ctx.wssFirstFillTime || Date.now();
                        const source = ctx.wssFirstFillTime ? 'WSS' : 'REST';
                        console.log(`[TakerExecutor] Task ${task.id}: SELL first fill detected (${source}) after ${ctx.predictFirstFillTime - startTime}ms`);
                    }

                    console.log(`[TakerExecutor] Task ${task.id}: SELL filled ${newFilled.toFixed(4)}, total ${ctx.totalPredictFilled.toFixed(4)} (wss=${ctx.wssFilledQty.toFixed(4)}, rest=${ctx.restFilledQty.toFixed(4)})`);

                    this.updateTask(task.id, {
                        status: 'PARTIALLY_FILLED',
                        predictFilledQty: ctx.totalPredictFilled,
                        avgPredictPrice: orderPrice,
                        remainingQty: orderQty - ctx.totalPredictFilled,
                    });

                    await this.taskLogger.logOrderEvent(task.id, 'ORDER_PARTIAL_FILL', {
                        platform: 'predict',
                        orderId: ctx.currentOrderHash!,
                        side: 'SELL',
                        outcome: task.arbSide || 'YES',
                        price: orderPrice,
                        quantity: orderQty,
                        filledQty: ctx.totalPredictFilled,
                        remainingQty: orderQty - ctx.totalPredictFilled,
                        avgPrice: orderPrice,
                        title: task.title,
                    });

                    if (newFilled > 0) {
                        if (isPaused) {
                            // 暂停期间检测到成交，强制对冲以避免风险暴露
                            console.log(`[TakerExecutor] Task ${task.id}: Fill detected while paused, hedging to avoid exposure...`);
                            await this.incrementalHedge(ctx, hedgeTokenId, newFilled);
                            if (signal.aborted) return;
                        } else {
                            // 检查是否应该触发对冲 (考虑 $1 名义金额阈值)
                            const isPredictFullyFilled = orderStatus.status === 'FILLED' || orderStatus.remainingQty === 0;
                            const hedgeCheck = await this.checkShouldHedge(ctx, hedgeTokenId, newFilled, isPredictFullyFilled);

                            if (hedgeCheck.shouldHedge) {
                                await this.incrementalHedge(ctx, hedgeTokenId, hedgeCheck.hedgeQty);
                                if (signal.aborted) return;
                            }
                        }
                    }
                }

                // 6. 检查是否全部成交
                if (orderStatus.status === 'FILLED' || orderStatus.remainingQty === 0) {
                    if (orderStatus.filledQty === 0) {
                        // FILLED 但 filledQty=0，视为取消
                        console.warn(`[TakerExecutor] Task ${task.id}: SELL order FILLED but filledQty=0, treating as CANCELLED`);
                        this.updateTask(task.id, { status: 'CANCELLED' });
                        await this.taskLogger.logTaskLifecycle(task.id, 'TASK_CANCELLED', {
                            status: 'CANCELLED',
                            reason: 'Order FILLED but filledQty=0',
                        });
                        return;
                    }

                    if (isPaused) {
                        console.log(`[TakerExecutor] Task ${task.id}: Fully filled but paused, waiting for price recovery...`);
                    } else {
                        await this.finishHedging(ctx, hedgeTokenId);
                        return;
                    }
                }

                // 7. 全部成交且已对冲完成
                if (ctx.totalPredictFilled >= orderQty && ctx.totalHedged >= ctx.totalPredictFilled && !isPaused) {
                    console.log(`[TakerExecutor] Task ${task.id}: SELL completed`);
                    return;
                }

                // WSS 事件可打断等待
                if (wssEventPromise) {
                    await Promise.race([this.delay(DEFAULT_POLL_INTERVAL), wssEventPromise]);
                } else {
                    await this.delay(DEFAULT_POLL_INTERVAL);
                }
            }
        } finally {
            // 清理 BSC WSS 订阅
            if (cancelBscWssWatch) {
                try { cancelBscWssWatch(); } catch { /* ignore */ }
            }

            // ★ 任务取消时主动撤销 Predict 订单，防止部分成交后遗留挂单
            if (signal.aborted && ctx.currentOrderHash) {
                console.log(`[TakerExecutor] Task ${task.id}: Aborting - cancelling Predict order ${ctx.currentOrderHash.slice(0, 16)}...`);
                try {
                    const cancelResult = await this.predictTrader.cancelOrder(ctx.currentOrderHash);
                    if (cancelResult.success) {
                        console.log(`[TakerExecutor] Task ${task.id}: ✅ Predict order cancelled on abort`);
                    } else {
                        console.warn(`[TakerExecutor] Task ${task.id}: ⚠️ Predict order cancel returned false (may be filled)`);
                    }
                } catch (e: any) {
                    console.warn(`[TakerExecutor] Task ${task.id}: ❌ Cancel on abort failed: ${e.message}`);
                }
            }

            console.log(`[TakerExecutor] Task ${task.id}: SELL price guard stopped, bscWssEnabled=${!!bscWssWatcher?.isConnected()}`);
        }
    }

    /**
     * SELL 订单超时处理
     */
    private async handleSellTimeout(
        ctx: TakerContext,
        hedgeTokenId: string,
        orderPrice: number,
        orderQty: number,
        minPolyBid: number
    ): Promise<void> {
        const { task, signal } = ctx;
        const MAX_PRICE_WAIT_MS = 5 * 60 * 1000;  // 最大等待价格恢复 5 分钟

        // 1. 取消订单前刷新成交量
        const statusBeforeCancel = await this.predictTrader.getOrderStatus(ctx.currentOrderHash!);
        if (statusBeforeCancel && statusBeforeCancel.filledQty > ctx.totalPredictFilled) {
            ctx.totalPredictFilled = statusBeforeCancel.filledQty;
        }

        // 2. 取消订单
        try {
            await this.predictTrader.cancelOrder(ctx.currentOrderHash!);
        } catch (e) {
            console.warn(`[TakerExecutor] Task ${task.id}: Cancel failed (may be filled):`, e);
        }

        // 3. 再次刷新成交量
        const statusAfterCancel = await this.predictTrader.getOrderStatus(ctx.currentOrderHash!);
        const finalFilledQty = statusAfterCancel?.filledQty ?? ctx.totalPredictFilled;
        const avgPrice = orderPrice;

        // ★ 同步任务状态
        this.updateTask(task.id, {
            predictFilledQty: finalFilledQty,
            avgPredictPrice: avgPrice,
            remainingQty: orderQty - finalFilledQty,
        });

        await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
            platform: 'predict',
            orderId: ctx.currentOrderHash!,
            side: 'SELL',
            outcome: task.arbSide || 'YES',
            price: orderPrice,
            quantity: orderQty,
            filledQty: finalFilledQty,
            remainingQty: orderQty - finalFilledQty,
            avgPrice,
            title: task.title,
            cancelReason: 'SELL 超时',
        });

        // 4. 如果有成交，等待风控条件满足后对冲
        if (finalFilledQty > ctx.totalHedged) {
            const { price: currentPolyBid } = await this.getHedgePrice(hedgeTokenId, 'SELL');

            if (currentPolyBid < minPolyBid) {
                // 暂停等待
                this.updateTask(task.id, { status: 'PAUSED' });
                console.log(`[TakerExecutor] Task ${task.id}: Timeout with fills, but Poly bid too low. Waiting (max ${MAX_PRICE_WAIT_MS / 1000}s)...`);

                // ★ 等待价格恢复 (带 signal 和最大等待时长)
                const waitStartTime = Date.now();
                while (!signal.aborted && Date.now() - waitStartTime < MAX_PRICE_WAIT_MS) {
                    await this.delay(1000);
                    const { price: newPolyBid } = await this.getHedgePrice(hedgeTokenId, 'SELL');
                    if (newPolyBid >= minPolyBid) {
                        console.log(`[TakerExecutor] Task ${task.id}: Poly bid recovered to ${newPolyBid.toFixed(4)}`);
                        break;
                    }
                }

                // 检查是否因取消或超时退出
                if (signal.aborted) {
                    console.log(`[TakerExecutor] Task ${task.id}: Price wait cancelled by signal`);
                    this.updateTask(task.id, { status: 'CANCELLED' });
                    await this.taskLogger.logTaskLifecycle(task.id, 'TASK_COMPLETED', {
                        status: 'CANCELLED',
                        reason: 'Task cancelled while waiting for Poly bid recovery',
                    });
                    return;
                }

                if (Date.now() - waitStartTime >= MAX_PRICE_WAIT_MS) {
                    console.log(`[TakerExecutor] Task ${task.id}: Price wait timeout, forcing hedge anyway`);
                    await this.taskLogger.logTakerEvent(task.id, 'HEDGE_PRICE_INVALID', {
                        hedgePrice: currentPolyBid,
                        minAllowed: minPolyBid,
                        side: 'SELL',
                    });
                    // 继续执行对冲，即使价格不理想（避免裸露头寸）
                }
            }

            // 执行对冲 - SELL 任务直接使用成交数量，不扣除 fee
            ctx.totalPredictFilled = finalFilledQty;
            await this.hedgeAndEnd(ctx, hedgeTokenId, finalFilledQty);
        } else {
            // 无成交
            this.updateTask(task.id, { status: 'CANCELLED' });
            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_COMPLETED', {
                status: 'CANCELLED',
                reason: 'SELL order timeout with no fills',
            });
        }
    }

    // ========================================================================
    // 成本守护 + 超时 + 成交监控
    // ========================================================================

    /**
     * 合并轮询：成本守护 + 超时撤单 + 成交监控
     */
    private async runWithCostGuard(
        ctx: TakerContext,
        hedgeTokenId: string,
        orderPrice: number,
        orderQty: number
    ): Promise<void> {
        const { task, signal } = ctx;
        const predictSide = task.type;
        const orderTimeout = task.orderTimeout || DEFAULT_ORDER_TIMEOUT;
        const startTime = Date.now();
        const feeRateBps = task.feeRateBps || 200;
        const maxTotalCost = task.maxTotalCost || 1;

        // 记录成本守护启动
        const hasWsClient = !!this.polyWsClient;
        await this.taskLogger.logCostGuard(task.id, 'COST_GUARD_STARTED', {
            maxTotalCost,
            predictMarketId: task.marketId,
            polymarketTokenId: hedgeTokenId,
            feeRateBps,
            pollInterval: DEFAULT_POLL_INTERVAL,
            eventDriven: hasWsClient,  // 记录是否使用事件驱动
        });

        // ========================================================================
        // 事件驱动价格保护 (Polymarket WS 订单簿变化触发)
        // ========================================================================
        let costGuardTriggered = false;
        let lastCostCheckTime = 0;

        // 节流的成本检查函数
        const throttledCostCheck = async () => {
            const now = Date.now();
            // 节流：距离上次检查不足 COST_CHECK_THROTTLE_MS，跳过
            if (now - lastCostCheckTime < COST_CHECK_THROTTLE_MS) return;
            lastCostCheckTime = now;

            // 已触发则跳过
            if (costGuardTriggered || signal.aborted) return;

            try {
                const costCheck = await this.getCurrentCost(task, hedgeTokenId, feeRateBps);
                if (costCheck.totalCost > maxTotalCost) {
                    costGuardTriggered = true;
                    console.log(`[TakerExecutor] Task ${task.id}: Cost guard triggered by WS event, cost=${costCheck.totalCost.toFixed(4)} > ${maxTotalCost}`);
                    await this.taskLogger.logCostGuard(task.id, 'COST_GUARD_TRIGGERED', {
                        maxTotalCost,
                        predictMarketId: task.marketId,
                        polymarketTokenId: hedgeTokenId,
                        feeRateBps,
                        currentCost: costCheck.totalCost,
                        predictAsk: costCheck.predictAsk,
                        polyAsk: costCheck.polyAsk,
                        fee: costCheck.fee,
                        triggeredBy: 'WS_EVENT',
                    });
                    // 触发撤单（通过 abort signal）
                    // 注意：实际撤单在主循环中处理
                }
            } catch (err) {
                // 静默处理，避免影响主流程
            }
        };

        // 设置 WS 订阅（如果可用）- 使用多订阅者模式
        let wsListenerId: string | null = null;
        if (this.polyWsClient) {
            // 使用 addOrderBookListener 注册监听器（带 assetId 过滤）
            wsListenerId = this.polyWsClient.addOrderBookListener(
                () => throttledCostCheck(),
                hedgeTokenId  // 只监听对冲 token
            );
            console.log(`[TakerExecutor] Task ${task.id}: Event-driven cost guard enabled (throttle=${COST_CHECK_THROTTLE_MS}ms, listenerId=${wsListenerId})`);
        } else {
            console.log(`[TakerExecutor] Task ${task.id}: No WS client, using polling fallback for cost guard`);
        }

        // ========================================================================
        // BSC WSS 成交事件处理 (WSS-first 架构)
        // - WSS 作为快速主通道，接收链上 OrderFilled 事件
        // - 增量去重累加，更新 wssFilledQty
        // - 合并: totalPredictFilled = max(wssFilledQty, restFilledQty)
        // - REST 作为兜底/对账
        // ========================================================================
        let bscWssWatcher: BscOrderWatcher | null = null;
        let cancelBscWssWatch: (() => void) | null = null;
        let wssEventResolve: (() => void) | null = null;
        let wssEventPromise: Promise<void> | null = null;

        const resetWssSignal = () => {
            wssEventPromise = new Promise<void>((resolve) => {
                wssEventResolve = resolve;
            });
        };
        resetWssSignal();

        /**
         * 合并 WSS 和 REST 成交量，更新 totalPredictFilled
         * 规则: totalPredictFilled = max(wssFilledQty, restFilledQty)，单调不减
         * @returns 是否有新成交 (totalPredictFilled 增加)
         */
        const mergeFilledQty = (): boolean => {
            const merged = Math.max(ctx.wssFilledQty, ctx.restFilledQty);
            // Clamp 到 [0, orderQty]，防止超量
            const clamped = Math.min(Math.max(0, merged), orderQty);
            if (clamped > ctx.totalPredictFilled) {
                ctx.totalPredictFilled = clamped;
                return true;
            }
            return false;
        };

        try {
            bscWssWatcher = getBscOrderWatcher();
            if (bscWssWatcher.isConnected() && ctx.currentOrderHash) {
                cancelBscWssWatch = bscWssWatcher.watchOrder(
                    ctx.currentOrderHash,
                    (event: OrderFilledEvent) => {
                        // 1. 去重: 使用 txHash:logIndex 作为唯一键
                        const dedupKey = `${event.txHash}:${event.logIndex}`;
                        if (ctx.wssFillEvents.has(dedupKey)) {
                            // 重复事件，跳过
                            return;
                        }
                        ctx.wssFillEvents.add(dedupKey);

                        // 2. 累加增量（使用统一工具函数）
                        const fillDelta = getSharesFromFillEvent(event);
                        ctx.wssFilledQty += fillDelta;

                        // 3. 记录首次 WSS 成交时间 (使用事件自带的时间戳)
                        if (!ctx.wssFirstFillTime) {
                            ctx.wssFirstFillTime = event.timestamp;
                            console.log(`[TakerExecutor] Task ${task.id}: WSS first fill at ${ctx.wssFirstFillTime - startTime}ms, delta=${fillDelta.toFixed(4)}, wssTotal=${ctx.wssFilledQty.toFixed(4)}`);
                        }

                        // 4. 唤醒主循环 (非阻塞信号)
                        // 注意: 不在 callback 里调用 mergeFilledQty()，合并逻辑留给主循环
                        // 这样主循环能正确检测增量并触发对冲
                        if (wssEventResolve) {
                            wssEventResolve();
                            resetWssSignal(); // 支持连续 fill
                        }
                    },
                    orderTimeout + 10000
                );
                console.log(`[TakerExecutor] Task ${task.id}: BSC WSS order listener enabled (WSS-first mode)`);
            }
        } catch {
            // watcher 未启用/未配置，静默降级到 REST-only
            console.log(`[TakerExecutor] Task ${task.id}: BSC WSS not available, using REST-only mode`);
        }

        // 状态预获取: 立即发起第一次状态查询 (并行)
        let prefetchResult: Awaited<ReturnType<typeof this.predictTrader.getOrderStatus>> | null = null;
        const prefetchPromise = this.predictTrader.getOrderStatus(ctx.currentOrderHash!).then(r => {
            prefetchResult = r;
            return r;
        });
        console.log(`[TakerExecutor] Task ${task.id}: Started status prefetch at ${Date.now() - startTime}ms`);

        try {
            while (!signal.aborted) {
                const elapsed = Date.now() - startTime;
                ctx.statusFetchAttempts++;

                // 1. 获取订单状态 (首次使用预获取结果，后续正常轮询)
                let orderStatus;
                if (ctx.statusFetchAttempts === 1 && prefetchResult !== null) {
                    // 使用预获取结果
                    orderStatus = prefetchResult;
                } else if (ctx.statusFetchAttempts === 1) {
                    // 首次但预获取还没返回，等待预获取
                    orderStatus = await prefetchPromise;
                } else {
                    // 后续正常轮询
                    orderStatus = await this.predictTrader.getOrderStatus(ctx.currentOrderHash!);
                }

                // 2. 处理状态获取失败
                if (!orderStatus) {
                    ctx.statusFetchFailures++;

                    // 检查是否超过首次状态获取超时 (在收到任何有效响应之前)
                    if (!ctx.hasReceivedValidStatus && elapsed >= STATUS_FETCH_TIMEOUT) {
                        console.error(`[TakerExecutor] Task ${task.id}: Status fetch timeout after ${elapsed}ms, ${ctx.statusFetchAttempts} attempts`);
                        await this.taskLogger.logTakerEvent(task.id, 'ORDER_TIMEOUT', {
                            orderHash: ctx.currentOrderHash,
                            timeoutMs: STATUS_FETCH_TIMEOUT,
                            filledQty: 0,
                            remainingQty: orderQty,
                        });
                        // 尝试撤单并结束
                        await this.handleCancelAndEnd(ctx, 'ORDER_TIMEOUT', hedgeTokenId, orderPrice, orderQty);
                        return;
                    }

                    // 记录连续失败
                    if (ctx.statusFetchFailures % 10 === 0) {
                        console.warn(`[TakerExecutor] Task ${task.id}: Status fetch failed ${ctx.statusFetchFailures} times consecutively`);
                    }

                    await this.delay(DEFAULT_POLL_INTERVAL);
                    continue;
                }

                // 3. 首次收到有效状态响应
                if (!ctx.hasReceivedValidStatus) {
                    ctx.hasReceivedValidStatus = true;
                    ctx.firstValidStatusTime = Date.now();
                    ctx.statusFetchFailures = 0; // 重置连续失败计数
                    console.log(`[TakerExecutor] Task ${task.id}: First valid status received after ${ctx.firstValidStatusTime - startTime}ms, status=${orderStatus.status}, filled=${orderStatus.filledQty}`);
                } else {
                    // 后续成功获取时重置失败计数
                    ctx.statusFetchFailures = 0;
                }

                // ================================================================
                // REST 成交检测 + WSS/REST 合并 (WSS-first 架构)
                // ================================================================

                // 更新 REST 成交量 (单调不减)
                if (orderStatus.filledQty > ctx.restFilledQty) {
                    ctx.restFilledQty = orderStatus.filledQty;
                }

                // 合并 WSS 和 REST 成交量
                const prevTotalFilled = ctx.totalPredictFilled;
                const hasNewFill = mergeFilledQty();

                // 2. 检查是否有新成交
                if (hasNewFill) {
                    const newFilled = ctx.totalPredictFilled - prevTotalFilled;

                    // 记录首次成交时间 (优先使用 WSS 时间)
                    if (!ctx.predictFirstFillTime) {
                        ctx.predictFirstFillTime = ctx.wssFirstFillTime || Date.now();
                        const source = ctx.wssFirstFillTime ? 'WSS' : 'REST';
                        console.log(`[TakerExecutor] Task ${task.id}: First fill detected (${source}) after ${ctx.predictFirstFillTime - (ctx.predictSubmitTime || ctx.startTime)}ms`);
                    }

                    const avgPredictPrice = orderPrice;

                    await this.taskLogger.logOrderEvent(task.id, 'ORDER_PARTIAL_FILL', {
                        platform: 'predict',
                        orderId: ctx.currentOrderHash!,
                        side: predictSide,
                        outcome: task.arbSide || 'YES',
                        price: orderPrice,
                        quantity: orderQty,
                        filledQty: newFilled,
                        remainingQty: orderQty - ctx.totalPredictFilled,
                        avgPrice: avgPredictPrice,
                        title: task.title,
                    });

                    this.updateTask(task.id, {
                        status: 'PARTIALLY_FILLED',
                        predictFilledQty: ctx.totalPredictFilled,
                        avgPredictPrice: avgPredictPrice,
                        remainingQty: Math.max(0, ctx.totalPredictFilled - ctx.totalHedged),
                    });

                    // 增量对冲 - 计算扣除 fee 后的实际 shares（两位小数精度）
                    const actualNewFilled = calculateActualSharesReceived(
                        newFilled,
                        avgPredictPrice,
                        feeRateBps
                    );
                    console.log(`[TakerExecutor] Task ${task.id}: Incremental hedge: rawFilled=${newFilled}, actualFilled=${actualNewFilled} (wss=${ctx.wssFilledQty.toFixed(4)}, rest=${ctx.restFilledQty.toFixed(4)})`);

                    // 检查是否应该触发对冲 (考虑 $1 名义金额阈值)
                    const isPredictFullyFilled = orderStatus.status === 'FILLED';
                    const hedgeCheck = await this.checkShouldHedge(ctx, hedgeTokenId, actualNewFilled, isPredictFullyFilled);

                    if (hedgeCheck.shouldHedge) {
                        await this.incrementalHedge(ctx, hedgeTokenId, hedgeCheck.hedgeQty);
                        if (signal.aborted) return;
                    }
                }

                // 3. 检查是否全部成交
                if (orderStatus.status === 'FILLED') {
                    const avgPredictPrice = orderPrice;
                    // 验证: FILLED 状态但 filledQty=0 表示订单可能被撤销/过期
                    if (orderStatus.filledQty === 0) {
                        console.warn(`[TakerExecutor] Task ${task.id}: Order status FILLED but filledQty=0, treating as CANCELLED`);
                        await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
                            platform: 'predict',
                            orderId: ctx.currentOrderHash || '',
                            side: predictSide,
                            outcome: task.arbSide || 'YES',
                            price: orderPrice,
                            quantity: orderQty,
                            filledQty: 0,
                            remainingQty: orderQty,
                            avgPrice: 0,
                            title: task.title,
                            error: { errorType: 'FilledButEmpty', message: 'Order status FILLED but filledQty=0' },
                        });
                        this.updateTask(task.id, {
                            status: 'CANCELLED',
                        });
                        return;
                    }

                    // 计算延迟统计
                    const latencyStats = {
                        submitToFirstStatus: ctx.firstValidStatusTime && ctx.predictSubmitTime
                            ? ctx.firstValidStatusTime - ctx.predictSubmitTime
                            : undefined,
                        submitToFill: ctx.predictFirstFillTime && ctx.predictSubmitTime
                            ? ctx.predictFirstFillTime - ctx.predictSubmitTime
                            : undefined,
                        statusFetchAttempts: ctx.statusFetchAttempts,
                    };
                    console.log(`[TakerExecutor] Task ${task.id}: Predict latency - submitToFirstStatus=${latencyStats.submitToFirstStatus}ms, submitToFill=${latencyStats.submitToFill}ms, attempts=${latencyStats.statusFetchAttempts}`);

                    await this.taskLogger.logOrderEvent(task.id, 'ORDER_FILLED', {
                        platform: 'predict',
                        orderId: ctx.currentOrderHash!,
                        side: predictSide,
                        outcome: task.arbSide || 'YES',
                        price: orderPrice,
                        quantity: orderQty,
                        filledQty: orderStatus.filledQty,
                        remainingQty: 0,
                        avgPrice: avgPredictPrice,
                        title: task.title,
                        latency: latencyStats,
                    });

                    // 完成所有对冲
                    // 兜底记录 Predict 平均成交价（订单详情接口不返回 price 字段时为 0）
                    this.updateTask(task.id, {
                        predictFilledQty: Math.max(ctx.totalPredictFilled, orderStatus.filledQty),
                        avgPredictPrice: avgPredictPrice,
                        remainingQty: Math.max(0, orderStatus.filledQty - ctx.totalHedged),
                    });

                    await this.finishHedging(ctx, hedgeTokenId);
                    return;
                }

                // 4. 检查超时
                if (elapsed >= orderTimeout) {
                    await this.taskLogger.logTakerEvent(task.id, 'ORDER_TIMEOUT', {
                        orderHash: ctx.currentOrderHash,
                        timeoutMs: orderTimeout,
                        filledQty: ctx.totalPredictFilled,
                        remainingQty: orderQty - ctx.totalPredictFilled,
                    });
                    await this.handleCancelAndEnd(ctx, 'ORDER_TIMEOUT', hedgeTokenId, orderPrice, orderQty);
                    return;
                }

                // 5. 检查成本 (事件驱动优先，轮询降级)
                // 如果 WS 事件已触发成本保护，立即处理
                if (costGuardTriggered) {
                    await this.handleCancelAndEnd(ctx, 'COST_INVALID', hedgeTokenId, orderPrice, orderQty);
                    return;
                }

                // 无 WS 时使用轮询降级 (每 N 次轮询检查一次)
                if (!hasWsClient && ctx.statusFetchAttempts % COST_CHECK_FALLBACK_INTERVAL === 0) {
                    const costCheck = await this.getCurrentCost(task, hedgeTokenId, feeRateBps);
                    if (costCheck.totalCost > maxTotalCost) {
                        await this.taskLogger.logCostGuard(task.id, 'COST_GUARD_TRIGGERED', {
                            maxTotalCost,
                            predictMarketId: task.marketId,
                            polymarketTokenId: hedgeTokenId,
                            feeRateBps,
                            currentCost: costCheck.totalCost,
                            predictAsk: costCheck.predictAsk,
                            polyAsk: costCheck.polyAsk,
                            fee: costCheck.fee,
                            triggeredBy: 'POLLING_FALLBACK',
                        });
                        await this.handleCancelAndEnd(ctx, 'COST_INVALID', hedgeTokenId, orderPrice, orderQty);
                        return;
                    }
                }

                // WSS 事件可打断等待：收到 fill 事件后立刻进入下一轮 getOrderStatus
                if (wssEventPromise) {
                    await Promise.race([
                        this.delay(DEFAULT_POLL_INTERVAL),
                        wssEventPromise,
                    ]);
                } else {
                    await this.delay(DEFAULT_POLL_INTERVAL);
                }
            }
        } finally {
            // 清理 WS 订阅 + 记录监听器状态 (便于排查泄漏)
            if (wsListenerId && this.polyWsClient) {
                const listenerRemoved = this.polyWsClient.removeOrderBookListener(wsListenerId);
                const remainingListeners = this.polyWsClient.getListenerCount();
                console.log(`[TakerExecutor] Task ${task.id}: WS listener cleanup - removed=${listenerRemoved}, listenerId=${wsListenerId}, remaining=${remainingListeners}`);
            }

            if (cancelBscWssWatch) {
                try { cancelBscWssWatch(); } catch { /* ignore */ }
            }

            // ★ 任务取消时主动撤销 Predict 订单，防止部分成交后遗留挂单
            if (signal.aborted && ctx.currentOrderHash) {
                console.log(`[TakerExecutor] Task ${task.id}: Aborting - cancelling Predict order ${ctx.currentOrderHash.slice(0, 16)}...`);
                try {
                    const cancelResult = await this.predictTrader.cancelOrder(ctx.currentOrderHash);
                    if (cancelResult.success) {
                        console.log(`[TakerExecutor] Task ${task.id}: ✅ Predict order cancelled on abort`);
                    } else {
                        console.warn(`[TakerExecutor] Task ${task.id}: ⚠️ Predict order cancel returned false (may be filled)`);
                    }
                } catch (e: any) {
                    console.warn(`[TakerExecutor] Task ${task.id}: ❌ Cancel on abort failed: ${e.message}`);
                }
            }

            await this.taskLogger.logCostGuard(task.id, 'COST_GUARD_STOPPED', {
                maxTotalCost,
                predictMarketId: task.marketId,
                polymarketTokenId: hedgeTokenId,
                feeRateBps,
                reason: signal.aborted ? 'ORDER_CANCELLED' : (costGuardTriggered ? 'COST_INVALID' : 'TASK_COMPLETED'),
                eventDriven: hasWsClient,
                bscWssEnabled: !!bscWssWatcher?.isConnected(),
            });
        }
    }

    // ========================================================================
    // 撤单 + 结束处理
    // ========================================================================

    /**
     * 统一撤单处理（超时/成本失效共用）
     *
     * 关键优化：
     * 1. 撤单前强制刷新成交量 - 避免丢失部分成交
     * 2. 无 PAUSED 状态 - 直接 cancel + end
     * 3. 对冲使用 WS 缓存取价
     */
    private async handleCancelAndEnd(
        ctx: TakerContext,
        reason: CancelReason,
        hedgeTokenId: string,
        orderPrice: number,
        orderQty: number
    ): Promise<void> {
        const { task } = ctx;

        // ★ 关键优化 1: 撤单前强制刷新成交量
        const statusBeforeCancel = await this.predictTrader.getOrderStatus(ctx.currentOrderHash!);
        const filledQtyBeforeCancel = statusBeforeCancel?.filledQty ?? 0;

        // 更新 ctx（可能轮询还没同步到最新成交）
        if (filledQtyBeforeCancel > ctx.totalPredictFilled) {
            await this.taskLogger.logTakerEvent(task.id, 'FORCED_FILL_REFRESH', {
                previousFilled: ctx.totalPredictFilled,
                actualFilled: filledQtyBeforeCancel,
            });
            ctx.totalPredictFilled = filledQtyBeforeCancel;
        }

        // 撤单
        await this.predictTrader.cancelOrder(ctx.currentOrderHash!);

        // ★ 撤单后再刷新一次（防止撤单期间有新成交）
        const statusAfterCancel = await this.predictTrader.getOrderStatus(ctx.currentOrderHash!);
        const finalFilledQty = statusAfterCancel?.filledQty ?? filledQtyBeforeCancel;

        if (finalFilledQty > ctx.totalPredictFilled) {
            await this.taskLogger.logTakerEvent(task.id, 'FORCED_FILL_REFRESH', {
                previousFilled: ctx.totalPredictFilled,
                actualFilled: finalFilledQty,
            });
            ctx.totalPredictFilled = finalFilledQty;
        }

        // 记录撤单
        const cancelReasonText = reason === 'ORDER_TIMEOUT' ? '订单超时' : reason === 'COST_INVALID' ? '成本失效' : reason;
        await this.taskLogger.logOrderEvent(task.id, 'ORDER_CANCELLED', {
            platform: 'predict',
            orderId: ctx.currentOrderHash!,
            side: task.type,
            outcome: task.arbSide || 'YES',
            price: orderPrice,
            quantity: orderQty,
            filledQty: finalFilledQty,
            remainingQty: Math.max(0, orderQty - finalFilledQty),
            avgPrice: orderPrice,
            title: task.title,
            cancelReason: cancelReasonText,
        });

        // 分支处理
        if (finalFilledQty === 0) {
            // 无成交，直接结束
            this.updateTask(task.id, {
                status: 'CANCELLED',
                cancelReason: reason,
            });

            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_CANCELLED', {
                status: 'CANCELLED',
                reason: `No fills, cancelled due to ${reason}`,
            });
            return;
        }

        // 有成交，进入对冲（不进入 PAUSED）
        // 计算扣除 fee 后的实际 shares（两位小数精度）
        const avgPredictPrice = orderPrice;
        const actualFilledQty = calculateActualSharesReceived(
            finalFilledQty,
            avgPredictPrice,
            task.feeRateBps || 200
        );
        console.log(`[TakerExecutor] Task ${task.id}: Cancel hedge - rawFilled=${finalFilledQty}, actualFilled=${actualFilledQty}`);
        await this.hedgeAndEnd(ctx, hedgeTokenId, actualFilledQty);
    }

    /**
     * 对冲并结束任务
     * 关键优化：使用 WS 缓存取价，降低延迟
     */
    private async hedgeAndEnd(
        ctx: TakerContext,
        hedgeTokenId: string,
        filledQty: number
    ): Promise<void> {
        const { task } = ctx;
        const remainingToHedge = filledQty - ctx.totalHedged;

        if (remainingToHedge <= 0) {
            const profit = this.calculateProfit(ctx);
            this.updateTask(task.id, {
                status: 'COMPLETED',
                actualProfit: profit,
                remainingQty: 0,
                completedAt: Date.now(),
            });
            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_COMPLETED', {
                status: 'COMPLETED',
                profit,
            });
            return;
        }

        // ★ 关键优化: 使用 WS 缓存取价
        // BUY 任务取 asks，SELL 任务取 bids
        const hedgeSide: 'BUY' | 'SELL' = task.type === 'SELL' ? 'SELL' : 'BUY';
        const { price: hedgePrice, source } = await this.getHedgePrice(hedgeTokenId, hedgeSide);

        await this.taskLogger.logTakerEvent(task.id, 'HEDGE_PRICE_SOURCE', {
            source,
            price: hedgePrice,
            side: hedgeSide,
        });

        // 价格检查: BUY 检查 maxAsk，SELL 检查 minBid
        if (hedgeSide === 'BUY' && hedgePrice > (task.polymarketMaxAsk || 1)) {
            await this.taskLogger.logTakerEvent(task.id, 'HEDGE_PRICE_INVALID', {
                hedgePrice,
                maxAllowed: task.polymarketMaxAsk,
            });
            // 仍然尝试对冲，但记录警告
        } else if (hedgeSide === 'SELL' && hedgePrice < (task.polymarketMinBid || 0)) {
            await this.taskLogger.logTakerEvent(task.id, 'HEDGE_PRICE_INVALID', {
                hedgePrice,
                minAllowed: task.polymarketMinBid,
            });
            // 仍然尝试对冲，但记录警告
        }

        // 执行对冲重试
        const maxRetries = task.maxHedgeRetries || DEFAULT_MAX_HEDGE_RETRIES;
        let retryCount = 0;
        let hedged = ctx.totalHedged;

        // 确定对冲的方向和 outcome
        // YES 端套利: Predict 买/卖 YES, Polymarket 对冲买/卖 NO
        // NO 端套利: Predict 买/卖 NO, Polymarket 对冲买/卖 YES
        const hedgeOutcome = task.arbSide === 'NO' ? 'YES' : 'NO';

        await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_STARTED', {
            hedgeQty: remainingToHedge,
            totalHedged: hedged,
            totalPredictFilled: filledQty,
            avgHedgePrice: hedged > 0 ? ctx.hedgePriceSum / hedged : 0,
            retryCount: 0,
            title: task.title,
            side: hedgeSide,
            outcome: hedgeOutcome,
        });

        // 计算剩余需对冲数量，低于阈值视为完成
        const remainingUnhedged = () => filledQty - hedged;
        const isHedgeComplete = () => remainingUnhedged() <= MIN_HEDGE_THRESHOLD;
        let abortedByError = false;  // IOC 安全阀超时等致命错误，跳过 LOSS_HEDGE
        let abortError: any = null;

        while (!isHedgeComplete() && retryCount < maxRetries) {
            retryCount++;
            const toHedge = remainingUnhedged();

            // 如果剩余数量低于阈值，跳过对冲尝试
            if (toHedge < MIN_HEDGE_THRESHOLD) {
                console.log(`[TakerExecutor] Task ${task.id}: Remaining ${toHedge.toFixed(4)} shares below threshold ${MIN_HEDGE_THRESHOLD}, treating as complete`);
                break;
            }

            // 先记录 ATTEMPT（即使下单失败也有审计记录）
            await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_ATTEMPT', {
                hedgeQty: toHedge,
                totalHedged: hedged,
                totalPredictFilled: filledQty,
                avgHedgePrice: hedged > 0 ? ctx.hedgePriceSum / hedged : 0,
                retryCount,
                title: task.title,
                side: hedgeSide,
                outcome: hedgeOutcome,
            });

            let result: HedgeResult;
            try {
                result = await this.executeHedgeOrder(ctx, hedgeTokenId, toHedge);
            } catch (hedgeErr: any) {
                // IOC 安全阀超时 or 其他错误: 中止重试循环，跳过 LOSS_HEDGE
                console.error(`[TakerExecutor] Task ${task.id}: executeHedgeOrder error, aborting retry loop: ${hedgeErr.message}`);
                abortedByError = true;
                abortError = hedgeErr;
                await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_FAILED', {
                    hedgeQty: toHedge,
                    totalHedged: hedged,
                    totalPredictFilled: filledQty,
                    retryCount,
                    title: task.title,
                    side: hedgeSide,
                    outcome: hedgeOutcome,
                    error: hedgeErr,
                });
                break;
            }

            if (result.filledQty > 0) {
                hedged += result.filledQty;
                ctx.totalHedged = hedged;
                ctx.hedgePriceSum += result.avgPrice * result.filledQty;

                await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_PARTIAL', {
                    hedgeQty: result.filledQty,
                    totalHedged: hedged,
                    totalPredictFilled: filledQty,
                    avgHedgePrice: ctx.hedgePriceSum / hedged,
                    retryCount,
                    title: task.title,
                    side: hedgeSide,
                    outcome: hedgeOutcome,
                    orderId: result.orderId,
                    orderStatus: result.isComplete ? 'MATCHED' : 'CANCELLED',
                });

                this.updateTask(task.id, {
                    hedgedQty: hedged,
                    avgPolymarketPrice: ctx.hedgePriceSum / hedged,
                    remainingQty: Math.max(0, remainingUnhedged()),
                });
            }

            if (isHedgeComplete()) {
                // 计算 Polymarket 延迟
                const polyLatency = ctx.polyFirstFillTime && ctx.polySubmitTime
                    ? ctx.polyFirstFillTime - ctx.polySubmitTime
                    : undefined;
                console.log(`[TakerExecutor] Task ${task.id}: Poly latency - submitToFill=${polyLatency}ms`);

                // 计算平均总成本
                const avgPredictPrice = task.predictPrice || 0;
                const avgPolyPrice = hedged > 0 ? ctx.hedgePriceSum / hedged : 0;
                const avgTotalCost = avgPredictPrice + avgPolyPrice;

                await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_COMPLETED', {
                    hedgeQty: 0,
                    totalHedged: hedged,
                    totalPredictFilled: filledQty,
                    avgHedgePrice: avgPolyPrice,
                    retryCount,
                    title: task.title,
                    side: hedgeSide,
                    outcome: hedgeOutcome,
                    avgPredictPrice,
                    avgTotalCost,
                });

                // Shares 对齐检查
                const alignment = validateSharesAlignment(filledQty, hedged);
                if (!alignment.aligned) {
                    console.warn(`[TakerExecutor] Task ${task.id}: Shares misalignment detected! predict=${filledQty}, poly=${hedged}, diff=${alignment.difference.toFixed(4)}`);
                    await this.taskLogger.logTakerEvent(task.id, 'SHARES_MISALIGNMENT', {
                        predictFilled: filledQty,
                        polyHedged: hedged,
                        difference: alignment.difference,
                    });
                }

                const profit = this.calculateProfit(ctx);
                this.updateTask(task.id, {
                    status: 'COMPLETED',
                    actualProfit: profit,
                    remainingQty: 0,
                    completedAt: Date.now(),
                });

                // 完整延迟统计
                const fullLatencyStats = {
                    predictSubmitToFirstStatus: ctx.firstValidStatusTime && ctx.predictSubmitTime
                        ? ctx.firstValidStatusTime - ctx.predictSubmitTime : undefined,
                    predictSubmitToFill: ctx.predictFirstFillTime && ctx.predictSubmitTime
                        ? ctx.predictFirstFillTime - ctx.predictSubmitTime : undefined,
                    polySubmitToFill: polyLatency,
                    totalTaskTime: Date.now() - ctx.startTime,
                    statusFetchAttempts: ctx.statusFetchAttempts,
                };
                console.log(`[TakerExecutor] Task ${task.id}: Full latency stats:`, JSON.stringify(fullLatencyStats));

                await this.taskLogger.logTaskLifecycle(task.id, 'TASK_COMPLETED', {
                    status: 'COMPLETED',
                    profit,
                    latency: fullLatencyStats,
                });
                return;
            }

            await this.delay(300);  // 短退避
        }

        // 循环结束后再次检查：如果剩余数量低于阈值，视为完成
        const finalUnhedged = remainingUnhedged();
        if (finalUnhedged < MIN_HEDGE_THRESHOLD) {
            console.log(`[TakerExecutor] Task ${task.id}: Final unhedged ${finalUnhedged.toFixed(4)} below threshold ${MIN_HEDGE_THRESHOLD}, marking as COMPLETED`);

            const polyLatency = ctx.polyFirstFillTime && ctx.polySubmitTime
                ? ctx.polyFirstFillTime - ctx.polySubmitTime
                : undefined;

            // 计算平均总成本
            const avgPredictPriceFinal = task.predictPrice || 0;
            const avgPolyPriceFinal = hedged > 0 ? ctx.hedgePriceSum / hedged : 0;
            const avgTotalCostFinal = avgPredictPriceFinal + avgPolyPriceFinal;

            await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_COMPLETED', {
                hedgeQty: 0,
                totalHedged: hedged,
                totalPredictFilled: filledQty,
                avgHedgePrice: avgPolyPriceFinal,
                retryCount,
                title: task.title,
                side: hedgeSide,
                outcome: hedgeOutcome,
                avgPredictPrice: avgPredictPriceFinal,
                avgTotalCost: avgTotalCostFinal,
            });

            const profit = this.calculateProfit(ctx);
            this.updateTask(task.id, {
                status: 'COMPLETED',
                actualProfit: profit,
                remainingQty: finalUnhedged,  // 记录实际剩余（虽然很小）
                completedAt: Date.now(),
            });

            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_COMPLETED', {
                status: 'COMPLETED',
                profit,
            });
            return;
        }

        // 致命错误中止: 已在 catch 中记录 HEDGE_FAILED，不再重试/补偿
        if (abortedByError) {
            console.log(`[TakerExecutor] Task ${task.id}: Hedge aborted by error, skipping LOSS_HEDGE. Unhedged=${finalUnhedged.toFixed(4)}`);
            this.updateTask(task.id, {
                status: 'HEDGE_FAILED',
                remainingQty: finalUnhedged,
            });
            const avgHedgePrice = hedged > 0 ? ctx.hedgePriceSum / hedged : 0;
            const abortReason = abortError?.message || 'Hedge aborted by error';
            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                status: 'HEDGE_FAILED',
                reason: abortReason,
                error: abortError,
            });
            await this.polyTrader.notifyOrderAlert({
                type: 'FAILED',
                platform: 'POLYMARKET',
                marketName: `⚠️ HEDGE ABORTED - ${task.title || `Task ${task.id}`}`,
                action: hedgeSide,
                side: hedgeOutcome,
                price: avgHedgePrice,
                quantity: filledQty,
                filledQuantity: hedged,
                error: `${abortReason}. Unhedged: ${finalUnhedged.toFixed(4)} shares. MANUAL INTERVENTION REQUIRED.`,
            });
            return;
        }

        // 正常重试耗尽 - 进入亏损对冲模式
        await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_FAILED', {
            hedgeQty: finalUnhedged,
            totalHedged: hedged,
            totalPredictFilled: filledQty,
            avgHedgePrice: hedged > 0 ? ctx.hedgePriceSum / hedged : 0,
            retryCount,
            title: task.title,
            side: hedgeSide,
            outcome: hedgeOutcome,
        });

        // 尝试亏损对冲 (Loss Hedge)
        console.log(`[TakerExecutor] Task ${task.id}: Entering LOSS_HEDGE mode, unhedged=${finalUnhedged.toFixed(4)}`);
        await this.executeLossHedge(ctx, hedgeTokenId, finalUnhedged, hedgeSide, hedged);
    }

    // ========================================================================
    // 增量对冲
    // ========================================================================

    /**
     * 增量对冲 - 部分成交时立即对冲
     */
    private async incrementalHedge(
        ctx: TakerContext,
        hedgeTokenId: string,
        newFilled: number
    ): Promise<void> {
        const { task } = ctx;
        const hedgeSide = task.type === 'BUY' ? 'BUY' : 'SELL';
        const hedgeOutcome = task.arbSide === 'NO' ? 'YES' : 'NO';

        this.updateTask(task.id, { status: 'HEDGING' });

        let result: HedgeResult;
        try {
            result = await this.executeHedgeOrder(ctx, hedgeTokenId, newFilled);
        } catch (hedgeErr: any) {
            // IOC 安全阀超时等错误: 记录后中止任务，避免继续对冲导致超量
            const unhedged = Math.max(0, ctx.totalPredictFilled - ctx.totalHedged);
            const avgHedgePrice = ctx.totalHedged > 0 ? ctx.hedgePriceSum / ctx.totalHedged : 0;
            console.error(`[TakerExecutor] Task ${task.id}: incrementalHedge error: ${hedgeErr.message}`);
            await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_FAILED', {
                hedgeQty: newFilled,
                totalHedged: ctx.totalHedged,
                totalPredictFilled: ctx.totalPredictFilled,
                title: task.title,
                side: hedgeSide,
                outcome: hedgeOutcome,
                error: hedgeErr,
            });
            this.updateTask(task.id, {
                status: 'HEDGE_FAILED',
                remainingQty: unhedged,
            });
            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                status: 'HEDGE_FAILED',
                reason: hedgeErr?.message || 'Incremental hedge aborted',
                error: hedgeErr,
            });
            await this.polyTrader.notifyOrderAlert({
                type: 'FAILED',
                platform: 'POLYMARKET',
                marketName: `⚠️ HEDGE ABORTED - ${task.title || `Task ${task.id}`}`,
                action: hedgeSide,
                side: hedgeOutcome,
                price: avgHedgePrice,
                quantity: ctx.totalPredictFilled,
                filledQuantity: ctx.totalHedged,
                error: `${hedgeErr?.message || 'Incremental hedge aborted'}. Unhedged: ${unhedged.toFixed(4)} shares. MANUAL INTERVENTION REQUIRED.`,
            });
            ctx.abortController?.abort();
            return;
        }

        if (result.filledQty > 0) {
            ctx.totalHedged += result.filledQty;
            ctx.hedgePriceSum += result.avgPrice * result.filledQty;

            this.updateTask(task.id, {
                hedgedQty: ctx.totalHedged,
                avgPolymarketPrice: ctx.hedgePriceSum / ctx.totalHedged,
                remainingQty: Math.max(0, ctx.totalPredictFilled - ctx.totalHedged),
            });

            await this.taskLogger.logHedgeEvent(task.id, 'HEDGE_PARTIAL', {
                hedgeQty: result.filledQty,
                totalHedged: ctx.totalHedged,
                totalPredictFilled: ctx.totalPredictFilled,
                avgHedgePrice: ctx.hedgePriceSum / ctx.totalHedged,
                retryCount: 0,
                title: task.title,
                side: hedgeSide,
                outcome: hedgeOutcome,
                orderId: result.orderId,
                orderStatus: result.isComplete ? 'MATCHED' : 'CANCELLED',
            });
        }

        // 回到 PARTIALLY_FILLED 继续监控
        this.updateTask(task.id, { status: 'PARTIALLY_FILLED' });
    }

    /**
     * 完成所有对冲
     * - BUY 任务：扣除 fee 后计算实际 shares（fee 减少购买到的 shares）
     * - SELL 任务：直接使用成交数量（fee 从 USDC 扣除，不影响 shares 数量）
     */
    private async finishHedging(ctx: TakerContext, hedgeTokenId: string): Promise<void> {
        const { task } = ctx;

        // 根据任务类型决定对冲数量
        let actualTotalFilled: number;
        if (task.type === 'SELL') {
            // SELL（平仓）: 直接使用成交数量
            actualTotalFilled = ctx.totalPredictFilled;
        } else {
            // BUY（开仓）: 扣除 fee 后计算实际 shares
            const avgPredictPrice = task.predictPrice || 0;
            actualTotalFilled = calculateActualSharesReceived(
                ctx.totalPredictFilled,
                avgPredictPrice,
                task.feeRateBps || 200
            );
        }
        const remainingToHedge = actualTotalFilled - ctx.totalHedged;

        console.log(`[TakerExecutor] Task ${task.id}: Finish hedge - rawFilled=${ctx.totalPredictFilled}, actualTotal=${actualTotalFilled}, hedged=${ctx.totalHedged}, remaining=${remainingToHedge}`);

        if (remainingToHedge > 0) {
            await this.hedgeAndEnd(ctx, hedgeTokenId, actualTotalFilled);
        } else {
            const profit = this.calculateProfit(ctx);
            this.updateTask(task.id, {
                status: 'COMPLETED',
                actualProfit: profit,
                remainingQty: 0,
                completedAt: Date.now(),
            });
            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_COMPLETED', {
                status: 'COMPLETED',
                profit,
            });
        }
    }

    // ========================================================================
    // 对冲订单执行
    // ========================================================================

    // ========================================================================
    // 亏损对冲 (Loss Hedge)
    // ========================================================================

    /**
     * 亏损对冲模式 - 当正常对冲失败后，以更高价格继续尝试对冲
     *
     * 规则:
     * - 以当前卖一价继续 IOC 对冲
     * - 卖一价不能超过 maxAsk + 2%，否则等待价格回落
     * - 最大等待时间 5 分钟
     */
    private async executeLossHedge(
        ctx: TakerContext,
        hedgeTokenId: string,
        unhedgedQty: number,
        hedgeSide: 'BUY' | 'SELL',
        initialHedged: number
    ): Promise<void> {
        const { task } = ctx;
        const maxAsk = task.polymarketMaxAsk || 1;
        const maxAllowedPrice = maxAsk * (1 + LOSS_HEDGE_MAX_PRICE_DEVIATION);
        const startTime = Date.now();

        let hedged = initialHedged;
        let remaining = unhedgedQty;
        let retryCount = 0;
        let waitingForPriceCount = 0;

        this.updateTask(task.id, { status: 'LOSS_HEDGE' });

        // 确定对冲方向和 outcome
        const hedgeOutcome = task.arbSide === 'NO' ? 'YES' : 'NO';

        await this.taskLogger.logHedgeEvent(task.id, 'LOSS_HEDGE_STARTED', {
            hedgeQty: remaining,
            totalHedged: hedged,
            totalPredictFilled: ctx.totalPredictFilled,
            maxAllowedPrice,
            originalMaxAsk: maxAsk,
            title: task.title,
            side: hedgeSide,
            outcome: hedgeOutcome,
        });

        console.log(`[TakerExecutor] Task ${task.id}: LOSS_HEDGE started - remaining=${remaining.toFixed(4)}, maxAllowedPrice=${maxAllowedPrice.toFixed(4)}`);

        let abortedByError = false;  // IOC 安全阀超时等致命错误，跳过后续重复日志
        let abortError: any = null;

        while (remaining >= MIN_HEDGE_THRESHOLD && retryCount < LOSS_HEDGE_MAX_RETRIES) {
            // 检查超时
            if (Date.now() - startTime > LOSS_HEDGE_MAX_WAIT_TIME_MS) {
                console.log(`[TakerExecutor] Task ${task.id}: LOSS_HEDGE timeout after ${LOSS_HEDGE_MAX_WAIT_TIME_MS}ms`);
                break;
            }

            // 获取当前卖一价
            const { price: currentAsk, source } = await this.getHedgePrice(hedgeTokenId, hedgeSide);

            // 检查价格是否超出阈值
            if (hedgeSide === 'BUY' && currentAsk > maxAllowedPrice) {
                waitingForPriceCount++;
                console.log(`[TakerExecutor] Task ${task.id}: LOSS_HEDGE waiting - currentAsk=${currentAsk.toFixed(4)} > maxAllowed=${maxAllowedPrice.toFixed(4)} (wait #${waitingForPriceCount})`);

                await this.taskLogger.logHedgeEvent(task.id, 'LOSS_HEDGE_WAITING', {
                    hedgeQty: remaining,
                    totalHedged: hedged,
                    currentPrice: currentAsk,
                    maxAllowedPrice,
                    waitCount: waitingForPriceCount,
                    title: task.title,
                    side: hedgeSide,
                    outcome: hedgeOutcome,
                });

                await this.delay(LOSS_HEDGE_WAIT_INTERVAL_MS);
                continue;
            }

            // 价格在可接受范围内，尝试对冲
            retryCount++;
            console.log(`[TakerExecutor] Task ${task.id}: LOSS_HEDGE attempt #${retryCount} - price=${currentAsk.toFixed(4)}, qty=${remaining.toFixed(4)}`);

            // 先记录 ATTEMPT（即使下单失败也有审计记录）
            await this.taskLogger.logHedgeEvent(task.id, 'LOSS_HEDGE_ATTEMPT', {
                hedgeQty: remaining,
                totalHedged: hedged,
                hedgePrice: currentAsk,
                priceSource: source,
                retryCount,
                title: task.title,
                side: hedgeSide,
                outcome: hedgeOutcome,
            });

            let result: HedgeResult;
            try {
                result = await this.executeHedgeOrder(ctx, hedgeTokenId, remaining);
            } catch (hedgeErr: any) {
                // IOC 安全阀超时 or 其他错误: 中止重试循环
                console.error(`[TakerExecutor] Task ${task.id}: LOSS_HEDGE executeHedgeOrder error, aborting: ${hedgeErr.message}`);
                await this.taskLogger.logHedgeEvent(task.id, 'LOSS_HEDGE_FAILED', {
                    hedgeQty: remaining,
                    totalHedged: hedged,
                    totalPredictFilled: ctx.totalPredictFilled,
                    retryCount,
                    title: task.title,
                    side: hedgeSide,
                    outcome: hedgeOutcome,
                    error: hedgeErr,
                });
                abortedByError = true;
                abortError = hedgeErr;
                break;
            }

            if (result.filledQty > 0) {
                hedged += result.filledQty;
                remaining -= result.filledQty;
                ctx.totalHedged = hedged;
                ctx.hedgePriceSum += result.avgPrice * result.filledQty;

                this.updateTask(task.id, {
                    hedgedQty: hedged,
                    avgPolymarketPrice: ctx.hedgePriceSum / hedged,
                    remainingQty: remaining,
                });

                await this.taskLogger.logHedgeEvent(task.id, 'LOSS_HEDGE_PARTIAL', {
                    hedgeQty: result.filledQty,
                    totalHedged: hedged,
                    totalPredictFilled: ctx.totalPredictFilled,
                    avgHedgePrice: ctx.hedgePriceSum / hedged,
                    retryCount,
                    title: task.title,
                    side: hedgeSide,
                    outcome: hedgeOutcome,
                    orderId: result.orderId,
                    orderStatus: result.isComplete ? 'MATCHED' : 'CANCELLED',
                });

                console.log(`[TakerExecutor] Task ${task.id}: LOSS_HEDGE partial - filled=${result.filledQty.toFixed(4)}, remaining=${remaining.toFixed(4)}`);
            }

            // 短暂等待后重试
            if (remaining >= MIN_HEDGE_THRESHOLD) {
                await this.delay(HEDGE_WAIT_DELAY);
            }
        }

        // 致命错误中止: 已在 catch 中记录 LOSS_HEDGE_FAILED，不再重复记录
        if (abortedByError) {
            console.log(`[TakerExecutor] Task ${task.id}: LOSS_HEDGE aborted by error. Unhedged=${remaining.toFixed(4)}`);
            this.updateTask(task.id, {
                status: 'HEDGE_FAILED',
                remainingQty: remaining,
            });
            const avgHedgePrice = hedged > 0 ? ctx.hedgePriceSum / hedged : 0;
            const abortReason = abortError?.message || 'Loss hedge aborted by error';
            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                status: 'HEDGE_FAILED',
                reason: abortReason,
                error: abortError,
            });
            await this.polyTrader.notifyOrderAlert({
                type: 'FAILED',
                platform: 'POLYMARKET',
                marketName: `⚠️ LOSS_HEDGE ABORTED - ${task.title || `Task ${task.id}`}`,
                action: hedgeSide,
                side: hedgeOutcome,
                price: avgHedgePrice,
                quantity: ctx.totalPredictFilled,
                filledQuantity: hedged,
                error: `${abortReason}. Unhedged: ${remaining.toFixed(4)} shares. MANUAL INTERVENTION REQUIRED.`,
            });
            return;
        }

        // 检查最终结果
        if (remaining < MIN_HEDGE_THRESHOLD) {
            // 亏损对冲成功完成
            const profit = this.calculateProfit(ctx);
            console.log(`[TakerExecutor] Task ${task.id}: LOSS_HEDGE completed - hedged=${hedged.toFixed(4)}, profit=${profit.toFixed(4)}`);

            this.updateTask(task.id, {
                status: 'COMPLETED',
                actualProfit: profit,
                remainingQty: remaining,
                completedAt: Date.now(),
            });

            // 计算平均总成本
            const avgPredictPrice = task.predictPrice || 0;
            const avgPolyPrice = hedged > 0 ? ctx.hedgePriceSum / hedged : 0;
            const avgTotalCost = avgPredictPrice + avgPolyPrice;

            await this.taskLogger.logHedgeEvent(task.id, 'LOSS_HEDGE_COMPLETED', {
                hedgeQty: 0,
                totalHedged: hedged,
                totalPredictFilled: ctx.totalPredictFilled,
                avgHedgePrice: avgPolyPrice,
                retryCount,
                totalWaitCount: waitingForPriceCount,
                elapsedMs: Date.now() - startTime,
                title: task.title,
                side: hedgeSide,
                outcome: hedgeOutcome,
                avgPredictPrice,
                avgTotalCost,
            });

            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_COMPLETED', {
                status: 'COMPLETED',
                profit,
                lossHedge: true,
            });
        } else {
            // 亏损对冲也失败了 - 需要人工接管
            const elapsedMs = Date.now() - startTime;
            const isTimeout = elapsedMs >= LOSS_HEDGE_MAX_WAIT_TIME_MS;
            const failReason = isTimeout
                ? `Loss hedge timeout after ${Math.round(elapsedMs / 60000)} minutes`
                : `Loss hedge failed after ${retryCount} retries`;

            console.log(`[TakerExecutor] Task ${task.id}: LOSS_HEDGE failed - remaining=${remaining.toFixed(4)}, reason=${failReason}`);

            this.updateTask(task.id, {
                status: 'HEDGE_FAILED',
                remainingQty: remaining,
            });

            await this.taskLogger.logHedgeEvent(task.id, 'LOSS_HEDGE_FAILED', {
                hedgeQty: remaining,
                totalHedged: hedged,
                totalPredictFilled: ctx.totalPredictFilled,
                avgHedgePrice: hedged > 0 ? ctx.hedgePriceSum / hedged : 0,
                retryCount,
                totalWaitCount: waitingForPriceCount,
                elapsedMs,
                title: task.title,
                side: hedgeSide,
                outcome: hedgeOutcome,
            });

            await this.taskLogger.logTaskLifecycle(task.id, 'TASK_FAILED', {
                status: 'HEDGE_FAILED',
                reason: `${failReason}, unhedged: ${remaining.toFixed(4)}`,
            });

            // 发送 TG 通知 - 需要人工接管
            await this.polyTrader.notifyOrderAlert({
                type: 'FAILED',
                platform: 'POLYMARKET',
                marketName: `⚠️ LOSS_HEDGE FAILED - ${task.title || `Task ${task.id}`}`,
                action: 'BUY',
                side: task.arbSide === 'NO' ? 'YES' : 'NO',
                price: hedged > 0 ? ctx.hedgePriceSum / hedged : 0,
                quantity: ctx.totalPredictFilled,
                filledQuantity: hedged,
                error: `${failReason}. Unhedged: ${remaining.toFixed(4)} shares. MANUAL INTERVENTION REQUIRED.`,
            });
        }
    }

    // ========================================================================
    // 执行对冲订单
    // ========================================================================

    /**
     * 执行对冲订单 (IOC)
     *
     * BUY 任务 (开仓): Polymarket 买入对冲代币
     * SELL 任务 (平仓): Polymarket 卖出对冲代币
     */
    private async executeHedgeOrder(
        ctx: TakerContext,
        hedgeTokenId: string,
        quantity: number
    ): Promise<HedgeResult> {
        const { task } = ctx;

        // 根据任务类型决定对冲方向
        // BUY 任务 (开仓): 买入对冲代币
        // SELL 任务 (平仓): 卖出对冲代币
        const hedgeSide: 'BUY' | 'SELL' = task.type === 'SELL' ? 'SELL' : 'BUY';

        // 获取最新价格 (BUY 取 asks，SELL 取 bids)
        const { price: hedgePrice } = await this.getHedgePrice(hedgeTokenId, hedgeSide);

        // 保守对齐到一位小数
        const alignedQty = Math.floor(quantity * 10) / 10;
        if (alignedQty <= 0) {
            console.log(`[TakerExecutor] Hedge qty too small after alignment: ${quantity} → ${alignedQty}`);
            return { filledQty: 0, avgPrice: 0, isComplete: false };
        }

        // IOC 订单 - 记录下单时间
        const polySubmitTime = Date.now();
        if (!ctx.polySubmitTime) {
            ctx.polySubmitTime = polySubmitTime;  // 首次对冲下单时间
        }

        // 对冲代币方向: YES→NO (arbSide='YES'), NO→YES (arbSide='NO')
        const hedgeOutcome = task.arbSide === 'NO' ? 'YES' : 'NO';
        console.log(`[TakerExecutor] Task ${task.id}: Hedge ${hedgeSide} ${hedgeOutcome} @ ${hedgePrice}, qty=${alignedQty}`);

        const result = await this.polyTrader.placeOrder({
            tokenId: hedgeTokenId,
            side: hedgeSide,
            price: hedgePrice,
            quantity: alignedQty,
            orderType: 'IOC',
            outcome: hedgeOutcome as 'YES' | 'NO',
            negRisk: task.negRisk,  // negRisk 市场需要使用不同的合约地址
            marketTitle: task.title,  // 市场标题用于 TG 通知
            conditionId: task.polymarketConditionId,  // 用于从 poly-slugs 查找标题
        });

        if (!result.success || !result.orderId) {
            return { filledQty: 0, avgPrice: 0, isComplete: false };
        }

        // 获取成交状态（优先用 pollOrderStatus，内部可走 WS 加速；失败回退单次查询）
        let status = await this.polyTrader.pollOrderStatus(result.orderId, 500)
            ?? await this.polyTrader.getOrderStatus(result.orderId);

        // IOC 安全阀: 如果 poll 后订单仍非终态(MATCHED/CANCELLED)，
        // 主动取消并循环确认，直到终态或超时。
        // 超时仍非终态时抛错中止重试，防止重复成交 (8x over-hedge bug)
        const statusBeforeCancel = status?.status ?? 'unknown';
        const isFinal = statusBeforeCancel === 'MATCHED' || statusBeforeCancel === 'CANCELLED';
        if (!isFinal) {
            console.log(`[TakerExecutor] Task ${task.id}: IOC order ${result.orderId.slice(0, 10)}... status=${statusBeforeCancel} after poll, forcing cancel`);
            try {
                await this.polyTrader.cancelOrder(result.orderId, { skipTelegram: true });
            } catch (cancelErr: any) {
                console.log(`[TakerExecutor] IOC cancel (may already resolved): ${cancelErr.message}`);
            }

            // 循环确认终态，直到 MATCHED/CANCELLED 或超时
            const resolveStart = Date.now();
            let resolved = false;
            while (Date.now() - resolveStart < IOC_RESOLVE_TIMEOUT_MS) {
                await this.delay(IOC_RESOLVE_INTERVAL_MS);
                const refreshed = await this.polyTrader.getOrderStatus(result.orderId);
                if (refreshed) {
                    status = refreshed;
                    if (refreshed.status === 'MATCHED' || refreshed.status === 'CANCELLED') {
                        resolved = true;
                        break;
                    }
                }
            }

            // 记录 IOC_FORCE_CANCEL 事件
            const statusAfterCancel = status?.status ?? 'unknown';
            await this.taskLogger.logTakerEvent(task.id, 'IOC_FORCE_CANCEL', {
                orderId: result.orderId,
                statusBeforeCancel,
                statusAfterCancel,
                finalFilledQty: status?.filledQty ?? 0,
            });

            // 超时仍非终态: 中止对冲流程，防止重复下单
            if (!resolved) {
                const errMsg = `IOC order ${result.orderId.slice(0, 10)}... unresolved after ${IOC_RESOLVE_TIMEOUT_MS}ms (status=${statusAfterCancel}), aborting hedge to prevent over-hedge`;
                console.error(`[TakerExecutor] Task ${task.id}: ${errMsg}`);
                throw new Error(errMsg);
            }
        }

        // 记录首次 Poly 成交时间
        if (status?.filledQty && status.filledQty > 0 && !ctx.polyFirstFillTime) {
            ctx.polyFirstFillTime = Date.now();
            console.log(`[TakerExecutor] Task ${ctx.task.id}: First Poly fill detected after ${ctx.polyFirstFillTime - polySubmitTime}ms`);

            // TG 通知（Polymarket）：包含任务总完成时间（Predict 下单 → Polymarket 获取到成交）
            const taskTotalMs = ctx.predictSubmitTime ? (ctx.polyFirstFillTime - ctx.predictSubmitTime) : undefined;
            await this.polyTrader.notifyOrderAlert({
                type: 'FILLED',
                platform: 'POLYMARKET',
                marketName: task.title || `Task ${task.id}`,
                action: hedgeSide,  // BUY/SELL
                side: hedgeOutcome as 'YES' | 'NO',  // YES/NO 方向
                price: hedgePrice,
                quantity: alignedQty,
                filledQuantity: status.filledQty,
                latency: {
                    submitToFill: ctx.polyFirstFillTime - polySubmitTime,
                    taskTotalMs,
                },
            });
        }

        return {
            filledQty: status?.filledQty ?? 0,
            avgPrice: hedgePrice,
            orderId: result.orderId,
            isComplete: status?.status === 'MATCHED',
        };
    }

    // ========================================================================
    // 工具函数
    // ========================================================================

    /**
     * 获取当前成本
     */
    private async getCurrentCost(
        task: Task,
        hedgeTokenId: string,
        feeRateBps: number
    ): Promise<{
        predictAsk: number;
        polyAsk: number;
        fee: number;
        totalCost: number;
        isValid: boolean;
    }> {
        // 使用缓存获取订单簿
        const { data: predictBook } = await this.orderbookCache.get(
            predictCacheKey(task.marketId),
            async () => {
                const book = await this.predictTrader.getOrderbook(task.marketId);
                return book ?? { bids: [], asks: [] };
            }
        );

        const { data: polyBook } = await this.orderbookCache.get(
            polyCacheKey(hedgeTokenId),
            async () => this.polyTrader.getOrderbook(hedgeTokenId)
        );

        // 重要: Predict 侧只拿到 YES 订单簿
        // - YES 端 BUY: 买入 YES → 用 YES ask
        // - NO 端 BUY: 买入 NO → 用 NO ask = 1 - YES bid
        // - SELL 任务: 卖出 YES → 用 YES bid 计算（较少用）
        const predictBookTyped = predictBook as { bids?: [number, number][]; asks?: [number, number][] };
        const rawBestYesAsk = predictBookTyped?.asks?.[0]?.[0];
        const rawBestYesBid = predictBookTyped?.bids?.[0]?.[0];
        // NaN 检查: parseFloat("") 或 parseFloat(null) 会返回 NaN
        const bestYesAsk = (rawBestYesAsk !== undefined && !isNaN(rawBestYesAsk)) ? rawBestYesAsk : 1;
        const bestYesBid = (rawBestYesBid !== undefined && !isNaN(rawBestYesBid)) ? rawBestYesBid : 0;

        // 根据 arbSide 和 type 决定 Predict 侧的成本价格
        const arbSide = task.arbSide || 'YES';
        let predictAsk: number;
        if (task.type === 'BUY') {
            if (arbSide === 'YES') {
                // YES 端 BUY: 买入 YES token，成本 = YES ask
                predictAsk = bestYesAsk;
            } else {
                // NO 端 BUY: 买入 NO token，成本 = NO ask = 1 - YES bid
                predictAsk = bestYesBid > 0 ? (1 - bestYesBid) : 1;
            }
        } else {
            // SELL: 卖出 YES 持仓，收入 = YES bid → 等价成本 = 1 - YES bid
            predictAsk = bestYesBid > 0 ? (1 - bestYesBid) : 1;
        }
        const polyAsk = polyBook?.asks?.[0]?.price ?? 1;
        const fee = calculatePredictFee(predictAsk, feeRateBps);
        const totalCost = predictAsk + polyAsk + fee;

        return {
            predictAsk,
            polyAsk,
            fee,
            totalCost,
            isValid: totalCost <= 1,  // <= 1 即不亏钱
        };
    }

    /**
     * 检查是否应该触发对冲 (考虑 Polymarket $1 最小名义金额阈值)
     *
     * @param ctx 任务上下文
     * @param hedgeTokenId 对冲代币 ID
     * @param newFilledQty 本次新成交的数量
     * @param isPredictFullyFilled Predict 订单是否已完全成交
     * @returns { shouldHedge: boolean, hedgeQty: number, reason: string }
     */
    private async checkShouldHedge(
        ctx: TakerContext,
        hedgeTokenId: string,
        newFilledQty: number,
        isPredictFullyFilled: boolean
    ): Promise<{ shouldHedge: boolean; hedgeQty: number; reason: string }> {
        const task = ctx.task;

        // 累计待对冲数量
        ctx.pendingHedgeQty += newFilledQty;

        // 计算总未对冲量
        const totalUnhedged = ctx.totalPredictFilled - ctx.totalHedged;

        // 如果未对冲量 < MIN_HEDGE_THRESHOLD，无需对冲
        if (totalUnhedged < MIN_HEDGE_THRESHOLD) {
            return { shouldHedge: false, hedgeQty: 0, reason: `Unhedged ${totalUnhedged.toFixed(4)} < MIN_HEDGE_THRESHOLD ${MIN_HEDGE_THRESHOLD}` };
        }

        // 获取当前对冲价格估算
        const hedgeSide: 'BUY' | 'SELL' = task.type === 'SELL' ? 'SELL' : 'BUY';
        const { price: hedgePrice } = await this.getHedgePrice(hedgeTokenId, hedgeSide);
        ctx.lastHedgePriceEstimate = hedgePrice;

        // 计算名义金额 = 待对冲量 × 对冲价格
        const notionalAmount = ctx.pendingHedgeQty * hedgePrice;

        // 如果 Predict 已完全成交，强制对冲剩余量（无论金额大小）
        if (isPredictFullyFilled && totalUnhedged >= MIN_HEDGE_THRESHOLD) {
            const hedgeQty = totalUnhedged;
            ctx.pendingHedgeQty = 0;  // 清空累计
            console.log(`[TakerExecutor] Predict fully filled, force hedge remaining ${hedgeQty.toFixed(4)} (notional: $${(hedgeQty * hedgePrice).toFixed(2)})`);
            return { shouldHedge: true, hedgeQty, reason: 'Predict fully filled' };
        }

        // 检查名义金额是否达到阈值
        if (notionalAmount >= MIN_HEDGE_NOTIONAL) {
            const hedgeQty = ctx.pendingHedgeQty;
            ctx.pendingHedgeQty = 0;  // 清空累计
            console.log(`[TakerExecutor] Notional $${notionalAmount.toFixed(2)} >= $${MIN_HEDGE_NOTIONAL}, triggering hedge for ${hedgeQty.toFixed(4)} shares`);
            return { shouldHedge: true, hedgeQty, reason: `Notional $${notionalAmount.toFixed(2)} >= threshold` };
        }

        // 金额未达阈值，继续累计
        console.log(`[TakerExecutor] Accumulating: pending=${ctx.pendingHedgeQty.toFixed(4)}, notional=$${notionalAmount.toFixed(2)} < $${MIN_HEDGE_NOTIONAL}, waiting...`);
        return { shouldHedge: false, hedgeQty: 0, reason: `Notional $${notionalAmount.toFixed(2)} < $${MIN_HEDGE_NOTIONAL}` };
    }

    /**
     * 获取对冲价格 (WS 优先，REST 降级)
     * @param hedgeTokenId - 对冲代币 ID
     * @param side - 'BUY' 取 asks，'SELL' 取 bids
     */
    private async getHedgePrice(
        hedgeTokenId: string,
        side: 'BUY' | 'SELL' = 'BUY'
    ): Promise<{
        price: number;
        source: HedgePriceSource;
    }> {
        // 1. 尝试 WS 缓存
        if (this.polyWsClient) {
            const wsBook = this.polyWsClient.getOrderBook(hedgeTokenId);
            if (wsBook) {
                const age = Date.now() - (wsBook.updateTimestampMs || 0);
                const priceLevel = side === 'BUY' ? wsBook.asks?.[0] : wsBook.bids?.[0];
                if (age < WS_CACHE_MAX_AGE && priceLevel) {
                    // NormalizedOrderBook 是 [number, number][] 格式
                    return {
                        price: priceLevel[0],
                        source: 'WS_CACHE',
                    };
                }
            }
        }

        // 2. 降级到 REST
        const restBook = await this.polyTrader.getOrderbook(hedgeTokenId);
        const defaultPrice = side === 'BUY' ? 1 : 0;  // BUY 默认最高价，SELL 默认最低价
        const price = side === 'BUY'
            ? (restBook?.asks?.[0]?.price ?? defaultPrice)
            : (restBook?.bids?.[0]?.price ?? defaultPrice);
        return {
            price,
            source: 'REST_FALLBACK',
        };
    }

    /**
     * 获取对冲 token ID
     * 套利逻辑:
     * - YES 端套利 (arbSide='YES'): Predict 买 YES → Polymarket 买 NO
     * - NO 端套利 (arbSide='NO'): Predict 买 NO → Polymarket 买 YES
     *
     * isInverted 标记表示市场方向是否反转
     */
    private getHedgeTokenId(task: Task): string {
        const arbSide = task.arbSide || 'YES';
        let tokenId: string | undefined;

        // 调试日志：显示 task 中的 token IDs
        console.log(`[TakerExecutor] getHedgeTokenId: arbSide=${arbSide}, isInverted=${task.isInverted}, ` +
            `yesTokenId=${task.polymarketYesTokenId?.slice(0, 20) || 'undefined'}..., ` +
            `noTokenId=${task.polymarketNoTokenId?.slice(0, 20) || 'undefined'}...`);

        if (arbSide === 'YES') {
            // YES 端套利: 对冲买 Poly NO (或 YES if inverted)
            tokenId = task.isInverted
                ? task.polymarketYesTokenId
                : task.polymarketNoTokenId;
        } else {
            // NO 端套利: 对冲买 Poly YES (或 NO if inverted)
            tokenId = task.isInverted
                ? task.polymarketNoTokenId
                : task.polymarketYesTokenId;
        }

        console.log(`[TakerExecutor] getHedgeTokenId: selected hedgeTokenId=${tokenId?.slice(0, 20) || 'undefined'}...`);

        // 验证 token ID 存在
        if (!tokenId) {
            const neededField = arbSide === 'YES'
                ? (task.isInverted ? 'polymarketYesTokenId' : 'polymarketNoTokenId')
                : (task.isInverted ? 'polymarketNoTokenId' : 'polymarketYesTokenId');
            throw new Error(
                `Task ${task.id} missing required field: ${neededField}. ` +
                `Please ensure the task was created with Polymarket token IDs.`
            );
        }

        return tokenId;
    }

    /**
     * 验证 Polymarket 持仓是否足够用于 SELL 任务
     * @param task 任务配置
     * @param hedgeTokenId 对冲 token ID
     * @returns 验证结果
     */
    private async validatePolymarketPosition(
        task: Task,
        hedgeTokenId: string
    ): Promise<{
        valid: boolean;
        actualShares: number;
        outcome: string;
    }> {
        const POLYMARKET_PROXY_ADDRESS = process.env.POLYMARKET_PROXY_ADDRESS;
        if (!POLYMARKET_PROXY_ADDRESS) {
            console.warn('[TakerExecutor] POLYMARKET_PROXY_ADDRESS not set, skipping position validation');
            return { valid: true, actualShares: 0, outcome: 'UNKNOWN' };
        }

        try {
            const res = await fetch(
                `https://data-api.polymarket.com/positions?user=${POLYMARKET_PROXY_ADDRESS}&sizeThreshold=0.01`,
                { signal: AbortSignal.timeout(5000) }
            );

            if (!res.ok) {
                console.warn(`[TakerExecutor] Failed to fetch Polymarket positions: ${res.status}`);
                return { valid: true, actualShares: 0, outcome: 'UNKNOWN' };  // 获取失败时不阻止执行
            }

            const positions = await res.json() as any[];

            // 根据 arbSide 确定期望的 outcome
            const expectedOutcome = task.arbSide === 'NO'
                ? (task.isInverted ? 'NO' : 'YES')  // arbSide='NO' 对冲卖 YES (或 NO if inverted)
                : (task.isInverted ? 'YES' : 'NO'); // arbSide='YES' 对冲卖 NO (或 YES if inverted)

            // 查找匹配的持仓
            const matchingPosition = positions.find((p: any) => {
                const tokenId = p.asset || p.token_id || '';
                return tokenId === hedgeTokenId && !p.redeemable;
            });

            const actualShares = matchingPosition ? parseFloat(matchingPosition.size || '0') : 0;
            const valid = actualShares >= task.quantity * 0.99;  // 允许 1% 误差

            console.log(`[TakerExecutor] Position validation: hedgeTokenId=${hedgeTokenId.slice(0, 20)}..., ` +
                `expected ${expectedOutcome} >= ${task.quantity}, actual=${actualShares.toFixed(2)}, valid=${valid}`);

            return { valid, actualShares, outcome: expectedOutcome };
        } catch (error) {
            console.warn(`[TakerExecutor] Position validation error:`, error);
            return { valid: true, actualShares: 0, outcome: 'UNKNOWN' };  // 出错时不阻止执行
        }
    }

    /**
     * 计算利润
     */
    private calculateProfit(ctx: TakerContext): number {
        const { task } = ctx;
        const revenue = ctx.totalHedged * 1;  // 结算时获得 $1

        // 注意: TAKER + SELL 用于 NO 端套利，Predict 侧实际成交价是 “卖 YES 的均价”
        // 但套利成本应按 “买 NO 的等价成本” 计算：predictNoAsk = 1 - predictYesSell
        const avgPredictYesPrice = task.predictPrice || 0;

        const fallbackPredictLegCost = task.predictPrice || 0; // BUY: YES ask, SELL: NO ask
        const predictLegCostPerShare = task.type === 'SELL'
            ? (avgPredictYesPrice > 0 ? (1 - avgPredictYesPrice) : fallbackPredictLegCost)
            : (avgPredictYesPrice > 0 ? avgPredictYesPrice : fallbackPredictLegCost);
        const avgHedgePrice = ctx.totalHedged > 0 ? (ctx.hedgePriceSum / ctx.totalHedged) : 0;
        const cost = ctx.totalPredictFilled * predictLegCostPerShare + ctx.totalHedged * avgHedgePrice;
        return revenue - cost;
    }

    /**
     * 延迟
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============================================================================
// 单例
// ============================================================================

let takerExecutorInstance: TakerExecutor | null = null;

export function getTakerExecutor(): TakerExecutor | null {
    return takerExecutorInstance;
}

export function initTakerExecutor(deps: TakerExecutorDeps): TakerExecutor {
    if (!takerExecutorInstance) {
        takerExecutorInstance = new TakerExecutor(deps);
    }
    return takerExecutorInstance;
}
