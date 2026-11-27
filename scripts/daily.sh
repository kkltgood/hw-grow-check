#!/bin/bash
#
# 每天定时任务：先扫码登录，再签到，最后发一封结果邮件。
#
# 周末例外：人不在电脑前，弹扫码窗口只会空等 10 分钟。所以周六周日不弹窗，
# 改成「静默试一次签到」——登录态如果还在就顺手签上，签不上就发一封
# 「请用手机补签」的提醒邮件，不制造一个看起来像故障的失败。
#
# 流程：
#   工作日：① 弹有头浏览器等你扫码（最长 10 分钟）② 登录成功即签到 ③ 发结果邮件
#   周末：  ① 无头静默跑一次签到 ② 成功发成功邮件；失败发手机补签提醒
#
# 退出码：0 成功 / 1 扫码超时 / 2 签到失败 / 3 登录异常 / 4 周末已发补签提醒
# GROW_QUIET_MAIL=1 让 cli.mjs 内部的告警不发邮件，避免重复发信。
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
NODE="$(command -v node || echo /usr/local/bin/node)"

export GROW_QUIET_MAIL=1

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

notify() {
  /usr/bin/osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1 || true
}

send_result() {
  # $1 = --ok / --fail / --remind，其余参数原样传给 mail-result
  "$NODE" src/mail-result.mjs "$@" 2>&1 | sed 's/^/  /'
}

# 允许手动强制周末模式，用于测试：bash scripts/daily.sh --weekend
FORCE_WEEKEND=0
[ "${1:-}" = "--weekend" ] && FORCE_WEEKEND=1
DOW=$(date +%u) # 1=周一 … 6=周六 7=周日

if [ "$FORCE_WEEKEND" -eq 1 ] || [ "$DOW" -ge 6 ]; then
  log "=== 开始（周末模式：不弹扫码窗口）==="
  notify "周末签到" "先静默试一次，签不上会发邮件提醒你手机补"

  OUT="$("$NODE" src/cli.mjs run 2>&1)"
  CODE=$?
  echo "$OUT"

  if [ "$CODE" -eq 0 ]; then
    send_result --ok
    notify "周末签到成功" "$(echo "$OUT" | grep -E '积分' | tail -1)"
    log "=== 结束（周末自动签上）==="
    exit 0
  fi

  send_result --remind --code "$CODE" --reason "登录态已失效，周末不弹扫码窗口；今天需要在手机上补签"
  notify "周末需要手机补签" "打开成长中心点一下签到即可"
  log "=== 结束（周末未签上，已发补签提醒）==="
  exit 4
fi

log "=== 开始（扫码登录）==="
notify "请扫码登录华为云" "浏览器已打开，10 分钟内扫码，扫完自动签到"

"$NODE" src/cli.mjs login 2>&1
LOGIN=$?

if [ "$LOGIN" -ne 0 ]; then
  log "登录未完成（退出码 ${LOGIN}），跳过签到"
  send_result --fail --code "$LOGIN" --reason "等了 10 分钟没有完成扫码登录，今天还没签上"
  notify "没有扫码" "今天未签到，可手动执行 scripts/daily.sh"
  log "=== 结束（未登录）==="
  exit "$LOGIN"
fi

log "登录成功，开始签到"
OUT="$("$NODE" src/cli.mjs run 2>&1)"
CODE=$?
echo "$OUT"

if [ "$CODE" -eq 0 ]; then
  send_result --ok
  notify "每日签到完成" "$(echo "$OUT" | grep -E '积分' | tail -1)"
  log "=== 结束（成功）==="
  exit 0
fi

send_result --fail --code "$CODE" --reason "登录正常，但签到或任务没跑完（详见日志）"
# 退出码 2 既可能是签到没成，也可能只是某个加分任务没跑完 —— 结论分开写，
# 否则日志里一句「签到失败」会让人以为这 10 分没拿到（11-26、11-27 都被误读过）。
if echo "$OUT" | grep -qE "签到：(签到成功|今日已签到)"; then
  notify "签到完成，另有任务没跑完" "邮件里有具体是哪一项"
  log "=== 结束（签到成功，另有任务没完成）==="
else
  notify "今天没签上" "邮件里有原因和补救方法"
  log "=== 结束（签到失败）==="
fi
exit "$CODE"
