# Predict-Polymarket 跨平台套利交易机器人

预测市场实盘交易系统，由个人做市商独立开发与运营。实时监控 **Predict.fun** 与 **Polymarket** 双平台订单簿，自动识别跨平台套利机会并执行双腿下单。

![TypeScript](https://img.shields.io/badge/TypeScript-ESM-blue)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)
![License](https://img.shields.io/badge/License-MIT-yellow)

> **实盘系统，不是玩具。** 本仓库是一套自 2026 年 4 月起以真实资金运行、多台云服务器 7×24 部署的交易系统的公开快照。实盘换来的经验教训整理在下方 [实盘踩坑录](#实盘踩坑录) 章节。
>
> English version: [README.md](README.md)

---

## 核心功能

- **Web Dashboard** — 实时套利面板，一键下单、任务管理、持仓监控（SSE 推送，无轮询）
- **跨平台市场匹配** — 自动识别 Predict ↔ Polymarket 关联市场（含体育三方事件胜/平/负分解）
- **深度感知计算** — 遍历双边订单簿深度，精确计算可执行数量与利润，而非只信盘口价
- **双策略执行** — `PREDICT_MAKER`（挂单等待 + 成交后对冲）与 `TAKER`（双边同时吃单）
- **幽灵深度检测** — 在滑点发生前识别 Polymarket 虚假/过期深度（见踩坑录）
- **GTC 保底对冲** — 主对冲失败时走升级链（抬价 IOC → 保本 GTC），防止裸敞口
- **链上成交检测** — 监听 BSC 链上事件确认成交，而非轮询 REST
- **Telegram 通知** — 套利机会、成交、对冲状态、异常告警实时推送

## 套利原理

预测市场份额结算价为 $1 或 $0。若一个平台的 YES 加另一个平台的 NO 合计成本低于 $1，差额即为无论结果如何都锁定的利润：

```
YES 端套利 (arbSide='YES'):
  Predict 买 YES + Polymarket 买 NO
  条件: predict_ask + polymarket_ask + fee < 1.0

NO 端套利 (arbSide='NO'):
  Predict 买 NO + Polymarket 买 YES
  条件: predict_ask + polymarket_ask + fee < 1.0
```

| 策略 | 说明 | 优势 |
|-----|------|------|
| `PREDICT_MAKER` | 在 Predict 挂 GTC 单，成交瞬间去 Polymarket 对冲 | 无 Maker 手续费，利润空间更大 |
| `TAKER` | 双边同时吃单 | 执行快，滑点上限可控 |

难的从来不是数学，而是「数字说可以」到「两条腿都真正成交」之间发生的一切——下面的工程正是为这段间隙而存在。

## 项目结构

```
src/
├── arb/                   # 套利检测引擎
├── dashboard/             # Dashboard 后端 + React 前端（SSE 推送）
│   ├── frontend/preview/  #   无构建 vanilla JSX 前端
│   ├── taker-mode/        #   TAKER 双边同时下单执行器
│   └── task-logger/       #   异步队列、JSONL 持久化、通知集成
├── market-maker/          # 做市引擎（Ink.js CLI）
├── polymarket/            # Polymarket CLOB REST + WebSocket 客户端
├── predict/               # Predict.fun REST 客户端
├── polymarket-dashboard/  # 独立 Polymarket 体育面板
├── probable/              # Probable Markets REST 客户端（第三平台）
├── services/              # BSC 链上监控、WS 健康、缓存
├── trading/               # 价格工具、深度计算、下单客户端
├── notification/          # Telegram 通知
├── terminal/              # CLI 工具（扫描器、订单簿查看）
└── config/                # 静态配置（BSC RPC failover 列表）
tools/                     # 钱包 / API Key 派生与冒烟测试
scripts/                   # 运维脚本（PM2 runner、指标报表）
docs/                      # 架构与设计文档
```

核心数据流：市场扫描器建立跨平台映射 → WebSocket 订阅让双边订单簿常驻内存 → 套利引擎逐 tick 重评 → 执行任务走状态机、每任务独立 JSONL 审计日志 → BSC 事件监听链上确认成交。

## 实盘踩坑录

以下每一条都是用真金白银换来的——来自本系统及其私有做市引擎后继者的实盘运行。每条教训都落地为自动化修复，而不只是文档里的一句备注。

**1. 「MATCHED」不等于成交。**
Polymarket 订单 API 会在同一份响应里返回 `status=MATCHED` 但 `size_matched=0`。三种成因：(a) API 同步延迟——短重试即恢复；(b) negRisk 自成交被回滚；(c) 真实 0 成交——缓存的卖价在撮合瞬间已被吃光（「幽灵深度」）。修法：带退避的重试后按取消处理，并在事件前后**连续**采集订单簿快照留作复盘取证——单一时间点的快照永远分不清 (a) 和 (c)。

**2. 交易所会异步作废你的订单。**
Predict 强制撤单的终态是 `INVALIDATED` 而非 `CANCELLED`。早期代码只认后者，把被作废的单误判为仍在挂，账本里堆积幽灵挂单。修法：所有终态一视同仁 + 全局对账循环 + 限时窗口内自动重挂。

**3. 最致命的状态是「已成交、未对冲」。**
Maker 腿成交而对冲 IOC 零成交时，天真的实现会暂停等主循环重试——但若后续没有新 tick，任何代码路径都不会醒来，裸敞口一直扛到市场结算。修法：零成交分支立即走升级链（抬价 IOC → 保本 GTC）并告警。永远不要指望「下一个 tick 会救场」——流动性薄的市场可能根本没有下一个 tick。

**4. 浮点数会吃掉你的利润。**
IEEE 754 下 `1.0 - 0.32 !== 0.68`。所有价格必须过 tick 对齐取整；Predict 还要求订单金额对齐 1e13（`amount % 1e13 === 0`）。一位没对齐 → 订单被拒 → 错过对冲窗口。

**5. 搞清楚你交易的是哪个时间戳。**
Polymarket 同时暴露市场级 `end_date_iso`（CLOB）和事件级 `endDate`（Gamma API），体育市场上两者可能差异巨大。风控模型用错时间戳，你以为「距结算还有 2 小时」的市场其实 10 分钟后就结算。

**6. negRisk 市场需要纵深防御。**
negRisk（多结果）市场的订单签名方式不同，flag 错了会产生本地验证通过、远端被拒（甚至错误执行）的签名。系统做了三层：市场扫描时强制校正 → 每次执行前 preflight 检查 → EIP-712 签名自检并与 CLOB 报告的 negRisk flag 比对。

**7. 关键订单绝不能排在常规订单后面。**
私有做市引擎中，退出（止损）单曾与常规报价共享同一条限流 FIFO——一张止损单排队 105 秒，市场早已跑远。修法：一切降风险操作走独立限流通道。限流是架构决策，不是包一层 wrapper。

**8. 可观测性救你的命；不轮转的日志要你的命。**
每任务 JSONL 审计日志、异常时订单簿快照采集、贯穿订单全生命周期的可 grep 追踪标记，让大多数事故几分钟内可诊断。同一套日志也曾撑爆服务器根分区、整机下线。这句话的前后两半都是教训。

## 快速开始

### 1. 安装依赖

```bash
npm install
pip install -r tools/requirements.txt   # Polymarket 凭证自动派生所需
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

只需填 **4 个值**，其余全部自动派生：

```env
PREDICT_API_KEY=                  # predict.fun/settings/api 创建
PREDICT_SIGNER_PRIVATE_KEY=       # Predict 签名钱包私钥（获取方式见官方文档 dev.predict.fun）
PREDICT_SMART_WALLET_ADDRESS=     # Predict 充值地址（智能钱包）
POLYMARKET_TRADER_PRIVATE_KEY=    # Polymarket 交易钱包私钥
```

启动时检测到 Polymarket 代理地址与 L2 API 凭证（key/secret/passphrase）为空，会自动从私钥派生并写回 `.env`，无需手动配置。也可单独派生：

```bash
python tools/get-pm-apikey.py                      # 交互式输入私钥，写入 .env
python tools/get-pm-apikey.py --dry-run 0x<私钥>   # 仅预览不写入
```

### 3. 运行

```bash
npm run dashboard -- --use-cache   # 推荐：使用市场缓存秒级启动
npm run dashboard                  # 首次运行 / 强制刷新市场列表（全量扫描约 4 分钟）
```

其他命令：

```bash
npm run scan-markets      # 全量市场扫描
npx tsc --noEmit          # 类型检查
pm2 start ecosystem.config.cjs   # 生产部署
```

## 技术栈

- **语言**: TypeScript (ESM)，工具链 Python
- **区块链**: ethers.js v6 (BSC + Polygon)、EIP-712 订单签名、智能钱包 (Predict) + 代理钱包 (Polymarket) 双体系
- **API**: Predict.fun REST · Polymarket CLOB REST/WebSocket · Gamma API
- **前端**: React（无构建 vanilla JSX）、Server-Sent Events
- **运维**: PM2、Docker、Telegram Bot API

## 安全说明

- 私钥仅存于 `.env`（已 gitignore），代码中无任何硬编码凭证
- 任务执行有深度监控与并发控制保护
- 本公开快照不含任何密钥、服务器地址或账户数据

## 相关资源

- [Predict API 文档](https://dev.predict.fun/)
- [Predict SDK](https://github.com/PredictDotFun/sdk)
- [Polymarket API 文档](https://docs.polymarket.com/)

---

**免责声明**: 本项目仅供学习和研究使用。交易有风险，投资需谨慎。使用本软件进行交易所产生的任何损失，开发者不承担责任。
