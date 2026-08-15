#!/bin/bash
# SessionStart: セッション開始時点の回帰テスト状況をコンテキストに入れる。
# 依存インストールは不要（node 標準のみで動くテスト）。何もブロックしない。
set -uo pipefail

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
command -v node >/dev/null 2>&1 || exit 0

result=$("$HOOK_DIR/km-tests.sh" 2>&1)
rc=$?

case "$rc" in
  0) note="（この時点のベースラインは green）" ;;
  2) note="" ;;
  *) note="
このセッションの変更より前から失敗している可能性がある。原因を先に切り分けること。" ;;
esac

printf '%s%s' "$result" "$note" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "KoseiMarker 起動時チェック: " + s.trim(),
    },
  }));
});
'
