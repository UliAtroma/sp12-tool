// Mixing desk after the SSL consoles of the 90s: 8 channel strips (the SP-12's 8 outputs) with drive (SSL / Mackie /
// Tascam flavoured saturation), dynamics, filters, 4-band EQ, 2 aux sends, pan, mute / solo, routing to the mix or to
// group A / B; reverb (Lexicon- or Quadraverb-flavoured, with its own EQ), tempo-synced delay, SSL-style bus compressor.
// Built per AudioContext, so offline renders (exports) sound like playback.
const LS = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch (e) { return d; } };
const db = x => Math.pow(10, x / 20);
export const CH_DEFAULT = () => ({
  drive: 0, model: 'ssl',                            // input drive (dB) and its character
  thr: 0, ratio: 1, rel: 0.2, makeup: 0,             // dynamics (ratio 1 = off)
  hpf: 20, lpf: 20000,
  hf: 0, hff: 8000, hmf: 0, hmff: 3000, hmq: 1, lmf: 0, lmff: 600, lmq: 1, lf: 0, lff: 100, eqOn: true,
  aux1: 0, aux2: 0, pan: 0, fader: 0, mute: false, solo: false, name: '', bus: 'mix'
});
const GRP_DEFAULT = () => ({ fader: 0, mute: false, thr: 0, ratio: 1 });
export const DESK_DEFAULT = () => ({
  ch: Array.from({ length: 8 }, CH_DEFAULT), grp: { A: GRP_DEFAULT(), B: GRP_DEFAULT() },
  bus: { on: false, thr: -10, ratio: 4, att: 0.01, rel: 0.3, makeup: 0 },
  rev: { type: 'lex', size: 1.8, pre: 0.02, lo: 120, hi: 9000, level: 0 },
  dly: { sync: '1/8.', time: 0.375, fb: 0.35, level: 0 }, master: 0
});
export const desk = (() => { const d = DESK_DEFAULT(), s = LS('sp12desk', null); if (!s) return d;
  return { ...d, ...s, ch: d.ch.map((c, i) => ({ ...c, ...(s.ch && s.ch[i] || {}) })), grp: { A: { ...d.grp.A, ...(s.grp && s.grp.A) }, B: { ...d.grp.B, ...(s.grp && s.grp.B) } },
    bus: { ...d.bus, ...s.bus }, rev: { ...d.rev, ...s.rev }, dly: { ...d.dly, ...s.dly } }; })();
export const saveDesk = () => { try { localStorage.setItem('sp12desk', JSON.stringify(desk)); } catch (e) { } };
export const SYNCS = { '1/4': 1, '1/4.': 1.5, '1/4T': 2 / 3, '1/8': 0.5, '1/8.': 0.75, '1/8T': 1 / 3, '1/16': 0.25, '1/16.': 0.375, '1/16T': 1 / 6, '1/32': 0.125 };
export const syncTime = (sync, bpm) => SYNCS[sync] ? Math.min(2, 60 / Math.max(20, bpm) * SYNCS[sync]) : null;

