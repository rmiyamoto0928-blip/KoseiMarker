# K5 修正（GPT-5.6 再採点97点の残 🟡1・最終5周目）実装ノート — 2026-07-17

対象: `js/hostscript.jsx` / `tests/host.test.js`

## 直した問題（唯一の残 🟡＝K5-1）

- K4-2 の旧削除は `_clearOwnedExcept(seq, keepKeys, ...)` で「今回追加分の合成キー集合（addedKeys）」を除外していた。
  集合方式は「同一キーなら保持」なので、過去マーカーと今回追加マーカーが **生name（ゼロ幅IDタグ込み）＋実 ticks まで完全一致**（runId 衝突＋本文一致＋同一フレームの三重偶然）すると、旧マーカーも同じキーで keep 判定になり **重複が残る（cleared=0）**。

## 対策（追加前スナップショット＋多重集合）

計画どおり。逸脱なし。

- **`_snapshotClearable(seq)` を新設**: 追加を始める前に、現在の所有マーカー（センチネル＋シグネチャ＋チェックサム検証OK）と旧形式（'校正'前方一致でセンチネル無し）を、`_markerKey`（生name＋実ticks）をキーに **多重集合（同一キーの件数）** として控える。
- **`_clearBySnapshot(seq, snap, includeLegacy)` を新設**（`_clearOwnedExcept` を置換）: 走査しながらスナップショットの件数を消費して照合し、**スナップショット件数分だけ削除**する。参照 `===` でなく識別データ＋件数で照合するので `getFirstMarker/getNextMarker` が走査ごとに別ラッパーを返しても安全。新規は追加前スナップショットに無いので原理的に除外される。
- **`replaceMarkers`**: `cf` のとき add ループ前に `clearSnap = _snapshotClearable(seq)` を撮る。add ループ中の `addedKeys` 記録を廃止。③は `_clearBySnapshot(seq, clearSnap, "1")` に差し替え。`if (cf && failed === 0)` のデータ保全ゲートは維持。
- 旧形式（legacy）は新規追加で作られない（新規は必ずゼロ幅IDが付く＝所有側になる）ため、スナップショット legacy 件数＝実在 legacy 件数。多重集合で件数消費しても従来の「全 legacy 削除」と同結果になり、実害・挙動変化なし。

### 「どちらの実物が残るか」について
同一キー（生name＋ticks 完全一致）の旧・新はユーザーから見て区別不能（名前・本文・位置・色すべて同一）。多重集合で「旧の件数分」消すため、物理的にどちらが残っても結果は「そのキーのマーカーが1件だけ残る」で正しい。走査順は旧が先（既存→createMarker で末尾追加）なので通常は旧が消え新が残るが、実機のマーカー順が ticks 順でも結果件数は不変。

## 検証結果（RED→GREEN 明示）

- `node tests/host.test.js` に K5-1 ケースを追加:
  - **RED（実装前・集合方式）**: 旧`校正 A`(frame10,runId1000:0)＋今回同一を clearFirst 追加 → `cleared=0` / 所有=2（両方保持）。対照（旧2件）→ `cleared=0` / 所有=3。→ 4 assertion FAIL を実測で確認。
  - **GREEN（実装後）**: `cleared=1` / 所有=1（旧1件だけ消え今回1件残存）。対照（旧2件）→ `cleared=2` / 所有=1（多重集合で件数分消費）。
  - `node tests/host.test.js` → **HOST ALL PASS（33 assertions）**（従来26＋K5-1で7増）。既存 K4-1/K4-2/K4-2対照/K4-3/K4-5 全 PASS 維持。
- `node tests/parser.test.js` → **ALL PASS（107 assertions）**（parser 無変更・回帰維持）。
- ES3 順守（hostscript.jsx に const/let/=>/テンプレート文字列なし・grep はコメント行のみ一致）。`.jsx` を `.js` コピーで `node --check` → syntax OK。`_clearOwnedExcept`/`addedKeys` の残骸なしを grep 確認。

## 実機（Premiere）残確認（前回同様・node では検証不能）

1. **ゼロ幅ID生存**: ゼロ幅IDが実機マーカー名で生存するか（生存しなければ K4-1 が発動し「追加のみ・旧保持」に安全側へ倒れる）。
2. **sequenceID 取得**: sequenceID が安定取得でき、listMarkers 応答の seqId と個別操作の照合が効くか。
3. **非同期実挙動**: 実行↔一覧更新↔シーケンス切替の競合・`_clearBySnapshot` の実 ticks 照合（createMarker 後の ticks 安定前提）。
</content>
</invoke>
