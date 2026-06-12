/**
 * Polymarket Trader - Polymarket CLOB 订单执行封装
 *
 * 功能:
 * - Taker 订单提交 (IOC 立即成交)
 * - 订单状态查询
 * - 订单取消
 * - HMAC L2 认证
 */

import { Wallet, verifyTypedData } from 'ethers';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { TelegramNotifier, createTelegramNotifier, type OrderAlert } from '../notification/telegram.js';
import { PolymarketUserWsClient, getPolymarketUserWsClient } from '../polymarket/user-ws-client.js';
import { detectPolymarketSignatureType, type PolySignatureType } from '../polymarket/wallet-type-detector.js';
import { Wallet as WalletV5 } from 'ethers5';
import {
    ClobClient as ClobClientV2,
    SignatureTypeV2,
    OrderType as OrderTypeV2,
    Side as SideV2,
} from '@polymarket/clob-client-v2';

// ============================================================================
// 常量
// ============================================================================

const CLOB_BASE_URL = process.env.POLYMARKET_CLOB_BASE_URL || 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon

// poly-slugs.json 缓存类型
interface PolySlugEntry {
    eventSlug: string;
    marketSlug: string;
    question?: string;  // 完整问题形式，优先使用
}
type PolySlugsCache = Record<string, PolySlugEntry>;

// 加载 poly-slugs.json 缓存
let polySlugsCache: PolySlugsCache = {};
try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    // dashboard -> src -> bot -> data
    const slugsPath = path.resolve(__dirname, '../../data/poly-slugs.json');
    if (fs.existsSync(slugsPath)) {
        polySlugsCache = JSON.parse(fs.readFileSync(slugsPath, 'utf-8'));
        console.log(`[PolymarketTrader] Loaded ${Object.keys(polySlugsCache).length} poly-slugs entries`);
    }
} catch (e: any) {
    console.warn(`[PolymarketTrader] Failed to load poly-slugs.json: ${e?.message || e}`);
}

// 从缓存获取市场标题（优先 question，fallback 到 marketSlug）
function getMarketTitleFromCache(conditionId: string): string | undefined {
    const entry = polySlugsCache[conditionId];
    if (!entry) return undefined;
    return entry.question || entry.marketSlug;
}

// 合约地址
const CTF_EXCHANGE = '0xE111180000d2663C0091e4f400237545B87B996B';
const NEG_RISK_EXCHANGE = '0xe2222d279d744050d28e00520010520000310F59';
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

// Polymarket 实际分类费率 (来源: docs.polymarket.com/trading/fees)
// API /fee-rate 返回的 base_fee 是合约 feeRateBps 参数 (最大费率上限)，
// 实际 fee 公式: fee_USDC = C × categoryRate × p × (1-p)
// 重要：fee 是从 USDC 端扣，BUY 时 shares 端拿满 gross（与文档 fee 表单位一致）。
// 历史版本误认为 fee 从 shares 扣 → 把每单 gross 上调 (1-fee×(1-p))^-1 → 永远超对冲。
// base_fee=1000 → Sports 类, categoryRate=0.03 (仅用于 USDC 端预留与 P&L)
// base_fee=0 → 无 taker fee
const POLY_CATEGORY_FEE_RATE: Record<number, number> = {
    1000: 0.03,   // Sports (NBA/NFL/MLB/Soccer/NHL/Esports etc.)
    // 未来其他分类: Crypto=0.072, Finance=0.04, Economics=0.05
};

export function normalizePolyFeeRate(baseFee: number): number {
    if (!Number.isFinite(baseFee) || baseFee <= 0) return 0;
    return POLY_CATEGORY_FEE_RATE[baseFee] ?? (baseFee / 10000);
}

export function calculatePolyPlatformFeeRate(price: number, feeRate: number, feeExponent: number = 1): number {
    if (price <= 0 || price >= 1 || feeRate <= 0) return 0;
    return feeRate * Math.pow(price * (1 - price), feeExponent);
}

export function calculatePolyBuyFeeSharePercent(price: number, feeRate: number, feeExponent: number = 1): number {
    if (price <= 0 || price >= 1) return 0;
    return calculatePolyPlatformFeeRate(price, feeRate, feeExponent) / price;
}

export function calculatePolyNetBuyShares(grossQty: number, price: number, _feeRate: number, _feeExponent: number = 1): number {
    // Polymarket BUY: 实际收到的 shares = gross 成交量，fee 仅扣 USDC 不动 shares。
    // 历史版本在这里乘 (1 - feeShare%) 做净额估算，导致下单一律 oversize → 超对冲。
    void price; void _feeRate; void _feeExponent;
    return grossQty <= 0 ? 0 : grossQty;
}

export function calculatePolyGrossBuyQuantityForTarget(targetQty: number, price: number, _feeRate: number, _feeExponent: number = 1): number {
    // BUY 拿满 gross：fee 在 USDC 端扣，shares 端没 buffer 可留 → 不再 oversize。
    void price; void _feeRate; void _feeExponent;
    return targetQty <= 0 ? 0 : targetQty;
}

// EIP-712 Order 类型
const ORDER_TYPES = {
    Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'signatureType', type: 'uint8' },
        { name: 'timestamp', type: 'uint256' },
        { name: 'metadata', type: 'bytes32' },
        { name: 'builder', type: 'bytes32' },
    ],
};

type PolyApiOrderType = 'GTC' | 'GTD' | 'FOK' | 'FAK';
type PolyInputOrderType = PolyApiOrderType | 'IOC';
type PolyOrderStatusMode = 'rest' | 'hybrid';

function normalizeOrderType(orderType?: PolyInputOrderType): PolyApiOrderType {
    if (!orderType || orderType === 'IOC') return 'FAK';
    return orderType;
}

function getOrderStatusMode(): PolyOrderStatusMode {
    const mode = (process.env.POLYMARKET_ORDER_STATUS_MODE || 'rest').toLowerCase();
    return mode === 'hybrid' ? 'hybrid' : 'rest';
}

function isImmediateOrderType(orderType?: PolyInputOrderType): boolean {
    const apiOrderType = normalizeOrderType(orderType);
    return apiOrderType === 'FAK' || apiOrderType === 'FOK';
}

function gcdBigInt(a: bigint, b: bigint): bigint {
    if (a < 0n) a = -a;
    if (b < 0n) b = -b;
    while (b !== 0n) {
        const next = a % b;
        a = b;
        b = next;
    }
    return a;
}

function normalizeBytes32(value: string | undefined, label: string): string {
    if (!value) return ZERO_BYTES32;
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new Error(`${label} must be a 0x-prefixed bytes32 hex string`);
    }
    return value;
}

// ============================================================================
// 类型定义
// ============================================================================

export interface PolyOrderInput {
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;        // 0-1 小数价格
    quantity: number;     // shares 数量
    orderType?: PolyInputOrderType;  // 默认 IOC，提交到 CLOB 时映射为 FAK
    negRisk?: boolean;
    feeRateBps?: number;        // Polymarket 市场费率 (bps)，不传则自动从 API 获取
    builderCode?: string;       // V2 bytes32 builder code，可选
    outcome?: 'YES' | 'NO';     // YES/NO 方向，用于通知显示
    outcomeName?: string;       // 多选市场的选项名（如 "Trump"），二元市场可省略
    marketTitle?: string;       // 市场标题，用于 TG 通知显示（优先级最高）
    conditionId?: string;       // Polymarket conditionId，用于从 poly-slugs 缓存查找标题
    /** 跳过 BUY fee 补偿 (GTC Maker 不收费) */
    skipFeeCompensation?: boolean;
    _allowanceRetried?: boolean;
}

export interface PolyOrderResult {
    success: boolean;
    orderId?: string;
    error?: string;
    timing?: any;
    submittedQuantity?: number;
    feeRate?: number;
    feeExponent?: number;
    feeSharePercent?: number;
    netQuantityEstimate?: number;
}

