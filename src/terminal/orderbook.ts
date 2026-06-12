/**
 * Polymarket Order Book Terminal Display - WebSocket Only + Change Highlighting
 * 
 * Real-time order book using WebSocket with change highlighting
 * 
 * Usage: 
 *   npx tsx src/terminal/orderbook.ts              # Auto-select most active
 *   npx tsx src/terminal/orderbook.ts "spurs"      # Search for specific market
 */

import WebSocket from 'ws';

// ANSI Colors
const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    blink: '\x1b[5m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    gray: '\x1b[90m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    white: '\x1b[37m',
};

function clearScreen(): void {
    process.stdout.write('\x1b[2J\x1b[H');
}

function hideCursor(): void {
    process.stdout.write('\x1b[?25l');
}

function showCursor(): void {
    process.stdout.write('\x1b[?25h');
}

function formatPrice(price: number): string {
    // Show full precision (0.01 = 1 basis point)
    const cents = price * 100;
    // If it's a round number, show 1 decimal, otherwise show 2
    if (Math.abs(cents - Math.round(cents)) < 0.001) {
        return `${cents.toFixed(1)}¢`;
    }
    return `${cents.toFixed(2)}¢`;
}

function formatShares(shares: number): string {
    if (shares >= 1000000) return `${(shares / 1000000).toFixed(2)}M`;
    if (shares >= 1000) return `${(shares / 1000).toFixed(2)}K`;
    return shares.toFixed(0);
}

function formatTotal(price: number, shares: number): string {
    const total = price * shares;
    if (total >= 1000) return `$${(total / 1000).toFixed(2)}K`;
    return `$${total.toFixed(2)}`;
}

function createBar(value: number, maxValue: number, width: number, color: string): string {
    const filled = Math.round((value / maxValue) * width);
    return `${color}${'█'.repeat(Math.min(filled, width))}${c.reset}${' '.repeat(width - Math.min(filled, width))}`;
}

interface Level { price: number; size: number; }
interface BookLevel { price: string; size: string; }

// Store previous state for change detection
let prevBidSizes: Map<number, number> = new Map();
let prevAskSizes: Map<number, number> = new Map();
let changedPrices: Set<number> = new Set();
let newPrices: Set<number> = new Set();

function detectChanges(oldMap: Map<number, number>, newLevels: Level[], isNew: boolean = false): void {
    const newMap = new Map<number, number>();

    for (const level of newLevels) {
        newMap.set(level.price, level.size);

        const oldSize = oldMap.get(level.price);
        if (oldSize === undefined) {
            // New price level
            if (!isNew) newPrices.add(level.price);
        } else if (Math.abs(oldSize - level.size) > 0.01) {
            // Size changed
            changedPrices.add(level.price);
        }
    }
}

