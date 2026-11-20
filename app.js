import * as C from './sp12core.js';
import * as DS from './drumsep.js';
import * as MX from './mixer.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const st = {
  files: [],          // {name,type,bytes,dirty,undo:[]}
  sp: null,           // index of active SP12
  sq: null,           // index of active SQ12
  X: null, pads: [], dir: [], regions: [], extra: new Map(), // extra: fileIndex -> Set(manual starts)
  region: 0, view: [0, 1], sel: null, bank: 4, padSel: null,
  hexFile: null, hexSel: null, seg: 0,
};
const rate = () => +$('#rateSel').value;
const spFile = () => st.files[st.sp];
const sqFile = () => st.files[st.sq];

// ---------- UI helpers ----------
const LS = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
const saveLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } };
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms); }
function led(txt) { $('#ledText').textContent = txt.toUpperCase(); }
function modal(html, buttons = [['OK', true]]) {
  return new Promise(res => {
    $('#modalBody').innerHTML = html; const bb = $('#modalBtns'); bb.innerHTML = '';
    buttons.forEach(([label, val, primary]) => { const b = document.createElement('button'); b.className = 'btn' + (primary ? ' primary' : ''); b.textContent = label; b.onclick = () => { $('#modal').hidden = true; res(val); }; bb.appendChild(b); });
    $('#modal').hidden = false; const inp = $('#modalBody input'); if (inp) inp.focus();
  });
}
function download(bytes, name, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const baseName = n => n.replace(/\.[^.]+$/, '');
const secs = n => (n / rate()).toFixed(3) + ' s';

// ---------- files ----------
async function openFiles(list) {
  for (const f of list) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const type = C.detectType(f.name, bytes);
    if (type === 'AUDIO') { await importAudioFile(f); continue; }
    const entry = { name: f.name, type, bytes, dirty: false, undo: [] };
    st.files.push(entry);
    const i = st.files.length - 1;
    if (type === 'SP12') { st.sp = i; st.extra.set(i, new Set()); st.region = 0; st.sel = null; refreshSP(true); }
    else { st.sq = i; st.seg = 0; refreshSQ(); }
    st.hexFile = i;
    led(`${type} ${baseName(f.name)}`);
  }
  refreshChrome();
}
function refreshChrome() {
  document.body.classList.toggle('has-SP12', st.sp != null);
  document.body.classList.toggle('has-SQ12', st.sq != null);
  document.body.classList.toggle('has-ANY', st.files.length > 0);
  $('#saveBtn').disabled = !st.files.length;
  const cur = st.files[st.hexFile];
  $('#undoBtn').disabled = !(cur && cur.undo.length);
  $('#fileChips').innerHTML = st.files.map((f, i) => `<span class="chip ${f.dirty ? 'dirty' : ''} ${i === st.sp || i === st.sq ? 'act' : ''}" data-i="${i}" title="${f.type}">${f.name.replace(/^[0-9a-f]{8}-/, '')}${f.dirty ? ' •' : ''}</span>`).join('');
  $$('#fileChips .chip').forEach(ch => ch.onclick = () => activate(+ch.dataset.i));
  $('#hexFile').innerHTML = st.files.map((f, i) => `<option value="${i}" ${i === st.hexFile ? 'selected' : ''}>${f.name}</option>`).join('');
  renderHex(); renderInfo(); if (st.files.length) renderPads(); if (typeof renderDiskFiles === 'function') renderDiskFiles();
  requestAnimationFrame(() => { if (st.sp != null) drawAll(); if (st.sq != null && st.M) drawGrid(); });
}
function activate(i) {
  const f = st.files[i]; st.hexFile = i; led(`${f.type} ${baseName(f.name)}`);
  if (f.type === 'SP12') { st.sp = i; if (!st.extra.has(i)) st.extra.set(i, new Set()); st.region = 0; refreshSP(true); }
  else { stopSeq(); st.sq = i; st.seg = 0; refreshSQ(); }
  refreshChrome();
}
function snapshot(fi) {
  const f = st.files[fi]; f.undo.push({ bytes: f.bytes.slice(), extra: new Set(st.extra.get(fi) || []) });
  if (f.undo.length > 40) f.undo.shift();
  f.dirty = true; st.hexFile = fi;
}
function undo() {
  const fi = st.hexFile, f = st.files[fi]; if (!f || !f.undo.length) return;
  const u = f.undo.pop(); f.bytes = u.bytes; f.dirty = f.undo.length > 0; if (f.type === 'SP12') st.extra.set(fi, u.extra);
  if (fi === st.sp) refreshSP(); if (fi === st.sq) refreshSQ(); refreshChrome(); toast('Undo');
}

// ---------- SP12 ----------
function refreshSP(resetView = false) {
  const f = spFile(); if (!f) return;
  st.X = C.decodeSamples(f.bytes);
  st.pads = C.parsePads(f.bytes); syncDesc();
  st.dir = C.parseRegionTable(f.bytes);
  st.mem = C.memInfo(f.bytes, st.X, st.pads, !!st.opt.rambo);
  const ex = st.extra.get(st.sp) || new Set();
  const R = C.findRegions(st.X, st.pads, st.dir, [...ex], st.mem);
  R.forEach(r => ex.add(r.start)); st.extra.set(st.sp, ex); // remember sound starts, so moving a truncate start keeps the sound
  st.padRes = R.res; st.regions = splitForced(R);
  if (st.region >= st.regions.length) st.region = 0;
  if (resetView) setRegion(st.region); else drawAll();
  renderRegions(); renderTrunc(); renderPads(); st.padBuf && st.padBuf.clear(); if (st.sq != null && st.M) drawGrid();
}
function cur() { return st.regions[st.region]; }
const bankBase = r => (st.mem && st.mem.sec[r.mbank] ? st.mem.sec[r.mbank].base : 0);
const memZones = () => st.opt.rambo ? (st.opt.zones || 8) : 2;
const memUsed = () => (st.regions || []).reduce((a, r) => a + (r.end - r.start) + C.FILLER, 0);
function setRegion(i) {
  st.region = i; const r = cur(); if (!r) return;
  st.view = [r.start, Math.max(r.start + 16, r.start + r.capacity)]; st.sel = null; renderRegions(); renderTrunc(); drawAll();
}
function renderRegions() {
  const used = C.usedEnd(st.X);
  $('#regions').innerHTML = st.regions.map((r, i) => {
    const pads = r.refs.map(p => `${(p >> 3) + 1}-${(p & 7) + 1}`).join(' '), loop = r.refs.some(pi => st.pads[pi].loop);
    const addr = r.start - bankBase(r);
    return `<li class="${i === st.region ? 'on' : ''}" data-i="${i}"><span class="nm">Sound ${i + 1}${loop ? ' ⟲' : ''}</span><span class="tag">${pads ? 'PAD ' + pads : r.source === 'Manuell' ? 'MANUAL' : ''}</span><span class="meta">Bank ${r.bank} @${addr} · ${r.end - r.start} smp · ${secs(r.end - r.start)}</span></li>`;
  }).join('');
  $$('#regions li').forEach(li => li.onclick = () => setRegion(+li.dataset.i));
  const cap = memZones() * C.BANK, total = Math.max(cap, st.X.length) * 1.0001;
  const cols = ['#ff5a36', '#ffb02e', '#5fd38d', '#4da3ff', '#c08bff', '#ff7aa8'];
  $('#memBar').innerHTML = st.regions.map((r, i) => `<i style="left:${r.start / total * 100}%;width:${r.capacity / total * 100}%;background:${cols[i % cols.length]}${i === st.region ? '' : '88'}"></i>`).join('') +
    (st.mem.base2 != null ? `<i style="left:${st.mem.base2 / total * 100}%;width:2px;background:#fff" title="bank 2"></i>` : '');
  const o = overInfo(), mt = $('#memText');
  mt.innerHTML = `${secs(memUsed())} / ${secs(cap)} used (${memZones()} × 2.5 s${st.opt.rambo ? ', Rambo' : ''})` + (o ? `<br><b class="warnTxt">⚠ over device memory${o.over ? `: ${secs(o.over)} too much` : ''}${o.long.length ? ` · pad ${o.long.map(padName).join(', ')} longer than 2.5 s (app only)` : ''}</b>` : '');
  if (typeof renderChop === 'function') renderChop();
}

