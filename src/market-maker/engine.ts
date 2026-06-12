/**
 * Predict 做市模块 - 单市场做市引擎
 *
 * 核心规则：
 * - 买单量 = 最大持仓 - 当前持仓 - 买单剩余量
 * - 卖单量 = 当前持仓 - 卖单剩余量
 * - 价格严格跟随买一/卖一（带节流）
 *
 * 不变量约束：
 * - 不做空：0 <= position
 * - 不超卖：openSellRemaining <= position
 * - 不超最大持仓：position + openBuyRemaining <= maxPosition
 * - 不交叉报价：buyPrice < sellPrice（避免自成交）
 */

import type {
    MarketMakerConfig,
    GlobalConfig,
    MarketState,
    ActiveOrder,
    ScalpSellOrder,
    PendingSellOrder,
    OrderDelta,
    PriceSnapshot,
    Fill,
    TradingStats,
    MarketMakerEvents,
    PredictOrderResponse,
    PositionQueryOptions,
    OrderStatusResult,
} from './types.js';

// ============================================================================
// 做市引擎
// ============================================================================

export class MarketMakerEngine {
    private config: MarketMakerConfig;
    private globalConfig: GlobalConfig;
    private state: MarketState;
    private stats: TradingStats;
    private events: MarketMakerEvents;

    // 状态锁，防止并发
    private isProcessing = false;
    private lastBuyAdjustTime = 0;
    private lastSellAdjustTime = 0;

    // 风控计数器
    private consecutiveErrors = 0;

    // 持仓同步计数器（降低 API 请求频率）
    private tickCounter = 0;
    private readonly POSITION_SYNC_INTERVAL = 10; // 每 10 个 tick 强制同步一次持仓

    // 下单时间戳（用于避免 API 延迟导致的误判"订单消失"）
    private lastBuyPlaceTime = 0;
    private lastSellPlaceTime = 0;
    private readonly ORDER_VISIBLE_DELAY_MS = 3000; // 下单后 3 秒内不判定"订单消失"

    // 订单消失确认计数器（防止 UNKNOWN 状态导致的本地状态长期陈旧）
    private buyOrderUnknownCount = 0;
    private sellOrderUnknownCount = 0;
    private readonly MAX_UNKNOWN_COUNT = 3; // 连续 3 次 UNKNOWN 后强制清除本地状态

    // 外部依赖（通过构造函数注入）
    private fetchOrderBook: (marketId: number) => Promise<{ bids: [number, number][]; asks: [number, number][] } | null>;
    private fetchOrders: (marketId: number) => Promise<PredictOrderResponse[]>;
    private fetchOrderByHash?: (hash: string) => Promise<OrderStatusResult>;  // 可选：查询订单真实状态
    private fetchPosition: (marketId: number, tokenId: string, options: PositionQueryOptions) => Promise<number>;
    private placeOrder: (params: PlaceOrderParams) => Promise<{ id: string; hash: string }>;
    private cancelOrder: (orderId: string) => Promise<boolean>;
    private cancelOrders?: (orderIds: string[]) => Promise<{ removed: string[]; noop: string[] }>;
    private getMarketTickSize?: (marketId: number) => Promise<number>;  // 可选：获取市场价格精度

    constructor(
        config: MarketMakerConfig,
        globalConfig: GlobalConfig,
        dependencies: EngineDependencies,
        events: MarketMakerEvents = {}
    ) {
        this.config = config;
        this.globalConfig = globalConfig;
        this.events = events;

        // 注入依赖
        this.fetchOrderBook = dependencies.fetchOrderBook;
        this.fetchOrders = dependencies.fetchOrders;
        this.fetchOrderByHash = dependencies.fetchOrderByHash;
        this.fetchPosition = dependencies.fetchPosition;
        this.placeOrder = dependencies.placeOrder;
        this.cancelOrder = dependencies.cancelOrder;
        this.cancelOrders = dependencies.cancelOrders;
        this.getMarketTickSize = dependencies.getMarketTickSize;

        // 初始化状态
        this.state = {
            marketId: config.marketId,
            title: config.title,
            position: 0,
            activeBuyOrder: null,
            activeSellOrder: null,
            scalpSellOrders: [],       // SCALP 多卖单
            pendingSellOrders: [],     // 待挂卖单队列
            lastBestBid: 0,
            lastBestAsk: 0,
            lastSpread: 0,
            lastUpdateMs: 0,
            status: 'idle',
        };

        // 初始化统计
        this.stats = {
            marketId: config.marketId,
            totalBuys: 0,
            totalSells: 0,
            totalBuyVolume: 0,
            totalSellVolume: 0,
            totalBuyValue: 0,
            totalSellValue: 0,
            realizedPnL: 0,
            unrealizedPnL: 0,
            totalPnL: 0,
            avgBuyPrice: 0,
            avgSellPrice: 0,
            inventoryCost: 0,
            orderAdjustments: 0,
            startTime: new Date(),
            lastTradeTime: null,
        };
    }

    // ========================================================================
    // 公开接口
    // ========================================================================

    /**
     * 初始化引擎（从 API 同步状态）
     */
    async init(): Promise<void> {
        this.state.status = 'initializing';
        this.emitStateChange();

        try {
            // 1. 获取市场精度（如果使用剥头皮策略且未指定 tickSize）
            if (this.config.strategy === 'SCALP' && this.getMarketTickSize) {
                const tickSize = await this.getMarketTickSize(this.config.marketId);
                this.config.tickSize = tickSize;
                console.log(`[MM ${this.config.marketId}] 剥头皮策略: tickSize=${tickSize}`);
            }

            // 2. 获取当前持仓
            this.state.position = await this.fetchPosition(
                this.config.marketId,
                this.config.tokenId,
                { isNegRisk: this.config.isNegRisk, isYieldBearing: this.config.isYieldBearing }
            );

            // 3. 获取活跃订单
            const orders = await this.fetchOrders(this.config.marketId);
            this.state.activeBuyOrder = this.findOrder(orders, 'BUY');
            this.state.activeSellOrder = this.findOrder(orders, 'SELL');

            // 4. 获取当前价格（根据 outcome 自动转换订单簿）
            const book = await this.getOrderBook();
            if (book) {
                this.updatePriceFromBook(book);
                if (this.config.outcome === 'NO') {
                    console.log(`[MM ${this.config.marketId}] [NO] 订单簿已转换: bestBid=${book.bids[0]?.[0]?.toFixed(4)}, bestAsk=${book.asks[0]?.[0]?.toFixed(4)}`);
                }
            }

            // 5. SCALP 策略: 初始化已有持仓的卖单
            if (this.config.strategy === 'SCALP') {
                // 同步 API 中已有的 SELL 订单到 scalpSellOrders
                const sellOrders = orders.filter(o =>
                    o.order?.marketId === this.config.marketId &&
                    o.order?.side === 'SELL' &&
                    (o.order?.status === 'OPEN' || o.order?.status === 'PARTIALLY_FILLED')
                );
                for (const o of sellOrders) {
                    if (o.order) {
                        this.state.scalpSellOrders.push({
                            id: o.id,
                            hash: o.order.hash,
                            side: 'SELL',
                            price: o.order.price,
                            quantity: o.order.quantity,
                            filledQuantity: o.order.quantityFilled,
                            status: o.order.status as 'OPEN' | 'PARTIALLY_FILLED',
                            createdAt: new Date(o.order.createdAt),
                            costPrice: o.order.price - this.config.tickSize, // 估算成本
                            costQuantity: o.order.quantity,
                        });
                    }
                }

                // 如果有持仓但没有卖单，将持仓加入待挂队列
                const totalSellQty = this.state.scalpSellOrders.reduce(
                    (sum, o) => sum + (o.quantity - o.filledQuantity), 0
                );
                // 使用精度处理后的持仓（与订单计算保持一致）
                const effectivePosition = this.getEffectivePosition();
                const uncoveredPosition = effectivePosition - totalSellQty;

                if (uncoveredPosition > 0 && book && book.bids.length > 0) {
                    const bestBid = book.bids[0][0];
                    // 将未覆盖的持仓加入待挂卖单队列
                    this.state.pendingSellOrders.push({
                        buyPrice: bestBid,  // 以当前买一价作为成本估算
                        buyQuantity: uncoveredPosition,
                        createdAt: new Date(),
                    });
                    console.log(`[MM ${this.config.marketId}] SCALP 初始化: 持仓 ${effectivePosition} 中有 ${uncoveredPosition} 未覆盖，加入待挂队列`);
                }

                if (this.state.scalpSellOrders.length > 0) {
                    console.log(`[MM ${this.config.marketId}] SCALP 初始化: 同步 ${this.state.scalpSellOrders.length} 个已有卖单`);
                }

                // 检查是否需要取消不必要的买单
                // 如果持仓 >= maxShares，不应该有买单
                if (effectivePosition >= this.config.maxShares && this.state.activeBuyOrder) {
                    console.log(`[MM ${this.config.marketId}] SCALP 初始化: 持仓已满 (${effectivePosition} >= ${this.config.maxShares})，取消多余买单`);
                    try {
                        await this.cancelOrder(this.state.activeBuyOrder.id);
                        this.state.activeBuyOrder = null;
                    } catch (error) {
                        console.error(`[MM ${this.config.marketId}] SCALP 初始化: 取消买单失败:`, error);
                    }
                }
            }

            this.state.status = 'running';
            this.state.lastUpdateMs = Date.now();
            this.emitStateChange();

            const scalpInfo = this.config.strategy === 'SCALP'
                ? `, 多卖单=${this.state.scalpSellOrders.length}, 待挂=${this.state.pendingSellOrders.length}`
                : '';
            console.log(`[MM ${this.config.marketId}] [${this.config.outcome}] 初始化完成: 持仓=${this.state.position}, 买单=${this.state.activeBuyOrder?.quantity ?? 0}, 卖单=${this.state.activeSellOrder?.quantity ?? 0}${scalpInfo}`);
        } catch (error) {
            this.handleError(error as Error);
        }
    }

