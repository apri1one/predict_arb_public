// Find most active markets by volume

async function find() {
    console.log('Fetching markets sorted by volume...\n');

    // Get markets sorted by volume
    const gammaRes = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=20&order=volume24hr&ascending=false');
    const markets = await gammaRes.json() as any[];

    for (const m of markets.slice(0, 10)) {
        if (!m.clobTokenIds || m.clobTokenIds === '[]') continue;

        try {
            const ids = JSON.parse(m.clobTokenIds);
            const yesBook = await (await fetch('https://clob.polymarket.com/book?token_id=' + ids[0])).json() as any;

            const bidCount = yesBook.bids?.length || 0;
            const askCount = yesBook.asks?.length || 0;
            const vol = m.volume24hr || m.volumeNum || 0;

            if (bidCount > 0 && askCount > 0) {
                console.log('📊 ' + m.question?.slice(0, 55));
                console.log('   24h Vol: $' + (vol / 1000).toFixed(1) + 'K');
                console.log('   Bids: ' + bidCount + ', Asks: ' + askCount);
                console.log('   Token: ' + ids[0].slice(0, 40) + '...\n');
            }
        } catch { }
    }
}

find().catch(console.error);
