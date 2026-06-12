#!/usr/bin/env tsx

import {
    formatHedgeTimingReview,
    generateHedgeTimingReview,
} from '../dashboard/hedge-timing.js';

function argValue(name: string): string | undefined {
    const idx = process.argv.indexOf(name);
    if (idx >= 0) return process.argv[idx + 1];
    const prefix = `${name}=`;
    const found = process.argv.find(arg => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : undefined;
}

function hasFlag(name: string): boolean {
    return process.argv.includes(name);
}

function numberArg(name: string, fallback: number): number {
    const raw = argValue(name);
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

async function main(): Promise<void> {
    const baseDir = argValue('--dir') || process.env.HEDGE_TIMING_LOG_DIR;
    const lastEvents = numberArg('--last', 1000);
    const writeReview = hasFlag('--write-review');
    const json = hasFlag('--json');

    const review = await generateHedgeTimingReview({
        baseDir,
        lastEvents,
        writeReview,
    });

    if (json) {
        console.log(JSON.stringify(review, null, 2));
        return;
    }

    console.log(formatHedgeTimingReview(review));
    if (review.reviewFiles?.markdown) {
        console.log(`Review written: ${review.reviewFiles.markdown}`);
    }
}

main().catch((error) => {
    console.error(`[hedge-timing-report] failed: ${(error as Error).message}`);
    process.exit(1);
});
