/**
 * Auto-Redeem Service
 * 自动扫描 Predict + Polymarket 已结算持仓并执行赎回
 *
 * - Predict: 通过 GraphQL 查询持仓，使用 ZeroDev ERC-4337 gasless UserOperation 赎回
 * - Polymarket: 通过 Data API 查询 redeemable 持仓，直接 Gnosis Safe execTransaction 赎回
 * - 每 10 分钟自动执行一次，启动时立即扫描
 */

import { Interface, ZeroHash } from 'ethers';
import { createTelegramNotifier, TelegramNotifier } from '../notification/telegram.js';
import type {
    RedeemablePosition,
    RedeemScanResult,
    RedeemExecutionResult,
    RedeemBatchResult,
} from './types.js';

const LOG_PREFIX = '[AutoRedeem]';
const SCAN_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟
const CYCLE_TIMEOUT_MS = 5 * 60 * 1000; // 单次 cycle 最大执行时间 5 分钟
const DEDUP_TTL_MS = 60 * 60 * 1000; // 已赎回记录保留 1 小时
const UNDETERMINED_TTL_MS = 6 * 60 * 60 * 1000; // 未决定 negRisk 去重保留 6 小时

let redeemTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

// 已赎回去重: key = "platform:conditionId", value = { ts, ttl }
const recentlyRedeemed = new Map<string, { ts: number; ttl: number }>();

function markRedeemed(platform: string, conditionId: string, ttlMs: number = DEDUP_TTL_MS): void {
    recentlyRedeemed.set(`${platform}:${conditionId}`, { ts: Date.now(), ttl: ttlMs });
}

function isRecentlyRedeemed(platform: string, conditionId: string): boolean {
    const entry = recentlyRedeemed.get(`${platform}:${conditionId}`);
    if (!entry) return false;
    if (Date.now() - entry.ts > entry.ttl) {
        recentlyRedeemed.delete(`${platform}:${conditionId}`);
        return false;
    }
    return true;
}

function pruneRedeemed(): void {
    const now = Date.now();
    for (const [key, entry] of recentlyRedeemed) {
        if (now - entry.ts > entry.ttl) recentlyRedeemed.delete(key);
    }
}

// Gnosis Safe ExecutionSuccess/ExecutionFailure 事件签名
const SAFE_EXEC_SUCCESS_TOPIC = '0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e';
const SAFE_EXEC_FAILURE_TOPIC = '0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5571b67d18e6e0e5c7';

// Telegram 通知 (懒加载单例)
let tgNotifier: TelegramNotifier | null = null;
function getTg(): TelegramNotifier | null {
    if (tgNotifier) return tgNotifier;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (token && chatId) {
        tgNotifier = createTelegramNotifier({ botToken: token, chatId, enabled: true });
    }
    return tgNotifier;
}

// ============================================================================
// Predict 扫描
// ============================================================================

/**
 * 通过 Predict GraphQL claimablePositions 查询可赎回持仓
 * 再通过 REST API 补查 isNegRisk/isYieldBearing (GraphQL schema 无此字段)
 */
