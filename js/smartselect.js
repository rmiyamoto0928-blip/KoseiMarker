/* smartselect.js — Premiereのパネルで「選ぶ欄」がちゃんと開くようにする共通部品
 *
 * 【なぜ要るか】
 *   CEP（Premiereがパネルを描く仕組み）では、ネイティブ <select> の一覧が
 *   パネルの外側の座標に描かれてしまい、押しても出ない／出ても選べない。
 *   欄がパネルの下のほうにあるほど、パネルが低いほど起きやすい。
 *   SozaiDrop で先に自作メニューにして直した実績があり（css/style.css の
 *   「パネル下端のネイティブselectのリストが画面外に描画されて選べない」）、
 *   その配置の考え方をここに一般化した。
 *
 * 【設計の要】★ <select> は見た目もそのまま残す。出てこない「一覧」だけを差し替える。
 *   閉じている間の欄は、今までどおりネイティブの <select> がそのまま描く。
 *     → 色も幅も高さも各パネルのCSSがそのまま効く＝配る側の手直しがゼロ。
 *     → キーボード操作・フォーカス・タブ移動もブラウザ任せのまま動く。
 *   押したときだけ、ネイティブの一覧が出るのを差し止めて、自前の一覧を出す。
 *     選んだら select.value を入れて *本物の change を発火* させるので、
 *     既存の処理はこの部品の存在を知らないまま今までどおり動く。
 *
 *   ＜かぶせ方式をやめた理由（2026-08-09）＞
 *   最初は <select> を隠して自作ボタンをかぶせる作りにしたが、
 *     ・パネルごとに色の変数名が違うので、色と幅を測って写す仕掛けが必要になった
 *     ・写した色が要素に直書きされ、「配色の正本は :root だけ」という
 *       SozaiDrop の決まりを破った（回帰テストが4件RED）
 *     ・自作ボタンはフォーカスを持てず、作り直しのあと選択位置が失われた
 *   欄そのものを触らなければ、この3つはまとめて起きない。
 *
 * 【安全装置】
 *   検査用の疑似ブラウザ（TelopKobo / CaptionMover の vm サンドボックス）には
 *   getBoundingClientRect などが無い。無い環境では *何もしないで終わる*。
 *   そうしないと読み込んだ瞬間に落ちて、パネル本体ごと動かなくなる。
 */
