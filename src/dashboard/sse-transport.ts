/**
 * SSE 传输层 — 底层写入、背压处理、广播
 *
 * 从 start-dashboard.ts 提取，所有 SSE 写入逻辑集中在此模块。
 * sseClients Map 由 start-dashboard.ts 拥有，通过 initSSETransport() 注入引用。
 */

import type { ServerResponse } from 'http';
import type { SSEClientMeta } from './dashboard-types.js';
import type { Task, TaskStatus } from './types.js';
import type { OrderFilledEvent as BscOrderFilledEvent } from '../services/bsc-order-watcher.js';
import type { WalletEventData } from '../services/predict-ws-client.js';
import {
    BACKPRESSURE_DRAIN_TIMEOUT_MS,
    BACKPRESSURE_MAX_TIMEOUT_COUNT,
    BACKPRESSURE_LOG_INTERVAL_MS,
} from './dashboard-config.js';

// ============================================================================
// 模块状态 (由 initSSETransport 注入)
// ============================================================================

let sseClients: Map<ServerResponse, SSEClientMeta>;

/**
 * 初始化 SSE 传输层，注入 sseClients Map 引用
 * 必须在使用任何 SSE 函数前调用
 */
export function initSSETransport(clients: Map<ServerResponse, SSEClientMeta>): void {
    sseClients = clients;
}

// ============================================================================
// SSE 安全写入 (模块级，处理背压)
// ============================================================================

/**
 * 等待 writable stream 的 drain 事件
 * @param stream 可写流
 * @param timeoutMs 超时时间（默认 30 秒）
 * @returns Promise<boolean> true 如果 drain 成功，false 如果超时或流关闭
 */
function waitForDrain(stream: ServerResponse, timeoutMs = 30000): Promise<boolean> {
    return new Promise((resolve) => {
        if (stream.writableEnded || stream.destroyed) {
            resolve(false);
            return;
        }

        const cleanup = () => {
            clearTimeout(timer);
            stream.removeListener('drain', onDrain);
            stream.removeListener('close', onClose);
            stream.removeListener('error', onClose);
        };

        const onDrain = () => {
            cleanup();
            resolve(true);
        };

        const onClose = () => {
            cleanup();
            resolve(false);
        };

        const timer = setTimeout(() => {
            cleanup();
            resolve(false);
        }, timeoutMs);

        stream.once('drain', onDrain);
        stream.once('close', onClose);
        stream.once('error', onClose);
    });
}

/**
 * 异步安全写入 SSE 数据（支持 drain 等待）
 * 用于初始快照发送，允许等待背压恢复
 * @param client SSE 客户端
 * @param message 完整的 SSE 消息
 * @param eventName 事件名（用于日志）
 * @returns Promise<boolean> true 如果写入成功
 */
async function safeSSEWriteAsync(client: ServerResponse, message: string, eventName: string): Promise<boolean> {
    const meta = sseClients.get(client);
    const msgSize = Buffer.byteLength(message, 'utf8');
    const connDuration = meta ? Math.round((Date.now() - meta.connectedAt) / 1000) : 0;
    const logPrefix = `[SSE] 客户端断开 - ip=${meta?.ip || 'unknown'}, ua=${meta?.ua || 'unknown'}, event=${eventName}, msgSize=${msgSize}B, connDuration=${connDuration}s`;

    try {
        if (client.writableEnded || client.destroyed) {
            console.warn(`${logPrefix}, reason=stream_closed`);
            sseClients.delete(client);
            return false;
        }

        const canContinue = client.write(message);
        if (!canContinue) {
            // 遇到背压，等待 drain 事件
            const drained = await waitForDrain(client);
            if (!drained) {
                console.warn(`${logPrefix}, reason=drain_timeout`);
                sseClients.delete(client);
                try { client.end(); } catch {}
                return false;
            }
        }
        return true;
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const stack = e instanceof Error && e.stack
            ? '\n' + e.stack.split('\n').slice(0, 3).join('\n')
            : '';
        console.warn(`${logPrefix}, reason=exception, error=${errMsg}${stack}`);
        sseClients.delete(client);
        try { client.end(); } catch {}
        return false;
    }
}

