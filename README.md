# Predict-Polymarket 套利交易机器人

Predict.fun 与 Polymarket 跨平台套利交易机器人。实时监控双平台订单簿，自动识别并执行套利机会。

---

## 核心功能

- **Web Dashboard**: 实时套利面板，一键下单、任务管理、持仓监控
- **跨平台市场匹配**: 自动识别 Predict ↔ Polymarket 关联市场（含体育三方事件）
- **深度感知计算**: 订单簿深度分析，精确计算可执行数量与利润
- **双策略执行**: PREDICT_MAKER（挂单等待 + 对冲）与 TAKER（双边同时吃单）
- **Telegram 通知**: 实时套利机会、成交、对冲状态推送

---

## 套利原理

```
YES 端套利 (arbSide='YES'):
  Predict 买 YES + Polymarket 买 NO = 锁定利润
  条件: predict_ask + polymarket_ask + fee < 1.0

NO 端套利 (arbSide='NO'):
  Predict 买 NO + Polymarket 买 YES = 锁定利润
  条件: predict_ask + polymarket_ask + fee < 1.0
```

| 策略 | 说明 | 优势 |
|-----|------|------|
| PREDICT_MAKER | 在 Predict 挂单，成交后 Polymarket 对冲 | 无 Maker 手续费，利润更高 |
| TAKER | 双边同时吃单 | 执行速度快，滑点可控 |

---

## 快速开始

### 1. 安装依赖

```bash
npm install

```

### 2. 配置环境变量

```bash
cp .env.example .env
```

然后编辑 `.env` 填写各项配置，详见下方说明。

### 3. 运行

```bash
# Web Dashboard（默认端口 3010）
npm run dashboard
```

---

## 环境变量配置详解

### Predict 配置

```env
PREDICT_API_KEY=<从 https://predict.fun/settings/api 获取>
PREDICT_SIGNER_PRIVATE_KEY=<Privy 嵌入式钱包私钥>
PREDICT_SMART_WALLET_ADDRESS=<Predict 充值地址>
```

**说明**:

