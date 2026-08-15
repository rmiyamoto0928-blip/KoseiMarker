#!/bin/bash
# Stop: js/ か tests/ に未コミットの変更がある状態で回帰テストが落ちていたら、完了させずに差し戻す。
# CLAUDE.md の「全PASSまで完了扱いにしない」を仕組み側で担保する。
# 同じ失敗内容で2回続けて止めることはしない（直せない状況で無限ループしないための保険）。
set -uo pipefail

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$HOOK_DIR/../.." && pwd)}"
STATE="$ROOT/.claude/.km-stop-state"

cd "$ROOT" || exit 0
command -v node >/dev/null 2>&1 || exit 0

# 対象ファイルに変更が無いセッションでは何もしない
if ! git status --porcelain -- js tests 2>/dev/null | grep -q .; then
  rm -f "$STATE"
  exit 0
fi

tests_out=$("$HOOK_DIR/km-tests.sh" 2>&1); tests_rc=$?
inv_out=$(node "$HOOK_DIR/km-invariants.js" 2>&1); inv_rc=$?

if [ "$tests_rc" -eq 0 ] && [ "$inv_rc" -eq 0 ]; then
  rm -f "$STATE"
  exit 0
fi

current=$(printf '%s\n%s' "$tests_out" "$inv_out")

# 直前の Stop と同じ失敗内容なら、もう止めずに通す（警告だけ出す）
if [ -f "$STATE" ] && [ "$current" = "$(cat "$STATE")" ]; then
  rm -f "$STATE"
  printf '%s' "$current" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    systemMessage: "KoseiMarker: 回帰テストが失敗したままです（2回目のため停止はしません）\n" + s.trim(),
  }));
});
'
  exit 0
fi

printf '%s' "$current" > "$STATE"
printf '%s' "$current" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason:
      "js/ または tests/ に変更があるのに回帰テスト（または不変条件チェック）が通っていない。" +
      "CLAUDE.md の規約どおり、全PASSにしてから完了すること。直せない理由がある場合は、何がなぜ落ちているかを明示して報告すること。\n" + s.trim(),
  }));
});
'
