var Preview = window.Preview || (window.Preview = {});
var { useState, useEffect, useMemo, useRef, useCallback } = Preview.ReactHooks;
var { Icon } = Preview;

// --- Components ---

/**
 * FlashValue - 值变化时闪烁的组件
 * 价格/深度上涨显示绿色闪烁，下跌显示红色闪烁
 */
const FlashValue = ({ value, children, className = '' }) => {
    const [flashClass, setFlashClass] = useState('');
    const prevValueRef = useRef(value);
    const flashKeyRef = useRef(0);

    useEffect(() => {
        const prevValue = prevValueRef.current;
        // 值变化且差异超过阈值才触发闪烁 (避免浮点精度噪音)
        const hasChanged = prevValue !== undefined && Math.abs(prevValue - value) > 0.0001;

        if (hasChanged) {
            // 值变化，触发闪烁
            const direction = value > prevValue ? 'flash-up' : 'flash-down';
            flashKeyRef.current += 1;
            setFlashClass(direction);

            // 动画结束后清除 class
            const timer = setTimeout(() => {
                setFlashClass('');
            }, 1500);

            // 更新 prevValueRef (修复：无论如何都要更新)
            prevValueRef.current = value;
            return () => clearTimeout(timer);
        }

        // 首次渲染或无变化时也更新
        prevValueRef.current = value;
    }, [value]);

    // 使用 key 强制重新创建元素以重新触发动画
    return (
        <span key={flashKeyRef.current} className={`${className} ${flashClass}`}>
            {children}
        </span>
    );
};


/** Parse boost time (ISO / seconds / milliseconds). */
const parseBoostTimeMs = (value) => {
    if (!value) return null;
    if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
    if (typeof value !== 'string') return null;
    if (/^\d+$/.test(value)) {
        const num = Number(value);
        return num > 1e12 ? num : num * 1000;
    }
    const hasTz = /[zZ]|[+-]\d{2}:\d{2}$/.test(value);
    const ts = Date.parse(hasTz ? value : `${value}Z`);
    return Number.isNaN(ts) ? null : ts;
};

/** 获取 boost 徽标状态：UPCOMING 显示倒计时，ACTIVE 显示 boosted。 */
const getBoostBadgeState = (boostStartTime, boostEndTime) => {
    const startMs = parseBoostTimeMs(boostStartTime);
    const endMs = parseBoostTimeMs(boostEndTime);
    const now = Date.now();

    if (startMs && now < startMs) {
        const mins = Math.max(1, Math.ceil((startMs - now) / 60000));
        return { phase: 'UPCOMING', text: `boost in ${mins}min` };
    }

    if (endMs && now > endMs) {
        return null;
    }

    return { phase: 'ACTIVE', text: 'boosted' };
};

/** PP 奖励档位徽章：星级 | PP/hr | 收益率×100；tier=0 时退回到 nextTier 用虚线"即将"样式
 *  尺寸与 SportsTimeBadge 一致；着色按收益率（yieldValue×100）从绿（低）→ 橙（高）渐变 */
const PointsBadge = ({ tier, hourlyRate, nextTier, nextHourlyRate, yieldValue }) => {
    const isUpcoming = !tier && !!nextTier;
    const t = tier || nextTier || 0;
    const hr = hourlyRate || (isUpcoming ? nextHourlyRate : 0) || 0;
    if (!t) return null;

    // yieldValue 只在 active 段有意义（基于当前订单簿深度）
    const yieldX100 = (!isUpcoming && typeof yieldValue === 'number' && Number.isFinite(yieldValue))
        ? yieldValue * 100
        : null;
    const yieldText = yieldX100 !== null
        ? (yieldX100 < 0.01 ? yieldX100.toExponential(1) : yieldX100.toFixed(1))
        : null;

    // 收益率越大 = 越好挂 = 越值得关注 → 偏橙；越小 → 偏绿
    const yieldStyle = (() => {
        if (yieldX100 === null) {
            return 'bg-[#F5C7A8] text-[#1A1915] border-[#D97757]/50';
        }
        if (yieldX100 >= 1.0)  return 'bg-[#D97757] text-[#1A1915] border-[#1A1915]/40 shadow-[0_2px_8px_rgba(217,119,87,0.45)]';
        if (yieldX100 >= 0.4)  return 'bg-[#F5C7A8] text-[#1A1915] border-[#D97757]/50';
        if (yieldX100 >= 0.15) return 'bg-amber-300 text-[#1A1915] border-amber-600/55';
        if (yieldX100 >= 0.05) return 'bg-lime-400 text-[#1A1915] border-lime-700/55';
        return 'bg-emerald-500 text-white border-emerald-700/55';
    })();

    const upcomingStyle = 'bg-white/55 text-[#6B665C] border-dashed border-[#D97757]/45';
    const styleClass = isUpcoming ? upcomingStyle : yieldStyle;

    const titleText = isUpcoming
        ? `即将激活：${t}★ ${hr} PP/hr`
        : `${t}★ ${hr} PP/hr${yieldX100 !== null ? ` | 收益率×100 = ${yieldX100.toFixed(4)}\n公式：hourlyRate ÷ 加权深度 × 100\n  加权深度 = Σᵢ (bid_i_sz + ask_i_sz) × (1, 1/3, 1/9)\n  仅 |price − mid| ≤ spreadThreshold (PP 有效区间，通常 ±6¢) 的档位计入\n  单位：PP/hr/share × 100` : ''}`;

    return (
        <span
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg border-2 text-sm font-bold tracking-wide ${styleClass}`}
            title={titleText}
        >
            {isUpcoming ? '→ ' : ''}{hr}/h{yieldText !== null ? ` | ${yieldText}` : ''}
        </span>
    );
};

/** Boost badge：未开始显示倒计时，开始后显示闪烁金色 boosted。 */
const BoostCountdown = ({ boostStartTime, boostEndTime }) => {
    const [state, setState] = useState(() => getBoostBadgeState(boostStartTime, boostEndTime));

    useEffect(() => {
        const update = () => setState(getBoostBadgeState(boostStartTime, boostEndTime));
        update();
        const timer = setInterval(update, 30000);
        return () => clearInterval(timer);
    }, [boostStartTime, boostEndTime]);

    if (!state) return null;

    const isActive = state.phase === 'ACTIVE';
    const className = isActive
        ? 'text-[10px] px-1.5 py-0.5 rounded bg-[#7A3F2A]/15 border border-[#D97757]/45 text-[#D97757] font-bold tracking-wide lowercase animate-pulse-slow'
        : 'text-[10px] px-1.5 py-0.5 rounded bg-[#7A3F2A]/15 border border-[#D97757]/45 text-[#C7654A] font-semibold tracking-wide lowercase';

    return (
        <span className={className}>
            {state.text}
        </span>
    );
};

const parseGameStartMs = (value) => {
    if (!value) return null;
    const ts = Date.parse(value);
    return Number.isNaN(ts) ? null : ts;
};

const getGameStartMeta = (gameStartTime, nowMs) => {
    const startMs = parseGameStartMs(gameStartTime);
    if (!startMs) {
        return { hasStart: false, isStarted: false, countdownText: '' };
    }
    const diffMs = startMs - nowMs;
    if (diffMs <= 0) {
        return { hasStart: true, isStarted: true, countdownText: '' };
    }
    const mins = Math.max(1, Math.ceil(diffMs / 60000));
    return { hasStart: true, isStarted: false, countdownText: `start in ${mins} mins` };
};

const useGameStartMeta = (gameStartTime) => {
    const [nowMs, setNowMs] = useState(Date.now());

    useEffect(() => {
        setNowMs(Date.now());
        if (!gameStartTime) return;
        const timer = setInterval(() => setNowMs(Date.now()), 30000);
        return () => clearInterval(timer);
    }, [gameStartTime]);

    return useMemo(() => getGameStartMeta(gameStartTime, nowMs), [gameStartTime, nowMs]);
};

// 与 Hedge 卡片同款的高亮时间/Live 标签：Live=红色脉冲、≤3min=深橙、其它=浅橙
const SportsTimeBadge = ({ gameStartTime }) => {
    const [nowMs, setNowMs] = useState(Date.now());
    useEffect(() => {
        if (!gameStartTime) return;
        const timer = setInterval(() => setNowMs(Date.now()), 30000);
        return () => clearInterval(timer);
    }, [gameStartTime]);

    const startMs = parseGameStartMs(gameStartTime);
    if (!startMs) return null;

    const diffMin = Math.round((startMs - nowMs) / 60000);
    const isLive = diffMin <= 0 && diffMin > -60 * 6; // 比赛进行中（开赛后 6 小时内视作直播）
    const isUrgent = diffMin > 0 && diffMin <= 3;

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
};

const Badge = ({ children, variant = 'default', icon }) => {
    const styles = {
        default: "bg-white/50 text-[#6B665C] border-black/[0.08]",
        success: "bg-emerald-500/10 text-[#1A1915] border-emerald-500/20",
        warning: "bg-[#D97757]/12 text-[#C7654A] border-[#D97757]/25",
        danger: "bg-rose-500/10 text-rose-400 border-rose-500/20",
        inverted: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    };
    return (
        <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-mono font-medium tracking-wide border ${styles[variant]} backdrop-blur-sm flex items-center gap-1`}>
            {icon && <Icon name={icon} size={10} />}
            {children}
        </span>
    );
};

/**
 * ExpiryCountdown - 显示任务倒计时 (时:分:秒)
 */
const ExpiryCountdown = ({ expiresAt, compact = false }) => {
    const [remaining, setRemaining] = useState('');

    useEffect(() => {
        if (!expiresAt) return;

        const update = () => {
            const diff = expiresAt - Date.now();
            if (diff <= 0) {
                setRemaining('00:00:00');
                return;
            }
            const hours = Math.floor(diff / (1000 * 60 * 60));
            const mins = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const secs = Math.floor((diff % (1000 * 60)) / 1000);
            // 格式: HH:MM:SS
            const pad = (n) => String(n).padStart(2, '0');
            setRemaining(`${pad(hours)}:${pad(mins)}:${pad(secs)}`);
        };

        update();
        const interval = setInterval(update, 1000);
        return () => clearInterval(interval);
    }, [expiresAt]);

    if (!expiresAt) return null;

    const isExpiring = expiresAt - Date.now() < 10 * 60 * 1000; // < 10 minutes

    return (
        <span className={`font-mono ${compact ? 'text-[10px]' : 'text-xs'} ${isExpiring ? 'text-rose-400' : 'text-[#C7654A]'}`}>
            {remaining}
        </span>
    );
};

/**
 * ExpirySelector - 任务过期时间选择器
 * 闹钟图标 + 倒计时显示，点击设置/取消定时
 */
const ExpirySelector = ({ taskId, currentExpiresAt, onUpdate, apiBaseUrl, taskApiBaseUrl }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [hours, setHours] = useState('');
    const [loading, setLoading] = useState(false);
    const [confirmCancel, setConfirmCancel] = useState(false);
    const inputRef = useRef(null);

    // 自动聚焦输入框
    useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isEditing]);

    // 设置定时
    const handleSetExpiry = async () => {
        const h = parseFloat(hours);
        if (isNaN(h) || h <= 0 || h > 72) {
            setIsEditing(false);
            setHours('');
            return;
        }
        setLoading(true);
        try {
            const expiresAt = Date.now() + h * 60 * 60 * 1000;
            const res = await fetch(`${taskApiBaseUrl || apiBaseUrl}/api/tasks/${taskId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ expiresAt }),
            });
            if (res.ok && onUpdate) {
                onUpdate({ expiresAt });
            }
        } catch (e) {
            console.error('Failed to set expiry:', e);
        } finally {
            setLoading(false);
            setIsEditing(false);
            setHours('');
        }
    };

    // 取消定时
    const handleCancelExpiry = async () => {
        if (!confirmCancel) {
            setConfirmCancel(true);
            // 3秒后自动取消确认状态
            setTimeout(() => setConfirmCancel(false), 3000);
            return;
        }
        setLoading(true);
        try {
            const res = await fetch(`${taskApiBaseUrl || apiBaseUrl}/api/tasks/${taskId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ expiresAt: null }),
            });
            if (res.ok && onUpdate) {
                onUpdate({ expiresAt: null });
            }
        } catch (e) {
            console.error('Failed to cancel expiry:', e);
        } finally {
            setLoading(false);
            setConfirmCancel(false);
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            handleSetExpiry();
        } else if (e.key === 'Escape') {
            setIsEditing(false);
            setHours('');
        }
    };

    // 编辑模式：显示输入框
    if (isEditing) {
        return (
            <div className="flex flex-col items-start">
                <span className="text-[#8B847A] text-[10px] mb-0.5">定时</span>
                <div className="flex items-center gap-1">
                    <input
                        ref={inputRef}
                        type="number"
                        min="0.1"
                        max="72"
                        step="0.5"
                        value={hours}
                        onChange={(e) => setHours(e.target.value)}
                        onKeyDown={handleKeyDown}
                        onBlur={() => { if (!hours) setIsEditing(false); }}
                        placeholder="H"
                        className="w-10 px-1 py-0.5 rounded bg-white/65 border border-black/15 text-[#1A1915] text-[10px] font-mono text-center focus:outline-none focus:border-[#D97757]"
                        disabled={loading}
                    />
                    <button
                        onClick={handleSetExpiry}
                        disabled={loading || !hours}
                        className="px-1 py-0.5 rounded bg-[#D97757] text-[#1A1915] text-[10px] font-medium hover:brightness-110 disabled:opacity-50"
                    >
                        ✓
                    </button>
                </div>
            </div>
        );
    }

    // 已有定时：计时器图标 + 倒计时，点击取消
    if (currentExpiresAt) {
        return (
            <div className="flex flex-col items-start">
                <span className="text-[#8B847A] text-[10px] mb-0.5">定时</span>
                <div className="flex items-center gap-1">
                    <button
                        onClick={handleCancelExpiry}
                        disabled={loading}
                        className={`text-base hover:scale-110 transition-transform ${
                            confirmCancel ? 'animate-pulse' : ''
                        }`}
                        title={confirmCancel ? '再次点击确认取消' : '点击取消定时'}
                    >
                        {confirmCancel ? '❌' : '⏲'}
                    </button>
                    <ExpiryCountdown expiresAt={currentExpiresAt} compact />
                </div>
                {confirmCancel && (
                    <span className="text-[10px] text-rose-400 mt-0.5">点击确认取消</span>
                )}
            </div>
        );
    }

    // 默认：显示计时器图标
    return (
        <div className="flex flex-col items-start">
            <span className="text-[#8B847A] text-[10px] mb-0.5">定时</span>
            <button
                onClick={() => setIsEditing(true)}
                className="text-base hover:scale-110 transition-transform"
                title="设置定时 (0-72小时)"
            >
                ⏲
            </button>
        </div>
    );
};

const Card = ({ children, className = '', noPadding = false }) => (
    <div className={`glass-card rounded-xl transition-all duration-300 hover:border-white/50 ${className}`}>
        <div className={noPadding ? '' : 'p-6'}>{children}</div>
    </div>
);

const RiskIndicator = ({ level, score }) => {
    const colors = { LOW: 'bg-emerald-500', MED: 'bg-yellow-500', HIGH: 'bg-rose-500' };
    const textColors = { LOW: 'text-[#1A1915]', MED: 'text-yellow-400', HIGH: 'text-rose-400' };
    return (
        <div className="flex flex-col gap-1">
            <div className="flex justify-between text-[10px] uppercase tracking-wide text-[#8B847A]">
                <span>Risk</span>
                <span className={textColors[level]}>{level} ({score})</span>
            </div>
            <div className="h-1.5 w-24 bg-white/65 rounded-full overflow-hidden border border-black/[0.08]">
                <div className={`h-full ${colors[level]} transition-all duration-500`} style={{ width: `${score}%` }} />
            </div>
        </div>
    );
};

const DepthIndicator = ({ depth }) => (
    <div className="flex items-center gap-2">
        <span className="text-xs font-bold text-[#8B847A]">可吃深度:</span>
        <FlashValue value={depth}>
            <span className="text-base font-mono text-blue-400">{Number(depth).toFixed(1)} shares</span>
        </FlashValue>
    </div>
);

const StatCard = ({ title, value, subValue, icon }) => (
    <Card className="flex flex-col justify-between h-full group hover:bg-white/45 backdrop-blur-lg">
        <div className="flex justify-between items-start mb-4">
            <div className="text-[#8B847A] text-xs font-medium tracking-wide uppercase">{title}</div>
            <div className="p-2 rounded-lg bg-white/50 border border-black/[0.08] group-hover:border-[#D97757]/35 transition-colors">
                <Icon name={icon} size={18} className="text-[#8B847A] group-hover:text-[#B85A3F] transition-colors" />
            </div>
        </div>
        <div>
            <div className="text-3xl font-display font-medium text-[#1A1915] tracking-tight mb-1">{value}</div>
            {subValue && <div className="text-xs text-[#8B847A]">{subValue}</div>}
        </div>
    </Card>
);

/**
 * 生成 Predict URL slug
 * 规则: 转小写 -> 移除特殊字符 -> 空格转连字符
 */
const generatePredictSlug = (title) => {
    if (!title) return null;
    return title
        .toLowerCase()
        .replace(/@/g, 'at')           // @ 转 at (体育比赛格式)
        .replace(/[^a-z0-9 -]/g, '')   // 移除所有特殊字符，保留字母、数字、空格、连字符
        .replace(/ +/g, '-')            // 空格转连字符
        .replace(/-+/g, '-')            // 合并多个连字符
        .replace(/^-|-$/g, '');         // 移除首尾连字符
};

/**
 * 从 Polymarket market slug 提取 event slug
 * market slug 格式: nba-xxx-xxx-YYYY-MM-DD[-spread-home-3pt5]
 * event slug 格式: nba-xxx-xxx-YYYY-MM-DD
 * 对于非体育市场，直接返回原 slug
 */
const extractPolymarketEventSlug = (slug) => {
    if (!slug) return slug;
    // 匹配体育赛事格式: sport-team1-team2-YYYY-MM-DD
    const match = slug.match(/^([a-z]+-[a-z]+-[a-z]+-\d{4}-\d{2}-\d{2})/i);
    return match ? match[1] : slug;
};

// Predict 图标 base64 (PNG 格式)
const PREDICT_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADkAAAA5CAMAAAC7xnO3AAAAgVBMVEVuV/kfKjcgKzptVvZ0Wv9tV/gZJykcKDByWf8aJyweKTVwWP5vWPxEP5NJQqBrVfIYJiZnU+hMQ6VCPo8pMFEiLEBgT9g0NmsxNGQtMllkUeFbTMpUSLpQRrA7Onw5OXhTR7ZNRalIQZs3N3IkLURpVOxdTdA/PIYoL00mLklbTMcw7QOKAAAB20lEQVRIx+3VyXKjMBAGYFB3q7WZJQaMF7zbceb9H3DwSCGcjDjMIVX+L1hV/mghWiJ5553/EgIgf/E/YgNgERU8L31UEouJFG66j6Y35S7Lujuhg6iCSm0PQkpxWFxqLaU01TlXEZTUfcU6FSLVUhvRJ2X52CJMVzyx7v/d54l8BPNxipJt2HgwjjC8nZgwYCbFSPQJVas8odfyWPxII1lyoDJ7PV9KqB2K8tfpT1cFyhW8LkouX3OgokGFtwf7wfSTqiY4uceccuyk8MMzQjJBV1oMT0aurE240aTET+nlB0LSUz97oVeKpuRiLEFd/BS4tTMlHvxQt2q21F5eFMySNCzYEmNl6BqoOP1Xcxct9QoBALfsO7EuI1eoD58QsVyziHudQXrafu6v7AemsRQlA5XS+N4rFn3JGXLYnsXKEU3L5SCDN8XFb7FoKcIBJjLbwxmStZZSm2q5QaJkhuT1rjtnxwbQQoQb77ITqjkfBwLV8nff5gBAMS6cft8Hz3qDlESH7JnTEE4zFU1B7YrRe9R3C7ES91r8UJlhvFwU9QCF3EVLcptrwWyeYS7aOSukNofq61rX9fWxXuZuDrVI+a0sy1vu0MNoColz1lrnQvPMwj7JO78vfwHSjxmwHfr8iwAAAABJRU5ErkJggg==';

// Polymarket 图标 base64
const POLYMARKET_ICON = 'data:image/x-icon;base64,AAABAAEAMDAAAAEAIACoJQAAFgAAACgAAAAwAAAAYAAAAAEAIAAAAAAAACQAAAAAAAAAAAAAAAAAAAAAAAD/XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XDD//1ww//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XTD//l4y//5fMf//XC3//1su//1dL//+XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9dMP//XjH//18z//9dMP//Vyr//FIi//hSIv/0XTT/9F80//taLP/+XS///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9dMf//XjL//10y//9bLf//VCX//FAg//pYLP/2b0f/85R2//fEs//55uD/9OXc//ZrQv//WCv//10w//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///10w//9eMf//XjL//10w//9WKP/+USL/+lQl//VgOP/zhGP/86+X//fXyv/5+Pb/+v////7//////v7//P////R/Xf//VCX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///10x//9eM//+XjH//1or//5UJP/8USH/91gr//h3UP/1mHz/98m4//ns6P/7/f3//P////z////9/////f////39/f///fz//f////J+Xf//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XTD//14y//9eMv//XC///1Yo//xPIf/1VCX/9WY+//OEZf/1uKH/9dzS//f6+f/7////////////////////+/////n18v/439P/8qKL//PJu////////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///l4w//9eMf/+WCv//VMj//tRIv/5Wy//9nZT//Sih//0ybv/+/Lt//z//v/+/////f////3//////////P78//ns5P/zv6//9pl7//VtRv/7Wy7/9kUS//SwnP///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL//+XS///VYo//hTJf/0a0T/8o5u//a4pf/55dz/+fr3//z////9/////f/////////9////+PTx//bUx//1q5P/83tZ//ZiN//3UiP//FIi//9YKv//XzP/+FMj//S1ov///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9dMf//Vyj/9YFd//XTxv/68/D//v///////v/9//////////v////7+/r/+ubf//W9qv/0jnH/925G//lUJ//9USH//1Um//9aLf/+XzL//l8y//9dMP//XzL/+FEg//S0of///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/8UCL/9L2t//z//////Pz///39///9/f/7+ff/8ca3//Saf//1dE3/+lwx//lUJv/9VCT//1kr//9eMf//XzL//14x//9dMP//XC///1wv//9cL///XzL/+FEg//S0of///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9eMv/7USH/8bys/////////Pv//v38///9/f/7+fb/8MW2//SNbv/4ckr/91ku//tUJP/9VyX//los//9eMf//XjP//10x//9cL///XC///1wv//9cL///XzL/+FEg//S0of///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8L6u/////////fz//////////////////f////v////6/Pn/9N7T//W7pv/zh2n/92g+//pUJv/+UCD//1Yn//9bLv//XjL//14y//9dMP//XzL/+FEg//S0of///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////69vT/7aSN//a5p//46eP/+/78//z////9/////v////7////8////+/Tv//TMvv/0pYv/83lU//ddLv/6UyP//VIi//5YKf//YDT/+FMk//S1ov///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////59vP/7mc+//lMHP/2YjX/9HtW//apj//20cP/9vLu//3///////7///////7////7////+fv5//nm3f/1vKv/9I9w//ZtRf/6Vyr/90US//SwnP///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////59/P/8XJM//9aLP//XC///1Yn//5RIv/5VCb/82tD//WMb//2uaX/+eXc//v69//9/////f////7//////////f////f08v/41Mj/8aKJ//HGt////////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////49/T/8nBJ//9XKf//XjH//10x//9fMv//XjH//lgq//1TIv/5UiL/+Fww//V4Uf/zo4r/88q7//v07//+/////v////7////9////+f////3//v///v7//f////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////49/T/8nBJ//9XKf//XTD//1wv//9cL///XC///10x//9eMv//XjL//1wv//9XKf/+UyP/+1Yn//hkOv/1f1v/9KuV//DZzv/7+/r///38///+/v///v7//f////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////49/T/8nBJ//9XKf//XTD//1wv//9cL///XC///10w//9eMv//XjL//1wv//9YKf/+UyP/+1Yn//hkOv/0flr/9KuV//DZz//6+/r///38///+/v///v7//f////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////49/T/8nBJ//9XKf//XjH//14x//9eMv//XjH//1gq//1TIf/4UiL/+Fww//V4UP/zo4n/88q6//r07//+/////v////7////9////+v////3//v///v7//f////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////49/P/8XJM//9aLP//XC///1Un//5RIv/6VCb/9WtE//SMb//1uaX/+eXd//v6+P/9/////f////7//////////f////f08v/31cn/8KGH//HGuP///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////59vP/7mY9//lMG//3YjX/9HlW//apj//30sT/9vLt//3///////////////7////8////+vv5//rm3f/0u6r/9I9w//VtRP/5Vyr/90YS//SwnP///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8b2t///////69vX/7KWN//e5p//56eL/+/38//z////+/////v////3////8/////PTv//TMvv/1poz/83lV//hdLv/6UyP//VIi//9YKf/+YDT/+FMk//S1ov///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7USH/8L6u/////////fz//////////////////P////v////6/Pr/897U//S6pP/zhmj/9mg+//pUJv/+UCD//1Yn//9bL///XjL//14y//9dMP//XzL/+FEg//S0of///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9eMv/7USH/8bys/////////Pv//v38///9/f/7+fb/8MW2//SNbv/4ckr/9lkt//xUI//9Vib//Vot//9eMf//XjP//10x//9cL///XC///1wv//9cL///XzL/+FEg//S0of///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9fMv/7UCH/9L2t//3//////Pz///39///9/f/7+ff/8cW3//SagP/2dE7/+V0w//pVJf/9VCT//1kr//9eMf//XzL//14x//9dMP//XC///1wv//9cL///XzL/+FEg//S0of///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9dMf/+Vyf/9YFd//bTx//79PD//v///////v/9/////v////v////7+/n/+ubf//a8qv/0j3H/925G//hUJ//9UCH//1Um//9aLf/+XzL//l8y//9dMP//XzL/+FEg//S0of///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XTD//lYp//hTJv/0a0T/8Y5u//a5pf/45dv/+fr3//z////9/////f/////////8////+PTx//bUx//2qpL/83tZ//ZiNv/4UiL//VEi//9YKv//XzP/+FMj//S1ov///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///l0x//5eMf/+WCv//VMj//xSIv/5Wy//93VS//Wih//0ybv/+/Lt//z//v/9/////f////7////+/////P79//rr4//yvq7/9pl7//VsR//7Wy7/9kUS//SwnP///////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XTD//14y//9eMv//XC///1Yo//1QIf/2VCX/9mY+//OEZf/1uKL/9tvS//f6+f/7////////////////////+v////n18v/43tT/8qKM//LJu////////P////J+Xv//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///10x//9fM///XjH//1or//5UJP/9USH/91gs//d2UP/0l3z/98m5//ns5//8/Pz//f////z////9/////f////z9/f///fz//P////J+Xf//VSX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///10w//9eMf//XzL//10v//9WKP/9USH/+VMk//dgN//0g2L/866X//bYy//4+PX/+f////7//////v7//f////R/Xf//VCX//14x//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9dMf//XjL//l0y//9bLf//VCX//FAh//pYLP/3b0f/8pR1//fEs//45t//9Obc//ZsQ//+WCv//10w//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cMP//XjH//18y//9dL///Vyr//FIi//lSIv/0XTT/9F81//paLP/+XS///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XTD//l4y//5fMf//XC3//1su//5dL//+XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XDD//1ww//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv//9cL///XC///1wv/wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/**
 * ViewLinks - 平台导航按钮组件
 * 提供 Predict 和 Polymarket 的外链按钮
 * @param predictSlug - 后端提供的验证过的 slug（优先使用）
 * @param sportsTeams - 体育市场专用搜索词（球队名，如 "Bulls Rockets"）
 */
