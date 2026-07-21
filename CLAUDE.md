# KoseiMarker — 校正マーカー（Premiere Pro CEP拡張）

校正リスト（first-cut-reviewの添削指示書 .md / typo-checkレポート表）を読み込み、Premiere Proのシーケンスマーカーを一括生成するパネル。GitHub: rmiyamoto0928-blip/KoseiMarker（2026-07-12に旧mlhkr0719-ship-itから移設）。
インストールは **シンボリックリンク方式**（`~/Library/Application Support/Adobe/CEP/extensions/KoseiMarker` → このフォルダ）。ここを直接編集すれば実機に反映される＝コピーを作らない。

## 構造と絶対に守ること

- 解析部は `js/parser.js` に分離。**parserを触ったら必ず `node tests/parser.test.js` を実行**（回帰テスト・全PASSまで完了扱いにしない）。
- `js/hostscript.jsx`（ExtendScript側）は **ES3制約**＝const/let/アロー関数/テンプレート文字列は使えない。varとfunctionのみ。
- 所有マーカー（この拡張が作成）は **name 末尾のゼロ幅一意ID**（`js/parser.js` の encodeId/decodeId＝`js/hostscript.jsx` の `_encodeId`/`_decodeId` と厳密一致）で特定する。復号IDの完全一致必須・ticksフォールバック禁止（同一ticksの取り違え防止）。**parser側とhost側のコーデック規則を必ず一致させること**。タグ構造＝`FRAME + 名前空間シグネチャ(KMID_SIG) + FRAME + runIdビット + FRAME + kビット + FRAME + チェックサムビット + FRAME`（枠=U+2060／0=U+200B／1=U+200C）。所有判定は「センチネル構造＋シグネチャ一致＋チェックサム検証OK＋正準表現（先頭ゼロ埋め拒否）」を全て満たす場合のみ＝形だけの一致は非所有（偶然一致の誤削除防止）。ID は (runId, k) の2要素で符号化し掛け算で潰さない（衝突排除）＝復号値は正準文字列 `"runId:k"`。KMID_SIG／チェックサム式を変えたら parser.js・hostscript.jsx・tests/parser.test.js の3箇所を同時更新する。非所有マーカー（旧形式・他ツール・手打ち）だけは idx＋ticks の二重キー方式で特定する。
- 削除と追加は host の `replaceMarkers()` に一本化（別evalScriptに分割しない）。順序は「①事前検証→②追加→③追加が全件成功したときだけ削除」（K3-1）。追加が1件でも失敗したら旧マーカーは消さない＝データ消失防止（一時的な重複は再実行で解消）。clearFirst時は旧所有マーカー＋旧形式を削除するが、今回追加分の rid は除外する。
- 微調整プリセット（30系10f/60系30f）は**秒精度タイムコードのみに適用**。フレーム/ミリ秒精度TCは補正なしが恒久仕様＝「直さない」こと。
- マーカー色の意味: 校正=赤 / ✅済=緑（済は名前に「校正✅」プレフィックス。ゼロ幅IDは末尾なのでプレフィックス操作で消えない）。

## 改修時のルール

- 本格改修は dev-team スキル必須（~/DECISIONS.md D3）。
- 進捗・保留は書かない（正本は ~/PENDING.md）。このファイルには変わりにくい事実のみ書き、構造を変えたら本ファイルも同時に更新する。
