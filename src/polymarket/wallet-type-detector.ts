/**
 * Polymarket 钱包类型自动探测
 *
 * 通过 Polygon RPC 读取 proxy 地址的 ERC-1967 implementation slot 判别:
 *   - slot 非零 → ERC-1967 Proxy → Deposit Wallet (signatureType 3, POLY_1271)
 *   - slot 为零 → Gnosis Safe (signatureType 2, POLY_GNOSIS_SAFE) 或其他
 *
 * 结果按 proxy 地址缓存到模块级 Map，多个 service 共享同一份结果。
 *
 * env 覆盖: POLYMARKET_SIGNATURE_TYPE=2|3 强制（用于自动探测误判兜底）；
 * 默认 'auto' 即从链上探测。
 */
import { JsonRpcProvider } from 'ethers';

export type PolySignatureType = 2 | 3;

// keccak256("eip1967.proxy.implementation") - 1
const ERC1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const DEFAULT_RPC_URLS = [
    'https://polygon-bor-rpc.publicnode.com',
    'https://rpc-mainnet.matic.quiknode.pro',
];

const cache = new Map<string, PolySignatureType>();

function parseEnvOverride(): PolySignatureType | null {
    const v = process.env.POLYMARKET_SIGNATURE_TYPE;
    if (!v || v === 'auto') return null;
    const n = parseInt(v, 10);
    if (n !== 2 && n !== 3) {
        throw new Error(
            `Invalid POLYMARKET_SIGNATURE_TYPE=${v}, expected '2' | '3' | 'auto'`
        );
    }
    return n as PolySignatureType;
}

async function probeRpc(proxyAddress: string, rpcUrl: string): Promise<PolySignatureType> {
    const provider = new JsonRpcProvider(rpcUrl);
    const code = await provider.getCode(proxyAddress);
    if (!code || code === '0x') {
        throw new Error(
            `Polymarket proxy ${proxyAddress} 链上无 bytecode。` +
            `请先在 polymarket.com 完成首次登录激活。`
        );
    }
    const slot = await provider.getStorage(proxyAddress, ERC1967_IMPL_SLOT);
    const isERC1967 = !!slot && /[1-9a-f]/i.test(slot.slice(2));
    return isERC1967 ? 3 : 2;
}

/**
 * 探测钱包类型。结果按 proxyAddress 缓存。
 * env POLYMARKET_SIGNATURE_TYPE=2|3 优先于探测。
 */
export async function detectPolymarketSignatureType(
    proxyAddress: string,
): Promise<PolySignatureType> {
    const key = proxyAddress.toLowerCase();
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const envOverride = parseEnvOverride();
    if (envOverride !== null) {
        cache.set(key, envOverride);
        return envOverride;
    }

    const rpcCandidates = [
        process.env.POLYGON_RPC_URL,
        ...DEFAULT_RPC_URLS,
    ].filter((u): u is string => !!u);

    let lastError: unknown;
    for (const rpc of rpcCandidates) {
        try {
            const result = await probeRpc(proxyAddress, rpc);
            cache.set(key, result);
            return result;
        } catch (e) {
            lastError = e;
        }
    }
    throw new Error(
        `detectPolymarketSignatureType: all RPC candidates failed for ${proxyAddress}. ` +
        `Last error: ${(lastError as Error)?.message || lastError}`
    );
}

/**
 * 同步读已缓存的结果。若未缓存返回 null，**调用方需自行处理 fallback**。
 * 仅在已确认调用过 detectPolymarketSignatureType() 之后的同步路径里使用。
 */
export function getCachedSignatureType(proxyAddress: string): PolySignatureType | null {
    return cache.get(proxyAddress.toLowerCase()) ?? null;
}
