/**
 * Predict Order Client
 * 
 * Handles order creation, signing, and submission to Predict.fun
 * Uses the SDK's OrderBuilder for signing and the REST API for submission
 */

import * as fs from 'fs';
import * as path from 'path';
import { Wallet } from 'ethers';

// Load env early
function loadEnv() {
    const envPath = path.join(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) process.env[match[1].trim()] = match[2].trim();
        }
    }
}

loadEnv();

export interface OrderInput {
    marketId: number;
    tokenId: string;         // Predict market tokenId (YES=0 or NO=1)
    side: 'BUY' | 'SELL';
    price: number;           // Price as decimal (0-1)
    quantity: number;        // Number of shares
    feeRateBps: number;      // Fee rate in basis points
    isNegRisk: boolean;      // From market data
    isYieldBearing?: boolean;
}

export interface SignedOrderPayload {
    hash: string;
    salt: string;
    maker: string;
    signer: string;
    taker: string;
    tokenId: string;
    makerAmount: string;
    takerAmount: string;
    expiration: string;
    nonce: string;
    feeRateBps: string;
    side: number;
    signatureType: number;
    signature: string;
}

export interface CreateOrderRequest {
    data: {
        pricePerShare: string;
        strategy: 'LIMIT' | 'MARKET';
        slippageBps: number;
        order: SignedOrderPayload;
    };
}

export interface CreateOrderResponse {
    success: boolean;
    data?: {
        orderHash: string;
        status: string;
    };
    error?: string;
}

// SDK Constants (from @predictdotfun/sdk/dist/Constants.js)
const PROTOCOL_NAME = 'predict.fun CTF Exchange';
const PROTOCOL_VERSION = '1';
const WEI = BigInt(1e18);

// Chain config for BSC
const CHAIN_ID = 56;

// Exchange addresses (from SDK AddressesByChainId)
const ADDRESSES = {
    CTF_EXCHANGE: '0x8BC070BEdAB741406F4B1Eb65A72bee27894B689',
    NEG_RISK_CTF_EXCHANGE: '0x365fb81bd4A24D6303cd2F19c349dE6894D8d58A',
    YIELD_BEARING_CTF_EXCHANGE: '0x6bEb5a40C032AFc305961162d8204CDA16DECFa5',
    YIELD_BEARING_NEG_RISK_CTF_EXCHANGE: '0x8A289d458f5a134bA40015085A8F50Ffb681B41d',
};

const EIP712_DOMAIN = [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
];

const ORDER_STRUCTURE = [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
];

export class PredictOrderClient {
    private signer: Wallet;
    private apiKey: string;
    private baseUrl = 'https://api.predict.fun';
    private initialized = false;

    constructor() {
        const privateKey = process.env.PREDICT_SIGNER_PRIVATE_KEY;
        const apiKey = process.env.PREDICT_API_KEY;

        if (!privateKey) {
            throw new Error('PREDICT_SIGNER_PRIVATE_KEY is required');
        }
        if (!apiKey) {
            throw new Error('PREDICT_API_KEY is required');
        }

        this.signer = new Wallet(privateKey);
        this.apiKey = apiKey;

        console.log(`[ORDER] Initialized with signer: ${this.signer.address}`);
    }

    /**
     * Initialize - no longer needs to fetch addresses (hardcoded from SDK)
     */
    async init(): Promise<void> {
        this.initialized = true;
        console.log(`[ORDER] Exchange addresses loaded from SDK constants`);
        console.log(`  - CTF_EXCHANGE: ${ADDRESSES.CTF_EXCHANGE}`);
        console.log(`  - NEG_RISK_CTF_EXCHANGE: ${ADDRESSES.NEG_RISK_CTF_EXCHANGE}`);
    }

    /**
     * Get the correct exchange address based on market type
     */
    private getExchangeAddress(isNegRisk: boolean, isYieldBearing: boolean): string {
        if (isNegRisk) {
            return isYieldBearing
                ? ADDRESSES.YIELD_BEARING_NEG_RISK_CTF_EXCHANGE
                : ADDRESSES.NEG_RISK_CTF_EXCHANGE;
        } else {
            return isYieldBearing
                ? ADDRESSES.YIELD_BEARING_CTF_EXCHANGE
                : ADDRESSES.CTF_EXCHANGE;
        }
    }