// ---------- waveform ----------
const wave = $('#wave'), ov = $('#overview');
function fitCanvas(c) { const r = c.getBoundingClientRect(), d = devicePixelRatio || 1; c.width = Math.max(1, r.width * d); c.height = Math.max(1, r.height * d); return d; }
function drawAll() { drawWave(); drawOverview(); updateSelInfo(); }
function drawWave() {
  const r = cur(); const d = fitCanvas(wave), g = wave.getContext('2d'), W = wave.width, H = wave.height;
  g.clearRect(0, 0, W, H); if (!r) return;
  const [v0, v1] = st.view, spp = (v1 - v0) / W;
  g.strokeStyle = '#2b4a6b'; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
  // region bounds shading
  const xOf = s => (s - v0) / spp;
  g.fillStyle = 'rgba(255,255,255,.035)'; g.fillRect(xOf(r.end), 0, xOf(r.start + r.capacity) - xOf(r.end), H);
  if (st.sel) { g.fillStyle = 'rgba(216,50,43,.28)'; const a = xOf(Math.min(...st.sel)), b = xOf(Math.max(...st.sel)); g.fillRect(a, 0, Math.max(1, b - a), H); }
  g.strokeStyle = '#ffd27a'; g.lineWidth = Math.max(1, d * 0.9); g.beginPath();
  const X = st.X;
  for (let x = 0; x < W; x++) {
    const s = Math.floor(v0 + x * spp), e = Math.max(s + 1, Math.floor(v0 + (x + 1) * spp));
    let mn = 4095, mx = 0;
    for (let i = s; i < e && i < X.length; i++) { const v = X[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mx < mn) continue;
    const y1 = H - mx / 4095 * H, y2 = H - mn / 4095 * H;
    if (spp < 1) { x === 0 ? g.moveTo(x, y1) : g.lineTo(x, y1); } else { g.moveTo(x + .5, y1); g.lineTo(x + .5, Math.max(y2, y1 + 1)); }
  }
  g.stroke();
  g.fillStyle = '#ff3326'; g.fillRect(xOf(r.end) - 1, 0, 2, H);
  const tp = truncPad();
  if (tp != null) { const rs = st.padRes[tp], pd = st.pads[tp];
    if (pd.loop && rs.loopF != null) { g.fillStyle = 'rgba(80,170,255,.22)'; g.fillRect(xOf(rs.loopF), 0, xOf(rs.fstart + rs.len) - xOf(rs.loopF), H); g.fillStyle = '#5fb0ff'; g.fillRect(xOf(rs.loopF) - 1, 0, 2 * d, H); }
    g.fillStyle = '#5fd38d'; g.fillRect(xOf(rs.fstart) - 1, 0, 2 * d, H); g.fillRect(xOf(rs.fstart + rs.len) - 1, 0, 2 * d, H);
    g.font = `${10 * d}px ui-monospace,monospace`; g.fillText('S', xOf(rs.fstart) + 3 * d, H - 6 * d); g.fillText('E', xOf(rs.fstart + rs.len) - 10 * d, H - 6 * d);
    if (pd.loop && rs.loopF != null) { g.fillStyle = '#5fb0ff'; g.fillText('LOOP', xOf(rs.loopF) + 3 * d, H - 18 * d); }
  }
  g.fillStyle = '#9fb7cf'; g.font = `${11 * d}px ui-monospace,monospace`;
  g.fillText(`${v0}`, 6 * d, 14 * d); const t = `${Math.round(v1)}`; g.fillText(t, W - g.measureText(t).width - 6 * d, 14 * d);
}
function drawOverview() {
  const d = fitCanvas(ov), g = ov.getContext('2d'), W = ov.width, H = ov.height, X = st.X;
  g.clearRect(0, 0, W, H); const n = C.usedEnd(X) || 1, spp = n / W;
  g.fillStyle = '#5f7f9f';
  for (let x = 0; x < W; x++) {
    const s = Math.floor(x * spp), e = Math.floor((x + 1) * spp); let mn = 4095, mx = 0;
    for (let i = s; i < e; i += 4) { const v = X[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mx >= mn) g.fillRect(x, H - mx / 4095 * H, 1, Math.max(1, (mx - mn) / 4095 * H));
  }
  st.regions.forEach((r, i) => { g.fillStyle = i === st.region ? '#ffd27a' : '#9fb7cf'; g.fillRect(r.start / spp, 0, 1 * d, H); });
  g.strokeStyle = '#ff3326'; g.lineWidth = 1.5 * d; g.strokeRect(st.view[0] / spp, 1, Math.max(2, (st.view[1] - st.view[0]) / spp), H - 2);
}
function updateSelInfo() {
  const r = cur(); if (!r) return;
  $('#regionTitle').textContent = `Sound ${st.region + 1} · ${secs(r.end - r.start)} · ${r.end - r.start} smp`;
  $('#selInfo').textContent = st.sel ? `Sel ${Math.min(...st.sel)}–${Math.max(...st.sel)} (${Math.abs(st.sel[1] - st.sel[0])} smp)` : '';
}
function sampleAt(ev) { const b = wave.getBoundingClientRect(); const f = (ev.clientX - b.left) / b.width; return Math.round(st.view[0] + f * (st.view[1] - st.view[0])); }
const clampR = s => { const r = cur(); return Math.max(r.start, Math.min(r.start + r.capacity, s)); };
let dragging = false;
// the truncate / loop markers of the chosen pad, in samples (file positions)
function markers() { const tp = truncPad(); if (tp == null) return null; const rs = st.padRes[tp], pd = st.pads[tp]; return { S: rs.fstart, E: rs.fstart + rs.len, L: pd.loop && rs.loopF != null ? rs.loopF : null }; }
function markerAt(ev) {
  const m = markers(); if (!m) return null; const b = wave.getBoundingClientRect(), px = ev.clientX - b.left, spp = (st.view[1] - st.view[0]) / b.width;
  let best = null, bd = 7; ['L', 'S', 'E'].forEach(k => { if (m[k] == null) return; const d = Math.abs((m[k] - st.view[0]) / spp - px); if (d < bd) { bd = d; best = k; } });
  return best;
}
wave.addEventListener('pointerdown', e => {
  if (!cur()) return; const mk = markerAt(e); wave.setPointerCapture(e.pointerId);
  if (mk) { st.mDrag = mk; snapshot(st.sp); return; }
  dragging = true; const s = clampR(sampleAt(e)); st.sel = [s, s]; drawAll();
});
wave.addEventListener('pointermove', e => {
  if (st.mDrag) { moveMarker(st.mDrag, clampR(sampleAt(e))); return; }
  if (!dragging) { wave.style.cursor = markerAt(e) ? 'ew-resize' : ''; return; }
  st.sel[1] = clampR(sampleAt(e)); drawAll();
});
wave.addEventListener('pointerup', () => {
  if (st.mDrag) { st.mDrag = null; finishMarkers(); return; }
  dragging = false; drawAll();
});
wave.addEventListener('dblclick', () => { const r = cur(); st.sel = [r.start, r.end]; drawAll(); });
wave.addEventListener('wheel', e => {
  e.preventDefault(); const r = cur(); if (!r) return;
  const c = sampleAt(e), [v0, v1] = st.view, k = e.deltaY > 0 ? 1.25 : 0.8;
  let n0 = c - (c - v0) * k, n1 = c + (v1 - c) * k;
  const lo = r.start, hi = r.start + r.capacity;
  if (n1 - n0 > hi - lo) { n0 = lo; n1 = hi; } if (n1 - n0 < 32) return;
  if (n0 < lo) { n1 += lo - n0; n0 = lo; } if (n1 > hi) { n0 -= n1 - hi; n1 = hi; }
  st.view = [n0, n1]; drawAll();
}, { passive: false });
ov.addEventListener('click', e => {
  const b = ov.getBoundingClientRect(), s = (e.clientX - b.left) / b.width * C.usedEnd(st.X);
  const i = st.regions.findIndex(r => s >= r.start && s < r.start + r.capacity); if (i >= 0) setRegion(i);
});
addEventListener('resize', () => { if (st.sp != null) drawAll(); });

// ---------- truncate / loop (per pad, non-destructive) ----------
function truncPad() { const r = cur(); if (!r || !r.refs.length) return null; if (!r.refs.includes(st.tPad)) st.tPad = r.refs[0]; return st.tPad; }
function renderTrunc(live = false) {
  const r = cur(), tp = truncPad(), row = $('#truncRow'); if (!row) return;
  const m = markers(), [v0, v1] = st.view, fr = x => x == null ? 0 : Math.max(0, Math.min(1, (x - v0) / Math.max(1, v1 - v0)));
  if (m) { ['S', 'E', 'L'].forEach(k => { const el = $('#tf' + k); if (el && document.activeElement !== el) el.value = fr(m[k]); }); }
  ['S', 'E', 'L'].forEach(k => { const b = $('#tl' + k); if (b) { b.classList.toggle('on', st.mLearn === k); b.textContent = st.mLearn === k ? 'CC?' : st.mCC[k] ? 'CC ' + st.mCC[k].split(':')[1] : 'Learn'; } });
  if (live && tp != null) { const rs = st.padRes[tp], pd = st.pads[tp]; $('#tStart').value = rs.fstart - r.start; $('#tEnd').value = rs.fstart + rs.len - r.start; $('#tLoopS').value = pd.loop && rs.loopF != null ? rs.loopF - r.start : ''; $('#tInfo').textContent = `${secs(rs.len)}${pd.loop ? ` · Loop ${secs(rs.fstart + rs.len - rs.loopF)}` : ''}`; return; }
  row.querySelectorAll('input,select,button').forEach(el => el.disabled = tp == null);
  if (tp == null) { $('#tPad').innerHTML = ''; $('#tInfo').textContent = 'no pad'; return; }
  $('#tPad').innerHTML = r.refs.map(pi => `<option value="${pi}" ${pi === tp ? 'selected' : ''}>${padName(pi)}</option>`).join('');
  const rs = st.padRes[tp], pd = st.pads[tp];
  $('#tStart').value = rs.fstart - r.start; $('#tEnd').value = rs.fstart + rs.len - r.start;
  $('#tLoop').checked = !!pd.loop; $('#tLoopS').value = pd.loop && rs.loopF != null ? rs.loopF - r.start : '';
  const same = r.refs.filter(pi => st.pads[pi].start === pd.start && st.pads[pi].length === pd.length).map(padName);
  $('#tInfo').textContent = `${secs(rs.len)}${pd.loop ? ` · Loop ${secs(rs.fstart + rs.len - rs.loopF)}` : ''} · pads ${same.join(', ')}`;
}
// live: move one marker without a full refresh; the pad plays the new version at once
function moveMarker(k, s) {
  const r = cur(), tp = truncPad(); if (tp == null) return; const m = markers(), pd = st.pads[tp], base = bankBase(r);
  let S = m.S, E = m.E, L = m.L;
  if (k === 'S') S = Math.max(r.start, Math.min(E - 8, s)); else if (k === 'E') E = Math.max(S + 8, Math.min(r.start + r.capacity, s)); else L = Math.max(S, Math.min(E - 8, s));
  if (L != null) L = Math.max(S, Math.min(E - 8, L));
  const group = r.refs.filter(pi => st.pads[pi].start === pd.start && st.pads[pi].length === pd.length);
  group.forEach(pi => { const p = st.pads[pi], rs = st.padRes[pi]; p.start = S - base; p.length = E - S; rs.fstart = S; rs.len = E - S;
    if (p.loop && L != null) { p.loopStart = L - base; rs.loopF = L; } p.loopEdited = true; C.writePad(spFile().bytes, p); });
  spFile().dirty = true; st.padBuf.clear(); drawWave(); renderTrunc(true);
}
function finishMarkers() { const keep = [...st.view], tp = st.tPad, reg = st.region; refreshSP(); st.region = reg; st.tPad = tp; st.view = keep; renderRegions(); renderTrunc(); drawAll(); refreshChrome(); }
// sliders and MIDI faders: Start / End / Loop; the slider range is the visible part of the wave (zoom in = finer)
function setMarkerFrac(k, f) { const [v0, v1] = st.view; if (k === 'L' && !(markers() || {}).L) return; if (!st.mSnap) { snapshot(st.sp); st.mSnap = setTimeout(() => { st.mSnap = null; finishMarkers(); }, 700); } else { clearTimeout(st.mSnap); st.mSnap = setTimeout(() => { st.mSnap = null; finishMarkers(); }, 700); } moveMarker(k, Math.round(v0 + f * (v1 - v0))); }
st.mLearn = null; st.mCC = LS('sp12markcc', {});   // { S: 'ch:cc', E: ..., L: ... }
function markerCC(ch, cc, val) {
  const key = `${ch}:${cc}`;
  if (st.mLearn) { Object.keys(st.mCC).forEach(k => { if (st.mCC[k] === key) delete st.mCC[k]; }); st.mCC[st.mLearn] = key; saveLS('sp12markcc', st.mCC); toast(`${{ S: 'Start', E: 'End', L: 'Loop' }[st.mLearn]} → MIDI CC ${cc} (ch ${ch + 1})`); st.mLearn = null; renderTrunc(); return true; }
  const k = Object.keys(st.mCC).find(k => st.mCC[k] === key); if (!k || st.sp == null) return false;
  setMarkerFrac(k, val / 127); flashLcd(`${{ S: 'START', E: 'END', L: 'LOOP' }[k]} ${(markers() || {})[k] - cur().start}`); return true;
}
function applyTrunc(startRel, endRel, loopOn, loopRel) {
  const r = cur(), tp = truncPad(); if (tp == null) return;
  const pd = st.pads[tp], base = bankBase(r), maxRel = r.capacity;
  startRel = Math.max(0, Math.min(maxRel - 8, Math.round(startRel))); endRel = Math.max(startRel + 8, Math.min(maxRel, Math.round(endRel)));
  if (loopOn) { loopRel = loopRel == null || isNaN(loopRel) ? startRel + Math.floor((endRel - startRel) / 2) : Math.round(loopRel); loopRel = Math.max(startRel, Math.min(endRel - 8, loopRel)); }
  snapshot(st.sp);
  const group = r.refs.filter(pi => st.pads[pi].start === pd.start && st.pads[pi].length === pd.length);
  group.forEach(pi => { const p = st.pads[pi]; p.start = r.start + startRel - base; p.length = endRel - startRel;
    p.loop = !!loopOn; if (loopOn) p.loopStart = r.start + loopRel - base; p.loopEdited = true; C.writePad(spFile().bytes, p); });
  refreshSP(); renderTrunc(); refreshChrome();
}
$('#tPad').onchange = e => { st.tPad = +e.target.value; renderTrunc(); drawAll(); if (!st.chop.file) { st.chop.marks = []; renderChop(); } };
['#tStart', '#tEnd', '#tLoopS'].forEach(id => $(id).onchange = () => applyTrunc(+$('#tStart').value, +$('#tEnd').value, $('#tLoop').checked, +$('#tLoopS').value));
$('#tLoop').onchange = () => applyTrunc(+$('#tStart').value, +$('#tEnd').value, $('#tLoop').checked, $('#tLoopS').value === '' ? null : +$('#tLoopS').value);
$('#tFromSel').onclick = () => { const r = cur(); if (!st.sel || Math.abs(st.sel[1] - st.sel[0]) < 8) { toast('Select a range in the wave first.'); return; } applyTrunc(Math.min(...st.sel) - r.start, Math.max(...st.sel) - r.start, $('#tLoop').checked, $('#tLoopS').value === '' ? null : +$('#tLoopS').value); };
$('#tLoopCur').onclick = () => { const r = cur(); if (!st.sel) { toast('Click a position in the wave first.'); return; } applyTrunc(+$('#tStart').value, +$('#tEnd').value, true, Math.min(...st.sel) - r.start); };
// transients in a 12-bit sound: energy rise in 5 ms hops, at least 50 ms apart, each moved back to a quiet point just before the hit
function transients(x, sens = 0.5) {
  const R = rate(), hop = Math.max(32, Math.round(R * 0.005)), nh = Math.floor(x.length / hop); if (nh < 3) return [];
  const e = new Float32Array(nh); for (let h = 0; h < nh; h++) { let a = 0; for (let i = h * hop; i < (h + 1) * hop; i++) a += Math.abs(x[i] - 2048); e[h] = a / hop; }
  const peak = Math.max(1, ...e), gap = Math.round(R * 0.05 / hop), out = []; let last = -1e9;
  for (let h = 1; h < nh; h++) { const prev = Math.max(e[h - 1], h > 1 ? e[h - 2] : 0, peak * 0.01), rise = (e[h] - prev) / peak;
    if (rise > 0.3 * (1.05 - sens) && e[h] > peak * 0.06 && h - last >= gap) { last = h; let s = h * hop, best = s, bv = 1e9; for (let i = Math.max(0, s - hop * 2); i <= s; i++) { const v = Math.abs(x[i] - 2048); if (v <= bv) { bv = v; best = i; } } out.push(best); } }
  return out;
}
function hitFrom(list, pos, dir) { return dir > 0 ? list.find(t => t > pos + 16) : [...list].reverse().find(t => t < pos - 16); }
// Trim: start / end to the previous / next transient of the sound
function trimJump(k, dir) {
  const r = cur(), m = markers(); if (!r || !m) { toast('No pad on this sound.'); return; }
  const base = r.start, T = transients(st.X.subarray(base, base + r.capacity)).map(t => t + base).filter(t => k === 'E' ? t > m.S + 64 : t < m.E - 64), pos = m[k];
  let t = hitFrom(T, pos, dir); if (t == null) t = k === 'E' && dir > 0 ? r.start + r.capacity : k === 'S' && dir < 0 ? r.start : null;
  if (t == null) { toast('No further transient.'); return; }
  snapshot(st.sp); moveMarker(k, t); finishMarkers(); flashLcd(`${k === 'S' ? 'START' : 'END'} ${t - base}`);
}
$$('[data-tj]').forEach(b => b.onclick = () => trimJump(b.dataset.tj[0], b.dataset.tj[1] === '+' ? 1 : -1));

// ---- long samples (app only, over 2.5 s): own little editor with start / end, transient jumps, truncate ----
st.long = null;
function longX(p) { const d = st.padWav.get(p).getChannelData(0), x = new Uint16Array(d.length); for (let i = 0; i < d.length; i++) x[i] = Math.max(0, Math.min(4095, Math.round(d[i] * 2048 + 2048))); return x; }
function renderLong(p) {
  const box = $('#longRow'); if (!box) return;
  if (p == null) p = st.long && st.padWav.has(st.long.p) ? st.long.p : [...st.padWav.keys()].find(q => st.padWav.get(q).length > C.MAXSND);
  if (p == null || !st.padWav.has(p)) { box.hidden = true; st.long = null; return; }
  if (!st.long || st.long.p !== p) { const x = longX(p); st.long = { p, x, S: 0, E: x.length, T: transients(x) }; }
  box.hidden = false; const L = st.long; if ($('#lCap').checked && L.E - L.S > C.MAXSND - 5) L.E = L.S + C.MAXSND - 5;
  $('#lInfo').textContent = `Pad ${padName(p)} · app only · ${secs(L.x.length)} → ${secs(L.E - L.S)}${L.E - L.S <= C.MAXSND - 5 ? ' ✓ fits SP-12' : ''}`;
  const cv = $('#longWave'), d = fitCanvas(cv), g = cv.getContext('2d'), W = cv.width, H = cv.height, x = L.x, spp = x.length / W;
  g.fillStyle = '#13202e'; g.fillRect(0, 0, W, H); g.fillStyle = 'rgba(77,163,255,.15)'; g.fillRect(L.S / spp, 0, (L.E - L.S) / spp, H);
  g.strokeStyle = '#ffd27a'; g.beginPath();
  for (let px = 0; px < W; px++) { let mn = 4095, mx = 0; for (let i = Math.floor(px * spp); i < Math.floor((px + 1) * spp) && i < x.length; i++) { if (x[i] < mn) mn = x[i]; if (x[i] > mx) mx = x[i]; } if (mx < mn) continue; g.moveTo(px + .5, H - mx / 4095 * H); g.lineTo(px + .5, H - mn / 4095 * H + 1); }
  g.stroke(); g.fillStyle = 'rgba(255,255,255,.25)'; L.T.forEach(t => g.fillRect(t / spp, H - 6 * d, d, 6 * d));
  g.fillStyle = '#5fd38d'; g.fillRect(L.S / spp - d, 0, 2 * d, H); g.fillStyle = '#ff3326'; g.fillRect(L.E / spp - d, 0, 2 * d, H);
}
function longSet(k, v) { const L = st.long; if (!L) return; const cap = $('#lCap').checked ? C.MAXSND - 5 : Infinity; v = Math.max(0, Math.min(L.x.length, Math.round(v)));
  if (k === 'S') { L.S = Math.min(v, L.E - 64); if (L.E - L.S > cap) L.E = L.S + cap; } else { L.E = Math.max(v, L.S + 64); if (L.E - L.S > cap) L.S = L.E - cap; } renderLong(L.p); }
function longPlay() { const L = st.long; if (!L) return; const c = ctx(), seg = L.x.subarray(L.S, L.E), buf = c.createBuffer(1, seg.length, rate()), dd = buf.getChannelData(0); for (let i = 0; i < seg.length; i++) dd[i] = (seg[i] - 2048) / 2048;
  if (st.longSrc) try { st.longSrc.stop(); } catch (e) { } const s = c.createBufferSource(); s.buffer = buf; s.connect(c.destination); s.start(); st.longSrc = s; }
{ const cv = $('#longWave'); let drag = null; const at = e => { const b = cv.getBoundingClientRect(); return (e.clientX - b.left) / b.width * st.long.x.length; };
  if (cv) { cv.addEventListener('pointerdown', e => { if (!st.long) return; cv.setPointerCapture(e.pointerId); const v = at(e); drag = Math.abs(v - st.long.S) < Math.abs(v - st.long.E) ? 'S' : 'E'; longSet(drag, v); });
    cv.addEventListener('pointermove', e => { if (drag) longSet(drag, at(e)); }); cv.addEventListener('pointerup', () => { drag = null; }); } }
$$('[data-lj]').forEach(b => b.onclick = () => { const L = st.long; if (!L) return; const k = b.dataset.lj[0], dir = b.dataset.lj[1] === '+' ? 1 : -1;
  let t = hitFrom(L.T.filter(t => k === 'E' ? t > L.S + 64 : t < L.E - 64), L[k], dir); if (t == null) t = k === 'E' && dir > 0 ? L.x.length : k === 'S' && dir < 0 ? 0 : null; if (t == null) { toast('No further transient.'); return; } longSet(k, t); });
$('#lPlay').onclick = longPlay;
$('#lCap').onchange = e => { st.opt.trimCap = e.target.checked; saveLS('sp12opt', st.opt); renderLong(); };
queueMicrotask(() => { $('#lCap').checked = st.opt.trimCap !== false; });
$('#lTrunc').onclick = () => {
  const L = st.long; if (!L) return; const p = L.p, x = L.x.slice(L.S, L.E);
  if (x.length <= C.MAXSND - 5) { st.long = null; commitSample(x, p, 0, null, `Pad ${padName(p)} truncated → SP-12 memory (${secs(x.length)})`); renderLong(); renderPads(); return; }
  st.long = null; longToPad(x, p, `Pad ${padName(p)}`); renderLong(p);
};
['S', 'E', 'L'].forEach(k => {
  $('#tf' + k).oninput = e => setMarkerFrac(k, +e.target.value);
  $('#tl' + k).onclick = () => { st.mLearn = st.mLearn === k ? null : k; if (st.mLearn && !st.midi.access) midiInit(true); renderTrunc(); if (st.mLearn) toast('Move a control on your MIDI controller …'); };
});
// chop panel
function chopPadOptions(sel, def) {
  const el = $(sel); if (!el) return; const v = el.value || def;
  el.innerHTML = Array.from({ length: 32 }, (_, p) => `<option value="${p}">${padName(p)} ${st.padRes && st.padRes[p] ? '· sample' : st.pads && st.pads[p] && !C.isEmptyPad(st.pads[p]) ? '· ROM' : '· empty'}</option>`).join(''); el.value = v;
}
$('#chEven').onclick = () => evenChops(Math.max(2, Math.min(32, +$('#chN').value || 8)));
$('#chAuto').onclick = () => autoChops(Math.max(2, Math.min(32, +$('#chN').value || 16)), +$('#chSens').value);
$('#chClear').onclick = () => { st.chop.marks = []; renderChop(); };
$('#chPadSrc').onclick = () => { st.chop.file = null; st.chop.marks = []; renderChop(); };
$('#chFile').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { const x = await decodeAudio(f); st.chop.file = { name: f.name, x: Uint16Array.from(x) }; st.chop.marks = []; renderChop(); toast(`${f.name}: ${secs(x.length)} loaded`); } catch (err) { toast('Could not read the audio.'); } };
$('#chGo').onclick = makeChops;
['#chTo', '#chRom'].forEach(id => $(id).onchange = () => renderChop());
$('#cpGo').onclick = () => { const tp = truncPad(); if (tp == null) { toast('Pick a pad with a sample first.'); return; } copySound(tp, +$('#cpTo').value); };
queueMicrotask(() => { $('#rambo').checked = !!st.opt.rambo; $('#zones').value = String(st.opt.zones || 8); });
$('#rambo').onchange = e => { st.opt.rambo = e.target.checked; saveLS('sp12opt', st.opt); if (st.sp != null) refreshSP(true); renderChop(); toast(st.opt.rambo ? 'Rambo: all pads RAM, ' + memZones() + ' × 2.5 s – file format not verified on hardware' : 'Turbo: 2 × 2.5 s'); };
$('#zones').onchange = e => { st.opt.zones = +e.target.value; saveLS('sp12opt', st.opt); if (st.sp != null) refreshSP(true); };
{
  const cv = $('#chopWave');
  cv.addEventListener('pointerdown', e => {
    const src = chopSource(); if (!src) return; cv.setPointerCapture(e.pointerId);
    const idx = chopIndexAt(e);
    if (e.shiftKey) { const B = chopBounds(src); let i = 0; while (i < B.length - 2 && idx >= B[i + 1]) i++; chopAudition(i); return; }
    const k = chopMarkNear(e);
    if (k >= 0) st.chop.drag = { k, moved: false }; else { st.chop.marks.push(idx); renderChop(); }
  });
  cv.addEventListener('pointermove', e => { const d = st.chop.drag; if (!d) { cv.style.cursor = chopMarkNear(e) >= 0 ? 'ew-resize' : 'crosshair'; return; } st.chop.marks[d.k] = chopIndexAt(e); d.moved = true; renderChop(); });
  cv.addEventListener('pointerup', () => { const d = st.chop.drag; if (d && !d.moved) st.chop.marks.splice(d.k, 1); st.chop.drag = null; renderChop(); });
}
$('#tClear').onclick = () => { const p = st.padSel ?? truncPad(); if (p == null) { toast('Hit or pick a pad first.'); return; } clearPad(p); };
$('#sDel').onclick = deleteSound;
$('#tLoad').onchange = e => { const f = e.target.files[0]; e.target.value = ''; const p = st.padSel ?? truncPad(); if (!f) return; if (p == null) { toast('Hit a pad first, then load.'); return; } loadAudioToPad(f, p); };
$('#tPlay').onclick = () => { const tp = truncPad(); if (tp != null) hitSound(tp, 1, 0, null, +$('#pitch').value); };

// ---------- edit ops ----------
function range() {
  const r = cur(); if (st.sel && Math.abs(st.sel[1] - st.sel[0]) > 1) return [Math.min(...st.sel), Math.max(...st.sel)];
  return [r.start, r.end];
}
function guardStarts() { // keep the 0x800 start markers of following sounds unambiguous
  const X = st.X, f = spFile();
  st.regions.forEach(r => { if (r.start < 3) return; for (let i = r.start - 3; i < r.start; i++) if (X[i] === 2048) { X[i] = 2050; C.encodeSamples(X, f.bytes, C.L.SAMPLES, i, i + 1); } });
}
function commit(a, b) { guardStarts(); C.encodeSamples(st.X, spFile().bytes, C.L.SAMPLES, a, b); spFile().dirty = true; drawAll(); refreshChrome(); }
const OPS = {
  normalize(a, b, X) { let p = 1; for (let i = a; i < b; i++) p = Math.max(p, Math.abs(X[i] - 2048)); const k = 2047 / p; for (let i = a; i < b; i++) X[i] = q(2048 + (X[i] - 2048) * k); },
  gainUp(a, b, X) { gain(a, b, X, 1.4125); }, gainDown(a, b, X) { gain(a, b, X, 0.7079); },
  reverse(a, b, X) { X.subarray(a, b).reverse(); },
  fadeIn(a, b, X) { const n = b - a; for (let i = 0; i < n; i++) X[a + i] = q(2048 + (X[a + i] - 2048) * (i / n)); },
  fadeOut(a, b, X) { const n = b - a; for (let i = 0; i < n; i++) X[a + i] = q(2048 + (X[a + i] - 2048) * (1 - i / n)); },
  silence(a, b, X) { X.fill(2048, a, b); },
};
const q = v => Math.max(0, Math.min(4095, Math.round(v)));
function gain(a, b, X, k) { for (let i = a; i < b; i++) X[i] = q(2048 + (X[i] - 2048) * k); }
$$('[data-op]').forEach(btn => btn.onclick = () => {
  const r = cur(); if (!r) return; const op = btn.dataset.op;
  snapshot(st.sp);
  if (op === 'truncate') {
    if (!st.sel) { toast('Mark a position in the sound first.'); spFile().undo.pop(); return; }
    const e = Math.max(...st.sel); if (e <= r.start + 8) { spFile().undo.pop(); return; }
    st.X.fill(2050, e, r.start + r.capacity);
    C.encodeSamples(st.X, spFile().bytes, C.L.SAMPLES, e, r.start + r.capacity);
    r.refs.forEach(pi => { const p = st.pads[pi], fs0 = st.padRes[pi].fstart; if (e > fs0 + 4) { p.length = e - fs0; if (p.loop && p.loopStart >= p.start + p.length) { p.loop = false; p.loopEdited = true; } C.writePad(spFile().bytes, p); } });
    st.sel = null; refreshSP(); refreshChrome(); toast(`Sample end at ${e - r.start}${r.refs.length ? ', pad lengths adjusted' : ''}`); return;
  }
  let [a, b] = range();
  if (a === r.start && !st.sel && op !== 'silence') a = Math.min(r.start + 5, b); // keep leading padding
  OPS[op](a, b, st.X); commit(a, b);
});

// ---------- audio ----------
let actx = null, src = null;
function ctx() { if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended' && !(window.OfflineAudioContext && actx instanceof OfflineAudioContext)) actx.resume(); return actx; }
function play(a, b, semis = +$('#pitch').value, gain = 1) {
  stop(); if (b <= a) return;
  const c = ctx(), X = st.X, srcRate = rate() * Math.pow(2, semis / 12);
  let buf;
  if ($('#zoh').checked) { // nearest-neighbour hold at device rate – the SP-12's drop-sample sound
    const n = Math.ceil((b - a) / srcRate * c.sampleRate); buf = c.createBuffer(1, n, c.sampleRate); const d = buf.getChannelData(0), step = srcRate / c.sampleRate;
    for (let i = 0; i < n; i++) d[i] = (X[a + Math.min(b - a - 1, Math.floor(i * step))] - 2048) / 2048;
  } else {
    const r0 = Math.max(3000, Math.min(192000, Math.round(srcRate)));
    buf = c.createBuffer(1, b - a, r0); const d = buf.getChannelData(0); for (let i = 0; i < b - a; i++) d[i] = (X[a + i] - 2048) / 2048;
  }
  src = c.createBufferSource(); src.buffer = buf; const gn = c.createGain(); gn.gain.value = gain; src.connect(gn); gn.connect(c.destination); src.start();
}
function stop() { try { src && src.stop(); } catch (e) { } src = null; }
$('#playBtn').onclick = () => { const r = cur(); r && play(r.start, r.end); };
$('#playSelBtn').onclick = () => { const [a, b] = range(); play(a, b); };
$('#stopBtn').onclick = stop;
$('#pitch').oninput = e => $('#pitchOut').textContent = `${e.target.value} st`;

// ---------- Chop mode: copy a sound to another pad, chop a sound or an audio file onto free pads ----------
// The current memory as a list of sounds (every region, with the pads that play it), for rebuildSP
function soundList() {
  const b = spFile().bytes;
  return st.regions.map(r => ({ data: st.X.slice(r.start, r.end), pref: r.mbank, refs: r.refs.map(pi => { const rs = st.padRes[pi], pd = st.pads[pi];
    return { pad: pi, off: rs.fstart - r.start, len: rs.len, loopOff: pd.loop && rs.loopF != null ? rs.loopF - r.start : null, first: Array.from(b.slice(C.FIRSTTAB + 10 * pi, C.FIRSTTAB + 10 * pi + 10)) }; }) }));
}
// pads in `targets` lose their old sound; sounds no pad plays any more (and that had pads before) are dropped
function rebuildWith(newSounds, targets, label, extra = {}) {
  const f = spFile(), T = new Set(targets);
  // a ROM pad that gets a RAM sound: remember its factory record, so "Pad leeren" can give it back
  st.romBak = st.romBak || new Map(); const bak = st.romBak.get(f) || {}; st.romBak.set(f, bak);
  newSounds.forEach(s => s.refs.forEach(r => { if (!st.padRes[r.pad] && !bak[r.pad] && !C.isEmptyPad(st.pads[r.pad])) bak[r.pad] = f.bytes.slice(C.L.PADREC + 10 * r.pad, C.L.PADREC + 10 * r.pad + 10); }));
  let list = soundList().map((s, i) => ({ ...s, i, had: s.refs.length > 0, refs: s.refs.filter(r => !T.has(r.pad)) })).filter(s => (s.refs.length || !s.had) && s.i !== extra.drop);
  list = list.concat(newSounds);
  const erase = extra.erase || [], restore = {}; erase.forEach(n => { if (bak[n]) { restore[n] = bak[n]; delete bak[n]; } });
  let out; try { out = C.rebuildSP(f.bytes, st.pads, list, { rambo: !!st.opt.rambo, zones: st.opt.zones || 8, overflow: extra.overflow !== false, erase, restore }); } catch (e) { toast(e.message, 6000); return false; }
  snapshot(st.sp); f.bytes = out.bytes; f.dirty = true; st.extra.set(st.sp, new Set());
  refreshSP(true); refreshChrome(); toast(label, 5000); return true;
}
const SIL5 = () => new Uint16Array(5).fill(2048);
function withSilence(x) { // a sound starts with 5 silent words (the SP-12 plays from there)
  let k = 0; while (k < 5 && k < x.length && x[k] === 2048) k++;
  if (k >= 5) return { data: x, pre: 0 }; const d = new Uint16Array(x.length + 5); d.set(SIL5()); d.set(x, 5); return { data: d, pre: 5 };
}
function copySound(srcPad, dstPad) {
  const rs = st.padRes[srcPad], pd = st.pads[srcPad]; if (!rs) { toast('The source pad has no sample.'); return; }
  if (srcPad === dstPad) { toast('Source and target are the same pad.'); return; }
  const w = withSilence(st.X.slice(rs.fstart, rs.fstart + rs.len));
  const ref = { pad: dstPad, off: 0, len: w.data.length, loopOff: pd.loop && rs.loopF != null ? rs.loopF - rs.fstart + w.pre : null, desc0: pd.sound, tuneIdx: pd.tune >> 3,
    first: Array.from(spFile().bytes.slice(C.FIRSTTAB + 10 * srcPad, C.FIRSTTAB + 10 * srcPad + 10)) };
  rebuildWith([{ data: w.data, pref: null, refs: [ref] }], [dstPad], `Pad ${padName(srcPad)} → ${padName(dstPad)} copied` + overNote());
}
// chop source: the chosen pad's sound (as truncated) or a loaded audio file
st.chop = { src: null, marks: [], view: null };
function chopSource() {
  if (st.chop.file) return st.chop.file;
  const tp = truncPad(); if (tp == null) return null; const rs = st.padRes[tp];
  return { name: `Pad ${padName(tp)}`, pad: tp, x: st.X.slice(rs.fstart, rs.fstart + rs.len) };
}
function chopBounds(src) { const n = src.x.length, m = [...new Set(st.chop.marks.filter(v => v > 16 && v < n - 16).map(Math.round))].sort((a, b) => a - b); return [0, ...m, n]; }
function evenChops(n) { const src = chopSource(); if (!src) return; const len = src.x.length; st.chop.marks = Array.from({ length: Math.max(0, n - 1) }, (_, i) => Math.round(len * (i + 1) / n)); renderChop(); }
// transients: energy rise in 5 ms hops, minimum gap 60 ms, the strongest ones, each moved back to a quiet point just before the hit
function autoChops(maxN, sens) {
  const src = chopSource(); if (!src) return; const x = src.x, R = rate(), hop = Math.max(32, Math.round(R * 0.005)), nh = Math.floor(x.length / hop);
  const e = new Float32Array(nh); for (let h = 0; h < nh; h++) { let a = 0; for (let i = h * hop; i < (h + 1) * hop; i++) a += Math.abs(x[i] - 2048); e[h] = a / hop; }
  const peak = Math.max(1, ...e), cand = [];
  for (let h = 2; h < nh; h++) { const prev = Math.max(e[h - 1], e[h - 2], peak * 0.01), rise = (e[h] - prev) / peak; if (rise > 0.35 * (1.05 - sens) && e[h] > peak * 0.08 * (1.05 - sens)) cand.push({ h, rise }); }
  const gap = Math.round(R * 0.06 / hop), pick = [];
  cand.sort((a, b) => b.rise - a.rise).forEach(c => { if (pick.length < maxN - 1 && pick.every(p => Math.abs(p - c.h) >= gap) && c.h * hop > R * 0.02) pick.push(c.h); });
  st.chop.marks = pick.sort((a, b) => a - b).map(h => { let s = h * hop, best = s, bv = 1e9; for (let i = Math.max(0, s - hop * 2); i <= s; i++) { const v = Math.abs(x[i] - 2048); if (v <= bv) { bv = v; best = i; } } return best; });
  renderChop(); toast(`${st.chop.marks.length + 1} chops`);
}
function chopTargets() {
  const start = +($('#chTo') && $('#chTo').value || 24), rom = $('#chRom') && $('#chRom').checked, list = [];
  for (let k = 0; k < 32; k++) { const p = (start + k) % 32; if (st.padRes[p]) continue; if (!rom && !st.opt.rambo && p < 24 && !C.isEmptyPad(st.pads[p])) continue; list.push(p); }
  return list;
}
function makeChops() {
  const src = chopSource(); if (!src) { toast('No chop source: pick a pad with a sample or load a file.'); return; }
  const B = chopBounds(src), n = B.length - 1, targets = chopTargets();
  if (!targets.length) { toast('No free pads. Allow ROM pads or clear some pads.', 6000); return; }
  const k = Math.min(n, targets.length);
  let chops = []; for (let i = 0; i < k; i++) chops.push(src.x.slice(B[i], B[i + 1]));
  const fit = $('#chFit').checked, cap = memZones() * C.BANK, free = cap - memUsed();
  const needOf = L => L.reduce((a, c) => a + c.length + 5 + C.FILLER, 0);
  const trimTo = (L, m) => L.map(c => { if (c.length <= m) return c; const t = c.slice(0, m), fl = Math.min(256, m >> 2); for (let i = 0; i < fl; i++) { const g = 1 - (i + 1) / fl, j = m - fl + i; t[j] = Math.round(2048 + (t[j] - 2048) * g); } return t; });
  if (chops.some(c => c.length > C.MAXSND)) { if (!fit) { toast('A chop is longer than 2.5 s. Turn on “fit memory”.', 6000); return; } chops = trimTo(chops, C.MAXSND); }
  if (needOf(chops) > free) {
    if (!fit) { toast(`Not enough memory: ${secs(needOf(chops))} needed, ${secs(Math.max(0, free))} free.`, 6000); return; }
    const orig = chops; let lo = 64, hi = Math.max(...orig.map(c => c.length));
    while (hi - lo > 16) { const m = (lo + hi) >> 1; if (needOf(trimTo(orig, m)) <= free) lo = m; else hi = m; }
    chops = trimTo(orig, lo); if (needOf(chops) > free) { toast('No memory left.', 5000); return; }
  }
  const srcPd = src.pad != null ? st.pads[src.pad] : null, desc0 = srcPd ? srcPd.sound : null;
  const out = +$('#chOut').value & 7;   // all chops on one output (default 8): monophonic, each cuts the last – the SP-12 chop way
  const sounds = chops.map((c, i) => { const w = withSilence(c); return { data: w.data, pref: null, refs: [{ pad: targets[i], off: 0, len: w.data.length, loopOff: null, desc0: (((desc0 ?? st.pads[targets[i]].sound) & 0x78) | out), tuneIdx: 16 }] }; });
  for (let tries = 0; tries < 6; tries++) {
    if (rebuildWith(sounds, targets.slice(0, k), `${k} chops → pads ${targets.slice(0, k).map(padName).join(' ')}${k < n ? ` (${n - k} without a free pad)` : ''}${fit && chops.some((c, i) => c.length < B[i + 1] - B[i]) ? ' · shortened to fit' : ''}`)) { st.chop.marks = []; st.chop.file = null; renderChop(); return; }
    if (!fit) return; sounds.forEach(s => { const m = Math.floor(s.data.length * 0.9); s.data = s.data.slice(0, m); s.refs[0].len = m; });
  }
}
// the chop panel's own wave: click = marker, click on a marker = remove it, drag = move, Shift + click = audition that chop
function renderChop() {
  const cv = $('#chopWave'); if (!cv) return; chopPadOptions('#chTo', '24'); chopPadOptions('#cpTo', '31'); const src = st.sp != null ? chopSource() : null;
  $('#chSrc').textContent = src ? `${src.name} · ${secs(src.x.length)} · ${chopBounds(src).length - 1} chops` : 'no source';
  $('#chMem').textContent = st.sp != null ? `${secs(Math.max(0, memZones() * C.BANK - memUsed()))} free · ${chopTargets().length} free pads` : '';
  const d = fitCanvas(cv), g = cv.getContext('2d'), W = cv.width, H = cv.height; g.clearRect(0, 0, W, H); if (!src) return;
  const x = src.x, spp = x.length / W; g.strokeStyle = '#ffd27a'; g.beginPath();
  for (let px = 0; px < W; px++) { let mn = 4095, mx = 0; for (let i = Math.floor(px * spp); i < Math.floor((px + 1) * spp) && i < x.length; i++) { if (x[i] < mn) mn = x[i]; if (x[i] > mx) mx = x[i]; } if (mx < mn) continue; g.moveTo(px + .5, H - mx / 4095 * H); g.lineTo(px + .5, Math.max(H - mn / 4095 * H, H - mx / 4095 * H + 1)); }
  g.stroke(); const B = chopBounds(src), T = chopTargets();
  g.font = `${10 * d}px ui-monospace,monospace`;
  for (let i = 0; i < B.length - 1; i++) { const a = B[i] / spp; g.fillStyle = i % 2 ? 'rgba(255,255,255,.05)' : 'rgba(77,163,255,.10)'; g.fillRect(a, 0, (B[i + 1] - B[i]) / spp, H); g.fillStyle = '#cfe0f0'; g.fillText(`${i + 1}${T[i] != null ? ' → ' + padName(T[i]) : ' ✕'}`, a + 3 * d, 12 * d); }
  g.fillStyle = '#ff3326'; B.slice(1, -1).forEach(v => g.fillRect(v / spp - d, 0, 2 * d, H));
}
function chopIndexAt(ev) { const cv = $('#chopWave'), b = cv.getBoundingClientRect(), src = chopSource(); return src ? Math.round((ev.clientX - b.left) / b.width * src.x.length) : 0; }
function chopMarkNear(ev) { const cv = $('#chopWave'), b = cv.getBoundingClientRect(), src = chopSource(); if (!src) return -1; const spp = src.x.length / b.width; return st.chop.marks.findIndex(v => Math.abs(v / spp - (ev.clientX - b.left)) < 6); }
function chopAudition(i) {
  const src = chopSource(); if (!src) return; const B = chopBounds(src), c = ctx(), seg = src.x.slice(B[i], B[i + 1]); if (!seg.length) return;
  const buf = c.createBuffer(1, seg.length, rate()), dd = buf.getChannelData(0); for (let k = 0; k < seg.length; k++) dd[k] = (seg[k] - 2048) / 2048;
  const s = c.createBufferSource(); s.buffer = buf; s.connect(c.destination); s.start();
}
// ---- delete / load single sounds ----
function clearPad(p) {
  if (st.padWav.has(p)) { st.padWav.delete(p); st.padBuf.clear(); renderPads(); toast(`Pad ${padName(p)}: app sound removed`); if (!st.padRes[p]) return; }
  if (st.sp == null) return; const pd = st.pads[p];
  if (!st.padRes[p] && C.isEmptyPad(pd)) { toast(`Pad ${padName(p)} is empty.`); return; }
  const bak = st.romBak && st.romBak.get(spFile()) && st.romBak.get(spFile())[p];
  rebuildWith([], [p], bak ? `Pad ${padName(p)}: ROM sound back` : `Pad ${padName(p)} cleared`, { erase: [p] });
}
async function deleteSound() {
  const r = cur(); if (!r) return; const pads = r.refs.map(padName).join(', ');
  const ok = await modal(`<p>Delete sound ${st.region + 1} (${secs(r.end - r.start)})?${pads ? `<br>Pads cleared: <b>${pads}</b>` : ''}</p>`, [['Cancel', null], ['Delete', 'ok', true]]);
  if (ok !== 'ok') return;
  rebuildWith([], r.refs, `Sound deleted${pads ? ' · pads ' + pads + ' cleared' : ''}`, { erase: r.refs, drop: st.region });
}
// an audio file (WAV, MP3, AIFF …) onto one pad: converted to 12 bit / 26.04 kHz mono. Up to 2.5 s it goes into the sample
// memory (even beyond the SP-12's physical memory, marked as such); longer files play only in the app and become the chop source.
async function loadAudioToPad(file, p) {
  if (st.sp == null) { toast('Open a .SP12 file first (or create a new one).'); return; }
  let x; try { x = await decodeAudio(file); } catch (e) { toast(`${file.name}: could not be read.`); return; }
  if (!x.length) { toast(`${file.name}: silence only.`); return; }
  if (x.length > C.MAXSND) { longToPad(x, p, file.name); return; }
  const w = withSilence(Uint16Array.from(x)), pd = st.pads[p];
  st.padWav.delete(p);
  rebuildWith([{ data: w.data, pref: null, refs: [{ pad: p, off: 0, len: w.data.length, loopOff: null, desc0: st.padRes[p] ? pd.sound : (pd.sound & 0x07), tuneIdx: 16 }] }], [p],
    `${file.name} → Pad ${padName(p)} (${secs(x.length)})` + overNote());
}
// longer than 2.5 s: lives on the pad in the app only (not in the SP-12 file) and becomes the chop source
function longToPad(x, p, name) {
  const c = ctx(), buf = c.createBuffer(1, x.length, rate()), dd = buf.getChannelData(0); for (let i = 0; i < x.length; i++) dd[i] = (x[i] - 2048) / 2048;
  st.padWav.set(p, buf); st.padBuf.clear(); st.chop.file = { name, x: Uint16Array.from(x) }; st.chop.marks = []; renderPads(); renderChop(); if (st.X) renderRegions(); renderLong(p);
  toast(`${name}: ${secs(x.length)} – longer than 2.5 s: plays on pad ${padName(p)} in the app only (chop it or squeeze to send to the SP-12).`, 8000);
}
// beyond the SP-12's physical memory? (app overflow banks, or more than the Turbo / Rambo capacity)
function overInfo() {
  if (st.sp == null || !st.mem) return null;
  const over = (st.mem.over || []).reduce((a, b) => a + st.mem.sec[b].free, 0), long = [...st.padWav.keys()].filter(p => st.padWav.get(p).length > C.MAXSND);
  return over || long.length ? { over, long } : null;
}
const overNote = () => { setTimeout(() => { const o = overInfo(); if (o) toast(`⚠ Over device memory by ${secs(o.over)}.`, 7000); }, 50); return ''; };
async function decodeAudio(file) {
  const ab = await file.arrayBuffer(); const c = ctx();
  const buf = await c.decodeAudioData(ab.slice(0));
  const n = Math.max(1, Math.round(buf.duration * rate()));
  const off = new OfflineAudioContext(1, n, rate());
  const s = off.createBufferSource(); s.buffer = buf; s.connect(off.destination); s.start();
  const out = await off.startRendering();
  let x = C.floatTo12(out.getChannelData(0)), a = 0, b = x.length;
  while (a < b && Math.abs(x[a] - 2048) <= 2) a++; while (b > a && Math.abs(x[b - 1] - 2048) <= 2) b--;
  return x.subarray(a, b);
}
async function importAudioFile(file) {
  if (st.sp == null) { toast('Open a .SP12 file first.'); return; }
  const choice = await modal(`<p>Import <b>${file.name}</b>: into sound ${st.region + 1} or as a new sound?</p>`, [['Cancel', null], ['Append', 'append'], [`In Sound ${st.region + 1}`, 'replace', true]]);
  if (choice === 'replace') return replaceWithAudio(file);
  if (choice === 'append') return appendAudio(file);
}
async function replaceWithAudio(file, given = null) {
  const r = cur(); if (!r) return;
  let smp = given; if (!smp) try { smp = await decodeAudio(file); } catch (e) { toast('Could not read the audio.'); return; }
  const room = r.capacity - 5 - 9; let n = smp.length;
  if (n > room) { n = room; toast(`Too long – cut to ${secs(room)}.`, 4000); }
  snapshot(st.sp);
  const X = st.X; X.fill(2048, r.start, r.start + 5); X.fill(2050, r.start + 5, r.start + r.capacity);
  X.set(smp.subarray(0, n), r.start + 5);
  C.encodeSamples(X, spFile().bytes, C.L.SAMPLES, r.start, r.start + r.capacity); guardStarts();
  const base = bankBase(r);
  r.refs.forEach(pi => { const p = st.pads[pi]; p.start = r.start - base; p.length = 5 + n; if (p.loop) { p.loop = false; p.loopEdited = true; } C.writePad(spFile().bytes, p); });
  refreshSP(true); refreshChrome(); toast(`${file ? file.name : 'MIDI-Sample'} → Sound ${st.region + 1} (${secs(n)})`);
}
async function appendAudio(file, given = null) {
  let smp = given; if (!smp) try { smp = await decodeAudio(file); } catch (e) { toast('Could not read the audio.'); return; }
  const m = st.mem, len = 5 + smp.length, f = spFile();
  // bank 2 exists: append behind its data. Otherwise append in bank 1 (bank 2 would have to be created first).
  let fileIdx, bank, addr;
  if (m.base2 != null) { bank = 2; addr = m.free2; fileIdx = m.base2 + addr; }
  else { bank = 1; addr = m.free1 || C.usedEnd(st.X); fileIdx = addr; }
  if (addr + len + 9 > C.BANK) { toast(`No room in bank ${bank}: ${secs(Math.max(0, C.BANK - addr - 9))} free, ${secs(len)} needed.`, 5000); return; }
  if (fileIdx < C.usedEnd(st.X) - 4) { toast('There is data behind this sound – cannot append here.', 5000); return; }
  snapshot(st.sp);
  f.bytes = C.resizeForSamples(f.bytes, fileIdx + len + 12);
  const X = C.decodeSamples(f.bytes);
  for (let i = C.usedEnd(st.X); i < fileIdx; i++) X[i] = 2050;
  X.fill(2048, fileIdx, fileIdx + 5); X.set(smp, fileIdx + 5); X.fill(2050, fileIdx + len, fileIdx + len + 9);
  C.encodeSamples(X, f.bytes); C.setPages(f.bytes);
  C.setLe16(f.bytes, bank === 2 ? 0x289 : 0x28B, addr + len + 9); // next free address of the bank
  st.extra.get(st.sp).add(fileIdx);
  refreshSP(); setRegion(Math.max(0, st.regions.findIndex(r => r.start === fileIdx))); refreshChrome();
  const ok = await modal(`<p>New sound in bank ${bank} @${addr} (${secs(smp.length)}).</p><label>Assign to pad (e.g. 4-6)<input id="padAssign" placeholder="4-6"></label>`, [['Skip', null], ['Assign', 'ok', true]]);
  const v = (document.getElementById('padAssign') || {}).value;
  if (ok === 'ok' && /^[1-4]-[1-8]$/.test(v || '')) {
    const pi = (+v[0] - 1) * 8 + (+v[2] - 1), p = st.pads[pi]; snapshot(st.sp);
    p.tune = (p.tune & 0xF8) | (bank === 2 ? 6 : 7);               // descriptor byte 1 bits 2-0 = memory bank (RAM 7 / 6)
    p.start = addr; p.length = len; p.loop = false; p.loopEdited = true; C.writePad(f.bytes, p); refreshSP(); refreshChrome(); toast(`Pad ${v} → Bank ${bank} @${addr}`);
  }
}
$('#wavReplace').onchange = e => { const f = e.target.files[0]; e.target.value = ''; f && replaceWithAudio(f); };
$('#wavAppend').onchange = e => { const f = e.target.files[0]; e.target.value = ''; f && appendAudio(f); };
$('#expWav').onclick = () => { const r = cur(); if (!r) return; download(C.encodeWav(st.X, r.start, r.end, rate()), `${baseName(spFile().name)}_sound${st.region + 1}.wav`, 'audio/wav'); };
$('#expAll').onclick = async () => { for (let i = 0; i < st.regions.length; i++) { const r = st.regions[i]; download(C.encodeWav(st.X, r.start, r.end, rate()), `${baseName(spFile().name)}_sound${i + 1}.wav`, 'audio/wav'); await new Promise(r => setTimeout(r, 350)); } };
$('#expMem').onclick = () => download(C.encodeWav(st.X, 0, C.usedEnd(st.X), rate()), `${baseName(spFile().name)}_speicher.wav`, 'audio/wav');
$('#splitBtn').onclick = () => {
  if (!st.sel) { toast('Click a position in the wave first.'); return; }
  let s = Math.min(...st.sel), found = -1;
  for (let d = 0; d < 64 && found < 0; d++) { if (C.validStart(st.X, s - d, st.X.length)) found = s - d; else if (C.validStart(st.X, s + d, st.X.length)) found = s + d; }
  if (found >= 0) st.extra.get(st.sp).add(found);
  else { forcedSet().add(s); found = s; toast('No sound start here – split is view/export only.', 4200); }
  refreshSP(); setRegion(Math.max(0, st.regions.findIndex(r => r.start === found)));
};
function forcedSet() { st.forcedBy = st.forcedBy || new Map(); if (!st.forcedBy.has(st.sp)) st.forcedBy.set(st.sp, new Set()); return st.forcedBy.get(st.sp); }
function splitForced(R) {
  const pts = [...forcedSet()]; if (!pts.length) return R;
  const out = [];
  R.forEach(r => {
    const inside = pts.filter(p => p > r.start && p < r.start + r.capacity).sort((a, b) => a - b);
    let s = r.start; [...inside, r.start + r.capacity].forEach((e, k) => {
      out.push({ ...r, start: s, capacity: e - s, end: k === 0 ? Math.min(r.end, e) : e, refs: r.refs.filter(pi => st.padRes[pi] && st.padRes[pi].fstart >= s && st.padRes[pi].fstart < e), source: k === 0 ? r.source : 'Manuell' }); s = e;
    });
  });
  return out.map((r, i) => ({ ...r, id: i }));
}
$('#unsplitBtn').onclick = () => {
  const r = cur(); if (!r) return; const ex = st.extra.get(st.sp);
  if (ex.has(r.start) || forcedSet().has(r.start)) { ex.delete(r.start); forcedSet().delete(r.start); refreshSP(); setRegion(Math.max(0, st.region - 1)); }
  else toast('Nur manuelle Markierungen lassen sich entfernen.');
};
$('#autoSplitBtn').onclick = () => {
  const c = C.autoSplitCandidates(st.X, st.regions); c.forEach(s => st.extra.get(st.sp).add(s));
  refreshSP(); toast(c.length ? `${c.length} more sound starts found` : 'No more sound starts found');
};

// ---------- pads ----------
function padIsUser(p) { return !!(st.padRes && st.padRes[p.index]); }
const NEXTMODE = { tune: 'decay', decay: 'mix', mix: 'multi', multi: 'none', none: 'tune' };  // 'none' = no LED lit, faders inactive (like the SP-12)
st.fmode = 'mix'; st.multi = { kind: 'pitch', src: null }; st.fader = 0;
// Multi mode: the 8 pads are 8 "slots" of one sound. The note parameter's high nibble stores the slot as one of 8 values.
const SLOTVAL = [5, 7, 9, 11, 12, 13, 14, 15];
const slotOf = h => { let k = SLOTVAL.indexOf(h); if (k < 0) { k = 0; SLOTVAL.forEach((v, i) => { if (Math.abs(v - h) < Math.abs(SLOTVAL[k] - h)) k = i; }); } return k; };
st.multiPitch = LS('sp12mpitch', [-7, -5, -3, -1, 1, 3, 5, 7]);           // semitones per slot
st.multiLevel = LS('sp12mlevel', SLOTVAL.map(v => v / 15));               // gain per slot
function faderValue(p) {
  if (st.fmode === 'tune') return st.padMode[p] === 'decay' ? 16 / 31 : tuneIdx(p) / 31;
  if (st.fmode === 'decay') return decayIdx(p) / 31;
  if (st.fmode === 'none') return 0.5;
  if (st.fmode === 'multi') { const k = p & 7; return st.multi.kind === 'pitch' ? (st.multiPitch[k] + st.opt.tuneRange) / (2 * st.opt.tuneRange) : st.multiLevel[k]; }
  return st.sp != null && st.pads[p] ? 1 - ((st.pads[p].sound >> 3) & 15) / 15 : st.mix[p];
}
function setFader(p, v01, fromUser = true) {
  v01 = Math.max(0, Math.min(1, v01));
  if (st.fmode === 'none') return;
  if (st.fmode === 'tune' || st.fmode === 'decay') {
    if (st.sp == null) { toast('Tune/decay needs a .SP12.'); return; }
    // the SP-12 keeps one value per sound: its tuning (tune mode) or its decay (decay mode); moving the other fader switches the mode
    const pd = st.pads[p], dm = st.fmode === 'decay' ? 0x80 : 0, nv = (Math.round(v01 * 31) << 3) | (pd.tune & 7), nb0 = (pd.sound & 0x7F) | dm;
    if (pd.tune === nv && pd.sound === nb0) return;
    if (!st.tuneSnap) { snapshot(st.sp); st.tuneSnap = setTimeout(() => st.tuneSnap = null, 800); }
    if (pd.sound !== nb0) flashLcd(dm ? `${padName(p)} DECAY MODE` : `${padName(p)} TUNE MODE`);
    pd.tune = nv; pd.sound = nb0; st.padMode[p] = dm ? 'decay' : 'tune'; C.writePad(spFile().bytes, pd); spFile().dirty = true; st.padBuf.clear(); refreshChrome();
  } else if (st.fmode === 'mix') {
    const pd = st.sp != null && st.pads[p];
    if (pd) { const red = Math.round((1 - v01) * 15); if (((pd.sound >> 3) & 15) === red) return;
      if (!st.tuneSnap) { snapshot(st.sp); st.tuneSnap = setTimeout(() => st.tuneSnap = null, 800); }
      pd.sound = (pd.sound & 0x87) | (red << 3); C.writePad(spFile().bytes, pd); spFile().dirty = true; refreshChrome(); }
    else { st.mix[p] = v01; saveLS('sp12mix', st.mix); } }
  else { const k = p & 7;
    if (st.multi.kind === 'pitch') { st.multiPitch[k] = Math.round((v01 * 2 - 1) * st.opt.tuneRange * 4) / 4; saveLS('sp12mpitch', st.multiPitch); }
    else { st.multiLevel[k] = v01; saveLS('sp12mlevel', st.multiLevel); } }
}
function faderText(p) {
  if (st.fmode === 'tune') { const i = tuneIdx(p); return st.padMode[p] === 'decay' ? `${padName(p)} TUNE (DECAY MODE)` : `${padName(p)} TUNE ${i > 16 ? '+' : ''}${Math.round(12 * Math.log2(pitchRatio(i)))} ST`; }
  if (st.fmode === 'decay') { const i = decayIdx(p); return `${padName(p)} DECAY ${i} · ${decaySecs(i)} S${st.padMode[p] === 'decay' ? '' : ' (DEFAULT)'}`; }
  if (st.fmode === 'multi') { const k = p & 7; return st.multi.kind === 'pitch' ? `MULTI ${k + 1} ${st.multiPitch[k] >= 0 ? '+' : ''}${st.multiPitch[k]} ST` : `MULTI ${k + 1} LEVEL ${Math.round(st.multiLevel[k] * 100)}`; }
  if (st.fmode === 'none') return 'FADERS OFF';
  return st.sp != null && st.pads[p] ? `${padName(p)} MIX ${31 - 2 * ((st.pads[p].sound >> 3) & 15)}` : `${padName(p)} MIX ${Math.round(st.mix[p] * 100)}`;
}
function renderPads() {
  const perf = $('#perf'), bank = st.bank;
  const leds = [4, 3, 2, 1].map(b => `<span data-b="${b}" class="${b === bank ? 'on' : ''}"><i></i>${b}</span>`).join('');
  const modes = [['tune', st.fmode === 'decay' ? 'Tune/<b>Decay</b>' : st.fmode === 'tune' ? '<b>Tune</b>/Decay' : 'Tune/Decay'], ['mix', 'Mix'], ['multi', 'Multi Mode']].map(([k, l]) => `<span data-m="${k}" class="${st.fmode === k || (k === 'tune' && st.fmode === 'decay') ? 'on' : ''}"><i></i>${l}</span>`).join('');
  let html = `<div class="selCol"><div class="leds">${modes}</div><button class="btn" id="modeSel">Mode</button>
    ${st.fmode === 'multi' ? `<button class="btn ghost" id="multiKind">${st.multi.kind === 'pitch' ? 'Multi Pitch' : 'Multi Level'}</button>` : ''}
    <div class="leds" style="margin-top:8px">${leds}</div><button class="btn" id="bankSel">Select</button></div>`;
  for (let k = 0; k < 8; k++) {
    const p = (bank - 1) * 8 + k, dis = st.fmode === 'none';
    const lab = st.fmode === 'tune' ? (st.padMode[p] === 'decay' ? '(DK)' : 'TUNE') : st.fmode === 'decay' ? (st.padMode[p] === 'decay' ? 'DECAY' : '(DEF)') : st.fmode === 'mix' ? 'MIX' : st.fmode === 'none' ? '' : st.multi.kind === 'pitch' ? `${st.multiPitch[k] >= 0 ? '+' : ''}${st.multiPitch[k]}` : 'LVL';
    html += `<div class="fader ${st.fader === k ? 'cur' : ''}"><input type="range" min="0" max="1" step="0.004" value="${faderValue(p)}" data-p="${p}" ${dis ? 'disabled' : ''} title="${padName(p)} ${lab}"><small>${k + 1}${lab ? ' · ' + lab : ''}</small></div>`;
  }
  for (let k = 0; k < 8; k++) {
    const p = (bank - 1) * 8 + k, pd = st.pads[p], user = pd && padIsUser(pd);
    const leg = b => `<em class="${b === bank ? 'on' : ''}">${LEGEND[b - 1][k]}</em>`;
    html += `<div class="padCol"><div class="legend">${leg(4)}${leg(3)}</div><div class="pad ${user ? 'user' : ''} ${pd && C.isEmptyPad(pd) ? 'padEmpty' : ''} ${st.padSel === p ? 'sel' : ''}" data-p="${p}" title="Pad ${padName(p)}${pd ? ' · Sound ' + C.hex(pd.sound) + ' · Tune ' + C.hex(pd.tune) : ''}"></div><div class="legend">${leg(2)}${leg(1)}</div><select class="padOut" data-p="${p}" title="Output (Channel Assign)">${Array.from({ length: 8 }, (_, o) => `<option value="${o}" ${st.padOut[p] === o ? 'selected' : ''}>Out ${o + 1}</option>`).join('')}</select></div>`;
  }
  perf.innerHTML = html;
  perf.querySelectorAll('.padOut').forEach(sel => sel.onchange = () => setOut(+sel.dataset.p, +sel.value));
  renderOuts();
  perf.querySelectorAll('.leds span[data-b]').forEach(sp => sp.onclick = () => { st.bank = +sp.dataset.b; renderPads(); });
  perf.querySelectorAll('.leds span[data-m]').forEach(sp => sp.onclick = () => setMode(sp.dataset.m));
  $('#bankSel').onclick = () => { st.bank = st.bank % 4 + 1; renderPads(); };
  $('#modeSel').onclick = () => setMode(NEXTMODE[st.fmode]);
  if ($('#multiKind')) $('#multiKind').onclick = toggleMultiKind;
  perf.querySelectorAll('.fader input').forEach(f => { f.oninput = () => { st.fader = (+f.dataset.p) & 7; setFader(+f.dataset.p, +f.value); flashLcd(faderText(+f.dataset.p)); }; f.onchange = () => renderPads(); });
  perf.querySelectorAll('.pad').forEach(el => {
    el.onpointerdown = e => { if (e.button !== 0) return; if (e.altKey) { clearPad(+el.dataset.p); return; } hitPad(+el.dataset.p); };
    el.ondragover = e => { e.preventDefault(); e.stopPropagation(); el.classList.add('dropOn'); };
    el.ondragleave = () => el.classList.remove('dropOn');
    el.ondrop = e => { e.preventDefault(); e.stopPropagation(); el.classList.remove('dropOn'); dragDepth = 0; $('#drop').classList.remove('on'); const f = [...e.dataTransfer.files][0]; if (f) loadAudioToPad(f, +el.dataset.p); };
  });
  $('#tuneRange').value = st.opt.tuneRange; $('#noteParams').checked = st.opt.noteParams; $('#hiMode').value = st.opt.hiMode || 'level';
  $('#gTune').value = st.opt.gTune || 0; $('#gTuneOut').textContent = `${(st.opt.gTune || 0) > 0 ? '+' : ''}${st.opt.gTune || 0} st`; $('#gDecay').value = defaultDecay(); $('#gDecayOut').textContent = `${defaultDecay()} · ${decaySecs(defaultDecay())} s`;
  const t = $('#padTable');
  t.innerHTML = `<tr><th>Pad</th><th>Name</th><th>Desc 0</th><th>Desc 1</th><th>Mode</th><th>Decay</th><th>Out</th><th>Start</th><th>Length</th><th>Time</th><th>Loop bytes</th><th>Status</th></tr>` +
    st.pads.map(p => { const vp = voiceParams(p.index); return `<tr class="${padIsUser(p) ? 'user' : ''}" data-p="${p.index}">
      <td>${p.bank}-${p.pad}</td><td>${legendOf(p.index)}</td>
      <td><input data-k="sound" value="${C.hex(p.sound)}"></td>
      <td><input data-k="tune" value="${C.hex(p.tune)}" title="${st.padMode[p.index] === 'tune' ? 'Index ' + vp.idx + ' · ' + (vp.semis >= 0 ? '+' : '') + vp.semis.toFixed(1) + ' st' : 'Decay ' + vp.idx}"></td>
      <td><select data-m="1"><option value="tune" ${st.padMode[p.index] === 'tune' ? 'selected' : ''}>Tune</option><option value="decay" ${st.padMode[p.index] === 'decay' ? 'selected' : ''}>Decay</option></select></td>
      <td><input data-d="1" type="number" min="0" max="31" value="${decayIdx(p.index)}" style="width:56px" title="${st.padMode[p.index] === 'decay' ? 'own decay (decay mode)' : 'default decay – typing switches to decay mode'} · ${decaySecs(decayIdx(p.index))} s"></td>
      <td><select data-o="1">${Array.from({ length: 8 }, (_, o) => `<option value="${o}" ${st.padOut[p.index] === o ? 'selected' : ''}>${o + 1}</option>`).join('')}</select></td>
      <td><input data-k="start" value="${p.start}"></td>
      <td><input data-k="length" value="${p.length}"></td>
      <td>${secs(p.length)}</td>
      <td class="raw">${p.extra.map(x => C.hex(x)).join(' ')}</td>
      <td>${padIsUser(p) ? 'RAM' : C.isEmptyPad(p) ? 'empty' : 'ROM → MIDI'}</td></tr>`; }).join('');
  $$('#padTable input[data-k]').forEach(inp => inp.onchange = () => {
    const p = st.pads[+inp.closest('tr').dataset.p], k = inp.dataset.k;
    const v = (k === 'sound' || k === 'tune') ? parseInt(inp.value, 16) : parseInt(inp.value, 10);
    const max = (k === 'sound' || k === 'tune') ? 255 : 65535;
    if (!(v >= 0 && v <= max)) { toast('Invalid value'); inp.value = k === 'sound' || k === 'tune' ? C.hex(p[k]) : p[k]; return; }
    snapshot(st.sp); p[k] = v; C.writePad(spFile().bytes, p); refreshSP(); refreshChrome();
  });
  $$('#padTable select[data-m]').forEach(sel => sel.onchange = () => setMode18(+sel.closest('tr').dataset.p, sel.value));
  $$('#padTable select[data-o]').forEach(sel => sel.onchange = () => setOut(+sel.closest('tr').dataset.p, +sel.value));
  $$('#padTable input[data-d]').forEach(inp => inp.onchange = () => { const p = +inp.closest('tr').dataset.p, pd = st.pads[p]; if (!pd || st.sp == null) return; writeDesc(p, pd.sound | 0x80, (Math.max(0, Math.min(31, +inp.value || 0)) << 3) | (pd.tune & 7)); st.padMode[p] = 'decay'; renderPads(); });
}
function toggleMultiKind() { st.multi.kind = st.multi.kind === 'pitch' ? 'level' : 'pitch'; if (st.fmode !== 'multi') setMode('multi'); else { renderPads(); led('MULTI ' + (st.multi.kind === 'pitch' ? 'PITCH' : 'LEVEL')); } }
function setMode(m) {
  if (m === 'multi') { st.multi.src = st.padSel != null ? st.padSel : (st.bank - 1) * 8; toast(`Multi: pad ${padName(st.multi.src)} on all 8 pads (${st.multi.kind === 'pitch' ? 'pitch' : 'level'})`); }
  st.fmode = m; renderPads(); led(m === 'tune' ? 'TUNE' : m === 'decay' ? 'DECAY' : m === 'mix' ? 'MIX' : m === 'none' ? 'FADERS OFF' : 'MULTI ' + (st.multi.kind === 'pitch' ? 'PITCH' : 'LEVEL'));
}
$('#tuneRange').onchange = e => { st.opt.tuneRange = +e.target.value; saveLS('sp12opt', st.opt); st.padBuf.clear(); renderPads(); };
$('#noteParams').onchange = e => { st.opt.noteParams = e.target.checked; saveLS('sp12opt', st.opt); };
$('#hiMode').onchange = e => { st.opt.hiMode = e.target.value; saveLS('sp12opt', st.opt); };
$('#gTune').oninput = e => { st.opt.gTune = +e.target.value; $('#gTuneOut').textContent = `${st.opt.gTune > 0 ? '+' : ''}${st.opt.gTune} st`; saveLS('sp12opt', st.opt); st.padBuf.clear(); };
$('#gDecay').oninput = e => { // Default Decay: into the .SP12 (Set-up 19), like the SP-12
  const v = +e.target.value; st.opt.gDecay = v; saveLS('sp12opt', st.opt); $('#gDecayOut').textContent = `${v} · ${decaySecs(v)} s`;
  if (st.sp != null) { const b = spFile().bytes; if ((b[0x28E] & 31) !== v) { if (!st.ddSnap) { snapshot(st.sp); st.ddSnap = setTimeout(() => st.ddSnap = null, 800); } b[0x28E] = v; spFile().dirty = true; refreshChrome(); } } };
function hitPad(i, fromKey = false, when = 0) {
  if (!when && st.samp && st.samp.on && st.samp.lazy) { lazyPad(i); return; }   // Lazy Chop: the pad press starts the next sample
  let p = i, gain = 1, semis = 0, slot = null;
  if (st.fmode === 'multi' && st.multi.src != null) { // the 8 pads of the bank play one sound at 8 pitches or 8 levels
    slot = i & 7; p = st.multi.src;
    if (st.multi.kind === 'pitch') semis = st.multiPitch[slot]; else gain = st.multiLevel[slot];
  }
  st.padSel = i; st.bank = (i >> 3) + 1; st.fader = i & 7;
  if (!when && $('#tFollow') && $('#tFollow').checked && st.padRes && st.padRes[p] && st.tPad !== p) { // the sample editor follows the pad
    const fs = st.padRes[p].fstart, ri = st.regions.findIndex(r => fs >= r.start && fs < r.start + r.capacity);
    if (ri >= 0) { if (ri !== st.region) setRegion(ri); st.tPad = p; renderTrunc(); drawAll(); if (!st.chop.file) st.chop.marks = []; renderChop(); } }
  if (!when && st.padWav.has(p) && $('#tFollow') && $('#tFollow').checked) renderLong(p);
  const pd = st.pads[p];
  if (st.sp == null && !st.padWav.has(p)) { midiNote(p, gain * st.mix[p], 0); }
  else hitSound(p, gain, when, null, semis);
  if (st.rec) recordHit(p, slot, when);
  if (!fromKey && pd && padSource(p) === 'midi' && !st.midi.out && !C.isEmptyPad(pd)) toast(`Pad ${padName(p)} (${legendOf(p)}): ROM sound – MIDI only`);
  renderPads(); const el = $(`#perf .pad[data-p="${i}"]`); if (el) { el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 120); }
  flashLcd(`PAD ${padName(p)} ${legendOf(p).toUpperCase()}`);
}
function flashLcd(t) { led(t); clearTimeout(flashLcd._t); flashLcd._t = setTimeout(() => { const f = st.files[st.hexFile]; led(st.rec ? 'RECORD' : f ? `${f.type} ${baseName(f.name)}` : 'NO FILE'); }, 900); }

// ---------- SQ12 ----------
const grid = $('#grid');
const padName = p => `${(p >> 3) + 1}-${(p & 7) + 1}`;
const LEGEND = [
  ['Bass 1', 'Bass 2', 'Snare 1', 'Snare 2', 'El.Snare 1', 'El.Snare 2', 'Rim', 'Cowbell'],
  ['Tom 1', 'Tom 2', 'Tom 3', 'Tom 4', 'El.Tom 1', 'El.Tom 2', 'El.Tom 3', 'El.Tom 4'],
  ['Hihat 1', 'Hihat 2', 'Hihat 3', 'Claps 1', 'Claps 2', 'Ride 1', 'Ride 2', 'Crash'],
  ['User 1', 'User 2', 'User 3', 'User 4', 'User 5', 'User 6', 'User 7', 'User 8']];
const legendOf = p => LEGEND[p >> 3][p & 7];
st.mix = (() => { try { const m = JSON.parse(localStorage.getItem('sp12mix')); if (Array.isArray(m) && m.length === 32) return m; } catch (e) { } return Array(32).fill(1); })();
// Event pad code (5 bit: bank code 0-3, pad 0-7) -> real pad. Code 1 = bank 4 (confirmed by chet). Others: default XOR 2, adjustable.
// a note's sound byte bits 4-0 = sound 0-31 (A1-D8 = pad 1-1 .. 4-8), no mapping needed
const realPad = code => code & 31;
const codeFor = real => real & 31;
// level: 5-bit level index 0-31 -> gain (exponential, about 1.3 dB per step, 31 = full)
const lvlGain = i => i <= 0 ? 0 : Math.pow(2, (Math.min(31, i) - 31) * 0.215);
// descriptor byte 0 of a sound: from the running song's mix, else from the .SP12
function desc0(p) { if (st.mixOv) return st.mixOv[p]; const pd = st.sp != null && st.pads[p]; return pd ? pd.sound : (st.padMode[p] === 'decay' ? 0x80 : 0) | (st.padOut[p] & 7); }
const levelRed = p => (desc0(p) >> 3) & 15;
// ---- song editor: chain segments, repeats; every change is written into the file (undo with Ctrl+Z)
// the song as blocks on a time line (repeats unrolled), the playing block lit with its progress
const SEGHUE = n => (n * 47) % 360;
function renderLane(M, SG) {
  const el = $('#songLane'); if (!el) return;
  if (!SG) { el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  const r = C.songPlan(M.songs, SG.n); st.lanePlan = r;
  let bar = 1; const PXQ = 9; // pixels per quarter
  const items = r.plan.map((x, k) => {
    if (x.seg == null) return x.mix != null ? `<i class="mk" title="Mix ${x.mix + 1}">M${x.mix + 1}</i>` : x.tempo ? `<i class="mk" title="Tempo ${Math.round(x.tempo)} BPM">♩${Math.round(x.tempo)}</i>` : '';
    const s = M.segs[x.seg], q = s ? s.len / C.PPQ : 4, bpb = s && s.b1 >= 1 && s.b1 <= 16 ? s.b1 : 4, w = Math.max(18, q * PXQ);
    const h = `<b data-k="${k}" data-n="${x.seg}" style="width:${w}px;--h:${SEGHUE(x.seg)}" title="Segment ${String(x.seg).padStart(2, '0')} · bar ${bar}${s ? '' : ' · missing!'}"><span>${String(x.seg).padStart(2, '0')}</span><em></em></b>`;
    bar += Math.max(1, Math.round(q / bpb)); return h;
  }).join('');
  el.innerHTML = `<div class="laneHead">Song ${String(SG.n).padStart(2, '0')} · ${r.plan.filter(x => x.seg != null).length} blocks · ${bar - 1} bars${r.loop ? ' · ⟲ Loop' : ''}<span id="lanePos"></span></div><div class="laneRow">${items}${r.loop ? '<i class="mk">⟲</i>' : '<i class="mk">END</i>'}</div>`;
  el.querySelectorAll('b[data-n]').forEach(b => b.onclick = () => { if (seqT) return; st.seg = +b.dataset.n; refreshSQ(); });
  st.laneK = null;
}
function updateLane(k, frac) {
  const el = $('#songLane'); if (!el || el.hidden) return;
  if (st.laneK !== k) {
    el.querySelectorAll('b.on').forEach(b => { b.classList.remove('on'); b.querySelector('em').style.width = '0'; });
    const b = el.querySelector(`b[data-k="${k}"]`); st.laneK = k;
    if (b) { b.classList.add('on'); const row = el.querySelector('.laneRow'); const x = b.offsetLeft - row.clientWidth / 3; if (Math.abs(row.scrollLeft - x) > row.clientWidth / 3) row.scrollTo({ left: x, behavior: 'smooth' }); }
    const n = (st.lanePlan ? st.lanePlan.plan.slice(0, k + 1).filter(x => x.seg != null).length : 0), tot = st.lanePlan ? st.lanePlan.plan.filter(x => x.seg != null).length : 0;
    const lp = $('#lanePos'); if (lp) lp.textContent = ` · ${n} / ${tot}`;
  }
  const b = el.querySelector('b.on em'); if (b) b.style.width = (frac * 100).toFixed(1) + '%';
}
function clearLane() { const el = $('#songLane'); if (!el) return; el.querySelectorAll('b.on').forEach(b => { b.classList.remove('on'); b.querySelector('em').style.width = '0'; }); st.laneK = null; const lp = $('#lanePos'); if (lp) lp.textContent = ''; }
function renderSongEdit(M, SG) {
  const el = $('#songEdit'); if (!el) return;
  if (!st.songEdit) { el.innerHTML = `<button class="btn" id="seEdit">Edit song</button>${M.songs.length ? '' : ''}`; $('#seEdit').onclick = () => { st.songEdit = true; st.songSel = null; refreshSQ(); }; return; }
  const segs = M.segs.filter(Boolean).map(s => s.n);
  el.innerHTML = `${SG ? `<select id="seSeg">${segs.map(n => `<option value="${n}" ${n === st.seg ? 'selected' : ''}>Seg ${String(n).padStart(2, '0')}</option>`).join('')}</select>
    <button class="btn" id="seAddSeg">+ Segment</button>
    <button class="btn" id="seAddBeg">+ Begin Repeat</button>
    <label class="knob">× <input id="seRptN" type="number" min="0" max="99" value="2" style="width:46px" title="0 = endless"></label><button class="btn" id="seAddRpt">+ Repeat</button>
    <button class="btn" id="seLeft" title="move left">◀</button><button class="btn" id="seRight" title="move right">▶</button>
    <button class="btn" id="seDel">Delete step</button>` : ''}
    <button class="btn" id="seNew">+ Song</button>
    <button class="btn primary" id="seDone">Done</button>
`;
  $('#seDone').onclick = () => { st.songEdit = false; st.songSel = null; refreshSQ(); };
  $('#seNew').onclick = () => {
    const used = new Set(M.songs.map(s => s.n)); let n = 1; while (used.has(n) && n < 99) n++;
    if (used.has(n)) { toast('All 100 songs used.'); return; }
    const songs = M.songs.map(s => ({ ...s })).concat([{ n, q: 0, tempo: Math.max(20, Math.min(255, Math.round(+$('#bpm').value || 90))), b1: 0, hdr: [0, 0, 0, 0, 0], steps: [[0xCA]] }]);
    if (writeSongsUI(songs)) { st.songN = n; st.songSel = null; refreshSQ(); toast(`Song ${String(n).padStart(2, '0')} angelegt`); }
  };
  if (!SG) return;
  const body = SG.steps.filter(x => x[0] !== 0xCA), at = () => st.songSel != null && st.songSel < body.length ? st.songSel + 1 : body.length;
  const apply = (nb, sel) => { const songs = M.songs.map(s => s.n === SG.n ? { ...s, steps: nb.concat([[0xCA]]) } : { ...s }); if (writeSongsUI(songs)) { st.songSel = sel; refreshSQ(); } };
  const ins = step => { const nb = body.slice(), k = at(); nb.splice(k, 0, step); apply(nb, k); };
  $('#seAddSeg').onclick = () => ins([+$('#seSeg').value]);
  $('#seAddBeg').onclick = () => ins([0xC8]);
  $('#seAddRpt').onclick = () => { const n = Math.max(0, Math.min(99, Math.round(+$('#seRptN').value || 0))); ins([0x64 + n]); };
  $('#seDel').onclick = () => { if (st.songSel == null || st.songSel >= body.length) { toast('Click a step first.'); return; } const nb = body.slice(); nb.splice(st.songSel, 1); apply(nb, nb.length ? Math.min(st.songSel, nb.length - 1) : null); };
  const mv = d => { const i = st.songSel; if (i == null || i >= body.length || i + d < 0 || i + d >= body.length) return; const nb = body.slice(); [nb[i], nb[i + d]] = [nb[i + d], nb[i]]; apply(nb, i + d); };
  $('#seLeft').onclick = () => mv(-1); $('#seRight').onclick = () => mv(1);
}
function writeSongsUI(songs) {
  const f = sqFile(); let nb;
  try { nb = C.writeSongs(f.bytes, songs); } catch (e) { toast(e.message); return false; }
  snapshot(st.sq); f.bytes = nb; f.dirty = true; refreshChrome(); return true;
}
$('#segNew').onclick = async () => {
  if (st.sq == null) return; const T = C.segTable(sqFile().bytes); let n = 1; while (n < 99 && T[n] != null) n++;
  if (T[n] != null) { toast('All 100 segments used.'); return; }
  const ok = await modal(`<p>New empty segment</p><label>Number <input id="nsN" type="number" min="0" max="99" value="${n}" style="width:60px"></label>
    <label>Bars <input id="nsBars" type="number" min="1" max="99" value="2" style="width:60px"></label>
    <label>Beats per bar <input id="nsBpb" type="number" min="1" max="16" value="4" style="width:60px"></label>`, [['Cancel', null], ['Create', 'ok', true]]);
  if (ok !== 'ok') return;
  const k = Math.max(0, Math.min(99, +$('#nsN').value | 0)), bars = Math.max(1, Math.min(99, +$('#nsBars').value | 0)), bpb = Math.max(1, Math.min(16, +$('#nsBpb').value | 0));
  const f = sqFile(); let nb;
  try { nb = C.insertSegment(f.bytes, k, C.emptySegment(bars * bpb, bpb)); } catch (e) { toast(e.message); return; }
  snapshot(st.sq); f.bytes = nb; f.dirty = true; st.seg = k; refreshSQ(); refreshChrome(); toast(`Segment ${String(k).padStart(2, '0')} created (${bars} bars)`);
};
// metronome: a click on every beat (accent on the one) while a sequence plays
function metroClick(t, accent) {
  const c = ctx(), o = c.createOscillator(), g = c.createGain();
  o.frequency.value = accent ? 1760 : 1175; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(accent ? 0.35 : 0.22, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
  o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + 0.05); return o;
}
function sqModel() {
  const b = sqFile().bytes, T = C.segTable(b);
  const segs = T.map((o, n) => o == null ? null : { n, ...C.decodeSegment(b, o) });
  st.noteKind = st.noteKind || new Map();
  segs.forEach(sg => sg && sg.events.forEach(e => { e.real = realPad(e.pad); const k = st.noteKind.get(`${st.sq}:${sg.n}:${e.tick}:${e.real}`); if (k) e.multi = k; }));
  const songs = C.decodeSongs(b), song = songs[0] || null;
  let evEnd = 0; segs.forEach(s => s && (evEnd = Math.max(evEnd, s.end))); evEnd = Math.max(evEnd, C.songAreaEnd(b));
  return { segs, song, songs, evEnd };
}
function refreshSQ() {
  const f0 = sqFile(); if (f0) { const h = C.seqHeader(f0.bytes); if (h.ub >= h.top) { f0.bytes = C.writeSongs(f0.bytes, []); f0.dirty = true; toast('Sequence file repaired: added the empty song the SP-12 needs'); } }
  const f = sqFile(); if (!f) return; const M = sqModel(); st.M = M; st.S = { evEnd: M.evEnd };
  const present = M.segs.filter(Boolean);
  if (!M.segs[st.seg]) st.seg = present.length ? present[0].n : 0;
  const songUse = new Set(); M.songs.forEach(sg => sg.steps.forEach(([c]) => { if (c < 0x64) songUse.add(c); }));
  $('#segList').innerHTML = present.map(s => `<li class="${s.n === st.seg ? 'on' : ''} ${seqT && !seqT.song && seqT.queued === s.n ? 'next' : ''}" data-n="${s.n}">Segment ${String(s.n).padStart(2, '0')}${songUse.has(s.n) ? '<span class="badge">♪</span>' : ''}<span>${fmtLen(s.len)} · ${s.events.length} notes${s.b0 >> 4 ? ' · Swing ' + C.swingOf(s.b0) + ' %' : ''}</span></li>`).join('') || '<li>no segments</li>';
  $$('#segList li[data-n]').forEach(li => li.onclick = () => {
    const n = +li.dataset.n;
    // while a segment plays: switch at the end of the current pass, like the SP-12
    if (seqT && !seqT.song) { seqT.queued = n === seqT.list[0] && seqT.queued == null ? null : n; refreshSQ(); flashLcd(`NEXT SEG ${String(n).padStart(2, '0')}`); return; }
    st.seg = n; refreshSQ();
  });
  if (st.songN == null || !M.songs.some(s => s.n === st.songN)) st.songN = M.song ? M.song.n : null;
  const SG = M.songs.find(s => s.n === st.songN);
  $('#songView').innerHTML = (M.songs.length > 1 ? `<div class="tempo">Song ${M.songs.map(s => `<a href="#" data-song="${s.n}" style="${s.n === st.songN ? 'font-weight:bold' : ''}">${String(s.n).padStart(2, '0')}</a>`).join(' ')}</div>` : '') +
    (SG ? SG.steps.map(([c, v], i) => c < 0x64
      ? `<span data-i="${i}" data-n="${c}" class="${st.songPos === i ? 'on' : ''} ${st.songEdit && st.songSel === i ? 'sel' : ''}" title="Segment ${c}">${String(c).padStart(2, '0')}</span>`
      : `<span data-i="${i}" class="cmd ${st.songEdit && st.songSel === i ? 'sel' : ''}" title="${C.hex(c)}">${C.songStepName([c, v])}</span>`).join('') : '<span class="cmd">no song</span>');
  $('#songView').classList.toggle('editing', !!st.songEdit);
  renderLane(M, SG);
  renderSongEdit(M, SG);
  $$('#songView a[data-song]').forEach(a => a.onclick = ev => { ev.preventDefault(); st.songN = +a.dataset.song; st.bpmFor = null; refreshSQ(); });
  $$('#songView span[data-i]').forEach(sp => sp.onclick = () => {
    if (st.songEdit) { const i = +sp.dataset.i; st.songSel = st.songSel === i ? null : i; refreshSQ(); return; }
    if (sp.dataset.n != null) { st.seg = +sp.dataset.n; refreshSQ(); }
  });
  if (SG && SG.bpm) {
    $('#songView').insertAdjacentHTML('afterbegin', `<div class="tempo">Song ${String(SG.n).padStart(2, '0')} · Tempo <b>${SG.bpm}${SG.tenths ? '.' + SG.tenths : ''} BPM</b>${SG.first ? ' · First Step ' + SG.first : ''}</div>`);
    if (st.bpmFor !== st.sq) { $('#bpm').value = SG.bpm; st.bpmFor = st.sq; }
  } else if (st.bpmFor !== st.sq) { $('#bpm').value = 90; st.bpmFor = st.sq; }
  const s = M.segs[st.seg];
  if (s) {
    $('#segBars').value = Math.max(1, Math.round(s.len / 96));
    $('#swingInfo').textContent = `${C.swingOf(s.b0)}%`;
    const raw = f.bytes.slice(s.off, s.end);
    $('#segBytes').innerHTML = [...raw].map((x, i) => `<span class="b" data-o="${s.off + i}">${C.hex(x)}</span>`).join('');
    $$('#segBytes .b').forEach(el => el.onclick = () => editByte(st.sq, +el.dataset.o));
  }
  const K = C.parseSQ12(f.bytes).kits;
  $('#kitTable').innerHTML = `<tr><th>#</th>${Array.from({ length: 32 }, (_, i) => `<th>${padName(i)}</th>`).join('')}</tr>` +
    K.map((k, r) => `<tr><td>Mix ${r + 1}</td>${k.map((v, c) => `<td class="b" data-o="${C.L.SQ_KITS + r * 32 + c}" style="cursor:pointer" title="${v & 0x80 ? 'Decay' : 'Tune'} · Level ${31 - 2 * ((v >> 3) & 15)} · Out ${(v & 7) + 1}">${C.hex(v)}</td>`).join('')}</tr>`).join('');
  $$('#kitTable td.b').forEach(el => el.onclick = () => editByte(st.sq, +el.dataset.o));
  drawGrid();
}
function fmtLen(len) { return len % 384 === 0 ? `${len / 384} bar${len === 384 ? '' : 's'}` : `${len / 96}/4`; }
function gridRows() {
  if ($('#allPads').checked) return [...Array(32).keys()];
  const used = new Set(); st.M.segs.forEach(s => s && s.events.forEach(e => used.add(e.real)));
  if (st.padRes) Object.keys(st.padRes).forEach(p => used.add(+p));                 // pads with a sample are always there to paint into
  const r = [...used].sort((a, b) => a - b); return r.length ? r : [24, 25, 26, 27, 28, 29, 30, 31];
}
const LABEL = 132, ROWH = 22;
function drawGrid(playTick = null) {
  if (!st.M) return; const s = st.M.segs[st.seg]; const rows = gridRows();
  grid.style.height = (rows.length * ROWH + 24) + 'px';
  const d = fitCanvas(grid), g = grid.getContext('2d'), W = grid.width, Hh = grid.height;
  g.clearRect(0, 0, W, Hh); if (!s) return;
  const L = LABEL * d, rh = ROWH * d, top = 24 * d, len = Math.max(s.len, 1), xOf = t => L + (t / len) * (W - L);
  const res = +$('#gridRes').value;
  g.font = `${11 * d}px ui-monospace,monospace`;
  // columns
  for (let t = 0; t <= len; t += res) {
    if (t % 384 === 0 && t < len) { g.fillStyle = '#9fb7cf'; g.fillText(`${t / 384 + 1}`, xOf(t) + 4 * d, 15 * d); }
    else if (t % 96 === 0 && t < len) { g.fillStyle = '#5f7f9f'; g.fillText(`${(t % 384) / 96 + 1}`, xOf(t) + 4 * d, 15 * d); }
  }
  rows.forEach((p, r) => {
    const y = top + r * rh;
    g.fillStyle = r % 2 ? '#15304c' : '#122840'; g.fillRect(L, y, W - L, rh);
    const src = padSource(p);
    g.fillStyle = src === 'user' ? '#ffd27a' : src === 'wav' ? '#8fe0a8' : '#7f9bb8';
    g.fillText(`${padName(p)} ${legendOf(p)}${src === 'wav' ? ' ·W' : src === 'midi' ? ' ·MIDI' : ''}`, 6 * d, y + rh * 0.68);
  });
  for (let t = 0; t <= len; t += res) { g.fillStyle = t % 384 === 0 ? '#9fb7cf' : t % 96 === 0 ? '#4d6f92' : '#20405f'; g.fillRect(Math.round(xOf(t)), top, 1, rows.length * rh); }
  s.events.forEach(e => {
    const r = rows.indexOf(e.real); if (r < 0) return; const x = xOf(e.tick), w = Math.max(4 * d, (res / len) * (W - L) - 2 * d);
    const lv = e.level ? e.level / 15 : 1;
    g.fillStyle = `rgba(255,${Math.round(150 + 60 * (1 - lv))},70,${0.35 + 0.65 * lv})`;
    g.fillRect(x + 1 * d, top + r * rh + 3 * d, w, rh - 6 * d);
    const sx = xOf(swingTick(e)); if (Math.abs(sx - x) > 1) { g.fillStyle = 'rgba(255,255,255,.75)'; g.fillRect(sx, top + r * rh + 2 * d, 2 * d, rh - 4 * d); }
  });
  if (playTick != null) { g.fillStyle = '#ff3326'; g.fillRect(xOf(playTick), top, 2 * d, rows.length * rh); }
}
function gridCell(e) {
  const s = st.M && st.M.segs[st.seg]; if (!s) return null; const b = grid.getBoundingClientRect();
  const x = e.clientX - b.left, y = e.clientY - b.top - 24; if (y < 0) return null;
  const rows = gridRows(), r = Math.floor(y / ROWH); if (r < 0 || r >= rows.length) return null;
  const res = +$('#gridRes').value, tick = Math.floor((x - LABEL) / (b.width - LABEL) * s.len / res) * res;
  return { s, pad: rows[r], label: x < LABEL, tick, res };
}
function cellNote(c) { return c.s.events.findIndex(ev => ev.real === c.pad && ev.tick >= c.tick && ev.tick < c.tick + c.res); }
function addNote(c) { const lv = $('#newLevel').value; c.s.events.push({ tick: c.tick, pad: codeFor(c.pad), real: c.pad, level: lv ? +lv : null, val: lv ? 0 : null, b5: false, step: 1e9 }); }
let paint = null;
grid.addEventListener('pointerdown', e => {
  const c = gridCell(e); if (!c) return;
  if (c.label) { st.wavPad = c.pad; $('#padWav').click(); return; }
  if (c.tick < 0 || c.tick >= c.s.len) return;
  const hit = cellNote(c);
  if (e.shiftKey) { // shift + drag: paint (or erase, if the first cell had a note) along the raster
    paint = { mode: hit >= 0 ? 'erase' : 'add', s: c.s, done: new Set() }; grid.setPointerCapture(e.pointerId); paintCell(c); return;
  }
  if (hit >= 0) c.s.events.splice(hit, 1); else { addNote(c); const lv = $('#newLevel').value; hitSound(c.pad, lv ? +lv / 15 : 1); }
  writeSeg(c.s);
});
function paintCell(c) {
  if (!paint || c.label || c.tick < 0 || c.tick >= c.s.len) return; const key = c.pad + ':' + c.tick; if (paint.done.has(key)) return; paint.done.add(key);
  const hit = cellNote(c);
  if (paint.mode === 'add' && hit < 0) addNote(c); else if (paint.mode === 'erase' && hit >= 0) c.s.events.splice(hit, 1);
  drawGrid();
}
grid.addEventListener('pointermove', e => { if (!paint) return; const c = gridCell(e); if (c && c.s === paint.s) paintCell(c); });
grid.addEventListener('pointerup', () => { if (!paint) return; const s0 = paint.s; paint = null; writeSeg(s0); });
function writeSeg(s) {
  snapshot(st.sq); const f = sqFile();
  f.bytes = C.replaceSegment(f.bytes, s.n, C.encodeSegment(s));
  refreshSQ(); refreshChrome();
}
$('#segBars').onchange = e => {
  const s = st.M.segs[st.seg]; if (!s) return; const q = Math.max(1, Math.min(396, Math.round(+e.target.value || 4)));
  const len = q * 96; const drop = s.events.filter(ev => ev.tick >= len).length;
  s.len = len; s.events = s.events.filter(ev => ev.tick < len); writeSeg(s);
  if (drop) toast(`${drop} notes behind the new end removed`);
};
$('#segClear').onclick = () => { const s = st.M.segs[st.seg]; if (!s) return; s.events = []; writeSeg(s); };
['#gridRes', '#allPads'].forEach(id => $(id).onchange = () => drawGrid());
addEventListener('resize', () => st.sq != null && drawGrid());

// --- pad sounds: user RAM sounds (with tune / decay), assigned WAVs; ROM pads stay silent and go out as MIDI
st.padWav = new Map(); st.padBuf = new Map();
// Tune/decay mode per pad (SP-12 Set-up 18 is not in the files): hats, ride and crash default to decay, like the SP-12
st.padMode = LS('sp12padmode', Array.from({ length: 32 }, (_, p) => /hihat|ride|crash/i.test(legendOf(p)) ? 'decay' : 'tune'));
st.padDecay = LS('sp12paddecay', Array(32).fill(31));       // default decay 0-31 (Set-up 19)
st.opt = LS('sp12opt', { tuneRange: 12, noteParams: true });
function userRegionForPad(p) { return st.sp != null && st.padRes ? st.padRes[p] || null : null; }
function padSource(p) { return st.padWav.has(p) ? 'wav' : userRegionForPad(p) ? 'user' : 'midi'; }
function setOut(p, o) { // Set-up 17: output in descriptor byte 0 bits 2-0
  st.padOut[p] = o; saveLS('sp12padout', st.padOut); const pd = st.sp != null && st.pads[p];
  if (pd) writeDesc(p, (pd.sound & 0xF8) | o, null); renderPads();
}
function setMode18(p, m) { // Set-up 18: flips byte 0 bit 7 and sets byte 1 to the middle (80h + bank), like the SP-12
  st.padMode[p] = m; saveLS('sp12padmode', st.padMode); const pd = st.sp != null && st.pads[p];
  if (pd) writeDesc(p, (pd.sound & 0x7F) | (m === 'decay' ? 0x80 : 0), 0x80 | (pd.tune & 7)); else st.padBuf.clear();
  renderPads(); drawGrid();
}
function padTune(p) { const pd = st.sp != null && st.pads[p]; return pd ? pd.tune : 0x80; }
// pitch in semitones and decay fraction (1 = full length) for a pad, optionally with the note's parameter nibble
// Sound descriptor (10 bytes per sound): byte 0 = bit 7 decay mode, bits 2-0 output; byte 1 = bits 7-3 tuning index 0-31
// (16 = original pitch, one semitone per step, at most one octave up), bits 2-0 bank. A note's level/tune byte adds its low
// nibble (-8..+7) to the index; in decay mode the index is the decay instead and the pitch stays original.
const tuneIdx = p => padTune(p) >> 3;
const noteTuneOff = val => val == null ? 0 : (val & 15) >= 8 ? (val & 15) - 16 : val & 15;
const pitchRatio = i => (Math.min(255, Math.round(128 * Math.pow(2, (i - 16) / 12)) - 1) + 1) / 128; // 8-bit pitch byte per frame
function syncDesc() { // Set-up 17/18 live in the .SP12: take output and tune/decay mode from the descriptors
  if (!st.pads) return;
  st.pads.forEach((pd, p) => { if (p > 31 || !pd) return; st.padMode[p] = pd.sound & 0x80 ? 'decay' : 'tune'; st.padOut[p] = pd.sound & 7; });
}
function writeDesc(p, b0, b1) {
  const pd = st.sp != null && st.pads[p]; if (!pd) return false;
  snapshot(st.sp); if (b0 != null) pd.sound = b0 & 255; if (b1 != null) pd.tune = b1 & 255;
  C.writePad(spFile().bytes, pd); spFile().dirty = true; st.padBuf.clear(); refreshChrome(); return true;
}
// Decay as the SP-12 runs it: the level holds, then falls one level step per decay tick until silent. Hold and tick time
// grow with the decay index 0-31 (31 = longest, about 6 s, not endless). Own approximation of the hardware's curve.
const DTICK = 4096 / (10e6 / 3);                                   // the voice decay clock: 1.23 ms
const decayShape = i => { i = Math.max(0, Math.min(31, i | 0)); const t = i < 1 ? 2 : i + 1, h = i < 10 ? 1 : Math.round(0.25 * (i - 9) * (i - 9)); return { step: t * DTICK, hold: (h + 1) * t * DTICK }; };
const decaySecs = i => { const d = decayShape(i); return (d.hold + 31 * d.step).toFixed(2); };
// Default Decay (Set-up 19) lives in the .SP12 at 0x28E (RAM 6C7Dh); every sound in tune mode uses it
const defaultDecay = () => st.sp != null ? Math.min(31, spFile().bytes[0x28E] & 31) : (st.opt.gDecay ?? 31);
const decayIdx = p => st.padMode[p] === 'decay' ? tuneIdx(p) : defaultDecay();
function voiceParams(p, val = null) {
  const off = st.opt.noteParams ? noteTuneOff(val) : 0, idx = Math.max(0, Math.min(31, tuneIdx(p) + off));
  let semis = 0, dix = defaultDecay();
  if (!(desc0(p) & 0x80)) semis = 12 * Math.log2(pitchRatio(idx)); else dix = idx;   // decay mode: the same index is the decay
  semis += st.opt.gTune || 0;
  return { semis, dix, decay: dix / 31, idx };
}
function padBuffer(p, semis = 0) {
  const c = ctx(), src = padSource(p);
  if (src === 'midi') return null;
  const ur = src === 'user' ? userRegionForPad(p) : null;
  const key = `${p}|${src}|${rate()}|${semis.toFixed(2)}|${ur ? ur.fstart + ':' + ur.len : ''}`; if (st.padBuf.has(key)) return st.padBuf.get(key);
  let buf;
  if (src === 'wav') buf = st.padWav.get(p);
  else { // zero-order hold at the pitched rate – the SP-12's drop-sample pitch shifting
    const a = ur.fstart, b2 = Math.min(st.X.length, ur.fstart + ur.len), step = rate() * Math.pow(2, semis / 12) / c.sampleRate;
    const n = Math.max(1, Math.ceil((b2 - a) / step)); buf = c.createBuffer(1, n, c.sampleRate); const dd = buf.getChannelData(0);
    for (let i = 0; i < n; i++) dd[i] = (st.X[a + Math.min(b2 - a - 1, Math.floor(i * step))] - 2048) / 2048;
  }
  if (st.padBuf.size > 300) st.padBuf.clear();
  if (ur && st.pads[p].loop) buf._loop = { start: (ur.loopF - ur.fstart) / (rate() * Math.pow(2, semis / 12)), end: buf.duration };
  st.padBuf.set(key, buf); return buf;
}
$('#padWav').onchange = async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file || st.wavPad == null) return;
  try { const c = ctx(); const buf = await c.decodeAudioData(await file.arrayBuffer()); st.padWav.set(st.wavPad, buf); toast(`${file.name} → Pad ${padName(st.wavPad)}`); drawGrid(); }
  catch (err) { toast('Could not read the audio.'); }
};
// --- MIDI out (Web MIDI: Chrome/Edge; Safari has no Web MIDI)
// SP-12 factory note map (measured on a real SP-12 Turbo): index = pad (bank 1 pad 1 … bank 4 pad 8)
const SP12NOTES = [36, 38, 40, 41, 43, 45, 39, 37, 47, 48, 50, 52, 53, 55, 57, 59, 42, 44, 46, 49, 51, 54, 56, 58, 60, 61, 62, 63, 64, 65, 66, 67];
st.midi = { access: null, out: null, cfg: Object.assign({ id: '', ch: 1, base: 36, scope: 'rom', vel: 100, map: 'sp12' }, LS('sp12midi', {})) };
const noteOfPad = p => st.midi.cfg.map === 'sp12' ? SP12NOTES[p] : st.midi.cfg.base + p;
const padOfNote = n => st.midi.cfg.map === 'sp12' ? SP12NOTES.indexOf(n) : n - st.midi.cfg.base;
async function midiInit(ask = false) {
  if (st.midi.access) { pickMidiOut(); return true; }            // one MIDIAccess only – a second one would deliver every message twice
  if (st.midi.pending) return st.midi.pending;
  st.midi.pending = midiInitReal(ask); const r = await st.midi.pending; st.midi.pending = null; return r;
}
async function midiInitReal(ask) {
  if (!navigator.requestMIDIAccess) { if (ask) toast('No Web MIDI in this browser – use Chrome or Edge.', 4500); return false; }
  try { st.midi.access = await navigator.requestMIDIAccess({ sysex: true }); } catch (e) { try { st.midi.access = await navigator.requestMIDIAccess(); toast('MIDI without SysEx – no disk or sample dumps.', 5000); } catch (e2) { if (ask) toast('MIDI access was denied.'); return false; } }
  st.midi.access.onstatechange = () => pickMidiOut();
  pickMidiOut(); return true;
}
function pickMidiOut() {
  const a = st.midi.access, outs = a ? [...a.outputs.values()] : [], ins = a ? [...a.inputs.values()] : [];
  st.midi.out = outs.find(o => o.id === st.midi.cfg.id) || null; $('#midiBtn').classList.toggle('primary', !!st.midi.out);
  ins.forEach(i => i.onmidimessage = null);
  st.midi.in = ins.find(i => i.id === st.midi.cfg.inId) || null;
  if (st.midi.in) st.midi.in.onmidimessage = ev => midiIn(ev.data);
  if (typeof renderMidiTab === 'function') renderMidiTab();
}
function midiNote(p, vel01, when) {
  const m = st.midi; if (!m.out || st.offline) return;
  if (m.cfg.scope === 'rom' && padSource(p) !== 'midi' && !m.cfg.thruAll) return;
  const ch = (m.cfg.ch - 1) & 15, note = Math.max(0, Math.min(127, noteOfPad(p))), vel = Math.max(1, Math.min(127, Math.round(vel01 * 127)));
  const c = ctx(), t = performance.now() + Math.max(0, (when ? when - c.currentTime : 0) * 1000);
  try { m.out.send([0x90 | ch, note, vel], t); m.out.send([0x80 | ch, note, 0], t + 60); if (!when) mlog('out', [0x90 | ch, note, vel]); } catch (e) { }
}
$('#midiBtn').onclick = async () => {
  if (!st.midi.access && !(await midiInit(true))) return;
  const outs = [...st.midi.access.outputs.values()], c = st.midi.cfg;
  const ok = await modal(`<h3 style="margin-top:0">MIDI out</h3>
    <label>Device <select id="mOut"><option value="">– off –</option>${outs.map(o => `<option value="${o.id}" ${o.id === c.id ? 'selected' : ''}>${o.name}</option>`).join('')}</select></label>
    <label>Channel <input id="mCh" type="number" min="1" max="16" value="${c.ch}" style="width:60px"></label>
    <label>Note map <select id="mMapM"><option value="sp12" ${c.map === 'sp12' ? 'selected' : ''}>SP-12</option><option value="lin" ${c.map !== 'sp12' ? 'selected' : ''}>linear from base</option></select></label>
    <label>Base note <input id="mBase" type="number" min="0" max="96" value="${c.base}" style="width:60px"></label>
    <label>Send for <select id="mScope"><option value="rom" ${c.scope === 'rom' ? 'selected' : ''}>ROM pads only</option><option value="all" ${c.scope === 'all' ? 'selected' : ''}>all pads</option></select></label>
    ${outs.length ? '' : '<p>No MIDI out found.</p>'}`, [['Cancel', false], ['OK', true, true]]);
  if (!ok) return;
  Object.assign(c, { id: $('#mOut').value, ch: Math.max(1, Math.min(16, +$('#mCh').value || 1)), base: Math.max(0, Math.min(96, +$('#mBase').value || 36)), scope: $('#mScope').value, map: $('#mMapM').value });
  saveLS('sp12midi', c); pickMidiOut(); toast(st.midi.out ? `MIDI → ${st.midi.out.name}, ch ${c.ch}` : 'MIDI off');
};
if ((st.midi.cfg.id || st.midi.cfg.inId) && navigator.requestMIDIAccess) midiInit(false);
// --- 8 monophonic outputs: 1-2 dynamic SSM2044-style low-pass (envelope with attack), 3-6 fixed low-pass, 7-8 unfiltered
st.padOut = LS('sp12padout', Array.from({ length: 32 }, (_, p) => p & 7));   // channel assign (Set-up 17), 0-based
st.filt = LS('sp12filt', { on: true, attack: 1.5, decay: 180, fmax: 16000, fmin: 900, fixed: 11000, res: 0.9 });
const OUTHW = o => o < 2 ? 'dyn' : o < 6 ? 'fix' : 'none';
// per output, by clicking its round symbol: on (as the hardware) → unfiltered → mute → on; outputs 7–8 have no filter: on → mute
st.outMode = LS('sp12outmode', Array(8).fill('on'));
const OUTTYPE = o => st.outMode[o] === 'raw' ? 'none' : OUTHW(o);
function cycleOut(o) { const m = st.outMode[o], hw = OUTHW(o); st.outMode[o] = m === 'on' ? (hw === 'none' ? 'mute' : 'raw') : m === 'raw' ? 'mute' : 'on'; saveLS('sp12outmode', st.outMode); applyFilterSettings(); renderOuts();
  flashLcd(`OUT ${o + 1} ${st.outMode[o] === 'mute' ? 'MUTE' : st.outMode[o] === 'raw' ? 'UNFILTERED' : hw === 'none' ? 'ON' : 'FILTERED'}`); }
