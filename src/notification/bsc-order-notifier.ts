/**
 * BSC 链上订单通知服务
 *
 * 订阅 BscOrderWatcher 的 orderFilled 事件，将 Predict 订单成交推送到 Telegram。
 * 默认只通知“自己的订单”（需要 PREDICT_SMART_WALLET_ADDRESS），避免刷屏。
 */

import { EventEmitter } from 'events';
import { getBscOrderWatcher, getSharesFromFillEvent, getFillDirection, PREDICT_EXCHANGE_ADDRESSES, type OrderFilledEvent } from '../services/bsc-order-watcher.js';
import { getTokenMarketCache, type TokenLookupResult } from '../services/token-market-cache.js';
import { getTaskService } from '../dashboard/task-service.js';
import type { TaskStatus } from '../dashboard/types.js';
import { TelegramNotifier, createTelegramNotifier } from './telegram.js';

export interface BscOrderNotifierConfig {
    telegramBotToken: string;
    telegramChatId: string;

    enabled?: boolean;
    notifyAllOrders?: boolean;
    smartWalletAddress?: string;

    silencePeriodMs?: number;
}

interface TaskIntentMatch {
    taskId: string;
    side: 'BUY' | 'SELL';
    outcome: 'YES' | 'NO';
    title: string;
}

const TASK_INTENT_LOOKBACK_MS = 10 * 60 * 1000;
const ACTIVE_TASK_STATUSES = new Set<TaskStatus>([
    'PENDING',
    'VALIDATING',
    'PREDICT_SUBMITTED',
    'PARTIALLY_FILLED',
    'PAUSED',
    'HEDGING',
    'HEDGE_PENDING',
    'HEDGE_RETRY',
    'LOSS_HEDGE',
    'UNWINDING',
    'UNWIND_PENDING',
]);

export class BscOrderNotifier extends EventEmitter {
    private telegram: TelegramNotifier;
    private config: Required<BscOrderNotifierConfig>;
    private isRunning = false;
    private eventHandler: ((event: OrderFilledEvent) => void) | null = null;

    private recentNotifications: Map<string, number> = new Map();
    private cleanupTimer: NodeJS.Timeout | null = null;

    // CTF 交易所同一笔 tx 产生两个 OrderFilled 事件 (YES/NO 配对结算)
    // 缓冲同一 txHash 的事件，选最佳的发送，避免重复通知
    private pendingTxEvents: Map<string, { events: OrderFilledEvent[]; timer: NodeJS.Timeout }> = new Map();

    constructor(config: BscOrderNotifierConfig) {
        super();
        this.config = {
            ...config,
            enabled: config.enabled ?? true,
            notifyAllOrders: config.notifyAllOrders ?? false,
            smartWalletAddress: config.smartWalletAddress ?? '',
            silencePeriodMs: config.silencePeriodMs ?? 60000,
        };

        this.telegram = createTelegramNotifier({
            botToken: config.telegramBotToken,
            chatId: config.telegramChatId,
            enabled: this.config.enabled,
        });
    }

