/**
 * Predict WebSocket 订单监控服务
 *
 * 通过 Predict WebSocket walletEvents 监听订单成交事件
 * 替代 BSC WSS 链上事件监控，延迟更低
 *
 * 提供与 bsc-order-watcher.ts 兼容的接口
 */

import { EventEmitter } from 'events';
import { Wallet, JsonRpcProvider } from 'ethers';
import { OrderBuilder } from '@predictdotfun/sdk';
import {
    getPredictWsClient,
    initPredictWsClient,
    type WalletEventData,
    type PredictWsClient,
} from './predict-ws-client.js';
import { getBscRpcUrl } from '../config/bsc-rpc.js';
import { getTokenMarketCache } from './token-market-cache.js';

// ============================================================================
// 类型定义
// ============================================================================

export interface OrderFilledEvent {
    orderHash: string;
    txHash: string;
    logIndex: number;
    maker: string;
    taker: string;
    makerAssetId: string;
    takerAssetId: string;
    makerAmountFilled: string;
    takerAmountFilled: string;
    fee: string;
    blockNumber: number;
    timestamp: number;
    // 原始事件数据
    rawEvent?: WalletEventData;
}

export interface OrderTerminatedEvent {
    orderHash: string;
    orderId?: string;
    type: 'CANCELLED' | 'EXPIRED';
    reason?: string;
    timestamp: number;
    rawEvent?: WalletEventData;
}

export interface PredictOrderWatcherConfig {
    apiKey: string;
    smartWalletAddress: string;
    privateKey: string;
}

type OrderWatchCallback = (event: OrderFilledEvent) => void;

// ============================================================================
// PredictOrderWatcher
// ============================================================================

export class PredictOrderWatcher extends EventEmitter {
    private wsClient: PredictWsClient | null = null;
    private config: PredictOrderWatcherConfig;
    private jwt: string | null = null;
    private isRunning = false;

    // 订单监听回调 (key: orderHash 或 orderId)
    private orderWatchers = new Map<string, Set<OrderWatchCallback>>();
    private walletEventHandler: ((event: WalletEventData) => void) | null = null;

    // orderHash ↔ orderId 双向映射（用于将 orderId 事件路由到 orderHash watcher）
    private hashToIdMap = new Map<string, string>();  // orderHash → orderId
    private idToHashMap = new Map<string, string>();  // orderId → orderHash

    // 去重
    private processedEvents = new Map<string, number>();
    private cleanupTimer: NodeJS.Timeout | null = null;

    // JWT 管理
    private jwtExpiresAt: number = 0;
    private jwtRefreshTimer: NodeJS.Timeout | null = null;
    private subscriptionValid = false;  // 订阅是否有效
    private static readonly JWT_REFRESH_MARGIN_MS = 5 * 60 * 1000;  // 提前 5 分钟刷新
    private static readonly JWT_REFRESH_INTERVAL_MS = 55 * 60 * 1000;  // 默认 55 分钟刷新一次
    private static readonly SUBSCRIPTION_RETRY_DELAY_MS = 5000;  // 订阅失败重试间隔
    private static readonly SUBSCRIPTION_MAX_RETRIES = 3;  // 订阅失败最大重试次数

    constructor(config: PredictOrderWatcherConfig) {
        super();
        this.config = config;
    }

    // ============================================================================
    // Public API
    // ============================================================================

    async start(): Promise<void> {
        if (this.isRunning) return;

        // 1. 获取 JWT（检查是否过期或即将过期）
        if (!this.jwt || this.isJwtExpiringSoon()) {
            this.jwt = await this.fetchJwt();
        }

        // 2. 初始化 WS 客户端
        this.wsClient = getPredictWsClient();
        if (!this.wsClient) {
            this.wsClient = initPredictWsClient({ apiKey: this.config.apiKey });
        }

        if (!this.wsClient.isConnected()) {
            await this.wsClient.connect();
        }

        // 3. 设置 JWT 并订阅钱包事件
        this.wsClient.setJwt(this.jwt);

        this.walletEventHandler = (event) => {
            // 透传所有钱包事件（供 SSE 广播完整订单生命周期）
            this.emit('walletEvent', event);
            // 过滤成交事件 → emit orderFilled
            this.handleWalletEvent(event);
        };

        const success = await this.wsClient.subscribeWalletEvents(this.walletEventHandler);
        if (!success) {
            throw new Error('Failed to subscribe to wallet events');
        }
        this.subscriptionValid = true;  // 初始订阅成功

        // 4. 启动清理定时器
        this.cleanupTimer = setInterval(() => this.cleanupProcessedEvents(), 60000);

        // 5. 启动 JWT 刷新定时器
        this.startJwtRefreshTimer();

        this.isRunning = true;
        this.emit('connected');
        console.log('[PredictOrderWatcher] 已连接 (via Predict WebSocket)');
    }

