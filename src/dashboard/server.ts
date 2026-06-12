import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { ArbScannerService } from './arb-service.js';
import { calculateCloseOpportunities, getClosePositions } from './hedge-mode/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3000;
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const FRONT_DIR_CANDIDATES = [
    resolve(PROJECT_ROOT, 'front'),
    resolve(__dirname, 'frontend'),
    resolve(PROJECT_ROOT, 'src', 'dashboard', 'frontend'),
];
const FRONT_DIR = FRONT_DIR_CANDIDATES.find((dir) => existsSync(join(dir, 'preview.html'))) ?? FRONT_DIR_CANDIDATES[0];
const FRONT_PREVIEW_PATH = join(FRONT_DIR, 'preview.html');
const FRONT_PREVIEW_DIR = join(FRONT_DIR, 'preview');
const HAS_FRONT_PREVIEW = existsSync(FRONT_PREVIEW_PATH);

// 安全配置
const API_TOKEN = process.env.DASHBOARD_API_TOKEN;  // 可选的 API Token
const ALLOWED_ORIGINS = [
    'http://localhost',
    'http://127.0.0.1',
    'http://[::1]',  // IPv6 localhost
];

const arbService = new ArbScannerService();

/**
 * 检查请求来源是否在白名单中
 */
function isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) return true;  // 同源请求没有 Origin 头
    return ALLOWED_ORIGINS.some(allowed =>
        origin.startsWith(allowed + ':') || origin === allowed
    );
}

/**
 * 验证 API Token（如果配置了的话）
 */
function validateApiToken(req: IncomingMessage): boolean {
    if (!API_TOKEN) return true;  // 未配置 Token 则跳过验证
    const authHeader = req.headers['authorization'];
    if (!authHeader) return false;
    const token = authHeader.replace('Bearer ', '');
    return token === API_TOKEN;
}

function getMimeType(path: string): string {
    if (path.endsWith('.html')) return 'text/html';
    if (path.endsWith('.css')) return 'text/css';
    if (path.endsWith('.js')) return 'application/javascript';
    if (path.endsWith('.json')) return 'application/json';
    if (path.endsWith('.svg')) return 'image/svg+xml';
    return 'text/plain';
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url || '/';
    const origin = req.headers['origin'] as string | undefined;

    // CORS: 仅允许 localhost 来源
    if (origin && isAllowedOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    // 非白名单来源不设置 CORS 头，浏览器会阻止跨域请求

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // 来源安全检查：阻止非 localhost 的 API 请求
    if (url.startsWith('/api/') && origin && !isAllowedOrigin(origin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: Origin not allowed' }));
        return;
    }

    // SSE endpoint
    if (url === '/api/stream') {
        // SSE headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });

        arbService.addClient(res);
        // console.log('Client connected to SSE');

        req.on('close', () => {
            arbService.removeClient(res);
            // console.log('Client disconnected from SSE');
        });
        return;
    }

    // REST API endpoints
    if (url === '/api/opportunities') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            timestamp: new Date().toISOString(),
            opportunities: arbService.getOpportunities(),
            stats: arbService.getStats().arbStats
        }));
        return;
    }

    if (url === '/api/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(arbService.getStats()));
        return;
    }

    if (url === '/api/markets') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ markets: arbService.getMarkets() }));
        return;
    }

    if (url === '/api/accounts') {
        // 敏感接口：需要 Token 验证（如果配置了 DASHBOARD_API_TOKEN）
        if (!validateApiToken(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing API token' }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(arbService.getAccounts()));
        return;
    }

    // 平仓机会 API
    if (url === '/api/close-opportunities') {
        try {
            const opportunities = await calculateCloseOpportunities();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                timestamp: new Date().toISOString(),
                count: opportunities.length,
                opportunities
            }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to calculate close opportunities' }));
        }
        return;
    }

    // 可平仓持仓 API
    if (url === '/api/close-positions') {
        try {
            const positions = await getClosePositions();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                timestamp: new Date().toISOString(),
                count: positions.length,
                positions
            }));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to get close positions' }));
        }
        return;
    }

    // Preview static files
    let filePath = url.split('?')[0];

    if (filePath === '/' && HAS_FRONT_PREVIEW) {
        filePath = '/preview';
    }

    if ((filePath === '/preview' || filePath === '/preview.html') && HAS_FRONT_PREVIEW) {
        const content = readFileSync(FRONT_PREVIEW_PATH);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
        return;
    }

    if (filePath.startsWith('/preview/')) {
        const relativePath = filePath.replace('/preview/', '');
        const fullPath = join(FRONT_PREVIEW_DIR, relativePath);
        if (existsSync(fullPath)) {
            const content = readFileSync(fullPath);
            res.writeHead(200, { 'Content-Type': getMimeType(fullPath) });
            res.end(content);
            return;
        }
    }

    if (url !== '/favicon.ico') {
        // console.log(`404: ${url}`);
    }
    res.writeHead(404);
    res.end('Not Found');
}

function listenWithRetry(server: any, port: number, maxRetries: number = 10): Promise<number> {
    return new Promise((resolve, reject) => {
        server.on('error', (e: any) => {
            if (e.code === 'EADDRINUSE') {
                if (maxRetries > 0) {
                    console.log(`Port ${port} in use, trying ${port + 1}...`);
                    server.listen(port + 1);
                    // This creates a chain? Actually server.listen again on same server instance might be cleaner if we close first, 
                    // but on('error') for net.Server usually allows re-listen. 
                    // However, to be safe, easier to rely on the recursive call logic if we were creating new servers, 
                    // but here we reuse the server instance.
                    // simpler: just handle the error recursively by re-listening on next port.
                    // But we need to update the port variable for the NEXT error.
                    // The 'error' listener stays attached. 
                    // We need to be careful not to stack listeners.

                    // Actually, let's just use recursion with new server instances or simple retry logic in a more robust way:
                    // But for this simple script:
                    resolve(listenWithRetry(server, port + 1, maxRetries - 1));
                } else {
                    reject(new Error('Could not find an open port'));
                }
            } else {
                reject(e);
            }
        });

        server.listen(port, () => {
            resolve(port);
        });
    });
}

export function startDashboardServer(initialPort: number = Number(process.env.DASHBOARD_PORT || DEFAULT_PORT)): Promise<void> {
    const server = createServer(handleRequest);

    return new Promise((resolve, reject) => {
        let currentPort = initialPort;

        server.on('error', (e: any) => {
            if (e.code === 'EADDRINUSE') {
                console.log(`⚠️  端口 ${currentPort} 被占用，尝试 ${currentPort + 1}...`);
                currentPort++;
                server.close();
                server.listen(currentPort);
            } else {
                console.error('Server error:', e);
                reject(e);
            }
        });

        server.on('listening', async () => {
            console.log(`\n🚀 Dashboard 启动成功!`);
            console.log(`👉 访问地址: http://localhost:${currentPort}`);
            console.log(`📡 API 接口: http://localhost:${currentPort}/api/stream`);

            try {
                console.log(`\n📊 启动数据服务...`);
                await arbService.start();
                resolve();
            } catch (e) {
                console.error(`\n❌ 启动失败:`, e);
                reject(e);
            }
        });

        server.listen(currentPort);
    });
}

// Auto-start if run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    startDashboardServer();
}
