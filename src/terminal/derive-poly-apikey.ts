/**
 * 为 Polymarket 派生 API Key
 * 使用 EIP-712 签名从私钥派生 L2 API 凭证
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync } from 'fs';
import { ethers } from 'ethers';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(process.cwd(), '.env') });

const CLOB_BASE_URL = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

// Polymarket CLOB Auth EIP-712 类型
const CLOB_AUTH_DOMAIN = {
    name: 'ClobAuthDomain',
    version: '1',
    chainId: CHAIN_ID,
};

const CLOB_AUTH_TYPES = {
    ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
    ],
};

const MSG_TO_SIGN = 'This message attests that I control the given wallet';

async function main() {
    console.log('═'.repeat(60));
    console.log('  Polymarket API Key 派生工具');
    console.log('═'.repeat(60));

    const privateKey = process.env.POLYMARKET_TRADER_PRIVATE_KEY;
    const traderAddress = process.env.POLYMARKET_TRADER_ADDRESS;

    if (!privateKey || !traderAddress) {
        console.error('\n❌ 缺少配置:');
        console.error('   - POLYMARKET_TRADER_PRIVATE_KEY');
        console.error('   - POLYMARKET_TRADER_ADDRESS');
        process.exit(1);
    }

    const wallet = new ethers.Wallet(privateKey);
    console.log(`\n📋 钱包信息:`);
    console.log(`  私钥派生地址: ${wallet.address}`);
    console.log(`  配置地址:     ${traderAddress}`);

    if (wallet.address.toLowerCase() !== traderAddress.toLowerCase()) {
        console.error('\n❌ 地址不匹配!');
        process.exit(1);
    }

    // 签署 Level 1 Auth 消息
    console.log('\n🔑 签署认证消息...');
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = 0;

    const message = {
        address: wallet.address,
        timestamp: timestamp.toString(),
        nonce: nonce,
        message: MSG_TO_SIGN,
    };

    const signature = await wallet.signTypedData(CLOB_AUTH_DOMAIN, CLOB_AUTH_TYPES, message);
    console.log(`  Timestamp: ${timestamp}`);
    console.log(`  Nonce: ${nonce}`);
    console.log(`  签名: ${signature.slice(0, 40)}...`);

    // 构建 Level 1 Headers
    const headers: Record<string, string> = {
        'POLY_ADDRESS': wallet.address,
        'POLY_SIGNATURE': signature,
        'POLY_TIMESTAMP': timestamp.toString(),
        'POLY_NONCE': nonce.toString(),
        'Content-Type': 'application/json',
    };

    const forceNew = process.argv.includes('--new');
    interface ApiCreds { apiKey: string; secret: string; passphrase: string }
    let creds: ApiCreds | null = null;

    // --new 模式: 删除旧 key 再创建新的
    if (forceNew) {
        console.log('\n🗑️  删除旧 API Key...');
        try {
            const delRes = await fetch(`${CLOB_BASE_URL}/auth/api-key`, {
                method: 'DELETE',
                headers,
            });
            if (delRes.ok) {
                console.log('  ✅ 旧 Key 已删除');
            } else {
                const errorText = await delRes.text();
                console.log(`  删除失败 (${delRes.status}): ${errorText} (可能无旧 Key)`);
            }
        } catch (e: any) {
            console.log(`  删除错误: ${e.message}`);
        }
    }

    if (!forceNew) {
        // 尝试派生 API Key (如果之前已创建)
        console.log('\n🔑 尝试派生 API Key...');
        try {
            const deriveRes = await fetch(`${CLOB_BASE_URL}/auth/derive-api-key`, {
                method: 'GET',
                headers,
            });

            if (deriveRes.ok) {
                creds = await deriveRes.json() as ApiCreds;
                console.log('  ✅ 派生成功!');
            } else {
                const errorText = await deriveRes.text();
                console.log(`  派生失败 (${deriveRes.status}): ${errorText}`);
            }
        } catch (e: any) {
            console.log(`  派生错误: ${e.message}`);
        }
    }

    // 派生失败或 --new 模式: 创建新 Key
    if (!creds) {
        console.log('\n🔑 创建新 API Key...');
        try {
            const createRes = await fetch(`${CLOB_BASE_URL}/auth/api-key`, {
                method: 'POST',
                headers,
            });

            if (createRes.ok) {
                creds = await createRes.json() as ApiCreds;
                console.log('  ✅ 创建成功!');
            } else {
                const errorText = await createRes.text();
                console.error(`  ❌ 创建失败 (${createRes.status}): ${errorText}`);
                process.exit(1);
            }
        } catch (e: any) {
            console.error(`  ❌ 创建错误: ${e.message}`);
            process.exit(1);
        }
    }

    if (creds) {
        // 写入 .env 文件
        const envPath = resolve(process.cwd(), '.env');
        let envContent = readFileSync(envPath, 'utf-8');

        const updates: Record<string, string> = {
            'POLYMARKET_API_KEY': creds.apiKey,
            'POLYMARKET_API_SECRET': creds.secret,
            'POLYMARKET_PASSPHRASE': creds.passphrase,
        };

        for (const [key, value] of Object.entries(updates)) {
            const regex = new RegExp(`^${key}=.*$`, 'm');
            if (regex.test(envContent)) {
                envContent = envContent.replace(regex, `${key}=${value}`);
            } else {
                envContent = envContent.trimEnd() + `\n${key}=${value}\n`;
            }
        }

        writeFileSync(envPath, envContent, 'utf-8');

        console.log('\n' + '═'.repeat(60));
        console.log('✅ API 凭证已写入 .env 文件:');
        console.log('═'.repeat(60));
        console.log(`POLYMARKET_API_KEY=${creds.apiKey}`);
        console.log(`POLYMARKET_API_SECRET=${creds.secret}`);
        console.log(`POLYMARKET_PASSPHRASE=${creds.passphrase}`);
        console.log('═'.repeat(60));
    }
}

main().catch(console.error);
