/**
 * API Key 轮换管理
 *
 * 从 start-dashboard.ts 提取，负责 Predict API Key 的池化管理、
 * 轮换策略、使用统计与脱敏显示。
 */

import { API_KEY_LOG_INTERVAL_MS } from './dashboard-config.js';

// ============================================================================
// Types
// ============================================================================

export type ApiKeyPurpose = 'scan' | 'trade';

// ============================================================================
// ApiKeyRotator
// ============================================================================

export class ApiKeyRotator {
    private keys: string[];
    private currentIndex: number = 0;
    private lastUsed: Map<string, number> = new Map();
    private cooldownMs: number = 1000;
    private purpose: ApiKeyPurpose;

    constructor(purpose: ApiKeyPurpose, keys?: string[]) {
        this.purpose = purpose;
        this.keys = keys || [];

        if (keys && keys.length > 0) {
            // 使用外部传入的 keys
        } else if (purpose === 'scan') {
            // 扫描用：加载 SCAN_1 到 SCAN_10 (支持多 key 轮换)
            // 支持两种命名：PREDICT_API_KEY_SCAN 或 PREDICT_API_KEY_SCAN_1
            const scan1 = process.env['PREDICT_API_KEY_SCAN_1'] || process.env['PREDICT_API_KEY_SCAN'];
            if (scan1) this.keys.push(scan1);
            for (let i = 2; i <= 10; i++) {
                const key = process.env[`PREDICT_API_KEY_SCAN_${i}`];
                if (key) this.keys.push(key);
            }

            // Fallback: 主 key
            if (this.keys.length === 0) {
                const fallbackKey = process.env['PREDICT_API_KEY'];
                if (fallbackKey) this.keys.push(fallbackKey);
            }
        } else {
            // trade: 交易专用 key
            const tradeKey = process.env['PREDICT_API_KEY_TRADE'];
            if (tradeKey) {
                this.keys.push(tradeKey);
            } else {
                const fallbackKey = process.env['PREDICT_API_KEY'];
                if (fallbackKey) this.keys.push(fallbackKey);
            }
        }

        console.log(`🔑 [${purpose.toUpperCase()}] 加载了 ${this.keys.length} 个 API Key\n`);
    }

    getNextKey(): string {
        if (this.keys.length === 0) return '';
        if (this.keys.length === 1) return this.keys[0];

        const now = Date.now();
        for (let i = 0; i < this.keys.length; i++) {
            const idx = (this.currentIndex + i) % this.keys.length;
            const key = this.keys[idx];
            const lastUse = this.lastUsed.get(key) || 0;

            if (now - lastUse >= this.cooldownMs) {
                this.currentIndex = (idx + 1) % this.keys.length;
                this.lastUsed.set(key, now);
                return key;
            }
        }

        const key = this.keys[this.currentIndex];
        this.currentIndex = (this.currentIndex + 1) % this.keys.length;
        this.lastUsed.set(key, now);
        return key;
    }

    getKeyCount(): number {
        return this.keys.length;
    }

    getAllKeys(): string[] {
        return [...this.keys];
    }
}

// ============================================================================
// 独立函数
// ============================================================================

/** SCAN_4 备用 key (可选) */
export function getInactiveScanKey(): string | null {
    return process.env['PREDICT_API_KEY_SCAN_4'] || null;
}

/** 初始化阶段使用所有 SCAN keys 并行加速 */
export function getAllScanKeys(): string[] {
    const keys: string[] = [];
    const primaryKey = process.env['PREDICT_API_KEY_SCAN'];
    if (primaryKey) keys.push(primaryKey);
    for (let i = 2; i <= 10; i++) {
        const key = process.env[`PREDICT_API_KEY_SCAN_${i}`];
        if (key) keys.push(key);
    }
    // Fallback: SCAN_4 -> 主 key (尽量避免用主 key 扫描)
    if (keys.length === 0) {
        const scan4Key = process.env['PREDICT_API_KEY_SCAN_4'];
        if (scan4Key) keys.push(scan4Key);
    }
    if (keys.length === 0) {
        const fallback = process.env['PREDICT_API_KEY'];
        if (fallback) keys.push(fallback);
    }
    return keys;
}

// ============================================================================
// 使用统计 (模块私有)
// ============================================================================

const apiKeyUsageCounts = new Map<string, number>();
let apiKeyUsageWindowStart = 0;

/** key 脱敏显示 */
export function maskApiKey(key: string): string {
    if (!key) return '';
    if (key.length <= 8) return key;
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/** 记录 API key 使用频率 */
export function recordApiKeyUsage(apiKey: string): void {
    if (!apiKey) return;
    const now = Date.now();
    if (!apiKeyUsageWindowStart) apiKeyUsageWindowStart = now;
    apiKeyUsageCounts.set(apiKey, (apiKeyUsageCounts.get(apiKey) || 0) + 1);

    if (now - apiKeyUsageWindowStart >= API_KEY_LOG_INTERVAL_MS) {
        const entries = Array.from(apiKeyUsageCounts.entries())
            .map(([key, count]) => `${maskApiKey(key)}=${count}`)
            .join(', ');
        console.log(`[Predict API] Scan key usage (${Math.round((now - apiKeyUsageWindowStart) / 1000)}s): ${entries || 'no-keys'}`);
        apiKeyUsageCounts.clear();
        apiKeyUsageWindowStart = now;
    }
}
