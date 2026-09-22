# 読み取り専用: .prproj の各テキスト部品の「ソーステキスト」FlatBuffer 先頭4バイトを出す（方式Aの1文字と照合用）
import sys, re, json, base64, struct, importlib.util
spec = importlib.util.spec_from_file_location('rpt', '/Users/miyamotoryuuji/premiere-extensions/TelopSkin/tools/read_project_texts.py')
rpt = importlib.util.module_from_spec(spec); spec.loader.exec_module(rpt)
xml = rpt.load_xml(sys.argv[1]); want = sys.argv[2]
by_id, by_uid = rpt.split_objects(xml); blobs = rpt.build_blob_table(xml)
def blob_of(body):
    kv = re.search(r'<StartKeyframeValue Encoding="base64"[^>]*>([A-Za-z0-9+/=\s]*?)</StartKeyframeValue>', body, re.S)
    if kv and kv.group(1).strip(): return kv.group(1), False
    hm = re.search(r'<StartKeyframeValue Encoding="base64" BinaryHash="([0-9a-f-]+)"', body)
    if hm and hm.group(1) in blobs: return blobs[hm.group(1)], True
    return None, None
out = []
capsule = []
for uid, (tag, body) in by_uid.items():
    if tag != 'Sequence': continue
    nm = re.search(r'<Name>(.*?)</Name>', body, re.S)
    if not nm or rpt.unescape(nm.group(1)) != want: continue
    for gm in re.finditer(r'<Second ObjectRef="(\d+)"/>', body):
        vtg = by_id.get(gm.group(1))
        if not vtg or vtg[0] != 'VideoTrackGroup': continue
        for tm in re.finditer(r'<Track Index="(\d+)" Object(U?)Ref="([^"]+)"/>', vtg[1]):
            ti = int(tm.group(1)); trk = by_uid.get(tm.group(3)) if tm.group(2)=='U' else by_id.get(tm.group(3))
            if not trk: continue
            for im in re.finditer(r'<TrackItem Index="\d+" ObjectRef="(\d+)"/>', trk[1]):
                ent = by_id.get(im.group(1))
                if not ent or ent[0] != 'VideoClipTrackItem': continue
                b = ent[1]
                st = re.search(r'<Start>(-?\d+)</Start>', b); st = st.group(1) if st else '0'
                ch = re.search(r'<Components ObjectRef="(\d+)"/>', b)
                if not ch: continue
                chain = by_id.get(ch.group(1))
                heads = []
                for cm in re.finditer(r'<Component Index="\d+" ObjectRef="(\d+)"/>', chain[1]):
                    c = by_id.get(cm.group(1))
                    if not c or c[0] != 'VideoFilterComponent': continue
                    mn = re.search(r'<MatchName>(.*?)</MatchName>', c[1])
                    mn = mn.group(1) if mn else ''
                    if mn == 'AE.ADBE Capsule':
                        capsule.append({'track': ti, 'start': st, 'has37': '37' in c[1]})
                    if mn != 'AE.ADBE Text': continue
                    for pm in re.finditer(r'<Param Index="\d+" ObjectRef="(\d+)"/>', c[1]):
                        p = by_id.get(pm.group(1))
                        if not p or p[0] != 'ArbVideoComponentParam': continue
                        pn = re.search(r'<Name>(.*?)</Name>', p[1], re.S)
                        if not pn or rpt.unescape(pn.group(1)) not in rpt.SRC_TEXT_NAMES: continue
                        b64, viaHash = blob_of(p[1])
                        if b64 is None: heads.append(None); continue
                        raw = base64.b64decode(re.sub(r'\s','',b64))
                        heads.append({'u32': struct.unpack('<I', raw[:4])[0], 'u16': struct.unpack('<H', raw[:2])[0], 'b2_3': raw[2:4].hex(), 'len': len(raw), 'viaHash': viaHash, 'text': rpt.text_from_blob(b64)})
                if heads: out.append({'track': ti, 'start': st, 'heads': heads})
print(json.dumps({'items': out, 'capsule': capsule}, ensure_ascii=False))
