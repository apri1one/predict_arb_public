/**
 * Compare Condition IDs between Polymarket and Predict for Jake Paul fight
 */

async function main() {
    const slug = 'boxing-jake-paul-vs-anthony-joshua-third-option-included';

    console.log('=== Comparing Condition IDs: Jake Paul vs Anthony Joshua ===\n');

    // 1. Get Polymarket event by slug
    console.log('[1] Fetching Polymarket event by slug...');
    const eventRes = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    const events = await eventRes.json() as any[];
    console.log(`    Events found: ${events.length}`);

    if (events.length > 0) {
        const event = events[0];
        console.log(`\n    Event Title: ${event.title}`);
        console.log(`    Event Slug: ${event.slug}`);

        // Get markets under this event
        if (event.markets && event.markets.length > 0) {
            console.log(`\n    Markets in this event (${event.markets.length}):`);
            for (const m of event.markets) {
                console.log(`\n    [Market] ${m.question}`);
                console.log(`      conditionId: ${m.conditionId}`);
                console.log(`      clobTokenIds: ${m.clobTokenIds?.slice(0, 100)}`);
                console.log(`      active: ${m.active}, closed: ${m.closed}`);
            }
        }
    }

    // 2. Compare with Predict's stored IDs
    console.log('\n' + '='.repeat(70));
    console.log('\n[2] Predict stored polymarketConditionIds:');

    const predictConditions = [
        { title: 'Jake Paul', conditionId: '0x74da675b5e1363b2215f24f29a13c067ff00220e2ac884a0fac7a94a51aa016e' },
        { title: 'Draw/Not Scored', conditionId: '0x2a496f947e51993cdb4af43c8dd851780a8bac86c06cd7ad5dcd5741f46ce843' },
        { title: 'Anthony Joshua', conditionId: '0x365eee5f424708fd861ea3f0d4d03d515e34b513303a30d097f2b35867f11dcd' },
    ];

    for (const p of predictConditions) {
        console.log(`\n    [${p.title}]`);
        console.log(`      ${p.conditionId}`);
    }

    // 3. Check if any match
    console.log('\n' + '='.repeat(70));
    console.log('\n[3] Checking for matches...\n');

    if (events.length > 0 && events[0].markets) {
        for (const pm of events[0].markets) {
            for (const pp of predictConditions) {
                if (pm.conditionId.toLowerCase() === pp.conditionId.toLowerCase()) {
                    console.log(`    MATCH FOUND!`);
                    console.log(`      Polymarket: ${pm.question}`);
                    console.log(`      Predict: ${pp.title}`);
                    console.log(`      conditionId: ${pm.conditionId}`);
                }
            }
        }
    }
}

main().catch(console.error);
