# 架构参考 (从 CLAUDE.md 提取)

## 高层架构

### 核心数据流

```
Predict API ──────┐
(markets, orderbook)
                   ├──→ start-dashboard.ts ──→ SSE ──→ 前端 (port 3010)
Polymarket API ───┘                                    任务API (port 3011)
(CLOB, Gamma)

前端 ──→ POST /tasks ──→ task-service ──→ task-executor
                                              │
                              ┌────────────────┴────────────┐
                              ↓                             ↓
                      predict-trader.ts         polymarket-trader.ts
                      (SDK OrderBuilder)        (EIP-712 签名)
                              │                             │
                              ↓                             ↓
                       [单钱包对冲]              [多钱包对冲 (poly-multi)]
                              │                             │
                              └───────→ telegram.ts ←───────┘
```

### 关键模块职责

| 模块 | 路径 | 职责 |
|-----|------|------|
| Dashboard 后端 | `src/dashboard/start-dashboard.ts` | SSE 推送、REST API、套利检测调度 |
| 任务执行 | `src/dashboard/task-executor.ts` | 任务状态机、深度监控、并发控制、多钱包拦截器 |
| TAKER 执行器 | `src/dashboard/taker-mode/executor.ts` | 双边同时下单、对冲逻辑 |
| 任务日志 | `src/dashboard/task-logger/` | 异步队列、JSONL 持久化、通知集成 |
| 自动任务 | `src/dashboard/auto-task-create.ts` | 批量创建任务、状态追踪 |
| 自动预览 | `src/dashboard/auto-task-preview.ts` | 候选筛选 (深度≥100, 价格0.2~0.8) |
| 批量取消 | `src/dashboard/batch-task-cancel.ts` | 批量取消活跃任务 |
| 多账户对冲 | `src/poly-multi/` | 钱包加密存储、配对管理、分布式对冲执行 |
| 体育服务 | `src/dashboard/sports-service.ts` | 体育市场匹配、赔率对比、足球三方事件 |
| Poly 体育面板 | `src/polymarket-dashboard/` | 独立 Polymarket 体育 Dashboard (端口 4020) |
| Probable 客户端 | `src/probable/` | Probable Markets REST API 适配 |
| 深度计算 | `src/trading/depth-calculator.ts` | 订单簿分析、可执行数量计算 |
| 价格工具 | `src/trading/price-utils.ts` | `roundToTick`、`alignPriceDown/Up`、手续费计算 |
| BSC 监控 | `src/services/bsc-order-watcher.ts` | WebSocket 订阅链上 OrderFilled 事件 |
| 平仓服务 | `src/dashboard/close-service.ts` | 持仓平仓、反向卖出 |
| 做市引擎 | `src/market-maker/engine.ts` | 1000ms tick 循环、订单调整、风控 |
| 下单客户端 | `src/trading/predict-order-client.ts` | Predict 订单构建/签名/提交封装 |

### 任务执行状态机

```
CREATED → PENDING → EXECUTING → FILL_COMPLETED → HEDGE_IN_PROGRESS
                                                   ↓
                                           HEDGE_COMPLETED / HEDGE_FAILED
                                                   ↓
                                             CLOSED / ERRORED
```

**三种策略**: PREDICT_MAKER (Predict 挂单等待成交后 Polymarket 对冲)、TAKER (双边同时吃单，`taker-mode/executor.ts` 处理)、POLY_MAKER (Polymarket 挂单等待成交后 Predict 对冲，`poly-maker-mode/executor.ts` 处理)。

### 多账户对冲 (poly-multi)

TaskExecutor 支持 `hedgeInterceptor` 可选拦截器。`PolyMultiModule` 注入后，对冲请求优先分配到多个 Polymarket 钱包执行，失败时 fallthrough 到单钱包。钱包凭证加密存储在 SQLite，需解锁密码。

### WebSocket 客户端

| 客户端 | 路径 | 连接地址 | 用途 |
|--------|------|---------|------|
| Polymarket Market WS | `polymarket/ws-client.ts` | `wss://ws-subscriptions-clob.polymarket.com` | 订单簿实时推送 |
| Polymarket User WS | `polymarket/user-ws-client.ts` | `wss://.../ws/user` | 用户订单/成交事件 |
| Predict WS | `services/predict-ws-client.ts` | `wss://ws.predict.fun/ws` | 钱包事件 (OrderFilled/Cancelled) |
| BSC WSS | `services/bsc-order-watcher.ts` | BSC 公共 WSS 节点 | 链上 OrderFilled 事件监听 |

### 实时通知系统

```
TaskLogger ─┬─→ SSE (taskEvent) ─→ 前端 Toast
            └─→ Telegram 推送

BscOrderWatcher ─→ orderFilled 事件 ─→ BscOrderNotifier ─→ Telegram
PredictWsClient ─→ wallet events ─→ WsOrderNotifier ─→ Telegram
```

## 套利原理

```
YES 端套利 (arbSide='YES'):
  Predict 买 YES + Polymarket 买 NO = 套利锁定
  条件: predict_ask + polymarket_ask + fee < 1.0

NO 端套利 (arbSide='NO'):
  Predict 买 NO + Polymarket 买 YES = 套利锁定
  条件: predict_ask + polymarket_ask + fee < 1.0
```

## 市场类型与 Exchange 地址

| 类型 | 说明 | Predict (BSC) | Polymarket (Polygon) |
|-----|------|--------------|---------------------|
| Binary | 二元市场 | `0x8BC070...` | `0x4bFb41...` |
| NegRisk | 多选市场 | `0x365fb8...` | `0xC5d563...` |

**negRisk 签名**: 多选市场必须使用 `NEG_RISK_CTF_EXCHANGE` 地址签名。足球三方事件的每个子市场虽然 outcomes 是 `["Yes","No"]`（二元），但属于 negRisk 多选事件，必须用 `NEG_RISK_CTF_EXCHANGE`。

## 订单签名 (EIP-712)

### Predict
```typescript
const domain = {
    name: 'predict.fun CTF Exchange',
    version: '1',
    chainId: 56,  // BSC
    verifyingContract: isNegRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE
};
```

### Polymarket
```typescript
const domain = {
    name: 'Polymarket CTF Exchange',
    version: '1',
    chainId: 137,  // Polygon
    verifyingContract: negRisk ? NEG_RISK_CTF_EXCHANGE : CTF_EXCHANGE
};
```

## 价格与金额计算

```typescript
// BUY: 支付 USDC，获得 tokens
makerAmount = price * quantity  // USDC
takerAmount = quantity          // tokens

// SELL: 支付 tokens，获得 USDC
makerAmount = quantity          // tokens
takerAmount = price * quantity  // USDC

// Predict 手续费
fee = feeRate * min(price, 1 - price) * quantity
// feeRate 通常为 2% (200 bps)
```

## 体育市场特殊逻辑

**足球三方市场**: 一场比赛在 Predict = 3 个独立二元市场 (主胜/平局/客胜)，在 Polymarket = 1 个 negRisk 多选事件的 3 个子市场。每个子市场有独立的 `conditionId` 和 `clobTokenIds` (YES/NO token pair)。`sports-service.ts` 负责跨平台子市场一一匹配。

**Token 映射**: `clobTokenIds[0]` = YES token (polymarketAwayTokenId), `clobTokenIds[1]` = NO token (polymarketHomeTokenId)。

**数据源规则**: 体育市场 Predict 订单簿使用 WS 推送，Polymarket 订单簿只能使用 REST API（Polymarket WS 不支持体育市场订阅）。
