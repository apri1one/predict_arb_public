import { promises as fsPromises } from 'fs';
import { join, resolve } from 'path';
import type {
    BatchCreateMeta,
    AutoCreateLogEntry,
    AutoCreateLogLevel,
    AutoCreateTasksResult,
    AutoTaskPreviewItem,
    AutoTaskPreviewScope,
    CreateTaskInput,
    ArbSide,
} from './types.js';

const DEFAULT_MAX_BUFFERED_LOGS = 200;
const DEFAULT_MIN_TASK_INTERVAL_MS = 0;
const MAX_PUBLIC_STATUS_LOGS = 80;

function toExpiryHours(expiresAt: number | undefined, now: number): number | undefined {
    if (!expiresAt || expiresAt <= now) return undefined;
    const hours = (expiresAt - now) / (60 * 60 * 1000);
    return hours > 0 ? Number(hours.toFixed(4)) : undefined;
}

function sanitizeJobId(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function toSerializableDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!details) return undefined;
    try {
        return JSON.parse(JSON.stringify(details)) as Record<string, unknown>;
    } catch {
        return { note: 'details_serialization_failed' };
    }
}

function formatLogLine(entry: AutoCreateLogEntry): string {
    const prefix = `[${new Date(entry.timestamp).toISOString()}] [${entry.level}] ${entry.message}`;
    if (!entry.details) return `${prefix}\n`;
    return `${prefix} ${JSON.stringify(entry.details)}\n`;
}

export function buildAutoCreateTaskInput(
    candidate: AutoTaskPreviewItem,
    index: number,
    now: number,
    batchCreate?: BatchCreateMeta
): CreateTaskInput {
    const quantity = Math.max(0, Math.floor(candidate.quantity));
    const expiryHours = toExpiryHours(candidate.expiresAt, now);

    if (candidate.strategy === 'POLY_MAKER') {
        const polyBidPrice = Number((candidate.polyBidPrice || candidate.predictBidPrice).toFixed(4));
        return {
            type: 'BUY',
            marketId: candidate.marketId,
            title: candidate.title,
            predictSlug: candidate.predictSlug,
            polymarketSlug: candidate.polymarketSlug,
            polymarketConditionId: candidate.polymarketConditionId,
            polymarketNoTokenId: candidate.polymarketNoTokenId,
            polymarketYesTokenId: candidate.polymarketYesTokenId,
            isInverted: candidate.isInverted,
            tickSize: candidate.tickSize,
            negRisk: candidate.negRisk,
            predictPrice: Number(candidate.predictBidPrice.toFixed(4)),
            polyBidPrice,
            polymarketMaxAsk: Number((1 - polyBidPrice).toFixed(4)),
            polymarketMinBid: 0,
            quantity,
            minProfitBuffer: 0.005,
            orderTimeout: 60000,
            maxHedgeRetries: 3,
            idempotencyKey: `AUTO-POLY-${candidate.marketId}-${candidate.arbSide}-${now}-${index}`,
            strategy: 'POLY_MAKER',
            arbSide: candidate.arbSide,
            isSportsMarket: candidate.isSportsMarket,
            feeRateBps: candidate.feeRateBps,
            ...(batchCreate ? { batchCreate } : {}),
            ...(expiryHours ? { expiryHours } : {}),
        };
    }

    const predictPrice = Number(candidate.predictBidPrice.toFixed(4));
    return {
        type: 'BUY',
        marketId: candidate.marketId,
        title: candidate.title,
        predictSlug: candidate.predictSlug,
        polymarketSlug: candidate.polymarketSlug,
        polymarketConditionId: candidate.polymarketConditionId,
        polymarketNoTokenId: candidate.polymarketNoTokenId,
        polymarketYesTokenId: candidate.polymarketYesTokenId,
        isInverted: candidate.isInverted,
        tickSize: candidate.tickSize,
        negRisk: candidate.negRisk,
        predictPrice,
        polymarketMaxAsk: Number((1 - predictPrice).toFixed(4)),
        polymarketMinBid: 0,
        quantity,
        minProfitBuffer: 0.005,
        orderTimeout: 60000,
        maxHedgeRetries: 3,
        idempotencyKey: `AUTO-BUY-${candidate.marketId}-${candidate.arbSide}-${now}-${index}`,
        strategy: 'PREDICT_MAKER',
        arbSide: candidate.arbSide,
        isSportsMarket: candidate.isSportsMarket,
        ...(batchCreate ? { batchCreate } : {}),
        ...(expiryHours ? { expiryHours } : {}),
    };
}

