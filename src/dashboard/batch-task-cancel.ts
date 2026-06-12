import type {
    BatchCancelJobState,
    BatchCancelTasksResult,
    Task,
    TaskStatus,
} from './types.js';

const DEFAULT_MIN_TASK_INTERVAL_MS = 1000;
const TERMINAL_STATUSES = new Set<TaskStatus>([
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'UNWIND_COMPLETED',
]);

interface BatchCancelTaskHandlerResult {
    cancelled: boolean;
    skipped?: boolean;
    status?: TaskStatus;
    error?: string;
}

interface BatchTaskCancelRunnerOptions {
    cancelTask: (taskId: string) => Promise<BatchCancelTaskHandlerResult>;
    minTaskIntervalMs?: number;
}

interface StartBatchCancelJobOptions {
    tasks: Task[];
}

function sanitizeJobId(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function cloneStatus(status: BatchCancelTasksResult): BatchCancelTasksResult {
    return JSON.parse(JSON.stringify(status)) as BatchCancelTasksResult;
}

function createEmptyBatchCancelResult(minTaskIntervalMs: number): BatchCancelTasksResult {
    return {
        state: 'IDLE',
        requested: 0,
        attempted: 0,
        cancelled: 0,
        skipped: 0,
        failed: 0,
        minTaskIntervalMs,
        updatedAt: Date.now(),
        items: [],
    };
}

function buildCurrentTask(task: Task, index: number, total: number): NonNullable<BatchCancelTasksResult['current']> {
    return {
        taskId: task.id,
        title: task.title,
        status: task.status,
        index: index + 1,
        total,
        marketId: task.marketId,
    };
}

export class BatchTaskCancelRunner {
    private readonly cancelTask: BatchTaskCancelRunnerOptions['cancelTask'];
    private readonly minTaskIntervalMs: number;
    private status: BatchCancelTasksResult;
    private tasks: Task[] = [];
    private stopRequested = false;
    private runPromise: Promise<void> | null = null;

    constructor(options: BatchTaskCancelRunnerOptions) {
        this.cancelTask = options.cancelTask;
        this.minTaskIntervalMs = Math.max(0, options.minTaskIntervalMs ?? DEFAULT_MIN_TASK_INTERVAL_MS);
        this.status = createEmptyBatchCancelResult(this.minTaskIntervalMs);
    }

    getStatus(): BatchCancelTasksResult {
        return cloneStatus(this.status);
    }

    isBusy(): boolean {
        return this.status.state === 'RUNNING' || this.status.state === 'STOPPING';
    }

    start(options: StartBatchCancelJobOptions): BatchCancelTasksResult {
        if (this.isBusy()) {
            throw new Error(`Batch cancel already active: ${this.status.state}`);
        }

        const now = Date.now();
        this.tasks = options.tasks;
        this.stopRequested = false;
        this.status = {
            state: options.tasks.length > 0 ? 'RUNNING' : 'COMPLETED',
            jobId: sanitizeJobId(`batch-cancel-${now}`),
            requested: options.tasks.length,
            attempted: 0,
            cancelled: 0,
            skipped: 0,
            failed: 0,
            minTaskIntervalMs: this.minTaskIntervalMs,
            startedAt: now,
            updatedAt: now,
            finishedAt: options.tasks.length > 0 ? undefined : now,
            items: [],
        };

        if (options.tasks.length > 0) {
            this.runPromise = this.runLoop();
        }

        return this.getStatus();
    }

    stop(): BatchCancelTasksResult {
        if (this.status.state === 'RUNNING') {
            this.stopRequested = true;
            this.status.state = 'STOPPING';
            this.status.pendingStop = true;
            this.status.updatedAt = Date.now();
        }
        return this.getStatus();
    }

    private async runLoop(): Promise<void> {
        try {
            for (let index = 0; index < this.tasks.length; index += 1) {
                const task = this.tasks[index];
                const startedAt = Date.now();

                this.status.current = buildCurrentTask(task, index, this.tasks.length);
                this.status.updatedAt = startedAt;

                let item: BatchCancelTasksResult['items'][number];
                try {
                    const result = await this.cancelTask(task.id);
                    item = {
                        taskId: task.id,
                        title: task.title,
                        status: result.status,
                        cancelled: result.cancelled,
                        skipped: result.skipped === true,
                        ...(result.error ? { error: result.error } : {}),
                    };
                    if (result.cancelled) {
                        this.status.cancelled += 1;
                    } else if (result.skipped) {
                        this.status.skipped += 1;
                    } else {
                        this.status.failed += 1;
                    }
                } catch (error: any) {
                    item = {
                        taskId: task.id,
                        title: task.title,
                        cancelled: false,
                        skipped: false,
                        error: error?.message || String(error),
                    };
                    this.status.failed += 1;
                }

                this.status.items.push(item);
                this.status.attempted += 1;
                this.status.updatedAt = Date.now();

                if (this.stopRequested) {
                    this.finish('STOPPED');
                    return;
                }

                if (index < this.tasks.length - 1) {
                    await this.waitRemaining(startedAt);
                }
            }

            this.finish('COMPLETED');
        } catch (error: any) {
            this.status.error = error?.message || String(error);
            this.finish('FAILED');
        } finally {
            this.runPromise = null;
        }
    }

    private finish(state: BatchCancelJobState): void {
        this.status.state = state;
        this.status.pendingStop = undefined;
        this.status.current = undefined;
        this.status.updatedAt = Date.now();
        this.status.finishedAt = Date.now();
    }

    private async waitRemaining(startedAt: number): Promise<void> {
        const elapsed = Date.now() - startedAt;
        const remaining = this.minTaskIntervalMs - elapsed;
        if (remaining <= 0) return;
        await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    }
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
    return TERMINAL_STATUSES.has(status);
}