/**
 * 安全地向 SSE 客户端写入数据（模块级，同步版本）
 * 策略：遇到背压时标记客户端并启动异步 drain 等待，不立即断开
 * @param client SSE 客户端
 * @param message 完整的 SSE 消息（含 event: 和 data:）
 * @param eventName 事件名（用于日志）
 * @param precomputedMsgSize 预计算的消息大小（可选，仅限广播场景传入以避免重复计算）
 * @returns true 如果写入成功，false 如果客户端被移除或正在背压中
 */
function safeSSEWriteGlobal(client: ServerResponse, message: string, eventName: string, precomputedMsgSize?: number): boolean {
    const meta = sseClients.get(client);
    if (!meta) return false;

    const msgSize = precomputedMsgSize ?? Buffer.byteLength(message, 'utf8');
    const connDuration = Math.round((Date.now() - meta.connectedAt) / 1000);
    const logPrefix = `[SSE] ip=${meta.ip}, ua=${meta.ua}, event=${eventName}, msgSize=${msgSize}B, connDuration=${connDuration}s`;

    // 如果客户端正在背压等待中，跳过本次写入（避免缓冲区进一步堆积）
    if (meta.backpressured) {
        // 不打日志，避免刷屏（背压期间可能有多次广播被跳过）
        return false;
    }

    try {
        const canContinue = client.write(message);
        if (!canContinue) {
            // 遇到背压：标记状态并启动异步 drain 等待
            meta.backpressured = true;
            meta.backpressureCycleCount++;

            // 限流日志：每 10 秒打印一次汇总
            const now = Date.now();
            if (now - meta.lastBackpressureLogTime >= BACKPRESSURE_LOG_INTERVAL_MS) {
                if (meta.backpressureCycleCount > 1) {
                    console.log(`${logPrefix}, status=backpressure, cycles=${meta.backpressureCycleCount} in ${Math.round((now - meta.lastBackpressureLogTime) / 1000)}s`);
                } else {
                    console.log(`${logPrefix}, status=backpressure_start`);
                }
                meta.lastBackpressureLogTime = now;
                meta.backpressureCycleCount = 0;
            }

            // 启动异步 drain 等待（不阻塞当前调用）
            handleBackpressureDrain(client, meta, logPrefix);
            return false;
        }
        return true;
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const stack = e instanceof Error && e.stack
            ? '\n' + e.stack.split('\n').slice(0, 3).join('\n')
            : '';
        console.warn(`${logPrefix}, status=exception, error=${errMsg}${stack}`);
        sseClients.delete(client);
        try { client.end(); } catch {}
        return false;
    }
}

/**
 * 处理背压状态的 drain 等待（异步，不阻塞调用者）
 * @param client SSE 客户端
 * @param meta 客户端元数据
 * @param logPrefix 日志前缀
 */
function handleBackpressureDrain(client: ServerResponse, meta: SSEClientMeta, logPrefix: string): void {
    waitForDrain(client, BACKPRESSURE_DRAIN_TIMEOUT_MS).then((drained) => {
        // 检查客户端是否仍然存在（可能在等待期间被关闭）
        if (!sseClients.has(client)) return;

        if (drained) {
            // drain 成功：恢复正常状态（静默，仅在汇总日志中体现）
            meta.backpressured = false;
            meta.drainTimeoutCount = 0;
        } else {
            // drain 超时：累加超时计数
            meta.drainTimeoutCount++;
            console.warn(`${logPrefix}, status=drain_timeout, timeoutCount=${meta.drainTimeoutCount}/${BACKPRESSURE_MAX_TIMEOUT_COUNT}`);

            if (meta.drainTimeoutCount >= BACKPRESSURE_MAX_TIMEOUT_COUNT) {
                // 连续多次超时，断开连接
                console.warn(`${logPrefix}, status=disconnected, reason=max_drain_timeout_exceeded`);
                sseClients.delete(client);
                try { client.end(); } catch {}
            } else {
                // 未达到阈值，保持背压状态，等待下一次写入尝试时重新触发 drain 等待
                // 或者立即重新启动 drain 等待
                handleBackpressureDrain(client, meta, logPrefix);
            }
        }
    });
}