let outs = null;
function getOuts() {
  if (outs) return outs; const c = ctx();
  outs = Array.from({ length: 8 }, (_, o) => {
    const inp = c.createGain(), f1 = c.createBiquadFilter(), f2 = c.createBiquadFilter();
    f1.type = f2.type = 'lowpass'; f1.Q.value = 0.54; f2.Q.value = 1.31 * st.filt.res; // two biquads = 4-pole (24 dB/oct) like the SSM2044
    inp.connect(f1); f1.connect(f2); f2.connect(MX.deskFor(c).ins[o]);   // into the mixing desk
    return { inp, f1, f2, cur: null };
  });
  applyFilterSettings(); return outs;
}
function applyFilterSettings() {
  if (!outs) return; const c = ctx(), ny = c.sampleRate / 2 * 0.95, t = c.currentTime;
  outs.forEach((o, i) => {
    const ty = OUTTYPE(i), f = !st.filt.on || ty === 'none' ? ny : ty === 'fix' ? st.filt.fixed : st.filt.fmin;
    [o.f1, o.f2].forEach(b => { b.frequency.cancelScheduledValues(t); b.frequency.setValueAtTime(Math.min(ny, f), t); });
    o.f2.Q.value = ty === 'none' || !st.filt.on ? 0.707 : 1.31 * st.filt.res;
    o.inp.gain.setValueAtTime(st.outMode[i] === 'mute' ? 0 : 1, t);
  });
}
function filterEnvelopeOld(o, i, t) { // outputs 1-2: cutoff opens with the attack, holds for the ~9.5 ms trigger, then decays
  if (!st.filt.on || OUTTYPE(i) !== 'dyn') return;
  const ny = ctx().sampleRate / 2 * 0.95, a = st.filt.attack / 1000, hi = Math.min(ny, st.filt.fmax), lo = st.filt.fmin;
  [o.f1, o.f2].forEach(b => {
    b.frequency.cancelScheduledValues(t); b.frequency.setValueAtTime(lo, t);
    b.frequency.linearRampToValueAtTime(hi, t + a); b.frequency.setValueAtTime(hi, t + a + 0.0095);
    b.frequency.setTargetAtTime(lo, t + a + 0.0095, st.filt.decay / 1000 / 3);
  });
}
function renderOuts() {
  const el = $('#outs'); if (!el) return; const used = new Set(st.padOut.slice((st.bank - 1) * 8, st.bank * 8));
  const f = st.filt;
  el.innerHTML = `<b class="knob">Out</b>` +
    Array.from({ length: 8 }, (_, o) => `<span class="ob ${OUTTYPE(o)} ${st.outMode[o]} ${used.has(o) ? 'act' : ''}" data-o="${o}" title="${st.outMode[o] === 'mute' ? 'muted' : OUTTYPE(o) === 'dyn' ? 'SSM2044 filter with envelope' : OUTTYPE(o) === 'fix' ? 'fixed low-pass' : 'unfiltered'} – click: filtered / unfiltered / mute"><i>${st.outMode[o] === 'mute' ? 'M' : o + 1}</i></span>`).join('') +
    `<label class="chk"><input type="checkbox" id="fOn" ${f.on ? 'checked' : ''}> Filter</label>
     <label class="knob">1–2 <input type="range" id="fMax" min="1000" max="20000" step="250" value="${f.fmax}"><output>${(f.fmax / 1000).toFixed(1)} kHz</output></label>
     <label class="knob">3–6 <input type="range" id="fFix" min="2000" max="16000" step="250" value="${f.fixed}"><output>${(f.fixed / 1000).toFixed(1)} kHz</output></label>
     <details class="more up"><summary class="btn ghost">⋯</summary><div class="pop">
       <label class="knob">Attack <input type="range" id="fAtt" min="0" max="20" step="0.5" value="${f.attack}"><output>${f.attack} ms</output></label>
       <label class="knob">Env decay <input type="range" id="fDec" min="20" max="1500" step="10" value="${f.decay}"><output>${f.decay} ms</output></label>
       <label class="knob">Rest cutoff <input type="range" id="fMin" min="200" max="6000" step="50" value="${f.fmin}"><output>${(f.fmin / 1000).toFixed(1)} kHz</output></label>
       <label class="knob">Reso <input type="range" id="fRes" min="0.5" max="3" step="0.05" value="${f.res}"><output>${f.res}</output></label>
     </div></details>`;
  $$('#outs .ob[data-o]').forEach(b => b.onclick = () => cycleOut(+b.dataset.o));
  const bind = (id, k, fmt) => { const i = $(id); i.oninput = () => { f[k] = +i.value; i.nextElementSibling.textContent = fmt(f[k]); saveLS('sp12filt', f); applyFilterSettings(); }; };
  bind('#fMax', 'fmax', v => (v / 1000).toFixed(1) + ' kHz'); bind('#fAtt', 'attack', v => v + ' ms'); bind('#fDec', 'decay', v => v + ' ms'); bind('#fMin', 'fmin', v => (v / 1000).toFixed(1) + ' kHz');
  bind('#fFix', 'fixed', v => (v / 1000).toFixed(1) + ' kHz'); bind('#fRes', 'res', v => v);
  $('#fOn').onchange = e => { f.on = e.target.checked; saveLS('sp12filt', f); applyFilterSettings(); };
}
// one voice: sample (pitched, decayed, looped, mixed) through its monophonic output, and/or MIDI note
function hitSound(p, gain = 1, when = 0, val = null, extraSemis = 0) {
  const c = ctx(), t = Math.max(c.currentTime, when || c.currentTime), v = voiceParams(p, val), O = st.offline;
  const g01 = gain * (st.sp != null ? lvlGain(31 - 2 * levelRed(p)) : st.mix[p]) * (O && ((O.solo != null && O.solo !== p) || (O.out != null && O.out !== (desc0(p) & 7))) ? 0 : 1);  // stems: the others silent, but still cutting their output
  midiNote(p, g01, t);
  const buf = padBuffer(p, v.semis + extraSemis); if (!buf) return null;
  const srcN = c.createBufferSource(), g = c.createGain(); srcN.buffer = buf; g.gain.setValueAtTime(g01, t);
  if (buf._loop) { srcN.loop = true; srcN.loopStart = buf._loop.start; srcN.loopEnd = buf._loop.end; }
  { // SP-12 decay: hold, then one level step (about 1.3 dB) per decay tick down to silence
    const d = decayShape(v.dix), steps = 31; g.gain.setValueAtTime(g01, t + d.hold);
    g.gain.exponentialRampToValueAtTime(Math.max(1e-5, g01 * lvlGain(1)), t + d.hold + (steps - 1) * d.step); g.gain.linearRampToValueAtTime(0, t + d.hold + steps * d.step);
    srcN._end = t + d.hold + steps * d.step + 0.01; }
  srcN.connect(g);
  const oi = desc0(p) & 7, o = getOuts()[oi];
  // monophonic output: keep the notes of this output in time order; each note is cut by the next one
  const note = { t, src: srcN, g };
  o.notes = (o.notes || []).filter(n => n.t > c.currentTime - 15);
  let k = o.notes.findIndex(n => n.t > t); if (k < 0) k = o.notes.length;
  const prev = o.notes[k - 1], next = o.notes[k];
  o.notes.splice(k, 0, note);
  if (prev) cutNote(prev, t);
  if (next) cutNote(note, next.t);
  else if (buf._loop) cutNote(note, t + 12, 0.25); // looped sounds sustain until the next note on the output
  g.connect(o.inp); srcN.start(t);
  scheduleFilter(o, oi, t);
  return srcN;
}
function cutNote(n, at, tc = 0.0015) {
  try { n.g.gain.cancelScheduledValues(at); n.g.gain.setTargetAtTime(0, at, tc); n.src.stop(at + tc * 12 + 0.01); } catch (e) { }
}
// filter envelope of outputs 1-2, rebuilt from the given time for all notes still to come (scheduled sequence notes included)
function scheduleFilter(o, oi, from) {
  if (!st.filt.on || OUTTYPE(oi) !== 'dyn') return;
  const ny = ctx().sampleRate / 2 * 0.95, a = st.filt.attack / 1000, hi = Math.min(ny, st.filt.fmax), lo = Math.min(hi, st.filt.fmin);
  [o.f1, o.f2].forEach(b => {
    b.frequency.cancelScheduledValues(from);
    o.notes.filter(n => n.t >= from).forEach(n => {
      b.frequency.setValueAtTime(lo, n.t); b.frequency.linearRampToValueAtTime(hi, n.t + a);
      b.frequency.setValueAtTime(hi, n.t + a + 0.0095); b.frequency.setTargetAtTime(lo, n.t + a + 0.0095, st.filt.decay / 1000 / 3);
    });
  });
}
function resetOuts() { if (!outs) return; outs.forEach(o => o.notes = []); applyFilterSettings(); }
// --- transport
let seqT = null;
st.rec = false;
function toggleRec() {
  if (st.sq == null) newSeqFile();
  st.rec = !st.rec; $('#recBtn').classList.toggle('on', st.rec); document.body.classList.toggle('recording', st.rec);
  led(st.rec ? 'RECORD' : 'RECORD OFF');
  if (st.rec && !seqT) startSeq([st.seg], true);
}
function recordHit(p, slot, when = 0) { // auto-correct to the current raster, like the SP-12; keeps multi slot / mix as the note's level nibble
  if (!seqT || !st.M) return; const c = ctx(), now = when || c.currentTime, cur = [...seqT.sched].reverse().find(x => x.t <= now); if (!cur) return;
  const s = st.M.segs[cur.n]; if (!s) return; const res = +$('#gridRes').value;
  let tick = Math.round(((now - cur.t) / seqT.tickSec) / res) * res; if (tick >= s.len) tick = 0;
  if (s.events.some(e => e.real === p && e.tick === tick)) return;
  let level = null;
  if (slot != null) level = SLOTVAL[slot];
  else if ($('#newLevel').value) level = +$('#newLevel').value;
  else if (st.mix[p] < 0.97) level = SLOTVAL[slotOf(Math.max(5, Math.round(st.mix[p] * 15)))];
  s.events.push({ tick, pad: codeFor(p), real: p, level, val: level ? 0 : null, b5: false, step: 1e9 });
  st.noteKind = st.noteKind || new Map(); if (slot != null) st.noteKind.set(`${st.sq}:${cur.n}:${tick}:${p}`, st.multi.kind);
  st.seg = cur.n; writeSeg(s);
}
// level nibble of a note: by default a level; optionally (or for notes recorded in Multi Pitch here) a multi-pitch slot
function noteVoice(e) { // gain relative to level 31; the sound's mix level reduction is added in hitSound
  const asPitch = e.level && (e.multi === 'pitch' || (e.multi == null && st.opt.hiMode === 'pitch'));
  if (asPitch) return { gain: 1, semis: st.multiPitch[slotOf(e.level)] };
  if (e.level && e.multi === 'level') return { gain: st.multiLevel[slotOf(e.level)], semis: 0 };
  return { gain: lvlGain(C.noteLevel(e)), semis: 0 };
}
function swingPct(s) { const v = $('#swingSel').value; return v === 'file' ? C.swingOf(s.b0) : +v; }
function swingTick(e) { const s = st.M.segs[st.seg]; return s ? C.swingTick(e.tick, swingPct(s)) : e.tick; }
const jitter = () => $('#jitterOn').checked ? (Math.random() * 2 - 1) * (+$('#jitterMs').value) / 1000 : 0;
$('#jitterMs').oninput = e => $('#jitterOut').textContent = `${e.target.value} ms`;
$('#swingSel').onchange = () => drawGrid();
function startSeq(list, loop) {
  stopSeq(true); const c = ctx(); if (!list.length) return;
  const bpm = Math.max(20, Math.min(255, +$('#bpm').value || 90)), tickSec = 60 / bpm / C.PPQ;
  const P = { list, loop, i: 0, next: c.currentTime + 0.08, srcs: [], sched: [], tickSec };
  const pump = () => {
    while (P.next < c.currentTime + 0.35) {
      if (P.i >= P.list.length) {
        if (P.queued != null && !P.song) { P.list = [P.queued]; P.queued = null; P.i = 0; continue; }
        if (!P.loop) break; P.i = P.loopFrom || 0; }
      const it = P.list[P.i], item = typeof it === 'object' ? it : { seg: it };
      if (item.mix != null) { st.mixOv = C.mixTable(sqFile().bytes, item.mix); P.i++; continue; }
      if (item.tempo && item.seg == null) { P.tickSec = 60 / item.tempo / C.PPQ; P.i++; continue; }
      if (item.tempo) P.tickSec = 60 / item.tempo / C.PPQ;
      const tickSec = P.tickSec, s = st.M.segs[item.seg]; if (!s) { P.i++; continue; }
      if ($('#metroOn').checked) { const bpb = s.b1 >= 1 && s.b1 <= 16 ? s.b1 : 4; for (let t = 0; t < s.len; t += C.PPQ) P.srcs.push(metroClick(P.next + t * tickSec, t % (C.PPQ * bpb) === 0)); }
      const sw = swingPct(s); s.events.forEach(e => { const v = noteVoice(e); const n = hitSound(e.real, v.gain, Math.max(c.currentTime, P.next + C.swingTick(e.tick, sw) * tickSec + jitter()), e.val, v.semis); if (n) P.srcs.push(n); });
      P.sched.push({ t: P.next, n: s.n, idx: item.step ?? P.i, k: P.i, len: s.len, tickSec }); P.next += s.len * tickSec; P.i++;
    }
    P.srcs = P.srcs.slice(-400);
    const now = c.currentTime, curS = [...P.sched].reverse().find(x => x.t <= now);
    if (curS) {
      if (P.song) updateLane(curS.k, Math.min(1, (now - curS.t) / (curS.len * curS.tickSec)));
      if (curS.n !== st.seg) { st.seg = curS.n; st.songPos = P.song ? curS.idx : null; refreshSQ(); }
      drawGrid(Math.min(curS.len, (now - curS.t) / P.tickSec));
      if (!P.loop && P.i >= P.list.length && now > P.next) { stopSeq(); return; }
    }
    seqT.raf = requestAnimationFrame(pump);
  };
  seqT = P; P.raf = requestAnimationFrame(pump); return P;
}
function stopSeq(keepRec = false) { st.mixOv = null; clearLane(); if (st.rec && !keepRec) toggleRec(); if (!seqT) return; cancelAnimationFrame(seqT.raf); seqT.srcs.forEach(s => { try { s.stop(); } catch (e) { } }); seqT = null; resetOuts(); st.songPos = null; drawGrid(); }
$('#seqPlay').onclick = () => startSeq([st.seg], $('#seqLoop').checked);
$('#songPlay').onclick = () => {
  const song = st.M.songs.find(s => s.n === st.songN); if (!song || !song.steps.length) { toast('No song in this file.'); return; }
  const r = C.songPlan(st.M.songs, song.n), bpm0 = +$('#bpm').value || song.tempo, k = bpm0 / song.tempo; // the tempo field scales the song
  const list = r.plan.map(x => x.tempo ? { ...x, tempo: x.tempo * k } : x);
  const P = startSeq(list, r.loop || $('#seqLoop').checked); if (P) { P.song = true; P.loopFrom = r.loop ? r.loopFrom : 0; }
};
$('#seqStop').onclick = () => stopSeq();
$('#recBtn').onclick = toggleRec;
$('#bpm').onchange = () => { // write the new tempo into the song
  const song = st.M && st.M.songs.find(s => s.n === st.songN); let v = Math.max(20, Math.min(255, Math.round(+$('#bpm').value || 90))); $('#bpm').value = v;
  if (!song || song.tempoOff == null || v === song.bpm) return;
  snapshot(st.sq); sqFile().bytes[song.tempoOff] = v; refreshSQ(); refreshChrome(); toast(`Song tempo set to ${v} BPM`);
};
// ---------- audio export: segment / song as WAV, stems per sound or per output (rendered offline, like playback) ----------
function planOf(kind) {
  if (kind === 'seg') return { list: [{ seg: st.seg }], bpm: Math.max(20, Math.min(255, +$('#bpm').value || 90)) };
  const song = st.M.songs.find(s => s.n === st.songN); if (!song) return null;
  const r = C.songPlan(st.M.songs, song.n), bpm0 = +$('#bpm').value || song.tempo, k = bpm0 / song.tempo;
  return { list: r.plan.map(x => x.tempo ? { ...x, tempo: x.tempo * k } : x), bpm: bpm0, song };
}
function planSeconds(P) { let tick = 60 / P.bpm / C.PPQ, t = 0; P.list.forEach(it => { if (it.tempo) tick = 60 / it.tempo / C.PPQ; const s = it.seg != null && st.M.segs[it.seg]; if (s) t += s.len * tick; }); return t; }
function schedulePlan(P, t0) {
  let tick = 60 / P.bpm / C.PPQ, t = t0; const used = new Set(), outsUsed = new Set();
  for (const it of P.list) {
    if (it.mix != null) { st.mixOv = C.mixTable(sqFile().bytes, it.mix); continue; }
    if (it.tempo) tick = 60 / it.tempo / C.PPQ; if (it.seg == null) continue;
    const s = st.M.segs[it.seg]; if (!s) continue; const sw = swingPct(s);
    s.events.forEach(e => { const v = noteVoice(e); used.add(e.real); outsUsed.add(desc0(e.real) & 7); hitSound(e.real, v.gain, t + C.swingTick(e.tick, sw) * tick + jitter(), e.val, v.semis); });
    t += s.len * tick;
  }
  st.mixOv = null; return { end: t, used, outsUsed };
}
async function renderPlan(P, opt) {
  const sr = opt.sr || 44100, secs0 = planSeconds(P) + (opt.tail ?? 3), frames = Math.ceil(secs0 * sr);
  const off = new OfflineAudioContext(2, frames, sr), saveA = actx, saveO = outs;
  actx = off; outs = null; st.offline = { solo: opt.solo ?? null, out: opt.out ?? null }; st.padBuf.clear();
  let info; try { info = schedulePlan(P, 0.02); } finally { actx = saveA; outs = saveO; st.offline = null; st.padBuf.clear(); }
  const buf = await off.startRendering(); return { data: [buf.getChannelData(0), buf.getChannelData(1)], sr, info };
}
function wav16(chs, sr, k = 1, len = chs[0].length) { // stereo (or mono) 16 bit
  const C2 = chs.length, n = len, b = new ArrayBuffer(44 + n * 2 * C2), v = new DataView(b), w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2 * C2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, C2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2 * C2, true); v.setUint16(32, 2 * C2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2 * C2, true);
  for (let i = 0, o = 44; i < n; i++) for (let ch = 0; ch < C2; ch++, o += 2) v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(chs[ch][i] * k * 32767))), true);
  return new Uint8Array(b);
}
function trimLen(chs, sr) { let e = chs[0].length; while (e > sr * 0.05 && chs.every(d => Math.abs(d[e - 1]) < 1e-4)) e--; return Math.min(chs[0].length, e + Math.round(sr * 0.05)); }
// minimal ZIP (stored, no compression) for the stems
function zipStore(files) {
  const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = d => { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = crcT[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  files.forEach(f => {
    const name = enc.encode(f.name), c = crc(f.data), h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint32(14, c, true); h.setUint32(18, f.data.length, true); h.setUint32(22, f.data.length, true); h.setUint16(26, name.length, true);
    parts.push(new Uint8Array(h.buffer), name, f.data);
    const cd = new DataView(new ArrayBuffer(46)); cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint32(16, c, true); cd.setUint32(20, f.data.length, true); cd.setUint32(24, f.data.length, true); cd.setUint16(28, name.length, true); cd.setUint32(42, off, true);
    central.push(new Uint8Array(cd.buffer), name); off += 30 + name.length + f.data.length;
  });
  const csz = central.reduce((a, x) => a + x.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csz, true); e.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)], out = new Uint8Array(all.reduce((a, x) => a + x.length, 0)); let p = 0; all.forEach(x => { out.set(x, p); p += x.length; }); return out;
}
$('#wavExport').onclick = async () => {
  if (st.sq == null || !st.M) return; const hasSong = st.M.songs.some(s => s.n === st.songN);
  const ok = await modal(`<p><b>Audio export</b></p>
    <label>What <select id="axWhat"><option value="seg">Segment ${String(st.seg).padStart(2, '0')}</option>${hasSong ? `<option value="song" selected>Song ${String(st.songN).padStart(2, '0')}</option>` : ''}</select></label>
    <label>Output <select id="axMode"><option value="mix">Mix (one WAV)</option><option value="pad">Stems per pad (ZIP)</option><option value="out">Stems per output 1–8 (ZIP)</option></select></label>
    <label>Sample rate <select id="axSr"><option value="44100">44.1 kHz</option><option value="48000">48 kHz</option></select></label>
    <label class="chk"><input type="checkbox" id="axNorm" checked> normalize</label>
    `, [['Cancel', null], ['Export', 'ok', true]]);
  if (ok !== 'ok') return;
  const what = $('#axWhat').value, mode = $('#axMode').value, sr = +$('#axSr').value, norm = $('#axNorm').checked, P = planOf(what);
  if (!P) { toast('No song.'); return; }
  if (seqT) stopSeq();
  const base = `${baseName(sqFile().name)}_${what === 'seg' ? 'seg' + String(st.seg).padStart(2, '0') : 'song' + String(st.songN).padStart(2, '0')}`;
  try {
    led('RENDERING …'); toast('Rendering …', 2000);
    const mix = await renderPlan(P, { sr }); let peak = 0; for (const d of mix.data) for (const x of d) peak = Math.max(peak, Math.abs(x)); const k = norm && peak > 0 ? 0.98 / peak : 1;
    if (mode === 'mix') { const L = trimLen(mix.data, sr); download(wav16(mix.data, sr, k, L), `${base}.wav`, 'audio/wav'); toast(`${base}.wav exported (${(L / sr).toFixed(1)} s)`); return; }
    const files = [], len = trimLen(mix.data, sr);
    const keys = mode === 'pad' ? [...mix.info.used].sort((a, b) => a - b).filter(p => padSource(p) !== 'midi') : [...mix.info.outsUsed].sort();
    for (const key of keys) {
      led(`STEM ${mode === 'pad' ? padName(key) : 'OUT ' + (key + 1)}`);
      const r = await renderPlan(P, mode === 'pad' ? { sr, solo: key } : { sr, out: key });
      files.push({ name: mode === 'pad' ? `${base}_pad${padName(key)}_${legendOf(key).replace(/[^\w-]+/g, '')}.wav` : `${base}_out${key + 1}.wav`, data: wav16(r.data, sr, k, len) });
    }
    files.push({ name: `${base}_mix.wav`, data: wav16(mix.data, sr, k, len) });
    download(zipStore(files), `${base}_stems.zip`, 'application/zip'); toast(`${files.length - 1} stems + mix exported (ZIP)`, 5000);
  } catch (e) { toast('Export failed: ' + e.message, 6000); } finally { led(st.sq != null ? `SQ12 ${baseName(sqFile().name)}` : 'SP-12'); }
};
$('#midiSeg').onclick = () => { const s = st.M.segs[st.seg]; if (!s) return; download(C.segmentToMidi({ ...s, events: s.events.map(e => ({ ...e, pad: noteOfPad(e.real) - 36, playTick: C.swingTick(e.tick, swingPct(s)) })) }, +$('#bpm').value || 90), `${baseName(sqFile().name)}_seg${String(s.n).padStart(2, '0')}.mid`, 'audio/midi'); };
$('#midiSong').onclick = () => {
  const song = st.M.songs.find(s => s.n === st.songN); if (!song) { toast('No song.'); return; }
  let off = 0; const ev = [];
  C.songPlan(st.M.songs, song.n).plan.filter(x => x.seg != null).forEach(x => { const s = st.M.segs[x.seg]; if (!s) return; const sw = swingPct(s); s.events.forEach(e => ev.push({ ...e, pad: noteOfPad(e.real) - 36, tick: e.tick + off, playTick: C.swingTick(e.tick, sw) + off })); off += s.len; });
  download(C.segmentToMidi({ events: ev, len: off }, +$('#bpm').value || 90), `${baseName(sqFile().name)}_song.mid`, 'audio/midi');
};
async function editByte(fi, o) {
  const f = st.files[fi];
  const ok = await modal(`<p>${f.name} · Offset 0x${C.hex(o, 4)} (${o})</p><label>New value (hex)<input id="byteVal" value="${C.hex(f.bytes[o])}" maxlength="2"></label>`, [['Cancel', false], ['Setzen', true, true]]);
  if (!ok) return; const v = parseInt(document.getElementById('byteVal').value, 16);
  if (!(v >= 0 && v <= 255)) { toast('Invalid value'); return; }
  setByte(fi, o, v);
}
function setByte(fi, o, v) {
  snapshot(fi); st.files[fi].bytes[o] = v;
  if (fi === st.sp) refreshSP(); if (fi === st.sq) refreshSQ(); refreshChrome();
}

