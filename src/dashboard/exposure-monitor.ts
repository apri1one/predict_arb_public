/**
 * exposure-monitor.ts — 全局敞口检测 (Exposure Alert)
 *
 * 从 start-dashboard.ts 提取。
 * 定时轮询检测未对冲敞口，发送 SSE 广播 + Telegram 置顶通知。
 */

import type { TelegramNotifier } from '../notification/telegram.js';
import type { Task, TaskFilter } from './types.js';
import {
    EXPOSURE_CHECK_INTERVAL_MS,
    EXPOSURE_THRESHOLD,
    HEDGE_GRACE_PERIOD_MS,
    HEDGING_STATUSES,
    EXPOSURE_ACTIVE_STATUSES,
} from './dashboard-config.js';

// ============================================================================
// Types
// ============================================================================

export interface ExposureMonitorDeps {
    taskService: { getTasks(filter?: TaskFilter): Task[] };
    broadcastSSEGlobal: (eventName: string, data: string) => void;
    getTelegramNotifier: () => TelegramNotifier | null;
    /** 触发敞口快照采集 (订单簿 + Polymarket WS 健康)，可选; 缺省则跳过快照 */
    captureExposureSnapshot?: (taskId: string, exposure: number) => Promise<void>;
}

export interface ExposureMonitorState {
    exposureTgMuted: boolean;
    currentExposureTaskIds: string;
    mutedExposureTaskIds: string;
    lastPinnedMessageId: number | null;
}

export interface ExposureMonitor {
    start(): void;
    /** 供 /api/exposure/dismiss 路由调用 */
    dismiss(taskIds?: string[]): void;
    /** 供路由读取状态 */
    getState(): ExposureMonitorState;
}

// ============================================================================
// Factory
// ============================================================================

