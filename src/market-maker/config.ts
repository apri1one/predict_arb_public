/**
 * Predict 做市模块 - 配置管理
 */

import type { GlobalConfig, MarketMakerConfig } from './types.js';

// ============================================================================
// 默认配置
// ============================================================================

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
    pollIntervalMs: 1000,          // 1秒轮询
    minAdjustIntervalMs: 500,      // 最小调整间隔 500ms
    maxRetries: 3,                 // 最大重试 3 次
    retryDelayMs: 1000,            // 重试延迟 1 秒

    // 风控参数
    minSpread: 0,                  // 最小价差（<=0 表示关闭限制）
    minOrderValueUsd: 0.9,         // 最小订单金额 0.9 USD（Predict API 限制）
    maxConsecutiveErrors: 5,       // 连续 5 次错误后暂停
    emergencyStop: false,          // 紧急停止开关
    sizeEpsilon: 0.1,              // Delta 失衡保护：尺寸容差 0.1 shares
};

export const DEFAULT_MARKET_CONFIG: Partial<MarketMakerConfig> = {
    maxShares: 100,
    minOrderSize: 1,
    feeRateBps: 200,               // 默认 2%
    isNegRisk: false,
    isYieldBearing: false,
    tickSize: 0.01,                // 默认 1% tick (会在 init 时从 API 覆盖)
    strategy: 'FOLLOW',            // 默认跟随模式
    outcome: 'YES',                // 默认做市 YES
    positionPrecisionDecimals: 2,  // 订单决策持仓精度（用于和前端显示保持一致）
    maxScalpSellOrders: 10,        // SCALP 策略: 最大卖单数量
};

// ============================================================================
// 配置验证
// ============================================================================

export function validateMarketConfig(config: MarketMakerConfig): string[] {
    const errors: string[] = [];

    if (!config.marketId || config.marketId <= 0) {
        errors.push('marketId 必须是正整数');
    }

    if (!config.tokenId) {
        errors.push('tokenId 不能为空');
    }

    if (config.maxShares <= 0) {
        errors.push('maxShares 必须大于 0');
    }

    if (config.minOrderSize <= 0) {
        errors.push('minOrderSize 必须大于 0');
    }

    if (config.feeRateBps < 0 || config.feeRateBps > 10000) {
        errors.push('feeRateBps 必须在 0-10000 之间');
    }

    if (config.maxBuyPrice !== undefined) {
        if (!Number.isFinite(config.maxBuyPrice) || config.maxBuyPrice <= 0 || config.maxBuyPrice >= 1) {
            errors.push('maxBuyPrice 必须在 0-1 之间（例如 0.723 表示 72.3¢）');
        }
    }

    if (config.minSellPrice !== undefined) {
        if (!Number.isFinite(config.minSellPrice) || config.minSellPrice <= 0 || config.minSellPrice >= 1) {
            errors.push('minSellPrice 必须在 0-1 之间（例如 0.723 表示 72.3¢）');
        }
    }

    if (config.maxBuyPrice !== undefined && config.minSellPrice !== undefined) {
        if (config.minSellPrice > config.maxBuyPrice) {
            errors.push('价格区间无效：minSellPrice 不能大于 maxBuyPrice');
        }
    }

    return errors;
}

export function validateGlobalConfig(config: GlobalConfig): string[] {
    const errors: string[] = [];

    if (config.pollIntervalMs < 100) {
        errors.push('pollIntervalMs 不能小于 100ms');
    }

    if (config.minAdjustIntervalMs < 0) {
        errors.push('minAdjustIntervalMs 不能为负数');
    }

    if (config.maxRetries < 0) {
        errors.push('maxRetries 不能为负数');
    }

    return errors;
}

// ============================================================================
// 配置合并
// ============================================================================

export function mergeMarketConfig(
    partial: Partial<MarketMakerConfig>,
    marketId: number,
    title: string,
    tokenId: string
): MarketMakerConfig {
    return {
        marketId,
        title,
        tokenId,
        outcome: partial.outcome ?? DEFAULT_MARKET_CONFIG.outcome!,
        feeRateBps: partial.feeRateBps ?? DEFAULT_MARKET_CONFIG.feeRateBps!,
        isNegRisk: partial.isNegRisk ?? DEFAULT_MARKET_CONFIG.isNegRisk!,
        isYieldBearing: partial.isYieldBearing ?? DEFAULT_MARKET_CONFIG.isYieldBearing!,
        maxShares: partial.maxShares ?? DEFAULT_MARKET_CONFIG.maxShares!,
        minOrderSize: partial.minOrderSize ?? DEFAULT_MARKET_CONFIG.minOrderSize!,
        tickSize: partial.tickSize ?? DEFAULT_MARKET_CONFIG.tickSize!,
        strategy: partial.strategy ?? DEFAULT_MARKET_CONFIG.strategy!,
        positionPrecisionDecimals: partial.positionPrecisionDecimals ?? DEFAULT_MARKET_CONFIG.positionPrecisionDecimals!,
        maxBuyPrice: partial.maxBuyPrice,
        minSellPrice: partial.minSellPrice,
        maxSpreadCents: partial.maxSpreadCents,
    };
}

export function mergeGlobalConfig(partial: Partial<GlobalConfig>): GlobalConfig {
    return {
        ...DEFAULT_GLOBAL_CONFIG,
        ...partial,
    };
}

// ============================================================================
// 配置持久化
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { MarketMakerStrategy } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_DIR = path.resolve(__dirname, '../..');  // bot/ 目录
const CONFIG_FILE = 'market-maker-last-config.json';

export interface SavedConfig {
    global: GlobalConfig;
    markets: MarketMakerConfig[];
    strategy: MarketMakerStrategy;
    savedAt: string;  // ISO 时间戳
}

/**
 * 保存配置到文件
 */
export function saveConfig(config: SavedConfig, dir: string = DEFAULT_CONFIG_DIR): void {
    const filePath = path.join(dir, CONFIG_FILE);
    const dataToSave = {
        ...config,
        savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2), 'utf8');
}

/**
 * 加载上次的配置
 */
export function loadConfig(dir: string = DEFAULT_CONFIG_DIR): SavedConfig | null {
    const filePath = path.join(dir, CONFIG_FILE);
    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content) as SavedConfig;
    } catch {
        return null;
    }
}

/**
 * 获取配置文件路径
 */
export function getConfigFilePath(dir: string = DEFAULT_CONFIG_DIR): string {
    return path.join(dir, CONFIG_FILE);
}

/**
 * 格式化配置摘要（用于显示）
 */
export function formatConfigSummary(config: SavedConfig): string {
    const savedDate = new Date(config.savedAt);
    const lines: string[] = [
        `策略: ${config.strategy}`,
        `保存时间: ${savedDate.toLocaleString()}`,
        `市场数量: ${config.markets.length}`,
        '',
        '市场列表:',
    ];

    for (const m of config.markets) {
        const bounds = (m.minSellPrice !== undefined || m.maxBuyPrice !== undefined)
            ? ` [${(m.minSellPrice ?? '-').toString()}..${(m.maxBuyPrice ?? '-').toString()}]`
            : '';
        const spread = m.maxSpreadCents !== undefined ? ` spread<${m.maxSpreadCents}c` : '';
        lines.push(`  [${m.marketId}] ${m.title.slice(0, 40)}${m.title.length > 40 ? '...' : ''} ${m.outcome} max=${m.maxShares}${bounds}${spread}`);
    }

    return lines.join('\n');
}
