/**
 * Polymarket Trade Service
 *
 * 薄封装 PolymarketTrader，提供下单/撤单/余额查询
 */

import { PolymarketTrader } from '../dashboard/polymarket-trader.js';
import type { PolyOrderRequest, PolyOrderResponse } from './types.js';

export class PolyTradeService {
    private trader: PolymarketTrader;

    constructor() {
        this.trader = new PolymarketTrader({
            privateKey: process.env.POLYMARKET_TRADER_PRIVATE_KEY!,
            proxyAddress: process.env.POLYMARKET_PROXY_ADDRESS!,
            apiKey: process.env.POLYMARKET_API_KEY!,
            apiSecret: process.env.POLYMARKET_API_SECRET!,
            passphrase: process.env.POLYMARKET_PASSPHRASE!,
            disableUserWs: true,
            disableTelegram: true,
        });
    }

    async placeOrder(input: PolyOrderRequest): Promise<PolyOrderResponse> {
        // 前置校验
        if (input.price * input.quantity < 1.0) {
            return { success: false, error: `最低订单金额 $1 (当前 $${(input.price * input.quantity).toFixed(2)})` };
        }
        if (input.price < 0.01 || input.price > 0.99) {
            return { success: false, error: `价格必须在 0.01-0.99 范围内 (当前 ${input.price})` };
        }
        if (input.quantity <= 0) {
            return { success: false, error: `数量必须 > 0 (当前 ${input.quantity})` };
        }

        const result = await this.trader.placeOrder({
            tokenId: input.tokenId,
            side: input.side,
            price: input.price,
            quantity: input.quantity,
            negRisk: input.negRisk,
            orderType: input.orderType || 'GTC',
        });

        return {
            success: result.success,
            orderId: result.orderId,
            error: result.error,
        };
    }

    async cancelOrder(orderId: string): Promise<boolean> {
        try {
            await this.trader.cancelOrder(orderId);
            return true;
        } catch (e: any) {
            console.error(`[PolyTrade] 撤单失败: ${e.message}`);
            return false;
        }
    }

    async getBalance(): Promise<number> {
        return this.trader.getBalance();
    }
}
