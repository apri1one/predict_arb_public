/**
 * Hedge Mode 模块出口
 *
 * 平仓服务，从历史 close-service.ts 迁移而来。功能职责：
 * - 双腿持仓匹配 (Predict + Polymarket)
 * - T-T / M-T 平仓收益与多档深度计算
 * - SSE/REST 平仓机会推送数据源
 *
 * 任务执行委托给 task-executor.ts 中现成的 SELL+TAKER / SELL+PREDICT_MAKER 分支，本模块不负责下单。
 */

export {
    refreshMarketMatches,
    calculateCloseOpportunities,
    getClosePositions,
    getPositionMarketIds,
    getUnmatchedPositions,
} from './service.js';

export {
    setPolyOrderbookProvider,
    setPredictOrderbookProvider,
    setPredictApiKeyProvider,
} from './providers.js';