| 变量 | 来源 | 说明 |
|-----|------|------|
| `PREDICT_API_KEY` | [predict.fun/settings/api](https://predict.fun/settings/api) | 在 Predict 网站设置页面创建 |
| `PREDICT_SIGNER_PRIVATE_KEY` | Privy 嵌入式钱包 | Privy 生成的 EOA 钱包私钥，用于 EIP-712 订单签名 (签名地址由私钥自动派生，无需单独配置) |
| `PREDICT_SMART_WALLET_ADDRESS` | Predict 网站充值页面 | 这是你在 Predict 上的充值地址（智能合约钱包），USDT 余额存放于此 |

> **如何获取 Privy 钱包信息**: 登录 predict.fun 后，在浏览器开发者工具的 Application → Local Storage 中可以找到 Privy 嵌入式钱包的地址和加密密钥信息。具体提取方式取决于 Privy 的版本和集成方式。

### Polymarket 配置

```env
POLYMARKET_TRADER_PRIVATE_KEY=<交易钱包私钥>
POLYMARKET_PROXY_ADDRESS=<代理钱包地址（资金所在）>
POLYMARKET_API_KEY=<L2 API Key>
POLYMARKET_API_SECRET=<L2 API Secret>
POLYMARKET_PASSPHRASE=<L2 API Passphrase>
```

**说明**:

| 变量 | 说明 |
|-----|------|
| `POLYMARKET_TRADER_PRIVATE_KEY` | 你在 Polymarket 上使用的 EOA 钱包私钥，用于签署订单和派生 API 凭证 |
| `POLYMARKET_PROXY_ADDRESS` | Polymarket 的 Gnosis Safe 代理钱包地址，实际持有资金的地址 |
| `POLYMARKET_API_KEY` | CLOB API 凭证，通过私钥派生获取（见下方） |
| `POLYMARKET_API_SECRET` | CLOB API 凭证 |
| `POLYMARKET_PASSPHRASE` | CLOB API 凭证 |
| `POLY_BUILDER_CODE` | 可选，Polymarket CLOB V2 builder attribution bytes32；不填则按 0x00 提交 |

### Polymarket API Key 生成方法

Polymarket 的 API Key / Secret / Passphrase 是通过 EIP-712 签名从你的交易私钥派生的，不是在网站上手动创建。

**方法一: Python 脚本（推荐，一键完成全部配置）**

```bash
# 安装依赖
pip install py-clob-client-v2 eth-account eth-utils requests

# 运行（交互式输入私钥，自动派生 API 凭证 + 查询代理钱包地址 + 写入 .env）
python tools/get-pm-apikey.py

# 或直接传入私钥
python tools/get-pm-apikey.py 0x你的私钥

# 仅查看结果不写入
python tools/get-pm-apikey.py --dry-run 0x你的私钥
```

此脚本会自动完成:
1. 从私钥派生 EOA 地址
2. 通过 CLOB API 派生 API Key / Secret / Passphrase
3. 通过 Gnosis Safe API 查询代理钱包地址
4. 将所有配置写入 `.env` 文件

**方法二: TypeScript 脚本**

```bash
# 先在 .env 中填好 POLYMARKET_TRADER_PRIVATE_KEY
npx tsx src/terminal/derive-poly-apikey.ts

# 强制创建新 Key（会删除旧 Key）
npx tsx src/terminal/derive-poly-apikey.ts --new
```

**方法三: 使用 py-clob-client-v2 手动派生**

```python
from py_clob_client.client import ClobClient

client = ClobClient(
    host="https://clob.polymarket.com",
    chain=137,
    key="0x你的私钥",
    signature_type=0,  # EOA
    funder="你的EOA地址",
)
creds = client.create_or_derive_api_creds()
print(f"API Key:    {creds.api_key}")
print(f"Secret:     {creds.api_secret}")
print(f"Passphrase: {creds.api_passphrase}")
```

### Telegram 配置（可选）

```env
TELEGRAM_BOT_TOKEN=<BotFather 创建的 Bot Token>
TELEGRAM_CHAT_ID=<接收通知的 Chat ID>
```

---

## 常用命令

```bash
# Dashboard
npm run dashboard                # 启动 (默认端口 3010)

# 市场扫描
npm run scan-markets             # 全量市场扫描

# 类型检查
npx tsc --noEmit

# PM2 部署
pm2 start ecosystem.config.cjs
pm2 logs dashboard
```

---

## 项目结构

```
predict_arb/
├── src/
│   ├── dashboard/             # Dashboard 后端 + React 前端
│   │   ├── frontend/preview/  # 无构建 vanilla JSX 前端
│   │   ├── taker-mode/        # TAKER 双边同时下单执行器
│   │   └── task-logger/       # 异步队列、JSONL 持久化、通知集成
│   ├── arb/                   # 套利检测引擎
│   ├── trading/               # 价格工具、深度计算、下单客户端
│   ├── config/                # 配置管理
│   ├── services/              # BSC/WS 监控、缓存
│   ├── polymarket/            # Polymarket REST + WS 客户端
│   ├── predict/               # Predict REST 客户端
│   ├── notification/          # Telegram 通知
│   └── terminal/              # CLI 工具脚本
├── tools/                     # 辅助工具 (API Key 派生等)
├── data/                      # 运行时数据
├── sdk/                       # Predict SDK (git 子模块)
└── docs/                      # 架构文档
```

---

## 技术栈

- **语言**: TypeScript (ESM)
- **区块链**: ethers.js v6 (BSC + Polygon)
- **API**: Predict.fun REST + Polymarket CLOB REST/WebSocket
- **前端**: React (无构建 vanilla JSX)
- **实时推送**: Server-Sent Events (SSE)
- **通知**: Telegram Bot API
- **部署**: PM2

---

## 安全说明

- 所有私钥存储在 `.env` 文件中，已添加到 `.gitignore`
- API Key 使用环境变量，不硬编码
- Dashboard 任务执行有深度监控与并发控制

---

## 相关资源

- [Predict API 文档](https://dev.predict.fun/)
- [Predict SDK](https://github.com/PredictDotFun/sdk)
- [Polymarket API 文档](https://docs.polymarket.com/)

---

**免责声明**: 本项目仅供学习和研究使用。交易有风险，投资需谨慎。使用本软件进行交易所产生的任何损失，开发者不承担责任。