export interface PolyOrderStatus {
    status: 'LIVE' | 'MATCHED' | 'CANCELLED';
    filledQty: number;
    remainingQty: number;
    avgPrice: number;
    pollCount?: number;
    pollSource?: string;
    pollElapsedMs?: number;
    /** Polymarket 取消原因 (e.g. INSUFFICIENT_BALANCE) — 仅 CANCELLED 时可能存在 */
    cancelReason?: string;
}

export interface PolyPosition {
    tokenId: string;
    quantity: number;
    avgPrice: number;
}

export interface PreflightResult {
    success: boolean;
    error?: string;
    /** 签名恢复出的地址 */
    recoveredAddress?: string;
    /** 市场实际 negRisk 值 (来自 Polymarket API) */
    actualNegRisk?: boolean;
}

export interface PolyFeeInfo {
    rate: number;
    exponent: number;
    takerOnly: boolean;
}

export interface PolyMarketInfo {
    tickSize: number;
    negRisk: boolean;
    tokens: { tokenId: string; outcome: string }[];
    fee?: PolyFeeInfo;
}

// ============================================================================
// WS 订单簿提供者（依赖注入，避免循环依赖）
// ============================================================================

type WsOrderbookProvider = (tokenId: string) => { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null;
let wsOrderbookProvider: WsOrderbookProvider | null = null;

/**
 * 设置 WS 订单簿提供者（由 start-dashboard 注入）
 * 任务执行时优先使用 WS 缓存，减少 API 调用
 */
export function setPolymarketWsOrderbookProvider(provider: WsOrderbookProvider): void {
    wsOrderbookProvider = provider;
    console.log('[PolymarketTrader] WS 订单簿提供者已注入');
}

// ============================================================================
// PolymarketTrader 类
// ============================================================================

/** 构造函数可选参数（多账户模式直传凭证，绕过 env） */
export interface PolymarketTraderOverrides {
    privateKey: string;
    proxyAddress: string;
    apiKey: string;
    apiSecret: string;
    passphrase: string;
    traderAddress?: string;
    disableUserWs?: boolean;    // 多账户实例禁用 User WS（避免单例竞争）
    disableTelegram?: boolean;  // 多账户实例禁用 TG 通知（由 executor 统一发送）
}

export class PolymarketTrader extends EventEmitter {
    private wallet: Wallet;
    private proxyAddress: string;
    private apiKey: string;
    private apiSecret: string;
    private passphrase: string;
    private traderAddress: string;
    private initialized = false;
    private telegram: TelegramNotifier | null = null;

    // User WS（用于 GTC watcher / 事件缓存；IOC 热路径默认 REST-first）
    private userWs: PolymarketUserWsClient | null = null;
    private userWsListenerIds: string[] = [];
    private userWsEnabled: boolean = true;
    private orderStatusMode: PolyOrderStatusMode = getOrderStatusMode();

    // 钱包签名类型 (2=Gnosis Safe, 3=Deposit Wallet)；init() 时通过 RPC 探测
    private _signatureType: PolySignatureType = 2;
    // 私钥保留供 v2 SDK 路径 (type 3) lazy 构造 ethers5 wallet 使用
    private _privateKey: string = '';
    // v2 SDK 客户端 (lazy)，仅 type 3 路径用
    private _v2Client: ClobClientV2 | null = null;

    /** type 3 (Deposit Wallet) 的 order signer 与 maker 同为 proxy；type 2 的 signer 是 EOA */
    private get orderSigner(): string {
        return this._signatureType === 3 ? this.proxyAddress : this.wallet.address;
    }

    /** lazy 初始化 v2 SDK ClobClient，仅在 type 3 路径调用 */
    private getV2Client(): ClobClientV2 {
        if (!this._v2Client) {
            // v2 SDK 仅支持 ethers v5 Wallet (或 viem WalletClient)，与项目主用 v6 隔离
            const v5Wallet = new WalletV5(this._privateKey);
            this._v2Client = new ClobClientV2({
                host: CLOB_BASE_URL,
                chain: CHAIN_ID,
                signer: v5Wallet,
                creds: { key: this.apiKey, secret: this.apiSecret, passphrase: this.passphrase },
                signatureType: SignatureTypeV2.POLY_1271,
                funderAddress: this.proxyAddress,
            });
        }
        return this._v2Client;
    }

    // tokenId/orderId -> marketTitle 缓存（用于 TG 通知显示）
    private tokenTitleCache = new Map<string, string>();
    private orderTitleCache = new Map<string, string>();
    private marketInfoCache = new Map<string, { data: PolyMarketInfo; timestamp: number }>();
    // 签名预检缓存: key = `${negRisk}` (签名正确性仅取决于 negRisk → 合约地址)
    private preflightCache = new Map<string, { success: boolean; timestamp: number }>();
    // tokenId -> feeRateBps 缓存 (3小时 TTL，费率极少变化，避免对冲热路径重复请求)
    private feeRateCache = new Map<string, { feeRateBps: number; timestamp: number }>();

    constructor(overrides?: PolymarketTraderOverrides) {
        super();

        const privateKey = overrides?.privateKey ?? process.env.POLYMARKET_TRADER_PRIVATE_KEY;
        const proxyAddress = overrides?.proxyAddress ?? process.env.POLYMARKET_PROXY_ADDRESS;
        const apiKey = overrides?.apiKey ?? process.env.POLYMARKET_API_KEY;
        const apiSecret = overrides?.apiSecret ?? process.env.POLYMARKET_API_SECRET;
        const passphrase = overrides?.passphrase ?? process.env.POLYMARKET_PASSPHRASE;
        const traderAddress = overrides?.traderAddress ?? process.env.POLYMARKET_TRADER_ADDRESS;

        if (!privateKey) throw new Error('POLYMARKET_TRADER_PRIVATE_KEY is required');
        if (!proxyAddress) throw new Error('POLYMARKET_PROXY_ADDRESS is required');
        if (!apiKey) throw new Error('POLYMARKET_API_KEY is required');
        if (!apiSecret) throw new Error('POLYMARKET_API_SECRET is required');
        if (!passphrase) throw new Error('POLYMARKET_PASSPHRASE is required');

        this.wallet = new Wallet(privateKey);
        this._privateKey = privateKey;
        this.proxyAddress = proxyAddress;
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.passphrase = passphrase;
        this.traderAddress = traderAddress || this.wallet.address;

        // 多账户实例禁用 User WS（避免单例竞争）
        if (overrides?.disableUserWs) {
            this.userWsEnabled = false;
            this.orderStatusMode = 'rest';
        }

        // 初始化 Telegram 通知（多账户实例可禁用，由 executor 统一发送）
        if (!overrides?.disableTelegram) {
            const tgToken = process.env.TELEGRAM_BOT_TOKEN;
            const tgChatId = process.env.TELEGRAM_CHAT_ID;
            if (tgToken && tgChatId) {
                this.telegram = createTelegramNotifier({
                    botToken: tgToken,
                    chatId: tgChatId,
                    enabled: true,
                });
            }
        }
    }

    /**
     * 初始化
     */
    async init(): Promise<void> {
        if (this.initialized) return;

        // 验证地址匹配
        if (this.traderAddress.toLowerCase() !== this.wallet.address.toLowerCase()) {
            console.warn(`[PolymarketTrader] Address mismatch: env=${this.traderAddress}, wallet=${this.wallet.address}`);
        }

        // 自动探测 proxy 钱包类型 (Safe=2 / DepositWallet=3)
        this._signatureType = await detectPolymarketSignatureType(this.proxyAddress);
        const typeLabel = this._signatureType === 3 ? 'Deposit Wallet (POLY_1271)' : 'Gnosis Safe (POLY_GNOSIS_SAFE)';
        const overrideSrc = process.env.POLYMARKET_SIGNATURE_TYPE && process.env.POLYMARKET_SIGNATURE_TYPE !== 'auto'
            ? 'env override'
            : 'auto-detected from on-chain bytecode';
        console.log(`[PolymarketTrader] signatureType=${this._signatureType} (${typeLabel}, ${overrideSrc})`);

        // 初始化 User WebSocket 客户端（可选；失败不影响 IOC REST-first 状态确认）
        if (this.userWsEnabled) {
            try {
                this.userWs = getPolymarketUserWsClient({
                    apiKey: this.apiKey,
                    secret: this.apiSecret,
                    passphrase: this.passphrase,
                });

                // 仅用于调试/可观测性；不要影响其他模块的监听器
                this.userWsListenerIds = this.userWs.setHandlers({
                    onConnect: () => console.log('[PolymarketTrader] User WS connected'),
                    onDisconnect: (code, reason) => console.log(`[PolymarketTrader] User WS disconnected: ${code} ${reason}`),
                    onError: (error) => console.warn(`[PolymarketTrader] User WS error: ${error.message}`),
                });

                await this.userWs.connect();
                console.log(`[PolymarketTrader] User WS initialized for order event tracking (orderStatusMode=${this.orderStatusMode})`);
            } catch (e: any) {
                console.warn(`[PolymarketTrader] Failed to initialize User WS: ${e?.message || e}, falling back to polling`);
                this.userWsEnabled = false;
                this.orderStatusMode = 'rest';
                this.userWs = null;
                this.userWsListenerIds = [];
            }
        }

        this.initialized = true;
        console.log(`[PolymarketTrader] Initialized: signer=${this.wallet.address.slice(0, 10)}..., proxy=${this.proxyAddress.slice(0, 10)}...`);

        // ── 启动自检 fail-fast ──
        // 调一次 GET /balance-allowance 验证 (signatureType, funder, API creds) 三件套对得上
        // 失败 → 默认 throw，阻止 bot 进入对冲流程造成单边敞口
        // env POLYMARKET_STARTUP_STRICT=false 时仅打印警告 + Telegram，不阻塞启动
        const strict = (process.env.POLYMARKET_STARTUP_STRICT ?? 'true').toLowerCase() !== 'false';
        const probe = await this.getBalanceAllowance({ assetType: 'COLLATERAL' });
        if (probe === null) {
            const errMsg = `Polymarket startup self-check FAILED: balance-allowance probe returned null. ` +
                `signatureType=${this._signatureType}, proxy=${this.proxyAddress.slice(0, 10)}..., apiKey=${this.apiKey.slice(0, 10)}.... ` +
                `可能原因: 钱包类型/凭证不匹配, 或网络问题. strict=${strict}`;
            console.error(`[PolymarketTrader] ${errMsg}`);
            if (this.telegram) {
                this.telegram.alertError({
                    operation: 'PolymarketTrader 启动自检',
                    platform: 'POLYMARKET',
                    marketName: '-',
                    error: errMsg,
                    requiresManualIntervention: true,
                }).catch(() => {});
            }
            if (strict) {
                throw new Error('Polymarket startup self-check failed — refusing to start. Set POLYMARKET_STARTUP_STRICT=false to bypass.');
            }
        } else {
            console.log(`[PolymarketTrader] Startup self-check OK (balance=${probe.balance.toFixed(4)} USDC)`);
        }
    }

    /** 发送订单通知（fire-and-forget，不阻塞订单流程） */
    notifyOrderAlert(alert: OrderAlert): void {
        if (!this.telegram) return;
        this.telegram.alertOrder(alert).catch(error =>
            console.warn('[PolymarketTrader] Failed to send Telegram order alert:', error?.message || error)
        );
    }

    /**
     * 提交买单 (Taker)
     */
    async placeBuyOrder(input: PolyOrderInput): Promise<PolyOrderResult> {
        return this.placeOrder({ ...input, side: 'BUY' });
    }

    /**
     * 提交卖单 (Taker)
     */
    async placeSellOrder(input: PolyOrderInput): Promise<PolyOrderResult> {
        return this.placeOrder({ ...input, side: 'SELL' });
    }

    /**
     * 提交订单 (默认 IOC)
     */
    async placeOrder(input: PolyOrderInput): Promise<PolyOrderResult> {
        if (!this.initialized) await this.init();

        // 验证 tokenId 存在
        if (!input.tokenId) {
            const error = 'tokenId is required for placeOrder';
            console.error(`[PolymarketTrader] ${error}`);
            return { success: false, error };
        }

        try {
            const requestedOrderType = input.orderType || 'IOC';
            const orderType = normalizeOrderType(requestedOrderType);
            const negRisk = input.negRisk || false;

            // 验证数量和价格
            if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
                const error = `Invalid quantity: ${input.quantity}`;
                console.error(`[PolymarketTrader] ${error}`);
                return { success: false, error };
            }
            if (!Number.isFinite(input.price) || input.price <= 0 || input.price > 1) {
                const error = `Invalid price: ${input.price}`;
                console.error(`[PolymarketTrader] ${error}`);
                return { success: false, error };
            }

            // 获取市场费率。CLOB V2 的 /clob-markets 返回 fd={r,e,to}；
            // /fee-rate 的 base_fee 仍作为兜底，并映射到本地分类费率。
            let feeRateBps = input.feeRateBps ?? 0;
            let feeRate = 0;
            let feeExponent = 1;
            let marketFee: PolyFeeInfo | undefined;

            if (input.feeRateBps !== undefined) {
                feeRate = normalizePolyFeeRate(input.feeRateBps);
            } else if (input.conditionId) {
                const marketInfo = await this.getMarketInfo(input.conditionId).catch(() => null);
                marketFee = marketInfo?.fee;
                if (marketFee && Number.isFinite(marketFee.rate) && marketFee.rate > 0) {
                    feeRate = marketFee.rate;
                    feeExponent = marketFee.exponent || 1;
                    feeRateBps = Math.round(feeRate * 10000);
                }
            }

            if (input.feeRateBps === undefined && feeRate <= 0) {
                feeRateBps = await this.getFeeRate(input.tokenId);
                feeRate = normalizePolyFeeRate(feeRateBps);
            }

            // BUY 侧 fee 补偿: fee 从 shares 中扣除，需多买以弥补
            // 官方公式 (docs.polymarket.com/trading/fees):
            //   platformFeeRate = feeRate × (p × (1-p)) ^ feeExponent
            //   BUY 时 fee 以 shares 扣除: fee_shares = grossQty × platformFeeRate / p
            //   补偿: grossQty = targetQty / (1 - platformFeeRate / p)
            let effectiveQty = input.quantity;
            let feeSharePercent = 0;
            let netQuantityEstimate = input.quantity;
            if (input.side === 'BUY' && feeRate > 0 && input.price > 0 && input.price < 1 && !input.skipFeeCompensation) {
                feeSharePercent = calculatePolyBuyFeeSharePercent(input.price, feeRate, feeExponent);
                const grossQty = calculatePolyGrossBuyQuantityForTarget(input.quantity, input.price, feeRate, feeExponent);
                console.log(`[PolymarketTrader] BUY fee compensation: target=${input.quantity}, gross=${grossQty.toFixed(4)}, feeRateBps=${feeRateBps}, feeRate=${feeRate}, feeExponent=${feeExponent}, feeSharePercent=${(feeSharePercent * 100).toFixed(4)}%`);
                effectiveQty = grossQty;
            }

            // CLOB V2 SDK 对 0.01 tick 使用 price=2dp, size=2dp, amount=4dp。
            // 向下收缩 size，避免因 amount 进位改变限价或超出目标风险。
            const PRICE_CENT_SCALE = 100n;
            const SIZE_CENT_SCALE = 100n;
            const BASE_UNITS = 1000000n;
            const SIZE_CENT_UNIT = BASE_UNITS / SIZE_CENT_SCALE; // 0.01 share
            const AMOUNT_4DP_UNIT = BASE_UNITS / 10000n; // 0.0001 USDC
            const priceCents = BigInt(Math.floor(input.price * 100 + 1e-9));
            const orderPrice = Number(priceCents) / 100;

            if (priceCents <= 0n || priceCents > 100n) {
                const error = `Invalid 2dp price after alignment: ${input.price} → ${orderPrice}`;
                console.error(`[PolymarketTrader] ${error}`);
                return { success: false, error };
            }

            // size 以 0.01 share 计；额外向下截断到与 priceCents 互补的步长，
            // 保证 makerAmount/takerAmount(USDC) 落在 2dp，满足 FAK/FOK 市场单要求
            // (CLOB: "market buy orders maker amount supports a max accuracy of 2 decimals")。
            const USDC_CENT_SCALE_BIG = 100n; // 0.01 USDC 步长
            const qtyStep2 = USDC_CENT_SCALE_BIG / gcdBigInt(priceCents, USDC_CENT_SCALE_BIG);
            const rawQty2 = BigInt(Math.floor(effectiveQty * 100 + 1e-9));
            const alignedQty2 = (rawQty2 / qtyStep2) * qtyStep2;
            const alignedQty = Number(alignedQty2) / 100;

            // 验证对齐后数量 > 0
            if (alignedQty2 <= 0n) {
                const error = `Quantity too small after alignment: ${effectiveQty} → ${alignedQty} (qtyStep=${Number(qtyStep2) / 100} share, price=${orderPrice})`;
                console.error(`[PolymarketTrader] ${error}`);
                return { success: false, error };
            }

            const sizeInUnits = alignedQty2 * SIZE_CENT_UNIT;
            const usdcAmount = alignedQty2 * priceCents * AMOUNT_4DP_UNIT;
            netQuantityEstimate = input.side === 'BUY' && feeSharePercent > 0
                ? calculatePolyNetBuyShares(alignedQty, orderPrice, feeRate, feeExponent)
                : alignedQty;

            if (alignedQty !== effectiveQty) {
                console.log(`[PolymarketTrader] Quantity aligned for CLOB V2 precision: ${effectiveQty.toFixed(4)} → ${alignedQty} @ ${orderPrice.toFixed(2)} (truncated ${(effectiveQty - alignedQty).toFixed(6)})`);
            }
            if (orderPrice !== input.price) {
                console.log(`[PolymarketTrader] Price aligned down to sports tick: ${input.price} → ${orderPrice.toFixed(2)}`);
            }

            let makerAmount: bigint;
            let takerAmount: bigint;

            // 金额由 price(2dp) * qty(2dp) 精确得到。qtyStep 对齐保证 USDC 端落在 2dp。
            if (input.side === 'BUY') {
                makerAmount = usdcAmount;
                takerAmount = sizeInUnits;
            } else {
                makerAmount = sizeInUnits;
                takerAmount = usdcAmount;
            }

            // FAK/FOK 市场单要求 maker 2dp、taker 4dp；步长对齐后 USDC 必须是 0.01 USDC 整数倍。
            const USDC_CENT_UNIT = BASE_UNITS / 100n; // 0.01 USDC in 1e6 base
            if (usdcAmount % USDC_CENT_UNIT !== 0n || sizeInUnits % SIZE_CENT_UNIT !== 0n) {
                const error = `Invalid precision after alignment: usdcAmount=${usdcAmount}, sizeInUnits=${sizeInUnits} (qty=${alignedQty}, price=${orderPrice})`;
                console.error(`[PolymarketTrader] ${error}`);
                return { success: false, error };
            }

            // 验证金额 > 0
            if (makerAmount <= 0n || takerAmount <= 0n) {
                const error = `Invalid amounts after calculation: makerAmount=${makerAmount}, takerAmount=${takerAmount} (qty=${alignedQty}, price=${orderPrice})`;
                console.error(`[PolymarketTrader] ${error}`);
                return { success: false, error };
            }

            // ────────────────────────────────────────────────────────────
            // type 3 (Deposit Wallet, POLY_1271) → v2 SDK ERC-7739 包装签名
            // 手写 EIP-712 路径不适用，必须通过 SDK 内置的 createOrder
            // ────────────────────────────────────────────────────────────
            if (this._signatureType === 3) {
                return await this._placeOrderV3({
                    input,
                    requestedOrderType,
                    orderType,
                    negRisk,
                    alignedQty,
                    orderPrice,
                    feeRate,
                    feeExponent,
                    feeSharePercent,
                    netQuantityEstimate,
                });
            }

            const salt = Math.round(Math.random() * Date.now());
            const expiration = BigInt(0);
            const timestamp = BigInt(Date.now());
            const metadata = ZERO_BYTES32;
            const builder = normalizeBytes32(input.builderCode || process.env.POLY_BUILDER_CODE, 'POLY_BUILDER_CODE');

            const orderForSigning = {
                salt: salt,
                maker: this.proxyAddress,
                signer: this.orderSigner,
                tokenId: BigInt(input.tokenId),
                makerAmount: makerAmount,
                takerAmount: takerAmount,
                side: input.side === 'BUY' ? 0 : 1,
                signatureType: this._signatureType,
                timestamp,
                metadata,
                builder,
            };

            // 获取 domain
            const domain = this.getDomain(negRisk);

            // 签署订单
            const signature = await this.wallet.signTypedData(domain, ORDER_TYPES, orderForSigning);

            // 构建请求体
            const body = JSON.stringify({
                order: {
                    salt: salt,
                    maker: this.proxyAddress,
                    signer: this.orderSigner,
                    tokenId: input.tokenId,
                    makerAmount: makerAmount.toString(),
                    takerAmount: takerAmount.toString(),
                    expiration: expiration.toString(),
                    side: input.side,
                    signatureType: this._signatureType,
                    timestamp: timestamp.toString(),
                    metadata,
                    builder,
                    signature: signature,
                },
                owner: this.apiKey,
                orderType: orderType,
                deferExec: false,
                postOnly: false,
            });

            // 发送请求
            const path = '/order';
            const headers = this.buildHeaders('POST', path, body);

            const res = await fetch(`${CLOB_BASE_URL}${path}`, {
                method: 'POST',
                headers,
                body,
                signal: AbortSignal.timeout(10000),  // 10s 超时防阻塞
            });

            if (!res.ok) {
                const errorText = await res.text();

                // 自动重试: 费率不匹配时从错误消息中提取正确费率并重试
                // 错误格式: {"error":"invalid fee rate (0), current market's taker fee: 1000"}
                const feeRateMatch = errorText.match(/current market's taker fee:\s*(\d+)/);
                if (feeRateMatch && !input.feeRateBps) {
                    const correctFee = parseInt(feeRateMatch[1], 10);
                    console.log(`[PolymarketTrader] Fee rate mismatch, retrying with correct fee: ${correctFee} bps`);
                    // 更新缓存
                    this.feeRateCache.set(input.tokenId, { feeRateBps: correctFee, timestamp: Date.now() });
                    // 递归重试一次 (带 feeRateBps 防止无限递归)
                    return this.placeOrder({ ...input, feeRateBps: correctFee });
                }

                if (!input._allowanceRetried && /allowance|not enough balance|insufficient balance|insufficient allowance/i.test(errorText)) {
                    const assetType = input.side === 'BUY' ? 'COLLATERAL' : 'CONDITIONAL';
                    console.warn(`[PolymarketTrader] Order rejected for balance/allowance, refreshing ${assetType} allowance and retrying once`);
                    await this.updateBalanceAllowance({
                        assetType,
                        tokenId: assetType === 'CONDITIONAL' ? input.tokenId : undefined,
                    });
                    return this.placeOrder({ ...input, _allowanceRetried: true });
                }

                const errorMsg = `HTTP ${res.status}: ${errorText}`;
                // 发送 TG 通知: HTTP 错误
                if (this.telegram) {
                    const marketName = input.marketTitle
                        || this.tokenTitleCache.get(input.tokenId)
                        || (input.conditionId && getMarketTitleFromCache(input.conditionId))
                        || `Token ${input.tokenId.slice(0, 10)}...`;
                    this.telegram.alertError({
                        operation: '下单',
                        platform: 'POLYMARKET',
                        marketName,
                        error: errorMsg,
                        requiresManualIntervention: false,
                    }).catch(() => {});
                }
                return { success: false, error: errorMsg };
            }

            const data = await res.json() as any;
            const orderId = data.orderID || data.id || data.order_id;

            // 记录 tokenId/orderId -> marketTitle 缓存
            if (input.marketTitle) {
                this.tokenTitleCache.set(input.tokenId, input.marketTitle);
                if (orderId) {
                    this.orderTitleCache.set(orderId, input.marketTitle);
                }
            }

            this.emit('order:placed', { orderId, input });

            // 发送 TG 通知: 下单成功（fire-and-forget）
            if (this.telegram) {
                const marketName = input.marketTitle
                    || this.tokenTitleCache.get(input.tokenId)
                    || (input.conditionId && getMarketTitleFromCache(input.conditionId))
                    || `Token ${input.tokenId.slice(0, 10)}...`;
                this.telegram.alertOrder({
                    type: 'PLACED',
                    platform: 'POLYMARKET',
                    marketName,
                    action: input.side,  // BUY/SELL
                    side: input.outcome || 'NO',  // YES/NO 方向
                    outcome: input.outcomeName,  // 多选市场的选项名
                    price: input.price,
                    quantity: input.quantity,
                    role: isImmediateOrderType(requestedOrderType) ? 'Taker' : 'Maker',
                    orderHash: orderId,
                    timestamp: Date.now(),
                }).catch(() => {});
            }

            return {
                success: true,
                orderId,
                submittedQuantity: alignedQty,
                feeRate,
                feeExponent,
                feeSharePercent,
                netQuantityEstimate,
            };
        } catch (error: any) {
            // 发送 TG 通知: 下单失败（fire-and-forget）
            if (this.telegram) {
                const marketName = input.marketTitle
                    || this.tokenTitleCache.get(input.tokenId)
                    || (input.conditionId && getMarketTitleFromCache(input.conditionId))
                    || `Token ${input.tokenId.slice(0, 10)}...`;
                this.telegram.alertError({
                    operation: '下单',
                    platform: 'POLYMARKET',
                    marketName,
                    error: error.message,
                    requiresManualIntervention: false,
                }).catch(() => {});
            }
            return { success: false, error: error.message };
        }
    }

    /**
     * type 3 (Deposit Wallet) 下单分支：走 v2 SDK 的 ERC-7739 包装签名
     *
     * GTC / GTD → createAndPostOrder (limit order, size 字段为 shares)
     * FAK / FOK → createAndPostMarketOrder (market order, amount 字段 BUY=USDC SELL=shares)
     */
    private async _placeOrderV3(ctx: {
        input: PolyOrderInput;
        requestedOrderType: PolyInputOrderType;
        orderType: PolyApiOrderType;
        negRisk: boolean;
        alignedQty: number;
        orderPrice: number;
        feeRate: number;
        feeExponent: number;
        feeSharePercent: number;
        netQuantityEstimate: number;
    }): Promise<PolyOrderResult> {
        const { input, requestedOrderType, orderType, negRisk, alignedQty, orderPrice } = ctx;
        try {
            const v2 = this.getV2Client();
            const v2Side = input.side === 'BUY' ? SideV2.BUY : SideV2.SELL;
            const options = { tickSize: '0.01' as const, negRisk };

            let resp: any;
            if (orderType === 'GTC' || orderType === 'GTD') {
                resp = await v2.createAndPostOrder(
                    { tokenID: input.tokenId, price: orderPrice, size: alignedQty, side: v2Side },
                    options,
                    orderType === 'GTD' ? OrderTypeV2.GTD : OrderTypeV2.GTC,
                );
            } else {
                // FAK / FOK 市场单
                // BUY: amount = USDC 名义金额；SELL: amount = shares
                const marketAmount = input.side === 'BUY' ? alignedQty * orderPrice : alignedQty;
                resp = await v2.createAndPostMarketOrder(
                    { tokenID: input.tokenId, price: orderPrice, amount: marketAmount, side: v2Side },
                    options,
                    orderType === 'FOK' ? OrderTypeV2.FOK : OrderTypeV2.FAK,
                );
            }

            const orderId = resp?.orderID || resp?.orderId || resp?.id;
            if (!orderId || resp?.success === false) {
                const errMsg = resp?.errorMsg || resp?.error || `v2 SDK 返回无 orderID: ${JSON.stringify(resp)}`;
                if (this.telegram) {
                    const marketName = input.marketTitle
                        || this.tokenTitleCache.get(input.tokenId)
                        || (input.conditionId && getMarketTitleFromCache(input.conditionId))
                        || `Token ${input.tokenId.slice(0, 10)}...`;
                    this.telegram.alertError({
                        operation: '下单',
                        platform: 'POLYMARKET',
                        marketName,
                        error: errMsg,
                        requiresManualIntervention: false,
                    }).catch(() => {});
                }
                return { success: false, error: errMsg };
            }

            if (input.marketTitle) {
                this.tokenTitleCache.set(input.tokenId, input.marketTitle);
                this.orderTitleCache.set(orderId, input.marketTitle);
            }
            this.emit('order:placed', { orderId, input });

            if (this.telegram) {
                const marketName = input.marketTitle
                    || this.tokenTitleCache.get(input.tokenId)
                    || (input.conditionId && getMarketTitleFromCache(input.conditionId))
                    || `Token ${input.tokenId.slice(0, 10)}...`;
                this.telegram.alertOrder({
                    type: 'PLACED',
                    platform: 'POLYMARKET',
                    marketName,
                    action: input.side,
                    side: input.outcome || 'NO',
                    outcome: input.outcomeName,
                    price: input.price,
                    quantity: input.quantity,
                    role: isImmediateOrderType(requestedOrderType) ? 'Taker' : 'Maker',
                    orderHash: orderId,
                    timestamp: Date.now(),
                }).catch(() => {});
            }

            return {
                success: true,
                orderId,
                submittedQuantity: alignedQty,
                feeRate: ctx.feeRate,
                feeExponent: ctx.feeExponent,
                feeSharePercent: ctx.feeSharePercent,
                netQuantityEstimate: ctx.netQuantityEstimate,
            };
        } catch (error: any) {
            const errMsg = error?.message || String(error);
            // allowance 错误自动 retry 一次
            if (!input._allowanceRetried && /allowance|not enough balance|insufficient balance|insufficient allowance/i.test(errMsg)) {
                const assetType = input.side === 'BUY' ? 'COLLATERAL' : 'CONDITIONAL';
                console.warn(`[PolymarketTrader] (type 3) order rejected for balance/allowance, refreshing ${assetType} allowance and retrying once`);
                await this.updateBalanceAllowance({
                    assetType,
                    tokenId: assetType === 'CONDITIONAL' ? input.tokenId : undefined,
                });
                return this.placeOrder({ ...input, _allowanceRetried: true });
            }
            if (this.telegram) {
                const marketName = input.marketTitle
                    || this.tokenTitleCache.get(input.tokenId)
                    || (input.conditionId && getMarketTitleFromCache(input.conditionId))
                    || `Token ${input.tokenId.slice(0, 10)}...`;
                this.telegram.alertError({
                    operation: '下单',
                    platform: 'POLYMARKET',
                    marketName,
                    error: errMsg,
                    requiresManualIntervention: false,
                }).catch(() => {});
            }
            return { success: false, error: errMsg };
        }
    }

    /**
     * 从 WS 缓存查询订单成交状态 (同步，无网络调用)
     * 返回 null 表示缓存未命中
     */
    getWsCachedFillStatus(orderId: string): { filledQty: number; isTerminal: boolean } | null {
        if (!this.userWs?.connected()) return null;
        return this.userWs.getCachedFillStatus(orderId);
    }

    /**
     * 获取 User WS 客户端实例（供外部模块注册监听器）
     * 返回 null 表示 WS 未初始化或未连接
     */
    getUserWsClient(): PolymarketUserWsClient | null {
        return this.userWs?.connected() ? this.userWs : null;
    }

    /**
     * 获取订单状态
     */
    async getOrderStatus(orderId: string): Promise<PolyOrderStatus | null> {
        try {
            const path = `/data/order/${orderId}`;
            const headers = this.buildHeaders('GET', path);

            const res = await fetch(`${CLOB_BASE_URL}${path}`, { headers });

            if (!res.ok) return null;

            const data = await res.json() as any;

            const status = data.status || 'LIVE';
            // 提取取消原因 — 字段名不确定，尝试多种可能
            let cancelReason: string | undefined;
            if (status === 'CANCELLED') {
                cancelReason = data.cancel_reason || data.expiry_reason || data.reason || undefined;
                console.log(`[PolyTrader] CANCELLED order raw:`, JSON.stringify(data));
            }

            return {
                status,
                filledQty: parseFloat(data.size_matched || '0'),
                remainingQty: parseFloat(data.original_size || '0') - parseFloat(data.size_matched || '0'),
                avgPrice: parseFloat(data.price || '0'),
                cancelReason,
            };
        } catch {
            return null;
        }
    }

    /**
     * 轮询订单状态
     *
     * 订单状态:
     * - LIVE: 正在等待成交，继续轮询
     * - MATCHED: 完全成交
     * - CANCELLED: 已取消（IOC 部分成交后剩余被取消时 filledQty > 0）
     */
    async pollOrderStatus(
        orderId: string,
        timeoutMs: number = 2000,
        signal?: AbortSignal,
        tradeWindowMs: number = 100
    ): Promise<PolyOrderStatus | null> {
        if (this.orderStatusMode === 'hybrid' && this.userWs?.connected()) {
            return this.pollOrderStatusViaWs(orderId, timeoutMs, tradeWindowMs, signal);
        }

        return this.pollOrderStatusViaApi(orderId, timeoutMs, signal);
    }

    private async pollOrderStatusViaWs(
        orderId: string,
        timeoutMs: number,
        tradeWindowMs: number,
        abortSignal?: AbortSignal
    ): Promise<PolyOrderStatus | null> {
        if (!this.userWs) return null;

        const REST_POLL_INTERVAL_MS = 100;
        const maxRestRetries = Math.ceil(timeoutMs / REST_POLL_INTERVAL_MS);
        let resolved = false;
        const startMs = Date.now();

        return new Promise<PolyOrderStatus | null>((resolve) => {
            const done = (status: PolyOrderStatus | null, source: string, pollCount?: number) => {
                if (resolved) return;
                resolved = true;
                if (status) {
                    status.pollSource = source;
                    status.pollElapsedMs = Date.now() - startMs;
                    if (pollCount !== undefined) status.pollCount = pollCount;
                }
                if (status?.status === 'MATCHED') {
                    this.emit('order:filled', { orderId, status });
                }
                console.log(`[PolyTrader] Order ${orderId.slice(0, 10)}... confirmed via ${source}: ${status?.status}, filled=${status?.filledQty ?? 0}`);
                resolve(status);
            };

            // ── WS 路径: 仅终态 (MATCHED/CANCELLED) 赢得竞速 ──
            // LIVE 不参与竞速: negRisk 市场中 WS TRADE 事件可能来自自成交（BUY NO ↔ BUY YES 撮合后被取消），
            // TRADE 事件在取消前发出导致虚假 filledQty。LIVE 状态必须由 REST 验证。
            this.userWs!.waitForOrderFinal(orderId, timeoutMs, tradeWindowMs).then((signal) => {
                if (signal.status === 'MATCHED' || signal.status === 'CANCELLED') {
                    done({ status: signal.status, filledQty: signal.filledQty, remainingQty: 0, avgPrice: 0 }, 'WS', 0);
                } else if (signal.status === 'LIVE' && signal.filledQty > 0) {
                    // WS 检测到 TRADE 但非终态 — 记录但不 resolve，等 REST 确认
                    console.log(`[PolyTrader] WS LIVE partial for ${orderId.slice(0, 10)}...: filled=${signal.filledQty}, deferring to REST`);
                }
            });

            // ── REST 路径: 每 100ms 轮询一次 ──
            const pollRest = async () => {
                let matchedZeroCount = 0;
                for (let i = 0; i < maxRestRetries && !resolved; i++) {
                    if (abortSignal?.aborted) { done(null, 'abort', i + 1); return; }
                    const status = await this.getOrderStatus(orderId);
                    if (status && (status.status === 'MATCHED' || status.status === 'CANCELLED')) {
                        // MATCHED+filled=0: 可能是 API 延迟同步，也可能是 negRisk 自成交被取消
                        // 重试 2 次等 size_matched 同步，第 3 次接受为真实 0 成交
                        if (status.status === 'MATCHED' && status.filledQty === 0) {
                            matchedZeroCount++;
                            if (matchedZeroCount < 3) {
                                console.warn(`[PolyTrader] REST(#${i + 1}): MATCHED but filled=0 (attempt ${matchedZeroCount}/3), retrying...`);
                                if (!resolved) await this.delay(REST_POLL_INTERVAL_MS);
                                continue;
                            }
                            // 连续 3 次 MATCHED+filled=0 → 视为 CANCELLED (negRisk 自成交或真实 0 成交)
                            console.warn(`[PolyTrader] REST(#${i + 1}): MATCHED+filled=0 confirmed after ${matchedZeroCount} checks, treating as CANCELLED`);
                            done({ ...status, status: 'CANCELLED' }, `REST(#${i + 1})`, i + 1);
                            return;
                        }
                        done(status, `REST(#${i + 1})`, i + 1);
                        return;
                    }
                    if (!resolved) await this.delay(REST_POLL_INTERVAL_MS);
                }
            };
            pollRest();

            // 总超时兜底
            setTimeout(() => {
                if (!resolved) done(null, 'timeout', maxRestRetries);
            }, timeoutMs + 500);
        });
    }

    private async pollOrderStatusViaApi(
        orderId: string,
        timeoutMs: number,
        abortSignal?: AbortSignal
    ): Promise<PolyOrderStatus | null> {
        const REST_POLL_INTERVAL_MS = 100;
        const maxRetries = Math.ceil(timeoutMs / REST_POLL_INTERVAL_MS);
        let lastStatus: PolyOrderStatus | null = null;
        const startMs = Date.now();

        let matchedZeroCount = 0;
        for (let i = 0; i < maxRetries; i++) {
            if (abortSignal?.aborted) {
                return lastStatus ? { ...lastStatus, pollCount: i, pollSource: 'REST(abort)', pollElapsedMs: Date.now() - startMs } : null;
            }
            const status = await this.getOrderStatus(orderId);

            if (status) {
                lastStatus = status;

                // MATCHED: 完全成交
                if (status.status === 'MATCHED') {
                    // MATCHED+filled=0: API 延迟同步或 negRisk 自成交被取消
                    if (status.filledQty === 0) {
                        matchedZeroCount++;
                        if (matchedZeroCount < 3) {
                            console.warn(`[PolyTrader] REST: MATCHED but filled=0 (attempt ${matchedZeroCount}/3), retrying...`);
                            await this.delay(REST_POLL_INTERVAL_MS);
                            continue;
                        }
                        console.warn(`[PolyTrader] REST: MATCHED+filled=0 confirmed, treating as CANCELLED`);
                        return { ...status, status: 'CANCELLED', pollCount: i + 1, pollSource: `REST(#${i + 1})`, pollElapsedMs: Date.now() - startMs };
                    }
                    this.emit('order:filled', { orderId, status });
                    return { ...status, pollCount: i + 1, pollSource: `REST(#${i + 1})`, pollElapsedMs: Date.now() - startMs };
                }

                // CANCELLED: IOC 订单未完全成交时，剩余部分会被取消
                // 但可能已有部分成交（filledQty > 0）
                if (status.status === 'CANCELLED') {
                    if (status.filledQty > 0) {
                        console.log(`[PolyTrader] IOC order partially filled: ${status.filledQty}`);
                    }
                    return { ...status, pollCount: i + 1, pollSource: `REST(#${i + 1})`, pollElapsedMs: Date.now() - startMs };
                }

                // LIVE: 订单还在等待成交，继续轮询
                console.log(`[PolyTrader] Order ${orderId.slice(0, 10)}... status: LIVE, filled: ${status.filledQty}, retry: ${i + 1}/${maxRetries}`);
            }

            await this.delay(REST_POLL_INTERVAL_MS);
        }

        // 超时后返回最后已知的状态（可能还是 LIVE）
        if (lastStatus) {
            console.log(`[PolyTrader] Poll timeout, last status: ${lastStatus.status}, filled: ${lastStatus.filledQty}`);
        }
        return lastStatus ? { ...lastStatus, pollCount: maxRetries, pollSource: 'REST(timeout)', pollElapsedMs: Date.now() - startMs } : null;
    }

    /**
     * 取消订单
     */
    async cancelOrder(
        orderId: string,
        options?: {
            timeoutMs?: number;
            skipTelegram?: boolean;
            marketTitle?: string;   // 市场标题，用于 TG 通知（优先级最高）
            conditionId?: string;   // conditionId，用于从 poly-slugs 查找标题
        }
    ): Promise<boolean> {
        const timeoutMs = options?.timeoutMs ?? 5000;
        try {
            const path = '/order';
            const body = JSON.stringify({ orderID: orderId });
            const headers = this.buildHeaders('DELETE', path, body);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            let res: Response;
            try {
                res = await fetch(`${CLOB_BASE_URL}${path}`, {
                    method: 'DELETE',
                    headers,
                    body,
                    signal: controller.signal,
                });
            } catch (e: any) {
                if (e?.name === 'AbortError') {
                    console.warn(`[PolyTrader] ⚠️ Timeout cancelling order ${orderId}`);
                    return false;
                }
                throw e;
            } finally {
                clearTimeout(timeoutId);
            }

            if (res.ok) {
                this.emit('order:cancelled', { orderId });

                // 发送 TG 通知: 订单取消成功
                if (this.telegram && !options?.skipTelegram) {
                    const marketName = options?.marketTitle
                        || this.orderTitleCache.get(orderId)
                        || (options?.conditionId && getMarketTitleFromCache(options.conditionId))
                        || `Order ${orderId.slice(0, 10)}...`;
                    this.telegram.alertOrder({
                        type: 'CANCELLED',
                        platform: 'POLYMARKET',
                        marketName,
                        action: 'BUY',
                        side: 'NO',
                        price: 0,
                        quantity: 0,
                    }).catch(() => {});
                }
            }

            return res.ok;
        } catch {
            return false;
        }
    }

    /**
     * 获取订单簿
     * 优先使用 WS 缓存（实时），fallback 到 REST API
     */
    async getOrderbook(tokenId: string): Promise<{ bids: { price: number; size: number }[]; asks: { price: number; size: number }[] } | null> {
        // 优先使用 WS 缓存（实时数据，减少 API 调用）
        if (wsOrderbookProvider) {
            const wsBook = wsOrderbookProvider(tokenId);
            if (wsBook && (wsBook.bids.length > 0 || wsBook.asks.length > 0)) {
                return wsBook;
            }
        }

        // Fallback: REST API
        try {
            const res = await fetch(`${CLOB_BASE_URL}/book?token_id=${tokenId}`);
            if (!res.ok) return null;

            const data = await res.json() as {
                bids: { price: string; size: string }[];
                asks: { price: string; size: string }[];
            };

            return {
                bids: (data.bids || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
                    .sort((a, b) => b.price - a.price),
                asks: (data.asks || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
                    .sort((a, b) => a.price - b.price),
            };
        } catch {
            return null;
        }
    }

    /**
     * 获取市场信息 (包含 tickSize)
     */
    async getMarketInfo(conditionId: string): Promise<PolyMarketInfo | null> {
        // 缓存命中 (5分钟 TTL — negRisk 等市场属性不会频繁变化)
        const cached = this.marketInfoCache.get(conditionId);
        if (cached && Date.now() - cached.timestamp < 300_000) {
            return cached.data;
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const res = await fetch(`${CLOB_BASE_URL}/clob-markets/${conditionId}`, {
                signal: controller.signal,
            });
            clearTimeout(timeoutId);

            if (!res.ok) return null;

            const data = await res.json() as any;
            const rawTokens = Array.isArray(data.t) ? data.t : (Array.isArray(data.tokens) ? data.tokens : []);
            const tickSize = parseFloat(String(data.mts ?? data.minimum_tick_size ?? ''));
            const rawFee = data.fd ?? data.feeSchedule ?? data.fee_schedule;
            const fee = rawFee ? {
                rate: Number(rawFee.r ?? rawFee.rate ?? 0),
                exponent: Number(rawFee.e ?? rawFee.exponent ?? 1),
                takerOnly: Boolean(rawFee.to ?? rawFee.takerOnly ?? rawFee.taker_only ?? true),
            } : undefined;

            const result: PolyMarketInfo = {
                tickSize,
                negRisk: data.nr === true || data.neg_risk === true || data.negRisk === true,
                tokens: rawTokens.map((t: any) => ({
                    tokenId: String(t.token_id ?? t.tokenId ?? t.asset_id ?? t.id ?? t.t ?? ''),
                    outcome: String(t.outcome ?? t.name ?? t.o ?? ''),
                })).filter((t: { tokenId: string; outcome: string }) => t.tokenId && t.outcome),
                fee: fee && Number.isFinite(fee.rate) ? fee : undefined,
            };

            if (!Number.isFinite(result.tickSize) || result.tickSize <= 0 || result.tokens.length === 0) {
                console.warn(`[PolymarketTrader] Invalid /clob-markets response for conditionId=${conditionId}`);
                return null;
            }

            this.marketInfoCache.set(conditionId, { data: result, timestamp: Date.now() });
            return result;
        } catch (e: any) {
            if (e?.name === 'AbortError') {
                console.warn(`[PolymarketTrader] getMarketInfo timeout (5s): ${conditionId}`);
            }
            return null;
        }
    }

    /**
     * 获取余额
     */
    async getBalance(): Promise<number> {
        const balanceAllowance = await this.getBalanceAllowance({ assetType: 'COLLATERAL' });
        if (!balanceAllowance) {
            throw new Error('Failed to query Polymarket collateral balance');
        }
        return balanceAllowance.balance;
    }

    async getBalanceAllowance(params: { assetType: 'COLLATERAL' | 'CONDITIONAL'; tokenId?: string; negRisk?: boolean }): Promise<{ balance: number; allowance: number; raw: any } | null> {
        if (params.assetType === 'CONDITIONAL' && !params.tokenId) {
            throw new Error('tokenId is required when assetType=CONDITIONAL');
        }

        try {
            const path = '/balance-allowance';
            const query = new URLSearchParams({
                asset_type: params.assetType,
                signature_type: String(this._signatureType),
            });
            if (params.tokenId) query.set('token_id', params.tokenId);

            const headers = this.buildHeaders('GET', path);
            const res = await fetch(`${CLOB_BASE_URL}${path}?${query.toString()}`, { headers });
            if (!res.ok) {
                console.warn(`[PolymarketTrader] getBalanceAllowance failed: HTTP ${res.status} ${await res.text()}`);
                return null;
            }

            const data = await res.json() as { balance?: string; allowance?: string; allowances?: Record<string, string> };
            if (data.balance == null) {
                console.warn(`[PolymarketTrader] getBalanceAllowance missing balance field: keys=${Object.keys(data).join(',')}`);
                return null;
            }

            let rawAllowance = data.allowance;
            if (rawAllowance == null && data.allowances && params.negRisk !== undefined) {
                const expectedExchange = params.negRisk ? NEG_RISK_EXCHANGE : CTF_EXCHANGE;
                rawAllowance = data.allowances[expectedExchange]
                    ?? data.allowances[expectedExchange.toLowerCase()]
                    ?? Object.entries(data.allowances).find(([address]) => address.toLowerCase() === expectedExchange.toLowerCase())?.[1];
            }

            return {
                balance: parseFloat(data.balance) / 1e6,
                allowance: rawAllowance == null ? Number.NaN : parseFloat(rawAllowance) / 1e6,
                raw: data,
            };
        } catch (error: any) {
            console.warn(`[PolymarketTrader] getBalanceAllowance error: ${error?.message || error}`);
            return null;
        }
    }

    async updateBalanceAllowance(params: { assetType: 'COLLATERAL' | 'CONDITIONAL'; tokenId?: string }): Promise<void> {
        if (params.assetType === 'CONDITIONAL' && !params.tokenId) {
            throw new Error('tokenId is required when assetType=CONDITIONAL');
        }

        const path = '/balance-allowance/update';
        const query = new URLSearchParams({
            asset_type: params.assetType,
            signature_type: String(this._signatureType),
        });
        if (params.tokenId) query.set('token_id', params.tokenId);

        const headers = this.buildHeaders('GET', path);
        const res = await fetch(`${CLOB_BASE_URL}${path}?${query.toString()}`, { headers });
        if (!res.ok) {
            throw new Error(`updateBalanceAllowance failed: HTTP ${res.status} ${await res.text()}`);
        }
    }

    // ========================================================================
    // 签名预检 (Preflight)
    // ========================================================================

    /**
     * 对冲前签名预检
     *
     * 在 Predict 下单前验证 Polymarket 签名能力，防止 Predict 成交后对冲失败导致全额敞口。
     * 验证内容:
     * 1. EIP-712 签名 → 恢复地址是否等于 signer wallet 地址
     * 2. 如果提供了 conditionId，验证市场实际 negRisk 是否与传入参数一致
     */
    async preflightCheck(input: {
        tokenId: string;
        negRisk: boolean;
        conditionId?: string;
    }): Promise<PreflightResult> {
        if (!this.initialized) await this.init();

        // 缓存命中: conditionId 参与 key，避免不同市场跳过 negRisk 校验
        const cacheKey = `${input.negRisk}:${input.conditionId ?? ''}`;
        const cached = this.preflightCache.get(cacheKey);
        if (cached?.success && Date.now() - cached.timestamp < 600_000) {
            return { success: true, recoveredAddress: this.wallet.address };
        }

        try {
            // 1. 构建一个最小测试订单进行签名验证
            const testOrder = {
                salt: 1,
                maker: this.proxyAddress,
                signer: this.orderSigner,
                tokenId: BigInt(input.tokenId),
                makerAmount: BigInt(100000),  // 0.1 pUSD
                takerAmount: BigInt(100000),
                side: 0,  // BUY
                signatureType: this._signatureType,
                timestamp: BigInt(Date.now()),
                metadata: ZERO_BYTES32,
                builder: normalizeBytes32(process.env.POLY_BUILDER_CODE, 'POLY_BUILDER_CODE'),
            };

            const domain = this.getDomain(input.negRisk);
            const signature = await this.wallet.signTypedData(domain, ORDER_TYPES, testOrder);

            // 验证签名恢复出的地址
            const recovered = verifyTypedData(domain, ORDER_TYPES, testOrder, signature);
            if (recovered.toLowerCase() !== this.wallet.address.toLowerCase()) {
                return {
                    success: false,
                    error: `签名恢复地址不匹配: recovered=${recovered}, expected=${this.wallet.address}`,
                    recoveredAddress: recovered,
                };
            }

            // 2. 验证市场 negRisk（如果提供了 conditionId）
            if (input.conditionId) {
                const marketInfo = await this.getMarketInfo(input.conditionId);
                if (marketInfo) {
                    if (marketInfo.negRisk !== input.negRisk) {
                        return {
                            success: false,
                            error: `negRisk 不匹配: task=${input.negRisk}, market=${marketInfo.negRisk} (conditionId=${input.conditionId})`,
                            recoveredAddress: recovered,
                            actualNegRisk: marketInfo.negRisk,
                        };
                    }
                } else {
                    return {
                        success: false,
                        error: `无法获取市场信息，不能验证 negRisk: conditionId=${input.conditionId}`,
                        recoveredAddress: recovered,
                    };
                }
            }

            // 缓存成功结果
            this.preflightCache.set(cacheKey, { success: true, timestamp: Date.now() });
            console.log(`[PolymarketTrader] Preflight OK: signer=${this.wallet.address.slice(0, 10)}..., negRisk=${input.negRisk}, contract=${domain.verifyingContract.slice(0, 10)}...`);
            return { success: true, recoveredAddress: recovered };
        } catch (error: any) {
            return {
                success: false,
                error: `签名预检异常: ${error.message}`,
            };
        }
    }

    // ========================================================================
    // 费率查询
    // ========================================================================

    /**
     * 获取 Polymarket 市场费率 (bps)
     * 使用 CLOB /fee-rate?token_id= 端点
     * 结果缓存 3 小时
     */
    async getFeeRate(tokenId: string): Promise<number> {
        const FEE_RATE_CACHE_TTL_MS = 3 * 60 * 60 * 1000;

        // 缓存命中 (3小时 TTL)
        const cached = this.feeRateCache.get(tokenId);
        if (cached && Date.now() - cached.timestamp < FEE_RATE_CACHE_TTL_MS) {
            return cached.feeRateBps;
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const res = await fetch(`${CLOB_BASE_URL}/fee-rate?token_id=${tokenId}`, {
                signal: controller.signal,
            });
            clearTimeout(timeoutId);

            if (!res.ok) {
                console.warn(`[PolymarketTrader] getFeeRate failed: HTTP ${res.status}`);
                // 使用过期缓存作为回退，避免有费率的市场下单第一次必然失败
                return cached?.feeRateBps ?? 0;
            }

            const data = await res.json() as { base_fee?: number };
            const feeRateBps = data.base_fee ?? 0;

            this.feeRateCache.set(tokenId, { feeRateBps, timestamp: Date.now() });
            if (feeRateBps > 0) {
                console.log(`[PolymarketTrader] Fee rate for token ${tokenId.slice(0, 15)}...: ${feeRateBps} bps`);
            }
            return feeRateBps;
        } catch (e: any) {
            if (e?.name === 'AbortError') {
                console.warn(`[PolymarketTrader] getFeeRate timeout (5s): ${tokenId.slice(0, 15)}...`);
            }
            // 使用过期缓存作为回退
            return cached?.feeRateBps ?? 0;
        }
    }

    // ========================================================================
    // 私有方法
    // ========================================================================

    private getDomain(negRisk: boolean) {
        return {
            name: 'Polymarket CTF Exchange',
            version: '2',
            chainId: CHAIN_ID,
            verifyingContract: negRisk ? NEG_RISK_EXCHANGE : CTF_EXCHANGE,
        };
    }

    private buildHeaders(method: string, path: string, body: string = ''): Record<string, string> {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const message = timestamp + method + path + body;
        const secretBuffer = Buffer.from(this.apiSecret, 'base64');
        const signature = crypto
            .createHmac('sha256', secretBuffer)
            .update(message, 'utf-8')
            .digest('base64');
        const urlSafeSignature = signature.replace(/\+/g, '-').replace(/\//g, '_');

        return {
            'POLY_API_KEY': this.apiKey,
            'POLY_SIGNATURE': urlSafeSignature,
            'POLY_TIMESTAMP': timestamp,
            'POLY_PASSPHRASE': this.passphrase,
            'POLY_ADDRESS': this.traderAddress,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// ============================================================================
// 单例
// ============================================================================

let instance: PolymarketTrader | null = null;

export function getPolymarketTrader(): PolymarketTrader {
    if (!instance) {
        instance = new PolymarketTrader();
    }
    return instance;
}
