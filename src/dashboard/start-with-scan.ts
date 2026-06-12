/**
 * Dashboard 启动脚本 - 先扫描市场再启动
 */

import { execSync } from 'child_process';
import * as path from 'path';

console.log('='.repeat(60));
console.log('   Dashboard 启动流程');
console.log('='.repeat(60));
console.log();

// 1. 扫描市场
console.log('📡 步骤 1/2: 扫描 Predict 市场并匹配 Polymarket...\n');

try {
    const scanScript = path.join(__dirname, '..', 'terminal', 'scan-all-markets.ts');
    execSync(`npx tsx ${scanScript}`, {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..', '..')
    });
    console.log('\n✅ 市场扫描完成\n');
} catch (error) {
    console.error('❌ 市场扫描失败:', error);
    console.error('   继续使用缓存的市场列表...\n');
}

// 2. 启动 Dashboard
console.log('🚀 步骤 2/2: 启动 Dashboard 服务器...\n');

try {
    const dashboardScript = path.join(__dirname, 'start-dashboard.ts');
    execSync(`npx tsx ${dashboardScript}`, {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..', '..')
    });
} catch (error) {
    console.error('❌ Dashboard 启动失败:', error);
    process.exit(1);
}
