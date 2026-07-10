(function () {
    var cs = new CSInterface();
    var host = null;

    var seqNameEl = document.getElementById('seqName');
    var seqRefresh = document.getElementById('seqRefresh');
    var fpsSel = document.getElementById('fps');
    var dataEl = document.getElementById('data');
    var dataClear = document.getElementById('dataClear');
    var loadFileBtn = document.getElementById('loadFile');
    var offsetEl = document.getElementById('offset');
    var clearEl = document.getElementById('clearFirst');
    var runBtn = document.getElementById('runBtn');
    var resetBtn = document.getElementById('resetBtn');
    var resultEl = document.getElementById('result');
    var logEl = document.getElementById('log');
    var logClear = document.getElementById('logClear');
    var listRefresh = document.getElementById('listRefresh');
    var markerListEl = document.getElementById('markerList');
    var countsEl = document.getElementById('counts');
    var searchEl = document.getElementById('search');
    var filtBtns = document.querySelectorAll('.filt');

    var curFilter = 'all';
    var allMarkers = [];
    var selTicks = null;      // 選択中（ハイライト）
    var editTicks = null;     // コメント編集中
    var editDraft = null;     // 編集中の未保存テキスト（再描画されても消さない）
    var confirmDelTicks = null; // 削除確認中（2タップ式）

    // evalScript に渡す文字列のエスケープ（U+2028/2029 は行終端子扱いになるため必須）
    function escJS(s) {
        return String(s)
            .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
            .replace(/\r/g, '\\r').replace(/\n/g, '\\n')
            .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    }

    // 検索用の正規化（macOSのNFD濁点分解を吸収）
    function norm(s) {
        s = String(s).toLowerCase();
        return s.normalize ? s.normalize('NFC') : s;
    }

    function log(msg) {
        var t = new Date().toTimeString().slice(0, 8);
        logEl.textContent += '[' + t + '] ' + msg + '\n';
        logEl.scrollTop = logEl.scrollHeight;
    }
    logClear.addEventListener('click', function () { logEl.textContent = ''; });

    // hostscript.jsx を読み込み
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'js/hostscript.jsx', true);
    xhr.onload = function () {
        if (xhr.status === 200 || xhr.status === 0) { host = xhr.responseText; log('hostscript ロード完了'); refreshSeq(); loadMarkers(); applyPresetOffset(); }
        else { showErr('hostscript.jsx ロード失敗'); }
    };
    xhr.onerror = function () { showErr('hostscript.jsx 読み込みエラー'); };
    xhr.send();

    // フレームレート別の微調整プリセット（秒精度TC用：30/29.97系→10、59.94/60系→30、他→0）
    // 秒精度のTC（0:34等）は秒の頭に刺さるため、テロップ表示の中心に寄せる補正。
    // フレーム/ミリ秒精度のTCには適用しない（parse側で除外）。
    function presetOffset(nominal) {
        if (nominal === 30) { return 10; }
        if (nominal === 60) { return 30; }
        return 0;
    }

    function applyPresetOffset() {
        var mode = fpsSel.value;
        if (mode === 'auto') {
            if (!host) { return; }
            evalHost('getSeqInfo()', function (res) {
                var d = {};
                try { d = JSON.parse(res); } catch (e) { return; }
                if (d.error || !d.fps) { return; }
                var nom = Math.round(d.fps);
                offsetEl.value = presetOffset(nom);
                log('自動fps=' + d.fps.toFixed(2) + ' → 秒精度TC微調整 ' + offsetEl.value + 'f をセット');
            });
        } else {
            var conf = fpsConf(mode);
            offsetEl.value = presetOffset(conf.nominal);
            log(mode + ' → 秒精度TC微調整 ' + offsetEl.value + 'f をセット');
        }
    }

    fpsSel.addEventListener('change', applyPresetOffset);

    seqRefresh.addEventListener('click', function () { refreshSeq(); loadMarkers(); applyPresetOffset(); });
    runBtn.addEventListener('click', run);
    resetBtn.addEventListener('click', resetMarkers);
    listRefresh.addEventListener('click', loadMarkers);
    dataClear.addEventListener('click', function () { dataEl.value = ''; dataEl.focus(); });
    loadFileBtn.addEventListener('click', loadReportFile);
    searchEl.addEventListener('input', function () { confirmDelTicks = null; renderList(); });

    for (var b = 0; b < filtBtns.length; b++) {
        (function (btn) {
            btn.addEventListener('click', function () {
                curFilter = btn.getAttribute('data-filter');
                for (var j = 0; j < filtBtns.length; j++) { filtBtns[j].className = 'filt'; }
                btn.className = 'filt active';
                confirmDelTicks = null;
                renderList();
            });
        })(filtBtns[b]);
    }

    // ---- 指示書/レポートのファイル読込（S2） ----
    function loadReportFile() {
        if (!window.cep || !window.cep.fs) { showErr('この環境ではファイル読込を使えません（貼り付けをご利用ください）'); return; }
        var dlg = window.cep.fs.showOpenDialogEx(false, false, '添削指示書 / 校正レポートを選択', '', ['md', 'txt']);
        if (!dlg || !dlg.data || !dlg.data.length) { return; }
        var path = dlg.data[0];
        var enc = (window.cep.encoding && window.cep.encoding.UTF8) ? window.cep.encoding.UTF8 : 'UTF-8';
        var r = window.cep.fs.readFile(path, enc);
        if (r.err !== 0) { showErr('ファイル読み込み失敗 (err=' + r.err + ')\n' + path); return; }
        var p = KMParser.parseText(r.data, { tableOnly: true });
        if (!p.list.length) { showErr('タイムコード付きの修正行（表）が見つかりませんでした\n' + path); return; }
        var lines = [];
        for (var i = 0; i < p.list.length; i++) {
            var rec = p.list[i];
            lines.push(rec.tcRaw + '\t' + (rec.cur || '') + '\t' + rec.fix);
        }
        dataEl.value = lines.join('\n');
        showOk(p.list.length + ' 件を読み込みました。内容を確認して「マーカーを追加」を押してください。');
        log('ファイル読込: ' + path + ' → ' + p.list.length + '件');
    }

    function resetMarkers() {
        if (!host) { showErr('ホストスクリプト未ロード'); return; }
        log('--- リセット（校正マーカー削除）---');
        evalHost('clearKoseiMarkers()', function (res) {
            log('clearKoseiMarkers → ' + res);
            var d = {};
            try { d = JSON.parse(res); } catch (e) { showErr('リセット: 応答パース失敗\n' + res); return; }
            if (d.error) { showErr(d.error); return; }
            showOk((d.removed || 0) + ' 件の校正マーカーを削除しました。');
            loadMarkers();
        });
    }

    var F1 = String.fromCharCode(1), F2 = String.fromCharCode(2);

    function loadMarkers() {
        if (!host) { return; }
        evalHost('listMarkers()', function (res) {
            var evalErr = (typeof EvalScript_ErrMessage !== 'undefined') ? EvalScript_ErrMessage : 'EvalScript error.';
            if (res === evalErr) {
                allMarkers = []; renderCounts(); markerListEl.innerHTML = '';
                renderEmpty('ExtendScript実行エラー（シーケンスを開いて「更新」を押してください）');
                return;
            }
            if (res && res.charAt(0) === '{') { // エラーJSON
                try { var e = JSON.parse(res); allMarkers = []; renderCounts(); markerListEl.innerHTML = ''; renderEmpty(e.error || 'マーカー取得エラー'); } catch (x) {}
                return;
            }
            renderMarkers(res);
        });
    }

    function renderEmpty(msg) {
        var d = document.createElement('div');
        d.className = 'empty';
        d.textContent = msg;
        markerListEl.appendChild(d);
    }

    function renderMarkers(raw) {
        allMarkers = [];
        if (raw) {
            var recs = raw.split(F2);
            for (var i = 0; i < recs.length; i++) {
                if (!recs[i]) { continue; }
                var f = recs[i].split(F1);
                if (!/^\d+$/.test(f[0])) { continue; } // ticksが数字列でないレコードは捨てる
                var name = f[1] || '';
                allMarkers.push({
                    idx: i, // listMarkersの並び順（同一ticksの取り違え防止キー）
                    ticks: f[0], name: name, cmt: f[2] || '', secs: parseFloat(f[3]),
                    kosei: name.indexOf('校正') === 0,
                    done: name.indexOf('校正✅') === 0
                });
            }
        }
        // 時間順を保証（S3）
        allMarkers.sort(function (a, b) {
            var sa = isFinite(a.secs) ? a.secs : 0, sb = isFinite(b.secs) ? b.secs : 0;
            return sa - sb;
        });
        renderCounts();
        renderList();
    }

    function renderCounts() {
        var tot = 0, done = 0, other = 0;
        for (var i = 0; i < allMarkers.length; i++) {
            if (allMarkers[i].kosei) { tot++; if (allMarkers[i].done) { done++; } }
            else { other++; }
        }
        if (tot === 0 && other === 0) { countsEl.textContent = ''; return; }
        var s = '校正 ' + tot + '件（✅済 ' + done + '／残 ' + (tot - done) + '）';
        if (other > 0) { s += '　その他 ' + other + '件'; }
        countsEl.textContent = s;
    }

    function matchFilter(mk) {
        if (curFilter === 'kosei' && !mk.kosei) { return false; }
        if (curFilter === 'remain' && (!mk.kosei || mk.done)) { return false; }
        if (curFilter === 'other' && mk.kosei) { return false; }
        var q = norm(searchEl.value.trim());
        if (q && norm(mk.name + ' ' + mk.cmt).indexOf(q) === -1) { return false; }
        return true;
    }

    function renderList() {
        markerListEl.innerHTML = '';
        var shown = 0;
        for (var i = 0; i < allMarkers.length; i++) {
            var mk = allMarkers[i];
            if (!matchFilter(mk)) { continue; }
            shown++;
            markerListEl.appendChild(buildRow(mk));
        }
        if (shown === 0) {
            renderEmpty(allMarkers.length ? '該当するマーカーがありません' : 'マーカーがありません');
        }
    }

    function buildRow(mk) {
        var row = document.createElement('div');
        row.className = 'mitem' + (mk.kosei ? ' kosei' : '') + (mk.done ? ' done' : '') + (mk.ticks === selTicks ? ' sel' : '');

        var nm = document.createElement('div');
        nm.className = 'mname';
        nm.textContent = fmtTime(mk.secs) + (mk.name ? '  ' + mk.name : '');
        row.appendChild(nm);

        if (editTicks === mk.ticks) {
            // コメント編集モード（A1）。再描画されても下書き(editDraft)を復元する
            var ta = document.createElement('textarea');
            ta.className = 'cedit';
            ta.value = (editDraft !== null) ? editDraft : mk.cmt;
            ta.addEventListener('input', function () { editDraft = ta.value; });
            row.appendChild(ta);
            var btns = document.createElement('div');
            btns.className = 'mact';
            btns.appendChild(actBtn('💾 保存', 'act save', function () { saveComment(mk, ta.value); }));
            btns.appendChild(actBtn('取消', 'act', function () { editTicks = null; editDraft = null; renderList(); }));
            row.appendChild(btns);
            ta.addEventListener('click', function (e) { e.stopPropagation(); });
            return row;
        }

        var cm = document.createElement('div');
        cm.className = 'mcmt';
        cm.textContent = mk.cmt || '（コメントなし）';
        if (!mk.cmt) { cm.style.color = '#777'; }
        row.appendChild(cm);

        var act = document.createElement('div');
        act.className = 'mact';
        if (mk.kosei) {
            act.appendChild(actBtn(mk.done ? '↩ 未済に戻す' : '✅ 済', 'act' + (mk.done ? '' : ' doneBtn'), function () { toggleDone(mk); }));
        }
        act.appendChild(actBtn('✎ 編集', 'act', function () { editTicks = mk.ticks; editDraft = mk.cmt; confirmDelTicks = null; renderList(); }));
        if (confirmDelTicks === mk.ticks) {
            act.appendChild(actBtn('本当に削除する', 'act delConfirm', function () { deleteOne(mk); }));
            act.appendChild(actBtn('やめる', 'act', function () { confirmDelTicks = null; renderList(); }));
        } else {
            act.appendChild(actBtn('🗑', 'act', function () { confirmDelTicks = mk.ticks; renderList(); }));
        }
        row.appendChild(act);

        row.addEventListener('click', function () {
            selTicks = mk.ticks;
            evalHost("gotoMarker('" + mk.ticks + "')", function () {});
            renderList();
        });
        return row;
    }

    function actBtn(label, cls, fn) {
        var b = document.createElement('button');
        b.className = cls;
        b.textContent = label;
        b.addEventListener('click', function (e) { e.stopPropagation(); fn(); });
        return b;
    }

    // ---- 済み⇔未済（S1） ----
    function toggleDone(mk) {
        evalHost("setMarkerDone(" + mk.idx + ",'" + mk.ticks + "','" + (mk.done ? 0 : 1) + "')", function (res) {
            log('setMarkerDone → ' + res);
            var d = {};
            try { d = JSON.parse(res); } catch (e) { showErr('済み切替: 応答パース失敗\n' + res); return; }
            if (d.error) { showErr(d.error); return; }
            if (!mk.done && d.colored === 0) { log('※この環境はマーカー色APIに未対応（名前の✅で管理します）'); }
            loadMarkers();
        });
    }

    // ---- コメント編集（A1） ----
    function saveComment(mk, text) {
        evalHost("setMarkerComment(" + mk.idx + ",'" + mk.ticks + "','" + escJS(text) + "')", function (res) {
            log('setMarkerComment → ' + res);
            var d = {};
            try { d = JSON.parse(res); } catch (e) { showErr('コメント保存: 応答パース失敗\n' + res); return; }
            if (d.error) { showErr(d.error); return; }
            editTicks = null;
            editDraft = null;
            loadMarkers();
        });
    }

    // ---- 個別削除（A1・2タップ確認） ----
    function deleteOne(mk) {
        confirmDelTicks = null;
        evalHost("deleteMarkerByTicks(" + mk.idx + ",'" + mk.ticks + "')", function (res) {
            log('deleteMarkerByTicks → ' + res);
            var d = {};
            try { d = JSON.parse(res); } catch (e) { showErr('削除: 応答パース失敗\n' + res); return; }
            if (d.error) { showErr(d.error); return; }
            loadMarkers();
        });
    }

    function fmtTime(sec) {
        if (!isFinite(sec) || sec < 0) { sec = 0; }
        var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
        function z(n) { return (n < 10 ? '0' : '') + n; }
        return (h > 0 ? h + ':' + z(m) : m + '') + ':' + z(s);
    }

    function evalHost(call, cb) {
        cs.evalScript(host + ';\n' + call, cb);
    }

    function refreshSeq() {
        if (!host) { return; }
        evalHost('getSeqInfo()', function (res) {
            log('getSeqInfo → ' + res);
            try {
                var d = JSON.parse(res);
                seqNameEl.textContent = d.error ? '—' : (d.seq || '—');
            } catch (e) { seqNameEl.textContent = '—'; log('getSeqInfo パース失敗'); }
        });
    }

    function fpsConf(mode, autoFps, autoVdf) {
        switch (mode) {
            case '2997df': return { fps: 30000 / 1001, nominal: 30, drop: true };
            case '2997nd': return { fps: 30000 / 1001, nominal: 30, drop: false };
            case '5994df': return { fps: 60000 / 1001, nominal: 60, drop: true };
            case '30': return { fps: 30, nominal: 30, drop: false };
            case '25': return { fps: 25, nominal: 25, drop: false };
            case '24': return { fps: 24, nominal: 24, drop: false };
            case '23976': return { fps: 24000 / 1001, nominal: 24, drop: false };
            case 'auto':
                var nom = Math.round(autoFps || 0);
                // DF判定はシーケンスのTC表示形式(videoDisplayFormat)を最優先:
                // 102=29.97DF / 106=59.94DF のみDF。23.976等にDFタイムコードは存在しない
                var drop;
                if (autoVdf === 102 || autoVdf === 106) { drop = true; }
                else if (autoVdf > 0) { drop = false; }
                else { drop = (nom === 30 || nom === 60) && Math.abs(autoFps - nom) > 0.001; } // vdf不明時のフォールバック
                return { fps: autoFps, nominal: nom, drop: drop };
        }
        return null;
    }

    // 貼り付けデータ → マーカーリスト（解析は KMParser に委譲）
    function parse(conf) {
        var p = KMParser.parseText(dataEl.value);
        var errs = p.errs.slice();
        var out = [];
        var zeroFrames = Math.round((conf.offset || 0) * conf.fps); // 開始TC(zeroPoint)をフレームで引く
        for (var i = 0; i < p.list.length; i++) {
            var rec = p.list[i];
            // 微調整は秒精度TCのみ（A3恒久修正：フレーム/ミリ秒精度のTCはそのまま正確に打つ）
            var adj = rec.tc.precise ? 0 : (conf.offsetFrames || 0);
            var frame = KMParser.tcToFrame(rec.tc, conf) + adj - zeroFrames;
            if (frame < 0) { frame = 0; }
            var comment = (rec.cur ? '現在：' + rec.cur + '\n' : '') + '修正：' + rec.fix;
            out.push({ frame: frame, name: '校正 ' + rec.tcRaw, comment: comment });
            log(rec.tcRaw + ' → frame ' + frame + (adj ? ' (微調整' + (adj > 0 ? '+' : '') + adj + 'f)' : '') + '  修正:' + rec.fix);
        }
        return { list: out, errs: errs };
    }

    var TICKS_PER_SEC = 254016000000;

    function run() {
        if (!host) { showErr('ホストスクリプト未ロード'); return; }
        var mode = fpsSel.value;
        log('--- 実行 (fps=' + mode + ') ---');
        // シーケンス情報は常に取得（開始TCオフセット・実fpsに使う）
        evalHost('getSeqInfo()', function (res) {
            log('getSeqInfo → ' + res);
            var d = {};
            try { d = JSON.parse(res); } catch (e) { showErr('getSeqInfo: JSONパース失敗\n' + res); return; }
            if (d.error) { showErr(d.error); return; }

            var conf;
            if (mode === 'auto') {
                if (!d.fps || d.fps <= 0) { showErr('自動取得失敗: fps不明 (' + d.fps + ')\n手動でフレームレートを選んでください'); return; }
                conf = fpsConf('auto', d.fps, parseInt(d.vdf, 10) || 0);
            } else {
                conf = fpsConf(mode);
            }

            // 開始TC(zeroPoint, ticks)を秒に換算して差し引く
            var zp = parseFloat(d.zeroPoint);
            conf.offset = (isFinite(zp) && zp > 0) ? (zp / TICKS_PER_SEC) : 0;
            conf.offsetFrames = parseInt(offsetEl.value, 10) || 0;
            log('fps=' + conf.fps.toFixed(4) + ' nominal=' + conf.nominal + ' drop=' + conf.drop +
                ' 開始TCオフセット=' + conf.offset.toFixed(3) + 's 秒精度TC微調整=' + conf.offsetFrames + 'f');
            doRun(conf);
        });
    }

    function doRun(conf) {
        var r = parse(conf);
        log('レコード ' + r.list.length + ' 件 / スキップ ' + r.errs.length + ' 件');
        if (r.errs.length) { log('スキップ:\n' + r.errs.join('\n')); }
        if (r.list.length === 0) {
            showErr('有効な行がありません（ログ参照）');
            return;
        }
        var parts = [];
        for (var k = 0; k < r.list.length; k++) {
            var it = r.list[k];
            parts.push(it.frame + F1 + it.name + F1 + it.comment);
        }
        var payload = escJS(parts.join(F2));
        var doAdd = function () {
            evalHost("addMarkers('" + payload + "')", function (res) {
                log('addMarkers → ' + res);
                var d = {};
                try { d = JSON.parse(res); } catch (e) { showErr('マーカー追加: 応答パース失敗\n' + res); return; }
                if (d.error) { showErr(d.error); return; }
                var msg = d.added + ' 件のマーカーを追加しました。';
                if (r.errs.length) { msg += '（スキップ ' + r.errs.length + ' 件・ログ参照）'; }
                showOk(msg);
                loadMarkers();
            });
        };
        if (clearEl.checked) {
            evalHost('clearKoseiMarkers()', function (res) {
                log('clearKoseiMarkers → ' + res);
                var dd = {};
                try { dd = JSON.parse(res); } catch (e) { showErr('既存マーカー削除: 応答パース失敗\n' + res); return; }
                if (dd.error) { showErr(dd.error); return; }
                doAdd();
            });
        } else {
            doAdd();
        }
    }

    function showOk(t) { resultEl.className = 'result ok'; resultEl.textContent = t; log('OK: ' + t); }
    function showErr(t) { resultEl.className = 'result err'; resultEl.textContent = t; log('ERR: ' + t); }
})();
