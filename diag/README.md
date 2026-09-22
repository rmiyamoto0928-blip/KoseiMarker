# テキスト取得診断（開発・調査専用）

Premiere Pro の「テキストパネル → グラフィック」に出ている**実際のテキスト本文**を、
パネルから自動取得できるかを確かめるための調査キット。

**本番の校正マーカー機能には未接続。** 取得率が確認できるまで接続しない。

---

## 0. このフォルダの位置づけ

| ファイル | 役割 | 本番への影響 |
| --- | --- | --- |
| `diag/textdiag.jsx` | ExtendScript。シーケンスを走査して診断JSONを書き出す（**読み取りのみ**） | なし |
| `diag/extract.js` | 診断JSON → 本文候補の抽出／Adobe CSV の読み取り／一致率の計算（UI非依存） | なし |
| `diag/textdiag.html` / `diag/textdiag.js` | 診断パネルのUI | なし |
| `tests/textdiag.test.js` | `textdiag.jsx` を node 上でモック実行する回帰テスト | なし |
| `tests/extract.test.js` | `extract.js` の回帰テスト | なし |

`js/parser.js` / `js/main.js` / `js/hostscript.jsx` / `index.html` は**1行も変更していない**。
変更したのは `CSXS/manifest.xml` と `.debug` への**追記のみ**（既存パネルの定義はそのまま）。

### 元に戻す

```bash
git checkout master -- CSXS/manifest.xml .debug   # 診断パネルの登録だけ取り消す
# または
git checkout master                               # 丸ごと戻す（diag/ は master に無い）
```

---

## 1. 起動

1. Premiere Pro を再起動（CEP のキャッシュが残るときは `~/Library/Caches/CSXS/cep_cache` を削除）
2. `ウィンドウ > エクステンション > 調査｜テキスト取得診断`
3. 調べたいシーケンスを開く（パネル上部にシーケンス名が出る）

DevTools が必要なときは Chrome で `localhost:7779`（本番パネルは `7778`）。

---

## 2. 手順

### ① テキスト取得診断を実行

- **最初は「走査するクリップ数の上限」を `20` にして試す。** 問題なければ `0`（上限なし）へ。
  巨大なシーケンスで `full` モードを一気に流すと時間がかかる（Premiere は固まったように見える）。
- **取得モード**
  - `full` … 全 ComponentParam の値を実際に読む（**本命。これで本文が出るかを見る**）
  - `meta` … 名前と件数だけ。値を一切読まない。最速・最安全。まず構造だけ見たいとき用
- 診断JSON がデスクトップに `KoseiMarker-textdiag-YYYYMMDD-hhmmss.json` として出る

### ② 抽出（本文候補の一覧）

診断JSONから本文候補を取り出して表で見せる。ここに**本文がちゃんと出ていれば取得は成立**。
1件も出ない場合はレポートの `rejected` と `errors` を見る（理由が必ず残っている）。

### ③ Adobe 公式出力と比較（これが合否判定）

1. Premiere の **テキストパネル → グラフィック → 右上の「…」→ CSV に書き出し**
   （TXT より **CSV を優先**。列は `Start Time / End Time / Text / Video Track / Layer ID`）
2. パネルの「CSV/TXT を選択」でそのファイルを読む
3. **一致率**、取得漏れ、余分な取得が出る

一致率の見方:

```
Adobe公式出力: 137 件
Extractor:     137 件
完全一致:      137 件
取得漏れ:        0 件
余分な取得:      0 件
→ 一致率 100%
```

比較の正規化ルール（`extract.js`）:
- 改行は既定で**区別する**（`keepNewlines: true`）。改行だけが違う場合は
  `keepNewlines: false` でも試すと「差分は改行だけ」と切り分けられる
- 全角空白→半角、前後空白、連続空白、NFD濁点、ゼロ幅文字は一致扱い
- 同じ本文が複数ある場合は**多重集合**で件数まで突き合わせる
- 1つの param から複数の本文候補が出た場合は `primary` の1件だけを数える（水増し防止）

### ④ レポート保存

`...-bundle.json`（診断＋抽出＋比較）を書き出す。**このファイルを共有すれば診断結果をそのまま引き継げる。**

---

## 3. テスト用シーケンスの作り方（STEP4/5）

