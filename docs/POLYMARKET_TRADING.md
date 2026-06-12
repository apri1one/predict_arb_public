# Polymarket 交易模块总结

## 概述

本文档总结 Polymarket CLOB API 交易模块的实现细节，供后续完善交易模块参考。

## 认证体系

### L2 认证 (Level 2 Authentication)

所有交易操作需要 L2 认证，包含以下 Headers：

| Header | 说明 |
|--------|------|
| `POLY_ADDRESS` | EOA 钱包地址 (必需) |
| `POLY_API_KEY` | API Key |
| `POLY_SIGNATURE` | HMAC-SHA256 签名 (URL-safe Base64) |
| `POLY_TIMESTAMP` | Unix 时间戳 (秒) |
| `POLY_PASSPHRASE` | API Passphrase |

### HMAC 签名构建

```typescript
function buildHmacSignature(
    apiSecret: string,  // Base64 编码的密钥
    timestamp: string,
    method: string,     // GET, POST, DELETE
    path: string,       // 不含查询参数
    body: string        // JSON 字符串，GET 请求为空
): string {
    const message = timestamp + method + path + body;
    const secretBuffer = Buffer.from(apiSecret, 'base64');
    const signature = crypto
        .createHmac('sha256', secretBuffer)
        .update(message, 'utf-8')
        .digest('base64');
    // 转换为 URL-safe Base64
    return signature.replace(/\+/g, '-').replace(/\//g, '_');
}
```

### API 凭证获取

```bash
# 通过私钥派生 API 凭证
GET /auth/derive-api-key
# Headers: EIP-712 签名
```

或使用 Python SDK：
```python
client.create_or_derive_api_creds()
```

## 钱包架构

### 三种签名类型

| signatureType | 名称 | 说明 |
|---------------|------|------|
| 0 | EOA | 标准外部账户，maker = signer |
| 1 | POLY_PROXY | Magic/Email 登录创建的 EIP-1167 代理 |
| 2 | POLY_GNOSIS_SAFE | MetaMask 登录创建的 Gnosis Safe |

### 地址关系

```
EOA 地址 (signer)
    │
    └── 签署交易，用于 API 认证

Proxy 地址 (maker/funder)
    │
    └── 持有资金，执行交易
```

### 验证方法

```typescript
// 检查代理钱包类型
const proxyCode = await provider.getCode(proxyAddress);
if (proxyCode.includes('363d3d373d3d3d363d73')) {
    // EIP-1167 Minimal Proxy (signatureType = 1)
} else if (proxyCode.length > 100) {
    // 可能是 Gnosis Safe (signatureType = 2)
}
```

## 订单结构

### EIP-712 订单类型

```typescript
const ORDER_TYPES = {
    Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },      // Proxy 地址
        { name: 'signer', type: 'address' },     // EOA 地址
        { name: 'tokenId', type: 'uint256' },    // 条件代币 ID
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'side', type: 'uint8' },         // 0=BUY, 1=SELL
        { name: 'signatureType', type: 'uint8' },
        { name: 'timestamp', type: 'uint256' },  // 毫秒时间戳
        { name: 'metadata', type: 'bytes32' },   // 默认 0x00
        { name: 'builder', type: 'bytes32' },    // builder code 或 0x00
    ],
};
```

### EIP-712 Domain

```typescript
// 普通市场
const DOMAIN = {
    name: 'Polymarket CTF Exchange',
    version: '2',
    chainId: 137,  // Polygon
    verifyingContract: '0xE111180000d2663C0091e4f400237545B87B996B',
};

// NegRisk 市场
const NEG_RISK_DOMAIN = {
    name: 'Polymarket CTF Exchange',
    version: '2',
    chainId: 137,
    verifyingContract: '0xe2222d279d744050d28e00520010520000310F59',
};
```

### 金额计算

```typescript
// USDC 使用 6 位小数
const DECIMALS = 6;

// BUY 订单: maker 给 USDC, taker 给 shares
if (side === 'BUY') {
    makerAmount = size * price * 1e6;  // USDC 数量
    takerAmount = size * 1e6;          // Shares 数量
}

// SELL 订单: maker 给 shares, taker 给 USDC
if (side === 'SELL') {
    makerAmount = size * 1e6;          // Shares 数量
    takerAmount = size * price * 1e6;  // USDC 数量
}
```

### Salt 生成

```typescript
const salt = Math.round(Math.random() * Date.now());
```

