// Find Spurs vs Knicks from Gamma API by volume

async function find() {
    console.log("Searching Gamma API for Spurs vs Knicks...\n");

    // Sort by 24h volume
    const res = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200&order=volume24hr&ascending=false');
    const markets = await res.json() as any[];

    console.log('Markets:', markets.length);

    for (const m of markets) {
        const q = (m.question || '').toLowerCase();
        if (q.includes('spurs') && q.includes('knicks')) {
            console.log('\n✓ FOUND:');
            console.log('  Question:', m.question);
            console.log('  24h Vol:', m.volume24hr);
            console.log('  Token IDs:', m.clobTokenIds?.slice(0, 80));

            if (m.clobTokenIds && m.clobTokenIds !== '[]') {
                const ids = JSON.parse(m.clobTokenIds);
                console.log('  YES Token:', ids[0]?.slice(0, 50));

                // Get order book
                const bookRes = await fetch(`https://clob.polymarket.com/book?token_id=${ids[0]}`);
                const book = await bookRes.json() as any;
                console.log('  Bids:', book.bids?.length || 0);
                console.log('  Asks:', book.asks?.length || 0);
            }
            return;
        }
    }

    // If not found, show top sports markets
    console.log('\nSpurs vs Knicks not found. Top sports-like markets:');
    for (const m of markets.slice(0, 20)) {
        const q = (m.question || '').toLowerCase();
        if (q.includes('vs') || q.includes('game') || q.includes('match')) {
            console.log('\n-', m.question?.slice(0, 60));
            console.log('  Vol:', m.volume24hr);
        }
    }
}

find().catch(console.error);