async function scanPredictRedeemable(): Promise<RedeemablePosition[]> {
    const SMART_WALLET = process.env.PREDICT_SMART_WALLET_ADDRESS;
    const API_KEY = process.env.PREDICT_API_KEY || process.env.PREDICT_API_KEY_SCAN;
    const BASE_URL = process.env.PREDICT_API_BASE_URL || 'https://api.predict.fun';

    if (!SMART_WALLET || !API_KEY) {
        console.log(`${LOG_PREFIX} Predict: 缺少环境变量，跳过扫描`);
        return [];
    }

    try {
        // 1. 通过 GraphQL claimablePositions 获取可赎回持仓
        const graphqlRes = await fetch('https://graphql.predict.fun/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: `{ account(address: "${SMART_WALLET}") { claimablePositions { edges { node { id shares valueUsd market { id title conditionId status } outcome { name index status } } } } } }`
            }),
            signal: AbortSignal.timeout(10000),
        });

        if (!graphqlRes.ok) {
            console.warn(`${LOG_PREFIX} Predict GraphQL 请求失败: ${graphqlRes.status}`);
            return [];
        }

        const data = await graphqlRes.json() as any;
        const edges = data?.data?.account?.claimablePositions?.edges || [];

        if (edges.length === 0) return [];

        // 2. 收集 marketId 列表，批量查 REST API 补充 isNegRisk/isYieldBearing
        const marketIds = [...new Set(edges.map((e: any) => e.node.market?.id).filter(Boolean))];
        const marketMeta = new Map<string, { isNegRisk: boolean; isYieldBearing: boolean }>();

        for (const marketId of marketIds) {
            try {
                const res = await fetch(`${BASE_URL}/v1/markets/${marketId}`, {
                    headers: { 'x-api-key': API_KEY },
                    signal: AbortSignal.timeout(5000),
                });
                if (res.ok) {
                    const mkt = (await res.json() as any).data;
                    marketMeta.set(String(marketId), {
                        isNegRisk: mkt.isNegRisk === true,
                        isYieldBearing: mkt.isYieldBearing === true,
                    });
                }
            } catch {
                // 查询失败用默认值
            }
        }

        // 3. 构建结果 (跳过最近已赎回的)
        const redeemable: RedeemablePosition[] = [];

        for (const edge of edges) {
            const node = edge.node;
            const market = node.market;
            if (!market) continue;

            const sharesWei = BigInt(node.shares || '0');
            if (sharesWei === 0n) continue;

            if (isRecentlyRedeemed('predict', market.conditionId)) {
                console.log(`${LOG_PREFIX} Predict 跳过已赎回: ${market.title} (conditionId=${market.conditionId})`);
                continue;
            }

            const shares = Number(sharesWei) / 1e18;
            const outcomeName = node.outcome?.name || 'Unknown';
            // GraphQL outcome.index 对应 REST API 的 indexSet
            const outcomeIndex = node.outcome?.index as number;
            const isWinner = node.outcome?.status === 'WON';
            const meta = marketMeta.get(String(market.id));

            redeemable.push({
                platform: 'predict',
                marketTitle: market.title || `Market #${market.id}`,
                conditionId: market.conditionId,
                outcome: outcomeName,
                shares,
                estimatedValue: isWinner ? shares : 0,
                isWinner,
                predictMarketId: Number(market.id),
                indexSet: outcomeIndex as 1 | 2,
                isNegRisk: meta?.isNegRisk ?? false,
                isYieldBearing: meta?.isYieldBearing ?? false,
                amountBigInt: sharesWei,
            });
        }

        return redeemable;
    } catch (error) {
        console.error(`${LOG_PREFIX} Predict 扫描异常:`, (error as Error).message);
        return [];
    }
}

// ============================================================================
// Polymarket 扫描
// ============================================================================

async function scanPolymarketRedeemable(): Promise<RedeemablePosition[]> {
    const PROXY_ADDRESS = process.env.POLYMARKET_PROXY_ADDRESS;
    if (!PROXY_ADDRESS) {
        console.log(`${LOG_PREFIX} Polymarket: 缺少 PROXY_ADDRESS，跳过扫描`);
        return [];
    }

    try {
        // sizeThreshold=0 确保所有持仓都返回（包括小额）
        const url = `https://data-api.polymarket.com/positions?user=${PROXY_ADDRESS}&sizeThreshold=0`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

        if (!res.ok) {
            console.warn(`${LOG_PREFIX} Polymarket positions API 失败: ${res.status}`);
            return [];
        }

        const positions = await res.json() as any[];
        if (!Array.isArray(positions)) return [];

        const redeemable: RedeemablePosition[] = [];

        for (const pos of positions) {
            if (pos.redeemable !== true) continue;

            const size = parseFloat(pos.size || '0');
            if (size <= 0) continue;

            if (pos.conditionId && isRecentlyRedeemed('polymarket', pos.conditionId)) {
                console.log(`${LOG_PREFIX} Polymarket 跳过已赎回: ${pos.title} (conditionId=${pos.conditionId})`);
                continue;
            }

            const curPrice = parseFloat(pos.curPrice || '0');
            const isWinner = curPrice === 1.0;

            redeemable.push({
                platform: 'polymarket',
                marketTitle: pos.title || 'Unknown',
                conditionId: pos.conditionId || '',
                outcome: (pos.outcome || 'Unknown').toUpperCase(),
                shares: size,
                estimatedValue: isWinner ? size : 0,
                isWinner,
                isNegRisk: pos.negativeRisk === true,
                tokenId: pos.asset,
            });
        }

        // 链上 ERC1155 余额校验：Data API 的 redeemable=true 与链上余额可能不同步
        // (Polymarket 平台 bundler 已 auto-redeem 但 API 缓存未更新)，过滤掉这类条目
        // 防止后续 redeem 调用空跑产生 "payout=0" 假失败告警
        if (redeemable.length > 0) {
            const { ethers } = await import('ethers');
            const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
            const provider = new ethers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com');
            const ctfContract = new ethers.Contract(
                CTF,
                ['function balanceOf(address, uint256) view returns (uint256)'],
                provider,
            );
            const checks = await Promise.all(redeemable.map(async (pos) => {
                if (!pos.tokenId) return { pos, hasBalance: true };
                try {
                    const balance: bigint = await ctfContract.balanceOf(PROXY_ADDRESS, pos.tokenId);
                    return { pos, hasBalance: balance > 0n };
                } catch {
                    // RPC 查询失败时保守视为仍有余额，让后续流程兜底
                    return { pos, hasBalance: true };
                }
            }));

            const filtered: RedeemablePosition[] = [];
            for (const { pos, hasBalance } of checks) {
                if (!hasBalance) {
                    console.log(`${LOG_PREFIX} Polymarket 跳过 (链上余额=0，平台已 auto-redeem): ${pos.marketTitle}`);
                    if (pos.conditionId) markRedeemed('polymarket', pos.conditionId);
                } else {
                    filtered.push(pos);
                }
            }
            return filtered;
        }

        return redeemable;
    } catch (error) {
        console.error(`${LOG_PREFIX} Polymarket 扫描异常:`, (error as Error).message);
        return [];
    }
}