export function filterAutoCreateCandidates(
    candidates: AutoTaskPreviewItem[],
    requestedIds?: string[]
): AutoTaskPreviewItem[] {
    if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
        return candidates;
    }

    const candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const filtered: AutoTaskPreviewItem[] = [];
    for (const id of requestedIds) {
        const candidate = candidateMap.get(id);
        if (candidate) {
            filtered.push(candidate);
        }
    }
    return filtered;
}

export function createEmptyAutoCreateResult(source: AutoTaskPreviewScope, requested: number): AutoCreateTasksResult {
    return {
        state: 'IDLE',
        source,
        autoStart: true,
        requested,
        attempted: 0,
        created: 0,
        started: 0,
        failed: 0,
        updatedAt: Date.now(),
        logs: [],
        tasks: [],
    };
}

interface AutoCreateTaskHandlerResult {
    created: boolean;
    taskId?: string;
    started: boolean;
    error?: string;
    createTaskInput?: CreateTaskInput;
    ready?: boolean;
    readyReason?: string;
    readyWaitMs?: number;
}

export interface AutoCreateTaskContext {
    index: number;
    total: number;
    autoStart: boolean;
    source: AutoTaskPreviewScope;
    jobId?: string;
}

interface AutoCreateTaskRunnerOptions {
    createTask: (candidate: AutoTaskPreviewItem, context: AutoCreateTaskContext) => Promise<AutoCreateTaskHandlerResult>;
    debugDir?: string;
    maxBufferedLogs?: number;
    minTaskIntervalMs?: number;
}

interface StartAutoCreateJobOptions {
    source: AutoTaskPreviewScope;
    candidates: AutoTaskPreviewItem[];
    autoStart: boolean;
}

function summarizeCreateTaskInput(input: CreateTaskInput): Record<string, unknown> {
    return {
        strategy: input.strategy,
        marketId: input.marketId,
        arbSide: input.arbSide,
        quantity: input.quantity,
        predictPrice: input.predictPrice,
        polyBidPrice: input.polyBidPrice,
        polymarketMaxAsk: input.polymarketMaxAsk,
        idempotencyKey: input.idempotencyKey,
        title: input.title,
    };
}

function compactStatusLogDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!details) return undefined;

    const compacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
        if (key === 'createTaskInput' && value && typeof value === 'object') {
            compacted.createTaskInput = summarizeCreateTaskInput(value as CreateTaskInput);
        } else {
            compacted[key] = value;
        }
    }
    return compacted;
}

function cloneStatus(status: AutoCreateTasksResult): AutoCreateTasksResult {
    const clone = JSON.parse(JSON.stringify(status)) as AutoCreateTasksResult;
    clone.logs = clone.logs.slice(-MAX_PUBLIC_STATUS_LOGS).map((entry) => ({
        ...entry,
        details: compactStatusLogDetails(entry.details),
    }));
    return clone;
}

function buildCurrentCandidate(candidate: AutoTaskPreviewItem, index: number, total: number): {
    id: string;
    title: string;
    arbSide: ArbSide;
    quantity: number;
    index: number;
    total: number;
    marketId: number;
    source: AutoTaskPreviewItem['source'];
    predictBidPrice: number;
    polymarketHedgePrice: number;
    budgetRatio: number;
    predictOrderValue: number;
    polymarketHedgeValue: number;
    expiresAt?: number;
} {
    return {
        id: candidate.id,
        title: candidate.title,
        arbSide: candidate.arbSide,
        quantity: Math.floor(candidate.quantity),
        index: index + 1,
        total,
        marketId: candidate.marketId,
        source: candidate.source,
        predictBidPrice: candidate.predictBidPrice,
        polymarketHedgePrice: candidate.polymarketHedgePrice,
        budgetRatio: candidate.budgetRatio,
        predictOrderValue: candidate.predictOrderValue,
        polymarketHedgeValue: candidate.polymarketHedgeValue,
        ...(candidate.expiresAt ? { expiresAt: candidate.expiresAt } : {}),
    };
}