function render(
    marketName: string,
    bids: Level[],
    asks: Level[],
    stats: { updates: number; bidVol: number; askVol: number; mode: string; lastChange: string }
): void {
    clearScreen();

    const maxSize = Math.max(...bids.map(l => l.size), ...asks.map(l => l.size), 1);
    const sortedAsks = [...asks].sort((a, b) => a.price - b.price).slice(0, 8);
    const displayAsks = [...sortedAsks].reverse();
    const sortedBids = [...bids].sort((a, b) => b.price - a.price).slice(0, 8);
    const displayBids = sortedBids;

    const bestBid = sortedBids[0]?.price ?? 0;
    const bestAsk = sortedAsks[0]?.price ?? 1;
    const spread = bestAsk - bestBid;
    const mid = (bestBid + bestAsk) / 2;

    console.log();
    console.log(`${c.bold}${c.cyan}╔${'═'.repeat(72)}╗${c.reset}`);
    console.log(`${c.cyan}║${c.reset}  ${c.bold}📊 Order Book ${c.green}[WebSocket Live]${c.reset}${' '.repeat(41)}${c.cyan}║${c.reset}`);
    console.log(`${c.cyan}╠${'═'.repeat(72)}╣${c.reset}`);

    const name = marketName.length > 60 ? marketName.slice(0, 57) + '...' : marketName;
    console.log(`${c.cyan}║${c.reset}  ${c.bold}${name}${c.reset}${' '.repeat(70 - name.length)}${c.cyan}║${c.reset}`);
    console.log(`${c.cyan}╠${'═'.repeat(72)}╣${c.reset}`);

    console.log(`${c.cyan}║${c.reset}  ${c.gray}DEPTH${c.reset}${' '.repeat(15)}  ${'PRICE'.padStart(10)}  ${'SHARES'.padStart(12)}  ${'TOTAL'.padStart(12)}  ${c.cyan}║${c.reset}`);
    console.log(`${c.cyan}╠${'═'.repeat(72)}╣${c.reset}`);

    // Asks (with highlighting)
    for (const ask of displayAsks) {
        const bar = createBar(ask.size, maxSize, 20, c.red);

        // Check if this price changed
        let priceColor = c.red;
        let indicator = ' ';
        if (newPrices.has(ask.price)) {
            priceColor = `${c.bgBlue}${c.white}`;
            indicator = '★';
        } else if (changedPrices.has(ask.price)) {
            priceColor = `${c.bgYellow}${c.red}`;
            indicator = '▲';
        }

        console.log(`${c.cyan}║${c.reset}${indicator} ${bar}  ${priceColor}${formatPrice(ask.price).padStart(10)}${c.reset}  ${formatShares(ask.size).padStart(12)}  ${formatTotal(ask.price, ask.size).padStart(12)}  ${c.cyan}║${c.reset}`);
    }

    console.log(`${c.cyan}║${c.reset}  ${c.bgRed}${c.white} Asks ${c.reset}${' '.repeat(65)}${c.cyan}║${c.reset}`);

    const info = `Last: ${formatPrice(mid)}                              Spread: ${formatPrice(spread)}`;
    console.log(`${c.cyan}║${c.reset}  ${c.dim}${info}${c.reset}${' '.repeat(70 - info.length)}${c.cyan}║${c.reset}`);

    console.log(`${c.cyan}║${c.reset}  ${c.bgGreen}${c.white} Bids ${c.reset}${' '.repeat(65)}${c.cyan}║${c.reset}`);

    // Bids (with highlighting)
    for (const bid of displayBids) {
        const bar = createBar(bid.size, maxSize, 20, c.green);

        let priceColor = c.green;
        let indicator = ' ';
        if (newPrices.has(bid.price)) {
            priceColor = `${c.bgBlue}${c.white}`;
            indicator = '★';
        } else if (changedPrices.has(bid.price)) {
            priceColor = `${c.bgYellow}${c.green}`;
            indicator = '▼';
        }

        console.log(`${c.cyan}║${c.reset}${indicator} ${bar}  ${priceColor}${formatPrice(bid.price).padStart(10)}${c.reset}  ${formatShares(bid.size).padStart(12)}  ${formatTotal(bid.price, bid.size).padStart(12)}  ${c.cyan}║${c.reset}`);
    }

    console.log(`${c.cyan}╠${'═'.repeat(72)}╣${c.reset}`);
    const time = new Date().toLocaleTimeString('zh-CN');
    const footer = `${time} | Updates: ${stats.updates} | ${stats.mode}`;
    console.log(`${c.cyan}║${c.reset}  ${c.dim}${footer}${c.reset}${' '.repeat(70 - footer.length)}${c.cyan}║${c.reset}`);
    console.log(`${c.cyan}╚${'═'.repeat(72)}╝${c.reset}`);

    console.log();
    console.log(`${c.bold}${c.yellow}📈 Volume${c.reset}  ${stats.lastChange}`);
    console.log(`${c.gray}${'─'.repeat(40)}${c.reset}`);
    console.log(`  Bid Volume: ${c.green}${formatShares(stats.bidVol)}${c.reset}`);
    console.log(`  Ask Volume: ${c.red}${formatShares(stats.askVol)}${c.reset}`);
    console.log();
    console.log(`${c.dim}Legend: ${c.bgBlue}${c.white} ★ New ${c.reset} ${c.bgYellow}${c.red} ▲▼ Changed ${c.reset}   Ctrl+C to exit${c.reset}`);

    // Store current state for next comparison
    prevBidSizes = new Map(bids.map(l => [l.price, l.size]));
    prevAskSizes = new Map(asks.map(l => [l.price, l.size]));

    // Clear changes after display
    changedPrices.clear();
    newPrices.clear();
}

