/**
 * 余额守卫 (Balance Guard) — 双边对称
 *
 * 事件源:
 *   - Polymarket WS: trade/order 事件 → 检查 Poly 余额 (保护 PREDICT_MAKER 任务的 Poly 对冲)
 *   - Predict WS:   orderFilled 事件 → 检查 Predict 余额 (保护 POLY_MAKER 任务的 Predict 对冲)
 *
 * 余额不足时自动批量取消相关任务，防止裸露头寸风险。
 */

import type { Task, TaskStatus } from './types.js';
import type { PolymarketUserWsClient, TradeEvent, OrderEvent } from '../polymarket/user-ws-client.js';
import type { PredictOrderWatcher } from '../services/predict-order-watcher.js';
import type { TaskExecutor } from './task-executor.js';
import type { TelegramNotifier } from '../notification/telegram.js';
import { computeMaxPredictAsk, FEE_REBATE_PERCENT } from './poly-maker-mode/helpers.js';
import { POLY_MAKER_PREDICT_HEDGE_SLIPPAGE_TICKS } from './dashboard-config.js';

// 终态状态集合 — 这些任务不需要检查
const TERMINAL_STATUSES: Set<TaskStatus> = new Set([
    'COMPLETED', 'FAILED', 'CANCELLED',
    'TIMEOUT_CANCELLED', 'HEDGE_FAILED', 'UNWIND_COMPLETED',
]);

// UNWIND 相关状态 — 不取消正在平仓的任务
const UNWIND_STATUSES: Set<TaskStatus> = new Set([
    'UNWINDING', 'UNWIND_PENDING', 'UNWIND_COMPLETED',
]);

// 触发检查的 trade event 状态
const TRIGGER_STATUSES: Set<string> = new Set(['MATCHED', 'CONFIRMED']);

export interface BalanceGuardDeps {
    getUserWsClient: () => PolymarketUserWsClient | null;
    getPredictOrderWatcher: () => PredictOrderWatcher | null;
    taskExecutor: TaskExecutor;
    getTaskList: () => Task[];
    getAvailableBalance: () => Promise<number | null>;
    getPredictAvailableBalance: () => Promise<number | null>;
    broadcastSSE: (eventName: string, data: string) => void;
    getTelegramNotifier: () => TelegramNotifier | null;
}

export interface BalanceGuard {
    start(): void;
    stop(): void;
}

const DEBOUNCE_MS = 1000;
const BALANCE_GUARD_CANCEL_CONCURRENCY = 4;
const PREDICT_HEDGE_SLIPPAGE = POLY_MAKER_PREDICT_HEDGE_SLIPPAGE_TICKS * 0.01;

