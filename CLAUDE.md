# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Predict.fun 与 Polymarket 跨平台套利交易机器人。

## 环境与约定

**服务器环境**: Ubuntu Linux (Bash)。使用标准 Unix 命令和语法。
- 使用 `export VARIABLE=value` 设置环境变量
- 项目路径: `~/predict_arb/`

**语言与技术栈**: TypeScript（主力）、Python（脚本/工具）。Shell 脚本用 Bash。

**SSH 与远程连接**:
- 本机即为部署服务器（predict-server, EC2 香港）
- 从本地 Windows 通过 `ssh` 连接本机
- 密钥必须存储在 tmpfs（仅内存），绝不写入磁盘

**开发工作流补充**:
- 修改 TS 代码后必须先编译（`npx tsc --noEmit`）再测试，防止陈旧构建误判
- 调试时必须调用真实 API/MCP 工具获取实时数据，绝不使用近似值
- 修复 Bug 后进行端到端验证，不仅检查类型

## 常用命令

```bash
# Dashboard (主入口, 端口 3010)
npm run dashboard               # 启动 http://localhost:3010 (交互式选择账号)
npm run dashboard -- --env .env.account1 --port 3010 --account account1  # 指定账号
npm run dashboard:all           # 启动所有账号

# Polymarket 独立面板 (端口 4020)
npm run poly-dashboard

# 类型检查 (修改代码后必须运行)
npx tsc --noEmit

# CLI 工具
npm run arb-monitor                      # 套利监控面板
npm run market-maker                     # Predict 做市引擎
npm run market-maker:scalp               # 做市 SCALP 策略
npm run scan-markets                     # 全量市场扫描
npx tsx src/terminal/linked-markets.ts   # 市场匹配扫描

# npm test 脚本
npm run test:polymarket    # Polymarket 连接测试
npm run test:predict       # Predict 连接测试
npm run test:strategy      # 套利策略测试
npm run test:all           # 运行以上三个

# PM2 部署
pm2 start ecosystem.config.cjs           # 后台运行 Dashboard (port 3010)
pm2 restart dashboard                    # 重启
pm2 logs dashboard                       # 查看日志
```

SDK 构建 (仅在修改 `sdk/` 时需要):
```bash
cd sdk && yarn install && yarn build
```

## 项目结构

```
predict_arb/                   # 项目根目录 (package.json, tsconfig.json, .env)
├── src/
│   ├── dashboard/             # Dashboard 后端 + React 前端
│   │   ├── frontend/preview/  # 无构建 vanilla JSX 前端 (components.jsx, app.jsx)
│   │   ├── taker-mode/        # TAKER 双边同时下单执行器
│   │   ├── poly-maker-mode/   # POLY_MAKER: Polymarket GTC 挂单 + Predict Taker 对冲
│   │   ├── task-logger/       # 异步队列、JSONL 持久化、通知集成
│   │   ├── auto-task-create.ts    # 自动批量创建任务
│   │   ├── auto-task-preview.ts   # 候选任务预览与预算分配
│   │   └── batch-task-cancel.ts   # 批量取消任务
│   ├── poly-multi/            # 多账户 Polymarket 对冲 (钱包管理/配对/分布式执行)
│   ├── polymarket-dashboard/  # 独立 Polymarket 体育面板 (端口 4020)
│   ├── probable/              # Probable Markets REST 客户端 (第三平台)
│   ├── arb/                   # 套利检测引擎
│   ├── trading/               # 价格工具、深度计算、下单客户端
│   ├── market-maker/          # 做市引擎 (Ink.js CLI)
│   ├── services/              # BSC/WS 监控、缓存
│   ├── polymarket/            # Polymarket REST + WS 客户端
│   ├── predict/               # Predict REST 客户端
│   ├── notification/          # Telegram 通知
│   └── terminal/              # CLI 工具脚本
├── data/                      # 运行时数据 (slugs、任务日志)
├── sdk/                       # Predict SDK (git 子模块, Yarn + TypeChain)
└── docs/                      # 架构文档、API 文档
```

