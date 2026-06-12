import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

export type HedgeTimingPhase =
    | 'submit'
    | 'submit_failed'
    | 'reconcile'
    | 'reconcile_failed';

export type HedgeTimingStrategy =
    | 'PREDICT_MAKER_FAST_HEDGE'
    | 'PREDICT_MAKER_INCREMENTAL'
    | 'TAKER'
    | 'POLY_MAKER';

export type HedgeFillSource =
    | 'predict_ws'
    | 'bsc_wss'
    | 'pending'
    | 'rest_poll'
    | 'delayed_fill'
    | 'unknown';

export interface PolyOrderSubmitTiming {
    initializedOnPath: boolean;
    initMs?: number;
    feeRateMs?: number;
    amountBuildMs?: number;
    orderBuildMs?: number;
    signMs?: number;
    serializeMs?: number;
    headerMs?: number;
    httpSubmitMs?: number;
    parseResponseMs?: number;
    totalMs: number;
    retryWithFeeRate?: boolean;
    retryAttemptMs?: number;
}

export interface HedgeTimingEvent {
    schemaVersion?: 'hedge-timing/v1';
    ts?: number;
    taskId: string;
    attemptId: string;
    phase: HedgeTimingPhase;
    strategy: HedgeTimingStrategy;
    fillSource?: HedgeFillSource;
    side: 'BUY' | 'SELL';
    qty: number;
    price: number;
    tokenId?: string;
    orderId?: string;
    resultStatus?: string;
    error?: string;
    fillToSubmitStartMs?: number;
    polyPlaceOrderMs?: number;
    watchMs?: number;
    e2eToTerminalMs?: number;
    watchDelta?: number;
    statusPollCount?: number;
    statusPollSource?: string;
    redispatchCount?: number;
    zeroFillCount?: number;
    unknownCount?: number;
    polyOrderTiming?: PolyOrderSubmitTiming;
}

export interface HedgeTimingReviewOptions {
    baseDir?: string;
    lastEvents?: number;
    writeReview?: boolean;
}

export interface HedgeTimingReview {
    generatedAt: string;
    baseDir: string;
    eventCount: number;
    completedTradeCount: number;
    window: {
        firstTs?: number;
        lastTs?: number;
        firstIso?: string;
        lastIso?: string;
    };
    metrics: Record<string, MetricSummary>;
    bottlenecks: string[];
    reviewFiles?: {
        json?: string;
        markdown?: string;
    };
}

export interface MetricSummary {
    count: number;
    p50?: number;
    p95?: number;
    p99?: number;
    max?: number;
}

const DEFAULT_BASE_DIR = './data/logs/hedge-timing';
const DEFAULT_REVIEW_THRESHOLD = 100;
const DEFAULT_REVIEW_MIN_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_REVIEW_LAST_EVENTS = 1000;

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined || value === '') return fallback;
    const normalized = value.toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMs(value: number | undefined): number | undefined {
    if (value === undefined || !Number.isFinite(value)) return undefined;
    return Math.round(value * 1000) / 1000;
}

function clampSampleRate(value: number): number {
    if (!Number.isFinite(value)) return 1;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
}

function utcDayFile(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10) + '.jsonl';
}

function isCompletionEvent(event: HedgeTimingEvent): boolean {
    return event.phase === 'reconcile' || event.phase === 'reconcile_failed';
}

function safeError(message: string | undefined): string | undefined {
    if (!message) return undefined;
    return message.replace(/\s+/g, ' ').slice(0, 300);
}

export class HedgeTimingLogger {
    private readonly enabled: boolean;
    private readonly baseDir: string;
    private readonly sampleRate: number;
    private readonly reviewThreshold: number;
    private readonly reviewMinIntervalMs: number;
    private readonly reviewLastEvents: number;
    private tradeCountSinceReview = 0;
    private lastReviewAt = 0;
    private reviewInProgress = false;

