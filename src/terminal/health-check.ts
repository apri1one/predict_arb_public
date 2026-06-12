/**
 * Health Check 巡检报告脚本
 *
 * 纯文件读取 + shell 命令，不依赖 Dashboard HTTP API。
 * 输出精简 JSON 摘要，供 cron + SSH + Claude Code 定时巡检。
 *
 * 使用：
 *   npx tsx src/terminal/health-check.ts           # 默认 24h
 *   npx tsx src/terminal/health-check.ts --days=7  # 7 天
 *   npx tsx src/terminal/health-check.ts --pretty  # 人类可读格式
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import type { Task, TaskStatus } from '../dashboard/types.js';

// ============================================================================
// 配置
// ============================================================================

const PROJECT_ROOT = process.cwd();
const TASKS_JSON_PATH = path.join(PROJECT_ROOT, 'data', 'tasks.json');
const TASK_LOGS_DIR = path.join(PROJECT_ROOT, 'data', 'logs', 'tasks');
const PM2_LOGS_DIR = path.join(process.env.HOME || os.homedir(), '.pm2', 'logs');

const TERMINAL_STATUSES = new Set<TaskStatus>([
    'COMPLETED', 'FAILED', 'HEDGE_FAILED', 'UNWIND_COMPLETED',
    'CANCELLED', 'TIMEOUT_CANCELLED',
] as const);

const SUCCESS_STATUSES = new Set<TaskStatus>(['COMPLETED'] as const);

const FAILED_STATUSES = new Set<TaskStatus>([
    'FAILED', 'HEDGE_FAILED', 'UNWIND_COMPLETED',
] as const);

const CANCELLED_STATUSES = new Set<TaskStatus>([
    'CANCELLED', 'TIMEOUT_CANCELLED',
] as const);

// ============================================================================
// 工具函数
// ============================================================================

function formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function shellExec(cmd: string): string {
    try {
        return execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim();
    } catch {
        return '';
    }
}

// ============================================================================
// 数据读取
// ============================================================================

function loadTasks(): Task[] {
    if (!fs.existsSync(TASKS_JSON_PATH)) {
        return [];
    }
    const raw = fs.readFileSync(TASKS_JSON_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Array<[string, Task]>;
    return parsed.map(([, task]) => task);
}

interface PM2Info {
    status: string;
    uptime: string;
    restarts: number;
    memory: string;
    memoryBytes: number;
    cpu: string;
    pid: number;
}

function getPM2Status(): PM2Info | null {
    const raw = shellExec('pm2 jlist 2>/dev/null');
    if (!raw) return null;

    try {
        const list = JSON.parse(raw) as Array<{
            name: string;
            pid: number;
            monit: { memory: number; cpu: number };
            pm2_env: {
                status: string;
                pm_uptime: number;
                restart_time: number;
            };
        }>;

        const dashboard = list.find(p => p.name === 'dashboard');
        if (!dashboard) return null;

        const env = dashboard.pm2_env;
        const monit = dashboard.monit;
        const uptimeMs = Date.now() - env.pm_uptime;

        return {
            status: env.status,
            uptime: formatDuration(uptimeMs),
            restarts: env.restart_time,
            memory: formatBytes(monit.memory),
            memoryBytes: monit.memory,
            cpu: `${monit.cpu}%`,
            pid: dashboard.pid,
        };
    } catch {
        return null;
    }
}

interface DiskInfo {
    rootUsage: string;
    logsSize: string;
    pm2LogsSize: string;
}

function getDiskInfo(): DiskInfo {
    // df -h / → 提取使用率
    const dfOutput = shellExec('df -h / --output=pcent 2>/dev/null | tail -1');
    const rootUsage = dfOutput.trim() || 'N/A';

    // du -sh data/logs/tasks/
    const logsSize = shellExec(`du -sh "${TASK_LOGS_DIR}" 2>/dev/null | cut -f1`).trim() || 'N/A';

    // du -sh ~/.pm2/logs/
    const pm2LogsSize = shellExec(`du -sh "${PM2_LOGS_DIR}" 2>/dev/null | cut -f1`).trim() || 'N/A';

    return { rootUsage, logsSize, pm2LogsSize };
}

// ============================================================================
// 统计计算
// ============================================================================

interface TaskStats {
    total: number;
    completed: number;
    failed: number;
    hedgeFailed: number;
    cancelled: number;
    successRate: string;
    totalProfit: number;
    avgProfit: number;
    avgDurationSec: number;
}

function computeTaskStats(tasks: Task[], cutoff: number): TaskStats {
    const inPeriod = tasks.filter(t => t.createdAt >= cutoff && TERMINAL_STATUSES.has(t.status));

    const completed = inPeriod.filter(t => SUCCESS_STATUSES.has(t.status)).length;
    const failed = inPeriod.filter(t => t.status === 'FAILED' || t.status === 'UNWIND_COMPLETED').length;
    const hedgeFailed = inPeriod.filter(t => t.status === 'HEDGE_FAILED').length;
    const cancelled = inPeriod.filter(t => CANCELLED_STATUSES.has(t.status)).length;
    const total = inPeriod.length;

    const totalProfit = inPeriod.reduce((sum, t) => sum + (t.actualProfit || 0), 0);

    const completedTasks = inPeriod.filter(t => SUCCESS_STATUSES.has(t.status));
    const avgProfit = completedTasks.length > 0
        ? completedTasks.reduce((sum, t) => sum + (t.actualProfit || 0), 0) / completedTasks.length
        : 0;

    const tasksWithDuration = inPeriod.filter(t => t.completedAt && t.createdAt);
    const avgDurationSec = tasksWithDuration.length > 0
        ? tasksWithDuration.reduce((sum, t) => sum + ((t.completedAt! - t.createdAt) / 1000), 0) / tasksWithDuration.length
        : 0;

    const successRate = total > 0 ? ((completed / total) * 100).toFixed(1) : '0.0';

    return {
        total,
        completed,
        failed,
        hedgeFailed,
        cancelled,
        successRate: `${successRate}%`,
        totalProfit: Math.round(totalProfit * 100) / 100,
        avgProfit: Math.round(avgProfit * 100) / 100,
        avgDurationSec: Math.round(avgDurationSec),
    };
}

interface RunningTaskInfo {
    id: string;
    status: TaskStatus;
    strategy: string;
    market: string;
    marketId: number;
    duration: string;
    filled: number;
    hedged: number;
    unhedgedExposure: number;
}

interface RunningSummary {
    total: number;
    byStatus: Record<string, number>;
    totalFilled: number;
    totalHedged: number;
    totalUnhedgedExposure: number;
    notable: RunningTaskInfo[];
}

function getRunningTasks(tasks: Task[]): RunningSummary {
    const running = tasks.filter(t => !TERMINAL_STATUSES.has(t.status));

    const byStatus: Record<string, number> = {};
    let totalFilled = 0;
    let totalHedged = 0;

    const mapped = running.map(t => {
        const filled = t.predictFilledQty || 0;
        const hedged = t.hedgedQty || 0;
        totalFilled += filled;
        totalHedged += hedged;
        byStatus[t.status] = (byStatus[t.status] || 0) + 1;

        return {
            id: t.id,
            status: t.status,
            strategy: t.strategy || 'PREDICT_MAKER',
            market: t.title,
            marketId: t.marketId,
            duration: formatDuration(Date.now() - t.createdAt),
            filled,
            hedged,
            unhedgedExposure: Math.round((filled - hedged) * 100) / 100,
        };
    });

    // 只输出有实际填充的任务 (filled > 0)
    const notable = mapped.filter(t => t.filled > 0);

    return {
        total: running.length,
        byStatus,
        totalFilled: Math.round(totalFilled * 100) / 100,
        totalHedged: Math.round(totalHedged * 100) / 100,
        totalUnhedgedExposure: Math.round((totalFilled - totalHedged) * 100) / 100,
        notable,
    };
}

interface FailureInfo {
    id: string;
    status: TaskStatus;
    market: string;
    reason: string;
    at: string;
}

function getFailures(tasks: Task[], cutoff: number): FailureInfo[] {
    return tasks
        .filter(t => t.createdAt >= cutoff && FAILED_STATUSES.has(t.status))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 20)
        .map(t => ({
            id: t.id,
            status: t.status,
            market: t.title,
            reason: t.error || t.cancelReason || 'Unknown',
            at: new Date(t.updatedAt).toISOString(),
        }));
}

// ============================================================================
// 告警生成
// ============================================================================

interface Alert {
    level: 'WARN' | 'INFO';
    msg: string;
}

function generateAlerts(
    running: RunningSummary,
    stats: TaskStats,
    pm2: PM2Info | null,
    disk: DiskInfo,
): Alert[] {
    const alerts: Alert[] = [];

    // 未对冲敞口 > 1 share
    for (const t of running.notable) {
        if (t.unhedgedExposure > 1) {
            alerts.push({
                level: 'WARN',
                msg: `未对冲敞口: ${t.id} (${t.unhedgedExposure} shares)`,
            });
        }
    }

    // 成功率 < 80%
    if (stats.total > 0 && parseFloat(stats.successRate) < 80) {
        alerts.push({
            level: 'WARN',
            msg: `成功率 ${stats.successRate} 低于 80% (${stats.total} tasks)`,
        });
    }

    // PM2 告警
    if (pm2) {
        if (pm2.restarts > 0) {
            alerts.push({
                level: 'WARN',
                msg: `PM2 累计重启 ${pm2.restarts} 次`,
            });
        }
        if (pm2.memoryBytes > 1200 * 1024 * 1024) {
            alerts.push({
                level: 'WARN',
                msg: `PM2 内存 ${pm2.memory} 超过 1200MB`,
            });
        }
        if (pm2.status !== 'online') {
            alerts.push({
                level: 'WARN',
                msg: `PM2 Dashboard 状态: ${pm2.status}`,
            });
        }
    } else {
        alerts.push({
            level: 'WARN',
            msg: 'PM2 Dashboard 进程未找到',
        });
    }

    // 日志大小
    const pm2LogsMB = parseSizeToMB(disk.pm2LogsSize);
    if (pm2LogsMB > 500) {
        alerts.push({
            level: 'INFO',
            msg: `PM2 logs ${disk.pm2LogsSize}, consider rotation`,
        });
    }

    const taskLogsMB = parseSizeToMB(disk.logsSize);
    if (taskLogsMB > 100) {
        alerts.push({
            level: 'INFO',
            msg: `Task logs ${disk.logsSize}, consider cleanup`,
        });
    }

    return alerts;
}

function parseSizeToMB(sizeStr: string): number {
    const match = sizeStr.match(/^([\d.]+)\s*([KMGT]?)B?$/i);
    if (!match) return 0;
    const val = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    switch (unit) {
        case 'K': return val / 1024;
        case 'M': return val;
        case 'G': return val * 1024;
        case 'T': return val * 1024 * 1024;
        default: return val / (1024 * 1024);
    }
}

// ============================================================================
// 主函数
// ============================================================================

interface HealthReport {
    generatedAt: string;
    period: string;
    pm2: PM2Info | { status: 'NOT_FOUND' };
    disk: DiskInfo;
    tasks: TaskStats;
    running: RunningSummary;
    failures: FailureInfo[];
    alerts: Alert[];
}

function buildReport(days: number): HealthReport {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const tasks = loadTasks();
    const pm2 = getPM2Status();
    const disk = getDiskInfo();
    const stats = computeTaskStats(tasks, cutoff);
    const running = getRunningTasks(tasks);
    const failures = getFailures(tasks, cutoff);
    const alerts = generateAlerts(running, stats, pm2, disk);

    return {
        generatedAt: new Date().toISOString(),
        period: `${days}d`,
        pm2: pm2 || { status: 'NOT_FOUND' },
        disk,
        tasks: stats,
        running,
        failures,
        alerts,
    };
}

function main(): void {
    const args = process.argv.slice(2);

    let days = 1;
    let pretty = false;

    for (const arg of args) {
        if (arg.startsWith('--days=')) {
            days = parseInt(arg.replace('--days=', ''), 10);
            if (isNaN(days) || days < 1) {
                console.error('Error: --days must be a positive integer');
                process.exit(1);
            }
        } else if (arg === '--pretty') {
            pretty = true;
        } else if (arg === '--help' || arg === '-h') {
            console.log('Usage: npx tsx src/terminal/health-check.ts [--days=N] [--pretty]');
            console.log('  --days=N   Time window (default: 1 = 24h)');
            console.log('  --pretty   Human-readable indented output');
            process.exit(0);
        }
    }

    const report = buildReport(days);
    const json = JSON.stringify(report, null, pretty ? 2 : undefined);
    console.log(json);
}

main();
