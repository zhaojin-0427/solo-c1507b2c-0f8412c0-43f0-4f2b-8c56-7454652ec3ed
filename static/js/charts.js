/* 扫频曲线: VSWR / 回波损耗 / |S11| / R-X 四个同步面板, 支持点击选点 */
const SweepCharts = (() => {
  const panels = [];
  let onPick = null;
  let domain = { f1: 1, f2: 2, band1: 1, band2: 2 };

  function mount(ids, pickCb) {
    onPick = pickCb;
    const defs = [
      { id: ids[0], key: 'vswr', title: '驻波比 VSWR', color: '#4fa3ff', limit: null, ylabel: '' },
      { id: ids[1], key: 'rl', title: '回波损耗 (dB)', color: '#7ee787', ylabel: '' },
      { id: ids[2], key: 's11', title: '|S11|', color: '#ffd166', ylabel: '' },
      { id: ids[3], key: 'z', title: '输入阻抗 R / X (Ω)', color: '#4fa3ff', dual: true },
    ];
    defs.forEach(d => {
      const cv = document.getElementById(d.id);
      const panel = { ...d, cv, ctx: cv.getContext('2d') };
      cv.addEventListener('click', e => {
        const f = xToF(panel, e);
        if (f != null && onPick) onPick(f);
      });
      cv.addEventListener('mousemove', e => {
        const f = xToF(panel, e);
        if (f != null && onPick) renderCursor(f);
      });
      panels.push(panel);
    });
  }

  function xToF(panel, e) {
    const rect = panel.cv.getBoundingClientRect();
    const x = e.clientX - rect.left;
    setup(panel);
    const { padL, padR } = panel.geom;
    const w = panel.cv.clientWidth - padL - padR;
    if (x < padL || x > padL + w) return null;
    const t = (x - padL) / w;
    return domain.f1 + t * (domain.f2 - domain.f1);
  }

  function setup(panel) {
    const cssW = panel.cv.clientWidth || 460;
    const cssH = panel.cv.clientHeight || 118;
    const dpr = window.devicePixelRatio || 1;
    panel.cv.width = cssW * dpr;
    panel.cv.height = cssH * dpr;
    panel.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    panel.geom = { padL: 46, padR: 12, padT: 16, padB: 16, w: cssW, h: cssH };
  }

  function yRange(panel, series) {
    let lo = Infinity, hi = -Infinity;
    for (const rows of series) {
      for (const r of rows.rows) {
        let v = r[panel.key];
        if (panel.key === 'z') v = r.x;
        if (!isFinite(v)) continue;
        lo = Math.min(lo, v); hi = Math.max(hi, v);
      }
      if (panel.dual) for (const r of rows.rows) { lo = Math.min(lo, r.r); hi = Math.max(hi, r.r); }
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (panel.key === 'vswr') { lo = 1; hi = Math.max(hi, panel.limit || 2); }
    if (panel.key === 's11') { lo = 0; hi = Math.max(hi, 0.1); }
    if (panel.key === 'rl') { hi = Math.max(hi, 10); lo = Math.max(0, Math.min(lo, hi - 5)); }
    if (hi - lo < 1e-9) hi = lo + 1;
    const pad = (hi - lo) * 0.08;
    return [lo - pad, hi + pad];
  }

  function render(data) {
    // data: { main, baseline, overlays:[{rows,color}], pickF, limit }
    const all = [data.main, ...(data.overlays || [])];
    if (data.baseline) all.push(data.baseline);
    domain.f1 = data.main.rows[0].f;
    domain.f2 = data.main.rows[data.main.rows.length - 1].f;
    domain.band1 = data.band1; domain.band2 = data.band2;

    for (const panel of panels) {
      setup(panel);
      const { ctx } = panel;
      const { padL, padR, padT, padB, w, h } = panel.geom;
      const iw = w - padL - padR, ih = h - padT - padB;
      const [yl, yh] = yRange(panel, all);
      panel.scale = { padL, padT, iw, ih, yl, yh };

      ctx.clearRect(0, 0, w, h);
      // 目标频段底纹
      ctx.fillStyle = '#1d2b3d55';
      const bx0 = padL + f2x(domain.band1) * iw;
      const bx1 = padL + f2x(domain.band2) * iw;
      ctx.fillRect(bx0, padT, Math.max(1, bx1 - bx0), ih);

      // 网格 + y 刻度
      ctx.strokeStyle = '#26323f'; ctx.fillStyle = '#74869c';
      ctx.font = '9px monospace'; ctx.textAlign = 'right'; ctx.lineWidth = 1;
      const N = 4;
      for (let k = 0; k <= N; k++) {
        const v = yl + (yh - yl) * k / N;
        const y = padT + ih - k / N * ih;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + iw, y); ctx.stroke();
        ctx.fillText(fmtTick(v), padL - 4, y + 3);
      }
      // x 频率刻度
      ctx.textAlign = 'center';
      for (let k = 0; k <= 4; k++) {
        const f = domain.f1 + (domain.f2 - domain.f1) * k / 4;
        const x = padL + k / 4 * iw;
        ctx.fillText((f / 1e6).toFixed(2), x, h - 4);
      }
      // 标题
      ctx.textAlign = 'left'; ctx.fillStyle = '#9fb0c6'; ctx.font = '10px sans-serif';
      ctx.fillText(panel.title, padL + 2, 11);

      // VSWR 限制线
      if (panel.key === 'vswr' && data.limit) {
        const y = padT + ih * (1 - (data.limit - yl) / (yh - yl));
        ctx.strokeStyle = '#ff5c5caa'; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + iw, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#ff8f8f'; ctx.textAlign = 'right';
        ctx.fillText('≤' + data.limit, padL + iw - 2, y - 3);
      }

      const drawOne = (bundle, key, color, width) => {
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
        bundle.rows.forEach((r, k) => {
          const v = key === 'xline' ? r.x : (panel.dual && key === 'z' ? r.r : r[key]);
          const x = padL + f2x(r.f) * iw;
          const y = padT + ih * (1 - (v - yl) / (yh - yl));
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
      };

      if (data.baseline) {
        drawOne(data.baseline, panel.key, '#ffd166', 1);
        if (panel.dual) drawOne(data.baseline, 'xline', '#ffd16688', 1);
      }
      for (const ov of data.overlays || []) {
        drawOne(ov, panel.key, ov.color || '#ff6b9d', 1.1);
        if (panel.dual) drawOne(ov, 'xline', (ov.color || '#ff6b9d') + '88', 1);
      }
      drawOne(data.main, panel.key, panel.color, 1.8);
      if (panel.dual) drawOne(data.main, 'xline', '#9cc5ff', 1.2);

      // 选点竖线 + 圆点
      if (data.pickF != null) {
        const x = padL + f2x(data.pickF) * iw;
        ctx.strokeStyle = '#7ee787'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ih); ctx.stroke();
        ctx.setLineDash([]);
        const r = nearestRow(data.main.rows, data.pickF);
        if (r) {
          const v = panel.key === 'z' ? r.r : r[panel.key];
          const y = padT + ih * (1 - (v - yl) / (yh - yl));
          ctx.fillStyle = '#7ee787';
          ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 7); ctx.fill();
        }
      }
    }
  }

  function f2x(f) {
    return (f - domain.f1) / (domain.f2 - domain.f1);
  }

  function renderCursor(f) {
    panels[0]._cursorF = f; // 仅 hover, 不强制重绘全部(保持简单: 交 app 节流重绘)
  }

  function nearestRow(rows, f) {
    let best = rows[0];
    for (const r of rows) if (Math.abs(r.f - f) < Math.abs(best.f - f)) best = r;
    return best;
  }

  function fmtTick(v) {
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    if (Math.abs(v) >= 10) return v.toFixed(0);
    if (Math.abs(v) >= 1) return v.toFixed(1);
    return v.toFixed(2);
  }

  return { mount, render, nearestRow };
})();