    /**
     * 主循环 - 每次轮询执行
     */
    async tick(): Promise<void> {
        // 风控检查：紧急停止
        if (this.globalConfig.emergencyStop) {
            if (this.state.status === 'running') {
                console.warn(`[MM ${this.config.marketId}] 紧急停止触发，撤销所有订单并暂停`);
                await this.cancelAllOrders();
                this.pause();
            }
            return;
        }

        // 检查状态：允许 range_paused 持续轮询，回到区间后自动恢复
        if (this.state.status !== 'running' && this.state.status !== 'range_paused') {
            return;
        }

        // 风控检查：连续错误过多
        if (this.consecutiveErrors >= this.globalConfig.maxConsecutiveErrors) {
            console.warn(`[MM ${this.config.marketId}] 连续错误 ${this.consecutiveErrors} 次，暂停做市`);
            this.pause();
            return;
        }

        // 防止并发
        if (this.isProcessing) {
            return;
        }

        this.isProcessing = true;
        const errorsAtStart = this.consecutiveErrors;

        try {
            // 1. 同步状态
            await this.syncState();

            // 1.5 SCALP 策略: 同步多卖单状态
            if (this.config.strategy === 'SCALP') {
                const orders = await this.fetchOrders(this.config.marketId);
                await this.syncScalpSellOrders(orders);
            }

            // 2. 获取最新价格（根据 outcome 自动转换订单簿）
            const book = await this.getOrderBook();
            if (!book || book.bids.length === 0 || book.asks.length === 0) {
                // 无订单簿数据，跳过
                return;
            }

            const prices = this.extractPrices(book);
            this.emitPriceUpdate(prices);

            // 风控检查：价格运行区间（可选）
            // - 卖一价不低于 minSellPrice
            // - 买一价不高于 maxBuyPrice
            const inRange = await this.enforcePriceRange(prices);
            if (!inRange) {
                // 价格越界时暂停下单（并已撤单），等待回到区间再恢复
                this.state.lastBestBid = prices.bestBid;
                this.state.lastBestAsk = prices.bestAsk;
                this.state.lastSpread = prices.spread;
                this.state.lastUpdateMs = Date.now();
                return;
            }

            // 风控检查：最小价差（minSpread<=0 表示关闭该限制）
            if (this.globalConfig.minSpread > 0 && prices.spread < this.globalConfig.minSpread) {
                // 价差过小，撤销所有订单
                console.warn(`[MM ${this.config.marketId}] 价差过小 (${(prices.spread * 100).toFixed(2)}% < ${(this.globalConfig.minSpread * 100).toFixed(2)}%)，撤销订单`);
                await this.cancelAllOrders();
                // 更新状态
                this.state.lastBestBid = prices.bestBid;
                this.state.lastBestAsk = prices.bestAsk;
                this.state.lastSpread = prices.spread;
                this.state.lastUpdateMs = Date.now();
                return;
            }

            // 风控检查：最大价差（可选）
            // spread >= maxSpreadCents 时，暂停买单但保留卖单
            if (this.config.maxSpreadCents !== undefined && this.config.maxSpreadCents > 0) {
                const spreadCents = prices.spread * 100;
                if (spreadCents >= this.config.maxSpreadCents) {
                    // 取消买单
                    if (this.state.activeBuyOrder) {
                        console.warn(`[MM ${this.config.marketId}] 价差过大 (${spreadCents.toFixed(1)}c >= ${this.config.maxSpreadCents}c)，取消买单`);
                        try {
                            await this.cancelOrder(this.state.activeBuyOrder.id);
                            this.events.onOrderCancelled?.(this.config.marketId, this.state.activeBuyOrder.id);
                            this.state.activeBuyOrder = null;
                        } catch (error) {
                            console.error(`[MM ${this.config.marketId}] 取消买单失败:`, error);
                        }
                    }

                    // 更新状态为 spread_paused
                    if (this.state.status !== 'range_paused' || !this.state.errorMessage?.includes('价差过大')) {
                        this.state.status = 'range_paused';
                        this.state.errorMessage = `价差过大: ${spreadCents.toFixed(1)}c >= ${this.config.maxSpreadCents}c`;
                        console.log(`[MM ${this.config.marketId}] ${this.state.errorMessage}`);
                    }

                    // 继续管理卖单（不 return）
                    // SCALP 策略: 只同步现有多卖单状态，不挂新卖单（因为买单已取消）
                    // FOLLOW 策略: 继续管理单卖单
                    if (this.config.strategy === 'SCALP') {
                        // SCALP: 同步多卖单状态（检测成交、移除已完成订单）
                        const orders = await this.fetchOrders(this.config.marketId);
                        await this.syncScalpSellOrders(orders);
                        // 不处理 pendingSellOrders，因为价差过大时不应挂新卖单
                    } else {
                        await this.manageSellOrderOnly(prices.bestAsk, prices.bestBid);
                    }

                    // 更新状态
                    this.state.lastBestBid = prices.bestBid;
                    this.state.lastBestAsk = prices.bestAsk;
                    this.state.lastSpread = prices.spread;
                    this.state.lastUpdateMs = Date.now();
                    return;
                } else if (this.state.status === 'range_paused' && this.state.errorMessage?.includes('价差过大')) {
                    // 价差恢复，清除 spread_paused 状态
                    console.log(`[MM ${this.config.marketId}] 价差已恢复 (${spreadCents.toFixed(1)}c < ${this.config.maxSpreadCents}c)，恢复做市`);
                    this.state.status = 'running';
                    this.state.errorMessage = undefined;
                    this.emitStateChange();
                }
            }

            // 风控检查：Delta 失衡保护（挂单量 > 目标量时先撤单）
            const hasImbalance = await this.checkDeltaImbalance();
            if (hasImbalance) {
                // 已撤单，跳过本轮下单，等待下一 tick 同步后再补齐
                this.state.lastBestBid = prices.bestBid;
                this.state.lastBestAsk = prices.bestAsk;
                this.state.lastSpread = prices.spread;
                this.state.lastUpdateMs = Date.now();
                return;
            }

            // 3. 计算目标订单（传入双边价格，用于交叉检查）
            const buyDelta = this.calculateBuyDelta(prices.bestBid, prices.bestAsk);

            // 4. 执行订单调整（串行，避免状态冲突）
            if (buyDelta.action !== 'NONE') {
                await this.executeDelta(buyDelta);
            }

            // 5. 卖单处理
            if (this.config.strategy === 'SCALP') {
                // SCALP 策略: 检查是否有未覆盖的持仓需要挂卖单
                await this.checkUncoveredPosition(prices.bestBid);
                // SCALP 策略: 处理待挂卖单队列（多卖单）
                await this.processScalpSellOrders();
            } else {
                // FOLLOW 策略: 单卖单对账式管理
                const sellDelta = this.calculateSellDelta(prices.bestAsk, prices.bestBid);
                if (sellDelta.action !== 'NONE') {
                    await this.executeDelta(sellDelta);
                }
            }

            // 更新状态
            this.state.lastBestBid = prices.bestBid;
            this.state.lastBestAsk = prices.bestAsk;
            this.state.lastSpread = prices.spread;
            this.state.lastUpdateMs = Date.now();

        } catch (error) {
            this.consecutiveErrors++;
            this.handleError(error as Error);
        } finally {
            this.isProcessing = false;
            // 仅当本次 tick 期间没有新增错误时，才重置连续错误计数
            if (this.consecutiveErrors === errorsAtStart) {
                this.consecutiveErrors = 0;
            }
        }
    }

    /**
     * 暂停做市
     */
    pause(): void {
        this.state.status = 'paused';
        this.emitStateChange();
    }

    /**
     * 恢复做市
     */
    resume(): void {
        if (this.state.status === 'paused' || this.state.status === 'error' || this.state.status === 'range_paused') {
            this.consecutiveErrors = 0;  // 重置错误计数
            this.state.status = 'running';
            this.emitStateChange();
        }
    }

    // ========================================================================
    // 风控：价格运行区间
    // ========================================================================

    private alignToTick(price: number): number {
        const tick = this.config.tickSize;
        if (!Number.isFinite(price) || !Number.isFinite(tick) || tick <= 0) return price;
        return Math.round(price / tick) * tick;
    }

    private async enforcePriceRange(prices: PriceSnapshot): Promise<boolean> {
        const maxBuy = this.config.maxBuyPrice !== undefined
            ? this.alignToTick(this.config.maxBuyPrice)
            : undefined;
        const minSell = this.config.minSellPrice !== undefined
            ? this.alignToTick(this.config.minSellPrice)
            : undefined;
        if (maxBuy === undefined && minSell === undefined) {
            // 未启用
            if (this.state.status === 'range_paused') {
                this.state.status = 'running';
                this.state.errorMessage = undefined;
                this.emitStateChange();
            }
            return true;
        }

        const buyRefPrice = this.alignToTick(prices.bestBid);

        // 卖价参考：FOLLOW=卖一价，SCALP=买一价+tick（与实际挂单一致）
        let sellRefPrice = prices.bestAsk;
        if (this.config.strategy === 'SCALP') {
            let scalpPrice = prices.bestBid + this.config.tickSize;
            scalpPrice = Math.max(this.config.tickSize, Math.min(1 - this.config.tickSize, scalpPrice));
            scalpPrice = Math.round(scalpPrice / this.config.tickSize) * this.config.tickSize;
            sellRefPrice = scalpPrice;
        }
        sellRefPrice = this.alignToTick(sellRefPrice);

        const violations: string[] = [];
        const epsilon = 1e-9;
        if (minSell !== undefined && sellRefPrice + epsilon < minSell) {
            violations.push(`卖价(${sellRefPrice.toFixed(4)}) < 下限(${minSell.toFixed(4)})`);
        }
        if (maxBuy !== undefined && buyRefPrice - epsilon > maxBuy) {
            violations.push(`买价(${buyRefPrice.toFixed(4)}) > 上限(${maxBuy.toFixed(4)})`);
        }

        if (violations.length === 0) {
            if (this.state.status === 'range_paused') {
                console.log(`[MM ${this.config.marketId}] 价格已回到区间，恢复下单`);
                this.state.status = 'running';
                this.state.errorMessage = undefined;
                this.emitStateChange();
            }
            return true;
        }

        const reason = `价格越界：${violations.join('，')}`;
        if (this.state.status !== 'range_paused' || this.state.errorMessage !== reason) {
            console.warn(`[MM ${this.config.marketId}] ${reason}，撤销订单并暂停下单`);
            await this.cancelAllOrders();
            this.state.status = 'range_paused';
            this.state.errorMessage = reason;
            this.emitStateChange();
        }

        return false;
    }

