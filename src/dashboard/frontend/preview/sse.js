var Preview = window.Preview || (window.Preview = {});
var { useState, useEffect, useRef, useCallback } = Preview.ReactHooks;
var { mapOpportunity } = Preview;

// --- SSE Configuration ---
const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const isFileOrigin = window.location.protocol === 'file:' || !window.location.hostname;
// Dashboard 默认端口 3010，前端和 API 在同一端口
// 仅当从文件直接打开时需要指定端口
const API_BASE_URL = isFileOrigin
    ? 'http://localhost:3010'  // 从文件直接打开时使用默认 Dashboard 端口
    : '';  // 从服务器访问时使用同源 (同端口)

// 任务 API 独立端口（port+1），隔离 SSE 流量防止 SSH 隧道拥塞
const TASK_API_BASE_URL = isFileOrigin
    ? 'http://localhost:3011'
    : `http://${window.location.hostname}:${parseInt(window.location.port || '3010') + 1}`;


// --- Data Hook with SSE ---
const useArbScanner = (addNotification, addOrderToast) => {
    const [opportunities, setOpportunities] = useState([]);
    const [history, setHistory] = useState([]);
    const [chartData, setChartData] = useState({
        profitTrend: [],
        opportunityCounts: [],
        strategyDistribution: { maker: 60, taker: 40 }
    });
    const [stats, setStats] = useState({
        makerCount: 0, takerCount: 0,
        avgProfit: 0, maxProfit: 0,
        totalDepthUsd: 0,
        latency: { predict: 150, polymarket: 25, compute: 0 },
        connectionStatus: {}
    });
    const [accounts, setAccounts] = useState({
        predict: { total: 0, available: 0, portfolio: 0, positions: [], openOrders: [] },
        polymarket: { total: 0, available: 0, portfolio: 0, positions: [], openOrders: [] }
    });
    const [markets, setMarkets] = useState([]);
    const [tasks, setTasks] = useState([]);
    const [sports, setSports] = useState({ markets: [], stats: { totalMatched: 0, withArbitrage: 0, avgProfit: 0, maxProfit: 0 }, lastUpdate: 0 });
    const [closeOpportunities, setCloseOpportunities] = useState({ opportunities: [], lastUpdate: null });
    const [isConnected, setIsConnected] = useState(false);
    const [exposureAlert, setExposureAlert] = useState(null);
    const eventSourceRef = useRef(null);
    const lastNotifiedRef = useRef(new Set());
    const reconnectTimeoutRef = useRef(null);
    // 前端机会缓存：保持卡片稳定，只更新价格和 shares
    const opportunityCacheRef = useRef(new Map()); // Map<id, {opp, lastSeen}>
    const FRONTEND_CACHE_EXPIRY_MS = 30 * 60 * 1000; // 30分钟后过期 (匹配后端 CACHE_EXPIRY_MS)
    const missingFieldWarnRef = useRef(new Map()); // Map<id, lastLogAt>

    // SSE 连接
    const connectSSE = useCallback(() => {
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
        }

        // 重连时清空缓存，避免旧数据残留（幽灵卡片）
        opportunityCacheRef.current.clear();

        console.log('?? Connecting to SSE...');
        const es = new EventSource(`${API_BASE_URL}/api/stream`);
        eventSourceRef.current = es;

        es.onopen = () => {
            console.log('? SSE Connected');
            setIsConnected(true);
        };

        es.onerror = (e) => {
            console.log('? SSE Error, reconnecting...');
            setIsConnected(false);
            es.close();

            // 3秒后重连
            if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
            reconnectTimeoutRef.current = setTimeout(connectSSE, 3000);
        };

        // 处理套利机会更新（支持增量推送）
        es.addEventListener('opportunity', (e) => {
            try {
                const rawData = JSON.parse(e.data);
                const now = Date.now();
                const cache = opportunityCacheRef.current;
                const warnCache = missingFieldWarnRef.current;

                // 兼容两种格式：数组 = 全量快照，对象 = 增量 { updated, removed }
                let rawOpps;
                if (Array.isArray(rawData)) {
                    rawOpps = rawData;
                } else {
                    rawOpps = rawData.updated || [];
                    // 删除已移除的机会
                    (rawData.removed || []).forEach(id => cache.delete(id));
                }
                const newOpps = rawOpps.map(mapOpportunity);

                // 1. 更新缓存：新数据更新已有条目，或添加新条目
                //    Boost 字段做”有值优先”合并，避免被无 boost 的增量包覆盖
                newOpps.forEach(opp => {
                    const prevEntry = cache.get(opp.id);
                    const prevOpp = prevEntry?.opp;
                    const prevHasBoost = Boolean(prevOpp?.boosted || prevOpp?.boostStartTime || prevOpp?.boostEndTime);
                    const currHasBoost = Boolean(opp.boosted || opp.boostStartTime || opp.boostEndTime);

                    let mergedOpp = opp;
                    if (!currHasBoost && prevHasBoost) {
                        mergedOpp = {
                            ...opp,
                            boosted: Boolean(prevOpp.boosted || prevOpp.boostStartTime || prevOpp.boostEndTime),
                            boostStartTime: prevOpp.boostStartTime || null,
                            boostEndTime: prevOpp.boostEndTime || null,
                        };
                    } else if (currHasBoost && !opp.boosted) {
                        mergedOpp = {
                            ...opp,
                            boosted: true,
                        };
                    }

                    cache.set(opp.id, { opp: mergedOpp, lastSeen: now });
                });

                // 2. 清理过期条目（超过60秒未更新）
                for (const [id, entry] of cache) {
                    if (now - entry.lastSeen > FRONTEND_CACHE_EXPIRY_MS) {
                        cache.delete(id);
                    }
                }

                // 3. 合并所有缓存数据生成最终列表
                const mergedOpps = Array.from(cache.values()).map(entry => entry.opp);

                // 4. 按 marketId 稳定排序
                mergedOpps.sort((a, b) => a.marketId - b.marketId);

                // 5. 设置状态
                setOpportunities(mergedOpps);

                // 缺失字段调试日志（避免刷屏）
                newOpps.forEach(opp => {
                    const missing = [];
                    if (!opp.polymarketConditionId) missing.push('polymarketConditionId');
                    if (!opp.polymarketNoTokenId) missing.push('polymarketNoTokenId');
                    if (!opp.polymarketYesTokenId) missing.push('polymarketYesTokenId');
                    if (missing.length > 0) {
                        const lastLog = warnCache.get(opp.id) || 0;
                        if (now - lastLog > 60000) {
                            console.warn('[Preview] Opportunity missing fields:', {
                                id: opp.id,
                                marketId: opp.marketId,
                                strategy: opp.strategy,
                                missing,
                            });
                            warnCache.set(opp.id, now);
                        }
                    }
                });

                // 高利润通知 - 只对后端标记为 isNew 的新机会通知
                newOpps.forEach(opp => {
                    // 只有 isNew=true 且利润超过阈值才通知
                    if (opp.isNew && opp.profitPercent > 0.5) {
                        addNotification(opp);
                        console.log(`[新机会通知] ${opp.title} | ${opp.side} ${opp.strategy} | ${opp.profitPercent.toFixed(2)}%`);
                    }
                });
            } catch (err) {
                console.error('Parse opportunity error:', err);
            }
        });

        // 处理初始连接分片推送（opportunity-batch）
        // 后端用 sendOpportunityBatchesAsync 分 30 个一批发送，避免大包阻塞 SSH 隧道
        es.addEventListener('opportunity-batch', (e) => {
            try {
                const { items } = JSON.parse(e.data);
                if (!items || items.length === 0) return;
                const now = Date.now();
                const cache = opportunityCacheRef.current;
                const newOpps = items.map(mapOpportunity);
                newOpps.forEach(opp => {
                    cache.set(opp.id, { opp, lastSeen: now });
                });
                // 每批都更新 UI（渐进式加载）
                const mergedOpps = Array.from(cache.values()).map(entry => entry.opp);
                mergedOpps.sort((a, b) => a.marketId - b.marketId);
                setOpportunities(mergedOpps);
            } catch (err) {
                console.error('Parse opportunity-batch error:', err);
            }
        });

        // 处理统计信息更新
        es.addEventListener('stats', (e) => {
            try {
                const data = JSON.parse(e.data);
                setStats({
                    makerCount: data.arbStats?.makerCount || 0,
                    takerCount: data.arbStats?.takerCount || 0,
                    avgProfit: data.arbStats?.avgProfit || 0,
                    maxProfit: data.arbStats?.maxProfit || 0,
                    totalDepthUsd: data.arbStats?.totalDepth || 0,
                    latency: {
                        predict: Math.round(data.latency?.predict || 0),
                        polymarket: Math.round(data.latency?.polymarket || 0),
                        compute: Math.round(data.refreshInterval || 0)
                    },
                    connectionStatus: data.connectionStatus || {}
                });

                // 更新策略分布
                const total = (data.arbStats?.makerCount || 0) + (data.arbStats?.takerCount || 0);
                if (total > 0) {
                    setChartData(prev => ({
                        ...prev,
                        strategyDistribution: {
                            maker: Math.round((data.arbStats.makerCount / total) * 100),
                            taker: Math.round((data.arbStats.takerCount / total) * 100)
                        }
                    }));
                }
            } catch (err) {
                console.error('Parse stats error:', err);
            }
        });

        // 处理账户信息更新
        es.addEventListener('accounts', (e) => {
            try {
                const data = JSON.parse(e.data);
                console.log('?? 收到账户数据:', data);
                setAccounts(data);
            } catch (err) {
                console.error('Parse accounts error:', err);
            }
        });

        // 处理市场列表更新
        es.addEventListener('markets', (e) => {
            try {
                const data = JSON.parse(e.data);
                console.log('?? 收到市场列表:', data.length, '个市场');
                setMarkets(data);
            } catch (err) {
                console.error('Parse markets error:', err);
            }
        });

        // 处理任务列表更新
        es.addEventListener('tasks', (e) => {
            try {
                const data = JSON.parse(e.data);
                console.log('?? 收到任务列表:', data.length, '个任务');
                setTasks(data);
            } catch (err) {
                console.error('Parse tasks error:', err);
            }
        });

        // 处理单个任务更新
        es.addEventListener('task', (e) => {
            try {
                const task = JSON.parse(e.data);
                console.log('?? 任务更新:', task.id, task.status);
                setTasks(prev => {
                    const idx = prev.findIndex(t => t.id === task.id);
                    if (idx >= 0) {
                        return [...prev.slice(0, idx), task, ...prev.slice(idx + 1)];
                    }
                    return [...prev, task];
                });
            } catch (err) {
                console.error('Parse task error:', err);
            }
        });

        // 处理任务删除
        es.addEventListener('taskDeleted', (e) => {
            try {
                const { id } = JSON.parse(e.data);
                console.log('??? 任务删除:', id);
                setTasks(prev => prev.filter(t => t.id !== id));
            } catch (err) {
                console.error('Parse taskDeleted error:', err);
            }
        });

        // 处理体育市场数据更新（增量推送）
        const sportsMapRef = { current: new Map() }; // Map<predictMarketId, market>

        es.addEventListener('sports', (e) => {
            try {
                const data = JSON.parse(e.data);

                if (data.snapshot) {
                    // 全量快照：完全替换
                    const newMap = new Map();
                    (data.updated || []).forEach(m => newMap.set(m.predictMarketId, m));
                    sportsMapRef.current = newMap;
                    console.log('⚽ 体育市场快照:', newMap.size, '场比赛');
                } else {
                    // 增量更新：merge updated, delete removed
                    const map = sportsMapRef.current;
                    (data.updated || []).forEach(m => map.set(m.predictMarketId, m));
                    (data.removed || []).forEach(id => map.delete(id));
                    if (data.updated?.length > 0 || data.removed?.length > 0) {
                        console.log(`⚽ 体育市场增量: +${data.updated?.length || 0} -${data.removed?.length || 0}, total=${map.size}`);
                    }
                }

                // 构造与原格式兼容的 sports 对象
                setSports({
                    markets: Array.from(sportsMapRef.current.values()),
                    stats: data.stats || { totalMatched: 0, withArbitrage: 0, avgProfit: 0, maxProfit: 0 },
                    lastUpdate: data.lastUpdate || Date.now(),
                });
            } catch (err) {
                console.error('Parse sports error:', err);
            }
        });

        // 处理平仓机会更新 (SSE 驱动，替代 REST 轮询)
        es.addEventListener('closeOpportunities', (e) => {
            try {
                const data = JSON.parse(e.data);
                setCloseOpportunities({ opportunities: data, lastUpdate: Date.now() });
            } catch (err) {
                console.error('Parse closeOpportunities error:', err);
            }
        });

        // 处理任务事件 (订单状态浮窗通知)
        es.addEventListener('taskEvent', (e) => {
            try {
                const event = JSON.parse(e.data);
                console.log('📋 任务事件:', event.type, event.taskId?.slice(0, 8));
                if (addOrderToast) {
                    addOrderToast(event);
                }
            } catch (err) {
                console.error('Parse taskEvent error:', err);
            }
        });

        // 处理敞口预警
        es.addEventListener('exposureAlert', (e) => {
            try {
                const alert = JSON.parse(e.data);
                console.warn('🚨 敞口预警:', alert.totalExposure, 'shares');
                setExposureAlert(alert);
            } catch (err) {
                console.error('Parse exposureAlert error:', err);
            }
        });
    }, [addNotification, addOrderToast]);

    useEffect(() => {
        // 连接 SSE 获取实时数据
        connectSSE();

        return () => {
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
            }
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
        };
    }, [connectSSE]);

    return { opportunities, history, chartData, stats, accounts, tasks, sports, closeOpportunities, isConnected, exposureAlert, setExposureAlert };
};

Preview.useArbScanner = useArbScanner;
Preview.API_BASE_URL = API_BASE_URL;
Preview.TASK_API_BASE_URL = TASK_API_BASE_URL;
