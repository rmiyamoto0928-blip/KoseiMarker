# KoseiMarker（校正マーカー）MAP

詳しい決まりは CLAUDE.md（こちらが正本）。ここは「どこに何があるか」だけ。

## ファイル構成
- index.html … 画面（ボタン・一覧の枠）
- css/style.css … 見た目（:root 無し・色は直書き）
- css/smartselect.css … 共通部品の写し（直接触らない。元は ~/premiere-extensions/shared/smartselect.css）
- js/main.js … 画面の動き／js/parser.js … 校正リストの解析
- js/hostscript.jsx … Premiere 側（ES3）／js/CSInterface.js・smartselect.js … 部品
- CSXS/manifest.xml … パネルの登録
- tests/parser.test.js・tests/host.test.js … 回帰テスト

## 色を決めている所（css/style.css・ドラゴンズブルー 2026-10-10）
- .primary（「マーカーを追加」＝1画面1個の実行ボタン）… 金 #F5C400／字 #10203A／hover #FFD84D
- .filt.active（絞り込みの選択中）… 紺 #00418E＋線 #5E9FE8
- .mitem:hover … rgba(94,159,232,0.22)／.mitem.sel … #173457＋線 #5E9FE8
- .cedit の枠 … #5E9FE8
- 残している色：赤（.danger・校正）・緑（済・ok）・灰、.mname #7fb3e0・.act.save #8fc7ff
- 決まり書＝~/premiere-extensions/shared/dragons-palette.md

## テストの流し方
```
node ~/KoseiMarker/tests/parser.test.js
node ~/KoseiMarker/tests/host.test.js
```
