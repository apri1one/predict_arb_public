import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import { Task, TaskStatus, TaskStrategy, CreateTaskInput, TaskFilter } from './types.js';
import { EventEmitter } from 'events';
import { getTaskLogger, TaskLogger, TaskConfigSnapshot } from './task-logger/index.js';
import { calculatePredictFee } from '../trading/depth-calculator.js';
import { getPolymarketSlug } from './url-mapper.js';

// predict-slugs.json 缓存类型
interface PredictSlugEntry {
    slug: string;
    verified: boolean;
}
type PredictSlugsCache = Record<string, PredictSlugEntry>;

// 加载 predict-slugs.json 缓存
let predictSlugsCache: PredictSlugsCache = {};
try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    // dashboard -> src -> bot -> data
    const slugsPath = path.resolve(__dirname, '../data/predict-slugs.json');
    if (fsSync.existsSync(slugsPath)) {
        predictSlugsCache = JSON.parse(fsSync.readFileSync(slugsPath, 'utf-8'));
        console.log(`[TaskService] Loaded ${Object.keys(predictSlugsCache).length} predict-slugs entries`);
    }
} catch (e: any) {
    console.warn(`[TaskService] Failed to load predict-slugs.json: ${e?.message || e}`);
}

/**
 * TaskService - 任务管理服务
 *
 * 功能:
 * - CRUD 操作
 * - JSON 文件持久化 (原子写入)
 * - 幂等 ID 生成
 * - 并发锁 (每个 market 只能有一个活跃任务)
 */
export class TaskService extends EventEmitter {
    private tasks: Map<string, Task> = new Map();
    // 锁 key 格式: "marketId:type" (如 "123:BUY", "123:SELL")
    // 同一市场的 BUY 和 SELL 任务可以共存
    private marketLocks: Map<string, string> = new Map();
    private persistPath: string;
    private writeQueue: Promise<void> = Promise.resolve();
    private loaded: boolean = false;
    private taskLogger: TaskLogger;

    constructor(persistPath?: string) {
        super();
        this.persistPath = persistPath || path.join(process.cwd(), 'data', 'tasks.json');
        this.taskLogger = getTaskLogger();
    }

    /**
     * 初始化: 从文件加载任务
     */
    async init(): Promise<void> {
        if (this.loaded) return;

        try {
            // 确保目录存在
            const dir = path.dirname(this.persistPath);
            await fs.mkdir(dir, { recursive: true });

            // 尝试加载
            const data = await fs.readFile(this.persistPath, 'utf-8');
            const entries: [string, Task][] = JSON.parse(data);

            // 兼容存量任务：为旧任务添加 strategy 默认值
            this.tasks = new Map(entries.map(([id, task]) => [
                id,
                { ...task, strategy: task.strategy ?? 'PREDICT_MAKER' } as Task
            ]));

            // 重建 market locks (key 格式: "marketId:type:arbSide")
            for (const [id, task] of this.tasks) {
                if (this.isActiveStatus(task.status)) {
                    this.marketLocks.set(this.getLockKey(task.marketId, task.type, task.arbSide, task.strategy), id);
                }
            }

            console.log(`[TaskService] Loaded ${this.tasks.size} tasks`);
        } catch (e: any) {
            if (e.code === 'ENOENT') {
                console.log('[TaskService] No existing tasks file, starting fresh');
            } else {
                console.error('[TaskService] Failed to load tasks:', e.message);
            }
        }

        this.loaded = true;
    }

