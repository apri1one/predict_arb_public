/**
 * Order Watcher 工厂模块
 *
 * 提供统一的订单成交监控接口，支持配置选择：
 * - Predict WS (默认)：通过 Predict 官方 WebSocket 钱包事件监控
 * - BSC WSS：通过 BSC 链上 WebSocket 监控 OrderFilled 事件
 *
 * 环境变量配置：
 * - PREDICT_ORDER_WATCHER_SOURCE: 'predict' | 'bsc' | 'auto'
 *   - 'predict' (默认)：仅使用 Predict WS
 *   - 'bsc'：仅使用 BSC WSS
 *   - 'auto'：优先 Predict WS，失败时 fallback 到 BSC WSS
 */

import type { EventEmitter } from 'events';

// ============================================================================
// 公共接口
// ============================================================================

export interface OrderFilledEvent {
    orderHash: string;
    txHash: string;
    logIndex: number;
    maker: string;
    taker: string;
    makerAssetId: string;
    takerAssetId: string;
    makerAmountFilled: string | number;
    takerAmountFilled: string | number;
    fee: string | number;
    blockNumber: number;
    timestamp: number;
    rawEvent?: any;
}

export type OrderWatchCallback = (event: OrderFilledEvent) => void;

export interface IOrderWatcher extends EventEmitter {
    start(): Promise<void>;
    stop(): void;
    isConnected(): boolean;
    watchOrder(orderHash: string, callback: OrderWatchCallback, timeoutMs?: number, orderId?: string): () => void;
    unwatchOrder(orderHash: string, callback?: OrderWatchCallback): void;
    registerOrderMapping?(orderHash: string, orderId: string): void;
    isSubscriptionValid?(): boolean;
}

// ============================================================================
// 配置
// ============================================================================

type WatcherSource = 'predict' | 'bsc' | 'auto';

function getWatcherSource(): WatcherSource {
    const source = process.env.PREDICT_ORDER_WATCHER_SOURCE?.toLowerCase();
    if (source === 'bsc') return 'bsc';
    if (source === 'auto') return 'auto';
    return 'predict';  // 默认使用 Predict WS
}

// ============================================================================
// 动态加载器
// ============================================================================

let predictWatcher: IOrderWatcher | null = null;
let bscWatcher: IOrderWatcher | null = null;
let activeWatcher: IOrderWatcher | null = null;
let currentSource: WatcherSource | null = null;

/**
 * 动态加载 Predict Order Watcher
 */
async function loadPredictWatcher(): Promise<IOrderWatcher> {
    if (predictWatcher) return predictWatcher;

    const { getPredictOrderWatcher } = await import('./predict-order-watcher.js');
    predictWatcher = getPredictOrderWatcher() as IOrderWatcher;
    return predictWatcher;
}

/**
 * 动态加载 BSC Order Watcher
 */
async function loadBscWatcher(): Promise<IOrderWatcher> {
    if (bscWatcher) return bscWatcher;

    const { getBscOrderWatcher } = await import('./bsc-order-watcher.js');
    bscWatcher = getBscOrderWatcher() as IOrderWatcher;
    return bscWatcher;
}

// ============================================================================
// 公共 API
// ============================================================================

/**
 * 获取订单监控器实例
 *
 * 根据 PREDICT_ORDER_WATCHER_SOURCE 配置返回相应的 watcher：
 * - 'predict': Predict WS watcher
 * - 'bsc': BSC WSS watcher
 * - 'auto': 优先 Predict WS，失败时 fallback 到 BSC
 */
export async function getOrderWatcher(): Promise<IOrderWatcher> {
    const source = getWatcherSource();

    // 如果已有活跃 watcher 且配置未变，直接返回
    if (activeWatcher && currentSource === source) {
        return activeWatcher;
    }

    currentSource = source;

    switch (source) {
        case 'bsc':
            console.log('[OrderWatcherFactory] 使用 BSC WSS 订单监控');
            activeWatcher = await loadBscWatcher();
            break;

        case 'auto':
            console.log('[OrderWatcherFactory] 使用 Auto 模式 (Predict WS 优先)');
            try {
                activeWatcher = await loadPredictWatcher();
                // 检查连接和订阅状态
                if (!activeWatcher.isConnected()) {
                    await activeWatcher.start();
                }
                if (activeWatcher.isSubscriptionValid && !activeWatcher.isSubscriptionValid()) {
                    throw new Error('Predict WS 订阅无效');
                }
                console.log('[OrderWatcherFactory] Predict WS 可用');
            } catch (e: any) {
                console.warn(`[OrderWatcherFactory] Predict WS 不可用 (${e?.message}), 降级到 BSC WSS`);
                activeWatcher = await loadBscWatcher();
            }
            break;

        case 'predict':
        default:
            console.log('[OrderWatcherFactory] 使用 Predict WS 订单监控');
            activeWatcher = await loadPredictWatcher();
            break;
    }

    return activeWatcher;
}

