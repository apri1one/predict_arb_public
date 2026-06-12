module.exports = {
    apps: [
        {
            name: "dashboard",
            cwd: __dirname,
            script: "node_modules/tsx/dist/cli.cjs",
            args: "src/dashboard/start-dashboard.ts --port 3010 --use-cache --rescan",
            interpreter: "node",
            interpreter_args: "--max-old-space-size=1536",
            windowsHide: true,
            kill_timeout: 60000,
            max_memory_restart: "1400M",
            log_date_format: "MM-DD HH:mm:ss",
            max_size: "20M",
            retain: 3,
            compress: false,
        }
    ]
};
