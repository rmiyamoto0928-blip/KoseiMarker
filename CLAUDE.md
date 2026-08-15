# KoseiMarker — 校正マーカー（Premiere Pro CEP拡張）

校正リスト（first-cut-reviewの添削指示書 .md / typo-checkレポート表）を読み込み、Premiere Proのシーケンスマーカーを一括生成するパネル。GitHub: rmiyamoto0928-blip/KoseiMarker（2026-07-12に旧mlhkr0719-ship-itから移設）。
インストールは **シンボリックリンク方式**（`~/Library/Application Support/Adobe/CEP/extensions/KoseiMarker` → このフォルダ）。ここを直接編集すれば実機に反映される＝コピーを作らない。

## 構造と絶対に守ること

- 解析部は `js/parser.js` に分離。**js/ か tests/ を触ったら必ず `node tests/parser.test.js` と `node tests/host.test.js` の両方を実行**（回帰テスト・全PASSまで完了扱いにしない）。
- `js/hostscript.jsx`（ExtendScript側）は **ES3制約**＝const/let/アロー関数/テンプレート文字列は使えない。varとfunctionのみ。
- 所有マーカー（この拡張が作成）は **name 末尾のゼロ幅一意ID**（`js/parser.js` の encodeId/decodeId＝`js/hostscript.jsx` の `_encodeId`/`_decodeId` と厳密一致）で特定する。復号IDの完全一致必須・ticksフォールバック禁止（同一ticksの取り違え防止）。**parser側とhost側のコーデック規則を必ず一致させること**。所有判定は「センチネル構造＋シグネチャ一致＋チェックサム検証OK＋正準表現」を全て満たす場合のみ＝形だけの一致は非所有（偶然一致の誤削除防止）。ID は (runId, k) の2要素で符号化し掛け算で潰さない（衝突排除）。KMID_SIG／チェックサム式を変えたら parser.js・hostscript.jsx・tests/parser.test.js の3箇所を同時更新する。非所有マーカー（旧形式・他ツール・手打ち）だけは idx＋ticks の二重キー方式で特定する。<br>タグ構造・判定条件・変更手順の詳細は `.claude/skills/koseimarker-dev/references/zero-width-id.md`（コーデックを触るなら必読）。
- 削除と追加は host の `replaceMarkers()` に一本化（別evalScriptに分割しない）。順序は「①事前検証→②追加→③追加が全件成功したときだけ削除」（K3-1）。追加が1件でも失敗したら旧マーカーは消さない＝データ消失防止（一時的な重複は再実行で解消）。clearFirst時は旧所有マーカー＋旧形式を削除するが、今回追加分の rid は除外する。
- 微調整プリセット（30系10f/60系30f）は**秒精度タイムコードのみに適用**。フレーム/ミリ秒精度TCは補正なしが恒久仕様＝「直さない」こと。
- マーカー色の意味: 校正=赤 / ✅済=緑（済は名前に「校正✅」プレフィックス。ゼロ幅IDは末尾なのでプレフィックス操作で消えない）。

## 改修時のルール

- **改修手順の正本は `.claude/skills/koseimarker-dev`（プロジェクトスキル）**。js/ か tests/ に触る作業では最初に読む。ファイル別の必須検証・レビュー観点・実機確認はそちらに置き、このファイルには不変条件だけを残す。
- 本格改修は dev-team スキル必須（~/DECISIONS.md D3）。**ただしこれはローカル(Mac)限定**——dev-team スキルと ~/DECISIONS.md / ~/PENDING.md はリモート（Claude Code on the web）には存在しない。リモートでは代わりに `/code-review`（必要に応じて `/security-review`）＋上記スキルの検証手順を通し、判断の記録は PR 本文か `docs/notes/` に残す。
- 検証は `.claude/hooks/` が自動でも回す（起動時・js/tests 編集直後・完了前）。`node .claude/hooks/km-invariants.js` はコーデック定数の3点同期と hostscript の ES3 制約を静的に照合する。**自動チェックは保険であって、自分で走らせない理由にはならない。**
- 進捗・保留は書かない（正本は ~/PENDING.md）。このファイルには変わりにくい事実のみ書き、構造を変えたら本ファイルも同時に更新する。
