/**
 * JSONL 日志导入 SQLite 工具
 *
 * 功能：
 * - 读取任务日志 JSONL 文件
 * - 导入到 SQLite 数据库
 * - 支持幂等去重 (task_id + sequence)
 * - 批量插入优化
 *
 * 使用：
 *   npx tsx src/terminal/import-logs-to-sqlite.ts --task=<taskId>
 *   npx tsx src/terminal/import-logs-to-sqlite.ts --all
 */

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

// ============================================================================
// 配置
// ============================================================================

const LOGS_BASE_DIR = path.join(process.cwd(), 'data', 'logs', 'tasks');
const DB_PATH = path.join(process.cwd(), 'data', 'logs', 'index.db');

// ============================================================================
// 类型
// ============================================================================

interface TaskLogEvent {
    timestamp: number;
    taskId: string;
    sequence: number;
    logSchemaVersion: string;
    executorId?: string;
    attemptId?: string;
    orderId?: string;
    orderHash?: string;
    priority: string;
    type: string;
    payload: Record<string, unknown>;
}

interface OrderBookSnapshot {
    timestamp: number;
    taskId: string;
    sequence: number;
    trigger: string;
    logSchemaVersion: string;
    predict: {
        bids: [number, number][];
        asks: [number, number][];
        bestBid: number | null;
        bestAsk: number | null;
        spread: number | null;
        latencyMs: number;
    } | null;
    polymarket: {
        bids: [number, number][];
        asks: [number, number][];
        bestBid: number | null;
        bestAsk: number | null;
        spread: number | null;
        latencyMs: number;
    } | null;
    arbMetrics: {
        totalCost: number;
        profitPercent: number;
        isValid: boolean;
        maxDepth: number;
    };
    priority: string;
}

interface TaskSummary {
    taskId: string;
    type: string;
    marketId: number;
    title: string;
    logSchemaVersion: string;
    status: string;
    isSuccess: boolean;
    totalEvents: number;
    totalSnapshots: number;
    eventCounts: Record<string, number>;
    startTime: number;
    endTime: number;
    durationMs: number;
    predictFilledQty: number;
    hedgedQty: number;
    avgPredictPrice: number;
    avgPolymarketPrice: number;
    actualProfit: number;
    profitPercent: number;
    unwindLoss: number;
    pauseCount: number;
    hedgeRetryCount: number;
    timeline: { timestamp: number; event: string; detail?: string }[];
    generatedAt: number;
}

// ============================================================================
// 数据库初始化
// ============================================================================

