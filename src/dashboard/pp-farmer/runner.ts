/**
 * Auto PP-Farmer Runner
 *
 * 每 5 分钟轮询所有有 PP 奖励的市场，自动按 PREDICT_MAKER 策略创建 + 启动任务。
 * 单平台资金池 = min(两平台可用) × 50%，所有本轮候选共享。
 * 开关默认关闭，内存状态（重启后恢复 OFF）。
 * 收益率阈值 yieldThreshold 可运行时调整（POST /api/pp-farmer/config）。
 * off→on 时立即执行一次，之后进入 5 分钟周期。
 */

import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { ArbOpportunity, ArbSide, AutoTaskPreviewItem } from '../types.js';
import type { SportsMatchedMarket } from '../sports-types.js';
import { selectPpFarmerCandidates, type PpFarmerSelection } from './candidate.js';

export const PP_FARMER_POLL_INTERVAL_MS = 5 * 60 * 1000;
const TASK_CREATE_INTERVAL_MS = 500;
const DEFAULT_YIELD_THRESHOLD = 0.001;
const MAX_BUDGET_POOL_RATIO = 0.5;
const DEFAULT_BUDGET_POOL_RATIO = 0.5;

function sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CreateAndStartResult {
    taskId?: string;
    error?: string;
}

export interface PpFarmerRunnerOptions {
    /** 候选源：'all' = 非体育套利市场；'sports' = 体育市场 */
    source: 'all' | 'sports';
    getOpportunities: () => ArbOpportunity[];
    getSportsMarkets: () => SportsMatchedMarket[];
    getAccounts: () => Promise<{
        predict: { available: number };
        polymarket: { available: number };
    }>;
    hasActiveTask: (
        marketId: number,
        type: 'BUY' | 'SELL',
        arbSide: ArbSide,
        strategy?: 'PREDICT_MAKER' | 'POLY_MAKER'
    ) => boolean;
    createAndStartTask: (
        candidate: AutoTaskPreviewItem,
        index: number
    ) => Promise<CreateAndStartResult>;
    /** 用户归档的 marketId 集合（candidate 选择时跳过） */
    getArchivedMarketIds?: () => Set<number>;
    logFilePath?: string;
}

export interface PpFarmerRunSummary {
    startedAt: number;
    finishedAt: number;
    durationMs: number;
    considered: number;
    qualified: number;
    createdCount: number;
    failedCount: number;
    poolUsdc: number;
    remainingUsdc: number;
    yieldThreshold: number;
    tasks: Array<{
        id: string;
        marketId: number;
        title: string;
        arbSide: ArbSide;
        quantity: number;
        predictBidPrice: number;
        polymarketHedgePrice: number;
        taskId?: string;
        error?: string;
    }>;
    skipped: Record<string, number>;
}

export interface PpFarmerState {
    enabled: boolean;
    busy: boolean;
    lastRunAt: number | null;
    nextRunAt: number | null;
    lastSummary: PpFarmerRunSummary | null;
    pollIntervalMs: number;
    config: {
        source: 'all' | 'sports';
        yieldThreshold: number;
        budgetPoolRatio: number;
        maxBudgetPoolRatio: number;
    };
}

export class PpFarmerRunner {
    private readonly options: PpFarmerRunnerOptions;
    private enabled = false;
    private busy = false;
    private lastRunAt: number | null = null;
    private nextRunAt: number | null = null;
    private lastSummary: PpFarmerRunSummary | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private yieldThreshold = DEFAULT_YIELD_THRESHOLD;
    private budgetPoolRatio = DEFAULT_BUDGET_POOL_RATIO;

    constructor(options: PpFarmerRunnerOptions) {
        this.options = options;
        if (options.logFilePath) {
            try {
                mkdirSync(dirname(options.logFilePath), { recursive: true });
            } catch {
                /* ignore */
            }
        }
    }