export class AutoTaskCreateRunner {
    private readonly createTask: AutoCreateTaskRunnerOptions['createTask'];
    private readonly debugDir?: string;
    private readonly maxBufferedLogs: number;
    private readonly minTaskIntervalMs: number;
    private status: AutoCreateTasksResult = createEmptyAutoCreateResult('mixed', 0);
    private candidates: AutoTaskPreviewItem[] = [];
    private autoStart = true;
    private pauseRequested = false;
    private stopRequested = false;
    private resumeResolver: (() => void) | null = null;
    private runPromise: Promise<void> | null = null;
    private logWriteQueue: Promise<void> = Promise.resolve();
    private logDirEnsured = false;

    constructor(options: AutoCreateTaskRunnerOptions) {
        this.createTask = options.createTask;
        this.debugDir = options.debugDir ? resolve(options.debugDir) : undefined;
        this.maxBufferedLogs = options.maxBufferedLogs ?? DEFAULT_MAX_BUFFERED_LOGS;
        this.minTaskIntervalMs = Math.max(0, options.minTaskIntervalMs ?? DEFAULT_MIN_TASK_INTERVAL_MS);
    }

    getStatus(): AutoCreateTasksResult {
        return cloneStatus(this.status);
    }

    isBusy(): boolean {
        return ['RUNNING', 'PAUSED', 'STOPPING'].includes(this.status.state);
    }

    start(options: StartAutoCreateJobOptions): AutoCreateTasksResult {
        if (this.isBusy()) {
            throw new Error(`Auto-create job already active: ${this.status.state}`);
        }

        this.candidates = options.candidates;
        this.autoStart = options.autoStart;
        this.pauseRequested = false;
        this.stopRequested = false;
        this.resumeResolver = null;

        const now = Date.now();
        const jobId = sanitizeJobId(`auto-create-${now}`);
        this.status = {
            state: options.candidates.length > 0 ? 'RUNNING' : 'COMPLETED',
            jobId,
            source: options.source,
            autoStart: options.autoStart,
            requested: options.candidates.length,
            attempted: 0,
            created: 0,
            started: 0,
            failed: 0,
            logFilePath: this.buildLogFilePath(jobId, options.source),
            startedAt: now,
            updatedAt: now,
            finishedAt: options.candidates.length > 0 ? undefined : now,
            logs: [],
            tasks: [],
        };

        this.appendLog('INFO', 'batch create job started', {
            source: options.source,
            requested: options.candidates.length,
            autoStart: options.autoStart,
            minTaskIntervalMs: this.minTaskIntervalMs,
        });

        if (options.candidates.length > 0) {
            this.runPromise = this.runLoop();
        } else {
            this.appendLog('INFO', 'no candidates to create', {
                source: options.source,
            });
        }

        return this.getStatus();
    }

    requestPause(): AutoCreateTasksResult {
        if (this.status.state !== 'RUNNING') {
            throw new Error(`Auto-create job cannot pause from state: ${this.status.state}`);
        }
        this.pauseRequested = true;
        this.status.pendingAction = 'pause';
        this.status.updatedAt = Date.now();
        this.appendLog('INFO', 'pause requested', {
            attempted: this.status.attempted,
            requested: this.status.requested,
        });
        return this.getStatus();
    }

    resume(): AutoCreateTasksResult {
        if (this.status.state !== 'PAUSED') {
            throw new Error(`Auto-create job cannot resume from state: ${this.status.state}`);
        }

        this.pauseRequested = false;
        this.status.state = 'RUNNING';
        this.status.pendingAction = undefined;
        this.status.updatedAt = Date.now();
        this.appendLog('INFO', 'resume requested', {
            attempted: this.status.attempted,
            requested: this.status.requested,
        });
        if (this.resumeResolver) {
            const resolve = this.resumeResolver;
            this.resumeResolver = null;
            resolve();
        }
        return this.getStatus();
    }