    /**
     * 重置错误计数（用于从暂停状态恢复）
     */
    resetErrors(): void {
        this.consecutiveErrors = 0;
    }

    // ========================================================================
    // 风控：Delta 失衡保护
    // ========================================================================

    /**
     * Delta 失衡保护
     *
     * 当 API 延迟导致 openOrders 返回旧数据时，可能出现"挂单剩余量 > 目标量"。
     * 此时应该先撤单，等待下一个 tick 同步后再补齐，避免：
     * - 余额占用叠加（多下单）
     * - 持仓越界（超买/超卖）
     * - API 报错（Insufficient balance）
     *
     * @returns true 表示检测到失衡并已撤单，调用方应跳过本轮下单
     */
    private async checkDeltaImbalance(): Promise<boolean> {
        const epsilon = this.globalConfig.sizeEpsilon;
        const effectivePosition = this.getEffectivePosition();
        const maxShares = this.config.maxShares;

        // 计算目标量
        const targetBuy = Math.max(0, maxShares - effectivePosition);  // 还能买多少
        const targetSell = Math.max(0, effectivePosition);              // 能卖多少（不做空）

        // 获取当前挂单剩余量
        const openBuyRemaining = this.state.activeBuyOrder
            ? (this.state.activeBuyOrder.quantity - this.state.activeBuyOrder.filledQuantity)
            : 0;
        const openSellRemaining = this.state.activeSellOrder
            ? (this.state.activeSellOrder.quantity - this.state.activeSellOrder.filledQuantity)
            : 0;

        // 计算失衡量
        const buyExcess = openBuyRemaining - targetBuy;
        const sellExcess = openSellRemaining - targetSell;

        // 检测是否存在失衡
        const hasBuyImbalance = buyExcess > epsilon;
        const hasSellImbalance = sellExcess > epsilon;

        if (!hasBuyImbalance && !hasSellImbalance) {
            return false;  // 无失衡
        }

        // 记录失衡日志
        console.warn(`[MM ${this.config.marketId}] Delta 失衡保护触发:`);
        console.warn(`  持仓: ${effectivePosition}, 最大: ${maxShares}, epsilon: ${epsilon}`);
        console.warn(`  目标买: ${targetBuy}, 挂单买: ${openBuyRemaining}, 超出: ${buyExcess.toFixed(2)}`);
        console.warn(`  目标卖: ${targetSell}, 挂单卖: ${openSellRemaining}, 超出: ${sellExcess.toFixed(2)}`);

        // 撤销超出的订单
        if (hasBuyImbalance && this.state.activeBuyOrder) {
            console.warn(`  → 撤销买单 (ID: ${this.state.activeBuyOrder.id})`);
            try {
                await this.cancelOrder(this.state.activeBuyOrder.id);
                this.events.onOrderCancelled?.(this.config.marketId, this.state.activeBuyOrder.id);
                this.state.activeBuyOrder = null;
            } catch (error) {
                console.error(`[MM ${this.config.marketId}] Delta 保护撤买单失败:`, error);
            }
        }

        if (hasSellImbalance && this.state.activeSellOrder) {
            console.warn(`  → 撤销卖单 (ID: ${this.state.activeSellOrder.id})`);
            try {
                await this.cancelOrder(this.state.activeSellOrder.id);
                this.events.onOrderCancelled?.(this.config.marketId, this.state.activeSellOrder.id);
                this.state.activeSellOrder = null;
            } catch (error) {
                console.error(`[MM ${this.config.marketId}] Delta 保护撤卖单失败:`, error);
            }
        }

        return true;  // 已处理失衡，跳过本轮下单
    }

    /**
     * 仅管理卖单（spread 过大时调用）
     * 买单已在 tick 中取消，这里只处理卖单
     */
    private async manageSellOrderOnly(bestAsk: number, bestBid: number): Promise<void> {
        const effectivePosition = this.getEffectivePosition();
        const openSellRemaining = this.state.activeSellOrder
            ? (this.state.activeSellOrder.quantity - this.state.activeSellOrder.filledQuantity)
            : 0;

        // 目标卖出量 = 当前持仓 - 已挂卖单量
        const targetSellSize = Math.max(0, effectivePosition - openSellRemaining);

        // Delta 失衡保护（卖单）
        if (openSellRemaining > effectivePosition + this.globalConfig.sizeEpsilon) {
            console.warn(`[MM ${this.config.marketId}] (spread_paused) Delta 失衡: SELL ${openSellRemaining} > position ${effectivePosition}`);
            if (this.state.activeSellOrder) {
                try {
                    await this.cancelOrder(this.state.activeSellOrder.id);
                    this.events.onOrderCancelled?.(this.config.marketId, this.state.activeSellOrder.id);
                    this.state.activeSellOrder = null;
                } catch (error) {
                    console.error(`[MM ${this.config.marketId}] Delta 保护撤卖单失败:`, error);
                }
            }
            return;
        }

        // 计算卖单价格
        const sellDelta = this.calculateSellDelta(bestAsk, bestBid);

        // 执行卖单调整
        if (sellDelta.action !== 'NONE') {
            await this.executeDelta(sellDelta);
        }
    }

    // ========================================================================
    // SCALP 多卖单管理
    // ========================================================================

    /**
     * SCALP 策略：检查是否有未覆盖的持仓需要挂卖单
     * 当卖单全部成交后，如果还有持仓，需要重新入队
     */
    private async checkUncoveredPosition(bestBid: number): Promise<void> {
        // 计算当前卖单覆盖的数量
        const scalpSellQty = this.state.scalpSellOrders.reduce(
            (sum, o) => sum + (o.quantity - o.filledQuantity), 0
        );
        const pendingSellQty = this.state.pendingSellOrders.reduce(
            (sum, o) => sum + o.buyQuantity, 0
        );
        const totalSellCoverage = scalpSellQty + pendingSellQty;

        // 使用精度处理后的持仓
        const effectivePosition = this.getEffectivePosition();
        const uncoveredPosition = effectivePosition - totalSellCoverage;

        // 如果有未覆盖的持仓，加入待挂队列
        if (uncoveredPosition > 0) {
            this.state.pendingSellOrders.push({
                buyPrice: bestBid,  // 以当前买一价作为成本估算
                buyQuantity: uncoveredPosition,
                createdAt: new Date(),
            });
            console.log(`[MM ${this.config.marketId}] SCALP: 检测到未覆盖持仓 ${uncoveredPosition.toFixed(2)}，加入待挂队列`);
        }
    }

    /**
     * 处理 SCALP 策略的卖单
     * 将待挂卖单队列中的订单实际挂出
     */
    private async processScalpSellOrders(): Promise<void> {
        // 检查是否有待挂卖单
        if (this.state.pendingSellOrders.length === 0) {
            return;
        }

        const maxOrders = this.config.maxScalpSellOrders ?? 10;

        while (this.state.pendingSellOrders.length > 0) {
            // 检查卖单数量上限
            if (this.state.scalpSellOrders.length >= maxOrders) {
                console.warn(`[MM ${this.config.marketId}] SCALP: 卖单数量达上限 ${maxOrders}，暂停挂单`);
                break;
            }

            const pending = this.state.pendingSellOrders.shift()!;

            // 计算卖出价格 = 买入价 + 1 tick
            let sellPrice = pending.buyPrice + this.config.tickSize;
            sellPrice = Math.max(this.config.tickSize, Math.min(1 - this.config.tickSize, sellPrice));
            sellPrice = Math.round(sellPrice / this.config.tickSize) * this.config.tickSize;

            // 价格区间检查
            if (this.config.minSellPrice !== undefined && sellPrice < this.config.minSellPrice) {
                console.warn(`[MM ${this.config.marketId}] SCALP: 卖价 ${sellPrice.toFixed(4)} < 下限 ${this.config.minSellPrice.toFixed(4)}，跳过`);
                continue;
            }

            try {
                const result = await this.placeOrder({
                    marketId: this.config.marketId,
                    tokenId: this.config.tokenId,
                    side: 'SELL',
                    price: sellPrice,
                    quantity: pending.buyQuantity,
                    feeRateBps: this.config.feeRateBps,
                    isNegRisk: this.config.isNegRisk,
                    isYieldBearing: this.config.isYieldBearing,
                });

                const scalpOrder: ScalpSellOrder = {
                    id: result.id,
                    hash: result.hash,
                    side: 'SELL',
                    price: sellPrice,
                    quantity: pending.buyQuantity,
                    filledQuantity: 0,
                    status: 'OPEN',
                    createdAt: new Date(),
                    costPrice: pending.buyPrice,
                    costQuantity: pending.buyQuantity,
                };

                this.state.scalpSellOrders.push(scalpOrder);
                this.events.onOrderPlaced?.(this.config.marketId, scalpOrder);
                console.log(`[MM ${this.config.marketId}] SCALP: 挂卖单 ${pending.buyQuantity} @ ${sellPrice.toFixed(4)} (成本: ${pending.buyPrice.toFixed(4)})`);

            } catch (error) {
                console.error(`[MM ${this.config.marketId}] SCALP: 挂卖单失败:`, error);
                // 失败的订单重新入队（尾部），下一个 tick 重试
                this.state.pendingSellOrders.push(pending);
                break; // 暂停处理，避免连续失败
            }
        }
    }

