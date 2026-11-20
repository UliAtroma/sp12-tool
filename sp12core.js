// SP-12 Turbo file core – parse / encode .SP12 (sounds) and .SQ12 (sequences)
// Format reverse-engineered from real files. Fields marked "?" are unconfirmed.

export const RATES = { '27500': 27500, '26040': 26040 };
export const MID = 2048;                 // 12-bit unsigned silence
export const TURBO_MAX_SAMPLES = 131072; // 2 banks x 65536 words
export const BANK = 65536;

export const L = {
  HEADER: 0x000,     // 0x000-0x1FF container header
  PAGES: 0x003,      // big-endian u16 at 3..4: floor(fileLength / 256)
  PARAM: 0x200,      // parameter block start
  DIR: 0x263,        // ? sound directory (9 x LE16 addresses)
  DIRN: 9,
  PADREC: 0x28F,     // 32 pad records, 10 bytes each
  PADRECLEN: 10,
  NPADS: 32,
  SAMPLES: 0x600,    // packed 12-bit sample memory
  // SQ12
  SQ_HDR: 0x200,
  SQ_KITS: 0x397,    // the 8 mixes: 32 bytes each = descriptor byte 0 of every sound (decay mode, level reduction, output)
  SQ_EVENTS: 0x497,
};

export const le16 = (b, o) => b[o] | (b[o + 1] << 8);
export const setLe16 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; };
export const hex = (v, n = 2) => v.toString(16).toUpperCase().padStart(n, '0');

