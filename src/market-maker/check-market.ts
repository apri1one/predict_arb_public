import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
    const apiKey = process.env.PREDICT_API_KEY!;
    const res = await fetch('https://api.predict.fun/v1/markets/704', {
        headers: { 'x-api-key': apiKey }
    });
    const data = await res.json() as any;
    console.log('Market 704:');
    console.log('  title:', data.data.title);
    console.log('  conditionId:', data.data.conditionId);
    console.log('  oracleQuestionId:', data.data.oracleQuestionId);
    console.log('  isNegRisk:', data.data.isNegRisk);
    console.log('  isYieldBearing:', data.data.isYieldBearing);
    console.log('  outcomes:', JSON.stringify(data.data.outcomes, null, 2));
}
main();