    stop(): AutoCreateTasksResult {
        if (this.status.state === 'RUNNING') {
            this.stopRequested = true;
            this.pauseRequested = false;
            this.status.state = 'STOPPING';
            this.status.pendingAction = 'stop';
            this.status.updatedAt = Date.now();
            this.appendLog('WARN', 'stop requested', {
                attempted: this.status.attempted,
                requested: this.status.requested,
            });
            return this.getStatus();
        }

        if (this.status.state === 'PAUSED') {
            this.stopRequested = true;
            this.appendLog('WARN', 'stop requested while paused', {
                attempted: this.status.attempted,
                requested: this.status.requested,
            });
            this.finish('STOPPED');
            if (this.resumeResolver) {
                const resolve = this.resumeResolver;
                this.resumeResolver = null;
                resolve();
            }
            return this.getStatus();
        }

        throw new Error(`Auto-create job cannot stop from state: ${this.status.state}`);
    }

    private async runLoop(): Promise<void> {
        try {
            for (let index = this.status.attempted; index < this.candidates.length; index += 1) {
                const candidateStartedAt = Date.now();
                const candidate = this.candidates[index];
                this.status.current = buildCurrentCandidate(candidate, index, this.candidates.length);
                this.status.updatedAt = Date.now();

                let created = false;
                let started = false;
                let taskId: string | undefined;
                let errorMessage: string | undefined;

                this.appendLog('INFO', `processing candidate ${index + 1}/${this.candidates.length}`, {
                    candidateId: candidate.id,
                    marketId: candidate.marketId,
                    title: candidate.title,
                    source: candidate.source,
                    arbSide: candidate.arbSide,
                    quantity: Math.floor(candidate.quantity),
                    maxQuantity: Math.floor(candidate.maxQuantity),
                    predictBidPrice: Number(candidate.predictBidPrice.toFixed(4)),
                    polymarketHedgePrice: Number(candidate.polymarketHedgePrice.toFixed(4)),
                    budgetRatio: Number(candidate.budgetRatio.toFixed(4)),
                    predictOrderValue: Number(candidate.predictOrderValue.toFixed(2)),
                    polymarketHedgeValue: Number(candidate.polymarketHedgeValue.toFixed(2)),
                    expiresAt: candidate.expiresAt,
                });

                try {
                    const result = await this.createTask(candidate, {
                        index,
                        total: this.candidates.length,
                        autoStart: this.autoStart,
                        source: this.status.source,
                        jobId: this.status.jobId,
                    });
                    created = result.created;
                    started = result.started;
                    taskId = result.taskId;
                    if (result.created) {
                        this.status.created += 1;
                    }
                    if (result.started) {
                        this.status.started += 1;
                    }
                    if (result.error) {
                        this.status.failed += 1;
                        errorMessage = result.error;
                    }

                    const startMilestoneTimedOut = result.started && result.ready === false;
                    this.appendLog(
                        result.error
                            ? (result.created ? 'WARN' : 'ERROR')
                            : (startMilestoneTimedOut ? 'WARN' : 'INFO'),
                        result.error
                            ? (result.created ? 'task created but start failed' : 'task create failed')
                            : startMilestoneTimedOut
                                ? 'task created and started, but readiness wait timed out'
                                : (result.started ? 'task created and started' : 'task created'),
                        {
                            candidateId: candidate.id,
                            taskId,
                            created: result.created,
                            started: result.started,
                            error: result.error,
                            ready: result.ready,
                            readyReason: result.readyReason,
                            readyWaitMs: result.readyWaitMs,
                            createTaskInput: toSerializableDetails(
                                result.createTaskInput as unknown as Record<string, unknown> | undefined
                            ),
                        }
                    );
                } catch (error: any) {
                    this.status.failed += 1;
                    errorMessage = error.message;
                    this.appendLog('ERROR', 'unexpected batch create handler failure', {
                        candidateId: candidate.id,
                        error: error.message,
                    });
                } finally {
                    this.status.attempted += 1;
                    this.status.tasks.push({
                        id: candidate.id,
                        taskId,
                        title: candidate.title,
                        arbSide: candidate.arbSide,
                        quantity: Math.floor(candidate.quantity),
                        created,
                        started,
                        error: errorMessage,
                    });
                    this.status.current = undefined;
                    this.status.updatedAt = Date.now();
                }

                if (this.stopRequested) {
                    this.finish('STOPPED');
                    return;
                }

                if (this.pauseRequested) {
                    this.status.state = 'PAUSED';
                    this.status.pendingAction = undefined;
                    this.status.updatedAt = Date.now();
                    this.appendLog('INFO', 'batch create paused', {
                        attempted: this.status.attempted,
                        requested: this.status.requested,
                    });
                    await new Promise<void>((resolve) => {
                        this.resumeResolver = resolve;
                    });

                    if (this.stopRequested) {
                        this.finish('STOPPED');
                        return;
                    }
                }

                if (index < this.candidates.length - 1 && this.minTaskIntervalMs > 0) {
                    const elapsedMs = Date.now() - candidateStartedAt;
                    const waitMs = this.minTaskIntervalMs - elapsedMs;
                    if (waitMs > 0) {
                        this.appendLog('INFO', 'waiting before next candidate', {
                            waitMs,
                            nextIndex: index + 2,
                            total: this.candidates.length,
                        });
                        await this.waitForNextCandidate(waitMs);
                    }
                }

                if (this.stopRequested) {
                    this.finish('STOPPED');
                    return;
                }

                if (this.pauseRequested) {
                    this.status.state = 'PAUSED';
                    this.status.pendingAction = undefined;
                    this.status.updatedAt = Date.now();
                    this.appendLog('INFO', 'batch create paused', {
                        attempted: this.status.attempted,
                        requested: this.status.requested,
                    });
                    await new Promise<void>((resolve) => {
                        this.resumeResolver = resolve;
                    });

                    if (this.stopRequested) {
                        this.finish('STOPPED');
                        return;
                    }
                }

            }

            this.finish('COMPLETED');
        } catch (error: any) {
            this.status.error = error.message;
            this.appendLog('ERROR', 'batch create loop failed', {
                error: error.message,
            });
            this.finish('FAILED');
        } finally {
            this.runPromise = null;
        }
    }