// ---------- MIDI tab: monitor, note test, MIDI in -> pads, SDS sample transfer with handshake, SysEx capture/replay ----------
st.mlog = []; st.cap = []; st.sds = { rx: null, tx: null };
const hx = a => [...a].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
function describe(m) {
  const s0 = m[0];
  if (s0 === 0xF0) {
    if (C.isSds(m)) { const t = m[3];
      if (t === 1) { const h = C.sdsParseHeader(m); return h ? `SDS Header · Sample ${h.num} · ${h.bits} Bit · ${h.length} words · ${Math.round(1e9 / h.periodNs)} Hz · Loop ${h.loopType === 0x7F ? 'off' : h.loopStart + '–' + h.loopEnd}` : 'SDS Header'; }
      if (t === 2) return `SDS Paket ${m[4]}`; if (t === 3) return `SDS request sample ${m[4] | m[5] << 7}`;
      return { 0x7F: 'ACK', 0x7E: 'NAK', 0x7D: 'CANCEL', 0x7C: 'WAIT' }[t] ? `SDS ${{ 0x7F: 'ACK', 0x7E: 'NAK', 0x7D: 'CANCEL', 0x7C: 'WAIT' }[t]} ${m[4]}` : 'Universal Non-Realtime';
    }
    return `SysEx ${m.length} Bytes${m[1] === 0x18 ? ' (E-mu)' : ''}`;
  }
  const ty = s0 & 0xF0, ch = (s0 & 15) + 1;
  if (ty === 0x90 && m[2]) return `Note On  ch ${ch} · ${m[1]} · vel ${m[2]}`;
  if (ty === 0x80 || ty === 0x90) return `Note Off ch ${ch} · ${m[1]}`;
  if (ty === 0xB0) return `CC ch ${ch} · ${m[1]} = ${m[2]}`; if (ty === 0xC0) return `Program ch ${ch} · ${m[1]}`;
  if (s0 === 0xF8) return 'Clock'; if (s0 === 0xFA) return 'Start'; if (s0 === 0xFC) return 'Stop'; if (s0 === 0xFB) return 'Continue'; if (s0 === 0xFE) return 'Active Sensing';
  return '';
}
function mlog(dir, m, note = '') {
  if (!$('#mLogClock').checked && (m[0] === 0xF8 || m[0] === 0xFE)) return;
  const t = new Date().toISOString().slice(11, 23), d = note || describe(m), raw = m.length > 24 ? hx(m.slice(0, 24)) + ` … (${m.length} B)` : hx(m);
  st.mlog.push(`${t} ${dir === 'in' ? 'IN ' : dir === 'out' ? 'OUT' : '!! '} ${raw}${d ? '   ' + d : ''}`);
  if (st.mlog.length > 2000) st.mlog.splice(0, 500);
  const el = $('#mLog'); if (!el || !$('#tab-midi').classList.contains('on')) return;
  clearTimeout(mlog._t); mlog._t = setTimeout(() => { el.textContent = st.mlog.slice(-300).join('\n'); el.scrollTop = el.scrollHeight; }, 60);
}
function msend(m, note) { if (!st.midi.out) { toast('No MIDI out selected.'); return false; } try { st.midi.out.send(m); mlog('out', m, note); return true; } catch (e) { mlog('err', m, 'Send failed: ' + e.message); return false; } }
function midiIn(data) {
  const m = Array.from(data); mlog('in', m);
  if ($('#dOn').checked && driveIn(m)) { if ($('#mCapture').checked && m[0] === 0xF0) st.cap.push(m); return; }
  if (m[0] === 0xF0) {
    if ($('#mCapture').checked) { st.cap.push(m); $('#mCapInfo').textContent = `${st.cap.length} SysEx · ${st.cap.reduce((a, x) => a + x.length, 0)} Bytes`; }
    if (C.isSds(m)) sdsIn(m);
    return;
  }
  const ty = m[0] & 0xF0;
  if (ty === 0xB0 && markerCC(m[0] & 15, m[1], m[2])) return;
  if ($('#mInPads').checked && ty === 0x90 && m[2] > 0) { const p = padOfNote(m[1]); if (p >= 0 && p < 32) hitPadFromMidi(p); }
}
function hitPadFromMidi(p) { // play locally without sending the note back to the SP-12
  const out = st.midi.out; st.midi.out = null; try { hitPad(p, true); } finally { st.midi.out = out; }
}
// --- MIDI disk drive (SP-12 CASSETTE/DISK 3x)
st.drive = { fn: null, blocks: [], cursor: 0, chunkLeft: 0, lastIn: 0, active: false, saved: 0, served: 0, inferred: 0 };
const isEmuMsg = m => m.length >= 5 && m[0] === 0xF0 && m[1] === 0x18 && m[2] === 0x01 && m[m.length - 1] === 0xF7;
function dsend(m, note) { if (st.midi.out) { st.midi.out.send(m); if (note) mlog('out', m, note); } }
function diskForLoad() { const i = +$('#dFile').value; const f = st.files[i]; return f ? C.fileToDisk(f.bytes) : []; }
function dstat(t) { $('#dStatus').textContent = t; flashLcd(t.toUpperCase().slice(0, 24)); }
function driveIn(m) {
  const D = st.drive, now = performance.now();
  if (isEmuMsg(m)) {
    D.lastIn = now; const c = m[3];
    if (c === 0) { Object.assign(D, { fn: null, blocks: [], cursor: 0, chunkLeft: 0, active: true, saved: 0, served: 0, inferred: 0, load: null });
      dsend([0xF0, 0x18, 0x01, C.DISK.STATUS, 0xF7], 'drive ready (status 41h)'); dstat('SP-12 connected'); armSilence(); return true; }
    if (c === 1) { mlog('in', m, 'end of function'); driveEnd(); return true; }
    if (c === 2) { D.fn = 'format'; dsend(C.DISK.ACK, 'ACK (Format)'); return true; }
    if (c === 6 && (m.length - 5) % 293 === 0) {
      D.fn = 'save'; const k = (m.length - 5) / 293; for (let i = 0; i < k; i++) D.blocks.push(C.diskUnpack(m, 4 + 293 * i));
      dsend(C.DISK.ACK); D.saved += k; dstat(`Receiving: ${D.saved} blocks`); return true;
    }
    if (c === 3) return true;                                    // blocks written: the ACK went with the data
    if (c === 4 && m.length === 8) { driveRequest(m[4] * 256 + m[5], m[6], 'read'); return true; }
    if (c === 5) { driveNext(); return true; }
    // while saving, the SP-12 reports blocks written with an 8-bit block number: damaged copies show up as unknown commands – ignore them
    if (D.active && D.fn === 'save') { mlog('in', m, 'damaged block report – ignored'); return true; }
    if (D.active) { mlog('in', m, 'damaged request – continuing'); driveRequest(D.cursor, 24, 'damaged'); return true; }
    return false;
  }
  // damaged read request: parts of it arrive as other MIDI messages while a transfer runs
  if (D.active && D.fn === 'read' && m[0] !== 0xF0 && m[0] < 0xF8) { D.lastIn = now; if (D.chunkLeft === 0) driveRequest(D.cursor, 24, 'damaged'); return true; }  // e.g. 94 18 77 (seen on the real SP-12)
  if (D.active && m[0] === 0xF0 && !isEmuMsg(m)) { D.lastIn = now; if (D.fn === 'read' && D.chunkLeft === 0) driveRequest(D.cursor, 24, 'damaged'); return true; }
  if (D.active && m[0] < 0xF8) { D.lastIn = now; return true; }   // stray bytes of a damaged SP-12 message: never play them as notes
  return false;
}
function driveRequest(B, n, how) {
  const D = st.drive; if (!D.load) { D.load = diskForLoad(); const f = st.files[+$('#dFile').value]; if (f && f.type === 'SP12' && st.files.indexOf(f) === st.sp && overInfo()) { mlog('err', [], 'warning: this sound file is over device memory'); toast('⚠ This sound file is over the SP-12 memory – overflow pads will sound wrong.', 8000); } }
  if (!D.load.length) { mlog('err', [], 'no disk selected'); dstat('No disk selected'); }
  D.fn = 'read'; D.cursor = B; D.chunkLeft = n; if (how !== 'read') D.inferred++;
  dsend(C.DISK.ACK, `ACK Lesen ab Block ${B} (${how})`);
}
function driveNext() {
  const D = st.drive; if (!D.load) D.load = diskForLoad();
  const blk = D.load[D.cursor] || new Uint8Array(256), out = new Uint8Array(298);
  out.set([0xF0, 0x18, 0x01, 0x06]); out.set(C.diskPack(blk), 4); out[297] = 0xF7; dsend(out);
  D.cursor++; D.served++; if (D.chunkLeft > 0) D.chunkLeft--; dstat(`Sending: block ${D.served} of ${D.load.length}`); armSilence();
}
// a request whose block number contained a status byte may vanish completely: after a short silence, continue in order
function armSilence() {
  clearTimeout(st.drive.sil); st.drive.sil = setTimeout(() => {
    const D = st.drive; if (!D.active || D.fn !== 'read' || D.chunkLeft !== 0) return;
    if (performance.now() - D.lastIn < 380) { armSilence(); return; }   // something came in just now: look again
    if (D.load && D.cursor >= D.load.length) return;
    if (D.served === 1 && D.cursor === 1) { // the SP-12 read only block 0 (the file type) and gave up
      const f = st.files[+$('#dFile').value]; D.active = false;
      mlog('err', [], 'SP-12 stopped after block 0'); dstat(`Stopped: wrong file type? Selected: ${f ? f.type : 'none'} – 3 3 needs .SQ12, 3 5 needs .SP12`); { const want = f && f.type === 'SP12' ? 'SQ12' : 'SP12', alt = st.files.map((g, i) => [g, i]).filter(([g]) => g.type === want);
        if (alt.length) { const pick = alt.find(([, i]) => i === (want === 'SQ12' ? st.sq : st.sp)) || alt[0]; $('#dFile').value = String(pick[1]); st.drive.load = null;
          toast(`The SP-12 stopped – wrong file type. Switched to ${pick[0].name.replace(/^[0-9a-f]{8}-/, '')} (${want === 'SQ12' ? '3 3' : '3 5'}). Start the load again.`, 9000); }
        else toast('The SP-12 stopped – probably the wrong file type (3 3 = .SQ12, 3 5 = .SP12).', 8000); } return; }
    mlog('err', [], 'request lost – assuming the next block'); driveRequest(D.cursor, 24, 'inferred');
  }, 400);
}
async function driveEnd() {
  const D = st.drive; D.active = false; clearTimeout(D.sil);
  if (D.fn === 'save' && D.blocks.length) {
    const type = C.diskType(D.blocks) || 'SP12', bytes = C.diskToFile(D.blocks);
    const name = `SP12_${type === 'SQ12' ? 'Sequences' : 'Sounds'}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${type}`;
    dstat(`Received: ${D.blocks.length} blocks (${type})`);
    st.files.push({ name, type, bytes, dirty: true, undo: [] }); activate(st.files.length - 1); renderDiskFiles();
    toast(`${name} received – Save to keep it`, 6000);
  } else if (D.fn === 'read') dstat(`Loaded: ${D.served} blocks sent${D.inferred ? `, ${D.inferred} requests inferred` : ''}`);
  else if (D.fn === 'format') dstat('Format done');
  else dstat('Done');
  D.fn = null;
}
function renderDiskFiles() {
  const sel = $('#dFile'); if (!sel) return; const cur0 = sel.value;
  sel.innerHTML = '<option value="">– none –</option>' + st.files.map((f, i) => `<option value="${i}">${f.name.replace(/^[0-9a-f]{8}-/, '')} (${f.type === 'SQ12' ? 'sequences → 3 3' : 'sounds → 3 5'}, ${C.fileToDisk(f.bytes).length} blocks)</option>`).join('');
  if (cur0 !== '' && st.files[+cur0]) sel.value = cur0; else if (st.hexFile != null) sel.value = st.hexFile;
}
$('#dFile').onchange = () => { st.drive.load = null; };