    stop(): void {
        if (!this.isRunning) return;
        this.isRunning = false;

        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        if (this.jwtRefreshTimer) {
            clearInterval(this.jwtRefreshTimer);
            this.jwtRefreshTimer = null;
        }

        if (this.walletEventHandler && this.wsClient) {
            void this.wsClient.unsubscribeWalletEvents(this.walletEventHandler);
            this.walletEventHandler = null;
        }

        this.orderWatchers.clear();
        this.processedEvents.clear();
        this.emit('disconnected');
    }

    isConnected(): boolean {
        return this.isRunning && (this.wsClient?.isConnected() ?? false);
    }

    /**
     * 检查订阅是否有效
     */
    isSubscriptionValid(): boolean {
        return this.subscriptionValid;
    }

    /**
     * 注册 orderHash ↔ orderId 映射
     * Predict API 下单返回 orderId，但 WS 事件用 orderId 标识
     * @param orderHash 订单 hash (下单返回)
     * @param orderId 订单 ID (API 返回)
     */
    registerOrderMapping(orderHash: string, orderId: string): void {
        const hash = orderHash.toLowerCase();
        const id = String(orderId).replace(/n$/, '');  // 移除可能的 'n' 后缀
        this.hashToIdMap.set(hash, id);
        this.idToHashMap.set(id, hash);
    }

    /**
     * 监听特定订单的成交事件
     * @param orderHash 订单 hash
     * @param callback 成交回调
     * @param timeoutMs 超时时间（超时后自动取消监听）
     * @param orderId 可选的订单 ID（用于匹配 WS 事件）
     * @returns 取消函数
     */
    watchOrder(
        orderHash: string,
        callback: OrderWatchCallback,
        timeoutMs: number = 300000,
        orderId?: string
    ): () => void {
        const normalizedHash = orderHash.toLowerCase();

        // 注册 orderHash ↔ orderId 映射
        if (orderId) {
            this.registerOrderMapping(orderHash, orderId);
        }

        // 注册回调（用 orderHash）
        if (!this.orderWatchers.has(normalizedHash)) {
            this.orderWatchers.set(normalizedHash, new Set());
        }
        this.orderWatchers.get(normalizedHash)!.add(callback);

        // 设置超时
        const timeoutId = setTimeout(() => {
            this.unwatchOrder(normalizedHash, callback);
        }, timeoutMs);

        // 返回取消函数
        return () => {
            clearTimeout(timeoutId);
            this.unwatchOrder(normalizedHash, callback);
        };
    }

    /**
     * 取消监听
     */
    unwatchOrder(orderHash: string, callback?: OrderWatchCallback): void {
        const normalizedHash = orderHash.toLowerCase();
        const callbacks = this.orderWatchers.get(normalizedHash);

        if (!callbacks) return;

        if (callback) {
            callbacks.delete(callback);
            if (callbacks.size === 0) {
                this.orderWatchers.delete(normalizedHash);
            }
        } else {
            this.orderWatchers.delete(normalizedHash);
        }
    }

    /**
     * 解析事件中的市场信息
     */
    parseMarketFromEvent(event: OrderFilledEvent): { market: { marketId: number; title: string }; side: 'YES' | 'NO' } | null {
        const tokenId = event.takerAssetId !== '0' ? event.takerAssetId : event.makerAssetId;
        const tokenCache = getTokenMarketCache();

        if (!tokenCache.isReady()) return null;

        return tokenCache.getMarketByTokenId(tokenId);
    }

    /**
     * 设置 tokenId → market 映射（兼容 BSC watcher 接口）
     */
    setTokenMarketMappings(_mappings: Map<string, { market: { marketId: number; title: string }; side: 'YES' | 'NO' }>): void {
        // TokenMarketCache 已经自动管理映射，这里不需要额外操作
    }

    // ============================================================================
    // Private
    // ============================================================================