(function (root) {
    'use strict';

    var d = root.document;

    // ---- 使える環境かどうかを最初に確かめる（1つでも欠けたら丸ごと諦める）----
    function usable() {
        if (!d || !d.body || typeof d.createElement !== 'function') { return false; }
        if (typeof d.querySelectorAll !== 'function') { return false; }
        if (typeof d.addEventListener !== 'function') { return false; }
        var probe;
        try { probe = d.createElement('div'); } catch (e) { return false; }
        if (!probe || typeof probe.getBoundingClientRect !== 'function') { return false; }
        if (!probe.classList || typeof probe.classList.add !== 'function') { return false; }
        if (typeof probe.appendChild !== 'function') { return false; }
        if (!root.getComputedStyle) { return false; }
        return true;
    }

    var ENABLED = usable();

    var hooked = [];       // 差し止めを付けた <select> の台帳
    var menu = null;       // 一覧は画面に1つだけ作って使い回す
    var openSel = null;    // いま一覧を出している <select>

    function px(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

    // 透明・未設定は「色が無い」扱い（写すと真っ黒や透け落ちになる）
    function solid(c) {
        if (!c) { return false; }
        c = String(c);
        if (c === 'transparent') { return false; }
        if (c.replace(/\s/g, '') === 'rgba(0,0,0,0)') { return false; }
        return true;
    }

    function makeMenu() {
        if (menu) { return menu; }
        menu = d.createElement('div');
        menu.className = 'ss-menu ss-hidden';
        menu.setAttribute('role', 'listbox');
        menu.addEventListener('mousedown', function (e) { e.preventDefault(); });  // 欄のフォーカスを外さない
        menu.addEventListener('click', function (e) {
            e.stopPropagation();
            var t = e.target;
            var v = t && t.getAttribute ? t.getAttribute('data-v') : null;
            if (v === null || !openSel) { return; }
            if (String(t.className).indexOf('ss-dis') >= 0) { return; }
            var sel = openSel;
            close();
            if (sel.value === v) { return; }   // 同じものを選び直しただけなら何も起こさない
            sel.value = v;
            fireChange(sel);                   // ★ここが「既存コードが今までどおり動く」要
        });
        d.body.appendChild(menu);
        return menu;
    }

    // ---- 一覧の色を、そのとき欄が実際に描かれている色に合わせる --------------
    // パネルごとに色の変数名がバラバラ（--ea-* / --sd-* / --btn / --field …）で、
    // 共通CSSから各パネルの色を名指しすることはできない。だから欄を実測して写す。
    // ★開いている間だけ差し、閉じるときに外す。
    //   出しっぱなしにすると「配色の正本は :root だけ」という決まりを破る形で
    //   DOMに色が residue として残る（SozaiDropの回帰テストが見張っている）。
    //   毎回測り直すので、Premiereの配色を変えてもそのまま追従する。
    var VARS = ['--ss-menu-bg', '--ss-menu-fg', '--ss-menu-border', '--ss-font'];

    function dressMenu(sel, m) {
        if (!m.style || typeof m.style.setProperty !== 'function') { return; }
        var cs;
        try { cs = root.getComputedStyle(sel); } catch (e) { return; }
        if (!cs) { return; }
        if (solid(cs.backgroundColor)) { m.style.setProperty('--ss-menu-bg', cs.backgroundColor); }
        if (solid(cs.color)) { m.style.setProperty('--ss-menu-fg', cs.color); }
        if (cs.borderTopStyle && cs.borderTopStyle !== 'none' &&
            px(cs.borderTopWidth) > 0 && solid(cs.borderTopColor)) {
            m.style.setProperty('--ss-menu-border', cs.borderTopColor);
        }
        if (px(cs.fontSize) > 0) { m.style.setProperty('--ss-font', cs.fontSize); }
    }

    function undressMenu(m) {
        if (!m.style || typeof m.style.removeProperty !== 'function') { return; }
        for (var i = 0; i < VARS.length; i++) { m.style.removeProperty(VARS[i]); }
    }

    // ---- 一覧を出す場所を決める ------------------------------------------------
    // 1) ふだんは下向き 2) 下が足りなければ上向きへ反転
    // 3) どちらも足りなければ広いほうへ出して高さを切り、中をスクロールで届かせる
    // これをやらないと、一覧の上端がマイナス座標へ出て上のほうの選択肢が押せなくなる
    // ＝いま直そうとしている不具合そのものを、自作の一覧でもう一度作ってしまう
    function place(sel, m) {
        var r = sel.getBoundingClientRect();
        var vh = root.innerHeight || 600;
        var vw = root.innerWidth || 300;
        var GAP = 2, EDGE = 4, MIN = 60;
        var below = vh - r.bottom - GAP - EDGE;
        var above = r.top - GAP - EDGE;
        var down = below >= Math.min(240, above) || (below >= MIN && below >= above);

        m.style.left = Math.max(EDGE, Math.min(r.left, vw - Math.max(r.width, 120) - EDGE)) + 'px';
        m.style.minWidth = Math.max(r.width, 120) + 'px';
        m.style.maxWidth = (vw - EDGE * 2) + 'px';
        if (down) {
            m.style.top = (r.bottom + GAP) + 'px';
            m.style.bottom = 'auto';
            m.style.maxHeight = Math.max(MIN, Math.min(280, below)) + 'px';
        } else {
            m.style.top = 'auto';
            m.style.bottom = (vh - r.top + GAP) + 'px';
            m.style.maxHeight = Math.max(MIN, Math.min(280, above)) + 'px';
        }
    }

    function buildList(sel, m) {
        var opts = sel.options || [], i, row, o;
        m.innerHTML = '';
        for (i = 0; i < opts.length; i++) {
            o = opts[i];
            row = d.createElement('div');
            row.className = 'ss-item' + (i === sel.selectedIndex ? ' ss-on' : '') +
                            (o.disabled ? ' ss-dis' : '');
            row.setAttribute('data-v', o.value);
            row.setAttribute('role', 'option');
            row.textContent = o.textContent || o.value;
            // 長い名前は折り返して全部読ませる。<select> だと「…」も出ずに切れて気づけない
            row.title = o.textContent || o.value;
            m.appendChild(row);
        }
        if (opts.length === 0) {
            row = d.createElement('div');
            row.className = 'ss-empty';
            row.textContent = '（選べるものがありません）';
            m.appendChild(row);
        }
    }

    // node が box の中（box 自身を含む）にあるか
    function within(node, box) {
        if (!node || !box) { return false; }
        if (typeof box.contains === 'function') {
            try { return box.contains(node); } catch (e) { /* 下の手繰りへ */ }
        }
        while (node) { if (node === box) { return true; } node = node.parentNode; }
        return false;
    }

    function close() {
        if (!openSel) { return; }
        menu.classList.add('ss-hidden');
        undressMenu(menu);
        openSel = null;
    }

    function open(sel) {
        if (sel.disabled) { return; }
        if (openSel === sel) { close(); return; }
        close();
        var m = makeMenu();
        buildList(sel, m);      // 押すたびに作り直す＝選択肢が入れ替わっていても必ず最新
        dressMenu(sel, m);
        m.classList.remove('ss-hidden');
        openSel = sel;
        place(sel, m);
        // 選ばれている行が見えるところまで送る（長い一覧で毎回いちばん上から探させない）
        var on = m.querySelector ? m.querySelector('.ss-on') : null;
        if (on && typeof on.offsetTop === 'number') { m.scrollTop = Math.max(0, on.offsetTop - 40); }
    }

    function fireChange(sel) {
        var ev;
        try {
            ev = new root.Event('change', { bubbles: true });
        } catch (e) {
            ev = d.createEvent('HTMLEvents');
            ev.initEvent('change', true, false);
        }
        sel.dispatchEvent(ev);
    }

    function hook(sel) {
        if (!sel || sel.__ss) { return false; }
        sel.__ss = true;
        // ★mousedown を止めるとネイティブの一覧は開かない（＝画面外に描かれる不具合が起きない）。
        //   欄そのものは消していないので、閉じている間の見た目は今までと1pxも変わらない。
        sel.addEventListener('mousedown', function (e) {
            if (sel.disabled) { return; }
            e.preventDefault();     // ネイティブの一覧を差し止める
            // ★stopPropagation はしない。欄を押したときの mousedown が上まで届かなくなると、
            //   各パネルが持っている「どこかを押したら自前の何かを閉じる」処理を黙って壊す。
            //   外側判定は onDocDown が的（target）を見て行うので、止める必要がない。
            try { sel.focus(); } catch (e2) { /* フォーカスは無くても選べる */ }
            open(sel);
        });
        // キーボードは <select> の標準のまま（上下で値が変わる）。
        // 開いている一覧が古くなるので閉じておく
        sel.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' || e.keyCode === 27) { close(); }
            else if (openSel === sel) { close(); }
        });
        hooked.push(sel);
        return true;
    }

    // あとから増えた <select> も拾う
    function scan(rootNode) {
        if (!ENABLED) { return 0; }
        var list = (rootNode || d).querySelectorAll('select'), n = 0, i;
        for (i = 0; i < list.length; i++) {
            if (list[i].getAttribute && list[i].getAttribute('data-ss') === 'off') { continue; }
            if (hook(list[i])) { n++; }
        }
        return n;
    }

    // あとから作られた <select>（設定画面など、開いた瞬間に組み立てる欄）を拾う。
    //
    // ★画面全体（body の subtree）を MutationObserver で見張る作りにしてはいけない。
    //   書き換えの多いパネルだと、DOMを1回いじるたびに見張りが動いて費用が積み上がり、
    //   パネルごと固まる。編集アシスタントの画面検査で実測：
    //   全体を見張る版は 20分たっても 103項目までしか進まず時間切れ、
    //   見張りを外した版は同じ時間で 455項目まで進んだ。
    //
    //   欄が増えるのは「ユーザーが何かを押したあと」（設定画面を開く等）なので、
    //   押されたときに一度だけ見に行けば足りる。ふだんの費用はゼロ。
    var scanPending = false;
    function scheduleScan() {
        if (scanPending || !root.setTimeout) { return; }
        scanPending = true;
        root.setTimeout(function () {
            scanPending = false;
            scan(d);
        }, 200);
    }

    // 画面のどこかが押された。一覧の外だったら閉じる
    function onDocDown(e) {
        if (!openSel) { return; }
        var t = e ? e.target : null;
        if (within(t, menu)) { return; }    // 一覧の中＝選ぼうとしている
        if (within(t, openSel)) { return; } // 開いている欄そのもの＝欄側で開閉を切り替える
        close();
    }

    // 2回呼ばれても平気にしておく（DOMContentLoaded と load の両方を待つため）。
    // 見張り役を二重に付けると、外側クリック1回で閉じる処理が2回走る
    var inited = false;
    function init() {
        if (!ENABLED) { return; }
        if (inited) { scan(d); return; }
        inited = true;
        scan(d);
        // 起動直後に中身を組み立てるパネルがあるので、少し遅れてもう一度だけ見に行く
        if (root.setTimeout) { root.setTimeout(function () { scan(d); }, 800); }
        // ★「外を押したら閉じる」は click ではなく mousedown で見る。
        //   click にすると、開くきっかけになった押し下げ（mousedown）と同じ1回の操作から
        //   遅れて飛んでくる click を「外を押した」と勘違いして、出した一覧を即座に閉じてしまう。
        //   （2026-08-10 実機で発覚。押した瞬間に出て、指を離すと消える。
        //     jsdomの検査は mousedown しか投げていなかったので素通りしていた）
        //   capture で受けるのは、途中の要素が伝播を止めていても必ず届かせるため。
        //   そのぶん「押した先が一覧の中／開いている欄そのもの」かを自分で見分ける。
        d.addEventListener('mousedown', onDocDown, true);
        d.addEventListener('click', scheduleScan);
        d.addEventListener('focusin', scheduleScan);
        // 開いたまま画面の大きさが変わると場所がズレる（パネルは自由に伸び縮みする）
        if (root.addEventListener) {
            root.addEventListener('resize', function () { if (openSel) { place(openSel, menu); } });
        }
        // 一覧を出したままスクロールされてもズレるので追従する
        d.addEventListener('scroll', function () { if (openSel) { place(openSel, menu); } }, true);
    }

    root.SmartSelect = {
        enabled: ENABLED,
        init: init,
        scan: scan,
        close: close,
        count: function () { return hooked.length; },
        // 検査から中身を覗くための入口（本番では使わない）
        _open: open,
        _menu: function () { return menu; }
    };

    if (ENABLED) {
        // 読み込みの段取りは環境によってまちまちなので、3通りとも受ける（init は2回目以降なにもしない）
        if (d.readyState === 'loading') {
            d.addEventListener('DOMContentLoaded', init);
            if (root.addEventListener) { root.addEventListener('load', init); }
        } else {
            init();
        }
    }
})(typeof window !== 'undefined' ? window : this);