// --- SDS receive (handshake): ACK each packet, NAK on bad checksum
function sdsIn(m) {
  const t = m[3], S = st.sds;
  if (t === C.SDS.HEADER) {
    const h = C.sdsParseHeader(m); if (!h) return;
    S.rx = { h, words: [], last: -1, t0: performance.now() };
    msend(C.sdsHandshake(h.cc, C.SDS.ACK, 0), 'ACK Header'); sdsProg(); return;
  }
  if (t === C.SDS.PACKET && S.rx) {
    const r = C.sdsParsePacket(m, S.rx.h.bits);
    if (!r || !r.ok) { msend(C.sdsHandshake(S.rx.h.cc, C.SDS.NAK, m[4]), 'NAK (checksum)'); return; }
    if (r.pkt !== ((S.rx.last + 1) & 127)) { msend(C.sdsHandshake(S.rx.h.cc, C.SDS.ACK, r.pkt), 'ACK (doppelt, verworfen)'); return; }
    S.rx.last = r.pkt; S.rx.words.push(...r.words);
    if (S.rx.words.length >= S.rx.h.length) { msend(C.sdsHandshake(S.rx.h.cc, C.SDS.ACK, r.pkt)); sdsDone(); } // last ACK, then finish
    else { msend(C.sdsHandshake(S.rx.h.cc, C.SDS.ACK, r.pkt)); sdsProg(); }
    return;
  }
  if (S.tx && [C.SDS.ACK, C.SDS.NAK, C.SDS.CANCEL, C.SDS.WAIT].includes(t)) S.tx.reply(t, m[4]);
}
function sdsProg() { const r = st.sds.rx; if (r) $('#mSdsProg').textContent = `Receiving sample ${r.h.num}: ${Math.min(100, Math.round(r.words.length / r.h.length * 100))} %`; }
async function sdsDone() {
  const r = st.sds.rx; st.sds.rx = null; const h = r.h, smp = Uint16Array.from(r.words.slice(0, h.length), w => Math.max(0, Math.min(4095, C.toSp12(w, h.bits))));
  const hz = Math.round(1e9 / h.periodNs), dur = ((performance.now() - r.t0) / 1000).toFixed(1);
  $('#mSdsProg').textContent = `Sample ${h.num} empfangen: ${h.length} Worte, ${h.bits} Bit, ${hz} Hz (${dur} s)`;
  st.lastRx = { h, smp };
  const choice = await modal(`<h3 style="margin-top:0">Sample ${h.num} empfangen</h3><p>${h.length} Samples · ${h.bits} Bit · ${hz} Hz${h.loopType !== 0x7F ? ` · Loop ${h.loopStart}–${h.loopEnd}` : ''}</p><p>Was soll damit passieren?</p>`,
    [['Nur behalten', null], ['WAV speichern', 'wav'], ...(st.sp != null ? [['Into selected sound', 'replace'], ['Als neuen Sound', 'append', true]] : [])]);
  if (choice === 'wav') download(C.encodeWav(smp, 0, smp.length, hz), `sp12_sample${h.num}.wav`, 'audio/wav');
  if (choice === 'replace') await replaceWithAudio(null, stripPad(smp));
  if (choice === 'append') await appendAudio(null, stripPad(smp));
}
function stripPad(x) { let a = 0, b = x.length; while (a < b && Math.abs(x[a] - 2048) <= 2) a++; while (b > a && Math.abs(x[b - 1] - 2048) <= 2) b--; return x.subarray(a, b); }
$('#mSdsReq').onclick = () => { const n = +$('#mSdsNum').value || 0; msend(C.sdsRequest(+$('#mSdsCh').value || 0, n), `Request sample ${n}`); $('#mSdsProg').textContent = 'waiting for the SP-12 …'; };
// --- SDS send with handshake (falls back to timed sending if the device never answers)
$('#mSdsSend').onclick = async () => {
  if (st.sp == null) { toast('Open a .SP12 and pick a sound first.'); return; }
  const r = cur(); if (!r) return; const tp = truncPad(), rs = tp != null ? st.padRes[tp] : null;
  const a = rs ? rs.fstart : r.start, len = rs ? rs.len : r.end - r.start, n = +$('#mSdsNum').value || 0, cc = +$('#mSdsCh').value || 0;
  const loop = tp != null && st.pads[tp].loop ? [rs.loopF - a, len - 1, 0] : [0, 0, 0x7F];
  const ok = await modal(`<h3 style="margin-top:0">Send to the SP-12?</h3><p>Sound ${st.region + 1}${tp != null ? ' (pad ' + padName(tp) + ')' : ''} · ${secs(len)} as <b>sample # ${n}</b>.</p><p class="note warn">This overwrites that sound on the SP-12.</p>`, [['Cancel', false], ['Sending', true, true]]);
  if (!ok) return;
  const words = Array.from(st.X.slice(a, a + len)), pk = C.sdsPackets(cc, words, 12);
  const S = st.sds; let waiting = null, handshake = false, cancelled = false;
  S.tx = { reply: (t, pkt) => { handshake = true; if (waiting) { const w = waiting; waiting = null; w(t); } } };
  const wait = ms => new Promise(res => { waiting = res; setTimeout(() => { if (waiting === res) { waiting = null; res('timeout'); } }, ms); });
  if (!msend(C.sdsHeader(cc, n, 12, rate(), len, ...loop), `Header Sample ${n}`)) { S.tx = null; return; }
  let ans = await wait(2000);
  if (ans === C.SDS.CANCEL || ans === C.SDS.NAK) { mlog('err', [], 'SP-12 rejected the header'); S.tx = null; $('#mSdsProg').textContent = 'abgelehnt'; return; }
  for (let i = 0; i < pk.length && !cancelled; i++) {
    let tries = 0;
    for (;;) {
      st.midi.out.send(pk[i]); if (i % 25 === 0) mlog('out', pk[i]);
      $('#mSdsProg').textContent = `Sending ${Math.round((i + 1) / pk.length * 100)} %${handshake ? ' (handshake)' : ' (no reply)'}`;
      ans = await wait(handshake ? 1500 : 25);
      if (ans === C.SDS.WAIT) ans = await wait(10000);
      if (ans === C.SDS.NAK && ++tries < 4) continue;
      if (ans === C.SDS.CANCEL) cancelled = true;
      break;
    }
  }
  S.tx = null; $('#mSdsProg').textContent = cancelled ? 'cancelled by the SP-12' : `Sample ${n} sent (${pk.length} packets${handshake ? ', handshake' : ', no reply'})`;
};
// --- note test: play every pad note once
$('#mNoteTest').onclick = async () => {
  if (!st.midi.out) { toast('Select a MIDI out first.'); return; }
  const ch = (st.midi.cfg.ch - 1) & 15;
  for (let p = 0; p < 32; p++) { const n = noteOfPad(p); msend([0x90 | ch, n, 100], `Test Pad ${padName(p)} → Note ${n}`); await new Promise(r => setTimeout(r, 180)); st.midi.out.send([0x80 | ch, n, 0]); }
};
$('#mPanic').onclick = () => { if (!st.midi.out) return; for (let c = 0; c < 16; c++) st.midi.out.send([0xB0 | c, 123, 0]); mlog('out', [0xB0, 123, 0], 'All Notes Off (all channels)'); };
// --- SysEx capture / replay
$('#mSyxSave').onclick = () => { if (!st.cap.length) { toast('Noch nichts mitgeschnitten.'); return; } download(Uint8Array.from(st.cap.flat()), `sp12_mitschnitt_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.syx`); };
$('#mClear').onclick = () => { st.cap = []; $('#mCapInfo').textContent = ''; };
$('#mSyxFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return; const b = new Uint8Array(await f.arrayBuffer());
  const msgs = []; let cur0 = null; for (const x of b) { if (x === 0xF0) cur0 = [x]; else if (cur0) { cur0.push(x); if (x === 0xF7) { msgs.push(cur0); cur0 = null; } } }
  if (!msgs.length) { toast('No SysEx in this file.'); return; }
  const ok = await modal(`<h3 style="margin-top:0">Send ${msgs.length} SysEx messages?</h3><p>${f.name} · ${b.length} bytes. Data on the SP-12 may be overwritten.</p>`, [['Cancel', false], ['Sending', true, true]]);
  if (!ok || !st.midi.out) return;
  for (let i = 0; i < msgs.length; i++) { st.midi.out.send(msgs[i]); if (i % 20 === 0) { mlog('out', msgs[i]); $('#mCapInfo').textContent = `sende ${i + 1}/${msgs.length}`; } await new Promise(r => setTimeout(r, Math.max(15, msgs[i].length / 3.125))); }
  $('#mCapInfo').textContent = `${msgs.length} Nachrichten gesendet`;
};
$('#mLogSave').onclick = () => download(new TextEncoder().encode(st.mlog.join('\n')), 'sp12_midi_log.txt', 'text/plain');
// --- ports
function renderMidiTab() {
  const a = st.midi.access, c = st.midi.cfg; if (!a) { $('#mStatus').textContent = 'not connected'; return; }
  $('#mIn').innerHTML = '<option value="">– off –</option>' + [...a.inputs.values()].map(p => `<option value="${p.id}" ${p.id === c.inId ? 'selected' : ''}>${p.name}</option>`).join('');
  $('#mOutSel').innerHTML = '<option value="">– off –</option>' + [...a.outputs.values()].map(p => `<option value="${p.id}" ${p.id === c.id ? 'selected' : ''}>${p.name}</option>`).join('');
  $('#mChan').value = c.ch; $('#mBaseN').value = c.base; $('#mMap').value = c.map || 'sp12'; $('#mBaseN').disabled = c.map === 'sp12'; $('#mThruAll').checked = !!c.thruAll;
  $('#mStatus').textContent = `${a.inputs.size} in · ${a.outputs.size} out${a.sysexEnabled ? ' · SysEx' : ' · no SysEx'}`;
}
$('#mConnect').onclick = async () => { if (await midiInit(true)) { renderMidiTab(); toast('MIDI verbunden'); } };
$('#mIn').onchange = e => { st.midi.cfg.inId = e.target.value; saveLS('sp12midi', st.midi.cfg); pickMidiOut(); };
$('#mOutSel').onchange = e => { st.midi.cfg.id = e.target.value; saveLS('sp12midi', st.midi.cfg); pickMidiOut(); };
$('#mChan').onchange = e => { st.midi.cfg.ch = Math.max(1, Math.min(16, +e.target.value || 10)); saveLS('sp12midi', st.midi.cfg); };
$('#mBaseN').onchange = e => { st.midi.cfg.base = Math.max(0, Math.min(96, +e.target.value || 36)); saveLS('sp12midi', st.midi.cfg); };
$('#mMap').onchange = e => { st.midi.cfg.map = e.target.value; saveLS('sp12midi', st.midi.cfg); renderMidiTab(); };
$('#mThruAll').onchange = e => { st.midi.cfg.thruAll = e.target.checked; saveLS('sp12midi', st.midi.cfg); };

