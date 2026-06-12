/**
 * CLI 参数解析与环境初始化
 *
 * 从 start-dashboard.ts 提取的启动流程函数：
 * - parseCliArgs: 命令行参数解析
 * - scanAccountConfigs: 扫描 .env.account* 配置文件
 * - selectAccountInteractive: 交互式选择账号
 * - loadEnv: 加载 .env 文件到 process.env
 * - initConfig: 组合上述步骤，返回 InitResult
 * - killProcessOnPort: 端口占用清理 (仅 Windows)
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import * as readline from 'readline';
import type { CliArgs, AccountConfig } from './dashboard-types.js';
import { ensurePolymarketEnv } from './polymarket-env-bootstrap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');

// ============================================================================
// InitResult 接口
// ============================================================================

export interface InitResult {
    port: number;
    accountName: string;
    dataDir: string;
}

// ============================================================================
// 命令行参数解析
// ============================================================================

function parseCliArgs(): CliArgs {
    const args = process.argv.slice(2);
    const result: CliArgs = {
        envFile: null,  // 默认 null，后续判断是否需要交互
        port: null,
        accountName: null,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        // --env <path> 或 --env=<path>
        if (arg === '--env' && args[i + 1]) {
            result.envFile = resolve(args[++i]);
        } else if (arg.startsWith('--env=')) {
            result.envFile = resolve(arg.slice(6));
        }

        // --port <number> 或 --port=<number>
        else if (arg === '--port' && args[i + 1]) {
            result.port = parseInt(args[++i], 10);
        } else if (arg.startsWith('--port=')) {
            result.port = parseInt(arg.slice(7), 10);
        }

        // --account <name> 或 --account=<name> (用于日志标识)
        else if (arg === '--account' && args[i + 1]) {
            result.accountName = args[++i];
        } else if (arg.startsWith('--account=')) {
            result.accountName = arg.slice(10);
        }

        // --help
        else if (arg === '--help' || arg === '-h') {
            console.log(`
Dashboard 启动参数:
  --env <path>      指定配置文件路径 (默认: 交互选择或 .env)
  --port <number>   指定端口 (默认: 3010 或 DASHBOARD_PORT)
  --account <name>  账号名称标识 (用于日志区分)
  --help            显示帮助

示例:
  npm run dashboard                                              # 交互式选择账号
  npm run dashboard -- --env .env.account1 --port 3010 --account account1
  npm run dashboard -- --env .env.account2 --port 3006 --account account2
`);
            process.exit(0);
        }
    }

    return result;
}

// ============================================================================
// 账号配置扫描与交互选择
// ============================================================================

/**
 * 扫描项目根目录下的 .env.account* 配置文件
 */
function scanAccountConfigs(): AccountConfig[] {
    const configs: AccountConfig[] = [];

    try {
        const files = readdirSync(PROJECT_ROOT);
        for (const file of files) {
            // 匹配 .env.account* 格式（排除 .example 文件）
            const match = file.match(/^\.env\.([a-zA-Z0-9_-]+)$/);
            if (match && !file.endsWith('.example')) {
                const accountName = match[1];
                configs.push({
                    name: accountName,
                    envFile: join(PROJECT_ROOT, file),
                    displayName: `${accountName} (${file})`,
                });
            }
        }
    } catch (e) {
        // 忽略扫描错误
    }

    // 按名称排序
    configs.sort((a, b) => a.name.localeCompare(b.name));

    return configs;
}

/**
 * 交互式选择账号配置
 */
async function selectAccountInteractive(configs: AccountConfig[]): Promise<{ envFile: string; accountName: string }> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        console.log('\n📋 选择账号配置:\n');

        // 显示选项
        configs.forEach((config, index) => {
            console.log(`  ${index + 1}. ${config.displayName}`);
        });
        console.log(`  ${configs.length + 1}. [默认] (.env)\n`);

        rl.question('请输入序号 (默认 1): ', (answer) => {
            rl.close();

            const choice = parseInt(answer.trim(), 10) || 1;

            if (choice > 0 && choice <= configs.length) {
                const selected = configs[choice - 1];
                resolve({
                    envFile: selected.envFile,
                    accountName: selected.name,
                });
            } else {
                // 默认 .env
                resolve({
                    envFile: join(PROJECT_ROOT, '.env'),
                    accountName: '',
                });
            }
        });
    });
}

