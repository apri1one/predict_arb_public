# Predict 做市模块架构文档

## 概述

`market-maker` 模块是一套完整的智能做市系统，用于在 Predict 预测市场上自动做市。采用**单市场引擎 + 多市场管理器 + 交易客户端**的三层架构。

## 一、文件结构

| 文件 | 行数 | 职责 |
|------|------|------|
| `types.ts` | ~263 | 全局类型定义：配置、状态、订单、事件、API 响应 |
| `config.ts` | ~170 | 配置管理：默认值、验证、合并、持久化 |
| `engine.ts` | ~1471 | 核心做市引擎：Tick 循环、订单调整、风控、状态同步 |
| `trading-client.ts` | ~1004 | 交易客户端：JWT 认证、订单签名/提交、持仓查询 |
| `multi-engine.ts` | ~378 | 多市场管理器：引擎生命周期、全局统计、紧急停止 |
| `market-selector.ts` | ~416 | 市场扫描与交互式选择 |
| `logger.ts` | ~263 | 日志系统：分级、轮转、彩色输出 |
| `index.ts` | ~65 | 模块导出 |

## 二、架构层次

```
┌─────────────────────────────────────────────────────────────┐
│                    应用层 (CLI / UI)                         │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│              MultiMarketMaker (multi-engine.ts)              │
│              多市场管理器：生命周期、全局统计                   │
└─────────────────────────┬───────────────────────────────────┘
                          │ 管理多个
┌─────────────────────────▼───────────────────────────────────┐
│              MarketMakerEngine (engine.ts)                   │
│              单市场引擎：Tick 循环、订单管理、风控              │
└─────────────────────────┬───────────────────────────────────┘
                          │ EngineDependencies
┌─────────────────────────▼───────────────────────────────────┐
│              TradingClient (trading-client.ts)               │
│              交易客户端：API 交互、链上查询、订单签名           │
└─────────────────────────┬───────────────────────────────────┘
                          │
        ┌─────────────────┴─────────────────┐
        ▼                                   ▼
┌───────────────────┐             ┌───────────────────┐
│   Predict API     │             │   BSC RPC         │
│   (REST + JWT)    │             │   (链上持仓)       │
└───────────────────┘             └───────────────────┘
```

## 三、核心类型定义

### 3.1 配置类型

```typescript
type MarketMakerStrategy = 'FOLLOW' | 'SCALP';
type OutcomeChoice = 'YES' | 'NO';

interface MarketMakerConfig {
    marketId: number;
    title: string;
    tokenId: string;              // 链上 Token ID
    outcome: OutcomeChoice;       // 做市方向
    feeRateBps: number;           // 手续费基点
    isNegRisk: boolean;
    isYieldBearing: boolean;
    maxShares: number;            // 最大持仓
    minOrderSize: number;
    tickSize: number;             // 价格精度
    strategy: MarketMakerStrategy;
    maxBuyPrice?: number;         // 风控：买价上限
    minSellPrice?: number;        // 风控：卖价下限
}

interface GlobalConfig {
    pollIntervalMs: number;         // 轮询间隔 (1000ms)
    minAdjustIntervalMs: number;    // 订单调整冷却 (500ms)
    maxRetries: number;
    minSpread: number;              // 最小价差
    minOrderValueUsd: number;       // 最小订单金额 (0.9 USD)
    maxConsecutiveErrors: number;   // 错误熔断阈值 (5)
    emergencyStop: boolean;         // 紧急停止
    sizeEpsilon: number;            // Delta 失衡容差 (0.1)
}
```

### 3.2 状态类型

```typescript
type MarketStatus =
    | 'idle'           // 空闲
    | 'initializing'   // 初始化
    | 'running'        // 运行中
    | 'adjusting'      // 调整中
    | 'range_paused'   // 价格越界暂停
    | 'paused'         // 暂停
    | 'error';         // 错误

interface MarketState {
    marketId: number;
    position: number;
    activeBuyOrder: ActiveOrder | null;
    activeSellOrder: ActiveOrder | null;
    lastBestBid: number;
    lastBestAsk: number;
    status: MarketStatus;
}
```

### 3.3 订单类型

```typescript
interface ActiveOrder {
    id: string;              // 订单 ID（撤单用）
    hash: string;            // 订单哈希
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
    filledQuantity: number;
    status: OrderStatus;
}

interface OrderDelta {
    action: 'PLACE' | 'CANCEL' | 'REPLACE' | 'NONE';
    side: 'BUY' | 'SELL';
    currentOrder: ActiveOrder | null;
    targetPrice: number;
    targetQuantity: number;
    reason?: string;
}
```