**前端架构**: `src/dashboard/frontend/preview/` 是无构建的 vanilla JSX 预览层 (通过 `<script>` 加载 React)，Dashboard 后端服务此前端。修改 UI 逻辑时通常改 `src/dashboard/frontend/preview/components.jsx`。

**前端图标规则**: 一律使用 Lucide SVG 图标（通过 `<Icon name="..." />` 组件渲染，UMD 已在 `preview.html` 引入），**禁止使用系统 emoji**。即使 Lucide 没有完全匹配的图标，也优先选语义最贴近的 Lucide 图标，必要时配合文字 badge 增强辨识度，而不要回退到 emoji。常用映射示例：足球→`goal`、电竞→`gamepad-2`、射击→`crosshair`、格斗→`swords`、冰球→`snowflake`、橄榄球→`shield`。

## 架构与业务逻辑

详见 `docs/architecture-reference.md`（数据流、模块职责、状态机、套利原理、签名、价格计算、体育市场逻辑）。

跨会话架构决策记录在 MEMORY.md 中，开始新任务前建议查阅。

### 三种任务策略

| 策略 | 前端标签 | 主动方 | 对冲方 | 执行器 |
|------|---------|--------|--------|--------|
| PREDICT_MAKER | P. | Predict GTC 挂单 | Polymarket IOC | task-executor.ts |
| TAKER | (已禁用) | 双边同时 IOC | — | taker-mode/ |
| POLY_MAKER | M. | Polymarket GTC 挂单 | Predict LIMIT@Ask | poly-maker-mode/executor.ts |

**POLY_MAKER 核心流程**: GTC 下单 → PredictPriceGuard 监控 → PolyFillWatcher 检测成交 → executePredictHedge 对冲 → 价格越限时暂停取消/恢复重挂

## 环境变量

