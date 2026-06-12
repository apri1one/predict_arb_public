// Preview Mock Data — 仅用于设计预览，覆盖 useArbScanner 返回静态数据
// ⚠️ preview.html 同时是生产 dashboard 的 /index.html 入口（start-dashboard.ts 直接服务 preview.html）
// 因此 mock 必须用 URL 参数自我门控，否则会劫持生产 dashboard 的数据与 fetch
//   本地预览：  http://localhost:8080/preview.html?mock
//   生产环境：  http://localhost:3010/        ← 无 ?mock，mock 自动失活
var Preview = window.Preview || (window.Preview = {});

(function () {
    const mockEnabled = new URLSearchParams(location.search).has('mock');
    if (!mockEnabled) {
        console.log('[mock-data] inactive (add ?mock to URL to enable preview mock)');
        return;
    }
    const now = Date.now();

    // --- Mock Opportunities ---
    const mockOpportunities = [
        {
            id: 'opp-1',
            strategy: 'PREDICT_MAKER',
            side: 'YES',
            isInverted: false,
            title: 'Will Bitcoin reach $150,000 before end of 2026?',
            outcome: 'Yes',
            marketId: 'pred-btc-150k',
            predictSlug: 'btc-150k-2026',
            polymarketSlug: 'will-bitcoin-reach-150k',
            polymarketConditionId: '0xabcd1234',
            estimatedProfit: 2.45,
            profitPercent: 3.2,
            predictAsk: 0.485,
            predictBid: 0.482,
            polymarketAsk: 0.512,
            polymarketBid: 0.510,
            predictVolume: 1_245_000,
            polymarketVolume: 8_400_000,
            depth: {
                predictAskDepth: 850,
                predictBidDepth: 920,
                polymarketBidDepth: 12_400,
                polymarketAskDepth: 11_800,
                polymarketYesAskDepth: 11_800,
                polymarketNoAskDepth: 9_500,
            },
            endDate: now + 30 * 24 * 3600 * 1000,
            boosted: true,
            boostStartTime: now - 5 * 60 * 1000,
            boostEndTime: now + 25 * 60 * 1000,
            pointsTier: 'Gold',
            pointsHourlyRate: 245,
            pointsNextTier: 'Platinum',
            pointsNextHourlyRate: 380,
            pointsYield: 0.42,
        },
        {
            id: 'opp-2',
            strategy: 'TAKER',
            side: 'NO',
            isInverted: false,
            title: 'Will the Federal Reserve cut rates in March 2026?',
            outcome: 'No',
            marketId: 'pred-fed-march',
            predictSlug: 'fed-rate-march-2026',
            polymarketSlug: 'fed-rate-cut-march',
            polymarketConditionId: '0xefgh5678',
            estimatedProfit: 1.18,
            profitPercent: 1.6,
            predictAsk: 0.342,
            predictBid: 0.338,
            polymarketAsk: 0.358,
            polymarketBid: 0.355,
            predictVolume: 540_000,
            polymarketVolume: 3_100_000,
            depth: {
                predictAskDepth: 1_240,
                predictBidDepth: 980,
                polymarketBidDepth: 8_200,
                polymarketAskDepth: 7_900,
                polymarketYesAskDepth: 8_500,
                polymarketNoAskDepth: 7_900,
            },
            endDate: now + 12 * 24 * 3600 * 1000,
            boosted: false,
            pointsTier: 'Silver',
            pointsHourlyRate: 110,
            pointsYield: 0.58,
        },
        {
            id: 'opp-3',
            strategy: 'PREDICT_MAKER',
            side: 'YES',
            isInverted: true,
            title: 'Will Ethereum surpass $8,000 in Q2 2026?',
            outcome: 'Yes',
            marketId: 'pred-eth-8k',
            predictSlug: 'eth-8k-q2-2026',
            polymarketSlug: 'eth-8000-q2',
            polymarketConditionId: '0xijkl9012',
            estimatedProfit: 4.82,
            profitPercent: 5.7,
            predictAsk: 0.218,
            predictBid: 0.214,
            polymarketAsk: 0.275,
            polymarketBid: 0.270,
            predictVolume: 2_100_000,
            polymarketVolume: 6_700_000,
            depth: {
                predictAskDepth: 620,
                predictBidDepth: 540,
                polymarketBidDepth: 18_400,
                polymarketAskDepth: 16_900,
                polymarketYesAskDepth: 16_900,
                polymarketNoAskDepth: 14_200,
            },
            endDate: now + 60 * 24 * 3600 * 1000,
            boosted: false,
            pointsTier: 'Platinum',
            pointsHourlyRate: 420,
            pointsYield: 0.31,
        },
        {
            id: 'opp-4',
            strategy: 'TAKER',
            side: 'YES',
            isInverted: false,
            title: 'Will OpenAI release GPT-6 in 2026?',
            outcome: 'Yes',
            marketId: 'pred-gpt6',
            predictSlug: 'openai-gpt6-2026',
            polymarketSlug: 'gpt6-release-2026',
            polymarketConditionId: '0xmnop3456',
            estimatedProfit: 0.75,
            profitPercent: 1.1,
            predictAsk: 0.612,
            predictBid: 0.608,
            polymarketAsk: 0.625,
            polymarketBid: 0.620,
            predictVolume: 320_000,
            polymarketVolume: 1_800_000,
            depth: {
                predictAskDepth: 480,
                predictBidDepth: 510,
                polymarketBidDepth: 5_400,
                polymarketAskDepth: 5_100,
                polymarketYesAskDepth: 5_100,
                polymarketNoAskDepth: 4_300,
            },
            endDate: now + 200 * 24 * 3600 * 1000,
            boosted: false,
            pointsTier: 'Bronze',
            pointsHourlyRate: 45,
            pointsYield: 0.72,
        },
        {
            id: 'opp-5',
            strategy: 'PREDICT_MAKER',
            side: 'NO',
            isInverted: false,
            title: 'Will Tesla stock close above $400 on Dec 31, 2026?',
            outcome: 'No',
            marketId: 'pred-tsla-400',
            predictSlug: 'tsla-400-eoy-2026',
            polymarketSlug: 'tsla-400-2026',
            polymarketConditionId: '0xqrst7890',
            estimatedProfit: 3.21,
            profitPercent: 4.1,
            predictAsk: 0.395,
            predictBid: 0.391,
            polymarketAsk: 0.428,
            polymarketBid: 0.425,
            predictVolume: 880_000,
            polymarketVolume: 4_200_000,
            depth: {
                predictAskDepth: 1_120,
                predictBidDepth: 1_050,
                polymarketBidDepth: 9_800,
                polymarketAskDepth: 9_200,
                polymarketYesAskDepth: 10_400,
                polymarketNoAskDepth: 9_200,
            },
            endDate: now + 240 * 24 * 3600 * 1000,
            boosted: false,
            pointsTier: 'Gold',
            pointsHourlyRate: 215,
            pointsYield: 0.48,
        },
    ];

    // 补全 mapOpportunity 衍生字段（真实模式下由后端 arb-service 计算并通过 SSE 下发；
    // mock 模式直接绕过 mapOpportunity，必须自填，否则 app.jsx 的 takerCost/maxQuantity 过滤会清空列表）
    for (const opp of mockOpportunities) {
        const askDepth = opp.depth?.polymarketAskDepth ?? 0;
        const predDepth = opp.depth?.predictAskDepth ?? 0;
        if (opp.maxQuantity == null) opp.maxQuantity = Math.max(50, Math.min(predDepth || askDepth, askDepth || predDepth));
        if (opp.polymarketPrice == null) opp.polymarketPrice = opp.polymarketAsk;
        if (opp.polyVolume == null) opp.polyVolume = opp.polymarketVolume;
        if (opp.takerCost == null) opp.takerCost = +(((opp.polymarketAsk ?? 0) - (opp.predictAsk ?? 0)) * 100 + 30).toFixed(1);
        if (opp.makerCost == null) opp.makerCost = +(((opp.polymarketBid ?? 0) - (opp.predictBid ?? 0)) * 100 + 22).toFixed(1);
    }

    // --- Mock Tasks ---
    const mockTasks = [
        {
            id: 'task-001',
            status: 'RUNNING',
            strategy: 'PREDICT_MAKER',
            side: 'YES',
            arbSide: 'BUY',
            marketId: 'pred-btc-150k',
            title: 'Will Bitcoin reach $150,000 before end of 2026?',
            outcome: 'Yes',
            targetQty: 1000,
            filledQty: 420,
            avgPrice: 0.483,
            estimatedProfit: 2.45,
            profitPercent: 3.2,
            createdAt: now - 8 * 60 * 1000,
            updatedAt: now - 30 * 1000,
            expiresAt: now + 50 * 60 * 1000,
            budgetRatio: 0.42,
            entries: [
                { ts: now - 7 * 60 * 1000, side: 'BUY', qty: 200, price: 0.482, status: 'FILLED' },
                { ts: now - 4 * 60 * 1000, side: 'BUY', qty: 220, price: 0.484, status: 'FILLED' },
            ],
        },
        {
            id: 'task-002',
            status: 'PENDING',
            strategy: 'TAKER',
            side: 'NO',
            arbSide: 'SELL',
            marketId: 'pred-fed-march',
            title: 'Will the Federal Reserve cut rates in March 2026?',
            outcome: 'No',
            targetQty: 500,
            filledQty: 0,
            avgPrice: 0,
            estimatedProfit: 1.18,
            profitPercent: 1.6,
            createdAt: now - 90 * 1000,
            updatedAt: now - 90 * 1000,
            expiresAt: now + 30 * 60 * 1000,
            budgetRatio: 0.18,
            entries: [],
        },
        {
            id: 'task-003',
            status: 'COMPLETED',
            strategy: 'PREDICT_MAKER',
            side: 'YES',
            arbSide: 'BUY',
            marketId: 'pred-eth-8k',
            title: 'Will Ethereum surpass $8,000 in Q2 2026?',
            outcome: 'Yes',
            targetQty: 800,
            filledQty: 800,
            avgPrice: 0.216,
            estimatedProfit: 4.82,
            realizedProfit: 4.65,
            profitPercent: 5.7,
            createdAt: now - 45 * 60 * 1000,
            updatedAt: now - 12 * 60 * 1000,
            expiresAt: now - 5 * 60 * 1000,
            budgetRatio: 0.35,
            entries: [
                { ts: now - 44 * 60 * 1000, side: 'BUY', qty: 400, price: 0.215, status: 'FILLED' },
                { ts: now - 30 * 60 * 1000, side: 'BUY', qty: 400, price: 0.217, status: 'FILLED' },
                { ts: now - 13 * 60 * 1000, side: 'SELL', qty: 800, price: 0.272, status: 'FILLED' },
            ],
        },
        {
            id: 'task-004',
            status: 'FAILED',
            strategy: 'TAKER',
            side: 'YES',
            arbSide: 'BUY',
            marketId: 'pred-gpt6',
            title: 'Will OpenAI release GPT-6 in 2026?',
            outcome: 'Yes',
            targetQty: 300,
            filledQty: 50,
            avgPrice: 0.611,
            estimatedProfit: 0.75,
            profitPercent: 1.1,
            createdAt: now - 22 * 60 * 1000,
            updatedAt: now - 18 * 60 * 1000,
            expiresAt: now - 2 * 60 * 1000,
            budgetRatio: 0.08,
            error: 'Polymarket rejected order: insufficient liquidity at target price',
            entries: [
                { ts: now - 21 * 60 * 1000, side: 'BUY', qty: 50, price: 0.611, status: 'FILLED' },
                { ts: now - 19 * 60 * 1000, side: 'BUY', qty: 250, price: 0.611, status: 'REJECTED' },
            ],
        },
    ];

    // --- Mock Accounts ---
    const mockAccounts = {
        predict: {
            total: 12_450.32,
            available: 8_320.45,
            portfolio: 4_129.87,
            positions: [
                { marketId: 'pred-btc-150k', title: 'Will Bitcoin reach $150,000 before end of 2026?', side: 'YES', qty: 420, avgPrice: 0.483, marketPrice: 0.485, pnl: 0.84, pnlPercent: 0.41 },
                { marketId: 'pred-eth-8k', title: 'Will Ethereum surpass $8,000 in Q2 2026?', side: 'YES', qty: 800, avgPrice: 0.216, marketPrice: 0.272, pnl: 44.80, pnlPercent: 25.93 },
            ],
            openOrders: [
                { id: 'pred-ord-1', marketId: 'pred-btc-150k', side: 'BUY', qty: 580, price: 0.482, status: 'OPEN', createdAt: now - 8 * 60 * 1000 },
            ],
        },
        polymarket: {
            total: 18_220.15,
            available: 14_980.22,
            portfolio: 3_239.93,
            positions: [
                { marketId: '0xabcd1234', title: 'Will Bitcoin reach $150,000 before end of 2026?', side: 'NO', qty: 420, avgPrice: 0.510, marketPrice: 0.512, pnl: 0.84, pnlPercent: 0.39 },
                { marketId: '0xijkl9012', title: 'Will Ethereum surpass $8,000 in Q2 2026?', side: 'NO', qty: 800, avgPrice: 0.728, marketPrice: 0.728, pnl: 0, pnlPercent: 0 },
            ],
            openOrders: [],
        },
    };

    // --- Mock Stats ---
    const mockStats = {
        makerCount: 3,
        takerCount: 2,
        avgProfit: 2.48,
        maxProfit: 4.82,
        totalDepthUsd: 142_500,
        latency: { predict: 142, polymarket: 28, compute: 4 },
        connectionStatus: { predict: 'connected', polymarket: 'connected' },
    };

    // --- Mock Sports ---
    const mockSports = {
        markets: [
            {
                id: 'sports-1',
                eventTitle: 'Lakers vs Celtics',
                homeTeam: 'Lakers',
                awayTeam: 'Celtics',
                homeMT: 0.52, homeTT: 0.51,
                awayMT: 0.48, awayTT: 0.49,
                gameStartTime: now + 4 * 3600 * 1000,
                bestOpportunity: { side: 'home', estimatedProfit: 1.85, profitPercent: 2.4 },
                consistency: 0.92,
            },
            {
                id: 'sports-2',
                eventTitle: 'Real Madrid vs Barcelona',
                homeTeam: 'Real Madrid',
                awayTeam: 'Barcelona',
                homeMT: 0.41, homeTT: 0.42,
                awayMT: 0.34, awayTT: 0.33,
                gameStartTime: now + 26 * 3600 * 1000,
                bestOpportunity: { side: 'away', estimatedProfit: 0.92, profitPercent: 1.3 },
                consistency: 0.85,
            },
        ],
        stats: { totalMatched: 12, withArbitrage: 3, avgProfit: 1.4, maxProfit: 2.4 },
        lastUpdate: now - 30 * 1000,
    };

    // --- Mock Close Opportunities ---
    const mockCloseOpportunities = {
        opportunities: [
            {
                id: 'close-1',
                marketId: 'pred-eth-8k',
                title: 'Will Ethereum surpass $8,000 in Q2 2026?',
                side: 'YES',
                qty: 800,
                entryPrice: 0.216,
                currentPrice: 0.272,
                pnl: 44.80,
                pnlPercent: 25.93,
                exitProfit: 41.20,
                recommendation: 'HOLD',
            },
            {
                id: 'close-2',
                marketId: 'pred-btc-150k',
                title: 'Will Bitcoin reach $150,000 before end of 2026?',
                side: 'YES',
                qty: 420,
                entryPrice: 0.483,
                currentPrice: 0.485,
                pnl: 0.84,
                pnlPercent: 0.41,
                exitProfit: 0.50,
                recommendation: 'WAIT',
            },
        ],
        lastUpdate: now - 15 * 1000,
    };

    // --- Override useArbScanner ---
    Preview.useArbScanner = function useArbScannerMock(_addNotification, _addOrderToast) {
        const { useState } = Preview.ReactHooks;
        const [opportunities] = useState(mockOpportunities);
        const [tasks] = useState(mockTasks);
        const [accounts] = useState(mockAccounts);
        const [stats] = useState(mockStats);
        const [sports] = useState(mockSports);
        const [closeOpportunities] = useState(mockCloseOpportunities);
        const [exposureAlert, setExposureAlert] = useState(null);

        return {
            opportunities,
            history: [],
            chartData: { profitTrend: [], opportunityCounts: [], strategyDistribution: { maker: 60, taker: 40 } },
            stats,
            accounts,
            tasks,
            sports,
            closeOpportunities,
            isConnected: true,
            exposureAlert,
            setExposureAlert,
        };
    };

    // --- Stub fetch for mock-only mode ---
    // 拦截对 dashboard API 的请求，返回合理的 mock 响应
    // 不影响其他网络请求（如 fonts、tailwind cdn）
    const originalFetch = window.fetch.bind(window);
    window.fetch = function patchedFetch(input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const isApi = /\/api\/|localhost:301[01]/.test(url);
        if (!isApi) return originalFetch(input, init);

        // 模拟不同 API 的响应
        let body = { success: true };
        if (/all-markets\/status/.test(url)) body = { enabled: true };
        else if (/all-markets\/toggle/.test(url)) body = { success: true, enabled: !window.__mockAllMarkets, };
        else if (/pp-farmer\/status/.test(url)) {
            // Mock: 默认开启，方便预览 ON 状态视觉效果
            window.__mockPpFarmerEnabled = window.__mockPpFarmerEnabled ?? true;
            body = { success: true, data: {
                enabled: window.__mockPpFarmerEnabled, busy: false,
                config: { yieldThreshold: 0.31 },
                lastSummary: { qualified: 5, createdCount: 2, failedCount: 0, poolUsdc: 1245.5 },
                lastRunAt: Date.now() - 60_000,
                nextRunAt: Date.now() + 240_000,
            } };
        }
        else if (/pp-farmer\/toggle/.test(url)) {
            window.__mockPpFarmerEnabled = !(window.__mockPpFarmerEnabled ?? true);
            body = { success: true, data: {
                enabled: window.__mockPpFarmerEnabled, busy: false,
                config: { yieldThreshold: 0.31 },
                lastSummary: window.__mockPpFarmerEnabled ? { qualified: 5, createdCount: 2, failedCount: 0, poolUsdc: 1245.5 } : null,
                lastRunAt: window.__mockPpFarmerEnabled ? Date.now() - 60_000 : null,
                nextRunAt: window.__mockPpFarmerEnabled ? Date.now() + 240_000 : null,
            } };
        }
        else if (/tasks(\/?$|\?)/.test(url) && (init?.method || 'GET') === 'POST') body = { success: true, taskId: 'task-mock-' + Date.now() };

        return Promise.resolve(new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
    };

    console.log('[mock-data] Mock data loaded. Opportunities:', mockOpportunities.length, '| Tasks:', mockTasks.length);
})();
