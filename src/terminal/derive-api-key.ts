/**
 * 派生或验证 Polymarket API Key
 * 用于确认 API Key 与 EOA 地址的关联
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import * as crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(process.cwd(), '.env') });

const CLOB_BASE_URL = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

// EIP-712 Domain for API Key derivation
const DERIVE_DOMAIN = {
    name: 'ClobAuthDomain',
    version: '1',
    chainId: CHAIN_ID,
};

const DERIVE_TYPES = {
    ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
    ],
};

interface ApiKeyCreds {
    apiKey: string;
    secret: string;
    passphrase: string;
}

async function deriveApiKey(wallet: ethers.Wallet, nonce: number = 0): Promise<ApiKeyCreds | null> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const address = await wallet.getAddress();

    const message = {
        address: address,
        timestamp: timestamp,
        nonce: nonce,
        message: 'This message attests that I control the given wallet',
    };

    console.log(`  派生参数:`);
    console.log(`    地址: ${address}`);
    console.log(`    时间戳: ${timestamp}`);
    console.log(`    Nonce: ${nonce}`);

    // 签名
    const signature = await wallet.signTypedData(DERIVE_DOMAIN, DERIVE_TYPES, message);
    console.log(`    签名: ${signature.slice(0, 20)}...`);

    // 调用 API
    const url = `${CLOB_BASE_URL}/auth/derive-api-key`;
    const body = JSON.stringify({
        timestamp: timestamp,
        nonce: nonce,
        signature: signature,
    });

    const headers = {
        'Content-Type': 'application/json',
        'POLY_ADDRESS': address,
        'POLY_SIGNATURE': signature,
        'POLY_TIMESTAMP': timestamp,
        'POLY_NONCE': nonce.toString(),
    };

    console.log(`\n  调用 ${url}`);
    const res = await fetch(url, {
        method: 'GET',
        headers,
    });

    if (res.ok) {
        const data = await res.json();
        console.log(`  ✅ 成功: ${JSON.stringify(data, null, 2)}`);
        return data as ApiKeyCreds;
    } else {
        console.log(`  ❌ 失败 (${res.status}): ${await res.text()}`);
        return null;
    }
}

async function main() {
    console.log('═'.repeat(60));
    console.log('  Polymarket API Key 派生测试');
    console.log('═'.repeat(60));

    const privateKey = process.env.POLYMARKET_TRADER_PRIVATE_KEY;
    const configuredAddress = process.env.POLYMARKET_TRADER_ADDRESS;
    const existingApiKey = process.env.POLYMARKET_API_KEY;

    if (!privateKey) {
        console.error('❌ 缺少 POLYMARKET_TRADER_PRIVATE_KEY');
        process.exit(1);
    }

    const wallet = new ethers.Wallet(privateKey);
    const derivedAddress = await wallet.getAddress();

    console.log('\n📋 配置信息:');
    console.log(`  配置的地址:   ${configuredAddress}`);
    console.log(`  派生的地址:   ${derivedAddress}`);
    console.log(`  现有 API Key: ${existingApiKey?.slice(0, 10)}...`);

    if (configuredAddress && configuredAddress.toLowerCase() !== derivedAddress.toLowerCase()) {
        console.warn('\n⚠️  警告: 配置的地址与私钥派生的地址不匹配!');
    }

    console.log('\n🔑 尝试派生 API Key (nonce=0)...');
    await deriveApiKey(wallet, 0);

    console.log('\n' + '═'.repeat(60));
}

main().catch(console.error);
