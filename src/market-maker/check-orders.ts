/**
 * 查询订单和持仓状态
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

import { createTradingClient } from './trading-client.js';

async function main() {
    const client = createTradingClient();
    await client.init();

    // 查询市场 709 的活跃订单
    console.log('\n=== 市场 709 活跃订单 ===');
    const orders = await client.fetchOrders(709);
    console.log(`订单数量: ${orders.length}`);
    console.log('原始数据:', JSON.stringify(orders, null, 2));

    // 查询持仓
    console.log('\n=== 市场 709 持仓 ===');
    const position = await client.fetchPosition(709);
    console.log(`持仓: ${position} shares`);

    // 余额
    const balance = await client.getBalance();
    console.log(`\n余额: ${balance.toFixed(4)} USDT`);

    // 尝试多种 API 撤单格式
    if (orders.length > 0) {
        const orderData = orders[0] as any;
        const hash = orderData.order.hash;
        const orderId = orderData.id;

        const apiKey = process.env.PREDICT_API_KEY!;
        const baseUrl = 'https://api.predict.fun';
        const jwt = await client.getJwt();
        const headers = {
            'x-api-key': apiKey,
            'Authorization': 'Bearer ' + jwt,
            'Content-Type': 'application/json'
        };

        console.log('\n=== 使用 API 撤单 (POST /v1/orders/remove) ===');
        console.log(`订单 ID: ${orderId}, Hash: ${hash.slice(0, 30)}...`);

        // 使用 TradingClient 的 cancelOrder 方法
        const result = await client.cancelOrder(orderId);
        console.log(`撤单结果: ${result ? '成功' : '失败'}`);

        // 等待一下再查询
        console.log('\n等待 3 秒...');
        await new Promise(r => setTimeout(r, 3000));

        // 重新查询订单
        console.log('\n=== 再次查询订单 ===');
        const orders2 = await client.fetchOrders(709);
        console.log(`订单数量: ${orders2.length}`);
    }
}

main().catch(console.error);