    private async fetchJwt(): Promise<string> {
        const API_BASE_URL = process.env.PREDICT_API_BASE_URL || 'https://api.predict.fun';
        const provider = new JsonRpcProvider(getBscRpcUrl());
        const signer = new Wallet(this.config.privateKey, provider);
        const orderBuilder = await OrderBuilder.make(56, signer as any, {
            predictAccount: this.config.smartWalletAddress,
        }) as OrderBuilder;

        const msgRes = await fetch(`${API_BASE_URL}/v1/auth/message`, {
            headers: { 'x-api-key': this.config.apiKey },
        });
        if (!msgRes.ok) throw new Error(`auth/message failed: ${msgRes.status}`);
        const msgData = await msgRes.json() as { data: { message: string } };
        const message = msgData.data.message;
        const signature = await orderBuilder.signPredictAccountMessage(message);

        const authRes = await fetch(`${API_BASE_URL}/v1/auth`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.config.apiKey,
            },
            body: JSON.stringify({
                signer: this.config.smartWalletAddress,
                signature,
                message,
            }),
        });
        if (!authRes.ok) {
            const text = await authRes.text();
            throw new Error(`auth failed: ${authRes.status} - ${text.slice(0, 200)}`);
        }
        const authData = await authRes.json() as { data: { token: string } };
        const token = authData.data.token;

        // 解析 JWT 过期时间
        this.jwtExpiresAt = this.parseJwtExpiration(token);
        if (this.jwtExpiresAt) {
            const expiresIn = Math.round((this.jwtExpiresAt - Date.now()) / 1000 / 60);
            console.log(`[PredictOrderWatcher] JWT 获取成功，${expiresIn} 分钟后过期`);
        } else {
            // 无法解析过期时间，使用默认 1 小时
            this.jwtExpiresAt = Date.now() + 60 * 60 * 1000;
            console.log('[PredictOrderWatcher] JWT 获取成功，设置默认 60 分钟过期');
        }

        return token;
    }

    private handleWalletEvent(event: WalletEventData): void {
        // 处理终态事件（ORDER_CANCELLED / ORDER_EXPIRED）
        if (event.type === 'ORDER_CANCELLED' || event.type === 'ORDER_EXPIRED') {
            let orderHash = event.orderHash?.toLowerCase();
            const orderId = event.orderId?.replace(/n$/, '');
            if (!orderHash && orderId) {
                const mappedHash = this.idToHashMap.get(orderId);
                if (mappedHash) orderHash = mappedHash;
            }
            if (orderHash || orderId) {
                const terminatedEvent: OrderTerminatedEvent = {
                    orderHash: orderHash || '',
                    orderId,
                    type: event.type === 'ORDER_CANCELLED' ? 'CANCELLED' : 'EXPIRED',
                    reason: event.reason || (event.rawData as any)?.cancelReason,
                    timestamp: event.timestamp || Date.now(),
                    rawEvent: event,
                };
                this.emit('orderTerminated', terminatedEvent);
            }
            return;
        }

        // 只处理成交相关事件
        // 注意：ORDER_TX_PENDING (orderTransactionSubmitted) 不触发 fill，
        //      因为交易可能失败，提前触发对冲会导致仓位不一致
        const fillEvents = ['ORDER_FILLED', 'ORDER_PARTIALLY_FILLED', 'ORDER_TX_CONFIRMED'];
        if (!fillEvents.includes(event.type)) {
            return;
        }

        // 获取订单标识（优先 orderHash，否则用 orderId 查找映射）
        let orderHash = event.orderHash?.toLowerCase();
        const orderId = event.orderId?.replace(/n$/, '');  // 移除可能的 'n' 后缀

        // 如果没有 orderHash 但有 orderId，尝试从映射中查找
        if (!orderHash && orderId) {
            const mappedHash = this.idToHashMap.get(orderId);
            if (mappedHash) orderHash = mappedHash;
        }

        // 必须有可用的标识符
        if (!orderHash && !orderId) {
            console.warn('[PredictOrderWatcher] 事件缺少 orderHash 和 orderId，忽略');
            return;
        }

        // 去重：使用 orderId + txHash + filledQty（orderId 比 orderHash 更可靠）
        const txHash = event.txHash || '';
        const dedupKey = `${orderId || orderHash}:${txHash}:${event.filledQty ?? 0}`;
        if (this.processedEvents.has(dedupKey)) return;
        this.processedEvents.set(dedupKey, Date.now());

        // 转换为兼容格式
        const filledEvent = this.convertToFilledEvent(event);
        // 确保 filledEvent 有 orderHash（可能是从 orderId 映射来的）
        if (orderHash && !filledEvent.orderHash) {
            filledEvent.orderHash = orderHash;
        }

        // 广播给全局监听器
        this.emit('orderFilled', filledEvent);

        // 通知特定订单的监听器（用 orderHash 查找）
        if (orderHash) {
            const callbacks = this.orderWatchers.get(orderHash);
            if (callbacks) {
                for (const cb of callbacks) {
                    try {
                        cb(filledEvent);
                    } catch (e: any) {
                        console.warn('[PredictOrderWatcher] Callback error:', e?.message);
                    }
                }
            }
        }
    }

    private convertToFilledEvent(event: WalletEventData): OrderFilledEvent {
        const raw = event.rawData as any;

        // 尝试从 rawData 中提取详细信息
        const makerAssetId = String(raw?.makerAssetId ?? raw?.order?.makerAssetId ?? '');
        const takerAssetId = String(raw?.takerAssetId ?? raw?.order?.takerAssetId ?? '');
        const makerAmountFilled = String(raw?.makerAmountFilled ?? raw?.makerAmount ?? '0');
        const takerAmountFilled = String(raw?.takerAmountFilled ?? raw?.takerAmount ?? '0');
        const fee = String(raw?.fee ?? '0');

        // 生成唯一 logIndex：Predict WS 不提供真实 logIndex，
        // 使用 filledQty 转整数后的低 16 位作为伪 logIndex，确保同一 txHash 内不同成交量的事件不会被去重
        // 这样 task-executor 使用 txHash:logIndex 去重时能正确区分多笔成交
        const filledQty = event.filledQty ?? 0;
        // 使用整数运算确保稳定：filledQty 可能是浮点数，先乘以 1e6 再取整
        const pseudoLogIndex = raw?.logIndex ?? (Math.floor(filledQty * 1e6) % 65536);

        return {
            orderHash: event.orderHash,
            txHash: event.txHash || '',
            logIndex: pseudoLogIndex,
            maker: this.config.smartWalletAddress,
            taker: '',
            makerAssetId,
            takerAssetId,
            makerAmountFilled,
            takerAmountFilled,
            fee,
            blockNumber: raw?.blockNumber ?? 0,
            timestamp: event.timestamp || Date.now(),
            rawEvent: event,
        };
    }

    private cleanupProcessedEvents(): void {
        const now = Date.now();
        const expireTime = 120000; // 2分钟
        for (const [key, time] of this.processedEvents) {
            if (now - time > expireTime) {
                this.processedEvents.delete(key);
            }
        }
    }

    // ============================================================================
    // JWT 管理
    // ============================================================================

    /**
     * 检查 JWT 是否即将过期
     */
    private isJwtExpiringSoon(): boolean {
        if (!this.jwtExpiresAt) return true;
        return Date.now() >= this.jwtExpiresAt - PredictOrderWatcher.JWT_REFRESH_MARGIN_MS;
    }

    /**
     * 启动 JWT 刷新定时器
     */
    private startJwtRefreshTimer(): void {
        if (this.jwtRefreshTimer) {
            clearInterval(this.jwtRefreshTimer);
        }

        // 计算下次刷新时间
        const refreshIn = this.jwtExpiresAt
            ? Math.max(0, this.jwtExpiresAt - Date.now() - PredictOrderWatcher.JWT_REFRESH_MARGIN_MS)
            : PredictOrderWatcher.JWT_REFRESH_INTERVAL_MS;

        // 首次刷新（如果快过期）
        if (refreshIn < 60000) {
            setTimeout(() => this.refreshJwt(), refreshIn);
        }

        // 定期检查刷新
        this.jwtRefreshTimer = setInterval(() => {
            if (this.isJwtExpiringSoon()) {
                this.refreshJwt();
            }
        }, 60000);  // 每分钟检查一次
    }

    /**
     * 刷新 JWT 并重新订阅
     */
    private async refreshJwt(): Promise<void> {
        if (!this.isRunning) return;

        try {
            console.log('[PredictOrderWatcher] 正在刷新 JWT...');
            const newJwt = await this.fetchJwt();

            // 取消旧订阅
            if (this.walletEventHandler && this.wsClient) {
                await this.wsClient.unsubscribeWalletEvents(this.walletEventHandler);
            }

            // 更新 JWT 并重新订阅（带重试）
            this.jwt = newJwt;
            if (this.wsClient && this.walletEventHandler) {
                this.wsClient.setJwt(newJwt);
                await this.subscribeWithRetry();
            }
        } catch (e: any) {
            console.error('[PredictOrderWatcher] JWT 刷新失败:', e?.message);
            this.subscriptionValid = false;
            this.emit('subscriptionLost', { reason: 'jwt_refresh_failed', error: e?.message });
            // 失败后稍后重试
            setTimeout(() => this.refreshJwt(), 30000);
        }
    }

    /**
     * 订阅钱包事件（带重试）
     */
    private async subscribeWithRetry(): Promise<void> {
        if (!this.wsClient || !this.walletEventHandler) return;

        for (let attempt = 1; attempt <= PredictOrderWatcher.SUBSCRIPTION_MAX_RETRIES; attempt++) {
            // 检查 WS 连接状态，必要时重连
            if (!this.wsClient.isConnected()) {
                console.log(`[PredictOrderWatcher] WS 未连接，尝试重连 (${attempt}/${PredictOrderWatcher.SUBSCRIPTION_MAX_RETRIES})...`);
                try {
                    await this.wsClient.connect();
                } catch (e: any) {
                    console.warn(`[PredictOrderWatcher] WS 重连失败: ${e?.message}`);
                    if (attempt < PredictOrderWatcher.SUBSCRIPTION_MAX_RETRIES) {
                        await new Promise(resolve => setTimeout(resolve, PredictOrderWatcher.SUBSCRIPTION_RETRY_DELAY_MS));
                    }
                    continue;
                }
            }

            const success = await this.wsClient.subscribeWalletEvents(this.walletEventHandler);
            if (success) {
                this.subscriptionValid = true;
                console.log('[PredictOrderWatcher] JWT 刷新成功，已重新订阅');
                this.emit('subscriptionRestored');
                return;
            }

            console.warn(`[PredictOrderWatcher] 订阅失败，重试 ${attempt}/${PredictOrderWatcher.SUBSCRIPTION_MAX_RETRIES}...`);
            if (attempt < PredictOrderWatcher.SUBSCRIPTION_MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, PredictOrderWatcher.SUBSCRIPTION_RETRY_DELAY_MS));
            }
        }

        // 所有重试失败
        this.subscriptionValid = false;
        console.error('[PredictOrderWatcher] ⚠️ 订阅失败，钱包事件可能断流！');
        this.emit('subscriptionLost', { reason: 'subscribe_failed_after_retries' });
    }

    /**
     * 从 JWT 解析过期时间
     */
    private parseJwtExpiration(jwt: string): number {
        try {
            // JWT 格式: header.payload.signature
            const parts = jwt.split('.');
            if (parts.length !== 3) return 0;

            const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
            if (payload.exp) {
                return payload.exp * 1000;  // 转换为毫秒
            }
        } catch {
            // 解析失败，使用默认过期时间
        }
        return 0;
    }
}

