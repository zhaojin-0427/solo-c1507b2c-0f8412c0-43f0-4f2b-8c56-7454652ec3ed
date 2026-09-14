/* 测量校准工作区 —— OSL 校准组管理 / 待测件修正 / 误差曲线 / 负载采样生成 */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  const smith = createSmithChart();
  const STD_LABEL = { open: '开路', short: '短路', load: '负载' };

  const ms = {
    kits: [], kitId: null, kit: null,   // kit: GET /api/calkits/<id> 详情
    solve: null,                        // 求解预览 (草稿) 或冻结求解 (已采用)
    result: null,                       // /api/meas/correct 响应
    pickF: null,
  };

  // ------------------------------------------------------------ 通用
  async function api(path, method, payload) {
    let resp, text;
    try {
      resp = await fetch(path, {
        method,
        headers: payload ? { 'Content-Type': 'application/json' } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
      });
      text = await resp.text();
    } catch (e) {
      throw new Error('无法连接计算服务: ' + e.message);
    }
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { /* HTML 错误页 */ }
    if (!resp.ok || !data) {
      const err = new Error((data && data.error) || `服务错误 ${resp.status}`);
      err.data = data;
      throw err;
    }
    if (data.error) { const err = new Error(data.error); err.data = data; throw err; }
    return data;
  }

  const esc = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtMHz = (f, d = 4) => (f / 1e6).toFixed(d);
  const cfmt = (c, d = 4) => `${c[0].toFixed(d)}${c[1] >= 0 ? '+' : ''}${c[1].toFixed(d)}j`;
  const cmag = c => Math.hypot(c[0], c[1]);
  const cang = c => (Math.atan2(c[1], c[0]) * 180 / Math.PI).toFixed(1);
  const magDb = c => (20 * Math.log10(Math.max(cmag(c), 1e-12))).toFixed(1);
  const zfmt = z => `${z[0].toFixed(2)}${z[1] >= 0 ? '+' : ''}${z[1].toFixed(2)}j Ω`;

  function diagHTML(diags) {
    if (!diags || !diags.length) return '<div class="hint">无诊断信息 ✓</div>';
    const icon = { error: '✗', warn: '⚠', info: 'ℹ' };
    return diags.map(d =>
      `<div class="diag-row d-${d.level}">${icon[d.level] || 'ℹ'} ${esc(d.msg)}</div>`).join('');
  }

  // ------------------------------------------------------------ 校准组列表 / 详情
  async function loadKits(keepSel) {
    ms.kits = await api('/api/calkits', 'GET');
    const sel = $('#calKitSel');
    sel.innerHTML = '<option value="">— 选择校准组 —</option>' + ms.kits.map(k => {
      const tag = k.status === 'adopted'
        ? (k.residual_ok ? '已采用✓' : '已采用(残差超限)') : '草稿';
      return `<option value="${k.id}" ${k.id === ms.kitId ? 'selected' : ''}>` +
        `#${k.id} ${esc(k.name)} · ${tag} · ${k.n_sweeps}扫线</option>`;
    }).join('');
    if (!keepSel && !ms.kits.some(k => k.id === ms.kitId)) {
      ms.kitId = null; ms.kit = null; ms.solve = null;
      renderKitDetail();
    }
  }

  async function loadKit(id) {
    ms.kitId = id;
    ms.kit = id ? await api('/api/calkits/' + id, 'GET') : null;
    ms.solve = null;
    ms.result = null;
    ms.pickF = null;
    renderKitDetail();
    renderResult();
    if (ms.kit) await solvePreview(true);   // 已采用取冻结解, 草稿做静默预览
  }

  function renderKitDetail() {
    const k = ms.kit;
    const st = $('#calKitStatus');
    const adopted = k && k.status === 'adopted';
    st.textContent = k ? (adopted ? '已采用 · 不可改写' : '草稿') : '';
    st.className = 'cal-status ' + (k ? (adopted ? 'cs-adopted' : 'cs-draft') : '');
    $('#calKitName').value = k ? k.name : '';
    $('#calKitZ0').value = k ? k.z0 : 50;
    standardsToForm(k ? k.standards : null);
    // 草稿可编辑, 采用后全部锁定
    ['#calKitName', '#calKitZ0', '#btnSaveKit', '#btnAdoptKit', '#btnAddSweep',
     '#btnSweepFile', '#sweepStd', '#sweepFmt', '#sweepUnit', '#sweepLabel', '#sweepText']
      .forEach(s => { $(s).disabled = !k || adopted; });
    $$('#cardStandards input').forEach(i => { i.disabled = !k || adopted; });
    $('#btnDelKit').disabled = !k || adopted;
    $('#calSolutionInfo').innerHTML = k && k.solution
      ? `求解于 ${new Date(k.solution.solved_at * 1000).toLocaleString()} · ` +
        `${k.solution.n_points} 共同频点 · ${fmtMHz(k.solution.f_range[0])}~${fmtMHz(k.solution.f_range[1])} MHz · ` +
        `残差RMS <b class="${k.solution.residual_ok ? 'pass-ok' : 'pass-bad'}">${k.solution.rms_global.toFixed(4)}</b>` +
        ` · 摘要哈希 ${k.solution.digest.slice(0, 12)}…`
      : (k ? '尚未求解/采用 — 添加扫线后「求解校验」, 通过后「采用校准组」冻结。' : '');
    renderSweeps();
    if (k && k.solution) $('#calDiagBox').innerHTML = diagHTML(k.solution.diagnostics);
    else if (!ms.solve) $('#calDiagBox').innerHTML = '';
  }

  function renderSweeps() {
    const box = $('#sweepList');
    const k = ms.kit;
    if (!k || !k.sweeps || !k.sweeps.length) {
      box.innerHTML = '<div class="hint">尚无扫线 — 每件标准件至少 1 组, 建议 ≥2 组。</div>';
      return;
    }
    const adopted = k.status === 'adopted';
    box.innerHTML = k.sweeps.map(s =>
      `<div class="sweep-row">
        <span class="sw-std sw-${s.standard}">${STD_LABEL[s.standard] || s.standard}</span>
        <span class="sw-lab" title="${esc(s.label || '')}">${esc(s.label || '扫线#' + s.id)}</span>
        <span class="sw-info">${s.n}点 · ${fmtMHz(s.f_lo, 3)}~${fmtMHz(s.f_hi, 3)}M</span>
        ${adopted ? '' : `<span class="sw-del" data-sid="${s.id}" title="删除该扫线">✕</span>`}
      </div>`).join('');
    box.querySelectorAll('.sw-del').forEach(el => el.addEventListener('click', async () => {
      if (!confirm('删除该扫线?')) return;
      await api(`/api/calkits/${ms.kitId}/sweeps/${el.dataset.sid}`, 'DELETE');
      await loadKit(ms.kitId);
    }));
  }

  // ------------------------------------------------------------ 标准件表单 (UI 单位 ↔ SI)
  function standardsToForm(std) {
    const s = std || {};
    const set = (id, v) => { $(id).value = (v == null) ? '' : +Number(v).toPrecision(9); };
    set('#stdOpenC', s.open ? s.open.c * 1e12 : 0);
    set('#stdOpenDelay', s.open ? s.open.delay * 1e12 : 0);
    set('#stdOpenLoss', s.open ? s.open.loss : 0);
    set('#stdOpenLossF', s.open ? s.open.loss_f / 1e6 : 1000);
    set('#stdShortL', s.short ? s.short.l * 1e9 : 0);
    set('#stdShortDelay', s.short ? s.short.delay * 1e12 : 0);
    set('#stdShortLoss', s.short ? s.short.loss : 0);
    set('#stdShortLossF', s.short ? s.short.loss_f / 1e6 : 1000);
    set('#stdLoadR', s.load ? s.load.r : 50);
    set('#stdLoadDelay', s.load ? s.load.delay * 1e12 : 0);
    set('#stdLoadLoss', s.load ? s.load.loss : 0);
    set('#stdLoadLossF', s.load ? s.load.loss_f / 1e6 : 1000);
  }

  function standardsFromForm() {
    const num = id => { const v = parseFloat($(id).value); return isFinite(v) ? v : 0; };
    return {
      open: { c: num('#stdOpenC') * 1e-12, delay: num('#stdOpenDelay') * 1e-12,
              loss: num('#stdOpenLoss'), loss_f: Math.max(num('#stdOpenLossF'), 1e-3) * 1e6 },
      short: { l: num('#stdShortL') * 1e-9, delay: num('#stdShortDelay') * 1e-12,
               loss: num('#stdShortLoss'), loss_f: Math.max(num('#stdShortLossF'), 1e-3) * 1e6 },
      load: { r: Math.max(num('#stdLoadR'), 1e-6), delay: num('#stdLoadDelay') * 1e-12,
              loss: num('#stdLoadLoss'), loss_f: Math.max(num('#stdLoadLossF'), 1e-3) * 1e6 },
    };
  }

  async function saveDraft() {
    if (!ms.kitId) return;
    await api('/api/calkits/' + ms.kitId, 'PUT', {
      name: $('#calKitName').value, z0: +$('#calKitZ0').value,
      standards: standardsFromForm(),
    });
    await loadKit(ms.kitId);
    loadKits(true);
  }

  async function solvePreview(silent) {
    if (!ms.kitId) return;
    try {
      ms.solve = await api(`/api/calkits/${ms.kitId}/solve`, 'POST', {});
      if (!ms.kit.solution) $('#calDiagBox').innerHTML = diagHTML(ms.solve.diagnostics);
      $('#measDiagBox').innerHTML = diagHTML(ms.solve.diagnostics);
      drawCharts();
      if (!silent && ms.solve.ok) {
        $('#calSolutionInfo').innerHTML =
          `试算: ${ms.solve.n_points} 共同频点 · ${fmtMHz(ms.solve.f_range[0])}~${fmtMHz(ms.solve.f_range[1])} MHz · ` +
          `残差RMS <b class="${ms.solve.residual_ok ? 'pass-ok' : 'pass-bad'}">${ms.solve.rms_global.toFixed(4)}</b>` +
          (ms.solve.residual_ok ? ' · 残差检查通过, 可采用' : ' · 残差超限, 请检查扫线');
      }
    } catch (e) {
      $('#calDiagBox').innerHTML = `<div class="diag-row d-error">✗ ${esc(e.message)}</div>`;
    }
  }

  async function adoptKit() {
    if (!ms.kitId) return;
    if (!confirm('采用后校准组冻结, 不可改写。确认采用?')) return;
    try {
      await api(`/api/calkits/${ms.kitId}/adopt`, 'POST', {});
    } catch (e) {
      $('#calDiagBox').innerHTML = `<div class="diag-row d-error">✗ ${esc(e.message)}</div>` +
        (e.data && e.data.diagnostics ? diagHTML(e.data.diagnostics) : '');
      return;
    }
    await loadKit(ms.kitId);
    loadKits(true);
  }

  // ------------------------------------------------------------ 扫线添加
  async function addSweep() {
    if (!ms.kitId) { alert('请先选择/新建校准组'); return; }
    const text = $('#sweepText').value;
    if (!text.trim()) { alert('请先粘贴扫线数据'); return; }
    try {
      const r = await api(`/api/calkits/${ms.kitId}/sweeps`, 'POST', {
        standard: $('#sweepStd').value, fmt: $('#sweepFmt').value,
        unit: $('#sweepUnit').value, label: $('#sweepLabel').value, text,
      });
      $('#sweepInfo').innerHTML = `已添加 ${r.n} 点` +
        (r.warns && r.warns.length ? `<br><span class="pass-bad">⚠ ${esc(r.warns.join(' ⚠ '))}</span>` : '');
      $('#sweepText').value = '';
      $('#sweepLabel').value = '';
      await loadKit(ms.kitId);
    } catch (e) {
      $('#sweepInfo').innerHTML = `<span class="pass-bad">✗ ${esc(e.message)}</span>`;
    }
  }

  function readFileInto(input, textarea, done) {
    const f = input.files && input.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { textarea.value = String(rd.result || ''); if (done) done(); };
    rd.readAsText(f);
    input.value = '';
  }

  // ------------------------------------------------------------ 待测件修正
  async function runCorrect() {
    if (!ms.kitId) { alert('请先选择校准组'); return; }
    if (ms.kit && ms.kit.status !== 'adopted') {
      $('#dutInfo').innerHTML = '<span class="pass-bad">✗ 校准组仍为草稿, 请先「采用」</span>';
      return;
    }
    const text = $('#dutText').value;
    if (!text.trim()) { alert('请先粘贴待测件数据'); return; }
    $('#dutInfo').textContent = '校正计算中…';
    try {
      ms.result = await api('/api/meas/correct', 'POST', {
        kit_id: ms.kitId, text, fmt: $('#dutFmt').value, unit: $('#dutUnit').value,
      });
    } catch (e) {
      ms.result = null;
      $('#dutInfo').innerHTML = `<span class="pass-bad">✗ ${esc(e.message)}</span>`;
      renderResult();
      return;
    }
    ms.pickF = null;
    $('#dutInfo').textContent =
      `${ms.result.rows.length} 点已修正` + (ms.result.dropped ? ` · 丢弃 ${ms.result.dropped} 点` : '');
    renderResult();
  }

  function renderResult() {
    drawMeasSmith();
    drawCharts();
    renderPoint();
    renderGate();
    const r = ms.result;
    $('#measDiagBox').innerHTML = r && r.diagnostics.length
      ? diagHTML(r.diagnostics)
      : (ms.solve ? diagHTML(ms.solve.diagnostics) : '<div class="hint">无诊断信息 ✓</div>');
    $('#measSmithInfo').textContent = r
      ? `校准组 #${r.kit.id} ${r.kit.name} · ${fmtMHz(r.rows[0].f, 3)}~${fmtMHz(r.rows[r.rows.length - 1].f, 3)} MHz`
      : '';
  }

  // ------------------------------------------------------------ 史密斯图
  function drawMeasSmith() {
    const r = ms.result;
    if (!r) {
      smith.render({ current: null, baseline: null, overlays: null, steps: null, z0: 50, endDot: null });
      return;
    }
    const raw = r.rows.map(p => ({ g_re: p.gr[0], g_im: p.gr[1] }));
    const cal = r.rows.map(p => ({ g_re: p.gc[0], g_im: p.gc[1] }));
    let endDot = null;
    if (ms.pickF != null) {
      const row = nearestRow(r.rows, ms.pickF);
      if (row) endDot = { g_re: row.gc[0], g_im: row.gc[1] };
    }
    smith.render({ current: cal, baseline: raw, overlays: null, steps: null,
                   z0: r.z0, endDot });
  }

  function nearestRow(rows, f) {
    let best = rows[0];
    for (const r of rows) if (Math.abs(r.f - f) < Math.abs(best.f - f)) best = r;
    return best;
  }

  // ------------------------------------------------------------ 误差曲线
  const chartGeom = new Map();

  function drawChart(cv, cfg) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = cv.clientWidth || 460, cssH = cv.clientHeight || 118;
    if (cssW < 20) return;
    cv.width = cssW * dpr; cv.height = cssH * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const padL = 46, padR = 12, padT = 16, padB = 16;
    const iw = cssW - padL - padR, ih = cssH - padT - padB;
    let lo = Infinity, hi = -Infinity;
    for (const s of cfg.series) for (const v of s.ys) {
      if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
    for (const h of cfg.hlines || []) { lo = Math.min(lo, h.y); hi = Math.max(hi, h.y); }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) hi = lo + 1;
    const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
    if (cfg.yMin != null) lo = Math.min(lo, cfg.yMin);
    const { f1, f2 } = cfg;
    chartGeom.set(cv.id, { f1, f2, padL, padR, w: cssW });
    ctx.clearRect(0, 0, cssW, cssH);
    // 网格 + y 刻度
    ctx.strokeStyle = '#26323f'; ctx.fillStyle = '#74869c';
    ctx.font = '9px monospace'; ctx.textAlign = 'right'; ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const v = lo + (hi - lo) * k / 4;
      const y = padT + ih - k / 4 * ih;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + iw, y); ctx.stroke();
      ctx.fillText(cfg.fmtY ? cfg.fmtY(v) : v.toFixed(2), padL - 4, y + 3);
    }
    ctx.textAlign = 'center';
    for (let k = 0; k <= 4; k++) {
      const f = f1 + (f2 - f1) * k / 4;
      ctx.fillText((f / 1e6).toFixed(2), padL + k / 4 * iw, cssH - 4);
    }
    ctx.textAlign = 'left'; ctx.fillStyle = '#9fb0c6'; ctx.font = '10px sans-serif';
    ctx.fillText(cfg.title, padL + 2, 11);
    // 水平参考线
    for (const h of cfg.hlines || []) {
      const y = padT + ih * (1 - (h.y - lo) / (hi - lo));
      ctx.strokeStyle = h.color; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + iw, y); ctx.stroke();
      ctx.setLineDash([]);
      if (h.label) {
        ctx.fillStyle = h.color; ctx.textAlign = 'right'; ctx.font = '9px sans-serif';
        ctx.fillText(h.label, padL + iw - 2, y - 3);
      }
    }
    // 折线
    for (const s of cfg.series) {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.2;
      if (s.dash) ctx.setLineDash(s.dash);
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k < s.xs.length; k++) {
        const v = s.ys[k];
        if (!isFinite(v)) { pen = false; continue; }
        const x = padL + (s.xs[k] - f1) / (f2 - f1) * iw;
        const y = padT + ih * (1 - (v - lo) / (hi - lo));
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // 选点竖线
    if (cfg.pickF != null) {
      const x = padL + (cfg.pickF - f1) / (f2 - f1) * iw;
      ctx.strokeStyle = '#7ee787'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ih); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function coefSeries() {
    // 系数曲线数据: 优先待测件修正结果 (对齐 DUT 频点), 否则用校准组求解网格
    if (ms.result) {
      const rows = ms.result.rows;
      return {
        f1: rows[0].f, f2: rows[rows.length - 1].f,
        xs: rows.map(r => r.f),
        ed: rows.map(r => cmag(r.ed)), es: rows.map(r => cmag(r.es)),
        er: rows.map(r => cmag(r.er)),
        dg: rows.map(r => Math.hypot(r.gc[0] - r.gr[0], r.gc[1] - r.gr[1])),
        rms: rows.map(r => r.rms),
      };
    }
    if (ms.solve && ms.solve.ok) {
      const s = ms.solve;
      return {
        f1: s.freqs[0], f2: s.freqs[s.freqs.length - 1], xs: s.freqs,
        ed: s.ed.map(cmag), es: s.es.map(cmag), er: s.er.map(cmag),
        dg: null, rms: s.rms,
      };
    }
    return null;
  }

  function drawCharts() {
    const d = coefSeries();
    const cv1 = $('#chartCoef'), cv2 = $('#chartCorr');
    if (!d) {
      [cv1, cv2].forEach(cv => {
        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, cv.width, cv.height);
      });
      return;
    }
    const db = a => a.map(v => 20 * Math.log10(Math.max(v, 1e-6)));
    drawChart(cv1, {
      title: '误差系数幅值 (dB)', f1: d.f1, f2: d.f2, pickF: ms.pickF,
      fmtY: v => v.toFixed(0),
      series: [
        { xs: d.xs, ys: db(d.ed), color: '#4fa3ff' },
        { xs: d.xs, ys: db(d.es), color: '#ff6b9d' },
        { xs: d.xs, ys: db(d.er), color: '#7ee787' },
      ],
    });
    const series2 = [{ xs: d.xs, ys: d.rms, color: '#ff9e64', width: 1.4 }];
    if (d.dg) series2.unshift({ xs: d.xs, ys: d.dg, color: '#ffd166', width: 1.4 });
    const limit = ms.result ? ms.result.residual_limit
      : (ms.solve ? ms.solve.residual_limit : 0.02);
    drawChart(cv2, {
      title: d.dg ? '修正量 |ΔΓ| 与 标准件残差RMS' : '标准件残差RMS (按频点)',
      f1: d.f1, f2: d.f2, pickF: ms.pickF, yMin: 0,
      fmtY: v => v.toFixed(3),
      hlines: [{ y: limit, color: '#ff5c5caa', label: '门限' }],
      series: series2,
    });
  }

  // ------------------------------------------------------------ 频点详情
  function selectPoint(f) {
    ms.pickF = f;
    drawMeasSmith();
    drawCharts();
    renderPoint();
  }

  function renderPoint() {
    const box = $('#measPointBox');
    const info = $('#measPointInfo');
    if (ms.pickF == null) {
      box.innerHTML = '<div class="hint">校正计算后, 点选频点查看三项误差系数 / 标准件残差 / 修正前后阻抗。</div>';
      info.textContent = '在史密斯图或误差曲线上点选频点';
      return;
    }
    if (ms.result) {
      const r = nearestRow(ms.result.rows, ms.pickF);
      info.textContent = `@ ${fmtMHz(r.f)} MHz`;
      box.innerHTML = `
        <div class="pt-grid">
          <div class="pt-sec"><div class="pt-title">修正前</div>
            <div>Γ = ${cfmt(r.gr)} <span class="hint">|Γ|=${cmag(r.gr).toFixed(3)} ∠${cang(r.gr)}°</span></div>
            <div>Z = <b>${zfmt(r.zr)}</b></div></div>
          <div class="pt-sec"><div class="pt-title">修正后</div>
            <div>Γ = ${cfmt(r.gc)} <span class="hint">|Γ|=${cmag(r.gc).toFixed(3)} ∠${cang(r.gc)}°</span></div>
            <div>Z = <b class="pass-ok">${zfmt(r.zc)}</b></div></div>
          <div class="pt-sec"><div class="pt-title">三项误差系数</div>
            <div>ed 方向性 = ${cfmt(r.ed)} <span class="hint">${magDb(r.ed)} dB</span></div>
            <div>es 源匹配 = ${cfmt(r.es)} <span class="hint">${magDb(r.es)} dB</span></div>
            <div>er 反射跟踪 = ${cfmt(r.er)} <span class="hint">${magDb(r.er)} dB</span></div></div>
          <div class="pt-sec"><div class="pt-title">标准件残差 / 方程状态</div>
            <div>开路 ${r.std.open.toFixed(4)} · 短路 ${r.std.short.toFixed(4)} · 负载 ${r.std.load.toFixed(4)}</div>
            <div>残差RMS ${r.rms.toFixed(4)} · 条件数 ${r.cond.toExponential(2)}</div></div>
        </div>`;
      return;
    }
    if (ms.solve && ms.solve.ok) {
      const s = ms.solve;
      let bi = 0;
      s.freqs.forEach((f, i) => { if (Math.abs(f - ms.pickF) < Math.abs(s.freqs[bi] - ms.pickF)) bi = i; });
      info.textContent = `@ ${fmtMHz(s.freqs[bi])} MHz (校准组求解网格)`;
      box.innerHTML = `
        <div class="pt-grid">
          <div class="pt-sec"><div class="pt-title">三项误差系数</div>
            <div>ed 方向性 = ${cfmt(s.ed[bi])} <span class="hint">${magDb(s.ed[bi])} dB</span></div>
            <div>es 源匹配 = ${cfmt(s.es[bi])} <span class="hint">${magDb(s.es[bi])} dB</span></div>
            <div>er 反射跟踪 = ${cfmt(s.er[bi])} <span class="hint">${magDb(s.er[bi])} dB</span></div></div>
          <div class="pt-sec"><div class="pt-title">标准件残差 / 方程状态</div>
            <div>开路 ${s.std_res.open[bi].toFixed(4)} · 短路 ${s.std_res.short[bi].toFixed(4)} · 负载 ${s.std_res.load[bi].toFixed(4)}</div>
            <div>残差RMS ${s.rms[bi].toFixed(4)} · 条件数 ${s.cond[bi].toExponential(2)}</div></div>
        </div>`;
      return;
    }
    box.innerHTML = '<div class="hint">请先选择校准组并校正计算。</div>';
  }

  // ------------------------------------------------------------ 残差门 / 生成采样
  function renderGate() {
    const gate = $('#measGate');
    const btn = $('#btnToSamples');
    const r = ms.result;
    if (!r) {
      gate.innerHTML = '<div class="hint">校正计算并通过残差检查后可生成负载采样。</div>';
      btn.disabled = true;
      $('#measHash').textContent = '';
      return;
    }
    const lim = r.residual_limit;
    if (r.residual_ok) {
      gate.innerHTML = `<div class="gate-ok">✓ 残差检查通过 · 整体RMS ${r.rms_global.toFixed(4)} ≤ 门限 ${lim}</div>`;
      btn.disabled = false;
    } else {
      gate.innerHTML = `<div class="gate-bad">✗ 残差检查未通过 · 整体RMS ${(r.rms_global || 0).toFixed(4)} > 门限 ${lim} — 禁止生成负载采样, 请检查校准组扫线</div>`;
      btn.disabled = true;
    }
    $('#measHash').textContent =
      `来源: 校准组 #${r.kit.id} ${r.kit.name} · 输入哈希 ${r.input_hash.slice(0, 16)}…`;
  }

  function toSamples() {
    const r = ms.result;
    if (!r || !r.residual_ok) return;
    const header = `# OSL修正负载采样 · 校准组#${r.kit.id} ${r.kit.name} · 哈希${r.input_hash.slice(0, 12)}\n` +
      '# f(MHz) R(Ω) X(Ω)';
    const body = r.rows.map(p =>
      `${(p.f / 1e6).toFixed(6)} ${p.zc[0].toFixed(3)} ${p.zc[1].toFixed(3)}`).join('\n');
    window.RFMatch.applyMeasSamples(header + '\n' + body, {
      kitId: r.kit.id, kitName: r.kit.name,
      inputHash: r.input_hash, nPoints: r.rows.length,
      rms: r.rms_global,
    });
  }

  // ------------------------------------------------------------ 事件绑定
  function bind() {
    smith.mount($('#measSmith'));
    $('#calKitSel').addEventListener('change', e => {
      const id = +e.target.value || null;
      if (id) loadKit(id).catch(err => alert(err.message));
    });
    $('#btnNewKit').addEventListener('click', async () => {
      const name = prompt('校准组名称', 'OSL 校准组 ' + new Date().toLocaleDateString());
      if (name == null) return;
      const r = await api('/api/calkits', 'POST', { name, z0: 50, standards: null });
      await loadKits();
      await loadKit(r.id);
    });
    $('#btnDelKit').addEventListener('click', async () => {
      if (!ms.kitId || !confirm('删除该校准组及其全部扫线?')) return;
      try { await api('/api/calkits/' + ms.kitId, 'DELETE'); }
      catch (e) { alert(e.message); return; }
      ms.kitId = null; ms.kit = null; ms.solve = null; ms.result = null;
      await loadKits();
      renderKitDetail();
      renderResult();
    });
    $('#btnSaveKit').addEventListener('click', () =>
      saveDraft().catch(e => alert(e.message)));
    $('#btnSolveKit').addEventListener('click', () => solvePreview(false));
    $('#btnAdoptKit').addEventListener('click', adoptKit);
    $('#btnAddSweep').addEventListener('click', addSweep);
    $('#btnSweepFile').addEventListener('click', () => $('#sweepFile').click());
    $('#sweepFile').addEventListener('change', () =>
      readFileInto($('#sweepFile'), $('#sweepText')));
    $('#btnDutFile').addEventListener('click', () => $('#dutFile').click());
    $('#dutFile').addEventListener('change', () =>
      readFileInto($('#dutFile'), $('#dutText')));
    $('#btnCorrect').addEventListener('click', runCorrect);
    $('#btnToSamples').addEventListener('click', toSamples);

    // 史密斯图点选: 反解最近频点
    $('#measSmith').addEventListener('click', ev => {
      if (!ms.result) return;
      const g = smith.pickGamma(ev);
      let best = null, bd = 1e9;
      for (const r of ms.result.rows) {
        const d = (r.gc[0] - g.r) ** 2 + (r.gc[1] - g.i) ** 2;
        if (d < bd) { bd = d; best = r; }
      }
      if (best && bd < 0.04) selectPoint(best.f);
    });
    // 误差曲线点选
    ['chartCoef', 'chartCorr'].forEach(id => {
      $('#' + id).addEventListener('click', ev => {
        const gm = chartGeom.get(id);
        if (!gm) return;
        const rect = ev.target.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const iw = gm.w - gm.padL - gm.padR;
        if (x < gm.padL || x > gm.padL + iw) return;
        selectPoint(gm.f1 + (x - gm.padL) / iw * (gm.f2 - gm.f1));
      });
    });
    // 切到测量校准工作区时刷新列表与画布
    $('#tabMeas').addEventListener('click', () => {
      loadKits(true);
      requestAnimationFrame(() => { drawMeasSmith(); drawCharts(); });
    });
    window.addEventListener('resize', () => {
      if (!$('#measLayout').classList.contains('hidden')) {
        drawMeasSmith(); drawCharts();
      }
    });
  }

  bind();
  loadKits();
})();
