/**
 * 一键启动 Dashboard (后端)
 */

import { spawn, ChildProcess } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const botDir = join(__dirname, '..', '..');

const BACKEND_PORT = process.env.DASHBOARD_PORT || 3002;

let backendProcess: ChildProcess | null = null;

function log(tag: string, message: string) {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] [${tag}] ${message}`);
}

function startBackend(): Promise<void> {
    return new Promise((resolve, reject) => {
        log('BACKEND', `启动后端服务 (端口 ${BACKEND_PORT})...`);

        backendProcess = spawn('npx', ['tsx', 'src/dashboard/start-dashboard.ts'], {
            cwd: botDir,
            shell: true,
            stdio: ['inherit', 'pipe', 'pipe'],
            env: { ...process.env, DASHBOARD_PORT: String(BACKEND_PORT) }
        });

        let resolved = false;

        backendProcess.stdout?.on('data', (data) => {
            const text = data.toString().trim();
            if (text) {
                for (const line of text.split('\n')) {
                    log('BACKEND', line);
                }
            }
            // 检测后端启动成功
            if (!resolved && text.includes('Dashboard 运行在')) {
                resolved = true;
                resolve();
            }
        });

        backendProcess.stderr?.on('data', (data) => {
            const text = data.toString().trim();
            if (text && !text.includes('ExperimentalWarning')) {
                log('BACKEND', `[ERR] ${text}`);
            }
        });

        backendProcess.on('error', (err) => {
            log('BACKEND', `启动失败: ${err.message}`);
            if (!resolved) reject(err);
        });

        backendProcess.on('exit', (code) => {
            log('BACKEND', `进程退出 (code: ${code})`);
            backendProcess = null;
        });

        // 超时检测
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                resolve(); // 即使没检测到也继续
            }
        }, 10000);
    });
}

function cleanup() {
    log('MAIN', '正在关闭...');

    if (backendProcess) {
        backendProcess.kill();
        backendProcess = null;
    }

    process.exit(0);
}

async function main() {
    console.log('');
    console.log('═'.repeat(60));
    console.log('  Arb Scanner Dashboard 一键启动');
    console.log('═'.repeat(60));
    console.log('');

    // 注册退出处理
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    try {
        // 1. 启动后端
        await startBackend();

        console.log('');
        console.log('─'.repeat(60));
        console.log('  ✅ Dashboard 已启动');
        console.log('─'.repeat(60));
        console.log(`  后端 API:   http://localhost:${BACKEND_PORT}`);
        console.log(`  预览页面:   http://localhost:${BACKEND_PORT}/preview`);
        console.log(`  SSE 流:     http://localhost:${BACKEND_PORT}/api/stream`);
        console.log('─'.repeat(60));
        console.log('  按 Ctrl+C 停止所有服务');
        console.log('─'.repeat(60));
        console.log('');

    } catch (error: any) {
        log('MAIN', `启动失败: ${error.message}`);
        cleanup();
    }
}

main();
