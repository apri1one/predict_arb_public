#!/bin/bash
# POLY_MAKER 对冲指标 10 小时回顾报告
# 读 pm2 日志 → 统计 → TG 推送
# 由 schedule-metrics-report.sh 通过 nohup+sleep 调度

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
LOG_FILE="${LOG_FILE:-${PM2_HOME:-${HOME}/.pm2}/logs/dashboard-out.log}"
ENV_FILE="${ENV_FILE:-${PROJECT_ROOT}/.env}"
OUT_FILE="${OUT_FILE:-/tmp/poly-maker-metrics-report.$(date +%Y%m%d-%H%M).txt}"

# 加载 TG 凭证
if [ ! -f "${ENV_FILE}" ]; then
  echo "ERROR: ${ENV_FILE} not found" >&2
  exit 1
fi

TELEGRAM_BOT_TOKEN=$(grep -E "^TELEGRAM_BOT_TOKEN=" "${ENV_FILE}" | head -1 | cut -d= -f2-)
TELEGRAM_CHAT_ID=$(grep -E "^TELEGRAM_CHAT_ID=" "${ENV_FILE}" | head -1 | cut -d= -f2-)

if [ -z "${TELEGRAM_BOT_TOKEN}" ] || [ -z "${TELEGRAM_CHAT_ID}" ]; then
  echo "ERROR: TG credentials missing" >&2
  exit 1
fi

# 调用 Python 脚本分析日志（复杂统计用 Python 更清晰）
REPORT=$(python3 "${PROJECT_ROOT}/scripts/poly-maker-metrics-report.py" "${LOG_FILE}" 2>&1)

if [ -z "${REPORT}" ]; then
  REPORT="⚠️ 报告生成失败，无输出"
fi

# 保存副本
echo "${REPORT}" > "${OUT_FILE}"

# 推 TG（HTML parse mode）
curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${REPORT}" \
  -d "parse_mode=HTML" \
  -d "disable_web_page_preview=true" \
  > /dev/null

echo "Report sent. Saved to ${OUT_FILE}"