    /**
     * Create and submit a limit order
     */
    async createLimitOrder(input: OrderInput): Promise<CreateOrderResponse> {
        if (!this.initialized) {
            await this.init();
        }

        // Calculate amounts
        const priceWei = BigInt(Math.floor(input.price * 1e18));
        const quantityWei = BigInt(Math.floor(input.quantity * 1e18));

        let makerAmount: bigint;
        let takerAmount: bigint;

        if (input.side === 'BUY') {
            // BUY: maker pays USDC (price * qty), taker provides shares (qty)
            makerAmount = (priceWei * quantityWei) / WEI;
            takerAmount = quantityWei;
        } else {
            // SELL: maker provides shares (qty), taker pays USDC (price * qty)
            makerAmount = quantityWei;
            takerAmount = (priceWei * quantityWei) / WEI;
        }

        // Build order
        const salt = this.generateSalt();
        const expiration = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7; // 7 days

        const order = {
            salt: salt,
            maker: this.signer.address,
            signer: this.signer.address,
            taker: '0x0000000000000000000000000000000000000000',
            tokenId: input.tokenId,
            makerAmount: makerAmount.toString(),
            takerAmount: takerAmount.toString(),
            expiration: expiration.toString(),
            nonce: '0',
            feeRateBps: input.feeRateBps.toString(),
            side: input.side === 'BUY' ? 0 : 1,
            signatureType: 0, // EOA
        };

        // Sign order
        const signature = await this.signOrder(order, input.isNegRisk, input.isYieldBearing ?? false);

        // Calculate order hash
        const orderHash = this.calculateOrderHash(order);

        // Build request payload
        const payload: CreateOrderRequest = {
            data: {
                pricePerShare: priceWei.toString(),
                strategy: 'LIMIT',
                slippageBps: 0,
                order: {
                    hash: orderHash,
                    salt: order.salt,
                    maker: order.maker,
                    signer: order.signer,
                    taker: order.taker,
                    tokenId: order.tokenId,
                    makerAmount: order.makerAmount,
                    takerAmount: order.takerAmount,
                    expiration: order.expiration,
                    nonce: order.nonce,
                    feeRateBps: order.feeRateBps,
                    side: order.side,
                    signatureType: order.signatureType,
                    signature,
                },
            },
        };

        // Submit order
        try {
            const res = await fetch(`${this.baseUrl}/v1/orders`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey,
                },
                body: JSON.stringify(payload),
            });

            const data = await res.json() as any;

            if (!res.ok) {
                return {
                    success: false,
                    error: data.message || data.error || `HTTP ${res.status}`,
                };
            }

            return {
                success: true,
                data: {
                    orderHash: data.data?.hash || orderHash,
                    status: data.data?.status || 'OPEN',
                },
            };
        } catch (error) {
            return {
                success: false,
                error: String(error),
            };
        }
    }

    /**
     * Cancel an order
     */
    async cancelOrder(orderHash: string): Promise<boolean> {
        try {
            const res = await fetch(`${this.baseUrl}/v1/orders/${orderHash}`, {
                method: 'DELETE',
                headers: { 'x-api-key': this.apiKey },
            });
            return res.ok;
        } catch {
            return false;
        }
    }

    /**
     * Get order status
     */
    async getOrderStatus(orderHash: string): Promise<{ status: string; filledQuantity: number } | null> {
        try {
            const res = await fetch(`${this.baseUrl}/v1/orders/${orderHash}`, {
                headers: { 'x-api-key': this.apiKey },
            });

            if (!res.ok) return null;

            const data = await res.json() as { data: { status: string; quantityFilled: number } };
            return {
                status: data.data.status,
                filledQuantity: data.data.quantityFilled,
            };
        } catch {
            return null;
        }
    }

    // ============================================================================
    // Private Methods
    // ============================================================================

    private generateSalt(): string {
        return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString();
    }

    private async signOrder(
        order: any,
        isNegRisk: boolean,
        isYieldBearing: boolean
    ): Promise<string> {
        // 根据市场类型选择正确的 exchange 地址
        const verifyingContract = this.getExchangeAddress(isNegRisk, isYieldBearing);

        console.log(`[ORDER] Signing order for ${isNegRisk ? 'NegRisk' : 'Binary'} market`);
        console.log(`  - verifyingContract: ${verifyingContract}`);

        const domain = {
            name: PROTOCOL_NAME,
            version: PROTOCOL_VERSION,
            chainId: CHAIN_ID,
            verifyingContract,
        };

        const types = {
            Order: ORDER_STRUCTURE,
        };

        const value = {
            salt: order.salt,
            maker: order.maker,
            signer: order.signer,
            taker: order.taker,
            tokenId: order.tokenId,
            makerAmount: order.makerAmount,
            takerAmount: order.takerAmount,
            expiration: order.expiration,
            nonce: order.nonce,
            feeRateBps: order.feeRateBps,
            side: order.side,
            signatureType: order.signatureType,
        };

        const signature = await this.signer.signTypedData(domain, types, value);
        return signature;
    }

    private calculateOrderHash(order: any): string {
        // Simplified hash - in production use proper EIP-712 hash
        const data = JSON.stringify(order);
        // Use timestamp + random as simple hash for now
        return `0x${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
    }
}

// Factory
export function createPredictOrderClient(): PredictOrderClient {
    return new PredictOrderClient();
}