const ViewLinks = ({ predictId, predictSlug: backendSlug, polymarketSlug, polymarketConditionId, title, sportsTeams, size = 'sm' }) => {
    // Predict URL: 优先使用后端缓存的 slug，否则从标题生成
    // 格式: https://predict.fun/market/{slug}
    const predictSlug = backendSlug || generatePredictSlug(title);
    const predictUrl = predictSlug
        ? `https://predict.fun/market/${predictSlug}`
        : null;

    // Polymarket URL: 优先使用后端提供的 slug，否则回退到搜索
    // 格式: https://polymarket.com/event/{eventSlug}
    // 注意: 体育市场的 slug 可能是 market slug (含 -spread-/-totals- 等后缀)，需要提取 event slug
    let polymarketUrl = null;
    if (polymarketSlug) {
        const eventSlug = extractPolymarketEventSlug(polymarketSlug);
        polymarketUrl = `https://polymarket.com/event/${eventSlug}`;
    } else {
        // Fallback: 使用搜索
        const searchTerm = sportsTeams || title;
        polymarketUrl = searchTerm
            ? `https://polymarket.com/markets?_q=${encodeURIComponent(searchTerm.substring(0, 50))}`
            : (polymarketConditionId ? `https://polymarket.com/markets?_q=${polymarketConditionId.substring(0, 16)}` : null);
    }

    // 图标尺寸: 放大 30% (原 16px -> 21px)
    const iconSize = size === 'sm' ? 21 : 26;
    // 边框风格统一为 border-2，与结算时间徽章一致
    const buttonClass = 'p-1 rounded-lg bg-white/50 border-2 border-black/[0.12] hover:border-black/30 hover:bg-white/75 transition-all group';

    return (
        <div className="flex items-center gap-1.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            {/* Predict Link */}
            {predictUrl && (
                <a
                    href={predictUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonClass}
                    title="View on Predict.fun"
                >
                    <img
                        src={PREDICT_ICON}
                        alt="Predict"
                        style={{ width: iconSize, height: iconSize }}
                        className="opacity-80 group-hover:opacity-100 transition-opacity"
                    />
                </a>
            )}
            {/* Polymarket Link */}
            {polymarketUrl && (
                <a
                    href={polymarketUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonClass}
                    title="View on Polymarket"
                >
                    <img
                        src={POLYMARKET_ICON}
                        alt="Polymarket"
                        style={{ width: iconSize, height: iconSize }}
                        className="opacity-80 group-hover:opacity-100 transition-opacity"
                    />
                </a>
            )}
        </div>
    );
};

// 高亮 negRisk 多选市场标题中的 outcome 名称 (来自 Gamma API groupItemTitle)
const HighlightedTitle = ({ title, outcome }) => {
    if (!outcome || !title) return title;
    // 在标题中查找 outcome 文本并高亮
    const idx = title.toLowerCase().indexOf(outcome.toLowerCase());
    if (idx < 0) return title;
    const matchedText = title.slice(idx, idx + outcome.length);
    return (
        <>
            {title.slice(0, idx)}
            <span className="text-[#C7654A]">{matchedText}</span>
            {title.slice(idx + outcome.length)}
        </>
    );
};

const OpportunityCard = React.memo(({ opp, onOpenTaskModal, activeTask, onArchive }) => {
    const isBoosted = Boolean(opp.boosted || opp.boostStartTime || opp.boostEndTime);
    // FIX: 所有套利开仓都应该是 BUY 类型任务
    // arbSide 字段控制买 YES 还是 NO (YES端: 买YES, NO端: 买NO)
    // SELL 类型仅用于平仓现有持仓，不用于套利开仓
    const primaryTaskType = 'BUY';
    const primaryIsBuy = true;

    // 任务标签颜色: BUY=绿色, CLOSE=红色
    const ribbonColor = activeTask?.type === 'CLOSE' ? '#ef4444' : '#10b981';
    const ribbonText = activeTask?.type === 'CLOSE' ? 'CLOSE' : 'BUY';

    return (
        <div className="group">
            <div className={`glass-card rounded-xl transition-all duration-300 overflow-hidden h-full relative
                ${isBoosted ? 'border-2 border-[#C7654A]/70 shadow-[0_0_12px_rgba(217,119,87,0.18)]' : 'border border-black/5'}
                hover:border-white/50 hover:scale-[1.005]`}>

                {/* 任务标签 (斜角丝带) */}
                {activeTask && (
                    <div
                        className="absolute top-2 -left-7 transform -rotate-45 text-[9px] font-semibold uppercase tracking-wider text-[#1A1915] px-8 py-0.5 z-10 pointer-events-none"
                        style={{ background: ribbonColor }}
                    >
                        {ribbonText}
                    </div>
                )}

                {/* Header */}
                <div className="p-5">
                    {/* 第一行: 标题 + 导航按钮 | profit */}
                    <div className="flex items-center justify-between mb-2 gap-2">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                            <h3 className="text-base font-medium text-[#1A1915] line-clamp-2 min-w-0 flex-1">
                                <HighlightedTitle title={opp.title} outcome={opp.outcome} />
                            </h3>
                            <ViewLinks
                                predictId={opp.marketId}
                                predictSlug={opp.predictSlug}
                                polymarketSlug={opp.polymarketSlug}
                                polymarketConditionId={opp.polymarketConditionId}
                                title={opp.title}
                            />
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                            <FlashValue value={opp.estimatedProfit}>
                                <div className="text-xl font-display font-semibold tracking-tight text-[#1A1915]">
                                    +${opp.estimatedProfit.toFixed(2)}
                                    <span className="text-xs ml-1 opacity-70">({opp.profitPercent.toFixed(1)}%)</span>
                                </div>
                            </FlashValue>
                        </div>
                    </div>
                    {/* 第二行: 全部 badges */}
                    <div className="flex flex-wrap items-center gap-2 mb-3">
                        {opp.isInverted && <Badge variant="inverted" icon="arrow-left-right">INV</Badge>}
                        {isBoosted && <BoostCountdown boostStartTime={opp.boostStartTime} boostEndTime={opp.boostEndTime} />}
                        <PointsBadge
                            tier={opp.pointsTier}
                            hourlyRate={opp.pointsHourlyRate}
                            nextTier={opp.pointsNextTier}
                            nextHourlyRate={opp.pointsNextHourlyRate}
                            yieldValue={opp.pointsYield}
                        />
                        {opp.endDate && (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg border-2 border-black/[0.12] bg-white/65 text-[#6B665C] text-sm font-bold tracking-wide">
                                <Icon name="clock" size={13} />
                                {new Date(opp.endDate).toLocaleDateString()}
                            </span>
                        )}
                        {onArchive && (
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onArchive(opp.marketId, opp.title); }}
                                title="归档：将此市场排除出 自动 PP"
                                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg border-2 border-black/[0.12] bg-white/55 backdrop-blur-md text-[#8B847A] hover:bg-rose-50 hover:text-rose-600 hover:border-rose-300/50 transition-colors text-sm font-bold tracking-wide">
                                <Icon name="archive" size={13} />
                                <span>归档</span>
                            </button>
                        )}
                    </div>

                    {/* Price Cards Row - Always Visible */}
                    <div className="grid grid-cols-2 gap-3 mb-3">
                        {/* Predict Card */}
                        <div className="p-3 rounded-lg border border-black/5 bg-white/45 backdrop-blur-lg">
                            <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                    <div className="w-5 h-5 rounded bg-blue-500/20 flex items-center justify-center">
                                        <span className="text-[10px] font-bold text-blue-400">P</span>
                                    </div>
                                    <span className="text-xs text-[#6B665C]">Predict</span>
                                </div>
                                {opp.predictVolume ? (
                                    <div className="text-right">
                                        <span className="text-[10px] text-[#8B847A] font-mono">vol: </span>
                                        <span className="font-mono text-xs text-[#D97757]">${opp.predictVolume >= 1000000 ? (opp.predictVolume / 1_000_000).toFixed(1) + 'M' : opp.predictVolume >= 1000 ? (opp.predictVolume / 1000).toFixed(1) + 'K' : opp.predictVolume.toFixed(0)}</span>
                                    </div>
                                ) : null}
                            </div>
                            <div className="space-y-1">
                                <div className="flex justify-between items-center gap-2">
                                    <span className={`text-[10px] ${opp.strategy === 'TAKER' ? 'text-[#B85A3F]' : 'text-[#8B847A]'}`}>{opp.side === 'NO' ? 'NO_ASK' : 'YES_ASK'}</span>
                                    <FlashValue value={opp.depth.predictAskDepth}>
                                        <span className="text-[10px] text-[#D97757] font-mono">{opp.depth.predictAskDepth.toFixed(0)} shares</span>
                                    </FlashValue>
                                    <FlashValue value={opp.predictAsk}>
                                        <span className="font-mono text-sm text-[#D97757]">{(opp.predictAsk * 100).toFixed(1)}¢</span>
                                    </FlashValue>
                                </div>
                                <div className="flex justify-between items-center gap-2">
                                    <span className={`text-[10px] ${opp.strategy === 'PREDICT_MAKER' ? 'text-[#B85A3F]' : 'text-[#8B847A]'}`}>{opp.side === 'NO' ? 'NO_BID' : 'YES_BID'}</span>
                                    <FlashValue value={opp.depth.predictBidDepth}>
                                        <span className="text-[10px] text-[#D97757] font-mono">{opp.depth.predictBidDepth.toFixed(0)} shares</span>
                                    </FlashValue>
                                    <FlashValue value={opp.predictBid}>
                                        <span className="font-mono text-sm text-[#D97757]">{(opp.predictBid * 100).toFixed(1)}¢</span>
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
                                    <span className="text-xs text-[#6B665C]">Polymarket</span>
                                </div>
                                {opp.polyVolume ? (
                                    <div className="text-right">
                                        <span className="text-[10px] text-[#8B847A] font-mono">vol: </span>
                                        <span className="font-mono text-xs text-[#D97757]">${(opp.polyVolume / 1_000_000).toFixed(1)}M</span>
                                    </div>
                                ) : null}
                            </div>
                            <div className="space-y-1">
                                <div className="flex justify-between items-center gap-2">
                                    <span className="text-[10px] text-blue-400">{opp.side === 'NO' ? 'ASK (YES)' : 'ASK (NO)'}</span>
                                    <FlashValue value={opp.depth.polymarketNoAskDepth}>
                                        <span className="text-[10px] text-[#D97757] font-mono">{opp.depth.polymarketNoAskDepth.toFixed(0)} shares</span>
                                    </FlashValue>
                                    <FlashValue value={opp.polymarketPrice}>
                                        <span className="font-mono text-sm text-[#D97757]">{(opp.polymarketPrice * 100).toFixed(1)}¢</span>
                                    </FlashValue>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Bottom Row: Meta Info */}
                    {(() => {
                        // 后端 arb-service.ts 已经把 makerCost/takerCost 转换为美分单位
                        // 例如 95.0 = 95.0¢ = $0.95，不需要再乘以100
                        const makerTotal = opp.makerCost || 0;
                        const takerTotal = opp.takerCost || 0;
                        const getColorClass = (val) => val < 100 ? 'text-[#D97757]' : val === 100 ? 'text-[#C7654A]' : 'text-rose-400';
                        return (
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-6 font-mono">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-bold text-[#8B847A]">挂单成本:</span>
                                        <FlashValue value={makerTotal}>
                                            <span className={`text-base font-semibold ${getColorClass(makerTotal)}`}>{makerTotal.toFixed(1)}¢</span>
                                        </FlashValue>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs font-bold text-[#8B847A]">吃单成本:</span>
                                        <FlashValue value={takerTotal}>
                                            <span className={`text-base font-semibold ${getColorClass(takerTotal)}`}>{takerTotal.toFixed(1)}¢</span>
                                        </FlashValue>
                                    </div>
                                </div>
                                <div className="flex items-center">
                                    <DepthIndicator depth={opp.maxQuantity} />
                                </div>
                            </div>
                        );
                    })()}

                    {/* Buy Button - Always Visible */}
                    <div className="flex gap-2 mt-3" onClick={(e) => e.stopPropagation()}>
                        <button
                            onClick={() => onOpenTaskModal && onOpenTaskModal(opp, primaryTaskType)}
                            className={`flex-1 h-10 rounded-lg text-[#1A1915] font-medium text-sm hover:brightness-110 hover:shadow-glow-button active:scale-[0.98] transition-all duration-200 flex items-center justify-center gap-2 ${primaryIsBuy ? 'bg-emerald-500' : 'bg-rose-500'}`}>
                            <Icon name={primaryIsBuy ? "arrow-down-circle" : "arrow-up-circle"} size={16} strokeWidth={2} />
                            {primaryIsBuy ? 'Buy' : 'Sell'}
                        </button>
                    </div>
                </div>

            </div>
        </div>
    );
}, (prevProps, nextProps) => {
    // 浅比较关键渲染字段，避免不必要的重渲染
    const p = prevProps.opp, n = nextProps.opp;
    return p.id === n.id
        && p.estimatedProfit === n.estimatedProfit
        && p.profitPercent === n.profitPercent
        && p.predictAsk === n.predictAsk
        && p.predictBid === n.predictBid
        && p.polymarketPrice === n.polymarketPrice
        && p.maxQuantity === n.maxQuantity
        && p.makerCost === n.makerCost
        && p.takerCost === n.takerCost
        && p.strategy === n.strategy
        && p.depth?.predictAskDepth === n.depth?.predictAskDepth
        && p.depth?.predictBidDepth === n.depth?.predictBidDepth
        && p.depth?.polymarketNoAskDepth === n.depth?.polymarketNoAskDepth
        && prevProps.activeTask?.id === nextProps.activeTask?.id
        && prevProps.activeTask?.status === nextProps.activeTask?.status;
});

