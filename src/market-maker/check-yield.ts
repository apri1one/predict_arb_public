import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
    const apiKey = process.env.PREDICT_API_KEY!;

    // 检查多个市场的 isYieldBearing
    const marketIds = [709, 743, 696, 699, 749];

    for (const id of marketIds) {
        const res = await fetch(`https://api.predict.fun/v1/markets/${id}`, {
            headers: { 'x-api-key': apiKey }
        });
        const data = await res.json() as any;
        console.log(`Market ${id} (${data.data?.title?.slice(0, 20) || 'N/A'}):`);
        console.log(`  isYieldBearing: ${data.data?.isYieldBearing}`);
        console.log(`  isNegRisk: ${data.data?.isNegRisk}`);
        console.log();
    }
}

main().catch(console.error);
