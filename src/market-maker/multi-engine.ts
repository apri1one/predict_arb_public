/**
 * Predict 做市模块 - 多市场管理器
 *
 * 管理多个 MarketMakerEngine 实例
 */

import { MarketMakerEngine, type EngineDependencies } from './engine.js';
import type {
    MarketMakerConfig,
    GlobalConfig,
    MarketState,
    TradingStats,
    Fill,
    ActiveOrder,
    PriceSnapshot,
} from './types.js';
import { DEFAULT_GLOBAL_CONFIG } from './config.js';

// ============================================================================
// 多市场管理器
// ============================================================================

export class MultiMarketMaker {
    private engines: Map<number, MarketMakerEngine> = new Map();
    private globalConfig: GlobalConfig;
    private dependencies: EngineDependencies;
    private events: MultiMarketMakerEvents;

    private isRunning = false;
    private tickInterval: ReturnType<typeof setInterval> | null = null;

    // 全局统计
    private globalStats: GlobalStats = {
        totalMarkets: 0,
        runningMarkets: 0,
        totalFills: 0,
        totalVolume: 0,
        totalRealizedPnL: 0,
        startTime: null,
    };

    constructor(
        dependencies: EngineDependencies,
        globalConfig: Partial<GlobalConfig> = {},
        events: MultiMarketMakerEvents = {}
    ) {
        this.dependencies = dependencies;
        this.globalConfig = { ...DEFAULT_GLOBAL_CONFIG, ...globalConfig };
        this.events = events;
    }

    // ========================================================================
    // 市场管理
    // ========================================================================

    /**
     * 添加市场
     */
    addMarket(config: MarketMakerConfig): void {
        if (this.engines.has(config.marketId)) {
            console.warn(`[MultiMM] 市场 ${config.marketId} 已存在，跳过`);
            return;
        }

        // 创建引擎，并注入事件处理
        const engine = new MarketMakerEngine(
            config,
            this.globalConfig,
            this.dependencies,
            {
                onStateChange: (marketId, state) => {
                    this.events.onMarketStateChange?.(marketId, state);
                    this.updateGlobalStats();
                },
                onFill: (fill) => {
                    this.globalStats.totalFills++;
                    this.globalStats.totalVolume += fill.price * fill.quantity;
                    this.events.onFill?.(fill);
                },
                onOrderPlaced: (marketId, order) => {
                    this.events.onOrderPlaced?.(marketId, order);
                },
                onOrderCancelled: (marketId, orderId) => {
                    this.events.onOrderCancelled?.(marketId, orderId);
                },
                onPriceUpdate: (snapshot) => {
                    this.events.onPriceUpdate?.(snapshot);
                },
                onError: (marketId, error) => {
                    this.events.onMarketError?.(marketId, error);
                },
            }
        );

        this.engines.set(config.marketId, engine);
        this.globalStats.totalMarkets++;

        console.log(`[MultiMM] 添加市场: ${config.marketId} - ${config.title}`);
    }

    /**
     * 移除市场
     */
    async removeMarket(marketId: number): Promise<void> {
        const engine = this.engines.get(marketId);
        if (!engine) {
            return;
        }

        // 停止引擎
        await engine.stop();

        this.engines.delete(marketId);
        this.globalStats.totalMarkets--;

        console.log(`[MultiMM] 移除市场: ${marketId}`);
    }

    /**
     * 获取市场列表
     */
    getMarkets(): number[] {
        return Array.from(this.engines.keys());
    }

    /**
     * 获取市场状态
     */
    getMarketState(marketId: number): MarketState | null {
        const engine = this.engines.get(marketId);
        return engine ? engine.getState() : null;
    }

    /**
     * 获取所有市场状态
     */
    getAllStates(): MarketState[] {
        return Array.from(this.engines.values()).map(e => e.getState());
    }

    /**
     * 获取市场统计
     */
    getMarketStats(marketId: number): TradingStats | null {
        const engine = this.engines.get(marketId);
        return engine ? engine.getStats() : null;
    }

    /**
     * 获取所有市场统计
     */
    getAllStats(): TradingStats[] {
        return Array.from(this.engines.values()).map(e => e.getStats());
    }

    // ========================================================================
    // 生命周期
    // ========================================================================

