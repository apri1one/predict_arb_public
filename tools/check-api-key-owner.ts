import * as dotenv from 'dotenv';
dotenv.config();
import { Wallet } from 'ethers';
import { createHmac } from 'crypto';

const pk = process.env.POLYMARKET_TRADER_PRIVATE_KEY!;
const apiKey = process.env.POLYMARKET_API_KEY!;
const apiSecret = process.env.POLYMARKET_API_SECRET!;
const passphrase = process.env.POLYMARKET_PASSPHRASE!;
const eoa = new Wallet(pk).address;

console.log('EOA:', eoa);
console.log('proxy:', process.env.POLYMARKET_PROXY_ADDRESS);
console.log('apiKey:', apiKey);
console.log();

async function call(addr: string, label: string) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const msg = ts + 'GET' + '/auth/api-keys';
    const secretBytes = Buffer.from(apiSecret.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const sig = createHmac('sha256', secretBytes).update(msg).digest('base64').replace(/\+/g, '-').replace(/\//g, '_');

    const res = await fetch('https://clob.polymarket.com/auth/api-keys', {
        headers: {
            'POLY_ADDRESS': addr,
            'POLY_SIGNATURE': sig,
            'POLY_TIMESTAMP': ts,
            'POLY_API_KEY': apiKey,
            'POLY_PASSPHRASE': passphrase,
        },
    });
    console.log(`[POLY_ADDRESS=${label}=${addr}] status=${res.status} body=${(await res.text()).slice(0, 300)}`);
}

await call(eoa, 'EOA');
await call(process.env.POLYMARKET_PROXY_ADDRESS!, 'PROXY');