// 加载 .env 文件
function loadEnv(envPath: string, accountName: string | null) {
    if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
            const match = line.trim().match(/^([^#=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                const value = match[2].trim();
                if (!process.env[key]) {
                    process.env[key] = value;
                }
            }
        }
        const label = accountName ? ` [${accountName}]` : '';
        console.log(`✅ 已加载配置: ${envPath}${label}\n`);
    } else {
        // Docker 环境中 --env-file 已注入环境变量，.env 文件可能不存在
        if (process.env.PREDICT_API_KEY) {
            console.log(`⚠️ 配置文件不存在: ${envPath}，使用已注入的环境变量\n`);
        } else {
            console.error(`❌ 配置文件不存在: ${envPath}`);
            process.exit(1);
        }
    }
}

// ============================================================================
// 初始化（异步）
// ============================================================================

export async function initConfig(): Promise<InitResult> {
    const cliArgs = parseCliArgs();

    let envFile: string;
    let accountName: string | null = cliArgs.accountName;

    if (cliArgs.envFile) {
        // 命令行指定了配置文件
        envFile = cliArgs.envFile;
    } else {
        // 扫描可用的账号配置
        const configs = scanAccountConfigs();

        if (configs.length > 0) {
            // 有多个账号配置，交互式选择
            const selected = await selectAccountInteractive(configs);
            envFile = selected.envFile;
            accountName = accountName || selected.accountName;
        } else {
            // 没有账号配置，使用默认 .env
            envFile = join(PROJECT_ROOT, '.env');
        }
    }

    // 加载配置
    loadEnv(envFile, accountName);

    // Polymarket 配置留空时从私钥自动派生 (写回 .env + 注入 process.env)
    try {
        ensurePolymarketEnv(envFile);
    } catch (e: any) {
        console.error(`❌ Polymarket 配置自动派生失败: ${e?.message || e}`);
        console.error('   请补全 .env 中的 POLYMARKET_* 配置，或运行: python tools/get-pm-apikey.py');
        process.exit(1);
    }

    // 计算结果
    const port = cliArgs.port || parseInt(process.env.DASHBOARD_PORT || '3010', 10);
    const resolvedAccountName = accountName || process.env.ACCOUNT_NAME || '';
    const dataDir = resolvedAccountName ? `./data/${resolvedAccountName}` : './data';

    if (resolvedAccountName) {
        console.log(`📁 数据目录: ${dataDir}`);
    }

    return { port, accountName: resolvedAccountName, dataDir };
}

// ============================================================================
// 端口清理工具 (Windows)
// ============================================================================

/**
 * 杀掉占用指定端口的进程 (仅 Windows)
 */
export function killProcessOnPort(port: number): boolean {
    if (process.platform !== 'win32') {
        console.log('⚠️  自动杀进程功能仅支持 Windows');
        return false;
    }

    try {
        // 查找占用端口的进程 PID
        const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf-8' });
        const lines = result.split('\n').filter(line => line.includes('LISTENING'));

        if (lines.length === 0) {
            return false;
        }

        // 提取 PID (最后一列)
        const pids = new Set<string>();
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            const pid = parts[parts.length - 1];
            if (pid && /^\d+$/.test(pid) && pid !== '0') {
                pids.add(pid);
            }
        }

        if (pids.size === 0) {
            return false;
        }

        // 杀掉进程
        for (const pid of pids) {
            try {
                console.log(`🔪 正在杀掉占用端口 ${port} 的进程 (PID: ${pid})...`);
                execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf-8' });
                console.log(`✅ 进程 ${pid} 已终止`);
            } catch (e) {
                // 进程可能已经退出
            }
        }

        // 等待端口释放
        return true;
    } catch (e) {
        // 没有找到占用端口的进程
        return false;
    }
}
