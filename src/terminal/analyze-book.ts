/**
 * Analyze Polymarket orderbook structure
 */

async function main() {
    const token = '17186228930277269925710685008112720110989575576784224613930645093956299392660';

    const res = await fetch(`https://clob.polymarket.com/book?token_id=${token}`);
    const book = await res.json() as { bids?: any[]; asks?: any[] };

    console.log('=== Polymarket Orderbook Structure Analysis ===\n');
    console.log('Jake Paul YES Token\n');

    console.log('BIDS (买单) - first 5:');
    for (const b of (book.bids || []).slice(0, 5)) {
        console.log(`  Price: ${b.price}, Size: ${parseFloat(b.size).toFixed(2)}`);
    }

    console.log('\nBIDS (买单) - last 5:');
    for (const b of (book.bids || []).slice(-5)) {
        console.log(`  Price: ${b.price}, Size: ${parseFloat(b.size).toFixed(2)}`);
    }

    console.log('\nASKS (卖单) - first 5:');
    for (const a of (book.asks || []).slice(0, 5)) {
        console.log(`  Price: ${a.price}, Size: ${parseFloat(a.size).toFixed(2)}`);
    }

    console.log('\nASKS (卖单) - last 5:');
    for (const a of (book.asks || []).slice(-5)) {
        console.log(`  Price: ${a.price}, Size: ${parseFloat(a.size).toFixed(2)}`);
    }

    // Determine sorting
    console.log('\n--- Analysis ---');
    if (book.bids && book.bids.length > 1) {
        const first = parseFloat(book.bids[0].price);
        const last = parseFloat(book.bids[book.bids.length - 1].price);
        console.log(`Bids: first=${first}, last=${last}`);
        console.log(`Bids sorted: ${first > last ? 'Descending (high to low)' : 'Ascending (low to high)'}`);
        console.log(`Best Bid (highest): ${first > last ? first : last}`);
    }

    if (book.asks && book.asks.length > 1) {
        const first = parseFloat(book.asks[0].price);
        const last = parseFloat(book.asks[book.asks.length - 1].price);
        console.log(`Asks: first=${first}, last=${last}`);
        console.log(`Asks sorted: ${first < last ? 'Ascending (low to high)' : 'Descending (high to low)'}`);
        console.log(`Best Ask (lowest): ${first < last ? first : last}`);
    }
}

main().catch(console.error);
