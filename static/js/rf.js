/* 客户端射频引擎 —— 与 rf.py 同构, 所有频率 Hz, 元件链从负载到源 */
const RF = (() => {
  const C0 = 299792458.0;
  const TAU = 2 * Math.PI;

  const cadd = (a, b) => ({ r: a.r + b.r, i: a.i + b.i });
  const csub = (a, b) => ({ r: a.r - b.r, i: a.i - b.i });
  const cmul = (a, b) => ({ r: a.r * b.r - a.i * b.i, i: a.r * b.i + a.i * b.r });
  const cdiv = (a, b) => {
    const d = b.r * b.r + b.i * b.i;
    return { r: (a.r * b.r + a.i * b.i) / d, i: (a.i * b.r - a.r * b.i) / d };
  };
  const cneg = a => ({ r: -a.r, i: -a.i });
  const cabs = a => Math.hypot(a.r, a.i);
  const cconj = a => ({ r: a.r, i: -a.i });
  const cexp = z => {
    const e = Math.exp(z.r);
    return { r: e * Math.cos(z.i), i: e * Math.sin(z.i) };
  };
  const ccosh = z => ({ r: Math.cosh(z.r) * Math.cos(z.i), i: Math.sinh(z.r) * Math.sin(z.i) });
  const csinh = z => ({ r: Math.sinh(z.r) * Math.cos(z.i), i: Math.cosh(z.r) * Math.sin(z.i) });
  const ctanh = z => {
    // tanh(z) = sinh/cosh; 用 tanh(x+iy) 公式避免大数溢出
    const x = z.r, y = z.i;
    const d = Math.cosh(2 * x) + Math.cos(2 * y);
    return { r: Math.sinh(2 * x) / d, i: Math.sin(2 * y) / d };
  };

  function lineGamma(el, f) {
    const vf = Math.max(el.vf ?? 1.0, 1e-3);
    const beta = TAU * f / (vf * C0);
    let alpha = (el.loss ?? 0) * Math.log(10) / 2000;
    alpha *= Math.sqrt(Math.max(f / Math.max(el.lossf ?? f, 1e3), 1e-9));
    return { g: { r: alpha, i: beta }, alpha, beta };
  }

  function lineZin(zl, el, f) {
    const { g } = lineGamma(el, f);
    const gl = cmul(g, { r: el.length, i: 0 });
    const t = ctanh(gl);
    const z0 = el.z0;
    // Z0*(zl + Z0*t)/(Z0 + zl*t)
    return cdiv(cmul({ r: z0, i: 0 }, cadd(zl, cmul({ r: z0, i: 0 }, t))),
      cadd({ r: z0, i: 0 }, cmul(zl, t)));
  }

  function stubY(el, f) {
    const { g } = lineGamma(el, f);
    const gl = cmul(g, { r: el.length, i: 0 });
    const z0 = { r: el.z0, i: 0 };
    let zin;
    if ((el.terminal ?? 'short') === 'short') {
      zin = cmul(z0, ctanh(gl));
    } else {
      zin = cdiv(z0, ctanh(gl));
    }
    return cdiv({ r: 1, i: 0 }, zin);
  }

  function applyElement(z, el, f) {
    const w = TAU * f;
    switch (el.kind) {
      case 'Lser': return cadd(z, { r: 0, i: w * el.value });
      case 'Cser': return cadd(z, { r: 0, i: -1 / (w * el.value) });
      case 'Lpar': return cdiv(CR1, cadd(cdiv(CR1, z), cdiv(CR1, { r: 0, i: w * el.value })));
      case 'Cpar': return cdiv(CR1, cadd(cdiv(CR1, z), { r: 0, i: w * el.value }));
      case 'line': return lineZin(z, el, f);
      case 'stub': return cdiv(CR1, cadd(cdiv(CR1, z), stubY(el, f)));
      default: return z;
    }
  }

  const CR1 = { r: 1, i: 0 };

  function chainInput(zl, chain, f, trace) {
    let z = { r: zl.r, i: zl.i };
    const steps = [{ el: null, z }];
    for (const el of chain) {
      z = applyElement(z, el, f);
      steps.push({ el, z: { r: z.r, i: z.i } });
    }
    return trace ? steps : z;
  }

  function metrics(z, z0) {
    const den = cadd(z, { r: z0, i: 0 });
    let g = cabs(den) < 1e-30 ? { r: 0, i: 0 }
      : cdiv(csub(z, { r: z0, i: 0 }), den);
    const mag = cabs(g);
    const m = Math.min(Math.max(mag, 0), 0.999999);
    return {
      gamma: g, s11: mag,
      vswr: (1 + m) / (1 - m),
      rl: mag > 1e-10 ? Math.min(-20 * Math.log10(Math.max(mag, 1e-12)), 100) : 100,
    };
  }

  // ---- 器件应力 (与 rf.py 同构): 1W 可用功率下逐段 V/I/损耗, 显示时按功率级缩放
  function elAbcd(el, f) {
    const w = TAU * f;
    const one = CR1, zero = { r: 0, i: 0 };
    switch (el.kind) {
      case 'Lser': case 'Cser': {
        const x = el.kind === 'Lser' ? w * el.value : -1 / (w * el.value);
        const q = el.q;
        return { a: one, b: { r: q ? Math.abs(x) / q : 0, i: x }, c: zero, d: one };
      }
      case 'Lpar': case 'Cpar': {
        const x = el.kind === 'Lpar' ? w * el.value : -1 / (w * el.value);
        const q = el.q;
        return { a: one, b: zero, c: { r: q ? 1 / (q * Math.abs(x)) : 0, i: -1 / x }, d: one };
      }
      case 'line': {
        const { g } = lineGamma(el, f);
        const gl = cmul(g, { r: el.length, i: 0 });
        const ch = ccosh(gl), sh = csinh(gl);
        const z0 = { r: el.z0, i: 0 };
        return { a: ch, b: cmul(z0, sh), c: cdiv(sh, z0), d: ch };
      }
      case 'stub':
        return { a: one, b: zero, c: stubY(el, f), d: one };
      default:
        return { a: one, b: zero, c: zero, d: one };
    }
  }

  // 已知源端 V/I, 求传输线(或支节)沿线 |V|max、|I|max; 峰值位置解析枚举, 含端点
  function waveExtremes(v, i, el, f) {
    const { g, beta } = lineGamma(el, f);
    const L = el.length;
    if (L <= 0 || beta <= 0) return [cabs(v), cabs(i)];
    const z0 = { r: el.z0, i: 0 };
    const h = { r: 0.5, i: 0 };
    const A = cmul(h, csub(v, cmul(i, z0)));
    const B = cmul(h, cadd(v, cmul(i, z0)));
    const C = cmul(h, csub(i, cdiv(v, z0)));
    const D = cmul(h, cadd(i, cdiv(v, z0)));
    const ext = (p, q) => {
      let best = cabs(cadd(p, q));                       // x = 0
      const gl = cmul(g, { r: L, i: 0 });
      best = Math.max(best, cabs(cadd(cmul(p, cexp(gl)), cmul(q, cexp(cneg(gl))))));  // x = L
      const pq = cmul(p, cconj(q));
      const phi = Math.atan2(pq.i, pq.r);
      const kLo = Math.floor(phi / TAU) + 1;
      const kHi = Math.floor((beta * L + phi / 2) / Math.PI);
      for (let k = kLo; k <= kHi; k++) {
        const x = (Math.PI * k - phi / 2) / beta;
        if (x <= 0 || x >= L) continue;
        const gx = cmul(g, { r: x, i: 0 });
        best = Math.max(best, cabs(cadd(cmul(p, cexp(gx)), cmul(q, cexp(cneg(gx))))));
      }
      return best;
    };
    return [ext(A, B), ext(C, D)];
  }

  // 统一有损模型 (与 rf.py 同构): 级联含 Q/线损的 ABCD 求输入阻抗,
  // 再以 1W 可用功率自源端向负载逐段反推 V/I; 阻抗/电压/电流/损耗/送达功率同一模型
  function stressAt(chain, zl, f, z0) {
    const abcds = chain.map(el => elAbcd(el, f));
    let A = { r: 1, i: 0 }, B = { r: 0, i: 0 }, C = { r: 0, i: 0 }, D = { r: 1, i: 0 };
    for (const m of abcds) {   // T = M_{n-1} … M_0
      const nA = cadd(cmul(m.a, A), cmul(m.b, C));
      const nB = cadd(cmul(m.a, B), cmul(m.b, D));
      const nC = cadd(cmul(m.c, A), cmul(m.d, C));
      const nD = cadd(cmul(m.c, B), cmul(m.d, D));
      A = nA; B = nB; C = nC; D = nD;
    }
    const denom = cadd(cmul(C, zl), D);
    const zin = cabs(denom) < 1e-30 ? { r: 1e30, i: 0 }
      : cdiv(cadd(cmul(A, zl), B), denom);
    const m = metrics(zin, z0);
    const pIn = Math.max(1 - m.s11 * m.s11, 0);
    const elements = chain.map(el => ({ uid: el.uid, kind: el.kind, v: 0, i: 0, p: 0 }));
    const nodes = chain.map(() => ({ v: { r: 0, i: 0 }, i: { r: 0, i: 0 } }));
    nodes.push({ v: { r: 0, i: 0 }, i: { r: 0, i: 0 } });
    if (pIn <= 0 || zin.r <= 1e-9) return { pIn: 0, pLoad: 0, zin, elements, nodes };
    let i = { r: Math.sqrt(pIn / zin.r), i: 0 };
    let v = cmul(i, zin);
    nodes[chain.length] = { v, i };
    for (let k = chain.length - 1; k >= 0; k--) {
      const el = chain[k];
      const { a, b, c, d } = abcds[k];
      const v2 = csub(cmul(d, v), cmul(b, i));
      const i2 = csub(cmul(a, i), cmul(c, v));
      const diss = Math.max(cmul(v, cconj(i)).r - cmul(v2, cconj(i2)).r, 0);
      let ve, ie;
      if (el.kind === 'Lser' || el.kind === 'Cser') { ve = cabs(cmul(b, i)); ie = cabs(i); }
      else if (el.kind === 'Lpar' || el.kind === 'Cpar') { ve = cabs(v); ie = cabs(cmul(c, v)); }
      else if (el.kind === 'line') { [ve, ie] = waveExtremes(v, i, el, f); }
      else { [ve, ie] = waveExtremes(v, cmul(stubY(el, f), v), el, f); }
      elements[k] = { uid: el.uid, kind: el.kind, v: ve, i: ie, p: diss };
      v = v2; i = i2;
      nodes[k] = { v, i };
    }
    return { pIn, pLoad: Math.max(cmul(v, cconj(i)).r, 0), zin, elements, nodes };
  }

  function elRatio(el, v, i, p) {
    let best = null, governs = null;
    for (const [key, val] of [['vmax', v], ['imax', i], ['pmax', p]]) {
      const lim = el[key];
      if (lim && lim > 0) {
        const r = val / lim;
        if (best === null || r > best) { best = r; governs = key; }
      }
    }
    return { ratio: best, governs };
  }

  // 扫频应力: 每频点逐段 V/I/P + 送达负载功率; 带内聚合每元件最差值/最差频点/裕量
  function stressSweep(cfg, chain, power, freqs, bandHz) {
    const pPeak = power.p_w * Math.pow(10, power.par_db / 10);
    const pTherm = power.p_w * power.duty;
    const spk = Math.sqrt(Math.max(pPeak, 0));
    const [b1, b2] = bandHz;
    const perEl = new Map();
    const rows = [];
    for (const f of freqs) {
      const zl = loadAt(cfg.samples, f);
      const st = stressAt(chain, zl, f, cfg.z0);
      const inBand = f >= b1 - 1e-6 && f <= b2 + 1e-6;
      const recs = chain.map((el, k) => {
        const s = st.elements[k];
        const v = s.v * spk, iv = s.i * spk, p = s.p * pTherm;
        const { ratio, governs } = elRatio(el, v, iv, p);
        if (inBand) {
          let a = perEl.get(el.uid);
          if (!a) {
            a = { uid: el.uid, kind: el.kind, v: 0, i: 0, p: 0,
                  vF: f, iF: f, pF: f, ratio: null, ratioF: null, governs: null };
            perEl.set(el.uid, a);
          }
          if (v > a.v) { a.v = v; a.vF = f; }
          if (iv > a.i) { a.i = iv; a.iF = f; }
          if (p > a.p) { a.p = p; a.pF = f; }
          if (ratio !== null && (a.ratio === null || ratio > a.ratio)) {
            a.ratio = ratio; a.ratioF = f; a.governs = governs;
          }
        }
        return { uid: el.uid, v, i: iv, p, ratio };
      });
      rows.push({
        f, pIn: st.pIn * power.p_w, pLoad: st.pLoad * power.p_w,
        pLoadAvg: st.pLoad * pTherm, pLoadPeak: st.pLoad * pPeak,
        pLossAvg: Math.max(st.pIn - st.pLoad, 0) * pTherm, recs,
      });
    }
    return { rows, perEl, pPeak, pTherm };
  }

  function parseSamples(text) {
    const rows = [];
    for (const raw of (text || '').split('\n')) {
      const line = raw.replace(/;/g, ' ').replace(/,/g, ' ');
      const parts = line.split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      const nums = [];
      let ok = true;
      for (let p of parts) {
        p = p.replace(/MHz|mhz|ohm|Ohm|Ω|f=|F=|R=|X=/g, '').trim();
        const v = parseFloat(p);
        if (!isFinite(v)) { ok = false; break; }
        nums.push(v);
      }
      if (ok && nums.length >= 3 && nums[0] > 0) rows.push([nums[0] * 1e6, nums[1], nums[2]]);
    }
    rows.sort((a, b) => a[0] - b[0]);
    const dedup = [];
    for (const r of rows) {
      if (dedup.length && Math.abs(r[0] - dedup[dedup.length - 1][0]) < 1e3) dedup[dedup.length - 1] = r;
      else dedup.push(r);
    }
    return dedup;
  }

  function loadAt(samples, f) {
    if (!samples.length) return { r: 50, i: 0 };
    if (samples.length === 1) return { r: samples[0][1], i: samples[0][2] };
    if (f <= samples[0][0]) return { r: samples[0][1], i: samples[0][2] };
    if (f >= samples[samples.length - 1][0]) {
      const s = samples[samples.length - 1];
      return { r: s[1], i: s[2] };
    }
    for (let k = 0; k < samples.length - 1; k++) {
      const [f0, r0, x0] = samples[k], [f1, r1, x1] = samples[k + 1];
      if (f >= f0 && f <= f1) {
        const t = f1 > f0 ? (f - f0) / (f1 - f0) : 0;
        return { r: r0 + t * (r1 - r0), i: x0 + t * (x1 - x0) };
      }
    }
    const s = samples[samples.length - 1];
    return { r: s[1], i: s[2] };
  }

  function sweepRange(cfg) {
    let f1 = cfg.band[0] * 1e6, f2 = cfg.band[1] * 1e6;
    for (const s of cfg.samples) { f1 = Math.min(f1, s[0]); f2 = Math.max(f2, s[0]); }
    const span = (cfg.band[1] - cfg.band[0]) * 1e6;
    const mid = (f1 + f2) / 2;
    if (f2 - f1 < span) { f1 = mid - 0.75 * span; f2 = mid + 0.75 * span; }
    return [Math.max(f1, 1e3), Math.max(f2, f1 + 1e3)];
  }

  function evaluate(cfg, chain, n = 201) {
    const [flo, fhi] = sweepRange(cfg);
    const rows = [];
    for (let k = 0; k < n; k++) {
      const f = flo + (fhi - flo) * k / (n - 1);
      const zl = loadAt(cfg.samples, f);
      const z = chainInput(zl, chain, f);
      const m = metrics(z, cfg.z0);
      rows.push({ f, r: z.r, x: z.i, s11: m.s11, vswr: m.vswr, rl: m.rl,
        g_re: m.gamma.r, g_im: m.gamma.i });
    }
    const b1 = cfg.band[0] * 1e6, b2 = cfg.band[1] * 1e6;
    const inb = rows.filter(r => r.f >= b1 - 1 && r.f <= b2 + 1);
    const worst = inb.reduce((a, r) => r.vswr > a.vswr ? r : a, inb[0]);
    return { rows, worstVswr: worst.vswr, worstF: worst.f, flo, fhi };
  }

  // ---- 格式化
  function fmtL(v) {
    const a = Math.abs(v);
    if (a >= 0.1) return v.toPrecision(3) + ' H';
    if (a >= 1e-4) return (v * 1e3).toPrecision(3) + ' mH';
    if (a >= 1e-7) return (v * 1e6).toPrecision(3) + ' µH';
    return (v * 1e9).toPrecision(3) + ' nH';
  }
  function fmtC(v) {
    const a = Math.abs(v);
    if (a >= 1e-3) return v.toPrecision(3) + ' F';
    if (a >= 1e-6) return (v * 1e6).toPrecision(3) + ' µF';
    if (a >= 1e-9) return (v * 1e9).toPrecision(3) + ' nF';
    return (v * 1e12).toPrecision(3) + ' pF';
  }
  function fmtV(v) {
    const a = Math.abs(v);
    if (a >= 1000) return (v / 1000).toPrecision(3) + ' kV';
    if (a >= 1) return v.toPrecision(3) + ' V';
    return (v * 1e3).toPrecision(3) + ' mV';
  }
  function fmtA(v) {
    const a = Math.abs(v);
    if (a >= 1) return v.toPrecision(3) + ' A';
    return (v * 1e3).toPrecision(3) + ' mA';
  }
  function fmtW(v) {
    const a = Math.abs(v);
    if (a >= 1000) return (v / 1000).toPrecision(3) + ' kW';
    if (a >= 1) return v.toPrecision(3) + ' W';
    if (a >= 1e-3) return (v * 1e3).toPrecision(3) + ' mW';
    return (v * 1e6).toPrecision(3) + ' µW';
  }

  const EL_LABEL = {
    Lser: '串联电感', Cser: '串联电容', Lpar: '并联电感', Cpar: '并联电容',
    line: '传输线段', stub: '并联支节',
  };

  return {
    C0, TAU, lineGamma, lineZin, stubY, applyElement, chainInput,
    metrics, parseSamples, loadAt, sweepRange, evaluate, fmtL, fmtC, EL_LABEL,
    elAbcd, waveExtremes, stressAt, elRatio, stressSweep, fmtV, fmtA, fmtW,
  };
})();
