/**
 * Predict 做市模块 - 日志系统
 *
 * 功能:
 * - 日志分级 (DEBUG, INFO, WARN, ERROR)
 * - 日志轮转 (按大小/时间)
 * - 控制台彩色输出
 * - 文件持久化
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// 类型定义
// ============================================================================

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LoggerConfig {
    level: LogLevel;           // 最低日志级别
    console: boolean;          // 是否输出到控制台
    file: boolean;             // 是否写入文件
    filePath?: string;         // 日志文件路径
    maxFileSize?: number;      // 最大文件大小 (bytes)，超过则轮转
    maxFiles?: number;         // 保留的历史文件数量
    errorFile?: string;        // 错误日志单独文件
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};

// ANSI 颜色
const COLORS = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
};

const LEVEL_COLORS: Record<LogLevel, string> = {
    DEBUG: COLORS.dim,
    INFO: COLORS.green,
    WARN: COLORS.yellow,
    ERROR: COLORS.red,
};

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: LoggerConfig = {
    level: 'INFO',
    console: true,
    file: true,
    filePath: './logs/market-maker.log',
    maxFileSize: 10 * 1024 * 1024,  // 10MB
    maxFiles: 5,
    errorFile: './logs/market-maker-error.log',
};

// ============================================================================
// Logger 类
// ============================================================================

export class Logger {
    private config: LoggerConfig;
    private currentFileSize = 0;
    private fileStream: fs.WriteStream | null = null;
    private errorStream: fs.WriteStream | null = null;

    constructor(config: Partial<LoggerConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };

        if (this.config.file && this.config.filePath) {
            this.initFileStream();
        }
        if (this.config.file && this.config.errorFile) {
            this.initErrorStream();
        }
    }

    private initFileStream(): void {
        const dir = path.dirname(this.config.filePath!);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // 检查现有文件大小
        if (fs.existsSync(this.config.filePath!)) {
            const stats = fs.statSync(this.config.filePath!);
            this.currentFileSize = stats.size;
        }

        this.fileStream = fs.createWriteStream(this.config.filePath!, { flags: 'a' });
    }

    private initErrorStream(): void {
        const dir = path.dirname(this.config.errorFile!);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.errorStream = fs.createWriteStream(this.config.errorFile!, { flags: 'a' });
    }

    private shouldLog(level: LogLevel): boolean {
        return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.config.level];
    }

    private formatMessage(level: LogLevel, prefix: string, message: string): string {
        const timestamp = new Date().toISOString();
        return `[${timestamp}] [${level}] ${prefix ? `[${prefix}] ` : ''}${message}`;
    }

    private rotateIfNeeded(): void {
        if (!this.config.filePath || !this.config.maxFileSize) return;
        if (this.currentFileSize < this.config.maxFileSize) return;

        // 关闭当前流
        this.fileStream?.end();

        // 轮转文件
        const maxFiles = this.config.maxFiles || 5;
        for (let i = maxFiles - 1; i >= 0; i--) {
            const oldPath = i === 0
                ? this.config.filePath
                : `${this.config.filePath}.${i}`;
            const newPath = `${this.config.filePath}.${i + 1}`;

            if (fs.existsSync(oldPath)) {
                if (i === maxFiles - 1) {
                    fs.unlinkSync(oldPath);  // 删除最旧的
                } else {
                    fs.renameSync(oldPath, newPath);
                }
            }
        }

        // 重新打开流
        this.currentFileSize = 0;
        this.fileStream = fs.createWriteStream(this.config.filePath, { flags: 'a' });
    }

    private writeToFile(formattedMessage: string, level: LogLevel): void {
        if (!this.config.file) return;

        const line = formattedMessage + '\n';
        const lineBytes = Buffer.byteLength(line);

        // 写入主日志
        if (this.fileStream) {
            this.rotateIfNeeded();
            this.fileStream.write(line);
            this.currentFileSize += lineBytes;
        }

        // ERROR 和 WARN 额外写入错误日志
        if ((level === 'ERROR' || level === 'WARN') && this.errorStream) {
            this.errorStream.write(line);
        }
    }

    private log(level: LogLevel, prefix: string, message: string, ...args: unknown[]): void {
        if (!this.shouldLog(level)) return;

        // 格式化额外参数
        let fullMessage = message;
        if (args.length > 0) {
            const argsStr = args.map(arg => {
                if (typeof arg === 'object') {
                    try {
                        return JSON.stringify(arg);
                    } catch {
                        return String(arg);
                    }
                }
                return String(arg);
            }).join(' ');
            fullMessage = `${message} ${argsStr}`;
        }

        const formattedMessage = this.formatMessage(level, prefix, fullMessage);

        // 控制台输出
        if (this.config.console) {
            const color = LEVEL_COLORS[level];
            console.log(`${color}${formattedMessage}${COLORS.reset}`);
        }

        // 文件输出
        this.writeToFile(formattedMessage, level);
    }

    // 公开方法
    debug(prefix: string, message: string, ...args: unknown[]): void {
        this.log('DEBUG', prefix, message, ...args);
    }

    info(prefix: string, message: string, ...args: unknown[]): void {
        this.log('INFO', prefix, message, ...args);
    }

    warn(prefix: string, message: string, ...args: unknown[]): void {
        this.log('WARN', prefix, message, ...args);
    }

    error(prefix: string, message: string, ...args: unknown[]): void {
        this.log('ERROR', prefix, message, ...args);
    }

    // 关闭日志流
    close(): void {
        this.fileStream?.end();
        this.errorStream?.end();
    }

    // 设置日志级别
    setLevel(level: LogLevel): void {
        this.config.level = level;
    }
}

// ============================================================================
// 全局单例
// ============================================================================

let globalLogger: Logger | null = null;

export function initLogger(config?: Partial<LoggerConfig>): Logger {
    globalLogger = new Logger(config);
    return globalLogger;
}

export function getLogger(): Logger {
    if (!globalLogger) {
        globalLogger = new Logger();
    }
    return globalLogger;
}

// ============================================================================
// 便捷导出
// ============================================================================

export const log = {
    debug: (prefix: string, message: string, ...args: unknown[]) =>
        getLogger().debug(prefix, message, ...args),
    info: (prefix: string, message: string, ...args: unknown[]) =>
        getLogger().info(prefix, message, ...args),
    warn: (prefix: string, message: string, ...args: unknown[]) =>
        getLogger().warn(prefix, message, ...args),
    error: (prefix: string, message: string, ...args: unknown[]) =>
        getLogger().error(prefix, message, ...args),
};