**既存案件の素材は絶対に変更しない。** 新規プロジェクト or 複製したテスト用シーケンスで行う。

一意なテスト文字列 `TEXT_EXTRACT_TEST_12345` を本文に入れた Graphic を置くと、
診断が「その文字列がどの component / どの param / どの呼び出しから出たか」を
`needle.hits` に記録する。→ 本文の在り処を名前の推測なしで特定できる。

### 検証してほしい種類（STEP5）

| # | 種類 | 現状 |
| --- | --- | --- |
| A | Premiere で普通に作成したテキスト（横書き文字ツール） | ？ 未検証 |
| B | Premiere Graphic・テキスト1レイヤー | ？ 未検証 |
| C | Premiere Graphic・テキスト複数レイヤー | ？ 未検証 |
| D | Premiere 側で作成した MOGRT | ？ 未検証（`getMGTComponent()` が null を返すという報告あり） |
| E | After Effects 製 MOGRT | ？ 未検証（Adobe公式サンプルはこれを前提にしている） |
| F | AE MOGRT・テキスト複数フィールド | ？ 未検証 |
| G | 改行ありテキスト | ？ 未検証 |
| H | 日本語＋英語＋数字 | ？ 未検証 |
| I | Graphic 複製 | ？ 未検証 |
| J | 複数 Video Track | ？ 未検証 |
| K | ネスト内部 | ？ 未検証（診断は `projectItem.isSequence()` でネストを検出するが、**中には入らない**） |
| L | 無効化されている Graphic | ？ 未検証（診断は `disabled` を記録して取得は行う） |
| M | 同一 Graphic 内に複数の編集可能テキスト | ？ 未検証 |

1種類が成功しても「対応完了」にしない。**A〜M を埋めてから**本番接続を判断する。

---

## 4. 調査で確認した API（仕様と実機を分ける）

### 4-1. このプロジェクトは CEP / ExtendScript（UXP ではない）

`CSXS/manifest.xml` は `ExtensionManifest` + `CSXS 7.0` + `CSInterface.evalScript`。
つまり **CEP 拡張**であり、`premierepro`（UXP）モジュールは使えない。
ユーザー要望の「UXP API」は、このパネルからは**現状そのまま呼べない**。

### 4-2. CEP / ExtendScript 側（＝今すぐ使える経路）

