const path = require('path');
const { spawn } = require('child_process');

const projectRoot = process.cwd();
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.cjs');
const dashboardEntry = path.join('src', 'dashboard', 'start-dashboard.ts');
const dashboardPort = process.env.DASHBOARD_PORT || '3020';

const child = spawn(
    process.execPath,
    [tsxCli, dashboardEntry, '--env', './.env', '--port', dashboardPort, '--use-cache'],
    {
        cwd: projectRoot,
        env: process.env,
        stdio: 'inherit',
        windowsHide: true,
    }
);

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 0);
});

['SIGINT', 'SIGTERM', 'SIGBREAK'].forEach((sig) => {
    process.on(sig, () => {
        if (!child.killed) {
            child.kill(sig);
        }
    });
});