    /**
     * 启动所有市场
     */
    async start(): Promise<void> {
        if (this.isRunning) {
            console.warn('[MultiMM] 已在运行中');
            return;
        }

        console.log(`[MultiMM] 启动 ${this.engines.size} 个市场...`);

        this.isRunning = true;
        this.globalStats.startTime = new Date();

        // 初始化所有引擎
        const engines = Array.from(this.engines.values());
        for (const engine of engines) {
            try {
                await engine.init();
            } catch (error) {
                console.error(`[MultiMM] 引擎初始化失败:`, error);
            }
        }

        // 启动主循环
        this.tickInterval = setInterval(async () => {
            if (!this.isRunning) return;

            // 串行处理每个市场，避免 API 限流
            const allEngines = Array.from(this.engines.values());
            for (const engine of allEngines) {
                try {
                    await engine.tick();
                } catch (error) {
                    // 错误已在 engine 内部处理
                }

                // 市场间隔，避免请求过快
                await sleep(100);
            }

            this.updateGlobalStats();

        }, this.globalConfig.pollIntervalMs);

        console.log('[MultiMM] 已启动');
    }

    /**
     * 停止所有市场
     */
    async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }

        console.log('[MultiMM] 停止中...');

        this.isRunning = false;

        // 停止定时器
        if (this.tickInterval) {
            clearInterval(this.tickInterval);
            this.tickInterval = null;
        }

        // 停止所有引擎（取消订单）
        const stopEngines = Array.from(this.engines.values());
        for (const engine of stopEngines) {
            try {
                await engine.stop();
            } catch (error) {
                console.error('[MultiMM] 引擎停止失败:', error);
            }
        }

        console.log('[MultiMM] 已停止');
    }

    /**
     * 暂停指定市场
     */
    pauseMarket(marketId: number): void {
        const engine = this.engines.get(marketId);
        if (engine) {
            engine.pause();
        }
    }

    /**
     * 恢复指定市场
     */
    resumeMarket(marketId: number): void {
        const engine = this.engines.get(marketId);
        if (engine) {
            engine.resume();
        }
    }

    /**
     * 暂停所有市场
     */
    pauseAll(): void {
        const pauseEngines = Array.from(this.engines.values());
        for (const engine of pauseEngines) {
            engine.pause();
        }
    }

    /**
     * 恢复所有市场
     */
    resumeAll(): void {
        const resumeEngines = Array.from(this.engines.values());
        for (const engine of resumeEngines) {
            engine.resume();
        }
    }

    // ========================================================================
    // 状态查询
    // ========================================================================

    /**
     * 是否运行中
     */
    isActive(): boolean {
        return this.isRunning;
    }

    /**
     * 获取全局统计
     */
    getGlobalStats(): GlobalStats {
        return { ...this.globalStats };
    }

    /**
     * 获取全局配置
     */
    getGlobalConfig(): GlobalConfig {
        return { ...this.globalConfig };
    }

    /**
     * 设置紧急停止
     * @param enabled true 启用紧急停止，false 恢复
     */
    setEmergencyStop(enabled: boolean): void {
        this.globalConfig.emergencyStop = enabled;
        if (enabled) {
            console.warn('[MultiMM] 紧急停止已启用，所有市场将暂停');
            this.pauseAll();
        } else {
            console.log('[MultiMM] 紧急停止已解除');
        }
    }

    /**
     * 检查是否处于紧急停止状态
     */
    isEmergencyStopped(): boolean {
        return this.globalConfig.emergencyStop;
    }

    // ========================================================================
    // 私有方法
    // ========================================================================

    private updateGlobalStats(): void {
        let runningCount = 0;
        let totalPnL = 0;

        const statsEngines = Array.from(this.engines.values());
        for (const engine of statsEngines) {
            const state = engine.getState();
            if (state.status === 'running') {
                runningCount++;
            }

            const stats = engine.getStats();
            totalPnL += stats.realizedPnL;
        }

        this.globalStats.runningMarkets = runningCount;
        this.globalStats.totalRealizedPnL = totalPnL;
    }
}

// ============================================================================
// 类型定义
// ============================================================================

export interface GlobalStats {
    totalMarkets: number;
    runningMarkets: number;
    totalFills: number;
    totalVolume: number;
    totalRealizedPnL: number;
    startTime: Date | null;
}

export interface MultiMarketMakerEvents {
    onMarketStateChange?: (marketId: number, state: MarketState) => void;
    onMarketError?: (marketId: number, error: Error) => void;
    onFill?: (fill: Fill) => void;
    onOrderPlaced?: (marketId: number, order: ActiveOrder) => void;
    onOrderCancelled?: (marketId: number, orderId: string) => void;
    onPriceUpdate?: (snapshot: PriceSnapshot) => void;
}

// ============================================================================
// 辅助函数
// ============================================================================

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
