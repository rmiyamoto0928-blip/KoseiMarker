# K3 修正（GPT-5.6 再採点64点の未達7件）実装ノート — 2026-07-17

対象: `js/parser.js` / `js/main.js` / `js/hostscript.jsx` / `tests/parser.test.js`

## 計画からの逸脱・判断メモ

- **K3-1 と K3-6 の見かけの矛盾を層構造で解消**：K3-1 は「不正rid→中止（何も変更しない）」、K3-6 は「不正rid→該当レコードfailed」と方向が違う。
  一次ゲート＝事前検証（K3-1）を権威とし、payload に不正rid/frame/フィールド不足があれば削除も追加もせず中止エラーを返す。
  K3-6 の failed 経路は「万一 encode 段まで不正値が届いた場合」の多重防御（encodeId が例外→add ループの try/catch で failed 計上）として残した。
  通常フロー（UI 発番）では事前検証を必ず通過するので中止は発生しない。この解釈を採用した理由を明記して逸脱扱いとする。

- **ID の型が number → 正準文字列 `"runId:k"` に変わった**（K3-5）。掛け算 `runId*1000+k` を廃し (runId,k) を別ビットフィールドで符号化。
  これに伴い decodeId の戻り値・UIキー・host の `_findMarkerById` 比較・payload フィールド（f[3]=runId, f[4]=k）を一括変更。既存の K2-2 コーデックテストは新APIへ全面書き換え。

- **codec 構造を刷新**（K3-4）：`FRAME + SIG + FRAME + runIdBits + FRAME + kBits + FRAME + checksumBits + FRAME`。
  所有判定＝センチネル＋シグネチャ一致＋チェックサム一致＋正準（先頭ゼロ埋め拒否）を全て満たす場合のみ。KMID_SIG=`11001010111100001101`、checksum=`(runId%P*31 + k%P*17 + 12345)%P`（P=1000003・積が2^53未満）。
  末尾の最大ゼロ幅ランを切り出し `split(FRAME)` で6分割して検証（曖昧な複数表現を排除）。

- **runId を単調増加化**（K3-5）：`nextRunId()` が `Date.now()` 同値時に +1。同一ミリ秒2連打でも実行間衝突しない。

- **replaceMarkers の順序変更**（K3-1）：旧「clear→add」を「検証→add→（failed===0のときだけ）clear」に。返却を `cleared/oldCleared/added/failed` に統一（旧 `legacy`→`oldCleared`。リセット用 clearKoseiMarkers は従来どおり `legacy` を返す）。

- **seqId 厳格化**（K3-2）：`_seqId` は name フォールバック廃止（sequenceID のみ）。ガードを `if (!expectId || 不一致)` に（空 expectId 素通り防止）。main は run/reset で seqId 空を先に弾く。

- **runToken 後着無効化**（K3-3）：run/reset 開始で runToken++＆捕捉、全 callback 冒頭で `if(myToken!==runToken) return;`。30秒タイムアウト発火時も runToken++ してから finish。

- **個別操作の seq 照合**（K3-7）：loadMarkers 時に listSeqId を保持し、編集/削除/済切替は expectSeqId を host に渡して `_guardSeq` で照合。不一致は「シーケンスが変わりました。一覧を更新してください」。

## 検証結果

- `node tests/parser.test.js` → ALL PASS（101 assertions。K3-4/5/6 のコーデック署名・衝突・検証・safeNonNegInt テスト含む）
- parser.js ↔ hostscript.jsx コーデック parity（node vm 直接比較）→ PASS（encode バイト一致・decode 値一致・否定ケース一致・safeNonNegInt 一致、9 id-cases）
- host ロジック擬似実行（モック marker API）→ replaceMarkers の順序・消失防止・事前検証中止・seqId 照合・dedup、個別操作の seq ガード＆rid解決 全 PASS
- ES3 順守（const/let/=>/テンプレート無し）・3ファイル `node --check` 構文OK

## 実機（Premiere）残確認

node では検証不能な以下は実機で要確認：
1. ゼロ幅IDタグが Premiere のマーカー名UI上で完全不可視か（表示・検索に混入しないか）
2. sequenceID がこの環境で安定取得できるか（K3-2 で name フォールバックを廃止したため、取得不能だと実行/リセットが中止になる）
3. 実行→別シーケンスへ切替→旧応答が後着した際に doRun/clear が走らないか（K3-3）
4. clearFirst で追加が途中失敗したとき旧マーカーが残る（消失しない）実挙動（K3-1）