// ---------- hex view ----------
const hv = $('#hexView');
function kind(f, o) {
  if (f.type === 'SP12') {
    if (o < 0x200) return 'hdr'; if (o >= C.L.DIR && o < C.L.DIR + C.L.DIRN * 2) return 'dir';
    if (o >= C.L.PADREC && o < C.L.PADREC + 320) return 'pad'; if (o >= C.L.SAMPLES) return 'smp'; return '';
  }
  if (o < 0x200) return 'hdr'; if (o >= C.SEG_TABLE && o < C.SEG_TABLE + 200 || o === C.SONG_PTR || o === C.SONG_PTR + 1) return 'dir'; if (o >= C.L.SQ_KITS && o < C.L.SQ_EVENTS) return 'pad';
  if (st.S && o >= C.L.SQ_EVENTS && o < st.S.evEnd) return 'seg'; return '';
}
function renderHex() {
  const f = st.files[st.hexFile]; if (!f) return;
  const rows = Math.ceil(f.bytes.length / 16); $('#hexSpacer').style.height = rows * 20 + 'px';
  const top = Math.floor(hv.scrollTop / 20), vis = Math.ceil(hv.clientHeight / 20) + 2; let out = '';
  for (let r = top; r < Math.min(rows, top + vis); r++) {
    const o = r * 16; let hx = '', asc = '';
    for (let i = 0; i < 16; i++) {
      const p = o + i; if (p >= f.bytes.length) { hx += '   '; continue; }
      const b = f.bytes[p], k = b === 0 ? 'k-z' : 'k-' + kind(f, p);
      hx += `<span class="x ${k} ${p === st.hexSel ? 's' : ''}" data-o="${p}">${C.hex(b)}</span>${i === 7 ? '  ' : ' '}`;
      asc += b >= 32 && b < 127 ? String.fromCharCode(b).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) : '.';
    }
    out += `<span class="o">${C.hex(o, 6)}</span>  ${hx} <span class="a">${asc}</span>\n`;
  }
  const pre = $('#hexRows'); pre.style.top = top * 20 + 'px'; pre.innerHTML = out;
  $('#hexSelInfo').textContent = st.hexSel != null ? `Offset 0x${C.hex(st.hexSel, 5)} (${st.hexSel})` : '';
}
hv.addEventListener('scroll', () => requestAnimationFrame(renderHex));
$('#hexRows').addEventListener('click', e => { const o = e.target.dataset && e.target.dataset.o; if (o == null) return; st.hexSel = +o; $('#hexVal').value = C.hex(st.files[st.hexFile].bytes[st.hexSel]); renderHex(); });
$('#hexFile').onchange = e => { st.hexFile = +e.target.value; st.hexSel = null; hv.scrollTop = 0; refreshChrome(); };
$('#hexGoto').onchange = e => { const v = e.target.value.trim(); const o = v.startsWith('0x') ? parseInt(v, 16) : parseInt(v, /[a-f]/i.test(v) ? 16 : 10); if (o >= 0) { st.hexSel = o; hv.scrollTop = Math.floor(o / 16) * 20 - 60; renderHex(); } };
$('#hexSet').onclick = () => { if (st.hexSel == null) return; const v = parseInt($('#hexVal').value, 16); if (v >= 0 && v <= 255) setByte(st.hexFile, st.hexSel, v); };

// ---------- info ----------
function renderInfo() { }   // the info page is gone (reduce to the max)