## 四、核心流程

### 4.1 初始化流程

```
MultiMarketMaker.start()
  └─ 并行初始化所有引擎
      └─ MarketMakerEngine.init()
           ├─ getMarketTickSize() → 获取价格精度
           ├─ fetchTokenPosition() → 链上持仓查询
           ├─ fetchOrders() → 获取活跃订单
           └─ fetchOrderBook() → 获取行情
```

### 4.2 Tick 循环

```
每 pollIntervalMs (1000ms) 执行:
  └─ MarketMakerEngine.tick()
       ├─ 风控检查
       │   ├─ emergencyStop → 立即停止
       │   └─ consecutiveErrors >= 5 → 熔断暂停
       ├─ syncState() → 同步订单和持仓
       ├─ fetchOrderBook() → 获取最新行情
       ├─ 风控检查
       │   ├─ enforcePriceRange() → 价格区间
       │   ├─ 最小价差检查
       │   └─ checkDeltaImbalance() → Delta 失衡
       ├─ calculateBuyDelta() → 计算买单调整
       ├─ calculateSellDelta() → 计算卖单调整
       └─ executeDelta() → 执行订单操作
```

### 4.3 订单决策逻辑

#### 买单 (calculateBuyDelta)

```
目标买量 = maxShares - position - openBuyRemaining

不变量约束：
- position + openBuyRemaining <= maxShares

决策：
- 无订单 + 目标>0 → PLACE
- 有订单 + 价格变化 → REPLACE
- 有订单 + 部分成交 → REPLACE (补单)
```

#### 卖单 (calculateSellDelta)

```
目标卖量 = position - openSellRemaining

不变量约束：
- openSellRemaining <= position (不超卖)

价格策略：
- FOLLOW: targetPrice = bestAsk
- SCALP:  targetPrice = bestBid + tickSize

决策：
- 无订单 + 目标>0 → PLACE
- 有订单 + 价格变化 → REPLACE
- 有订单 + 新增持仓 → REPLACE (补单)
```

## 五、风控机制

| 机制 | 触发条件 | 处理方式 |
|------|----------|----------|
| **紧急停止** | `emergencyStop = true` | 撤单 + 暂停所有市场 |
| **连续错误熔断** | `errors >= maxConsecutiveErrors` | 撤单 + 转 `paused` |
| **价格区间** | `buyPrice > maxBuyPrice` | 撤单 + 转 `range_paused` |
| **价格区间** | `sellPrice < minSellPrice` | 撤单 + 转 `range_paused` |
| **最小价差** | `spread < minSpread` | 撤单（保持 running） |
| **Delta 失衡** | `挂单量 > 目标量 + epsilon` | 撤单 + 跳过本轮 |
| **最小订单金额** | `价值 < 0.9 USD` | 调整数量或跳过 |
| **不做空** | 卖单计算时 | `desiredSell = max(0, position)` |
| **不超买** | 买单计算时 | `desiredBuy = max(0, maxShares - position - openBuy)` |

## 六、状态同步

### 6.1 订单同步 (syncState)

```
1. 获取 API 订单列表
2. 比对本地状态：
   - 订单 ID 相同 → 检测成交增量
   - 订单消失 → 检查可见性延迟 (3s)
     - 延迟期内 → 保持本地状态
     - 超过延迟 → 查询订单真实状态
     - 连续 3 次 UNKNOWN → 强制清除
3. 触发成交记录 (recordFill)
```

### 6.2 持仓同步

```
触发时机：
- 检测到成交
- 订单消失
- 每 10 tick 强制同步

方法：
- ERC-1155 balanceOf(smartWallet, tokenId)
- 与本地比较，有差异则更新
```

## 七、PnL 计算

### 库存成本（加权平均）

```typescript
// BUY 成交时
newCost = (oldCost * oldPosition + price * quantity) / newPosition
```

### 已实现盈亏

```typescript
// SELL 成交时
realizedPnL += (sellPrice - inventoryCost) * quantity
```

### 未实现盈亏

```typescript
unrealizedPnL = position * (currentPrice - inventoryCost)
totalPnL = realizedPnL + unrealizedPnL
```

## 八、API 集成

### 8.1 认证流程

```
1. GET /v1/auth/message → 获取签名消息
2. OrderBuilder.signPredictAccountMessage(message)
3. POST /v1/auth → 提交认证
4. 保存 JWT，自动刷新
```