// ============================================================================
// SSE 发送 API
// ============================================================================

/**
 * 异步向单个 SSE 客户端发送事件（支持 drain 等待）
 * 用于初始快照推送，允许等待背压恢复
 * @param client SSE 客户端
 * @param eventName 事件名
 * @param data JSON 数据字符串
 * @returns Promise<boolean> true 如果写入成功
 */
export async function sendSSEToClientAsync(client: ServerResponse, eventName: string, data: string): Promise<boolean> {
    const message = `event: ${eventName}\ndata: ${data}\n\n`;
    return safeSSEWriteAsync(client, message, eventName);
}

/**
 * 向单个 SSE 客户端发送事件（同步版本，带背压检测）
 * 用于广播场景
 * @param client SSE 客户端
 * @param eventName 事件名
 * @param data JSON 数据字符串
 * @returns true 如果写入成功，false 如果客户端被移除
 */
export function sendSSEToClient(client: ServerResponse, eventName: string, data: string): boolean {
    const message = `event: ${eventName}\ndata: ${data}\n\n`;
    return safeSSEWriteGlobal(client, message, eventName);
}

/**
 * 检查 SSE 客户端是否仍可写入
 * 用于在昂贵计算（如 API 调用）之前快速判断是否需要继续
 * @param client SSE 客户端
 * @returns true 如果客户端仍可写入
 */
export function isSSEClientAlive(client: ServerResponse): boolean {
    return !client.writableEnded && !client.destroyed && sseClients.has(client);
}

/**
 * 异步分片发送大数组数据到单个 SSE 客户端（支持 drain 等待）
 * 用于初始快照推送，允许等待背压恢复
 * @param client SSE 客户端
 * @param items 要发送的数组
 * @param batchSize 每批大小（默认 30）
 * @returns Promise<boolean> true 如果全部发送成功
 */
export async function sendOpportunityBatchesAsync<T>(client: ServerResponse, items: T[], batchSize = 30): Promise<boolean> {
    const total = items.length;
    for (let offset = 0; offset < total; offset += batchSize) {
        const batch = items.slice(offset, offset + batchSize);
        const done = offset + batchSize >= total;
        const payload = JSON.stringify({ items: batch, offset, total, done });
        if (!await sendSSEToClientAsync(client, 'opportunity-batch', payload)) {
            return false;
        }
    }
    // 发送空数组时也要发一个 done 包
    if (total === 0) {
        const payload = JSON.stringify({ items: [], offset: 0, total: 0, done: true });
        if (!await sendSSEToClientAsync(client, 'opportunity-batch', payload)) {
            return false;
        }
    }
    return true;
}

/**
 * 分片发送大数组数据到单个 SSE 客户端（同步版本）
 * 将大数组拆分成多个小批次发送，用于广播场景
 * @param client SSE 客户端
 * @param items 要发送的数组
 * @param batchSize 每批大小（默认 30）
 * @returns true 如果全部发送成功，false 如果客户端被移除
 */
export function sendOpportunityBatches<T>(client: ServerResponse, items: T[], batchSize = 30): boolean {
    const total = items.length;
    for (let offset = 0; offset < total; offset += batchSize) {
        const batch = items.slice(offset, offset + batchSize);
        const done = offset + batchSize >= total;
        const payload = JSON.stringify({ items: batch, offset, total, done });
        if (!sendSSEToClient(client, 'opportunity-batch', payload)) {
            return false;
        }
    }
    // 发送空数组时也要发一个 done 包
    if (total === 0) {
        const payload = JSON.stringify({ items: [], offset: 0, total: 0, done: true });
        if (!sendSSEToClient(client, 'opportunity-batch', payload)) {
            return false;
        }
    }
    return true;
}