// ---------- wiring ----------
$('#fileIn').onchange = e => { openFiles([...e.target.files]); e.target.value = ''; };
$('#saveBtn').onclick = () => {
  const tab = ($('#tabs .on') || {}).dataset?.tab;
  let list = st.files.filter(f => f.dirty);
  if (!list.length) list = tab === 'hex' || tab === 'info' ? [st.files[st.hexFile]] : [spFile(), sqFile()].filter(Boolean);
  list.forEach((f, i) => setTimeout(() => download(f.bytes, f.name), i * 300));
  list.forEach(f => f.dirty = false); refreshChrome(); toast(`${list.map(f => f.name.replace(/^[0-9a-f]{8}-/, '')).join(', ')} saved`);
};
$('#undoBtn').onclick = undo;
$('#rateSel').onchange = () => { if (st.sp != null) { renderRegions(); drawAll(); renderPads(); } };
$$('#tabs [data-tab]').forEach(b => b.onclick = () => {
  setTimeout(() => { if (b.dataset.tab === 'mixer') renderDesk(); if (b.dataset.tab === 'main' && st.sq != null) drawGrid(); if (b.dataset.tab === 'sample' && st.sp != null) { drawAll(); renderChop(); } }, 0);
  $$('#tabs [data-tab]').forEach(x => x.classList.toggle('on', x === b));
  $$('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'hex') renderHex();
  if (b.dataset.tab === 'midi') { renderMidiTab(); renderDiskFiles(); $('#mLog').textContent = st.mlog.slice(-300).join('\n'); }
});
$$('#subTabs [data-sub]').forEach(b => b.onclick = () => {
  $$('#subTabs [data-sub]').forEach(x => x.classList.toggle('on', x === b)); $$('.subp').forEach(p => p.classList.toggle('on', p.id === 'sub-' + b.dataset.sub));
  if (b.dataset.sub === 'chop' || b.dataset.sub === 'mem') renderChop(); if (b.dataset.sub === 'rec') renderSampPads();
});
$('#newSp12').onclick = () => { newSoundFile(); };
$('#newSq12').onclick = () => { newSeqFile(); };
$$('[data-proxy]').forEach(b => b.onclick = () => $('#' + b.dataset.proxy).click());
let dragDepth = 0;
addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('#drop').classList.add('on'); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) $('#drop').classList.remove('on'); });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('#drop').classList.remove('on'); openFiles([...e.dataTransfer.files]); });
const PADKEYS = ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma']; // y x c v b n m , on a German keyboard
// Note repeat: Shift + pad key repeats the pad at the grid resolution (Raster), locked to the running sequence's grid
const repeats = new Map();
function startRepeat(code, pad) {
  if (repeats.has(code)) return; const c = ctx();
  const R = { pad, next: null };
  const tickSec = () => seqT ? seqT.tickSec : 60 / Math.max(20, +$('#bpm').value || 90) / C.PPQ, res = () => +$('#gridRes').value || 24;
  const firstT = () => {
    const now = c.currentTime;
    if (seqT) { const cur = [...seqT.sched].reverse().find(x => x.t <= now); if (cur) { const tk = (now - cur.t) / seqT.tickSec, r = res(); const near = Math.round(tk / r) * r;
      return (now - (cur.t + near * seqT.tickSec)) < 0.03 ? Math.max(now, cur.t + near * seqT.tickSec) : cur.t + Math.ceil(tk / r) * r * seqT.tickSec; } }
    return now;
  };
  R.next = firstT();
  R.timer = setInterval(() => {
    while (R.next < c.currentTime + 0.04) { hitPad(R.pad, true, Math.max(c.currentTime, R.next)); R.next += res() * tickSec(); }
  }, 8);
  repeats.set(code, R); flashLcd('NOTE REPEAT');
}
function stopRepeat(code) { const R = repeats.get(code); if (R) { clearInterval(R.timer); repeats.delete(code); } }
function stopAllRepeats() { [...repeats.keys()].forEach(stopRepeat); }
addEventListener('keyup', e => { if (e.key === 'Shift') stopAllRepeats(); else stopRepeat(e.code); });
addEventListener('blur', stopAllRepeats);
addEventListener('keydown', e => {
  if ((e.target.matches && e.target.matches('input:not([type=range]),select,textarea')) || !$('#modal').hidden) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); return; }
  if ((e.code === 'Tab' && e.ctrlKey) || e.code === 'IntlBackslash') { e.preventDefault(); st.bank = e.shiftKey ? (st.bank + 2) % 4 + 1 : st.bank % 4 + 1; renderPads(); drawGrid(); flashLcd(`BANK ${st.bank}`); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tab = ($('#tabs .on') || {}).dataset?.tab;
  const k = PADKEYS.indexOf(e.code);
  if (k >= 0) { e.preventDefault(); if (e.repeat) return; const pad = (st.bank - 1) * 8 + k; if (e.shiftKey) startRepeat(e.code, pad); else hitPad(pad, true); return; }
  if (e.code === 'NumpadEnter' || (e.code === 'Enter' && !(e.target.matches && e.target.matches('button')))) { e.preventDefault(); if (st.sq == null) return; seqT ? stopSeq() : startSeq([st.seg], $('#seqLoop').checked); return; }
  if (e.code === 'NumpadDecimal' || e.code === 'NumpadComma' || e.code === 'Period') { e.preventDefault(); if (!e.repeat) toggleRec(); return; }
  if (e.code === 'Tab' && e.shiftKey) { e.preventDefault(); toggleMultiKind(); return; }
  if (e.code === 'Tab') { e.preventDefault(); setMode(NEXTMODE[st.fmode]); return; }
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') { e.preventDefault(); st.fader = (st.fader + (e.code === 'ArrowRight' ? 1 : 7)) % 8; renderPads(); flashLcd(`FADER ${st.fader + 1}`); return; }
  if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
    e.preventDefault();
    const p = (st.bank - 1) * 8 + st.fader, step = (e.shiftKey ? 0.1 : 0.02) * (e.code === 'ArrowUp' ? 1 : -1);
    setFader(p, faderValue(p) + step); renderPads(); flashLcd(faderText(p)); return;
  }
  if (e.key === ' ' && st.sq != null) { e.preventDefault(); seqT ? stopSeq() : $('#seqPlay').click(); return; }
  if (e.key === ' ' && st.sp != null) { e.preventDefault(); src ? stop() : $('#playBtn').click(); return; }
  const bk = /^(Digit|Numpad)([1-4])$/.exec(e.code);
  if (bk && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); st.bank = +bk[2]; renderPads(); drawGrid(); flashLcd(`BANK ${st.bank}`); return; }
});
addEventListener('beforeunload', e => { if (st.files.some(f => f.dirty)) { e.preventDefault(); e.returnValue = ''; } });

// PWA
let deferred = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('#installBtn').hidden = false; });
$('#installBtn').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#installBtn').hidden = true; };
// ---------- Sampling (like the SP-12's SAMPLE module): VU, assign voice, level, threshold, length, re-sample, arm, force;
// plus Auto (each hit onto the next pad) and Lazy Chop (press pads while the sound runs in: each press starts the next sample)
const SR_WORKLET = `class SP12Rec extends AudioWorkletProcessor {
  constructor() { super(); this.mode = 'mix'; this.buf = new Float32Array(1024); this.n = 0; this.port.onmessage = e => { this.mode = e.data; }; }
  process(inputs) { const ch = inputs[0]; if (!ch || !ch.length) return true; const a = ch[0], b = ch[1] || ch[0], m = this.mode;
    for (let i = 0; i < a.length; i++) { this.buf[this.n++] = m === 'L' ? a[i] : m === 'R' ? b[i] : (a[i] + b[i]) * 0.5; if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(1024); this.n = 0; } }
    return true; } }
registerProcessor('sp12-rec', SP12Rec);`;
st.samp = { on: false, chunks: [], total: 0, state: 'idle', peak: 0, hold: 0, last: null, lazy: null };
const dB = x => x > 0 ? 20 * Math.log10(x) : -120;
async function sampInputs() {
  try { const devs = await navigator.mediaDevices.enumerateDevices(); const el = $('#smpIn'), v = el.value;
    el.innerHTML = devs.filter(d => d.kind === 'audioinput').map(d => `<option value="${d.deviceId}">${d.label || 'Input ' + d.deviceId.slice(0, 6)}</option>`).join(''); if (v) el.value = v; } catch (e) { }
}
async function sampStart() {
  const S = st.samp; if (S.on) return true; const c = ctx();
  try {
    const id = $('#smpIn').value;
    S.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } });
  } catch (e) { toast('No access to the audio input: ' + e.message, 6000); return false; }
  await sampInputs();
  if (!S.mod) { const url = URL.createObjectURL(new Blob([SR_WORKLET], { type: 'text/javascript' })); await c.audioWorklet.addModule(url); S.mod = true; }
  S.src = c.createMediaStreamSource(S.stream); S.gain = c.createGain(); S.gain.gain.value = Math.pow(10, (+$('#smpLevel').value) / 20);
  S.node = new AudioWorkletNode(c, 'sp12-rec', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
  S.node.port.postMessage($('#smpCh').value);
  S.mon = c.createGain(); S.mon.gain.value = $('#smpMon').checked ? 1 : 0;
  S.src.connect(S.gain); S.gain.connect(S.node); S.gain.connect(S.mon); S.mon.connect(c.destination);
  S.sr = c.sampleRate; S.chunks = []; S.total = 0; S.on = true;
  S.node.port.onmessage = e => sampChunk(e.data);
  sampDraw(); $('#smpPower').textContent = 'Input off'; return true;
}
function sampStop() {
  const S = st.samp; if (!S.on) return; sampEnd(true);
  try { S.src.disconnect(); S.gain.disconnect(); S.mon.disconnect(); S.node.port.onmessage = null; S.node.disconnect(); } catch (e) { }
  S.stream.getTracks().forEach(t => t.stop()); S.on = false; S.state = 'idle'; $('#smpPower').textContent = 'Input on'; sampStatus('Input off');
}
// all input kept for up to 60 s (lazy chop / pre-roll); samples are addressed by their running index
function sampChunk(x) {
  const S = st.samp, i0 = S.total; S.chunks.push({ i0, x }); S.total += x.length;
  while (S.chunks.length && S.total - S.chunks[0].i0 > S.sr * 60) S.chunks.shift();
  let pk = 0, first = -1; const thr = Math.pow(10, (+$('#smpThr').value) / 20);
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > pk) pk = a; if (first < 0 && a >= thr) first = i0 + i; }
  S.peak = Math.max(pk, S.peak * 0.92); if (pk > 0.99) S.clip = performance.now();
  const maxLen = Math.round(+$('#smpLen').value * S.sr);
  if (S.state === 'armed' && first >= 0) { S.state = 'rec'; S.start = Math.max(0, first - Math.round(S.sr * 0.004)); S.quiet = 0; sampStatus('Sampling …'); }
  if (S.state === 'rec') {
    if (S.mode === 'auto') { if (pk < thr * 0.7) S.quiet += x.length; else S.quiet = 0; if (S.quiet > S.sr * (+$('#smpRel').value) / 1000) { sampTake(S.start, S.total - S.quiet + Math.round(S.sr * 0.02)); S.state = 'armed'; sampStatus(`Auto: waiting → pad ${padName(S.pad)}`); return; } }
    if (S.total - S.start >= maxLen) { sampTake(S.start, S.start + maxLen); S.state = S.mode === 'auto' ? 'armed' : 'idle'; if (S.mode === 'auto') sampStatus(`Auto: waiting → pad ${padName(S.pad)}`); }
  }
}
function sampSlice(a, b) {
  const S = st.samp, out = new Float32Array(Math.max(0, b - a));
  S.chunks.forEach(ch => { const s = Math.max(a, ch.i0), e = Math.min(b, ch.i0 + ch.x.length); if (e > s) out.set(ch.x.subarray(s - ch.i0, e - ch.i0), s - a); });
  return out;
}
// a recorded stretch onto the current pad: down to 26.04 kHz / 12 bit (the SP-12's format), at most 2.5 s
async function sampTake(a, b) {
  const S = st.samp, p = S.pad; if (p == null || b - a < S.sr * 0.01) return;
  const chopOut = S.lazy ? +$('#chOut').value & 7 : null;
  const cap = $('#smpCap').checked, tk0 = +$('#smpTrick').value || 0, f = sampSlice(a, cap ? Math.min(b, a + Math.round(S.sr * 2.5 * (tk0 ? squeezeF(16, tk0) : 1))) : b); S.last = { mode: S.mode, pad: p };
  if (S.mode === 'auto' || S.mode === 'lazy') S.pad = nextSampPad(p);
  const n = Math.max(1, Math.round(f.length * rate() / S.sr)), off = new OfflineAudioContext(1, n, rate()), buf = off.createBuffer(1, f.length, S.sr); buf.copyToChannel(f, 0);
  const s = off.createBufferSource(); s.buffer = buf; s.connect(off.destination); s.start(); const r = await off.startRendering();
  let x = C.floatTo12(r.getChannelData(0)); const tk = +$('#smpTrick').value || 0;
  if (tk) x = await resampleBy(x, squeezeF(16, tk));            // memory trick right away: stored faster, tuned down by tk
  if (!cap && x.length > C.MAXSND - 5) { S.queue = (S.queue || Promise.resolve()).then(() => { longToPad(x, p, `Sample ${padName(p)}`); if (S.state === 'idle' && !S.lazy) sampStatus(`Done: pad ${padName(p)} · ${secs(x.length)} (app only)`); }); renderSampPads(); return; }
  x = x.slice(0, C.MAXSND - 5);
  S.queue = (S.queue || Promise.resolve()).then(() => { commitSample(x, p, tk, chopOut, `Sampled → pad ${padName(p)} (${secs(x.length)})`); if (S.state === 'idle' && !S.lazy) sampStatus(`Done: pad ${padName(p)} · ${secs(x.length)}`); });
  renderSampPads();
}
function commitSample(x, p, tk, out, label) {
  if (st.sp == null) newSoundFile();
  const w = withSilence(x), pd = st.pads[p]; st.padWav.delete(p);
  rebuildWith([{ data: w.data, pref: null, refs: [{ pad: p, off: 0, len: w.data.length, loopOff: null, desc0: (((st.padRes[p] ? pd.sound : (pd.sound & 0x07)) & 0x7F) & (out != null ? 0x78 : 0xFF)) | (out ?? 0), tuneIdx: 16 - (tk || 0) }] }], [p], label + (tk ? ` · trick −${tk} st` : '') + overNote());
}
function nextSampPad(p) { const over = $('#smpOver').checked; for (let k = 1; k <= 32; k++) { const q = (p + k) % 32; if (over || !st.padRes[q]) return q; } return (p + 1) % 32; }
function sampEnd(silent) { const S = st.samp; if (S.state === 'rec' || S.lazy) { const end = S.total; if (S.lazy && S.lazy.pad != null) { S.pad = S.lazy.pad; sampTake(S.lazy.start, end); } else if (S.state === 'rec') sampTake(S.start, end); } S.lazy = null; S.state = 'idle'; if (!silent) sampStatus('Stopped'); renderSampPads(); }
// Lazy Chop: while the input runs, each pad press closes the running sample and starts the next one on that pad, seamlessly
function lazyPad(p) {
  const S = st.samp, now = S.total;
  if (S.lazy.pad != null) { S.pad = S.lazy.pad; const mode = S.mode; S.mode = 'single'; sampTake(S.lazy.start, now); S.mode = mode; }
  S.lazy = { pad: p, start: now }; sampStatus(`Lazy chop: recording pad ${padName(p)} …`); renderSampPads(p);
}
function sampStatus(t) { const el = $('#smpStatus'); if (el) el.textContent = t; flashLcd(t.toUpperCase().slice(0, 24)); }
function renderSampPads(cur) { const el = $('#smpPad'); if (!el) return; const v = cur ?? st.samp.pad ?? st.padSel ?? 24; el.innerHTML = Array.from({ length: 32 }, (_, p) => `<option value="${p}">${padName(p)} ${st.padRes && st.padRes[p] ? '· sample' : ''}</option>`).join(''); el.value = v; }
function sampDraw() {
  const S = st.samp, cv = $('#smpVu'); if (!cv || !S.on) return;
  const d = fitCanvas(cv), g = cv.getContext('2d'), W = cv.width, H = cv.height, toX = db => Math.max(0, Math.min(1, (db + 60) / 60)) * W;
  g.fillStyle = '#13202e'; g.fillRect(0, 0, W, H);
  const pk = dB(S.peak); g.fillStyle = pk > -1 ? '#ff3326' : pk > -9 ? '#ffd27a' : '#5fd38d'; g.fillRect(0, 0, toX(pk), H);
  g.fillStyle = '#fff'; g.fillRect(toX(+$('#smpThr').value) - d, 0, 2 * d, H);
  g.fillStyle = '#cfe0f0'; g.font = `${10 * d}px ui-monospace,monospace`; g.fillText(`${pk.toFixed(1)} dB${S.clip && performance.now() - S.clip < 1500 ? '  CLIP' : ''}  ${S.state === 'rec' || S.lazy ? '● REC' : S.state === 'armed' ? 'ARMED' : ''}`, 4 * d, H - 5 * d);
  if ($('#smpVuLcd').checked) led(`VU ${'█'.repeat(Math.round(Math.max(0, (pk + 48) / 3)))}`.slice(0, 24));
  requestAnimationFrame(sampDraw);
}
// an empty .SQ12: no segments, no song, the 8 mixes from the open sound file (or the factory-like set)
const MIX_DEFAULT = [0x1a, 0x1a, 0x0b, 0x0b, 0x1b, 0x1b, 0x1b, 0x25, 0, 1, 0, 1, 0x20, 0x21, 0x20, 0x21, 0xae, 0xae, 0xae, 0x14, 0x14, 0xa7, 0x97, 0x97, 0x1e, 0x1f, 0x1e, 0x1f, 0x1e, 0x1f, 0x1e, 0x1f];
function newSeqFile() {
  const low = 0x497, b = new Uint8Array(0x200 + Math.ceil((low - 0x200) / 256) * 256); b.set([0, 1, 0, 0, 0], 0); b[0x200] = 0x17;
  C.setLe16(b, 0x201, 0xFFFF); C.setLe16(b, 0x203, low + 0x6CFD); C.setLe16(b, 0x205, 0xFFFF);           // RAM top, lower top (= data start), upper bottom
  const mix = st.sp != null ? st.pads.slice(0, 32).map(p => p.sound) : MIX_DEFAULT; for (let k = 0; k < 8; k++) b.set(mix, C.L.SQ_KITS + 32 * k);
  C.setPages(b); const b2 = C.writeSongs(b, []); st.files.push({ name: 'New.SQ12', type: 'SQ12', bytes: b2, dirty: true, undo: [] }); st.sq = st.files.length - 1; st.seg = null; st.songN = null;
  refreshSQ(); refreshChrome(); toast('New sequence file – add segments with + Seg, a song under Song');
}
function newSoundFile() { // an empty .SP12 to sample into
  const b = new Uint8Array(0x600 + 512); b.set([0, 1, 0, 0, 0], 0); b[0x200] = 0x18;
  for (let n = 0; n < 32; n++) b.set(C.eraseRecord(n), C.L.PADREC + 10 * n); C.setPages(b);
  st.files.push({ name: 'New.SP12', type: 'SP12', bytes: b, dirty: true, undo: [] }); st.sp = st.files.length - 1; st.extra.set(st.sp, new Set()); refreshSP(true); refreshChrome();
}
async function sampGo(kind) {
  if (!(await sampStart())) return; const S = st.samp;
  S.mode = $('#smpMode').value; S.pad = kind === 're' && S.last ? S.last.pad : +$('#smpPad').value; if (kind === 're' && S.last) S.mode = S.last.mode === 'lazy' ? 'single' : S.last.mode;
  if (S.mode === 'lazy') { S.lazy = { pad: null, start: 0 }; S.state = 'idle'; sampStatus('Lazy chop: play the sound in, hit pads'); return; }
  if (kind === 'force') { S.state = 'rec'; S.start = S.total; S.quiet = 0; sampStatus(`Sampling → pad ${padName(S.pad)} …`); }
  else { S.state = 'armed'; sampStatus(`Armed: ${$('#smpThr').value} dB → pad ${padName(S.pad)}`); }
}

$('#smpPower').onclick = () => st.samp.on ? sampStop() : sampStart().then(ok => ok && sampStatus('Input on'));
$('#smpLevel').oninput = e => { $('#smpLevelOut').textContent = `${e.target.value} dB`; if (st.samp.gain) st.samp.gain.gain.value = Math.pow(10, (+e.target.value) / 20); };
$('#smpThr').oninput = e => { $('#smpThrOut').textContent = `${e.target.value} dB`; };
$('#smpLen').oninput = e => { $('#smpLenOut').textContent = `${(+e.target.value).toFixed(1)} s`; };
$('#smpMon').onchange = e => { if (st.samp.mon) st.samp.mon.gain.value = e.target.checked ? 1 : 0; };
$('#smpCh').onchange = e => { if (st.samp.node) st.samp.node.port.postMessage(e.target.value); };
$('#smpIn').onchange = () => { if (st.samp.on) { sampStop(); sampStart(); } };
$('#smpArm').onclick = () => sampGo('arm'); $('#smpForce').onclick = () => sampGo('force'); $('#smpRe').onclick = () => sampGo('re');
$('#smpStopBtn').onclick = () => sampEnd(false);
renderSampPads();

// ---------- memory trick (like sampling at 45 rpm and tuning down): store a sound faster, play it k semitones lower ----------
// The data get shorter by the factor F = pitch(t) / pitch(t - k); the tuning index drops by k, so it plays at its old
// speed and pitch again – with the grit of the lower playback rate. Only sounds in tune mode (decay mode has no tuning).
async function resampleBy(x, F) { // 12-bit at rate() played F times faster -> 12-bit at rate()
  const n = Math.max(1, Math.round(x.length / F)), off = new OfflineAudioContext(1, n, rate()), buf = off.createBuffer(1, x.length, rate() * F), d = buf.getChannelData(0);
  for (let i = 0; i < x.length; i++) d[i] = (x[i] - 2048) / 2048;
  const s = off.createBufferSource(); s.buffer = buf; s.connect(off.destination); s.start(); const r = await off.startRendering();
  return C.floatTo12(r.getChannelData(0));
}
const squeezeF = (t, k) => pitchRatio(t) / pitchRatio(t - k);
function packFits(sizes, zones) { const bins = Array(zones).fill(0); for (const z of sizes.slice().sort((a, b) => b - a)) { const i = bins.findIndex(u => u + z <= C.BANK); if (i < 0) return false; bins[i] += z; } return true; }
function squeezePlan(reserve, maxK) {
  const items = soundList().filter(s => s.refs.length).map(s => {
    const tunes = s.refs.map(r => st.pads[r.pad].tune >> 3), dm = s.refs.some(r => st.pads[r.pad].sound & 0x80);
    return { s, len: s.data.length, t: tunes[0], maxK: dm ? 0 : Math.min(maxK, ...tunes), k: 0, why: dm ? 'Decay-Modus' : '' };
  });
  [...st.padWav.entries()].forEach(([p, buf]) => { if (buf.length * rate() / buf.sampleRate <= C.MAXSND) return;
    items.push({ wav: p, buf, len: Math.round(buf.length * rate() / buf.sampleRate) + 5, t: 16, maxK: Math.min(16, maxK), k: 0, why: '' }); });
  const size = it => Math.ceil(it.len / (it.k ? squeezeF(it.t, it.k) : 1)) + C.FILLER, zones = memZones(), cap = zones * C.BANK - Math.round(reserve * rate());
  const ok = () => items.every(it => size(it) - C.FILLER <= C.MAXSND) && items.reduce((a, it) => a + size(it), 0) <= cap && packFits(items.map(size), zones);
  items.forEach(it => { while (size(it) - C.FILLER > C.MAXSND && it.k < it.maxK) it.k++; });    // first: nothing over 2.5 s
  // then as little as possible, spread out: the next semitone goes where it saves most for the least extra grit
  let guard = 0; while (!ok() && guard++ < 2000) { const c = items.filter(it => it.k < it.maxK).sort((a, b) => size(b) / (b.k + 1) - size(a) / (a.k + 1))[0]; if (!c) break; c.k++; }
  return { items, ok: ok(), size, total: items.reduce((a, it) => a + size(it), 0), cap };
}
async function squeezeMemory() {
  if (st.sp == null) { toast('Open a .SP12 first.'); return; }
  const ok0 = await modal(`<p><b>Squeeze to fit:</b> samples are stored faster and tuned down by the same semitones – same speed and pitch, less memory, more grit.</p>
    <label>Keep free <input id="sqRes" type="number" min="0" max="5" step="0.1" value="0" style="width:60px"> s</label>
    <label>Max <input id="sqMax" type="number" min="1" max="16" value="12" style="width:52px"> semitones per sample</label>
    `, [['Cancel', null], ['Preview', 'ok', true]]);
  if (ok0 !== 'ok') return;
  const P = squeezePlan(Math.max(0, +$('#sqRes').value || 0), Math.max(1, Math.min(16, +$('#sqMax').value || 12)));
  const rows = P.items.filter(it => it.k || it.why || it.wav != null).map(it => `<tr><td>${it.wav != null ? 'Pad ' + padName(it.wav) + ' (app only)' : 'Pads ' + it.s.refs.map(r => padName(r.pad)).join(' ')}</td><td>${it.k ? '−' + it.k + ' st' : it.why || '–'}</td><td>${secs(it.len)} → ${secs(P.size(it) - C.FILLER)}</td></tr>`).join('');
  const go = await modal(`<p>${P.ok ? 'Fits:' : '<b class="warnTxt">Still does not fit</b> – allow more semitones or delete sounds.'} ${secs(P.total)} of ${secs(P.cap)}.</p>
    <table class="grid"><tr><th>Sound</th><th>Trick</th><th>Length</th></tr>${rows || '<tr><td colspan="3">nothing to do – it fits</td></tr>'}</table>`, [['Cancel', null], ['Convert', 'ok', true]]);
  if (go !== 'ok' || !P.items.some(it => it.k)) return;
  toast('Converting …', 2000); const f = spFile(), out = [], wavPads = [];
  for (const it of P.items) {
    if (it.wav != null) { if (!it.k) continue; const fl = it.buf.getChannelData(0), x = new Uint16Array(fl.length); for (let i = 0; i < fl.length; i++) x[i] = Math.max(0, Math.min(4095, Math.round(2048 + fl[i] * 2047)));
      const y = withSilence(await resampleBy(x, squeezeF(16, it.k) * it.buf.sampleRate / rate())).data, pd = st.pads[it.wav];
      out.push({ data: y, pref: null, refs: [{ pad: it.wav, off: 0, len: y.length, loopOff: null, desc0: pd.sound & 0x07, tuneIdx: 16 - it.k }], isWav: true }); wavPads.push(it.wav); continue; }
    if (!it.k) { out.push(it.s); continue; }
    const F = squeezeF(it.t, it.k), y = await resampleBy(it.s.data, F), sc = v => Math.round(v / F); y.fill(2048, 0, 5);   // keep the clean sound start
    out.push({ data: y, pref: null, refs: it.s.refs.map(r => ({ ...r, off: sc(r.off), len: Math.min(y.length - sc(r.off), sc(r.len)), loopOff: r.loopOff != null ? sc(r.loopOff) : null, tuneIdx: (st.pads[r.pad].tune >> 3) - it.k })) });
  }
  const wp = new Set(wavPads), list = out.map(s => s.isWav ? s : { ...s, refs: s.refs.filter(r => !wp.has(r.pad)) }).filter(s => s.refs.length);
  let res; try { res = C.rebuildSP(f.bytes, st.pads, list, { rambo: !!st.opt.rambo, zones: st.opt.zones || 8, overflow: true }); } catch (e) { toast(e.message, 6000); return; }
  snapshot(st.sp); f.bytes = res.bytes; f.dirty = true; wavPads.forEach(p => st.padWav.delete(p)); st.extra.set(st.sp, new Set()); refreshSP(true); refreshChrome();
  toast(`Squeezed ${P.items.filter(it => it.k).length} sounds · ${secs(memUsed())} used` + overNote(), 6000);
}

$('#sqBtn').onclick = squeezeMemory;
function smpLenMax() { const k = +$('#smpTrick').value || 0, mx = $('#smpCap').checked ? (2.5 * (k ? squeezeF(16, k) : 1)).toFixed(1) : '30', L = $('#smpLen'); L.max = mx; if (+L.value > +mx) L.value = mx; $('#smpLenOut').textContent = `${(+L.value).toFixed(1)} s`; L.title = `5 · Sample length (up to ${mx} s)`; }
$('#smpCap').onchange = e => { st.opt.smpCap = e.target.checked; saveLS('sp12opt', st.opt); smpLenMax(); if (!e.target.checked) { $('#smpLen').value = Math.max(+$('#smpLen').value, 10); smpLenMax(); } };
queueMicrotask(() => { $('#smpCap').checked = st.opt.smpCap !== false; smpLenMax(); });
$('#smpTrick').onchange = e => { smpLenMax(); return; const k = +e.target.value || 0, mx = (2.5 * (k ? squeezeF(16, k) : 1)).toFixed(1), L = $('#smpLen'); L.max = mx; if (+L.value > +mx) L.value = mx; $('#smpLenOut').textContent = `${(+L.value).toFixed(1)} s`; L.title = `5 · Sample length (up to ${mx} s with trick)`; };

