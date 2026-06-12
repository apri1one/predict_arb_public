/**
 * HTTP 工具函数
 *
 * 从 start-dashboard.ts 提取：JSON body 解析、MIME 类型、CORS、鉴权。
 *
 * CORS 白名单依赖运行时端口（来自 CLI 参数），必须在使用前调用 initHttpUtils(port)。
 * DASHBOARD_API_TOKEN 在函数内部 lazy 读取 process.env，确保 .env 已加载。
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { MAX_BODY_SIZE } from './dashboard-config.js';

// ============================================================================
// CORS 白名单 (模块私有，lazy 初始化)
// ============================================================================

let _allowedOrigins: string[] | null = null;

/**
 * 初始化 HTTP 工具模块 (必须在 initConfig() 之后调用)
 *
 * @param port Dashboard 端口号
 */
export function initHttpUtils(port: number): void {
    const dashboardPort = String(port);
    const defaultAllowed = [
        `http://localhost:${dashboardPort}`,
        `http://127.0.0.1:${dashboardPort}`,
        'http://localhost:5173',
        'http://127.0.0.1:5173',
    ];
    const envAllowed = (process.env.DASHBOARD_ALLOWED_ORIGINS || '')
        .split(',')
        .map(origin => origin.trim())
        .filter(Boolean);
    _allowedOrigins = Array.from(new Set([...defaultAllowed, ...envAllowed]));
}

function getAllowedOrigins(): string[] {
    if (!_allowedOrigins) {
        throw new Error('http-utils not initialized: call initHttpUtils(port) after initConfig()');
    }
    return _allowedOrigins;
}

// ============================================================================
// JSON Body 解析辅助函数
// ============================================================================

export async function parseJsonBody<T>(req: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_SIZE) {
                req.destroy();
                reject(new Error('Request body too large'));
                return;
            }
            body += chunk;
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body) as T);
            } catch (e) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

// ============================================================================
// MIME 类型映射
// ============================================================================

export function getMimeType(path: string): string {
    if (path.endsWith('.html')) return 'text/html';
    if (path.endsWith('.css')) return 'text/css';
    if (path.endsWith('.js')) return 'application/javascript';
    if (path.endsWith('.json')) return 'application/json';
    return 'text/plain';
}

// ============================================================================
// 网络地址判断
// ============================================================================

export function isLoopbackAddress(address?: string): boolean {
    if (!address) return false;
    if (address === '::1' || address === '127.0.0.1') return true;
    if (address.startsWith('127.')) return true;
    if (address.startsWith('::ffff:127.')) return true;
    return false;
}

/**
 * 检查是否是局域网私有 IP 地址
 * - 10.0.0.0 - 10.255.255.255
 * - 172.16.0.0 - 172.31.255.255
 * - 192.168.0.0 - 192.168.255.255
 */
export function isPrivateAddress(address?: string): boolean {
    if (!address) return false;
    // 去除 IPv6 前缀
    const ip = address.replace(/^::ffff:/, '');
    // 10.x.x.x
    if (ip.startsWith('10.')) return true;
    // 192.168.x.x
    if (ip.startsWith('192.168.')) return true;
    // 172.16.x.x - 172.31.x.x
    if (ip.startsWith('172.')) {
        const second = parseInt(ip.split('.')[1], 10);
        if (second >= 16 && second <= 31) return true;
    }
    return false;
}

// ============================================================================
// API 鉴权
// ============================================================================

/**
 * 检查请求是否通过鉴权
 * - 如果配置了 DASHBOARD_API_TOKEN，需要 Bearer token 校验
 * - 如果未配置 token，只允许来自 localhost 的请求
 *
 * DASHBOARD_API_TOKEN 在函数内部 lazy 读取 process.env，
 * 确保 .env 已被 initConfig() 加载。
 */
export function isAuthorizedRequest(req: IncomingMessage): boolean {
    const dashboardApiToken = process.env.DASHBOARD_API_TOKEN || '';

    // 检查 Bearer token
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        if (dashboardApiToken && token === dashboardApiToken) {
            return true;
        }
    }

    // token 模式下允许通过 query 传入（兼容 EventSource 无法设置 header）
    if (dashboardApiToken) {
        try {
            const url = new URL(req.url || '/', 'http://localhost');
            const token = url.searchParams.get('token');
            if (token && token === dashboardApiToken) {
                return true;
            }
        } catch {
            // ignore
        }
        return false;
    }

    // 未配置 token，允许本机和局域网访问
    const remoteAddress = req.socket?.remoteAddress;

    // X-Forwarded-For 已禁用（可被伪造）
    // 仅信任 socket.remoteAddress（通过 SSH 隧道访问时为 127.0.0.1）
    return isLoopbackAddress(remoteAddress) || isPrivateAddress(remoteAddress);
}

// ============================================================================
// CORS
// ============================================================================

/**
 * 检查 origin 是否来自局域网 IP
 */
export function isPrivateOrigin(origin: string): boolean {
    try {
        const url = new URL(origin);
        const host = url.hostname;
        return isPrivateAddress(host) || isLoopbackAddress(host);
    } catch {
        return false;
    }
}

/**
 * 获取安全的 CORS 头
 */
export function getSecureCorsHeaders(req: IncomingMessage): Record<string, string> {
    const origin = req.headers['origin'] || '';
    // 允许白名单或局域网来源
    if (getAllowedOrigins().includes(origin) || isPrivateOrigin(origin)) {
        return {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Credentials': 'true',
        };
    }
    // 默认不允许跨域
    return {};
}

export function requireAuth(req: IncomingMessage, res: ServerResponse): Record<string, string> | null {
    const corsHeaders = getSecureCorsHeaders(req);
    if (!isAuthorizedRequest(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
        return null;
    }
    return corsHeaders;
}