ドキュメント（[Premiere Pro Scripting Guide](https://ppro-scripting.docsforadobe.dev/)）で確認できるもの:

| API | 種別 | 備考 |
| --- | --- | --- |
| `trackItem.name` | 属性 | **クリップの表示名。本文ではない** |
| `trackItem.components` | 属性 | `ComponentCollection`（`.numItems`、`[i]`） |
| `trackItem.getMatchName()` / `.matchName` | メソッド/属性 | 内部識別名 |
| `trackItem.projectItem` | 属性 | マスタークリップ。`.isSequence()` でネスト判定 |
| `trackItem.getMGTComponent()` | メソッド | **MOGRT の公開パラメータを返す** |
| `trackItem.start / end / inPoint / outPoint / duration` | 属性 | `Time`（`.ticks` / `.seconds`） |
| `trackItem.disabled` / `isAdjustmentLayer()` | 属性/メソッド | 無効クリップ・調整レイヤー判定 |
| `component.matchName` / `.displayName` / `.properties` | 属性 | `displayName` は**ローカライズされる** |
| `componentParam.displayName` | 属性 | **ローカライズされる**（`matchName` は無い） |
| `componentParam.getValue()` / `getValueAtTime()` / `setValue()` | メソッド | 同期。値の型は param 依存 |
| `app.enableQE()` | メソッド | QE DOM を有効化（**QE DOM 自体は非公式・非サポート**） |

ドキュメント未記載だが **Adobe 公式サンプル [PProPanel](https://github.com/Adobe-CEP/Samples/tree/master/PProPanel) が実際に使っているもの**
（`jsx/PPRO/Premiere.jsx` の `importMoGRT`）:

```js
var moComp = newTrackItem.getMGTComponent();
var params = moComp.properties;
for (var z = 0; z < params.numItems; z++) { var thisParam = params[z]; /* thisParam.name */ }
var srcTextParam = params.getParamForDisplayName("Source Text");  // ← 未ドキュメント
if (srcTextParam) {
    var val = srcTextParam.getValue();
    srcTextParam.setValue("New value set by PProPanel!");
}
```

→ `properties.getParamForDisplayName(name)` と `param.name` は**公式サンプルに実在する**が、
リファレンスには無い。かつ `"Source Text"` は**英語の displayName** なので、
日本語UIでは引けない可能性がある。診断は英語/日本語の両方をプローブし、
**さらに index 総当たり走査（言語非依存）も必ず行う**。

### 4-3. UXP 側（＝将来の経路。現状このパネルからは呼べない）

`@adobe/premierepro` の型定義（npm から取得。`26.5.0` = 現行安定 / `27.0.0-beta.51`）で確認:

| バージョン | 事実 |
| --- | --- |
| 26.5.0 | `ComponentParam.getValueAtTime(time): Promise<number \| string \| boolean \| PointF \| Color>` — **`string` は返り得る**が、MOGRT/Graphic 本文専用の型は無い |
| 26.5.0 | `getStartValue(): Promise<Keyframe>` のみ。**テキスト専用の型は無い** |
| 26.5.0 | `getMGTComponent()` 相当が**存在しない**（`insertMogrtFromPath` / `insertMogrtFromLibrary` のみ）。MOGRT の param は `getComponentChain()` → `Component.getParam(i)` 経由 |
| 26.5.0 | DOM に `Graphic` / `TextLayer` / `SourceText` クラスは**無い**（全68クラスを確認） |
| **27.0.0-beta** | **`MogrtText` 型が新規追加**。`getText()` / `setText()` を持つ |
| **27.0.0-beta** | `getStartValue(): Promise<Keyframe \| PointKeyframe \| Color \| MogrtText \| MogrtComment>` ＝ **公式にテキスト本文が取れる** |
| 27.0.0-beta | `getValueAtTime()` は `Promise<{value: number \| string \| boolean \| number[]}>` に**破壊的変更**。テキストは `getStartValue()` 側に寄せられた |

つまり **MOGRT テキストの正式な取得APIは Premiere 27 で入る**。26.5 では未定義（＝実機で
`getValueAtTime` が生文字列を返すかどうかを確かめるしかない）。

`ComponentParam` には UXP でも **`matchName` が無い**（`displayName` のみ）。
→ ローカライズ問題は UXP でも同じ。index 走査が基本になる。

### 4-4. Transcript（STEP8・Graphic本文とは別機能）

UXP に**正式APIが揃っている**（26.5.0 で確認）:

| API | Since | 内容 |
| --- | --- | --- |
| `Transcript.exportToJSON(clipProjectItem): Promise<string>` | 25.6 | **文字起こしを JSON 文字列で取得** |
| `Transcript.hasTranscript(clipProjectItem): boolean` | 26.3 | 文字起こしの有無 |
| `Transcript.transcribeClipProjectItem(clipProjectItem, {language})` | 25.6 | 文字起こしを実行 |
| `Transcript.querySupportedLanguages()` | 26.3 | 対応言語一覧 |
| `Transcript.importFromJSON(jsonString): TextSegments` | 25.6 | JSON から取り込み |
| JSON フォーマット仕様 | — | `uxp-premiere-pro-samples` の `sample-panels/premiere-api/assets/transcript_format_spec.json` に**公式仕様あり** |

注意: 対象は **ClipProjectItem 単位**（シーケンス単位ではない）。
シーケンス全体で見るには trackItem → projectItem のマッピングが必要。
**ExtendScript 側には同等APIが無い**＝Transcript を使うなら UXP 前提。

### 4-5. Adobe 公式の書き出し（STEP7）

- 経路: **テキストパネル → グラフィック → 「…」→ TXT / CSV に書き出し**
- 列: `Start Time`, `End Time`, `Text`, `Video Track`, `Layer ID`
- Premiere グラフィックは**エッセンシャルグラフィックのレイヤースタック順**、
  AE MOGRT は**AE で付けた Source Text ラベル**で並ぶ
- **これを起動する公式スクリプトAPIは、CEP/ExtendScript にも UXP にも見つからなかった**
  （ExtendScript に After Effects の `app.executeCommand()` 相当は無い）
- 既知の不具合報告あり: 「Text panel export CSV and TXT omit text and layer information」
  → **Adobe 公式出力自体が完全とは限らない**ので、比較時は件数の妥当性も見る

自動化を狙う場合の手段と位置づけ:

| 手段 | 公式サポート | 備考 |
| --- | --- | --- |
| UXP の正式API | — | **該当APIなし**（書き出しを起動する手段が公開されていない） |
| CEP / ExtendScript の正式API | — | **該当APIなし** |
| QE DOM（`app.enableQE()` 以降） | **非公式・非サポート** | `enableQE()` 自体はリファレンスにあるが、QE DOM の中身は無保証。バージョン間で壊れる |
| Hybrid Plugin（UXP + C++） | 公式 | [Hybrid Plugins](https://developer.adobe.com/premiere-pro/uxp/plugins/hybrid-plugins/)。実装コスト大 |
| macOS UI Automation / AppleScript | **非公式・Adobe非サポート** | メニュー構成の変更で壊れる。アクセシビリティ権限も必要 |
| 内部JSON直接編集 | **非公式・危険** | プロジェクト破損リスク。採用しない |

---

## 5. 「できない」と判断していた理由（技術的な障壁）

1. **本パネルは CEP** であり、ユーザーが想定していた UXP API（`premierepro`）は呼べない
2. **`trackItem.name` はクリップの表示名で本文ではない** — ここを本文として使うと
   「クリップ名を変えたら結果が変わる」「1クリップ複数テキストが扱えない」
3. **ComponentParam に `matchName` が無い**（CEP も UXP も）。`displayName` はローカライズされるため、
   `"Source Text"` 決め打ちは日本語UIで落ちる
4. **26.5 系の UXP にテキスト本文専用の型が無い**（`MogrtText` は 27 beta で追加）
5. **`getMGTComponent()` は AE 製 MOGRT 前提**で、Premiere 製 MOGRT では null を返すという報告がある
6. **Adobe の TXT/CSV 書き出しを起動する公式APIが存在しない**

→ ただし 2〜5 は「**index 総当たり走査＋値の型で判定**」すれば回避できる可能性がある。
それを実測するのがこの診断キット。

---

## 6. テスト

```bash
node tests/parser.test.js     # 本番パーサー（変更していないが必ず確認）
node tests/host.test.js       # 本番ホストスクリプト（同上）
node tests/textdiag.test.js   # 診断ExtendScript（モック実行）
node tests/extract.test.js    # 抽出＋CSV比較
```

`textdiag.jsx` / `extract.js` を触ったら**必ず対応するテストを実行**する（全PASSまで完了扱いにしない）。

---

## 7. 参考

- [Premiere Pro Scripting Guide（ExtendScript）](https://ppro-scripting.docsforadobe.dev/)
- [Adobe 公式 CEP サンプル PProPanel](https://github.com/Adobe-CEP/Samples/tree/master/PProPanel)
- [Premiere UXP API リファレンス](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/)
- [Adobe 公式 UXP サンプル](https://github.com/AdobeDocs/uxp-premiere-pro-samples)
- [Hybrid Plugins](https://developer.adobe.com/premiere-pro/uxp/plugins/hybrid-plugins/)
- [Export text from Motion Graphics templates（Adobe ヘルプ）](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-text-from-motion-graphics.html)

### CEP の期限（重要・別件だが無視できない）

Adobe 公式 CEP サンプルの ReadMe（2025年11月 / Premiere Pro 25.6 時点）:

> As of Premiere Pro 25.6, CEP extensions to Premiere Pro have been superseded by UXP Extensibility.
> If you are starting new development, start in UXP. CEP extensions continue to be supported;
> **the plan is to support both CEP and UXP for a calendar year, after which we will remove support for CEP extensibility.**

> *As we work toward providing UXP-based extensibility, we've stopped additional work on the ExtendScript API.*

＝ **CEP は 25.6 から約1年で打ち切り予定**。本パネル（CEP）の移行判断が別途必要。
テキスト本文の正式APIも UXP 27 側にあるため、**取得方式の選定と移行計画は分けて考える**こと。

---

## 8. ローカル追加調査（2026-09-22・本人の Mac 上で確認）

クラウド環境（Linux・Premiere 無し）では確かめられなかった点を、本人の Mac で確認した結果。

### 8-1. 実機の Premiere のバージョン

| アプリ | 版（Info.plist） |
| --- | --- |
| Adobe Premiere Pro 2026 | **26.0.2**（build 26.0.2.2） |
| Adobe Premiere Pro 2025 | 25.1 |

→ UXP の `MogrtText`（27.0 beta の型定義にだけある）は**使えない版**。今すぐ試せるのは CEP 経路。

### 8-2. sozaidrop-panel にも「誤字脱字チェック」は無い

`~/sozaidrop-panel` を `mText` / `Source Text` / `getMGTComponent` / `誤字` / `typo` で全文検索して該当ゼロ
（効果音・BGM 取り込みパネル）。インストール済みの自作パネル全部を同じ語で検索しても、
タイムラインのテキストを読んで誤字チェックする処理は見つからなかった。
→ 前提ずれ①（「クリップ名から取得する誤字チェック」は現存しない）は確定。

### 8-3. 同じ Mac の別パネルに残っていた実物の手がかり（推測ではなくコード由来）

| 出どころ | 分かっていること | 実機での状態 |
| --- | --- | --- |
| TelopStyle `jsx/hostscript.jsx` の `tsGetSelectedTexts()` | 選択クリップの「ソーステキスト」を CEP の `param.getValue()` で読むと、**文字＋装飾が入った1つの JSON 文字列**が返る（本文は `mTextParam.mStyleSheet.mText`） | 装飾の差し替えで実運用 |
| TextTransfer（`js/lib/textjson.js`） | 上と同じ JSON の `mText` だけ差し替える。MOGRT は `getMGTComponent()` の枠を読む | **MOGRT は実機で「全然変なものが入る」＝未解決**（2026-08-09） |
| TelopSkin `tools/read_project_texts.py` | `.prproj`（gzip XML）の `ソーステキスト` → `StartKeyframeValue`（base64 の FlatBuffer）から本文を直接読む | 実プロジェクト200本で**取得率 98.84%**（同じ中身は2回目から BinaryHash だけになる点を補正後。2026-07-31） |

注意：TelopSkin の説明文は「ExtendScript から読めるのはレイヤー名だけ」と書いており、TelopStyle の実運用と食い違う。
**どちらが正しいか（版・グラフィックの種類で変わるのか）を決めるのが今回の診断**。

→ STEP10 の候補 H に **「.prproj を直接読む」**を追加する（非公式の形式・Premiere を開かなくても読める・保存前の変更は反映されない・自動保存ファイルは書きかけのことがある）。

### 8-4. 診断パネルの取り付け方（本番パネルに触れない形）

本番の「チェック｜校正マーカー」は `~/KoseiMarker`（master）へのリンクで動いている。
このブランチへ切り替えると本番も切り替わり、しかも master にだけある1コミット（`8cd8eef` スマート選択）が消えて見えるため、**切り替えない**。
代わりに、別の Bundle ID の入れ物を作ってリンクした：

```
~/premiere-extensions/TextDiag/
  CSXS/manifest.xml   … Bundle ID com.ryuji.textdiag（この入れ物専用）
  diag -> ~/KoseiMarker-textdiag/diag   （このブランチの worktree）
  css  -> ~/KoseiMarker-textdiag/css
  js   -> ~/KoseiMarker-textdiag/js
~/Library/Application Support/Adobe/CEP/extensions/TextDiag -> ~/premiere-extensions/TextDiag
```

外すとき：`rm "$HOME/Library/Application Support/Adobe/CEP/extensions/TextDiag"`（リンクを消すだけ）。
あとで master に取り込むときは、このブランチを master に**マージ**する（master を巻き戻さない）。

### 8-5. 次にやること（3方式の突き合わせ）

1. 実案件のシーケンスを開いて診断パネル「①」→「④」（読み取りのみ・何も変更しない）
2. 同じシーケンスで Adobe の「テキスト → グラフィック → … → 書き出し → CSV」
3. プロジェクトを保存
4. AI が **CEP 診断 / Adobe CSV / .prproj 直読み** の3つを件数・本文・改行・トラック・時刻で突き合わせる
