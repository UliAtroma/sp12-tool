// Drum-break chopper: pure DSP on the original sound (no separation – the sound stays as it is).
// 1. (percussive() = HPSS is kept for reference, not used) 2. onsets (spectral flux of the percussive part), 3. features per hit, 4. classification into kick / snare / hats / perc,
// 5. the most typical hit per class (plus a clearly different variant) as a short sample.

function fft(re, im) { // in place, radix 2
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) { let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) { const u = i + k, v = u + len / 2, tr = re[v] * cr - im[v] * ci, ti = re[v] * ci + im[v] * cr;
        re[v] = re[u] - tr; im[v] = im[u] - ti; re[u] += tr; im[u] += ti; const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr; } }
  }
}
const N = 1024, HOP = 256, BINS = N / 2 + 1;
const WIN = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
function stft(x) {
  const frames = Math.max(1, Math.ceil(x.length / HOP) + 1), R = [], I = [];
  for (let f = 0; f < frames; f++) {
    const re = new Float32Array(N), im = new Float32Array(N), o = f * HOP - N / 2;
    for (let i = 0; i < N; i++) { const k = o + i; re[i] = k >= 0 && k < x.length ? x[k] * WIN[i] : 0; }
    fft(re, im); R.push(re.slice(0, BINS)); I.push(im.slice(0, BINS));
  }
  return { R, I, frames };
}
function istft(R, I, len) {
  const out = new Float32Array(len), norm = new Float32Array(len);
  for (let f = 0; f < R.length; f++) {
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let k = 0; k < BINS; k++) { re[k] = R[f][k]; im[k] = I[f][k]; if (k > 0 && k < N / 2) { re[N - k] = R[f][k]; im[N - k] = -I[f][k]; } }
    for (let i = 0; i < N; i++) im[i] = -im[i]; fft(re, im);            // inverse via conjugate
    const o = f * HOP - N / 2;
    for (let i = 0; i < N; i++) { const k = o + i; if (k < 0 || k >= len) continue; out[k] += re[i] / N * WIN[i]; norm[k] += WIN[i] * WIN[i]; }
  }
  for (let i = 0; i < len; i++) if (norm[i] > 1e-6) out[i] /= norm[i];
  return out;
}
function median(a) { const s = Float32Array.from(a).sort(); return s[s.length >> 1]; }
// HPSS with soft masks; returns the percussive signal and its magnitude spectrogram
export function percussive(x, opt = {}) {
  const S = stft(x), F = S.frames, M = S.R.map((re, f) => { const m = new Float32Array(BINS); for (let k = 0; k < BINS; k++) m[k] = Math.hypot(re[k], S.I[f][k]); return m; });
  const LT = opt.lt || 17, LF = opt.lf || 17, H = [], P = [], buf = new Float32Array(Math.max(LT, LF));
  for (let f = 0; f < F; f++) {
    const h = new Float32Array(BINS), p = new Float32Array(BINS);
    for (let k = 0; k < BINS; k++) {
      let n = 0; for (let d = -(LT >> 1); d <= LT >> 1; d++) { const g = f + d; buf[n++] = g >= 0 && g < F ? M[g][k] : 0; } h[k] = median(buf.subarray(0, n));
      n = 0; for (let d = -(LF >> 1); d <= LF >> 1; d++) { const j = k + d; buf[n++] = j >= 0 && j < BINS ? M[f][j] : 0; } p[k] = median(buf.subarray(0, n));
    }
    H.push(h); P.push(p);
  }
  const pw = opt.power || 2, R = [], I = [], PM = [];
  for (let f = 0; f < F; f++) {
    const r = new Float32Array(BINS), i = new Float32Array(BINS), pm = new Float32Array(BINS);
    for (let k = 0; k < BINS; k++) { const a = Math.pow(P[f][k], pw), b = Math.pow(H[f][k], pw), m = a + b > 0 ? a / (a + b) : 0; r[k] = S.R[f][k] * m; i[k] = S.I[f][k] * m; pm[k] = M[f][k] * m; }
    R.push(r); I.push(i); PM.push(pm);
  }
  return { y: istft(R, I, x.length), PM };
}
// onsets: half-wave rectified spectral flux (log magnitude), adaptive threshold, minimum gap
export function onsets(PM, sr, opt = {}) {
  const F = PM.length, flux = new Float32Array(F);
  for (let f = 1; f < F; f++) { let s = 0; for (let k = 1; k < BINS; k++) { const d = Math.log1p(PM[f][k] * 10) - Math.log1p(PM[f - 1][k] * 10); if (d > 0) s += d; } flux[f] = s; }
  const mx = Math.max(1e-9, ...flux), gap = Math.round((opt.gap || 0.05) * sr / HOP), out = [], sens = opt.sens ?? 0.5;
  for (let f = 2; f < F - 1; f++) {
    let loc = 0, n = 0; for (let d = -8; d <= 8; d++) { const g = f + d; if (g >= 0 && g < F) { loc += flux[g]; n++; } } loc /= n;
    if (flux[f] > flux[f - 1] && flux[f] >= flux[f + 1] && flux[f] > loc * (1.2 + (1 - sens)) && flux[f] > mx * 0.06 * (1.3 - sens)) {
      if (out.length && f - out[out.length - 1].f < gap) { if (flux[f] > out[out.length - 1].v) out[out.length - 1] = { f, v: flux[f] }; continue; }
      out.push({ f, v: flux[f] });
    }
  }
  return out.map(o => ({ t: Math.max(0, o.f * HOP - N / 2), strength: o.v / mx }));
}
// features of one hit from the percussive spectrogram (first ~60 ms) and its envelope
function features(y, PM, t, sr, end) {
  const f0 = Math.max(0, Math.round((t + N / 2) / HOP)), f1 = Math.min(PM.length, f0 + Math.max(2, Math.round(0.06 * sr / HOP)));
  // what the hit adds: the spectrum just after the onset minus the background just before it (bass, chords, pads drop out
  // of the analysis – only the analysis, the sample itself stays untouched)
  const b0 = Math.max(0, f0 - 4), b1 = Math.max(b0 + 1, f0 - 1), bg = new Float32Array(BINS);
  for (let f = b0; f < b1; f++) for (let k = 0; k < BINS; k++) bg[k] = Math.max(bg[k], PM[f][k]);
  const hz = k => k * sr / N, band = [0, 0, 0, 0, 0]; let tot = 0, cen = 0, geo = 0, ar = 0, cnt = 0;
  for (let f = f0; f < f1; f++) for (let k = 1; k < BINS; k++) {
    const m = Math.max(0, PM[f][k] - bg[k] * 1.1), e = m * m, h = hz(k); tot += e; cen += e * h;
    band[h < 150 ? 0 : h < 400 ? 1 : h < 2000 ? 2 : h < 5000 ? 3 : 4] += e;
    geo += Math.log(m + 1e-9); ar += m; cnt++;
  }
  const flat = cnt ? Math.exp(geo / cnt) / (ar / cnt + 1e-12) : 0;
  // decay per band from the spectrogram (10 ms frames): time until the band falls 20 dB under its peak, up to the next hit
  const fEnd = Math.min(PM.length, Math.round((end + N / 2) / HOP)), bandE = (f, lo, hi) => { let e = 0; for (let k = Math.max(1, Math.floor(lo * N / sr)); k < Math.min(BINS, Math.ceil(hi * N / sr)); k++) { const m = Math.max(0, PM[f][k] - bg[k]); e += m * m; } return e; };
  const decayOf = (lo, hi) => { let pk = 0, pf = f0; for (let f = f0; f < Math.min(fEnd, f0 + 4); f++) { const e = bandE(f, lo, hi); if (e > pk) { pk = e; pf = f; } } for (let f = pf; f < fEnd; f++) if (bandE(f, lo, hi) < pk * 0.01) return (f - f0) * HOP / sr; return (fEnd - f0) * HOP / sr; };
  const dec = decayOf(30, sr / 2), decLow = decayOf(30, 200), decHigh = decayOf(5000, sr / 2);
  let pk = 0; for (let i = t; i < Math.min(end, t + Math.round(sr * 0.05)); i++) pk = Math.max(pk, Math.abs(y[i]));
  const fr = band.map(b => b / (tot || 1));
  return { low: fr[0], lowmid: fr[1], mid: fr[2], himid: fr[3], high: fr[4], centroid: cen / (tot || 1), flat, decay: dec, decLow, decHigh, energy: tot, peak: pk };
}
function classify(ft) {
  if (ft.low >= 0.4) return 'kick';                                              // the low band rules, even with a hat on top
  if (ft.high + ft.himid * 0.5 >= 0.5) return ft.decHigh > 0.13 ? 'openhat' : 'hihat';
  if (ft.lowmid + ft.mid + ft.himid >= 0.45 && ft.flat > 0.1 && ft.low < 0.35) return 'snare';
  return 'perc';
}
// how typical a hit is for its class (higher = better example)
function typical(c, f) {
  const loud = Math.sqrt(f.energy);
  if (c === 'kick') return loud * (f.low + f.lowmid * 0.5) * (1 - f.high);
  if (c === 'snare') return loud * (f.mid + f.himid) * (0.5 + f.flat) * (1 - f.low);
  if (c === 'hihat') return loud * f.high * (1 - f.low) / (0.05 + f.decHigh);
  if (c === 'openhat') return loud * f.high * (1 - f.low) * Math.min(1, f.decHigh);
  return loud * (1 - Math.abs(f.low - 0.3));
}
const dist = (a, b) => Math.abs(Math.log((a.centroid + 50) / (b.centroid + 50))) + Math.abs(a.low - b.low) + Math.abs(a.high - b.high) + Math.abs(Math.log((a.decay + 0.02) / (b.decay + 0.02))) * 0.5 + Math.abs(Math.log((a.decLow + 0.02) / (b.decLow + 0.02))) * 0.5;
// the whole analysis: x = Float32Array at sr; returns picked hits [{ kind, label, start, end }] and the drum signal
// spectrogram of the untouched signal: no separation, the sound stays as it is
function spectrum(x) { const S = stft(x); return S.R.map((re, f) => { const m = new Float32Array(BINS); for (let k = 0; k < BINS; k++) m[k] = Math.hypot(re[k], S.I[f][k]); return m; }); }
export function analyse(x, sr, opt = {}) {
  const y = x, PM = spectrum(x), on = onsets(PM, sr, opt), maxLen = Math.round((opt.maxLen || 0.5) * sr);
  const hits = on.map((o, i) => {
    const start = Math.max(0, o.t - Math.round(sr * 0.003)), nxt = i + 1 < on.length ? on[i + 1].t : x.length, end = Math.min(x.length, nxt - Math.round(sr * 0.002), start + maxLen);
    const ft = features(y, PM, start, sr, Math.min(x.length, nxt, start + Math.round(sr * 0.8))); const kind = classify(ft);
    return { start, end, nextGap: (nxt - start) / sr, ft, kind, score: typical(kind, ft) * Math.min(1, (nxt - start) / sr / ({ kick: 0.3, openhat: 0.3, snare: 0.2, hihat: 0.08 }[kind] || 0.15)) };   // hits cut off early by the next one score lower
  });
  const want = [['kick', 'Kick'], ['kick2', 'Kick 2'], ['snare', 'Snare'], ['snare2', 'Snare 2'], ['hihat', 'HiHat'], ['openhat', 'Open HiHat'], ['perc', 'Perc']], picked = [];
  ['kick', 'snare', 'hihat', 'openhat', 'perc'].forEach(c => {
    const list = hits.filter(h => h.kind === c).sort((a, b) => b.score - a.score); if (!list.length) return;
    picked.push({ ...list[0], label: want.find(w => w[0] === c)[1], kind: c });
    if (c === 'kick' || c === 'snare') { const v = list.slice(1).find(h => dist(h.ft, list[0].ft) > 0.35 && h.score > list[0].score * 0.25); if (v) picked.push({ ...v, label: c === 'kick' ? 'Kick 2' : 'Snare 2', kind: c + '2' }); }
  });
  const order = want.map(w => w[0]); picked.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return { y, hits, picked };
}
