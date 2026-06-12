module.exports = {
  apps: [
    {
      name: "dashboard",
      cwd: "E:/predict-engine",
      script: "node_modules/tsx/dist/cli.cjs",
      interpreter: "C:/Program Files/nodejs/node.exe",
      args: "src/dashboard/start-dashboard.ts --env ./.env --port 3020 --use-cache",
      autorestart: true,
      watch: false
    }
  ]
};