    async start(): Promise<void> {
        if (this.isRunning) return;
        if (!this.config.enabled) return;

        if (!this.config.notifyAllOrders && !this.config.smartWalletAddress) {
            console.warn('[BscOrderNotifier] PREDICT_SMART_WALLET_ADDRESS 未配置，默认不启用以避免刷屏');
            return;
        }

        const bscWatcher = getBscOrderWatcher();
        if (!bscWatcher.isConnected()) {
            await bscWatcher.start();
        }

        this.eventHandler = (event) => {
            void this.handleOrderFilledEvent(event).catch((e) => {
                console.warn('[BscOrderNotifier] handleOrderFilledEvent failed:', e?.message || e);
            });
        };
        bscWatcher.on('orderFilled', this.eventHandler);

        this.cleanupTimer = setInterval(() => this.cleanupRecentNotifications(), 60000);
        this.isRunning = true;

        console.log(`[BscOrderNotifier] 已启动 silencePeriodMs=${this.config.silencePeriodMs} notifyAllOrders=${this.config.notifyAllOrders} wallet=${this.config.smartWalletAddress.slice(0, 10)}...`);

        // fire-and-forget，不阻塞启动流程
        this.telegram.sendText(`🟠 🔗 <b>Predict 链上订单监控已启动</b>

实时推送订单成交通知

<b>数据源:</b> BSC WebSocket
<b>钱包:</b> <code>${this.config.smartWalletAddress.slice(0, 10)}...${this.config.smartWalletAddress.slice(-4)}</code>
<b>时间:</b> ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
            .catch(() => { /* ignore */ });
    }

    stop(): void {
        if (!this.isRunning) return;
        this.isRunning = false;

        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        // 清理 pending tx buffers
        for (const [, entry] of this.pendingTxEvents) {
            clearTimeout(entry.timer);
        }
        this.pendingTxEvents.clear();

        if (this.eventHandler) {
            try {
                getBscOrderWatcher().off('orderFilled', this.eventHandler);
            } catch { /* ignore */ }
            this.eventHandler = null;
        }

        this.telegram
            .sendText(`🟠 🛑 <b>Predict 链上订单监控已停止</b>

<b>时间:</b> ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
            .catch(() => { /* ignore */ });
    }

    running(): boolean {
        return this.isRunning;
    }

    private async handleOrderFilledEvent(event: OrderFilledEvent): Promise<void> {
        const myAddress = this.config.smartWalletAddress?.toLowerCase() || '';

        if (!this.config.notifyAllOrders) {
            const isMine = event.maker.toLowerCase() === myAddress || event.taker.toLowerCase() === myAddress;
            if (!isMine) return;
        }

        // CTF 交易所同一笔 tx 产生 YES/NO 配对的两个 OrderFilled 事件
        // 用 setTimeout(0) 而非固定 150ms：让通知尽快进入 TG 队列（在 hedge HTTP 之前），
        // 保证 BSC 成交消息早于对冲消息到达 TG。
        // 若同一 txHash 的第二个配对事件在 timer 触发前到达，仍可合并；
        // 若 timer 已触发，第二个事件会被 isDuplicateNotification 去重忽略。
        const pending = this.pendingTxEvents.get(event.txHash);
        if (pending) {
            pending.events.push(event);
            return; // timer 已启动，等待收集完毕
        }

        const entry = {
            events: [event],
            timer: setTimeout(() => {
                this.pendingTxEvents.delete(event.txHash);
                void this.notifyFromTxEvents(entry.events, myAddress).catch(e => {
                    console.warn('[BscOrderNotifier] notifyFromTxEvents failed:', e?.message || e);
                });
            }, 0),
        };
        this.pendingTxEvents.set(event.txHash, entry);
    }

    /**
     * 从同一 tx 的所有事件中提取最佳信息并发送通知
     *
     * CTF 交易所同一笔 tx 可能产生多个 OrderFilled 事件 (YES/NO 配对结算)。
     * 策略:
     * 1. 遍历所有事件的所有 tokenId 查找市场（解决互补面 tokenId 不在缓存的问题）
     * 2. 优先使用能解析到市场的事件计算价格/方向
     * 3. 链上 maker/taker 不一定对应 API 层的角色（NegRisk 结算会交换），
     *    方向仅反映链上资产流向
     */
    private async notifyFromTxEvents(events: OrderFilledEvent[], myAddress: string): Promise<void> {
        // 去重 key: orderHash + txHash — 同一订单同一 tx 只发一次通知（跨 logIndex 合并）
        // partial fill 产生新 txHash，因此此 key 不会误伤后续部分成交的通知
        const key = `bsc:${events[0].orderHash.toLowerCase()}:${events[0].txHash.toLowerCase()}`;
        if (this.isDuplicateNotification(key)) return;

        const tokenCache = getTokenMarketCache();
        const cacheReady = tokenCache.isReady();

        // 优先选择“真实成交事件”（对手方不是 Exchange 合约），并只解析与我方实际收/付 token 对应的 tokenId
        const resolved = cacheReady ? this.resolveBestEventLookup(events, myAddress) : null;
        const lookup = resolved?.lookup || null;
        const resolvedEvent = resolved?.event || null;

        // 未解析到市场时记录调试信息
        if (!lookup) {
            const allTokenIds = events.flatMap(e =>
                [e.makerAssetId, e.takerAssetId].filter(id => id !== '0')
            );
            console.warn(
                `[BscOrderNotifier] 市场查找失败 tx=${events[0].txHash.slice(0, 16)}`,
                `events=${events.length}`,
                `tokenIds=[${allTokenIds.map(id => id.slice(0, 12) + '...').join(', ')}]`,
                `cacheReady=${cacheReady}`,
            );
        }

        // 使用解析到市场的事件，否则回退到第一个事件
        const event = resolvedEvent || events[0];

        const marketTitle = lookup?.market.title || '未知市场';
        const tokenSide = lookup?.side || '?';  // YES/NO

        // 使用统一工具函数
        const shares = getSharesFromFillEvent(event);
        const direction = getFillDirection(event, myAddress);  // 'BUY' | 'SELL' | null

        // 计算 USDC 金额：哪边的 assetId 是 0，那边的 amount 就是 USDC
        const usdcAmount = event.takerAssetId === '0'
            ? event.takerAmountFilled
            : event.makerAmountFilled;

        // 计算成交价格（链上原始视角）
        const price = shares > 0 ? usdcAmount / shares : 0;

        // 默认展示链上视角；标题可用本地任务/缓存补全，但方向/价格以链上 token 映射为准
        let displayTitle = marketTitle;
        let displaySide: 'YES' | 'NO' | '?' = tokenSide === 'YES' || tokenSide === 'NO' ? tokenSide : '?';
        let displayDirection: 'BUY' | 'SELL' | null = direction;
        let displayPrice = price;
        let displayUsdcAmount = usdcAmount;

        // negRisk 方向修正：negRisk 交易产生多个 OrderFilled 事件 (真实交易 + Exchange 内部结算)，
        // 真实事件中的资产流向与用户实际意图相反 (买 NO 在链上表现为卖 token)，需翻转方向
        if (displayDirection && events.length >= 2) {
            const hasExchangeCounterparty = events.some(evt => {
                const m = evt.maker.toLowerCase();
                const t = evt.taker.toLowerCase();
                return PREDICT_EXCHANGE_ADDRESSES.has(m) || PREDICT_EXCHANGE_ADDRESSES.has(t);
            });
            if (hasExchangeCounterparty) {
                displayDirection = displayDirection === 'BUY' ? 'SELL' : 'BUY';
            }
        }

        const taskIntent = this.resolveTaskIntent(lookup?.market.marketId, event.timestamp, shares);
        if (taskIntent) {
            if (!displayTitle || displayTitle === '未知市场' || /^Market #\d+$/i.test(displayTitle)) {
                displayTitle = taskIntent.title || displayTitle;
            }
            // 任务意图方向优先级最高（比 negRisk 翻转更可靠）
            if (taskIntent.side === 'BUY' || taskIntent.side === 'SELL') {
                displayDirection = taskIntent.side;
            }
        }

        const outcomeName = this.getDisplayOutcomeName(lookup, displayTitle, displaySide);
        const sideDisplay = outcomeName && outcomeName !== 'Yes' && outcomeName !== 'No'
            ? `${displaySide} (${outcomeName})`
            : displaySide;

        // 角色判定：negRisk 产生 2 个 OrderFilled 事件，内部结算事件的 maker/taker 不可靠。
        // 找"真实事件"（对手方不是 Exchange 合约的那个），在真实事件中 maker/taker 字段可靠。
        let role: 'Maker' | 'Taker' = 'Taker';  // 默认 Taker（保守）
        for (const evt of events) {
            const m = evt.maker.toLowerCase();
            const t = evt.taker.toLowerCase();
            const userIsMaker = m === myAddress;
            const userIsTaker = t === myAddress;
            if (!userIsMaker && !userIsTaker) continue;
            const counterparty = userIsMaker ? t : m;
            if (!PREDICT_EXCHANGE_ADDRESSES.has(counterparty)) {
                // 真实事件：对手方是普通钱包，maker/taker 角色可靠
                role = userIsMaker ? 'Maker' : 'Taker';
                break;
            }
        }

        // 交易类型
        const actionEmoji = displayDirection === 'BUY' ? '📈' : displayDirection === 'SELL' ? '📉' : '❓';
        const actionText = displayDirection === 'BUY' ? '买入' : displayDirection === 'SELL' ? '卖出' : '成交';

        // Maker 不付费，fee 只对 Taker 有效
        const feeAmount = role === 'Taker' ? event.fee : 0;
        const message = `🟠 ✅ <b>Predict 订单成交</b> (链上确认)

<b>类型:</b> ${actionEmoji} ${actionText}
<b>市场:</b> ${this.escapeHtml(displayTitle.slice(0, 60))}${displayTitle.length > 60 ? '...' : ''}
<b>方向:</b> ${sideDisplay}
<b>角色:</b> ${role}
<b>成交价:</b> ${(displayPrice * 100).toFixed(1)}¢
<b>成交量:</b> ${shares.toFixed(2)} 股
<b>成交额:</b> $${displayUsdcAmount.toFixed(2)}
<b>手续费:</b> $${feeAmount.toFixed(4)}

<b>订单:</b> <code>${event.orderHash.slice(0, 16)}...</code>
<b>交易:</b> <a href="https://bscscan.com/tx/${event.txHash}">查看</a>
<b>区块:</b> #${event.blockNumber}
<b>时间:</b> ${new Date(event.timestamp).toLocaleString('zh-CN')}

📡 <i>via BSC WebSocket</i>`;

        await this.telegram.sendText(message);
        this.emit('notified', event);
    }

    private resolveTaskIntent(
        marketId: number | undefined,
        fillTimestamp: number,
        shares: number
    ): TaskIntentMatch | null {
        try {
            const taskService = getTaskService();
            // 有 marketId 时精确匹配；无 marketId 时在所有任务中模糊匹配（足球等缓存未覆盖的市场）
            const candidates = (marketId && Number.isFinite(marketId) && marketId > 0)
                ? taskService.getTasks({ marketId, includeCompleted: true })
                : taskService.getTasks({ includeCompleted: true });
            if (candidates.length === 0) return null;

            const hasMarketId = !!(marketId && Number.isFinite(marketId) && marketId > 0);
            let best: TaskIntentMatch | null = null;
            let bestScore = Number.POSITIVE_INFINITY;

            for (const task of candidates) {
                const timeDiff = Math.abs(task.updatedAt - fillTimestamp);
                if (timeDiff > TASK_INTENT_LOOKBACK_MS) continue;

                const qtyRef = task.predictFilledQty > 0 ? task.predictFilledQty : task.quantity;
                const qtyDiff = Math.abs(qtyRef - shares);
                const statusPenalty = ACTIVE_TASK_STATUSES.has(task.status) ? 0 : 20000;
                const score = timeDiff + qtyDiff * 1500 + statusPenalty;

                if (score < bestScore) {
                    bestScore = score;
                    best = {
                        taskId: task.id,
                        side: task.type,
                        outcome: task.arbSide,
                        title: task.title || '',
                    };
                }
            }

            // 无 marketId 时搜索范围是全部任务，需更严格的得分阈值防止误匹配
            // 要求: 时间差 <30s + 数量偏差 <5% 对应的得分大约 30000 + 少量 qtyDiff
            if (!hasMarketId && bestScore > 45000) return null;

            return best;
        } catch (e: any) {
            console.warn('[BscOrderNotifier] resolveTaskIntent failed:', e?.message || e);
            return null;
        }
    }

    private resolveBestEventLookup(
        events: OrderFilledEvent[],
        myAddress: string,
    ): { event: OrderFilledEvent; lookup: TokenLookupResult } | null {
        let fallback: { event: OrderFilledEvent; lookup: TokenLookupResult } | null = null;
        const my = myAddress.toLowerCase();
        const tokenCache = getTokenMarketCache();

        for (const event of events) {
            const lookup = this.resolveLookupForEvent(event, my, tokenCache);
            if (!lookup) continue;

            const counterparty = event.maker.toLowerCase() === my
                ? event.taker.toLowerCase()
                : event.maker.toLowerCase();
            const isRealCounterparty = !PREDICT_EXCHANGE_ADDRESSES.has(counterparty);

            if (isRealCounterparty) {
                return { event, lookup };
            }
            if (!fallback) {
                fallback = { event, lookup };
            }
        }

        return fallback;
    }

    private resolveLookupForEvent(
        event: OrderFilledEvent,
        myAddressLower: string,
        tokenCache: ReturnType<typeof getTokenMarketCache>,
    ): TokenLookupResult | null {
        const iAmMaker = event.maker.toLowerCase() === myAddressLower;
        const iAmTaker = event.taker.toLowerCase() === myAddressLower;
        if (!iAmMaker && !iAmTaker) return null;

        const direction = getFillDirection(event, myAddressLower);
        if (!direction) return null;

        let tokenId = '';
        if (direction === 'BUY') {
            tokenId = iAmMaker ? event.takerAssetId : event.makerAssetId;
        } else {
            tokenId = iAmMaker ? event.makerAssetId : event.takerAssetId;
        }

        if (tokenId && tokenId !== '0') {
            return tokenCache.getMarketByTokenId(tokenId);
        }
        if (event.makerAssetId !== '0') {
            const makerLookup = tokenCache.getMarketByTokenId(event.makerAssetId);
            if (makerLookup) return makerLookup;
        }
        if (event.takerAssetId !== '0') {
            return tokenCache.getMarketByTokenId(event.takerAssetId);
        }
        return null;
    }

    private getDisplayOutcomeName(
        lookup: TokenLookupResult | null,
        displayTitle: string,
        displaySide: 'YES' | 'NO' | '?',
    ): string | undefined {
        if (!lookup || (displaySide !== 'YES' && displaySide !== 'NO')) return undefined;

        const directName = displaySide === 'YES' ? lookup.market.yesName : lookup.market.noName;
        if (directName && !this.isGenericOutcomeName(directName)) {
            return directName;
        }

        const parsed = this.parseSelectionFromMarketTitle(displayTitle);
        if (!parsed) return undefined;

        if (displaySide === 'YES') {
            return parsed.selection;
        }

        if (parsed.selectionKind === 'draw') {
            return 'Not Draw';
        }
        if (parsed.selectionKind === 'teamA') {
            return parsed.teamB;
        }
        if (parsed.selectionKind === 'teamB') {
            return parsed.teamA;
        }
        return `Not ${parsed.selection}`;
    }

    private isGenericOutcomeName(name: string | undefined): boolean {
        if (!name) return true;
        const normalized = name.trim().toLowerCase();
        return normalized === 'yes' || normalized === 'no' || normalized === 'up' || normalized === 'down';
    }

    private parseSelectionFromMarketTitle(title: string): {
        teamA: string;
        teamB: string;
        selection: string;
        selectionKind: 'teamA' | 'teamB' | 'draw' | 'unknown';
    } | null {
        const trimmed = String(title || '').trim();
        const sepIndex = trimmed.lastIndexOf(' - ');
        if (sepIndex <= 0) return null;

        const eventTitle = trimmed.slice(0, sepIndex).trim();
        const selection = trimmed.slice(sepIndex + 3).trim();
        if (!eventTitle || !selection) return null;

        const teams = this.parseTeamsFromEventTitle(eventTitle);
        if (!teams) {
            return {
                teamA: '',
                teamB: '',
                selection,
                selectionKind: /draw/i.test(selection) ? 'draw' : 'unknown',
            };
        }

        let selectionKind: 'teamA' | 'teamB' | 'draw' | 'unknown' = 'unknown';
        if (/draw/i.test(selection)) {
            selectionKind = 'draw';
        } else if (this.normalizeTeamName(selection) === this.normalizeTeamName(teams.teamA)) {
            selectionKind = 'teamA';
        } else if (this.normalizeTeamName(selection) === this.normalizeTeamName(teams.teamB)) {
            selectionKind = 'teamB';
        }

        return {
            teamA: teams.teamA,
            teamB: teams.teamB,
            selection,
            selectionKind,
        };
    }

    private parseTeamsFromEventTitle(eventTitle: string): { teamA: string; teamB: string } | null {
        const normalized = eventTitle.trim();
        let match = normalized.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
        if (match) {
            return { teamA: match[1].trim(), teamB: match[2].trim() };
        }
        match = normalized.match(/^(.+?)\s+@\s+(.+)$/i);
        if (match) {
            return { teamA: match[1].trim(), teamB: match[2].trim() };
        }
        return null;
    }

    private normalizeTeamName(name: string): string {
        return String(name || '')
            .toLowerCase()
            .replace(/\bfc\b/g, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    private isDuplicateNotification(key: string): boolean {
        const now = Date.now();
        const lastTime = this.recentNotifications.get(key);
        if (lastTime && now - lastTime < this.config.silencePeriodMs) {
            console.log(`[BscOrderNotifier] 去重命中 key=${key} (距上次 ${now - lastTime}ms < ${this.config.silencePeriodMs}ms)`);
            return true;
        }
        this.recentNotifications.set(key, now);
        return false;
    }

    private cleanupRecentNotifications(): void {
        const now = Date.now();
        for (const [key, time] of this.recentNotifications.entries()) {
            if (now - time > this.config.silencePeriodMs * 2) {
                this.recentNotifications.delete(key);
            }
        }
    }

    private escapeHtml(text: string): string {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
}

let globalBscOrderNotifier: BscOrderNotifier | null = null;

export function getBscOrderNotifier(config?: BscOrderNotifierConfig): BscOrderNotifier {
    if (!globalBscOrderNotifier) {
        if (!config) throw new Error('BscOrderNotifier not initialized. Call with config first.');
        globalBscOrderNotifier = new BscOrderNotifier(config);
    }
    return globalBscOrderNotifier;
}

export async function startBscOrderNotifierFromEnv(): Promise<BscOrderNotifier | null> {
    const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    const telegramChatId = process.env.TELEGRAM_CHAT_ID;
    const smartWalletAddress = process.env.PREDICT_SMART_WALLET_ADDRESS;

    if (!telegramBotToken || !telegramChatId) {
        console.warn('[BscOrderNotifier] Missing Telegram credentials, skipping');
        return null;
    }

    if (!smartWalletAddress) {
        console.warn('[BscOrderNotifier] Missing PREDICT_SMART_WALLET_ADDRESS, skipping');
        return null;
    }

    const notifier = getBscOrderNotifier({
        telegramBotToken,
        telegramChatId,
        smartWalletAddress,
        enabled: true,
        notifyAllOrders: false,
    });

    await notifier.start();
    return notifier;
}

export function stopBscOrderNotifier(): void {
    if (globalBscOrderNotifier) {
        globalBscOrderNotifier.stop();
        globalBscOrderNotifier = null;
    }
}
