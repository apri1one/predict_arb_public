# Predict.fun × Polymarket Cross-Platform Arbitrage Bot

A real-money trading system for prediction markets, built and operated by a solo market maker. It monitors orderbooks on **Predict.fun** and **Polymarket** in real time, detects cross-platform arbitrage opportunities, and executes both legs automatically.

![TypeScript](https://img.shields.io/badge/TypeScript-ESM-blue)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green)
![License](https://img.shields.io/badge/License-MIT-yellow)

> **Production, not a demo.** This is a public snapshot of a system that has been trading real capital since January 2026, running 24/7 across multiple cloud servers. The hard-won operational knowledge is documented in [Lessons from Production](#lessons-from-production) below.
>
> 中文版说明见 [README.zh.md](README.zh.md)

---

## Highlights

- **Web dashboard** — live arbitrage panel with one-click execution, task management, position monitoring (Server-Sent Events, no polling)
- **Cross-platform market matching** — automatically links Predict ↔ Polymarket markets, including three-way sports events (win/draw/lose decomposition)
- **Depth-aware sizing** — walks both orderbooks to compute the exact executable quantity and profit, instead of trusting top-of-book prices
- **Two execution strategies** — `PREDICT_MAKER` (post a maker order, hedge on fill) and `TAKER` (hit both sides simultaneously)
- **Phantom-depth detection** — identifies stale/fake Polymarket depth before it turns into slippage (see lessons below)
- **GTC fallback hedging** — if the primary hedge fails, an escalation chain (re-priced IOC → break-even GTC) prevents naked exposure
- **On-chain fill detection** — listens to BSC events for order fills rather than polling REST
- **Telegram notifications** — opportunities, fills, hedge status, and anomaly alerts in real time

## The Arbitrage Model

Prediction market shares resolve to $1 or $0. If YES on one platform plus NO on the other costs less than $1 combined, the difference is locked-in profit regardless of outcome:

```
YES-side arb (arbSide='YES'):
  Buy YES on Predict + Buy NO on Polymarket
  Condition: predict_ask + polymarket_ask + fees < 1.0

NO-side arb (arbSide='NO'):
  Buy NO on Predict + Buy YES on Polymarket
  Condition: predict_ask + polymarket_ask + fees < 1.0
```

| Strategy | How it works | Edge |
|----------|--------------|------|
| `PREDICT_MAKER` | Post a GTC maker order on Predict; hedge on Polymarket the moment it fills | No maker fee → wider margin |
| `TAKER` | Take liquidity on both platforms simultaneously | Speed; slippage is bounded upfront |

The hard part is not the math — it is everything that happens between "the numbers said yes" and "both legs are actually filled". That gap is where the engineering below lives.

## Architecture

```
src/
├── arb/                   # Arbitrage detection engine
├── dashboard/             # Dashboard backend + React frontend (SSE push)
│   ├── frontend/preview/  #   Build-free vanilla JSX frontend
│   ├── taker-mode/        #   TAKER dual-leg simultaneous executor
│   └── task-logger/       #   Async queue, JSONL persistence, notifications
├── market-maker/          # Market-making engine (Ink.js CLI)
├── polymarket/            # Polymarket CLOB REST + WebSocket clients
├── predict/               # Predict.fun REST client
├── polymarket-dashboard/  # Standalone Polymarket sports dashboard
├── probable/              # Probable Markets REST client (third platform)
├── services/              # BSC on-chain monitoring, WS health, caches
├── trading/               # Price utils, depth calculation, order clients
├── notification/          # Telegram notifications
├── terminal/              # CLI tools (scanners, orderbook viewer)
└── config/                # Static config (BSC RPC failover list)
tools/                     # Wallet / API-key derivation & smoke tests
scripts/                   # Ops scripts (PM2 runner, metrics reports)
docs/                      # Architecture & design docs
```

Key data flow: market scanners build the cross-platform mapping → WebSocket subscriptions keep both orderbooks hot in memory → the arb engine re-evaluates on every tick → execution tasks run through a state machine with per-task JSONL audit logs → BSC event listeners confirm fills on-chain.

## Lessons from Production

Everything below was learned the expensive way — by running this system (and its private market-making successor) on real money. Each item shipped with an automated fix, not just a note in a doc.

**1. "MATCHED" does not mean filled.**
Polymarket's order API can return `status=MATCHED` with `size_matched=0` in the same response. Three distinct causes: (a) API replication lag — a short retry loop resolves it; (b) negRisk self-trade rollback; (c) genuine zero fill because the cached ask was consumed in the matching instant ("phantom depth"). The fix: retry with backoff, then treat as cancelled — and continuously capture orderbook snapshots around the event for post-mortem forensics, because a single snapshot can never distinguish (a) from (c).

**2. Exchanges invalidate orders asynchronously.**
Predict force-cancels orders with a terminal status of `INVALIDATED` — not `CANCELLED`. Early code only recognized `CANCELLED`, misread invalidated orders as still open, and accumulated ghost orders in its books. Fix: treat all terminal states as terminal, run a global reconciliation loop, and re-place within a bounded window.

**3. The deadliest state is "filled but unhedged".**
When the maker leg fills and the hedge IOC returns zero fill, a naive implementation pauses and waits for the main loop to retry — but if no further ticks arrive, no code path ever wakes up, and you carry naked exposure until market resolution. Fix: the zero-fill branch immediately escalates through a fallback chain (re-priced IOC → break-even GTC) and alerts. Never rely on "the next tick will fix it" — in thin markets there may be no next tick.

**4. Floating point will eat your margin.**
`1.0 - 0.32 !== 0.68` in IEEE 754. Every price must pass through tick-aligned rounding; Predict additionally requires order amounts aligned to 1e13 wei-units (`amount % 1e13 === 0`). One unaligned digit → rejected order → missed hedge window.

**5. Know which timestamp you are trading against.**
Polymarket exposes a market-level `end_date_iso` (CLOB) and an event-level `endDate` (Gamma API) — for sports they can differ materially. Settling your risk model on the wrong one means your "2 hours to settlement" market actually resolves in 10 minutes.

**6. negRisk markets need defense in depth.**
Orders on negRisk (multi-outcome) markets sign differently. A wrong flag produces a signature that verifies locally and gets rejected (or worse, mis-executed) remotely. The system runs three layers: forced correction at market-scan time → a preflight check before every execution → an EIP-712 self-verification against the CLOB's reported negRisk flag.

**7. Critical orders must not queue behind routine ones.**
In the private market-making engine, exit (stop-loss) orders once shared a rate-limit FIFO with routine quote updates — an exit order sat in queue for 105 seconds while the market moved. Fix: a dedicated rate-limit lane for anything risk-reducing. Rate limiting is an architecture decision, not a wrapper.

**8. Observability saves you; unrotated logs kill you.**
Per-task JSONL audit trails, orderbook snapshot capture on anomalies, and grep-able trace markers through the full order lifecycle made most incidents diagnosable in minutes. The same logging once filled a server's root partition and took the whole box offline. Both halves of that sentence are the lesson.

## Quick Start

### 1. Install

```bash
npm install
pip install -r tools/requirements.txt   # for Polymarket credential auto-derivation
```

### 2. Configure

```bash
cp .env.example .env
```

Only **4 values** are required — everything else is auto-derived:

```env
PREDICT_API_KEY=                  # create at predict.fun/settings/api
PREDICT_SIGNER_PRIVATE_KEY=       # your Predict signer wallet key (see Predict docs: dev.predict.fun)
PREDICT_SMART_WALLET_ADDRESS=     # your Predict deposit (smart wallet) address
POLYMARKET_TRADER_PRIVATE_KEY=    # your Polymarket trading wallet key
```

On startup, the Polymarket proxy address and L2 API credentials (key/secret/passphrase) are automatically derived from the private key and written back to `.env` — no manual setup. To derive them separately:

```bash
python tools/get-pm-apikey.py                      # interactive, writes to .env
python tools/get-pm-apikey.py --dry-run 0x<key>    # preview only
```

### 3. Run

```bash
npm run dashboard -- --use-cache   # recommended: start in seconds using market cache
npm run dashboard                  # first run / force market rescan (~4 min full scan)
```

Other commands:

```bash
npm run scan-markets      # full market scan
npx tsc --noEmit          # typecheck
pm2 start ecosystem.config.cjs   # production deployment
```

## Tech Stack

- **Language**: TypeScript (ESM), Python for tooling
- **Blockchain**: ethers.js v6 (BSC + Polygon), EIP-712 order signing, smart-wallet (Predict) + proxy-wallet (Polymarket) architectures
- **APIs**: Predict.fun REST · Polymarket CLOB REST/WebSocket · Gamma API
- **Frontend**: React (build-free vanilla JSX), Server-Sent Events
- **Ops**: PM2, Docker, Telegram Bot API

## Security Notes

- Private keys live only in `.env` (gitignored); nothing is hardcoded
- Task execution is guarded by depth monitoring and concurrency control
- This public snapshot contains no keys, no server addresses, and no account data

## Resources

- [Predict API docs](https://dev.predict.fun/)
- [Predict SDK](https://github.com/PredictDotFun/sdk)
- [Polymarket API docs](https://docs.polymarket.com/)

---

**Disclaimer**: This project is for research and educational purposes. Trading involves risk. The author assumes no liability for losses incurred by using this software.