    private finish(state: AutoCreateTasksResult['state']): void {
        this.pauseRequested = false;
        this.stopRequested = false;
        this.appendLog(state === 'COMPLETED' ? 'INFO' : state === 'FAILED' ? 'ERROR' : 'WARN', 'batch create finished', {
            state,
            attempted: this.status.attempted,
            requested: this.status.requested,
            created: this.status.created,
            started: this.status.started,
            failed: this.status.failed,
        });
        this.status.state = state;
        this.status.pendingAction = undefined;
        this.status.current = undefined;
        this.status.finishedAt = Date.now();
        this.status.updatedAt = this.status.finishedAt;
    }

    private buildLogFilePath(jobId: string, source: AutoTaskPreviewScope): string | undefined {
        if (!this.debugDir) return undefined;
        return join(this.debugDir, `${jobId}-${source}.log`);
    }

    private async waitForNextCandidate(waitMs: number): Promise<void> {
        const deadline = Date.now() + waitMs;
        while (Date.now() < deadline) {
            if (this.stopRequested || this.pauseRequested) {
                return;
            }
            const remainingMs = deadline - Date.now();
            await this.sleep(Math.min(remainingMs, 100));
        }
    }

    private async sleep(ms: number): Promise<void> {
        if (ms <= 0) return;
        await new Promise<void>((resolve) => setTimeout(resolve, ms));
    }

    private appendLog(level: AutoCreateLogLevel, message: string, details?: Record<string, unknown>): void {
        const timestamp = Date.now();
        const entry: AutoCreateLogEntry = {
            id: `${timestamp}-${this.status.logs.length + 1}`,
            timestamp,
            level,
            message,
            ...(details ? { details: toSerializableDetails(details) } : {}),
        };

        this.status.logs.push(entry);
        if (this.status.logs.length > this.maxBufferedLogs) {
            this.status.logs.splice(0, this.status.logs.length - this.maxBufferedLogs);
        }

        if (!this.status.logFilePath || !this.debugDir) return;

        const logPath = this.status.logFilePath;
        const debugDir = this.debugDir;
        const line = formatLogLine(entry);

        this.logWriteQueue = this.logWriteQueue.then(async () => {
            try {
                if (!this.logDirEnsured) {
                    await fsPromises.mkdir(debugDir, { recursive: true });
                    this.logDirEnsured = true;
                }
                await fsPromises.appendFile(logPath, line, 'utf8');
            } catch {
                // Ignore write failure; in-memory logs still retained in status.logs.
            }
        });
    }
}
