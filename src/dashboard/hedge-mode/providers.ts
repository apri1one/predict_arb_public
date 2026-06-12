/**
 * Hedge Mode 依赖注入 - 订单簿与 API Key 提供者
 *
 * service.ts 通过这里读取 provider；start-dashboard.ts 通过 setter 注入。
 * 拆分到独立文件是为了避免 service.ts 既导出业务函数又导出 setter 造成的循环依赖与测试困难。
 */

interface OrderbookLevel {
    price: number;
    size: number;
}

interface Orderbook {
    bids: OrderbookLevel[];
    asks: OrderbookLevel[];
}

export type PolyOrderbookProvider = (tokenId: string) => Orderbook | null;
export type PredictOrderbookProvider = (marketId: number) => Orderbook | null;
export type PredictApiKeyProvider = () => string | null;

let polyOrderbookProvider: PolyOrderbookProvider | null = null;
let predictOrderbookProvider: PredictOrderbookProvider | null = null;
let predictApiKeyProvider: PredictApiKeyProvider | null = null;

export function setPolyOrderbookProvider(provider: PolyOrderbookProvider): void {
    polyOrderbookProvider = provider;
}

export function setPredictOrderbookProvider(provider: PredictOrderbookProvider): void {
    predictOrderbookProvider = provider;
}

export function setPredictApiKeyProvider(provider: PredictApiKeyProvider): void {
    predictApiKeyProvider = provider;
}

export function getPolyOrderbookProvider(): PolyOrderbookProvider | null {
    return polyOrderbookProvider;
}

export function getPredictOrderbookProvider(): PredictOrderbookProvider | null {
    return predictOrderbookProvider;
}

export function getPredictApiKeyProvider(): PredictApiKeyProvider | null {
    return predictApiKeyProvider;
}
