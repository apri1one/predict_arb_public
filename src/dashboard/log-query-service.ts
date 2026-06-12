/**
 * 日志查询服务 - 为前端提供日志查询 API
 *
 * 功能：
 * - 任务列表 (带分页)
 * - 任务时间线
 * - 统计报表
 * - 失败任务分析
 * - 订单簿快照查看
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// 类型定义
// ============================================================================

export interface TaskLogSummary {
    taskId: string;
    type: string;
    marketId: number;
    title: string;
    status: string;
    isSuccess: boolean;
    startTime: number;
    endTime: number;
    durationMs: number;
    predictFilledQty: number;
    polyFilledQty: number;
    hedgedQty: number;
    actualProfit: number;
    profitPercent: number;
    strategy?: 'PREDICT_MAKER' | 'TAKER' | 'POLY_MAKER';
}

export interface TaskTimelineEvent {
    timestamp: number;
    sequence: number;
    type: string;
    detail: string;
    payload?: Record<string, unknown>;
}

export interface TaskTimeline {
    taskId: string;
    type: string;
    marketId: number;
    title: string;
    status: string;
    createdAt: number;
    completedAt: number | null;
    durationMs: number;
    actualProfit: number;
    events: TaskTimelineEvent[];
}

export interface LogStats {
    period: string;
    total: number;
    success: number;
    failed: number;
    cancelled: number;
    successRate: number;
    totalProfit: number;
    avgProfit: number;
    avgDuration: number;
    totalVolume: number;
    byType: Array<{
        type: string;
        count: number;
        profit: number;
        avgProfitPercent: number;
    }>;
    byMarket: Array<{
        marketId: number;
        title: string;
        count: number;
        profit: number;
    }>;
}

export interface FailedTask {
    taskId: string;
    type: string;
    marketId: number;
    title: string;
    status: string;
    createdAt: number;
    durationMs: number;
    loss: number;
    unwindLoss: number;
    pauseCount: number;
    hedgeRetryCount: number;
    errorMessage: string;
}

export interface OrderBookSnapshot {
    timestamp: number;
    sequence: number;
    trigger: string;
    predict: {
        bestBid: number | null;
        bestAsk: number | null;
        spread: number | null;
        latencyMs: number;
        bids: [number, number][];
        asks: [number, number][];
    } | null;
    polymarket: {
        bestBid: number | null;
        bestAsk: number | null;
        spread: number | null;
        latencyMs: number;
        bids: [number, number][];
        asks: [number, number][];
    } | null;
    arbMetrics: {
        totalCost: number;
        profitPercent: number;
        isValid: boolean;
        maxDepth: number;
    };
}

// ============================================================================
// 工具函数
// ============================================================================

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
}

function readJsonl<T>(filePath: string): T[] {
    if (!fs.existsSync(filePath)) return [];

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    const results: T[] = [];

    for (const line of lines) {
        try {
            results.push(JSON.parse(line));
        } catch {
            // 忽略解析失败的行
        }
    }

    return results;
}

function readSummary(taskDir: string): TaskLogSummary | null {
    const summaryPath = path.join(taskDir, 'summary.json');
    if (!fs.existsSync(summaryPath)) return null;

    try {
        const content = fs.readFileSync(summaryPath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return null;
    }
}

// ============================================================================
// LogQueryService 类
// ============================================================================

export class LogQueryService {
    private logsBaseDir: string;

    constructor() {
        this.logsBaseDir = path.join(process.cwd(), 'data', 'logs', 'tasks');
    }

    /**
     * 获取任务列表 (带分页)
     */
    getTaskList(options?: {
        limit?: number;
        offset?: number;
        status?: string;
        type?: string;
    }): { tasks: TaskLogSummary[]; total: number } {
        const limit = options?.limit || 50;
        const offset = options?.offset || 0;

        if (!fs.existsSync(this.logsBaseDir)) {
            return { tasks: [], total: 0 };
        }

        const taskDirs = fs.readdirSync(this.logsBaseDir)
            .filter(name => {
                const taskDir = path.join(this.logsBaseDir, name);
                return fs.statSync(taskDir).isDirectory();
            });

        // 读取所有任务摘要
        const allTasks: TaskLogSummary[] = [];
        for (const taskId of taskDirs) {
            const taskDir = path.join(this.logsBaseDir, taskId);
            const summary = readSummary(taskDir);
            if (summary) {
                allTasks.push(summary);
            } else {
                // 没有 summary，从 events 构建基本信息
                const eventsPath = path.join(taskDir, 'events.jsonl');
                const events = readJsonl<any>(eventsPath);
                if (events.length > 0) {
                    const firstEvent = events[0];
                    const lastEvent = events[events.length - 1];
                    allTasks.push({
                        taskId,
                        type: firstEvent.payload?.taskConfig?.type || 'UNKNOWN',
                        marketId: firstEvent.payload?.taskConfig?.marketId || 0,
                        title: firstEvent.payload?.taskConfig?.title || taskId,
                        status: lastEvent.type?.replace('TASK_', '') || 'UNKNOWN',
                        isSuccess: lastEvent.type === 'TASK_COMPLETED',
                        startTime: firstEvent.timestamp,
                        endTime: lastEvent.timestamp,
                        durationMs: lastEvent.timestamp - firstEvent.timestamp,
                        predictFilledQty: 0,
                        polyFilledQty: 0,
                        hedgedQty: 0,
                        actualProfit: 0,
                        profitPercent: 0,
                    });
                }
            }
        }

        // 过滤
        let filtered = allTasks;
        if (options?.status) {
            filtered = filtered.filter(t => t.status === options.status);
        }
        if (options?.type) {
            filtered = filtered.filter(t => t.type === options.type);
        }

        // 按时间降序
        filtered.sort((a, b) => b.startTime - a.startTime);

        // 分页
        const paged = filtered.slice(offset, offset + limit);

        return { tasks: paged, total: filtered.length };
    }

    /**
     * 获取任务时间线
     */
    getTaskTimeline(taskId: string): TaskTimeline | null {
        const taskDir = path.join(this.logsBaseDir, taskId);
        if (!fs.existsSync(taskDir)) return null;

        const summary = readSummary(taskDir);
        const eventsPath = path.join(taskDir, 'events.jsonl');
        const events = readJsonl<any>(eventsPath);

        if (events.length === 0) return null;

        const firstEvent = events[0];
        const lastEvent = events[events.length - 1];

        // 构建时间线事件
        const timelineEvents: TaskTimelineEvent[] = events.map(event => {
            let detail = '';
            const p = event.payload || {};

            switch (event.type) {
                case 'TASK_CREATED':
                case 'TASK_STARTED':
                    detail = `${p.taskConfig?.type || ''} ${p.taskConfig?.quantity || ''} @ ${p.taskConfig?.predictPrice || ''}`;
                    break;
                case 'ORDER_SUBMITTED':
                    detail = `${p.platform} ${p.side} ${p.quantity} @ ${p.price}`;
                    break;
                case 'ORDER_FILLED':
                case 'ORDER_PARTIAL_FILL':
                    detail = `${p.platform} filled ${p.filledQty} @ ${p.avgPrice}`;
                    break;
                case 'ORDER_CANCELLED':
                    // 尝试显示取消原因
                    if (p.cancelReason) {
                        detail = p.cancelReason;
                    } else {
                        detail = `${p.platform || ''} ${p.side || ''} ${p.quantity || ''} @ ${p.price || ''}`.trim();
                    }
                    break;
                case 'PRICE_GUARD_TRIGGERED':
                    detail = `poly=${p.triggerPrice?.toFixed(4)} > max=${p.thresholdPrice}`;
                    break;
                case 'PRICE_GUARD_RESUMED':
                    detail = `poly=${p.triggerPrice?.toFixed(4)} <= max=${p.thresholdPrice}`;
                    break;
                case 'DEPTH_GUARD_TRIGGERED':
                    detail = `depth=${p.availableDepth} < required=${p.requiredDepth}`;
                    break;
                case 'DEPTH_GUARD_RESUMED':
                    detail = `depth=${p.availableDepth} >= required=${p.requiredDepth}`;
                    break;
                case 'HEDGE_COMPLETED':
                    detail = `hedged ${p.hedgeQty} @ ${p.avgHedgePrice?.toFixed(4)}`;
                    break;
                case 'TASK_COMPLETED':
                    detail = `profit: $${(p.profit || 0).toFixed(2)}`;
                    break;
                case 'TASK_FAILED':
                    detail = p.reason || p.error?.message || '';
                    break;
                default:
                    if (p.reason) detail = p.reason;
            }

            return {
                timestamp: event.timestamp,
                sequence: event.sequence,
                type: event.type,
                detail,
                payload: p,
            };
        });

        return {
            taskId,
            type: summary?.type || firstEvent.payload?.taskConfig?.type || 'UNKNOWN',
            marketId: summary?.marketId || firstEvent.payload?.taskConfig?.marketId || 0,
            title: summary?.title || firstEvent.payload?.taskConfig?.title || taskId,
            status: summary?.status || lastEvent.type?.replace('TASK_', '') || 'UNKNOWN',
            createdAt: summary?.startTime || firstEvent.timestamp,
            completedAt: summary?.endTime || (lastEvent.type?.includes('COMPLETED') || lastEvent.type?.includes('FAILED') ? lastEvent.timestamp : null),
            durationMs: summary?.durationMs || (lastEvent.timestamp - firstEvent.timestamp),
            actualProfit: summary?.actualProfit || 0,
            events: timelineEvents,
        };
    }

    /**
     * 获取统计数据
     */
    getStats(days: number = 7): LogStats {
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

        if (!fs.existsSync(this.logsBaseDir)) {
            return this.emptyStats(days);
        }

        const taskDirs = fs.readdirSync(this.logsBaseDir)
            .filter(name => {
                const taskDir = path.join(this.logsBaseDir, name);
                return fs.statSync(taskDir).isDirectory();
            });

        let total = 0, success = 0, failed = 0, cancelled = 0;
        let totalProfit = 0, totalDuration = 0, totalVolume = 0;
        const byType: Map<string, { count: number; profit: number; profitPercentSum: number }> = new Map();
        const byMarket: Map<number, { title: string; count: number; profit: number }> = new Map();

        for (const taskId of taskDirs) {
            const taskDir = path.join(this.logsBaseDir, taskId);
            const summary = readSummary(taskDir);

            if (!summary) continue;
            if (summary.startTime < cutoff) continue;

            total++;
            if (summary.isSuccess) success++;
            else if (summary.status === 'FAILED' || summary.status === 'HEDGE_FAILED') failed++;
            else if (summary.status === 'CANCELLED') cancelled++;

            totalProfit += summary.actualProfit || 0;
            totalDuration += summary.durationMs || 0;
            // 成交量按主动方口径：POLY_MAKER 主动方是 Polymarket，其余是 Predict
            const activeFilled = summary.strategy === 'POLY_MAKER'
                ? summary.polyFilledQty
                : summary.predictFilledQty;
            totalVolume += activeFilled || 0;

            // 按类型统计
            const typeStats = byType.get(summary.type) || { count: 0, profit: 0, profitPercentSum: 0 };
            typeStats.count++;
            typeStats.profit += summary.actualProfit || 0;
            typeStats.profitPercentSum += summary.profitPercent || 0;
            byType.set(summary.type, typeStats);

            // 按市场统计
            const marketStats = byMarket.get(summary.marketId) || { title: summary.title, count: 0, profit: 0 };
            marketStats.count++;
            marketStats.profit += summary.actualProfit || 0;
            byMarket.set(summary.marketId, marketStats);
        }

        return {
            period: `Last ${days} days`,
            total,
            success,
            failed,
            cancelled,
            successRate: total > 0 ? (success / total) * 100 : 0,
            totalProfit,
            avgProfit: total > 0 ? totalProfit / total : 0,
            avgDuration: total > 0 ? totalDuration / total : 0,
            totalVolume,
            byType: Array.from(byType.entries()).map(([type, stats]) => ({
                type,
                count: stats.count,
                profit: stats.profit,
                avgProfitPercent: stats.count > 0 ? stats.profitPercentSum / stats.count : 0,
            })),
            byMarket: Array.from(byMarket.entries())
                .map(([marketId, stats]) => ({
                    marketId,
                    title: stats.title,
                    count: stats.count,
                    profit: stats.profit,
                }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 10),
        };
    }

    /**
     * 获取失败任务列表
     */
    getFailures(days: number = 7): FailedTask[] {
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

        if (!fs.existsSync(this.logsBaseDir)) {
            return [];
        }

        const taskDirs = fs.readdirSync(this.logsBaseDir)
            .filter(name => {
                const taskDir = path.join(this.logsBaseDir, name);
                return fs.statSync(taskDir).isDirectory();
            });

        const failures: FailedTask[] = [];

        for (const taskId of taskDirs) {
            const taskDir = path.join(this.logsBaseDir, taskId);
            const summary = readSummary(taskDir);

            if (!summary) continue;
            if (summary.startTime < cutoff) continue;
            if (!['FAILED', 'HEDGE_FAILED', 'UNWIND_COMPLETED'].includes(summary.status)) continue;

            // 获取错误信息
            const eventsPath = path.join(taskDir, 'events.jsonl');
            const events = readJsonl<any>(eventsPath);
            const failedEvent = events.find(e => e.type.includes('FAILED'));
            const errorMessage = failedEvent?.payload?.error?.message
                || failedEvent?.payload?.reason
                || '';

            failures.push({
                taskId,
                type: summary.type,
                marketId: summary.marketId,
                title: summary.title,
                status: summary.status,
                createdAt: summary.startTime,
                durationMs: summary.durationMs,
                loss: summary.actualProfit,
                unwindLoss: (summary as any).unwindLoss || 0,
                pauseCount: (summary as any).pauseCount || 0,
                hedgeRetryCount: (summary as any).hedgeRetryCount || 0,
                errorMessage,
            });
        }

        // 按时间降序
        failures.sort((a, b) => b.createdAt - a.createdAt);

        return failures;
    }

    /**
     * 获取订单簿快照
     */
    getOrderBookSnapshot(taskId: string, sequence?: number): OrderBookSnapshot[] {
        const taskDir = path.join(this.logsBaseDir, taskId);
        const snapshotsPath = path.join(taskDir, 'orderbooks.jsonl');

        if (!fs.existsSync(snapshotsPath)) {
            return [];
        }

        const snapshots = readJsonl<any>(snapshotsPath);

        if (sequence !== undefined) {
            const found = snapshots.find(s => s.sequence === sequence);
            return found ? [this.formatSnapshot(found)] : [];
        }

        return snapshots.map(s => this.formatSnapshot(s));
    }

    private formatSnapshot(raw: any): OrderBookSnapshot {
        return {
            timestamp: raw.timestamp,
            sequence: raw.sequence,
            trigger: raw.trigger,
            predict: raw.predict ? {
                bestBid: raw.predict.bestBid,
                bestAsk: raw.predict.bestAsk,
                spread: raw.predict.spread,
                latencyMs: raw.predict.latencyMs,
                bids: raw.predict.bids || [],
                asks: raw.predict.asks || [],
            } : null,
            polymarket: raw.polymarket ? {
                bestBid: raw.polymarket.bestBid,
                bestAsk: raw.polymarket.bestAsk,
                spread: raw.polymarket.spread,
                latencyMs: raw.polymarket.latencyMs,
                bids: raw.polymarket.bids || [],
                asks: raw.polymarket.asks || [],
            } : null,
            arbMetrics: raw.arbMetrics || {
                totalCost: 0,
                profitPercent: 0,
                isValid: false,
                maxDepth: 0,
            },
        };
    }

    private emptyStats(days: number): LogStats {
        return {
            period: `Last ${days} days`,
            total: 0,
            success: 0,
            failed: 0,
            cancelled: 0,
            successRate: 0,
            totalProfit: 0,
            avgProfit: 0,
            avgDuration: 0,
            totalVolume: 0,
            byType: [],
            byMarket: [],
        };
    }
}

// 单例
let instance: LogQueryService | null = null;

export function getLogQueryService(): LogQueryService {
    if (!instance) {
        instance = new LogQueryService();
    }
    return instance;
}