function initDatabase(db: Database.Database): void {
    // 任务主表
    db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            market_id INTEGER NOT NULL,
            title TEXT,
            status TEXT NOT NULL,
            predict_price REAL,
            polymarket_max_ask REAL,
            polymarket_min_bid REAL,
            quantity REAL NOT NULL,
            predict_filled_qty REAL DEFAULT 0,
            hedged_qty REAL DEFAULT 0,
            avg_predict_price REAL,
            avg_polymarket_price REAL,
            actual_profit REAL,
            profit_percent REAL,
            unwind_loss REAL,
            pause_count INTEGER DEFAULT 0,
            hedge_retry_count INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            completed_at INTEGER,
            duration_ms INTEGER,
            is_success INTEGER,
            imported_at INTEGER
        )
    `);

    // 事件表
    db.exec(`
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            timestamp INTEGER NOT NULL,
            type TEXT NOT NULL,
            priority TEXT,
            executor_id TEXT,
            attempt_id TEXT,
            order_id TEXT,
            order_hash TEXT,
            payload TEXT,
            UNIQUE(task_id, sequence),
            FOREIGN KEY (task_id) REFERENCES tasks(id)
        )
    `);

    // 订单簿快照表
    db.exec(`
        CREATE TABLE IF NOT EXISTS orderbook_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            timestamp INTEGER NOT NULL,
            trigger_type TEXT NOT NULL,
            predict_best_bid REAL,
            predict_best_ask REAL,
            predict_spread REAL,
            predict_latency_ms INTEGER,
            predict_depth_json TEXT,
            poly_best_bid REAL,
            poly_best_ask REAL,
            poly_spread REAL,
            poly_latency_ms INTEGER,
            poly_depth_json TEXT,
            total_cost REAL,
            profit_percent REAL,
            is_arb_valid INTEGER,
            max_depth REAL,
            UNIQUE(task_id, sequence),
            FOREIGN KEY (task_id) REFERENCES tasks(id)
        )
    `);

    // 订单表 (从事件中提取)
    db.exec(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            platform TEXT NOT NULL,
            order_id TEXT NOT NULL,
            side TEXT NOT NULL,
            price REAL NOT NULL,
            quantity REAL NOT NULL,
            filled_qty REAL DEFAULT 0,
            avg_price REAL,
            status TEXT,
            submitted_at INTEGER,
            filled_at INTEGER,
            UNIQUE(task_id, order_id),
            FOREIGN KEY (task_id) REFERENCES tasks(id)
        )
    `);

    // 索引
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
        CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_snapshots_task ON orderbook_snapshots(task_id);
        CREATE INDEX IF NOT EXISTS idx_orders_task ON orders(task_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
    `);

    console.log('[SQLite] Database initialized');
}

// ============================================================================
// 文件读取
// ============================================================================

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

function readSummary(taskDir: string): TaskSummary | null {
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
// 导入逻辑
// ============================================================================

function importTask(db: Database.Database, taskId: string): { events: number; snapshots: number; orders: number } {
    const taskDir = path.join(LOGS_BASE_DIR, taskId);

    if (!fs.existsSync(taskDir)) {
        console.error(`[Import] Task directory not found: ${taskDir}`);
        return { events: 0, snapshots: 0, orders: 0 };
    }

    // 读取 summary
    const summary = readSummary(taskDir);

    // 如果有 summary，先导入任务主表
    if (summary) {
        const insertTask = db.prepare(`
            INSERT OR REPLACE INTO tasks (
                id, type, market_id, title, status,
                predict_filled_qty, hedged_qty,
                avg_predict_price, avg_polymarket_price,
                actual_profit, profit_percent, unwind_loss,
                pause_count, hedge_retry_count,
                created_at, completed_at, duration_ms,
                is_success, imported_at
            ) VALUES (
                @id, @type, @marketId, @title, @status,
                @predictFilledQty, @hedgedQty,
                @avgPredictPrice, @avgPolymarketPrice,
                @actualProfit, @profitPercent, @unwindLoss,
                @pauseCount, @hedgeRetryCount,
                @createdAt, @completedAt, @durationMs,
                @isSuccess, @importedAt
            )
        `);

        insertTask.run({
            id: summary.taskId,
            type: summary.type,
            marketId: summary.marketId,
            title: summary.title,
            status: summary.status,
            predictFilledQty: summary.predictFilledQty,
            hedgedQty: summary.hedgedQty,
            avgPredictPrice: summary.avgPredictPrice,
            avgPolymarketPrice: summary.avgPolymarketPrice,
            actualProfit: summary.actualProfit,
            profitPercent: summary.profitPercent,
            unwindLoss: summary.unwindLoss,
            pauseCount: summary.pauseCount,
            hedgeRetryCount: summary.hedgeRetryCount,
            createdAt: summary.startTime,
            completedAt: summary.endTime,
            durationMs: summary.durationMs,
            isSuccess: summary.isSuccess ? 1 : 0,
            importedAt: Date.now(),
        });
    }

    // 读取并导入事件
    const eventsPath = path.join(taskDir, 'events.jsonl');
    const events = readJsonl<TaskLogEvent>(eventsPath);

    const insertEvent = db.prepare(`
        INSERT OR IGNORE INTO events (
            task_id, sequence, timestamp, type, priority,
            executor_id, attempt_id, order_id, order_hash, payload
        ) VALUES (
            @taskId, @sequence, @timestamp, @type, @priority,
            @executorId, @attemptId, @orderId, @orderHash, @payload
        )
    `);

    const insertOrder = db.prepare(`
        INSERT OR REPLACE INTO orders (
            task_id, platform, order_id, side, price, quantity,
            filled_qty, avg_price, status, submitted_at, filled_at
        ) VALUES (
            @taskId, @platform, @orderId, @side, @price, @quantity,
            @filledQty, @avgPrice, @status, @submittedAt, @filledAt
        )
    `);

    let eventCount = 0;
    let orderCount = 0;

    const insertEvents = db.transaction(() => {
        for (const event of events) {
            insertEvent.run({
                taskId: event.taskId,
                sequence: event.sequence,
                timestamp: event.timestamp,
                type: event.type,
                priority: event.priority,
                executorId: event.executorId || null,
                attemptId: event.attemptId || null,
                orderId: event.orderId || null,
                orderHash: event.orderHash || null,
                payload: JSON.stringify(event.payload),
            });
            eventCount++;

            // 提取订单信息
            if (event.type.startsWith('ORDER_')) {
                const p = event.payload as Record<string, unknown>;
                insertOrder.run({
                    taskId: event.taskId,
                    platform: p.platform as string,
                    orderId: p.orderId as string,
                    side: p.side as string,
                    price: p.price as number,
                    quantity: p.quantity as number,
                    filledQty: p.filledQty as number,
                    avgPrice: p.avgPrice as number,
                    status: event.type.replace('ORDER_', ''),
                    submittedAt: event.type === 'ORDER_SUBMITTED' ? event.timestamp : null,
                    filledAt: event.type === 'ORDER_FILLED' ? event.timestamp : null,
                });
                orderCount++;
            }
        }
    });

    insertEvents();

    // 读取并导入快照
    const snapshotsPath = path.join(taskDir, 'orderbooks.jsonl');
    const snapshots = readJsonl<OrderBookSnapshot>(snapshotsPath);

    const insertSnapshot = db.prepare(`
        INSERT OR IGNORE INTO orderbook_snapshots (
            task_id, sequence, timestamp, trigger_type,
            predict_best_bid, predict_best_ask, predict_spread, predict_latency_ms, predict_depth_json,
            poly_best_bid, poly_best_ask, poly_spread, poly_latency_ms, poly_depth_json,
            total_cost, profit_percent, is_arb_valid, max_depth
        ) VALUES (
            @taskId, @sequence, @timestamp, @trigger,
            @predictBestBid, @predictBestAsk, @predictSpread, @predictLatencyMs, @predictDepthJson,
            @polyBestBid, @polyBestAsk, @polySpread, @polyLatencyMs, @polyDepthJson,
            @totalCost, @profitPercent, @isArbValid, @maxDepth
        )
    `);

    let snapshotCount = 0;

    const insertSnapshots = db.transaction(() => {
        for (const snapshot of snapshots) {
            insertSnapshot.run({
                taskId: snapshot.taskId,
                sequence: snapshot.sequence,
                timestamp: snapshot.timestamp,
                trigger: snapshot.trigger,
                predictBestBid: snapshot.predict?.bestBid ?? null,
                predictBestAsk: snapshot.predict?.bestAsk ?? null,
                predictSpread: snapshot.predict?.spread ?? null,
                predictLatencyMs: snapshot.predict?.latencyMs ?? null,
                predictDepthJson: snapshot.predict ? JSON.stringify({
                    bids: snapshot.predict.bids,
                    asks: snapshot.predict.asks,
                }) : null,
                polyBestBid: snapshot.polymarket?.bestBid ?? null,
                polyBestAsk: snapshot.polymarket?.bestAsk ?? null,
                polySpread: snapshot.polymarket?.spread ?? null,
                polyLatencyMs: snapshot.polymarket?.latencyMs ?? null,
                polyDepthJson: snapshot.polymarket ? JSON.stringify({
                    bids: snapshot.polymarket.bids,
                    asks: snapshot.polymarket.asks,
                }) : null,
                totalCost: snapshot.arbMetrics.totalCost,
                profitPercent: snapshot.arbMetrics.profitPercent,
                isArbValid: snapshot.arbMetrics.isValid ? 1 : 0,
                maxDepth: snapshot.arbMetrics.maxDepth,
            });
            snapshotCount++;
        }
    });

    insertSnapshots();

    return { events: eventCount, snapshots: snapshotCount, orders: orderCount };
}

function importAllTasks(db: Database.Database): void {
    if (!fs.existsSync(LOGS_BASE_DIR)) {
        console.error(`[Import] Logs directory not found: ${LOGS_BASE_DIR}`);
        return;
    }

    const taskDirs = fs.readdirSync(LOGS_BASE_DIR);
    let totalEvents = 0;
    let totalSnapshots = 0;
    let totalOrders = 0;

    for (const taskId of taskDirs) {
        const taskDir = path.join(LOGS_BASE_DIR, taskId);
        const stat = fs.statSync(taskDir);

        if (!stat.isDirectory()) continue;

        const result = importTask(db, taskId);
        totalEvents += result.events;
        totalSnapshots += result.snapshots;
        totalOrders += result.orders;

        console.log(`[Import] ${taskId}: ${result.events} events, ${result.snapshots} snapshots, ${result.orders} orders`);
    }

    console.log(`\n[Import] Total: ${taskDirs.length} tasks, ${totalEvents} events, ${totalSnapshots} snapshots, ${totalOrders} orders`);
}

// ============================================================================
// 主程序
// ============================================================================

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    // 解析参数
    let taskId: string | null = null;
    let importAll = false;

    for (const arg of args) {
        if (arg.startsWith('--task=')) {
            taskId = arg.replace('--task=', '');
        } else if (arg === '--all') {
            importAll = true;
        }
    }

    if (!taskId && !importAll) {
        console.log('Usage:');
        console.log('  npx tsx src/terminal/import-logs-to-sqlite.ts --task=<taskId>');
        console.log('  npx tsx src/terminal/import-logs-to-sqlite.ts --all');
        process.exit(1);
    }

    // 确保数据库目录存在
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    // 打开数据库
    const db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');

    try {
        // 初始化表结构
        initDatabase(db);

        if (importAll) {
            importAllTasks(db);
        } else if (taskId) {
            const result = importTask(db, taskId);
            console.log(`[Import] ${taskId}: ${result.events} events, ${result.snapshots} snapshots, ${result.orders} orders`);
        }
    } finally {
        db.close();
    }
}

main().catch(console.error);
