#!/bin/bash
# 一次性脚本：Polymarket V2 升级窗口重启 PM2 dashboard
# 触发时间: 2026-04-28 07:00 UTC (= 15:00 UTC+8)
# 跑完自动从 crontab 删除自己

LOG=/home/ubuntu/predict_arb/scripts/scheduled-v2-restart.log
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/ubuntu/.npm-global/bin:/home/ubuntu/.nvm/versions/node/v20.18.0/bin

{
    echo ""
    echo "=== $(date -u +'%F %T') UTC: Polymarket V2 scheduled restart ==="
    echo "Pre-restart pm2 status:"
    pm2 list | grep -E "name|dashboard"

    echo ""
    echo "Restarting dashboard..."
    pm2 restart dashboard --update-env
    RESTART_RC=$?
    echo "pm2 restart exit code: $RESTART_RC"

    sleep 8

    echo ""
    echo "Post-restart pm2 status:"
    pm2 list | grep -E "name|dashboard"

    echo ""
    echo "Tail of dashboard-out.log:"
    tail -n 20 /home/ubuntu/.pm2/logs/dashboard-out.log

    echo "=== $(date -u +'%F %T') UTC: Done ==="
} >> "$LOG" 2>&1

# 自删 cron 条目（一次性任务）
crontab -l 2>/dev/null | grep -v "scheduled-v2-restart" | crontab -