    constructor() {
        this.enabled = boolFromEnv(process.env.HEDGE_TIMING_ENABLED, false);
        this.baseDir = path.resolve(process.env.HEDGE_TIMING_LOG_DIR || DEFAULT_BASE_DIR);
        this.sampleRate = clampSampleRate(numberFromEnv(process.env.HEDGE_TIMING_SAMPLE_RATE, 1));
        this.reviewThreshold = Math.max(0, Math.floor(numberFromEnv(
            process.env.HEDGE_TIMING_REVIEW_TRADE_THRESHOLD,
            DEFAULT_REVIEW_THRESHOLD,
        )));
        this.reviewMinIntervalMs = Math.max(0, numberFromEnv(
            process.env.HEDGE_TIMING_REVIEW_MIN_INTERVAL_MS,
            DEFAULT_REVIEW_MIN_INTERVAL_MS,
        ));
        this.reviewLastEvents = Math.max(1, Math.floor(numberFromEnv(
            process.env.HEDGE_TIMING_REVIEW_LAST_EVENTS,
            DEFAULT_REVIEW_LAST_EVENTS,
        )));

        if (this.enabled) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    log(event: HedgeTimingEvent): void {
        if (!this.enabled) return;
        if (this.sampleRate <= 0 || Math.random() > this.sampleRate) return;

        const enriched: HedgeTimingEvent = {
            ...event,
            schemaVersion: 'hedge-timing/v1',
            ts: event.ts ?? Date.now(),
            error: safeError(event.error),
            fillToSubmitStartMs: roundMs(event.fillToSubmitStartMs),
            polyPlaceOrderMs: roundMs(event.polyPlaceOrderMs),
            watchMs: roundMs(event.watchMs),
            e2eToTerminalMs: roundMs(event.e2eToTerminalMs),
        };

        void this.appendAndMaybeReview(enriched).catch((error) => {
            console.warn('[HedgeTiming] write failed:', (error as Error).message);
        });
    }

    private async appendAndMaybeReview(event: HedgeTimingEvent): Promise<void> {
        await fsPromises.mkdir(this.baseDir, { recursive: true });
        const fileName = utcDayFile(event.ts ?? Date.now());
        const filePath = path.join(this.baseDir, fileName);
        await fsPromises.appendFile(filePath, JSON.stringify(event) + '\n', 'utf-8');

        if (!isCompletionEvent(event) || this.reviewThreshold <= 0) return;

        this.tradeCountSinceReview++;
        if (this.tradeCountSinceReview < this.reviewThreshold) return;

        const now = Date.now();
        if (this.reviewInProgress || now - this.lastReviewAt < this.reviewMinIntervalMs) return;

        this.tradeCountSinceReview = 0;
        this.reviewInProgress = true;
        this.lastReviewAt = now;
        try {
            const review = await generateHedgeTimingReview({
                baseDir: this.baseDir,
                lastEvents: this.reviewLastEvents,
                writeReview: true,
            });
            console.log(
                `[HedgeTiming] log review generated: events=${review.eventCount}, trades=${review.completedTradeCount}` +
                (review.reviewFiles?.markdown ? `, file=${review.reviewFiles.markdown}` : ''),
            );
        } catch (error) {
            console.warn('[HedgeTiming] review failed:', (error as Error).message);
        } finally {
            this.reviewInProgress = false;
        }
    }
}

let instance: HedgeTimingLogger | null = null;

export function getHedgeTimingLogger(): HedgeTimingLogger {
    if (!instance) {
        instance = new HedgeTimingLogger();
    }
    return instance;
}

async function readJsonlFile(filePath: string): Promise<HedgeTimingEvent[]> {
    const text = await fsPromises.readFile(filePath, 'utf-8');
    const events: HedgeTimingEvent[] = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            events.push(JSON.parse(trimmed) as HedgeTimingEvent);
        } catch {
            // Keep report generation best-effort for partially written lines.
        }
    }
    return events;
}

export async function readRecentHedgeTimingEvents(
    baseDir = path.resolve(process.env.HEDGE_TIMING_LOG_DIR || DEFAULT_BASE_DIR),
    lastEvents = DEFAULT_REVIEW_LAST_EVENTS,
): Promise<HedgeTimingEvent[]> {
    if (!fs.existsSync(baseDir)) return [];
    const files = (await fsPromises.readdir(baseDir))
        .filter(file => file.endsWith('.jsonl'))
        .sort()
        .reverse();

    const events: HedgeTimingEvent[] = [];
    for (const file of files) {
        const fileEvents = await readJsonlFile(path.join(baseDir, file));
        events.unshift(...fileEvents);
        if (events.length >= lastEvents) break;
    }

    return events
        .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
        .slice(-lastEvents);
}

function percentile(sorted: number[], ratio: number): number | undefined {
    if (sorted.length === 0) return undefined;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
    return roundMs(sorted[idx]);
}

function summarize(values: Array<number | undefined>): MetricSummary {
    const nums = values
        .filter((value): value is number => value !== undefined && Number.isFinite(value))
        .sort((a, b) => a - b);
    return {
        count: nums.length,
        p50: percentile(nums, 0.50),
        p95: percentile(nums, 0.95),
        p99: percentile(nums, 0.99),
        max: nums.length ? roundMs(nums[nums.length - 1]) : undefined,
    };
}

function addMetric(
    metrics: Record<string, MetricSummary>,
    name: string,
    events: HedgeTimingEvent[],
    selector: (event: HedgeTimingEvent) => number | undefined,
): void {
    metrics[name] = summarize(events.map(selector));
}

function buildBottlenecks(metrics: Record<string, MetricSummary>): string[] {
    const items: string[] = [];
    const p95 = (name: string): number => metrics[name]?.p95 ?? 0;

    if (p95('fillToSubmitStartMs') > 20) {
        items.push('fill_to_submit_start p95 is above 20ms; inspect fill callback scheduling and merge/check work.');
    }
    if (p95('polyOrderTiming.initMs') > 0) {
        items.push('Polymarket init is still on the hedge submit path; pre-warm trader init before live tasks.');
    }
    if (p95('polyOrderTiming.feeRateMs') > 25) {
        items.push('feeRate lookup contributes to submit latency; pre-warm or refresh fee cache before order submit.');
    }
    if (p95('polyOrderTiming.signMs') > 20) {
        items.push('signTypedData is a visible cost; keep signing inputs minimal and measure wallet/provider stalls.');
    }
    if (p95('polyOrderTiming.httpSubmitMs') > 120) {
        items.push('Polymarket HTTP submit dominates submit latency; compare network path, retry rate, and CLOB status.');
    }
    if (p95('watchMs') > 500) {
        items.push('order status confirmation is slow; review adaptive polling and user-ws cache hit rate.');
    }
    if (items.length === 0) {
        items.push('No single high-confidence bottleneck crossed the default review thresholds.');
    }

    return items;
}