const FilterBar = ({ filters, setFilters, onReset }) => (
    <div className="flex flex-col md:flex-row gap-4 items-center justify-between mb-6 p-4 rounded-xl border border-black/5 bg-white/35 backdrop-blur-md backdrop-blur-sm">
        <div className="flex items-center gap-4 w-full md:w-auto overflow-x-auto pb-2 md:pb-0">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-black/[0.08] bg-white/55 backdrop-blur-md text-xs font-medium text-[#8B847A] whitespace-nowrap">
                <Icon name="filter" size={14} />
                <span>Strategy:</span>
                <select value={filters.strategy} onChange={(e) => setFilters({ ...filters, strategy: e.target.value })}
                    className="bg-white/55 backdrop-blur-xl border border-black/[0.12] rounded px-2 py-0.5 outline-none text-[#1A1915] cursor-pointer"
                    style={{ colorScheme: 'dark' }}>
                    <option value="ALL" className="bg-white/55 backdrop-blur-xl text-[#1A1915]">All</option>
                    <option value="PREDICT_MAKER" className="bg-white/55 backdrop-blur-xl text-[#1A1915]">P. 挂单</option>
                    <option value="TAKER" className="bg-white/55 backdrop-blur-xl text-[#1A1915]">M. 挂单</option>
                </select>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-black/[0.08] bg-white/55 backdrop-blur-md text-xs font-medium text-[#8B847A] whitespace-nowrap">
                <Icon name="arrow-up-down" size={14} />
                <span>Sort:</span>
                <select value={filters.sortBy} onChange={(e) => setFilters({ ...filters, sortBy: e.target.value })}
                    className="bg-white/55 backdrop-blur-xl border border-black/[0.12] rounded px-2 py-0.5 outline-none text-[#1A1915] cursor-pointer"
                    style={{ colorScheme: 'dark' }}>
                    <option value="PROFIT" className="bg-white/55 backdrop-blur-xl text-[#1A1915]">利润$ ↓</option>
                    <option value="PROFIT_PCT" className="bg-white/55 backdrop-blur-xl text-[#1A1915]">利润% ↓</option>
                    <option value="SETTLEMENT" className="bg-white/55 backdrop-blur-xl text-[#1A1915]">结算时间 ↑</option>
                    <option value="DEPTH" className="bg-white/55 backdrop-blur-xl text-[#1A1915]">深度 ↓</option>
                    <option value="PP_YIELD" className="bg-white/55 backdrop-blur-xl text-[#1A1915]">PP 收益率 ↓ (易挂在前)</option>
                </select>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-black/[0.08] bg-white/55 backdrop-blur-md text-xs font-medium text-[#8B847A] whitespace-nowrap">
                <Icon name="layers" size={14} />
                <span>深度≥</span>
                <input type="number" value={filters.minDepth ?? ''} placeholder="0"
                    onChange={(e) => setFilters({ ...filters, minDepth: e.target.value })}
                    className="bg-transparent border-none outline-none text-[#1A1915] placeholder-[#A39C8E] w-14 text-xs [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
                {filters.minDepth !== '' && Number(filters.minDepth) > 0 && (
                    <button onClick={() => setFilters({ ...filters, minDepth: '' })} className="text-[#8B847A] hover:text-[#1A1915]">
                        <Icon name="x" size={12} />
                    </button>
                )}
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-black/[0.08] bg-white/55 backdrop-blur-md text-xs font-medium text-[#8B847A] whitespace-nowrap">
                <Icon name="search" size={14} />
                <input type="text" value={filters.searchQuery || ''} placeholder="搜索市场..."
                    onChange={(e) => setFilters({ ...filters, searchQuery: e.target.value })}
                    className="bg-transparent border-none outline-none text-[#1A1915] placeholder-[#A39C8E] w-32 text-xs" />
                {filters.searchQuery && (
                    <button onClick={() => setFilters({ ...filters, searchQuery: '' })} className="text-[#8B847A] hover:text-[#1A1915]">
                        <Icon name="x" size={12} />
                    </button>
                )}
            </div>
        </div>
        <button onClick={onReset} className="text-xs text-[#8B847A] hover:text-[#1A1915] underline decoration-dotted transition-colors whitespace-nowrap">
            Reset
        </button>
    </div>
);

const HistoryTable = ({ history }) => (
    <Card className="overflow-hidden" noPadding>
        <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
                <thead>
                    <tr className="border-b border-black/5 bg-white/45 backdrop-blur-lg text-[10px] uppercase tracking-wide text-[#8B847A]">
                        <th className="p-4 font-medium">Time</th>
                        <th className="p-4 font-medium">Market</th>
                        <th className="p-4 font-medium">Strategy</th>
                        <th className="p-4 font-medium text-right">PnL</th>
                        <th className="p-4 font-medium">Status</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-black/[0.06]/50">
                    {history.map((record) => (
                        <tr key={record.id} className="hover:bg-white/5 transition-colors">
                            <td className="p-4 text-xs font-mono text-[#8B847A] whitespace-nowrap">
                                {new Date(record.timestamp).toLocaleTimeString()}
                            </td>
                            <td className="p-4">
                                <div className="text-xs font-medium text-[#1A1915] truncate max-w-[200px]">{record.title}</div>
                                <div className="text-[10px] text-[#8B847A]">#{record.marketId}</div>
                            </td>
                            <td className="p-4"><Badge>{record.strategy}</Badge></td>
                            <td className="p-4 text-right">
                                <div className={`text-sm font-mono font-medium ${record.realizedProfit > 0 ? 'text-[#1A1915]' : 'text-[#8B847A]'}`}>
                                    {record.realizedProfit > 0 ? '+' : ''}${record.realizedProfit?.toFixed(2)}
                                </div>
                            </td>
                            <td className="p-4">
                                <span className={`text-[10px] font-bold uppercase tracking-wide
                                    ${record.status === 'EXECUTED' ? 'text-[#1A1915]' : record.status === 'FAILED' ? 'text-rose-400' : 'text-[#8B847A]'}`}>
                                    {record.status}
                                </span>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    </Card>
);

// Task Status Badge
const TaskStatusBadge = ({ status }) => {
    const colors = {
        'PENDING': 'bg-white/65 text-[#6B665C] border-black/[0.12]',
        'VALIDATING': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
        'PREDICT_SUBMITTED': 'bg-[#D97757]/12 text-[#C7654A] border-[#D97757]/25',
        'PARTIALLY_FILLED': 'bg-[#D97757]/12 text-[#C7654A] border-[#D97757]/25',
        'PAUSED': 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
        'HEDGING': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
        'HEDGE_PENDING': 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
        'HEDGE_RETRY': 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
        'HEDGE_FAILED': 'bg-rose-500/10 text-rose-400 border-rose-500/20',
        'HEDGE_FAILED_GTC_PENDING': 'bg-[#D97757]/22 text-[#C7654A] border-[#D97757]/35 animate-pulse',
        'LOSS_HEDGE': 'bg-orange-500/20 text-orange-400 border-orange-500/30 animate-pulse',
        'COMPLETED': 'bg-emerald-500/10 text-[#1A1915] border-emerald-500/20',
        'FAILED': 'bg-rose-500/10 text-rose-400 border-rose-500/20',
        'CANCELLED': 'bg-white/65 text-[#8B847A] border-black/[0.12]',
        'TIMEOUT_CANCELLED': 'bg-white/65 text-[#8B847A] border-black/[0.12]',
        'UNWINDING': 'bg-purple-500/10 text-purple-400 border-purple-500/20',
        'UNWIND_PENDING': 'bg-purple-500/10 text-purple-400 border-purple-500/20',
        'UNWIND_COMPLETED': 'bg-purple-500/10 text-purple-400 border-purple-500/20',
    };

    // 状态中文映射
    const statusLabels = {
        'PENDING': '待执行',
        'VALIDATING': '校验中',
        'PREDICT_SUBMITTED': 'Predict 已挂单',
        'PARTIALLY_FILLED': '部分成交',
        'PAUSED': '已暂停',
        'HEDGING': '对冲中',
        'HEDGE_PENDING': '对冲等待',
        'HEDGE_RETRY': '对冲重试',
        'HEDGE_FAILED': '对冲失败',
        'HEDGE_FAILED_GTC_PENDING': '⏳ GTC 保底挂单中',
        'LOSS_HEDGE': '⚠️ 亏损对冲',
        'COMPLETED': '已完成',
        'FAILED': '失败',
        'CANCELLED': '已取消',
        'TIMEOUT_CANCELLED': '超时取消',
        'UNWINDING': '反向平仓中',
        'UNWIND_PENDING': '准备平仓',
        'UNWIND_COMPLETED': '平仓完成',
    };

    return (
        <span className={`text-[10px] px-2 py-1 rounded border font-medium ${colors[status] || colors['PENDING']}`}>
            {statusLabels[status] || status}
        </span>
    );
};

// Tasks Tab Component
const TasksTab = ({
    tasks,
    onStart,
    onCancel,
    onCancelAll,
    onStopCancelAll,
    batchCancelStatus,
    batchCancelLoading,
    onViewLogs,
    onUpdateTask,
    apiBaseUrl,
    taskApiBaseUrl,
}) => {
    const terminalStatuses = ['COMPLETED', 'FAILED', 'CANCELLED', 'UNWIND_COMPLETED'];
    const activeTasks = tasks.filter(t => !terminalStatuses.includes(t.status));
    const completedTasks = tasks.filter(t => terminalStatuses.includes(t.status));
    const batchState = batchCancelStatus?.state || 'IDLE';
    const batchRequested = batchCancelStatus?.requested || 0;
    const batchAttempted = batchCancelStatus?.attempted || 0;
    const batchProgress = batchRequested > 0
        ? Math.max(0, Math.min(100, (batchAttempted / batchRequested) * 100))
        : 0;
    const batchBusy = batchState === 'RUNNING' || batchState === 'STOPPING';
    const showBatchSummary = batchRequested > 0 && batchState !== 'IDLE';

    return (
        <div className="space-y-6">
            {/* Active Tasks */}
            <div>
                <div className="flex items-center justify-between mb-4 px-1">
                    <h3 className="font-display text-sm font-medium text-[#1A1915] flex items-center gap-2">
                        <Icon name="play-circle" size={16} className="text-[#B85A3F]" />
                        活跃任务
                    </h3>
                    <div className="flex items-center gap-3">
                        <div className="text-xs text-[#8B847A] font-mono">{activeTasks.length} 个任务</div>
                        <button
                            onClick={() => onCancelAll && onCancelAll()}
                            disabled={!onCancelAll || activeTasks.length === 0 || batchBusy || batchCancelLoading}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                                !onCancelAll || activeTasks.length === 0 || batchBusy || batchCancelLoading
                                    ? 'bg-white/55 backdrop-blur-xl text-[#A39C8E] cursor-not-allowed'
                                    : 'bg-rose-500/15 text-rose-300 border border-rose-500/30 hover:bg-rose-500/25'
                            }`}>
                            {batchCancelLoading ? '提交中...' : 'Cancel All'}
                        </button>
                        {batchBusy && (
                            <button
                                onClick={() => onStopCancelAll && onStopCancelAll()}
                                disabled={!onStopCancelAll || batchCancelLoading}
                                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                                    !onStopCancelAll || batchCancelLoading
                                        ? 'bg-white/55 backdrop-blur-xl text-[#A39C8E] cursor-not-allowed'
                                        : 'bg-white/65 text-[#3A342C] hover:bg-white/75'
                                }`}>
                                停止
                            </button>
                        )}
                    </div>
                </div>

                {showBatchSummary && (
                    <div className="mb-4 rounded-2xl border border-black/[0.08] bg-white/70 backdrop-blur-xl p-4">
                        <div className="flex items-start justify-between gap-4 mb-3">
                            <div>
                                <div className="text-xs font-medium text-[#6B665C]">
                                    批量取消 {batchState === 'COMPLETED' ? '已完成' : batchState === 'STOPPED' ? '已停止' : batchState === 'FAILED' ? '失败' : batchState === 'STOPPING' ? '停止中' : '进行中'}
                                </div>
                                <div className="text-sm text-[#1A1915] font-medium mt-1">
                                    {batchAttempted}/{batchRequested} 已处理
                                    <span className="text-[#8B847A] font-mono ml-2">{batchCancelStatus?.minTaskIntervalMs || 1000}ms / task</span>
                                </div>
                            </div>
                            <div className="text-right text-xs font-mono text-[#6B665C]">
                                <div>取消 {batchCancelStatus?.cancelled || 0}</div>
                                <div>跳过 {batchCancelStatus?.skipped || 0}</div>
                                <div>失败 {batchCancelStatus?.failed || 0}</div>
                            </div>
                        </div>
                        <div className="h-2 rounded-full bg-white/55 backdrop-blur-xl overflow-hidden">
                            <div
                                className={`h-full transition-all ${batchState === 'FAILED' ? 'bg-rose-500' : 'bg-[#D97757]'}`}
                                style={{ width: `${batchProgress}%` }}
                            />
                        </div>
                        {batchCancelStatus?.current && (
                            <div className="mt-3 text-xs text-[#6B665C]">
                                当前任务:
                                <span className="text-[#1A1915] ml-2">{batchCancelStatus.current.index}/{batchCancelStatus.current.total}</span>
                                <span className="text-[#8B847A] ml-2 truncate inline-block max-w-[42rem] align-bottom" title={batchCancelStatus.current.title}>
                                    {batchCancelStatus.current.title}
                                </span>
                            </div>
                        )}
                        {batchCancelStatus?.error && (
                            <div className="mt-3 text-xs text-rose-400 bg-rose-500/10 rounded-lg px-3 py-2">
                                {batchCancelStatus.error}
                            </div>
                        )}
                    </div>
                )}

                {activeTasks.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 rounded-2xl border border-dashed border-black/[0.08] bg-white/35 backdrop-blur-md">
                        <Icon name="inbox" size={40} className="text-[#A39C8E] mb-4" strokeWidth={1} />
                        <p className="text-sm text-[#6B665C]">暂无活跃任务</p>
                        <p className="text-xs text-[#8B847A] mt-1">在机会卡片上点击 Buy/Sell 创建任务</p>
                    </div>
                ) : (
                    <div className="space-y-3">
                        {activeTasks.map(task => (
                            <div key={task.id} className="glass-card rounded-xl p-4 border border-black/5 hover:border-black/[0.08] transition-all">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-2">
                                            <span className={`text-xs font-bold ${task.type === 'BUY' ? 'text-[#1A1915]' : 'text-rose-400'}`}>
                                                {task.type}
                                            </span>
                                            <span className={`text-[10px] px-1.5 py-0.5 rounded ${task.arbSide === 'YES' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'}`}>
                                                {task.arbSide}
                                            </span>
                                            <TaskStatusBadge status={task.status} />
                                            <span className="text-xs font-mono text-[#8B847A]">#{task.marketId}</span>
                                            <ViewLinks
                                                predictId={task.marketId}
                                                predictSlug={task.predictSlug}
                                                polymarketSlug={task.polymarketSlug}
                                                polymarketConditionId={task.polymarketConditionId}
                                                title={task.title}
                                            />
                                        </div>
                                        <h4 className="text-sm text-[#1A1915] font-medium leading-tight mb-2" title={task.title}>{task.title}</h4>
                                        <div className="grid grid-cols-4 gap-4 text-xs">
                                            <div>
                                                <span className="text-[#8B847A]">Predict</span>
                                                <div className="text-[#1A1915] font-mono">{(task.predictPrice * 100).toFixed(1)}¢</div>
                                            </div>
                                            <div>
                                                <span className="text-[#8B847A]">数量</span>
                                                <div className="text-[#1A1915] font-mono">
                                                    {task.quantity}
                                                    {task.totalQuantity > 0 && task.quantity !== task.totalQuantity && (
                                                        <span className="text-[#8B847A] text-[10px] ml-1" title="原始数量">
                                                            / {task.totalQuantity}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                            <div>
                                                <ExpirySelector
                                                    taskId={task.id}
                                                    currentExpiresAt={task.expiresAt}
                                                    onUpdate={(update) => onUpdateTask && onUpdateTask(task.id, update)}
                                                    apiBaseUrl={apiBaseUrl}
                                                    taskApiBaseUrl={taskApiBaseUrl}
                                                />
                                            </div>
                                            <div>
                                                <span className="text-[#8B847A]">已成交</span>
                                                <div className="text-[#1A1915] font-mono">{task.strategy === 'POLY_MAKER' ? (task.polyFilledQty || 0) : (task.predictFilledQty || 0)}</div>
                                            </div>
                                        </div>
                                        {task.error && (
                                            task.error.startsWith('幽灵深度') ? (
                                                <div className="mt-2 text-xs rounded px-2 py-1.5 border border-[#D97757]/35 bg-[#D97757]/12 text-[#C7654A] flex items-center gap-1.5">
                                                    <span className="text-base leading-none">👻</span>
                                                    <span>{task.error}</span>
                                                </div>
                                            ) : (
                                                <div className="mt-2 text-xs text-rose-400 bg-rose-500/10 rounded px-2 py-1">
                                                    {task.error}
                                                </div>
                                            )
                                        )}
                                    </div>
                                    <div className="flex flex-col gap-2">
                                        {task.status === 'PENDING' && (
                                            <button
                                                onClick={() => onStart(task.id)}
                                                className="px-3 py-1.5 rounded-lg bg-emerald-500 text-[#1A1915] text-xs font-medium hover:brightness-110 transition-all">
                                                启动
                                            </button>
                                        )}
                                        <button
                                            onClick={() => onViewLogs && onViewLogs(task.id)}
                                            className="px-3 py-1.5 rounded-lg bg-white/65 text-[#6B665C] text-xs font-medium hover:bg-[#D97757]/22 hover:text-[#C7654A] transition-all flex items-center gap-1">
                                            <Icon name="file-text" size={12} />
                                            日志
                                        </button>
                                        <button
                                            onClick={() => onCancel(task.id)}
                                            className="px-3 py-1.5 rounded-lg bg-white/65 text-[#6B665C] text-xs font-medium hover:bg-white/75 hover:text-[#1A1915] transition-all">
                                            取消
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Completed Tasks */}
            {completedTasks.length > 0 && (
                <div>
                    <div className="flex items-center justify-between mb-4 px-1">
                        <h3 className="font-display text-sm font-medium text-[#6B665C] flex items-center gap-2">
                            <Icon name="check-circle" size={16} className="text-[#8B847A]" />
                            历史任务
                        </h3>
                        <div className="text-xs text-[#8B847A] font-mono">{completedTasks.length} 个任务</div>
                    </div>
                    <div className="space-y-2">
                        {completedTasks.slice(0, 10).map(task => (
                            <div key={task.id} className="glass-card rounded-xl p-3 border border-black/[0.08] hover:border-black/[0.08] transition-all group">
                                <div className="flex items-center justify-between gap-4">
                                    <div className="flex items-center gap-3 min-w-0 flex-1">
                                        <span className={`text-xs font-bold ${task.type === 'BUY' ? 'text-[#1A1915]' : 'text-rose-400'}`}>
                                            {task.type}
                                        </span>
                                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${task.arbSide === 'YES' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'}`}>
                                            {task.arbSide}
                                        </span>
                                        <span className="text-xs text-[#3A342C] truncate" title={task.title}>{task.title}</span>
                                        <ViewLinks
                                            predictId={task.marketId}
                                            predictSlug={task.predictSlug}
                                            polymarketSlug={task.polymarketSlug}
                                            polymarketConditionId={task.polymarketConditionId}
                                            title={task.title}
                                        />
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        {task.actualProfit !== undefined && (
                                            <span className={`text-xs font-mono ${task.actualProfit > 0 ? 'text-[#1A1915]' : 'text-rose-400'}`}>
                                                {task.actualProfit > 0 ? '+' : ''}${task.actualProfit.toFixed(2)}
                                            </span>
                                        )}
                                        <TaskStatusBadge status={task.status} />
                                        <button
                                            onClick={() => onViewLogs && onViewLogs(task.id)}
                                            className="px-2 py-1 rounded bg-white/65 text-[#6B665C] text-[10px] font-medium hover:bg-[#D97757]/22 hover:text-[#C7654A] transition-all flex items-center gap-1"
                                            title="查看日志">
                                            <Icon name="file-text" size={12} />
                                            日志
                                        </button>
                                        <button
                                            onClick={() => onCancel(task.id)}
                                            className="p-1 rounded text-[#A39C8E] hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                                            title="删除">
                                            <Icon name="trash-2" size={14} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

// Task Modal Component
const TaskModal = ({ isOpen, onClose, data, onSubmit, accounts, apiBaseUrl, taskApiBaseUrl }) => {
    const [quantity, setQuantity] = useState(10);
    const [predictPriceCents, setPredictPriceCents] = useState(0); // 使用美分单位避免精度问题
    const [priceEdited, setPriceEdited] = useState(false);
    const [isVisible, setIsVisible] = useState(false);
    const [isAnimating, setIsAnimating] = useState(false);
    // 启动失败时保存任务 ID (用于错误恢复)
    const [createdTaskId, setCreatedTaskId] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState(null);
    const [confirmStep, setConfirmStep] = useState(false);  // 二次确认状态
    const [expiryHours, setExpiryHours] = useState('');  // 定时过期（小时）
    const [polyBidPriceCents, setPolyBidPriceCents] = useState(0);  // POLY_MAKER: Polymarket 挂单 bid 价格（美分）

    // 处理打开动画
    useEffect(() => {
        if (isOpen) {
            setIsAnimating(true);
            // 小延迟后开始动画
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    setIsVisible(true);
                });
            });
            // 重置状态
            setCreatedTaskId(null);
            setSubmitError(null);
            setPriceEdited(false);
            setConfirmStep(false);
        }
    }, [isOpen]);

    // 处理关闭动画
    const handleClose = () => {
        setIsVisible(false);
        setTimeout(() => {
            setIsAnimating(false);
            onClose();
        }, 200); // 等待动画完成
    };

    useEffect(() => {
        if (data?.opp) {
            setQuantity(Math.min(data.opp.maxQuantity || 10, 100));
            // 转换为美分并四舍五入，避免浮点精度问题
            // TAKER BUY 使用 ask 价格，PREDICT_MAKER BUY 使用 bid 价格
            const isTaker = data.opp.strategy === 'TAKER';
            const isPolyMakerInit = data.opp.strategy === 'POLY_MAKER';
            const rawPrice = data.type === 'BUY'
                ? (isTaker ? data.opp.predictAsk : data.opp.predictBid)
                : data.opp.predictAsk;
            if (!priceEdited) {
                setPredictPriceCents(Math.round(rawPrice * 1000) / 10); // 精确到0.1美分
            }
            // POLY_MAKER: Polymarket bid 价格 = 当前买一价
            if (isPolyMakerInit) {
                const polyBidDefault = data.opp.polymarketPrice || 0.5;
                setPolyBidPriceCents(Math.round(polyBidDefault * 1000) / 10);
            }
            // 体育 PREDICT_MAKER/POLY_MAKER 任务: 计算默认倒计时 = 开赛前 3 分钟
            if (data.opp.isSportsMarket && !isTaker && data.opp.gameStartTime) {
                const msUntilGame = new Date(data.opp.gameStartTime).getTime() - Date.now() - 3 * 60 * 1000;
                if (msUntilGame > 0) {
                    setExpiryHours((msUntilGame / (60 * 60 * 1000)).toFixed(2));
                } else {
                    setExpiryHours('');
                }
            } else {
                setExpiryHours('');
            }
        }
    }, [data]);

    // 转换回小数形式用于计算
    const predictPrice = predictPriceCents / 100;

    if (!isOpen && !isAnimating) return null;
    if (!data) return null;

    const { opp, type } = data;
    const isTaker = opp.strategy === 'TAKER';
    const isPolyMaker = opp.strategy === 'POLY_MAKER';
    // 始终使用 opp.polymarketPrice，这是对冲方向的 ASK 价格
    // YES 端套利: polymarketPrice = NO ASK (买 NO 对冲)
    // NO 端套利: polymarketPrice = YES ASK (买 YES 对冲)
    const polyPrice = opp.polymarketPrice;
    // POLY_MAKER: 挂单 bid 价格 (用户可编辑)
    const polyBidPrice = polyBidPriceCents / 100;
    // 对冲方向标签
    const polyTokenLabel = opp.side === 'YES' ? 'NO' : 'YES';
    // 用于计算的安全数量值 (空值时视为0)
    const safeQuantity = quantity === '' ? 0 : (parseInt(quantity) || 0);
    // Predict 手续费: feeRate * min(price, 1-price) * (1 - 10%返点)
    const feeRateBps = opp.feeRateBps || 200; // 默认 2%
    const feeRate = feeRateBps / 10000;
    const feeRebate = 0.10; // 10% 返点
    // POLY_MAKER: Predict 侧是 taker 对冲，需要手续费
    // TAKER: Predict 侧也是 taker，需要手续费
    // PREDICT_MAKER: Predict 侧是 maker，无手续费
    const predictFeePerShare = (isTaker || isPolyMaker)
        ? feeRate * Math.min(predictPrice, 1 - predictPrice) * (1 - feeRebate)
        : 0;
    // POLY_MAKER: totalCost = predictPrice(对冲taker) + polyBidPrice(挂单) + predictFee
    // 其他: totalCost = predictPrice + polyPrice + predictFee
    const totalCost = isPolyMaker
        ? (predictPrice + polyBidPrice + predictFeePerShare)
        : (predictPrice + polyPrice + predictFeePerShare);
    const estimatedProfit = (1 - totalCost) * safeQuantity;
    const profitPercent = (1 - totalCost) * 100;

    // 资金占用计算
    // BUY 任务: Predict 买入 YES (需要 predictPrice * qty USDT), Polymarket 买入 NO (需要 polyPrice * qty USDC)
    // SELL 任务: Predict 卖出 YES (需要持仓), Polymarket 卖出 NO (需要持仓)
    // POLY_MAKER: Predict 对冲 taker + Polymarket GTC 挂单
    const needsFunds = type === 'BUY' || (isTaker && type === 'SELL') || isPolyMaker;
    // POLY_MAKER: Polymarket 挂单资金 = polyBidPrice * qty (Maker 无 fee)
    const predictRequired = needsFunds ? predictPrice * safeQuantity : 0;
    const polymarketRequired = needsFunds
        ? (isPolyMaker ? polyBidPrice * safeQuantity : polyPrice * safeQuantity)
        : 0;
    const predictFee = needsFunds ? predictFeePerShare * safeQuantity : 0;

    // 获取账户余额
    const predictBalance = accounts?.predict?.available || 0;
    const polymarketBalance = accounts?.polymarket?.available || 0;

    // 检查资金是否充足 (Predict 需要包含手续费)
    const predictTotalRequired = predictRequired + predictFee;
    const predictInsufficient = needsFunds && predictTotalRequired > predictBalance;
    const polymarketInsufficient = needsFunds && polymarketRequired > polymarketBalance;
    // Polymarket 最小订单限制: $1
    const POLYMARKET_MIN_ORDER = 1.0;
    const polymarketBelowMinimum = needsFunds && polymarketRequired > 0 && polymarketRequired < POLYMARKET_MIN_ORDER;
    const hasSufficientFunds = !predictInsufficient && !polymarketInsufficient && !polymarketBelowMinimum;

    // 验证必需字段
    const missingFields = [];
    if (!opp.polymarketConditionId) missingFields.push('polymarketConditionId');
    if (!opp.polymarketNoTokenId) missingFields.push('polymarketNoTokenId');
    if (!opp.polymarketYesTokenId) missingFields.push('polymarketYesTokenId');
    const hasRequiredFields = missingFields.length === 0;

    // 验证数量有效
    const hasValidQuantity = safeQuantity > 0;

    // 二次确认点击处理
    const handleConfirmClick = () => {
        if (submitting) return;
        if (!confirmStep) {
            // 第一次点击：进入确认状态
            setConfirmStep(true);
            // 3秒后自动取消确认状态
            setTimeout(() => setConfirmStep(false), 3000);
            return;
        }
        // 第二次点击：执行任务
        handleSubmit();
    };

    // 创建任务后自动启动
    const handleSubmit = async () => {
        if (submitting) return;
        setConfirmStep(false);  // 重置确认状态

        // 验证必需字段
        if (!hasRequiredFields) {
            alert(`缺少必需字段: ${missingFields.join(', ')}`);
            return;
        }

        // 基础任务参数
        // PREDICT_MAKER BUY: 套利条件 predictBid + polyAsk < 1.0
        // polymarketMaxAsk = 1.0 - predictBid，超过此价格无套利空间
        // PREDICT_MAKER SELL: polymarketMinBid = predictAsk，低于此价格亏损
        const taskParams = {
            type,
            marketId: opp.marketId,
            title: opp.title,
            predictSlug: opp.predictSlug,
            polymarketSlug: opp.polymarketSlug,
            polymarketConditionId: opp.polymarketConditionId,
            polymarketNoTokenId: opp.polymarketNoTokenId,
            polymarketYesTokenId: opp.polymarketYesTokenId,
            isInverted: opp.isInverted ?? false,
            tickSize: opp.tickSize ?? 0.01,
            negRisk: opp.negRisk ?? false,
            predictPrice,
            polymarketMaxAsk: type === 'BUY' ? Number((1.0 - predictPrice).toFixed(4)) : 0,
            polymarketMinBid: type === 'SELL' ? Number(predictPrice.toFixed(4)) : 0,
            quantity: safeQuantity,
            minProfitBuffer: 0.005,
            orderTimeout: isTaker ? 10000 : 60000,  // TAKER 默认 10 秒超时
            maxHedgeRetries: 3,
            idempotencyKey: `${type}-${opp.marketId}-${Date.now()}`,
            // 策略类型
            strategy: opp.strategy,
            // 套利方向 (YES端: Predict买YES+Poly买NO, NO端: Predict买NO+Poly买YES)
            arbSide: opp.side || 'YES',
            // 体育市场标识 (使用 REST API 而非 WS 获取订单簿)
            isSportsMarket: opp.isSportsMarket || false,
            // 倒计时过期
            ...(expiryHours && parseFloat(expiryHours) > 0 ? { expiryHours: parseFloat(expiryHours) } : {}),
        };

        // TAKER 模式专用字段
        if (isTaker) {
            // 计算 fee (与后端一致)
            const feeRateBps = opp.feeRateBps || 200;
            const baseFeePercent = feeRateBps / 10000;
            const minPrice = Math.min(predictPrice, 1 - predictPrice);
            const predictFee = baseFeePercent * minPrice;

            // maxTotalCost: 固定为 1（只要 totalCost < 1 就是盈利的）
            // 套利原理: predict 赢 + poly 赢 = 1，所以 totalCost < 1 即可保证盈利
            const maxTotalCost = 1;

            taskParams.predictAskPrice = predictPrice;
            taskParams.maxTotalCost = maxTotalCost;
            taskParams.feeRateBps = feeRateBps;
        }

        // POLY_MAKER 模式专用字段
        if (isPolyMaker) {
            taskParams.strategy = 'POLY_MAKER';
            taskParams.polyBidPrice = polyBidPrice;
            taskParams.feeRateBps = feeRateBps;
            // Predict 价格用作对冲参考（非挂单价）
            taskParams.predictAskPrice = predictPrice;
        }

        setSubmitting(true);
        setSubmitError(null);
        try {
            // 单次请求创建并启动任务 (autoStart 避免 SSH 隧道二次 round trip)
            const createRes = await fetch(`${taskApiBaseUrl || apiBaseUrl}/api/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...taskParams, autoStart: true }),
            });
            const createData = await createRes.json();

            if (!createData.success) {
                setSubmitError(createData.error || 'Failed to create task');
                return;
            }

            const taskId = createData.data?.id;
            if (!taskId) {
                setSubmitError('Task created but no ID returned');
                return;
            }

            if (createData.started) {
                handleClose();  // 关闭 Modal
            } else {
                // 任务已创建但启动失败
                setCreatedTaskId(taskId);
                setSubmitError(`任务已创建但启动失败: ${createData.startError || 'Unknown error'}`);
            }
        } catch (error) {
            setSubmitError(error.message);
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className={`fixed inset-0 z-50 flex items-center justify-center transition-all duration-200 ${isVisible ? 'bg-black/35 backdrop-blur-sm' : 'bg-black/0'}`}>
            <div className={`w-full max-w-md mx-4 glass-card rounded-2xl border border-black/[0.08] shadow-2xl transition-all duration-200 ${isVisible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-4'}`}>
                <div className="p-6 border-b border-black/[0.08]">
                    <div className="flex items-center justify-between">
                        <h2 className="font-display text-lg font-semibold text-[#1A1915] flex items-center gap-2">
                            <span className={type === 'BUY' ? 'text-[#1A1915]' : 'text-rose-400'}>{type}</span>
                            任务配置
                            {isPolyMaker && <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/20 border border-purple-500/30 text-purple-400 font-medium">M. 挂单</span>}
                        </h2>
                        <button
                            onClick={handleClose}
                            className="w-8 h-8 rounded-lg bg-white/65 hover:bg-rose-500/20 text-[#6B665C] hover:text-rose-400 transition-all flex items-center justify-center"
                            title="关闭">
                            <Icon name="x" size={18} />
                        </button>
                    </div>
                    <p className="text-sm text-[#6B665C] mt-1 truncate">{opp.title}</p>
                </div>

                <div className="p-6 space-y-4">
                    {/* POLY_MAKER: Polymarket Bid 价格输入（主输入） */}
                    {isPolyMaker && (
                        <div>
                            <label className="block text-xs text-[#8B847A] mb-1">
                                Polymarket 挂单 Bid (美分)
                            </label>
                            <div className="flex items-center gap-2">
                                <input
                                    type="number"
                                    value={polyBidPriceCents}
                                    onChange={(e) => setPolyBidPriceCents(Math.round(parseFloat(e.target.value) * 10) / 10 || 0)}
                                    step="0.1"
                                    min="1"
                                    max="99"
                                    className="flex-1 bg-white/55 backdrop-blur-xl border border-black/[0.12] rounded-lg px-3 py-2 text-[#1A1915] font-mono text-sm focus:outline-none focus:border-purple-500"
                                />
                                <span className="text-purple-400 text-sm font-mono">¢</span>
                            </div>
                            <div className="text-[10px] text-[#A39C8E] mt-1">= ${polyBidPrice.toFixed(4)}</div>
                        </div>
                    )}

                    {/* Predict Price - 使用美分单位 */}
                    <div>
                        <label className="block text-xs text-[#8B847A] mb-1">
                            {isPolyMaker ? 'Predict 对冲价格 (美分)' : `Predict ${type === 'BUY' ? 'Bid' : 'Ask'} 价格 (美分)`}
                        </label>
                        <div className="flex items-center gap-2">
                            <input
                                type="number"
                                value={predictPriceCents}
                                onChange={(e) => {
                                    if (isPolyMaker) return; // POLY_MAKER 时 Predict 价格不可编辑
                                    setPriceEdited(true);
                                    setPredictPriceCents(Math.round(parseFloat(e.target.value) * 10) / 10 || 0);
                                }}
                                disabled={isPolyMaker}
                                step="0.1"
                                min="1"
                                max="99"
                                className={`flex-1 bg-white/55 backdrop-blur-xl border border-black/[0.12] rounded-lg px-3 py-2 font-mono text-sm focus:outline-none ${
                                    isPolyMaker
                                        ? 'text-[#8B847A] cursor-not-allowed'
                                        : 'text-[#1A1915] focus:border-[#D97757]'
                                }`}
                            />
                            <span className={`text-sm font-mono ${isPolyMaker ? 'text-[#8B847A]' : 'text-[#C7654A]'}`}>¢</span>
                        </div>
                        <div className="text-[10px] text-[#A39C8E] mt-1">= ${predictPrice.toFixed(4)}</div>
                    </div>

                    {/* Quantity */}
                    <div>
                        <label className="block text-xs text-[#8B847A] mb-1">数量 (Shares)</label>
                        <input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            value={quantity}
                            onChange={(e) => {
                                const val = e.target.value;
                                // 允许空输入和纯数字
                                if (val === '' || /^\d+$/.test(val)) {
                                    setQuantity(val === '' ? '' : parseInt(val));
                                }
                            }}
                            onBlur={(e) => {
                                // 失焦时如果为空则设为1
                                if (e.target.value === '' || parseInt(e.target.value) < 1) {
                                    setQuantity(1);
                                }
                            }}
                            className="w-full bg-white/55 backdrop-blur-xl border border-black/[0.12] rounded-lg px-3 py-2 text-[#1A1915] font-mono text-sm focus:outline-none focus:border-[#D97757]"
                        />
                        <div className="text-xs text-[#8B847A] mt-1">最大深度: {opp.maxQuantity?.toFixed(0) || '-'} shares</div>
                    </div>

                    {/* 定时过期 (TAKER 不需要) */}
                    {!isTaker && (
                        <div>
                            <label className="block text-xs text-[#8B847A] mb-1">定时过期 (小时)</label>
                            <div className="flex items-center gap-2">
                                <input
                                    type="number"
                                    min="0"
                                    max="72"
                                    step="0.01"
                                    value={expiryHours}
                                    onChange={(e) => setExpiryHours(e.target.value)}
                                    placeholder="留空=不过期"
                                    className="w-full bg-white/55 backdrop-blur-xl border border-black/[0.12] rounded-lg px-3 py-2 text-[#1A1915] font-mono text-sm focus:outline-none focus:border-[#D97757]"
                                />
                                <span className="text-xs text-[#8B847A] whitespace-nowrap">h</span>
                            </div>
                            {expiryHours && parseFloat(expiryHours) > 0 && (
                                <div className="text-[10px] text-[#8B847A] mt-1">
                                    过期时间: {new Date(Date.now() + parseFloat(expiryHours) * 3600000).toLocaleString()}
                                </div>
                            )}
                        </div>
                    )}

                    {/* 资金占用提示 */}
                    {needsFunds && (
                        <div className="bg-white/45 backdrop-blur-lg rounded-lg p-3 border border-black/[0.08] space-y-2">
                            <div className="text-xs text-[#8B847A] font-medium mb-2">资金占用</div>

                            {/* Predict 资金占用 */}
                            <div className="flex justify-between items-center">
                                <div className="flex items-center gap-2">
                                    <div className="w-4 h-4 rounded bg-blue-500/20 flex items-center justify-center">
                                        <span className="text-[8px] font-bold text-blue-400">P</span>
                                    </div>
                                    <span className="text-xs text-[#6B665C]">{isPolyMaker ? 'Predict 对冲' : 'Predict'}</span>
                                    {(isTaker || isPolyMaker) && predictFee > 0 && (
                                        <span className="text-[10px] text-[#8B847A]">
                                            (含fee ${predictFee.toFixed(2)})
                                        </span>
                                    )}
                                </div>
                                <div className="text-right">
                                    <span className={`font-mono text-sm ${predictInsufficient ? 'text-rose-400' : 'text-[#1A1915]'}`}>
                                        ${predictTotalRequired.toFixed(2)}
                                    </span>
                                    <span className="text-xs text-[#8B847A] ml-1">
                                        / ${predictBalance.toFixed(2)}
                                    </span>
                                    {predictInsufficient && (
                                        <span className="text-[10px] text-rose-400 ml-1">不足</span>
                                    )}
                                </div>
                            </div>

                            {/* Polymarket 资金占用 */}
                            <div className="flex justify-between items-center">
                                <div className="flex items-center gap-2">
                                    <div className="w-4 h-4 rounded bg-purple-500/20 flex items-center justify-center">
                                        <span className="text-[8px] font-bold text-purple-400">M</span>
                                    </div>
                                    <span className="text-xs text-[#6B665C]">{isPolyMaker ? 'Poly 挂单' : 'Polymarket'}</span>
                                </div>
                                <div className="text-right">
                                    <span className={`font-mono text-sm ${(polymarketInsufficient || polymarketBelowMinimum) ? 'text-rose-400' : 'text-[#1A1915]'}`}>
                                        ${polymarketRequired.toFixed(2)}
                                    </span>
                                    <span className="text-xs text-[#8B847A] ml-1">
                                        / ${polymarketBalance.toFixed(2)}
                                    </span>
                                    {polymarketInsufficient && (
                                        <span className="text-[10px] text-rose-400 ml-1">不足</span>
                                    )}
                                    {polymarketBelowMinimum && (
                                        <span className="text-[10px] text-rose-400 ml-1">最小$1</span>
                                    )}
                                </div>
                            </div>

                            {/* 总计 */}
                            <div className="flex justify-between items-center pt-2 border-t border-black/[0.08]">
                                <span className="text-xs text-[#6B665C]">总计</span>
                                <span className={`font-mono text-sm font-medium ${!hasSufficientFunds ? 'text-rose-400' : 'text-[#C7654A]'}`}>
                                    ${(predictTotalRequired + polymarketRequired).toFixed(2)}
                                </span>
                            </div>
                        </div>
                    )}

                    {/* Polymarket Price (readonly) */}
                    <div>
                        <label className="block text-xs text-[#8B847A] mb-1">
                            {isPolyMaker
                                ? `Polymarket ${polyTokenLabel} ASK (参考价)`
                                : `Polymarket ${polyTokenLabel} ASK (对冲买入价)`
                            }
                        </label>
                        <div className="bg-white/45 backdrop-blur-lg border border-black/[0.08] rounded-lg px-3 py-2 text-[#6B665C] font-mono text-sm">
                            {(polyPrice * 100).toFixed(1)}¢
                            {isPolyMaker && <span className="text-[10px] text-[#A39C8E] ml-2">挂单 bid: {polyBidPriceCents.toFixed(1)}¢</span>}
                        </div>
                    </div>

                    {/* Estimated Profit */}
                    <div className="bg-white/45 backdrop-blur-lg rounded-lg p-3 border border-black/[0.08]">
                        <div className="flex justify-between text-sm">
                            <span className="text-[#8B847A]">预估利润</span>
                            <span className={estimatedProfit > 0 ? 'text-[#1A1915] font-medium' : 'text-rose-400'}>
                                {estimatedProfit > 0 ? '+' : ''}${estimatedProfit.toFixed(2)} ({profitPercent.toFixed(2)}%)
                            </span>
                        </div>
                    </div>
                </div>

                {/* 错误提示 */}
                {submitError && (
                    <div className="px-6 py-2 bg-rose-500/10 border-t border-rose-500/30">
                        <p className="text-sm text-rose-400">{submitError}</p>
                    </div>
                )}

                <div className="p-6 border-t border-black/[0.08] flex gap-3">
                    <button
                        onClick={handleClose}
                        disabled={submitting}
                        className="flex-1 py-2.5 rounded-lg bg-white/65 text-[#6B665C] font-medium text-sm hover:bg-white/75 hover:text-[#1A1915] transition-all disabled:opacity-50">
                        取消
                    </button>
                    <button
                        onClick={handleConfirmClick}
                        disabled={submitting || (!hasRequiredFields || !hasValidQuantity || (needsFunds && !hasSufficientFunds))}
                        className={`flex-1 py-2.5 rounded-lg font-medium text-sm text-[#1A1915] transition-all ${
                            submitting || (!hasRequiredFields || !hasValidQuantity || (needsFunds && !hasSufficientFunds))
                                ? 'bg-white/70 cursor-not-allowed opacity-50'
                                : confirmStep
                                    ? 'bg-[#D97757] hover:brightness-110 animate-pulse'
                                    : type === 'BUY'
                                        ? 'bg-emerald-500 hover:brightness-110'
                                        : 'bg-rose-500 hover:brightness-110'
                        }`}>
                        {submitting
                            ? '执行中...'
                            : !hasRequiredFields
                                ? '数据不完整'
                                : !hasValidQuantity
                                    ? '请输入数量'
                                    : (needsFunds && !hasSufficientFunds)
                                        ? '资金不足'
                                        : confirmStep
                                            ? '确认'
                                            : '创建任务'
                        }
                    </button>
                </div>
            </div>
        </div>
    );
};

const formatAutoPreviewTime = (value) => {
    if (!value) return '--';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '--';
    return parsed.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
};

const formatSkippedReason = (reason) => {
    const labels = {
        invalid_profit: '利润数据无效',
        live_profit_non_positive: 'Live 盈利需大于 0',
        sports_profit_negative: 'Sports 盈利需大于等于 0',
        invalid_price: '价格无效',
        price_out_of_range: '价格不在 0.2-0.8',
        depth_below_100: '深度小于 100',
        active_task_exists: '已有同向活跃任务',
        missing_game_start_time: '缺少开赛时间',
        sports_starting_soon: '体育比赛小于 5 分钟开赛',
        missing_end_date: '缺少结算时间',
        expiry_already_passed: '过期时间已失效',
        predict_budget_too_small: 'Predict 预算不足',
        polymarket_task_budget_too_small: 'Polymarket 单任务预算不足',
        below_polymarket_minimum: 'Polymarket 最小下单额不足',
    };
    return labels[reason] || reason;
};

const formatAutoCreateLogDetails = (details) => {
    if (!details) return '';
    try {
        return JSON.stringify(details, null, 2);
    } catch (error) {
        return `{"error":"log_details_format_failed","message":"${error.message}"}`;
    }
};

const getAutoCreateLogLevelClass = (level) => {
    if (level === 'ERROR') return 'text-rose-300 border-rose-500/20 bg-rose-500/10';
    if (level === 'WARN') return 'text-[#D97757] border-[#D97757]/25 bg-[#D97757]/12';
    return 'text-[#2A2520] border-black/[0.08] bg-white/65 backdrop-blur-xl';
};

const MAX_VISIBLE_AUTO_PREVIEW_CANDIDATES = 60;
const MAX_VISIBLE_AUTO_CREATE_LOGS = 40;

const AutoTaskPreviewModal = ({
    isOpen,
    onClose,
    loading,
    creating,
    error,
    result,
    createStatus,
    source,
    onRefresh,
    onCreate,
    onPause,
    onResume,
    onStop,
}) => {
    const skippedEntries = Object.entries(result?.summary?.skipped || {})
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
    const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
    const batchStatus = createStatus || { state: 'IDLE', requested: 0, attempted: 0, created: 0, started: 0, failed: 0, logs: [], tasks: [] };
    const requested = Number(batchStatus?.requested || 0);
    const attempted = Number(batchStatus?.attempted || 0);
    const progressPercent = requested > 0 ? Math.max(0, Math.min(100, (attempted / requested) * 100)) : 0;
    const isBatchRunning = ['RUNNING', 'STOPPING'].includes(batchStatus?.state);
    const isBatchPaused = batchStatus?.state === 'PAUSED';
    const isBatchTerminal = ['COMPLETED', 'FAILED', 'STOPPED'].includes(batchStatus?.state);
    const previewSource = result?.source || source || 'all';
    const previewSourceLabel = previewSource === 'sports'
        ? 'SPORTS Panel'
        : previewSource === 'all'
            ? 'ALL Panel'
            : 'Mixed Pool';
    const logEntries = Array.isArray(batchStatus?.logs)
        ? batchStatus.logs.slice(-MAX_VISIBLE_AUTO_CREATE_LOGS)
        : [];
    const logContainerRef = useRef(null);
    const [showBatchLogs, setShowBatchLogs] = useState(false);
    const [progressCollapsed, setProgressCollapsed] = useState(false);
    const [showAllCandidates, setShowAllCandidates] = useState(false);
    const visibleCandidates = showAllCandidates
        ? candidates
        : candidates.slice(0, MAX_VISIBLE_AUTO_PREVIEW_CANDIDATES);
    const hiddenCandidateCount = Math.max(0, candidates.length - visibleCandidates.length);

    useEffect(() => {
        if (!showBatchLogs || !logContainerRef.current) return;
        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }, [logEntries.length, showBatchLogs]);

    useEffect(() => {
        if (batchStatus?.jobId) {
            setShowBatchLogs(false);
        }
    }, [batchStatus?.jobId]);

    useEffect(() => {
        setShowAllCandidates(false);
    }, [result?.generatedAt, previewSource]);

    if (!isOpen) return null;

    return ReactDOM.createPortal(
        <div className="fixed inset-0 z-[70] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
            <div
                className="w-full max-w-5xl max-h-[90vh] overflow-hidden rounded-2xl border border-black/[0.08] bg-white/75 backdrop-blur-xl shadow-2xl flex flex-col"
                onClick={(event) => event.stopPropagation()}>
                <div className="px-6 py-4 border-b border-black/[0.08] flex items-start justify-between gap-4">
                    <div>
                        <div className="flex items-center gap-2 mb-1">
                            <Icon name="list" size={18} className="text-[#C7654A]" />
                            <h3 className="text-lg font-semibold text-[#1A1915]">批量创建预览</h3>
                            <span className="text-[10px] px-2 py-0.5 rounded-full border border-[#D97757]/35 bg-[#D97757]/12 text-[#D97757] font-mono">
                                {previewSourceLabel}
                            </span>
                        </div>
                        <p className="text-sm text-[#8B847A]">
                            先输出建议列表。点击"批量创建并启动"后，会按顺序执行 create + start，默认每 2 秒处理 1 条，并实时输出日志。
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {onCreate && (
                            <button
                                onClick={onCreate}
                                disabled={loading || creating || candidates.length === 0 || isBatchRunning || isBatchPaused}
                                className="px-3 py-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-[#1A1915] text-sm hover:bg-emerald-500/20 transition-colors disabled:opacity-50">
                                {creating && !isBatchRunning && !isBatchPaused ? '提交中...' : '批量创建并启动'}
                            </button>
                        )}
                        {isBatchRunning && onPause && (
                            <button
                                onClick={onPause}
                                disabled={creating || batchStatus?.pendingAction === 'pause' || batchStatus?.state === 'STOPPING'}
                                className="px-3 py-2 rounded-lg border border-[#D97757]/35 bg-[#D97757]/12 text-[#D97757] text-sm hover:bg-[#D97757]/22 transition-colors disabled:opacity-50">
                                {batchStatus?.pendingAction === 'pause' ? '暂停中...' : '暂停创建'}
                            </button>
                        )}
                        {isBatchPaused && onResume && (
                            <button
                                onClick={onResume}
                                disabled={creating}
                                className="px-3 py-2 rounded-lg border border-sky-500/30 bg-sky-500/10 text-sky-300 text-sm hover:bg-sky-500/20 transition-colors disabled:opacity-50">
                                继续创建
                            </button>
                        )}
                        {(isBatchRunning || isBatchPaused) && onStop && (
                            <button
                                onClick={onStop}
                                disabled={creating || batchStatus?.pendingAction === 'stop' || batchStatus?.state === 'STOPPING'}
                                className="px-3 py-2 rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-300 text-sm hover:bg-rose-500/20 transition-colors disabled:opacity-50">
                                {batchStatus?.pendingAction === 'stop' || batchStatus?.state === 'STOPPING' ? '停止中...' : '停止创建'}
                            </button>
                        )}
                        {onRefresh && (
                            <button
                                onClick={onRefresh}
                                disabled={loading || creating || isBatchRunning || isBatchPaused}
                                className="px-3 py-2 rounded-lg border border-black/[0.12] bg-white/55 backdrop-blur-xl text-[#3A342C] text-sm hover:bg-white/65 transition-colors disabled:opacity-50">
                                {loading ? '计算中...' : '刷新预览'}
                            </button>
                        )}
                        <button
                            onClick={onClose}
                            className="w-9 h-9 rounded-lg bg-white/55 backdrop-blur-xl text-[#6B665C] hover:bg-white/65 hover:text-[#1A1915] transition-colors flex items-center justify-center">
                            <Icon name="x" size={18} />
                        </button>
                    </div>
                </div>

                <div className="px-6 py-4 border-b border-black/[0.08] bg-white/40 backdrop-blur-md">
                    {(requested > 0 || isBatchTerminal || isBatchRunning || isBatchPaused) && (
                        <div className="mb-4 rounded-xl border border-black/[0.08] bg-white/70 backdrop-blur-xl p-4">
                            <div
                                className="flex flex-wrap items-center justify-between gap-2 mb-3 cursor-pointer select-none"
                                onClick={() => setProgressCollapsed((v) => !v)}
                            >
                                <div className="flex items-center gap-2">
                                    <Icon name={progressCollapsed ? 'chevron-right' : 'chevron-down'} size={14} className="text-[#8B847A]" />
                                    <div>
                                        <div className="text-xs text-[#8B847A] mb-1">批量创建进度</div>
                                        <div className="text-sm font-medium text-[#1A1915]">
                                            {batchStatus?.state === 'RUNNING' && '进行中'}
                                            {batchStatus?.state === 'PAUSED' && '已暂停'}
                                            {batchStatus?.state === 'STOPPING' && '停止中'}
                                            {batchStatus?.state === 'COMPLETED' && '已完成'}
                                            {batchStatus?.state === 'STOPPED' && '已停止'}
                                            {batchStatus?.state === 'FAILED' && '执行失败'}
                                            {batchStatus?.state === 'IDLE' && '未开始'}
                                        </div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-3">
                                    <div className="text-xs font-mono text-[#6B665C]">
                                        {attempted} / {requested || '--'}
                                    </div>
                                    {progressCollapsed && (
                                        <div className="flex items-center gap-2 text-[11px] font-mono">
                                            <span className="text-[#1A1915]">{batchStatus?.created || 0} 创建</span>
                                            {(batchStatus?.failed || 0) > 0 && <span className="text-rose-300">{batchStatus.failed} 失败</span>}
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div className="h-2 rounded-full bg-white/55 backdrop-blur-xl overflow-hidden">
                                <div
                                    className="h-full rounded-full bg-emerald-400 transition-all duration-300"
                                    style={{ width: `${progressPercent}%` }}
                                />
                            </div>
                            {!progressCollapsed && (
                                <>
                                    <div className="mt-3 grid grid-cols-3 gap-3 text-xs">
                                        <div className="rounded-lg border border-black/[0.08] bg-white/45 backdrop-blur-lg px-3 py-2">
                                            <div className="text-[#8B847A] mb-1">已创建</div>
                                            <div className="font-mono text-[#1A1915]">{batchStatus?.created || 0}</div>
                                        </div>
                                        <div className="rounded-lg border border-black/[0.08] bg-white/45 backdrop-blur-lg px-3 py-2">
                                            <div className="text-[#8B847A] mb-1">{batchStatus?.autoStart ? '已启动' : '待启动'}</div>
                                            <div className="font-mono text-sky-300">
                                                {batchStatus?.autoStart
                                                    ? (batchStatus?.started || 0)
                                                    : Math.max(0, (batchStatus?.created || 0) - (batchStatus?.failed || 0))}
                                            </div>
                                        </div>
                                        <div className="rounded-lg border border-black/[0.08] bg-white/45 backdrop-blur-lg px-3 py-2">
                                            <div className="text-[#8B847A] mb-1">失败</div>
                                            <div className="font-mono text-rose-300">{batchStatus?.failed || 0}</div>
                                        </div>
                                    </div>
                                    {batchStatus?.current && (
                                        <div className="mt-3 space-y-3">
                                            <div className="rounded-lg border border-[#D97757]/25 bg-[#D97757]/12 px-3 py-2 text-xs text-[#D97757]">
                                                当前任务 {batchStatus.current.index}/{batchStatus.current.total}: {batchStatus.current.title} · {batchStatus.current.quantity} shares
                                            </div>
                                            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
                                                <div className="rounded-lg border border-black/[0.08] bg-white/45 backdrop-blur-lg px-3 py-2">
                                                    <div className="text-[#8B847A] mb-1">Shares</div>
                                                    <div className="font-mono text-[#1A1915]">{batchStatus.current.quantity}</div>
                                                </div>
                                                <div className="rounded-lg border border-black/[0.08] bg-white/45 backdrop-blur-lg px-3 py-2">
                                                    <div className="text-[#8B847A] mb-1">Predict Bid</div>
                                                    <div className="font-mono text-blue-300">{(Number(batchStatus.current.predictBidPrice || 0) * 100).toFixed(2)}¢</div>
                                                </div>
                                                <div className="rounded-lg border border-black/[0.08] bg-white/45 backdrop-blur-lg px-3 py-2">
                                                    <div className="text-[#8B847A] mb-1">Poly Hedge</div>
                                                    <div className="font-mono text-purple-300">{(Number(batchStatus.current.polymarketHedgePrice || 0) * 100).toFixed(2)}¢</div>
                                                </div>
                                                <div className="rounded-lg border border-black/[0.08] bg-white/45 backdrop-blur-lg px-3 py-2">
                                                    <div className="text-[#8B847A] mb-1">预算比例</div>
                                                    <div className="font-mono text-[#D97757]">{(Number(batchStatus.current.budgetRatio || 0) * 100).toFixed(1)}%</div>
                                                </div>
                                                <div className="rounded-lg border border-black/[0.08] bg-white/45 backdrop-blur-lg px-3 py-2">
                                                    <div className="text-[#8B847A] mb-1">过期时间</div>
                                                    <div className="font-mono text-[#2A2520]">{formatAutoPreviewTime(batchStatus.current.expiresAt)}</div>
                                                </div>
                                            </div>
                                            <div className="grid grid-cols-2 gap-3 text-xs">
                                                <div className="rounded-lg border border-black/[0.08] bg-white/45 backdrop-blur-lg px-3 py-2">
                                                    <div className="text-[#8B847A] mb-1">Predict 名义金额</div>
                                                    <div className="font-mono text-[#2A2520]">${Number(batchStatus.current.predictOrderValue || 0).toFixed(2)}</div>
                                                </div>
                                                <div className="rounded-lg border border-black/[0.08] bg-white/45 backdrop-blur-lg px-3 py-2">
                                                    <div className="text-[#8B847A] mb-1">Poly 对冲金额</div>
                                                    <div className="font-mono text-[#2A2520]">${Number(batchStatus.current.polymarketHedgeValue || 0).toFixed(2)}</div>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                    {!batchStatus?.current && batchStatus?.pendingAction === 'pause' && (
                                        <div className="mt-3 rounded-lg border border-[#D97757]/25 bg-[#D97757]/12 px-3 py-2 text-xs text-[#D97757]">
                                            暂停请求已接收，将在当前任务创建完成后生效。
                                        </div>
                                    )}
                                    {!batchStatus?.current && (batchStatus?.pendingAction === 'stop' || batchStatus?.state === 'STOPPING') && (
                                        <div className="mt-3 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                                            停止请求已接收，将在当前任务创建完成后结束本次批量创建。
                                        </div>
                                    )}
                                    {batchStatus?.error && (
                                        <div className="mt-3 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                                            {batchStatus.error}
                                        </div>
                                    )}
                                    {(batchStatus?.jobId || batchStatus?.logFilePath || logEntries.length > 0) && (
                                        <div className="mt-4 rounded-xl border border-black/[0.08] bg-white/70 backdrop-blur-xl p-4">
                                            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                                                <div>
                                                    <div className="text-xs text-[#8B847A] mb-1">批量创建 Debug 日志</div>
                                                    <div className="text-sm font-medium text-[#1A1915]">
                                                        {batchStatus?.jobId || '--'}
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-3">
                                                    <button
                                                        onClick={() => setShowBatchLogs((value) => !value)}
                                                        className="px-2.5 py-1 rounded-lg border border-black/[0.12] bg-white/55 backdrop-blur-xl text-[#3A342C] text-[11px] hover:bg-white/65 transition-colors">
                                                        {showBatchLogs ? '隐藏日志' : '展开日志'}
                                                    </button>
                                                    <div className="text-[11px] text-[#8B847A] font-mono break-all text-right">
                                                        {batchStatus?.logFilePath || '未生成日志文件'}
                                                    </div>
                                                </div>
                                            </div>
                                            {showBatchLogs ? (
                                                <div
                                                    ref={logContainerRef}
                                                    className="max-h-72 overflow-y-auto space-y-2 rounded-lg border border-black/[0.06] bg-white/40 backdrop-blur-sm p-3">
                                                    {logEntries.length === 0 ? (
                                                        <div className="text-xs text-[#8B847A]">点击"批量创建并启动"后，这里会实时显示详细日志。</div>
                                                    ) : (
                                                        logEntries.map((entry) => (
                                                            <div key={entry.id} className={`rounded-lg border p-3 text-xs ${getAutoCreateLogLevelClass(entry.level)}`}>
                                                                <div className="flex flex-wrap items-center justify-between gap-2">
                                                                    <div className="font-mono">{entry.message}</div>
                                                                    <div className="font-mono text-[11px] text-[#8B847A]">
                                                                        {formatAutoPreviewTime(entry.timestamp)}
                                                                    </div>
                                                                </div>
                                                                {entry.details && (
                                                                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-[#6B665C]">
                                                                        {formatAutoCreateLogDetails(entry.details)}
                                                                    </pre>
                                                                )}
                                                            </div>
                                                        ))
                                                    )}
                                                </div>
                                            ) : (
                                                <div className="rounded-lg border border-black/[0.06] bg-white/35 px-3 py-2 text-xs text-[#8B847A]">
                                                        日志已隐藏。当前可展开最近 {logEntries.length} 条轻量日志，完整日志保留在服务器文件中。
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    )}

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div className="rounded-xl border border-black/[0.08] bg-white/70 backdrop-blur-xl p-3">
                            <div className="text-[11px] text-[#8B847A] mb-1">候选任务</div>
                            <div className="text-xl font-mono text-[#1A1915]">{result?.summary?.generated ?? '--'}</div>
                        </div>
                        <div className="rounded-xl border border-black/[0.08] bg-white/70 backdrop-blur-xl p-3">
                            <div className="text-[11px] text-[#8B847A] mb-1">总 Shares</div>
                            <div className="text-xl font-mono text-[#1A1915]">{result?.summary?.totalQuantity ?? '--'}</div>
                        </div>
                        <div className="rounded-xl border border-black/[0.08] bg-white/70 backdrop-blur-xl p-3">
                            <div className="text-[11px] text-[#8B847A] mb-1">Poly 理论满成交对冲额</div>
                            <div className="text-xl font-mono text-purple-400">
                                ${Number(result?.summary?.totalPolymarketValue || 0).toFixed(2)}
                            </div>
                        </div>
                        <div className="rounded-xl border border-black/[0.08] bg-white/70 backdrop-blur-xl p-3">
                            <div className="text-[11px] text-[#8B847A] mb-1">生成时间</div>
                            <div className="text-sm font-mono text-[#3A342C]">
                                {formatAutoPreviewTime(result?.generatedAt)}
                            </div>
                        </div>
                    </div>

                    {result && (
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[#8B847A]">
                            <span>Predict 可用 ${Number(result.summary.predictAvailable || 0).toFixed(2)}</span>
                            <span>•</span>
                            <span>Poly 可用 ${Number(result.summary.polymarketAvailable || 0).toFixed(2)}</span>
                            <span>•</span>
                            <span>扫描候选 {result.summary.considered || 0}</span>
                        </div>
                    )}

                    {Array.isArray(result?.warnings) && result.warnings.length > 0 && (
                        <div className="mt-3 space-y-2">
                            {result.warnings.map((warning, index) => (
                                <div key={`${warning}-${index}`} className="rounded-lg border border-[#D97757]/25 bg-[#D97757]/12 px-3 py-2 text-xs text-[#D97757]">
                                    {warning}
                                </div>
                            ))}
                        </div>
                    )}

                    {skippedEntries.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                            {skippedEntries.map(([reason, count]) => (
                                <span key={reason} className="px-2 py-1 rounded-full border border-black/[0.12] bg-white/75 backdrop-blur-xl text-[11px] text-[#6B665C]">
                                    {formatSkippedReason(reason)} x {count}
                                </span>
                            ))}
                        </div>
                    )}
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-4">
                    {loading ? (
                        <div className="flex flex-col items-center justify-center py-24 text-[#6B665C]">
                            <Icon name="refresh-cw" size={28} className="animate-spin text-[#C7654A] mb-4" />
                            <p className="text-sm">正在根据余额和筛选条件生成待创建任务...</p>
                        </div>
                    ) : error ? (
                        <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-4 text-sm text-rose-300">
                            {error}
                        </div>
                    ) : candidates.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-24 text-[#8B847A]">
                            <Icon name="inbox" size={32} className="mb-4 text-[#A39C8E]" />
                            <p className="text-sm">当前没有满足条件的待创建任务。</p>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {visibleCandidates.map((item, index) => (
                                <div key={item.id || `${item.marketId}-${item.arbSide}-${index}`} className="rounded-2xl border border-black/[0.08] bg-white/35 backdrop-blur-md p-4">
                                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-2 mb-2">
                                                <Badge variant={item.source === 'sports' ? 'warning' : 'success'}>
                                                    {item.source === 'sports' ? 'SPORTS' : 'ALL'}
                                                </Badge>
                                                <Badge variant={item.arbSide === 'YES' ? 'inverted' : 'warning'}>
                                                    {item.arbSide}
                                                </Badge>
                                                {item.isSportsMarket && item.gameStartTime && (
                                                    <span className="text-[11px] px-2 py-0.5 rounded-full border border-black/[0.12] bg-white/75 backdrop-blur-xl text-[#6B665C] font-mono">
                                                        开赛 {formatAutoPreviewTime(item.gameStartTime)}
                                                    </span>
                                                )}
                                                {item.expiresAt && (
                                                    <span className="text-[11px] px-2 py-0.5 rounded-full border border-black/[0.12] bg-white/75 backdrop-blur-xl text-[#6B665C] font-mono">
                                                        过期 {formatAutoPreviewTime(item.expiresAt)}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-sm font-semibold text-[#1A1915] leading-relaxed">
                                                {index + 1}. {item.title}
                                            </div>
                                        </div>

                                        <div className="shrink-0 min-w-[120px]">
                                            <div className="text-[11px] text-[#8B847A] mb-1">建议 Shares</div>
                                            <div className="text-3xl font-mono text-[#1A1915] leading-none">
                                                {item.quantity}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mt-4 text-xs">
                                        <div className="rounded-xl border border-black/[0.08] bg-white/65 backdrop-blur-xl p-3">
                                            <div className="text-[#8B847A] mb-1">Predict Bid</div>
                                            <div className="font-mono text-blue-400">{(Number(item.predictBidPrice || 0) * 100).toFixed(2)}¢</div>
                                        </div>
                                        <div className="rounded-xl border border-black/[0.08] bg-white/65 backdrop-blur-xl p-3">
                                            <div className="text-[#8B847A] mb-1">Poly Hedge</div>
                                            <div className="font-mono text-purple-400">{(Number(item.polymarketHedgePrice || 0) * 100).toFixed(2)}¢</div>
                                        </div>
                                        <div className="rounded-xl border border-black/[0.08] bg-white/65 backdrop-blur-xl p-3">
                                            <div className="text-[#8B847A] mb-1">可套利深度</div>
                                            <div className="font-mono text-[#1A1915]">{Math.floor(Number(item.maxQuantity || 0))}</div>
                                        </div>
                                        <div className="rounded-xl border border-black/[0.08] bg-white/65 backdrop-blur-xl p-3">
                                            <div className="text-[#8B847A] mb-1">预算比例</div>
                                            <div className="font-mono text-[#D97757]">{(Number(item.budgetRatio || 0) * 100).toFixed(1)}%</div>
                                        </div>
                                        <div className="rounded-xl border border-black/[0.08] bg-white/65 backdrop-blur-xl p-3">
                                            <div className="text-[#8B847A] mb-1">预计利润</div>
                                            <div className="font-mono text-[#1A1915]">
                                                ${Number(item.estimatedProfit || 0).toFixed(2)}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3 text-xs">
                                        <div className="rounded-xl border border-black/[0.08] bg-white/40 backdrop-blur-md p-3">
                                            <div className="text-[#8B847A] mb-1">Predict 名义金额</div>
                                            <div className="font-mono text-[#2A2520]">${Number(item.predictOrderValue || 0).toFixed(2)}</div>
                                        </div>
                                        <div className="rounded-xl border border-black/[0.08] bg-white/40 backdrop-blur-md p-3">
                                            <div className="text-[#8B847A] mb-1">Poly 对冲金额</div>
                                            <div className="font-mono text-[#2A2520]">${Number(item.polymarketHedgeValue || 0).toFixed(2)}</div>
                                        </div>
                                        <div className="rounded-xl border border-black/[0.08] bg-white/40 backdrop-blur-md p-3">
                                            <div className="text-[#8B847A] mb-1">利润率</div>
                                            <div className="font-mono text-[#2A2520]">{Number(item.profitPercent || 0).toFixed(2)}%</div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                            {hiddenCandidateCount > 0 && (
                                <button
                                    onClick={() => setShowAllCandidates(true)}
                                    className="w-full rounded-xl border border-black/[0.08] bg-white/55 backdrop-blur-xl px-4 py-3 text-sm text-[#3A342C] hover:bg-white/65 transition-colors">
                                    显示剩余 {hiddenCandidateCount} 条候选
                                </button>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
};

// 流动性分析组件
const LiquidityAnalytics = () => {
    const [data, setData] = React.useState(null);
    const [loading, setLoading] = React.useState(true);
    const [refreshing, setRefreshing] = React.useState(false);
    const [lastScanTime, setLastScanTime] = React.useState(null);

    const fetchData = React.useCallback(async () => {
        try {
            const res = await fetch('/api/liquidity');
            const json = await res.json();
            if (json.success && json.data) {
                setData(json.data);
                setLastScanTime(json.lastScanTime);
            }
        } catch (e) {
            console.error('Failed to fetch liquidity data:', e);
        } finally {
            setLoading(false);
        }
    }, []);

    React.useEffect(() => {
        fetchData();
    }, [fetchData]);

    const handleRefresh = async () => {
        setRefreshing(true);
        try {
            await fetch('/api/liquidity/refresh', { method: 'POST' });
            // 轮询等待扫描完成（最多等待120秒）
            let attempts = 0;
            const maxAttempts = 40;  // 40次 * 3秒 = 120秒
            const poll = async () => {
                attempts++;
                const res = await fetch('/api/liquidity');
                const json = await res.json();
                if (json.success && json.data) {
                    setData(json.data);
                    setLastScanTime(json.lastScanTime);
                    setRefreshing(false);
                } else if (attempts < maxAttempts) {
                    setTimeout(poll, 3000);
                } else {
                    setRefreshing(false);
                }
            };
            setTimeout(poll, 5000);  // 首次等待5秒后开始轮询
        } catch {
            setRefreshing(false);
        }
    };

    const formatNumber = (num) => {
        if (num >= 1000000) return `$${(num / 1000000).toFixed(2)}M`;
        if (num >= 1000) return `$${(num / 1000).toFixed(1)}K`;
        return `$${num.toFixed(0)}`;
    };

    const getRatioColor = (ratio) => {
        if (ratio >= 10) return 'text-rose-400';
        if (ratio >= 5) return 'text-orange-400';
        if (ratio >= 2) return 'text-[#C7654A]';
        return 'text-[#1A1915]';
    };

    if (loading) {
        return (
            <Card className="p-6">
                <div className="flex items-center justify-center py-12">
                    <Icon name="loader" size={24} className="animate-spin text-[#B85A3F]" />
                    <span className="ml-3 text-[#6B665C]">加载流动性数据...</span>
                </div>
            </Card>
        );
    }

    if (!data) {
        return (
            <Card className="p-6">
                <div className="text-center py-12">
                    <p className="text-[#6B665C] mb-4">流动性扫描尚未完成</p>
                    <button onClick={handleRefresh}
                        className="px-4 py-2 bg-[#D97757] text-[#1A1915] rounded-lg font-medium hover:bg-[#C7654A] transition-colors">
                        开始扫描
                    </button>
                </div>
            </Card>
        );
    }

    return (
        <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-medium text-[#1A1915] flex items-center gap-2">
                    <Icon name="bar-chart-2" size={16} className="text-[#B85A3F]" />
                    市场流动性分析
                    <span className="text-xs text-[#8B847A] font-normal ml-2">
                        按 Vol/Liq 比值排序 • {data.valid} 个有效市场
                    </span>
                </h3>
                <div className="flex items-center gap-3">
                    {lastScanTime && (
                        <span className="text-xs text-[#8B847A]">
                            更新于 {new Date(lastScanTime).toLocaleTimeString('zh-CN', { hour12: false })}
                        </span>
                    )}
                    <button onClick={handleRefresh} disabled={refreshing}
                        className="px-3 py-1 text-xs bg-white/65 text-[#3A342C] rounded hover:bg-white/75 disabled:opacity-50 transition-colors">
                        {refreshing ? '刷新中...' : '刷新'}
                    </button>
                </div>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-[#8B847A] text-xs border-b border-black/[0.08]">
                            <th className="px-2 py-2 text-left font-medium w-10">#</th>
                            <th className="px-2 py-2 text-left font-medium">市场</th>
                            <th className="px-2 py-2 text-right font-medium w-24">24h交易量</th>
                            <th className="px-2 py-2 text-right font-medium w-20">流动性</th>
                            <th className="px-2 py-2 text-right font-medium w-16">比值</th>
                            <th className="px-2 py-2 text-center font-medium w-12">链接</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-black/[0.06]/50">
                        {data.top20.map((item, index) => (
                            <tr key={item.marketId} className="hover:bg-white/40 transition-colors">
                                <td className="px-2 py-2.5 text-[#8B847A] font-mono">{index + 1}</td>
                                <td className="px-2 py-2.5 min-w-[300px]">
                                    <div className="font-medium text-[#1A1915] whitespace-normal break-words" title={item.title}>
                                        {item.title}
                                    </div>
                                    <div className="text-xs text-[#8B847A]">
                                        {item.outcomeCount} 个选项 • {item.categorySlug}
                                    </div>
                                </td>
                                <td className="px-2 py-2.5 text-right font-mono text-[#3A342C]">
                                    {formatNumber(item.volume24h)}
                                </td>
                                <td className="px-2 py-2.5 text-right font-mono text-[#6B665C]">
                                    {formatNumber(item.liquidity)}
                                </td>
                                <td className="px-2 py-2.5 text-right">
                                    <span className={`font-mono font-semibold ${getRatioColor(item.volumeLiquidityRatio)}`}>
                                        {item.volumeLiquidityRatio.toFixed(2)}
                                    </span>
                                </td>
                                <td className="px-2 py-2.5 text-center">
                                    <a href={`https://predict.fun/market/${item.predictSlug || item.categorySlug}`}
                                        target="_blank" rel="noopener noreferrer"
                                        className="inline-flex items-center justify-center w-6 h-6 rounded bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 transition-colors">
                                        <Icon name="external-link" size={12} />
                                    </a>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="flex items-center gap-4 mt-4 text-xs text-[#8B847A]">
                <span>比值说明:</span>
                <span className="text-rose-400">≥10 极高</span>
                <span className="text-orange-400">≥5 高</span>
                <span className="text-[#C7654A]">≥2 中</span>
                <span className="text-[#1A1915]">&lt;2 正常</span>
            </div>
        </Card>
    );
};

// New: Enhanced Analytics Dashboard
const AnalyticsDashboard = ({ stats, chartData }) => (
    <div className="space-y-6">
        {/* 流动性分析表格 */}
        <LiquidityAnalytics />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Profit Trend */}
            <Card className="p-6">
                <h3 className="text-sm font-medium text-[#1A1915] mb-4 flex items-center gap-2">
                    <Icon name="trending-up" size={16} className="text-[#B85A3F]" />
                    Profit Trend (24h)
                </h3>
                <div className="h-48 flex items-end justify-between gap-1">
                    {chartData.profitTrend.map((d, i) => (
                        <div key={i} className="w-full relative group">
                            <div className="bg-white/65 hover:bg-emerald-500/20 transition-colors rounded-t-sm"
                                style={{ height: `${(d.avgProfit / 3) * 100}%` }}>
                                <div className="absolute inset-0 bg-emerald-500 opacity-30 group-hover:opacity-50 transition-opacity rounded-t-sm"></div>
                            </div>
                            <div className="absolute -top-8 left-1/2 -translate-x-1/2 text-[9px] bg-white/55 backdrop-blur-xl border border-black/[0.12] px-1.5 py-0.5 rounded text-[#1A1915] opacity-0 group-hover:opacity-100 transition-opacity font-mono pointer-events-none whitespace-nowrap">
                                {d.avgProfit.toFixed(1)}%
                            </div>
                        </div>
                    ))}
                </div>
                <div className="flex justify-between mt-2 text-[10px] text-[#8B847A] font-mono">
                    <span>0h</span>
                    <span>24h</span>
                </div>
            </Card>

            {/* Strategy Distribution Pie Chart */}
            <Card className="p-6">
                <h3 className="text-sm font-medium text-[#1A1915] mb-4 flex items-center gap-2">
                    <Icon name="pie-chart" size={16} className="text-[#B85A3F]" />
                    Strategy Distribution
                </h3>
                <div className="flex items-center justify-center h-48">
                    <div className="relative">
                        <div className="w-32 h-32 rounded-full pie-chart"
                            style={{ '--maker-pct': chartData.strategyDistribution.maker }}>
                        </div>
                        <div className="absolute inset-0 flex items-center justify-center">
                            <div className="w-20 h-20 rounded-full bg-white/55 backdrop-blur-xl flex flex-col items-center justify-center">
                                <span className="text-2xl font-display font-bold text-[#1A1915]">{stats.makerCount + stats.takerCount}</span>
                                <span className="text-[10px] text-[#8B847A]">Total</span>
                            </div>
                        </div>
                    </div>
                    <div className="ml-8 space-y-3">
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded bg-emerald-500"></div>
                            <span className="text-xs text-[#6B665C]">Maker</span>
                            <span className="text-xs font-mono text-[#1A1915] ml-2">{chartData.strategyDistribution.maker}%</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-3 h-3 rounded bg-blue-500"></div>
                            <span className="text-xs text-[#6B665C]">Taker</span>
                            <span className="text-xs font-mono text-[#1A1915] ml-2">{chartData.strategyDistribution.taker}%</span>
                        </div>
                    </div>
                </div>
            </Card>

            {/* Opportunity Count Over Time */}
            <Card className="p-6">
                <h3 className="text-sm font-medium text-[#1A1915] mb-4 flex items-center gap-2">
                    <Icon name="bar-chart-3" size={16} className="text-[#B85A3F]" />
                    Opportunity Count (24h)
                </h3>
                <div className="h-48 flex items-end justify-between gap-0.5">
                    {chartData.opportunityCounts.map((d, i) => (
                        <div key={i} className="w-full flex flex-col-reverse">
                            <div className="bg-emerald-500/50 rounded-t-sm transition-all" style={{ height: `${d.maker * 8}px` }}></div>
                            <div className="bg-blue-500/50 transition-all" style={{ height: `${d.taker * 8}px` }}></div>
                        </div>
                    ))}
                </div>
                <div className="flex justify-between mt-2 text-[10px] text-[#8B847A] font-mono">
                    <span>0h</span>
                    <span>24h</span>
                </div>
                <div className="flex justify-center gap-4 mt-3">
                    <div className="flex items-center gap-1 text-[10px] text-[#8B847A]">
                        <div className="w-2 h-2 rounded bg-emerald-500/50"></div>
                        Maker
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-[#8B847A]">
                        <div className="w-2 h-2 rounded bg-blue-500/50"></div>
                        Taker
                    </div>
                </div>
            </Card>

            {/* Depth vs Spread Scatter */}
            <Card className="p-6">
                <h3 className="text-sm font-medium text-[#1A1915] mb-4 flex items-center gap-2">
                    <Icon name="scatter-chart" size={16} className="text-[#B85A3F]" />
                    Depth vs Spread
                </h3>
                <div className="h-48 relative border-l border-b border-black/[0.08]">
                    {Array.from({ length: 15 }).map((_, i) => (
                        <div key={i}
                            className="absolute w-2 h-2 rounded-full bg-[#D97757] opacity-60 hover:opacity-100 hover:scale-150 transition-all cursor-pointer shadow-glow-sm"
                            style={{ left: `${Math.random() * 90}%`, bottom: `${Math.random() * 90}%` }}
                            title="Opportunity">
                        </div>
                    ))}
                    <span className="absolute -left-6 top-1/2 -rotate-90 text-[10px] text-[#8B847A] origin-center">Depth</span>
                </div>
                <div className="text-[10px] text-[#8B847A] text-center mt-2">Spread %</div>
            </Card>
        </div>
    </div>
);

// Notification Toast
const NotificationToast = ({ notification, onDismiss }) => (
    <div className="notification-toast glass-card rounded-lg p-4 mb-2 border-l-4 border-[#D97757] max-w-sm">
        <div className="flex justify-between items-start">
            <div>
                <div className="text-sm font-medium text-[#1A1915]">{notification.title}</div>
                <div className="text-xs text-[#6B665C] mt-1 truncate max-w-[200px]">{notification.message}</div>
                <div className="text-xs text-[#1A1915] mt-1 font-mono">+${notification.profit.toFixed(2)}</div>
            </div>
            <button onClick={() => onDismiss(notification.id)} className="text-[#8B847A] hover:text-[#1A1915] transition-colors">
                <Icon name="x" size={14} />
            </button>
        </div>
    </div>
);

// ============================================================================
// Order Toast (订单状态浮窗通知)
// ============================================================================

// 事件类型配置
const ORDER_EVENT_CONFIG = {
    'TASK_STARTED': { emoji: '🚀', label: '任务启动', color: 'border-blue-500', bg: 'bg-blue-500/10' },
    'TASK_COMPLETED': { emoji: '✅', label: '任务完成', color: 'border-emerald-500', bg: 'bg-emerald-500/10' },
    'TASK_FAILED': { emoji: '❌', label: '任务失败', color: 'border-rose-500', bg: 'bg-rose-500/10' },
    'TASK_CANCELLED': { emoji: '🛑', label: '任务取消', color: 'border-black/15', bg: 'bg-black/5' },
    'TASK_PAUSED': { emoji: '⏸️', label: '任务暂停', color: 'border-[#D97757]', bg: 'bg-[#D97757]/12' },
    'TASK_RESUMED': { emoji: '▶️', label: '任务恢复', color: 'border-blue-500', bg: 'bg-blue-500/10' },
    'ORDER_SUBMITTED': { emoji: '📤', label: '订单提交', color: 'border-blue-400', bg: 'bg-blue-400/10' },
    'ORDER_FILLED': { emoji: '💰', label: '订单成交', color: 'border-emerald-400', bg: 'bg-emerald-400/10' },
    'ORDER_PARTIAL_FILL': { emoji: '🔄', label: '部分成交', color: 'border-[#C7654A]', bg: 'bg-[#C7654A]/12' },
    'ORDER_CANCELLED': { emoji: '❌', label: '订单取消', color: 'border-rose-400', bg: 'bg-rose-400/10' },
    'ORDER_EXPIRED': { emoji: '⏰', label: '订单过期', color: 'border-black/20', bg: 'bg-black/5' },
    'HEDGE_SUBMITTED': { emoji: '🔗', label: '对冲提交', color: 'border-purple-400', bg: 'bg-purple-400/10' },
    'HEDGE_FILLED': { emoji: '🎯', label: '对冲成交', color: 'border-purple-400', bg: 'bg-purple-400/10' },
    'HEDGE_FAILED': { emoji: '⚠️', label: '对冲失败', color: 'border-rose-400', bg: 'bg-rose-400/10' },
    'HEDGE_FAILED_GTC_PENDING': { emoji: '⏳', label: 'GTC 保底', color: 'border-[#C7654A]', bg: 'bg-[#C7654A]/12' },
    'PRICE_GUARD_TRIGGERED': { emoji: '🛡️', label: '价格守护', color: 'border-[#D97757]', bg: 'bg-[#D97757]/12' },
    'PRICE_GUARD_RESUMED': { emoji: '✅', label: '价格恢复', color: 'border-emerald-500', bg: 'bg-emerald-500/10' },
    'DEPTH_GUARD_TRIGGERED': { emoji: '📚', label: '深度守护', color: 'border-[#D97757]', bg: 'bg-[#D97757]/12' },
    'DEPTH_GUARD_RESUMED': { emoji: '✅', label: '深度恢复', color: 'border-emerald-500', bg: 'bg-emerald-500/10' },
    'COST_INVALID': { emoji: '💸', label: '成本失效', color: 'border-rose-500', bg: 'bg-rose-500/10' },
};

// 单个 Toast 组件
const OrderToast = ({ toast, isExiting }) => {
    const config = ORDER_EVENT_CONFIG[toast.type] || { emoji: '📋', label: toast.type, color: 'border-black/15', bg: 'bg-black/5' };
    const platformLabel = toast.platform === 'predict' ? 'Predict' : toast.platform === 'polymarket' ? 'Polymarket' : '';
    const sideLabel = toast.side === 'YES' ? 'YES 🟢' : toast.side === 'NO' ? 'NO 🔴' : '';
    const time = toast.timestamp ? new Date(toast.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '';

    return (
        <div
            className={`order-toast glass-card rounded-xl p-4 mb-3 border-l-4 ${config.color} ${config.bg} w-80 shadow-xl backdrop-blur-md transition-all duration-300 ${isExiting ? 'opacity-0 translate-x-[-20px]' : 'opacity-100 translate-x-0'}`}
            style={{ animation: isExiting ? 'none' : 'slideIn 0.3s ease-out' }}
        >
            <div className="flex items-start gap-3">
                <span className="text-2xl">{config.emoji}</span>
                <div className="flex-1 min-w-0">
                    {/* 标题行 */}
                    <div className="flex items-center gap-2 mb-2">
                        <span className="text-sm font-semibold text-[#1A1915]">{config.label}</span>
                        {platformLabel && (
                            <span className={`text-xs px-2 py-0.5 rounded-full ${toast.platform === 'predict' ? 'bg-blue-500/30 text-blue-300' : 'bg-purple-500/30 text-purple-300'}`}>
                                {platformLabel}
                            </span>
                        )}
                    </div>
                    {/* 方向和价格 */}
                    {(sideLabel || toast.price !== undefined) && (
                        <div className="flex items-center gap-3 text-sm text-[#2A2520] mb-1">
                            {sideLabel && <span className="font-medium">{sideLabel}</span>}
                            {toast.price !== undefined && <span>@ {(Number(toast.price) * 100).toFixed(1)}¢</span>}
                        </div>
                    )}
                    {/* 成交信息 */}
                    {(toast.filledQty !== undefined || toast.quantity !== undefined) && (
                        <div className="text-sm text-[#3A342C] mb-1">
                            {toast.filledQty !== undefined && (
                                <span>成交: {Number(toast.filledQty).toFixed(0)}</span>
                            )}
                            {toast.quantity !== undefined && toast.filledQty !== undefined && (
                                <span className="text-[#8B847A]">/{Number(toast.quantity).toFixed(0)}</span>
                            )}
                            {toast.avgPrice !== undefined && (
                                <span className="ml-2">均价: {(Number(toast.avgPrice) * 100).toFixed(1)}¢</span>
                            )}
                        </div>
                    )}
                    {/* 错误信息 */}
                    {toast.error && (
                        <div className="text-xs text-rose-400 mt-1 break-words">{toast.error}</div>
                    )}
                    {toast.reason && (
                        <div className="text-xs text-[#C7654A] mt-1">{toast.reason}</div>
                    )}
                    {/* 底部：任务ID和时间 */}
                    <div className="flex items-center justify-between mt-2 text-xs text-[#8B847A]">
                        <span className="font-mono">{toast.taskId?.slice(0, 12)}...</span>
                        {time && <span>{time}</span>}
                    </div>
                </div>
            </div>
        </div>
    );
};

// Toast 容器组件 (左上角，向下堆叠)
const OrderToastContainer = ({ toasts }) => {
    if (!toasts || toasts.length === 0) return null;

    return (
        <div className="fixed top-20 left-4 z-50 flex flex-col pointer-events-none">
            {toasts.map((toast) => (
                <OrderToast key={toast.id} toast={toast} isExiting={toast.isExiting} />
            ))}
        </div>
    );
};

// useOrderToasts Hook
const useOrderToasts = () => {
    const [toasts, setToasts] = useState([]);
    const toastIdRef = useRef(0);

    const addOrderToast = useCallback((event) => {
        const id = ++toastIdRef.current;
        const newToast = { ...event, id, isExiting: false };

        setToasts(prev => {
            // 最多保留 5 个 toast
            const updated = [newToast, ...prev].slice(0, 5);
            return updated;
        });

        // 5秒后开始渐隐
        setTimeout(() => {
            setToasts(prev => prev.map(t => t.id === id ? { ...t, isExiting: true } : t));
            // 渐隐动画后移除
            setTimeout(() => {
                setToasts(prev => prev.filter(t => t.id !== id));
            }, 300);
        }, 5000);
    }, []);

    return { toasts, addOrderToast };
};

// Settings Panel
const SettingsPanel = ({ isOpen, onClose, settings, setSettings }) => {
    const [notifPermission, setNotifPermission] = useState(
        'Notification' in window ? Notification.permission : 'denied'
    );

    if (!isOpen) return null;

    const handleDesktopToggle = async () => {
        if (!settings.desktop) {
            // Turning ON - request permission if needed
            if ('Notification' in window && Notification.permission === 'default') {
                const permission = await Notification.requestPermission();
                setNotifPermission(permission);
                if (permission === 'granted') {
                    setSettings(s => ({ ...s, desktop: true }));
                }
            } else if (Notification.permission === 'granted') {
                setSettings(s => ({ ...s, desktop: true }));
            }
        } else {
            // Turning OFF
            setSettings(s => ({ ...s, desktop: false }));
        }
    };

    const getPermissionStatus = () => {
        if (!('Notification' in window)) return { text: 'Not supported', color: 'text-[#8B847A]' };
        if (notifPermission === 'granted') return { text: 'Allowed', color: 'text-[#1A1915]' };
        if (notifPermission === 'denied') return { text: 'Blocked', color: 'text-rose-400' };
        return { text: 'Not set', color: 'text-[#6B665C]' };
    };

    const permStatus = getPermissionStatus();

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/55 backdrop-blur-md backdrop-blur-sm" onClick={onClose}>
            <div className="glass-card rounded-2xl w-full max-w-md m-4 border border-black/[0.08]" onClick={e => e.stopPropagation()}>
                <div className="p-6 border-b border-black/5 flex justify-between items-center">
                    <h2 className="text-lg font-display font-medium text-[#1A1915] flex items-center gap-2">
                        <Icon name="settings" size={20} className="text-[#B85A3F]" />
                        Settings
                    </h2>
                    <button onClick={onClose} className="text-[#8B847A] hover:text-[#1A1915] transition-colors">
                        <Icon name="x" size={20} />
                    </button>
                </div>

                <div className="p-6 space-y-6">
                    {/* Notifications Section */}
                    <div>
                        <h3 className="text-sm font-medium text-[#1A1915] mb-4 flex items-center gap-2">
                            <Icon name="bell" size={16} />
                            Notifications
                        </h3>
                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <span className="text-sm text-[#6B665C]">Enable Notifications</span>
                                <button
                                    onClick={() => setSettings(s => ({ ...s, enabled: !s.enabled }))}
                                    className={`w-12 h-6 rounded-full transition-colors ${settings.enabled ? 'bg-[#D97757]' : 'bg-white/75'}`}>
                                    <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${settings.enabled ? 'translate-x-6' : 'translate-x-0.5'}`}></div>
                                </button>
                            </div>
                            {/* Sound Alert 已移除 */}
                            <div className="flex items-center justify-between">
                                <div>
                                    <span className="text-sm text-[#6B665C]">Desktop Notifications</span>
                                    <div className={`text-[10px] ${permStatus.color}`}>Browser: {permStatus.text}</div>
                                </div>
                                <button
                                    onClick={handleDesktopToggle}
                                    disabled={notifPermission === 'denied'}
                                    className={`w-12 h-6 rounded-full transition-colors ${settings.desktop && notifPermission === 'granted' ? 'bg-[#D97757]' : 'bg-white/75'} ${notifPermission === 'denied' ? 'opacity-50 cursor-not-allowed' : ''}`}>
                                    <div className={`w-5 h-5 rounded-full bg-white shadow transition-transform ${settings.desktop && notifPermission === 'granted' ? 'translate-x-6' : 'translate-x-0.5'}`}></div>
                                </button>
                            </div>
                            {notifPermission === 'denied' && (
                                <div className="text-[11px] text-rose-400 bg-rose-500/10 rounded-lg p-2">
                                    Desktop notifications are blocked. Please enable them in your browser settings.
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Threshold Section */}
                    <div>
                        <h3 className="text-sm font-medium text-[#1A1915] mb-4 flex items-center gap-2">
                            <Icon name="target" size={16} />
                            Alert Threshold
                        </h3>
                        <div className="space-y-4">
                            <div>
                                <div className="flex justify-between text-sm mb-2">
                                    <span className="text-[#6B665C]">Min Profit for Alert</span>
                                    <span className="text-[#B85A3F] font-mono">{settings.minProfit}%</span>
                                </div>
                                <input
                                    type="range"
                                    min="0.5"
                                    max="5"
                                    step="0.5"
                                    value={settings.minProfit}
                                    onChange={(e) => setSettings(s => ({ ...s, minProfit: parseFloat(e.target.value) }))}
                                    className="w-full accent-amber-500 h-2 bg-white/65 rounded-lg cursor-pointer"
                                />
                            </div>
                            <div>
                                <div className="text-sm text-[#6B665C] mb-2">Alert Strategies</div>
                                <div className="flex gap-2">
                                    {['PREDICT_MAKER', 'TAKER'].map(s => (
                                        <button
                                            key={s}
                                            onClick={() => setSettings(prev => ({
                                                ...prev,
                                                strategies: prev.strategies.includes(s)
                                                    ? prev.strategies.filter(x => x !== s)
                                                    : [...prev.strategies, s]
                                            }))}
                                            className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors ${settings.strategies.includes(s)
                                                ? 'bg-[#D97757] text-[#1A1915]'
                                                : 'bg-white/65 text-[#6B665C] hover:bg-white/75'
                                                }`}>
                                            {s}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Test Button - 只测试桌面通知 */}
                    <button
                        onClick={() => {
                            if (settings.desktop && 'Notification' in window && Notification.permission === 'granted') {
                                new Notification('Test Notification', { body: 'Notifications are working!' });
                            }
                        }}
                        className="w-full py-3 rounded-lg bg-white/65 text-[#1A1915] hover:bg-white/75 transition-colors text-sm font-medium">
                        Test Desktop Notification
                    </button>
                </div>
            </div>
        </div>
    );
};

const LatencyBar = ({ label, ms, max = 300 }) => {
    const pct = Math.min(100, (ms / max) * 100);
    const color = ms < 100 ? 'bg-emerald-500' : ms < 300 ? 'bg-[#D97757]' : 'bg-rose-500';
    return (
        <div className="mb-5">
            <div className="flex justify-between text-[11px] font-medium uppercase tracking-wide mb-2">
                <span className="text-[#8B847A]">{label}</span>
                <span className={`font-mono ${ms < 100 ? 'text-[#1A1915]' : ms < 300 ? 'text-[#C7654A]' : 'text-rose-400'}`}>{ms}ms</span>
            </div>
            <div className="h-1.5 w-full bg-white/65 rounded-full overflow-hidden">
                <div className={`h-full ${color} rounded-full transition-all duration-300 ease-out`} style={{ width: `${pct}%` }} />
            </div>
        </div>
    );
};

// Account Balance Card Component
const AccountCard = ({ platform, balance, positions, openOrders = [], icon, color, expanded, onToggle, onRefresh, refreshing }) => {
    const handleRefresh = (e) => {
        e.stopPropagation();  // 防止触发 onToggle
        onRefresh?.();
    };

    return (
        <div className={`glass-card rounded-xl border border-black/5 hover:border-black/[0.08] transition-all duration-300 ${expanded ? 'bg-white/40 backdrop-blur-md' : ''}`}>
            <div className="p-4 cursor-pointer" onClick={onToggle}>
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center">
                            <img
                                src={icon === 'predict' ? PREDICT_ICON : POLYMARKET_ICON}
                                alt={platform}
                                className="w-full h-full object-cover"
                            />
                        </div>
                        <div>
                            <div className="text-sm font-medium text-[#1A1915]">{platform}</div>
                            <div className="text-[10px] text-[#8B847A] uppercase tracking-wide">Account</div>
                        </div>
                        {/* 刷新按钮 */}
                        <button
                            onClick={handleRefresh}
                            disabled={refreshing}
                            className={`ml-2 p-1 rounded-md transition-all ${refreshing ? 'text-[#A39C8E] cursor-not-allowed' : 'text-[#8B847A] hover:text-[#3A342C] hover:bg-white/50'}`}
                            title="刷新账户数据"
                        >
                            <Icon name="refresh-cw" size={12} className={refreshing ? 'animate-spin' : ''} />
                        </button>
                    </div>
                    <div className="text-right">
                        <div className="text-lg font-display font-semibold text-[#1A1915] flex items-center justify-end gap-2">
                            ${balance.available.toFixed(2)}
                            <Icon name="chevron-down" size={14} className={`text-[#A39C8E] transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`} />
                        </div>
                        <div className="text-[10px] text-[#8B847A]">Available</div>
                    </div>
                </div>

                {/* Balance Details - Visible when collapsed too, as per user request to show 'info in picture' which likely includes these totals */}
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                    <div className="bg-white/45 backdrop-blur-lg rounded px-2 py-1.5">
                        <span className="text-[#8B847A]">Total: </span>
                        <span className="text-[#3A342C] font-mono">${balance.total.toFixed(2)}</span>
                    </div>
                    <div className="bg-white/45 backdrop-blur-lg rounded px-2 py-1.5">
                        <span className="text-[#8B847A]">Portfolio: </span>
                        <span className="text-[#C7654A] font-mono">${balance.portfolio.toFixed(2)}</span>
                    </div>
                    <div className="bg-white/45 backdrop-blur-lg rounded px-2 py-1.5">
                        <span className="text-[#8B847A]">Orders: </span>
                        <span className="text-cyan-400 font-mono">{openOrders.length}</span>
                    </div>
                </div>
            </div>

            {/* Positions & Orders - Collapsible */}
            <div className={`grid transition-all duration-300 ease-out border-t border-black/5 overflow-hidden ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0 border-none'}`}>
                <div className="min-h-0">
                    <div className="p-4 pt-3">
                        {/* Open Orders Section */}
                        <div className="mb-4">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] text-[#8B847A] uppercase tracking-wide">Open Orders</span>
                                <span className="text-[10px] font-mono text-cyan-400">{openOrders.length} pending</span>
                            </div>
                            <div className="space-y-1.5 max-h-48 overflow-y-auto">
                                {openOrders.length > 0 ? openOrders.map((order, idx) => (
                                    <div key={idx} className="flex items-center justify-between text-[11px] bg-cyan-950/20 border border-cyan-900/30 rounded px-2 py-1.5 hover:bg-cyan-900/30 transition-colors">
                                        <div className="flex items-center gap-2 min-w-0 flex-1">
                                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${order.side === 'BUY' ? 'bg-emerald-500/20 text-[#1A1915]' : 'bg-rose-500/20 text-rose-400'}`}>
                                                {order.side}
                                            </span>
                                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${order.outcome === 'YES' ? 'bg-blue-500/20 text-blue-400' : 'bg-orange-500/20 text-orange-400'}`}>
                                                {order.outcome}
                                            </span>
                                            <span className="text-[#6B665C] text-[10px]" title={order.market}>{order.market}</span>
                                        </div>
                                        <div className="text-right flex-shrink-0 ml-2">
                                            <span className="font-mono text-[#3A342C]">{order.filled}/{order.qty}</span>
                                            <span className="text-[#8B847A] ml-1">@</span>
                                            <span className="font-mono text-cyan-300">{(order.price * 100).toFixed(1)}¢</span>
                                        </div>
                                    </div>
                                )) : (
                                    <div className="text-[11px] text-[#A39C8E] text-center py-2">No open orders</div>
                                )}
                            </div>
                        </div>

                        {/* Open Positions Section */}
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] text-[#8B847A] uppercase tracking-wide">Open Positions</span>
                            <span className="text-[10px] font-mono text-[#6B665C]">{positions.length} active</span>
                        </div>
                        <div className="space-y-1.5 max-h-48 overflow-y-auto">
                            {positions.length > 0 ? positions.map((pos, idx) => (
                                <div key={idx} className="flex items-center justify-between text-[11px] bg-white/35 backdrop-blur-md rounded px-2 py-1.5 hover:bg-white/50 transition-colors">
                                    <div className="flex items-center gap-2 min-w-0 flex-1">
                                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${pos.side === 'YES' ? 'bg-emerald-500/20 text-[#1A1915]' : 'bg-rose-500/20 text-rose-400'}`}>
                                            {pos.side}
                                        </span>
                                        <span className="text-[#6B665C] text-[10px]" title={pos.market}>{pos.market}</span>
                                    </div>
                                    <div className="text-right flex-shrink-0 ml-2">
                                        <span className="font-mono text-[#3A342C]">{pos.qty}</span>
                                        <span className="text-[#8B847A] ml-1">@</span>
                                        <span className="font-mono text-[#3A342C]">{Number(pos.avgPrice).toFixed(1)}¢</span>
                                    </div>
                                </div>
                            )) : (
                                <div className="text-[11px] text-[#A39C8E] text-center py-2">No open positions</div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

// Task Log Modal Component - 任务日志查看弹窗
const TaskLogModal = ({ isOpen, onClose, taskId, apiBaseUrl }) => {
    const [timeline, setTimeline] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen && taskId) {
            setLoading(true);
            setError(null);
            fetch(`${apiBaseUrl}/api/logs/tasks/${taskId}/timeline`)
                .then(res => res.json())
                .then(data => {
                    if (data.success) {
                        setTimeline(data.data);
                    } else {
                        setError(data.error || '加载失败');
                    }
                })
                .catch(err => setError(err.message))
                .finally(() => setLoading(false));
        }
    }, [isOpen, taskId, apiBaseUrl]);

    if (!isOpen) return null;

    const formatTime = (ts) => {
        const d = new Date(ts);
        return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    };

    const formatDuration = (ms) => {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        return `${(ms / 60000).toFixed(1)}m`;
    };

    const getEventIcon = (type) => {
        if (type.includes('CREATED') || type.includes('STARTED')) return { icon: 'play', color: 'text-[#1A1915]' };
        if (type.includes('COMPLETED')) return { icon: 'check-circle', color: 'text-[#1A1915]' };
        if (type.includes('FAILED')) return { icon: 'x-circle', color: 'text-rose-400' };
        if (type.includes('ORDER')) return { icon: 'file-text', color: 'text-blue-400' };
        if (type.includes('HEDGE')) return { icon: 'shield', color: 'text-[#C7654A]' };
        if (type.includes('PRICE_GUARD')) return { icon: 'alert-triangle', color: 'text-[#C7654A]' };
        if (type.includes('PAUSED')) return { icon: 'pause', color: 'text-yellow-400' };
        if (type.includes('CANCELLED')) return { icon: 'x', color: 'text-[#6B665C]' };
        return { icon: 'circle', color: 'text-[#6B665C]' };
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-sm" onClick={onClose}>
            <div className="w-full max-w-2xl max-h-[80vh] mx-4 glass-card rounded-2xl border border-black/[0.08] shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="p-4 border-b border-black/[0.08] flex items-center justify-between shrink-0">
                    <div>
                        <h2 className="font-display text-lg font-semibold text-[#1A1915] flex items-center gap-2">
                            <Icon name="file-text" size={18} className="text-[#B85A3F]" />
                            任务日志
                        </h2>
                        {timeline && (
                            <p className="text-xs text-[#8B847A] mt-1 font-mono">{taskId}</p>
                        )}
                    </div>
                    <button onClick={onClose} className="text-[#8B847A] hover:text-[#1A1915] transition-colors p-1">
                        <Icon name="x" size={20} />
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-4">
                    {loading && (
                        <div className="flex items-center justify-center py-12">
                            <div className="animate-spin rounded-full h-8 w-8 border-2 border-[#D97757] border-t-transparent"></div>
                        </div>
                    )}

                    {error && (
                        <div className="text-center py-12">
                            <Icon name="alert-circle" size={40} className="text-rose-400 mx-auto mb-4" />
                            <p className="text-rose-400">{error}</p>
                        </div>
                    )}

                    {timeline && !loading && (
                        <div className="space-y-4">
                            {/* Summary */}
                            <div className="grid grid-cols-4 gap-3 mb-6">
                                <div className="glass-card rounded-lg p-3 border border-black/5">
                                    <div className="text-[10px] text-[#8B847A] uppercase mb-1">类型</div>
                                    <div className={`text-sm font-bold ${timeline.type === 'BUY' ? 'text-[#1A1915]' : 'text-rose-400'}`}>
                                        {timeline.type}
                                    </div>
                                </div>
                                <div className="glass-card rounded-lg p-3 border border-black/5">
                                    <div className="text-[10px] text-[#8B847A] uppercase mb-1">状态</div>
                                    <div className="text-sm text-[#1A1915]">{timeline.status}</div>
                                </div>
                                <div className="glass-card rounded-lg p-3 border border-black/5">
                                    <div className="text-[10px] text-[#8B847A] uppercase mb-1">耗时</div>
                                    <div className="text-sm text-[#1A1915] font-mono">{formatDuration(timeline.durationMs)}</div>
                                </div>
                                <div className="glass-card rounded-lg p-3 border border-black/5">
                                    <div className="text-[10px] text-[#8B847A] uppercase mb-1">利润</div>
                                    <div className={`text-sm font-mono ${timeline.actualProfit >= 0 ? 'text-[#1A1915]' : 'text-rose-400'}`}>
                                        {timeline.actualProfit >= 0 ? '+' : ''}${timeline.actualProfit.toFixed(2)}
                                    </div>
                                </div>
                            </div>

                            {/* Timeline Events */}
                            <div className="relative">
                                <div className="absolute left-4 top-0 bottom-0 w-px bg-white/65"></div>
                                <div className="space-y-3">
                                    {timeline.events.map((event, idx) => {
                                        const { icon, color } = getEventIcon(event.type);
                                        return (
                                            <div key={idx} className="relative pl-10">
                                                <div className={`absolute left-2 w-5 h-5 rounded-full bg-white/55 backdrop-blur-xl border border-black/[0.12] flex items-center justify-center`}>
                                                    <Icon name={icon} size={12} className={color} />
                                                </div>
                                                <div className="glass-card rounded-lg p-3 border border-black/5 hover:border-black/[0.08] transition-colors">
                                                    <div className="flex items-center justify-between gap-4 mb-1">
                                                        <span className="text-xs font-mono text-[#C7654A]">{event.type}</span>
                                                        <span className="text-[10px] font-mono text-[#8B847A]">{formatTime(event.timestamp)}</span>
                                                    </div>
                                                    {event.detail && (
                                                        <p className="text-xs text-[#6B665C]">{event.detail}</p>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// --- Sports Card ---
const SportsCard = ({ market, onOpenTaskModal, onCreateTakerTask, onCancelTask, accounts, tasks = [] }) => {
    const [expanded, setExpanded] = useState(false);
    const isBoosted = Boolean(market.boosted || market.boostStartTime || market.boostEndTime);
    const [takerConfirm, setTakerConfirm] = useState(null); // { direction: 'away'|'home', opp: SportsArbOpportunity }
    const [takerQuantity, setTakerQuantity] = useState(100); // Taker 数量输入
    const [cancelConfirm, setCancelConfirm] = useState(null); // 'away' | 'home' | null
    const [cancelling, setCancelling] = useState(null); // 'away' | 'home' | null
    const gameStartMeta = useGameStartMeta(market.gameStartTime);

    // 体育图标映射
    // 全部走 Lucide 图标；为每个运动选语义最贴近且 lucide@latest UMD 一定包含的图标名
    // 全部走 Lucide 图标；为每个运动选语义最贴近且 lucide@latest UMD 一定包含的图标名
    const sportIconNames = {
        nba: 'circle-dot',       // 篮球：圆球 + 缝线
        nfl: 'shield',           // 美式橄榄球护具
        ncaaf: 'shield',
        nhl: 'snowflake',        // 冰球 = 冰
        mlb: 'circle-dashed',    // 棒球：圆球 + 虚线缝线
        epl: 'volleyball',       // 足球：圆球（lucide 无 soccer-ball，volleyball 形状最接近）
        mma: 'swords',           // 格斗
        lol: 'joystick',         // 电竞（比 gamepad-2 更稳妥）
        cs: 'crosshair',         // 射击
        dota: 'joystick',        // 电竞 Dota 2
        f1: 'flag',              // 赛车
    };
    const sportIconName = sportIconNames[market.sport] || 'trophy';

    // 查找该市场的活跃任务 (Away/Home 两个方向)
    // NBA 双市场: 两个方向都用 predictAwayMarketId，通过 arbSide 区分 (away=YES, home=NO)
    const terminalStatuses = ['COMPLETED', 'FAILED', 'CANCELLED', 'UNWIND_COMPLETED', 'TIMEOUT_CANCELLED'];
    const awayTasks = tasks.filter(t =>
        t.marketId === market.predictAwayMarketId &&
        (t.arbSide === 'YES' || t.arbSide === undefined) &&
        !terminalStatuses.includes(t.status)
    );
    const homeTasks = tasks.filter(t =>
        (t.marketId === market.predictAwayMarketId || t.marketId === market.predictHomeMarketId) &&
        t.arbSide === 'NO' &&
        !terminalStatuses.includes(t.status)
    );
    // 兼容: 单任务引用 (用于角标等只需一个的场景)
    const awayTask = awayTasks[0];
    const homeTask = homeTasks[0];
    const hasActiveTask = awayTasks.length > 0 || homeTasks.length > 0;

    // 任务状态标签和颜色
    const getTaskLabel = (task) => {
        if (!task) return '';
        const status = task.status;
        if (status === 'PENDING') return '待启动';
        if (status === 'PAUSED') return '暂停';
        if (status === 'VALIDATING') return '校验中';
        if (['PREDICT_SUBMITTED', 'PARTIALLY_FILLED', 'HEDGING', 'HEDGE_PENDING', 'HEDGE_RETRY'].includes(status)) return '执行中';
        return 'BUY';
    };
    const getTaskColor = (task) => {
        if (!task) return '#10b981';
        const status = task.status;
        if (status === 'PAUSED') return '#f59e0b';  // 橙色
        if (['PREDICT_SUBMITTED', 'PARTIALLY_FILLED', 'HEDGING', 'HEDGE_PENDING', 'HEDGE_RETRY'].includes(status)) return '#3b82f6';  // 蓝色
        return '#10b981';  // 绿色
    };
    const isTaskExecuting = (task) => {
        if (!task) return false;
        return ['PREDICT_SUBMITTED', 'PARTIALLY_FILLED', 'HEDGING', 'HEDGE_PENDING', 'HEDGE_RETRY'].includes(task.status);
    };

    // 取消任务: 两段确认 (按 taskId)
    const handleCancelClick = (taskId) => {
        if (cancelConfirm === taskId) {
            // 第二次点击: 执行取消
            if (!taskId || !onCancelTask) return;
            setCancelling(taskId);
            setCancelConfirm(null);
            onCancelTask(taskId).finally(() => setCancelling(null));
        } else {
            // 第一次点击: 进入确认状态，3 秒后自动重置
            setCancelConfirm(taskId);
            setTimeout(() => setCancelConfirm(prev => prev === taskId ? null : prev), 3000);
        }
    };

    // orderbook 已从 SSE 移除（减少背压），价格从套利机会字段提取
    // 对于二元 Predict 市场：
    // - awayMT/homeMT 提供的是 YES/NO 的 bid
    // - ask 需要通过互补面的 bid 反推，不能直接拿 POLY_MAKER 的 predictPrice
    const awayMT = market.awayMT || {};
    const awayTT = market.awayTT || {};
    const homeMT = market.homeMT || {};
    const homeTT = market.homeTT || {};
    const pred = {
        awayBid: awayMT.predictPrice, awayBidDepth: awayMT.predictDepth || awayMT.maxQuantity,
        awayAsk: Number.isFinite(homeMT.predictPrice) ? (1 - homeMT.predictPrice) : undefined,
        awayAskDepth: homeMT.predictDepth || homeMT.maxQuantity,
        homeBid: homeMT.predictPrice, homeBidDepth: homeMT.predictDepth || homeMT.maxQuantity,
        homeAsk: Number.isFinite(awayMT.predictPrice) ? (1 - awayMT.predictPrice) : undefined,
        homeAskDepth: awayMT.predictDepth || awayMT.maxQuantity,
    };
    const poly = {
        awayBid: awayTT.polyHedgePrice, awayBidDepth: awayTT.polyDepth || awayTT.maxQuantity,
        awayAsk: homeMT.polyHedgePrice, awayAskDepth: homeMT.maxQuantity,
        homeBid: homeTT.polyHedgePrice, homeBidDepth: homeTT.polyDepth || homeTT.maxQuantity,
        homeAsk: awayMT.polyHedgePrice, homeAskDepth: awayMT.maxQuantity,
    };
    const formatOrderbookPrice = (price, depth) => {
        const p = Number(price);
        const d = Number(depth);
        if (!Number.isFinite(p) || !Number.isFinite(d) || d <= 0 || p <= 0 || p >= 1) {
            return '--';
        }
        return `${(p * 100).toFixed(1)}¢`;
    };
    const flashValueSafe = (price, depth) => {
        const p = Number(price);
        const d = Number(depth);
        if (!Number.isFinite(p) || !Number.isFinite(d) || d <= 0 || p <= 0 || p >= 1) {
            return -1;
        }
        return p;
    };

    // 找到最佳机会
    const bestOpp = market.bestOpportunity;
    const hasArb = bestOpp && bestOpp.profitPercent > 0;

    // 获取套利信息
    // 后端字段名: awayMT, awayTT, homeMT, homeTT
    const getOppInfo = (direction, mode) => {
        const modeKey = mode === 'PREDICT_MAKER' ? 'MT' : 'TT';
        const key = `${direction}${modeKey}`;
        return market[key] || null;
    };

    // 创建 PREDICT_MAKER 任务时转换为标准格式
    const handleCreateMakerTask = (direction) => {
        const opp = getOppInfo(direction, 'PREDICT_MAKER');
        if (!opp || !opp.isValid) return;

        // 转换为 OpportunityCard 期望的格式
        // NBA 双市场结构: Predict 一场比赛 = 2 个独立市场 (Away, Home)
        // 关键: 买主队(Home) = 买客队市场(Away)的 NO
        //
        // direction='away' (买客队):
        //   - marketId = predictAwayMarketId (客队市场)
        //   - arbSide = 'YES' (买客队市场的 YES)
        //   - Poly 对冲 = 买 polymarketHomeTokenId (主队 token)
        //
        // direction='home' (买主队):
        //   - marketId = predictAwayMarketId (仍用客队市场！)
        //   - arbSide = 'NO' (买客队市场的 NO = 主队获胜)
        //   - Poly 对冲 = 买 polymarketAwayTokenId (客队 token)
        const teamName = direction === 'away' ? market.awayTeam : market.homeTeam;
        const taskData = {
            // NBA: 始终使用客队市场 ID，通过 arbSide 控制方向
            marketId: market.predictAwayMarketId,
            title: `${market.predictTitle} - Buy ${teamName}`,
            strategy: 'PREDICT_MAKER',
            side: direction === 'away' ? 'YES' : 'NO',
            arbSide: direction === 'away' ? 'YES' : 'NO',
            predictPrice: opp.predictPrice,
            polymarketPrice: opp.polyHedgePrice,
            profitPercent: opp.profitPercent,
            maxQuantity: opp.maxQuantity,
            estimatedProfit: opp.profit * opp.maxQuantity,
            polymarketConditionId: market.polymarketConditionId,
            // Token 映射:
            // - arbSide='YES' (买客队): YES=客队token, NO=主队token (对冲用)
            // - arbSide='NO' (买主队): YES=客队token, NO=主队token (这次买NO，对冲买YES)
            polymarketYesTokenId: market.polymarketAwayTokenId,
            polymarketNoTokenId: market.polymarketHomeTokenId,
            negRisk: market.negRisk,
            tickSize: market.tickSize,
            feeRateBps: market.feeRateBps,
            isInverted: false,
            predictBid: opp.predictPrice,
            predictAsk: opp.predictPrice,
            isSportsMarket: true,  // 体育市场标识，使用 REST API 获取订单簿
            gameStartTime: market.gameStartTime,  // 供 TaskModal 计算默认倒计时
            // URL 导航 (对齐体育面板 ViewLinks)
            predictSlug: market.predictSlug,
            polymarketSlug: market.polymarketSlug,
        };

        onOpenTaskModal(taskData, 'BUY');
    };

    // 显示 TAKER 确认弹窗
    const handleTakerClick = (direction) => {
        const opp = getOppInfo(direction, 'TAKER');
        if (!opp || !opp.isValid) return;
        // 初始化数量为最大可用量的一半，最小 5
        const initialQty = Math.max(5, Math.min(Math.floor(opp.maxQuantity / 2), 500));
        setTakerQuantity(initialQty);
        setTakerConfirm({ direction, opp });
    };

    // 确认 TAKER 任务
    const handleConfirmTaker = () => {
        if (!takerConfirm) return;

        const { direction, opp } = takerConfirm;
        const teamName = direction === 'away' ? market.awayTeam : market.homeTeam;

        // 计算手续费 (与 depth-calculator 一致)
        const feeRateBps = market.feeRateBps || 200;
        const baseFeePercent = feeRateBps / 10000;
        const minPrice = Math.min(opp.predictPrice, 1 - opp.predictPrice);
        const predictFee = Number((baseFeePercent * minPrice * 0.9).toFixed(6)); // 10% 返点

        // maxTotalCost: 固定为 1（只要 totalCost < 1 就是盈利的）
        const maxTotalCost = 1;

        // 使用用户输入的数量 (最小 5 shares，向下取整到 tickSize)
        const tickSize = market.tickSize || 1;
        const alignedQuantity = Math.floor(takerQuantity / tickSize) * tickSize;
        const quantity = Math.max(alignedQuantity, 5); // 最小 5 shares

        // 构建任务参数 (与 dashboard taker 模式一致)
        // NBA 双市场结构: Predict 一场比赛 = 2 个独立市场 (Away, Home)
        // 关键: 买主队(Home) = 买客队市场(Away)的 NO
        //
        // direction='away' (买客队): arbSide='YES', 对冲买 Poly Home token
        // direction='home' (买主队): arbSide='NO', 对冲买 Poly Away token
        const taskParams = {
            type: 'BUY',
            strategy: 'TAKER',
            // NBA: 始终使用客队市场 ID，通过 arbSide 控制方向
            marketId: market.predictAwayMarketId,
            title: `${market.predictTitle} - Buy ${teamName}`,
            arbSide: direction === 'away' ? 'YES' : 'NO',
            // TAKER BUY 必需字段
            predictAskPrice: Number(opp.predictPrice.toFixed(4)),
            maxTotalCost: maxTotalCost,
            // 对冲价格上限 (加点滑点保护，会被 task-service 重新计算覆盖)
            polymarketMaxAsk: Number((opp.polyHedgePrice + 0.02).toFixed(4)),
            // Token 映射:
            // - arbSide='YES' (买客队): YES=客队token, NO=主队token (对冲买NO)
            // - arbSide='NO' (买主队): YES=客队token, NO=主队token (对冲买YES)
            polymarketConditionId: market.polymarketConditionId,
            polymarketYesTokenId: market.polymarketAwayTokenId,
            polymarketNoTokenId: market.polymarketHomeTokenId,
            // 数量
            quantity: quantity,
            // 配置
            negRisk: market.negRisk,
            tickSize: tickSize,
            feeRateBps: feeRateBps,
            isInverted: false,
            isSportsMarket: true,  // 体育市场标识，使用 REST API 获取订单簿
            // URL 导航 (对齐体育面板 ViewLinks)
            predictSlug: market.predictSlug,
            polymarketSlug: market.polymarketSlug,
        };

        // 调用 Taker 任务创建函数
        if (onCreateTakerTask) {
            onCreateTakerTask(taskParams);
        }

        setTakerConfirm(null);
    };

    // 创建 POLY_MAKER 任务 (Polymarket 优先挂单)
    const handleCreatePolyMakerTask = (direction) => {
        const opp = getOppInfo(direction, 'TAKER');  // 复用 TT 数据（有 polyHedgePrice）
        if (!opp || !opp.isValid) return;

        const teamName = direction === 'away' ? market.awayTeam : market.homeTeam;
        const taskData = {
            marketId: market.predictAwayMarketId,
            title: `${market.predictTitle} - Buy ${teamName}`,
            strategy: 'POLY_MAKER',
            side: direction === 'away' ? 'YES' : 'NO',
            arbSide: direction === 'away' ? 'YES' : 'NO',
            // POLY_MAKER: polyHedgePrice 是 Polymarket 对冲方向的 ask 价格
            predictPrice: opp.predictPrice,
            predictBid: opp.predictPrice,
            predictAsk: opp.predictPrice,
            polymarketPrice: opp.polyHedgePrice,
            profitPercent: opp.profitPercent,
            maxQuantity: opp.maxQuantity,
            estimatedProfit: opp.profit * opp.maxQuantity,
            polymarketConditionId: market.polymarketConditionId,
            polymarketYesTokenId: market.polymarketAwayTokenId,
            polymarketNoTokenId: market.polymarketHomeTokenId,
            negRisk: market.negRisk,
            tickSize: market.tickSize,
            feeRateBps: market.feeRateBps,
            isInverted: false,
            isSportsMarket: true,
            gameStartTime: market.gameStartTime,
            predictSlug: market.predictSlug,
            polymarketSlug: market.polymarketSlug,
        };

        onOpenTaskModal(taskData, 'BUY');
    };

    // 渲染 P. 按钮 (Predict 优先挂单, PREDICT_MAKER 策略)
    const renderMakerButton = (direction) => {
        const opp = getOppInfo(direction, 'PREDICT_MAKER');
        const teamName = direction === 'away' ? market.awayTeam : market.homeTeam;

        if (!opp || !opp.isValid) {
            return (
                <button disabled className="flex-1 px-2 py-1.5 rounded-lg bg-[#F5F1EB] text-[#A39C8E] text-[10px] cursor-not-allowed">
                    <span className="font-medium">{teamName}</span>
                    <span className="ml-1 opacity-70">(P.)</span>
                    <span className="block">--</span>
                </button>
            );
        }

        return (
            <button
                onClick={() => handleCreateMakerTask(direction)}
                className="flex-1 px-2 py-1.5 rounded-lg bg-emerald-500 border border-emerald-500 text-white text-[10px] hover:bg-emerald-600 shadow-[0_1px_3px_rgba(60,50,40,0.10)] transition-colors"
            >
                <span className="font-medium">{teamName}</span>
                <span className="ml-1 opacity-70">(P.)</span>
                <span className="ml-1 text-[#8B847A]">{Math.floor(opp.maxQuantity)}</span>
                <span className="block font-mono">+{opp.profitPercent.toFixed(2)}%</span>
            </button>
        );
    };

    // 渲染 M. 按钮 (Polymarket 优先挂单, POLY_MAKER 策略)
    const renderPolyMakerButton = (direction) => {
        const opp = getOppInfo(direction, 'TAKER');
        const teamName = direction === 'away' ? market.awayTeam : market.homeTeam;

        if (!opp || !opp.isValid) {
            return (
                <button disabled className="flex-1 px-2 py-1.5 rounded-lg bg-[#F5F1EB] text-[#A39C8E] text-[10px] cursor-not-allowed">
                    <span className="font-medium">{teamName}</span>
                    <span className="ml-1 opacity-70">(M.)</span>
                    <span className="block">--</span>
                </button>
            );
        }

        return (
            <button
                onClick={() => handleCreatePolyMakerTask(direction)}
                className="flex-1 px-2 py-1.5 rounded-lg bg-purple-500 border border-purple-500 text-white text-[10px] hover:bg-purple-600 shadow-[0_1px_3px_rgba(60,50,40,0.10)] transition-colors"
            >
                <span className="font-medium">{teamName}</span>
                <span className="ml-1 opacity-70">(M.)</span>
                <span className="ml-1 text-[#8B847A]">{Math.floor(opp.maxQuantity)}</span>
                <span className="block font-mono">+{opp.profitPercent.toFixed(2)}%</span>
            </button>
        );
    };

    return (
        <div className="group">
            <div className={`glass-card rounded-xl transition-all duration-300 overflow-hidden h-full relative
                ${isBoosted ? 'border-2 border-[#C7654A]/70 shadow-[0_0_12px_rgba(217,119,87,0.18)]' : 'border border-black/5'}
                ${expanded ? 'border-[#D97757]/35 shadow-glow-sm bg-white/55 backdrop-blur-xl' : 'hover:border-white/50 hover:scale-[1.005]'}
                ${hasArb ? 'ring-1 ring-emerald-500/20' : ''}
                ${hasActiveTask ? 'ring-1 ring-blue-500/30' : ''}`}>

                {/* 任务标签 (斜角丝带) - Away 任务 */}
                {awayTask && (
                    <div
                        className={`absolute top-2 -left-7 transform -rotate-45 text-[9px] font-semibold uppercase tracking-wider text-[#1A1915] px-8 py-0.5 z-10 pointer-events-none ${isTaskExecuting(awayTask) ? 'animate-pulse' : ''}`}
                        style={{ background: getTaskColor(awayTask) }}
                        title={`Away 任务 x${awayTasks.length} | ${awayTasks.map(t => `${t.strategy === 'POLY_MAKER' ? 'M.' : 'P.'} ${t.status}`).join(', ')}`}
                    >
                        {market.awayTeam?.slice(0, 3)} {awayTasks.length > 1 ? `x${awayTasks.length}` : getTaskLabel(awayTask)}
                    </div>
                )}
                {/* 任务标签 (斜角丝带) - Home 任务 (显示在右上角) */}
                {homeTask && (
                    <div
                        className={`absolute top-2 -right-7 transform rotate-45 text-[9px] font-semibold uppercase tracking-wider text-[#1A1915] px-8 py-0.5 z-10 pointer-events-none ${isTaskExecuting(homeTask) ? 'animate-pulse' : ''}`}
                        style={{ background: getTaskColor(homeTask) }}
                        title={`Home 任务 x${homeTasks.length} | ${homeTasks.map(t => `${t.strategy === 'POLY_MAKER' ? 'M.' : 'P.'} ${t.status}`).join(', ')}`}
                    >
                        {market.homeTeam?.slice(0, 3)} {homeTasks.length > 1 ? `x${homeTasks.length}` : getTaskLabel(homeTask)}
                    </div>
                )}

                {/* Header */}
                <div className="p-5 cursor-pointer" onClick={() => setExpanded(!expanded)}>
                    {/* Top Row */}
                    <div className="flex items-start justify-between mb-4">
                        <div className="min-w-0 flex-1">
                            {/* 第一行: 运动图标 + SPORT 标签 + 队伍标题 + 导航按钮 */}
                            <div className="flex items-center gap-2 mb-1.5">
                                <Icon name={sportIconName} size={20} className="text-[#6B665C]" />
                                <span className="inline-flex items-center px-3 py-1 rounded-lg border-2 border-black/[0.12] bg-white/65 text-[#1A1915] text-sm font-bold tracking-wide">
                                    {market.sport?.toUpperCase()}
                                </span>
                                <h3 className="text-base font-medium text-[#1A1915]">{market.awayTeam} @ {market.homeTeam}</h3>
                                <ViewLinks
                                    predictId={market.predictMarketId}
                                    predictSlug={market.predictSlug}
                                    polymarketSlug={market.polymarketSlug}
                                    polymarketConditionId={market.polymarketConditionId}
                                    title={market.predictTitle}
                                    sportsTeams={`${market.awayTeam} ${market.homeTeam}`}
                                />
                            </div>
                            {/* 第二行: 时间 + PP + boost + 异常 */}
                            <div className="flex flex-wrap items-center gap-2">
                                <SportsTimeBadge gameStartTime={market.gameStartTime} />
                                {isBoosted && <BoostCountdown boostStartTime={market.boostStartTime} boostEndTime={market.boostEndTime} />}
                                <PointsBadge
                                    tier={market.pointsTier}
                                    hourlyRate={market.pointsHourlyRate}
                                    nextTier={market.pointsNextTier}
                                    nextHourlyRate={market.pointsNextHourlyRate}
                                    yieldValue={market.pointsYield}
                                />
                                {!market.consistency?.isValid && <Badge variant="danger" icon="alert-triangle">异常</Badge>}
                            </div>
                            <div className="flex items-center gap-3 text-xs text-[#8B847A] mt-1">
                                {(market.predictVolume > 0 || market.polymarketVolume > 0) && (
                                    <span>
                                        <Icon name="activity" size={12} className="inline mr-1" />
                                        Vol: ${(market.predictVolume / 1000).toFixed(0)}K | ${(market.polymarketVolume / 1000).toFixed(0)}K
                                    </span>
                                )}
                            </div>
                        </div>
                        {hasArb && (
                            <div className="text-right flex-shrink-0">
                                <div className="text-xl font-display font-semibold text-[#1A1915]">
                                    +{bestOpp.profitPercent.toFixed(2)}%
                                </div>
                            </div>
                        )}
                        <div className={`ml-2 text-[#8B847A] transition-transform duration-300 ${expanded ? 'rotate-180 text-[#B85A3F]' : ''}`}>
                            <Icon name="chevron-down" size={20} />
                        </div>
                    </div>

                    {/* Price Table */}
                    <div className="grid grid-cols-3 gap-2 text-xs font-mono mb-3">
                        <div className="text-[#8B847A]"></div>
                        <div className="text-center text-[#6B665C]">{market.awayTeam}</div>
                        <div className="text-center text-[#6B665C]">{market.homeTeam}</div>

                        <div className="text-[#8B847A]">P.Bid</div>
                        <FlashValue value={flashValueSafe(pred.awayBid, pred.awayBidDepth)} className="text-center text-blue-400 block">
                            {formatOrderbookPrice(pred.awayBid, pred.awayBidDepth)}
                        </FlashValue>
                        <FlashValue value={flashValueSafe(pred.homeBid, pred.homeBidDepth)} className="text-center text-blue-400 block">
                            {formatOrderbookPrice(pred.homeBid, pred.homeBidDepth)}
                        </FlashValue>

                        <div className="text-[#8B847A]">P.Ask</div>
                        <FlashValue value={flashValueSafe(pred.awayAsk, pred.awayAskDepth)} className="text-center text-blue-400 block">
                            {formatOrderbookPrice(pred.awayAsk, pred.awayAskDepth)}
                        </FlashValue>
                        <FlashValue value={flashValueSafe(pred.homeAsk, pred.homeAskDepth)} className="text-center text-blue-400 block">
                            {formatOrderbookPrice(pred.homeAsk, pred.homeAskDepth)}
                        </FlashValue>

                        <div className="text-[#8B847A]">M.Bid</div>
                        <FlashValue value={flashValueSafe(poly.awayBid, poly.awayBidDepth)} className="text-center text-purple-400 block">
                            {formatOrderbookPrice(poly.awayBid, poly.awayBidDepth)}
                        </FlashValue>
                        <FlashValue value={flashValueSafe(poly.homeBid, poly.homeBidDepth)} className="text-center text-purple-400 block">
                            {formatOrderbookPrice(poly.homeBid, poly.homeBidDepth)}
                        </FlashValue>

                        <div className="text-[#8B847A]">M.Ask</div>
                        <FlashValue value={flashValueSafe(poly.awayAsk, poly.awayAskDepth)} className="text-center text-purple-400 block">
                            {formatOrderbookPrice(poly.awayAsk, poly.awayAskDepth)}
                        </FlashValue>
                        <FlashValue value={flashValueSafe(poly.homeAsk, poly.homeAskDepth)} className="text-center text-purple-400 block">
                            {formatOrderbookPrice(poly.homeAsk, poly.homeAskDepth)}
                        </FlashValue>
                    </div>

                    {/* Arb Buttons - 4 buttons in 2x2 grid */}
                    <div className="space-y-1.5" onClick={(e) => e.stopPropagation()}>
                        {/* P. Row */}
                        <div className="grid grid-cols-2 gap-1.5">
                            {renderMakerButton('away')}
                            {renderMakerButton('home')}
                        </div>
                        {/* M. Row */}
                        <div className="grid grid-cols-2 gap-1.5">
                            {renderPolyMakerButton('away')}
                            {renderPolyMakerButton('home')}
                        </div>
                        {/* Cancel Task Rows - P. 在上, M. 在下 */}
                        {hasActiveTask && (() => {
                            const renderCancelBtn = (task, teamName) => {
                                if (!task) return <div />;
                                const isPM = task.strategy === 'POLY_MAKER';
                                const tid = task.id;
                                const colorClasses = isPM
                                    ? {
                                        idle: 'bg-purple-500/10 border border-purple-500/30 text-purple-400 hover:bg-purple-500/20',
                                        confirm: 'bg-purple-500/20 border border-purple-500/50 text-purple-400 animate-pulse',
                                    }
                                    : {
                                        idle: 'bg-emerald-500/10 border border-emerald-500/30 text-[#1A1915] hover:bg-emerald-500/20',
                                        confirm: 'bg-emerald-500/20 border border-emerald-500/50 text-[#1A1915] animate-pulse',
                                    };
                                return (
                                    <button
                                        key={tid}
                                        onClick={() => handleCancelClick(tid)}
                                        disabled={cancelling === tid}
                                        className={`flex-1 px-2 py-1.5 rounded-lg text-[10px] transition-all ${
                                            cancelling === tid
                                                ? 'bg-white/50 text-[#A39C8E] cursor-wait'
                                                : cancelConfirm === tid
                                                    ? colorClasses.confirm
                                                    : colorClasses.idle
                                        }`}
                                    >
                                        {cancelling === tid ? '取消中...'
                                            : cancelConfirm === tid ? '确认取消'
                                            : `✕ ${isPM ? 'M.' : 'P.'} ${teamName} ${task.filledShares || 0}/${task.quantity} @${((isPM ? task.polyBidPrice : task.predictPrice) * 100).toFixed(1)}¢`}
                                    </button>
                                );
                            };
                            const rows = [
                                { strat: 'PREDICT_MAKER', away: awayTasks.find(t => (t.strategy || 'PREDICT_MAKER') === 'PREDICT_MAKER'), home: homeTasks.find(t => (t.strategy || 'PREDICT_MAKER') === 'PREDICT_MAKER') },
                                { strat: 'POLY_MAKER', away: awayTasks.find(t => t.strategy === 'POLY_MAKER'), home: homeTasks.find(t => t.strategy === 'POLY_MAKER') },
                            ].filter(r => r.away || r.home);
                            return (
                                <div className="flex flex-col gap-1">
                                    {rows.map(r => (
                                        <div key={r.strat} className="grid grid-cols-2 gap-1.5">
                                            {renderCancelBtn(r.away, market.awayTeam)}
                                            {renderCancelBtn(r.home, market.homeTeam)}
                                        </div>
                                    ))}
                                </div>
                            );
                        })()}
                    </div>
                </div>

                {/* Taker Confirmation Modal - 使用 Portal 渲染到 body，避免被 overflow-hidden 裁切 */}
                {takerConfirm && ReactDOM.createPortal((() => {
                    // 计算资金占用
                    const opp = takerConfirm.opp;
                    const feeRateBps = market.feeRateBps || 200;
                    const baseFeePercent = feeRateBps / 10000;
                    const minPrice = Math.min(opp.predictPrice, 1 - opp.predictPrice);
                    const predictFee = baseFeePercent * minPrice * 0.9;
                    const predictRequired = opp.predictPrice * takerQuantity + predictFee * takerQuantity;
                    const polyRequired = opp.polyHedgePrice * takerQuantity;
                    const predictBalance = accounts?.predict?.available || 0;
                    const polyBalance = accounts?.polymarket?.available || 0;
                    const predictInsufficient = predictRequired > predictBalance;
                    const polyInsufficient = polyRequired > polyBalance;
                    const polyBelowMin = polyRequired > 0 && polyRequired < 1;
                    const canSubmit = !predictInsufficient && !polyInsufficient && !polyBelowMin && takerQuantity >= 5;

                    return (
                        <div className="fixed inset-0 bg-white/40 backdrop-blur-sm flex items-center justify-center z-50">
                            <div className="bg-white/55 backdrop-blur-xl border border-black/[0.12] rounded-xl p-5 max-w-md w-full mx-4 shadow-xl">
                                <div className="flex items-center justify-between mb-4">
                                    <div className="flex items-center gap-2">
                                        <Icon name="zap" size={20} className="text-[#C7654A]" />
                                        <h3 className="text-lg font-medium text-[#1A1915]">Taker 套利 - {takerConfirm.direction === 'away' ? market.awayTeam : market.homeTeam}</h3>
                                    </div>
                                    <button
                                        onClick={() => setTakerConfirm(null)}
                                        className="w-8 h-8 rounded-lg bg-white/65 hover:bg-rose-500/20 text-[#6B665C] hover:text-rose-400 transition-all flex items-center justify-center"
                                        title="关闭">
                                        <Icon name="x" size={18} />
                                    </button>
                                </div>

                                {/* 价格信息 */}
                                <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
                                    <div className="bg-white/50 rounded-lg p-3">
                                        <div className="text-[#8B847A] text-xs mb-1">Predict Ask</div>
                                        <div className="text-blue-400 font-mono text-lg">
                                            {(opp.predictPrice * 100).toFixed(2)}¢
                                        </div>
                                    </div>
                                    <div className="bg-white/50 rounded-lg p-3">
                                        <div className="text-[#8B847A] text-xs mb-1">Poly 对冲</div>
                                        <div className="text-purple-400 font-mono text-lg">
                                            {(opp.polyHedgePrice * 100).toFixed(2)}¢
                                        </div>
                                    </div>
                                </div>

                                {/* 数量输入 */}
                                <div className="mb-4">
                                    <label className="block text-xs text-[#8B847A] mb-1">买入数量 (Shares)</label>
                                    <input
                                        type="text"
                                        inputMode="numeric"
                                        pattern="[0-9]*"
                                        value={takerQuantity}
                                        onChange={(e) => {
                                            const val = e.target.value;
                                            if (val === '' || /^\d+$/.test(val)) {
                                                setTakerQuantity(val === '' ? '' : parseInt(val));
                                            }
                                        }}
                                        onBlur={(e) => {
                                            if (e.target.value === '' || parseInt(e.target.value) < 5) {
                                                setTakerQuantity(5);
                                            }
                                        }}
                                        className="w-full bg-white/55 backdrop-blur-xl border border-black/[0.12] rounded-lg px-3 py-2 text-[#1A1915] font-mono text-sm focus:outline-none focus:border-[#D97757]"
                                    />
                                    <div className="text-xs text-[#8B847A] mt-1">最大深度: {opp.maxQuantity?.toFixed(0) || '-'} shares</div>
                                </div>

                                {/* 利润预估 */}
                                <div className="flex justify-between items-center mb-4 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                                    <span className="text-[#6B665C] text-sm">预估利润</span>
                                    <div className="text-right">
                                        <span className="text-[#1A1915] font-mono text-lg">+{opp.profitPercent.toFixed(2)}%</span>
                                        <span className="text-[#1A1915]/75 text-sm ml-2">
                                            (${(opp.profitPercent / 100 * takerQuantity).toFixed(2)})
                                        </span>
                                    </div>
                                </div>

                                {/* 资金占用 */}
                                <div className="bg-white/50 rounded-lg p-3 mb-4 space-y-2">
                                    <div className="text-xs text-[#8B847A] font-medium">资金占用</div>
                                    <div className="flex justify-between items-center">
                                        <div className="flex items-center gap-2">
                                            <div className="w-4 h-4 rounded bg-blue-500/20 flex items-center justify-center">
                                                <span className="text-[8px] font-bold text-blue-400">P</span>
                                            </div>
                                            <span className="text-xs text-[#6B665C]">Predict</span>
                                        </div>
                                        <div className="text-right">
                                            <span className={`font-mono text-sm ${predictInsufficient ? 'text-rose-400' : 'text-[#1A1915]'}`}>
                                                ${predictRequired.toFixed(2)}
                                            </span>
                                            <span className="text-xs text-[#8B847A] ml-1">/ ${predictBalance.toFixed(2)}</span>
                                            {predictInsufficient && <span className="text-[10px] text-rose-400 ml-1">不足</span>}
                                        </div>
                                    </div>
                                    <div className="flex justify-between items-center">
                                        <div className="flex items-center gap-2">
                                            <div className="w-4 h-4 rounded bg-purple-500/20 flex items-center justify-center">
                                                <span className="text-[8px] font-bold text-purple-400">M</span>
                                            </div>
                                            <span className="text-xs text-[#6B665C]">Polymarket</span>
                                        </div>
                                        <div className="text-right">
                                            <span className={`font-mono text-sm ${(polyInsufficient || polyBelowMin) ? 'text-rose-400' : 'text-[#1A1915]'}`}>
                                                ${polyRequired.toFixed(2)}
                                            </span>
                                            <span className="text-xs text-[#8B847A] ml-1">/ ${polyBalance.toFixed(2)}</span>
                                            {polyInsufficient && <span className="text-[10px] text-rose-400 ml-1">不足</span>}
                                            {polyBelowMin && <span className="text-[10px] text-rose-400 ml-1">最小$1</span>}
                                        </div>
                                    </div>
                                </div>

                                <div className="p-3 bg-[#D97757]/12 border border-[#D97757]/25 rounded-lg mb-4 text-xs text-[#D97757]">
                                    <Icon name="alert-triangle" size={14} className="inline mr-1" />
                                    Taker 模式将立即以当前 Ask 价格买入，请确认价格和深度！
                                </div>

                                <div className="flex gap-3">
                                    <button
                                        onClick={() => setTakerConfirm(null)}
                                        className="flex-1 px-4 py-2 rounded-lg bg-white/65 text-[#3A342C] hover:bg-white/75 transition-colors"
                                    >
                                        取消
                                    </button>
                                    <button
                                        onClick={handleConfirmTaker}
                                        disabled={!canSubmit}
                                        className={`flex-1 px-4 py-2 rounded-lg font-medium transition-colors ${
                                            canSubmit
                                                ? 'bg-[#D97757] text-[#1A1915] hover:bg-[#C7654A]'
                                                : 'bg-white/75 text-[#8B847A] cursor-not-allowed'
                                        }`}
                                    >
                                        确认买入
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })(), document.body)}

                {/* Expanded Details */}
                {expanded && (
                    <div className="px-5 pb-5 border-t border-black/5 pt-4">
                        <div className="grid grid-cols-2 gap-4 text-xs">
                            <div>
                                <div className="text-[#8B847A] mb-1">Predict ID</div>
                                <div className="font-mono text-[#3A342C]">{market.predictMarketId}</div>
                            </div>
                            <div>
                                <div className="text-[#8B847A] mb-1">Volume (P|M)</div>
                                <div className="font-mono text-[#3A342C]">${(market.predictVolume || 0).toLocaleString()} | ${(market.polymarketVolume || 0).toLocaleString()}</div>
                            </div>
                            <div className="col-span-2">
                                <div className="text-[#8B847A] mb-1">Condition ID</div>
                                <div className="font-mono text-[#6B665C] text-[10px] truncate">{market.polymarketConditionId}</div>
                            </div>
                            {market.consistency?.warning && (
                                <div className="col-span-2 p-2 rounded bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[10px]">
                                    ⚠️ {market.consistency.warning}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

// --- Football Three-Way Demo Card (A / Draw / B, 12 buttons) ---
const FootballThreeWayCardDemo = ({ eventTitle, marketsByKind, onOpenTaskModal, onCreateTakerTask, onCancelTask, accounts, tasks = [] }) => {
    const [takerConfirm, setTakerConfirm] = useState(null); // { market, selectionName, side, opp }
    const [takerQuantity, setTakerQuantity] = useState(100);
    const [cancelConfirmTaskId, setCancelConfirmTaskId] = useState(null);
    const [cancellingTaskId, setCancellingTaskId] = useState(null);

    const isEsports = !!(marketsByKind?.match || marketsByKind?.game1 || marketsByKind?.game2);
    const orderedKinds = isEsports ? ['match', 'game1', 'game2'] : ['teamA', 'draw', 'teamB'];
    const cardSportIconNames = {
        nba: 'circle-dot', nfl: 'shield', ncaaf: 'shield', nhl: 'snowflake',
        mlb: 'circle-dashed', epl: 'volleyball', mma: 'swords',
        lol: 'joystick', cs: 'crosshair', dota: 'joystick', f1: 'flag',
    };
    const cardSportLabels = {
        nba: 'NBA', nfl: 'NFL', ncaaf: 'NCAAF', nhl: 'NHL', mlb: 'MLB',
        epl: 'FOOTBALL', mma: 'MMA', lol: 'LOL', cs: 'CS2', dota: 'DOTA', f1: 'F1',
    };
    const orderedButtons = [
        { side: 'YES', mode: 'PREDICT_MAKER', label: 'YES-P.' },
        { side: 'NO', mode: 'PREDICT_MAKER', label: 'NO-P.' },
        { side: 'YES', mode: 'TAKER', label: 'YES-M.' },
        { side: 'NO', mode: 'TAKER', label: 'NO-M.' },
    ];

    const selectionMarkets = orderedKinds
        .map((kind) => marketsByKind?.[kind])
        .filter(Boolean);
    const baseMarket = selectionMarkets[0] || null;
    if (!baseMarket) return null;
    const boostSourceMarket = selectionMarkets.find(m => Boolean(m?.boosted || m?.boostStartTime || m?.boostEndTime)) || null;
    const isBoosted = Boolean(boostSourceMarket);
    const boostStartTime = boostSourceMarket?.boostStartTime;
    const boostEndTime = boostSourceMarket?.boostEndTime;

    const getSelectionName = (market) => {
        if (!market) return 'Unknown';
        if (market.selectionKind === 'draw') return 'Draw';
        if (market.selectionKind === 'match') return 'Match Winner';
        if (market.selectionKind === 'game1') return 'Game 1';
        if (market.selectionKind === 'game2') return 'Game 2';
        return market.selectionLabel || market.predictTitle || 'Unknown';
    };

    const terminalStatuses = ['COMPLETED', 'FAILED', 'CANCELLED', 'UNWIND_COMPLETED', 'TIMEOUT_CANCELLED'];
    const executingStatuses = ['PREDICT_SUBMITTED', 'PARTIALLY_FILLED', 'HEDGING', 'HEDGE_PENDING', 'HEDGE_RETRY'];
    const isTaskExecuting = (task) => !!task && executingStatuses.includes(task.status);

    const activeTaskEntries = selectionMarkets.flatMap((market) => {
        const selectionName = getSelectionName(market);
        const marketId = market.predictAwayMarketId || market.predictMarketId;
        const yesTask = tasks.find(t =>
            Number(t.marketId) === Number(marketId) &&
            (t.arbSide === 'YES' || t.arbSide === undefined) &&
            !terminalStatuses.includes(t.status)
        );
        const noTask = tasks.find(t =>
            Number(t.marketId) === Number(marketId) &&
            t.arbSide === 'NO' &&
            !terminalStatuses.includes(t.status)
        );
        const entries = [];
        if (yesTask) entries.push({ market, selectionName, side: 'YES', task: yesTask });
        if (noTask) entries.push({ market, selectionName, side: 'NO', task: noTask });
        return entries;
    });
    const hasActiveTask = activeTaskEntries.length > 0;
    const anyTaskExecuting = activeTaskEntries.some(entry => isTaskExecuting(entry.task));
    const getCancelEntry = (market, side) => {
        if (!market) return null;
        const marketId = market.predictAwayMarketId || market.predictMarketId;
        return activeTaskEntries.find(entry =>
            Number(entry.task?.marketId) === Number(marketId) &&
            entry.side === side
        ) || null;
    };

    const getOpp = (market, side, mode) => {
        if (!market) return null;
        if (side === 'YES') return mode === 'PREDICT_MAKER' ? market.awayMT : market.awayTT;
        return mode === 'PREDICT_MAKER' ? market.homeMT : market.homeTT;
    };

    const formatOutcomeAsk = (price, depth) => {
        const p = Number(price);
        const d = Number(depth);
        if (!Number.isFinite(p) || !Number.isFinite(d) || d <= 0 || p <= 0 || p >= 1) return '--';
        return `${(p * 100).toFixed(1)}¢`;
    };

    const getOutcomeAskCompare = (market) => {
        // 当前 selection 的 YES ask：
        // - Predict: YES ask = 1 - NO bid
        // - Polymarket: YES ask = 当前 selection token 的 ask
        const awayMT = market?.awayMT || {};
        const homeMT = market?.homeMT || {};
        return {
            predictAsk: formatOutcomeAsk(
                Number.isFinite(homeMT.predictPrice) ? (1 - homeMT.predictPrice) : undefined,
                homeMT.predictDepth || homeMT.maxQuantity,
            ),
            polymarketAsk: formatOutcomeAsk(homeMT.polyHedgePrice, homeMT.polyDepth || homeMT.maxQuantity),
        };
    };

    const totalPredictVol = selectionMarkets.reduce((sum, m) => sum + (m.predictVolume || 0), 0);
    const totalPolyVol = selectionMarkets.reduce((sum, m) => sum + (m.polymarketVolume || 0), 0);
    const gameStartTime = selectionMarkets.find(m => m.gameStartTime)?.gameStartTime || null;
    const gameStartMeta = useGameStartMeta(gameStartTime);
    const teamALabel = isEsports
        ? (baseMarket?.eventTitle || '')
        : getSelectionName(marketsByKind?.teamA);
    const teamBLabel = isEsports
        ? ''
        : getSelectionName(marketsByKind?.teamB);
    const sportsTeams = [teamALabel, teamBLabel].filter(Boolean).join(' ');

    const buildTaskTitle = (market, selectionName, _side) => {
        const prefix = eventTitle || market.eventTitle || market.predictTitle;
        return `${prefix} - ${selectionName}`;
    };

    const handleCancelTaskClick = (entry) => {
        if (!entry?.task?.id || !onCancelTask) return;
        const taskId = entry.task.id;
        if (cancelConfirmTaskId === taskId) {
            setCancellingTaskId(taskId);
            setCancelConfirmTaskId(null);
            Promise.resolve(onCancelTask(taskId))
                .finally(() => setCancellingTaskId(prev => prev === taskId ? null : prev));
            return;
        }
        setCancelConfirmTaskId(taskId);
        setTimeout(() => setCancelConfirmTaskId(prev => prev === taskId ? null : prev), 3000);
    };

    const openMakerTask = (market, selectionName, side, opp) => {
        if (!opp || !opp.isValid) return;
        const taskData = {
            marketId: market.predictAwayMarketId || market.predictMarketId,
            title: buildTaskTitle(market, selectionName, side),
            strategy: 'PREDICT_MAKER',
            side,
            arbSide: side,
            predictPrice: opp.predictPrice,
            polymarketPrice: opp.polyHedgePrice,
            profitPercent: opp.profitPercent,
            maxQuantity: opp.maxQuantity,
            estimatedProfit: opp.profit * opp.maxQuantity,
            polymarketConditionId: market.polymarketConditionId,
            polymarketYesTokenId: market.polymarketAwayTokenId,
            polymarketNoTokenId: market.polymarketHomeTokenId,
            negRisk: market.negRisk,
            tickSize: market.tickSize,
            feeRateBps: market.feeRateBps,
            isInverted: false,
            predictBid: opp.predictPrice,
            predictAsk: opp.predictPrice,
            isSportsMarket: true,
            gameStartTime: market.gameStartTime,
            predictSlug: market.predictSlug,
            polymarketSlug: market.polymarketSlug,
        };

        onOpenTaskModal(taskData, 'BUY');
    };

    const openTakerConfirm = (market, selectionName, side, opp) => {
        if (!opp || !opp.isValid) return;
        const initialQty = Math.max(5, Math.min(Math.floor((opp.maxQuantity || 0) / 2), 500));
        setTakerQuantity(initialQty);
        setTakerConfirm({ market, selectionName, side, opp });
    };

    // POLY_MAKER: Polymarket 优先挂单，打开 TaskModal
    const openPolyMakerTask = (market, selectionName, side, opp) => {
        if (!opp || !opp.isValid) return;
        const taskData = {
            marketId: market.predictAwayMarketId || market.predictMarketId,
            title: buildTaskTitle(market, selectionName, side),
            strategy: 'POLY_MAKER',
            side,
            arbSide: side,
            predictPrice: opp.predictPrice,
            predictBid: opp.predictPrice,
            predictAsk: opp.predictPrice,
            polymarketPrice: opp.polyHedgePrice,
            profitPercent: opp.profitPercent,
            maxQuantity: opp.maxQuantity,
            estimatedProfit: opp.profit * opp.maxQuantity,
            polymarketConditionId: market.polymarketConditionId,
            polymarketYesTokenId: market.polymarketAwayTokenId,
            polymarketNoTokenId: market.polymarketHomeTokenId,
            negRisk: market.negRisk,
            tickSize: market.tickSize,
            feeRateBps: market.feeRateBps,
            isInverted: false,
            isSportsMarket: true,
            gameStartTime: market.gameStartTime,
            predictSlug: market.predictSlug,
            polymarketSlug: market.polymarketSlug,
        };

        onOpenTaskModal(taskData, 'BUY');
    };

    const confirmTaker = () => {
        if (!takerConfirm) return;
        const { market, selectionName, side, opp } = takerConfirm;

        const feeRateBps = market.feeRateBps || 200;
        const tickSize = market.tickSize || 1;
        const alignedQuantity = Math.floor((Number(takerQuantity) || 0) / tickSize) * tickSize;
        const quantity = Math.max(alignedQuantity, 5);

        const taskParams = {
            type: 'BUY',
            strategy: 'TAKER',
            marketId: market.predictAwayMarketId || market.predictMarketId,
            title: buildTaskTitle(market, selectionName, side),
            arbSide: side,
            predictAskPrice: Number((opp.predictPrice || 0).toFixed(4)),
            maxTotalCost: 1,
            polymarketMaxAsk: Number(((opp.polyHedgePrice || 0) + 0.02).toFixed(4)),
            polymarketConditionId: market.polymarketConditionId,
            polymarketYesTokenId: market.polymarketAwayTokenId,
            polymarketNoTokenId: market.polymarketHomeTokenId,
            quantity,
            negRisk: market.negRisk,
            tickSize,
            feeRateBps,
            isInverted: false,
            isSportsMarket: true,
            predictSlug: market.predictSlug,
            polymarketSlug: market.polymarketSlug,
        };

        if (onCreateTakerTask) {
            onCreateTakerTask(taskParams);
        }
        setTakerConfirm(null);
    };

    const renderActionButton = (market, selectionName, cfg) => {
        const opp = getOpp(market, cfg.side, cfg.mode);
        const canClick = opp && opp.isValid;
        const baseClass = cfg.mode === 'PREDICT_MAKER'
            ? 'bg-emerald-500 border-emerald-500 text-white hover:bg-emerald-600 shadow-[0_1px_3px_rgba(60,50,40,0.10)]'
            : 'bg-purple-500 border-purple-500 text-white hover:bg-purple-600 shadow-[0_1px_3px_rgba(60,50,40,0.10)]';

        if (!canClick) {
            return (
                <button key={cfg.label} disabled className="px-1.5 py-1 rounded-md bg-[#F5F1EB] text-[#A39C8E] text-[10px] cursor-not-allowed">
                    <span className="block font-mono">{cfg.label}</span>
                    <span className="block text-[9px]">Max --</span>
                    <span className="block">--</span>
                </button>
            );
        }

        const clickHandler = cfg.mode === 'PREDICT_MAKER'
            ? () => openMakerTask(market, selectionName, cfg.side, opp)
            : () => openPolyMakerTask(market, selectionName, cfg.side, opp);

        return (
            <button
                key={cfg.label}
                onClick={clickHandler}
                className={`px-1.5 py-1 rounded-md border text-[10px] transition-all ${baseClass}`}
            >
                <span className="block font-mono">{cfg.label}</span>
                <span className="block text-[9px] text-[#8B847A]">Max {Math.floor(opp.maxQuantity || 0)}</span>
                <span className="block font-mono">+{opp.profitPercent.toFixed(2)}%</span>
            </button>
        );
    };

    return (
        <div className="group">
            <div className={`glass-card rounded-xl transition-all duration-300 overflow-hidden h-full
                relative
                ${isBoosted ? 'border-2 border-[#C7654A]/70 shadow-[0_0_12px_rgba(217,119,87,0.18)]' : 'border border-black/5'}
                hover:border-white/50`}>
                {hasActiveTask && (
                    <div
                        className={`absolute top-2 -left-8 transform -rotate-45 text-[9px] font-semibold uppercase tracking-wider text-[#1A1915] px-9 py-0.5 z-10 pointer-events-none ${anyTaskExecuting ? 'animate-pulse' : ''}`}
                        style={{ background: anyTaskExecuting ? '#3b82f6' : '#10b981' }}
                        title={`活跃任务: ${activeTaskEntries.length}`}
                    >
                        任务 x{activeTaskEntries.length}
                    </div>
                )}
                <div className="p-5">
                    <div className="flex items-start justify-between mb-4">
                        <div className="min-w-0 flex-1">
                            {/* 第一行: 运动图标 + SPORT 标签 + 标题 + 导航按钮 */}
                            <div className="flex items-center gap-2 mb-1.5">
                                <Icon name={cardSportIconNames[baseMarket.sport] || 'volleyball'} size={20} className="text-[#6B665C]" />
                                <span className="inline-flex items-center px-3 py-1 rounded-lg border-2 border-black/[0.12] bg-white/65 text-[#1A1915] text-sm font-bold tracking-wide">{cardSportLabels[baseMarket.sport] || (baseMarket.sport || 'FOOTBALL').toUpperCase()}</span>
                                <h3 className="text-base font-medium text-[#1A1915]">
                                    {eventTitle || baseMarket.eventTitle || `${baseMarket.awayTeam} vs ${baseMarket.homeTeam}`}
                                </h3>
                                <ViewLinks
                                    predictId={baseMarket.predictMarketId}
                                    predictSlug={baseMarket.predictSlug}
                                    polymarketSlug={baseMarket.polymarketSlug}
                                    polymarketConditionId={baseMarket.polymarketConditionId}
                                    title={eventTitle || baseMarket.eventTitle || baseMarket.predictTitle}
                                    sportsTeams={sportsTeams}
                                />
                            </div>
                            {/* 第二行: 时间 + PP + boost */}
                            <div className="flex flex-wrap items-center gap-2">
                                <SportsTimeBadge gameStartTime={gameStartTime} />
                                {isBoosted && <BoostCountdown boostStartTime={boostStartTime} boostEndTime={boostEndTime} />}
                                <PointsBadge
                                    tier={baseMarket.pointsTier}
                                    hourlyRate={baseMarket.pointsHourlyRate}
                                    nextTier={baseMarket.pointsNextTier}
                                    nextHourlyRate={baseMarket.pointsNextHourlyRate}
                                    yieldValue={Math.max(...selectionMarkets.map(m => Number(m?.pointsYield) || 0))}
                                />
                            </div>
                            <div className="flex items-center gap-3 text-xs text-[#8B847A] mt-1">
                                <span>
                                    <Icon name="activity" size={12} className="inline mr-1" />
                                    Vol: ${(totalPredictVol / 1000).toFixed(0)}K | ${(totalPolyVol / 1000).toFixed(0)}K
                                </span>
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                        {orderedKinds.map((kind) => {
                            const market = marketsByKind?.[kind];
                            if (!market) {
                                return (
                                    <div key={kind} className="rounded-lg border border-black/[0.06] p-2">
                                        <div className="text-xs text-[#8B847A]">N/A</div>
                                    </div>
                                );
                            }

                            const selectionName = getSelectionName(market);
                            const askCompare = getOutcomeAskCompare(market);
                            return (
                                <div key={kind} className="rounded-lg border border-black/[0.06] bg-white/40 backdrop-blur-md p-2">
                                    <div className="text-xs font-semibold text-[#1A1915] truncate mb-2" title={selectionName}>
                                        {selectionName}
                                    </div>
                                    <div className="grid grid-cols-2 gap-1 text-[10px] font-mono mb-2">
                                        <div className="text-blue-400/90">P.Ask {askCompare.predictAsk}</div>
                                        <div className="text-purple-400/90 text-right">M.Ask {askCompare.polymarketAsk}</div>
                                    </div>
                                    <div className="grid grid-cols-2 gap-1">
                                        {orderedButtons.map((cfg) => renderActionButton(market, selectionName, cfg))}
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {hasActiveTask && (
                        <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2">
                            {orderedKinds.map((kind) => {
                                const market = marketsByKind?.[kind];
                                if (!market) {
                                    return (
                                        <div key={`cancel-${kind}`} className="rounded-lg border border-black/[0.08] bg-white/55 backdrop-blur-xl p-2">
                                            <div className="text-xs text-[#8B847A]">N/A</div>
                                        </div>
                                    );
                                }

                                const selectionName = getSelectionName(market);
                                const yesEntry = getCancelEntry(market, 'YES');
                                const noEntry = getCancelEntry(market, 'NO');

                                const renderCancelButton = (entry, sideLabel) => {
                                    if (!entry) {
                                        return (
                                            <button
                                                key={`${kind}-${sideLabel}-empty`}
                                                disabled
                                                className="px-1.5 py-1 rounded-md bg-[#F5F1EB] text-[#A39C8E] text-[10px] cursor-not-allowed"
                                            >
                                                <span className="block font-mono">{sideLabel}</span>
                                                <span className="block">--</span>
                                            </button>
                                        );
                                    }

                                    const taskId = entry.task.id;
                                    const isCancelling = cancellingTaskId === taskId;
                                    const isConfirming = cancelConfirmTaskId === taskId;
                                    const isPM = entry.task.strategy === 'POLY_MAKER';
                                    const color = isPM ? 'purple' : 'emerald';
                                    return (
                                        <button
                                            key={taskId}
                                            onClick={() => handleCancelTaskClick(entry)}
                                            disabled={isCancelling}
                                            className={`px-1.5 py-1 rounded-md text-[10px] transition-all ${
                                                isCancelling
                                                    ? 'bg-white/50 text-[#A39C8E] cursor-wait'
                                                    : isConfirming
                                                        ? `bg-${color}-500/20 border border-${color}-500/50 text-${color}-400 animate-pulse`
                                                        : `bg-${color}-500/10 border border-${color}-500/30 text-${color}-400 hover:bg-${color}-500/20`
                                            }`}
                                            title={`任务 #${String(taskId).slice(0, 8)} | ${entry.task.status} | ${isPM ? 'M.' : 'P.'}`}
                                        >
                                            <span className="block font-mono">{isPM ? 'M.' : 'P.'}{sideLabel}</span>
                                            <span className="block">
                                                {isCancelling
                                                    ? '取消中...'
                                                    : isConfirming
                                                        ? '确认取消'
                                                        : `${entry.task.filledShares || 0}/${entry.task.quantity} @${((isPM ? entry.task.polyBidPrice : entry.task.predictPrice) * 100).toFixed(1)}¢`}
                                            </span>
                                        </button>
                                    );
                                };

                                return (
                                    <div key={`cancel-${kind}`} className="rounded-lg border border-black/[0.06] bg-white/35 backdrop-blur-md p-2">
                                        <div className="text-xs font-semibold text-[#3A342C] truncate mb-2" title={selectionName}>
                                            {selectionName}
                                        </div>
                                        <div className="grid grid-cols-2 gap-1">
                                            {renderCancelButton(yesEntry, 'YES')}
                                            {renderCancelButton(noEntry, 'NO')}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* Taker 二次确认 */}
            {takerConfirm && ReactDOM.createPortal((() => {
                const { market, selectionName, side, opp } = takerConfirm;
                const feeRateBps = market.feeRateBps || 200;
                const baseFeePercent = feeRateBps / 10000;
                const minPrice = Math.min(opp.predictPrice, 1 - opp.predictPrice);
                const predictFee = baseFeePercent * minPrice * 0.9;
                const predictRequired = opp.predictPrice * takerQuantity + predictFee * takerQuantity;
                const polyRequired = opp.polyHedgePrice * takerQuantity;
                const predictBalance = accounts?.predict?.available || 0;
                const polyBalance = accounts?.polymarket?.available || 0;
                const predictInsufficient = predictRequired > predictBalance;
                const polyInsufficient = polyRequired > polyBalance;
                const polyBelowMin = polyRequired > 0 && polyRequired < 1;
                const canSubmit = !predictInsufficient && !polyInsufficient && !polyBelowMin && takerQuantity >= 5;

                return (
                    <div className="fixed inset-0 bg-white/40 backdrop-blur-sm flex items-center justify-center z-50">
                        <div className="bg-white/55 backdrop-blur-xl border border-black/[0.12] rounded-xl p-5 max-w-md w-full mx-4 shadow-xl">
                            <div className="flex items-center justify-between mb-4">
                                <div className="flex items-center gap-2">
                                    <Icon name="zap" size={20} className="text-[#C7654A]" />
                                    <h3 className="text-lg font-medium text-[#1A1915]">Taker 确认 - {selectionName} {side}</h3>
                                </div>
                                <button
                                    onClick={() => setTakerConfirm(null)}
                                    className="w-8 h-8 rounded-lg bg-white/65 hover:bg-rose-500/20 text-[#6B665C] hover:text-rose-400 transition-all flex items-center justify-center"
                                    title="关闭">
                                    <Icon name="x" size={18} />
                                </button>
                            </div>

                            <div className="grid grid-cols-2 gap-3 mb-4 text-sm">
                                <div className="bg-white/50 rounded-lg p-3">
                                    <div className="text-[#8B847A] text-xs mb-1">Predict Ask</div>
                                    <div className="text-blue-400 font-mono text-lg">{(opp.predictPrice * 100).toFixed(2)}¢</div>
                                </div>
                                <div className="bg-white/50 rounded-lg p-3">
                                    <div className="text-[#8B847A] text-xs mb-1">Poly 对冲</div>
                                    <div className="text-purple-400 font-mono text-lg">{(opp.polyHedgePrice * 100).toFixed(2)}¢</div>
                                </div>
                            </div>

                            <div className="mb-4">
                                <label className="block text-xs text-[#8B847A] mb-1">买入数量 (Shares)</label>
                                <input
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    value={takerQuantity}
                                    onChange={(e) => {
                                        const val = e.target.value;
                                        if (val === '' || /^\d+$/.test(val)) {
                                            setTakerQuantity(val === '' ? '' : parseInt(val));
                                        }
                                    }}
                                    onBlur={(e) => {
                                        if (e.target.value === '' || parseInt(e.target.value) < 5) {
                                            setTakerQuantity(5);
                                        }
                                    }}
                                    className="w-full bg-white/55 backdrop-blur-xl border border-black/[0.12] rounded-lg px-3 py-2 text-[#1A1915] font-mono text-sm focus:outline-none focus:border-[#D97757]"
                                />
                                <div className="text-xs text-[#8B847A] mt-1">最大深度: {opp.maxQuantity?.toFixed(0) || '-'} shares</div>
                            </div>

                            <div className="bg-white/50 rounded-lg p-3 mb-4 space-y-2">
                                <div className="text-xs text-[#8B847A] font-medium">资金占用</div>
                                <div className="flex justify-between items-center text-xs">
                                    <span className="text-[#6B665C]">Predict</span>
                                    <span className={predictInsufficient ? 'text-rose-400' : 'text-[#1A1915]'}>
                                        ${predictRequired.toFixed(2)} / ${predictBalance.toFixed(2)}
                                    </span>
                                </div>
                                <div className="flex justify-between items-center text-xs">
                                    <span className="text-[#6B665C]">Polymarket</span>
                                    <span className={(polyInsufficient || polyBelowMin) ? 'text-rose-400' : 'text-[#1A1915]'}>
                                        ${polyRequired.toFixed(2)} / ${polyBalance.toFixed(2)}
                                    </span>
                                </div>
                            </div>

                            <div className="flex gap-3">
                                <button
                                    onClick={() => setTakerConfirm(null)}
                                    className="flex-1 px-4 py-2 rounded-lg bg-white/65 text-[#3A342C] hover:bg-white/75 transition-colors"
                                >
                                    取消
                                </button>
                                <button
                                    onClick={confirmTaker}
                                    disabled={!canSubmit}
                                    className={`flex-1 px-4 py-2 rounded-lg font-medium transition-colors ${
                                        canSubmit ? 'bg-[#D97757] text-[#1A1915] hover:bg-[#C7654A]' : 'bg-white/75 text-[#8B847A] cursor-not-allowed'
                                    }`}
                                >
                                    确认买入
                                </button>
                            </div>
                        </div>
                    </div>
                );
            })(), document.body)}
        </div>
    );
};

// 敞口预警 Banner (常驻，需手动关闭)
const ExposureAlertBanner = ({ alert, onDismiss }) => {
    if (!alert) return null;
    return (
        <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-[60] w-[480px] animate-slideDown">
            <div className="glass-card rounded-xl p-4 border-2 border-rose-500/60 bg-rose-500/10 shadow-2xl backdrop-blur-md">
                <div className="flex items-start gap-3">
                    <span className="text-3xl">🚨</span>
                    <div className="flex-1">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-base font-bold text-rose-400">
                                敞口预警: {(alert.totalExposure || 0).toFixed(1)} shares
                            </span>
                            <button onClick={onDismiss} className="text-[#8B847A] hover:text-[#1A1915] text-lg leading-none">&times;</button>
                        </div>
                        <div className="space-y-1">
                            {(alert.tasks || []).map(t => (
                                <div key={t.id} className="text-xs text-[#3A342C]">
                                    <span className="text-[#1A1915] font-medium">{(t.title || '').slice(0, 35)}</span>
                                    <span className="ml-2 text-rose-400">{(t.exposure || 0).toFixed(1)} shares 未对冲</span>
                                </div>
                            ))}
                        </div>
                        <div className="text-xs text-[#8B847A] mt-2">
                            {new Date(alert.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

Preview.Components = {
    Badge,
    Card,
    RiskIndicator,
    DepthIndicator,
    StatCard,
    OpportunityCard,
    FilterBar,
    HistoryTable,
    TaskStatusBadge,
    TasksTab,
    TaskModal,
    TaskLogModal,
    AutoTaskPreviewModal,
    AnalyticsDashboard,
    NotificationToast,
    OrderToastContainer,
    useOrderToasts,
    SettingsPanel,
    LatencyBar,
    AccountCard,
    SportsCard,
    FootballThreeWayCardDemo,
    ExposureAlertBanner,
};

// 共享原子组件挂到 Preview 命名空间（供 hedge-tab.jsx 等独立文件复用）
Preview.Badge = Badge;
Preview.FlashValue = FlashValue;
Preview.ViewLinks = ViewLinks;
Preview.HighlightedTitle = HighlightedTitle;
