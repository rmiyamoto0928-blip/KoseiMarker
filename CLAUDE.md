# KoseiMarker — 校正マーカー（Premiere Pro CEP拡張）

校正リスト（first-cut-reviewの添削指示書 .md / typo-checkレポート表）を読み込み、Premiere Proのシーケンスマーカーを一括生成するパネル。GitHub: mlhkr0719-ship-it/KoseiMarker。
インストールは **シンボリックリンク方式**（`~/Library/Application Support/Adobe/CEP/extensions/KoseiMarker` → このフォルダ）。ここを直接編集すれば実機に反映される＝コピーを作らない。

## 構造と絶対に守ること

- 解析部は `js/parser.js` に分離。**parserを触ったら必ず `node tests/parser.test.js` を実行**（回帰テスト・全PASSまで完了扱いにしない）。
- `js/hostscript.jsx`（ExtendScript側）は **ES3制約**＝const/let/アロー関数/テンプレート文字列は使えない。varとfunctionのみ。
- マーカーの特定は idx＋ticks の二重キー方式を崩さない（片方だけにすると別マーカーを誤操作する）。
- 微調整プリセット（30系10f/60系30f）は**秒精度タイムコードのみに適用**。フレーム/ミリ秒精度TCは補正なしが恒久仕様＝「直さない」こと。
- マーカー色の意味: 校正=赤 / ✅済=緑（済は名前に「校正✅」プレフィックス）。

## 改修時のルール

- 本格改修は dev-team スキル必須（~/DECISIONS.md D3）。
- 進捗・保留は書かない（正本は ~/PENDING.md）。このファイルには変わりにくい事実のみ書き、構造を変えたら本ファイルも同時に更新する。
