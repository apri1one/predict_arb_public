/**
 * 查询 Predict 订单并支持取消
 * 用法:
 *   npx tsx src/terminal/query-predict-orders.ts                     # 查询所有活跃订单
 *   npx tsx src/terminal/query-predict-orders.ts 521                 # 查询市场 521 的订单
 *   npx tsx src/terminal/query-predict-orders.ts 521 --cancel        # 取消市场 521 的所有订单
 *   npx tsx src/terminal/query-predict-orders.ts --cancel-id 692138  # 取消指定订单
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { createTradingClient } from '../market-maker/trading-client.js';

async function main() {
    // 解析参数
    const args = process.argv.slice(2);
    let marketId: number | undefined;
    let shouldCancel = false;
    let cancelId: string | undefined;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--cancel') {
            shouldCancel = true;
        } else if (args[i] === '--cancel-id' && args[i + 1]) {
            cancelId = args[i + 1];
            i++;
        } else if (!isNaN(parseInt(args[i], 10))) {
            marketId = parseInt(args[i], 10);
        }
    }

    console.log('═'.repeat(60));
    console.log('  Predict 订单查询工具');
    console.log('═'.repeat(60));

    const client = createTradingClient();
    await client.init();

    // 获取余额
    const balance = await client.getBalance();
    console.log(`\n账户余额: $${balance.toFixed(2)}`);

    // 如果指定了 --cancel-id，直接取消该订单
    if (cancelId) {
        console.log(`\n=== 取消订单 ${cancelId} ===`);
        const success = await client.cancelOrder(cancelId);
        console.log(`结果: ${success ? '✅ 成功' : '❌ 失败'}`);
        console.log('\n' + '═'.repeat(60));
        return;
    }

    // 如果指定市场，查询该市场的订单
    if (marketId) {
        console.log(`\n=== 市场 ${marketId} 活跃订单 ===`);
        const orders = await client.fetchOrders(marketId);

        if (orders.length === 0) {
            console.log('没有活跃订单');
        } else {
            console.log(`找到 ${orders.length} 个订单:\n`);
            // 输出原始数据结构
            console.log('原始数据结构:', JSON.stringify(orders[0], null, 2));
            console.log('');

            for (const order of orders) {
                const o = order as any;
                const orderData = o.order || o;

                // 解析金额 (18位小数)
                const makerAmount = BigInt(orderData.makerAmount || '0');
                const takerAmount = BigInt(orderData.takerAmount || '0');
                const side = orderData.side; // 0 = BUY, 1 = SELL

                let price: number;
                let quantity: number;

                if (side === 0) { // BUY: makerAmount = USDC, takerAmount = shares
                    quantity = Number(takerAmount) / 1e18;
                    price = quantity > 0 ? Number(makerAmount) / 1e18 / quantity : 0;
                } else { // SELL: makerAmount = shares, takerAmount = USDC
                    quantity = Number(makerAmount) / 1e18;
                    price = quantity > 0 ? Number(takerAmount) / 1e18 / quantity : 0;
                }

                console.log(`订单ID: ${o.id}`);
                console.log(`  方向: ${side === 0 ? 'BUY' : 'SELL'} YES`);
                console.log(`  数量: ${quantity.toFixed(2)} shares`);
                console.log(`  价格: $${price.toFixed(4)}`);
                console.log(`  成本: $${(Number(makerAmount) / 1e18).toFixed(4)}`);
                console.log(`  状态: ${o.status}`);
                console.log(`  已成交: ${o.amountFilled ? (Number(o.amountFilled) / 1e18).toFixed(2) : '0'} shares`);
                console.log(`  市场ID: ${o.marketId}`);
                console.log('');
            }

            // 如果要取消
            if (shouldCancel) {
                console.log('\n=== 取消订单 ===');
                const orderIds = orders.map((o: any) => o.id);
                for (const orderId of orderIds) {
                    console.log(`取消订单 ${orderId}...`);
                    const success = await client.cancelOrder(orderId);
                    console.log(`  结果: ${success ? '成功' : '失败'}`);
                }
            }
        }

        // 查询持仓
        console.log(`\n=== 市场 ${marketId} 持仓 ===`);
        const position = await client.fetchPosition(marketId);
        console.log(`持仓: ${position} shares`);
    } else {
        // 查询所有市场的活跃订单
        console.log('\n=== 所有活跃订单 ===');
        console.log('提示: 指定市场 ID 以查询特定市场的订单');
        console.log('用法: npx tsx src/terminal/query-predict-orders.ts <marketId>\n');

        // 查询几个常见市场
        const commonMarkets = [521, 709, 732];
        for (const mid of commonMarkets) {
            try {
                const orders = await client.fetchOrders(mid);
                if (orders.length > 0) {
                    console.log(`市场 ${mid}: ${orders.length} 个订单`);
                    for (const o of orders as any[]) {
                        console.log(`  ${o.id}: ${o.side} ${o.outcome} ${o.remainingQuantity}@${o.price}`);
                    }
                }
            } catch (e) {
                // ignore
            }
        }
    }

    console.log('\n' + '═'.repeat(60));
}

main().catch(console.error);