export async function generateHedgeTimingReview(
    options: HedgeTimingReviewOptions = {},
): Promise<HedgeTimingReview> {
    const baseDir = path.resolve(options.baseDir || process.env.HEDGE_TIMING_LOG_DIR || DEFAULT_BASE_DIR);
    const events = await readRecentHedgeTimingEvents(baseDir, options.lastEvents ?? DEFAULT_REVIEW_LAST_EVENTS);
    const completed = events.filter(isCompletionEvent);
    const metrics: Record<string, MetricSummary> = {};

    addMetric(metrics, 'fillToSubmitStartMs', events, event => event.fillToSubmitStartMs);
    addMetric(metrics, 'polyPlaceOrderMs', events, event => event.polyPlaceOrderMs);
    addMetric(metrics, 'watchMs', completed, event => event.watchMs);
    addMetric(metrics, 'e2eToTerminalMs', completed, event => event.e2eToTerminalMs);
    addMetric(metrics, 'statusPollCount', completed, event => event.statusPollCount);
    addMetric(metrics, 'polyOrderTiming.initMs', events, event => event.polyOrderTiming?.initMs);
    addMetric(metrics, 'polyOrderTiming.feeRateMs', events, event => event.polyOrderTiming?.feeRateMs);
    addMetric(metrics, 'polyOrderTiming.amountBuildMs', events, event => event.polyOrderTiming?.amountBuildMs);
    addMetric(metrics, 'polyOrderTiming.orderBuildMs', events, event => event.polyOrderTiming?.orderBuildMs);
    addMetric(metrics, 'polyOrderTiming.signMs', events, event => event.polyOrderTiming?.signMs);
    addMetric(metrics, 'polyOrderTiming.headerMs', events, event => event.polyOrderTiming?.headerMs);
    addMetric(metrics, 'polyOrderTiming.httpSubmitMs', events, event => event.polyOrderTiming?.httpSubmitMs);
    addMetric(metrics, 'polyOrderTiming.parseResponseMs', events, event => event.polyOrderTiming?.parseResponseMs);
    addMetric(metrics, 'polyOrderTiming.totalMs', events, event => event.polyOrderTiming?.totalMs);

    const firstTs = events[0]?.ts;
    const lastTs = events[events.length - 1]?.ts;
    const review: HedgeTimingReview = {
        generatedAt: new Date().toISOString(),
        baseDir,
        eventCount: events.length,
        completedTradeCount: completed.length,
        window: {
            firstTs,
            lastTs,
            firstIso: firstTs ? new Date(firstTs).toISOString() : undefined,
            lastIso: lastTs ? new Date(lastTs).toISOString() : undefined,
        },
        metrics,
        bottlenecks: buildBottlenecks(metrics),
    };

    if (options.writeReview) {
        const reviewDir = path.join(baseDir, 'reviews');
        await fsPromises.mkdir(reviewDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const jsonPath = path.join(reviewDir, `hedge-review-${stamp}.json`);
        const mdPath = path.join(reviewDir, `hedge-review-${stamp}.md`);
        await fsPromises.writeFile(jsonPath, JSON.stringify(review, null, 2) + '\n', 'utf-8');
        await fsPromises.writeFile(mdPath, formatHedgeTimingReview(review), 'utf-8');
        review.reviewFiles = { json: jsonPath, markdown: mdPath };
    }

    return review;
}

export function formatHedgeTimingReview(review: HedgeTimingReview): string {
    const metricLines = Object.entries(review.metrics)
        .map(([name, metric]) =>
            `| ${name} | ${metric.count} | ${metric.p50 ?? ''} | ${metric.p95 ?? ''} | ${metric.p99 ?? ''} | ${metric.max ?? ''} |`)
        .join('\n');
    const bottlenecks = review.bottlenecks.map(item => `- ${item}`).join('\n');

    return [
        '# Hedge Timing Review',
        '',
        `Generated: ${review.generatedAt}`,
        `Window: ${review.window.firstIso ?? 'n/a'} - ${review.window.lastIso ?? 'n/a'}`,
        `Events: ${review.eventCount}`,
        `Completed trades: ${review.completedTradeCount}`,
        '',
        '## Metrics',
        '',
        '| Metric | Count | p50 ms | p95 ms | p99 ms | max ms |',
        '| --- | ---: | ---: | ---: | ---: | ---: |',
        metricLines || '| n/a | 0 |  |  |  |  |',
        '',
        '## Review',
        '',
        bottlenecks,
        '',
    ].join('\n');
}
