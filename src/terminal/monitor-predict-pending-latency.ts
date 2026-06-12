import dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { createTelegramNotifier, type TelegramNotifier } from '../notification/telegram.js';
import { getPredictOrderWatcher, stopPredictOrderWatcher } from '../services/predict-order-watcher.js';
import type { WalletEventData } from '../services/predict-ws-client.js';

type TrackKey = string;

interface OrderTrack {
    key: TrackKey;
    orderId?: string;
    orderHash?: string;
    txHash?: string;
    marketId?: number;
    pendingAt?: number;
    confirmedAt?: number;
    firstFillAt?: number;
    failedAt?: number;
    lastEventType?: string;
    reason?: string;
    pendingNotified: boolean;
    confirmedNotified: boolean;
    fillNotified: boolean;
    failedNotified: boolean;
}

interface MonitorStats {
    pendingCount: number;
    confirmedCount: number;
    failedCount: number;
    fillCount: number;
    pendingToConfirmedMs: number[];
    pendingToFirstFillMs: number[];
    pendingToFailedMs: number[];
}

interface JsonLogLine {
    ts: string;
    kind: string;
    payload: Record<string, unknown>;
}

const DEFAULT_DURATION_MS = 0;
function getPositiveIntegerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function formatDuration(ms?: number): string {
    if (ms === undefined || !Number.isFinite(ms)) return 'n/a';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(3)}s`;
}

function formatTimestamp(ts?: number): string {
    if (!ts) return 'n/a';
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function average(values: number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function successRate(stats: MonitorStats): number | null {
    const resolved = stats.confirmedCount + stats.failedCount;
    if (resolved === 0) return null;
    return stats.confirmedCount / resolved;
}

function normalizeId(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    const str = String(value).trim();
    return str ? str : undefined;
}

function createTelegram(): TelegramNotifier | null {
    const token = process.env.TELEGRAM_BOT_TOKEN || '';
    const chatId = process.env.TELEGRAM_CHAT_ID || '';
    if (!token || !chatId) return null;
    return createTelegramNotifier({
        botToken: token,
        chatId,
        enabled: true,
    });
}

async function sendTelegramText(telegram: TelegramNotifier | null, text: string): Promise<void> {
    if (!telegram) return;
    try {
        await telegram.sendText(text);
    } catch (error: any) {
        console.error(`[TG] send failed: ${error?.message || error}`);
    }
}

function mkdirp(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
}

function buildLogPath(): string {
    const baseDir = path.join(process.cwd(), 'data', 'logs', 'predict-pending-monitor');
    mkdirp(baseDir);
    const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\..+/, '');
    return path.join(baseDir, `predict-pending-monitor-${stamp}.jsonl`);
}

function appendLogLine(logPath: string, line: JsonLogLine): void {
    fs.appendFileSync(logPath, `${JSON.stringify(line)}\n`);
}

function buildSummary(stats: MonitorStats) {
    const avgConfirmed = average(stats.pendingToConfirmedMs);
    const avgFirstFill = average(stats.pendingToFirstFillMs);
    const avgFailed = average(stats.pendingToFailedMs);
    const rate = successRate(stats);

    return {
        pendingCount: stats.pendingCount,
        confirmedCount: stats.confirmedCount,
        failedCount: stats.failedCount,
        fillCount: stats.fillCount,
        avgPendingToConfirmedMs: avgConfirmed,
        avgPendingToFirstFillMs: avgFirstFill,
        avgPendingToFailedMs: avgFailed,
        successRate: rate,
    };
}

function summaryText(stats: MonitorStats): string {
    const summary = buildSummary(stats);
    const rateText = summary.successRate === null
        ? 'n/a'
        : `${(summary.successRate * 100).toFixed(1)}%`;
    return [
        `pending=${summary.pendingCount}`,
        `confirmed=${summary.confirmedCount}`,
        `failed=${summary.failedCount}`,
        `fill=${summary.fillCount}`,
        `avgPending->confirmed=${formatDuration(summary.avgPendingToConfirmedMs ?? undefined)}`,
        `avgPending->firstFill=${formatDuration(summary.avgPendingToFirstFillMs ?? undefined)}`,
        `successRate=${rateText}`,
    ].join(', ');
}

async function main(): Promise<void> {
    const durationMs = getPositiveIntegerEnv('PREDICT_PENDING_MONITOR_DURATION_MS', DEFAULT_DURATION_MS);
    const logPath = buildLogPath();
    const telegram = createTelegram();

    const stats: MonitorStats = {
        pendingCount: 0,
        confirmedCount: 0,
        failedCount: 0,
        fillCount: 0,
        pendingToConfirmedMs: [],
        pendingToFirstFillMs: [],
        pendingToFailedMs: [],
    };

    const tracks = new Map<TrackKey, OrderTrack>();
    const orderIdToKey = new Map<string, TrackKey>();
    const orderHashToKey = new Map<string, TrackKey>();
    const txHashToKey = new Map<string, TrackKey>();

    const watcher = getPredictOrderWatcher();
    const startedAt = Date.now();

    const resolveTrackKey = (event: WalletEventData): TrackKey => {
        const orderId = normalizeId(event.orderId);
        const orderHash = normalizeId(event.orderHash)?.toLowerCase();
        const txHash = normalizeId(event.txHash)?.toLowerCase();

        let key =
            (orderId && orderIdToKey.get(orderId)) ||
            (orderHash && orderHashToKey.get(orderHash)) ||
            (txHash && txHashToKey.get(txHash)) ||
            orderId ||
            orderHash ||
            txHash ||
            `unknown:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;

        if (orderId) orderIdToKey.set(orderId, key);
        if (orderHash) orderHashToKey.set(orderHash, key);
        if (txHash) txHashToKey.set(txHash, key);
        return key;
    };

    const getOrCreateTrack = (event: WalletEventData): OrderTrack => {
        const key = resolveTrackKey(event);
        let track = tracks.get(key);
        if (!track) {
            track = {
                key,
                pendingNotified: false,
                confirmedNotified: false,
                fillNotified: false,
                failedNotified: false,
            };
            tracks.set(key, track);
        }

        track.orderId = normalizeId(event.orderId) || track.orderId;
        track.orderHash = normalizeId(event.orderHash)?.toLowerCase() || track.orderHash;
        track.txHash = normalizeId(event.txHash)?.toLowerCase() || track.txHash;
        track.marketId = event.marketId ?? track.marketId;
        track.lastEventType = event.type;
        track.reason = event.reason || track.reason;
        return track;
    };

    const log = (kind: string, payload: Record<string, unknown>) => {
        appendLogLine(logPath, {
            ts: new Date().toISOString(),
            kind,
            payload,
        });
    };

    const emitSummaryLog = (reason: string) => {
        const summary = buildSummary(stats);
        console.log(`[PredictPendingMonitor] ${reason}: ${summaryText(stats)}`);
        log('summary', {
            reason,
            elapsedMs: Date.now() - startedAt,
            ...summary,
        });
    };

    await watcher.start();

    log('startup', {
        startedAt: new Date(startedAt).toISOString(),
        durationMs: durationMs > 0 ? durationMs : null,
        summaryMode: 'on_settlement_event',
        logPath,
    });

    console.log('[PredictPendingMonitor] started');
    console.log(`[PredictPendingMonitor] logPath=${logPath}`);
    console.log(`[PredictPendingMonitor] duration=${durationMs > 0 ? formatDuration(durationMs) : 'infinite'}`);
    console.log('[PredictPendingMonitor] summaryMode=on_settlement_event');

    await sendTelegramText(telegram, `🚀 <b>Predict pending 监控已启动</b>

<b>模式:</b> walletEvent pending/confirmed/fill 监控
<b>日志:</b> <code>${logPath}</code>
<b>运行时长:</b> ${durationMs > 0 ? formatDuration(durationMs) : '无限期'}
<b>汇总方式:</b> 每次成交相关消息后汇总
<b>时间:</b> ${formatTimestamp(startedAt)}`);

    const shutdown = async (reason: string, exitCode = 0) => {
        watcher.off('walletEvent', onWalletEvent);
        watcher.off('subscriptionLost', onSubscriptionLost);
        watcher.off('subscriptionRestored', onSubscriptionRestored);
        watcher.off('disconnected', onDisconnected);
        watcher.off('connected', onConnected);
        emitSummaryLog(reason);
        await sendTelegramText(telegram, `🛑 <b>Predict pending 监控停止</b>

<b>原因:</b> ${reason}
<b>运行时长:</b> ${formatDuration(Date.now() - startedAt)}
<b>统计:</b> ${summaryText(stats)}`);
        try {
            stopPredictOrderWatcher();
        } catch {
            // ignore
        }
        process.exit(exitCode);
    };

    const onSubscriptionLost = (info: any) => {
        console.warn(`[PredictPendingMonitor] subscription lost: ${JSON.stringify(info)}`);
        log('subscription_lost', {
            info,
            elapsedMs: Date.now() - startedAt,
        });
        void sendTelegramText(telegram, `⚠️ <b>Predict pending 订阅断开</b>

<b>原因:</b> <code>${JSON.stringify(info)}</code>
<b>时间:</b> ${formatTimestamp(Date.now())}`);
    };

    const onSubscriptionRestored = () => {
        console.log('[PredictPendingMonitor] subscription restored');
        log('subscription_restored', {
            elapsedMs: Date.now() - startedAt,
        });
        void sendTelegramText(telegram, `✅ <b>Predict pending 订阅已恢复</b>

<b>时间:</b> ${formatTimestamp(Date.now())}`);
    };

    const onDisconnected = () => {
        console.warn('[PredictPendingMonitor] watcher disconnected');
        log('disconnected', {
            elapsedMs: Date.now() - startedAt,
        });
    };

    const onConnected = () => {
        console.log('[PredictPendingMonitor] watcher connected');
        log('connected', {
            elapsedMs: Date.now() - startedAt,
        });
    };

    const onWalletEvent = (event: WalletEventData) => {
        const track = getOrCreateTrack(event);
        const receivedAt = Date.now();

        log('wallet_event', {
            key: track.key,
            eventType: event.type,
            orderId: track.orderId,
            orderHash: track.orderHash,
            txHash: track.txHash,
            marketId: track.marketId,
            filledQty: event.filledQty ?? null,
            avgPrice: event.avgPrice ?? null,
            eventTimestamp: event.timestamp,
            receivedAt,
            reason: event.reason ?? null,
        });

        if (event.type === 'ORDER_TX_PENDING') {
            if (!track.pendingAt) {
                track.pendingAt = receivedAt;
                stats.pendingCount += 1;
                console.log(`[PredictPendingMonitor] pending key=${track.key} orderId=${track.orderId ?? 'n/a'} orderHash=${track.orderHash ?? 'n/a'} txHash=${track.txHash ?? 'n/a'}`);
            }
            if (!track.pendingNotified) {
                track.pendingNotified = true;
                void sendTelegramText(telegram, `🟠 <b>Predict TX_PENDING</b>

<b>orderId:</b> <code>${track.orderId ?? 'n/a'}</code>
<b>orderHash:</b> <code>${track.orderHash ?? 'n/a'}</code>
<b>txHash:</b> <code>${track.txHash ?? 'n/a'}</code>
<b>marketId:</b> <code>${track.marketId ?? 'n/a'}</code>
<b>时间:</b> ${formatTimestamp(track.pendingAt)}`);
            }
            return;
        }

        if (event.type === 'ORDER_TX_CONFIRMED') {
            if (!track.confirmedAt) {
                track.confirmedAt = receivedAt;
                stats.confirmedCount += 1;
                if (track.pendingAt) {
                    stats.pendingToConfirmedMs.push(track.confirmedAt - track.pendingAt);
                }
                console.log(`[PredictPendingMonitor] confirmed key=${track.key} latency=${formatDuration(track.pendingAt ? track.confirmedAt - track.pendingAt : undefined)}`);
            }
            if (!track.confirmedNotified) {
                track.confirmedNotified = true;
                void sendTelegramText(telegram, `✅ <b>Predict TX_CONFIRMED</b>

<b>orderId:</b> <code>${track.orderId ?? 'n/a'}</code>
<b>orderHash:</b> <code>${track.orderHash ?? 'n/a'}</code>
<b>txHash:</b> <code>${track.txHash ?? 'n/a'}</code>
<b>pending→confirmed:</b> ${formatDuration(track.pendingAt && track.confirmedAt ? track.confirmedAt - track.pendingAt : undefined)}
<b>平均 pending→confirmed:</b> ${formatDuration(average(stats.pendingToConfirmedMs) ?? undefined)}
<b>confirmed 成功率:</b> ${(() => {
                    const rate = successRate(stats);
                    return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
                })()}`);
            }
            emitSummaryLog(`after_${event.type.toLowerCase()}`);
            return;
        }

        if (event.type === 'ORDER_TX_FAILED') {
            if (!track.failedAt) {
                track.failedAt = receivedAt;
                stats.failedCount += 1;
                if (track.pendingAt) {
                    stats.pendingToFailedMs.push(track.failedAt - track.pendingAt);
                }
                console.warn(`[PredictPendingMonitor] failed key=${track.key} latency=${formatDuration(track.pendingAt ? track.failedAt - track.pendingAt : undefined)} reason=${track.reason ?? 'n/a'}`);
            }
            if (!track.failedNotified) {
                track.failedNotified = true;
                void sendTelegramText(telegram, `❌ <b>Predict TX_FAILED</b>

<b>orderId:</b> <code>${track.orderId ?? 'n/a'}</code>
<b>orderHash:</b> <code>${track.orderHash ?? 'n/a'}</code>
<b>txHash:</b> <code>${track.txHash ?? 'n/a'}</code>
<b>pending→failed:</b> ${formatDuration(track.pendingAt && track.failedAt ? track.failedAt - track.pendingAt : undefined)}
<b>原因:</b> <code>${track.reason ?? 'n/a'}</code>
<b>confirmed 成功率:</b> ${(() => {
                    const rate = successRate(stats);
                    return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
                })()}`);
            }
            emitSummaryLog(`after_${event.type.toLowerCase()}`);
            return;
        }

        if (event.type === 'ORDER_FILLED' || event.type === 'ORDER_PARTIALLY_FILLED') {
            if (!track.firstFillAt) {
                track.firstFillAt = receivedAt;
                stats.fillCount += 1;
                if (track.pendingAt) {
                    stats.pendingToFirstFillMs.push(track.firstFillAt - track.pendingAt);
                }
                console.log(`[PredictPendingMonitor] first fill key=${track.key} type=${event.type} latency=${formatDuration(track.pendingAt ? track.firstFillAt - track.pendingAt : undefined)}`);
            }
            if (!track.fillNotified) {
                track.fillNotified = true;
                void sendTelegramText(telegram, `📡 <b>Predict 首次 Fill</b>

<b>事件:</b> ${event.type}
<b>orderId:</b> <code>${track.orderId ?? 'n/a'}</code>
<b>orderHash:</b> <code>${track.orderHash ?? 'n/a'}</code>
<b>txHash:</b> <code>${track.txHash ?? 'n/a'}</code>
<b>filledQty:</b> <code>${event.filledQty ?? 'n/a'}</code>
<b>pending→firstFill:</b> ${formatDuration(track.pendingAt && track.firstFillAt ? track.firstFillAt - track.pendingAt : undefined)}
<b>平均 pending→firstFill:</b> ${formatDuration(average(stats.pendingToFirstFillMs) ?? undefined)}`);
            }
            emitSummaryLog(`after_${event.type.toLowerCase()}`);
        }
    };

    watcher.on('walletEvent', onWalletEvent);
    watcher.on('subscriptionLost', onSubscriptionLost);
    watcher.on('subscriptionRestored', onSubscriptionRestored);
    watcher.on('disconnected', onDisconnected);
    watcher.on('connected', onConnected);

    process.on('SIGINT', () => {
        void shutdown('SIGINT', 0);
    });
    process.on('SIGTERM', () => {
        void shutdown('SIGTERM', 0);
    });

    if (durationMs > 0) {
        setTimeout(() => {
            void shutdown('duration_elapsed', 0);
        }, durationMs);
    }
}

main().catch((error: any) => {
    console.error('[PredictPendingMonitor] fatal:', error?.message || error);
    process.exit(1);
});