    /**
     * 同步 SCALP 卖单状态
     * 检测成交、移除已完成的订单
     */
    private async syncScalpSellOrders(apiOrders: PredictOrderResponse[]): Promise<void> {
        const updatedOrders: ScalpSellOrder[] = [];

        for (const localOrder of this.state.scalpSellOrders) {
            // 在 API 返回中查找对应订单
            const apiOrder = apiOrders.find(o => o.id === localOrder.id);

            if (apiOrder && apiOrder.order) {
                const newFilled = apiOrder.order.quantityFilled;
                const filledDelta = newFilled - localOrder.filledQuantity;

                // 检测增量成交
                if (filledDelta > 0) {
                    console.log(`[MM ${this.config.marketId}] SCALP: 卖单成交 ${filledDelta} @ ${localOrder.price.toFixed(4)} (成本: ${localOrder.costPrice.toFixed(4)})`);
                    this.recordScalpSellFill(localOrder.price, filledDelta, localOrder.costPrice);
                }

                // 更新状态
                localOrder.filledQuantity = newFilled;
                localOrder.status = apiOrder.order.status as 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'EXPIRED';

                // 保留未完全成交的订单
                if (localOrder.status === 'OPEN' || localOrder.status === 'PARTIALLY_FILLED') {
                    updatedOrders.push(localOrder);
                } else {
                    // 订单已完成（FILLED/CANCELLED/EXPIRED），从列表移除
                    console.log(`[MM ${this.config.marketId}] SCALP: 卖单完成 (${localOrder.status}), 移除 ID: ${localOrder.id}`);
                    this.events.onOrderCancelled?.(this.config.marketId, localOrder.id);
                }
            } else {
                // 订单在 API 中消失
                const age = Date.now() - localOrder.createdAt.getTime();
                if (age > 5000) {
                    // 超过可见性延迟，尝试查询订单真实状态
                    console.warn(`[MM ${this.config.marketId}] SCALP: 卖单消失 ID: ${localOrder.id}`);
                    if (this.fetchOrderByHash) {
                        const status = await this.confirmOrderStatus(localOrder.hash, 'SELL');
                        if (status === 'FILLED') {
                            const remaining = localOrder.quantity - localOrder.filledQuantity;
                            if (remaining > 0) {
                                console.log(`[MM ${this.config.marketId}] SCALP: 补记卖单成交 ${remaining} @ ${localOrder.price.toFixed(4)}`);
                                this.recordScalpSellFill(localOrder.price, remaining, localOrder.costPrice);
                            }
                        }
                    }
                    // 不再保留
                } else {
                    // 可能是 API 延迟，暂时保留
                    updatedOrders.push(localOrder);
                }
            }
        }

        this.state.scalpSellOrders = updatedOrders;
    }

    /**
     * 记录 SCALP 卖单成交（独立于 recordFill，避免重复入队）
     */
    private recordScalpSellFill(sellPrice: number, quantity: number, costPrice: number): void {
        // 更新统计
        this.stats.totalSells++;
        this.stats.totalSellVolume += quantity;
        this.stats.totalSellValue += sellPrice * quantity;

        // 计算已实现盈亏（使用精确成本）
        const sellProfit = (sellPrice - costPrice) * quantity;
        this.stats.realizedPnL += sellProfit;

        this.stats.avgSellPrice = this.stats.totalSellValue / this.stats.totalSellVolume;
        this.stats.lastTradeTime = new Date();

        // 触发成交事件
        const fill: Fill = {
            orderId: '',
            marketId: this.config.marketId,
            side: 'SELL',
            price: sellPrice,
            quantity,
            filledAt: new Date(),
        };
        this.events.onFill?.(fill);
        console.log(`[MM ${this.config.marketId}] SCALP: 已实现盈亏 +$${sellProfit.toFixed(4)} (${quantity} × ${(sellPrice - costPrice).toFixed(4)})`);
    }

    /**
     * 停止并取消所有订单
     */
    async stop(): Promise<void> {
        this.state.status = 'idle';

        try {
            // 优先从接口拉全量订单，确保未跟踪到的订单也被撤销
            await this.cancelAllOrders();
        } catch (error) {
            console.error(`[MM ${this.config.marketId}] 停止时撤单失败:`, error);
        }

        // 本地状态兜底清空
        this.state.activeBuyOrder = null;
        this.state.activeSellOrder = null;
        this.state.scalpSellOrders = [];
        this.state.pendingSellOrders = [];

        this.emitStateChange();
    }

    /**
     * 获取当前状态
     */
    getState(): MarketState {
        return { ...this.state };
    }

    /**
     * 获取统计信息
     */
    getStats(): TradingStats {
        return { ...this.stats };
    }

    // ========================================================================
    // 核心逻辑
    // ========================================================================

    /**
     * 计算买单调整（对账式同步）
     *
     * 规则：desiredBuy = maxPosition - position - openBuyRemaining
     * 不变量：position + openBuyRemaining <= maxPosition
     */
    private getEffectivePosition(): number {
        const decimalsRaw = this.config.positionPrecisionDecimals ?? 2;
        const decimals = Number.isFinite(decimalsRaw) ? Math.max(0, Math.min(8, Math.trunc(decimalsRaw))) : 2;
        const factor = Math.pow(10, decimals);
        const floored = Math.floor(this.state.position * factor) / factor;
        return Number.isFinite(floored) ? Math.max(0, floored) : 0;
    }

    private calculateBuyDelta(bestBid: number, bestAsk: number): OrderDelta {
        const current = this.state.activeBuyOrder;
        const openBuyRemaining = current ? (current.quantity - current.filledQuantity) : 0;
        const effectivePosition = this.getEffectivePosition();

        // 计算目标买单量（对账式：当前缺口）
        const desiredBuy = this.config.maxShares - effectivePosition - openBuyRemaining;

        // 不变量检查：position + openBuyRemaining <= maxPosition
        if (effectivePosition + openBuyRemaining > this.config.maxShares + 1e-9) {
            console.warn(`[MM ${this.config.marketId}] 不变量违反: position(${effectivePosition}) + openBuy(${openBuyRemaining}) > max(${this.config.maxShares})`);
            // 需要取消买单
            if (current) {
                return {
                    action: 'CANCEL',
                    side: 'BUY',
                    currentOrder: current,
                    targetPrice: 0,
                    targetQuantity: 0,
                    reason: '不变量违反，取消买单',
                };
            }
        }

        // 价格交叉检查：buyPrice < sellPrice（避免自成交）
        if (current && bestBid >= bestAsk) {
            console.warn(`[MM ${this.config.marketId}] 价格交叉: bid(${bestBid}) >= ask(${bestAsk})，暂停买单`);
            return {
                action: 'CANCEL',
                side: 'BUY',
                currentOrder: current,
                targetPrice: 0,
                targetQuantity: 0,
                reason: '价格交叉，暂停买单',
            };
        }

        // 没有买单，检查是否需要新挂
        if (!current) {
            // 需要新挂买单
            if (desiredBuy > 0 && bestBid < bestAsk) {
                return {
                    action: 'PLACE',
                    side: 'BUY',
                    currentOrder: null,
                    targetPrice: bestBid,
                    targetQuantity: desiredBuy,
                    reason: '新挂买单',
                };
            }
            return { action: 'NONE', side: 'BUY', currentOrder: null, targetPrice: 0, targetQuantity: 0 };
        }

        // 已有买单，检查是否需要调整
        // 【安全边界】价格变化阈值：避免浮点数精度问题导致的无效调整
        const priceDiff = Math.abs(current.price - bestBid);
        const priceChanged = priceDiff >= this.config.tickSize * 0.5; // 价格变化超过半个 tick 才算变化

        // 如果价格变了，或者需要的量变了（因为部分成交后需要补单）
        if (priceChanged && openBuyRemaining > 0) {
            // 计算新的目标量 = 当前剩余 + 缺口
            const newTargetQty = Math.max(0, this.config.maxShares - effectivePosition);
            return {
                action: 'REPLACE',
                side: 'BUY',
                currentOrder: current,
                targetPrice: bestBid,
                targetQuantity: newTargetQty,
                reason: `价格变化: ${current.price} → ${bestBid} (diff=${priceDiff.toFixed(6)})`,
            };
        }

        // 【安全边界】缺口阈值：避免浮点数精度问题导致的无效补单
        // 缺口必须超过 1 才触发补单（小于 $1 的补单没有意义）
        const MIN_GAP_FOR_REPLACE = 1;
        if (desiredBuy > MIN_GAP_FOR_REPLACE) {
            const newTargetQty = this.config.maxShares - effectivePosition;
            return {
                action: 'REPLACE',
                side: 'BUY',
                currentOrder: current,
                targetPrice: bestBid,
                targetQuantity: newTargetQty,
                reason: `补单: 缺口 ${desiredBuy.toFixed(2)}`,
            };
        }

        return { action: 'NONE', side: 'BUY', currentOrder: current, targetPrice: bestBid, targetQuantity: openBuyRemaining };
    }

