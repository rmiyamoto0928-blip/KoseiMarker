#!/bin/bash
# PostToolUse(Edit|Write): js/ か tests/ を編集した直後に回帰テスト＋不変条件チェックを走らせ、
# 結果をそのままモデルのコンテキストへ返す。ブロックはしない（改修途中の中間状態を止めないため）。
set -uo pipefail

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$HOOK_DIR/../.." && pwd)}"

payload=$(cat)
command -v node >/dev/null 2>&1 || exit 0

file=$(printf '%s' "$payload" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(s);
    process.stdout.write(String((j.tool_response && j.tool_response.filePath) || (j.tool_input && j.tool_input.file_path) || ""));
  } catch (e) { process.stdout.write(""); }
});
' 2>/dev/null)

# 監視対象は解析部・host・UI・テストのみ。ドキュメントや設定の編集では走らせない。
case "$file" in
  *js/parser.js|*js/hostscript.jsx|*js/main.js|*tests/*.test.js) ;;
  *) exit 0 ;;
esac

tests_out=$("$HOOK_DIR/km-tests.sh" 2>&1); tests_rc=$?
inv_out=$(node "$HOOK_DIR/km-invariants.js" 2>&1); inv_rc=$?

[ "$tests_rc" -eq 0 ] && [ "$inv_rc" -eq 0 ] && exit 0

printf '%s\n%s' "$tests_out" "$inv_out" | node -e '
let s = "";
process.stdin.on("data", d => s += d);
process.stdin.on("end", () => {
  const body = s.trim();
  process.stdout.write(JSON.stringify({
    systemMessage: "KoseiMarker: 回帰テスト/不変条件に問題あり",
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        "編集後の自動チェックで問題を検出した。改修途中なら続けてよいが、完了扱いにする前に必ず解消すること。\n" + body,
    },
  }));
});
'