// ============================================================================
// Predict 执行赎回 (ZeroDev ERC-4337 Gasless UserOperation)
// ============================================================================

// ZeroDev 配置 (从 Predict 前端逆向获取)
const ZERODEV_PROJECT_ID = 'c01cff06-113b-431c-a23e-9fc10f221eba';
const ZERODEV_BUNDLER_RPC = `https://rpc.zerodev.app/api/v3/${ZERODEV_PROJECT_ID}/chain/56`;
const KERNEL_VERSION = '0.3.1' as const;

// 懒加载 ZeroDev Kernel client (避免重复初始化)
let kernelClientCache: any = null;
let kernelClientInitPromise: Promise<any> | null = null;

async function getKernelClient() {
    if (kernelClientCache) return kernelClientCache;
    if (kernelClientInitPromise) return kernelClientInitPromise;

    kernelClientInitPromise = (async () => {
        const PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY!;
        const SMART_WALLET = process.env.PREDICT_SMART_WALLET_ADDRESS!;

        const { createPublicClient, http } = await import('viem');
        const { bsc } = await import('viem/chains');
        const { privateKeyToAccount } = await import('viem/accounts');
        const { createKernelAccount, createKernelAccountClient, createZeroDevPaymasterClient, constants } = await import('@zerodev/sdk');
        const { signerToEcdsaValidator } = await import('@zerodev/ecdsa-validator');

        const entryPoint = constants.getEntryPoint('0.7');

        const formattedKey = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : `0x${PRIVATE_KEY}`;
        const signer = privateKeyToAccount(formattedKey as `0x${string}`);

        const publicClient = createPublicClient({
            chain: bsc,
            transport: http('https://bsc-rpc.publicnode.com'),
        });

        const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
            signer,
            entryPoint,
            kernelVersion: KERNEL_VERSION,
        });

        const kernelAccount = await createKernelAccount(publicClient, {
            plugins: { sudo: ecdsaValidator },
            entryPoint,
            kernelVersion: KERNEL_VERSION,
            deployedAccountAddress: SMART_WALLET as `0x${string}`,
        } as any);

        if (kernelAccount.address.toLowerCase() !== SMART_WALLET.toLowerCase()) {
            throw new Error(`Kernel 地址不匹配: expected=${SMART_WALLET}, got=${kernelAccount.address}`);
        }

        const paymasterClient = createZeroDevPaymasterClient({
            chain: bsc,
            transport: http(ZERODEV_BUNDLER_RPC),
            entryPoint,
        } as any);

        const client = createKernelAccountClient({
            account: kernelAccount,
            chain: bsc,
            bundlerTransport: http(ZERODEV_BUNDLER_RPC),
            paymaster: paymasterClient,
            entryPoint,
        } as any);

        console.log(`${LOG_PREFIX} ZeroDev Kernel client 初始化完成 (wallet=${SMART_WALLET})`);
        kernelClientCache = client;
        return client;
    })();

    try {
        return await kernelClientInitPromise;
    } catch (error) {
        kernelClientInitPromise = null;
        throw error;
    }
}