    /**
     * 计算卖单调整（对账式同步）
     *
     * 规则：desiredSell = position - openSellRemaining
     * 不变量：openSellRemaining <= position
     */
    private calculateSellDelta(bestAsk: number, bestBid: number): OrderDelta {
        const current = this.state.activeSellOrder;
        const openSellRemaining = current ? (current.quantity - current.filledQuantity) : 0;
        const effectivePosition = this.getEffectivePosition();

        // 根据策略计算目标卖出价格
        // SCALP（剥头皮）：买一价 + 1 tick，赚取最小价差
        // FOLLOW（跟随）：卖一价，被动做市
        let targetSellPrice: number;

        if (this.config.strategy === 'SCALP') {
            // 剥头皮策略：bestBid + 1 tick（无价差限制）
            let scalpPrice = bestBid + this.config.tickSize;

            // 价格钳位到 (0, 1) 区间
            scalpPrice = Math.max(this.config.tickSize, Math.min(1 - this.config.tickSize, scalpPrice));

            // 对齐到 tick（避免精度问题）
            scalpPrice = Math.round(scalpPrice / this.config.tickSize) * this.config.tickSize;

            targetSellPrice = scalpPrice;
        } else {
            // FOLLOW 策略：跟随卖一价
            targetSellPrice = bestAsk;
        }

        // 不变量检查：openSellRemaining <= position（不能超卖）
        if (openSellRemaining > effectivePosition + 1e-9) {
            console.warn(`[MM ${this.config.marketId}] 不变量违反: openSell(${openSellRemaining}) > position(${effectivePosition})`);
            // 需要取消部分或全部卖单
            if (current) {
                return {
                    action: 'CANCEL',
                    side: 'SELL',
                    currentOrder: current,
                    targetPrice: 0,
                    targetQuantity: 0,
                    reason: '不变量违反（超卖），取消卖单',
                };
            }
        }

        // 计算目标卖单量（对账式：当前缺口）
        const desiredSell = effectivePosition - openSellRemaining;

        // 没有持仓，应该取消卖单
        if (effectivePosition <= 0) {
            if (current) {
                return {
                    action: 'CANCEL',
                    side: 'SELL',
                    currentOrder: current,
                    targetPrice: 0,
                    targetQuantity: 0,
                    reason: '无持仓，取消卖单',
                };
            }
            return { action: 'NONE', side: 'SELL', currentOrder: null, targetPrice: 0, targetQuantity: 0 };
        }

        // 价格交叉检查（剥头皮策略下检查 targetSellPrice 与 bestBid 的关系）
        if (current && targetSellPrice <= bestBid) {
            console.warn(`[MM ${this.config.marketId}] 价格交叉: sellPrice(${targetSellPrice}) <= bid(${bestBid})，暂停卖单`);
            return {
                action: 'CANCEL',
                side: 'SELL',
                currentOrder: current,
                targetPrice: 0,
                targetQuantity: 0,
                reason: '价格交叉，暂停卖单',
            };
        }

        // 没有卖单，检查是否需要新挂
        if (!current) {
            if (desiredSell > 0 && targetSellPrice > bestBid) {
                return {
                    action: 'PLACE',
                    side: 'SELL',
                    currentOrder: null,
                    targetPrice: targetSellPrice,
                    targetQuantity: desiredSell,
                    reason: this.config.strategy === 'SCALP'
                        ? `新挂卖单(剥头皮): bid=${bestBid.toFixed(4)} + tick=${this.config.tickSize}`
                        : '新挂卖单',
                };
            }
            return { action: 'NONE', side: 'SELL', currentOrder: null, targetPrice: 0, targetQuantity: 0 };
        }

        // 已有卖单，检查是否需要调整
        // 【安全边界】价格变化阈值：避免浮点数精度问题导致的无效调整
        const priceDiff = Math.abs(current.price - targetSellPrice);
        const priceChanged = priceDiff >= this.config.tickSize * 0.5; // 价格变化超过半个 tick 才算变化
        const followSellPrice = this.config.strategy !== 'SCALP';

        if (priceChanged && openSellRemaining > 0 && followSellPrice) {
            // 价格变了，重挂（目标量 = 当前持仓）
            return {
                action: 'REPLACE',
                side: 'SELL',
                currentOrder: current,
                targetPrice: targetSellPrice,
                targetQuantity: effectivePosition,
                reason: `价格变化: ${current.price} → ${targetSellPrice} (diff=${priceDiff.toFixed(6)})`,
            };
        }

        // 【安全边界】缺口阈值：避免浮点数精度问题导致的无效补单
        // 缺口必须超过 1 才触发补单（小于 $1 的补单没有意义）
        const MIN_GAP_FOR_REPLACE = 1;
        if (desiredSell > MIN_GAP_FOR_REPLACE) {
            return {
                action: 'REPLACE',
                side: 'SELL',
                currentOrder: current,
                targetPrice: targetSellPrice,
                targetQuantity: effectivePosition,
                reason: `补单: 新增持仓 ${desiredSell.toFixed(2)}`,
            };
        }

        return { action: 'NONE', side: 'SELL', currentOrder: current, targetPrice: targetSellPrice, targetQuantity: openSellRemaining };
    }

    /**
     * 执行订单调整
     */
    private async executeDelta(delta: OrderDelta): Promise<void> {
        // 检查最小调整间隔（按买/卖分别计时）
        const now = Date.now();
        const lastTime = delta.side === 'BUY' ? this.lastBuyAdjustTime : this.lastSellAdjustTime;
        if (now - lastTime < this.globalConfig.minAdjustIntervalMs) {
            return;
        }

        console.log(`[MM ${this.config.marketId}] ${delta.side} ${delta.action}: ${delta.reason}`);

        try {
            switch (delta.action) {
                case 'PLACE':
                    await this.doPlaceOrder(delta.side, delta.targetPrice, delta.targetQuantity);
                    break;

                case 'CANCEL':
                    if (!delta.currentOrder) {
                        console.warn(`[MM ${this.config.marketId}] ${delta.side} CANCEL 但 currentOrder 为空，跳过`);
                        break;
                    }
                    await this.doCancelOrder(delta.currentOrder!.id, delta.side);
                    break;

                case 'REPLACE':
                    if (!delta.currentOrder) {
                        console.warn(`[MM ${this.config.marketId}] ${delta.side} REPLACE 但 currentOrder 为空，降级为 PLACE`);
                        await this.doPlaceOrder(delta.side, delta.targetPrice, delta.targetQuantity);
                        break;
                    }
                    // 先取消，再挂单（等待撤单在 API 侧可见，避免 shares 冻结/占用）
                    await this.doCancelOrder(delta.currentOrder!.id, delta.side);
                    await this.waitForOrderRemoval(delta.currentOrder!.id, 2000);
                    await this.doPlaceOrder(delta.side, delta.targetPrice, delta.targetQuantity);
                    break;
            }

            // 更新对应方向的调整时间
            if (delta.side === 'BUY') {
                this.lastBuyAdjustTime = now;
            } else {
                this.lastSellAdjustTime = now;
            }
            this.stats.orderAdjustments++;
            this.emitStateChange();

        } catch (error) {
            // 累加连续错误计数（不抛出，让下一轮 tick 继续）
            this.consecutiveErrors++;
            console.error(`[MM ${this.config.marketId}] 订单操作失败 (连续错误: ${this.consecutiveErrors}):`, error);
            this.events.onError?.(
                this.config.marketId,
                error instanceof Error ? error : new Error(String(error))
            );

            // SELL 订单偶发会因为 shares 已被其它 SELL 订单占用/撤单未同步而导致 amountAvailable=0。
            // 这里做一次温和自愈：撤掉该市场所有 SELL 订单并等待，再对账式同步持仓/订单。
            if (delta.side === 'SELL' && this.isInsufficientSharesError(error)) {
                try {
                    console.warn(`[MM ${this.config.marketId}] 检测到 SELL share 不足/冻结，尝试撤销所有 SELL 订单并等待同步`);
                    await this.cancelOrdersBySide('SELL');
                    await this.sleep(500);
                    await this.syncState();
                } catch (recoveryError) {
                    console.error(`[MM ${this.config.marketId}] SELL 自愈失败:`, recoveryError);
                }
            }

            // BUY 订单偶发会因为抵押品已被其它 BUY 订单占用/撤单未同步而导致 amountAvailable < 需求。
            // 这里做一次温和自愈：撤掉该市场所有 BUY 订单并等待，再对账式同步持仓/订单。
            if (delta.side === 'BUY' && this.isInsufficientCollateralError(error)) {
                try {
                    console.warn(`[MM ${this.config.marketId}] 检测到 BUY 抵押品不足/冻结，尝试撤销所有 BUY 订单并等待同步`);
                    await this.cancelOrdersBySide('BUY');
                    await this.sleep(500);
                    await this.syncState();
                } catch (recoveryError) {
                    console.error(`[MM ${this.config.marketId}] BUY 自愈失败:`, recoveryError);
                }
            }
        }
    }

    // ========================================================================
    // 订单操作
    // ========================================================================

