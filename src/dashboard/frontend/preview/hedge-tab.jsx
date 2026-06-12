var Preview = window.Preview || (window.Preview = {});
var { useState, useEffect, useRef, useCallback, useMemo } = Preview.ReactHooks;
var { Icon, Badge, FlashValue, ViewLinks, HighlightedTitle } = Preview;
var { API_BASE_URL, TASK_API_BASE_URL } = Preview;

// ============================================================================
// 共用格式化
// ============================================================================
const formatPrice = (p) => (p * 100).toFixed(1) + '¢';
const formatProfit = (p) => p >= 0 ? `+$${p.toFixed(2)}` : `-$${Math.abs(p).toFixed(2)}`;
const formatPct = (p) => p >= 0 ? `+${p.toFixed(1)}%` : `${p.toFixed(1)}%`;

// ============================================================================
// HedgeCard - 单个平仓机会卡片
// 镜面对称：开仓 BUY (OpportunityCard) ←→ 平仓 SELL (本卡片)
// ============================================================================
const HedgeCard = ({ opportunity, onTaskCreated, activeTask }) => {
    // T-T 状态
    const [ttConfirming, setTtConfirming] = useState(false);
    const [ttSubmitting, setTtSubmitting] = useState(false);
    const [ttError, setTtError] = useState(null);
    const [ttQuantity, setTtQuantity] = useState(opportunity.matchedShares);
    const ttTimeoutRef = useRef(null);

    // M-T 状态
    const [mtConfirming, setMtConfirming] = useState(false);
    const [mtSubmitting, setMtSubmitting] = useState(false);
    const [mtError, setMtError] = useState(null);
    const [mtQuantity, setMtQuantity] = useState(opportunity.matchedShares);
    // 美分存储 (0-100，一位小数)，避免浮点
    const [mtAskPriceCents, setMtAskPriceCents] = useState(
        Math.round((opportunity.mt?.predictAsk || 0.5) * 100 * 10) / 10
    );
    const [mtPriceEdited, setMtPriceEdited] = useState(false);
    const mtTimeoutRef = useRef(null);

    const tt = opportunity.tt || { predictBid: 0, predictBidDepth: 0, polyBid: 0, polyBidDepth: 0, predictFee: 0, estProfitPerShare: 0, estProfitTotal: 0, estProfitPct: 0, minPolyBid: 0, isValid: false };
    const mt = opportunity.mt || { predictAsk: 0.5, polyBid: 0, polyBidDepth: 0, maxCloseShares: 0, estProfitPerShare: 0, estProfitTotal: 0, estProfitPct: 0, minPolyBid: 0, isValid: false };

    const mtAskPrice = mtAskPriceCents / 100;

    // 3 秒后重置确认状态
    useEffect(() => {
        if (ttConfirming && !ttSubmitting) {
            ttTimeoutRef.current = window.setTimeout(() => setTtConfirming(false), 3000);
        }
        return () => { if (ttTimeoutRef.current) clearTimeout(ttTimeoutRef.current); };
    }, [ttConfirming, ttSubmitting]);

    useEffect(() => {
        if (mtConfirming && !mtSubmitting) {
            mtTimeoutRef.current = window.setTimeout(() => setMtConfirming(false), 3000);
        }
        return () => { if (mtTimeoutRef.current) clearTimeout(mtTimeoutRef.current); };
    }, [mtConfirming, mtSubmitting]);

    // 同步数量
    useEffect(() => {
        setTtQuantity(opportunity.maxCloseShares);
        setMtQuantity(opportunity.mt?.maxCloseShares || opportunity.matchedShares);
        if (!mtPriceEdited) {
            setMtAskPriceCents(Math.round((opportunity.mt?.predictAsk || 0.5) * 100 * 10) / 10);
        }
    }, [opportunity.maxCloseShares, opportunity.mt?.maxCloseShares, opportunity.mt?.predictAsk]);

    // M-T 动态利润
    // polymarketMinBid 语义：hedge 卖出 Poly 时能接受的最低价（市场基准 - 滑点）。
    // 跌穿则 PAUSE，不再 hedge。原"entryCost - mtAskPrice" 是保本公式，会算出负数让 SDK 拒签。
    // SLIPPAGE_HEDGE 与 HEDGE_SLIPPAGE_TICKS（dashboard-config.ts，默认 3 ticks = 0.03）保持一致。
    const SLIPPAGE_HEDGE = 0.03;
    const calcMtMinPolyBid = () => Math.max(0.01, (mt?.polyBid || 0) - SLIPPAGE_HEDGE);
    const calcMtProfit = () => {
        const polyBid = mt?.polyBid || 0;
        const profitPerShare = mtAskPrice + polyBid - opportunity.entryCostPerShare;
        return profitPerShare * mtQuantity;
    };

    // 任务提交（共用 payload 构造）
    const buildPayload = (mode, qty) => {
        const isTaker = mode === 'TT';
        // 体育市场：开赛前 3 分钟过期 (与 auto-task-preview SPORTS_EXPIRY_OFFSET_MS 对齐)
        let expiresAt = undefined;
        if (opportunity.isSportsMarket && opportunity.gameStartTime) {
            const startMs = new Date(opportunity.gameStartTime).getTime();
            if (Number.isFinite(startMs) && startMs > Date.now()) {
                expiresAt = startMs - 3 * 60 * 1000;
            }
        }
        return {
            type: 'SELL',
            marketId: opportunity.predictMarketId,
            title: opportunity.title,
            polymarketConditionId: opportunity.polymarketConditionId,
            polymarketNoTokenId: opportunity.polymarketNoTokenId || '',
            polymarketYesTokenId: opportunity.polymarketYesTokenId || '',
            isInverted: opportunity.isInverted || false,
            tickSize: opportunity.tickSize || 0.01,
            negRisk: opportunity.negRisk || false,
            arbSide: opportunity.arbSide,
            quantity: qty,
            entryCost: opportunity.entryCostPerShare * qty,
            feeRateBps: opportunity.feeRateBps,
            polymarketMinBid: isTaker ? tt.minPolyBid : calcMtMinPolyBid(),
            strategy: isTaker ? 'TAKER' : 'PREDICT_MAKER',
            predictPrice: isTaker ? tt.predictBid : mtAskPrice,
            polymarketMaxAsk: 0,
            minProfitBuffer: 0.001,
            orderTimeout: 300000,
            maxHedgeRetries: 3,
            isSportsMarket: opportunity.isSportsMarket || false,
            ...(expiresAt ? { expiresAt } : {}),
            ...(opportunity.gameStartTime ? { gameStartTime: opportunity.gameStartTime } : {}),
        };
    };

    const submitTask = async (mode, qty, label, setError) => {
        const payload = buildPayload(mode, qty);
        const res = await fetch(`${TASK_API_BASE_URL}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...payload, autoStart: true }),
        });
        if (!res.ok) {
            const errData = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
            throw new Error(errData.message || errData.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!data.started) {
            throw new Error(`任务创建成功但启动失败: ${data.startError || 'Unknown'}`);
        }
        console.log(`${label} Hedge 任务已启动:`, data.data?.id);
    };

    const handleTtClick = async () => {
        if (ttSubmitting) return;
        if (ttConfirming) {
            setTtSubmitting(true); setTtError(null);
            try {
                const maxQty = opportunity.maxCloseShares;
                if (!Number.isFinite(ttQuantity) || ttQuantity <= 0) throw new Error('Invalid shares');
                if (ttQuantity > maxQty) throw new Error(`Shares exceed max (${maxQty.toFixed(1)})`);
                await submitTask('TT', ttQuantity, 'T-T', setTtError);
                setTtConfirming(false);
                onTaskCreated?.();
            } catch (e) {
                setTtError(e.message);
            } finally {
                setTtSubmitting(false);
            }
        } else {
            setTtConfirming(true); setTtError(null);
        }
    };

    const handleMtClick = async () => {
        if (mtSubmitting) return;
        if (mtConfirming) {
            setMtSubmitting(true); setMtError(null);
            try {
                const maxQty = opportunity.matchedShares;
                if (!Number.isFinite(mtQuantity) || mtQuantity <= 0) throw new Error('Invalid shares');
                if (mtQuantity > maxQty) throw new Error(`Shares exceed max (${maxQty.toFixed(1)})`);
                if (!Number.isFinite(mtAskPriceCents) || mtAskPriceCents <= 0 || mtAskPriceCents >= 100) {
                    throw new Error('Invalid ask price (0 < price < 100¢)');
                }
                await submitTask('MT', mtQuantity, 'M-T', setMtError);
                setMtConfirming(false);
                onTaskCreated?.();
            } catch (e) {
                setMtError(e.message);
            } finally {
                setMtSubmitting(false);
            }
        } else {
            setMtConfirming(true); setMtError(null);
        }
    };

    const bestMode = tt.estProfitTotal >= mt.estProfitTotal ? 'TT' : 'MT';
    const bestProfit = Math.max(tt.estProfitTotal, mt.estProfitTotal);
    const isProfitable = bestProfit > 0;
    const mtDynamicProfit = calcMtProfit();
    const mtDynamicMinPolyBid = calcMtMinPolyBid();
    const mtIsValid = mtDynamicProfit > 0;

    // 任务标签
    const hasActiveTask = !!activeTask;
    const taskStatus = activeTask?.status;
    const isExecuting = ['PREDICT_SUBMITTED', 'PARTIALLY_FILLED', 'HEDGING', 'HEDGE_PENDING', 'HEDGE_RETRY'].includes(taskStatus);
    const isPaused = taskStatus === 'PAUSED';
    const isPending = taskStatus === 'PENDING';

    const taskLabel = isPending ? '待启动' : isPaused ? '暂停中' : isExecuting ? '执行中' : taskStatus === 'VALIDATING' ? '校验中' : 'SELL';
    const taskColor = isPending ? '#f59e0b' : isPaused ? '#6366f1' : '#ef4444';

    return (
        <div className="group">
            <div className={`glass-card rounded-xl transition-all duration-300 overflow-hidden h-full relative
                ${isProfitable ? 'border border-emerald-500/30' : 'border border-rose-500/20'}
                hover:border-white/50 hover:scale-[1.005]`}>

                {/* 活跃任务斜角丝带 */}
                {hasActiveTask && (
                    <div
                        className={`absolute top-2 -left-7 transform -rotate-45 text-[9px] font-semibold uppercase tracking-wider text-[#1A1915] px-8 py-0.5 z-10 pointer-events-none ${isExecuting ? 'animate-pulse' : ''}`}
                        style={{ background: taskColor }}
                        title={`任务 #${activeTask.id?.slice(0, 8)} - ${taskStatus}`}
                    >
                        {taskLabel}
                    </div>
                )}

                <div className="p-5">
                    {/* 第一行: 标题 + 导航按钮 + profit */}
                    <div className="flex items-center justify-between mb-2 gap-2">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                            <h3 className="text-base font-medium text-[#1A1915] line-clamp-2 min-w-0 flex-1">
                                {HighlightedTitle ? <HighlightedTitle title={opportunity.title} outcome={opportunity.arbSide} /> : opportunity.title}
                            </h3>
                            {ViewLinks && (
                                <ViewLinks
                                    predictId={opportunity.predictMarketId}
                                    predictSlug={opportunity.predictSlug}
                                    polymarketSlug={opportunity.polymarketSlug}
                                    polymarketConditionId={opportunity.polymarketConditionId}
                                    title={opportunity.title}
                                />
                            )}
                            {opportunity.isInverted && <Badge variant="inverted" icon="arrow-left-right">INV</Badge>}
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                            <FlashValue value={bestProfit}>
                                <div className={`text-xl font-display font-semibold tracking-tight ${isProfitable ? 'text-[#1A1915]' : 'text-rose-400'}`}>
                                    {formatProfit(bestProfit)}
                                </div>
                            </FlashValue>
                        </div>
                    </div>

                    {/* 第二行: 比赛时间 / Live 高亮框 */}
                    {opportunity.isSportsMarket && opportunity.gameStartTime && (
                        <div className="flex flex-wrap items-center gap-2 mb-3">
                            {(() => {
                                const startMs = new Date(opportunity.gameStartTime).getTime();
                                if (!Number.isFinite(startMs)) return null;
                                const diffMin = Math.round((startMs - Date.now()) / 60000);
                                const isLive = diffMin <= 0 && diffMin > -60 * 6; // 比赛进行中（开赛后 6 小时内视作直播）
                                const isUrgent = diffMin > 0 && diffMin <= 3;     // 即将开赛
                                let label;
                                if (diffMin > 60) label = `${Math.floor(diffMin / 60)}h${diffMin % 60}m to start`;
                                else if (diffMin > 0) label = `${diffMin}m to start`;
                                else if (diffMin > -60) label = `Live ${-diffMin}m`;
                                else label = `Started ${Math.floor(-diffMin / 60)}h ago`;

                                const boxClass = isLive
                                    ? 'bg-rose-500 text-white border-rose-700/50 shadow-[0_2px_8px_rgba(244,63,94,0.45)] animate-pulse'
                                    : isUrgent
                                        ? 'bg-[#D97757] text-[#1A1915] border-[#1A1915]/40 shadow-[0_2px_8px_rgba(217,119,87,0.45)]'
                                        : 'bg-[#F5C7A8] text-[#1A1915] border-[#D97757]/50';

                                return (
                                    <span
                                        className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg border-2 text-sm font-bold tracking-wide ${boxClass}`}
                                        title={new Date(startMs).toLocaleString()}
                                    >
                                        {isLive && (
                                            <span className="inline-block w-2 h-2 rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.9)]"></span>
                                        )}
                                        <Icon name="clock" size={13} />
                                        <span>{label}</span>
                                    </span>
                                );
                            })()}
                        </div>
                    )}

                    {/* Price Cards Row - Predict / Polymarket */}
                    <div className="grid grid-cols-2 gap-3 mb-3">
                        {/* Predict Card */}
                        <div className="p-3 rounded-lg border border-black/5 bg-white/45 backdrop-blur-lg">
                            <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                    <div className="w-5 h-5 rounded bg-blue-500/20 flex items-center justify-center">
                                        <span className="text-[10px] font-bold text-blue-400">P</span>
                                    </div>
                                    <span className="text-xs text-[#6B665C]">Predict ({opportunity.arbSide})</span>
                                </div>
                            </div>
                            <div className="space-y-1">
                                <div className="flex justify-between items-center gap-2">
                                    <span className="text-[10px] text-[#B85A3F]">BID (T-T)</span>
                                    <FlashValue value={tt.predictBidDepth}>
                                        <span className="text-[10px] text-[#D97757] font-mono">{tt.predictBidDepth.toFixed(0)} shares</span>
                                    </FlashValue>
                                    <FlashValue value={tt.predictBid}>
                                        <span className="font-mono text-sm text-[#D97757]">{formatPrice(tt.predictBid)}</span>
                                    </FlashValue>
                                </div>
                                <div className="flex justify-between items-center gap-2">
                                    <span className="text-[10px] text-[#B85A3F]">ASK (M-T)</span>
                                    <span className="text-[10px] text-[#8B847A] font-mono">挂单价</span>
                                    <FlashValue value={mt.predictAsk}>
                                        <span className="font-mono text-sm text-[#D97757]">{formatPrice(mt.predictAsk)}</span>
                                    </FlashValue>
                                </div>
                            </div>
                        </div>

                        {/* Polymarket Card */}
                        <div className="p-3 rounded-lg border border-black/5 bg-white/45 backdrop-blur-lg">
                            <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                    <div className="w-5 h-5 rounded bg-purple-500/20 flex items-center justify-center">
                                        <span className="text-[10px] font-bold text-purple-400">M</span>
                                    </div>
                                    <span className="text-xs text-[#6B665C]">Polymarket (对冲腿)</span>
                                </div>
                            </div>
                            <div className="space-y-1">
                                <div className="flex justify-between items-center gap-2">
                                    <span className="text-[10px] text-blue-400">BID</span>
                                    <FlashValue value={tt.polyBidDepth}>
                                        <span className="text-[10px] text-[#D97757] font-mono">{tt.polyBidDepth.toFixed(0)} shares</span>
                                    </FlashValue>
                                    <FlashValue value={tt.polyBid}>
                                        <span className="font-mono text-sm text-[#D97757]">{formatPrice(tt.polyBid)}</span>
                                    </FlashValue>
                                </div>
                                <div className="flex justify-between items-center gap-2 text-[10px] text-[#8B847A]">
                                    <span>持仓 {(opportunity.matchedShares || 0).toFixed(1)}</span>
                                    <span>成本 {formatPrice(opportunity.entryCostPerShare)}/sh</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* T-T vs M-T 双策略 */}
                    <div className="grid grid-cols-2 gap-3">
                        {/* T-T 策略卡 */}
                        <div className={`p-3 rounded-lg border ${tt.isValid ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-rose-500/20 bg-rose-500/5'}`}>
                            <div className="flex items-center justify-between mb-2">
                                <Badge variant={tt.isValid ? 'success' : 'default'}>T.吃单</Badge>
                                {bestMode === 'TT' && tt.isValid && (
                                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#D97757]/10 text-[#C7654A] border border-[#D97757]/20">Best</span>
                                )}
                            </div>
                            <div className="space-y-1.5 text-[11px]">
                                <div className="flex justify-between">
                                    <span className="text-[#8B847A]">Fee</span>
                                    <span className="font-mono text-rose-400">-${(tt.predictFee * opportunity.matchedShares).toFixed(2)}</span>
                                </div>
                                {opportunity.depthAnalysis && (
                                    <div className="flex justify-between">
                                        <span className="text-[#8B847A]">可盈利深度</span>
                                        <span className={`font-mono ${opportunity.depthAnalysis.maxProfitableShares > 0 ? 'text-[#1A1915]' : 'text-[#6B665C]'}`}>
                                            {(opportunity.depthAnalysis.maxProfitableShares || 0).toFixed(1)} sh
                                        </span>
                                    </div>
                                )}
                                <div className={`flex justify-between font-medium pt-1 border-t border-black/[0.08] ${tt.isValid ? 'text-[#1A1915]' : 'text-rose-400'}`}>
                                    <span>Profit</span>
                                    <span className="font-mono">{formatProfit(opportunity.depthAnalysis?.totalProfit || tt.estProfitTotal)} ({formatPct(tt.estProfitPct)})</span>
                                </div>
                            </div>

                            {tt.isValid && (
                                <div className="mt-3 space-y-2">
                                    <div className="flex items-center justify-between text-[10px] text-[#8B847A]">
                                        <span>Shares</span>
                                        <span>Max {(opportunity.maxCloseShares || 0).toFixed(1)}</span>
                                    </div>
                                    <input
                                        type="number"
                                        className="w-full px-2 py-1.5 text-xs font-mono bg-white/55 backdrop-blur-xl border border-black/[0.12] rounded text-[#1A1915] focus:border-[#D97757] focus:outline-none"
                                        value={ttQuantity}
                                        min={0}
                                        max={opportunity.maxCloseShares}
                                        step={0.1}
                                        onChange={(e) => {
                                            const next = parseFloat(e.target.value);
                                            setTtQuantity(Number.isFinite(next) ? next : 0);
                                            setTtConfirming(false); setTtError(null);
                                        }}
                                    />
                                    {ttQuantity > opportunity.maxCloseShares && (
                                        <div className="text-[10px] text-rose-400">超过深度限制</div>
                                    )}
                                    <button
                                        className={`w-full h-9 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-2 ${
                                            ttConfirming
                                                ? 'bg-rose-500 text-[#1A1915] animate-pulse'
                                                : 'bg-rose-500/90 text-[#1A1915] hover:brightness-110 hover:shadow-glow-button'
                                        } ${(ttSubmitting || ttQuantity <= 0 || ttQuantity > opportunity.maxCloseShares) ? 'opacity-50 cursor-not-allowed' : ''}`}
                                        onClick={handleTtClick}
                                        disabled={ttSubmitting || ttQuantity <= 0 || ttQuantity > opportunity.maxCloseShares}
                                    >
                                        <Icon name="arrow-up-circle" size={14} strokeWidth={2} />
                                        {ttSubmitting ? '提交中...' : ttConfirming ? '确认 (3s)' : 'T-T 平仓'}
                                    </button>
                                    {ttError && <div className="text-[10px] text-rose-400 truncate" title={ttError}>{ttError}</div>}
                                </div>
                            )}
                        </div>

                        {/* M-T 策略卡 */}
                        <div className={`p-3 rounded-lg border ${mtIsValid ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-rose-500/20 bg-rose-500/5'}`}>
                            <div className="flex items-center justify-between mb-2">
                                <Badge variant={mtIsValid ? 'success' : 'default'}>M.挂单</Badge>
                                {bestMode === 'MT' && mtIsValid && (
                                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#D97757]/10 text-[#C7654A] border border-[#D97757]/20">Best</span>
                                )}
                            </div>
                            <div className="space-y-1.5 text-[11px]">
                                <div className="flex justify-between">
                                    <span className="text-[#8B847A]">Fee</span>
                                    <span className="font-mono text-[#1A1915]">0¢ (Maker)</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-[#8B847A]">Min Poly Bid</span>
                                    <span className="font-mono text-[#3A342C]">{formatPrice(mtDynamicMinPolyBid)}</span>
                                </div>
                                <div className={`flex justify-between font-medium pt-1 border-t border-black/[0.08] ${mtIsValid ? 'text-[#1A1915]' : 'text-rose-400'}`}>
                                    <span>Profit</span>
                                    <span className="font-mono">{formatProfit(mtDynamicProfit)}</span>
                                </div>
                            </div>

                            <div className="mt-3 space-y-2">
                                <div className="flex items-center justify-between text-[10px] text-[#8B847A]">
                                    <span>挂单价 ¢</span>
                                    <span>当前 Ask: {formatPrice(mt.predictAsk)}</span>
                                </div>
                                <div className="relative">
                                    <input
                                        type="number"
                                        className="w-full px-2 py-1.5 pr-6 text-xs font-mono bg-white/55 backdrop-blur-xl border border-black/[0.12] rounded text-[#1A1915] focus:border-[#D97757] focus:outline-none"
                                        value={mtAskPriceCents}
                                        min={0.1}
                                        max={99.9}
                                        step={0.1}
                                        onChange={(e) => {
                                            const next = parseFloat(e.target.value);
                                            const rounded = Number.isFinite(next) ? Math.round(next * 10) / 10 : 0;
                                            setMtPriceEdited(true);
                                            setMtAskPriceCents(rounded);
                                            setMtConfirming(false); setMtError(null);
                                        }}
                                    />
                                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-[#8B847A]">¢</span>
                                </div>
                                <div className="flex items-center justify-between text-[10px] text-[#8B847A]">
                                    <span>Shares</span>
                                    <span>Max {(mt?.maxCloseShares || opportunity.matchedShares).toFixed(1)}</span>
                                </div>
                                <input
                                    type="number"
                                    className="w-full px-2 py-1.5 text-xs font-mono bg-white/55 backdrop-blur-xl border border-black/[0.12] rounded text-[#1A1915] focus:border-[#D97757] focus:outline-none"
                                    value={mtQuantity}
                                    min={0}
                                    max={mt?.maxCloseShares || opportunity.matchedShares}
                                    step={0.1}
                                    onChange={(e) => {
                                        const next = parseFloat(e.target.value);
                                        setMtQuantity(Number.isFinite(next) ? next : 0);
                                        setMtConfirming(false); setMtError(null);
                                    }}
                                />
                                {mtQuantity > (mt?.maxCloseShares || opportunity.matchedShares) && (
                                    <div className="text-[10px] text-rose-400">超过深度限制</div>
                                )}
                                <button
                                    className={`w-full h-9 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-2 ${
                                        mtConfirming
                                            ? 'bg-rose-500 text-[#1A1915] animate-pulse'
                                            : mtIsValid
                                                ? 'bg-rose-500/90 text-[#1A1915] hover:brightness-110 hover:shadow-glow-button'
                                                : 'bg-white/65 text-[#6B665C] border border-black/[0.12]'
                                    } ${(mtSubmitting || mtQuantity <= 0 || mtQuantity > (mt?.maxCloseShares || opportunity.matchedShares)) ? 'opacity-50 cursor-not-allowed' : ''}`}
                                    onClick={handleMtClick}
                                    disabled={mtSubmitting || mtQuantity <= 0 || mtQuantity > (mt?.maxCloseShares || opportunity.matchedShares)}
                                >
                                    <Icon name="arrow-up-circle" size={14} strokeWidth={2} />
                                    {mtSubmitting ? '提交中...' : mtConfirming ? '确认 (3s)' : 'M-T 平仓'}
                                </button>
                                {mtError && <div className="text-[10px] text-rose-400 truncate" title={mtError}>{mtError}</div>}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

// ============================================================================
// HedgeTab - 平仓管理标签页
// ============================================================================
const HedgeTab = ({ onSwitchToTasks, tasks = [], sseData }) => {
    const [opportunities, setOpportunities] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [lastRefresh, setLastRefresh] = useState(null);
    const [manualRefreshing, setManualRefreshing] = useState(false);

    // SSE 推送驱动：后端每 30 秒广播
    useEffect(() => {
        if (sseData && sseData.opportunities && sseData.lastUpdate) {
            setOpportunities(sseData.opportunities);
            setLastRefresh(new Date(sseData.lastUpdate));
            setLoading(false);
        }
    }, [sseData]);

    const handleManualRefresh = useCallback(async () => {
        setManualRefreshing(true);
        setError(null);
        try {
            const res = await fetch(`${API_BASE_URL}/api/close-opportunities?refresh=true`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            setOpportunities(data.opportunities || []);
            setLastRefresh(data.lastUpdate ? new Date(data.lastUpdate) : new Date());
        } catch (e) {
            setError(e.message);
        } finally {
            setManualRefreshing(false);
        }
    }, []);

    const handleTaskCreated = () => {
        handleManualRefresh();
    };

    const profitableCount = opportunities.filter(o => o.tt?.isValid || o.mt?.isValid).length;
    const totalPotentialProfit = opportunities.reduce((sum, o) =>
        sum + Math.max(o.tt?.estProfitTotal || 0, o.mt?.estProfitTotal || 0), 0
    );

    // 卡片固定顺序：已开赛(group 0) → 未开赛按 gameStartTime 升序(group 1) → 无 gameStartTime 按 predictMarketId(group 2)
    // 同时间用 predictMarketId+arbSide 作稳定 tiebreaker，避免后端推送顺序变化导致卡片跳动
    const sortedOpportunities = useMemo(() => {
        const nowMs = Date.now();
        const decorated = opportunities.map((opp) => {
            const startMs = opp.gameStartTime ? new Date(opp.gameStartTime).getTime() : NaN;
            let group;
            let sortKey;
            if (Number.isFinite(startMs) && startMs <= nowMs) {
                group = 0;             // 已开赛：最前
                sortKey = startMs;     // 同组内按开赛时间升序（先开赛的在前）
            } else if (Number.isFinite(startMs)) {
                group = 1;             // 未开赛
                sortKey = startMs;
            } else {
                group = 2;             // 无开赛时间（非体育）
                sortKey = opp.predictMarketId || 0;
            }
            return { opp, group, sortKey };
        });
        decorated.sort((a, b) => {
            if (a.group !== b.group) return a.group - b.group;
            if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
            const aId = a.opp.predictMarketId || 0;
            const bId = b.opp.predictMarketId || 0;
            if (aId !== bId) return aId - bId;
            return String(a.opp.arbSide).localeCompare(String(b.opp.arbSide));
        });
        return decorated.map((d) => d.opp);
    }, [opportunities]);

    return (
        <div className="space-y-6">
            {/* 顶部统计条 */}
            <div className="glass-card rounded-xl border border-black/[0.08] p-5">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="font-display text-sm font-medium text-[#1A1915] flex items-center gap-2">
                        <Icon name="briefcase" size={16} className="text-[#B85A3F]" />
                        Hedge — 平仓机会（双边卖出）
                    </h3>
                    <button
                        onClick={handleManualRefresh}
                        disabled={manualRefreshing}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                            manualRefreshing
                                ? 'bg-white/65 text-[#8B847A] cursor-not-allowed'
                                : 'bg-[#D97757]/10 text-[#C7654A] border border-[#D97757]/20 hover:bg-[#C7654A]/20'
                        }`}
                    >
                        <Icon name={manualRefreshing ? 'loader' : 'refresh-cw'} size={12} className={manualRefreshing ? 'animate-spin' : ''} />
                        {manualRefreshing ? '刷新中...' : '手动刷新'}
                    </button>
                </div>
                <div className="grid grid-cols-4 gap-6">
                    <div>
                        <div className="text-[#8B847A] text-xs mb-1">持仓数</div>
                        <div className="text-2xl font-display font-semibold text-[#1A1915]">{opportunities.length}</div>
                    </div>
                    <div>
                        <div className="text-[#8B847A] text-xs mb-1">可盈利</div>
                        <div className="text-2xl font-display font-semibold text-[#1A1915]">{profitableCount}</div>
                    </div>
                    <div>
                        <div className="text-[#8B847A] text-xs mb-1">潜在收益</div>
                        <div className={`text-2xl font-display font-semibold ${totalPotentialProfit >= 0 ? 'text-[#1A1915]' : 'text-rose-400'}`}>
                            {totalPotentialProfit >= 0 ? '+' : ''}${totalPotentialProfit.toFixed(2)}
                        </div>
                    </div>
                    <div>
                        <div className="text-[#8B847A] text-xs mb-1">最后更新</div>
                        <div className="text-sm font-mono text-[#3A342C]">
                            {lastRefresh ? lastRefresh.toLocaleTimeString() : '-'}
                        </div>
                    </div>
                </div>
            </div>

            {error && (
                <div className="glass-card rounded-xl border border-rose-500/30 p-4">
                    <p className="text-rose-400 text-sm">加载失败: {error}</p>
                </div>
            )}

            {opportunities.length === 0 && !loading && !error ? (
                <div className="flex flex-col items-center justify-center py-20 rounded-2xl border border-dashed border-black/[0.08] bg-white/55 backdrop-blur-xl">
                    <Icon name="inbox" size={48} className="text-[#A39C8E] mb-4" strokeWidth={1} />
                    <p className="text-[#6B665C]">暂无可平仓的持仓</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {sortedOpportunities.map((opp) => {
                        const activeTask = tasks.find(t =>
                            t.marketId === opp.predictMarketId &&
                            t.type === 'SELL' &&
                            !['COMPLETED', 'FAILED', 'CANCELLED', 'UNWIND_COMPLETED'].includes(t.status)
                        );
                        return (
                            <HedgeCard
                                key={`${opp.predictMarketId}-${opp.arbSide}`}
                                opportunity={opp}
                                onTaskCreated={handleTaskCreated}
                                activeTask={activeTask}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
};

// 导出
Preview.Components = Preview.Components || {};
Preview.Components.HedgeTab = HedgeTab;
Preview.Components.HedgeCard = HedgeCard;
// 兼容旧名（迁移期保留，后续可删）
Preview.Components.ClosePositionTab = HedgeTab;
Preview.Components.ClosePositionCard = HedgeCard;