async function redeemPredictPositions(positions: RedeemablePosition[]): Promise<RedeemExecutionResult[]> {
    if (positions.length === 0) return [];

    const SMART_WALLET = process.env.PREDICT_SMART_WALLET_ADDRESS;
    const PRIVATE_KEY = process.env.PREDICT_SIGNER_PRIVATE_KEY;
    if (!SMART_WALLET || !PRIVATE_KEY) {
        return positions.map(p => ({
            platform: 'predict' as const,
            conditionId: p.conditionId,
            marketTitle: p.marketTitle,
            success: false,
            error: '缺少 PREDICT_SIGNER_PRIVATE_KEY 或 PREDICT_SMART_WALLET_ADDRESS',
        }));
    }

    let kernelClient: any;
    try {
        kernelClient = await getKernelClient();
    } catch (error) {
        const errMsg = (error as Error).message;
        console.error(`${LOG_PREFIX} Predict: ZeroDev 初始化失败 - ${errMsg}`);
        return positions.map(p => ({
            platform: 'predict' as const,
            conditionId: p.conditionId,
            marketTitle: p.marketTitle,
            success: false,
            error: `ZeroDev 初始化失败: ${errMsg}`,
        }));
    }

    // 获取合约地址
    const { OrderBuilder, ChainId, AddressesByChainId } = await import('@predictdotfun/sdk');
    const addrs = (AddressesByChainId as any)?.[ChainId.BnbMainnet]
        || (OrderBuilder as any).AddressesByChainId?.[ChainId.BnbMainnet];

    const { encodeFunctionData, zeroHash } = await import('viem');

    const results: RedeemExecutionResult[] = [];

    for (const pos of positions) {
        try {
            console.log(`${LOG_PREFIX} Predict gasless 赎回: ${pos.marketTitle} (${pos.outcome}, shares=${pos.shares.toFixed(2)}, winner=${pos.isWinner})`);

            const conditionId = pos.conditionId as `0x${string}`;
            const sharesWei = pos.amountBigInt || BigInt(Math.round(pos.shares * 1e18));
            const isNegRisk = pos.isNegRisk ?? false;
            const isYieldBearing = pos.isYieldBearing ?? true;

            let targetContract: `0x${string}`;
            let redeemCalldata: `0x${string}`;

            if (isNegRisk) {
                const identifier = isYieldBearing ? 'YIELD_BEARING_NEG_RISK_ADAPTER' : 'NEG_RISK_ADAPTER';
                targetContract = addrs[identifier] as `0x${string}`;
                const indexSet = pos.indexSet || 1;
                const amounts: [bigint, bigint] = indexSet === 1 ? [sharesWei, 0n] : [0n, sharesWei];
                redeemCalldata = encodeFunctionData({
                    abi: [{
                        name: 'redeemPositions',
                        type: 'function',
                        stateMutability: 'nonpayable',
                        inputs: [
                            { name: 'conditionId', type: 'bytes32' },
                            { name: 'amounts', type: 'uint256[]' },
                        ],
                        outputs: [],
                    }],
                    functionName: 'redeemPositions',
                    args: [conditionId, amounts],
                });
            } else {
                const identifier = isYieldBearing ? 'YIELD_BEARING_CONDITIONAL_TOKENS' : 'CONDITIONAL_TOKENS';
                targetContract = addrs[identifier] as `0x${string}`;
                const USDT = addrs.USDT as `0x${string}`;
                redeemCalldata = encodeFunctionData({
                    abi: [{
                        name: 'redeemPositions',
                        type: 'function',
                        stateMutability: 'nonpayable',
                        inputs: [
                            { name: 'collateralToken', type: 'address' },
                            { name: 'parentCollectionId', type: 'bytes32' },
                            { name: 'conditionId', type: 'bytes32' },
                            { name: 'indexSets', type: 'uint256[]' },
                        ],
                        outputs: [],
                    }],
                    functionName: 'redeemPositions',
                    args: [USDT, zeroHash, conditionId, [BigInt(pos.indexSet || 1)]],
                });
            }

            const txHash = await kernelClient.sendTransaction({
                to: targetContract,
                data: redeemCalldata,
                value: 0n,
            });

            console.log(`${LOG_PREFIX} Predict 赎回成功: ${pos.marketTitle} tx=${txHash}`);
            markRedeemed('predict', pos.conditionId);
            results.push({
                platform: 'predict',
                conditionId: pos.conditionId,
                marketTitle: pos.marketTitle,
                success: true,
                redeemedValue: pos.estimatedValue,
                txHash,
            });
        } catch (error) {
            const errMsg = (error as Error).message?.substring(0, 300) || String(error);
            console.error(`${LOG_PREFIX} Predict 赎回失败: ${pos.marketTitle} - ${errMsg}`);
            results.push({
                platform: 'predict',
                conditionId: pos.conditionId,
                marketTitle: pos.marketTitle,
                success: false,
                error: errMsg,
            });
        }
    }

    return results;
}

