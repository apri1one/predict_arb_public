/**
 * WebSocket 订单通知服务
 *
 * 订阅 Polymarket User Channel，将订单状态变更推送到 Telegram。
 * - 采用多订阅者 API（避免覆盖其他模块的监听器）
 * - stop() 会清理 interval 与 listener，避免泄漏
 */

import {
    PolymarketUserWsClient,
    getPolymarketUserWsClient,
    type OrderEvent,
    type TradeEvent,
} from '../polymarket/user-ws-client.js';
import { TelegramNotifier, createTelegramNotifier } from './telegram.js';

export interface WsOrderNotifierConfig {
    apiKey: string;
    secret: string;
    passphrase: string;

    telegramBotToken: string;
    telegramChatId: string;

    notifyPlacement?: boolean;
    notifyCancellation?: boolean;
    notifyUpdate?: boolean;
    notifyTrade?: boolean;

    silencePeriodMs?: number;
}

/**
 * 安全解析时间戳
 * - 空值返回当前时间
 * - 纯数字字符串按 Unix 时间戳解析（自动检测 ms/s）
 * - ISO 字符串直接解析
 * - 无效值返回当前时间
 */
function safeFormatTimestamp(ts: string | number | undefined | null): string {
    if (!ts) return new Date().toLocaleString('zh-CN', { hour12: false });

    let date: Date;
    if (typeof ts === 'number') {
        date = ts > 1e12 ? new Date(ts) : new Date(ts * 1000);
    } else if (/^\d+$/.test(ts)) {
        const num = parseInt(ts, 10);
        date = num > 1e12 ? new Date(num) : new Date(num * 1000);
    } else {
        date = new Date(ts);
    }

    return isNaN(date.getTime())
        ? new Date().toLocaleString('zh-CN', { hour12: false })
        : date.toLocaleString('zh-CN', { hour12: false });
}

export class WsOrderNotifier {
    private wsClient: PolymarketUserWsClient | null = null;
    private telegram: TelegramNotifier;
    private config: Required<WsOrderNotifierConfig>;
    private isRunning = false;

    private recentNotifications: Map<string, number> = new Map();
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    private listenerIds: string[] = [];

    constructor(config: WsOrderNotifierConfig) {
        this.config = {
            ...config,
            notifyPlacement: config.notifyPlacement ?? false,
            notifyCancellation: config.notifyCancellation ?? true,
            notifyUpdate: config.notifyUpdate ?? true,
            notifyTrade: config.notifyTrade ?? true,
            silencePeriodMs: config.silencePeriodMs ?? 5000,
        };

        this.telegram = createTelegramNotifier({
            botToken: config.telegramBotToken,
            chatId: config.telegramChatId,
            enabled: true,
        });
    }

    async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;

        this.wsClient = getPolymarketUserWsClient({
            apiKey: this.config.apiKey,
            secret: this.config.secret,
            passphrase: this.config.passphrase,
        });

        this.listenerIds = [
            this.wsClient.addOrderEventListener((event) => {
                void this.handleOrderEvent(event).catch((e) => {
                    console.warn('[WsOrderNotifier] handleOrderEvent failed:', e?.message || e);
                });
            }),
            this.wsClient.addTradeEventListener((event) => {
                void this.handleTradeEvent(event).catch((e) => {
                    console.warn('[WsOrderNotifier] handleTradeEvent failed:', e?.message || e);
                });
            }),
            this.wsClient.addConnectListener(() => {
                this.telegram
                    .sendText(`🔵 🔗 <b>Polymarket 订单监控已连接</b>

实时推送订单状态变更

<b>数据源:</b> Polymarket User WS
<b>时间:</b> ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
                    .catch((e) => console.warn('[WsOrderNotifier] Failed to send connect notification:', e?.message || e));
            }),
            this.wsClient.addDisconnectListener((code, reason) => {
                if (!this.isRunning) return;
                this.telegram
                    .sendText(`🔵 ⚠️ <b>Polymarket 订单监控断开</b>

<b>代码:</b> ${code}
<b>原因:</b> ${reason || '未知'}
<b>时间:</b> ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
                    .catch((e) => console.warn('[WsOrderNotifier] Failed to send disconnect notification:', e?.message || e));
            }),
            this.wsClient.addErrorListener((error) => {
                console.warn('[WsOrderNotifier] User WS error:', error.message);
            }),
        ];

        await this.wsClient.connect();

        this.cleanupTimer = setInterval(() => this.cleanupRecentNotifications(), 60000);
    }

