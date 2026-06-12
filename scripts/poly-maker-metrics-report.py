#!/usr/bin/env python3
"""
POLY_MAKER 对冲指标 10 小时统计分析

从 pm2 日志读取 [PolyMakerExecutor] 相关对冲行，解析其中的 e2eMs/elapsedMs/retries 等字段，
统计 min/p50/avg/p95/max，输出适合 TG 推送的简报。

用法: python3 poly-maker-metrics-report.py <logfile>
"""

import re
import sys
import os
from datetime import datetime, timedelta

SINCE_HOURS = 10
SLOW_THRESHOLD_MS = 1000
CONSECUTIVE_THRESHOLD_MS = 500


def parse_ts(line):
    """pm2 日志行前缀: '04-18 17:06:57:' 或 '0|dashboar | MM-DD HH:MM:SS:'"""
    m = re.search(r'(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})', line)
    if not m:
        return None
    now = datetime.now()
    mm, dd, hh, mi, ss = map(int, m.groups())
    # 假设同一年（跨年边界不处理）
    return datetime(now.year, mm, dd, hh, mi, ss)


def extract_metric(line, key):
    """从 '[e2eMs=342ms, elapsedMs=318ms, ...]' 里抽取某个字段"""
    m = re.search(rf'{key}=(\d+)', line)
    return int(m.group(1)) if m else None


def percentile(sorted_arr, p):
    if not sorted_arr:
        return None
    idx = max(0, min(len(sorted_arr) - 1, int(round(len(sorted_arr) * p / 100)) - 1))
    return sorted_arr[idx]


def main():
    if len(sys.argv) < 2:
        print("Usage: poly-maker-metrics-report.py <logfile>", file=sys.stderr)
        sys.exit(1)

    log_path = sys.argv[1]
    if not os.path.exists(log_path):
        print(f"⚠️ 日志文件不存在: {log_path}")
        return

    cutoff = datetime.now() - timedelta(hours=SINCE_HOURS)

    completed = []
    failed = []

    # 兼容两种前缀行（带 "0|dashboar |" 或不带）
    reconciled_pat = re.compile(r'\[PolyMakerExecutor\] Predict hedge reconciled')
    failed_pat = re.compile(r'\[PolyMakerExecutor\] Predict hedge failed')

    with open(log_path, 'r', errors='ignore') as f:
        for line in f:
            ts = parse_ts(line)
            if not ts or ts < cutoff:
                continue

            if reconciled_pat.search(line):
                entry = {
                    'ts': ts,
                    'e2eMs': extract_metric(line, 'e2eMs'),
                    'elapsedMs': extract_metric(line, 'elapsedMs'),
                    'retries': extract_metric(line, 'retries'),
                }
                if entry['e2eMs'] is not None:
                    completed.append(entry)
            elif failed_pat.search(line):
                entry = {
                    'ts': ts,
                    'e2eMs': extract_metric(line, 'e2eMs'),
                    'retries': extract_metric(line, 'retries'),
                }
                failed.append(entry)

    total = len(completed) + len(failed)
    lines = []
    lines.append(f"<b>📊 POLY_MAKER 对冲指标（过去 {SINCE_HOURS}h）</b>")
    lines.append(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("")

    if total == 0:
        lines.append("⚠️ <b>未采集到指标</b>")
        lines.append("可能原因:")
        lines.append("• pm2 dashboard 未重启 → 新 metrics 代码未生效")
        lines.append("• 过去 10h 无 POLY_MAKER 任务运行")
        lines.append("")
        lines.append("建议: <code>pm2 restart dashboard</code> 后重新观察")
        print('\n'.join(lines))
        return

    success_rate = len(completed) / total * 100 if total > 0 else 0
    lines.append(f"样本: <b>{len(completed)}</b> 成功 / <b>{len(failed)}</b> 失败，成功率 <b>{success_rate:.1f}%</b>")

    if completed:
        e2es = sorted(x['e2eMs'] for x in completed if x['e2eMs'] is not None)
        if e2es:
            lines.append("")
            lines.append("<b>e2eMs 分布</b>")
            lines.append(f"  min: {e2es[0]}ms")
            lines.append(f"  p50: {percentile(e2es, 50)}ms")
            lines.append(f"  avg: {sum(e2es)//len(e2es)}ms")
            lines.append(f"  p95: {percentile(e2es, 95)}ms")
            lines.append(f"  max: {e2es[-1]}ms")

        slow = [x for x in completed if x['e2eMs'] and x['e2eMs'] > SLOW_THRESHOLD_MS]
        slow_pct = len(slow) / len(completed) * 100 if completed else 0
        lines.append("")
        lines.append(f"慢对冲 (>{SLOW_THRESHOLD_MS}ms): <b>{len(slow)}</b> 次 ({slow_pct:.1f}%)")

        retried = [x for x in completed if x['retries'] and x['retries'] > 0]
        retry_pct = len(retried) / len(completed) * 100 if completed else 0
        lines.append(f"有 retry: <b>{len(retried)}</b> 次 ({retry_pct:.1f}%)")

        all_events = sorted([(x['ts'], 'ok') for x in completed] + [(x['ts'], 'fail') for x in failed])
        consecutive = 0
        for i in range(1, len(all_events)):
            gap_ms = (all_events[i][0] - all_events[i - 1][0]).total_seconds() * 1000
            if 0 <= gap_ms < CONSECUTIVE_THRESHOLD_MS:
                consecutive += 1
        consec_pct = consecutive / total * 100 if total > 0 else 0
        lines.append(f"连续 fill (&lt; {CONSECUTIVE_THRESHOLD_MS}ms): <b>{consecutive}</b> 次 ({consec_pct:.1f}%)")

        # 决策建议
        lines.append("")
        lines.append("<b>任务 #5 决策建议</b>")

        p95 = percentile(e2es, 95) if e2es else 0
        avg_retry = sum(x['retries'] or 0 for x in completed) / len(completed) if completed else 0

        reasons = []
        do_it = False

        if consec_pct > 10:
            do_it = True
            reasons.append(f"• 连续 fill 占比 {consec_pct:.1f}% > 10% (强信号)")
        if p95 > 2000:
            do_it = True
            reasons.append(f"• p95 = {p95}ms > 2000ms (e2e 尾部过长)")
        if avg_retry > 1:
            do_it = True
            reasons.append(f"• 平均 retry = {avg_retry:.2f} > 1")

        if retry_pct < 5 and p95 < 1500 and consec_pct < 5:
            reasons.append(f"• retry 占比 {retry_pct:.1f}% &lt; 5%")
            reasons.append(f"• p95 = {p95}ms &lt; 1500ms")
            reasons.append(f"• 连续 fill 占比 {consec_pct:.1f}% &lt; 5%")
            lines.append("<b>🟢 暂缓做 #5</b>（收益小，改动大）")
            lines.extend(reasons)
        elif do_it:
            lines.append("<b>🟠 建议做 #5</b>")
            lines.extend(reasons)
        else:
            lines.append("<b>🟡 证据不足</b>（样本少或指标边缘）")
            lines.append(f"• 样本 {len(completed)} 次，完成率 {success_rate:.1f}%")
            lines.append(f"• p95 = {p95}ms, retry 占比 {retry_pct:.1f}%, 连续 fill {consec_pct:.1f}%")
            lines.append("• 建议多观察几天再决定")

    print('\n'.join(lines))


if __name__ == '__main__':
    main()
