/**
 * Arbitrage Detection Types
 * 
 * Type definitions for cross-platform arbitrage detection
 */

// ============================================================================
// Order Book Types
// ============================================================================

export interface OrderBookLevel {
    price: number;
    quantity: number;
    platform: 'polymarket' | 'predict';
}

export interface UnifiedMarketBook {
    polymarket: {
        yesBids: OrderBookLevel[];
        yesAsks: OrderBookLevel[];
        noBids: OrderBookLevel[];
        noAsks: OrderBookLevel[];
        lastUpdate: number;
    } | null;
    predict: {
        yesBids: OrderBookLevel[];
        yesAsks: OrderBookLevel[];
        noBids: OrderBookLevel[];
        noAsks: OrderBookLevel[];
        lastUpdate: number;
    } | null;
}

// ============================================================================
// Arbitrage Types
// ============================================================================

/**
 * Type of arbitrage opportunity
 */
export type ArbitrageType =
    | 'same_platform_binary'   // Buy YES + NO < 1 on same platform
    | 'cross_platform_yes'     // Buy YES cheap, sell YES expensive
    | 'cross_platform_no'      // Buy NO cheap, sell NO expensive
    | 'cross_platform_binary'  // Buy YES on one, buy NO on other < 1
    | 'triangular';            // Complex multi-leg arbitrage

/**
 * A single leg of an arbitrage trade
 */
export interface ArbitrageLeg {
    platform: 'polymarket' | 'predict';
    marketId: string;
    side: 'YES' | 'NO';
    action: 'BUY' | 'SELL';
    price: number;          // Average execution price
    quantity: number;       // Quantity to trade
    cost: number;           // Total cost (price * quantity)
    fees: number;           // Estimated fees
    levels: number;         // How many order book levels consumed
}

/**
 * Complete arbitrage opportunity
 */
export interface ArbitrageOpportunity {
    id: string;
    type: ArbitrageType;
    legs: ArbitrageLeg[];

    // Profitability
    grossProfit: number;           // Raw profit before fees
    totalFees: number;             // All fees combined
    netProfit: number;             // Profit after fees
    profitPercentage: number;      // Net profit / total cost
    roi: number;                   // Return on investment %

    // Execution details
    maxQuantity: number;           // Limited by liquidity
    totalCost: number;             // Capital required
    estimatedValue: number;        // Expected payout

    // Risk metrics
    slippage: number;              // Estimated slippage %
    depthScore: number;            // Liquidity quality 0-100
    latencyRisk: number;           // Risk of price change 0-100

    // Timing
    detectedAt: number;
    expiresAt: number;             // Estimated validity window

    // Status
    isExecutable: boolean;
    reason?: string;               // Why not executable
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface FeeStructure {
    polymarket: {
        makerFee: number;    // e.g., 0.001 = 0.1%
        takerFee: number;    // e.g., 0.002 = 0.2%
    };
    predict: {
        makerFee: number;
        takerFee: number;
    };
}

export interface ArbitrageConfig {
    // Profit thresholds
    minNetProfitPercent: number;      // Minimum profit % to consider (default: 0.5%)
    minNetProfitAbsolute: number;     // Minimum absolute profit (default: $1)

    // Risk parameters
    maxSlippagePercent: number;       // Max acceptable slippage (default: 1%)
    minDepthScore: number;            // Minimum liquidity score (default: 30)
    maxLatencyRiskMs: number;         // Max acceptable data age (default: 500ms)

    // Position sizing
    maxPositionSize: number;          // Max value per trade
    minPositionSize: number;          // Min value to bother

    // Fee structure
    fees: FeeStructure;

    // Execution
    opportunityValidityMs: number;    // How long opportunity is valid (default: 5000ms)
}

// ============================================================================
// Event Types
// ============================================================================

export type ArbitrageEventType =
    | 'opportunity_detected'
    | 'opportunity_expired'
    | 'opportunity_executed'
    | 'market_update';

export interface ArbitrageEvent {
    type: ArbitrageEventType;
    opportunity?: ArbitrageOpportunity;
    timestamp: number;
}

export type ArbitrageCallback = (event: ArbitrageEvent) => void;