// ============================================================================
// 工具函数（兼容 bsc-order-watcher 接口）
// ============================================================================

/**
 * 从成交事件中提取 shares 数量
 */
export function getSharesFromFillEvent(event: OrderFilledEvent): number {
    // 从 Predict WS 事件中提取
    if (event.rawEvent) {
        const wsEvent = event.rawEvent;
        if (typeof wsEvent.filledQty === 'number' && wsEvent.filledQty > 0) {
            return wsEvent.filledQty;
        }
    }

    // 从 amount 字段解析
    const parseWei18 = (v: string): number => {
        try {
            const s = String(v || '0');
            if (!s || s === '0') return 0;
            return Number(BigInt(s)) / 1e18;
        } catch {
            return 0;
        }
    };

    // takerAssetId=0 表示 USDC，另一边是 token
    if (event.takerAssetId === '0') {
        // maker 给出 token
        return parseWei18(event.makerAmountFilled);
    } else {
        // taker 给出 token
        return parseWei18(event.takerAmountFilled);
    }
}

// ============================================================================
// Singleton
// ============================================================================

let globalPredictOrderWatcher: PredictOrderWatcher | null = null;

export function getPredictOrderWatcher(smartWalletAddress?: string): PredictOrderWatcher {
    if (!globalPredictOrderWatcher) {
        const apiKey = process.env.PREDICT_API_KEY_TRADE || process.env.PREDICT_API_KEY || '';
        const privateKey = process.env.PREDICT_SIGNER_PRIVATE_KEY || '';
        const wallet = smartWalletAddress || process.env.PREDICT_SMART_WALLET_ADDRESS || '';

        if (!apiKey || !privateKey || !wallet) {
            throw new Error('PredictOrderWatcher requires PREDICT_API_KEY, PREDICT_SIGNER_PRIVATE_KEY, and PREDICT_SMART_WALLET_ADDRESS');
        }

        globalPredictOrderWatcher = new PredictOrderWatcher({
            apiKey,
            smartWalletAddress: wallet,
            privateKey,
        });
    }
    return globalPredictOrderWatcher;
}

export function stopPredictOrderWatcher(): void {
    if (globalPredictOrderWatcher) {
        globalPredictOrderWatcher.stop();
        globalPredictOrderWatcher = null;
    }
}

// 兼容旧接口的别名
export { PredictOrderWatcher as BscOrderWatcher };
export { getPredictOrderWatcher as getBscOrderWatcher };
export { stopPredictOrderWatcher as stopBscOrderWatcher };