// ---------- drum-break separator: drums out of the mix (HPSS), hits found and sorted, the best ones onto free pads ----------
async function drumSeparate() {
  const src = chopSource(); if (!src) { toast('Pick a source first: a pad with a sample, or a file under Chop.', 7000); return; }
  if (st.sp == null) newSoundFile();
  const ok = await modal(`<p><b>Drum break → pads</b> · ${src.name} (${secs(src.x.length)})</p>
    
    <label>Max length <input id="dsLen" type="number" min="0.1" max="2.5" step="0.05" value="0.5" style="width:60px"> s</label>
    <label>Sensitivity <input id="dsSens" type="range" min="0" max="1" step="0.05" value="0.5"></label>
    <label>Free pads from <select id="dsTo">${Array.from({ length: 32 }, (_, p) => `<option value="${p}" ${p === (+$('#chTo').value || 24) ? 'selected' : ''}>${padName(p)}${st.padRes[p] ? ' · Sample' : ''}</option>`).join('')}</select></label>
    <label class="chk"><input type="checkbox" id="dsRom" ${$('#chRom').checked ? 'checked' : ''}> ROM pads too</label>`, [['Cancel', null], ['Analyse', 'ok', true]]);
  if (ok !== 'ok') return;
  const maxLen = Math.max(0.1, Math.min(2.5, +$('#dsLen').value || 0.5)), sens = +$('#dsSens').value, to = +$('#dsTo').value, rom = $('#dsRom').checked;
  led('ANALYSING …'); toast('Analysing …', 2000); await new Promise(r => setTimeout(r, 30));
  const sr = rate(), x = Float32Array.from(src.x, v => (v - 2048) / 2048);
  const A = DS.analyse(x, sr, { maxLen, sens });
  if (!A.picked.length) { toast('No drum hits found. Raise the sensitivity or pick another source.', 6000); return; }
  const from = x;   // always the original sound
  // kicks from the original: the separation also takes their low, tonal tail (that is how HPSS works); the rest from the drum track
  const cut = h => { const kick = /kick/.test(h.kind), d = /hat/.test(h.kind) ? h.ft.decHigh : h.ft.decay, end = kick ? h.end : Math.min(h.end, h.start + Math.max(Math.round(0.15 * sr), Math.round(d * 2.2 * sr))), seg = from.slice(h.start, Math.max(h.start + 64, end)), fl = Math.min(seg.length >> 2, Math.round(sr * 0.008));
    for (let i = 0; i < fl; i++) seg[seg.length - fl + i] *= 1 - (i + 1) / fl; return seg; };
  // free pads from the chosen one on
  const targets = []; for (let k = 0; k < 32 && targets.length < A.picked.length; k++) { const p = (to + k) % 32; if (st.padRes[p]) continue; if (!rom && !st.opt.rambo && p < 24 && !C.isEmptyPad(st.pads[p])) continue; targets.push(p); }
  const counts = {}; A.hits.forEach(h => counts[h.kind] = (counts[h.kind] || 0) + 1);
  const rows = A.picked.map((h, i) => `<tr><td>${h.label}</td><td>${targets[i] != null ? padName(targets[i]) : '– no free pad'}</td><td>${(cut(h).length / sr).toFixed(2)} s</td><td>@ ${(h.start / sr).toFixed(2)} s</td><td><button class="btn ghost" data-aud="${i}">▶</button></td></tr>`).join('');
  const peek = modal(`<p>${A.hits.length} hits (kick ${counts.kick || 0}, snare ${counts.snare || 0}, hat ${counts.hihat || 0}, open hat ${counts.openhat || 0}, perc ${counts.perc || 0}). Picked:</p>
    <table class="grid"><tr><th>Element</th><th>Pad</th><th>Length</th><th>Where</th><th></th></tr>${rows}</table>
`, [['Cancel', null], ['To pads', 'ok', true]]);
  const play = f => { const c = ctx(), b = c.createBuffer(1, f.length, sr); b.copyToChannel(f, 0); const s0 = c.createBufferSource(); s0.buffer = b; s0.connect(c.destination); s0.start(); st.dsPlay && st.dsPlay.stop && (() => { try { st.dsPlay.stop(); } catch (e) { } })(); st.dsPlay = s0; };
  setTimeout(() => { $$('[data-aud]').forEach(b => b.onclick = () => play(cut(A.picked[+b.dataset.aud]))); }, 30);
  if (await peek !== 'ok') { try { st.dsPlay && st.dsPlay.stop(); } catch (e) { } return; }
  const k = Math.min(A.picked.length, targets.length), sounds = [];
  for (let i = 0; i < k; i++) { const w = withSilence(C.floatTo12(cut(A.picked[i]))), pd = st.pads[targets[i]]; sounds.push({ data: w.data, pref: null, refs: [{ pad: targets[i], off: 0, len: w.data.length, loopOff: null, desc0: pd.sound & 0x07, tuneIdx: 16 }] }); }
  rebuildWith(sounds, targets.slice(0, k), A.picked.slice(0, k).map((h, i) => `${h.label} → ${padName(targets[i])}`).join(' · ') + overNote());
}
$('#dsBtn').onclick = drumSeparate;

// ---------- mixing desk tab (SSL-style): see mixer.js ----------
const KN = { // knob specs: min, max, default, log scale, colour, label, format
  drive: [0, 24, 0, 0, 'red', 'DRIVE', v => v < 0.1 ? 'off' : `+${v.toFixed(0)} dB`],
  thr: [-40, 0, 0, 0, 'grey', 'THR', v => `${v.toFixed(0)} dB`], ratio: [1, 20, 1, 1, 'grey', 'RAT', v => v < 1.05 ? 'off' : `${v.toFixed(1)}:1`],
  rel: [0.05, 2, 0.2, 1, 'grey', 'REL', v => `${(v * 1000).toFixed(0)} ms`], makeup: [0, 20, 0, 0, 'grey', 'GAIN', v => `+${v.toFixed(1)}`],
  hpf: [20, 400, 20, 1, 'black', 'HPF', v => v < 21 ? 'off' : `${v.toFixed(0)}`], lpf: [2000, 20000, 20000, 1, 'black', 'LPF', v => v > 19900 ? 'off' : `${(v / 1000).toFixed(1)}k`],
  hf: [-15, 15, 0, 0, 'red', 'HF', v => `${v.toFixed(1)}`], hff: [1500, 16000, 8000, 1, 'red', 'kHz', v => `${(v / 1000).toFixed(1)}`],
  hmf: [-15, 15, 0, 0, 'green', 'HMF', v => `${v.toFixed(1)}`], hmff: [600, 7000, 3000, 1, 'green', 'kHz', v => `${(v / 1000).toFixed(1)}`], hmq: [0.3, 4, 1, 1, 'green', 'Q', v => v.toFixed(1)],
  lmf: [-15, 15, 0, 0, 'blue', 'LMF', v => `${v.toFixed(1)}`], lmff: [100, 2000, 600, 1, 'blue', 'Hz', v => `${v.toFixed(0)}`], lmq: [0.3, 4, 1, 1, 'blue', 'Q', v => v.toFixed(1)],
  lf: [-15, 15, 0, 0, 'brown', 'LF', v => `${v.toFixed(1)}`], lff: [30, 450, 100, 1, 'brown', 'Hz', v => `${v.toFixed(0)}`],
  aux1: [0, 1, 0, 0, 'yellow', 'REV', v => `${Math.round(v * 100)}`], aux2: [0, 1, 0, 0, 'yellow', 'DLY', v => `${Math.round(v * 100)}`],
  pan: [-1, 1, 0, 0, 'white', 'PAN', v => Math.abs(v) < 0.02 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`],
  'grp.A.thr': [-40, 0, 0, 0, 'grey', 'THR', v => `${v.toFixed(0)} dB`], 'grp.A.ratio': [1, 10, 1, 1, 'grey', 'RAT', v => v < 1.05 ? 'off' : `${v.toFixed(1)}:1`],
  'grp.B.thr': [-40, 0, 0, 0, 'grey', 'THR', v => `${v.toFixed(0)} dB`], 'grp.B.ratio': [1, 10, 1, 1, 'grey', 'RAT', v => v < 1.05 ? 'off' : `${v.toFixed(1)}:1`],
  'bus.thr': [-30, 0, -10, 0, 'grey', 'THR', v => `${v.toFixed(0)} dB`], 'bus.makeup': [0, 15, 0, 0, 'grey', 'MAKE', v => `+${v.toFixed(1)}`],
  'bus.ratio': [0, 2, 1, 0, 'grey', 'RATIO', v => ['2', '4', '10'][Math.round(v)] + ':1'], 'bus.att': [0, 5, 2, 0, 'grey', 'ATT', v => ['0.1', '0.3', '1', '3', '10', '30'][Math.round(v)] + ' ms'],
  'bus.rel': [0, 4, 1, 0, 'grey', 'REL', v => ['0.1', '0.3', '0.6', '1.2', 'auto'][Math.round(v)]],
  'rev.size': [0.3, 4, 1.8, 1, 'yellow', 'SIZE', v => `${v.toFixed(1)} s`], 'rev.pre': [0, 0.2, 0.02, 0, 'yellow', 'PRE', v => `${Math.round(v * 1000)} ms`],
  'rev.lo': [20, 1000, 120, 1, 'brown', 'LO CUT', v => `${v.toFixed(0)}`], 'rev.hi': [1000, 16000, 9000, 1, 'red', 'HI CUT', v => `${(v / 1000).toFixed(1)}k`],
  'rev.level': [0, 1, 0, 0, 'yellow', 'RETURN', v => `${Math.round(v * 100)}`],
  'dly.time': [0.02, 1.5, 0.375, 1, 'yellow', 'TIME', v => `${Math.round(v * 1000)} ms`], 'dly.fb': [0, 0.9, 0.35, 0, 'yellow', 'FDBK', v => `${Math.round(v * 100)}`], 'dly.level': [0, 1, 0, 0, 'yellow', 'RETURN', v => `${Math.round(v * 100)}`],
};
const BUSV = { 'bus.ratio': [2, 4, 10], 'bus.att': [0.0001, 0.0003, 0.001, 0.003, 0.01, 0.03], 'bus.rel': [0.1, 0.3, 0.6, 1.2, 0.4] };
const pathOf = (c, k) => k.includes('.') ? k.split('.') : ['ch', c, k];
const knobGet = (c, k) => { const P = pathOf(c, k); let o = MX.desk; for (let i = 0; i < P.length - 1; i++) o = o[P[i]]; const v = o[P[P.length - 1]]; if (BUSV[k]) { const j = BUSV[k].indexOf(v); return j < 0 ? 1 : j; } return v; };
const knobSet = (c, k, v) => { const P = pathOf(c, k); let o = MX.desk; for (let i = 0; i < P.length - 1; i++) o = o[P[i]]; o[P[P.length - 1]] = BUSV[k] ? BUSV[k][Math.round(v)] : v; };
const toN = (sp, v) => sp[3] ? Math.log(v / sp[0]) / Math.log(sp[1] / sp[0]) : (v - sp[0]) / (sp[1] - sp[0]);
const fromN = (sp, n) => { n = Math.max(0, Math.min(1, n)); return sp[3] ? sp[0] * Math.pow(sp[1] / sp[0], n) : sp[0] + n * (sp[1] - sp[0]); };
const knobHtml = (c, k) => { const sp = KN[k], v = knobGet(c, k); return `<div class="kn ${sp[4]}" data-c="${c}" data-k="${k}" title="${sp[5]}"><i style="--r:${(-135 + 270 * toN(sp, v)).toFixed(1)}deg"></i><small>${sp[5]}</small><em>${sp[6](v)}</em></div>`; };
const MODELS = { ssl: 'SSL', mackie: 'MCK', tascam: 'TSC' };
function deskLive() { return MX.deskFor(ctx()); }
function deskBpm() { const s = st.M && st.M.songs && st.M.songs.find(x => x.n === st.songN); return +$('#bpm').value || (s && s.tempo) || 90; }
function deskSyncDelay() { const t = MX.syncTime(MX.desk.dly.sync, deskBpm()); if (t) MX.desk.dly.time = t; }
function stripWho(o) { return Array.from({ length: 32 }, (_, p) => p).filter(p => (desc0(p) & 7) === o && (st.padRes && st.padRes[p])).map(padName).join(' ') || '–'; }
function renderDesk() {
  const el = $('#desk'); if (!el) return; const D = MX.desk; deskSyncDelay();
  const fd = (c, v) => `<div class="fd"><input type="range" class="fdr" data-c="${c}" min="-60" max="12" step="0.5" value="${v}"><div class="meter"><i id="mt${c}"></i></div></div><div class="db">${v > -59.9 ? (v > 0 ? '+' : '') + v.toFixed(1) : '−∞'}</div>`;
  el.innerHTML = D.ch.map((s, i) => `<div class="strip" data-c="${i}">
      <div class="scr">${i + 1}</div><canvas class="vu" id="vu${i}" width="200" height="96"></canvas><div class="who" title="pads on this output">${stripWho(i)}</div>
      <div class="sec"><b>Drive <button class="sw on" data-model="${i}" title="SSL · Mackie · Tascam">${MODELS[s.model] || 'SSL'}</button></b><div class="kg one">${knobHtml(i, 'drive')}</div></div>
      <div class="sec"><b>Dynamics</b><div class="kg">${['thr', 'ratio', 'rel', 'makeup'].map(k => knobHtml(i, k)).join('')}</div></div>
      <div class="sec"><b>Filters</b><div class="kg">${['hpf', 'lpf'].map(k => knobHtml(i, k)).join('')}</div></div>
      <div class="sec"><b>EQ <button class="sw ${s.eqOn ? 'on' : ''}" data-sw="eqOn" data-c="${i}">in</button></b><div class="kg">${['hf', 'hff', 'hmf', 'hmff', 'hmq', 'lmf', 'lmff', 'lmq', 'lf', 'lff'].map(k => knobHtml(i, k)).join('')}</div></div>
      <div class="sec"><div class="kg">${['aux1', 'aux2', 'pan'].map(k => knobHtml(i, k)).join('')}<select class="route" data-c="${i}" title="bus routing">${['mix', 'A', 'B'].map(r => `<option value="${r}" ${s.bus === r ? 'selected' : ''}>${r === 'mix' ? 'MIX' : 'GRP ' + r}</option>`).join('')}</select></div></div>
      <div class="ms"><button class="sw mute ${s.mute ? 'on' : ''}" data-sw="mute" data-c="${i}">M</button><button class="sw solo ${s.solo ? 'on' : ''}" data-sw="solo" data-c="${i}">S</button></div>
      ${fd(i, s.fader)}
      <input class="tape" data-c="${i}" value="${s.name || ''}" placeholder="out ${i + 1}" maxlength="10">
    </div>`).join('') + ['A', 'B'].map(g => { const G = D.grp[g]; return `<div class="strip grp">
      <div class="scr">${g}</div><canvas class="vu" id="vug${g}" width="200" height="96"></canvas><div class="who">${D.ch.map((s, i) => s.bus === g ? i + 1 : null).filter(Boolean).join(' ') || 'group'}</div>
      <div class="sec"><b>Comp</b><div class="kg">${knobHtml(-1, `grp.${g}.thr`)}${knobHtml(-1, `grp.${g}.ratio`)}</div></div>
      <div class="ms"><button class="sw mute ${G.mute ? 'on' : ''}" data-gm="${g}">M</button></div>
      ${fd('g' + g, G.fader)}<div class="tape">group ${g}</div></div>`; }).join('') + `<div class="strip master">
      <div class="scr">BUS</div><div class="vu2"><canvas class="vu" id="vuL" width="200" height="96"></canvas><canvas class="vu" id="vuR" width="200" height="96"></canvas></div>
      <div class="rambo ${st.opt.rambo ? 'on' : ''}" id="ramboBadge" title="SP-12 Rambo RAM upgrade – switch it on under Sample › Memory"><b>RAMBO</b><small>RAM UPGRADE</small></div>
      <div class="sec"><b>Bus comp <button class="sw ${D.bus.on ? 'on' : ''}" data-sw="bus.on">in</button></b><div class="kg">${['bus.thr', 'bus.ratio', 'bus.att', 'bus.rel', 'bus.makeup'].map(k => knobHtml(-1, k)).join('')}</div><div class="gr">GR <span id="busGr">0.0</span> dB</div></div>
      <div class="sec"><b>Reverb <button class="sw on" id="revType" title="Lexicon-style hall · Quadraverb-style">${D.rev.type === 'quad' ? 'QUAD' : 'LEX'}</button></b><div class="kg">${['rev.size', 'rev.pre', 'rev.lo', 'rev.hi', 'rev.level'].map(k => knobHtml(-1, k)).join('')}</div></div>
      <div class="sec"><b>Delay <select id="dlySync">${['free', ...Object.keys(MX.SYNCS)].map(k => `<option ${D.dly.sync === k ? 'selected' : ''}>${k}</option>`).join('')}</select></b><div class="kg">${['dly.time', 'dly.fb', 'dly.level'].map(k => knobHtml(-1, k)).join('')}</div></div>
      ${fd(-1, D.master)}<div class="tape">master</div>
    </div>`;
  el.querySelector('.kn[data-k="dly.time"]').classList.toggle('lock', D.dly.sync !== 'free');
  const apply = c => { MX.applyDesk(deskLive(), typeof c === 'number' && c >= 0 ? c : null); clearTimeout(renderDesk._s); renderDesk._s = setTimeout(MX.saveDesk, 400); };
  el.querySelectorAll('.kn').forEach(kn => {
    const c = +kn.dataset.c, k = kn.dataset.k, sp = KN[k];
    kn.onpointerdown = e => { if (k === 'dly.time' && D.dly.sync !== 'free') { toast('Delay is synced – set sync to free to turn the time knob.'); return; }
      kn.setPointerCapture(e.pointerId); const y0 = e.clientY, n0 = toN(sp, knobGet(c, k));
      kn.onpointermove = ev => { let v = fromN(sp, n0 + (y0 - ev.clientY) / (ev.shiftKey ? 600 : 150)); if (BUSV[k]) v = Math.round(v); knobSet(c, k, v);
        kn.querySelector('i').style.setProperty('--r', `${(-135 + 270 * toN(sp, v)).toFixed(1)}deg`); kn.querySelector('em').textContent = sp[6](v);
        if (k === 'rev.size') { clearTimeout(kn._t); kn._t = setTimeout(() => apply(-1), 200); } else apply(c); };
      kn.onpointerup = () => { kn.onpointermove = null; }; };
    kn.ondblclick = () => { knobSet(c, k, sp[2]); renderDesk(); apply(c); };
  });
  el.querySelectorAll('[data-sw]').forEach(b => b.onclick = () => { const k = b.dataset.sw; if (k === 'bus.on') D.bus.on = !D.bus.on; else { const c = +b.dataset.c; D.ch[c][k] = !D.ch[c][k]; } renderDesk(); apply(-1); });
  el.querySelectorAll('[data-model]').forEach(b => b.onclick = () => { const s = D.ch[+b.dataset.model], ks = Object.keys(MODELS); s.model = ks[(ks.indexOf(s.model) + 1) % ks.length]; renderDesk(); apply(+b.dataset.model); });
  el.querySelectorAll('[data-gm]').forEach(b => b.onclick = () => { const G = D.grp[b.dataset.gm]; G.mute = !G.mute; renderDesk(); apply(-1); });
  el.querySelectorAll('select.route').forEach(s => s.onchange = () => { D.ch[+s.dataset.c].bus = s.value; renderDesk(); apply(-1); });
  el.querySelectorAll('.fdr').forEach(f => f.oninput = () => { const c = f.dataset.c, v = +f.value; if (c === '-1') D.master = v; else if (c[0] === 'g') D.grp[c[1]].fader = v; else D.ch[+c].fader = v;
    f.parentElement.nextElementSibling.textContent = v > -59.9 ? (v > 0 ? '+' : '') + v.toFixed(1) : '−∞'; apply(c[0] === 'g' || c === '-1' ? -1 : +c); });
  el.querySelectorAll('input.tape[data-c]').forEach(t => t.onchange = () => { D.ch[+t.dataset.c].name = t.value; MX.saveDesk(); });
  $('#ramboBadge').onclick = () => { $('#tabs [data-tab="sample"]').click(); const b = $('#subTabs [data-sub="mem"]'); if (b) b.click(); };
  $('#revType').onclick = () => { D.rev.type = D.rev.type === 'quad' ? 'lex' : 'quad'; renderDesk(); apply(-1); };
  $('#dlySync').onchange = e => { D.dly.sync = e.target.value; deskSyncDelay(); renderDesk(); apply(-1); };
  deskMeters();
}
$('#deskReset').onclick = async () => { if (await modal('<p>Reset the whole desk?</p>', [['Cancel', null], ['Reset', 'ok', true]]) !== 'ok') return; Object.assign(MX.desk, MX.DESK_DEFAULT()); renderDesk(); MX.applyDesk(deskLive()); MX.saveDesk(); };
$('#bpm').addEventListener('change', () => { if (MX.desk.dly.sync !== 'free') { deskSyncDelay(); MX.applyDesk(deskLive()); if ($('#tab-mixer').classList.contains('on')) renderDesk(); } });
// analog VU: 0 VU = −18 dBFS RMS, 300 ms ballistics, scale −20 … +3 VU (linear in voltage, like the real dial)
const VUFACE = new Map();
function vuFace(W, H) {
  const k = `${W}x${H}`; if (VUFACE.has(k)) return VUFACE.get(k);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d'), cx = W / 2, cy = H * 1.18, R = H * 0.98;
  const grd = g.createLinearGradient(0, 0, 0, H); grd.addColorStop(0, '#f6eccb'); grd.addColorStop(1, '#e2d2a0'); g.fillStyle = grd; g.fillRect(0, 0, W, H);
  const ang = vu => { const lin = Math.pow(10, vu / 20), p = (lin - 0.1) / (Math.pow(10, 3 / 20) - 0.1); return (-50 + 100 * p) * Math.PI / 180; };
  g.lineWidth = H * 0.025; g.strokeStyle = '#222'; g.beginPath(); g.arc(cx, cy, R * 0.8, -Math.PI / 2 + ang(-20), -Math.PI / 2 + ang(0)); g.stroke();
  g.strokeStyle = '#c62a23'; g.lineWidth = H * 0.06; g.beginPath(); g.arc(cx, cy, R * 0.8, -Math.PI / 2 + ang(0), -Math.PI / 2 + ang(3)); g.stroke();
  g.fillStyle = '#222'; g.font = `700 ${H * 0.13}px Helvetica, Arial`; g.textAlign = 'center';
  [-20, -10, -7, -5, -3, -1, 0, 1, 2, 3].forEach(v => { const a = ang(v), x1 = cx + Math.sin(a) * R * 0.8, y1 = cy - Math.cos(a) * R * 0.8, x2 = cx + Math.sin(a) * R * 0.9, y2 = cy - Math.cos(a) * R * 0.9;
    g.strokeStyle = v > 0 ? '#c62a23' : '#222'; g.lineWidth = H * 0.02; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    if ([-20, -10, -5, -3, 0, 3].includes(v)) { g.fillStyle = v > 0 ? '#c62a23' : '#222'; g.fillText(String(Math.abs(v)), cx + Math.sin(a) * R * 1.02, cy - Math.cos(a) * R * 1.02 + H * 0.04); } });
  g.font = `700 ${H * 0.16}px Helvetica, Arial`; g.fillStyle = '#222'; g.fillText('VU', cx, H * 0.78);
  const o = { cv, ang, cx, cy, R }; VUFACE.set(k, o); return o;
}
function drawVu(id, holder, r, dt, label) {
  const el = $('#' + id); if (!el) return; const g = el.getContext('2d'), W = el.width, H = el.height, F = vuFace(W, H);
  const vu = Math.max(-22, Math.min(4, 20 * Math.log10(r + 1e-7) + 18));
  holder._vu = holder._vu == null ? -22 : holder._vu + (vu - holder._vu) * (1 - Math.exp(-dt / 0.065));
  g.drawImage(F.cv, 0, 0); const a = F.ang(Math.max(-21, Math.min(3.6, holder._vu)));
  g.strokeStyle = '#111'; g.lineWidth = H * 0.025; g.beginPath(); g.moveTo(F.cx, F.cy); g.lineTo(F.cx + Math.sin(a) * F.R * 0.95, F.cy - Math.cos(a) * F.R * 0.95); g.stroke();
  if (label) { g.fillStyle = '#555'; g.font = `700 ${H * 0.13}px Helvetica, Arial`; g.textAlign = 'left'; g.fillText(label, W * 0.05, H * 0.17); }
  if (holder._vu > 0.5) { g.fillStyle = '#ff3326'; g.beginPath(); g.arc(W * 0.9, H * 0.14, H * 0.06, 0, Math.PI * 2); g.fill(); }
}
function deskMeters() {
  if (!$('#tab-mixer').classList.contains('on')) return; const D = MX.deskFor(ctx());
  const show = (an, id, o) => { const el = $('#' + id); if (!el) return; o._pk = Math.max(MX.peak(an), (o._pk || 0) * 0.9); const dbv = 20 * Math.log10(o._pk + 1e-6); el.style.height = `${Math.max(0, Math.min(100, (dbv + 48) / 54 * 100))}%`; el.classList.toggle('hot', dbv > -1); };
  D.strips.forEach((S, i) => show(S.meter, 'mt' + i, S)); ['A', 'B'].forEach(g => show(D.groups[g].meter, 'mtg' + g, D.groups[g])); show(D.meterM, 'mt-1', D);
  const now = performance.now(), dt = Math.min(0.1, (now - (deskMeters.t || now)) / 1000); deskMeters.t = now;
  D.strips.forEach((S, i) => drawVu('vu' + i, S, MX.rms(S.meter), dt)); ['A', 'B'].forEach(g => drawVu('vug' + g, D.groups[g], MX.rms(D.groups[g].meter), dt));
  drawVu('vuL', D.meterL, MX.rms(D.meterL), dt, 'L'); drawVu('vuR', D.meterR, MX.rms(D.meterR), dt, 'R');
  const gr = $('#busGr'); if (gr) gr.textContent = (D.busComp.reduction || 0).toFixed(1);
  requestAnimationFrame(deskMeters);
}

const VERSION = '40';
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  { const v = $('#aboutVer'); if (v) v.textContent = 'v' + VERSION; const m = location.hostname.match(/^([^.]+)\.github\.io$/), s = $('#aboutSrc');
    if (m && s) s.href = `https://github.com/${m[1]}/${location.pathname.split('/').filter(Boolean)[0] || ''}`; }
  navigator.serviceWorker.register('sw.js').then(r => r.update()).catch(() => { });
  const hadController = !!navigator.serviceWorker.controller; let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { // only when an older version was running
    if (!hadController || reloaded) return;
    if (!st.files.length) { reloaded = true; location.reload(); } else toast('New version installed – reload after saving.', 6000);
  });
}
if ('launchQueue' in window) launchQueue.setConsumer(async p => { if (p.files && p.files.length) openFiles(await Promise.all(p.files.map(h => h.getFile()))); });
refreshChrome(); led(`SP-12 TOOL V${VERSION}`);
window.sp12 = { st, openFiles, get seqT() { return seqT; } };
// ---- touch: hold a pad = note repeat (like Shift + pad key) ----
{
  const HOLD_MS = 350, holds = new Map();
  const end = id => { const h = holds.get(id); if (!h) return; clearTimeout(h.t); stopRepeat(h.code); holds.delete(id); };
  const endAll = () => [...holds.keys()].forEach(end);
  document.addEventListener('pointerdown', e => {
    const el = e.target.closest && e.target.closest('.pad[data-p]'); if (!el || e.button !== 0 || e.altKey) return;
    end(e.pointerId); const p = +el.dataset.p, code = 'hold' + e.pointerId;
    holds.set(e.pointerId, { code, t: setTimeout(() => startRepeat(code, p), HOLD_MS) });
  }, true);
  ['pointerup', 'pointercancel'].forEach(ev => document.addEventListener(ev, e => end(e.pointerId), true));
  document.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' && !e.buttons) end(e.pointerId); }, true);
  ['touchend', 'touchcancel'].forEach(ev => document.addEventListener(ev, e => { if (!e.touches.length) endAll(); }, true));
  addEventListener('blur', endAll);
  document.addEventListener('contextmenu', e => { if (e.target.closest && e.target.closest('.pad')) e.preventDefault(); });
}