async function main(): Promise<void> {
    const searchTerm = process.argv[2]?.toLowerCase() || '';

    console.log(`${c.bold}${c.cyan}Polymarket Order Book Terminal [WebSocket + Highlighting]${c.reset}`);

    if (searchTerm) {
        console.log(`${c.dim}Searching for: "${searchTerm}"...${c.reset}\n`);
    } else {
        console.log(`${c.dim}Fetching most active markets...${c.reset}\n`);
    }

    const gammaRes = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200&order=volume24hr&ascending=false');
    const markets = await gammaRes.json() as Array<{ question?: string; clobTokenIds?: string; volume24hr?: number }>;

    let selectedMarket = '';
    let tokenId = '';
    let bestActivity = 0;

    for (const m of markets) {
        if (!m.clobTokenIds || m.clobTokenIds === '[]') continue;

        const question = (m.question || '').toLowerCase();
        if (searchTerm && !question.includes(searchTerm)) continue;

        try {
            const ids = JSON.parse(m.clobTokenIds);
            if (ids.length > 0) {
                const bookRes = await fetch(`https://clob.polymarket.com/book?token_id=${ids[0]}`);
                const book = await bookRes.json() as { bids?: BookLevel[]; asks?: BookLevel[] };
                const activity = (book.bids?.length ?? 0) + (book.asks?.length ?? 0);

                if (activity > bestActivity) {
                    bestActivity = activity;
                    selectedMarket = m.question || 'Unknown';
                    tokenId = ids[0];
                    console.log(`✓ ${m.question?.slice(0, 55)}... (${activity} levels)`);
                    if (searchTerm) break;
                }
            }
        } catch { }
    }

    if (!tokenId) {
        console.error(`No active market found${searchTerm ? ` for "${searchTerm}"` : ''}!`);
        process.exit(1);
    }

    console.log(`\n${c.green}Selected: ${selectedMarket}${c.reset}\n`);
    console.log('Connecting to WebSocket...\n');

    let bids: Level[] = [];
    let asks: Level[] = [];
    let stats = { updates: 0, bidVol: 0, askVol: 0, mode: 'Connecting...', lastChange: '' };

    hideCursor();

    // Fetch initial data
    const initialBook = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    const initData = await initialBook.json() as { bids?: BookLevel[]; asks?: BookLevel[] };

    bids = (initData.bids || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));
    asks = (initData.asks || []).map(l => ({ price: parseFloat(l.price), size: parseFloat(l.size) }));

    // Initialize prev state
    prevBidSizes = new Map(bids.map(l => [l.price, l.size]));
    prevAskSizes = new Map(asks.map(l => [l.price, l.size]));

    stats.bidVol = bids.reduce((s, l) => s + l.size, 0);
    stats.askVol = asks.reduce((s, l) => s + l.size, 0);
    stats.updates = 1;
    stats.mode = 'Initial snapshot';

    render(selectedMarket, bids, asks, stats);

    // Connect to WebSocket
    const wsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        stats.mode = `${c.green}● WebSocket Connected${c.reset}`;
        const subscribeMsg = JSON.stringify({
            type: 'market',
            assets_ids: [tokenId],
        });
        ws.send(subscribeMsg);
        render(selectedMarket, bids, asks, stats);
    });

    ws.on('message', (data: WebSocket.Data) => {
        try {
            const msg = JSON.parse(data.toString());

            // Handle book event - direct format (bids/asks at root level)
            if (msg.event_type === 'book') {
                // Check if this update is for our token
                if (msg.asset_id && msg.asset_id !== tokenId) return;

                let updated = false;

                if (msg.bids && Array.isArray(msg.bids)) {
                    const newBids = msg.bids.map((l: { price: string; size: string }) => ({
                        price: parseFloat(l.price),
                        size: parseFloat(l.size)
                    }));
                    detectChanges(prevBidSizes, newBids);
                    bids = newBids;
                    updated = true;
                }
                if (msg.asks && Array.isArray(msg.asks)) {
                    const newAsks = msg.asks.map((l: { price: string; size: string }) => ({
                        price: parseFloat(l.price),
                        size: parseFloat(l.size)
                    }));
                    detectChanges(prevAskSizes, newAsks);
                    asks = newAsks;
                    updated = true;
                }

                // Also handle wrapped format (data array)
                if (Array.isArray(msg.data)) {
                    for (const update of msg.data) {
                        if (update.asset_id !== tokenId) continue;
                        if (update.bids && Array.isArray(update.bids)) {
                            const newBids = update.bids.map((l: { price: string; size: string }) => ({
                                price: parseFloat(l.price),
                                size: parseFloat(l.size)
                            }));
                            detectChanges(prevBidSizes, newBids);
                            bids = newBids;
                            updated = true;
                        }
                        if (update.asks && Array.isArray(update.asks)) {
                            const newAsks = update.asks.map((l: { price: string; size: string }) => ({
                                price: parseFloat(l.price),
                                size: parseFloat(l.size)
                            }));
                            detectChanges(prevAskSizes, newAsks);
                            asks = newAsks;
                            updated = true;
                        }
                    }
                }

                if (updated) {
                    stats.updates++;
                    stats.bidVol = bids.reduce((s, l) => s + l.size, 0);
                    stats.askVol = asks.reduce((s, l) => s + l.size, 0);
                    stats.mode = `${c.green}● Live${c.reset}`;

                    const changes = changedPrices.size + newPrices.size;
                    if (changes > 0) {
                        stats.lastChange = `${c.yellow}+${changes} changes${c.reset}`;
                    } else {
                        stats.lastChange = '';
                    }

                    render(selectedMarket, bids, asks, stats);
                }
            }

            // Also handle price_change events for additional updates
            if (msg.event_type === 'price_change' && msg.price_changes) {
                // price_change events don't have full book, just trigger a re-render indicator
                stats.lastChange = `${c.cyan}price tick${c.reset}`;
            }
        } catch {
            // Ignore parse errors
        }
    });

    ws.on('error', (err) => {
        stats.mode = `${c.red}● Error: ${err.message.slice(0, 20)}${c.reset}`;
        render(selectedMarket, bids, asks, stats);
    });

    ws.on('close', () => {
        stats.mode = `${c.red}● Disconnected${c.reset}`;
        render(selectedMarket, bids, asks, stats);
    });

    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send('PING');
        }
    }, 10000);

    process.on('SIGINT', () => {
        clearInterval(pingInterval);
        ws.close();
        showCursor();
        console.log('\n\nGoodbye!');
        process.exit(0);
    });

    await new Promise(() => { });
}

main().catch(e => {
    showCursor();
    console.error(e);
    process.exit(1);
});
