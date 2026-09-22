// ============================================================================
// KoseiMarker / テキスト取得診断パネル（開発・調査専用）
//
//  ① diag/textdiag.jsx を evalScript で走らせ、診断JSONをディスクへ書き出す
//  ② 書き出した診断JSONを読み戻し、diag/extract.js で「本文候補」を抽出して一覧表示
//  ③ Adobe「テキスト → グラフィック → 書き出し」のCSV/TXTを読み込んで一致率を出す
//  ④ 診断＋抽出＋比較をまとめたレポートを保存（そのまま共有できる）
//
// ※ 本番パネル（index.html / js/main.js / js/hostscript.jsx）には一切触らない。
// ============================================================================
(function () {
    'use strict';
    var cs = new CSInterface();
    var host = null;              // diag/textdiag.jsx のソース
    var lastDiagPath = '';        // 直近の診断JSONのパス
    var lastReport = null;        // 診断JSON（パース済み）
    var lastExtract = null;       // 抽出結果
    var lastCompare = null;       // 比較結果
    var busy = false;

    var $ = function (id) { return document.getElementById(id); };
    var seqNameEl = $('seqName'), resultEl = $('result'), logEl = $('log');

    function log(msg) {
        var t = new Date().toTimeString().slice(0, 8);
        logEl.textContent += '[' + t + '] ' + msg + '\n';
        logEl.scrollTop = logEl.scrollHeight;
    }
    function showOk(t) { resultEl.className = 'result ok'; resultEl.textContent = t; log('OK: ' + t); }
    function showErr(t) { resultEl.className = 'result err'; resultEl.textContent = t; log('ERR: ' + t); }

    // evalScript に渡す文字列のエスケープ（U+2028/2029 は行終端子扱いになるため必須）
    function escJS(s) {
        return String(s)
            .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
            .replace(/\r/g, '\\r').replace(/\n/g, '\\n')
            .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    }
    function evalHost(call, cb) {
        if (!host) { showErr('診断ホストスクリプト未ロード'); return; }
        cs.evalScript(host + ';\n' + call, cb);
    }
    function esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function fsOk() {
        if (!window.cep || !window.cep.fs) { showErr('この環境ではファイル入出力が使えません（CEPのcep.fsが無い）'); return false; }
        return true;
    }
    function utf8() {
        return (window.cep.encoding && window.cep.encoding.UTF8) ? window.cep.encoding.UTF8 : 'UTF-8';
    }

    // ---- 診断ホストスクリプトの読み込み ----
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'textdiag.jsx', true);
    xhr.onload = function () {
        if (xhr.status === 200 || xhr.status === 0) { host = xhr.responseText; log('診断ホストスクリプト ロード完了'); refreshSeq(); }
        else { showErr('textdiag.jsx ロード失敗 (status=' + xhr.status + ')'); }
    };
    xhr.onerror = function () { showErr('textdiag.jsx 読み込みエラー'); };
    xhr.send();

    function refreshSeq() {
        // 本番の hostscript は読み込まないので、シーケンス名は診断側で最小限取得する
        evalHost('(function(){var s=app.project.activeSequence; return s? String(s.name) : "";})()', function (res) {
            seqNameEl.textContent = (res && res !== 'EvalScript error.') ? res : '—';
        });
    }

    // ---------------------------------------------------------------- ① 診断実行
    function run() {
        if (busy) { return; }
        if (!host) { showErr('診断ホストスクリプト未ロード'); return; }
        busy = true; $('runBtn').disabled = true;
        var needle = $('needle').value;
        var maxClips = parseInt($('maxClips').value, 10) || 0;
        var mode = $('valueMode').value;
        log('--- 診断実行 (needle="' + needle + '" maxClips=' + maxClips + ' mode=' + mode + ') ---');
        var call = "kmDiagRun('','" + escJS(needle) + "','" + maxClips + "','" + mode + "')";
        var to = setTimeout(function () {
            if (busy) { busy = false; $('runBtn').disabled = false; showErr('タイムアウト（120秒応答なし）。クリップ数上限を小さくして再試行してください。'); }
        }, 120000);
        evalHost(call, function (res) {
            clearTimeout(to);
            busy = false; $('runBtn').disabled = false;
            log('kmDiagRun → ' + String(res).slice(0, 600));
            var d;
            try { d = JSON.parse(res); }
            catch (e) { showErr('診断: 応答をJSONとして読めませんでした\n' + String(res).slice(0, 800)); return; }
            if (d.error) { showErr(d.error); return; }
            if (!d.wrote) { showErr('レポートを書き出せませんでした: ' + (d.writeError || '理由不明') + '\n' + d.path); return; }
            lastDiagPath = d.path;
            var msg = 'Videoトラック ' + d.videoTrackCount + ' 本 / クリップ ' + d.scannedClips + '/' + d.totalClips +
                      ' 件を走査しました。\n' + Math.round(d.bytesApprox / 1024) + ' KB のレポートを書き出しました:\n' + d.path;
            if (d.needleHits > 0) { msg += '\n★ テスト文字列を ' + d.needleHits + ' 箇所で検出しました（レポートの needle.hits を参照）'; }
            else if ($('needle').value) { msg += '\n※ テスト文字列は見つかりませんでした'; }
            if (d.errorCount > 0) { msg += '\n⚠️ 走査エラー ' + d.errorCount + ' 件（レポートの errors を参照）'; }
            if (d.truncated) { msg += '\n⚠️ 上限に達して打ち切りました（レポートは不完全）'; }
            showOk(msg);
            preview(); // そのまま抽出まで進める
        });
    }

    // ---------------------------------------------------------------- ② 抽出プレビュー
    function preview() {
        if (!lastDiagPath) { showErr('先に「① テキスト取得診断を実行」を押してください'); return; }
        if (!fsOk()) { return; }
        var r = window.cep.fs.readFile(lastDiagPath, utf8());
        if (r.err !== 0) { showErr('診断JSONを読めませんでした (err=' + r.err + ')\n' + lastDiagPath); return; }
        try { lastReport = JSON.parse(r.data); }
        catch (e) { showErr('診断JSONのパースに失敗: ' + e.message); return; }

        lastExtract = KMTextExtract.extract(lastReport);
        if (lastExtract.error) { showErr(lastExtract.error); return; }
        var dg = lastExtract.diagnostics;
        var s = '<b>抽出できた本文:</b> ' + dg.textCount + ' 件 ／ <b>本文を持つクリップ:</b> ' + dg.clipsWithText +
                ' 件（走査 ' + dg.scannedClips + '/' + dg.totalClips + '）<br>' +
                '<b>Premiere:</b> ' + (dg.appVersion || '不明') + ' ／ <b>UIロケール:</b> ' + (dg.hostLocale || '不明') +
                ' ／ <b>取得モード:</b> ' + (dg.valueMode || '-') + '<br>' +
                '<b>無効クリップ:</b> ' + dg.disabledClipsWithText + ' 件 ／ <b>ネスト:</b> ' + dg.nestedSequenceClips +
                ' 件 ／ <b>除外(理由付き):</b> ' + lastExtract.rejected.length + ' 件';
        if (dg.truncated) { s += '<br><span class="badc">⚠️ レポートが打ち切られています</span>'; }
        $('previewSummary').innerHTML = s;

        var h = '<table class="tbl"><tr><th>開始</th><th>V</th><th>種別</th><th>本文</th><th>由来</th></tr>';
        var g = lastExtract.graphics;
        for (var i = 0; i < g.length; i++) {
            for (var t = 0; t < g[i].texts.length; t++) {
                var tx = g[i].texts[t];
                if (tx.primary === false) { continue; } // 副候補はプレビューでは畳む
                var flags = (g[i].disabled ? ' 🚫無効' : '') + (g[i].isNestedSequence ? ' 📦ネスト' : '');
                h += '<tr><td>' + esc(fmtSec(g[i].start.seconds)) + '</td>' +
                     '<td>' + esc(g[i].trackLabel) + '</td>' +
                     '<td>' + esc(g[i].type) + flags + '</td>' +
                     '<td>' + esc(tx.text).replace(/\n/g, '<br>') + (tx.truncated ? ' <span class="badc">…(切り詰め)</span>' : '') + '</td>' +
                     '<td class="mono">' + esc((tx.paramDisplayName || '') + ' / ' + tx.via) + '</td></tr>';
            }
        }
        h += '</table>';
        if (!g.length) { h = '<div class="empty">本文候補が1件も取れませんでした。レポートの rejected / errors を確認してください。</div>'; }
        $('previewBox').innerHTML = h;
        log('抽出: ' + dg.textCount + ' 件（クリップ ' + dg.clipsWithText + ' 件）');
    }

    function fmtSec(sec) {
        if (!isFinite(sec) || sec < 0) { return '-'; }
        var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
        function z(n) { return (n < 10 ? '0' : '') + n; }
        return (h > 0 ? h + ':' + z(m) : m + '') + ':' + z(s);
    }

    // ---------------------------------------------------------------- ③ Adobe CSV と比較
    function loadCsv() {
        if (!lastExtract) { showErr('先に「② 抽出」まで進めてください'); return; }
        if (!fsOk()) { return; }
        var dlg = window.cep.fs.showOpenDialogEx(false, false,
            'Adobe「テキスト→グラフィック→書き出し」のCSV/TXTを選択', '', ['csv', 'txt']);
        if (!dlg || !dlg.data || !dlg.data.length) { return; }
        var p = dlg.data[0];
        var r = window.cep.fs.readFile(p, utf8());
        if (r.err !== 0) { showErr('CSV/TXT を読めませんでした (err=' + r.err + ')\n' + p); return; }

        var adobe = KMTextExtract.parseAdobeCsv(r.data);
        lastCompare = KMTextExtract.compare(lastExtract, adobe);
        lastCompare.sourceFile = p;
        var c = lastCompare;
        var cls = c.coveragePercent >= 100 ? 'okc' : (c.coveragePercent >= 80 ? 'midc' : 'badc');
        var s = '<div class="big ' + cls + '">一致率 ' + c.coveragePercent + '%</div>' +
                'Adobe公式出力: <b>' + c.adobeCount + '</b> 件<br>' +
                'Extractor: <b>' + c.extractCount + '</b> 件<br>' +
                '完全一致: <b>' + c.exactMatches + '</b> 件<br>' +
                '取得漏れ: <b class="' + (c.missingCount ? 'badc' : 'okc') + '">' + c.missingCount + '</b> 件<br>' +
                '余分な取得: <b class="' + (c.extraCount ? 'midc' : 'okc') + '">' + c.extraCount + '</b> 件<br>' +
                '<span class="mono">' + esc(p) + '</span>';
        for (var w = 0; w < c.warnings.length; w++) { s += '<br><span class="midc">⚠️ ' + esc(c.warnings[w]) + '</span>'; }
        $('cmpSummary').innerHTML = s;

        var h = '';
        if (c.missing.length) {
            h += '<table class="tbl"><tr><th colspan="3">取得漏れ（Adobeにあって取れなかった）</th></tr>';
            for (var i = 0; i < c.missing.length; i++) {
                h += '<tr><td>' + esc(c.missing[i].start) + '</td><td>' + esc(c.missing[i].track) + '</td><td>' +
                     esc(c.missing[i].text).replace(/\n/g, '<br>') + '</td></tr>';
            }
            h += '</table>';
        }
        if (c.extra.length) {
            h += '<table class="tbl"><tr><th colspan="3">余分な取得（Adobeに無いのに取れた）</th></tr>';
            for (var j = 0; j < c.extra.length; j++) {
                h += '<tr><td>' + esc(fmtSec(c.extra[j].startSeconds)) + '</td><td>' + esc(c.extra[j].trackLabel) + '</td><td>' +
                     esc(c.extra[j].text).replace(/\n/g, '<br>') + '</td></tr>';
            }
            h += '</table>';
        }
        if (!h) { h = '<div class="empty">差分なし（Adobe公式出力と完全一致）</div>'; }
        $('cmpBox').innerHTML = h;
        log('比較: Adobe ' + c.adobeCount + ' / 抽出 ' + c.extractCount + ' / 一致 ' + c.exactMatches +
            ' / 漏れ ' + c.missingCount + ' / 余分 ' + c.extraCount + ' → ' + c.coveragePercent + '%');
    }

    // ---------------------------------------------------------------- ④ レポート保存
    function saveReport() {
        if (!lastExtract) { showErr('先に「② 抽出」まで進めてください'); return; }
        if (!fsOk()) { return; }
        var bundle = {
            schema: 'koseimarker.textdiag.bundle/1',
            generatedAt: new Date().toISOString(),
            diagPath: lastDiagPath,
            extract: lastExtract,
            compare: lastCompare
        };
        var out = lastDiagPath.replace(/\.json$/, '') + '-bundle.json';
        var w = window.cep.fs.writeFile(out, JSON.stringify(bundle, null, 2), utf8());
        if (w.err !== 0) { showErr('レポート保存に失敗 (err=' + w.err + ')\n' + out); return; }
        showOk('レポートを保存しました:\n' + out + '\n（このファイルをそのまま共有すれば診断結果を引き継げます）');
    }

    $('runBtn').addEventListener('click', run);
    $('previewBtn').addEventListener('click', preview);
    $('csvBtn').addEventListener('click', loadCsv);
    $('saveBtn').addEventListener('click', saveReport);
    $('seqRefresh').addEventListener('click', refreshSeq);
    $('logClear').addEventListener('click', function () { logEl.textContent = ''; });
})();
