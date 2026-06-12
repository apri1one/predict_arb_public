/**
 * 任务日志查询工具
 *
 * 功能：
 * - 查看任务时间线
 * - 统计报表
 * - 失败任务分析
 * - 订单簿快照查看
 *
 * 使用：
 *   npx tsx src/terminal/query-task-logs.ts timeline <taskId>
 *   npx tsx src/terminal/query-task-logs.ts stats [--days=7]
 *   npx tsx src/terminal/query-task-logs.ts failures [--days=7]
 *   npx tsx src/terminal/query-task-logs.ts orderbook <taskId> <sequence>
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

// ============================================================================
// 配置
// ============================================================================

const DB_PATH = path.join(process.cwd(), 'data', 'logs', 'index.db');

// ============================================================================
// 工具函数
// ============================================================================

function formatTimestamp(ts: number): string {
    return new Date(ts).toISOString().replace('T', ' ').substring(0, 19);
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
}

function formatProfit(profit: number): string {
    const sign = profit >= 0 ? '+' : '';
    return `${sign}$${profit.toFixed(2)}`;
}

// ============================================================================
// 命令实现
// ============================================================================

function showTimeline(db: Database.Database, taskId: string): void {
    // 获取任务信息
    const task = db.prepare(`
        SELECT * FROM tasks WHERE id = ?
    `).get(taskId) as Record<string, unknown> | undefined;

    if (!task) {
        console.error(`Task ${taskId} not found in database`);
        return;
    }

    console.log('\n' + '='.repeat(80));
    console.log(`Task: ${taskId}`);
    console.log('='.repeat(80));
    console.log(`Type: ${task.type}`);
    console.log(`Market: ${task.market_id} - ${task.title}`);
    console.log(`Status: ${task.status}`);
    console.log(`Created: ${formatTimestamp(task.created_at as number)}`);
    if (task.completed_at) {
        console.log(`Completed: ${formatTimestamp(task.completed_at as number)}`);
        console.log(`Duration: ${formatDuration(task.duration_ms as number)}`);
    }
    console.log(`Profit: ${formatProfit(task.actual_profit as number)}`);
    console.log('');

    // 获取事件时间线
    const events = db.prepare(`
        SELECT timestamp, type, payload, sequence
        FROM events
        WHERE task_id = ?
        ORDER BY sequence ASC
    `).all(taskId) as Array<{ timestamp: number; type: string; payload: string; sequence: number }>;

    console.log('Timeline:');
    console.log('-'.repeat(80));

    for (const event of events) {
        const time = formatTimestamp(event.timestamp);
        const payload = JSON.parse(event.payload);
        let detail = '';

        switch (event.type) {
            case 'ORDER_SUBMITTED':
                detail = `${payload.platform} ${payload.side} ${payload.quantity} @ ${payload.price}`;
                break;
            case 'ORDER_FILLED':
            case 'ORDER_PARTIAL_FILL':
                detail = `${payload.platform} filled ${payload.filledQty} @ ${payload.avgPrice}`;
                break;
            case 'PRICE_GUARD_TRIGGERED':
                detail = `poly=${payload.triggerPrice.toFixed(4)} > max=${payload.thresholdPrice}`;
                break;
            case 'HEDGE_COMPLETED':
                detail = `hedged ${payload.hedgeQty} @ ${payload.avgHedgePrice.toFixed(4)}`;
                break;
            case 'TASK_COMPLETED':
                detail = `profit: ${formatProfit(payload.profit || 0)}`;
                break;
            case 'TASK_FAILED':
                detail = payload.reason || payload.error?.message || '';
                break;
            default:
                if (payload.reason) detail = payload.reason;
        }

        console.log(`[${time}] ${event.type}${detail ? ` - ${detail}` : ''}`);
    }

    console.log('-'.repeat(80));
}

function showStats(db: Database.Database, days: number): void {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    // 总体统计
    const stats = db.prepare(`
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN is_success = 1 THEN 1 ELSE 0 END) as success,
            SUM(CASE WHEN status = 'FAILED' OR status = 'HEDGE_FAILED' THEN 1 ELSE 0 END) as failed,
            SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) as cancelled,
            SUM(actual_profit) as totalProfit,
            AVG(actual_profit) as avgProfit,
            AVG(duration_ms) as avgDuration,
            SUM(predict_filled_qty) as totalVolume
        FROM tasks
        WHERE created_at >= ?
    `).get(cutoff) as Record<string, number>;

    console.log('\n' + '='.repeat(60));
    console.log(`Task Statistics (Last ${days} days)`);
    console.log('='.repeat(60));
    console.log(`Total Tasks: ${stats.total}`);
    const successRate = stats.total > 0 ? ((stats.success / stats.total) * 100).toFixed(1) : '0.0';
    console.log(`Success: ${stats.success} (${successRate}%)`);
    console.log(`Failed: ${stats.failed}`);
    console.log(`Cancelled: ${stats.cancelled}`);
    console.log('');
    console.log(`Total Profit: ${formatProfit(stats.totalProfit || 0)}`);
    console.log(`Avg Profit/Task: ${formatProfit(stats.avgProfit || 0)}`);
    console.log(`Avg Duration: ${formatDuration(stats.avgDuration || 0)}`);
    console.log(`Total Volume: ${(stats.totalVolume || 0).toFixed(2)} shares`);
    console.log('');

    // 按类型统计
    const byType = db.prepare(`
        SELECT
            type,
            COUNT(*) as count,
            SUM(actual_profit) as profit,
            AVG(profit_percent) as avgProfitPercent
        FROM tasks
        WHERE created_at >= ?
        GROUP BY type
    `).all(cutoff) as Array<{ type: string; count: number; profit: number; avgProfitPercent: number }>;

    console.log('By Type:');
    console.log('-'.repeat(60));
    for (const row of byType) {
        console.log(`  ${row.type}: ${row.count} tasks, ${formatProfit(row.profit || 0)} total, ${(row.avgProfitPercent || 0).toFixed(2)}% avg`);
    }
    console.log('');

    // 按 market 统计 (Top 5)
    const byMarket = db.prepare(`
        SELECT
            market_id,
            title,
            COUNT(*) as count,
            SUM(actual_profit) as profit
        FROM tasks
        WHERE created_at >= ?
        GROUP BY market_id
        ORDER BY count DESC
        LIMIT 5
    `).all(cutoff) as Array<{ market_id: number; title: string; count: number; profit: number }>;

    console.log('Top 5 Markets:');
    console.log('-'.repeat(60));
    for (const row of byMarket) {
        console.log(`  [${row.market_id}] ${row.title?.substring(0, 30) || 'Unknown'}: ${row.count} tasks, ${formatProfit(row.profit || 0)}`);
    }
    console.log('-'.repeat(60));
}

function showFailures(db: Database.Database, days: number): void {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    const failures = db.prepare(`
        SELECT
            id, type, market_id, title, status,
            actual_profit, unwind_loss,
            pause_count, hedge_retry_count,
            created_at, duration_ms
        FROM tasks
        WHERE created_at >= ?
          AND (status = 'FAILED' OR status = 'HEDGE_FAILED' OR status = 'UNWIND_COMPLETED')
        ORDER BY created_at DESC
    `).all(cutoff) as Array<Record<string, unknown>>;

    console.log('\n' + '='.repeat(80));
    console.log(`Failed Tasks (Last ${days} days): ${failures.length} tasks`);
    console.log('='.repeat(80));

    if (failures.length === 0) {
        console.log('No failed tasks found');
        return;
    }

    for (const task of failures) {
        console.log('');
        console.log(`Task: ${task.id}`);
        console.log(`  Type: ${task.type}`);
        console.log(`  Market: ${task.market_id} - ${(task.title as string)?.substring(0, 40)}`);
        console.log(`  Status: ${task.status}`);
        console.log(`  Created: ${formatTimestamp(task.created_at as number)}`);
        console.log(`  Duration: ${formatDuration(task.duration_ms as number)}`);
        console.log(`  Loss: ${formatProfit(task.actual_profit as number)}`);
        if (task.unwind_loss) {
            console.log(`  Unwind Loss: ${formatProfit(task.unwind_loss as number)}`);
        }
        console.log(`  Pause Count: ${task.pause_count}`);
        console.log(`  Hedge Retries: ${task.hedge_retry_count}`);

        // 获取最后一个错误事件
        const lastError = db.prepare(`
            SELECT type, payload
            FROM events
            WHERE task_id = ? AND type LIKE '%FAILED%'
            ORDER BY sequence DESC
            LIMIT 1
        `).get(task.id) as { type: string; payload: string } | undefined;

        if (lastError) {
            const payload = JSON.parse(lastError.payload);
            const errorMsg = payload.error?.message || payload.reason || '';
            console.log(`  Error: ${errorMsg}`);
        }
    }

    console.log('\n' + '-'.repeat(80));

    // 错误类型统计
    const errorTypes = db.prepare(`
        SELECT
            e.type,
            COUNT(*) as count
        FROM events e
        JOIN tasks t ON e.task_id = t.id
        WHERE t.created_at >= ?
          AND e.type LIKE '%FAILED%'
        GROUP BY e.type
        ORDER BY count DESC
    `).all(cutoff) as Array<{ type: string; count: number }>;

    console.log('\nError Type Summary:');
    for (const row of errorTypes) {
        console.log(`  ${row.type}: ${row.count}`);
    }
}

function showOrderbook(db: Database.Database, taskId: string, sequence: number): void {
    const snapshot = db.prepare(`
        SELECT *
        FROM orderbook_snapshots
        WHERE task_id = ? AND sequence = ?
    `).get(taskId, sequence) as Record<string, unknown> | undefined;

    if (!snapshot) {
        console.error(`Snapshot not found: task=${taskId}, sequence=${sequence}`);
        return;
    }

    console.log('\n' + '='.repeat(60));
    console.log(`Orderbook Snapshot: ${taskId} #${sequence}`);
    console.log('='.repeat(60));
    console.log(`Time: ${formatTimestamp(snapshot.timestamp as number)}`);
    console.log(`Trigger: ${snapshot.trigger_type}`);
    console.log('');

    console.log('Predict:');
    if (snapshot.predict_best_bid || snapshot.predict_best_ask) {
        console.log(`  Best Bid: ${snapshot.predict_best_bid || 'N/A'}`);
        console.log(`  Best Ask: ${snapshot.predict_best_ask || 'N/A'}`);
        console.log(`  Spread: ${snapshot.predict_spread || 'N/A'}`);
        console.log(`  Latency: ${snapshot.predict_latency_ms}ms`);
        if (snapshot.predict_depth_json) {
            const depth = JSON.parse(snapshot.predict_depth_json as string);
            console.log(`  Depth: ${depth.bids?.length || 0} bids, ${depth.asks?.length || 0} asks`);
        }
    } else {
        console.log('  N/A');
    }
    console.log('');

    console.log('Polymarket:');
    if (snapshot.poly_best_bid || snapshot.poly_best_ask) {
        console.log(`  Best Bid: ${snapshot.poly_best_bid || 'N/A'}`);
        console.log(`  Best Ask: ${snapshot.poly_best_ask || 'N/A'}`);
        console.log(`  Spread: ${snapshot.poly_spread || 'N/A'}`);
        console.log(`  Latency: ${snapshot.poly_latency_ms}ms`);
        if (snapshot.poly_depth_json) {
            const depth = JSON.parse(snapshot.poly_depth_json as string);
            console.log(`  Depth: ${depth.bids?.length || 0} bids, ${depth.asks?.length || 0} asks`);
        }
    } else {
        console.log('  N/A');
    }
    console.log('');

    console.log('Arb Metrics:');
    console.log(`  Total Cost: ${snapshot.total_cost}`);
    console.log(`  Profit %: ${(snapshot.profit_percent as number).toFixed(2)}%`);
    console.log(`  Valid: ${snapshot.is_arb_valid ? 'Yes' : 'No'}`);
    console.log(`  Max Depth: ${snapshot.max_depth}`);
    console.log('-'.repeat(60));
}

// ============================================================================
// 主程序
// ============================================================================

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command || !['timeline', 'stats', 'failures', 'orderbook'].includes(command)) {
        console.log('Usage:');
        console.log('  npx tsx src/terminal/query-task-logs.ts timeline <taskId>');
        console.log('  npx tsx src/terminal/query-task-logs.ts stats [--days=7]');
        console.log('  npx tsx src/terminal/query-task-logs.ts failures [--days=7]');
        console.log('  npx tsx src/terminal/query-task-logs.ts orderbook <taskId> <sequence>');
        process.exit(1);
    }

    if (!fs.existsSync(DB_PATH)) {
        console.error(`Database not found: ${DB_PATH}`);
        console.error('Run "npx tsx src/terminal/import-logs-to-sqlite.ts --all" first');
        process.exit(1);
    }

    const db = new Database(DB_PATH, { readonly: true });

    try {
        switch (command) {
            case 'timeline': {
                const taskId = args[1];
                if (!taskId) {
                    console.error('Usage: timeline <taskId>');
                    process.exit(1);
                }
                showTimeline(db, taskId);
                break;
            }

            case 'stats': {
                let days = 7;
                for (const arg of args) {
                    if (arg.startsWith('--days=')) {
                        days = parseInt(arg.replace('--days=', ''), 10);
                    }
                }
                showStats(db, days);
                break;
            }

            case 'failures': {
                let days = 7;
                for (const arg of args) {
                    if (arg.startsWith('--days=')) {
                        days = parseInt(arg.replace('--days=', ''), 10);
                    }
                }
                showFailures(db, days);
                break;
            }

            case 'orderbook': {
                const taskId = args[1];
                const sequence = parseInt(args[2], 10);
                if (!taskId || isNaN(sequence)) {
                    console.error('Usage: orderbook <taskId> <sequence>');
                    process.exit(1);
                }
                showOrderbook(db, taskId, sequence);
                break;
            }
        }
    } finally {
        db.close();
    }
}

main().catch(console.error);