// ---- drive: three saturation characters (own curves, in the spirit of the consoles; not measurements)
const CURVE_N = 4096;
function curve(model) {
  const k = new Float32Array(CURVE_N);
  for (let i = 0; i < CURVE_N; i++) { const x = i / (CURVE_N - 1) * 2 - 1; let y;
    if (model === 'ssl') y = Math.tanh(1.2 * x) / Math.tanh(1.2) * 0.9 + 0.1 * Math.tanh(3 * x) / Math.tanh(3);               // clean, then firm odd-order clip
    else if (model === 'mackie') { const a = x + 0.12 * x * x; y = Math.tanh(1.6 * a) / Math.tanh(1.6 * 1.12); }                 // warm, slightly asymmetric
    else { const a = x + 0.25 * x * x - 0.05; y = (2 / Math.PI) * Math.atan(2.2 * a) / ((2 / Math.PI) * Math.atan(2.2 * 1.2)); } // tape-ish, even harmonics, soft knee
    k[i] = Math.max(-1, Math.min(1, y)); }
  return k;
}
const CURVES = { ssl: curve('ssl'), mackie: curve('mackie'), tascam: curve('tascam') };
// ---- reverb impulses: "lex" = dense, smooth, darkening hall with modulated tail; "quad" = brighter, grainier, metallic,
// lower internal rate (sample-and-hold) like late-80s budget digital reverbs. Own synthesis, inspired by – not copies of – the units.
function impulse(c, type, secs, pre) {
  const sr = c.sampleRate, n = Math.max(1, Math.round(sr * (secs + pre))), b = c.createBuffer(2, n, sr), p0 = Math.round(pre * sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch); let lp = 0, hold = 0, seed = ch ? 7 : 3;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
    const er = type === 'lex' ? [0.011, 0.019, 0.027, 0.041, 0.053] : [0.007, 0.013, 0.023, 0.029];
    er.forEach((t, k) => { const i = p0 + Math.round(t * sr * (ch ? 1.07 : 1)); if (i < n) d[i] += (type === 'lex' ? 0.5 : 0.7) * Math.pow(0.8, k) * (k % 2 ? -1 : 1); });
    const decimate = type === 'quad' ? Math.max(1, Math.round(sr / 20000)) : 1;
    for (let i = p0; i < n; i++) {
      const t = (i - p0) / sr, env = Math.pow(1 - (i - p0) / (n - p0), type === 'lex' ? 2.2 : 3.0) * Math.min(1, t / (type === 'lex' ? 0.03 : 0.012));
      if ((i - p0) % decimate === 0) hold = rnd();
      const damp = type === 'lex' ? 0.55 + 0.4 * Math.min(1, t / secs) : 0.25 + 0.2 * Math.min(1, t / secs);   // HF loss over time
      lp += (1 - damp) * (hold - lp);
      let v = lp * env;
      if (type === 'lex') v *= 1 + 0.08 * Math.sin(2 * Math.PI * 0.7 * t + ch);                                 // slow modulation
      else v += 0.18 * env * Math.sin(2 * Math.PI * (ch ? 1310 : 1170) * t) * Math.exp(-t * 6);                     // metallic ring
      d[i] += v * (type === 'lex' ? 0.9 : 1);
    }
  }
  return b;
}
const chains = new WeakMap();
export function deskFor(c) {
  if (chains.has(c)) return chains.get(c);
  const master = c.createGain(), busComp = c.createDynamicsCompressor(), busMake = c.createGain(), out = c.createGain();
  const revIn = c.createGain(), revPre = c.createDelay(0.5), rev = c.createConvolver(), revHp = c.createBiquadFilter(), revLp = c.createBiquadFilter(), revOut = c.createGain();
  revHp.type = 'highpass'; revLp.type = 'lowpass';
  rev.buffer = impulse(c, desk.rev.type, desk.rev.size, 0); revIn.connect(revPre); revPre.connect(rev); rev.connect(revHp); revHp.connect(revLp); revLp.connect(revOut); revOut.connect(master);
  const dlyIn = c.createGain(), dly = c.createDelay(2), dlyFb = c.createGain(), dlyOut = c.createGain(), dlyLp = c.createBiquadFilter();
  dlyLp.type = 'lowpass'; dlyLp.frequency.value = 4500; dlyIn.connect(dly); dly.connect(dlyLp); dlyLp.connect(dlyFb); dlyFb.connect(dly); dlyLp.connect(dlyOut); dlyOut.connect(master);
  master.connect(busComp); busComp.connect(busMake); busMake.connect(out); out.connect(c.destination);
  const meterM = c.createAnalyser(); meterM.fftSize = 512; out.connect(meterM);
  const split = c.createChannelSplitter(2), meterL = c.createAnalyser(), meterR = c.createAnalyser(); meterL.fftSize = meterR.fftSize = 1024; out.connect(split); split.connect(meterL, 0); split.connect(meterR, 1);
  const groups = {}; ['A', 'B'].forEach(g => { const inp = c.createGain(), comp = c.createDynamicsCompressor(), fader = c.createGain(), meter = c.createAnalyser(); meter.fftSize = 256;
    inp.connect(comp); comp.connect(fader); fader.connect(master); fader.connect(meter); groups[g] = { inp, comp, fader, meter }; });
  const strips = desk.ch.map(() => {
    const inp = c.createGain(), pre = c.createGain(), shp = c.createWaveShaper(), post = c.createGain(), tone = c.createBiquadFilter(), comp = c.createDynamicsCompressor(), make = c.createGain();
    const hpf = c.createBiquadFilter(), lpf = c.createBiquadFilter(), hf = c.createBiquadFilter(), hmf = c.createBiquadFilter(), lmf = c.createBiquadFilter(), lf = c.createBiquadFilter();
    const pan = c.createStereoPanner(), fader = c.createGain(), route = c.createGain(), a1 = c.createGain(), a2 = c.createGain(), meter = c.createAnalyser();
    shp.oversample = '4x'; tone.type = 'lowpass'; hpf.type = 'highpass'; lpf.type = 'lowpass'; hf.type = 'highshelf'; hmf.type = 'peaking'; lmf.type = 'peaking'; lf.type = 'lowshelf'; meter.fftSize = 1024;
    inp.connect(pre); pre.connect(shp); shp.connect(post); post.connect(tone); tone.connect(comp); comp.connect(make); make.connect(hpf); hpf.connect(lpf);
    lpf.connect(lf); lf.connect(lmf); lmf.connect(hmf); hmf.connect(hf); hf.connect(pan); pan.connect(fader); fader.connect(route); fader.connect(meter);
    hf.connect(a1); hf.connect(a2); a1.connect(revIn); a2.connect(dlyIn);
    return { inp, pre, shp, post, tone, comp, make, hpf, lpf, hf, hmf, lmf, lf, pan, fader, route, a1, a2, meter, dest: null };
  });
  const D = { c, ins: strips.map(s => s.inp), strips, groups, master, busComp, busMake, out, rev, revPre, revHp, revLp, revOut, dly, dlyFb, dlyOut, meterM, meterL, meterR, revKey: `${desk.rev.type}|${desk.rev.size}` };
  chains.set(c, D); applyDesk(D); return D;
}
export function applyDesk(D, only = null) {
  const c = D.c, t = c.currentTime, set = (p, v) => { try { p.setTargetAtTime(v, t, 0.01); } catch (e) { p.value = v; } };
  const anySolo = desk.ch.some(s => s.solo);
  D.strips.forEach((S, i) => {
    if (only != null && only !== i) return; const s = desk.ch[i];
    const drv = Math.max(0, s.drive);                                   // drive: more into the curve, level kept roughly even
    if (S.model !== s.model) { S.shp.curve = CURVES[s.model] || CURVES.ssl; S.model = s.model; }
    set(S.pre.gain, db(drv) * 0.5); set(S.post.gain, 2 / (1 + drv / 12));
    set(S.tone.frequency, s.model === 'tascam' ? 14000 - drv * 250 : s.model === 'mackie' ? 18000 : 20000); S.tone.Q.value = 0.5;
    const dynOn = s.ratio > 1.01;
    set(S.comp.threshold, dynOn ? s.thr : 0); set(S.comp.ratio, Math.max(1, s.ratio)); set(S.comp.release, s.rel); set(S.comp.attack, 0.003); set(S.comp.knee, 3); set(S.make.gain, db(dynOn ? s.makeup : 0));
    set(S.hpf.frequency, s.hpf); S.hpf.Q.value = 0.707; set(S.lpf.frequency, Math.min(s.lpf, c.sampleRate / 2 * 0.95)); S.lpf.Q.value = 0.707;
    const eq = s.eqOn ? 1 : 0;
    set(S.hf.frequency, s.hff); set(S.hf.gain, s.hf * eq); set(S.hmf.frequency, s.hmff); set(S.hmf.gain, s.hmf * eq); S.hmf.Q.value = s.hmq;
    set(S.lmf.frequency, s.lmff); set(S.lmf.gain, s.lmf * eq); S.lmf.Q.value = s.lmq; set(S.lf.frequency, s.lff); set(S.lf.gain, s.lf * eq);
    const on = !s.mute && (!anySolo || s.solo), g = on ? db(s.fader) : 0;
    set(S.pan.pan, s.pan); set(S.fader.gain, g); set(S.a1.gain, on ? s.aux1 * db(s.fader) : 0); set(S.a2.gain, on ? s.aux2 * db(s.fader) : 0);
    const dest = s.bus === 'A' || s.bus === 'B' ? D.groups[s.bus].inp : D.master;   // routing
    if (S.dest !== dest) { try { S.route.disconnect(); } catch (e) { } S.route.connect(dest); S.dest = dest; }
  });
  if (only != null) return;
  ['A', 'B'].forEach(k => { const g = desk.grp[k], G = D.groups[k], dyn = g.ratio > 1.01;
    set(G.comp.threshold, dyn ? g.thr : 0); set(G.comp.ratio, Math.max(1, g.ratio)); set(G.comp.attack, 0.005); set(G.comp.release, 0.25); set(G.fader.gain, g.mute ? 0 : db(g.fader)); });
  const b = desk.bus;
  set(D.busComp.threshold, b.on ? b.thr : 0); set(D.busComp.ratio, b.on ? b.ratio : 1); set(D.busComp.attack, b.att); set(D.busComp.release, b.rel); set(D.busComp.knee, 1); set(D.busMake.gain, db(b.on ? b.makeup : 0));
  const key = `${desk.rev.type}|${desk.rev.size}`; if (D.revKey !== key) { D.rev.buffer = impulse(c, desk.rev.type, desk.rev.size, 0); D.revKey = key; }
  set(D.revPre.delayTime, desk.rev.pre); set(D.revHp.frequency, desk.rev.lo); set(D.revLp.frequency, Math.min(desk.rev.hi, c.sampleRate / 2 * 0.95)); set(D.revOut.gain, desk.rev.level);
  set(D.dly.delayTime, desk.dly.time); set(D.dlyFb.gain, Math.min(0.92, desk.dly.fb)); set(D.dlyOut.gain, desk.dly.level);
  set(D.out.gain, db(desk.master));
}
export function peak(an) { const a = new Float32Array(an.fftSize); an.getFloatTimeDomainData(a); let p = 0; for (const x of a) p = Math.max(p, Math.abs(x)); return p; }

export function rms(an) { const a = new Float32Array(an.fftSize); an.getFloatTimeDomainData(a); let s = 0; for (const x of a) s += x * x; return Math.sqrt(s / a.length); }