    private async doPlaceOrder(side: 'BUY' | 'SELL', price: number, quantity: number): Promise<void> {
        // 防护检查：本地状态已有该方向的订单，跳过（防止重复下单）
        const existingOrder = side === 'BUY' ? this.state.activeBuyOrder : this.state.activeSellOrder;
        if (existingOrder) {
            console.warn(`[MM ${this.config.marketId}] 防护: 本地已有 ${side} 订单 (ID: ${existingOrder.id})，跳过重复下单`);
            return;
        }

        // 提前记录下单开始时间（用于 visibility delay 判断）
        // 放在 placeOrder 调用前，因为 placeOrder 可能因 hash 回填耗时较长
        const placeStartTime = Date.now();
        if (side === 'BUY') {
            this.lastBuyPlaceTime = placeStartTime;
        } else {
            this.lastSellPlaceTime = placeStartTime;
        }

        // 风控检查：最小订单金额
        const orderValue = price * quantity;
        if (orderValue < this.globalConfig.minOrderValueUsd) {
            // 计算满足最小金额的数量
            const minQuantity = Math.ceil(this.globalConfig.minOrderValueUsd / price) + 1;

            if (side === 'SELL') {
                // SELL 订单：不能超过持仓（不变量约束）
                const maxAllowedQty = this.state.position;
                if (minQuantity > maxAllowedQty) {
                    // 无法满足最小金额且不能超卖，跳过下单
                    console.warn(`[MM ${this.config.marketId}] SELL 订单金额 $${orderValue.toFixed(2)} < $${this.globalConfig.minOrderValueUsd}，但调整后数量 ${minQuantity} > 持仓 ${maxAllowedQty}，跳过下单`);
                    return;
                }
                console.log(`[MM ${this.config.marketId}] SELL 订单金额不足，调整数量: ${quantity} → ${minQuantity} (持仓上限: ${maxAllowedQty})`);
                quantity = minQuantity;
            } else {
                // BUY 订单：不能超过剩余可买量
                const maxAllowedQty = this.config.maxShares - this.state.position;
                if (minQuantity > maxAllowedQty) {
                    console.warn(`[MM ${this.config.marketId}] BUY 订单金额 $${orderValue.toFixed(2)} < $${this.globalConfig.minOrderValueUsd}，但调整后数量 ${minQuantity} > 可买量 ${maxAllowedQty}，跳过下单`);
                    return;
                }
                console.log(`[MM ${this.config.marketId}] BUY 订单金额不足，调整数量: ${quantity} → ${minQuantity} (可买上限: ${maxAllowedQty})`);
                quantity = minQuantity;
            }
        }

        let result: { id: string; hash: string };
        try {
            result = await this.placeOrder({
                marketId: this.config.marketId,
                tokenId: this.config.tokenId,
                side,
                price,
                quantity,
                feeRateBps: this.config.feeRateBps,
                isNegRisk: this.config.isNegRisk,
                isYieldBearing: this.config.isYieldBearing,
            });
        } catch (error) {
            // SELL 可能因为 shares 被旧 SELL 订单占用/撤单未同步而失败，做一次自愈重试
            if (side === 'SELL' && this.isInsufficientSharesError(error)) {
                console.warn(`[MM ${this.config.marketId}] 检测到 SELL shares 不足/冻结，尝试撤销所有 SELL 订单后重试`);
                await this.cancelOrdersBySide('SELL');
                await this.sleep(500);
                await this.syncState();

                const safeQty = Math.min(quantity, this.state.position);
                if (safeQty <= 0) {
                    console.warn(`[MM ${this.config.marketId}] 重试前持仓=0，跳过 SELL`);
                    return;
                }

                result = await this.placeOrder({
                    marketId: this.config.marketId,
                    tokenId: this.config.tokenId,
                    side,
                    price,
                    quantity: safeQty,
                    feeRateBps: this.config.feeRateBps,
                    isNegRisk: this.config.isNegRisk,
                    isYieldBearing: this.config.isYieldBearing,
                });
                quantity = safeQty;
            }
            // BUY 可能因为抵押品被旧 BUY 订单占用/撤单未同步而失败，做一次自愈重试
            else if (side === 'BUY' && this.isInsufficientCollateralError(error)) {
                console.warn(`[MM ${this.config.marketId}] 检测到 BUY 抵押品不足/冻结，尝试撤销所有 BUY 订单后重试`);
                await this.cancelOrdersBySide('BUY');
                await this.sleep(500);
                await this.syncState();

                // 重新检查可买量
                const maxAllowedQty = this.config.maxShares - this.state.position;
                const safeQty = Math.min(quantity, maxAllowedQty);
                if (safeQty <= 0) {
                    console.warn(`[MM ${this.config.marketId}] 重试前可买量=0，跳过 BUY`);
                    return;
                }

                result = await this.placeOrder({
                    marketId: this.config.marketId,
                    tokenId: this.config.tokenId,
                    side,
                    price,
                    quantity: safeQty,
                    feeRateBps: this.config.feeRateBps,
                    isNegRisk: this.config.isNegRisk,
                    isYieldBearing: this.config.isYieldBearing,
                });
                quantity = safeQty;
            } else {
                throw error;
            }
        }

        const order: ActiveOrder = {
            id: result.id,              // 订单 ID（用于撤单）
            hash: result.hash,
            side,
            price,
            quantity,
            filledQuantity: 0,
            status: 'OPEN',
            createdAt: new Date(),
        };

        if (side === 'BUY') {
            this.state.activeBuyOrder = order;
        } else {
            this.state.activeSellOrder = order;
        }

        this.events.onOrderPlaced?.(this.config.marketId, order);
        console.log(`[MM ${this.config.marketId}] 下单成功: ${side} ${quantity} @ ${price} (ID: ${result.id})`);
    }

    /**
     * 撤销所有活跃订单（紧急停止 / 风控触发时使用）
     *
     * 重要：只撤销当前 marketId 的订单，避免影响其他市场
     */
    private async cancelAllOrders(): Promise<void> {
        // 兜底：以 API 返回的 OPEN 订单为准，确保撤掉"引擎未知/状态丢失"的遗留挂单
        let openOrderIds: string[] = [];
        try {
            const orders = await this.fetchOrders(this.config.marketId);
            // 二次过滤：确保只处理当前 marketId 的订单（防止 API 返回其他市场的订单）
            openOrderIds = orders
                .filter(o => o.order?.marketId === this.config.marketId)
                .map(o => o.id)
                .filter(Boolean);
        } catch (error) {
            console.error(`[MM ${this.config.marketId}] 获取 OPEN 订单失败（撤单兜底将退化为仅撤本地状态）:`, error);
        }

        // 合并本地状态中的订单 ID（防止 API 短暂空列表时漏撤）
        const stateIds = [
            this.state.activeBuyOrder?.id,
            this.state.activeSellOrder?.id,
            // SCALP 策略: 包含所有多卖单 ID
            ...this.state.scalpSellOrders.map(o => o.id),
        ].filter((v): v is string => Boolean(v));

        const ids = Array.from(new Set([...openOrderIds, ...stateIds]));
        if (ids.length === 0) {
            this.state.activeBuyOrder = null;
            this.state.activeSellOrder = null;
            this.state.scalpSellOrders = [];
            this.state.pendingSellOrders = [];
            return;
        }

        try {
            if (this.cancelOrders) {
                const { removed, noop } = await this.cancelOrders(ids);
                for (const id of [...removed, ...noop]) {
                    this.events.onOrderCancelled?.(this.config.marketId, id);
                }
                console.log(`[MM ${this.config.marketId}] 风控撤单: removed=${removed.length}, noop=${noop.length}`);
            } else {
                for (const id of ids) {
                    try {
                        await this.cancelOrder(id);
                        this.events.onOrderCancelled?.(this.config.marketId, id);
                    } catch (error) {
                        console.error(`[MM ${this.config.marketId}] 风控撤单失败 (ID: ${id}):`, error);
                    }
                }
            }
        } finally {
            // 不论撤单是否全部成功，清空本地订单状态，下一轮由 syncState 重新对账
            this.state.activeBuyOrder = null;
            this.state.activeSellOrder = null;
            this.state.scalpSellOrders = [];
            this.state.pendingSellOrders = [];
        }
    }

    /**
     * 取消订单
     * @param orderId 订单 ID（不是 hash）
     */
    private async doCancelOrder(orderId: string, side: 'BUY' | 'SELL'): Promise<void> {
        const success = await this.cancelOrder(orderId);

        if (!success) {
            throw new Error(`取消订单失败: ${orderId}`);
        }

        if (side === 'BUY') {
            this.state.activeBuyOrder = null;
        } else {
            this.state.activeSellOrder = null;
        }

        this.events.onOrderCancelled?.(this.config.marketId, orderId);
        console.log(`[MM ${this.config.marketId}] 取消成功: ID ${orderId}`);
    }

    // ========================================================================
    // 状态同步
    // ========================================================================