    getState(): PpFarmerState {
        return {
            enabled: this.enabled,
            busy: this.busy,
            lastRunAt: this.lastRunAt,
            nextRunAt: this.nextRunAt,
            lastSummary: this.lastSummary,
            pollIntervalMs: PP_FARMER_POLL_INTERVAL_MS,
            config: {
                source: this.options.source,
                yieldThreshold: this.yieldThreshold,
                budgetPoolRatio: this.budgetPoolRatio,
                maxBudgetPoolRatio: MAX_BUDGET_POOL_RATIO,
            },
        };
    }

    setYieldThreshold(value: number): void {
        if (!Number.isFinite(value) || value < 0) return;
        this.yieldThreshold = value;
        this.log('INFO', 'yieldThreshold updated', { yieldThreshold: value });
    }

    setBudgetPoolRatio(value: number): void {
        if (!Number.isFinite(value) || value < 0) return;
        const clamped = Math.min(MAX_BUDGET_POOL_RATIO, value);
        this.budgetPoolRatio = clamped;
        this.log('INFO', 'budgetPoolRatio updated', { budgetPoolRatio: clamped });
    }

    async toggle(): Promise<PpFarmerState> {
        if (this.enabled) this.disable();
        else await this.enable();
        return this.getState();
    }

    async enable(): Promise<void> {
        if (this.enabled) return;
        this.enabled = true;
        this.log('INFO', 'pp-farmer enabled', { trigger: 'toggle', yieldThreshold: this.yieldThreshold });
        this.scheduleTimer();
        // 立即触发一次
        void this.runOnce('manual-toggle').catch((err: any) => {
            this.log('ERROR', 'first-run after enable failed', { error: err?.message });
        });
    }

    disable(): void {
        if (!this.enabled) return;
        this.enabled = false;
        this.clearTimer();
        this.nextRunAt = null;
        this.log('INFO', 'pp-farmer disabled', { trigger: 'toggle' });
    }

    shutdown(): void {
        this.disable();
    }

    private scheduleTimer(): void {
        this.clearTimer();
        if (!this.enabled) return;
        this.nextRunAt = Date.now() + PP_FARMER_POLL_INTERVAL_MS;
        this.timer = setInterval(() => {
            void this.runOnce('interval').catch((err: any) => {
                this.log('ERROR', 'interval run failed', { error: err?.message });
            });
        }, PP_FARMER_POLL_INTERVAL_MS);
    }

