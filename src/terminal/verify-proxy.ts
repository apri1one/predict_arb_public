/**
 * 验证 Polymarket proxy 钱包与 EOA 的关系
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(process.cwd(), '.env') });

// Polygon mainnet RPC
const RPC_URL = 'https://polygon-rpc.com';

// Polymarket Proxy Factory 地址
// 从 CTF Exchange 合约读取 (使用小写，避免 checksum 问题)
const PROXY_FACTORY = '0xa1b19cb0fb4facbf6fe4c9ab0e79ae7d1f71e5c3';
const PROXY_IMPLEMENTATION = '0x6c1c5a9c82bb86c33d9ea9c8f7ed0e2b6bf53faf';

// PolyProxy 地址计算 (EIP-1167 Minimal Proxy)
function computePolyProxyAddress(owner: string, factory: string, implementation: string): string {
    // EIP-1167 minimal proxy 创建使用 CREATE2
    // salt = keccak256(owner)
    const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address'], [owner]));

    // initcode = minimal proxy bytecode
    // 0x3d602d80600a3d3981f3363d3d373d3d3d363d73 + implementation + 0x5af43d82803e903d91602b57fd5bf3
    const minimalProxyBytecode = '0x3d602d80600a3d3981f3363d3d373d3d3d363d73' +
        implementation.slice(2).toLowerCase() +
        '5af43d82803e903d91602b57fd5bf3';

    const initCodeHash = ethers.keccak256(minimalProxyBytecode);

    // CREATE2 address = keccak256(0xff + factory + salt + initCodeHash)[12:]
    const create2Address = ethers.getCreate2Address(factory, salt, initCodeHash);

    return create2Address;
}

async function main() {
    console.log('═'.repeat(60));
    console.log('  Polymarket Proxy 钱包验证');
    console.log('═'.repeat(60));

    const privateKey = process.env.POLYMARKET_TRADER_PRIVATE_KEY;
    const configuredProxyAddress = process.env.POLYMARKET_PROXY_ADDRESS;

    if (!privateKey) {
        console.error('❌ 缺少 POLYMARKET_TRADER_PRIVATE_KEY');
        process.exit(1);
    }

    const wallet = new ethers.Wallet(privateKey);
    const eoaAddress = await wallet.getAddress();

    console.log('\n📋 配置信息:');
    console.log(`  EOA 地址:           ${eoaAddress}`);
    console.log(`  配置的 Proxy 地址:  ${configuredProxyAddress}`);

    // 计算预期的 proxy 地址
    console.log('\n🔍 计算预期的 Proxy 地址...');
    console.log(`  Factory:        ${PROXY_FACTORY}`);
    console.log(`  Implementation: ${PROXY_IMPLEMENTATION}`);

    const computedProxy = computePolyProxyAddress(eoaAddress, PROXY_FACTORY, PROXY_IMPLEMENTATION);
    console.log(`  计算结果:       ${computedProxy}`);

    // 比较
    if (configuredProxyAddress?.toLowerCase() === computedProxy.toLowerCase()) {
        console.log('\n✅ Proxy 地址匹配！可以使用 signatureType=1 (POLY_PROXY)');
    } else {
        console.log('\n⚠️  Proxy 地址不匹配！');
        console.log('   可能原因:');
        console.log('   1. 您使用的是 Gnosis Safe (signatureType=2)');
        console.log('   2. 您使用的是 Magic/Email 登录创建的不同类型的 proxy');
        console.log('   3. Factory 或 Implementation 地址不正确');

        // 尝试查询链上合约来验证
        console.log('\n🔗 尝试查询链上信息...');
        try {
            const provider = new ethers.JsonRpcProvider(RPC_URL);

            // 检查 proxy 地址的 code
            const proxyCode = await provider.getCode(configuredProxyAddress || '');
            if (proxyCode !== '0x') {
                console.log(`  Proxy 是合约: ✅`);
                console.log(`  Code 长度: ${proxyCode.length} 字符`);

                // 检查是否是 minimal proxy
                if (proxyCode.includes('363d3d373d3d3d363d73')) {
                    console.log(`  类型: EIP-1167 Minimal Proxy`);
                    // 提取 implementation 地址
                    const implStart = proxyCode.indexOf('363d3d373d3d3d363d73') + 20;
                    const implHex = '0x' + proxyCode.slice(implStart, implStart + 40);
                    console.log(`  Implementation: ${implHex}`);
                } else if (proxyCode.length > 100) {
                    console.log(`  类型: 可能是 Gnosis Safe 或其他合约`);
                }
            } else {
                console.log(`  ❌ 配置的地址不是合约`);
            }
        } catch (e: any) {
            console.log(`  查询失败: ${e.message}`);
        }
    }

    console.log('\n' + '═'.repeat(60));
}

main().catch(console.error);
