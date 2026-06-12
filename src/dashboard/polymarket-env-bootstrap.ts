/**
 * Polymarket 环境自动引导
 *
 * .env 只需填 POLYMARKET_TRADER_PRIVATE_KEY，其余 Polymarket 配置留空时，
 * 启动阶段自动调用 tools/get-pm-apikey.py (--json --stdin) 从私钥派生:
 *   - POLYMARKET_PROXY_ADDRESS  (polymarket.com profile / Safe API)
 *   - POLYMARKET_API_KEY / API_SECRET / PASSPHRASE  (CLOB L2 凭证, 确定性派生)
 *   - POLYMARKET_TRADER_ADDRESS (EOA, 顺带补全)
 * 派生结果写回 .env 并注入 process.env 后继续启动。
 *
 * 失败即中止: 凭证派生失败时抛错 (缺凭证的 dashboard 交易功能不可用, fail fast)。
 * 私钥通过 stdin 传给 Python 脚本, 不出现在命令行参数与日志中。
 */

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const DERIVE_SCRIPT = join(PROJECT_ROOT, 'tools', 'get-pm-apikey.py');

/** L2 凭证三件套必须同源 (同一次派生), 任一缺失则三个全部重写 */
const CRED_KEYS = ['POLYMARKET_API_KEY', 'POLYMARKET_API_SECRET', 'POLYMARKET_PASSPHRASE'] as const;

interface DeriveResult {
    address?: string;
    proxyAddress?: string;
    apiKey?: string;
    apiSecret?: string;
    passphrase?: string;
    error?: string;
}

/** 空值判断: 未设置、空白、或 "0x" 占位符 (来自旧 .env.example 模板) 均视为空 */
function isBlank(v: string | undefined): boolean {
    const t = (v || '').trim();
    return !t || t === '0x';
}

function findPython(): string {
    const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
    for (const cmd of candidates) {
        const probe = spawnSync(cmd, ['--version'], { stdio: 'pipe', windowsHide: true });
        if (probe.status === 0) return cmd;
    }
    throw new Error('未找到 python/python3，无法自动派生 Polymarket 配置 (需先安装 Python + pip install -r tools/requirements.txt)');
}

/**
 * 更新 .env 中指定 key (保留注释/空行/其余行与原行尾)。
 * latin1 读写保证非 ASCII 行字节保真; 写入的值均为 ASCII。
 */
function updateEnvFile(envPath: string, updates: Record<string, string>): void {
    const text = readFileSync(envPath, 'latin1');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const pending = new Map(Object.entries(updates));
    const newLines: string[] = [];

    for (const line of lines) {
        const stripped = line.trim();
        if (stripped && !stripped.startsWith('#')) {
            const match = stripped.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
            const key = match?.[1];
            if (key && pending.has(key)) {
                newLines.push(`${key}=${pending.get(key)}`);
                pending.delete(key);
                continue;
            }
        }
        newLines.push(line);
    }

    if (pending.size > 0) {
        // 去掉文件尾部多余空行后追加
        while (newLines.length > 0 && newLines[newLines.length - 1].trim() === '') newLines.pop();
        newLines.push('');
        newLines.push('# === Polymarket (auto-generated) ===');
        for (const [key, value] of pending) newLines.push(`${key}=${value}`);
    }

    writeFileSync(envPath, newLines.join(eol) + eol, 'latin1');
}

/**
 * 检测 Polymarket 配置缺口并自动派生补全。
 * 配置完整或无私钥时为 noop; 派生失败时抛错。
 */
export function ensurePolymarketEnv(envPath: string): void {
    const pk = (process.env.POLYMARKET_TRADER_PRIVATE_KEY || '').trim();
    if (!pk) return; // 无私钥不归本模块管, 后续模块自行报错

    const missingCreds = CRED_KEYS.filter(k => isBlank(process.env[k]));
    const missingProxy = isBlank(process.env.POLYMARKET_PROXY_ADDRESS);
    if (missingCreds.length === 0 && !missingProxy) return;

    const missingDesc = [...missingCreds, ...(missingProxy ? ['POLYMARKET_PROXY_ADDRESS'] : [])];
    console.log(`🔑 Polymarket 配置缺失 (${missingDesc.join(', ')})，正在从私钥自动派生...`);

    if (!existsSync(DERIVE_SCRIPT)) {
        throw new Error(`派生脚本不存在: ${DERIVE_SCRIPT}`);
    }

    const python = findPython();
    const proc = spawnSync(python, [DERIVE_SCRIPT, '--json', '--stdin'], {
        input: pk + '\n',
        encoding: 'utf-8',
        timeout: 90_000,
        windowsHide: true,
        cwd: PROJECT_ROOT,
    });

    if (proc.error) {
        throw new Error(`派生脚本执行失败: ${proc.error.message}`);
    }

    // --json 模式输出单行 JSON; 依赖检查失败时 stdout 是提示文字
    const stdout = (proc.stdout || '').trim();
    const jsonLine = stdout.split('\n').reverse().find(l => l.trim().startsWith('{'));
    if (!jsonLine) {
        const detail = [stdout.slice(0, 400), (proc.stderr || '').trim().slice(0, 400)].filter(Boolean).join(' | ');
        throw new Error(`派生脚本无 JSON 输出 (exit=${proc.status}): ${detail}`);
    }

    let result: DeriveResult;
    try {
        result = JSON.parse(jsonLine) as DeriveResult;
    } catch {
        throw new Error(`派生脚本 JSON 解析失败 (exit=${proc.status})`);
    }
    if (result.error) {
        throw new Error(`派生失败: ${result.error}`);
    }
    for (const field of ['address', 'proxyAddress', 'apiKey', 'apiSecret', 'passphrase'] as const) {
        if (!result[field]) throw new Error(`派生结果缺少字段 ${field}`);
    }

    const updates: Record<string, string> = {};
    if (missingCreds.length > 0) {
        updates.POLYMARKET_API_KEY = result.apiKey!;
        updates.POLYMARKET_API_SECRET = result.apiSecret!;
        updates.POLYMARKET_PASSPHRASE = result.passphrase!;
    }
    if (missingProxy) updates.POLYMARKET_PROXY_ADDRESS = result.proxyAddress!;
    if (isBlank(process.env.POLYMARKET_TRADER_ADDRESS)) {
        updates.POLYMARKET_TRADER_ADDRESS = result.address!;
    }

    for (const [k, v] of Object.entries(updates)) process.env[k] = v;

    if (existsSync(envPath)) {
        updateEnvFile(envPath, updates);
        console.log(`✅ Polymarket 配置已派生并写入 ${envPath}`);
    } else {
        // Docker 等纯环境变量注入场景: 无 .env 文件可写, 仅注入当前进程
        console.warn(`⚠️  配置文件 ${envPath} 不存在，派生结果仅注入当前进程 (未持久化)`);
    }
    console.log(`   EOA: ${result.address}  Proxy: ${result.proxyAddress}`);
}
