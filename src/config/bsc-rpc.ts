/**
 * BSC RPC 节点配置
 * 按延迟测试结果排序 (2026-01-04)
 *
 * 测试结果:
 * - bsc-rpc.publicnode.com: 255ms (最快)
 * - bsc-dataseed.bnbchain.org: 268ms
 * - bsc.publicnode.com: 275ms
 * - bsc-dataseed2.binance.org: 279ms
 * - bsc-dataseed1.binance.org: 286ms
 */

export const BSC_RPC_ENDPOINTS = [
    'https://bsc-rpc.publicnode.com',       // 255ms - 最快
    'https://bsc-dataseed.bnbchain.org/',   // 268ms
    'https://bsc.publicnode.com',           // 275ms
    'https://bsc-dataseed2.binance.org/',   // 279ms
    'https://bsc-dataseed1.binance.org/',   // 286ms
] as const;

/**
 * 获取主 RPC URL（最快节点）
 */
export function getBscRpcUrl(): string {
    return BSC_RPC_ENDPOINTS[0];
}

/**
 * 获取所有备用 RPC URLs
 */
export function getBscRpcEndpoints(): string[] {
    return [...BSC_RPC_ENDPOINTS];
}

/**
 * RPC 故障转移管理器
 * 用于需要多节点备份的模块
 */
export class BscRpcFailover {
    private currentIndex = 0;
    private endpoints: string[];

    constructor(endpoints?: string[]) {
        this.endpoints = endpoints || getBscRpcEndpoints();
    }

    /**
     * 获取当前 RPC URL
     */
    getCurrentUrl(): string {
        return this.endpoints[this.currentIndex];
    }

    /**
     * 切换到下一个节点
     */
    switchToNext(): string {
        this.currentIndex = (this.currentIndex + 1) % this.endpoints.length;
        console.log(`[BscRpcFailover] Switched to: ${this.endpoints[this.currentIndex]}`);
        return this.endpoints[this.currentIndex];
    }

    /**
     * 重置到第一个节点
     */
    reset(): void {
        this.currentIndex = 0;
    }

    /**
     * 获取当前索引
     */
    getCurrentIndex(): number {
        return this.currentIndex;
    }
}
