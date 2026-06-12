var Preview = window.Preview || (window.Preview = {});
var { useState, useRef, useEffect, useCallback, useMemo } = Preview.ReactHooks;

// ============================================================================
// 工具函数
// ============================================================================

const SPORT_ICONS = {
    nba: { emoji: '\u{1F3C0}', label: 'NBA' },
    nhl: { emoji: '\u{1F3D2}', label: 'NHL' },
    football: { emoji: '\u26BD', label: 'Football' },
    lol: { emoji: '\u{1F3AE}', label: 'LoL' },
    cs2: { emoji: '\u{1F52B}', label: 'CS2' },
    dota2: { emoji: '\u{1F5E1}\uFE0F', label: 'Dota2' },
};

function formatPrice(price) {
    if (!Number.isFinite(price) || price <= 0 || price >= 1) return '--';
    return (price * 100).toFixed(1) + '\u00A2';
}

function formatDepth(depth) {
    if (!Number.isFinite(depth) || depth <= 0) return '';
    if (depth >= 1000) return `(${(depth / 1000).toFixed(1)}K)`;
    return `(${Math.round(depth)})`;
}

function formatVolume(vol) {
    if (!vol) return '$0';
    if (vol >= 1e6) return `$${(vol / 1e6).toFixed(1)}M`;
    if (vol >= 1e3) return `$${(vol / 1e3).toFixed(0)}K`;
    return `$${Math.round(vol)}`;
}

function formatGameTime(dateStr) {
    if (!dateStr) return { countdown: '', datetime: '' };
    const date = new Date(dateStr);
    const now = Date.now();
    const diff = date.getTime() - now;

    // 格式化具体日期时间
    const month = date.toLocaleString('en', { month: 'short' });
    const day = date.getDate();
    const hours = date.getHours().toString().padStart(2, '0');
    const mins = date.getMinutes().toString().padStart(2, '0');
    const datetime = `${month} ${day}, ${hours}:${mins}`;

    if (diff < 0) return { countdown: 'LIVE', datetime };

    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);

    let countdown;
    if (h > 48) {
        countdown = `${Math.floor(h / 24)}d`;
    } else if (h > 0) {
        countdown = `${h}h ${m}m`;
    } else {
        countdown = `${m}m`;
    }

    return { countdown, datetime };
}

// ============================================================================
// FlashValue
// ============================================================================

const FlashValue = ({ value, format = formatPrice }) => {
    const prevRef = useRef(value);
    const [flash, setFlash] = useState('');
    const keyRef = useRef(0);

    useEffect(() => {
        const prev = prevRef.current;
        prevRef.current = value;
        if (Math.abs(value - prev) > 0.0001) {
            setFlash(value > prev ? 'flash-up' : 'flash-down');
            keyRef.current++;
            const timer = setTimeout(() => setFlash(''), 1500);
            return () => clearTimeout(timer);
        }
    }, [value]);

    return (
        <span key={keyRef.current} className={`transition-colors duration-300 ${flash}`}>
            {format(value)}
        </span>
    );
};

// ============================================================================
// OrderPopover
// ============================================================================

const OrderPopover = ({ label, tokenId, price, negRisk, onPlace, onClose }) => {
    const [quantity, setQuantity] = useState('100');
    const [submitting, setSubmitting] = useState(false);

    const qty = parseFloat(quantity || '0');
    const cost = (price * qty).toFixed(2);
    const payout = qty.toFixed(2);
    const isValid = qty > 0 && price * qty >= 1;

    const handleSubmit = async () => {
        setSubmitting(true);
        await onPlace({
            tokenId,
            side: 'BUY',
            price,
            quantity: qty,
            negRisk,
        });
        setSubmitting(false);
        onClose();
    };

    return (
        <div className="absolute z-50 top-full mt-2 left-0 right-0 bg-surface border border-borderHover rounded-lg p-3 shadow-xl"
             onClick={e => e.stopPropagation()}>
            <div className="text-xs text-muted mb-2 font-medium">Buy: {label}</div>
            <div className="grid grid-cols-2 gap-2 text-xs mb-2">
                <div>
                    <span className="text-muted">Price: </span>
                    <span className="text-foreground font-mono">{formatPrice(price)}</span>
                </div>
                <div>
                    <span className="text-muted">Shares: </span>
                    <input
                        type="number"
                        value={quantity}
                        onChange={e => setQuantity(e.target.value)}
                        className="w-16 bg-background border border-border rounded px-1.5 py-0.5 text-foreground font-mono text-xs focus:outline-none focus:border-accent/30"
                        min="1"
                        autoFocus
                    />
                </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs mb-3 text-muted">
                <div>Cost: <span className="text-foreground font-mono">${cost}</span></div>
                <div>Payout: <span className="text-green-400 font-mono">${payout}</span></div>
            </div>
            <div className="flex gap-2">
                <button
                    onClick={onClose}
                    className="flex-1 px-2 py-1.5 text-xs rounded border border-border text-muted hover:bg-card transition"
                >Cancel</button>
                <button
                    onClick={handleSubmit}
                    disabled={submitting || !isValid}
                    className="flex-1 px-2 py-1.5 text-xs rounded bg-accent text-black font-medium hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                    {submitting ? 'Placing...' : 'Confirm'}
                </button>
            </div>
        </div>
    );
};

