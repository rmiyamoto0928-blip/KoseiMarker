# KoseiMarker 🔴重大バグ6件 修正ノート（2026-07-17）

クロスチェック（GPT-5.6×Claude 3ラウンド）で確定した重大バグ6件を、既存動作を壊さず最小差分で修正した。
対象実体は `/Users/miyamotoryuuji/KoseiMarker`（CEP/extensions/KoseiMarker はここへの symlink）。

## 計画からの逸脱（設計判断として選んだ点）

1. **所有権タグ（Fix2）は「名前末尾の不可視タグ」方式を採用**（comments 方式は不採用）。
   理由: comments はユーザーが setMarkerComment で上書きするためタグが消える。名前末尾なら
   setMarkerDone の接頭辞置換・setMarkerComment のどちらでも生き残る。タグは `​#KMK`
   （先頭ゼロ幅スペースで Premiere 表示上は不可視）。ソース上は生の不可視文字だと
   編集/バックアップ同期で壊れうるため **明示エスケープ `"​#KMK"`** で定数化（hostscript.jsx / main.js の2箇所を一致させる）。

2. **リセットボタン（全削除）にはシーケンスID照合を渡していない**。
   Fix3 の対象は run() 実行中の「fps/zeroPoint を取得したシーケンスと別シーケンスへ刺す」事故。
   リセットは単発の即時操作で fps 計算を伴わないため、`clearKoseiMarkers()`（引数なし＝照合スキップ）
   で従来どおり。run()／既存削除→追加の経路にだけ seqId 照合を通した。→ 実機で要確認（下記）。

3. **旧「校正」前方一致マーカーは自動削除しない**（Fix2）。
   目印タグを持つマーカーだけ削除し、旧形式は `legacy` として件数報告のみ（いきなり消さない方針）。
   本アップデート以前に作られた全マーカーは目印なし＝初回リセットでは消えない。UI/ログに
   「旧形式N件は保持・手動削除」を明示する。

## 各修正の要点

- **Fix1 校正漏れの無警告スキップ（parser.js）**: `classifyMdRow` を新設し、表行を
  record / error / ignore に3分類。TCらしきセルがあるのに修正案空・列不足・TC判別不能な行は
  errs に積む。`splitMdCells` でエスケープ `\|` をセル内リテラルとして扱い列ズレを防止。
  parseText は `stats:{mdTcRows,mdAdopted}` を返し、loadReportFile/doRun で「表TC付き行 vs 採用」を
  表示・不一致警告。`parseMdRow` は後方互換の薄いラッパとして維持。
- **Fix2 他人のマーカー削除（hostscript.jsx）**: addMarkers が名前末尾に `KMK_TAG` を付与。
  clearKoseiMarkers はタグ保持マーカーのみ削除、旧形式は legacy カウント。
- **Fix3 実行中のシーケンス切替（main.js/hostscript.jsx）**: getSeqInfo が `seqId`（sequenceID優先/名前fallback）を返す。
  run 開始時の seqId を doRun→add/clear に渡し、実行時 activeSequence と不一致なら
  「シーケンスが変わりました。もう一度実行してください」を返し無処理。
- **Fix4 非トランザクション追加（hostscript.jsx）**: addMarkers をレコード単位 try/catch。
  `{"added":N,"failed":M,"errors":[...]}` を返し、mk falsy チェックも追加。パネルは失敗件数を出し分け。
- **Fix5 同一ticksのUI取り違え（main.js）**: 各マーカーに一意キー `mk.key`（listMarkers並び順index）を付与。
  UI状態を selTicks/editTicks/confirmDelTicks → selKey/editKey/confirmDelKey へ変更（hostscript呼び出しの
  idx+ticks 二重キーは不変）。
- **Fix6 連打で重複追加（main.js）**: `busy` フラグ＋`setBusy()` で run/reset 中は runBtn/resetBtn を
  disabled。全ての完了/失敗/例外パスで setBusy(false) を呼び解除。

## テスト・検証

- `node tests/parser.test.js` → ALL PASS (48 assertions)。Fix1 用に失敗テストを先行追加（TDD赤→緑）。
- main.js / parser.js / hostscript.jsx を node --check（jsx は .js 複製）で構文OK。
- hostscript.jsx は ES3 準拠（const/let/=>/テンプレート文字列なし）を grep 確認。

## 実機（Premiere）で要確認の残点

- 所有権タグの実挙動: 追加→リセットでタグ付きだけ消え、手打ち/他ツールのマーカーが残ること。
  名前末尾のゼロ幅タグが Premiere のマーカーパネルで不可視であること。
- シーケンスID照合: `seq.sequenceID` が実機で安定値を返すか（実行中に別シーケンスへ切替→
  「シーケンスが変わりました」で無処理になるか）。返らない環境では名前fallbackで照合される。
- 同一TC複数マーカーのUI: 同じTCに2件以上ある状態で、編集/削除確認/選択ハイライトが
  片方だけに正しく効くこと。
- 部分失敗表示: addMarkers で一部失敗時に「追加N件・失敗M件」が出て、再実行で重複しないこと。