    /**
     * 创建任务
     */
    createTask(input: CreateTaskInput): Task {
        const strategy = input.strategy ?? 'PREDICT_MAKER';

        // 调试日志：打印体育市场任务创建参数
        if (input.isSportsMarket) {
            console.log(`[TaskService] Sports task create: marketId=${input.marketId}, arbSide=${input.arbSide}, title=${input.title?.slice(0, 30)}`);
        }

        // 0a. SELL 任务必须提供 entryCost
        // 注意: TAKER + SELL 用于 NO 端套利（Predict SELL YES ≈ BUY NO），不是平仓，不需要 entryCost
        if (input.type === 'SELL' && strategy !== 'TAKER' && (input.entryCost === undefined || input.entryCost <= 0)) {
            throw new Error('SELL task requires valid entryCost (original position cost) for profit calculation');
        }

        // 0a-bis. PREDICT_MAKER + SELL 必须提供有效 polymarketMinBid（hedge 卖价护栏）
        // 防止前端"保本公式"算出 ≤0 的脏值入库，触发下游 Invalid price 死循环
        if (input.type === 'SELL' && strategy === 'PREDICT_MAKER'
            && (input.polymarketMinBid === undefined || input.polymarketMinBid <= 0)) {
            throw new Error(
                `PREDICT_MAKER SELL requires valid polymarketMinBid > 0 (got ${input.polymarketMinBid}). ` +
                `Must be Poly best bid - slippage, not breakeven formula.`
            );
        }

        // 0b. TAKER 模式必填字段验证
        if (strategy === 'TAKER') {
            if (input.type === 'BUY') {
                // TAKER + BUY: 开仓吃单，需要 ask 价格和最大成本
                if (input.predictAskPrice === undefined || input.predictAskPrice <= 0) {
                    throw new Error('TAKER BUY strategy requires valid predictAskPrice');
                }
                if (input.maxTotalCost === undefined || input.maxTotalCost <= 0) {
                    throw new Error('TAKER BUY strategy requires valid maxTotalCost');
                }
            } else if (input.type === 'SELL') {
                // TAKER + SELL: 平仓吃单 (T-T 模式)
                // 需要: predictPrice (bid), polymarketMinBid, entryCost
                if (input.predictPrice === undefined || input.predictPrice <= 0) {
                    throw new Error('TAKER SELL strategy requires valid predictPrice (bid price)');
                }
                if (input.polymarketMinBid === undefined || input.polymarketMinBid <= 0) {
                    throw new Error('TAKER SELL strategy requires valid polymarketMinBid');
                }
                if (input.entryCost === undefined || input.entryCost <= 0) {
                    throw new Error('TAKER SELL strategy requires valid entryCost for profit calculation');
                }
            }
        }

        // 0c. TAKER 模式计算 polymarketMaxAsk
        let polymarketMaxAsk = input.polymarketMaxAsk;
        const feeRateBps = input.feeRateBps ?? 200;  // 默认 2%
        if (strategy === 'TAKER' && input.predictAskPrice && input.maxTotalCost) {
            const fee = calculatePredictFee(input.predictAskPrice, feeRateBps);
            polymarketMaxAsk = input.maxTotalCost - input.predictAskPrice - fee;

            if (polymarketMaxAsk <= 0) {
                throw new Error(
                    `Invalid maxTotalCost: polymarketMaxAsk=${polymarketMaxAsk.toFixed(4)} <= 0. ` +
                    `predictAskPrice=${input.predictAskPrice.toFixed(4)}, fee=${fee.toFixed(4)}`
                );
            }
        }

        // 1. 生成幂等 ID
        const id = this.generateIdempotentId(input);

        // 2. 检查重复
        if (this.tasks.has(id)) {
            throw new Error(`Task ${id} already exists`);
        }

        // 3. 检查并发锁 (按 marketId:type:arbSide 锁定，同方向只允许一个任务，防止 negRisk 自成交)
        const lockKey = this.getLockKey(input.marketId, input.type, input.arbSide);
        const existingTaskId = this.marketLocks.get(lockKey);
        if (existingTaskId) {
            const existingTask = this.tasks.get(existingTaskId);
            if (existingTask && this.isActiveStatus(existingTask.status)) {
                throw new Error(`Market ${input.marketId} ${input.type}:${input.arbSide} already has active task (${existingTask.strategy}): ${existingTaskId}`);
            }
        }

        // 4. 创建任务
        const now = Date.now();
        // 如果没有提供 title，从 predict-slugs.json 查找
        const title = input.title
            || predictSlugsCache[String(input.marketId)]?.slug
            || `Market ${input.marketId}`;
        const task: Task = {
            id,
            type: input.type,
            marketId: input.marketId,
            title,
            predictSlug: input.predictSlug,
            // 优先使用前端传入的 slug，否则从 url-mapper 缓存获取
            polymarketSlug: input.polymarketSlug || getPolymarketSlug(input.polymarketConditionId),
            strategy,  // PREDICT_MAKER / TAKER / POLY_MAKER
            arbSide: input.arbSide,  // 套利方向: YES 或 NO
            polymarketConditionId: input.polymarketConditionId,
            polymarketNoTokenId: input.polymarketNoTokenId,
            polymarketYesTokenId: input.polymarketYesTokenId,
            isInverted: input.isInverted,
            tickSize: input.tickSize,
            negRisk: input.negRisk,
            // Maker 用 predictPrice; Taker BUY 用 predictAskPrice; Taker SELL 用 predictPrice (bid)
            predictPrice: (strategy === 'TAKER' && input.type === 'BUY')
                ? input.predictAskPrice!
                : input.predictPrice,
            polymarketMaxAsk,  // 使用计算后的值
            polymarketMinBid: input.polymarketMinBid,
            quantity: input.quantity,
            // POLY_MAKER 已改为“成本价 + 配置滑点容忍”，不再使用 minProfitBuffer
            minProfitBuffer: strategy === 'POLY_MAKER' ? 0 : input.minProfitBuffer,
            orderTimeout: input.orderTimeout,
            maxHedgeRetries: input.maxHedgeRetries,
            entryCost: input.entryCost,
            // Taker 专用字段
            predictAskPrice: input.predictAskPrice,
            maxTotalCost: input.maxTotalCost,
            feeRateBps: (strategy === 'TAKER' || strategy === 'POLY_MAKER') ? feeRateBps : undefined,
            // POLY_MAKER 专用字段
            polyBidPrice: input.polyBidPrice,
            status: 'PENDING',
            totalQuantity: input.quantity,
            predictFilledQty: 0,
            polyFilledQty: 0,
            hedgedQty: 0,
            remainingQty: input.quantity,
            pauseCount: 0,
            hedgeRetryCount: 0,
            unwindQty: 0,
            avgPredictPrice: 0,
            avgPolymarketPrice: 0,
            actualProfit: 0,
            unwindLoss: 0,
            createdAt: now,
            updatedAt: now,
            // 任务过期时间: 优先 input.expiresAt（绝对时间戳，体育平仓用开赛前 3min），其次 expiryHours
            expiresAt: input.expiresAt && input.expiresAt > now
                ? input.expiresAt
                : (input.expiryHours && input.expiryHours > 0
                    ? now + input.expiryHours * 60 * 60 * 1000
                    : undefined),
            // 体育市场标识 (使用 REST API 获取订单簿)
            isSportsMarket: input.isSportsMarket,
            batchCreate: input.batchCreate,
            // 余额守卫: 仅 PREDICT_MAKER BUY 任务记录 Poly 对冲所需 USDC
            // POLY_MAKER 的 Poly 余额在 GTC 挂单时已锁定，无需守护
            polyRequiredBalance: (input.type === 'BUY' && input.strategy !== 'POLY_MAKER') ? input.quantity * polymarketMaxAsk : 0,
        };

        // 5. 保存
        this.tasks.set(id, task);
        this.marketLocks.set(lockKey, id);
        this.persistAsync();

        // 6. 初始化日志目录并记录 TASK_CREATED
        this.taskLogger.initTaskLogDir(id).then(() => {
            return this.taskLogger.logTaskLifecycle(id, 'TASK_CREATED', {
                status: 'PENDING',
                taskConfig: this.buildTaskConfigSnapshot(task),
            });
        }).catch(err => {
            console.error(`[TaskService] Failed to log TASK_CREATED for ${id}:`, err);
        });

        // 7. 发送事件
        this.emit('task:created', task);

        return task;
    }

