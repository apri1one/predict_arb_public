# Architecture (Docs Phase)

This diagram defines the target module boundaries and data flows. Implementation is deferred.

```mermaid
flowchart LR
  subgraph Predict
    P_REST[REST API\n/v1/markets\n/v1/markets/{id}/orderbook\n/v1/orders/matches]
  end

  subgraph Polymarket
    PM_CLOB_REST[CLOB REST\n/book /books /price ...]
    PM_CLOB_WS[CLOB WebSocket\nwss://ws-subscriptions-clob.polymarket.com]
    PM_DATA[Data API\nhttps://data-api.polymarket.com]
    PM_GAMMA[Gamma API\nhttps://gamma-api.polymarket.com]
  end

  subgraph Bot
    MAP[Market+Outcome Mapper\n(strict)]
    OB[Orderbook Normalizer\n(levels, units)]
    FEES[Fee Model\n(Predict taker fee)]
    CALC[Depth-aware Arb Engine\nYES+NO(+fee) <= 1]
    RISK[Risk Controls\n(size caps, unhedged time)]
    ALERTS[Alerts\n(Telegram)]
    EXEC[Execution Layer\n(deferred)]
    STORE[Storage\n(mapping + metrics)]
  end

  P_REST --> MAP
  PM_DATA --> MAP
  PM_GAMMA --> MAP

  P_REST --> OB
  PM_CLOB_REST --> OB
  PM_CLOB_WS --> OB

  MAP --> CALC
  OB --> CALC
  FEES --> CALC
  CALC --> RISK
  RISK --> EXEC
  RISK --> ALERTS
  CALC --> STORE
  MAP --> STORE
```

## Module responsibilities (target)

### 1) Market+Outcome Mapper
- Builds a strict mapping between Predict market+outcome ↔ Polymarket token_id (YES/NO).
- Input sources: Predict `polymarketConditionIds`, Polymarket Data/Gamma endpoints.
- Output: stable mapping table with manual override capability.

### 2) Orderbook Normalizer
- Ingests orderbook snapshots/updates from both venues.
- Normalizes:
  - price units (always $ in [0,1])
  - size units (shares/contracts)
  - ordering (asks ascending, bids descending)
- Produces depth ladders suitable for average fill cost computation.

### 3) Fee Model
- Predict taker fee per share from docs (validated against API `feeRateBps` and live fills).
- Polymarket assumed 0 fee (to validate).

### 4) Depth-aware Arb Engine
- Consumes normalized ladders and fee model.
- Computes `avgCostYES(Q)` / `avgCostNO(Q)` and maximal executable `Q*` for `minProfit=0`.

### 5) Risk / Ops
- Enforces size limits, max unhedged time, max slippage, and circuit breakers.
- Sends alerts (Telegram).
- Records metrics for latency and opportunity quality.

