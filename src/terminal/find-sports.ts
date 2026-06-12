// Find today's active sports markets

async function find() {
    console.log("Fetching today's sports markets...\n");

    const res = await fetch('https://clob.polymarket.com/markets');
    const data = await res.json() as any;

    const markets = data.data || [];
    console.log('Total markets:', markets.length);

    // Find active NBA/sports markets
    let found = 0;
    for (const m of markets) {
        const q = (m.question || '').toLowerCase();

        // Only active and not closed markets
        if (m.closed === true) continue;

        // Check for sports keywords
        if (q.includes('nba') || q.includes('vs.') || q.includes('win')) {
            // Check if has order book
            if (m.tokens && m.tokens.length > 0) {
                const tokenId = m.tokens[0].token_id;
                try {
                    const bookRes = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
                    const book = await bookRes.json() as any;
                    const bidCount = book.bids?.length || 0;
                    const askCount = book.asks?.length || 0;

                    if (bidCount > 0 || askCount > 0) {
                        found++;
                        console.log(`\n[${found}] ${m.question?.slice(0, 60)}`);
                        console.log(`    Active: ${m.active}, Closed: ${m.closed}`);
                        console.log(`    Bids: ${bidCount}, Asks: ${askCount}`);
                        console.log(`    Token: ${tokenId.slice(0, 40)}...`);

                        if (found >= 10) break;
                    }
                } catch { }
            }
        }
    }

    if (found === 0) {
        console.log('\nNo active sports markets with order book found');
    }
}

find().catch(console.error);