export function detectType(name, bytes) {
  const n = (name || '').toLowerCase();
  if (n.endsWith('.sq12')) return 'SQ12';
  if (n.endsWith('.sp12')) return 'SP12';
  if (n.endsWith('.wav') || n.endsWith('.aif') || n.endsWith('.aiff')) return 'AUDIO';
  if (bytes && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'AUDIO';
  if (bytes && bytes.length > 0x4000) return 'SP12';
  return 'SQ12';
}

// ---------- samples ----------
// 3 bytes -> 2 samples: s0 = a<<4 | (c & 0x0F), s1 = b<<4 | (c >> 4)
export function decodeSamples(bytes, off = L.SAMPLES) {
  const n = Math.max(0, Math.floor((bytes.length - off) / 3)) * 2;
  const X = new Uint16Array(n);
  for (let k = 0, o = off; k < n; k += 2, o += 3) {
    const a = bytes[o], b = bytes[o + 1], c = bytes[o + 2];
    X[k] = (a << 4) | (c & 15);
    X[k + 1] = (b << 4) | (c >> 4);
  }
  return X;
}
export function encodeSamples(X, bytes, off = L.SAMPLES, from = 0, to = X.length) {
  from &= ~1; if (to & 1) to++;
  for (let k = from; k < to && k < X.length; k += 2) {
    const o = off + (k >> 1) * 3;
    if (o + 2 >= bytes.length) break;
    const s0 = X[k] & 4095, s1 = (k + 1 < X.length ? X[k + 1] : MID) & 4095;
    bytes[o] = s0 >> 4; bytes[o + 1] = s1 >> 4; bytes[o + 2] = (s0 & 15) | ((s1 & 15) << 4);
  }
}
export function usedEnd(X) { // trailing zero area = unused
  let e = X.length; while (e > 0 && X[e - 1] < 64) e--; return e;
}

// ---------- pads ----------
export function parsePads(bytes) {
  const pads = [];
  for (let p = 0; p < L.NPADS; p++) {
    const o = L.PADREC + p * L.PADRECLEN;
    const lenRaw = le16(bytes, o + 4);
    pads.push({
      index: p, bank: (p >> 3) + 1, pad: (p & 7) + 1, offset: o,
      sound: bytes[o], tune: bytes[o + 1], start: le16(bytes, o + 2),
      lenRaw, length: lenRaw ? (0x10000 - lenRaw) & 0xffff : 0,
      extra: Array.from(bytes.slice(o + 6, o + 10)),
      // loop: start address (LE16) + 0x10000 - loop length (LE16); the loop runs to the end of the sound. 0xFFFD = no loop
      loopStart: le16(bytes, o + 6), loopRaw: le16(bytes, o + 8),
    });
    const q = pads[pads.length - 1], ll = (0x10000 - q.loopRaw) & 0xffff;
    q.loop = q.loopRaw !== 0xFFFD && q.loopRaw !== 0 && ll > 3 && q.loopStart >= q.start && q.loopStart < q.start + q.length;
    q.loopLen = q.loop ? ll : 0;
  }
  return pads;
}
export function writePad(bytes, p) {
  const o = L.PADREC + p.index * L.PADRECLEN;
  bytes[o] = p.sound & 255; bytes[o + 1] = p.tune & 255;
  setLe16(bytes, o + 2, p.start & 0xffff);
  setLe16(bytes, o + 4, p.length ? (0x10000 - p.length) & 0xffff : 0);
  if (p.loopEdited) { // only touched when the loop was edited, so untouched pads keep their bytes
    if (p.loop) { const ls = Math.max(p.start, Math.min(p.start + p.length - 4, p.loopStart)); setLe16(bytes, o + 6, ls); setLe16(bytes, o + 8, (0x10000 - (p.start + p.length - ls)) & 0xffff); }
    else { setLe16(bytes, o + 6, 0); setLe16(bytes, o + 8, 0xFFFD); }
  }
}
export function parseDir(bytes) {
  const d = []; for (let i = 0; i < L.DIRN; i++) d.push(le16(bytes, L.DIR + i * 2)); return d;
}

// ---------- regions (user sounds in RAM) ----------
export function validStart(X, s, end) {
  if (s < 0 || s + 4 > end) return false;
  for (let i = 0; i < 4; i++) if (X[s + i] !== MID) return false;
  let before = 0; while (s - before - 1 >= 0 && X[s - before - 1] === MID) before++;
  return before <= 2;
}
function energyAfter(X, s, n = 256) {
  let mn = 4095, mx = 0; const e = Math.min(X.length, s + n);
  for (let i = s; i < e; i++) { if (X[i] < mn) mn = X[i]; if (X[i] > mx) mx = X[i]; }
  return mx - mn;
}
export const isEmptyPad = p => p.length <= 3;
// Memory banks: the sound descriptor's byte 1 bits 2-0 name the bank. Turbo: RAM banks 7 and 6 (shown as "Bank 1" and
// "Bank 2"), the other banks are ROM sounds without data in the file. Rambo (RAM in place of the ROMs): banks 7..0, shown 1..8.
// Next free address of bank b (2-7) at 0x27D + 2b; banks 0/1 have no slot (the end of their highest sound).
// The file holds the data in bank order 7, 6, 5 .. 0, each section rounded up to 512 samples (3 blocks).
export const bankLabel = b => 8 - b, bankOfLabel = l => 8 - l;
export const RAMBANK = { 7: 1, 6: 2 };
export const memBankOf = p => p.tune & 7;
export const REGTAB = 0x201, FIRSTTAB = 0x3CF;                // sound n: region start/length 0x201 + 4n; its 5 first words 0x3CF + 10n
export const parseRegionTable = bytes => Array.from({ length: 32 }, (_, n) => ({ start: le16(bytes, REGTAB + 4 * n), len: le16(bytes, REGTAB + 2 + 4 * n) }));
export function memInfo(bytes, X, pads = null, rambo = false) {
  const end = usedEnd(X), free = {};
  for (let b = 2; b < 8; b++) free[b] = le16(bytes, 0x27D + 2 * b);
  for (let b = 0; b < 2; b++) { let hi = 0; if (rambo && pads) pads.forEach(p => { if ((p.tune & 7) === b && p.length > 3) hi = Math.max(hi, (p.start + p.length) & 0xFFFF); }); free[b] = hi; }
  // banks 5..2 beyond the Turbo's two: only the app's overflow (more than the SP-12 can hold), only when their free pointer is set
  const order = rambo ? [7, 6, 5, 4, 3, 2, 1, 0] : [7, 6, 5, 4, 3, 2], sec = {}; let base = 0;
  order.forEach(b => { const f = free[b]; if (!f) return; const size = Math.ceil(f / 512) * 512; if (base >= X.length) return; sec[b] = { base, free: f, size }; base += size; });
  const base2 = sec[6] ? sec[6].base : null;
  const physical = rambo ? order : [7, 6], over = Object.keys(sec).map(Number).filter(b => !physical.includes(b));
  return { over, free1: free[7], free2: free[6], free, base2, end, bank1End: sec[7] ? Math.min(free[7], base2 ?? Infinity) : (base2 ?? end), sec, order, rambo };
}
export function findRegions(X, pads, dir, extraStarts = [], mem = null) {
  const end = usedEnd(X); mem = mem || { bank1End: end, base2: null, sec: { 7: { base: 0, free: end, size: end } } };
  const secs = Object.entries(mem.sec).map(([b, v]) => ({ b: +b, ...v })).sort((a, b) => a.base - b.base);
  const secOf = s => secs.find(x => s >= x.base && s < x.base + x.size) || secs[secs.length - 1];
  const starts = new Map();
  const add = (s, src) => { if (validStart(X, s, end) && !starts.has(s)) starts.set(s, src); };
  add(0, 'Speicheranfang');
  if (Array.isArray(dir)) dir.forEach((r, n) => { const p = pads[n]; if (!p || !r || typeof r !== 'object') return; const sc = mem.sec[p.tune & 7]; if (sc && r.len) add(sc.base + r.start, 'Region'); });
  extraStarts.forEach(s => add(s, 'Manuell'));
  // every pad by its descriptor's memory bank: a bank with data in the file = RAM sound, anything else = ROM sound (MIDI only)
  const res = {};
  pads.forEach(p => {
    if (isEmptyPad(p)) return;
    const sc = mem.sec[memBankOf(p)]; if (!sc) return;
    const fstart = sc.base + p.start;
    if (fstart + p.length > X.length + 16) return;
    res[p.index] = { fstart, bank: bankLabel(memBankOf(p)), len: p.length, loopF: p.loop ? fstart + (p.loopStart - p.start) : null };
    if (![...starts.keys()].some(k => k < fstart && fstart - k < 16)) add(fstart, 'Pad');   // a pad playing from just behind its region start
  });
  const sorted = [...starts.keys()].sort((a, b) => a - b);
  const regions = sorted.map((s, i) => {
    const sc = secOf(s), secEnd = sc ? sc.base + sc.size : end;
    let next = i + 1 < sorted.length ? sorted[i + 1] : end; if (next > secEnd) next = secEnd;
    const refs = Object.keys(res).map(Number).filter(pi => res[pi].fstart >= s && res[pi].fstart < next);
    let e = next; const ends = refs.map(pi => res[pi].fstart + res[pi].len).filter(x => x <= next);
    if (ends.length) e = Math.max(...ends);
    return { id: i, start: s, end: e, capacity: next - s, refs, source: starts.get(s), bank: sc ? bankLabel(sc.b) : 1, mbank: sc ? sc.b : 7 };
  });
  regions.res = res; return regions;
}
// Rebuild the whole sample memory from a list of sounds (copy / chop / compaction):
// sounds = [{ data: Uint16Array (from the sound's first word), refs: [{ pad, off, len, loopOff, first }], pref: bank }]
// Every sound gets packed into a bank (first fit, its own bank first), 9 filler words behind it, as the SP-12 lays them out.
export const FILLER = 9, MAXSND = BANK - 5 - FILLER;
export const eraseRecord = n => Uint8Array.from([(n & 1) | 0x1E, 0x80, 0, 0, 0xFD, 0xFF, 0, 0, 0xFD, 0xFF]);
export function rebuildSP(bytes, pads, sounds, opt = {}) {
  const banks = opt.rambo ? [7, 6, 5, 4, 3, 2, 1, 0].slice(0, Math.max(2, Math.min(8, opt.zones || 8))) : opt.overflow ? [7, 6, 5, 4, 3, 2] : [7, 6];
  const used = Object.fromEntries(banks.map(b => [b, 0])), place = new Map();
  const order = sounds.map((s, i) => ({ s, i, n: s.data.length + FILLER })).sort((a, b) => b.n - a.n);
  for (const o of order) {
    if (o.s.data.length > MAXSND) throw new Error(`A sample is longer than 2.5 s (${o.s.data.length} samples).`);
    const phys = opt.rambo ? banks : [7, 6], pref = phys.includes(o.s.pref) ? o.s.pref : null;   // overflow banks only when nothing else fits
    const tryB = [pref, ...banks].filter((b, k, a) => b != null && banks.includes(b) && a.indexOf(b) === k);
    const b = tryB.find(b => used[b] + o.n <= BANK);
    if (b == null) throw new Error('Memory full: samples do not fit into ' + banks.length + ' × 2.5 s.');
    place.set(o.i, b); used[b] += o.n;
  }
  const addr = new Map(); banks.forEach(b => { let a = 0; sounds.forEach((s, i) => { if (place.get(i) !== b) return; addr.set(i, a); a += s.data.length + FILLER; }); });
  const secBase = {}; let total = 0; banks.forEach(b => { if (!used[b]) return; secBase[b] = total; total += Math.ceil(used[b] / 512) * 512; });
  const X = new Uint16Array(total);
  sounds.forEach((s, i) => { const o = secBase[place.get(i)] + addr.get(i); X.set(s.data, o); X.fill(2050, o + s.data.length, o + s.data.length + FILLER); });
  const oBlocks = Math.min(bytes.length, getPages(bytes) * 256), tail = bytes.length > oBlocks ? bytes.subarray(oBlocks) : new Uint8Array(0);
  const dataLen = L.SAMPLES + Math.ceil(total / 2) * 3, blocks = Math.ceil(dataLen / 256);
  const nb = new Uint8Array(blocks * 256 + tail.length); nb.set(bytes.subarray(0, L.SAMPLES)); nb.set(tail, blocks * 256);
  nb[3] = (blocks >> 8) & 255; nb[4] = blocks & 255;
  encodeSamples(X, nb, L.SAMPLES);
  banks.forEach(b => { if (b >= 2) setLe16(nb, 0x27D + 2 * b, used[b]); });
  if (!opt.rambo) for (let b = 2; b < 6; b++) if (!banks.includes(b) || !used[b]) setLe16(nb, 0x27D + 2 * b, 0);
  const P = pads.map(p => ({ ...p }));
  sounds.forEach((s, i) => s.refs.forEach(r => {
    const p = P[r.pad], b = place.get(i), a = addr.get(i);
    p.tune = (p.tune & 0xF8) | b; p.start = a + r.off; p.length = r.len;
    if (r.loopOff != null) { p.loop = true; p.loopStart = a + r.loopOff; } else p.loop = false;
    p.loopEdited = true; if (r.desc0 != null) p.sound = r.desc0; if (r.tuneIdx != null) p.tune = (r.tuneIdx << 3) | b;
    writePad(nb, p);
    if (r.pad !== 31 || b >= 2) { setLe16(nb, REGTAB + 4 * r.pad, a); setLe16(nb, REGTAB + 2 + 4 * r.pad, s.data.length); }
    nb.set(r.first || [0, 0x80, 0, 0x80, 0, 0x80, 0, 0x80, 0, 0x80], FIRSTTAB + 10 * r.pad);
  }));
  (opt.erase || []).forEach(n => {   // erased pad, as the SP-12 leaves it: output 7/8, level reduction 3, tune mode, no sound
    const rec = opt.restore && opt.restore[n] ? opt.restore[n] : eraseRecord(n);
    nb.set(rec, L.PADREC + L.PADRECLEN * n); if (!(opt.restore && opt.restore[n])) { setLe16(nb, REGTAB + 4 * n, 0); if (n !== 31) setLe16(nb, REGTAB + 2 + 4 * n, 0); }
  });
  return { bytes: nb, used, banks };
}
export function autoSplitCandidates(X, regions) {
  const end = usedEnd(X), out = [];
  let run = 0;
  for (let i = 0; i < end; i++) {
    if (X[i] === MID) run++;
    else {
      if (run >= 4) {
        const s = i - run;
        if (s > 0 && energyAfter(X, i, 256) > 300 && !regions.some(r => Math.abs(r.start - s) < 8)) out.push(s);
      }
      run = 0;
    }
  }
  return out;
}

// ---------- sequences (.SQ12) – partly decoded ----------
export const SQ_RAM_DELTA = 0x7194 - 0x497; // Z80 RAM address - file offset (derived)
export function parseSQ12(bytes) {
  const hdr = { count: bytes[L.SQ_HDR], words: [] };
  for (let i = 0; i < 9; i++) hdr.words.push(le16(bytes, L.SQ_HDR + 1 + i * 2));
  const kits = [];
  for (let k = 0; k < 8; k++) kits.push(Array.from(bytes.slice(L.SQ_KITS + k * 32, L.SQ_KITS + k * 32 + 32)));
  // event area ends at the first run of >= 4 zero bytes
  let evEnd = bytes.length;
  for (let i = L.SQ_EVENTS; i < bytes.length - 4; i++) if (!bytes[i] && !bytes[i + 1] && !bytes[i + 2] && !bytes[i + 3]) { evEnd = i; break; }
  // segment start pointers from the header (RAM addresses)
  let ptrs = hdr.words.map(w => w - SQ_RAM_DELTA).filter(o => o >= L.SQ_EVENTS && o < evEnd);
  ptrs = [...new Set(ptrs)].sort((a, b) => a - b);
  let bounds;
  if (ptrs.length >= 2 && ptrs[0] === L.SQ_EVENTS) bounds = ptrs;
  else { // fallback: split at "01 00 04"
    bounds = [L.SQ_EVENTS];
    for (let i = L.SQ_EVENTS; i < evEnd - 2; i++) if (bytes[i] === 1 && bytes[i + 1] === 0 && bytes[i + 2] === 4) bounds.push(i + 1);
  }
  const segBounds = bounds.slice(0, -1).map((a, i) => [a, bounds[i + 1]]);
  const lastStart = bounds[bounds.length - 1];
  const segments = segBounds.map(([a, b], n) => {
    const d = bytes.slice(a, b - 1); // last byte = 01 terminator
    return { n: n + 1, offset: a, length: b - a, ram: a + SQ_RAM_DELTA, header: Array.from(d.slice(0, 4)), steps: tokenize(d.slice(4)), terminator: bytes[b - 1] };
  });
  const tail = Array.from(bytes.slice(lastStart, evEnd));
  return { hdr, kits, segments, tail, tailOffset: lastStart, evEnd };
}
// tentative: bytes with low nibble 0x2 act as time markers; following bytes are the events at that time
function tokenize(d) {
  const steps = []; let cur = null;
  for (const b of d) {
    if ((b & 0x0f) === 0x02) { cur = { t: b, ev: [] }; steps.push(cur); }
    else { if (!cur) { cur = { t: null, ev: [] }; steps.push(cur); } cur.ev.push(b); }
  }
  return steps;
}
export function findAscii(bytes, s) {
  const c = [...s].map(ch => ch.charCodeAt(0));
  outer: for (let i = 0; i <= bytes.length - c.length; i++) {
    for (let j = 0; j < c.length; j++) if (bytes[i + j] !== c[j]) continue outer;
    return i;
  }
  return -1;
}

// ---------- WAV ----------
export function encodeWav(X, s, e, rate) {
  const n = Math.max(0, e - s), buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, (X[s + i] - MID) << 4, true);
  return new Uint8Array(buf);
}
export function floatTo12(f) { // Float32Array [-1,1] -> Uint16Array 12-bit
  const o = new Uint16Array(f.length);
  for (let i = 0; i < f.length; i++) o[i] = Math.max(0, Math.min(4095, Math.round(f[i] * 2047) + MID));
  return o;
}
export function setPages(bytes) { const p = Math.floor(bytes.length / 256); bytes[3] = (p >> 8) & 255; bytes[4] = p & 255; }
export const getPages = b => (b[3] << 8) | b[4];
export function resizeForSamples(bytes, nSamples) {
  const need = L.SAMPLES + Math.ceil(nSamples / 2) * 3;
  if (need <= bytes.length) return bytes;
  const nb = new Uint8Array(need); nb.set(bytes); setPages(nb); return nb;
}