export function createBalanceGuard(deps: BalanceGuardDeps): BalanceGuard {
    const {
        getUserWsClient,
        getPredictOrderWatcher,
        taskExecutor,
        getTaskList,
        getAvailableBalance,
        getPredictAvailableBalance,
        broadcastSSE,
        getTelegramNotifier,
    } = deps;

    let tradeListenerId: string | null = null;
    let orderListenerId: string | null = null;
    let predictFilledHandler: (() => void) | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let checking = false;  // 重入锁

    function calcPredictRequiredBalance(task: Task): number {
        if (task.strategy !== 'POLY_MAKER' || task.type !== 'BUY') return 0;
        if (!task.polyBidPrice || task.polyBidPrice <= 0) return 0;

        const remainingQty = Math.max(0, (task.quantity || 0) - Math.max(0, task.hedgedQty || 0));
        if (remainingQty <= 0) return 0;

        const feeRateBps = task.feeRateBps || 200;
        const askPrice = computeMaxPredictAsk(task.polyBidPrice, PREDICT_HEDGE_SLIPPAGE);
        const feePerShare =
            (feeRateBps / 10000) *
            Math.min(askPrice, 1 - askPrice) *
            (1 - FEE_REBATE_PERCENT);
        const feeAsSharePercent = askPrice > 0 ? (feePerShare / askPrice) : 0;
        const grossQty = remainingQty / Math.max(1e-9, (1 - feeAsSharePercent));
        return grossQty * askPrice;
    }

    async function cancelTasksInBatch(
        entries: Array<{ id: string; reason: string }>
    ): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
        const queue = [...entries];
        const results: Array<{ id: string; ok: boolean; error?: string }> = [];

        async function worker(): Promise<void> {
            while (queue.length > 0) {
                const item = queue.shift();
                if (!item) return;
                try {
                    await taskExecutor.cancelTask(item.id, {
                        reason: item.reason,
                        cancelReason: 'BALANCE_GUARD',
                    });
                    results.push({ id: item.id, ok: true });
                } catch (err) {
                    results.push({ id: item.id, ok: false, error: (err as Error).message });
                }
            }
        }

        const workers = Array.from({
            length: Math.min(BALANCE_GUARD_CANCEL_CONCURRENCY, Math.max(1, entries.length)),
        }, () => worker());
        await Promise.all(workers);
        return results;
    }

    /**
     * 核心检查逻辑：查询余额 → 汇总不足任务 → 批量取消
     */
    async function checkAndCancel(): Promise<void> {
        if (checking) return;
        checking = true;

        try {
            const [polyAvailable, predictAvailable] = await Promise.all([
                getAvailableBalance(),
                getPredictAvailableBalance(),
            ]);
            if (polyAvailable === null && predictAvailable === null) {
                // 两边都查不到，不误杀
                console.log('[BalanceGuard] Poly/Predict 余额查询均失败，跳过本次检查');
                return;
            }

            const tasks = getTaskList();
            const candidates = tasks.filter(t =>
                t.type === 'BUY'
                && !TERMINAL_STATUSES.has(t.status)
                && !UNWIND_STATUSES.has(t.status)
            );

            if (candidates.length === 0) return;

            console.log(
                `[BalanceGuard] 余额检查: `
                + `Poly=${polyAvailable === null ? 'N/A' : `$${polyAvailable.toFixed(2)}`}, `
                + `Predict=${predictAvailable === null ? 'N/A' : `$${predictAvailable.toFixed(2)}`}, `
                + `候选任务=${candidates.length}`,
            );

            const insufficientTasks = new Map<string, {
                task: Task;
                reasons: string[];
                polyRequired?: number;
                predictRequired?: number;
            }>();

            for (const task of candidates) {
                // Poly 余额检查: 仅 PREDICT_MAKER 任务 (Poly 是对冲端，需要可用余额下 IOC)
                // POLY_MAKER 的 Poly 余额在 GTC 挂单时已锁定，由交易所管理
                if (polyAvailable !== null && task.strategy === 'PREDICT_MAKER') {
                    const polyRequired = task.polyRequiredBalance ?? 0;
                    if (polyRequired > 0 && polyAvailable < polyRequired) {
                        const entry = insufficientTasks.get(task.id) || { task, reasons: [] };
                        entry.polyRequired = polyRequired;
                        entry.reasons.push(`Polymarket 余额不足 ($${polyAvailable.toFixed(2)} < $${polyRequired.toFixed(2)})`);
                        insufficientTasks.set(task.id, entry);
                    }
                }

                // Predict 余额检查: 仅 POLY_MAKER 任务 (Predict 是对冲端)
                if (predictAvailable !== null && task.strategy === 'POLY_MAKER') {
                    const predictRequired = calcPredictRequiredBalance(task);
                    if (predictRequired > 0 && predictAvailable < predictRequired) {
                        const entry = insufficientTasks.get(task.id) || { task, reasons: [] };
                        entry.predictRequired = predictRequired;
                        entry.reasons.push(`Predict 余额不足 ($${predictAvailable.toFixed(2)} < $${predictRequired.toFixed(2)})`);
                        insufficientTasks.set(task.id, entry);
                    }
                }
            }

            if (insufficientTasks.size > 0) {
                const taskIds = [...insufficientTasks.keys()];
                console.warn(`[BalanceGuard] ⚠️ 命中 ${taskIds.length} 个余额不足任务，执行批量取消`);
                const results = await cancelTasksInBatch(taskIds.map(id => {
                    const entry = insufficientTasks.get(id)!;
                    return {
                        id,
                        reason: `余额守护取消: ${entry.reasons.join('；')}`,
                    };
                }));
                const cancelledTasks = results
                    .filter(r => r.ok)
                    .map(r => {
                        const entry = insufficientTasks.get(r.id)!;
                        return {
                            id: r.id,
                            title: entry.task.title,
                            reasons: entry.reasons,
                        };
                    });
                const failedTasks = results
                    .filter(r => !r.ok)
                    .map(r => ({
                        id: r.id,
                        title: insufficientTasks.get(r.id)?.task.title || r.id,
                        error: r.error || 'unknown',
                    }));

                // SSE 广播
                broadcastSSE('balanceGuard', JSON.stringify({
                    type: 'BALANCE_INSUFFICIENT',
                    polymarketAvailable: polyAvailable,
                    predictAvailable,
                    cancelledTaskIds: cancelledTasks.map(t => t.id),
                    failedTaskIds: failedTasks.map(t => t.id),
                    timestamp: Date.now(),
                }));

                // Telegram 通知
                const tg = getTelegramNotifier();
                if (tg) {
                    const lines = [
                        `⚠️ <b>余额守卫批量取消</b>`,
                        `Polymarket 可用余额: ${polyAvailable === null ? 'N/A' : `$${polyAvailable.toFixed(2)}`}`,
                        `Predict 可用余额: ${predictAvailable === null ? 'N/A' : `$${predictAvailable.toFixed(2)}`}`,
                        `已取消 ${cancelledTasks.length} 个任务:`,
                        ...cancelledTasks.map(t => `  - ${t.title}\n    原因: ${t.reasons.join('；')}`),
                        ...(failedTasks.length > 0
                            ? [
                                `取消失败 ${failedTasks.length} 个任务:`,
                                ...failedTasks.map(t => `  - ${t.title}: ${t.error}`),
                            ]
                            : []),
                    ];
                    tg.sendText(lines.join('\n')).catch(() => { /* ignore */ });
                }
            }

        } catch (error) {
            console.error('[BalanceGuard] 检查异常:', (error as Error).message);
        } finally {
            checking = false;
        }
    }

    /**
     * 统一的 debounce 调度: 多次事件合并为一次检查
     * 已有 pending 检查时不重置计时器，防止高频事件无限推迟
     */
    function scheduleCheck(): void {
        if (debounceTimer) return;  // 已有 pending 检查，不重置

        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            checkAndCancel();
        }, DEBOUNCE_MS);
    }

    /**
     * Polymarket WS trade 事件回调 (PREDICT_MAKER 侧: Poly 成交 → 检查 Poly 余额)
     */
    function onTradeEvent(event: TradeEvent): void {
        if (!TRIGGER_STATUSES.has(event.status)) return;
        scheduleCheck();
    }

    /**
     * Polymarket 订单取消事件回调
     * 交易所因余额/allowance 等原因自动撤单时，也会通过这里触发余额守护检查
     */
    function onOrderEvent(event: OrderEvent): void {
        if (event.type !== 'CANCELLATION') return;
        scheduleCheck();
    }

    /**
     * Predict WS 成交事件回调 (POLY_MAKER 侧: Predict 成交 → 余额减少 → 检查 Predict 余额)
     */
    function onPredictFilled(): void {
        scheduleCheck();
    }

    return {
        start(): void {
            // Polymarket 侧: 监听成交/撤单事件 → 检查 Poly 余额 (保护 PREDICT_MAKER 任务)
            const wsClient = getUserWsClient();
            if (!wsClient) {
                console.warn('[BalanceGuard] Polymarket User WS 未初始化，Poly 侧余额守卫未启动');
            } else {
                tradeListenerId = wsClient.addTradeEventListener(onTradeEvent);
                orderListenerId = wsClient.addOrderEventListener(onOrderEvent);
            }

            // Predict 侧: 监听成交事件 → 检查 Predict 余额 (保护 POLY_MAKER 任务)
            const predictWatcher = getPredictOrderWatcher();
            if (!predictWatcher) {
                console.warn('[BalanceGuard] PredictOrderWatcher 未初始化，Predict 侧余额守卫未启动');
            } else {
                predictFilledHandler = onPredictFilled;
                predictWatcher.on('orderFilled', predictFilledHandler);
            }

            const polySide = wsClient ? '✅' : '❌';
            const predictSide = predictWatcher ? '✅' : '❌';
            console.log(`✅ 余额守卫已启动 (Poly ${polySide} Predict ${predictSide})`);
        },

        stop(): void {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }
            if (tradeListenerId) {
                try {
                    const wsClient = getUserWsClient();
                    wsClient?.removeTradeEventListener(tradeListenerId);
                } catch { /* ignore during shutdown */ }
                tradeListenerId = null;
            }
            if (orderListenerId) {
                try {
                    const wsClient = getUserWsClient();
                    wsClient?.removeOrderEventListener(orderListenerId);
                } catch { /* ignore during shutdown */ }
                orderListenerId = null;
            }
            if (predictFilledHandler) {
                try {
                    const predictWatcher = getPredictOrderWatcher();
                    predictWatcher?.removeListener('orderFilled', predictFilledHandler);
                } catch { /* ignore during shutdown */ }
                predictFilledHandler = null;
            }
        },
    };
}