    /**
     * 状态同步（安全版 + 优化版）
     *
     * 核心原则：
     * - 只信任 API 返回的订单列表
     * - 成交检测仅基于 filledQuantity 增量（两次都有订单时）
     * - 订单消失不推断为成交（可能是撤单/拒绝/API 错误）
     * - 持仓以链上 tokenId balanceOf 为准
     *
     * 性能优化：
     * - 订单列表每次都查（必须跟踪订单状态）
     * - 持仓只在以下情况查询：
     *   1. 订单消失（需要确认实际持仓）
     *   2. 检测到成交（确认持仓变化）
     *   3. 每 N 个 tick 强制同步一次（安全兜底）
     */
    private async syncState(): Promise<void> {
        this.tickCounter++;

        // 1. 获取活跃订单（每次都查）
        const orders = await this.fetchOrders(this.config.marketId);

        // 标记是否需要同步持仓
        let needPositionSync = false;

        // 2. 检测买单变化
        const newBuyOrder = this.findOrder(orders, 'BUY');
        const oldBuyOrder = this.state.activeBuyOrder;

        const now = Date.now();

        // 先获取当前持仓用于判断（仅在订单消失时需要对比）
        let actualPosition: number | null = null;
        const getActualPosition = async () => {
            if (actualPosition === null) {
                actualPosition = await this.fetchPosition(
                    this.config.marketId,
                    this.config.tokenId,
                    { isNegRisk: this.config.isNegRisk, isYieldBearing: this.config.isYieldBearing }
                );
            }
            return actualPosition;
        };

        if (oldBuyOrder && newBuyOrder && oldBuyOrder.id === newBuyOrder.id) {
            // 同一订单，检测增量成交
            const filledDelta = newBuyOrder.filledQuantity - oldBuyOrder.filledQuantity;
            // 调试日志：成交检测
            if (newBuyOrder.filledQuantity > 0 || oldBuyOrder.filledQuantity > 0) {
                console.log(`[MM ${this.config.marketId}] BUY 成交检测: old=${oldBuyOrder.filledQuantity}, new=${newBuyOrder.filledQuantity}, delta=${filledDelta}`);
            }
            if (filledDelta > 0) {
                console.log(`[MM ${this.config.marketId}] === BUY 成交! delta=${filledDelta} ===`);
                this.recordFill('BUY', oldBuyOrder.price, filledDelta);
                needPositionSync = true; // 成交后需要确认持仓
            }
            this.state.activeBuyOrder = newBuyOrder;
            this.buyOrderUnknownCount = 0; // 订单存在，重置计数器
        } else if (oldBuyOrder && !newBuyOrder) {
            // 订单消失 - 检查可见性延迟
            const timeSincePlaced = now - this.lastBuyPlaceTime;
            const inVisibilityDelay = timeSincePlaced < this.ORDER_VISIBLE_DELAY_MS;

            if (inVisibilityDelay) {
                // 在可见性延迟期内 → API 可能还没同步，保持本地状态
                console.log(`[MM ${this.config.marketId}] 买单 API 延迟 (${timeSincePlaced}ms < ${this.ORDER_VISIBLE_DELAY_MS}ms)，保持本地状态`);
            } else {
                // 超过延迟期 → 查询订单真实状态确认
                const orderStatus = await this.confirmOrderStatus(oldBuyOrder.hash, 'BUY');
                if (orderStatus === 'STILL_OPEN') {
                    // 订单确认仍有效，保持本地状态
                    console.log(`[MM ${this.config.marketId}] 买单确认仍有效 (hash: ${oldBuyOrder.hash})，保持本地状态`);
                    this.buyOrderUnknownCount = 0;
                } else if (orderStatus === 'UNKNOWN') {
                    // 状态未知，增加计数器
                    this.buyOrderUnknownCount++;
                    if (this.buyOrderUnknownCount >= this.MAX_UNKNOWN_COUNT) {
                        // 连续多次 UNKNOWN，可能是订单真的消失了，强制清除
                        const currentPosition = await getActualPosition();
                        console.warn(`[MM ${this.config.marketId}] 买单连续 ${this.buyOrderUnknownCount} 次 UNKNOWN，强制清除 (持仓: ${this.state.position} → ${currentPosition})`);
                        this.state.position = currentPosition;
                        this.state.activeBuyOrder = null;
                        this.buyOrderUnknownCount = 0;
                    } else {
                        console.log(`[MM ${this.config.marketId}] 买单状态未知 (${this.buyOrderUnknownCount}/${this.MAX_UNKNOWN_COUNT})，保持本地状态`);
                    }
                } else {
                    // 订单已确认成交/取消/失效/不存在，清除本地状态
                    const currentPosition = await getActualPosition();
                    console.warn(`[MM ${this.config.marketId}] 买单确认消失 (状态: ${orderStatus}, 持仓: ${this.state.position} → ${currentPosition})`);

                    // BUG FIX: 如果订单是 FILLED，需要记录剩余成交量
                    if (orderStatus === 'FILLED') {
                        const remainingQty = oldBuyOrder.quantity - oldBuyOrder.filledQuantity;
                        if (remainingQty > 0) {
                            console.log(`[MM ${this.config.marketId}] === BUY 完全成交! 补记 remainingQty=${remainingQty} ===`);
                            this.recordFill('BUY', oldBuyOrder.price, remainingQty);
                        }
                    }

                    this.state.position = currentPosition;
                    this.state.activeBuyOrder = null;
                    this.buyOrderUnknownCount = 0;
                }
            }
        } else {
            // 无旧订单或有新订单（不同 ID），直接更新
            this.state.activeBuyOrder = newBuyOrder;
            this.buyOrderUnknownCount = 0;
        }

        // 3. 检测卖单变化
        const newSellOrder = this.findOrder(orders, 'SELL');
        const oldSellOrder = this.state.activeSellOrder;

        if (oldSellOrder && newSellOrder && oldSellOrder.id === newSellOrder.id) {
            // 同一订单，检测增量成交
            const filledDelta = newSellOrder.filledQuantity - oldSellOrder.filledQuantity;
            // 调试日志：成交检测
            if (newSellOrder.filledQuantity > 0 || oldSellOrder.filledQuantity > 0) {
                console.log(`[MM ${this.config.marketId}] SELL 成交检测: old=${oldSellOrder.filledQuantity}, new=${newSellOrder.filledQuantity}, delta=${filledDelta}`);
            }
            if (filledDelta > 0) {
                console.log(`[MM ${this.config.marketId}] === SELL 成交! delta=${filledDelta} ===`);
                this.recordFill('SELL', oldSellOrder.price, filledDelta);
                needPositionSync = true; // 成交后需要确认持仓
            }
            this.state.activeSellOrder = newSellOrder;
            this.sellOrderUnknownCount = 0; // 订单存在，重置计数器
        } else if (oldSellOrder && !newSellOrder) {
            // 订单消失 - 检查可见性延迟
            const timeSincePlaced = now - this.lastSellPlaceTime;
            const inVisibilityDelay = timeSincePlaced < this.ORDER_VISIBLE_DELAY_MS;

            if (inVisibilityDelay) {
                console.log(`[MM ${this.config.marketId}] 卖单 API 延迟 (${timeSincePlaced}ms < ${this.ORDER_VISIBLE_DELAY_MS}ms)，保持本地状态`);
            } else {
                // 超过延迟期 → 查询订单真实状态确认
                const orderStatus = await this.confirmOrderStatus(oldSellOrder.hash, 'SELL');
                if (orderStatus === 'STILL_OPEN') {
                    // 订单确认仍有效，保持本地状态
                    console.log(`[MM ${this.config.marketId}] 卖单确认仍有效 (hash: ${oldSellOrder.hash})，保持本地状态`);
                    this.sellOrderUnknownCount = 0;
                } else if (orderStatus === 'UNKNOWN') {
                    // 状态未知，增加计数器
                    this.sellOrderUnknownCount++;
                    if (this.sellOrderUnknownCount >= this.MAX_UNKNOWN_COUNT) {
                        // 连续多次 UNKNOWN，可能是订单真的消失了，强制清除
                        const currentPosition = await getActualPosition();
                        console.warn(`[MM ${this.config.marketId}] 卖单连续 ${this.sellOrderUnknownCount} 次 UNKNOWN，强制清除 (持仓: ${this.state.position} → ${currentPosition})`);
                        this.state.position = currentPosition;
                        this.state.activeSellOrder = null;
                        this.sellOrderUnknownCount = 0;
                    } else {
                        console.log(`[MM ${this.config.marketId}] 卖单状态未知 (${this.sellOrderUnknownCount}/${this.MAX_UNKNOWN_COUNT})，保持本地状态`);
                    }
                } else {
                    // 订单已确认成交/取消/失效/不存在，清除本地状态
                    const currentPosition = await getActualPosition();
                    console.warn(`[MM ${this.config.marketId}] 卖单确认消失 (状态: ${orderStatus}, 持仓: ${this.state.position} → ${currentPosition})`);

                    // BUG FIX: 如果订单是 FILLED，需要记录剩余成交量
                    if (orderStatus === 'FILLED') {
                        const remainingQty = oldSellOrder.quantity - oldSellOrder.filledQuantity;
                        if (remainingQty > 0) {
                            console.log(`[MM ${this.config.marketId}] === SELL 完全成交! 补记 remainingQty=${remainingQty} ===`);
                            this.recordFill('SELL', oldSellOrder.price, remainingQty);
                        }
                    }

                    this.state.position = currentPosition;
                    this.state.activeSellOrder = null;
                    this.sellOrderUnknownCount = 0;
                }
            }
        } else {
            this.state.activeSellOrder = newSellOrder;
            this.sellOrderUnknownCount = 0;
        }

        // 5. 按需同步持仓（降低 API 请求频率）
        const forceSync = this.tickCounter >= this.POSITION_SYNC_INTERVAL;
        if (needPositionSync || forceSync) {
            if (forceSync) {
                this.tickCounter = 0; // 重置计数器
            }
            // 复用已获取的持仓数据，避免重复 API 调用
            const currentPosition = actualPosition ?? await this.fetchPosition(
                this.config.marketId,
                this.config.tokenId,
                { isNegRisk: this.config.isNegRisk, isYieldBearing: this.config.isYieldBearing }
            );
            if (currentPosition !== this.state.position) {
                console.log(`[MM ${this.config.marketId}] 持仓同步: ${this.state.position} → ${currentPosition}`);
                this.state.position = currentPosition;
            }
        }
    }

    /**
     * 从 API 响应中查找指定方向的订单
     * API 返回结构: { id, order: { hash, side, status, ... } }
     */
    private findOrder(orders: PredictOrderResponse[], side: 'BUY' | 'SELL'): ActiveOrder | null {
        // 二次过滤：确保只处理当前 marketId 的订单（防止 API 返回其他市场的订单）
        const filteredOrders = orders.filter(o => o.order?.marketId === this.config.marketId);

        // 调试日志：显示过滤后的订单
        if (filteredOrders.length > 0) {
            filteredOrders.forEach(o => {
                console.log(`[MM ${this.config.marketId}] API 订单原始数据: id=${o.id}, side=${o.order?.side}, status=${o.order?.status}, qty=${o.order?.quantity}, filled=${o.order?.quantityFilled}`);
            });
        }

        const orderResp = filteredOrders.find(o =>
            o.order?.side === side &&
            (o.order?.status === 'OPEN' || o.order?.status === 'PARTIALLY_FILLED')
        );

        if (!orderResp || !orderResp.order) return null;

        const o = orderResp.order;
        const result = {
            id: orderResp.id,           // 订单 ID（用于撤单）
            hash: o.hash,
            side: o.side,
            price: o.price,
            quantity: o.quantity,
            filledQuantity: o.quantityFilled,
            status: o.status as 'OPEN' | 'PARTIALLY_FILLED',
            createdAt: new Date(o.createdAt),
        };

        // 调试日志：显示解析后的订单数据
        console.log(`[MM ${this.config.marketId}] findOrder(${side}): parsed filledQuantity=${result.filledQuantity} (raw: ${o.quantityFilled})`);

        return result;
    }

