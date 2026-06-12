/**
 * 取消所有 Polymarket 订单
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(process.cwd(), '.env') });

const CLOB_BASE_URL = 'https://clob.polymarket.com';

interface EnvConfig {
    polyTraderAddress: string;
    polyApiKey: string;
    polyApiSecret: string;
    polyPassphrase: string;
}

function loadConfig(): EnvConfig {
    return {
        polyTraderAddress: process.env.POLYMARKET_TRADER_ADDRESS || '',
        polyApiKey: process.env.POLYMARKET_API_KEY || '',
        polyApiSecret: process.env.POLYMARKET_API_SECRET || '',
        polyPassphrase: process.env.POLYMARKET_PASSPHRASE || '',
    };
}

function buildHeaders(
    apiKey: string,
    apiSecret: string,
    passphrase: string,
    method: string,
    path: string,
    body: string = '',
    address: string = ''
): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    // 签名消息: timestamp + method + path + body
    const message = timestamp + method + path + body;
    const secretBuffer = Buffer.from(apiSecret, 'base64');
    const signature = crypto
        .createHmac('sha256', secretBuffer)
        .update(message, 'utf-8')
        .digest('base64');
    const urlSafeSignature = signature.replace(/\+/g, '-').replace(/\//g, '_');

    const headers: Record<string, string> = {
        'POLY_ADDRESS': address,  // 必须包含钱包地址
        'POLY_API_KEY': apiKey,
        'POLY_SIGNATURE': urlSafeSignature,
        'POLY_TIMESTAMP': timestamp,
        'POLY_PASSPHRASE': passphrase,
        'Content-Type': 'application/json',
    };

    return headers;
}

async function cancelAllOrders(cfg: EnvConfig): Promise<void> {
    // DELETE /cancel-all 取消所有订单
    const path = '/cancel-all';
    const body = '';

    console.log('🗑️  取消所有订单...');
    console.log(`  端点: DELETE ${CLOB_BASE_URL}${path}`);
    console.log(`  地址: ${cfg.polyTraderAddress}`);

    const headers = buildHeaders(
        cfg.polyApiKey,
        cfg.polyApiSecret,
        cfg.polyPassphrase,
        'DELETE',
        path,
        body,
        cfg.polyTraderAddress  // 添加钱包地址
    );

    const res = await fetch(`${CLOB_BASE_URL}${path}`, {
        method: 'DELETE',
        headers,
    });

    const responseText = await res.text();
    console.log(`  响应状态: ${res.status}`);
    console.log(`  响应内容: ${responseText}`);

    if (res.ok) {
        console.log('✅ 取消请求已发送');
    } else {
        console.log('❌ 取消失败');
    }
}

async function main() {
    console.log('═'.repeat(60));
    console.log('  取消所有 Polymarket 订单');
    console.log('═'.repeat(60));

    const cfg = loadConfig();

    if (!cfg.polyApiKey || !cfg.polyApiSecret || !cfg.polyPassphrase) {
        console.error('❌ 缺少 API 凭证');
        process.exit(1);
    }

    console.log(`\n  API Key: ${cfg.polyApiKey.slice(0, 10)}...`);

    await cancelAllOrders(cfg);

    console.log('\n' + '═'.repeat(60));
}

main().catch(console.error);