// ================= SQ12 v2: fully decoded segment format =================
// Segment: [b0][b1][len LE16 ticks] then steps, terminated by 0x01.
// Step:    time byte t = ((tick % 64) << 2) | 2 ; a value <= previous time byte means +64 ticks.
//          t = 0x00 means "skip 64 ticks, no events" (previous time byte is kept for comparison).
// Event:   e = sound 0-31 (A1-D8) | 0x20 = lowest level step off | 0x40 if a level/tune byte follows | 0x80 if last in step.
//          level/tune byte: high nibble = level nibble (0 = 15), low nibble = tuning -8..+7 (decay offset in decay mode).
//          note level 0-31 = 2 x level nibble + 1 unless bit 5. Segment n's pointer at 0x207 + 2n (RAM 6F04h).
// 96 PPQ: one stored unit = 4 ticks, so the time byte is the low byte of the tick counter (+2). 384 ticks = 1 bar of 4/4.
export const SEG_TABLE = 0x207, SONG_PTR = 0x203, SONG_TABLE = 0x2CF, NSEG = 100, PPQ = 96, TPU = 4;
// segment header byte 0, high nibble: swing setting (assumed order of the SP-12 swing values)
export const SWINGS = [50, 54, 58, 63, 67, 71];
export const swingOf = b0 => SWINGS[Math.min(SWINGS.length - 1, b0 >> 4)];
export function swingTick(tick, pct) { // delay every second 16th (pairs of 48 ticks at 96 PPQ), proportionally in between
  if (!pct || pct === 50) return tick; const base = Math.floor(tick / 48) * 48, p = tick - base, m = 48 * pct / 100;
  return base + (p < 24 ? p * m / 24 : m + (p - 24) * (48 - m) / 24);
}
export function segTable(bytes) {
  const t = [];
  for (let n = 0; n < NSEG; n++) { const p = le16(bytes, SEG_TABLE + 2 * n); t.push(p >> 8 && p !== 0xffff ? p - SQ_RAM_DELTA : null); } // empty: high byte 0
  return t;
}
export function decodeSegment(bytes, off) {
  const b0 = bytes[off], b1 = bytes[off + 1], len = le16(bytes, off + 2) * TPU;
  const events = []; let i = off + 4, w = 0, prev = -1, step = 0, ok = false;
  while (i < bytes.length) {
    const t = bytes[i++];
    if (t === 0x01) { ok = true; break; }
    if (t === 0x00) { w++; continue; }
    if (prev >= 0 && t <= prev) w++;
    prev = t; const tick = (w * 64 + (t >> 2)) * TPU;
    for (let g = 0; g < 64; g++) {
      const e = bytes[i++]; let v = null; if (e & 0x40) v = bytes[i++];
      events.push({ tick, step, pad: e & 0x1F, b5: (e & 0x20) !== 0, level: v == null ? null : v >> 4, val: v == null ? null : v & 15 });
      if (e & 0x80) break;
    }
    step++;
  }
  return { off, b0, b1, len, events, end: i, ok };
}
export function encodeSegment(seg) {
  const lenU = Math.round(seg.len / TPU), out = [seg.b0, seg.b1, lenU & 255, lenU >> 8];
  const ev = seg.events.map(e => ({ ...e, u: Math.round(e.tick / TPU) })).sort((a, b) => a.u - b.u || (a.step ?? 0) - (b.step ?? 0));
  const groups = []; ev.forEach(e => { const g = groups[groups.length - 1]; if (g && g.tick === e.u) g.ev.push(e); else groups.push({ tick: e.u, ev: [e] }); });
  let w = 0, prev = -1;
  for (const g of groups) {
    const gw = Math.floor(g.tick / 64), t = ((g.tick % 64) << 2) | 2;
    const implied = prev >= 0 && t <= prev ? 1 : 0;
    for (let z = 0; z < gw - w - implied; z++) out.push(0);
    w = gw; prev = t; out.push(t);
    g.ev.forEach((e, k) => {
      const hasP = e.level != null || e.val != null;
      out.push((e.pad & 0x1F) | (e.b5 ? 0x20 : 0) | (hasP ? 0x40 : 0) | (k === g.ev.length - 1 ? 0x80 : 0));
      if (hasP) out.push(((e.level || 0) << 4) | (e.val || 0));
    });
  }
  const lastW = Math.max(1, Math.ceil(lenU / 64)) - (groups.length ? 1 : 0);
  for (; w < lastW; w++) out.push(0);
  out.push(1);
  return Uint8Array.from(out);
}
// note level 0-31 as the SP-12 reads it (before the mix's level reduction)
export const noteLevel = e => 2 * ((e.level || 0) || 15) + (e.b5 ? 0 : 1);
// Songs: 100 pointers at 0x2CF (RAM 6FCCh) to the song's tempo byte; a song runs downward in RAM: tempo, tenths (bits 3-0),
// First Step and 4 more header bytes, then the steps, the last one End (CAh). Steps: 00-63h segment, 64h End Repeat
// endless, 65h-C7h End Repeat x(n-64h), C8h Begin Repeat, C9h Loop, CAh End, CBh-D4h Trigger, D5h-DCh Mix 1-8,
// DDh Link Song v, DEh Sub-song v, DFh+ tempo change v (bit 7 = minus) at once / over (n-DFh) beats (DDh+: 2 bytes).
// In the file the song area (RAM upper bottom+1 .. RAM top) follows the lower area (RAM 6EFEh .. lower top).
export function seqHeader(bytes) { return { top: le16(bytes, 0x201), lt: le16(bytes, 0x203), ub: le16(bytes, 0x205) }; }
export function songFileOf(bytes, a) { const h = seqHeader(bytes); return 0x201 + (h.lt - 0x6EFE) + (a - h.ub - 1); }
export function songAreaEnd(bytes) { const h = seqHeader(bytes); return 0x201 + (h.lt - 0x6EFE) + Math.max(0, h.top - h.ub); }
export function decodeSongs(bytes) {
  const out = [], h = seqHeader(bytes);
  for (let n = 0; n < 100; n++) {
    const q = le16(bytes, SONG_TABLE + 2 * n); if (!(q >> 8) || q <= h.ub + 7 || q > h.top) continue;
    const at = a => { const o = songFileOf(bytes, a); return o >= 0 && o < bytes.length ? bytes[o] : 0xCA; };
    const steps = []; let i = q - 7, ok = false;
    for (let k = 0; k < 2000 && i > h.ub; k++) { const c = at(i); if (c >= 0xDD) { steps.push([c, at(i - 1)]); i -= 2; } else { steps.push([c]); i--; } if (c === 0xCA) { ok = true; break; } }
    out.push({ n, q, tempo: at(q), b1: at(q - 1), tenths: at(q - 1) & 15, first: at(q - 2), hdr: [2, 3, 4, 5, 6].map(k => at(q - k)), steps, ok, tempoOff: songFileOf(bytes, q), bpm: at(q), tempoRaw: at(q) });
  }
  return out;
}
export function decodeSong(bytes) { const s = decodeSongs(bytes); return s.length ? s[0] : null; }
export const mixTable = (bytes, k) => Array.from(bytes.slice(L.SQ_KITS + 32 * k, L.SQ_KITS + 32 * k + 32));
export function songStepName([c, v]) {
  const two = x => String(x).padStart(2, '0');
  if (c < 0x64) return 'Seg ' + two(c);
  if (c < 0xC8) return c === 0x64 ? 'Repeat ∞' : 'Repeat ×' + (c - 0x64);
  if (c === 0xC8) return 'Begin Rpt'; if (c === 0xC9) return 'Loop'; if (c === 0xCA) return 'End';
  if (c < 0xD5) return 'Trigger ' + ['Off', '1/4', '1/4T', '1/8', '1/8T', '1/16', '1/16T', '1/32', '1/32T', 'Click'][c - 0xCB];
  if (c < 0xDD) return 'Mix ' + (c - 0xD5 + 1);
  if (c === 0xDD) return 'Link Song ' + two(v); if (c === 0xDE) return 'Sub-song ' + two(v);
  return 'Tempo ' + (v & 0x80 ? '−' : '+') + (v & 0x7F) + (c > 0xDF ? ' / ' + (c - 0xDF) + ' Beats' : '');
}
// The song as a play list: [{ seg, mix, tempo }] with repeats unrolled (endless repeat / Loop: loop = true)
export function songPlan(songs, n, depth = 0) {
  const song = songs.find(s => s.n === n), plan = []; let loop = false; if (!song || depth > 4) return { plan, loop, loopFrom: 0 };
  let tempo = song.tempo, i = 0, rptStart = null, rptLeft = null, rptPlan = 0, loopFrom = 0, guard = 0;
  while (i < song.steps.length && guard++ < 5000) {
    const [c, v] = song.steps[i];
    if (c < 0x64) plan.push({ seg: c, tempo, step: depth ? null : i });
    else if (c === 0xC8) { rptStart = i + 1; rptLeft = null; rptPlan = plan.length; }
    else if (c < 0xC8) {
      if (c === 0x64) { loop = true; loopFrom = rptStart != null ? rptPlan : 0; break; }
      if (rptLeft == null) rptLeft = c - 0x64 - 1;
      if (rptLeft > 0 && rptStart != null) { rptLeft--; i = rptStart; continue; }
      rptLeft = null; rptStart = null;
    }
    else if (c === 0xC9) { loop = true; break; }
    else if (c === 0xCA) break;
    else if (c >= 0xD5 && c < 0xDD) plan.push({ mix: c - 0xD5 });
    else if (c === 0xDD) { const r = songPlan(songs, v, depth + 1); loopFrom = plan.length + r.loopFrom; plan.push(...r.plan); loop = r.loop; break; }
    else if (c === 0xDE) { const r = songPlan(songs, v, depth + 1); plan.push(...r.plan); }
    else if (c >= 0xDF) { tempo = Math.max(20, Math.min(255, tempo + (v & 0x80 ? -(v & 0x7F) : v & 0x7F))); plan.push({ tempo }); }
    i++;
  }
  return { plan, loop, loopFrom };
}
// Replace one segment's bytes; shift everything after it and fix all pointers.
export function replaceSegment(bytes, n, newSeg) {
  const tbl = segTable(bytes); const off = tbl[n]; if (off == null) throw new Error('Segment empty');
  const old = decodeSegment(bytes, off); const oldLen = old.end - off, delta = newSeg.length - oldLen;
  // used data end: furthest end of any segment or the song
  let usedEnd = 0; tbl.forEach(o => { if (o != null) usedEnd = Math.max(usedEnd, decodeSegment(bytes, o).end); });
  usedEnd = Math.max(usedEnd, songAreaEnd(bytes));
  let size = bytes.length;
  const needed = usedEnd + delta;
  if (needed > size - 16) size = 0x200 + Math.ceil((needed + 64 - 0x200 - 0xC8) / 256) * 256 + 0xC8;
  const nb = new Uint8Array(Math.max(size, bytes.length));
  nb.set(bytes.subarray(0, off));
  nb.set(newSeg, off);
  nb.set(bytes.subarray(off + oldLen, Math.min(bytes.length, nb.length - newSeg.length - off + off + oldLen)), off + newSeg.length);
  const fix = o => { const p = le16(nb, o); if (p && p !== 0xffff && p - SQ_RAM_DELTA > off) setLe16(nb, o, p + delta); };
  for (let k = 0; k < NSEG; k++) fix(SEG_TABLE + 2 * k);
  fix(SONG_PTR);
  if (nb.length !== bytes.length) setPages(nb);
  return nb;
}
export function segmentToMidi(seg, bpm = 90, noteBase = 36) {
  const trk = []; const vlq = n => { const s = [n & 127]; while ((n >>= 7)) s.unshift((n & 127) | 128); return s; };
  const us = Math.round(60e6 / bpm); trk.push(0, 0xFF, 0x51, 3, us >> 16 & 255, us >> 8 & 255, us & 255);
  const evs = [];
  seg.events.forEach(e => { const vel = e.level ? Math.max(1, Math.round(e.level / 15 * 127)) : 100; const t = Math.round(e.playTick ?? e.tick); evs.push([t, 0x99, noteBase + e.pad, vel], [t + 24, 0x89, noteBase + e.pad, 0]); });
  evs.sort((a, b) => a[0] - b[0] || (a[1] === 0x89 ? -1 : 1)); let last = 0;
  evs.forEach(([t, s, n, v]) => { trk.push(...vlq(t - last), s, n, v); last = t; });
  trk.push(...vlq(Math.max(0, seg.len - last)), 0xFF, 0x2F, 0);
  const hdr = [0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, PPQ];
  const tl = trk.length; return Uint8Array.from([...hdr, 0x4D, 0x54, 0x72, 0x6B, tl >>> 24, tl >> 16 & 255, tl >> 8 & 255, tl & 255, ...trk]);
}

