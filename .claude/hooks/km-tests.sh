#!/bin/bash
# 校正マーカーの回帰テスト共通ランナー（parser + host の両方を必ず走らせる）。
# 出力: 1行サマリ＋失敗時のみ詳細。
# 終了コード: 0=全PASS / 1=失敗あり / 2=実行できず（node が無い等）
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}" || exit 2

if ! command -v node >/dev/null 2>&1; then
  echo "node が見つからないため回帰テストを実行できませんでした"
  exit 2
fi

out_parser=$(node tests/parser.test.js 2>&1); rc_parser=$?
out_host=$(node tests/host.test.js 2>&1); rc_host=$?

if [ "$rc_parser" -eq 0 ] && [ "$rc_host" -eq 0 ]; then
  echo "回帰テスト全PASS: $(printf '%s' "$out_parser" | tail -1) / $(printf '%s' "$out_host" | tail -1)"
  exit 0
fi

echo "回帰テスト失敗（parser=$rc_parser host=$rc_host）"
[ "$rc_parser" -ne 0 ] && { echo "--- tests/parser.test.js ---"; printf '%s\n' "$out_parser" | tail -20; }
[ "$rc_host" -ne 0 ] && { echo "--- tests/host.test.js ---"; printf '%s\n' "$out_host" | tail -20; }
exit 1