    /**
     * 获取单个任务
     */
    getTask(id: string): Task | null {
        return this.tasks.get(id) || null;
    }

    /**
     * 获取任务列表
     */
    getTasks(filter?: TaskFilter): Task[] {
        let tasks = Array.from(this.tasks.values());

        if (filter) {
            if (filter.status && filter.status.length > 0) {
                tasks = tasks.filter(t => filter.status!.includes(t.status));
            }
            if (filter.type) {
                tasks = tasks.filter(t => t.type === filter.type);
            }
            if (filter.marketId !== undefined) {
                tasks = tasks.filter(t => t.marketId === filter.marketId);
            }
            if (!filter.includeCompleted) {
                tasks = tasks.filter(t => !this.isTerminalStatus(t.status));
            }
        }

        // 按创建时间降序
        return tasks.sort((a, b) => b.createdAt - a.createdAt);
    }

    /**
     * 更新任务
     */
    updateTask(id: string, update: Partial<Task>): Task {
        const task = this.tasks.get(id);
        if (!task) {
            throw new Error(`Task ${id} not found`);
        }

        const updated: Task = {
            ...task,
            ...update,
            updatedAt: Date.now(),
        };

        this.tasks.set(id, updated);
        this.persistAsync();

        // 如果状态变为终态，释放锁
        if (this.isTerminalStatus(updated.status) && !this.isTerminalStatus(task.status)) {
            this.releaseLock(task.marketId, id, task.type, task.arbSide, task.strategy);
        }

        // 发送事件
        this.emit('task:updated', updated);

        return updated;
    }

