/**
 * Dashboard 内部类型定义
 *
 * 从 start-dashboard.ts 提取的类型/接口。
 * 注意：这些类型是 Dashboard 后端内部使用的扩展版本，
 * 与 types.ts 中的同名类型（前端共享版本）不同。
 */

import type { ArbOpportunity } from './types.js';

// ============================================================================
// 命令行参数
// ============================================================================

export interface CliArgs {
    envFile: string | null;  // null 表示未指定，需要交互选择
    port: number | null;
    accountName: string | null;
}

// ============================================================================
// 账号配置
// ============================================================================

export interface AccountConfig {
    name: string;       // 账号名称 (如 "account1")
    envFile: string;    // 配置文件路径
    displayName: string; // 显示名称
}

// ============================================================================
// 系统状态与市场数据
// ============================================================================

// 与前端 types.ts 中的 SystemStats 保持一致
export interface SystemStats {
    latency: {
        predict: number;      // ms
        polymarket: number;   // ms
    };
    connectionStatus: {
        polymarketWs: 'connected' | 'disconnected' | 'reconnecting';
        predictWs: 'connected' | 'disconnected';
        bscWss: 'connected' | 'disconnected';
        predictApi: 'ok' | 'rate_limited' | 'error';
    };
    lastFullUpdate: string;   // ISO string
    marketsMonitored: number;
    refreshInterval: number;  // ms
    arbStats: {
        makerCount: number;
        takerCount: number;
        avgProfit: number;
        maxProfit: number;
        totalDepth: number;
    };
    dataVersion: number;      // 递增版本号，用于一致性验证
}

export interface MarketPair {
    predictId: number;
    predictTitle: string;
    predictQuestion: string;  // 完整事件标题
    categorySlug?: string;    // Predict event slug (用于 URL 导航)
    polymarketConditionId: string;
    polymarketSlug?: string;           // Polymarket market slug (用于 URL 导航)
    polymarketTokenId?: string;        // Legacy: 第一个 token (通常是 YES)
    polymarketNoTokenId?: string;      // NO token ID
    polymarketYesTokenId?: string;     // YES token ID
    tickSize: number;                   // 动态 tick size (0.01 或 0.001)
    feeRateBps: number;
    isInverted: boolean;
    endDate?: string;  // ISO 8601 结算时间 (从 Polymarket 获取)
    negRisk: boolean;  // Polymarket negRisk 市场标志
    predictVolume?: number;  // Predict 总成交量 (USD)
    polyVolume?: number;     // Polymarket 总成交量 (USD)
}

export interface DashboardData {
    opportunities: ArbOpportunity[];
    stats: SystemStats;
}

// ============================================================================
// SSE 传输
// ============================================================================

export interface SSEClientMeta {
    ip: string;
    ua: string;
    connectedAt: number;
    initialized: boolean;  // 初始快照是否发送完毕（广播跳过未初始化客户端，避免事件交错）
    backpressured: boolean;  // 是否处于背压状态（write() 返回 false，正在等待 drain）
    drainTimeoutCount: number;  // 连续 drain 超时次数（超过阈值则断开）
    lastBackpressureLogTime: number;  // 上次背压日志时间（限流用）
    backpressureCycleCount: number;  // 本周期内背压循环次数（汇总日志用）
}

// ============================================================================
// 广播通道
// ============================================================================

export type BroadcastChannel =
    | 'opportunity'
    | 'stats'
    | 'markets'
    | 'tasks'
    | 'sports'
    | 'closeOpportunities'
    | 'accounts';

// ============================================================================
// 流动性扫描
// ============================================================================

export interface LiquidityScanItem {
    marketId: number;
    title: string;
    categorySlug: string;
    predictSlug: string;
    outcomeCount: number;
    volume24h: number;
    liquidity: number;
    volumeLiquidityRatio: number;
}

export interface LiquidityScanResult {
    data: { valid: number; top20: LiquidityScanItem[] };
    lastScanTime: number;
}