// ============================================================================
// BinaryCard — 二元赛事卡片 (moneyline)
// ============================================================================

const BinaryCard = ({ market, onPlaceOrder, tradeEnabled }) => {
    const [popover, setPopover] = useState(null); // 'away' | 'home' | null
    const sport = SPORT_ICONS[market.sport] || { emoji: '\u{1F3AF}', label: market.sport };
    const ob = market.orderbook || {};
    const { countdown, datetime } = formatGameTime(market.gameStartTime);

    return (
        <div className="bg-card border border-border rounded-xl p-4 hover:border-borderHover transition-all relative">
            {/* Header: sport + time */}
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                    <span className="text-base">{sport.emoji}</span>
                    <span className="text-xs font-medium text-accent">{sport.label}</span>
                </div>
                <div className="text-right">
                    {countdown && (
                        <div className={`text-xs font-mono ${countdown === 'LIVE' ? 'text-red-400 font-semibold' : 'text-muted'}`}>
                            {countdown === 'LIVE' ? '\u{1F534} LIVE' : countdown}
                        </div>
                    )}
                    {datetime && (
                        <div className="text-[10px] text-muted/60 font-mono">{datetime}</div>
                    )}
                </div>
            </div>

            {/* Teams */}
            <div className="text-center mb-3">
                <span className="text-sm font-medium text-foreground">{market.awayTeam}</span>
                <span className="text-xs text-muted mx-2">vs</span>
                <span className="text-sm font-medium text-foreground">{market.homeTeam}</span>
            </div>

            {/* Orderbook — 2 column */}
            <div className="grid grid-cols-2 gap-4 mb-3">
                {/* Away */}
                <div className="text-center bg-background/30 rounded-lg py-2 px-1">
                    <div className="text-[10px] text-muted mb-1 truncate">{market.awayTeam}</div>
                    <div className="text-xs font-mono space-y-0.5">
                        <div>
                            <span className="text-green-400/80">Bid </span>
                            <FlashValue value={ob.awayBid || 0} />
                            <span className="text-muted/60 ml-1 text-[10px]">{formatDepth(ob.awayBidDepth)}</span>
                        </div>
                        <div>
                            <span className="text-red-400/80">Ask </span>
                            <FlashValue value={ob.awayAsk || 0} />
                            <span className="text-muted/60 ml-1 text-[10px]">{formatDepth(ob.awayAskDepth)}</span>
                        </div>
                    </div>
                    {ob.awayAsk > 0 && ob.awayBid > 0 && (
                        <div className="text-[10px] text-muted/50 mt-1">
                            Spr: {((ob.awayAsk - ob.awayBid) * 100).toFixed(1) + '\u00A2'}
                        </div>
                    )}
                </div>

                {/* Home */}
                <div className="text-center bg-background/30 rounded-lg py-2 px-1">
                    <div className="text-[10px] text-muted mb-1 truncate">{market.homeTeam}</div>
                    <div className="text-xs font-mono space-y-0.5">
                        <div>
                            <span className="text-green-400/80">Bid </span>
                            <FlashValue value={ob.homeBid || 0} />
                            <span className="text-muted/60 ml-1 text-[10px]">{formatDepth(ob.homeBidDepth)}</span>
                        </div>
                        <div>
                            <span className="text-red-400/80">Ask </span>
                            <FlashValue value={ob.homeAsk || 0} />
                            <span className="text-muted/60 ml-1 text-[10px]">{formatDepth(ob.homeAskDepth)}</span>
                        </div>
                    </div>
                    {ob.homeAsk > 0 && ob.homeBid > 0 && (
                        <div className="text-[10px] text-muted/50 mt-1">
                            Spr: {((ob.homeAsk - ob.homeBid) * 100).toFixed(1) + '\u00A2'}
                        </div>
                    )}
                </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-border pt-2">
                <div className="text-[10px] text-muted">
                    Vol: {formatVolume(market.volume)}
                    {market.liquidity > 0 && <span> | Liq: {formatVolume(market.liquidity)}</span>}
                </div>
                {tradeEnabled && (
                    <div className="flex gap-1.5">
                        <button
                            onClick={() => setPopover(popover === 'away' ? null : 'away')}
                            className="px-2 py-1 text-[10px] rounded bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition font-mono truncate max-w-[100px]"
                        >
                            {market.awayTeam.length > 8 ? market.awayTeam.slice(0, 8) + '..' : market.awayTeam} {formatPrice(ob.awayAsk)}
                        </button>
                        <button
                            onClick={() => setPopover(popover === 'home' ? null : 'home')}
                            className="px-2 py-1 text-[10px] rounded bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition font-mono truncate max-w-[100px]"
                        >
                            {market.homeTeam.length > 8 ? market.homeTeam.slice(0, 8) + '..' : market.homeTeam} {formatPrice(ob.homeAsk)}
                        </button>
                    </div>
                )}
            </div>

            {/* Popover */}
            {popover === 'away' && (
                <OrderPopover
                    label={`${market.awayTeam}`}
                    tokenId={market.awayTokenId}
                    price={ob.awayAsk || market.awayPrice}
                    negRisk={market.negRisk}
                    onPlace={onPlaceOrder}
                    onClose={() => setPopover(null)}
                />
            )}
            {popover === 'home' && (
                <OrderPopover
                    label={`${market.homeTeam}`}
                    tokenId={market.homeTokenId}
                    price={ob.homeAsk || market.homePrice}
                    negRisk={market.negRisk}
                    onPlace={onPlaceOrder}
                    onClose={() => setPopover(null)}
                />
            )}
        </div>
    );
};

