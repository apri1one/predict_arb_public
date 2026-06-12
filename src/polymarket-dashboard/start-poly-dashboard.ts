/**
 * Polymarket Sports Dashboard — 主入口
 *
 * 独立 HTTP 服务器: SSE 推送 + REST API + 静态文件
 * 默认端口 4020
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { resolve, extname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

// 加载 .env
config({ path: resolve(fileURLToPath(import.meta.url), '../../../.env') });

import { PolySportsService } from './poly-sports-service.js';
import { PolyTradeService } from './poly-trade-service.js';
import type { PolySportsSSE } from './types.js';

// ============================================================================
// 配置
// ============================================================================

const PORT = parseInt(process.env.POLY_DASHBOARD_PORT || '4020', 10);
const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const FRONTEND_DIR = resolve(__dirname, 'frontend');

// ============================================================================
// CORS
// ============================================================================

const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

// ============================================================================
// SSE 客户端管理
// ============================================================================

interface SSEClient {
    res: ServerResponse;
    initialized: boolean;
}

const sseClients = new Map<ServerResponse, SSEClient>();

function sendSSE(client: SSEClient, event: string, data: string): void {
    const message = `event: ${event}\ndata: ${data}\n\n`;
    try {
        client.res.write(message);
    } catch {
        sseClients.delete(client.res);
    }
}

function broadcastSSE(event: string, data: string): void {
    for (const client of sseClients.values()) {
        if (!client.initialized) continue;
        sendSSE(client, event, data);
    }
}

// ============================================================================
// MIME
// ============================================================================

function getMimeType(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.jsx': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
    };
    return mimeMap[ext] || 'text/plain';
}

// ============================================================================
// 主逻辑
// ============================================================================

async function main(): Promise<void> {
    console.log('=== Polymarket Sports Dashboard ===');
    console.log(`端口: ${PORT}`);

    // 初始化服务
    const sportsService = new PolySportsService();
    let tradeService: PolyTradeService | null = null;

    // 检查交易凭证
    const hasTradeCredentials = !!(
        process.env.POLYMARKET_TRADER_PRIVATE_KEY &&
        process.env.POLYMARKET_PROXY_ADDRESS &&
        process.env.POLYMARKET_API_KEY &&
        process.env.POLYMARKET_API_SECRET &&
        process.env.POLYMARKET_PASSPHRASE
    );

    if (hasTradeCredentials) {
        tradeService = new PolyTradeService();
        console.log('[Dashboard] 交易服务已启用');
    } else {
        console.log('[Dashboard] 交易凭证缺失，下单功能禁用（仅展示模式）');
    }

    // 启动赛事服务
    await sportsService.start((data: PolySportsSSE) => {
        broadcastSSE('sports', JSON.stringify(data));
    });

    // 定期推送余额
    let cachedBalance = 0;
    if (tradeService) {
        const refreshBalance = async () => {
            try {
                cachedBalance = await tradeService!.getBalance();
            } catch { /* ignore */ }
        };
        await refreshBalance();
        setInterval(refreshBalance, 30_000);
    }

    // HTTP 服务器
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = req.url?.split('?')[0] || '/';
        const method = req.method || 'GET';

        // CORS preflight
        if (method === 'OPTIONS') {
            res.writeHead(204, corsHeaders);
            res.end();
            return;
        }

        // ====== SSE ======
        if (url === '/api/stream' && method === 'GET') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                ...corsHeaders,
            });

            const client: SSEClient = { res, initialized: false };
            sseClients.set(res, client);
            req.on('close', () => sseClients.delete(res));

            // 发送快照
            const snapshot = sportsService.getSnapshot();
            snapshot.balance = cachedBalance;
            sendSSE(client, 'sports', JSON.stringify(snapshot));
            client.initialized = true;
            return;
        }

        // ====== REST API ======
        if (url === '/api/sports' && method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify(sportsService.getAllMarkets()));
            return;
        }

        if (url === '/api/account' && method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ balance: cachedBalance, tradeEnabled: !!tradeService }));
            return;
        }

        if (url === '/api/order' && method === 'POST') {
            if (!tradeService) {
                res.writeHead(403, { 'Content-Type': 'application/json', ...corsHeaders });
                res.end(JSON.stringify({ success: false, error: '交易服务未启用' }));
                return;
            }

            const body = await readBody(req);
            try {
                const input = JSON.parse(body);
                const result = await tradeService.placeOrder(input);

                // 下单后刷新余额
                if (result.success) {
                    cachedBalance = await tradeService.getBalance();
                    broadcastSSE('balance', JSON.stringify({ balance: cachedBalance }));
                }

                res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json', ...corsHeaders });
                res.end(JSON.stringify(result));
            } catch (e: any) {
                res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
            return;
        }

        // DELETE /api/order/:id
        if (url.startsWith('/api/order/') && method === 'DELETE') {
            if (!tradeService) {
                res.writeHead(403, { 'Content-Type': 'application/json', ...corsHeaders });
                res.end(JSON.stringify({ success: false, error: '交易服务未启用' }));
                return;
            }

            const orderId = url.replace('/api/order/', '');
            const success = await tradeService.cancelOrder(orderId);
            res.writeHead(success ? 200 : 500, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ success }));
            return;
        }

        // ====== 静态文件 ======
        let filePath = url === '/' ? '/poly-terminal.html' : url;
        const fullPath = resolve(FRONTEND_DIR, '.' + filePath);

        // 安全检查: 防止路径穿越
        if (!fullPath.startsWith(FRONTEND_DIR)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        if (existsSync(fullPath)) {
            try {
                const content = readFileSync(fullPath, 'utf-8');
                res.writeHead(200, {
                    'Content-Type': getMimeType(filePath),
                    'Cache-Control': 'no-store, no-cache, must-revalidate',
                    ...corsHeaders,
                });
                res.end(content);
            } catch {
                res.writeHead(500);
                res.end('Internal Server Error');
            }
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    });

    server.listen(PORT, () => {
        console.log(`[Dashboard] 启动成功: http://localhost:${PORT}`);
    });

    // 优雅退出
    const shutdown = () => {
        console.log('\n[Dashboard] 正在关闭...');
        sportsService.stop();
        server.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString()));
        req.on('error', reject);
    });
}

main().catch(e => {
    console.error('启动失败:', e);
    process.exit(1);
});