### 8.2 订单签名

```
1. OrderBuilder.getLimitOrderAmounts() → 计算金额
2. 对齐到 1e13 精度（API 要求）
3. OrderBuilder.buildOrder() → 构建订单
4. OrderBuilder.buildTypedData() → EIP-712 数据
5. OrderBuilder.signTypedDataOrder() → 签名
6. POST /v1/orders → 提交
```

### 8.3 Token ID 计算

```
1. GET /v1/markets/{marketId}
2. 根据 outcome (YES/NO) 选择 onChainId
3. 缓存结果
```

### 8.4 链上持仓

```
1. 根据 isNegRisk + isYieldBearing 选择合约：
   - CONDITIONAL_TOKENS
   - NEG_RISK_CONDITIONAL_TOKENS
   - YIELD_BEARING_CONDITIONAL_TOKENS
   - YIELD_BEARING_NEG_RISK_CONDITIONAL_TOKENS
2. ERC-1155 balanceOf(smartWallet, tokenId)
```

## 九、关键设计模式

### 9.1 依赖注入

```typescript
interface EngineDependencies {
    fetchOrderBook: (marketId) => Promise<OrderBook>;
    fetchOrders: (marketId) => Promise<Order[]>;
    fetchPosition: (marketId, tokenId) => Promise<number>;
    placeOrder: (params) => Promise<{ id, hash }>;
    cancelOrder: (orderId) => Promise<boolean>;
    // ...
}

// 引擎通过构造函数注入依赖，便于测试和替换
const engine = new MarketMakerEngine(config, globalConfig, dependencies);
```

### 9.2 事件回调

```typescript
interface MarketMakerEvents {
    onStateChange?: (marketId, state) => void;
    onFill?: (fill) => void;
    onError?: (marketId, error) => void;
    onOrderPlaced?: (marketId, order) => void;
    onOrderCancelled?: (marketId, orderId) => void;
    onPriceUpdate?: (snapshot) => void;
}
```

### 9.3 对账式同步

- 只信任 API 返回的数据
- 本地状态始终与 API 对账
- 发现不一致时以 API/链上为准

## 十、环境配置

### 必填

```
PREDICT_API_KEY          # API Key
PREDICT_API_SECRET       # API Secret (可选)
PREDICT_PASSPHRASE       # API Passphrase (可选)
PREDICT_PRIVATE_KEY      # 钱包私钥
```

### 可选

```
PREDICT_BASE_URL         # API 基地址
BSC_RPC_URL              # BSC RPC 节点
MM_POLL_INTERVAL_MS      # 轮询间隔 (默认 1000)
MM_MIN_ADJUST_INTERVAL   # 调整冷却 (默认 500)
MM_MAX_CONSECUTIVE_ERRORS # 错误熔断阈值 (默认 5)
MM_SIZE_EPSILON          # Delta 容差 (默认 0.1)
```

## 十一、使用示例

```typescript
import { TradingClient, MultiMarketMaker, mergeGlobalConfig } from './market-maker';

// 1. 创建交易客户端
const client = new TradingClient({
    apiKey: process.env.PREDICT_API_KEY,
    privateKey: process.env.PREDICT_PRIVATE_KEY,
});
await client.init();

// 2. 创建多市场管理器
const mm = new MultiMarketMaker(
    mergeGlobalConfig({}),
    client.getDependencies()
);

// 3. 添加市场
mm.addMarket({
    marketId: 12345,
    title: 'Will BTC reach $100k?',
    tokenId: '0x...',
    outcome: 'YES',
    maxShares: 100,
    strategy: 'SCALP',
    // ...
});

// 4. 启动
await mm.start();

// 5. 风控操作
mm.setEmergencyStop(true);   // 紧急停止
mm.pauseMarket(12345);       // 暂停单个市场
mm.resumeAll();              // 恢复所有

// 6. 停止
await mm.stop();
```

## 十二、日志

```typescript
// 日志级别
DEBUG < INFO < WARN < ERROR

// 日志输出
- 控制台：彩色输出
- 文件：自动轮转，默认 10MB/文件，保留 5 个

// 关键事件
- tick_error: Tick 失败
- order_placed: 下单成功
- order_cancelled: 撤单
- fill_detected: 检测到成交
- delta_imbalance: Delta 失衡
- price_range_violation: 价格越界
- circuit_breaker: 错误熔断
```