## API 端点

### 下单

```
POST /order
Content-Type: application/json

{
    "order": {
        "salt": 1234567890,
        "maker": "0x...",           // Proxy 地址
        "signer": "0x...",          // EOA 地址
        "taker": "0x0000...0000",
        "tokenId": "12345...",
        "makerAmount": "50000",
        "takerAmount": "5000000",
        "expiration": "0",          // GTC 必须为 "0"
        "nonce": "0",
        "feeRateBps": "0",
        "side": "BUY",              // 字符串: "BUY" 或 "SELL"
        "signatureType": 2,
        "signature": "0x..."
    },
    "owner": "api-key-uuid",        // API Key (不是地址!)
    "orderType": "GTC"              // GTC, GTD, FOK, IOC
}
```

**响应：**
```json
{
    "orderID": "0x..."
}
```

### 取消单个订单

```
DELETE /order
Content-Type: application/json

{
    "orderID": "0x..."
}
```

**响应：**
```json
{
    "canceled": ["0x..."],
    "not_canceled": {}
}
```

### 取消多个订单

```
DELETE /orders
Content-Type: application/json

["0x...", "0x..."]
```

### 取消所有订单

```
DELETE /cancel-all
```

### 取消市场所有订单

```
DELETE /cancel-market-orders
Content-Type: application/json

{
    "market": "condition_id",  // 可选
    "asset_id": "token_id"     // 可选
}
```

## 订单类型

| 类型 | 说明 | expiration |
|------|------|------------|
| GTC | Good-Till-Cancelled | `"0"` |
| GTD | Good-Till-Date | Unix 时间戳 |
| FOK | Fill-Or-Kill | - |
| IOC | Immediate-Or-Cancel | - |

## 限制条件

| 限制 | 值 |
|------|-----|
| 最小订单量 | 5 shares |
| 价格精度 | $0.01 (tick_size) |
| 价格范围 | $0.01 - $0.99 |
| API 限速 | 未公开 |

## 延迟统计

基于实测数据：

| 操作 | 延迟 |
|------|------|
| 订单签名 | ~8-15ms |
| 订单提交 | ~265-285ms |
| 订单撤销 | ~265-275ms |
| **总往返** | **~530-560ms** |

## 常见错误

| 错误 | 原因 | 解决方案 |
|------|------|----------|
| `Invalid order payload` | 订单格式错误 | 检查字段类型和格式 |
| `the order owner has to be the owner of the API KEY` | owner 字段错误 | owner 应为 API Key |
| `invalid signature` | 签名类型错误 | 检查 signatureType |
| `invalid expiration value` | GTC 订单 expiration 非零 | 设置 expiration = "0" |
| `Size lower than the minimum: 5` | 订单量太小 | 最小 5 shares |
| `Unauthorized/Invalid api key` | 认证失败 | 检查 Headers，确保包含 POLY_ADDRESS |

## 代码位置

| 文件 | 用途 |
|------|------|
| [test-order.ts](../bot/src/terminal/test-order.ts) | 下单/取消测试脚本 |
| [cancel-all-orders.ts](../bot/src/terminal/cancel-all-orders.ts) | 取消所有订单脚本 |
| [verify-proxy.ts](../bot/src/terminal/verify-proxy.ts) | 代理钱包验证脚本 |
| [derive-api-key.ts](../bot/src/terminal/derive-api-key.ts) | API Key 派生测试 |
| [test-balance.ts](../bot/src/terminal/test-balance.ts) | 余额查询测试 |

## 待完善功能

1. **订单客户端封装**
   - 统一的 `PolymarketOrderClient` 类
   - 自动重试和错误处理
   - 订单状态追踪

2. **批量订单**
   - POST /orders 批量下单
   - 原子性保证

3. **订单查询**
   - GET /data/orders 查询订单状态
   - WebSocket 订单更新订阅

4. **风控模块**
   - 最大持仓限制
   - 单笔订单限额
   - 频率限制

5. **Maker 策略**
   - 双边报价
   - 动态价差
   - 库存管理

## 参考资料

- [Polymarket CLOB 文档](https://docs.polymarket.com/)
- [py-clob-client-v2](https://github.com/Polymarket/py-clob-client-v2)
- [clob-client-v2 (TypeScript)](https://github.com/Polymarket/clob-client-v2)
- [CTF Exchange V2 合约](https://polygonscan.com/address/0xE111180000d2663C0091e4f400237545B87B996B)
