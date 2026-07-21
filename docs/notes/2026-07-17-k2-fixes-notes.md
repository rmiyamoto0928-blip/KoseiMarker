# KoseiMarker 2周目修正（K2-1〜K2-8）実装ノート

GPT-5.6 敵対レビュー(54点)指摘への対応。計画（依頼書）からの逸脱・判断メモのみ記す。

## 計画から変えた/補った点

- **K2-1 replaceMarkers の payload は「JSON」でなく既存のCharCode区切りを維持**。依頼書は `replaceMarkers(payloadJson,...)` と表記していたが、ExtendScript(ES3)に JSON パーサが無いため既存の CharCode(1)/(2) 区切りを踏襲。レコードに recordId フィールド（4番目）を追加した。
- **K2-2 recordId はパネル側で採番**（runId=実行時刻ms × 1000 + 連番）。host はその整数をゼロ幅符号化して name 末尾へ。ビット列は U+2060(枠)＋U+200B(0)/U+200C(1)。復号はビット演算でなく乗算（32bit溢れ回避・2^53まで正確）。
- **K2-2 「UIキーを復号IDに統一」は所有マーカーのみ適用**。非所有マーカー（旧形式・他ツール・手打ち）は ID を持たないので idx+ticks の二重キーを継続（host `_resolveMarker` が rid 空なら idx+ticks にフォールバック）。所有マーカーは exact 一致・ticksフォールバック無し。CLAUDE.md の不変条件も同内容に更新。
- **K2-3 旧形式削除は「run+clearFirst のときだけ」**。リセットボタンは従来どおり旧形式を保持（手打ち保護優先）。host `clearKoseiMarkers(expectId, includeLegacy)` の第2引数で切替。
- **K2-3 dedupe キーは frame＋comment**（TC＋本文）。既存所有マーカーの ticks を frame に丸めて比較。clearFirst=OFF のときのみ有効。
- **K2-8 seqId不能時は name一致警告でなく即中止**（依頼書の「または name一致＋警告」のうち安全側を採用）。`_seqId` が空文字を返す設計にし、replaceMarkers/clearKoseiMarkers の両方で中止。

## 検証

- `node tests/parser.test.js` → ALL PASS (79 assertions)。K2-6/K2-7/コーデックのテストを追加（赤→緑）。
- parser⇔host コーデック parity を12値・双方向で確認（大きい52bit値・旧#KMKタグnull含む）。
- host `replaceMarkers` をモックPremiere APIで検証: A)clearFirstで所有＋旧形式削除・非kosei保持 B)dedupeスキップ C)K2-4孤児削除 D)seqID不一致で無変更 E)seqID不能で中止。
- per-marker ops を同一ticks二重マーカーで検証: rid exact一致・ticksフォールバック無し・done切替でID保持。
- `node --check` で main.js / hostscript.jsx 構文OK（jsxは.jsコピーで）。

## 実機確認が必要な残点（ローカルでは確認不可）

- **ゼロ幅ID(最大~51文字の不可視文字)が Premiere のマーカー名でどう見えるか**（マーカーパネル/書き出しで幅ゼロか・コピペで壊れないか・name長制限）。
- replaceMarkers 実機での cleared/added/legacy/skipped/failed 表示。
- 旧 `​#KMK` 形式マーカーが clearFirst で「旧形式」として削除されること。
- タイムアウト30秒（callback未達）時の finish() 復帰。