// ============================================================================
// Polymarket 执行赎回 (直接链上 Gnosis Safe execTransaction)
// ============================================================================

// Gnosis Safe 最小 ABI (仅需赎回相关方法)
const SAFE_ABI = [
    'function nonce() view returns (uint256)',
    'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)',
    'function getOwners() view returns (address[])',
    'function getThreshold() view returns (uint256)',
];

// MultiSend ABI
const MULTISEND_ABI = ['function multiSend(bytes transactions)'];
const MULTISEND_ADDRESS = '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761'; // Polygon

async function redeemPolymarketPositions(positions: RedeemablePosition[]): Promise<RedeemExecutionResult[]> {
    if (positions.length === 0) return [];

    const PRIVATE_KEY = process.env.POLYMARKET_TRADER_PRIVATE_KEY;
    const PROXY_ADDRESS = process.env.POLYMARKET_PROXY_ADDRESS;
    if (!PRIVATE_KEY || !PROXY_ADDRESS) {
        return positions.map(p => ({
            platform: 'polymarket' as const,
            conditionId: p.conditionId,
            marketTitle: p.marketTitle,
            success: false,
            error: '缺少 POLYMARKET_TRADER_PRIVATE_KEY 或 POLYMARKET_PROXY_ADDRESS',
        }));
    }

    // 按 conditionId 去重 (同一 conditionId 的 YES/NO 一起赎回)
    const uniqueConditions = new Map<string, RedeemablePosition>();
    for (const pos of positions) {
        if (!pos.conditionId) continue;
        const existing = uniqueConditions.get(pos.conditionId);
        if (!existing || pos.isWinner) {
            uniqueConditions.set(pos.conditionId, pos);
        }
    }

    const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
    const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

    const { ethers } = await import('ethers');
    const provider = new ethers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com');

    // 通过 CTF payoutDenominator 检查 condition 是否已解决（> 0 = 已解决）
    // 注意: 不再使用 NegRiskAdapter.getDetermined()，因为它需要 questionId 而非 conditionId
    const negRiskPositions: Array<[string, RedeemablePosition]> = [];
    const standardPositions: Array<[string, RedeemablePosition]> = [];
    const results: RedeemExecutionResult[] = [];

    const ctfContract = new ethers.Contract(CTF, [
        'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
    ], provider);

    for (const [condId, pos] of uniqueConditions) {
        // 检查 CTF 层面 condition 是否已解决
        try {
            const denom: bigint = await ctfContract.payoutDenominator(condId);
            if (denom === 0n) {
                console.log(`${LOG_PREFIX} Polymarket 跳过 (未解决): ${pos.marketTitle} conditionId=${condId}`);
                markRedeemed('polymarket', condId, UNDETERMINED_TTL_MS);
                continue;
            }
        } catch (error) {
            console.warn(`${LOG_PREFIX} payoutDenominator 查询失败: ${condId} - ${(error as Error).message}`);
            // 查询失败仍尝试赎回
        }

        if (pos.isNegRisk) {
            negRiskPositions.push([condId, pos]);
        } else {
            standardPositions.push([condId, pos]);
        }
    }

    // negRisk 赎回: 调用 NegRiskAdapter.redeemPositions(conditionId, indexSets, amounts)
    if (negRiskPositions.length > 0) {
        const negRiskResults = await executePolymarketSafeTx(
            negRiskPositions, provider, PRIVATE_KEY, PROXY_ADDRESS, true,
        );
        results.push(...negRiskResults);
    }

    // 标准持仓赎回: 调用 CTF.redeemPositions(pUSD, 0x0, conditionId, [1,2])
    if (standardPositions.length > 0) {
        const stdResults = await executePolymarketSafeTx(
            standardPositions, provider, PRIVATE_KEY, PROXY_ADDRESS, false,
        );
        results.push(...stdResults);
    }

    return results;
}

/**
 * 执行 Polymarket Safe 赎回交易 (标准 或 negRisk)
 */
