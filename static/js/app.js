/* 射频匹配推演台 主逻辑 */
(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const uid = (p = 'e') => p + Math.random().toString(36).slice(2, 9);

  // ------------------------------------------------------------ 默认数据
  const DEFAULT_SAMPLES =
    'f(MHz) R(Ω) X(Ω)\n' +
    '14.000 36.2 -28.5\n14.050 37.0 -26.1\n14.100 38.4 -23.0\n' +
    '14.150 40.1 -19.2\n14.200 42.6 -14.0\n14.250 46.0  -8.0\n' +
    '14.300 50.5  -0.8\n14.350 56.6   7.6\n14.400 64.5  17.8';

  const state = {
    samplesText: DEFAULT_SAMPLES,
    samples: [],
    cfg: { z0: 50, band: [14.0, 14.4], vswr_limit: 1.5, eseries: 'E24', plane: 'load', min_margin: 0.2 },
    feed: { z0: 50, length: 12.0, vf: 0.66, loss: 1.2, lossf: 10, vmax: null, imax: null, pmax: null },
    power: { p_w: 100, par_db: 0, duty: 1.0 },   // 发射功率W / 峰均比dB / 占空比(0..1)
    chain: [],            // 用户元件 (不含主馈线)
    feedEnabled: true,
    baselineRows: null,
    candidates: [],
    activeCand: null,
    overlays: new Set(),
    locks: new Set(),
    rateOpen: new Set(),  // 展开额定编辑的元件 uid
    stress: null,         // 最近一次应力扫描结果
    pickF: null,
    traceSteps: null,
    projectId: null,
    projectName: '未命名项目',
  };

  const MAINLINE_UID = 'mainline';
  const RATE_LABEL = { vmax: '耐压', imax: '电流', pmax: '热功率' };
  const STRESS_COLORS = ['#4fa3ff', '#ff6b9d', '#7ee787', '#ffd166', '#c792ea', '#ff9e64', '#9cc5ff', '#f2a0a0'];

  // ------------------------------------------------------------ 元件工厂
  function newElement(kind) {
    const base = uid();
    const fd = feedSpec();
    if (kind === 'Lser') return { kind, uid: base, value: 1.2e-6 };
    if (kind === 'Cser') return { kind, uid: base, value: 220e-12 };
    if (kind === 'Lpar') return { kind, uid: base, value: 0.56e-6 };
    if (kind === 'Cpar') return { kind, uid: base, value: 100e-12 };
    if (kind === 'line')
      return { kind: 'line', uid: base, z0: fd.z0, length: 2.0, vf: fd.vf, loss: fd.loss, lossf: fd.lossf * 1e6 };
    if (kind === 'stub')
      return { kind: 'stub', uid: base, z0: fd.z0, length: 1.0, vf: fd.vf, loss: fd.loss,
               lossf: fd.lossf * 1e6, terminal: 'short' };
    return null;
  }

  function feedSpec() {
    const el = { kind: 'line', uid: MAINLINE_UID, z0: +state.feed.z0, length: +state.feed.length,
             vf: +state.feed.vf, loss: +state.feed.loss, lossf: +state.feed.lossf * 1e6, main: true };
    for (const k of ['vmax', 'imax', 'pmax'])
      if (state.feed[k] != null && state.feed[k] > 0) el[k] = +state.feed[k];
    return el;
  }

  // 有效计算链 = 主馈线 + 用户元件, 顺序按 place: 'before' 在馈线负载侧, 'after'(默认) 在源侧
  function effectiveChain() {
    const before = [], after = [];
    for (const e of state.chain) (e.place === 'before' ? before : after).push({ ...e });
    const out = [...before];
    if (state.feedEnabled && state.feed.length > 0) out.push(feedSpec());
    out.push(...after);
    return out;
  }

  function feedCfg() {
    return { z0: +state.feed.z0, length: +state.feed.length, vf: +state.feed.vf,
             loss: +state.feed.loss, lossf: +state.feed.lossf * 1e6 };
  }

  function cfgPayload(extra = {}) {
    return {
      z0: state.cfg.z0, band: state.cfg.band, vswr_limit: state.cfg.vswr_limit,
      eseries: state.cfg.eseries, plane: state.cfg.plane,
      samples_text: state.samplesText, feed_enabled: state.feedEnabled,
      feed: state.feed, chain: effectiveChain(),
      power: { p_w: state.power.p_w, par_db: state.power.par_db, duty: state.power.duty },
      min_margin: state.cfg.min_margin,
      ...extra,
    };
  }

  // 统一后端 POST: 任何非 JSON / 非 200 / 网络错误都抛带中文说明的 Error
  async function apiPost(path, payload) {
    let resp, text;
    try {
      resp = await fetch(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      text = await resp.text();
    } catch (e) {
      throw new Error('无法连接计算服务: ' + e.message);
    }
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { /* HTML 错误页 */ }
    if (!resp.ok || !data) {
      throw new Error(`服务错误 ${resp.status}: ${(data && data.error) ? data.error : '计算失败, 请检查输入'}`);
    }
    if (data.error) throw new Error(data.error);
    return data;
  }

  // ------------------------------------------------------------ 重算管线
  let recomputeQueued = false;
  function scheduleRecompute() {
    if (recomputeQueued) return;
    recomputeQueued = true;
    requestAnimationFrame(() => { recomputeQueued = false; recompute(); });
  }

  function recompute() {
    state.samples = RF.parseSamples(state.samplesText);
    $('#samplesInfo').textContent = state.samples.length
      ? `已解析 ${state.samples.length} 点 · ${fmtF(state.samples[0][0])}~${fmtF(state.samples.at(-1)[0])} MHz`
      : '未解析到有效数据';
    if (!state.samples.length) return;

    const cfg = {
      z0: state.cfg.z0, band: state.cfg.band, samples: state.samples,
      vswr_limit: state.cfg.vswr_limit,
    };
    const chain = effectiveChain();
    const ev = RF.evaluate(cfg, chain, 201);
    state.currentEval = ev;

    // 器件应力: 按扫频点逐段求 电压/电流/损耗/送达负载功率
    state.stress = RF.stressSweep(
      { z0: state.cfg.z0, samples: state.samples }, chain, state.power,
      ev.rows.map(r => r.f), [state.cfg.band[0] * 1e6, state.cfg.band[1] * 1e6]);

    // 候选/基线扫频数据(链固定, 负载可能变 -> 重算)
    state.candidates.forEach(c => {
      c.rows = RF.evaluate(cfg, c.chain, 201).rows;
    });

    renderSmith(ev.rows);
    renderCharts(ev.rows);
    renderStressCharts();
    updateChainStress();
    renderAnomalies(ev.rows);
    $('#chartStats').textContent =
      `带内最差 VSWR ${ev.worstVswr.toFixed(3)} @ ${(ev.worstF / 1e6).toFixed(3)} MHz`;

    if (state.pickF != null) showTrace(state.pickF);
  }

  function renderSmith(rows) {
    const endRow = rows[rows.length - 1];
    const overlays = state.candidates.filter(c => state.overlays.has(c.id))
      .map(c => ({ rows: c.rows }));
    let steps = null;
    if (state.traceSteps) steps = state.traceSteps.map(s => ({ r: s.r, x: s.x }));
    SmithChart.render({
      current: rows, baseline: state.baselineRows, overlays,
      steps, z0: state.cfg.z0, endDot: steps ? null : endRow,
    });
  }

  function renderCharts(rows) {
    SweepCharts.render({
      main: { rows },
      baseline: state.baselineRows ? { rows: state.baselineRows } : null,
      overlays: state.candidates.filter(c => state.overlays.has(c.id)).map(c => ({ rows: c.rows })),
      pickF: state.pickF, limit: state.cfg.vswr_limit,
      band1: state.cfg.band[0] * 1e6, band2: state.cfg.band[1] * 1e6,
    });
  }

  const elHasRating = el => (el.vmax > 0) || (el.imax > 0) || (el.pmax > 0);

  // ------------------------------------------------------------ 应力显示
  function renderStressCharts() {
    const s = state.stress;
    if (!s || !state.currentEval) return;
    const chain = effectiveChain();
    const freqs = s.rows.map(r => r.f);
    const series = [];
    chain.forEach((el, k) => {
      if (!elHasRating(el)) return;
      series.push({
        label: elName(el), color: STRESS_COLORS[series.length % STRESS_COLORS.length],
        utils: s.rows.map(r => (r.recs[k].ratio != null ? r.recs[k].ratio * 100 : NaN)),
      });
    });
    $('#stressLegend').innerHTML = series.length
      ? series.map(t => `<span><i style="background:${t.color}"></i>${escapeHtml(t.label)}</span>`).join('')
      : '<span class="hint">未设置额定值 — 在元件「⚡额定」中填写后此处显示利用率曲线</span>';
    SweepCharts.renderStress({
      freqs, f1: freqs[0], f2: freqs[freqs.length - 1],
      band1: state.cfg.band[0] * 1e6, band2: state.cfg.band[1] * 1e6,
      pickF: state.pickF, series, hasRatings: series.length > 0,
      marginPct: (1 - state.cfg.min_margin) * 100,
      power: {
        freqs,
        avg: s.rows.map(r => r.pLoadAvg),
        peak: s.rows.map(r => r.pLoadPeak),
        loss: s.rows.map(r => r.pLossAvg),
      },
    });
  }

  // 链节点应力行 + 链级"首先超限/最小裕量" + 功率卡摘要
  function updateChainStress() {
    const s = state.stress;
    const chain = effectiveChain();
    const elMap = new Map(chain.map(e => [e.uid, e]));
    const m = state.cfg.min_margin;
    $$('.stress-line').forEach(div => {
      const uid = div.dataset.suid;
      const a = s && s.perEl.get(uid);
      const el = elMap.get(uid);
      if (!a || !el) { div.textContent = ''; div.className = 'stress-line'; return; }
      const base = `⚡${RF.fmtV(a.v)} · ${RF.fmtA(a.i)} · 耗${RF.fmtW(a.p)}`;
      if (a.ratio == null) {
        div.textContent = base + ' · 未设额定';
        div.className = 'stress-line';
        div.title = '带内峰值应力 (V/I 为峰值包络级, 耗散为热平均级); 留空额定值只计算不判超限';
      } else {
        const lim = el[a.governs];
        const stressVal = a.governs === 'vmax' ? a.v : a.governs === 'imax' ? a.i : a.p;
        const fmt = a.governs === 'vmax' ? RF.fmtV : a.governs === 'imax' ? RF.fmtA : RF.fmtW;
        const lab = RATE_LABEL[a.governs];
        const marginPct = (1 - a.ratio) * 100;
        const cls = a.ratio > 1 ? 's-bad' : (a.ratio > 1 - m ? 's-warn' : 's-ok');
        div.textContent = `${base} · 最差${(a.ratioF / 1e6).toFixed(3)}M · ${lab}${fmt(stressVal)}/${fmt(lim)} · ` +
          `${marginPct >= 0 ? '裕量' : '超限'}${Math.abs(marginPct).toFixed(0)}%`;
        div.className = 'stress-line ' + cls;
        div.title = `带内最差: ${lab}利用率 ${(a.ratio * 100).toFixed(0)}% @ ${(a.ratioF / 1e6).toFixed(4)} MHz`;
      }
    });
    const info = $('#chainStressInfo');
    let worst = null;
    for (const e of chain) {
      const a = s && s.perEl.get(e.uid);
      if (a && a.ratio != null && (!worst || a.ratio > worst.a.ratio)) worst = { e, a };
    }
    if (!s) {
      info.textContent = ''; info.className = 'chain-stress-info';
    } else if (!worst) {
      info.textContent = '应力: 未设置额定值 — 各节点显示计算应力, 不判超限。';
      info.className = 'chain-stress-info';
    } else {
      const name = elName(worst.e);
      const f = (worst.a.ratioF / 1e6).toFixed(3);
      const lab = RATE_LABEL[worst.a.governs];
      if (worst.a.ratio > 1) {
        info.textContent = `✗ 首先超限: ${name} @ ${f}MHz · ${lab}超${((worst.a.ratio - 1) * 100).toFixed(0)}%`;
        info.className = 'chain-stress-info s-bad';
      } else {
        info.textContent = `✓ 最小裕量: ${name} @ ${f}MHz · ${lab}裕量${((1 - worst.a.ratio) * 100).toFixed(0)}%`;
        info.className = 'chain-stress-info ' + (worst.a.ratio > 1 - m ? 's-warn' : 's-ok');
      }
    }
    const ps = $('#stressSummary');
    if (s && s.rows.length) {
      const b1 = state.cfg.band[0] * 1e6, b2 = state.cfg.band[1] * 1e6;
      const inb = s.rows.filter(r => r.f >= b1 - 1 && r.f <= b2 + 1);
      const src = inb.length ? inb : s.rows;
      const lo = Math.min(...src.map(r => r.pLoadAvg));
      const hi = Math.max(...src.map(r => r.pLoadAvg));
      const pk = Math.max(...src.map(r => r.pLoadPeak));
      ps.textContent = `带内送达负载: 平均 ${RF.fmtW(lo)}~${RF.fmtW(hi)} · 峰值包络至 ${RF.fmtW(pk)}`;
    } else ps.textContent = '';
  }

  // ------------------------------------------------------------ 异常频点
  function renderAnomalies(rows) {
    const b1 = state.cfg.band[0] * 1e6, b2 = state.cfg.band[1] * 1e6;
    const inb = rows.filter(r => r.f >= b1 - 1 && r.f <= b2 + 1);
    const bad = inb.filter(r => r.vswr > state.cfg.vswr_limit)
      .sort((a, b) => b.vswr - a.vswr).slice(0, 12);
    const box = $('#anomalyBox');
    box.innerHTML = bad.length
      ? bad.map(r => `<div class="anomaly-row" data-f="${r.f}">
          <span>${(r.f / 1e6).toFixed(3)} MHz · Z=${zfmt(r.r, r.x)}</span>
          <span class="bad">VSWR ${r.vswr.toFixed(2)} · RL ${r.rl.toFixed(1)}dB</span></div>`).join('')
      : '<div class="hint">带内所有采样点均低于 VSWR 上限 ✓</div>';
    box.querySelectorAll('.anomaly-row').forEach(el =>
      el.addEventListener('click', () => showTrace(+el.dataset.f)));
  }

  // ------------------------------------------------------------ 变换追溯
  function showTrace(fHz) {
    state.pickF = fHz;
    if (!state.samples.length) return;
    // 与图表完全同源: 本地 RF 引擎逐段变换, 保证阻抗/驻波一致
    const chain = effectiveChain();
    const zl = RF.loadAt(state.samples, fHz);
    const steps = RF.chainInput(zl, chain, fHz, true);
    const zin = steps[steps.length - 1].z;
    const z0 = state.cfg.z0;
    // 该频点逐段应力 (V/I 峰值包络级, 损耗热平均级)
    const st = RF.stressAt(chain, zin, fHz, z0);
    const pPeak = state.power.p_w * Math.pow(10, state.power.par_db / 10);
    const pTherm = state.power.p_w * state.power.duty;
    const spk = Math.sqrt(Math.max(pPeak, 0));
    $('#traceInfo').textContent =
      `@ ${(fHz / 1e6).toFixed(4)} MHz · 送达负载 平均${RF.fmtW(st.pLoad * pTherm)} / 峰值${RF.fmtW(st.pLoad * pPeak)}`;
    state.traceSteps = steps.map(s => {
      const m = RF.metrics(s.z, z0);
      return { r: s.z.r, x: s.z.i, element: s.el, g_re: m.gamma.r, g_im: m.gamma.i,
               vswr: m.vswr, rl: m.rl };
    });
    const box = $('#traceBox');
    box.innerHTML = state.traceSteps.map((s, k) => {
      const name = k === 0 ? '负载' : elName(s.element);
      let stressTxt;
      if (k === 0) {
        stressTxt = `吸收 ${RF.fmtW(st.pLoad * pTherm)}(平均)`;
      } else {
        const se = st.elements[k - 1];
        stressTxt = `V ${RF.fmtV(se.v * spk)} · I ${RF.fmtA(se.i * spk)} · 耗 ${RF.fmtW(se.p * pTherm)}`;
      }
      return `<div class="trace-step ${k === state.traceSteps.length - 1 ? 'hot' : ''}">
        <div class="idx">${k}</div>
        <div><span class="zval"><b>${zfmt(s.r, s.x)}</b></span>
        <span class="tags">${name} · Γ=${s.g_re.toFixed(3)}${s.g_im >= 0 ? '+' : ''}${s.g_im.toFixed(3)}j · VSWR ${s.vswr.toFixed(2)} · RL ${s.rl.toFixed(1)}dB</span>
        <span class="tags stress-tag">${stressTxt}</span></div>
      </div>`;
    }).join('');
    renderSmith(state.currentEval.rows);
    renderCharts(state.currentEval.rows);
    renderStressCharts();
  }

  function elName(el) {
    if (!el) return '负载';
    if (el.uid === MAINLINE_UID || el.main) return '主馈线';
    switch (el.kind) {
      case 'Lser': return '串L ' + RF.fmtL(el.value);
      case 'Cser': return '串C ' + RF.fmtC(el.value);
      case 'Lpar': return '并L ' + RF.fmtL(el.value);
      case 'Cpar': return '并C ' + RF.fmtC(el.value);
      case 'line': return `线段 ${el.length.toFixed(2)}m`;
      case 'stub': return `${el.terminal === 'short' ? '短路' : '开路'}支节 ${el.length.toFixed(2)}m`;
      default: return el.kind;
    }
  }

  // ------------------------------------------------------------ 链编辑器
  function renderChain() {
    const box = $('#chainBox');
    const nodes = effectiveChain();
    if (!nodes.length) {
      box.innerHTML = '<div class="hint">链为空: 负载直连源端。用上方按钮插入元件。</div>';
      return;
    }
    const mainIdx = nodes.findIndex(n => n.uid === MAINLINE_UID);
    box.innerHTML = nodes.map((e, i) => nodeHTML(e, i, mainIdx)).join('');
    bindNodeEvents(box);
    if (state.stress) updateChainStress();   // 重建节点后回填应力行
  }

  function nodeHTML(e, i, mainIdx) {
    const locked = state.locks.has(e.uid);
    const isMain = e.uid === MAINLINE_UID;
    const cls = `el-node ${locked ? 'locked' : ''} ${isMain ? 'mainline' : ''}`;
    const zoneTag = (e.place === 'before') ? '<span class="zone-tag z-before">天线侧</span>'
      : '<span class="zone-tag z-after">电台侧</span>';
    let body = '';
    const sideBtn = `<span class="sidebtn" data-act="side"
        title="切换主馈线侧 (天线侧/电台侧)">${(e.place === 'before') ? '📡侧' : '🎙侧'}</span>`;
    const lock = `<span class="lockbtn ${locked ? 'on' : ''}" data-act="lock" title="锁定/解锁">${locked ? '🔒' : '🔓'}</span>`;
    const del = isMain ? '' : `<span class="delbtn" data-act="del" title="右键也可删除">✕</span>`;
    const stressLine = `<span class="stress-line" data-suid="${e.uid}"></span>`;
    if (isMain) {
      body = `<div class="title">主馈线 (负载侧首段)</div>
        <div class="tags hint">${e.z0}Ω · ${e.length.toFixed(2)}m · vf ${e.vf} · ${e.loss}dB/100m</div>
        <div class="rate-row">${stressLine}</div>`;
    } else if (e.kind === 'Lser' || e.kind === 'Lpar') {
      body = `<div class="title">${isMain?'':zoneTag}${RF.EL_LABEL[e.kind]} <span class="uid">#${e.uid}</span></div>
        <div class="valrow">
          <span class="drag-val" data-drag="val" data-prop="value" data-unit="H" title="横向拖动改值">⇔</span>
          <input class="val" data-prop="value" data-unit="H" value="${e.value}">
          <span class="disp">${RF.fmtL(e.value)}</span></div>
        ${rateRowHTML(e, stressLine, true)}`;
    } else if (e.kind === 'Cser' || e.kind === 'Cpar') {
      body = `<div class="title">${isMain?'':zoneTag}${RF.EL_LABEL[e.kind]} <span class="uid">#${e.uid}</span></div>
        <div class="valrow">
          <span class="drag-val" data-drag="val" data-prop="value" data-unit="F" title="横向拖动改值">⇔</span>
          <input class="val" data-prop="value" data-unit="F" value="${e.value}">
          <span class="disp">${RF.fmtC(e.value)}</span></div>
        ${rateRowHTML(e, stressLine, true)}`;
    } else {
      const isStub = e.kind === 'stub';
      body = `<div class="title">${isMain?'':zoneTag}${isStub ? (e.terminal === 'short' ? '短路支节' : '开路支节') : '传输线段'}
        <span class="uid">#${e.uid}</span></div>
        <div class="valrow">
          <span class="drag-pos ${canDragPos(e) ? '' : 'disabled'}" data-drag="pos"
            title="拖动在主馈线上的插入位置(改变前后线段长度)">⤧位置</span>
          <span class="drag-val" data-drag="val" data-prop="length" data-unit="m" title="横向拖动改长度">⇔</span>
          <input class="val" data-prop="length" data-unit="m" value="${e.length.toFixed(3)}" style="width:70px">
          <span class="disp">${e.length.toFixed(3)} m</span>
          ${isStub ? `<select class="term" data-prop="terminal">
            <option value="short" ${e.terminal === 'short' ? 'selected' : ''}>短路</option>
            <option value="open" ${e.terminal === 'open' ? 'selected' : ''}>开路</option></select>` : ''}
        </div>
        <div class="tags hint">${e.z0}Ω · vf ${e.vf} · ${e.loss}dB/100m${positionInfo(e)}</div>
        ${rateRowHTML(e, stressLine, false)}`;
    }
    return `<div class="${cls}" data-uid="${e.uid}">
      <div class="arrow">${i === 0 ? '负载→' : '↓'}</div>
      <div class="body">${body}</div>
      <div class="locks">${isMain?"":sideBtn}${lock}${del}</div></div>`;
  }

  // 额定参数行: ⚡额定 展开按钮 + 应力显示行 + (可选)额定编辑框
  function rateRowHTML(e, stressLine, withQ) {
    const open = state.rateOpen.has(e.uid);
    const rated = elHasRating(e) || (withQ && e.q > 0);
    let box = '';
    if (open) {
      const fld = (key, lab, ph) =>
        `<label>${lab}<input class="rate" data-rate="${key}" value="${e[key] ?? ''}" placeholder="${ph}"></label>`;
      box = `<div class="rate-box">
        ${withQ ? fld('q', 'Q值', '∞') : ''}
        ${fld('vmax', '耐压V', '—')}${fld('imax', '电流A', '—')}${fld('pmax', '热功W', '—')}
      </div>`;
    }
    return `<div class="rate-row">
      <span class="ratebtn ${open ? 'on' : ''}" data-act="rate"
        title="额定参数: ${withQ ? 'Q值/' : ''}耐压/电流/热功率 · 留空不判超限">⚡额定${rated ? '●' : ''}</span>
      ${stressLine}</div>${box}`;
  }

    // 只有支节/线段能把位置"摊到"相邻两线段上: 前一段与后一段都须是 line
  function canDragPos(e) {
    const nodes = effectiveChain();
    const i = nodes.findIndex(n => n.uid === e.uid);
    if (i < 0) return false;
    const prev = nodes[i - 1], next = nodes[i + 1];
    return prev && prev.kind === 'line' && next && next.kind === 'line';
  }

  function positionInfo(e) {
    const nodes = effectiveChain();
    const i = nodes.findIndex(n => n.uid === e.uid);
    if (i < 0) return '';
    // 支节挂在节点处, 距负载 = 之前所有线段长度之和(含主馈线中该点之前的部分)
    const before = nodes.slice(0, i).filter(n => n.kind === 'line')
      .reduce((s, n) => s + n.length, 0);
    return ` · 距负载 ${before.toFixed(2)}m`;
  }

  function bindNodeEvents(box) {
    box.querySelectorAll('.el-node').forEach(node => {
      const uidv = node.dataset.uid;
      const el = findEl(uidv);
      const isMain = uidv === MAINLINE_UID;
      node.querySelector('[data-act="lock"]')?.addEventListener('click', () => {
        state.locks.has(uidv) ? state.locks.delete(uidv) : state.locks.add(uidv);
        if (isMain) syncFeedForm();
        renderChain();
      });
      node.querySelector('[data-act="side"]')?.addEventListener('click', () => {
        if (!el) return;
        el.place = el.place === 'before' ? 'after' : 'before';
        afterChainChange();
      });
      node.querySelector('[data-act="del"]')?.addEventListener('click', () => deleteEl(uidv));
      node.querySelector('[data-act="rate"]')?.addEventListener('click', () => {
        state.rateOpen.has(uidv) ? state.rateOpen.delete(uidv) : state.rateOpen.add(uidv);
        renderChain();
      });
      node.addEventListener('contextmenu', ev => {
        ev.preventDefault();
        if (!isMain) deleteEl(uidv);
      });
      if (!el || isMain) return;   // 主馈线无值编辑, 以下仅针对用户元件
      node.querySelectorAll('input.val').forEach(inp => {
        inp.addEventListener('change', () => {
          const v = parseFloat(inp.value);
          if (isFinite(v)) { el[inp.dataset.prop] = v; afterChainChange(); }
        });
      });
      node.querySelectorAll('input.rate').forEach(inp => {
        inp.addEventListener('change', () => {
          const key = inp.dataset.rate;
          const raw = inp.value.trim();
          const v = parseFloat(raw);
          if (raw !== '' && isFinite(v) && v > 0) el[key] = v;
          else delete el[key];              // 留空 = 未设置, 只计算不判超限
          afterChainChange();
        });
      });
      node.querySelectorAll('select.term').forEach(sel =>
        sel.addEventListener('change', () => { el.terminal = sel.value; afterChainChange(); }));
      node.querySelectorAll('[data-drag="val"]').forEach(handle =>
        attachValueDrag(handle, el));
      node.querySelectorAll('[data-drag="pos"]').forEach(handle => {
        if (canDragPos(el)) attachPositionDrag(handle, el);
      });
    });
  }

  function attachValueDrag(handle, el) {
    handle.addEventListener('pointerdown', ev => {
      ev.preventDefault();
      const prop = handle.dataset.prop;
      const startX = ev.clientX;
      const startVal = el[prop];
      const move = e2 => {
        const dx = e2.clientX - startX;
        const fine = e2.shiftKey ? 0.1 : 1;
        let v;
        if (prop === 'length') v = Math.max(0, startVal * (1 + dx * 0.004 * fine));
        else v = startVal * Math.exp(dx * 0.012 * fine);
        el[prop] = v;
        scheduleRecompute();
        renderChain();
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        afterChainChange();
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
  }

  function attachPositionDrag(handle, el) {
    // 把位置在相邻两线段间滑动: prev.length += delta, next.length -= delta
    handle.addEventListener('pointerdown', ev => {
      ev.preventDefault();
      const nodes = state.chain;
      // effective chain 索引
      const eff = effectiveChain();
      const i = eff.findIndex(n => n.uid === el.uid);
      const prevEff = eff[i - 1], nextEff = eff[i + 1];
      const prevUser = findEl(prevEff.uid), nextUser = findEl(nextEff.uid);
      // 主馈线可能在其中(它是合成对象, 直接改 state.feed.length)
      const startX = ev.clientX;
      const total = prevEff.length + nextEff.length;
      let applied = 0;
      const move = e2 => {
        const dx = e2.clientX - startX;
        let delta = dx * total * 0.004 * (e2.shiftKey ? 0.1 : 1);
        delta = Math.max(-prevEff.length + 0.02, Math.min(nextEff.length - 0.02, delta));
        if (Math.abs(delta - applied) < 1e-9) return;
        const step = delta - applied;
        setSegLen(prevEff, prevUser, prevEff.length + step);
        setSegLen(nextEff, nextUser, nextEff.length - step);
        prevEff.length += step; nextEff.length -= step;
        applied = delta;
        scheduleRecompute();
        renderChain();
      };
      const up = () => {
        removeEventListener('pointermove', move);
        removeEventListener('pointerup', up);
        afterChainChange();
      };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    });
  }

  function setSegLen(effEl, userEl, len) {
    if (effEl.uid === MAINLINE_UID) { state.feed.length = len; syncFeedForm(); }
    else if (userEl) userEl.length = len;
  }

  function findEl(id) {
    if (id === MAINLINE_UID) return null;
    return state.chain.find(e => e.uid === id);
  }

  function deleteEl(id) {
    state.chain = state.chain.filter(e => e.uid !== id);
    state.locks.delete(id);
    afterChainChange();
  }

  function afterChainChange() {
    renderChain();
    scheduleRecompute();
  }

  // ------------------------------------------------------------ 候选方案
  async function runSolve() {
    if (!state.samples.length) { state.samples = RF.parseSamples(state.samplesText); }
    if (!state.samples.length) { alert('请先粘贴有效采样'); return; }
    $('#solveInfo').textContent = '求解中…';
    let data;
    try {
      data = await apiPost('/api/solve', cfgPayload());
    } catch (e) {
      $('#solveInfo').textContent = '✗ ' + e.message;
      return;
    }
    state.candidates = data.candidates;
    state.overlays = new Set();
    state.activeCand = null;
    renderCandidates();
    scheduleRecompute();
    $('#solveInfo').textContent = `${data.candidates.length} 个候选` +
      (data.excluded ? ` · 已排除 ${data.excluded} 个超硬限制组合` : '');
  }

  function renderCandidates() {
    const box = $('#candidateBox');
    if (!state.candidates.length) { box.innerHTML = '<div class="hint">尚无候选</div>'; return; }
    box.innerHTML = state.candidates.map(c => {
      const ok = c.worst_vswr <= state.cfg.vswr_limit;
      const bwPct = Math.min(100, c.bw_frac * 100);
      let stBadge = '';
      if (c.stress && c.stress.rated) {
        stBadge = c.stress.violations > 0
          ? `<span class="stress-badge sbad" title="超过最小安全裕量的额定项数">⚠${c.stress.violations}项超裕量</span>`
          : `<span class="stress-badge sok" title="带内最差应力裕量">裕量≥${Math.max(0, Math.round((1 - (c.stress.worst_ratio || 0)) * 100))}%</span>`;
      }
      return `<div class="cand-row ${ok ? 'ok' : 'bad'} ${state.activeCand === c.id ? 'active' : ''}"
          data-id="${c.id}">
        <input type="checkbox" class="ov" data-id="${c.id}" ${state.overlays.has(c.id) ? 'checked' : ''} title="叠加显示">
        <span class="lab" title="${c.label}">${c.rank}. ${c.label}</span>
        <span class="metric"><b>${c.worst_vswr.toFixed(2)}</b>${stBadge}<br>BW ${bwPct >= 99.9 ? '≥100' : bwPct.toFixed(0)}% · ${c.count}件${c.stub_len ? ' · 支' + c.stub_len.toFixed(2) + 'm' : ''}</span>
        <button class="btn btn-small apply" data-id="${c.id}">载入</button>
      </div>`;
    }).join('');
    box.querySelectorAll('.ov').forEach(cb => cb.addEventListener('change', () => {
      const id = cb.dataset.id;
      cb.checked ? state.overlays.add(id) : state.overlays.delete(id);
      scheduleRecompute();
    }));
    box.querySelectorAll('.apply').forEach(b => b.addEventListener('click', () => applyCandidate(b.dataset.id)));
    box.querySelectorAll('.lab').forEach(el => el.addEventListener('click', () => {
      state.activeCand = state.activeCand === el.parentElement.dataset.id ? null : el.parentElement.dataset.id;
      renderCandidates();
    }));
  }

  function applyCandidate(id) {
    const c = state.candidates.find(x => x.id === id);
    if (!c) return;
    // 服务端候选链已按 负载->源 排好; 主馈线段带 main 标记
    state.chain = [];
    state.locks = new Set();
    let seenMain = false;
    for (const e of c.chain) {
      if (e.uid === MAINLINE_UID || e.main) {
        seenMain = true;
        state.feedEnabled = true;
        Object.assign(state.feed, { z0: e.z0, vf: e.vf, loss: e.loss,
          lossf: e.lossf / 1e6, length: e.length,
          vmax: e.vmax ?? null, imax: e.imax ?? null, pmax: e.pmax ?? null });
        syncFeedForm();
      } else {
        state.chain.push({ ...e, uid: e.uid || uid(), place: seenMain ? 'after' : 'before' });
      }
    }
    state.overlays = new Set([id]);
    state.activeCand = id;
    setBaselineIfNeeded();
    afterChainChange();
    renderCandidates();
  }

  function setBaselineIfNeeded() {
    if (!state.baselineRows && state.currentEval) state.baselineRows = state.currentEval.rows;
  }

  // ------------------------------------------------------------ 容差抽样
  async function runMC() {
    const target = state.activeCand
      ? state.candidates.find(c => c.id === state.activeCand) : null;
    const chain = target ? target.chain : effectiveChain();
    $('#mcInfo').textContent = '抽样中…';
    let mc;
    try {
      mc = await apiPost('/api/montecarlo', cfgPayload({
        candidate_chain: chain,
        locks: [...state.locks],
        seed: +$('#mcSeed').value, n: +$('#mcN').value,
        tol: (+$('#mcTol').value) / 100, len_tol: (+$('#mcLenTol').value) / 100,
      }));
    } catch (e) { $('#mcInfo').textContent = '✗ ' + e.message; return; }
    $('#mcInfo').textContent = '';
    const ycls = v => v >= 0.9 ? 'pass-ok' : (v >= 0.6 ? '' : 'pass-bad');
    const hasS = mc.stress_yield != null;
    $('#mcTable').innerHTML = `<table>
      <tr><th>电气达标</th>${hasS ? '<th>应力合格</th><th>双合格</th>' : ''}<th>P50 最差VSWR</th><th>P95</th><th>极端值</th></tr>
      <tr><td class="yield-big ${ycls(mc.yield)}">${(mc.yield * 100).toFixed(1)}%</td>
      ${hasS ? `<td class="yield-big ${ycls(mc.stress_yield)}">${(mc.stress_yield * 100).toFixed(1)}%</td>
      <td class="yield-big ${ycls(mc.both_yield)}">${(mc.both_yield * 100).toFixed(1)}%</td>` : ''}
      <td>${mc.p50.toFixed(3)}</td><td>${mc.p95.toFixed(3)}</td><td>${mc.worst.toFixed(3)}</td></tr>
      </table><div class="hint">种子 ${mc.seed} · ${mc.n} 次 · L/C ±${(mc.tol * 100).toFixed(1)}% · 长度 ±${(mc.len_tol * 100).toFixed(1)}% · 锁定 ${state.locks.size} 件 · 判据: 全带 VSWR≤${state.cfg.vswr_limit}${hasS ? ` · 应力≤100%额定 (最差应力比 P95 ${mc.ratio_p95.toFixed(2)})` : ' · 未设额定值, 仅统计电气达标'}</div>`;
  }

  // ------------------------------------------------------------ 持久化
  function snapshot() {
    return {
      samplesText: state.samplesText, cfg: state.cfg, feed: state.feed,
      feedEnabled: state.feedEnabled, chain: state.chain,
      locks: [...state.locks], baselineRows: state.baselineRows,
      projectName: state.projectName,
      eseries: state.cfg.eseries,
      power: state.power, min_margin: state.cfg.min_margin,
    };
  }

  function restore(s) {
    Object.assign(state.cfg, s.cfg || {});
    state.cfg.min_margin = (s.min_margin != null) ? s.min_margin : 0.2;
    state.samplesText = s.samplesText ?? DEFAULT_SAMPLES;
    // 旧项目缺少应力数据: feed 缺省额定保持 null (未设置), power 用默认值
    Object.assign(state.feed, { vmax: null, imax: null, pmax: null }, s.feed || {});
    state.feedEnabled = s.feedEnabled ?? true;
    state.power = Object.assign({ p_w: 100, par_db: 0, duty: 1.0 }, s.power || {});
    state.chain = s.chain || [];
    state.locks = new Set(s.locks || []);
    state.rateOpen = new Set();
    state.baselineRows = s.baselineRows || null;
    state.projectName = s.projectName || '未命名项目';
    state.candidates = []; state.activeCand = null; state.overlays = new Set();
    state.pickF = null; state.traceSteps = null;
    syncAllForms();
    renderChain();
    renderCandidates();
    scheduleRecompute();
  }

  async function saveProject() {
    const name = prompt('项目名称', state.projectName);
    if (name == null) return;
    state.projectName = name;
    const resp = await fetch('/api/projects', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.projectId, name, state: snapshot() }),
    });
    const d = await resp.json();
    state.projectId = d.id;
    loadProjectList();
  }

  async function loadProjectList() {
    const sel = $('#projectSel');
    const resp = await fetch('/api/projects');
    const items = await resp.json();
    sel.innerHTML = '<option value="">— 选择项目 —</option>' + items.map(p =>
      `<option value="${p.id}" ${p.id === state.projectId ? 'selected' : ''}>${escapeHtml(p.name)} · ${new Date(p.updated * 1000).toLocaleString()}</option>`).join('');
  }

  async function openProject(id) {
    const resp = await fetch('/api/projects/' + id);
    const d = await resp.json();
    if (d.error) return;
    state.projectId = d.id; state.projectName = d.name;
    restore(d.state);
    loadProjectList();
  }

  async function deleteProject() {
    if (!state.projectId) return;
    if (!confirm('删除当前项目及其全部版本?')) return;
    await fetch('/api/projects/' + state.projectId, { method: 'DELETE' });
    state.projectId = null;
    loadProjectList();
  }

  async function saveVersion() {
    if (!state.projectId) { await saveProject(); if (!state.projectId) return; }
    const label = prompt('版本标签', new Date().toLocaleString());
    if (label == null) return;
    const worst = state.currentEval ? state.currentEval.worstVswr.toFixed(3) : '';
    await fetch(`/api/projects/${state.projectId}/versions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, summary: '最差VSWR ' + worst, state: snapshot() }),
    });
    alert('版本已保存');
  }

  async function openVersions() {
    if (!state.projectId) { alert('请先保存项目'); return; }
    const resp = await fetch(`/api/projects/${state.projectId}/versions`);
    const items = await resp.json();
    $('#modalTitle').textContent = `历史版本 · ${state.projectName}`;
    $('#modalBody').className = 'modal-body';
    $('#modalBody').innerHTML = items.length ? items.map(v =>
      `<div class="ver-row"><div>
        <b>${escapeHtml(v.label)}</b>
        <div class="hint">${new Date(v.created * 1000).toLocaleString()} · ${escapeHtml(v.summary || '')}</div></div>
        <div><button class="btn btn-small restore" data-vid="${v.id}">恢复</button>
        <button class="btn btn-small btn-danger-ghost vdel" data-vid="${v.id}">删除</button></div></div>`).join('')
      : '<div class="hint">尚无版本快照</div>';
    $('#modalMask').classList.remove('hidden');
    $('#modalBody').querySelectorAll('.restore').forEach(b => b.addEventListener('click', async () => {
      const d = await (await fetch('/api/versions/' + b.dataset.vid)).json();
      if (!d.error) { restore(d.state); $('#modalMask').classList.add('hidden'); }
    }));
    $('#modalBody').querySelectorAll('.vdel').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('删除该版本?')) return;
      await fetch('/api/versions/' + b.dataset.vid, { method: 'DELETE' });
      openVersions();
    }));
  }

  // ------------------------------------------------------------ 表单同步
  function syncFeedForm() {
    $('#feedZ0').value = state.feed.z0;
    $('#feedLen').value = state.feed.length;
    $('#feedVf').value = state.feed.vf;
    $('#feedLoss').value = state.feed.loss;
    $('#feedLossF').value = state.feed.lossf;
    $('#feedVmax').value = state.feed.vmax ?? '';
    $('#feedImax').value = state.feed.imax ?? '';
    $('#feedPmax').value = state.feed.pmax ?? '';
    $('#feedEnabled').checked = state.feedEnabled;
    // 主馈线锁定后禁止编辑参数
    const locked = state.locks.has(MAINLINE_UID);
    ['feedZ0', 'feedLen', 'feedVf', 'feedLoss', 'feedLossF', 'feedVmax', 'feedImax', 'feedPmax']
      .forEach(id => ($('#' + id).disabled = locked));
    $('#cardFeed').classList.toggle('locked-card', locked);
  }

  function syncAllForms() {
    $('#samplesText').value = state.samplesText;
    $('#sysZ0').value = state.cfg.z0;
    $('#vswrLimit').value = state.cfg.vswr_limit;
    $('#bandLo').value = state.cfg.band[0];
    $('#bandHi').value = state.cfg.band[1];
    $('#eseries').value = state.cfg.eseries;
    $('#plane').value = state.cfg.plane;
    $('#pwrW').value = state.power.p_w;
    $('#pwrPar').value = state.power.par_db;
    $('#pwrDuty').value = Math.round(state.power.duty * 1000) / 10;
    $('#minMargin').value = Math.round(state.cfg.min_margin * 1000) / 10;
    syncFeedForm();
  }

  function bindForms() {
    $('#samplesText').addEventListener('input', () => {
      state.samplesText = $('#samplesText').value;
      state.baselineRows = null; scheduleRecompute();
    });
    $('#btnParse').addEventListener('click', () => {
      state.baselineRows = null;
      state.samples = RF.parseSamples(state.samplesText);
      scheduleRecompute();
    });
    $('#sysZ0').addEventListener('change', e => { state.cfg.z0 = +e.target.value; scheduleRecompute(); });
    $('#vswrLimit').addEventListener('change', e => {
      state.cfg.vswr_limit = +e.target.value; renderCandidates(); scheduleRecompute();
    });
    $('#bandLo').addEventListener('change', e => { state.cfg.band[0] = +e.target.value; scheduleRecompute(); });
    $('#bandHi').addEventListener('change', e => { state.cfg.band[1] = +e.target.value; scheduleRecompute(); });
    $('#eseries').addEventListener('change', e => { state.cfg.eseries = e.target.value; });
    $('#plane').addEventListener('change', e => { state.cfg.plane = e.target.value; });

    ['feedZ0', 'feedLen', 'feedVf', 'feedLoss', 'feedLossF', 'feedVmax', 'feedImax', 'feedPmax']
      .forEach(id => $(`#${id}`).addEventListener('change', () => readFeedForm()));
    $('#feedEnabled').addEventListener('change', e => {
      state.feedEnabled = e.target.checked; afterChainChange();
    });

    // 发射功率 / 峰均比 / 占空比 / 最小安全裕量
    $('#pwrW').addEventListener('change', e => {
      state.power.p_w = Math.max(0, +e.target.value || 0); scheduleRecompute();
    });
    $('#pwrPar').addEventListener('change', e => {
      state.power.par_db = Math.max(0, +e.target.value || 0); scheduleRecompute();
    });
    $('#pwrDuty').addEventListener('change', e => {
      state.power.duty = Math.min(100, Math.max(0, +e.target.value || 0)) / 100; scheduleRecompute();
    });
    $('#minMargin').addEventListener('change', e => {
      state.cfg.min_margin = Math.min(90, Math.max(0, +e.target.value || 0)) / 100;
      renderCandidates(); scheduleRecompute();
    });

    $$('[data-add]').forEach(b => b.addEventListener('click', () => {
      const kindMap = { shortStub: 'stub', openStub: 'stub' };
      const kind = kindMap[b.dataset.add] || b.dataset.add;
      const el = newElement(kind);
      if (b.dataset.add === 'openStub') el.terminal = 'open';
      // 新元件默认落在当前求解参考面一侧
      el.place = state.cfg.plane === 'source' ? 'after' : 'before';
      state.chain.push(el);
      afterChainChange();
    }));
    $('#btnClearChain').addEventListener('click', () => {
      if (confirm('清空全部用户元件?')) { state.chain = []; state.locks = new Set(); afterChainChange(); }
    });

    $('#btnSolve').addEventListener('click', runSolve);
    $('#btnMC').addEventListener('click', runMC);
    $('#btnSaveProject').addEventListener('click', saveProject);
    $('#btnSaveVersion').addEventListener('click', saveVersion);
    $('#btnVersions').addEventListener('click', openVersions);
    $('#btnDeleteProject').addEventListener('click', deleteProject);
    $('#projectSel').addEventListener('change', e => { if (e.target.value) openProject(+e.target.value); });
    $('#modalClose').addEventListener('click', () => $('#modalMask').classList.add('hidden'));
    $('#modalMask').addEventListener('click', e => { if (e.target.id === 'modalMask') e.target.classList.add('hidden'); });

    // 史密斯图点选 -> 反解频率(取幅角/模最近的扫频点)
    $('#smithCanvas').addEventListener('click', ev => {
      const g = SmithChart.pickGamma(ev);
      if (!state.currentEval) return;
      let best = null, bd = 1e9;
      for (const r of state.currentEval.rows) {
        const d = (r.g_re - g.r) ** 2 + (r.g_im - g.i) ** 2;
        if (d < bd) { bd = d; best = r; }
      }
      if (best && bd < 0.04) showTrace(best.f);
    });

    SweepCharts.mount(['chartVswr', 'chartRl', 'chartS11', 'chartZ'], f => showTrace(f));
    SweepCharts.mountStress(['chartStress', 'chartPower'], f => showTrace(f));
  }

  function numOrNull(s) {
    const v = parseFloat(s);
    return (String(s).trim() !== '' && isFinite(v) && v > 0) ? v : null;
  }

  function readFeedForm() {
    state.feed = {
      z0: +$('#feedZ0').value, length: +$('#feedLen').value,
      vf: +$('#feedVf').value, loss: +$('#feedLoss').value, lossf: +$('#feedLossF').value,
      vmax: numOrNull($('#feedVmax').value),
      imax: numOrNull($('#feedImax').value),
      pmax: numOrNull($('#feedPmax').value),
    };
    afterChainChange();
  }

  // ------------------------------------------------------------ 小工具
  function zfmt(r, x) {
    return `${r >= 0 ? '' : ''}${r.toFixed(1)}${x >= 0 ? '+' : ''}${x.toFixed(1)}j Ω`;
  }
  function fmtF(fHz) { return (fHz / 1e6).toFixed(3); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------------------ 启动
  window.addEventListener('resize', () => scheduleRecompute());
  SmithChart.mount($('#smithCanvas'));
  bindForms();
  syncAllForms();
  renderChain();
  state.samples = RF.parseSamples(state.samplesText);
  scheduleRecompute();
  loadProjectList();
})();
