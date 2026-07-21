# K4 修正（GPT-5.6 再採点76点の残 🔴2＋🟡）実装ノート — 2026-07-17

対象: `js/parser.js` / `js/main.js` / `js/hostscript.jsx` / `tests/parser.test.js` / `tests/host.test.js`（新規）

## 計画からの逸脱・判断メモ

- **K4-2 の「identity 除外」は object === ではなく合成キー（生name＋実ticks）で実装した**。
  理由: Premiere ExtendScript の `getFirstMarker/getNextMarker` が走査ごとに別ラッパーを返す可能性があり、`===` の同一性判定が実機で安定する保証がない（node では検証不能）。
  代わりに「今回作成した実物の 生name（末尾ゼロ幅IDタグ込み）＋実 ticks」を合成キーにして除外集合を作った。これは rid 値だけの一致より厳密で、runId 衝突（パネル再ロード/時計巻き戻り）があっても旧マーカーは別フレーム＝別 ticks になり確実に区別できる。
  唯一の同一キー衝突＝「同 rid かつ同フレームかつ同名」の完全重複マーカーだけで、その場合はどちらを残しても実害がない。task 記載の「mk そのものを除外」を、より堅牢な合成キーで満たす形にした（＝逸脱として明記）。

- **K4-1 の旧削除中止は既存の `failed===0` ゲートに集約した**。idVerifyFailed は failed にも加算するので、`if (cf && failed === 0)` が既に「ID定着失敗が1件でもあれば③旧削除を走らせない」を満たす。返却に `idVerifyFailed` を追加し、main.js が専用メッセージで明示する。

- **K4-3 で listMarkers の応答形式を変更**（seqId + `CharCode(3)` + 一覧本体）。従来 loadMarkers は `getSeqInfo()`→`listMarkers()` の2 evalScript だったのを 1 呼び出しに統合し、seqId を一覧と同梱で取得。main.js に `listToken` を張り後着応答を破棄。seqId が空でも一覧は返す（個別操作は `_guardSeq` が安全に弾く）ため、リスト表示自体は維持される。run/reset/refreshSeq/applyPresetOffset の getSeqInfo 呼び出しは各自の操作用なので変更なし。

- **K4-5 は host payload の `f.length < 5` → `!== 5` のみが実変更**。parser 側のタグ復号フィールド数は既に `parts.length !== 6`（K3-4 で厳密化済）なので変更不要。テストで両者をカバー。

- **K4-4 は parser.js と hostscript.jsx の _decodeId/_parseTag に同一ロジックを追加**（安全整数上限 9007199254740991 以下＋再エンコード一致）。codec parity（node 直接比較）で両実装の一致を再確認。

## 検証結果（いずれも計画どおり・逸脱は上記のみ）

- `node tests/parser.test.js` → **ALL PASS（107 assertions）**。K4-4（2^53-1受理／2^53超はチェックサム一致でも非所有）・K4-5（余分フィールドタグ非所有）を追加。
- K4-4 の RED→GREEN を確認: K4-4 の2行を除いた旧版で over-2^53 タグが `isOwned=true`（赤）→ 適用後 `false`（緑）。
- `node tests/host.test.js`（新規・hostscript.jsx を Function で擬似実行＋marker API モック）→ **HOST ALL PASS（26 assertions）**:
  - K4-5: 余分/不足フィールド payload は中止・追加0、正規5フィールドは追加。
  - K4-1: 不可視IDが保持されない環境（name setter が ZW を除去）で added=0 / idVerifyFailed=1 / cleared=0、旧マーカー保持・定着失敗の新マーカーは除去。
  - K4-2: 旧マーカー rid=1000:0（別フレーム999）と今回 rid=1000:0（frame10）の衝突で、旧は identity 差で削除・新のみ残存（cleared=1・所有1件）。対照（衝突なし）も旧削除＋新追加が成立。
  - K4-3: listMarkers 応答が seqId + F3 + 本体、seqId 一致、レコード4フィールド、マーカー無しでも seqId 返却。
- codec parity（parser ↔ host、5 id-cases＋2^53超否定）→ PASS。
- ES3 順守（hostscript.jsx に const/let/=>/テンプレート無し）・3ファイル syntax OK（.jsx は .js コピーで `node --check`）。

## 実機（Premiere）残確認

node では検証不能。実機で要確認:
1. **K4-1 の前提**: ゼロ幅IDが Premiere 実機のマーカー名で生存するか（生存しない環境なら K4-1 が発動し「追加のみ・旧保持」に安全側で倒れる。逆に生存すれば通常どおり replace が成立）。
2. **K4-2 の identity**: runId 衝突時に旧マーカーが実 ticks 差で正しく削除され、今回分が残るか（合成キー方式なので object === に依存しないが、実 ticks が createMarker 後に安定する前提）。
3. **K4-3 の seqId**: sequenceID が安定取得でき、listMarkers 応答の seqId と個別操作の照合が期待どおり効くか。複数 loadMarkers 交錯時に後着応答が listToken で破棄されるか。
4. 非同期競合（実行↔一覧更新↔シーケンス切替）の実挙動。
