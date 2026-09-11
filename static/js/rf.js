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

  const EL_LABEL = {
    Lser: '串联电感', Cser: '串联电容', Lpar: '并联电感', Cpar: '并联电容',
    line: '传输线段', stub: '并联支节',
  };

  return {
    C0, TAU, lineGamma, lineZin, stubY, applyElement, chainInput,
    metrics, parseSamples, loadAt, sweepRange, evaluate, fmtL, fmtC, EL_LABEL,
  };
})();