// ================= MIDI Sample Dump Standard (SDS) =================
// Header  F0 7E cc 01 sl sh ee pl pm ph gl gm gh hl hm hh il im ih jj F7
// Packet  F0 7E cc 02 kk <120 data bytes> ll F7   (ll = XOR of 7E cc 02 kk data, & 7F)
// Handshake: ACK 7F, NAK 7E, CANCEL 7D, WAIT 7C   (F0 7E cc xx pp F7);  Request: F0 7E cc 03 sl sh F7
export const SDS = { HEADER: 0x01, PACKET: 0x02, REQUEST: 0x03, ACK: 0x7F, NAK: 0x7E, CANCEL: 0x7D, WAIT: 0x7C };
const u21 = (a, i) => a[i] | (a[i + 1] << 7) | (a[i + 2] << 14);
const w21 = v => [v & 127, (v >> 7) & 127, (v >> 14) & 127];
export const isSds = m => m.length >= 5 && m[0] === 0xF0 && m[1] === 0x7E;
export function sdsHandshake(cc, type, pkt = 0) { return [0xF0, 0x7E, cc & 127, type, pkt & 127, 0xF7]; }
export function sdsRequest(cc, num) { return [0xF0, 0x7E, cc & 127, SDS.REQUEST, num & 127, (num >> 7) & 127, 0xF7]; }
export function sdsParseHeader(m) {
  if (!isSds(m) || m[3] !== SDS.HEADER || m.length < 21) return null;
  return { cc: m[2], num: m[4] | (m[5] << 7), bits: m[6], periodNs: u21(m, 7), length: u21(m, 10), loopStart: u21(m, 13), loopEnd: u21(m, 16), loopType: m[19] };
}
export function sdsHeader(cc, num, bits, rateHz, length, loopStart = 0, loopEnd = 0, loopType = 0x7F) {
  return [0xF0, 0x7E, cc & 127, SDS.HEADER, num & 127, (num >> 7) & 127, bits, ...w21(Math.round(1e9 / rateHz)), ...w21(length), ...w21(loopStart), ...w21(loopEnd), loopType, 0xF7];
}
const bytesPerWord = bits => Math.ceil(bits / 7);
// packet data -> words (unsigned, left-justified in 7-bit bytes)
export function sdsParsePacket(m, bits) {
  if (!isSds(m) || m[3] !== SDS.PACKET || m.length !== 127) return null;
  let cs = 0x7E ^ m[2] ^ 0x02 ^ m[4]; for (let i = 5; i < 125; i++) cs ^= m[i];
  const ok = (cs & 127) === m[125], n = bytesPerWord(bits), words = [];
  for (let i = 5; i + n <= 125; i += n) { let v = 0; for (let k = 0; k < n; k++) v = (v << 7) | m[i + k]; words.push(v >> (n * 7 - bits)); }
  return { pkt: m[4], ok, words };
}
export function sdsPackets(cc, words, bits) {
  const n = bytesPerWord(bits), per = Math.floor(120 / n), out = [];
  for (let w = 0, k = 0; w < words.length; w += per, k++) {
    const d = new Array(120).fill(0);
    for (let j = 0; j < per && w + j < words.length; j++) { let v = (words[w + j] & ((1 << bits) - 1)) << (n * 7 - bits); for (let b = n - 1; b >= 0; b--) { d[j * n + b] = v & 127; v >>= 7; } }
    let cs = 0x7E ^ (cc & 127) ^ 0x02 ^ (k & 127); d.forEach(x => cs ^= x);
    out.push([0xF0, 0x7E, cc & 127, SDS.PACKET, k & 127, ...d, cs & 127, 0xF7]);
  }
  return out;
}
// convert between SDS words of any bit depth and the SP-12's 12-bit unsigned samples
export const toSp12 = (w, bits) => bits >= 12 ? w >> (bits - 12) : w << (12 - bits);
export const fromSp12 = (s, bits) => bits >= 12 ? s << (bits - 12) : s >> (12 - bits);

