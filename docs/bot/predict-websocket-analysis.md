# Predict WebSocket 功能分析报告

## 测试日期
2026-01-17

## 1. Predict 官方 WebSocket 功能

### 连接信息
- **端点**: `wss://ws.predict.fun/ws`
- **认证**: API Key (URL 参数 `?apiKey=xxx` 或 Header `x-api-key`)
- **心跳**: 服务器每 15 秒发送心跳，客户端必须在 15 秒内回复

### 可订阅主题

| 主题 | 格式 | 认证要求 | 用途 |
|------|------|---------|------|
| 订单簿 | `predictOrderbook/{marketId}` | API Key | 实时订单簿更新 |
| 价格更新 | `assetPriceUpdate/{priceFeedId}` | API Key | 资产价格更新 |
| 钱包事件 | `predictWalletEvents/{jwt}` | JWT Token | 订单状态变更 |

### 钱包事件类型
- `ORDER_ACCEPTED` - 订单被接受
- `ORDER_REJECTED` - 订单被拒绝
- `ORDER_FILLED` - 订单完全成交
- `ORDER_PARTIALLY_FILLED` - 订单部分成交
- `ORDER_CANCELLED` - 订单被取消
- `ORDER_EXPIRED` - 订单过期
- `ORDER_TX_CONFIRMED` - 链上交易确认
- `ORDER_TX_FAILED` - 链上交易失败

## 2. 测试结果

### 2.1 订单簿 WebSocket vs REST API

| 指标 | WebSocket | REST API |
|------|-----------|----------|
| 连接耗时 | 731ms | N/A |
| 单次延迟 | - | 296ms (平均) |
| 更新频率 | ~648ms/次 | 按需请求 |
| 15秒内更新次数 | 31 次 | 取决于轮询频率 |

**结论**:
- WebSocket 订单簿更新约每 **648ms** 推送一次
- REST API 每次请求需要 **~300ms**
- 如果轮询频率 < 2次/秒，WebSocket 更高效

### 2.2 订单成交通知延迟

| 通道 | 延迟 | 说明 |
|------|------|------|
| BSC WSS | 2780ms | 从下单到收到链上事件 |
| REST API 轮询 | 未能捕获 | 3s 间隔可能错过 |

**分解**:
- 下单 API 耗时: 2239ms
- 链上确认延迟: ~541ms (2780 - 2239)

### 2.3 BSC WebSocket

| 指标 | 数值 |
|------|------|
| 连接耗时 | 773ms |
| 订阅成功率 | 100% |
| 事件接收 | ✅ 正常 |

## 3. 可替换为 WebSocket 的接口

### 3.1 订单簿获取 ⭐ 推荐替换

**当前实现**: REST API 轮询 (`/v1/markets/{id}/orderbook`)
- 位置: `bot/src/predict/index.ts` - `pollOrderBooks()`
- 频率: 100ms 轮询
- 问题: API 调用频繁，可能触发限频

**WebSocket 替代**: `predictOrderbook/{marketId}`
- 优势:
  - 减少 API 调用 90%+
  - 自动推送更新
  - 更低延迟
- 劣势:
  - 推送间隔 ~648ms，不是逐笔实时
  - 需要维护 WebSocket 连接

**建议**:
- 套利扫描场景: ✅ 推荐使用 WebSocket
- 下单前最终确认: 仍使用 REST API 获取最新深度

### 3.2 订单状态查询 ⚠️ 可选替换

**当前实现**:
- REST API 轮询 (`/v1/orders/{hash}`)
- BSC WSS 事件监听 (链上 `OrderFilled`)

**WebSocket 替代**: `predictWalletEvents/{jwt}`
- 优势:
  - 可获取完整订单生命周期事件
  - 包括 ACCEPTED、REJECTED、CANCELLED 等
- 劣势:
  - 需要 JWT 认证
  - JWT 有效期管理复杂

**建议**:
- 保留现有 BSC WSS 实现（延迟 ~541ms）
- 可选添加官方 WS 作为补充，获取订单被拒绝等非链上事件

### 3.3 市场数据获取 ❌ 不推荐替换

**当前实现**: REST API (`/v1/markets`)

**WebSocket 替代**: 暂无对应主题

**建议**: 保持 REST API

## 4. 实施建议

### 短期优化（推荐）

1. **订单簿订阅改造**
   - 将 `bot/src/predict/index.ts` 中的轮询改为 WebSocket 订阅
   - 使用已创建的 `PredictWsClient` 类
   - 保留 REST API 作为 fallback

```typescript
// 示例改造
import { initPredictWsClient } from '../services/predict-ws-client.js';

const wsClient = initPredictWsClient({ apiKey: API_KEY });
await wsClient.connect();

// 订阅订单簿
for (const marketId of subscribedMarkets) {
    await wsClient.subscribeOrderbook(marketId, (data) => {
        // 更新缓存
        orderbookCache.set(marketId, data);
        // 触发套利检测
        this.emit('orderbook:update', marketId, data);
    });
}
```

2. **混合模式**
   - WebSocket 用于实时订阅
   - REST API 用于下单前最终确认

### 长期优化（可选）

1. **官方 WS 订单状态**
   - 添加 `predictWalletEvents` 订阅
   - 用于获取非链上事件（如订单被拒绝）

2. **多通道冗余**
   - BSC WSS: 链上成交事件
   - Predict WS: 官方订单状态
   - REST API: 最终确认

## 5. 新增文件

| 文件 | 说明 |
|------|------|
| `bot/src/services/predict-ws-client.ts` | Predict 官方 WebSocket 客户端 |
| `bot/src/testing/test-predict-ws.ts` | WebSocket 功能测试 |
| `bot/src/testing/test-order-fill-latency.ts` | 下单延迟测试 |

## 6. 延迟对比总结

```
下单流程延迟分解:

┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   下单 API      │────▶│   链上确认      │────▶│   事件通知      │
│   ~2200ms       │     │   ~500ms        │     │   BSC WSS       │
└─────────────────┘     └─────────────────┘     └─────────────────┘

订单簿更新:

REST API 轮询:   [────300ms────][────300ms────][────300ms────]
WebSocket 推送:  [─────────────648ms─────────────][─────────────648ms─────────────]
```

## 7. 结论

1. **订单簿获取**: 强烈推荐改用 WebSocket，可减少 90%+ 的 API 调用
2. **订单状态**: BSC WSS 已足够快（~541ms），官方 WS 可作为补充
3. **整体延迟**: 下单 + 确认总延迟约 2.8s，主要瓶颈在下单 API 本身