async function executePolymarketSafeTx(
    conditionEntries: Array<[string, RedeemablePosition]>,
    provider: import('ethers').JsonRpcProvider,
    privateKey: string,
    proxyAddress: string,
    isNegRisk: boolean,
): Promise<RedeemExecutionResult[]> {
    const CTF = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
    const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
    const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

    const ctfInterface = new Interface([
        'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    ]);
    const negRiskAdapterInterface = new Interface([
        'function redeemPositions(bytes32 conditionId, uint256[] amounts)',
    ]);

    const label = isNegRisk ? 'negRisk' : '标准';

    try {
        const { ethers } = await import('ethers');
        const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
        const signer = new ethers.Wallet(formattedKey, provider);
        const safeContract = new ethers.Contract(proxyAddress, SAFE_ABI, signer);

        // 验证 EOA 是 Safe owner
        const owners: string[] = await safeContract.getOwners();
        const isOwner = owners.some(o => o.toLowerCase() === signer.address.toLowerCase());
        if (!isOwner) {
            throw new Error(`EOA ${signer.address} 不是 Safe ${proxyAddress} 的 owner`);
        }

        // 构建赎回交易
        const txns: Array<{to: string; data: string; value: string}> = [];
        const activeEntries: Array<[string, RedeemablePosition]> = [];

        if (isNegRisk) {
            const ctfBalContract = new ethers.Contract(CTF, [
                'function balanceOf(address, uint256) view returns (uint256)',
            ], provider);

            for (const [condId, pos] of conditionEntries) {
                // 查询链上 ERC1155 余额 (避免 API 与链上不一致)
                let balance: bigint;
                try {
                    balance = pos.tokenId
                        ? await ctfBalContract.balanceOf(proxyAddress, pos.tokenId)
                        : BigInt(Math.round(pos.shares * 1e6));
                } catch {
                    balance = BigInt(Math.round(pos.shares * 1e6));
                }

                if (balance === 0n) {
                    console.log(`${LOG_PREFIX} 跳过 (链上余额=0): ${pos.marketTitle}`);
                    markRedeemed('polymarket', condId);
                    continue;
                }

                // NegRiskAdapter.redeemPositions(conditionId, [yesAmount, noAmount])
                const isYes = (pos.outcome || '').toUpperCase().startsWith('Y');
                const amounts: bigint[] = isYes ? [balance, 0n] : [0n, balance];

                txns.push({
                    to: NEG_RISK_ADAPTER,
                    data: negRiskAdapterInterface.encodeFunctionData('redeemPositions', [condId, amounts]),
                    value: '0',
                });
                activeEntries.push([condId, pos]);
            }
        } else {
            for (const [condId, pos] of conditionEntries) {
                txns.push({
                    to: CTF,
                    data: ctfInterface.encodeFunctionData('redeemPositions', [
                        PUSD, ZeroHash, condId, [1, 2],
                    ]),
                    value: '0',
                });
                activeEntries.push([condId, pos]);
            }
        }

        if (txns.length === 0) {
            console.log(`${LOG_PREFIX} Polymarket ${label}: 所有持仓已赎回或余额为0`);
            return [];
        }

        console.log(`${LOG_PREFIX} Polymarket ${label}赎回: ${txns.length} 个 conditionId`);

        // 确定最终交易 (单笔 Call 或 MultiSend DelegateCall)
        let finalTo: string;
        let finalData: string;
        let operation: number;

        if (txns.length === 1) {
            finalTo = txns[0].to;
            finalData = txns[0].data;
            operation = 0; // Call
        } else {
            // MultiSend: 打包多笔交易
            const packed = txns.map(tx => {
                const dataBytes = ethers.getBytes(tx.data);
                return ethers.solidityPacked(
                    ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
                    [0, tx.to, 0, dataBytes.length, tx.data],
                );
            });
            const allPacked = ethers.concat(packed);
            const multiSendInterface = new Interface(MULTISEND_ABI);
            finalTo = MULTISEND_ADDRESS;
            finalData = multiSendInterface.encodeFunctionData('multiSend', [allPacked]);
            operation = 1; // DelegateCall
        }

        // 获取 Safe nonce
        const nonce: bigint = await safeContract.nonce();
        console.log(`${LOG_PREFIX} Safe nonce=${nonce}, operation=${operation === 0 ? 'Call' : 'DelegateCall'}`);

        // 获取 Safe 交易哈希
        const txHash: string = await safeContract.getTransactionHash(
            finalTo, 0, finalData, operation,
            0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce,
        );

        // 直接 ECDSA 签名 Safe 交易哈希 (与 poly-multi 项目一致，修复 GS013)
        const sig = signer.signingKey.sign(ethers.getBytes(txHash));
        // 打包为 r + s + v (65 bytes), v=27或28 (标准 ECDSA)
        const packedSig = sig.r + sig.s.slice(2) + sig.v.toString(16).padStart(2, '0');

        // 执行交易
        console.log(`${LOG_PREFIX} 发送 Safe execTransaction...`);
        const tx = await safeContract.execTransaction(
            finalTo, 0, finalData, operation,
            0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress,
            packedSig,
        );

        console.log(`${LOG_PREFIX} 交易已发送: ${tx.hash}, 等待确认...`);
        const receipt = await tx.wait();

        // 验证 Safe 内部执行结果 (ExecutionSuccess vs ExecutionFailure)
        const hasExecFailure = receipt.logs.some(
            (log: any) => log.topics?.[0] === SAFE_EXEC_FAILURE_TOPIC,
        );

        // 验证实际赎回金额: 检查 USDC Transfer 事件
        const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
        const transferLogs = receipt.logs.filter(
            (log: any) => log.topics?.[0] === TRANSFER_TOPIC,
        );
        const actualPayout = transferLogs.reduce((sum: bigint, log: any) => {
            try { return sum + BigInt(log.data); } catch { return sum; }
        }, 0n);

        if (hasExecFailure) {
            console.error(`${LOG_PREFIX} Polymarket ${label}赎回 Safe 内部执行失败: tx=${tx.hash}`);
            for (const [condId] of activeEntries) markRedeemed('polymarket', condId, UNDETERMINED_TTL_MS);
            return activeEntries.map(([, pos]) => ({
                platform: 'polymarket' as const,
                conditionId: pos.conditionId,
                marketTitle: pos.marketTitle,
                success: false,
                txHash: tx.hash,
                error: 'Safe execTransaction 内部执行失败 (ExecutionFailure)',
            }));
        }

        if (actualPayout === 0n) {
            console.warn(`${LOG_PREFIX} Polymarket ${label}赎回交易成功但 payout=0 (空赎回): tx=${tx.hash}`);
            for (const [condId] of activeEntries) markRedeemed('polymarket', condId);
            return activeEntries.map(([, pos]) => ({
                platform: 'polymarket' as const,
                conditionId: pos.conditionId,
                marketTitle: pos.marketTitle,
                success: false,
                txHash: tx.hash,
                error: 'payout=0，可能尚未结算或已赎回',
            }));
        }

        const payoutUsd = Number(actualPayout) / 1e6; // pUSD 6 decimals
        console.log(`${LOG_PREFIX} Polymarket ${label}赎回成功: tx=${tx.hash}, payout=$${payoutUsd.toFixed(2)}, gas=${receipt.gasUsed.toString()}`);

        for (const [condId] of activeEntries) markRedeemed('polymarket', condId);

        return activeEntries.map(([, pos]) => ({
            platform: 'polymarket' as const,
            conditionId: pos.conditionId,
            marketTitle: pos.marketTitle,
            success: true,
            redeemedValue: pos.estimatedValue,
            txHash: tx.hash,
        }));
    } catch (error) {
        const errMsg = (error as Error).message?.substring(0, 300) || String(error);
        console.error(`${LOG_PREFIX} Polymarket ${label}赎回失败:`, errMsg);

        // 标记失败去重，防止无限重试 (6小时后才会重新尝试)
        for (const [condId] of conditionEntries) {
            markRedeemed('polymarket', condId, UNDETERMINED_TTL_MS);
        }

        return conditionEntries.map(([, pos]) => ({
            platform: 'polymarket' as const,
            conditionId: pos.conditionId,
            marketTitle: pos.marketTitle,
            success: false,
            error: errMsg,
        }));
    }
}

// ============================================================================
// 综合扫描与执行
// ============================================================================

async function scanAll(): Promise<RedeemScanResult> {
    const startTime = Date.now();

    const [predict, polymarket] = await Promise.all([
        scanPredictRedeemable(),
        scanPolymarketRedeemable(),
    ]);

    const totalEstimatedValue = [...predict, ...polymarket]
        .filter(p => p.isWinner)
        .reduce((sum, p) => sum + p.estimatedValue, 0);

    return {
        predict,
        polymarket,
        totalEstimatedValue,
        scanTime: Date.now() - startTime,
    };
}

async function autoRedeemCycle(): Promise<void> {
    if (isRunning) {
        console.log(`${LOG_PREFIX} 上一轮仍在执行，跳过`);
        return;
    }

    isRunning = true;
    try {
        // 整体超时保护：防止 RPC 挂起导致 isRunning 永久卡住
        await Promise.race([
            autoRedeemCycleInner(),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`cycle 超时 (${CYCLE_TIMEOUT_MS / 1000}s)`)), CYCLE_TIMEOUT_MS)
            ),
        ]);
    } catch (error) {
        console.error(`${LOG_PREFIX} 自动赎回异常:`, (error as Error).message);
    } finally {
        isRunning = false;
    }
}

