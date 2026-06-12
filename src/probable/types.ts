/**
 * Probable REST API Types
 */

export interface ProbableToken {
    token_id: string;
    outcome: string;
    price?: string;
}

export interface ProbableMarket {
    id: string;
    condition_id: string;
    question: string;
    question_id?: string;
    market_slug: string;
    outcomes: string;
    volume24hr?: string;
    liquidity?: string;
    clobTokenIds: string;
    active: boolean;
    closed: boolean;
    archived?: boolean;
    startDate?: string;
    endDate?: string;
    tokens?: ProbableToken[];
    icon?: string;
    description?: string;
    tags?: string[];
    groupItemTitle?: string;
    resolved?: boolean;
    liveness?: string;
    disputed?: boolean;
    proposal_history?: unknown[];
}

export interface ProbableEvent {
    id: string;
    slug: string;
    title: string;
    createdAt?: string;
    image?: string;
    icon?: string;
    active: boolean;
    closed: boolean;
    archived?: boolean;
    live?: boolean;
    ended?: boolean;
    liquidity?: string;
    volume?: string;
    volume24hr?: number | string;
    marketStructure?: string;
    markets?: ProbableMarket[];
}

export interface ProbableClientOptions {
    baseUrl?: string;
    publicBaseUrl?: string;
    requestTimeout?: number;
}

export interface GetProbableMarketsOptions {
    limit?: number;
    offset?: number;
    active?: boolean;
    closed?: boolean;
    archived?: boolean;
    slug?: string;
}
