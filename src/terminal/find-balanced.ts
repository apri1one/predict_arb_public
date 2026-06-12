// Find a market with balanced YES prices

async function find() {
    const gammaRes = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100');
    const markets = await gammaRes.json() as any[];

    console.log('Searching for balanced markets...\n');

    for (const m of markets) {
        if (!m.clobTokenIds || m.clobTokenIds === '[]') continue;

        try {
            const ids = JSON.parse(m.clobTokenIds);
            const yesBook = await (await fetch('https://clob.polymarket.com/book?token_id=' + ids[0])).json() as any;

            const bestBid = parseFloat(yesBook.bids?.[0]?.price || '0');
            const bestAsk = parseFloat(yesBook.asks?.[0]?.price || '1');

            // Look for balanced markets (YES around 20-80%)
            if (bestBid > 0.15 && bestAsk < 0.85 && (bestAsk - bestBid) < 0.10) {
                console.log('✓ ' + m.question?.slice(0, 55));
                console.log('  YES Bid: ' + (bestBid * 100).toFixed(1) + '¢');
                console.log('  YES Ask: ' + (bestAsk * 100).toFixed(1) + '¢');
                console.log('  Spread: ' + ((bestAsk - bestBid) * 100).toFixed(1) + '¢');
                console.log('  Token: ' + ids[0].slice(0, 40) + '...\n');
                return ids[0];
            }
        } catch { }
    }

    console.log('No balanced markets found');
    return null;
}

find().catch(console.error);