// ============================================================================
// ThreeWayCard — 足球三方卡片
// ============================================================================

const ThreeWayCard = ({ market, onPlaceOrder, tradeEnabled }) => {
    const [popover, setPopover] = useState(null);
    const sport = SPORT_ICONS[market.sport] || { emoji: '\u26BD', label: 'Football' };
    const { countdown, datetime } = formatGameTime(market.gameStartTime);
    const selections = market.selections || [];

    return (
        <div className="bg-card border border-border rounded-xl p-4 hover:border-borderHover transition-all relative">
            {/* Header */}
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                    <span className="text-base">{sport.emoji}</span>
                    <span className="text-xs font-medium text-accent">{sport.label}</span>
                </div>
                <div className="text-right">
                    {countdown && (
                        <div className={`text-xs font-mono ${countdown === 'LIVE' ? 'text-red-400 font-semibold' : 'text-muted'}`}>
                            {countdown === 'LIVE' ? '\u{1F534} LIVE' : countdown}
                        </div>
                    )}
                    {datetime && (
                        <div className="text-[10px] text-muted/60 font-mono">{datetime}</div>
                    )}
                </div>
            </div>

            {/* Teams */}
            <div className="text-center mb-3">
                <span className="text-sm font-medium text-foreground">{market.homeTeam}</span>
                <span className="text-xs text-muted mx-2">vs</span>
                <span className="text-sm font-medium text-foreground">{market.awayTeam}</span>
            </div>

            {/* 3-way selections — always 3 columns */}
            <div className="grid grid-cols-3 gap-2 mb-3">
                {selections.map((sel, idx) => (
                    <div key={idx} className="text-center bg-background/30 rounded-lg py-2 px-1">
                        <div className="text-[10px] text-muted mb-1 truncate">{sel.label}</div>
                        <div className="text-sm font-mono font-medium text-foreground">
                            <FlashValue value={sel.ask > 0 && sel.ask < 1 ? sel.ask : sel.price} />
                        </div>
                        <div className="text-[10px] text-muted/60 font-mono mt-0.5">
                            {sel.ask > 0 && sel.ask < 1 ? (
                                <span>Bid {formatPrice(sel.bid)} | Ask {formatDepth(sel.askDepth)}</span>
                            ) : (
                                <span>--</span>
                            )}
                        </div>
                    </div>
                ))}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-border pt-2">
                <div className="text-[10px] text-muted">
                    Vol: {formatVolume(market.volume)}
                </div>
                {tradeEnabled && (
                    <div className="flex gap-1">
                        {selections.map((sel, idx) => (
                            <button
                                key={idx}
                                onClick={() => setPopover(popover === idx ? null : idx)}
                                className="px-2 py-1 text-[10px] rounded bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition font-mono truncate max-w-[80px]"
                            >
                                {sel.label.length > 6 ? sel.label.slice(0, 6) + '..' : sel.label} {formatPrice(sel.ask > 0 && sel.ask < 1 ? sel.ask : sel.price)}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* Popover */}
            {popover !== null && selections[popover] && (
                <OrderPopover
                    label={selections[popover].label}
                    tokenId={selections[popover].tokenId}
                    price={selections[popover].ask > 0 && selections[popover].ask < 1 ? selections[popover].ask : selections[popover].price}
                    negRisk={market.negRisk}
                    onPlace={onPlaceOrder}
                    onClose={() => setPopover(null)}
                />
            )}
        </div>
    );
};

// ============================================================================
// SportsCard — dispatch
// ============================================================================

const SportsCard = (props) => {
    const mt = props.market.marketType;
    if (mt === 'three-way' || props.market.isThreeWay) {
        return <ThreeWayCard {...props} />;
    }
    if (mt === 'moneyline') {
        return <BinaryCard {...props} />;
    }
    // futures/outright — 暂不显示，后续可添加 FuturesCard
    return null;
};

Preview.SportsCard = SportsCard;
Preview.SPORT_ICONS = SPORT_ICONS;