// ============================================================================
// SSE 广播
// ============================================================================

/**
 * 广播 SSE 消息到所有客户端（模块级）
 * 预计算消息大小，避免每个客户端重复计算 Buffer.byteLength
 * 跳过尚未完成初始快照的客户端，确保"先完整快照、后增量广播"的事件顺序
 */
export function broadcastSSEGlobal(eventName: string, data: string): void {
    const message = `event: ${eventName}\ndata: ${data}\n\n`;
    const msgSize = Buffer.byteLength(message, 'utf8');
    for (const [client, meta] of sseClients.entries()) {
        // 跳过尚未完成初始快照的客户端（避免事件交错）
        if (!meta.initialized) continue;
        safeSSEWriteGlobal(client, message, eventName, msgSize);
    }
}

// ============================================================================
// Task SSE 广播
// ============================================================================

// 批量创建时同一任务状态机会快速迁移多次（CREATED → VALIDATING → PREDICT_SUBMITTED ...）。
// 对非终态做 80ms trailing-edge 合并：窗口内只广播最后一次 snapshot，减少 SSE 带宽与前端 re-render。
// 终态（COMPLETED/FAILED/CANCELLED 等）立即广播，确保列表及时收到收尾事件。
const TASK_BROADCAST_DEBOUNCE_MS = 80;
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'TIMEOUT_CANCELLED',
    'HEDGE_FAILED',
    'UNWIND_COMPLETED',
]);
const pendingTaskBroadcasts = new Map<string, { task: Task; timer: NodeJS.Timeout }>();

function flushTaskBroadcast(taskId: string): void {
    const entry = pendingTaskBroadcasts.get(taskId);
    if (!entry) return;
    pendingTaskBroadcasts.delete(taskId);
    clearTimeout(entry.timer);
    broadcastSSEGlobal('task', JSON.stringify(entry.task));
}

export function broadcastTaskUpdate(task: Task): void {
    if (TERMINAL_TASK_STATUSES.has(task.status)) {
        const existing = pendingTaskBroadcasts.get(task.id);
        if (existing) {
            clearTimeout(existing.timer);
            pendingTaskBroadcasts.delete(task.id);
        }
        broadcastSSEGlobal('task', JSON.stringify(task));
        return;
    }

    const existing = pendingTaskBroadcasts.get(task.id);
    if (existing) {
        existing.task = task;
        return;
    }

    const entry = {
        task,
        timer: setTimeout(() => flushTaskBroadcast(task.id), TASK_BROADCAST_DEBOUNCE_MS),
    };
    pendingTaskBroadcasts.set(task.id, entry);
}

export function broadcastTaskDeleted(taskId: string): void {
    const data = JSON.stringify({ id: taskId, deleted: true });
    broadcastSSEGlobal('taskDeleted', data);
}

/**
 * 广播 BSC 链上订单成交事件（用于前端可观测性）
 */
export function broadcastBscOrderFilled(payload: {
    type: 'bscOrderFilled';
    event: BscOrderFilledEvent;
    tokenId: string;
    marketId?: number;
    marketTitle?: string;
    side?: string;  // YES/NO 或多选市场的 outcome 名称
}): void {
    broadcastSSEGlobal('bscOrderFilled', JSON.stringify(payload));
}

/**
 * 广播 Predict 钱包事件（订单生命周期：created/accepted/filled/cancelled）
 */
export function broadcastPredictWalletEvent(payload: {
    type: 'predictWalletEvent';
    event: WalletEventData;
    marketId?: number;
    marketTitle?: string;
}): void {
    broadcastSSEGlobal('predictWalletEvent', JSON.stringify(payload));
}