/**
 * 同步获取当前活跃的 watcher（如果已初始化）
 */
export function getActiveOrderWatcher(): IOrderWatcher | null {
    return activeWatcher;
}

/**
 * 获取当前使用的 watcher 源
 */
export function getCurrentWatcherSource(): WatcherSource | null {
    return currentSource;
}

/**
 * 判断当前是否使用 Predict WS
 */
export function isUsingPredictWs(): boolean {
    return currentSource === 'predict' || (currentSource === 'auto' && activeWatcher === predictWatcher);
}

/**
 * 判断当前是否使用 BSC WSS
 */
export function isUsingBscWss(): boolean {
    return currentSource === 'bsc' || (currentSource === 'auto' && activeWatcher === bscWatcher);
}

/**
 * 强制切换到指定的 watcher
 * 仅在 auto 模式下有效，用于手动 fallback
 */
export async function switchToWatcher(target: 'predict' | 'bsc'): Promise<IOrderWatcher> {
    if (currentSource !== 'auto') {
        console.warn(`[OrderWatcherFactory] 当前模式是 ${currentSource}，无法切换`);
        return activeWatcher!;
    }

    if (target === 'predict') {
        activeWatcher = await loadPredictWatcher();
        console.log('[OrderWatcherFactory] 已切换到 Predict WS');
    } else {
        activeWatcher = await loadBscWatcher();
        console.log('[OrderWatcherFactory] 已切换到 BSC WSS');
    }

    return activeWatcher;
}

/**
 * 停止所有 watcher
 */
export function stopAllWatchers(): void {
    if (predictWatcher) {
        try {
            predictWatcher.stop();
        } catch { /* ignore */ }
        predictWatcher = null;
    }

    if (bscWatcher) {
        try {
            bscWatcher.stop();
        } catch { /* ignore */ }
        bscWatcher = null;
    }

    activeWatcher = null;
    currentSource = null;
}

/**
 * 获取 watcher 状态信息
 */
export function getWatcherStatus(): {
    source: WatcherSource | null;
    predictWs: { connected: boolean; subscriptionValid: boolean } | null;
    bscWss: { connected: boolean } | null;
} {
    return {
        source: currentSource,
        predictWs: predictWatcher ? {
            connected: predictWatcher.isConnected(),
            subscriptionValid: predictWatcher.isSubscriptionValid?.() ?? false,
        } : null,
        bscWss: bscWatcher ? {
            connected: bscWatcher.isConnected(),
        } : null,
    };
}

// ============================================================================
// 工具函数（从两个 watcher 统一导出）
// ============================================================================

/**
 * 从成交事件中提取 shares 数量
 */
export function getSharesFromFillEvent(event: OrderFilledEvent): number {
    // 优先使用 rawEvent 中的 filledQty（Predict WS 格式）
    if (event.rawEvent?.filledQty !== undefined) {
        const qty = event.rawEvent.filledQty;
        if (typeof qty === 'number' && qty > 0) {
            return qty;
        }
    }

    // 解析 wei 格式（BSC WSS 或兜底）
    const parseWei18 = (v: string | number): number => {
        if (typeof v === 'number') return v;
        try {
            const s = String(v || '0');
            if (!s || s === '0') return 0;
            return Number(BigInt(s)) / 1e18;
        } catch {
            return 0;
        }
    };

    // takerAssetId=0 表示 USDC，另一边是 token
    if (String(event.takerAssetId) === '0') {
        return parseWei18(event.makerAmountFilled);
    } else {
        return parseWei18(event.takerAmountFilled);
    }
}
