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

    // 所有マーカーの識別は hostscript.jsx と共通の「ゼロ幅一意ID」（KMParser.decodeId/stripId）で行う（K2-2）。
    var curFilter = 'all';
    var allMarkers = [];
    var busy = false;         // 実行中フラグ（多重クリック/連打防止）
    var busyTimer = null;     // 実行のタイムアウト監視（callback未到達で永久disabledを防ぐ・K2-5）
    // UI状態のキーは「所有マーカー=復号ID / 非所有マーカー=並び順idx」で持つ（K2-2）。
    // 所有マーカーはIDが並び替え・増減に強い一意キーになるので取り違えない。
    var selKey = null;        // 選択中（ハイライト）
    var editKey = null;       // コメント編集中
    var editDraft = null;     // 編集中の未保存テキスト（再描画されても消さない）
    var confirmDelKey = null; // 削除確認中（2タップ式）
    var runToken = 0;         // 実行トークン（K3-3: 後着callback/タイムアウト後の古い応答を無効化する単調増加値）
    var lastRunId = 0;        // 直近の runId（K3-5: 同一ミリ秒でも実行間で衝突しないよう単調増加させる）
    var listSeqId = '';       // 一覧を読み込んだ時点のシーケンスID（K3-7: 個別操作前の照合に使う。K4-3: 一覧応答と同梱で取得）
    var listToken = 0;        // 一覧取得トークン（K4-3: loadMarkers 交錯時に後着応答を破棄する単調増加値）

    // 実行ごとに一意で単調増加する runId を発行（K3-5: Date.now が同値でも +1 して重複を避ける）
    function nextRunId() {
        var t = (new Date()).getTime();
        if (t <= lastRunId) { t = lastRunId + 1; }
        lastRunId = t;
        return t;
    }

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
    searchEl.addEventListener('input', function () { confirmDelKey = null; renderList(); });

    for (var b = 0; b < filtBtns.length; b++) {
        (function (btn) {
            btn.addEventListener('click', function () {
                curFilter = btn.getAttribute('data-filter');
                for (var j = 0; j < filtBtns.length; j++) { filtBtns[j].className = 'filt'; }
                btn.className = 'filt active';
                confirmDelKey = null;
                renderList();
            });
        })(filtBtns[b]);
    }

    // 実行の開始/終了は beginBusy()/finish() の対で管理する（K2-5）。
    // どの終了経路（成功/失敗/例外/callback未到達）からも finish() を必ず1回呼び、永久disabledを防ぐ。
    var BUSY_TIMEOUT_MS = 30000;
    function beginBusy() {
        busy = true;
        runBtn.disabled = true;
        resetBtn.disabled = true;
        if (busyTimer) { clearTimeout(busyTimer); }
        busyTimer = setTimeout(function () {
            busyTimer = null;
            // K3-3: タイムアウト発火時に runToken を進め、以後に到着する古い応答（doRun/clear）を全て無効化してから finish
            if (busy) { runToken++; showErr('タイムアウト（30秒応答なし）。処理を中断しました。再度お試しください。'); finish(); }
        }, BUSY_TIMEOUT_MS);
        renderList(); // 実行中は一覧の編集/削除/済切替ボタンを無効化するため再描画
    }
    function finish() {
        if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
        busy = false;
        runBtn.disabled = false;
        resetBtn.disabled = false;
        renderList(); // 一覧の操作を再び有効化
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
        // 表のTC付き行のうち採用できなかった行があれば警告（無警告の刺し漏れ防止・Fix1）
        var st = p.stats || { mdTcRows: 0, mdAdopted: 0 };
        var skipped = st.mdTcRows - st.mdAdopted;
        var msg = p.list.length + ' 件を読み込みました。内容を確認して「マーカーを追加」を押してください。';
        if (skipped > 0) {
            msg += '\n⚠️ 表のTC付き ' + st.mdTcRows + ' 行中 ' + skipped + ' 行は採用できませんでした（ログ参照）。';
            for (var e = 0; e < p.errs.length; e++) { log('採用不可: ' + p.errs[e]); }
        }
        showOk(msg);
        log('ファイル読込: ' + path + ' → ' + p.list.length + '件（表TC行' + st.mdTcRows + ' / 採用' + st.mdAdopted + '）');
    }

    function resetMarkers() {
        if (busy) { return; }
        if (!host) { showErr('ホストスクリプト未ロード'); return; }
        runToken++;                      // K3-3: 新しい実行。以前の実行の後着callbackを無効化する
        var myToken = runToken;
        beginBusy();
        log('--- リセット（校正マーカー削除）---');
        try {
            // seqId照合付きの削除にする（K2-1）。旧形式は保持（includeLegacy=0）＝手打ちマーカー保護。
            evalHost('getSeqInfo()', function (res) {
                if (myToken !== runToken) { return; } // K3-3: 後着/タイムアウト後の応答は破棄
                var d = {};
                try { d = JSON.parse(res); } catch (e) { showErr('リセット: getSeqInfo パース失敗\n' + res); finish(); return; }
                if (d.error) { showErr(d.error); finish(); return; }
                if (!d.seqId) { showErr('シーケンスIDを取得できませんでした。もう一度お試しください'); finish(); return; } // K3-2
                var eid = escJS(d.seqId);
                evalHost("clearKoseiMarkers('" + eid + "','0')", function (res2) {
                    if (myToken !== runToken) { return; } // K3-3
                    log('clearKoseiMarkers → ' + res2);
                    var dd = {};
                    try { dd = JSON.parse(res2); } catch (e2) { showErr('リセット: 応答パース失敗\n' + res2); finish(); return; }
                    if (dd.error) { showErr(dd.error); finish(); return; }
                    var msg = (dd.removed || 0) + ' 件の校正マーカーを削除しました。';
                    if (dd.legacy) { msg += '（旧形式 ' + dd.legacy + ' 件は目印が無いため保持・手動で削除してください）'; }
                    showOk(msg);
                    finish();
                    loadMarkers();
                });
            });
        } catch (e) { showErr('リセットエラー: ' + e); finish(); }
    }

    var F1 = String.fromCharCode(1), F2 = String.fromCharCode(2), F3 = String.fromCharCode(3);

    // K4-3: seqId と一覧を 1 回の listMarkers() 応答で受け取り、seqId を一覧とセットで保持する
    //   （別evalScriptで getSeqInfo→listMarkers と分けると、その隙のシーケンス切替で seqId と一覧が食い違う）。
    //   listToken を張り、複数 loadMarkers が交錯したときは後着応答を破棄する（K3-3 の runToken と同様）。
    function loadMarkers() {
        if (!host) { return; }
        listToken++;
        var myList = listToken;
        evalHost('listMarkers()', function (res) {
            if (myList !== listToken) { return; } // 後着応答は破棄（この応答の seqId/一覧はもう古い）
            var evalErr = (typeof EvalScript_ErrMessage !== 'undefined') ? EvalScript_ErrMessage : 'EvalScript error.';
            if (res === evalErr) {
                listSeqId = '';
                allMarkers = []; renderCounts(); markerListEl.innerHTML = '';
                renderEmpty('ExtendScript実行エラー（シーケンスを開いて「更新」を押してください）');
                return;
            }
            if (res && res.charAt(0) === '{') { // エラーJSON
                listSeqId = '';
                try { var e = JSON.parse(res); allMarkers = []; renderCounts(); markerListEl.innerHTML = ''; renderEmpty(e.error || 'マーカー取得エラー'); } catch (x) {}
                return;
            }
            // 正常応答 = seqId + F3 + 一覧本体。この応答に入っていた seqId を一覧とセットで保持する
            var sep = res.indexOf(F3);
            if (sep === -1) { // 想定外の形式（seqId 区切りが無い）
                listSeqId = '';
                allMarkers = []; renderCounts(); markerListEl.innerHTML = '';
                renderEmpty('マーカー一覧の応答形式が不正です（「更新」を押してください）');
                return;
            }
            listSeqId = res.slice(0, sep);
            renderMarkers(res.slice(sep + 1));
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
                var rawName = f[1] || '';
                var rid = KMParser.decodeId(rawName);                 // この拡張の一意ID（非所有は null）
                var owned = rid !== null;                             // ゼロ幅IDが妥当に付いているか
                var name = owned ? KMParser.stripId(rawName) : rawName; // 表示・検索・判定はゼロ幅IDを除いた名前で
                allMarkers.push({
                    idx: i,                                  // listMarkersの並び順（非所有マーカーの idx+ticks 用）
                    rid: owned ? String(rid) : '',           // 所有マーカーの一意ID（host操作の主キー・K2-2）
                    key: owned ? ('r' + rid) : ('x' + i),    // UI状態キー（所有=ID / 非所有=idx）
                    ticks: f[0], name: name, cmt: f[2] || '', secs: parseFloat(f[3]), owned: owned,
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
        row.className = 'mitem' + (mk.kosei ? ' kosei' : '') + (mk.done ? ' done' : '') + (mk.key === selKey ? ' sel' : '');

        var nm = document.createElement('div');
        nm.className = 'mname';
        nm.textContent = fmtTime(mk.secs) + (mk.name ? '  ' + mk.name : '');
        row.appendChild(nm);

        if (editKey === mk.key) {
            // コメント編集モード（A1）。再描画されても下書き(editDraft)を復元する
            var ta = document.createElement('textarea');
            ta.className = 'cedit';
            ta.value = (editDraft !== null) ? editDraft : mk.cmt;
            ta.addEventListener('input', function () { editDraft = ta.value; });
            row.appendChild(ta);
            var btns = document.createElement('div');
            btns.className = 'mact';
            btns.appendChild(actBtn('💾 保存', 'act save', function () { saveComment(mk, ta.value); }));
            btns.appendChild(actBtn('取消', 'act', function () { editKey = null; editDraft = null; renderList(); }));
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
        act.appendChild(actBtn('✎ 編集', 'act', function () { if (busy) { return; } editKey = mk.key; editDraft = mk.cmt; confirmDelKey = null; renderList(); }));
        if (confirmDelKey === mk.key) {
            act.appendChild(actBtn('本当に削除する', 'act delConfirm', function () { deleteOne(mk); }));
            act.appendChild(actBtn('やめる', 'act', function () { confirmDelKey = null; renderList(); }));
        } else {
            act.appendChild(actBtn('🗑', 'act', function () { if (busy) { return; } confirmDelKey = mk.key; renderList(); }));
        }
        row.appendChild(act);

        row.addEventListener('click', function () {
            selKey = mk.key;
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
        if (busy) { return; } // 実行中は一覧操作を止める（K2-5）
        evalHost("setMarkerDone('" + escJS(mk.rid) + "'," + mk.idx + ",'" + mk.ticks + "','" + (mk.done ? 0 : 1) + "','" + escJS(listSeqId) + "')", function (res) {
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
        if (busy) { return; } // 実行中は一覧操作を止める（K2-5）
        evalHost("setMarkerComment('" + escJS(mk.rid) + "'," + mk.idx + ",'" + mk.ticks + "','" + escJS(text) + "','" + escJS(listSeqId) + "')", function (res) {
            log('setMarkerComment → ' + res);
            var d = {};
            try { d = JSON.parse(res); } catch (e) { showErr('コメント保存: 応答パース失敗\n' + res); return; }
            if (d.error) { showErr(d.error); return; }
            editKey = null;
            editDraft = null;
            loadMarkers();
        });
    }

    // ---- 個別削除（A1・2タップ確認） ----
    function deleteOne(mk) {
        if (busy) { return; } // 実行中は一覧操作を止める（K2-5）
        confirmDelKey = null;
        evalHost("deleteMarkerByTicks('" + escJS(mk.rid) + "'," + mk.idx + ",'" + mk.ticks + "','" + escJS(listSeqId) + "')", function (res) {
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
        // fps を渡してフレーム値の範囲外行も errs に載せる（K2-7）
        var p = KMParser.parseText(dataEl.value, { fps: conf.nominal });
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
        return { list: out, errs: errs, stats: p.stats };
    }

    var TICKS_PER_SEC = 254016000000;

    function run() {
        if (busy) { return; } // 実行中の二重起動を防ぐ（Fix6）
        if (!host) { showErr('ホストスクリプト未ロード'); return; }
        runToken++;                      // K3-3: 新しい実行。以前の実行の後着callbackを無効化する
        var myToken = runToken;
        beginBusy();
        try {
            var mode = fpsSel.value;
            log('--- 実行 (fps=' + mode + ') ---');
            // シーケンス情報は常に取得（開始TCオフセット・実fps・シーケンス識別子に使う）
            evalHost('getSeqInfo()', function (res) {
                if (myToken !== runToken) { return; } // K3-3: 後着/タイムアウト後の応答は破棄
                log('getSeqInfo → ' + res);
                var d = {};
                try { d = JSON.parse(res); } catch (e) { showErr('getSeqInfo: JSONパース失敗\n' + res); finish(); return; }
                if (d.error) { showErr(d.error); finish(); return; }
                if (!d.seqId) { showErr('シーケンスIDを取得できませんでした。もう一度お試しください'); finish(); return; } // K3-2

                var conf;
                if (mode === 'auto') {
                    if (!d.fps || d.fps <= 0) { showErr('自動取得失敗: fps不明 (' + d.fps + ')\n手動でフレームレートを選んでください'); finish(); return; }
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
                // 実行開始時のシーケンス識別子を保持し、削除/追加時に照合（実行中の切替で別シーケンスを壊さない・Fix3）
                doRun(conf, d.seqId, myToken);
            });
        } catch (e) {
            showErr('実行エラー: ' + e);
            finish();
        }
    }

    function doRun(conf, seqId, myToken) {
        try {
            var r = parse(conf);
            log('レコード ' + r.list.length + ' 件 / スキップ ' + r.errs.length + ' 件');
            if (r.stats && r.stats.mdTcRows) { log('表TC付き行 ' + r.stats.mdTcRows + ' / 採用 ' + r.stats.mdAdopted); }
            if (r.errs.length) { log('スキップ:\n' + r.errs.join('\n')); }
            if (r.list.length === 0) {
                showErr('有効な行がありません（ログ参照）');
                finish();
                return;
            }
            // 各レコードに一意IDを割り当てる（K3-5: runId=単調増加の実行ID・k=実行内の連番。掛け算で潰さず別フィールドで渡す）。
            // host が (runId, k) をゼロ幅符号化して付与する（K2-2/K3-4）。
            var runId = nextRunId();
            var parts = [];
            for (var k = 0; k < r.list.length; k++) {
                var it = r.list[k];
                parts.push(it.frame + F1 + it.name + F1 + it.comment + F1 + runId + F1 + k);
            }
            var payload = escJS(parts.join(F2));
            var eid = escJS(seqId || '');
            var clearFlag = clearEl.checked ? '1' : '0';
            // 削除＋追加を1回の呼び出しに統合（K3-1: 検証→追加→成功時のみ削除。追加失敗時は旧マーカーを残す＝消失防止）
            evalHost("replaceMarkers('" + payload + "','" + eid + "','" + clearFlag + "')", function (res) {
                if (myToken !== runToken) { return; } // K3-3: 後着/タイムアウト後の応答は破棄
                log('replaceMarkers → ' + res);
                var d = {};
                try { d = JSON.parse(res); } catch (e) { showErr('マーカー追加: 応答パース失敗\n' + res); finish(); return; }
                if (d.error) { showErr(d.error); finish(); return; }
                var msg;
                if (d.cleared) { msg = '既存 ' + d.cleared + ' 件を削除し、' + d.added + ' 件のマーカーを追加しました。'; }
                else { msg = d.added + ' 件のマーカーを追加しました。'; }
                if (d.oldCleared) {
                    msg += '（旧形式 ' + d.oldCleared + ' 件も削除）';
                    log('旧形式マーカー ' + d.oldCleared + ' 件も削除しました（手打ちの校正メモがあれば要確認）');
                }
                if (d.skipped) { msg += '（重複 ' + d.skipped + ' 件はスキップ）'; }
                if (d.failed) {
                    msg += '（失敗 ' + d.failed + ' 件・ログ参照）';
                    // K3-1: clearFirst指定でも追加に失敗があると既存を消していない（消失防止）ことをユーザーに明示
                    if (clearEl.checked) { msg += '※失敗があったため既存マーカーは削除していません（データ保全のため）。'; }
                    // K4-1: ID定着失敗（この環境ではマーカー名の不可視IDが保持されない可能性）を明示
                    if (d.idVerifyFailed) {
                        msg += '（うち ' + d.idVerifyFailed + ' 件はマーカーに目印IDを付けられませんでした）';
                        log('⚠️ ID定着失敗 ' + d.idVerifyFailed + ' 件: この環境ではマーカー名の不可視IDが保持されない可能性があります。安全のため既存マーカーは削除していません。');
                    }
                    if (d.errors && d.errors.length) { log('追加失敗: ' + d.errors.join(' / ')); }
                }
                if (r.errs.length) { msg += '（スキップ ' + r.errs.length + ' 件・ログ参照）'; }
                showOk(msg);
                finish();
                loadMarkers();
            });
        } catch (e) {
            showErr('実行エラー: ' + e);
            finish();
        }
    }

    function showOk(t) { resultEl.className = 'result ok'; resultEl.textContent = t; log('OK: ' + t); }
    function showErr(t) { resultEl.className = 'result err'; resultEl.textContent = t; log('ERR: ' + t); }
})();