export function createExposureMonitor(deps: ExposureMonitorDeps): ExposureMonitor {
    const { taskService, broadcastSSEGlobal, getTelegramNotifier, captureExposureSnapshot } = deps;

    // 闭包内部状态
    let lastPinnedMessageId: number | null = null;
    let exposureTgMuted = false;
    let currentExposureTaskIds = '';
    const mutedExposureTaskIds = new Set<string>();
    let lastAlertedTasks: { id: string; title: string; exposure: number; predictFilled?: number; hedged?: number }[] = [];

    // ------------------------------------------------------------------
    // sendExposureTelegramAlert
    // ------------------------------------------------------------------

    async function sendExposureTelegramAlert(
        totalExposure: number,
        exposedTasks: { id: string; title: string; exposure: number; predictFilled?: number; hedged?: number }[],
    ): Promise<void> {
        const tg = getTelegramNotifier();
        if (!tg) return;

        const lines = [
            `🚨 <b>敞口预警: ${totalExposure.toFixed(1)} shares 未对冲</b>`,
            ``,
            `时间: ${new Date().toLocaleString('zh-CN')}`,
            ``,
        ];
        for (const t of exposedTasks) {
            lines.push(`• <b>${(t.title || '').slice(0, 30)}</b>: ${(t.exposure || 0).toFixed(1)} shares (成交${(t.predictFilled ?? 0).toFixed(0)}/对冲${(t.hedged ?? 0).toFixed(0)})`);
        }

        // 取消上一条置顶
        if (lastPinnedMessageId) {
            await tg.unpinMessage(lastPinnedMessageId);
        }
        lastPinnedMessageId = await tg.sendAndPin(lines.join('\n'));
        lastAlertedTasks = exposedTasks.map(task => ({ ...task }));
    }

    async function sendExposureResolvedTelegramAlert(
        resolvedTasks: { id: string; title: string; exposure: number; predictFilled?: number; hedged?: number }[],
    ): Promise<void> {
        const tg = getTelegramNotifier();
        if (!tg || resolvedTasks.length === 0) return;

        const lines = [
            `✅ <b>敞口已恢复</b>`,
            ``,
            `时间: ${new Date().toLocaleString('zh-CN')}`,
            ``,
        ];

        for (const task of resolvedTasks.slice(0, 8)) {
            lines.push(`• <b>${(task.title || '').slice(0, 30)}</b>`);
        }

        if (resolvedTasks.length > 8) {
            lines.push(`• 其余 ${resolvedTasks.length - 8} 个任务已恢复`);
        }

        await tg.sendText(lines.join('\n'));
    }

    // ------------------------------------------------------------------
    // startExposureMonitor (interval callback)
    // ------------------------------------------------------------------

    function tick(): void {
        const allTasks = taskService.getTasks();
        let totalExposure = 0;
        const exposedTasks: { id: string; title: string; exposure: number; predictFilled: number; hedged: number }[] = [];

        for (const t of allTasks) {
            // 只检查执行中的任务
            if (!EXPOSURE_ACTIVE_STATUSES.has(t.status)) continue;

            // 对冲中的任务给予宽限期：刚进入对冲状态不足 60s 的跳过，避免误报
            if (HEDGING_STATUSES.has(t.status) && t.updatedAt && (Date.now() - t.updatedAt < HEDGE_GRACE_PERIOD_MS)) continue;

            // 敞口 = 主动方成交 - 对冲方成交。主动方依策略：POLY_MAKER → Poly，其余 → Predict
            const isPolyMaker = t.strategy === 'POLY_MAKER';
            const filled = Number(isPolyMaker ? t.polyFilledQty : t.predictFilledQty) || 0;
            const hedged = Number(t.hedgedQty) || 0;
            // 过滤异常值 (wei 未转换等): 合理范围 < 1e8
            if (!Number.isFinite(filled) || filled > 1e8) continue;
            const exposure = filled - hedged;
            // 只关注有意义的敞口 (>= 10 shares)
            if (!Number.isFinite(exposure) || exposure < 10) continue;
            totalExposure += exposure;
            exposedTasks.push({
                id: t.id,
                title: t.title || `Task #${t.id?.slice(0, 8) || 'unknown'}`,
                exposure,
                predictFilled: filled,
                hedged,
            });
        }

        if (!Number.isFinite(totalExposure) || totalExposure <= EXPOSURE_THRESHOLD) {
            // 敞口消除，取消置顶并重置静默
            if (lastPinnedMessageId) {
                const tg = getTelegramNotifier();
                if (tg) tg.unpinMessage(lastPinnedMessageId).catch(() => {});
                lastPinnedMessageId = null;
            }
            if (!exposureTgMuted && lastAlertedTasks.length > 0) {
                sendExposureResolvedTelegramAlert(lastAlertedTasks).catch(() => {});
            }
            lastAlertedTasks = [];
            exposureTgMuted = false;
            mutedExposureTaskIds.clear();
            return;
        }

        const now = Date.now();
        const currentExposureTaskIdSet = new Set(exposedTasks.map(t => t.id));
        currentExposureTaskIds = [...currentExposureTaskIdSet].sort().join(',');

        // 自动清理已不在敞口列表中的静默任务；任务敞口消失后，下次重新出现应允许再次告警
        for (const taskId of [...mutedExposureTaskIds]) {
            if (!currentExposureTaskIdSet.has(taskId)) {
                mutedExposureTaskIds.delete(taskId);
            }
        }

        const visibleTasks = exposedTasks.filter(t => !mutedExposureTaskIds.has(t.id));
        const visibleTotalExposure = visibleTasks.reduce((sum, task) => sum + task.exposure, 0);

        // 所有当前敞口都已被静默：前端不再展示，Telegram 也不再提醒
        if (visibleTasks.length === 0 || visibleTotalExposure <= EXPOSURE_THRESHOLD) {
            exposureTgMuted = mutedExposureTaskIds.size > 0;
            if (lastPinnedMessageId) {
                const tg = getTelegramNotifier();
                if (tg) tg.unpinMessage(lastPinnedMessageId).catch(() => {});
                lastPinnedMessageId = null;
            }
            if (!exposureTgMuted && lastAlertedTasks.length > 0) {
                sendExposureResolvedTelegramAlert(lastAlertedTasks).catch(() => {});
            }
            lastAlertedTasks = [];
            return;
        }

        // 仍有可见敞口任务，表示应该继续展示/提醒
        exposureTgMuted = false;

        // 1. SSE 广播到前端（仅广播未静默任务）
        broadcastSSEGlobal('exposureAlert', JSON.stringify({
            totalExposure: visibleTotalExposure,
            tasks: visibleTasks,
            timestamp: now,
        }));

        // 2. Telegram 置顶消息（仅针对未静默任务）
        sendExposureTelegramAlert(visibleTotalExposure, visibleTasks);

        // 3. 持续快照：每个可见敞口任务采集双边订单簿 + Polymarket WS 健康状态
        //    用于事后复盘"幽灵深度"/对冲失败时刻的市场真实状况 (PARIVISION 事故经验)
        if (captureExposureSnapshot) {
            for (const t of visibleTasks) {
                captureExposureSnapshot(t.id, t.exposure).catch(err => {
                    console.warn(`[ExposureMonitor] captureExposureSnapshot error (task=${t.id}):`, err?.message || err);
                });
            }
        }
    }

    // ------------------------------------------------------------------
    // Public interface
    // ------------------------------------------------------------------

    return {
        start(): void {
            setInterval(tick, EXPOSURE_CHECK_INTERVAL_MS);
            console.log(`✅ 敞口监控已启动 (每 ${EXPOSURE_CHECK_INTERVAL_MS / 1000}s 轮询, 阈值 ${EXPOSURE_THRESHOLD} shares)\n`);
        },

        dismiss(taskIds?: string[]): void {
            const ids = (taskIds && taskIds.length > 0)
                ? taskIds
                : currentExposureTaskIds.split(',').map(id => id.trim()).filter(Boolean);
            for (const taskId of ids) {
                mutedExposureTaskIds.add(taskId);
            }
            exposureTgMuted = mutedExposureTaskIds.size > 0;
            // 取消 Telegram 置顶
            if (lastPinnedMessageId) {
                const tg = getTelegramNotifier();
                if (tg) tg.unpinMessage(lastPinnedMessageId).catch(() => {});
                lastPinnedMessageId = null;
            }
            console.log(`[ExposureMonitor] 已静默 ${ids.length} 个敞口任务的前端/TG 告警`);
        },

        getState(): ExposureMonitorState {
            return {
                exposureTgMuted,
                currentExposureTaskIds,
                mutedExposureTaskIds: [...mutedExposureTaskIds].sort().join(','),
                lastPinnedMessageId,
            };
        },
    };
}
