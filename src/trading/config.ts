/**
 * Trading Configuration
 */

export interface TradingConfig {
    // Account
    predictMaxBalance: number;       // Max USD to use on Predict
    polymarketMaxBalance: number;    // Max USD to use on Polymarket

    // Thresholds
    minProfitPercent: number;        // Minimum profit % to trigger (0 = any profit)
    maxPositionPerMarket: number;    // Max shares per market

    // Timing
    orderbookPollIntervalMs: number; // How often to refresh orderbooks
    orderCheckIntervalMs: number;    // How often to check order status
    maxOrderAgeMs: number;           // Cancel order if not filled after this time

    // Execution
    useRealExecution: boolean;       // true = real trades, false = simulation

    // Risk
    maxSlippagePercent: number;      // Max price movement to tolerate
    emergencyStopLoss: number;       // Stop if losses exceed this USD amount

    // Telegram
    telegramEnabled: boolean;
    telegramBotToken: string;
    telegramChatId: string;
}

export const DEFAULT_CONFIG: TradingConfig = {
    // Account (500 USD each as specified)
    predictMaxBalance: 500,
    polymarketMaxBalance: 500,

    // Thresholds (>= 0 profit as specified)
    minProfitPercent: 0,
    maxPositionPerMarket: 1000,      // 1000 shares max per market

    // Timing
    orderbookPollIntervalMs: 500,    // 500ms refresh
    orderCheckIntervalMs: 200,       // Check order every 200ms
    maxOrderAgeMs: 60000,            // Cancel after 1 minute

    // Execution
    useRealExecution: true,          // Real trades

    // Risk
    maxSlippagePercent: 1,           // 1% max slippage
    emergencyStopLoss: 50,           // Stop if lose $50

    // Telegram (loaded from env)
    telegramEnabled: true,
    telegramBotToken: '',
    telegramChatId: '',
};

export function loadConfigFromEnv(): Partial<TradingConfig> {
    return {
        telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
        telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
        telegramEnabled: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    };
}