// ================= SP-12 "MIDI disk" (CASSETTE/DISK 3x on the SP-12) =================
// The SP-12 talks to a disk drive over MIDI: E-mu SysEx F0 18 01 cc ... F7.
//  00 status   -> drive answers F0 18 01 41 F7 (ready)        01 end of function     02 format -> ACK
//  06 block data: 256-byte blocks packed into 293 MIDI bytes  -> drive ACKs (F0 18 01 20 F7)
//  03 blocks written (hh ll nn)                               04 read request (hh ll nn) -> ACK
//  05 next block -> drive sends F0 18 01 06 <293 bytes> F7
// Block numbers in 03/04 are raw 8-bit bytes (not MIDI-safe), so requests for blocks with a low byte >= 80h
// arrive damaged or not at all; the drive then continues with the next block in order.
// Protocol as implemented by SirKrisBo's SP-12 MIDI Disk (GPL-3.0); this is an independent implementation.
export const DISK = { STATUS: 0x41, ACK: [0xF0, 0x18, 0x01, 0x20, 0xF7] };
export function diskPack(blk) {
  const out = new Uint8Array(293); let acc = 0, n = 0, o = 0;
  for (let i = 0; i < 256; i++) { acc = (acc << 8) | blk[i]; n += 8; while (n >= 7) { n -= 7; out[o++] = (acc >> n) & 0x7F; } acc &= (1 << n) - 1; }
  out[o++] = (acc << (7 - n)) & 0x7F; return out;
}
export function diskUnpack(d, off) {
  const out = new Uint8Array(256); let acc = 0, n = 0, o = 0;
  for (let i = 0; i < 293 && o < 256; i++) { acc = (acc << 7) | (d[off + i] & 0x7F); n += 7; if (n >= 8) { n -= 8; out[o++] = (acc >> n) & 0xFF; acc &= (1 << n) - 1; } }
  return out;
}
// .SP12 / .SQ12 file = 512-byte header (bytes 3-4: blocks + 2) + 256-byte disk blocks (+ optional tail)
export function fileToDisk(bytes) {
  const n = Math.max(0, Math.min(getPages(bytes) - 2, Math.floor((bytes.length - 512) / 256)));
  const blocks = []; for (let i = 0; i < n; i++) blocks.push(bytes.slice(512 + i * 256, 512 + (i + 1) * 256)); return blocks;
}
export function diskToFile(blocks) {
  const b = new Uint8Array(512 + blocks.length * 256); b[1] = 1; const p = blocks.length + 2; b[3] = (p >> 8) & 255; b[4] = p & 255;
  blocks.forEach((blk, i) => b.set(blk, 512 + i * 256)); return b;
}
export const diskType = blocks => blocks[0] ? ({ 0x17: 'SQ12', 0x18: 'SP12', 0x1A: 'SP12' }[blocks[0][0]] || null) : null;

