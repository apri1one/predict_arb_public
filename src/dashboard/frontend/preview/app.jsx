var Preview = window.Preview || (window.Preview = {});
var { useState, useEffect, useMemo, useRef, useCallback } = Preview.ReactHooks;
var { Icon } = Preview;
var { useNotifications, useArbScanner, API_BASE_URL, TASK_API_BASE_URL } = Preview;

// --- Main App ---
const App = () => {
    // 等待 Preview.Components 就绪 (Babel 异步编译 components.jsx)
    const [ready, setReady] = useState(!!Preview.Components?.OpportunityCard);
    useEffect(() => {
        if (ready) return;
        const timer = setInterval(() => {
            if (Preview.Components?.OpportunityCard) {
                setReady(true);
                clearInterval(timer);
            }
        }, 50);
        return () => clearInterval(timer);
    }, [ready]);

    const _C = Preview.Components || {};
    const {
        OpportunityCard, FilterBar, TasksTab, TaskModal, TaskLogModal,
        AutoTaskPreviewModal, NotificationToast, OrderToastContainer,
        SettingsPanel, AccountCard, HedgeTab, SportsCard,
        FootballThreeWayCardDemo, ExposureAlertBanner,
    } = _C;
    const useOrderToasts = _C.useOrderToasts || (() => ({ toasts: [], addOrderToast: () => {} }));

    const { notifications, settings, setSettings, addNotification, dismissNotification } = useNotifications();
    const { toasts: orderToasts, addOrderToast } = useOrderToasts();
    const { opportunities, stats, accounts, tasks, sports, closeOpportunities, isConnected, exposureAlert, setExposureAlert } = useArbScanner(addNotification, addOrderToast);
    const [taskModalOpen, setTaskModalOpen] = useState(false);
    const [taskModalData, setTaskModalData] = useState(null); // { opp, type: 'BUY' | 'SELL' }
    const [logModalOpen, setLogModalOpen] = useState(false);
    const [logModalTaskId, setLogModalTaskId] = useState(null);
    const [activeTab, setActiveTab] = useState('LIVE');
    const [allMarketsEnabled, setAllMarketsEnabled] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [filters, setFilters] = useState({ strategy: 'ALL', sortBy: 'PP_YIELD', searchQuery: '', minDepth: '100', onlyPp: false }); // 默认按 ID 排序，位置稳定
    const [isScanning, setIsScanning] = useState(false);
    const [isRefreshingAccounts, setIsRefreshingAccounts] = useState(false);
    const [autoPreviewOpen, setAutoPreviewOpen] = useState(false);
    const [autoPreviewLoadingMap, setAutoPreviewLoadingMap] = useState({});
    const [autoPreviewResultMap, setAutoPreviewResultMap] = useState({});
    const [autoPreviewErrorMap, setAutoPreviewErrorMap] = useState({});
    const [autoPreviewSource, setAutoPreviewSource] = useState('all');
    const [autoCreateLoadingMap, setAutoCreateLoadingMap] = useState({});
    const [autoCreateStatusMap, setAutoCreateStatusMap] = useState({});
    // 从 map 中派生当前 source 的值 (P. 和 M. 独立互不干扰)
    const autoPreviewLoading = autoPreviewLoadingMap[autoPreviewSource] || false;
    const autoPreviewResult = autoPreviewResultMap[autoPreviewSource] || null;
    const autoPreviewError = autoPreviewErrorMap[autoPreviewSource] || null;
    const autoCreateLoading = autoCreateLoadingMap[autoPreviewSource] || false;
    const autoCreateStatus = autoCreateStatusMap[autoPreviewSource] || null;
    const [batchCancelLoading, setBatchCancelLoading] = useState(false);
    const [batchCancelStatus, setBatchCancelStatus] = useState(null);
    const [ppFarmerStateMap, setPpFarmerStateMap] = useState({});
    const [ppFarmerLoadingMap, setPpFarmerLoadingMap] = useState({});
    const [ppFarmerNowTick, setPpFarmerNowTick] = useState(Date.now());
    // 用户输入的收益率阈值（×100 单位，提交时转回原始 yieldValue 值）
    const [ppFarmerYieldInputMap, setPpFarmerYieldInputMap] = useState({});
    const [ppFarmerBudgetInputMap, setPpFarmerBudgetInputMap] = useState({});
    const [ppRulesModalOpen, setPpRulesModalOpen] = useState(false);
    const [archiveList, setArchiveList] = useState([]);  // [{ marketId, title, archivedAt, reason? }]

    // 活跃任务数 (非终态)
    const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED', 'UNWIND_COMPLETED', 'TIMEOUT_CANCELLED'];
    const activeTaskCount = tasks.filter(t => !TERMINAL_STATUSES.includes(t.status)).length;

    // All 市场开关状态
    useEffect(() => {
        fetch(`${API_BASE_URL}/api/all-markets/status`)
            .then(r => r.json())
            .then(d => setAllMarketsEnabled(d.enabled))
            .catch(() => {});
    }, []);

    const toggleAllMarkets = async () => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/all-markets/toggle`, { method: 'POST' });
            const data = await res.json();
            if (data.success) setAllMarketsEnabled(data.enabled);
        } catch (err) {
            console.error('Toggle all markets failed:', err);
        }
    };

    // 刷新账户数据
    const handleRefreshAccounts = async () => {
        if (isRefreshingAccounts) return;

        setIsRefreshingAccounts(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/account/refresh`, { method: 'POST' });
            const data = await res.json();
            if (!data.success) {
                console.error('刷新账户失败:', data.error);
            }
        } catch (error) {
            console.error('刷新账户请求失败:', error.message);
        } finally {
            setIsRefreshingAccounts(false);
        }
    };

    // 触发市场重新扫描
    const handleRescan = async () => {
        if (isScanning) return;

        setIsScanning(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/rescan`, { method: 'POST' });
            if (res.ok) {
                // 扫描成功后刷新页面
                setTimeout(() => window.location.reload(), 2000);
            } else {
                alert('扫描失败,请查看后端日志');
                setIsScanning(false);
            }
        } catch (error) {
            alert('扫描请求失败: ' + error.message);
            setIsScanning(false);
        }
    };

    // 打开任务配置模态框
    const handleOpenTaskModal = useCallback((opp, type) => {
        setTaskModalData({ opp, type });
        setTaskModalOpen(true);
    }, []);

    // 关闭任务配置模态框
    const handleCloseTaskModal = () => {
        setTaskModalOpen(false);
        setTaskModalData(null);
    };

    // 创建任务
    const handleCreateTask = async (taskInput) => {
        try {
            const res = await fetch(`${TASK_API_BASE_URL}/api/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(taskInput),
            });
            const data = await res.json();
            if (data.success) {
                handleCloseTaskModal();
                setActiveTab('TASKS'); // 切换到任务标签页
            } else {
                alert('创建任务失败: ' + data.error);
            }
        } catch (error) {
            alert('创建任务失败: ' + error.message);
        }
    };

    // 创建体育市场 Taker 任务 (autoStart 一次请求完成)
    const handleCreateSportsTakerTask = async (taskParams) => {
        try {
            const createRes = await fetch(`${TASK_API_BASE_URL}/api/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...taskParams, autoStart: true }),
            });
            const createData = await createRes.json();

            if (!createData.success) {
                alert('创建任务失败: ' + createData.error);
                return;
            }

            if (!createData.started) {
                alert('启动任务失败: ' + (createData.startError || 'Unknown error'));
            }
        } catch (error) {
            alert('创建 Taker 任务失败: ' + error.message);
        }
    };

    const fetchAutoTaskPreview = useCallback(async (source = autoPreviewSource) => {
        if (autoPreviewLoadingMap[source]) return;

        setAutoPreviewLoadingMap(prev => ({ ...prev, [source]: true }));
        setAutoPreviewErrorMap(prev => ({ ...prev, [source]: null }));
        setAutoPreviewSource(source);
        try {
            const res = await fetch(`${TASK_API_BASE_URL}/api/tasks/auto-preview?source=${source}`);
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            setAutoPreviewResultMap(prev => ({ ...prev, [source]: data.data || null }));
        } catch (error) {
            setAutoPreviewErrorMap(prev => ({ ...prev, [source]: error.message || '自动任务预览请求失败' }));
        } finally {
            setAutoPreviewLoadingMap(prev => ({ ...prev, [source]: false }));
        }
    }, [autoPreviewLoadingMap, autoPreviewSource]);

    const fetchAutoCreateStatus = useCallback(async (source) => {
        const src = source || autoPreviewSource;
        try {
            const res = await fetch(`${TASK_API_BASE_URL}/api/tasks/auto-create?source=${encodeURIComponent(src)}`);
            const data = await res.json();
            if (res.ok && data.success) {
                setAutoCreateStatusMap(prev => ({ ...prev, [src]: data.data || null }));
            }
        } catch (error) {
            console.error('批量创建状态请求失败:', error.message || error);
        }
    }, [TASK_API_BASE_URL, autoPreviewSource]);

    const fetchBatchCancelStatus = useCallback(async () => {
        try {
            const res = await fetch(`${TASK_API_BASE_URL}/api/tasks/batch-cancel`);
            const data = await res.json();
            if (res.ok && data.success) {
                setBatchCancelStatus(data.data || null);
            }
        } catch (error) {
            console.error('批量取消状态请求失败:', error.message || error);
        }
    }, [TASK_API_BASE_URL]);

    const handleOpenAutoTaskPreview = useCallback((source) => {
        setAutoPreviewOpen(true);
        fetchAutoTaskPreview(source);
        fetchAutoCreateStatus(source);
    }, [fetchAutoTaskPreview, fetchAutoCreateStatus]);

    const handleCloseAutoTaskPreview = useCallback(() => {
        setAutoPreviewOpen(false);
    }, []);

    const handleAutoCreateTasks = useCallback(async () => {
        const currentSource = autoPreviewSource;
        const currentResult = autoPreviewResultMap[currentSource];
        if (autoCreateLoadingMap[currentSource] || !currentResult?.candidates?.length) return;

        setAutoCreateLoadingMap(prev => ({ ...prev, [currentSource]: true }));
        try {
            const res = await fetch(`${TASK_API_BASE_URL}/api/tasks/auto-create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    source: currentSource,
                    candidateIds: currentResult.candidates.map((item) => item.id),
                    autoStart: true,
                }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            setAutoCreateStatusMap(prev => ({ ...prev, [currentSource]: data.data || null }));
        } catch (error) {
            alert(`批量创建失败: ${error.message || error}`);
        } finally {
            setAutoCreateLoadingMap(prev => ({ ...prev, [currentSource]: false }));
        }
    }, [TASK_API_BASE_URL, autoCreateLoadingMap, autoPreviewResultMap, autoPreviewSource]);

    const handleAutoCreateControl = useCallback(async (action) => {
        const currentSource = autoPreviewSource;
        if (autoCreateLoadingMap[currentSource]) return;
        setAutoCreateLoadingMap(prev => ({ ...prev, [currentSource]: true }));
        try {
            const res = await fetch(`${TASK_API_BASE_URL}/api/tasks/auto-create/control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, source: currentSource }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            setAutoCreateStatusMap(prev => ({ ...prev, [currentSource]: data.data || null }));
        } catch (error) {
            alert(`批量创建控制失败: ${error.message || error}`);
        } finally {
            setAutoCreateLoadingMap(prev => ({ ...prev, [currentSource]: false }));
        }
    }, [TASK_API_BASE_URL, autoCreateLoadingMap, autoPreviewSource]);

    useEffect(() => {
        if (!autoPreviewOpen) return undefined;

        fetchAutoCreateStatus(autoPreviewSource);
        const timer = setInterval(() => fetchAutoCreateStatus(autoPreviewSource), 1000);
        return () => clearInterval(timer);
    }, [autoPreviewOpen, autoPreviewSource, fetchAutoCreateStatus]);

    const fetchPpFarmerStatus = useCallback(async (source) => {
        const sources = source ? [source] : ['all', 'sports'];
        await Promise.all(sources.map(async (src) => {
            try {
                const res = await fetch(`${TASK_API_BASE_URL}/api/pp-farmer/status?source=${src}`);
                const data = await res.json();
                if (data.success) {
                    setPpFarmerStateMap(prev => ({ ...prev, [src]: data.data }));
                }
            } catch (error) {
                console.error(`自动 PP (${src}) 状态请求失败:`, error.message || error);
            }
        }));
    }, [TASK_API_BASE_URL]);

    const handleTogglePpFarmer = useCallback(async (source) => {
        const src = source || 'all';
        if (ppFarmerLoadingMap[src]) return;
        setPpFarmerLoadingMap(prev => ({ ...prev, [src]: true }));
        try {
            const res = await fetch(`${TASK_API_BASE_URL}/api/pp-farmer/toggle?source=${src}`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
            setPpFarmerStateMap(prev => ({ ...prev, [src]: data.data }));
        } catch (error) {
            alert(`自动 PP (${src}) 切换失败: ${error.message || error}`);
        } finally {
            setPpFarmerLoadingMap(prev => ({ ...prev, [src]: false }));
        }
    }, [TASK_API_BASE_URL, ppFarmerLoadingMap]);

    const handleUpdatePpFarmerConfig = useCallback(async (source) => {
        const src = source || 'all';
        const tInputRaw = ppFarmerYieldInputMap[src] ?? '';
        const bInputRaw = ppFarmerBudgetInputMap[src] ?? '';
        const body = {};
        if (tInputRaw !== '') {
            // 输入框采用 ×100 显示单位（与卡片徽章一致），提交时除以 100 还原 yieldValue
            const inputNum = Number(tInputRaw);
            if (!Number.isFinite(inputNum) || inputNum < 0) {
                alert('收益率阈值必须是非负数字（×100 单位）');
                return;
            }
            body.yieldThreshold = inputNum / 100;
        }
        if (bInputRaw !== '') {
            const inputNum = Number(bInputRaw);
            if (!Number.isFinite(inputNum) || inputNum < 0 || inputNum > 50) {
                alert('单任务最大资金占用百分比需在 [0, 50] 之间');
                return;
            }
            body.budgetPoolRatio = inputNum / 100;
        }
        if (Object.keys(body).length === 0) return;
        try {
            const res = await fetch(`${TASK_API_BASE_URL}/api/pp-farmer/config?source=${src}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
            setPpFarmerStateMap(prev => ({ ...prev, [src]: data.data }));
        } catch (error) {
            alert(`自动 PP (${src}) 配置更新失败: ${error.message || error}`);
        }
    }, [TASK_API_BASE_URL, ppFarmerYieldInputMap, ppFarmerBudgetInputMap]);

    useEffect(() => {
        fetchPpFarmerStatus();
        const timer = setInterval(fetchPpFarmerStatus, 10000);
        return () => clearInterval(timer);
    }, [fetchPpFarmerStatus]);

    // 同步后端阈值/比例到输入框（threshold 用 ×100 单位）
    useEffect(() => {
        for (const src of ['all', 'sports']) {
            const cfg = ppFarmerStateMap[src]?.config;
            if (!cfg) continue;
            if (Number.isFinite(cfg.yieldThreshold)) {
                setPpFarmerYieldInputMap(prev => prev[src] === undefined || prev[src] === ''
                    ? { ...prev, [src]: String(cfg.yieldThreshold * 100) }
                    : prev);
            }
            if (Number.isFinite(cfg.budgetPoolRatio)) {
                setPpFarmerBudgetInputMap(prev => prev[src] === undefined || prev[src] === ''
                    ? { ...prev, [src]: String(Math.round(cfg.budgetPoolRatio * 100)) }
                    : prev);
            }
        }
    }, [ppFarmerStateMap.all?.config?.yieldThreshold, ppFarmerStateMap.all?.config?.budgetPoolRatio,
        ppFarmerStateMap.sports?.config?.yieldThreshold, ppFarmerStateMap.sports?.config?.budgetPoolRatio]);

    // 任一 runner 开启时每秒推进倒计时
    useEffect(() => {
        const anyEnabled = !!ppFarmerStateMap.all?.enabled || !!ppFarmerStateMap.sports?.enabled;
        if (!anyEnabled) return undefined;
        const timer = setInterval(() => setPpFarmerNowTick(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [ppFarmerStateMap.all?.enabled, ppFarmerStateMap.sports?.enabled]);

    // ===== Archive (排除清单) =====
    const fetchArchive = useCallback(async () => {
        try {
            const res = await fetch(`${TASK_API_BASE_URL}/api/pp-archive`);
            const data = await res.json();
            if (data.success) setArchiveList(Array.isArray(data.data) ? data.data : []);
        } catch {
            // silent
        }
    }, [TASK_API_BASE_URL]);

    useEffect(() => {
        fetchArchive();
        const timer = setInterval(fetchArchive, 30000);
        return () => clearInterval(timer);
    }, [fetchArchive]);

    const handleArchiveMarket = useCallback(async (marketId, title) => {
        try {
            const res = await fetch(`${TASK_API_BASE_URL}/api/pp-archive/add`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ marketId, title }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
            await fetchArchive();
        } catch (error) {
            alert(`归档失败: ${error.message || error}`);
        }
    }, [TASK_API_BASE_URL, fetchArchive]);

    const handleUnarchiveMarket = useCallback(async (marketId) => {
        try {
            const res = await fetch(`${TASK_API_BASE_URL}/api/pp-archive/remove`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ marketId }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
            await fetchArchive();
        } catch (error) {
            alert(`移出归档失败: ${error.message || error}`);
        }
    }, [TASK_API_BASE_URL, fetchArchive]);

    const archivedSet = useMemo(() => new Set(archiveList.map(e => e.marketId)), [archiveList]);


    useEffect(() => {
        if (activeTab !== 'TASKS') return undefined;

        fetchBatchCancelStatus();
        const timer = setInterval(fetchBatchCancelStatus, 1000);
        return () => clearInterval(timer);
    }, [activeTab, fetchBatchCancelStatus]);

    // 启动任务
    const handleStartTask = async (taskId) => {
        try {
            const res = await fetch(`${TASK_API_BASE_URL}/api/tasks/${taskId}/start`, { method: 'POST' });
            const data = await res.json();
            if (!data.success) {
                alert('启动任务失败: ' + data.error);
            }
        } catch (error) {
            alert('启动任务失败: ' + error.message);
        }
    };

    // 取消/删除任务
    const handleCancelTask = async (taskId) => {
        try {
            const res = await fetch(`${TASK_API_BASE_URL}/api/tasks/${taskId}`, { method: 'DELETE' });
            const data = await res.json();
            if (!data.success) {
                alert('操作失败: ' + data.error);
            }
        } catch (error) {
            alert('操作失败: ' + error.message);
        }
    };

    const handleCancelAllTasks = useCallback(async () => {
        if (batchCancelLoading) return;

        const activeTaskIds = tasks
            .filter(task => !['COMPLETED', 'FAILED', 'CANCELLED', 'UNWIND_COMPLETED'].includes(task.status))
            .map(task => task.id);

        if (activeTaskIds.length === 0) {
            alert('当前没有可取消的活跃任务');
            return;
        }

        if (!window.confirm(`确认按 1 秒 1 个任务的节奏取消全部 ${activeTaskIds.length} 个活跃任务吗？`)) {
            return;
        }

        setBatchCancelLoading(true);
        try {
            const res = await fetch(`${TASK_API_BASE_URL}/api/tasks/batch-cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskIds: activeTaskIds }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            setBatchCancelStatus(data.data || null);
        } catch (error) {
            alert(`批量取消失败: ${error.message || error}`);
        } finally {
            setBatchCancelLoading(false);
        }
    }, [TASK_API_BASE_URL, batchCancelLoading, tasks]);

    const handleBatchCancelControl = useCallback(async (action) => {
        if (batchCancelLoading) return;

        setBatchCancelLoading(true);
        try {
            const res = await fetch(`${TASK_API_BASE_URL}/api/tasks/batch-cancel/control`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.error || `HTTP ${res.status}`);
            }
            setBatchCancelStatus(data.data || null);
        } catch (error) {
            alert(`批量取消控制失败: ${error.message || error}`);
        } finally {
            setBatchCancelLoading(false);
        }
    }, [TASK_API_BASE_URL, batchCancelLoading]);

    // 查看任务日志
    const handleViewLogs = (taskId) => {
        setLogModalTaskId(taskId);
        setLogModalOpen(true);
    };

    // 关闭日志弹窗
    const handleCloseLogModal = () => {
        setLogModalOpen(false);
        setLogModalTaskId(null);
    };

    // Shared expansion state for Account Cards
    const [accountsExpanded, setAccountsExpanded] = useState(false);

    // 从 SSE 获取的账户数据
    const predictAccount = {
        balance: {
            total: accounts.predict?.total || 0,
            available: accounts.predict?.available || 0,
            portfolio: accounts.predict?.portfolio || 0
        },
        positions: accounts.predict?.positions || [],
        openOrders: accounts.predict?.openOrders || []
    };

    const polymarketAccount = {
        balance: {
            total: accounts.polymarket?.total || 0,
            available: accounts.polymarket?.available || 0,
            portfolio: accounts.polymarket?.portfolio || 0
        },
        positions: accounts.polymarket?.positions || [],
        openOrders: accounts.polymarket?.openOrders || []
    };

    // 调试:检查账户数据
    useEffect(() => {
        console.log('💰 账户状态更新:', { predictAccount, polymarketAccount, rawAccounts: accounts });
    }, [accounts]);

    const activeAutoPreviewSource = activeTab === 'SPORTS'
        ? 'sports'
        : activeTab === 'LIVE'
            ? 'all'
            : null;

    // 体育市场索引：用于 Live 面板识别“对阵事件”并按赛事去重
    const sportsEventMeta = useMemo(() => {
        const markets = Array.isArray(sports.markets) ? sports.markets : [];
        const sportsPredictIdToEventKey = new Map();

        const normalizeText = (value) => String(value || '').trim().toLowerCase();
        const normalizeConditionId = (value) => String(value || '').trim();
        const buildFallbackEventKey = (market) => {
            const away = normalizeText(market.awayTeam);
            const home = normalizeText(market.homeTeam);
            const start = normalizeText(market.gameStartTime);
            return `teams:${away}|${home}|${start}`;
        };
        const isHeadToHeadEvent = (market) => {
            const away = normalizeText(market.awayTeam);
            const home = normalizeText(market.homeTeam);
            return away && home && away !== home;
        };

        for (const market of markets) {
            // 仅收录“对阵事件”，冠军盘/多选事件不参与 Live 去重
            if (!isHeadToHeadEvent(market)) continue;
            const conditionId = normalizeConditionId(market.polymarketConditionId);
            const eventKey = conditionId ? `cond:${conditionId}` : buildFallbackEventKey(market);

            [market.predictMarketId, market.predictAwayMarketId, market.predictHomeMarketId].forEach((predictId) => {
                if (Number.isFinite(predictId)) {
                    sportsPredictIdToEventKey.set(predictId, eventKey);
                }
            });
        }

        return { sportsPredictIdToEventKey };
    }, [sports.markets]);

    // Sports 面板渲染项：
    // 1) 足球三项盘（teamA/draw/teamB）合并为单卡
    // 2) 其他市场保持单卡
    const sportsRenderItems = useMemo(() => {
        const rawMarkets = Array.isArray(sports.markets) ? sports.markets : [];
        const markets = filters.onlyPp
            ? rawMarkets.filter((m) => (m.pointsHourlyRate || 0) > 0)
            : rawMarkets;
        const grouped = new Map();
        const items = [];

        markets.forEach((market, index) => {
            const eventKey = String(market.eventKey || '').trim();
            if (market.isThreeWayEvent && eventKey) {
                if (!grouped.has(eventKey)) {
                    grouped.set(eventKey, {
                        index,
                        eventTitle: market.eventTitle || market.predictTitle,
                        markets: [],
                    });
                }
                const entry = grouped.get(eventKey);
                entry.markets.push(market);
                entry.index = Math.min(entry.index, index);
                if (!entry.eventTitle && market.eventTitle) entry.eventTitle = market.eventTitle;
                return;
            }

            items.push({
                type: 'single',
                key: `single-${market.predictMarketId}-${market.polymarketConditionId}`,
                market,
                index,
                sortTime: market.gameStartTime ? new Date(market.gameStartTime).getTime() : NaN,
            });
        });

        for (const [eventKey, entry] of grouped) {
            const byKind = { teamA: null, draw: null, teamB: null, match: null, game1: null, game2: null };
            entry.markets.forEach((market) => {
                const kind = market.selectionKind;
                if (byKind.hasOwnProperty(kind) && !byKind[kind]) {
                    byKind[kind] = market;
                }
            });

            const startTimes = entry.markets
                .map(m => m.gameStartTime ? new Date(m.gameStartTime).getTime() : NaN)
                .filter(Number.isFinite);
            const sortTime = startTimes.length > 0 ? Math.min(...startTimes) : NaN;

            const isFootballTriple = byKind.teamA && byKind.draw && byKind.teamB;
            const isEsportsTriple = byKind.match && byKind.game1 && byKind.game2;
            if (isFootballTriple || isEsportsTriple) {
                items.push({
                    type: 'football-three-way',
                    key: `threeway-${eventKey}`,
                    eventTitle: entry.eventTitle,
                    marketsByKind: byKind,
                    index: entry.index,
                    sortTime,
                });
            } else {
                entry.markets.forEach((market, idx) => {
                    items.push({
                        type: 'single',
                        key: `fallback-${eventKey}-${market.predictMarketId}-${market.polymarketConditionId}`,
                        market,
                        index: entry.index + idx / 1000,
                        sortTime: market.gameStartTime ? new Date(market.gameStartTime).getTime() : NaN,
                    });
                });
            }
        }

        return items.sort((a, b) => {
            const aHasStart = Number.isFinite(a.sortTime);
            const bHasStart = Number.isFinite(b.sortTime);
            if (aHasStart && bHasStart && a.sortTime !== b.sortTime) return a.sortTime - b.sortTime;
            if (aHasStart !== bHasStart) return aHasStart ? -1 : 1;
            return a.index - b.index;
        });
    }, [sports.markets, filters.onlyPp]);

    const filteredOpps = useMemo(() => {
        let result = [...opportunities];
        if (filters.strategy !== 'ALL') result = result.filter(o => o.strategy === filters.strategy);
        // 默认过滤: taker total < 10¢ 且 最大可套利深度 = 0
        result = result.filter(o => (o.takerCost || 0) >= 10 && (o.maxQuantity || 0) > 0);
        // 可吃深度下限过滤
        if (filters.minDepth !== '' && Number(filters.minDepth) > 0) {
            const min = Number(filters.minDepth);
            result = result.filter(o => (o.maxQuantity || 0) >= min);
        }
        // 搜索过滤
        if (filters.searchQuery) {
            const q = filters.searchQuery.toLowerCase();
            result = result.filter(o => (o.title || '').toLowerCase().includes(q));
        }
        // 仅显示有 PP 奖励的市场
        if (filters.onlyPp) {
            result = result.filter(o => (o.pointsHourlyRate || 0) > 0);
        }
        // 排除归档市场
        if (archivedSet.size > 0) {
            result = result.filter(o => !archivedSet.has(o.marketId));
        }

        // Live 面板中体育事件去重：同一赛事只保留“最佳”机会卡片
        const pickBetterSportsOpp = (nextOpp, currentOpp) => {
            if ((nextOpp.estimatedProfit || 0) !== (currentOpp.estimatedProfit || 0)) {
                return (nextOpp.estimatedProfit || 0) > (currentOpp.estimatedProfit || 0);
            }
            if ((nextOpp.profitPercent || 0) !== (currentOpp.profitPercent || 0)) {
                return (nextOpp.profitPercent || 0) > (currentOpp.profitPercent || 0);
            }
            if ((nextOpp.maxQuantity || 0) !== (currentOpp.maxQuantity || 0)) {
                return (nextOpp.maxQuantity || 0) > (currentOpp.maxQuantity || 0);
            }
            if ((nextOpp.lastUpdate || 0) !== (currentOpp.lastUpdate || 0)) {
                return (nextOpp.lastUpdate || 0) > (currentOpp.lastUpdate || 0);
            }
            return (nextOpp.marketId || 0) < (currentOpp.marketId || 0);
        };

        // All 面板不显示体育对阵事件（体育市场仅支持 REST，不适合 WS 驱动的面板）
        // 1. 已被 sports-service 匹配的市场
        // 2. 标题含 " vs " 的对阵市场（如 LoL/MMA 等未被匹配的赛事）
        result = result.filter(opp =>
            !sportsEventMeta.sportsPredictIdToEventKey.has(opp.marketId) &&
            !(opp.title && / vs\.? /i.test(opp.title))
        );

        result.sort((a, b) => {
            if (filters.sortBy === 'PROFIT') return b.estimatedProfit - a.estimatedProfit;
            if (filters.sortBy === 'PROFIT_PCT') return b.profitPercent - a.profitPercent;
            if (filters.sortBy === 'TIME') return b.lastUpdate - a.lastUpdate;
            if (filters.sortBy === 'SETTLEMENT') {
                // 按结算时间升序 (最早结算的在前面)
                const aEnd = a.endDate ? new Date(a.endDate).getTime() : Infinity;
                const bEnd = b.endDate ? new Date(b.endDate).getTime() : Infinity;
                return aEnd - bEnd;
            }
            if (filters.sortBy === 'DEPTH') return (b.depth.predict + b.depth.polymarket) - (a.depth.predict + a.depth.polymarket);
            if (filters.sortBy === 'PP_YIELD') {
                // 收益率越大越好挂（PP/hr 高 + 深度低）；无 reward 排到末尾
                const aDiff = Number.isFinite(a.pointsYield) ? a.pointsYield : -Infinity;
                const bDiff = Number.isFinite(b.pointsYield) ? b.pointsYield : -Infinity;
                return bDiff - aDiff;
            }
            if (filters.sortBy === 'ID') return a.marketId - b.marketId; // 按 ID 排序，位置稳定
            return 0;
        });
        return result;
    }, [opportunities, filters, sportsEventMeta, archivedSet]);

    if (!ready) {
        return (
            <div className="min-h-screen flex items-center justify-center">
                <div className="text-[#8B847A] text-sm">Loading...</div>
            </div>
        );
    }

    return (
        <div className="min-h-screen font-sans selection:bg-[#D97757] selection:text-[#1A1915] pb-20">

            {/* Order Toast Container (左上角订单状态浮窗) */}
            <OrderToastContainer toasts={orderToasts} />

            {/* 敞口预警 Banner (顶部居中，常驻) */}
            <ExposureAlertBanner alert={exposureAlert} onDismiss={() => {
                const taskIds = Array.isArray(exposureAlert?.tasks)
                    ? exposureAlert.tasks.map(task => task?.id).filter(Boolean)
                    : [];
                setExposureAlert(null);
                fetch(`${Preview.API_BASE_URL}/api/exposure/dismiss`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ taskIds }),
                }).catch(() => {});
            }} />

            {/* Settings Panel */}
            <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} setSettings={setSettings} />

            {/* Header */}
            <header className="fixed top-0 left-0 right-0 h-16 bg-white/70 backdrop-blur-md backdrop-blur-md border-b border-black/5 z-40">
                <div className="max-w-7xl mx-auto px-6 h-full flex items-center justify-between">
                    <div className="flex items-center gap-10">
                        <div className="flex items-center gap-4">
                            <div className="w-8 h-8 rounded-lg bg-[#D97757]/10 border border-[#D97757]/20 flex items-center justify-center shadow-glow-sm">
                                <Icon name="radar" size={18} className="text-[#B85A3F]" strokeWidth={2} />
                            </div>
                            <div>
                                <h1 className="font-display font-semibold text-lg tracking-tight text-[#1A1915] leading-none">Arb<span className="text-[#8B847A]">Scanner</span></h1>
                                <div className="flex items-center gap-2 text-[9px] font-medium tracking-wide uppercase text-[#8B847A] mt-1">
                                    <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-[#D97757] shadow-[0_0_8px_rgba(217,119,87,0.55)]' : 'bg-rose-500'}`}></span>
                                    {isConnected ? 'Online' : 'Reconnecting...'}
                                </div>
                            </div>
                        </div>

                        {/* Separated & Enlarged Network Status */}
                        <div className="hidden lg:flex items-center gap-6 border-l border-black/5 pl-8">
                            {/* Polymarket Status */}
                            <div className="flex flex-col gap-1.5 min-w-[100px]">
                                <div className="flex items-center justify-between text-[11px] font-medium leading-none">
                                    <span className="flex items-center gap-1.5 text-[#6B665C]">
                                        <span className={`w-1.5 h-1.5 rounded-full ${
                                            stats.connectionStatus?.polymarketWs === 'connected' ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]'
                                            : stats.connectionStatus?.polymarketWs === 'reconnecting' ? 'bg-[#C7654A] animate-pulse'
                                            : 'bg-rose-500'
                                        }`}></span>
                                        Polymarket
                                    </span>
                                    <span className={`font-mono ${stats.latency.polymarket < 1000 ? 'text-[#1A1915]' : stats.latency.polymarket < 5000 ? 'text-[#C7654A]' : 'text-rose-400'}`}>
                                        {stats.latency.polymarket >= 1000 ? `${(stats.latency.polymarket / 1000).toFixed(1)}s` : `${stats.latency.polymarket}ms`}
                                    </span>
                                </div>
                                <div className="h-1.5 w-full bg-white/65 rounded-full overflow-hidden">
                                    <div
                                        className={`h-full ${stats.latency.polymarket < 1000 ? 'bg-emerald-500' : stats.latency.polymarket < 5000 ? 'bg-[#D97757]' : 'bg-rose-500'} rounded-full transition-all duration-300`}
                                        style={{ width: `${Math.min(100, stats.latency.polymarket / 50)}%` }}
                                    />
                                </div>
                            </div>

                            {/* Predict Status */}
                            <div className="flex flex-col gap-1.5 min-w-[100px]">
                                <div className="flex items-center justify-between text-[11px] font-medium leading-none">
                                    <span className="flex items-center gap-1.5 text-[#6B665C]">
                                        <span className={`w-1.5 h-1.5 rounded-full ${
                                            stats.connectionStatus?.predictWs === 'connected' ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]'
                                            : 'bg-rose-500'
                                        }`}></span>
                                        Predict
                                    </span>
                                    <span className={`font-mono ${stats.latency.predict < 1000 ? 'text-[#1A1915]' : stats.latency.predict < 5000 ? 'text-[#C7654A]' : 'text-rose-400'}`}>
                                        {stats.latency.predict >= 1000 ? `${(stats.latency.predict / 1000).toFixed(1)}s` : `${stats.latency.predict}ms`}
                                    </span>
                                </div>
                                <div className="h-1.5 w-full bg-white/65 rounded-full overflow-hidden">
                                    <div
                                        className={`h-full ${stats.latency.predict < 1000 ? 'bg-emerald-500' : stats.latency.predict < 5000 ? 'bg-[#D97757]' : 'bg-rose-500'} rounded-full transition-all duration-300`}
                                        style={{ width: `${Math.min(100, stats.latency.predict / 50)}%` }}
                                    />
                                </div>
                            </div>

                            {/* BSC WSS Status */}
                            <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#6B665C]">
                                <span className={`w-1.5 h-1.5 rounded-full ${
                                    stats.connectionStatus?.bscWss === 'connected' ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]'
                                    : 'bg-rose-500'
                                }`}></span>
                                BSC
                            </div>

                            {/* Sports WS Orderbook Status */}
                            {stats.sportsWs && (
                                <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#6B665C]" title={`Tokens: ${stats.sportsWs.subscribedTokens} | Updates: ${stats.sportsWs.updateCount} | ${stats.sportsWs.updatesPerSecond}/s`}>
                                    <span className={`w-1.5 h-1.5 rounded-full ${
                                        stats.sportsWs.connected ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]'
                                        : 'bg-rose-500'
                                    }`}></span>
                                    <span>Sports</span>
                                    <span className="font-mono text-[10px] text-[#8B847A]">{stats.sportsWs.subscribedTokens}t {stats.sportsWs.updatesPerSecond}/s</span>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center gap-6">
                        <button
                            onClick={() => setFilters((prev) => ({ ...prev, onlyPp: !prev.onlyPp }))}
                            title="仅显示有 PP 奖励的市场（同时影响 Live 与 Sports 两个面板）"
                            className={`hidden md:flex items-center justify-center gap-2 px-4 py-2 rounded-lg border-2 text-sm font-bold tracking-wide transition-all min-w-[150px] ${
                                filters.onlyPp
                                    ? 'bg-[#D97757] text-[#1A1915] border-[#1A1915]/40 shadow-[0_2px_8px_rgba(217,119,87,0.45)]'
                                    : 'bg-[#F5C7A8] text-[#1A1915] border-[#D97757]/50 hover:bg-[#EDB58F] hover:border-[#D97757]/70'
                            }`}>
                            <Icon name={filters.onlyPp ? 'zap' : 'zap-off'} size={14} />
                            <span>仅看有 PP 市场</span>
                        </button>
                        <div className="hidden md:flex items-center gap-1 text-[10px] font-mono text-[#8B847A] bg-white/55 backdrop-blur-xl px-2 py-1 rounded border border-black/[0.08]">
                            <Icon name="clock" size={10} />
                            <span>{new Date().toLocaleTimeString()}</span>
                        </div>
                        <div className="h-6 w-px bg-white/65"></div>
                        <button className="relative text-[#8B847A] hover:text-[#1A1915] transition-colors">
                            <Icon name="bell" size={18} />
                            {notifications.length > 0 && (
                                <span className="absolute -top-1 -right-1 w-4 h-4 bg-rose-500 rounded-full border-2 border-[#EFE9DF] text-[9px] font-bold text-[#1A1915] flex items-center justify-center">
                                    {notifications.length}
                                </span>
                            )}
                        </button>
                        <button onClick={() => setSettingsOpen(true)} className="text-[#8B847A] hover:text-[#1A1915] transition-colors">
                            <Icon name="settings" size={18} />
                        </button>
                    </div>
                </div>
            </header>

            <main className="max-w-7xl mx-auto px-4 md:px-6 pt-24">
                {/* Top Row: Account Cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                    <AccountCard
                        platform="Predict.fun"
                        balance={predictAccount.balance}
                        positions={predictAccount.positions}
                        openOrders={predictAccount.openOrders}
                        icon="predict"
                        color="bg-blue-600"
                        expanded={accountsExpanded}
                        onToggle={() => setAccountsExpanded(!accountsExpanded)}
                        onRefresh={handleRefreshAccounts}
                        refreshing={isRefreshingAccounts}
                    />
                    <AccountCard
                        platform="Polymarket"
                        balance={polymarketAccount.balance}
                        positions={polymarketAccount.positions}
                        openOrders={polymarketAccount.openOrders}
                        icon="polymarket"
                        color="bg-purple-600"
                        expanded={accountsExpanded}
                        onToggle={() => setAccountsExpanded(!accountsExpanded)}
                        onRefresh={handleRefreshAccounts}
                        refreshing={isRefreshingAccounts}
                    />
                </div>

                {/* Tabs */}
                <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4 mb-6 border-b border-black/5">
                    <div className="flex gap-6 overflow-x-auto">
                        {['LIVE', 'SPORTS', 'TASKS', 'CLOSE', 'ARCHIVE'].map((tab) => (
                            <span key={tab} className="flex items-center gap-1">
                                <button onClick={() => setActiveTab(tab)}
                                    className={`pb-3 text-sm font-medium tracking-wide transition-all relative whitespace-nowrap ${activeTab === tab ? 'text-[#B85A3F]' : 'text-[#8B847A] hover:text-[#1A1915]'}`}>
                                    {tab === 'CLOSE' ? '平仓' : tab === 'SPORTS' ? '体育' : tab === 'LIVE' ? '全部' : tab === 'ARCHIVE' ? '归档' : tab === 'TASKS' ? '任务' : tab}
                                    {tab === 'TASKS' && activeTaskCount > 0 && (
                                        <span className="absolute -top-1 -right-5 min-w-[18px] h-[18px] flex items-center justify-center px-1 text-[10px] font-bold rounded-full bg-[#D97757] text-[#1A1915] leading-none">{activeTaskCount}</span>
                                    )}
                                    {activeTab === tab && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#D97757] shadow-glow-sm"></div>}
                                </button>
                                {tab === 'LIVE' && (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); toggleAllMarkets(); }}
                                        className={`mb-1 px-1.5 py-0.5 text-[10px] rounded font-medium transition-colors ${
                                            allMarketsEnabled
                                                ? 'bg-emerald-900/50 text-[#1A1915] hover:bg-emerald-800/50'
                                                : 'bg-white/65 text-[#8B847A] hover:bg-white/75'
                                        }`}
                                        title={allMarketsEnabled ? '点击关闭 All 市场监控' : '点击开启 All 市场监控'}
                                    >
                                        {allMarketsEnabled ? 'ON' : 'OFF'}
                                    </button>
                                )}
                            </span>
                        ))}
                    </div>
                    {activeAutoPreviewSource && (
                        <div className="pb-3 flex gap-2">
                            {(() => {
                                const ppSource = activeAutoPreviewSource;
                                const ppState = ppFarmerStateMap[ppSource] || null;
                                const ppLoading = !!ppFarmerLoadingMap[ppSource];
                                const tInputVal = ppFarmerYieldInputMap[ppSource] ?? '';
                                const bInputVal = ppFarmerBudgetInputMap[ppSource] ?? '';
                                const farmEnabled = !!ppState?.enabled;
                                const farmBusy = !!ppState?.busy;
                                const last = ppState?.lastSummary;
                                const lastRunAt = ppState?.lastRunAt;
                                const nextRunAt = ppState?.nextRunAt;
                                const remainMs = farmEnabled && nextRunAt ? Math.max(0, nextRunAt - ppFarmerNowTick) : 0;
                                const remainMin = Math.floor(remainMs / 60000);
                                const remainSec = Math.floor((remainMs % 60000) / 1000);
                                const countdown = farmEnabled && nextRunAt
                                    ? `${String(remainMin).padStart(2, '0')}:${String(remainSec).padStart(2, '0')}`
                                    : '';
                                const thresholdX100 = ((ppState?.config?.yieldThreshold ?? 0) * 100).toFixed(2);
                                const budgetPct = ((ppState?.config?.budgetPoolRatio ?? 0) * 100).toFixed(0);
                                const sourceLabel = ppSource === 'sports' ? '仅体育' : '仅非体育';
                                const tooltipLines = [
                                    `Tab: ${sourceLabel}`,
                                    farmEnabled ? `已开启 · 每 5 分钟自动挂 PP 收益率≥${thresholdX100} 的市场 · 资金池 ${budgetPct}%` : '已关闭',
                                    farmBusy ? '轮询进行中…' : '',
                                    lastRunAt ? `上次运行: ${new Date(lastRunAt).toLocaleTimeString()}` : '',
                                    last ? `候选 ${last.qualified} · 创建 ${last.createdCount} · 失败 ${last.failedCount} · 池 $${last.poolUsdc?.toFixed?.(2) ?? '-'}` : '',
                                    farmEnabled && nextRunAt ? `下次: ${new Date(nextRunAt).toLocaleTimeString()}` : '',
                                ].filter(Boolean);
                                const buttonClass = farmEnabled
                                    ? 'border-[#D97757]/45 bg-[#D97757]/10 text-[#C7654A] hover:bg-[#D97757]/15 shadow-[0_1px_3px_rgba(217,119,87,0.18)]'
                                    : 'border-black/10 bg-white text-[#6B665C] hover:bg-[#FAF6EE] shadow-[0_1px_3px_rgba(60,50,40,0.08)]';
                                return (
                                    <>
                                    <button
                                        onClick={() => handleTogglePpFarmer(ppSource)}
                                        disabled={ppLoading}
                                        title={tooltipLines.join('\n')}
                                        className={`px-4 py-2 rounded-lg border ${buttonClass} text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2`}>
                                        <Icon name={farmEnabled ? 'zap' : 'zap-off'} size={16} />
                                        {ppLoading
                                            ? '切换中...'
                                            : farmEnabled
                                                ? `自动 PP (${sourceLabel}) · ON${farmBusy ? ' ·运行中' : ''}`
                                                : `自动 PP (${sourceLabel}) · OFF`}
                                        {farmEnabled && countdown ? (
                                            <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-white border border-black/10 text-[#1A1915]">
                                                {farmBusy ? '…' : countdown}
                                            </span>
                                        ) : null}
                                        {farmEnabled && last ? (
                                            <span className="text-[10px] font-mono opacity-70">
                                                +{last.createdCount}
                                            </span>
                                        ) : null}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setPpRulesModalOpen(true)}
                                        title="查看 自动 PP 的筛选规则与默认设置"
                                        className="px-2.5 py-2 rounded-lg border border-black/10 bg-white text-[#8B847A] hover:text-[#1A1915] hover:bg-[#FAF6EE] shadow-[0_1px_3px_rgba(60,50,40,0.08)] transition-colors flex items-center gap-1 text-xs font-medium">
                                        <Icon name="info" size={14} />
                                        <span>规则</span>
                                    </button>
                                    <div className="flex items-center gap-1 px-2 py-1 rounded-lg border border-black/10 bg-white shadow-[0_1px_3px_rgba(60,50,40,0.08)] text-xs">
                                        <span className="text-[#8B847A]">收益率≥</span>
                                        <input
                                            type="number"
                                            step="0.01"
                                            min="0"
                                            value={tInputVal}
                                            onChange={(e) => setPpFarmerYieldInputMap(prev => ({ ...prev, [ppSource]: e.target.value }))}
                                            placeholder="0.10"
                                            title="挂大于等于此收益率（×100 单位，与卡片徽章一致）的市场"
                                            className="w-16 bg-transparent border-none outline-none text-[#1A1915] placeholder-[#A39C8E] text-xs [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                        />
                                        <span className="text-[#8B847A] ml-2">每单上限</span>
                                        <input
                                            type="number"
                                            step="5"
                                            min="0"
                                            max="50"
                                            value={bInputVal}
                                            onChange={(e) => setPpFarmerBudgetInputMap(prev => ({ ...prev, [ppSource]: e.target.value }))}
                                            placeholder="50"
                                            title="单任务最大资金占用百分比 [0%, 50%]，例如 25 表示 min(predict, poly) × 25% 作为每单上限"
                                            className="w-12 bg-transparent border-none outline-none text-[#1A1915] placeholder-[#A39C8E] text-xs [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                        />
                                        <span className="text-[#8B847A]">%</span>
                                        <button
                                            onClick={() => handleUpdatePpFarmerConfig(ppSource)}
                                            className="ml-1 px-2 py-0.5 rounded bg-yellow-400 hover:bg-yellow-300 text-[#1A1915] text-xs font-semibold"
                                            title="保存配置（收益率阈值 / 资金池占比）">
                                            确定
                                        </button>
                                    </div>
                                    </>
                                );
                            })()}
                            <button
                                onClick={() => handleOpenAutoTaskPreview(activeAutoPreviewSource)}
                                disabled={autoPreviewLoadingMap[activeAutoPreviewSource]}
                                className={`px-4 py-2 rounded-lg border text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 ${
                                    activeAutoPreviewSource === 'all'
                                        ? 'bg-[#1A1915] text-white border-[#1A1915] hover:bg-[#2A2520] shadow-[0_1px_3px_rgba(60,50,40,0.12)]'
                                        : 'bg-white text-[#1A1915] border-black/10 hover:bg-[#FAF6EE] shadow-[0_1px_3px_rgba(60,50,40,0.08)]'
                                }`}>
                                <Icon name="list" size={16} />
                                {autoPreviewLoadingMap[activeAutoPreviewSource]
                                    ? '计算中...'
                                    : activeAutoPreviewSource === 'sports'
                                        ? '输出 P. 待创建任务'
                                        : '输出 All 待创建任务'}
                            </button>
                            {activeAutoPreviewSource === 'sports' && (
                                <button
                                    onClick={() => handleOpenAutoTaskPreview('poly-maker')}
                                    disabled={autoPreviewLoadingMap['poly-maker']}
                                    className="px-4 py-2 rounded-lg border border-black/10 bg-white text-[#1A1915] text-sm font-medium hover:bg-[#FAF6EE] shadow-[0_1px_3px_rgba(60,50,40,0.08)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
                                    <Icon name="list" size={16} />
                                    {autoPreviewLoadingMap['poly-maker'] ? '计算中...' : '输出 M. 待创建任务'}
                                </button>
                            )}
                        </div>
                    )}
                </div>

                <div key={activeTab} className="animate-tab-in">
                {activeTab === 'CLOSE' ? (
                    <HedgeTab onSwitchToTasks={() => setActiveTab('TASKS')} tasks={tasks} sseData={closeOpportunities} />
                ) : activeTab === 'SPORTS' ? (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between mb-4 px-1">
                            <h3 className="font-display text-sm font-medium text-[#1A1915] flex items-center gap-2">
                                <Icon name="activity" size={16} className="text-[#B85A3F]" />
                                体育市场套利
                            </h3>
                            <div className="text-xs text-[#8B847A] font-mono">
                                {sports.stats?.withArbitrage || 0} / {sports.stats?.totalMatched || 0} 场有套利
                            </div>
                        </div>
                        {sportsRenderItems.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-32 rounded-2xl border border-dashed border-black/[0.08] bg-white/35 backdrop-blur-md">
                                {isConnected ? (
                                    <>
                                        <Icon name="search" size={48} className="text-[#B85A3F] opacity-80 mb-6" strokeWidth={1} />
                                        <p className="font-display text-xl text-[#1A1915] mb-2">暂无体育市场</p>
                                        <p className="text-sm text-[#8B847A]">正在扫描匹配的体育赛事...</p>
                                    </>
                                ) : (
                                    <>
                                        <Icon name="refresh-cw" size={48} className="text-[#B85A3F] animate-spin opacity-50 mb-6" strokeWidth={1} />
                                        <p className="font-display text-lg text-[#1A1915]">正在连接...</p>
                                    </>
                                )}
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {sportsRenderItems.map((item) => {
                                    if (item.type === 'football-three-way') {
                                        return (
                                            <FootballThreeWayCardDemo
                                                key={item.key}
                                                eventTitle={item.eventTitle}
                                                marketsByKind={item.marketsByKind}
                                                onOpenTaskModal={handleOpenTaskModal}
                                                onCreateTakerTask={handleCreateSportsTakerTask}
                                                onCancelTask={handleCancelTask}
                                                accounts={accounts}
                                                tasks={tasks}
                                            />
                                        );
                                    }

                                    const market = item.market;
                                    return (
                                        <SportsCard
                                            key={item.key}
                                            market={market}
                                            onOpenTaskModal={handleOpenTaskModal}
                                            onCreateTakerTask={handleCreateSportsTakerTask}
                                            onCancelTask={handleCancelTask}
                                            accounts={accounts}
                                            tasks={tasks}
                                        />
                                    );
                                })}
                            </div>
                        )}
                    </div>
                ) : activeTab === 'MARKETS' ? (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between mb-4 px-1">
                            <h3 className="font-display text-sm font-medium text-[#1A1915] flex items-center gap-2">
                                <Icon name="list" size={16} className="text-[#B85A3F]" />
                                监控市场列表
                            </h3>
                            <div className="text-xs text-[#8B847A] font-mono">{markets.length} 个市场</div>
                        </div>
                        {markets.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-32 rounded-2xl border border-dashed border-black/[0.08] bg-white/35 backdrop-blur-md">
                                <Icon name="inbox" size={48} className="text-[#A39C8E] mb-6" strokeWidth={1} />
                                <p className="font-display text-lg text-[#6B665C]">暂无市场数据</p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {markets.map((m, idx) => (
                                    <div key={`${m.predictId}-${idx}`} className="glass-card rounded-xl p-4 border border-black/5 hover:border-black/[0.08] transition-all">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <span className="text-xs font-mono text-[#8B847A]">ID {m.predictId}</span>
                                                    {m.predictTitle !== m.predictQuestion && (
                                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 border border-blue-500/20 text-blue-400 font-medium">{m.predictTitle}</span>
                                                    )}
                                                    {m.isInverted && (
                                                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#D97757]/10 border border-[#D97757]/20 text-[#C7654A] font-medium">INVERTED</span>
                                                    )}
                                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/65 text-[#6B665C] font-mono">{(m.feeRateBps / 100).toFixed(2)}%</span>
                                                </div>
                                                <h4 className="text-sm text-[#1A1915] font-medium leading-tight mb-1">{m.predictQuestion || m.predictTitle}</h4>
                                                <div className="text-xs text-[#8B847A] font-mono truncate" title={m.polymarketConditionId}>
                                                    Condition: {m.polymarketConditionId.substring(0, 16)}...
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ) : activeTab === 'ARCHIVE' ? (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between mb-4 px-1">
                            <h3 className="font-display text-sm font-medium text-[#1A1915] flex items-center gap-2">
                                <Icon name="archive" size={16} className="text-[#B85A3F]" />
                                自动 PP 归档清单
                            </h3>
                            <div className="text-xs text-[#8B847A] font-mono">{archiveList.length} 个市场</div>
                        </div>
                        {archiveList.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-32 rounded-2xl border border-dashed border-black/[0.08] bg-white/35 backdrop-blur-md">
                                <Icon name="inbox" size={48} className="text-[#A39C8E] mb-6" strokeWidth={1} />
                                <p className="font-display text-lg text-[#6B665C]">暂无归档市场</p>
                                <p className="text-xs text-[#8B847A] mt-2">在「全部」面板的卡片右上角点「归档」可把市场排除出 自动 PP</p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {archiveList.map((entry) => (
                                    <div key={entry.marketId} className="glass-card rounded-xl p-4 border border-black/5 hover:border-black/[0.08] transition-all">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-1.5">
                                                    <span className="text-xs font-mono text-[#8B847A]">ID {entry.marketId}</span>
                                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/65 text-[#6B665C] font-mono">{new Date(entry.archivedAt).toLocaleString()}</span>
                                                </div>
                                                <h4 className="text-sm text-[#1A1915] font-medium leading-tight">{entry.title}</h4>
                                                {entry.reason && <p className="text-xs text-[#8B847A] mt-1">原因：{entry.reason}</p>}
                                            </div>
                                            <button
                                                onClick={() => handleUnarchiveMarket(entry.marketId)}
                                                title="移出归档：恢复进入 自动 PP 候选"
                                                className="text-xs px-3 py-1.5 rounded-lg border border-[#D97757]/40 bg-[#F5C7A8] text-[#1A1915] hover:bg-[#EDB58F] hover:border-[#D97757]/70 font-medium transition-colors flex items-center gap-1 flex-shrink-0">
                                                <Icon name="undo-2" size={12} />
                                                <span>移出</span>
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ) : activeTab === 'TASKS' ? (
                    <TasksTab
                        tasks={tasks}
                        onStart={handleStartTask}
                        onCancel={handleCancelTask}
                        onCancelAll={handleCancelAllTasks}
                        onStopCancelAll={() => handleBatchCancelControl('stop')}
                        batchCancelStatus={batchCancelStatus}
                        batchCancelLoading={batchCancelLoading}
                        onViewLogs={handleViewLogs}
                        apiBaseUrl={API_BASE_URL}
                        taskApiBaseUrl={TASK_API_BASE_URL}
                    />
                ) : !allMarketsEnabled ? (
                    <div className="flex flex-col items-center justify-center py-32 rounded-2xl border border-dashed border-black/[0.08] bg-white/35 backdrop-blur-md">
                        <Icon name="pause-circle" size={48} className="text-[#A39C8E] mb-6" strokeWidth={1} />
                        <p className="font-display text-lg text-[#6B665C] mb-2">All 市场监控已关闭</p>
                        <p className="text-sm text-[#8B847A] mb-6">仅 Sports 标签页处于活跃监控状态</p>
                        <button onClick={toggleAllMarkets}
                            className="px-4 py-2 bg-[#B85A3F] hover:bg-[#C7654A] text-[#1A1915] rounded-lg text-sm font-medium transition-colors">
                            启用 All 市场
                        </button>
                    </div>
                ) : (
                    <>
                        <FilterBar filters={filters} setFilters={setFilters} onReset={() => setFilters({ strategy: 'ALL', sortBy: 'PP_YIELD', searchQuery: '', minDepth: '100', onlyPp: false })} />

                        <div className="flex items-center justify-between mb-4 px-1">
                            <h3 className="font-display text-sm font-medium text-[#1A1915] flex items-center gap-2">
                                <Icon name="activity" size={16} className="text-[#B85A3F]" />
                                Scanning Results
                            </h3>
                            <div className="text-xs text-[#8B847A] font-mono">{filteredOpps.length} Opportunities</div>
                        </div>

                        {filteredOpps.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-32 rounded-2xl border border-dashed border-black/[0.08] bg-white/35 backdrop-blur-md">
                                {isConnected ? (
                                    <>
                                        <Icon name="search" size={48} className="text-[#B85A3F] opacity-80 mb-6" strokeWidth={1} />
                                        <p className="font-display text-xl text-[#1A1915] mb-2">No Matches Found</p>
                                        <p className="text-sm text-[#8B847A]">Try adjusting your filters.</p>
                                    </>
                                ) : (
                                    <>
                                        <Icon name="refresh-cw" size={48} className="text-[#B85A3F] animate-spin opacity-50 mb-6" strokeWidth={1} />
                                        <p className="font-display text-lg text-[#1A1915]">Initializing...</p>
                                    </>
                                )}
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 transition-opacity duration-300">
                                {filteredOpps.map(opp => {
                                    // 查找该市场的活跃任务 (非终态: COMPLETED/FAILED/CANCELLED)
                                    const activeTask = tasks.find(t =>
                                        t.marketId === opp.marketId &&
                                        !['COMPLETED', 'FAILED', 'CANCELLED', 'UNWIND_COMPLETED'].includes(t.status)
                                    );
                                    return <OpportunityCard key={opp.id} opp={opp} onOpenTaskModal={handleOpenTaskModal} activeTask={activeTask} onArchive={handleArchiveMarket} />;
                                })}
                            </div>
                        )}
                    </>
                )}
                </div>
            </main>

            {/* 任务配置模态框 */}
            <TaskModal
                isOpen={taskModalOpen}
                onClose={handleCloseTaskModal}
                data={taskModalData}
                onSubmit={handleCreateTask}
                accounts={accounts}
                apiBaseUrl={API_BASE_URL}
                taskApiBaseUrl={TASK_API_BASE_URL}
            />

            {ppRulesModalOpen && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
                    onClick={() => setPpRulesModalOpen(false)}>
                    <div
                        className="bg-[#FAF6EE] border border-black/10 rounded-xl p-6 max-w-lg w-full mx-4 shadow-2xl"
                        onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-start justify-between mb-4">
                            <div className="flex items-center gap-2">
                                <Icon name="zap" size={18} className="text-[#D97757]" />
                                <h3 className="text-base font-bold text-[#1A1915]">自动 PP 筛选规则与默认设置</h3>
                            </div>
                            <button onClick={() => setPpRulesModalOpen(false)} className="text-[#8B847A] hover:text-[#1A1915]">
                                <Icon name="x" size={18} />
                            </button>
                        </div>
                        <div className="text-[13px] text-[#1A1915] space-y-3 leading-relaxed">
                            <div>
                                <div className="font-semibold mb-1.5 text-[#B85A3F]">候选必须满足以下全部条件：</div>
                                <ul className="space-y-1 pl-2">
                                    <li>· 当前有活跃 PP 奖励（pointsTier &gt; 0）</li>
                                    <li>· PP 收益率 ≥ 用户阈值（默认 0.10，对应内部 0.001）</li>
                                    <li>· Predict 买卖一档价差 &lt; 6¢（spread ≥ 6¢ 没奖励）</li>
                                    <li>· Predict 买一价 ≥ <span className="font-mono font-semibold">10¢</span>（避免 notional 过小）</li>
                                    <li>· 可挂深度 ≥ 100 shares</li>
                                    <li>· Polymarket 对冲单 notional ≥ $1（平台最小限额）</li>
                                </ul>
                            </div>
                            <div>
                                <div className="font-semibold mb-1.5 text-[#B85A3F]">两个面板各自筛选：</div>
                                <ul className="space-y-1 pl-2">
                                    <li>· <span className="font-mono font-semibold">全部</span> 面板：仅非体育市场，距结算 ≥ 3 天</li>
                                    <li>· <span className="font-mono font-semibold">体育</span> 面板：仅体育，距开赛 &gt; 5 分钟</li>
                                </ul>
                            </div>
                            <div>
                                <div className="font-semibold mb-1.5 text-[#B85A3F]">每笔订单资金上限：</div>
                                <p className="pl-2">
                                    min(Predict 可用, Polymarket 可用) × 占比 ÷ 价格
                                    <br />
                                    <span className="text-[#6B665C]">占比可调，默认 50%，最大 50%。Predict resting 单共享抵押，多单不互相挤占。</span>
                                </p>
                            </div>
                            <div>
                                <div className="font-semibold mb-1.5 text-[#B85A3F]">轮询节奏：</div>
                                <p className="pl-2">每 5 分钟扫描一次；OFF→ON 时立即触发一次。</p>
                            </div>
                            <div>
                                <div className="font-semibold mb-1.5 text-[#B85A3F]">策略：</div>
                                <p className="pl-2">
                                    固定 <span className="font-mono font-semibold">PREDICT_MAKER</span>：在 Predict 挂买单等吃，成交后立刻 IOC 对冲 Polymarket。
                                </p>
                            </div>
                            <div>
                                <div className="font-semibold mb-1.5 text-[#B85A3F]">排序：</div>
                                <p className="pl-2">PP 收益率降序优先（高收益率 = 容易拿大份额），再按结算/开赛时间升序，再按利润率降序。</p>
                            </div>
                            <div>
                                <div className="font-semibold mb-1.5 text-[#B85A3F]">收益率公式：</div>
                                <div className="pl-2 space-y-1">
                                    <p className="font-mono text-[12px] bg-white/60 border border-black/10 rounded px-2 py-1.5 leading-snug">
                                        收益率 = hourlyRate ÷ (买一价 × 买一深度 + 卖一价 × 卖一深度)
                                    </p>
                                    <p className="text-[#6B665C]">
                                        分子：每小时 PP 奖励；分母：买卖一档的总挂单金额（notional）。
                                    </p>
                                    <p className="text-[#6B665C]">
                                        数值越大越好挂——同样金额能拿到更多 PP；UI 显示的徽章数字 = 真实值 × 100。
                                    </p>
                                </div>
                            </div>
                            <div className="rounded-lg border border-rose-300/60 bg-rose-50/70 p-3">
                                <div className="font-semibold mb-1.5 text-rose-700 flex items-center gap-1.5">
                                    <Icon name="alert-triangle" size={14} />
                                    All 面板风险提示
                                </div>
                                <ul className="space-y-1 pl-2 text-[#1A1915]">
                                    <li>· All 面板包含<strong>新闻 / 政治 / 突发事件</strong>类市场，一条消息出来价格会瞬间跳，挂在中间的 maker 单很容易被先吃后调价——俗称「接刀子」。</li>
                                    <li>· 这类市场的 Predict 一档报价不一定反映"真实"概率，机器人按当前 spread / depth 计算出的收益率可能在事件爆出后失效。</li>
                                    <li>· 建议：对自己不熟悉、消息驱动强的市场（选举、判决、监管等），自己手动 review 候选；或仅用 Sports 面板（有开赛缓冲，无突发新闻冲击）。</li>
                                </ul>
                            </div>
                        </div>
                        <div className="mt-5 pt-3 border-t border-black/10 flex justify-end">
                            <button
                                onClick={() => setPpRulesModalOpen(false)}
                                className="px-4 py-2 rounded-lg bg-[#1A1915] text-white text-sm font-medium hover:bg-[#2A2520]">
                                我知道了
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <AutoTaskPreviewModal
                isOpen={autoPreviewOpen}
                onClose={handleCloseAutoTaskPreview}
                loading={autoPreviewLoading}
                creating={autoCreateLoading}
                error={autoPreviewError}
                result={autoPreviewResult}
                createStatus={autoCreateStatus}
                source={autoPreviewSource}
                onRefresh={() => fetchAutoTaskPreview(autoPreviewSource)}
                onCreate={handleAutoCreateTasks}
                onPause={() => handleAutoCreateControl('pause')}
                onResume={() => handleAutoCreateControl('resume')}
                onStop={() => handleAutoCreateControl('stop')}
            />

            {/* 任务日志弹窗 */}
            <TaskLogModal
                isOpen={logModalOpen}
                onClose={handleCloseLogModal}
                taskId={logModalTaskId}
                apiBaseUrl={API_BASE_URL}
            />
        </div>
    );
};

class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
    }
    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }
    componentDidCatch(error, info) {
        console.error('[ErrorBoundary] Render error:', error, info?.componentStack);
    }
    render() {
        if (this.state.hasError) {
            return (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#09090b', color: '#fff', fontFamily: 'system-ui, sans-serif' }}>
                    <div style={{ fontSize: 48, marginBottom: 16 }}>:/</div>
                    <h2 style={{ fontSize: 20, marginBottom: 8 }}>Dashboard Render Error</h2>
                    <pre style={{ fontSize: 12, color: '#f87171', maxWidth: 600, overflow: 'auto', padding: 16, background: '#18181b', borderRadius: 8, border: '1px solid #27272a', marginBottom: 16 }}>
                        {this.state.error?.message || 'Unknown error'}
                    </pre>
                    <button
                        onClick={() => { this.setState({ hasError: false, error: null }); }}
                        style={{ padding: '8px 20px', borderRadius: 8, background: '#f59e0b', color: '#000', fontWeight: 600, border: 'none', cursor: 'pointer' }}>
                        Retry
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<ErrorBoundary><App /></ErrorBoundary>);