```bash
# Predict (必需)
PREDICT_API_KEY=                    # API Key
PREDICT_SIGNER_PRIVATE_KEY=         # 签名私钥
PREDICT_SMART_WALLET_ADDRESS=       # 智能钱包地址

# Predict (可选 - 多 Key 轮换)
PREDICT_API_KEY_SCAN=               # 扫描专用
PREDICT_API_KEY_SCAN_2=
PREDICT_API_KEY_SCAN_3=

# Polymarket (必需)
POLYMARKET_PROXY_ADDRESS=           # 代理钱包 (资金所在)
POLYMARKET_API_KEY=                 # L2 API Key
POLYMARKET_API_SECRET=              # L2 Secret
POLYMARKET_PASSPHRASE=              # L2 Passphrase
POLYMARKET_TRADER_PRIVATE_KEY=      # 签名私钥

# Telegram (可选)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

## 开发规则

1. **类型安全** - 修改后运行 `npx tsc --noEmit` (hook 自动执行)
2. **端到端验证** - Bug 修复后验证完整流程，不仅检查类型

> 禁止模拟数据、失败即中止、简体中文 — 已在全局 CLAUDE.md 中定义，此处不重复。

## 代码风格

- TypeScript ESM (`"type": "module"`)，导入路径带 `.js` 后缀
- 文件名 kebab-case，4 空格缩进
- camelCase 变量/函数，PascalCase 类型/类
- SDK 有独立 ESLint + Prettier；bot 端 ESLint 规则较宽松
- 双 ethers 版本: `ethers` (v6, 主要) + `ethers5` (v5, Polymarket SDK 兼容)

## 关键注意事项

| 项目 | 说明 |
|-----|------|
| 浮点精度 | 价格计算必须用 `roundToTick()` 或 `.toFixed()` 处理，`1.0 - 0.32` ≠ `0.68` |
| 结算时间 | 使用 Gamma API 事件级 `endDate`，非 CLOB 市场级 `end_date_iso` |
| 套利方向 | YES→NO = arbSide:'YES', NO→YES = arbSide:'NO' |
| Polymarket 最小订单 | $1 USD |
| Predict 精度 | 金额需对齐到 1e13 (amount % 1e13 === 0) |
| 钱包类型 | Predict 用智能钱包，Polymarket 用代理钱包 |
| tsconfig exclude | `src/dashboard/frontend/`、`src/polymarket-dashboard/frontend/` 被排除在编译之外 |
| negRisk 防护 | 三层: sports-service 强制校正 → task-executor CLOB 预检 → polymarket-trader 签名预检 |
| 双端口架构 | Dashboard SSE 在 3010，任务 API 独立端口 3011 (隔离 SSE 流量) |
| 任务策略 | PREDICT_MAKER (P.挂单→Poly对冲)、TAKER (双边IOC)、POLY_MAKER (M.挂单→Predict对冲) |
| Poly 订单簿数据源 | 体育市场使用独立 WS 订阅 (非 REST 轮询)，WS 更新写入 polyOrderbookCache |
| Poly GTC 挂单 | expiration 固定为 0 (永不过期)，过期由 task-executor 定时检查 + executor finally 清理 |
| Predict 无 IOC | 用 LIMIT@Ask + 30s expiry + 手动取消 模拟 taker |
| Poly 延迟指标 | 来自 AccountService positions REST 调用 (~5s 周期)，非订单簿 API |

## 复盘经验

| 经验 | 详情 |
|------|------|
| 敞口告警快照 | `exposure-monitor.tick()` 触发告警时，必须**持续**采集涉事任务的双边订单簿快照（每个 tick 一份）+ Polymarket WS 连接状态（connected/reconnect 次数/lastMessageAt/订阅数）写入该 task 的 `data/logs/tasks/<taskId>/orderbooks.jsonl`。Hedge IOC `MATCHED & size_matched=0` 失败时，单一时间点的快照不够还原"幽灵深度"成因，需要前后连续序列。已实现：`task-executor.captureExposureSnapshot()` + `polymarket/ws-client.getHealthSnapshot()`。 |
| MATCHED but filled=0 | Polymarket REST `/data/order/{id}` 同一份响应里 `status=MATCHED` 但 `size_matched=0`，触发条件：(1) API 延迟同步（重试 200ms × 2 通常即恢复）；(2) negRisk 自成交被回滚；(3) 真实 0 成交（缓存的 ask 在撮合瞬间已被吃光/撤掉，即"幽灵深度"）。代码 `polymarket-trader.ts:1040-1049` 重试 3 次后转 CANCELLED。 |
| IOC 0 fill + Predict FILLED 死角 | `reconcileInflightHedge` 的 0 fill 分支历史上只设 `phantomDepthDetected` + 取消 Predict 单（已成交时为 noop），不主动走 fallback chain，依赖"主循环兜底"。但 Predict 已 FILLED 后 `hash=null` + `isPaused=false` → `depth_pause`/`depth_resume`/`price_resume` 三条入口全不触发，任务陷入"已成交未对冲"死角直到过期。修复：0 fill 分支直接 fire-and-forget 调 `forceHedgeResidual(ctx, side, 'zero_fill')` 走 Tier1 抬价 IOC + Tier2 保本 GTC（事故：2026-05-20 PARIVISION vs Liquid 186 股裸敞口）。 |

## 部署

**PM2 部署** (port 3010):
```bash
pm2 start ecosystem.config.cjs    # 启动 (--port 3010 --use-cache --rescan)
pm2 restart dashboard             # 重启
pm2 logs dashboard                # 查看日志
```

**SSH 服务器** (`predict-server`):
- 项目路径: `~/predict_arb/`
- .env 位置: `~/predict_arb/.env`
- 连接信息见本地 SSH config