    /**
     * 更新任务过期时间
     * @param expiresAt - 过期时间戳，undefined 表示清除定时
     */
    updateTaskExpiry(id: string, expiresAt: number | undefined): Task {
        const task = this.tasks.get(id);
        if (!task) {
            throw new Error(`Task ${id} not found`);
        }

        // 显式设置 expiresAt（包括 undefined 来清除）
        const updated: Task = {
            ...task,
            expiresAt,  // 直接赋值，undefined 会覆盖原值
            updatedAt: Date.now(),
        };

        this.tasks.set(id, updated);
        this.persistAsync();

        // 发送事件
        this.emit('task:updated', updated);

        return updated;
    }

    /**
     * 取消任务
     */
    cancelTask(id: string): Task {
        const task = this.tasks.get(id);
        if (!task) {
            throw new Error(`Task ${id} not found`);
        }

        if (this.isTerminalStatus(task.status)) {
            throw new Error(`Task ${id} is already in terminal status: ${task.status}`);
        }

        return this.updateTask(id, { status: 'CANCELLED' });
    }

    /**
     * 删除任务 (仅限终态任务)
     */
    deleteTask(id: string): boolean {
        const task = this.tasks.get(id);
        if (!task) {
            return false;
        }

        if (!this.isTerminalStatus(task.status)) {
            throw new Error(`Cannot delete active task ${id}, cancel it first`);
        }

        this.tasks.delete(id);
        this.persistAsync();

        this.emit('task:deleted', id);
        return true;
    }

    /**
     * 获取活跃任务数量
     */
    getActiveTaskCount(): number {
        return Array.from(this.tasks.values())
            .filter(t => this.isActiveStatus(t.status))
            .length;
    }

    /**
     * 获取运行中可恢复的任务（用于暂停/恢复流程，不涉及重启恢复）
     */
    getRecoverableTasks(): Task[] {
        return Array.from(this.tasks.values())
            .filter(t => this.isRecoverableStatus(t.status));
    }

    /**
     * 检查 market 是否有活跃任务 (指定类型和方向，不区分策略)
     * 同一 marketId + arbSide 只允许一个任务，防止 negRisk 自成交
     */
    hasActiveTask(marketId: number, type?: 'BUY' | 'SELL', arbSide?: 'YES' | 'NO', _strategy?: 'PREDICT_MAKER' | 'TAKER' | 'POLY_MAKER'): boolean {
        // 快速路径: (marketId, type, arbSide) 完整时直查 marketLocks，O(1)
        // marketLocks 在 createTask 注册、终态 updateTask 释放，与活跃任务一一对应
        if (type && arbSide) {
            return this.marketLocks.has(this.getLockKey(marketId, type, arbSide));
        }
        // 退化路径: 参数不完整时只扫活跃锁 (~27 条)，而非全量任务 (万级)
        for (const lockKey of this.marketLocks.keys()) {
            // lockKey 格式: "marketId:type:arbSide" 或 "marketId:type"
            const firstColon = lockKey.indexOf(':');
            if (firstColon < 0) continue;
            const lockedMarketId = Number(lockKey.slice(0, firstColon));
            if (lockedMarketId !== marketId) continue;
            const rest = lockKey.slice(firstColon + 1);
            const secondColon = rest.indexOf(':');
            const lockedType = secondColon < 0 ? rest : rest.slice(0, secondColon);
            const lockedArbSide = secondColon < 0 ? undefined : rest.slice(secondColon + 1);
            if (type && lockedType !== type) continue;
            if (arbSide && lockedArbSide !== arbSide) continue;
            return true;
        }
        return false;
    }

    /**
     * 获取 market 的活跃任务 (指定类型和方向)
     */
    getActiveTaskForMarket(marketId: number, type?: 'BUY' | 'SELL', arbSide?: 'YES' | 'NO'): Task | null {
        for (const task of this.tasks.values()) {
            if (task.marketId !== marketId || !this.isActiveStatus(task.status)) continue;
            if (type && task.type !== type) continue;
            if (arbSide && task.arbSide !== arbSide) continue;
            return task;
        }
        if (type) {
            // 优先返回 YES，否则返回 NO
            return this.getActiveTaskForMarket(marketId, type, 'YES') || this.getActiveTaskForMarket(marketId, type, 'NO');
        }
        // 未指定类型时优先返回 BUY，否则返回 SELL
        return this.getActiveTaskForMarket(marketId, 'BUY') || this.getActiveTaskForMarket(marketId, 'SELL');
    }

    // ============================================================
    // 私有方法
    // ============================================================