// ---------- SQ12 editing: new segments, songs ----------
const SEQ_LOW = 0x6EFE, SEQ_DELTA = 0x201 - SEQ_LOW;              // file offset = RAM address + SEQ_DELTA (lower area)
// whole blocks again; the bytes after the data in the last block and any tail behind the blocks (e.g. from other tools) are kept
function finishSQ(nb, orig) {
  const n = 0x200 + Math.max(1, Math.ceil((nb.length - 0x200) / 256)) * 256, oBlocks = orig ? Math.min(orig.length, ((orig[3] << 8) | orig[4]) * 256) : 0;
  const tail = orig && orig.length > oBlocks ? orig.subarray(oBlocks) : new Uint8Array(0);
  const out = new Uint8Array(n + tail.length);
  if (orig) out.set(orig.subarray(nb.length, Math.min(n, oBlocks)), nb.length);   // padding as before
  out.set(nb); out.set(tail, n); out[3] = ((n / 256) >> 8) & 255; out[4] = (n / 256) & 255; return out;
}
// an empty, playable segment: beat unit quarter (b0 low nibble 0), beats per bar, length in units of 1/24 quarter
export function emptySegment(quarters, beatsPerBar = 4, swingIdx = 0) {
  return encodeSegment({ b0: (swingIdx & 15) << 4, b1: beatsPerBar, len: quarters * 24 * TPU, events: [] });
}
// add segment n (00-99) behind the segment data (RAM lower top); the songs move up in the file
export function insertSegment(bytes, n, seg) {
  if (segTable(bytes)[n] != null) throw new Error('Segment ' + n + ' exists');
  const h = seqHeader(bytes), lowEnd = h.lt + SEQ_DELTA, end = songAreaEnd(bytes);
  if (h.lt + seg.length > h.ub) throw new Error('Sequence memory full');
  const nb = new Uint8Array(end + seg.length);
  nb.set(bytes.subarray(0, lowEnd)); nb.set(seg, lowEnd); nb.set(bytes.subarray(lowEnd, end), lowEnd + seg.length);
  setLe16(nb, SEG_TABLE + 2 * n, h.lt); setLe16(nb, 0x203, h.lt + seg.length);
  return finishSQ(nb, bytes);
}
// a song's bytes, lowest address first (it runs downward from its tempo byte)
export function encodeSong(song) {
  const down = [song.tempo & 255, song.b1 ?? (song.tenths || 0), ...(song.hdr || [song.first || 0, 0, 0, 0, 0])];
  song.steps.forEach(st => down.push(...st));
  const last = song.steps[song.steps.length - 1]; if (!last || last[0] !== 0xCA) down.push(0xCA);
  return down.reverse();
}
// write all songs again (packed downward from the RAM top, highest pointer first, as the SP-12 keeps them)
export const EMPTY_SONG = () => ({ n: 1, q: 0xFFFF, tempo: 120, b1: 0, hdr: [0, 0, 0, 0, 0], steps: [] });
// the SP-12 always keeps at least one song at the RAM top (a file without one is refused by 3 3)
export function writeSongs(bytes, songs) {
  if (!songs.length) songs = [EMPTY_SONG()];
  const h = seqHeader(bytes), lowEnd = h.lt + SEQ_DELTA;
  const order = songs.slice().sort((a, b) => (b.q || 0) - (a.q || 0) || a.n - b.n);
  let top = Math.max(0, ...songs.map(sg => sg.q || 0)) || h.top; const ptr = new Map(), chunks = [];   // keep the free bytes above the first song
  order.forEach(sg => { const b = encodeSong(sg); ptr.set(sg.n, top); chunks.unshift(b); top -= b.length; });
  const ub = top, area = chunks.flat();
  if (ub <= h.lt) throw new Error('Sequence memory full');
  const nb = new Uint8Array(lowEnd + area.length); nb.set(bytes.subarray(0, lowEnd)); nb.set(area, lowEnd);
  setLe16(nb, 0x205, ub);
  for (let k = 0; k < 100; k++) setLe16(nb, SONG_TABLE + 2 * k, 0);
  ptr.forEach((q, n) => setLe16(nb, SONG_TABLE + 2 * n, q));
  return finishSQ(nb, bytes);
}
// remove segment n: its bytes leave the lower area, later segments and the songs move down, the table entry becomes empty
export function deleteSegment(bytes, n) {
  const tbl = segTable(bytes), off = tbl[n]; if (off == null) throw new Error('Segment ' + n + ' is empty');
  const len = decodeSegment(bytes, off).end - off, h = seqHeader(bytes), end = songAreaEnd(bytes);
  const nb = new Uint8Array(end - len);
  nb.set(bytes.subarray(0, off)); nb.set(bytes.subarray(off + len, end), off);
  for (let k = 0; k < NSEG; k++) { const p = le16(nb, SEG_TABLE + 2 * k); if (p >> 8 && p !== 0xffff && p - SQ_RAM_DELTA > off) setLe16(nb, SEG_TABLE + 2 * k, p - len); }
  setLe16(nb, SEG_TABLE + 2 * n, 0); setLe16(nb, 0x203, h.lt - len);
  return finishSQ(nb, bytes);
}
