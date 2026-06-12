var Preview = window.Preview || (window.Preview = {});
var { useState, useMemo, useCallback } = Preview.ReactHooks;
var { SportsCard, SPORT_ICONS } = Preview;
var { useSportsStream } = Preview;
var { useToasts, ToastContainer } = Preview;

// ============================================================================
// Sport Filter Tabs
// ============================================================================

const SPORT_TABS = [
    { key: 'all', label: 'All', emoji: '\u{1F3C6}' },
    { key: 'nba', label: 'NBA', emoji: '\u{1F3C0}' },
    { key: 'nhl', label: 'NHL', emoji: '\u{1F3D2}' },
    { key: 'football', label: 'Football', emoji: '\u26BD' },
    { key: 'lol', label: 'LoL', emoji: '\u{1F3AE}' },
    { key: 'cs2', label: 'CS2', emoji: '\u{1F52B}' },
    { key: 'dota2', label: 'Dota2', emoji: '\u{1F5E1}\uFE0F' },
];

const SORT_OPTIONS = [
    { key: 'time', label: 'Start Time' },
    { key: 'volume', label: 'Volume' },
    { key: 'liquidity', label: 'Liquidity' },
];

// ============================================================================
// App
// ============================================================================

const App = () => {
    const { toasts, addToast, dismissToast } = useToasts();
    const { markets, stats, balance, isConnected, tradeEnabled, placeOrder } = useSportsStream(addToast);

    // 单选模式 — 点击直接切换
    const [activeSport, setActiveSport] = useState('all');
    const [sortBy, setSortBy] = useState('time');
    const [search, setSearch] = useState('');

    // Filtered + sorted markets
    const displayMarkets = useMemo(() => {
        let filtered = markets;

        // Sport filter (single select)
        if (activeSport !== 'all') {
            filtered = filtered.filter(m => m.sport === activeSport);
        }

        // Search
        if (search.trim()) {
            const q = search.trim().toLowerCase();
            filtered = filtered.filter(m =>
                (m.homeTeam || '').toLowerCase().includes(q) ||
                (m.awayTeam || '').toLowerCase().includes(q) ||
                (m.question || '').toLowerCase().includes(q) ||
                (m.eventTitle || '').toLowerCase().includes(q) ||
                (m.selections || []).some(s => (s.label || '').toLowerCase().includes(q))
            );
        }

        // Sort
        filtered = [...filtered].sort((a, b) => {
            if (sortBy === 'volume') return (b.volume || 0) - (a.volume || 0);
            if (sortBy === 'liquidity') return (b.liquidity || 0) - (a.liquidity || 0);
            const tA = a.gameStartTime ? new Date(a.gameStartTime).getTime() : Infinity;
            const tB = b.gameStartTime ? new Date(b.gameStartTime).getTime() : Infinity;
            return tA - tB;
        });

        return filtered;
    }, [markets, activeSport, sortBy, search]);

    return (
        <div className="min-h-screen bg-background text-foreground font-sans">
            <ToastContainer toasts={toasts} onDismiss={dismissToast} />

            {/* Header */}
            <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-lg border-b border-border">
                <div className="max-w-7xl mx-auto px-4 py-3">
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-3">
                            <h1 className="text-lg font-display font-semibold text-foreground">
                                Polymarket Sports
                            </h1>
                            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400'} animate-pulse`} />
                        </div>
                        <div className="flex items-center gap-4 text-sm">
                            <span className="text-muted">
                                Markets: <span className="text-foreground font-mono">{stats.total || 0}</span>
                            </span>
                            {tradeEnabled && (
                                <span className="text-muted">
                                    Balance: <span className="text-accent font-mono">${balance.toFixed(2)}</span>
                                </span>
                            )}
                        </div>
                    </div>

                    {/* Sport tabs — single select */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                        {SPORT_TABS.map(tab => {
                            const isActive = activeSport === tab.key;
                            const count = tab.key === 'all'
                                ? (stats.total || 0)
                                : (stats.bySport?.[tab.key] || 0);
                            return (
                                <button
                                    key={tab.key}
                                    onClick={() => setActiveSport(tab.key)}
                                    className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${
                                        isActive
                                            ? 'bg-accent/15 border-accent/30 text-accent'
                                            : 'bg-card border-border text-muted hover:border-borderHover hover:text-foreground'
                                    }`}
                                >
                                    <span className="mr-1">{tab.emoji}</span>
                                    {tab.label}
                                    {count > 0 && <span className="ml-1 opacity-60">{count}</span>}
                                </button>
                            );
                        })}
                    </div>

                    {/* Search + Sort */}
                    <div className="flex items-center gap-3 mt-2">
                        <div className="flex-1 relative">
                            <input
                                type="text"
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                placeholder="Search teams..."
                                className="w-full bg-card border border-border rounded-lg px-3 py-1.5 text-sm text-foreground placeholder-muted focus:outline-none focus:border-accent/30"
                            />
                            {search && (
                                <button
                                    onClick={() => setSearch('')}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-foreground text-xs"
                                >
                                    x
                                </button>
                            )}
                        </div>
                        <div className="flex items-center gap-1">
                            {SORT_OPTIONS.map(opt => (
                                <button
                                    key={opt.key}
                                    onClick={() => setSortBy(opt.key)}
                                    className={`px-2 py-1 text-xs rounded border transition ${
                                        sortBy === opt.key
                                            ? 'bg-accent/15 border-accent/30 text-accent'
                                            : 'border-border text-muted hover:border-borderHover'
                                    }`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </header>

            {/* Main content */}
            <main className="max-w-7xl mx-auto px-4 py-4">
                {displayMarkets.length === 0 ? (
                    <div className="text-center py-20">
                        {isConnected ? (
                            <div>
                                <div className="text-muted text-lg mb-2">
                                    {markets.length > 0 ? 'No matches for current filter' : 'Loading markets...'}
                                </div>
                                <div className="text-muted/60 text-sm">
                                    Polymarket sports markets will appear here when available.
                                </div>
                            </div>
                        ) : (
                            <div className="text-muted">Connecting...</div>
                        )}
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        {displayMarkets.map(market => (
                            <SportsCard
                                key={market.conditionId}
                                market={market}
                                onPlaceOrder={placeOrder}
                                tradeEnabled={tradeEnabled}
                            />
                        ))}
                    </div>
                )}
            </main>
        </div>
    );
};

// Mount
ReactDOM.render(<App />, document.getElementById('root'));
