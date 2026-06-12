/**
 * POLY_MAKER 对冲聚合指标
 *
 * 对齐 PREDICT_MAKER 的 fastHedgeMetrics 模式，并额外提供 e2e p95。
 * 抽为纯函数便于单元测试。
 */

import type { PolyMakerContext } from './types.js';

/** e2e 样本环形缓冲上限 */
export const E2E_RING_CAPACITY = 100;
/** p95 计算所需最小样本数，低于此值显示 "?" */
export const P95_MIN_SAMPLES = 5;

export interface HedgeMetrics {
    completedCount: number;
    failedCount: number;
    totalElapsedMs: number;
    totalE2eMs: number;
    elapsedSamples: number;
    e2eSamples: number;
    totalRetries: number;
    e2eRing: number[];
}

/** 创建空 metrics */
export function createEmptyMetrics(): HedgeMetrics {
    return {
        completedCount: 0,
        failedCount: 0,
        totalElapsedMs: 0,
        totalE2eMs: 0,
        elapsedSamples: 0,
        e2eSamples: 0,
        totalRetries: 0,
        e2eRing: [],
    };
}

/** 确保 ctx 上 metrics 存在 (lazy init) */
export function ensureHedgeMetrics(ctx: PolyMakerContext): HedgeMetrics {
    if (!ctx.hedgeMetrics) {
        ctx.hedgeMetrics = createEmptyMetrics();
    }
    return ctx.hedgeMetrics;
}

export interface HedgeMetricsSample {
    /** HEDGE_COMPLETED / HEDGE_FAILED */
    outcome: 'completed' | 'failed';
    /** 函数内部耗时 (ms)，必填 */
    elapsedMs: number;
    /** fill→确认端到端 (ms)，可能缺失 (首次 fill 打点丢失时) */
    e2eMs?: number;
    /** 本次对冲使用的 retry 次数 */
    retries: number;
}

/**
 * 更新 metrics（纯函数：直接 mutate 传入 metrics 对象并返回）
 *
 * 规则：
 * - completed: 累加 completedCount / elapsedMs / e2eMs / retries
 * - failed:    只累加 failedCount + retries，**不**污染 elapsed/e2e 分布
 * - e2eRing FIFO：超出 E2E_RING_CAPACITY 时 shift 最旧
 */
export function updateMetrics(metrics: HedgeMetrics, sample: HedgeMetricsSample): HedgeMetrics {
    if (sample.outcome === 'completed') {
        metrics.completedCount += 1;
        metrics.totalElapsedMs += sample.elapsedMs;
        metrics.elapsedSamples += 1;
        if (sample.e2eMs !== undefined && Number.isFinite(sample.e2eMs)) {
            metrics.totalE2eMs += sample.e2eMs;
            metrics.e2eSamples += 1;
            metrics.e2eRing.push(sample.e2eMs);
            while (metrics.e2eRing.length > E2E_RING_CAPACITY) {
                metrics.e2eRing.shift();
            }
        }
        metrics.totalRetries += sample.retries;
    } else {
        metrics.failedCount += 1;
        metrics.totalRetries += sample.retries;
    }
    return metrics;
}

/**
 * 计算 p95（排序后 95% 位置 = Math.ceil(len * 0.95) - 1）
 * 样本数 < P95_MIN_SAMPLES 时返回 undefined
 */
export function computeP95(ring: number[]): number | undefined {
    const n = ring.length;
    if (n < P95_MIN_SAMPLES) return undefined;
    const sorted = [...ring].sort((a, b) => a - b);
    const idx = Math.ceil(n * 0.95) - 1;
    return sorted[Math.max(0, Math.min(n - 1, idx))];
}

/**
 * 格式化聚合日志行（不含前缀 [PolyMakerExecutor]），以缩进的 [k=v, ...] 形式。
 *
 * 对应真实输出样例：
 *   [e2eMs=1234ms, elapsedMs=987ms, avgE2e=1050ms, p95E2e=1900ms, retries=2, completed=12, failed=1, attemptId=abcd1234]
 */
export function formatMetricsLine(
    sample: HedgeMetricsSample,
    metrics: HedgeMetrics,
    attemptId: string,
): string {
    const avgE2e = metrics.e2eSamples > 0
        ? Math.round(metrics.totalE2eMs / metrics.e2eSamples)
        : undefined;
    const p95E2e = computeP95(metrics.e2eRing);

    const e2eStr = sample.e2eMs !== undefined ? `${Math.round(sample.e2eMs)}ms` : '?';
    const elapsedStr = `${Math.round(sample.elapsedMs)}ms`;
    const avgE2eStr = avgE2e !== undefined ? `${avgE2e}ms` : '?';
    const p95Str = p95E2e !== undefined ? `${Math.round(p95E2e)}ms` : '?';

    return (
        `[e2eMs=${e2eStr}, elapsedMs=${elapsedStr}, ` +
        `avgE2e=${avgE2eStr}, p95E2e=${p95Str}, ` +
        `retries=${sample.retries}, ` +
        `completed=${metrics.completedCount}, failed=${metrics.failedCount}, ` +
        `attemptId=${attemptId}]`
    );
}
