// 読み取り専用の比較スクリプト（入力ファイルは一切書き換えない）
// 基準＝Adobe CSV ／ 方式A＝CEP診断JSON（extract.js）／ 方式H＝read_project_texts.py の出力JSON
// 使い方: node compare3.js <csv> <diag.json> <h.json> <h_heads.json>
'use strict';
const fs = require('fs');
const X = require(process.env.HOME + '/KoseiMarker-textdiag/diag/extract.js');
const [csvPath, diagPath, hPath, headsPath] = process.argv.slice(2);

const TICKS = 254016000000;           // Premiere の1秒
const FPS_NUM = 30000, FPS_DEN = 1001; // 29.97

function tcToFrames(tc) {             // 29.97 DF（; 区切り）
    const m = /^(\d+)[:;](\d+)[:;](\d+)[:;.](\d+)$/.exec(tc);
    if (!m) return null;
    const hh = +m[1], mm = +m[2], ss = +m[3], ff = +m[4];
    const totalMin = hh * 60 + mm;
    const drop = /;/.test(tc) ? 2 * (totalMin - Math.floor(totalMin / 10)) : 0;
    return ((hh * 3600 + mm * 60 + ss) * 30 + ff) - drop;
}
const secToFrames = (s) => Math.round(s * FPS_NUM / FPS_DEN);

// ---- 基準
const csv = X.parseAdobeCsv(fs.readFileSync(csvPath, 'utf8'));
const base = csv.rows.map(r => ({ text: r.text, startF: tcToFrames(r.start), endF: tcToFrames(r.end), layer: r.layer }));

// ---- 方式A
const report = JSON.parse(fs.readFileSync(diagPath, 'utf8'));
const ext = X.extract(report);
const A = [];
const prov = {};
for (const g of ext.graphics) {
    for (const t of g.texts) {
        if (t.primary === false) continue;
        const key = `${t.origin}:${t.componentMatchName} / 「${t.paramDisplayName}」 / ${t.via}`;
        prov[key] = (prov[key] || 0) + 1;
        A.push({ text: t.text, track: g.trackLabel, startF: secToFrames(g.start.seconds), endF: secToFrames(g.end.seconds),
                 kind: g.type, comp: t.componentMatchName, param: t.paramDisplayName, clipName: g.clipName });
    }
}

// ---- 方式H
const hj = JSON.parse(fs.readFileSync(hPath, 'utf8'));
const H = hj.items.map(i => ({ text: i.text, track: 'V' + (i.track + 1), startF: Math.round(+i.start / (TICKS * FPS_DEN / FPS_NUM)),
                               endF: Math.round(+i.end / (TICKS * FPS_DEN / FPS_NUM)), layer: i.layer }));

// ---- 正規化
const NORM = {
    raw: s => s,                                                       // 何もしない（生の完全一致）
    nl: s => X.normalizeForCompare(s, { keepNewlines: true }),          // 改行コードを \n に統一（改行の位置は見る）
    nonl: s => X.normalizeForCompare(s, { keepNewlines: false })        // 改行を空白扱い（改行の有無を無視）
};

function cmp(mine, normName) {
    const nrm = NORM[normName];
    const bucket = new Map();
    for (const m of mine) { const k = nrm(m.text); if (!bucket.has(k)) bucket.set(k, []); bucket.get(k).push(m); }
    const matched = [], missing = [];
    for (const b of base) {
        const arr = bucket.get(nrm(b.text));
        if (arr && arr.length) matched.push({ base: b, mine: arr.shift() }); else missing.push(b);
    }
    const extra = [].concat(...bucket.values());
    const startOk = matched.filter(p => p.mine.startF === p.base.startF).length;
    const endOk = matched.filter(p => p.mine.endF === p.base.endF).length;
    return { count: mine.length, exact: matched.length, rate: (100 * matched.length / base.length).toFixed(1) + '%',
             missing: missing.length, extra: extra.length, startOk, endOk,
             missingEx: missing, extraEx: extra };
}

const fmtF = f => { const s = Math.floor(f / 30), ff = f % 30; return `00;00;${String(s).padStart(2, '0')};${String(ff).padStart(2, '0')}`; };
const short = s => JSON.stringify(s.slice(0, 20));

const out = { csv: { rows: base.length, header: csv.header, warnings: csv.warnings,
                     multiLine: base.filter(b => /\r|\n/.test(b.text)).length,
                     layerIds: [...new Set(base.map(b => b.layer))] },
              A: { diagnostics: ext.diagnostics, provenance: prov, rejectedCount: ext.rejected.length },
              H: { items: H.length, byLayer: H.reduce((o, h) => (o[h.layer] = (o[h.layer] || 0) + 1, o), {}) },
              results: {} };
for (const [name, mine] of [['A', A], ['H', H]]) {
    for (const n of Object.keys(NORM)) {
        const r = cmp(mine, n);
        out.results[name + '/' + n] = { count: r.count, exact: r.exact, rate: r.rate, missing: r.missing, extra: r.extra,
            startOk: r.startOk + '/' + r.exact, endOk: r.endOk + '/' + r.exact,
            missingEx: r.missingEx.slice(0, 6).map(b => `${short(b.text)} ${fmtF(b.startF)}`),
            extraEx: r.extraEx.slice(0, 6).map(m => `${short(m.text)} ${m.track} ${fmtF(m.startF)} ${m.comp || ('layer' + m.layer)} ${m.param || ''}`) };
    }
}

// ---- A と H のトラック・開始時刻の照合（CSV にはトラック列が無いので A↔H で見る）
const heads = JSON.parse(fs.readFileSync(headsPath, 'utf8'));
let pairClips = 0, trackStartSame = 0, headSame = 0, headTotal = 0;
const aTextClips = ext.graphics.filter(g => g.texts.some(t => t.componentMatchName === 'AE.ADBE Text'));
for (const it of heads.items) {
    const sf = Math.round(+it.start / (TICKS * FPS_DEN / FPS_NUM));
    const lab = 'V' + (it.track + 1);
    const g = aTextClips.find(g => g.trackLabel === lab && secToFrames(g.start.seconds) === sf);
    if (!g) continue;
    pairClips++; trackStartSame++;
    // A の1文字（UTF-16 の1単位）＝ FlatBuffer 先頭2バイト（ルートのオフセット）か？
    const aChars = [];
    const clip = report.tracks[g.trackIndex].clips[g.clipIndex];
    for (const c of clip.components) if (c.matchName === 'AE.ADBE Text') {
        const gv = c.params[0].calls.find(x => x.call === 'getValue()');
        aChars.push(gv && typeof gv.value === 'string' ? gv.value.charCodeAt(0) : null);
    }
    it.heads.forEach((h, i) => { headTotal++; if (h && aChars[i] === h.u16 && h.b2_3 === '0000') headSame++; });
}
out.AvsH = { hTextClips: heads.items.length, aTextClips: aTextClips.length, sameTrackAndStart: trackStartSame,
             flatbufferHeadMatch: headSame + '/' + headTotal,
             capsuleInPrproj: heads.capsule };
console.log(JSON.stringify(out, null, 1));
