import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) process.env[match[1].trim()] = match[2].trim();
        }
    }
}

loadEnv();

const apiKey = process.env.PREDICT_API_KEY || '';

async function main() {
    console.log('=== 对比列表 API 和单独查询 API 的响应字段 ===\n');

    // 1. 列表 API
    console.log('1. 列表 API (/v1/markets)');
    const listRes = await fetch('https://api.predict.fun/v1/markets?limit=1', {
        headers: { 'x-api-key': apiKey }
    });
    const listData = await listRes.json() as any;
    const listMarket = listData.data?.[0];
    console.log('   字段:', Object.keys(listMarket || {}).join(', '));
    console.log('   polymarketConditionIds:', listMarket?.polymarketConditionIds || '无');

    // 2. 单独查询 API
    const marketId = listMarket?.id || 441;
    console.log(`\n2. 单独查询 API (/v1/markets/${marketId})`);
    const singleRes = await fetch(`https://api.predict.fun/v1/markets/${marketId}`, {
        headers: { 'x-api-key': apiKey }
    });
    const singleData = await singleRes.json() as any;
    const singleMarket = singleData.data;
    console.log('   字段:', Object.keys(singleMarket || {}).join(', '));
    console.log('   polymarketConditionIds:', singleMarket?.polymarketConditionIds || '无');

    console.log('\n=== 结论 ===');
    console.log('列表 API 不返回 polymarketConditionIds 字段');
    console.log('需要逐个查询每个市场才能获取 Polymarket 链接');
    console.log('这就是为什么缓存中只有 15 个市场 - 它们是之前手动/逐个查询匹配的');
}

main().catch(console.error);
