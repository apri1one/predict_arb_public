/**
 * Probable REST API Client
 *
 * 说明：
 * - 市场列表建议走 market-api 域名
 * - 交易相关接口走 api 域名
 */

import type {
    ProbableMarket,
    ProbableEvent,
    ProbableClientOptions,
    GetProbableMarketsOptions,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.probable.markets/public/api/v1';
const DEFAULT_PUBLIC_BASE_URL = 'https://market-api.probable.markets/public/api/v1';
const DEFAULT_REQUEST_TIMEOUT = 15000;

type MarketsEnvelope = {
    markets?: ProbableMarket[];
};

export class ProbableRestClient {
    readonly baseUrl: string;
    readonly publicBaseUrl: string;
    private readonly requestTimeout: number;

    constructor(options: ProbableClientOptions = {}) {
        this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
        this.publicBaseUrl = options.publicBaseUrl || DEFAULT_PUBLIC_BASE_URL;
        this.requestTimeout = options.requestTimeout || DEFAULT_REQUEST_TIMEOUT;
    }

    private async fetch<T>(url: string, options: RequestInit = {}): Promise<T> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal,
                headers: {
                    Accept: 'application/json',
                    ...options.headers,
                },
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
            }

            return response.json() as Promise<T>;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * 获取市场列表（market-api）
     */
    async getMarkets(options: GetProbableMarketsOptions = {}): Promise<ProbableMarket[]> {
        const params = new URLSearchParams();

        if (options.limit !== undefined) params.append('limit', String(options.limit));
        if (options.offset !== undefined) params.append('offset', String(options.offset));
        if (options.active !== undefined) params.append('active', String(options.active));
        if (options.closed !== undefined) params.append('closed', String(options.closed));
        if (options.archived !== undefined) params.append('archived', String(options.archived));
        if (options.slug) params.append('slug', options.slug);

        const url = `${this.publicBaseUrl}/markets${params.toString() ? `?${params.toString()}` : ''}`;
        const payload = await this.fetch<MarketsEnvelope | ProbableMarket[]>(url);

        if (Array.isArray(payload)) return payload;
        return payload.markets || [];
    }

    /**
     * 获取事件列表（market-api）
     */
    async getEvents(options: { limit?: number; offset?: number } = {}): Promise<ProbableEvent[]> {
        const params = new URLSearchParams();
        if (options.limit !== undefined) params.append('limit', String(options.limit));
        if (options.offset !== undefined) params.append('offset', String(options.offset));

        const url = `${this.publicBaseUrl}/events${params.toString() ? `?${params.toString()}` : ''}`;
        return this.fetch<ProbableEvent[]>(url);
    }

    /**
     * 分页获取活跃市场
     */
    async getAllActiveMarkets(options: { limit?: number; maxPages?: number } = {}): Promise<ProbableMarket[]> {
        const limit = options.limit ?? 200;
        const maxPages = options.maxPages ?? 50;
        const all: ProbableMarket[] = [];

        for (let page = 0; page < maxPages; page++) {
            const offset = page * limit;
            const markets = await this.getMarkets({
                limit,
                offset,
                active: true,
                closed: false,
                archived: false,
            });

            if (markets.length === 0) break;
            all.push(...markets);
            if (markets.length < limit) break;
        }

        const deduped = new Map<string, ProbableMarket>();
        for (const market of all) {
            if (!market?.id) continue;
            deduped.set(String(market.id), market);
        }
        return Array.from(deduped.values());
    }
}

export function createProbableRestClient(options?: ProbableClientOptions): ProbableRestClient {
    return new ProbableRestClient(options);
}