    /**
     * 幂等 ID 生成
     */
    private generateIdempotentId(input: CreateTaskInput): string {
        // 如果前端传入了 idempotencyKey，直接使用
        if (input.idempotencyKey) {
            return input.idempotencyKey;
        }

        // 否则基于参数 + 10秒时间窗口生成
        const timeWindow = Math.floor(Date.now() / 10000);
        const hash = crypto.createHash('sha256');
        hash.update(`${input.marketId}-${input.type}-${input.arbSide || ''}-${input.predictPrice}-${input.quantity}-${timeWindow}`);
        return hash.digest('hex').substring(0, 16);
    }

    /**
     * 生成锁 key
     * 格式: "marketId:type:arbSide" (如 "3438:BUY:YES", "3438:BUY:NO")
     * 同一市场同方向只允许一个任务（无论策略），防止 negRisk 自成交
     */
    private getLockKey(marketId: number, type: 'BUY' | 'SELL', arbSide?: 'YES' | 'NO', _strategy?: TaskStrategy): string {
        return arbSide ? `${marketId}:${type}:${arbSide}` : `${marketId}:${type}`;
    }

    /**
     * 释放 market 锁
     */
    private releaseLock(marketId: number, taskId: string, type: 'BUY' | 'SELL', arbSide?: 'YES' | 'NO', strategy?: TaskStrategy): void {
        const lockKey = this.getLockKey(marketId, type, arbSide, strategy);
        const lockedBy = this.marketLocks.get(lockKey);
        if (lockedBy === taskId) {
            this.marketLocks.delete(lockKey);
        }
    }

    /**
     * 判断是否是活跃状态
     */
    private isActiveStatus(status: TaskStatus): boolean {
        return ![
            'COMPLETED',
            'FAILED',
            'CANCELLED',
            'TIMEOUT_CANCELLED',
            'HEDGE_FAILED',
            'UNWIND_COMPLETED',
        ].includes(status);
    }

    /**
     * 判断是否是终态
     */
    private isTerminalStatus(status: TaskStatus): boolean {
        return [
            'COMPLETED',
            'FAILED',
            'CANCELLED',
            'TIMEOUT_CANCELLED',
            'HEDGE_FAILED',
            'UNWIND_COMPLETED',
        ].includes(status);
    }

    /**
     * 判断是否可恢复
     */
    private isRecoverableStatus(status: TaskStatus): boolean {
        return [
            'PREDICT_SUBMITTED',
            'PARTIALLY_FILLED',
            'HEDGING',
            'HEDGE_PENDING',
            'PAUSED',
        ].includes(status);
    }

    /**
     * 异步持久化 (原子写入)
     */
    private persistAsync(): void {
        this.writeQueue = this.writeQueue.then(async () => {
            try {
                const tempPath = this.persistPath + '.tmp';
                const data = JSON.stringify(Array.from(this.tasks.entries()), null, 2);

                await fs.writeFile(tempPath, data, 'utf-8');
                await fs.rename(tempPath, this.persistPath);
            } catch (e) {
                console.error('[TaskService] Failed to persist:', e);
            }
        });
    }

    /**
     * 构建任务配置快照
     */
    private buildTaskConfigSnapshot(task: Task): TaskConfigSnapshot {
        return {
            type: task.type,
            marketId: task.marketId,
            title: task.title,
            predictPrice: task.predictPrice,
            polymarketMaxAsk: task.polymarketMaxAsk,
            polymarketMinBid: task.polymarketMinBid,
            quantity: task.quantity,
            polymarketConditionId: task.polymarketConditionId,
            polymarketNoTokenId: task.polymarketNoTokenId,
            polymarketYesTokenId: task.polymarketYesTokenId,
            isInverted: task.isInverted,
            feeRateBps: task.feeRateBps ?? 0,  // Taker 有费用，Maker 无费用
            tickSize: task.tickSize,
            negRisk: task.negRisk,
            arbSide: task.arbSide,             // 套利方向
            strategy: task.strategy,           // 策略类型
            predictAskPrice: task.predictAskPrice,  // Taker 专用
            maxTotalCost: task.maxTotalCost,        // Taker 专用
            polyBidPrice: task.polyBidPrice,        // POLY_MAKER 专用
        };
    }
}

// 单例
let instance: TaskService | null = null;

export function getTaskService(): TaskService {
    if (!instance) {
        instance = new TaskService();
    }
    return instance;
}

/**
 * 初始化 TaskService (支持自定义路径，用于多账号隔离)
 */
export function initTaskService(persistPath?: string): TaskService {
    if (instance) {
        console.warn('[TaskService] Already initialized, returning existing instance');
        return instance;
    }
    instance = new TaskService(persistPath);
    return instance;
}