    private recordFill(side: 'BUY' | 'SELL', price: number, quantity: number): void {
        const fill: Fill = {
            orderId: side === 'BUY' ? this.state.activeBuyOrder?.id ?? '' : this.state.activeSellOrder?.id ?? '',
            marketId: this.config.marketId,
            side,
            price,
            quantity,
            filledAt: new Date(),
        };

        // 更新统计和 PnL（使用加权平均成本法）
        if (side === 'BUY') {
            this.stats.totalBuys++;
            this.stats.totalBuyVolume += quantity;
            this.stats.totalBuyValue += price * quantity;

            // 更新库存成本（加权平均）
            // 新成本 = (旧成本 + 新购入成本) / (旧持仓 + 新购入量)
            const oldPosition = this.state.position;
            const newPosition = oldPosition + quantity;
            if (newPosition > 0) {
                this.stats.inventoryCost = (this.stats.inventoryCost * oldPosition + price * quantity) / newPosition;
            }

            this.stats.avgBuyPrice = this.stats.totalBuyValue / this.stats.totalBuyVolume;

            // SCALP 策略: BUY 成交后，将卖单请求加入队列
            if (this.config.strategy === 'SCALP') {
                this.state.pendingSellOrders.push({
                    buyPrice: price,
                    buyQuantity: quantity,
                    createdAt: new Date(),
                });
                console.log(`[MM ${this.config.marketId}] SCALP: 买入成交 ${quantity} @ ${price}，待挂卖单入队`);
            }
        } else {
            this.stats.totalSells++;
            this.stats.totalSellVolume += quantity;
            this.stats.totalSellValue += price * quantity;

            // 计算本次卖出的已实现盈亏
            // 已实现 = (卖出价 - 平均成本) * 卖出量
            const costBasis = this.stats.inventoryCost;
            const sellProfit = (price - costBasis) * quantity;
            this.stats.realizedPnL += sellProfit;

            this.stats.avgSellPrice = this.stats.totalSellValue / this.stats.totalSellVolume;
        }

        this.stats.lastTradeTime = new Date();

        this.events.onFill?.(fill);
        console.log(`[MM ${this.config.marketId}] 成交: ${side} ${quantity} @ ${price}`);
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /**
     * 确认订单真实状态（仅在订单从列表消失且超过可见性延迟时调用）
     *
     * @returns
     * - 'STILL_OPEN': 订单仍然有效（OPEN/PARTIALLY_FILLED），只是列表延迟
     * - 'FILLED': 订单已完全成交
     * - 'CANCELLED'/'EXPIRED'/'INVALIDATED': 订单已取消/过期/无效
     * - 'NOT_FOUND': 订单不存在（可能被拒绝或从未创建）
     * - 'UNKNOWN': 无法确认（没有 fetchOrderByHash 依赖）
     */
    private async confirmOrderStatus(
        hash: string,
        side: 'BUY' | 'SELL'
    ): Promise<'STILL_OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'INVALIDATED' | 'NOT_FOUND' | 'UNKNOWN'> {
        if (!this.fetchOrderByHash) {
            // 没有查询方法，降级为"假定消失"
            console.log(`[MM ${this.config.marketId}] 无 fetchOrderByHash，假定 ${side} 订单已消失`);
            return 'UNKNOWN';
        }

        try {
            const result = await this.fetchOrderByHash(hash);

            if (!result.found) {
                return 'NOT_FOUND';
            }

            switch (result.status) {
                case 'OPEN':
                case 'PARTIALLY_FILLED':
                    return 'STILL_OPEN';
                case 'FILLED':
                    return 'FILLED';
                case 'CANCELLED':
                    return 'CANCELLED';
                case 'EXPIRED':
                    return 'EXPIRED';
                case 'INVALIDATED':
                    return 'INVALIDATED';
                default:
                    return 'UNKNOWN';
            }
        } catch (error) {
            console.error(`[MM ${this.config.marketId}] 查询订单状态失败 (hash: ${hash}):`, error);
            // 查询失败时，保守处理：假定订单消失
            return 'UNKNOWN';
        }
    }

    private updatePriceFromBook(book: { bids: [number, number][]; asks: [number, number][] }): void {
        if (book.bids.length > 0) {
            this.state.lastBestBid = book.bids[0][0];
        }
        if (book.asks.length > 0) {
            this.state.lastBestAsk = book.asks[0][0];
        }
        this.state.lastSpread = this.state.lastBestAsk - this.state.lastBestBid;
    }

    private extractPrices(book: { bids: [number, number][]; asks: [number, number][] }): PriceSnapshot {
        const bestBid = book.bids[0]?.[0] ?? 0;
        const bestBidSize = book.bids[0]?.[1] ?? 0;
        const bestAsk = book.asks[0]?.[0] ?? 0;
        const bestAskSize = book.asks[0]?.[1] ?? 0;
        const spread = bestAsk - bestBid;
        const midPrice = (bestBid + bestAsk) / 2;
        const spreadPercent = midPrice > 0 ? (spread / midPrice) * 100 : 0;

        return {
            marketId: this.config.marketId,
            bestBid,
            bestBidSize,
            bestAsk,
            bestAskSize,
            spread,
            spreadPercent,
            timestamp: new Date(),
        };
    }

    /**
     * 将 YES 订单簿转换为 NO 订单簿
     *
     * API 返回的订单簿是基于 YES outcome 的:
     * - YES bids = 有人愿意以该价格买入 YES
     * - YES asks = 有人愿意以该价格卖出 YES
     *
     * 对于 NO outcome:
     * - NO bids = 有人愿意买 NO = 有人愿意卖 YES = YES asks，价格 = 1 - YES_ask_price
     * - NO asks = 有人愿意卖 NO = 有人愿意买 YES = YES bids，价格 = 1 - YES_bid_price
     */
    private convertBookForNo(
        yesBook: { bids: [number, number][]; asks: [number, number][] }
    ): { bids: [number, number][]; asks: [number, number][] } {
        // YES asks -> NO bids (价格反转，排序从高到低)
        const noBids: [number, number][] = yesBook.asks
            .map(([price, size]): [number, number] => [1 - price, size])
            .sort((a, b) => b[0] - a[0]); // bids 从高到低排序

        // YES bids -> NO asks (价格反转，排序从低到高)
        const noAsks: [number, number][] = yesBook.bids
            .map(([price, size]): [number, number] => [1 - price, size])
            .sort((a, b) => a[0] - b[0]); // asks 从低到高排序

        return { bids: noBids, asks: noAsks };
    }

    /**
     * 获取订单簿（根据 outcome 自动转换）
     */
    private async getOrderBook(): Promise<{ bids: [number, number][]; asks: [number, number][] } | null> {
        const book = await this.fetchOrderBook(this.config.marketId);
        if (!book) return null;

        // 如果是 NO outcome，需要转换订单簿
        if (this.config.outcome === 'NO') {
            return this.convertBookForNo(book);
        }

        return book;
    }

    private isInsufficientSharesError(error: unknown): boolean {
        const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
        return message.includes('insufficient shares')
            || message.includes('amountavailable')
            || message.includes('tokenpermarketexceedederror')
            || message.includes('available balance is less than the total ask amount');
    }

    /**
     * 检测 BUY 订单抵押品不足错误
     * 当现有 BUY 订单占用了抵押品，导致新订单无法下单时触发
     */
    private isInsufficientCollateralError(error: unknown): boolean {
        const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
        return message.includes('insufficient collateral')
            || message.includes('collateralpermarketexceedederror')
            || message.includes('available balance is less than the total bid amount');
    }

    private async cancelOrdersBySide(side: 'BUY' | 'SELL'): Promise<void> {
        let orderIds: string[] = [];
        try {
            const orders = await this.fetchOrders(this.config.marketId);
            // 二次过滤：确保只处理当前 marketId 的订单
            orderIds = orders
                .filter(o =>
                    o.order?.marketId === this.config.marketId &&
                    o.order?.side === side &&
                    (o.order?.status === 'OPEN' || o.order?.status === 'PARTIALLY_FILLED')
                )
                .map(o => o.id)
                .filter(Boolean);
        } catch {
            // ignore
        }

        if (orderIds.length === 0) return;

        try {
            if (this.cancelOrders) {
                const { removed, noop } = await this.cancelOrders(orderIds);
                console.log(`[MM ${this.config.marketId}] 批量撤 ${side}: removed=${removed.length}, noop=${noop.length}`);
            } else {
                for (const id of orderIds) {
                    await this.cancelOrder(id);
                }
            }
        } finally {
            if (side === 'BUY') this.state.activeBuyOrder = null;
            if (side === 'SELL') this.state.activeSellOrder = null;
        }
    }

    private async waitForOrderRemoval(orderId: string, timeoutMs: number): Promise<void> {
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
            const orders = await this.fetchOrders(this.config.marketId);
            if (!orders.some(o => o.id === orderId)) {
                return;
            }
            await this.sleep(200);
        }
        console.warn(`[MM ${this.config.marketId}] 撤单后订单仍未消失 (ID: ${orderId})，继续运行`);
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    private handleError(error: Error): void {
        console.error(`[MM ${this.config.marketId}] 错误:`, error.message);
        this.state.status = 'error';
        this.state.errorMessage = error.message;
        this.emitStateChange();
        this.events.onError?.(this.config.marketId, error);
    }

    private emitStateChange(): void {
        this.events.onStateChange?.(this.config.marketId, this.getState());
    }

    private emitPriceUpdate(snapshot: PriceSnapshot): void {
        // 更新未实现盈亏
        this.updateUnrealizedPnL(snapshot.bestBid);

        this.events.onPriceUpdate?.(snapshot);
    }

    /**
     * 更新未实现盈亏
     * 未实现盈亏 = 持仓 * (当前价格 - 平均成本)
     * 使用 bestBid 作为当前价格（保守估值，立即卖出能获得的价格）
     */
    private updateUnrealizedPnL(currentPrice: number): void {
        if (this.state.position > 0 && this.stats.inventoryCost > 0) {
            this.stats.unrealizedPnL = this.state.position * (currentPrice - this.stats.inventoryCost);
        } else {
            this.stats.unrealizedPnL = 0;
        }
        this.stats.totalPnL = this.stats.realizedPnL + this.stats.unrealizedPnL;
    }
}

// ============================================================================
// 依赖接口
// ============================================================================

export interface PlaceOrderParams {
    marketId: number;
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
    feeRateBps: number;
    isNegRisk: boolean;
    isYieldBearing?: boolean;
}

export interface EngineDependencies {
    fetchOrderBook: (marketId: number) => Promise<{ bids: [number, number][]; asks: [number, number][] } | null>;
    fetchOrders: (marketId: number) => Promise<PredictOrderResponse[]>;
    /** 可选：通过 hash 查询订单真实状态（用于确认订单是否存在/已成交/被拒） */
    fetchOrderByHash?: (hash: string) => Promise<OrderStatusResult>;
    fetchPosition: (marketId: number, tokenId: string, options: PositionQueryOptions) => Promise<number>;
    placeOrder: (params: PlaceOrderParams) => Promise<{ id: string; hash: string }>;
    cancelOrder: (orderId: string) => Promise<boolean>;
    cancelOrders?: (orderIds: string[]) => Promise<{ removed: string[]; noop: string[] }>;
    /** 可选：获取市场价格精度 (tick size) */
    getMarketTickSize?: (marketId: number) => Promise<number>;
}