    stop(): void {
        if (!this.isRunning) return;
        this.isRunning = false;

        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        if (this.wsClient) {
            for (const id of this.listenerIds) {
                if (id.startsWith('order_')) this.wsClient.removeOrderEventListener(id);
                else if (id.startsWith('trade_')) this.wsClient.removeTradeEventListener(id);
                else if (id.startsWith('connect_')) this.wsClient.removeConnectListener(id);
                else if (id.startsWith('disconnect_')) this.wsClient.removeDisconnectListener(id);
                else if (id.startsWith('error_')) this.wsClient.removeErrorListener(id);
            }
            this.listenerIds = [];
            this.wsClient = null;
        }

        this.telegram
            .sendText(`🔵 🛑 <b>Polymarket 订单监控已停止</b>

<b>时间:</b> ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
            .catch((e) => console.warn('[WsOrderNotifier] Failed to send stop notification:', e?.message || e));
    }

    running(): boolean {
        return this.isRunning;
    }

    private async handleOrderEvent(event: OrderEvent): Promise<void> {
        if (event.type === 'PLACEMENT' && !this.config.notifyPlacement) return;
        if (event.type === 'CANCELLATION' && !this.config.notifyCancellation) return;
        if (event.type === 'UPDATE' && !this.config.notifyUpdate) return;

        const key = `order:${event.id}:${event.type}`;
        if (this.isDuplicateNotification(key)) return;

        const actionIcon = event.side === 'BUY' ? '📈' : '📉';
        const actionText = event.side === 'BUY' ? '买入' : '卖出';
        const price = parseFloat(event.price || '0');
        const originalSize = parseFloat(event.original_size || '0');
        const sizeMatched = parseFloat(event.size_matched || '0');

        // 根据事件类型确定角色
        const role = event.type === 'PLACEMENT' ? 'Maker (挂单)' : 'Maker';

        let quantityText: string;
        let amountText: string = '';
        let priceLabel: string;

        switch (event.type) {
            case 'PLACEMENT':
                quantityText = `${originalSize.toFixed(0)} 股`;
                priceLabel = '挂单价';
                amountText = `\n<b>金额:</b> $${(price * originalSize).toFixed(2)}`;
                break;
            case 'UPDATE':
                quantityText = `${sizeMatched.toFixed(0)}/${originalSize.toFixed(0)} 股`;
                priceLabel = '成交价';
                amountText = `\n<b>成交额:</b> $${(price * sizeMatched).toFixed(2)}`;
                break;
            case 'CANCELLATION':
                quantityText = sizeMatched > 0
                    ? `${sizeMatched.toFixed(0)}/${originalSize.toFixed(0)} 股 (已取消)`
                    : `${originalSize.toFixed(0)} 股 (已取消)`;
                priceLabel = '挂单价';
                break;
            default:
                quantityText = `${originalSize.toFixed(0)} 股`;
                priceLabel = '价格';
        }

        let message = `🔵 ${this.getOrderEmoji(event.type)} <b>Polymarket 订单${this.getOrderTypeText(event.type)}</b>

<b>类型:</b> ${actionIcon} ${actionText}
<b>角色:</b> ${role}
<b>${priceLabel}:</b> ${(price * 100).toFixed(1)}¢
<b>数量:</b> ${quantityText}${amountText}

<b>订单:</b> <code>${event.id.slice(0, 18)}...</code>
<b>时间:</b> ${safeFormatTimestamp(event.timestamp)}

📡 <i>via Polymarket WS</i>`;

        await this.telegram.sendText(message);
    }

    private async handleTradeEvent(event: TradeEvent): Promise<void> {
        if (!this.config.notifyTrade) return;
        if (!['MINED', 'CONFIRMED', 'FAILED'].includes(event.status)) return;

        const key = `trade:${event.taker_order_id}:${event.status}`;
        if (this.isDuplicateNotification(key)) return;

        const emoji = event.status === 'CONFIRMED' ? '✅' : event.status === 'FAILED' ? '🚨' : '⏳';
        const statusText = event.status === 'CONFIRMED' ? '成交' : event.status === 'FAILED' ? '失败' : '处理中';
        const actionIcon = event.side === 'BUY' ? '📈' : '📉';
        const actionText = event.side === 'BUY' ? '买入' : '卖出';
        const price = parseFloat(event.price || '0');
        const size = parseFloat(event.size || '0');

        const message = `🔵 ${emoji} <b>Polymarket 交易${statusText}</b>

<b>类型:</b> ${actionIcon} ${actionText}
<b>角色:</b> Taker
<b>成交价:</b> ${(price * 100).toFixed(1)}¢
<b>成交量:</b> ${size.toFixed(0)} 股
<b>成交额:</b> $${(price * size).toFixed(2)}

<b>订单:</b> <code>${event.taker_order_id.slice(0, 18)}...</code>
<b>时间:</b> ${safeFormatTimestamp(event.timestamp)}

📡 <i>via Polymarket WS</i>`;

        await this.telegram.sendText(message);
    }

    private getOrderEmoji(type: string): string {
        switch (type) {
            case 'PLACEMENT': return '📝';
            case 'UPDATE': return '🔄';
            case 'CANCELLATION': return '❌';
            default: return '📋';
        }
    }

    private getOrderTypeText(type: string): string {
        switch (type) {
            case 'PLACEMENT': return '已挂单';
            case 'UPDATE': return '部分成交';
            case 'CANCELLATION': return '已取消';
            default: return '更新';
        }
    }

    private isDuplicateNotification(key: string): boolean {
        const now = Date.now();
        const lastTime = this.recentNotifications.get(key);
        if (lastTime && now - lastTime < this.config.silencePeriodMs) return true;
        this.recentNotifications.set(key, now);
        return false;
    }

    private cleanupRecentNotifications(): void {
        const now = Date.now();
        const expireTime = this.config.silencePeriodMs * 2;
        for (const [key, time] of this.recentNotifications) {
            if (now - time > expireTime) this.recentNotifications.delete(key);
        }
    }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: WsOrderNotifier | null = null;

export function getWsOrderNotifier(config?: WsOrderNotifierConfig): WsOrderNotifier {
    if (!instance) {
        if (!config) throw new Error('Config required for first initialization');
        instance = new WsOrderNotifier(config);
    }
    return instance;
}

export async function startWsOrderNotifierFromEnv(): Promise<WsOrderNotifier | null> {
    const apiKey = process.env.POLYMARKET_API_KEY;
    const secret = process.env.POLYMARKET_API_SECRET;
    const passphrase = process.env.POLYMARKET_PASSPHRASE;
    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;

    if (!apiKey || !secret || !passphrase) {
        console.warn('[WsOrderNotifier] Missing Polymarket credentials, skipping');
        return null;
    }
    if (!telegramBotToken || !telegramChatId) {
        console.warn('[WsOrderNotifier] Missing Telegram credentials, skipping');
        return null;
    }

    const notifier = getWsOrderNotifier({
        apiKey,
        secret,
        passphrase,
        telegramBotToken,
        telegramChatId,
        notifyPlacement: false,
        notifyCancellation: true,
        notifyUpdate: true,
        notifyTrade: true,
    });

    await notifier.start();
    return notifier;
}

export function stopWsOrderNotifier(): void {
    if (instance) {
        instance.stop();
        instance = null;
    }
}