    private clearTimer(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async runOnce(trigger: 'interval' | 'manual-toggle'): Promise<void> {
        if (!this.enabled) return;
        if (this.busy) {
            this.log('WARN', 'skip: previous run still in progress', { trigger });
            return;
        }

        this.busy = true;
        const startedAt = Date.now();
        this.nextRunAt = startedAt + PP_FARMER_POLL_INTERVAL_MS;

        let selection: PpFarmerSelection | null = null;
        const tasks: PpFarmerRunSummary['tasks'] = [];
        let createdCount = 0;
        let failedCount = 0;

        try {
            const accounts = await this.options.getAccounts();
            const predictAvailable = accounts?.predict?.available ?? 0;
            const polymarketAvailable = accounts?.polymarket?.available ?? 0;

            this.log('INFO', 'run start', {
                trigger,
                predictAvailable,
                polymarketAvailable,
                poolUsdc: Math.min(predictAvailable, polymarketAvailable) * this.budgetPoolRatio,
                yieldThreshold: this.yieldThreshold,
                budgetPoolRatio: this.budgetPoolRatio,
                source: this.options.source,
            });

            selection = selectPpFarmerCandidates({
                opportunities: this.options.getOpportunities(),
                sportsMarkets: this.options.getSportsMarkets(),
                predictAvailable,
                polymarketAvailable,
                hasActiveTask: this.options.hasActiveTask,
                yieldThreshold: this.yieldThreshold,
                source: this.options.source,
                budgetPoolRatio: this.budgetPoolRatio,
                archivedMarketIds: this.options.getArchivedMarketIds?.(),
                now: startedAt,
            });

            this.log('INFO', 'selection done', {
                trigger,
                considered: selection.considered,
                qualified: selection.qualified,
                finalCandidates: selection.candidates.length,
                poolUsdc: selection.poolUsdc,
                remainingUsdc: selection.remainingUsdc,
                skipped: selection.skipped,
            });

            for (let i = 0; i < selection.candidates.length; i += 1) {
                if (!this.enabled) {
                    this.log('WARN', 'run aborted: disabled mid-iteration', { trigger, index: i });
                    break;
                }
                if (i > 0) {
                    await sleep(TASK_CREATE_INTERVAL_MS);
                    if (!this.enabled) {
                        this.log('WARN', 'run aborted: disabled during throttle', { trigger, index: i });
                        break;
                    }
                }
                const candidate = selection.candidates[i];
                const taskEntry: PpFarmerRunSummary['tasks'][number] = {
                    id: candidate.id,
                    marketId: candidate.marketId,
                    title: candidate.title,
                    arbSide: candidate.arbSide,
                    quantity: candidate.quantity,
                    predictBidPrice: candidate.predictBidPrice,
                    polymarketHedgePrice: candidate.polymarketHedgePrice,
                };

                try {
                    const result = await this.options.createAndStartTask(candidate, i);
                    if (result.error) {
                        failedCount += 1;
                        taskEntry.error = result.error;
                        if (result.taskId) taskEntry.taskId = result.taskId;
                        this.log('ERROR', 'task creation failed', {
                            trigger,
                            candidateId: candidate.id,
                            marketId: candidate.marketId,
                            error: result.error,
                        });
                    } else {
                        createdCount += 1;
                        if (result.taskId) taskEntry.taskId = result.taskId;
                        this.log('INFO', 'task created', {
                            trigger,
                            candidateId: candidate.id,
                            marketId: candidate.marketId,
                            taskId: result.taskId,
                            quantity: candidate.quantity,
                            predictPrice: candidate.predictBidPrice,
                            polyPrice: candidate.polymarketHedgePrice,
                            estimatedProfit: candidate.estimatedProfit,
                        });
                    }
                } catch (err: any) {
                    failedCount += 1;
                    taskEntry.error = err?.message || String(err);
                    this.log('ERROR', 'task creation threw', {
                        trigger,
                        candidateId: candidate.id,
                        marketId: candidate.marketId,
                        error: taskEntry.error,
                    });
                }

                tasks.push(taskEntry);
            }
        } catch (err: any) {
            this.log('ERROR', 'run failed before candidate loop', {
                trigger,
                error: err?.message || String(err),
            });
        } finally {
            const finishedAt = Date.now();
            const summary: PpFarmerRunSummary = {
                startedAt,
                finishedAt,
                durationMs: finishedAt - startedAt,
                considered: selection?.considered ?? 0,
                qualified: selection?.qualified ?? 0,
                createdCount,
                failedCount,
                poolUsdc: selection?.poolUsdc ?? 0,
                remainingUsdc: selection?.remainingUsdc ?? 0,
                yieldThreshold: selection?.yieldThreshold ?? this.yieldThreshold,
                tasks,
                skipped: selection?.skipped ?? {},
            };
            this.lastSummary = summary;
            this.lastRunAt = finishedAt;
            this.busy = false;

            this.log('INFO', 'run finished', {
                trigger,
                durationMs: summary.durationMs,
                created: createdCount,
                failed: failedCount,
            });
        }
    }

    private log(level: 'INFO' | 'WARN' | 'ERROR', message: string, details?: Record<string, unknown>): void {
        const timestamp = new Date().toISOString();
        console.log(`[PpFarmer][${level}] ${message}${details ? ' ' + JSON.stringify(details) : ''}`);
        if (!this.options.logFilePath) return;
        try {
            appendFileSync(
                this.options.logFilePath,
                JSON.stringify({ timestamp, level, message, ...(details ? { details } : {}) }) + '\n',
                'utf8'
            );
        } catch (err: any) {
            console.warn(`[PpFarmer] log write failed: ${err?.message}`);
        }
    }
}