async function autoRedeemCycleInner(): Promise<void> {
    try {
        // 0. 清理过期去重记录
        pruneRedeemed();

        // 1. 扫描
        const scan = await scanAll();
        const totalPositions = scan.predict.length + scan.polymarket.length;

        if (totalPositions === 0) {
            console.log(`${LOG_PREFIX} 无可赎回持仓 (扫描耗时 ${scan.scanTime}ms)`);
            return;
        }

        console.log(`${LOG_PREFIX} 发现 ${totalPositions} 个可赎回持仓 (Predict: ${scan.predict.length}, Polymarket: ${scan.polymarket.length}), 预估价值: $${scan.totalEstimatedValue.toFixed(2)}, 扫描耗时 ${scan.scanTime}ms`);

        // 2. 执行赎回 (两个平台并行)
        const [predictResults, polyResults] = await Promise.all([
            redeemPredictPositions(scan.predict),
            redeemPolymarketPositions(scan.polymarket),
        ]);

        const allResults = [...predictResults, ...polyResults];
        const succeeded = allResults.filter(r => r.success);
        const failed = allResults.filter(r => !r.success);
        const totalRedeemed = succeeded.reduce((sum, r) => sum + (r.redeemedValue || 0), 0);

        // 3. 日志
        console.log(`${LOG_PREFIX} 赎回完成: 成功 ${succeeded.length}, 失败 ${failed.length}, 赎回金额 $${totalRedeemed.toFixed(2)}`);

        // 4. Telegram 通知 (仅有价值的赎回才推送)
        if (totalRedeemed > 0 || failed.length > 0) {
            const tg = getTg();
            if (tg) {
                const lines: string[] = ['[AutoRedeem] 赎回结果'];
                if (succeeded.length > 0) {
                    lines.push('');
                    lines.push(`成功 (${succeeded.length}):`);
                    for (const r of succeeded) {
                        const val = r.redeemedValue ? ` $${r.redeemedValue.toFixed(2)}` : ' (清理)';
                        lines.push(`  ${r.platform === 'predict' ? 'P' : 'PM'} ${r.marketTitle}${val}`);
                    }
                }
                if (failed.length > 0) {
                    lines.push('');
                    lines.push(`失败 (${failed.length}):`);
                    for (const r of failed) {
                        lines.push(`  ${r.platform === 'predict' ? 'P' : 'PM'} ${r.marketTitle}: ${r.error}`);
                    }
                }
                lines.push('');
                lines.push(`赎回总额: $${totalRedeemed.toFixed(2)}`);

                try {
                    await tg.sendText(lines.join('\n'));
                } catch {
                    // 通知失败不影响主逻辑
                }
            }
        }
    } catch (error) {
        console.error(`${LOG_PREFIX} 赎回执行异常:`, (error as Error).message);
    }
}

// ============================================================================
// 公共接口
// ============================================================================

/**
 * 启动自动赎回定时服务
 * 立即执行首轮扫描，之后每 10 分钟执行一次
 */
export function startAutoRedeem(): void {
    console.log(`${LOG_PREFIX} 启动自动赎回服务 (间隔 ${SCAN_INTERVAL_MS / 60000} 分钟)`);

    // 延迟 30 秒执行首轮（等待其他服务初始化完成）
    setTimeout(() => {
        autoRedeemCycle().catch(err => {
            console.error(`${LOG_PREFIX} 首轮扫描异常:`, err.message);
        });
    }, 30000);

    // 定时执行
    redeemTimer = setInterval(() => {
        autoRedeemCycle().catch(err => {
            console.error(`${LOG_PREFIX} 定时扫描异常:`, err.message);
        });
    }, SCAN_INTERVAL_MS);
}

/**
 * 停止自动赎回服务
 */
export function stopAutoRedeem(): void {
    if (redeemTimer) {
        clearInterval(redeemTimer);
        redeemTimer = null;
        console.log(`${LOG_PREFIX} 自动赎回服务已停止`);
    }
}
