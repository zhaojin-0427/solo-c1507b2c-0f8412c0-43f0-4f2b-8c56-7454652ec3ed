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
    cfg: { z0: 50, band: [14.0, 14.4], vswr_limit: 1.5, eseries: 'E24', plane: 'load' },
    feed: { z0: 50, length: 12.0, vf: 0.66, loss: 1.2, lossf: 10 },
    chain: [],            // 用户元件 (不含主馈线)
    feedEnabled: true,
    baselineRows: null,
    candidates: [],
    activeCand: null,
    overlays: new Set(),
    locks: new Set(),
    pickF: null,
    traceSteps: null,
    projectId: null,
    projectName: '未命名项目',
  };

  const MAINLINE_UID = 'mainline';

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
    return { kind: 'line', uid: MAINLINE_UID, z0: +state.feed.z0, length: +state.feed.length,
             vf: +state.feed.vf, loss: +state.feed.loss, lossf: +state.feed.lossf * 1e6, main: true };
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
      feed: state.feed, chain: effectiveChain(), ...extra,
    };
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
    const ev = RF.evaluate(cfg, effectiveChain(), 201);
    state.currentEval = ev;

    // 候选/基线扫频数据(链固定, 负载可能变 -> 重算)
    state.candidates.forEach(c => {
      c.rows = RF.evaluate(cfg, c.chain, 201).rows;
    });

    renderSmith(ev.rows);
    renderCharts(ev.rows);
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
  async function showTrace(fHz) {
    state.pickF = fHz;
    $('#traceInfo').textContent = `@ ${(fHz / 1e6).toFixed(4)} MHz`;
    try {
      const resp = await fetch('/api/trace', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfgPayload({ f: fHz / 1e6 })),
      });
      const data = await resp.json();
      if (data.error) return;
      state.traceSteps = data.steps;
      const box = $('#traceBox');
      box.innerHTML = data.steps.map((s, k) => {
        const name = k === 0 ? '负载' : elName(s.element);
        return `<div class="trace-step ${k === data.steps.length - 1 ? 'hot' : ''}">
          <div class="idx">${k}</div>
          <div><span class="zval"><b>${zfmt(s.r, s.x)}</b></span>
          <span class="tags">${name} · Γ=${(s.g_re).toFixed(3)}${s.g_im >= 0 ? '+' : ''}${s.g_im.toFixed(3)}j · VSWR ${s.vswr.toFixed(2)} · RL ${s.rl.toFixed(1)}dB</span></div>
        </div>`;
      }).join('');
      renderSmith(state.currentEval.rows);
      renderCharts(state.currentEval.rows);
    } catch (e) { /* 离线时忽略 */ }
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
    if (isMain) {
      body = `<div class="title">主馈线 (负载侧首段)</div>
        <div class="tags hint">${e.z0}Ω · ${e.length.toFixed(2)}m · vf ${e.vf} · ${e.loss}dB/100m</div>`;
    } else if (e.kind === 'Lser' || e.kind === 'Lpar') {
      body = `<div class="title">${isMain?'':zoneTag}${RF.EL_LABEL[e.kind]} <span class="uid">#${e.uid}</span></div>
        <div class="valrow">
          <span class="drag-val" data-drag="val" data-prop="value" data-unit="H" title="横向拖动改值">⇔</span>
          <input class="val" data-prop="value" data-unit="H" value="${e.value}">
          <span class="disp">${RF.fmtL(e.value)}</span></div>`;
    } else if (e.kind === 'Cser' || e.kind === 'Cpar') {
      body = `<div class="title">${isMain?'':zoneTag}${RF.EL_LABEL[e.kind]} <span class="uid">#${e.uid}</span></div>
        <div class="valrow">
          <span class="drag-val" data-drag="val" data-prop="value" data-unit="F" title="横向拖动改值">⇔</span>
          <input class="val" data-prop="value" data-unit="F" value="${e.value}">
          <span class="disp">${RF.fmtC(e.value)}</span></div>`;
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
        <div class="tags hint">${e.z0}Ω · vf ${e.vf} · ${e.loss}dB/100m${positionInfo(e)}</div>`;
    }
    return `<div class="${cls}" data-uid="${e.uid}">
      <div class="arrow">${i === 0 ? '负载→' : '↓'}</div>
      <div class="body">${body}</div>
      <div class="locks">${isMain?"":sideBtn}${lock}${del}</div></div>`;
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
      if (!el) return;
      node.querySelector('[data-act="lock"]')?.addEventListener('click', () => {
        state.locks.has(uidv) ? state.locks.delete(uidv) : state.locks.add(uidv);
        renderChain();
      });
      node.querySelector('[data-act="side"]')?.addEventListener('click', () => {
        el.place = el.place === 'before' ? 'after' : 'before';
        afterChainChange();
      });
      node.querySelector('[data-act="del"]')?.addEventListener('click', () => deleteEl(uidv));
      node.addEventListener('contextmenu', ev => {
        ev.preventDefault();
        if (uidv !== MAINLINE_UID) deleteEl(uidv);
      });
      node.querySelectorAll('input.val').forEach(inp => {
        inp.addEventListener('change', () => {
          const v = parseFloat(inp.value);
          if (isFinite(v)) { el[inp.dataset.prop] = v; afterChainChange(); }
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
    const resp = await fetch('/api/solve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfgPayload()),
    });
    const data = await resp.json();
    if (data.error) { $('#solveInfo').textContent = data.error; return; }
    state.candidates = data.candidates;
    state.overlays = new Set();
    state.activeCand = null;
    renderCandidates();
    scheduleRecompute();
    $('#solveInfo').textContent = `${data.candidates.length} 个候选`;
  }

  function renderCandidates() {
    const box = $('#candidateBox');
    if (!state.candidates.length) { box.innerHTML = '<div class="hint">尚无候选</div>'; return; }
    box.innerHTML = state.candidates.map(c => {
      const ok = c.worst_vswr <= state.cfg.vswr_limit;
      const bwPct = Math.min(100, c.bw_frac * 100);
      return `<div class="cand-row ${ok ? 'ok' : 'bad'} ${state.activeCand === c.id ? 'active' : ''}"
          data-id="${c.id}">
        <input type="checkbox" class="ov" data-id="${c.id}" ${state.overlays.has(c.id) ? 'checked' : ''} title="叠加显示">
        <span class="lab" title="${c.label}">${c.rank}. ${c.label}</span>
        <span class="metric"><b>${c.worst_vswr.toFixed(2)}</b><br>BW ${bwPct >= 99.9 ? '≥100' : bwPct.toFixed(0)}% · ${c.count}件${c.stub_len ? ' · 支' + c.stub_len.toFixed(2) + 'm' : ''}</span>
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
          lossf: e.lossf / 1e6, length: e.length });
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
    const resp = await fetch('/api/montecarlo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfgPayload({
        candidate_chain: chain,
        locks: [...state.locks],
        seed: +$('#mcSeed').value, n: +$('#mcN').value,
        tol: (+$('#mcTol').value) / 100, len_tol: (+$('#mcLenTol').value) / 100,
      })),
    });
    const mc = await resp.json();
    if (mc.error) { $('#mcInfo').textContent = mc.error; return; }
    $('#mcInfo').textContent = '';
    const ycls = mc.yield >= 0.9 ? 'pass-ok' : (mc.yield >= 0.6 ? '' : 'pass-bad');
    $('#mcTable').innerHTML = `<table>
      <tr><th>达标比例</th><th>P50 最差VSWR</th><th>P95</th><th>极端值</th></tr>
      <tr><td class="yield-big ${ycls}">${(mc.yield * 100).toFixed(1)}%</td>
      <td>${mc.p50.toFixed(3)}</td><td>${mc.p95.toFixed(3)}</td><td>${mc.worst.toFixed(3)}</td></tr>
      </table><div class="hint">种子 ${mc.seed} · ${mc.n} 次 · L/C ±${(mc.tol * 100).toFixed(1)}% · 长度 ±${(mc.len_tol * 100).toFixed(1)}% · 锁定 ${state.locks.size} 件 · 判据: 全带 VSWR≤${state.cfg.vswr_limit}</div>`;
  }

  // ------------------------------------------------------------ 持久化
  function snapshot() {
    return {
      samplesText: state.samplesText, cfg: state.cfg, feed: state.feed,
      feedEnabled: state.feedEnabled, chain: state.chain,
      locks: [...state.locks], baselineRows: state.baselineRows,
      projectName: state.projectName,
      eseries: state.cfg.eseries,
    };
  }

  function restore(s) {
    Object.assign(state.cfg, s.cfg || {});
    state.samplesText = s.samplesText ?? DEFAULT_SAMPLES;
    Object.assign(state.feed, s.feed || {});
    state.feedEnabled = s.feedEnabled ?? true;
    state.chain = s.chain || [];
    state.locks = new Set(s.locks || []);
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
    $('#feedEnabled').checked = state.feedEnabled;
  }

  function syncAllForms() {
    $('#samplesText').value = state.samplesText;
    $('#sysZ0').value = state.cfg.z0;
    $('#vswrLimit').value = state.cfg.vswr_limit;
    $('#bandLo').value = state.cfg.band[0];
    $('#bandHi').value = state.cfg.band[1];
    $('#eseries').value = state.cfg.eseries;
    $('#plane').value = state.cfg.plane;
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

    ['feedZ0', 'feedLen', 'feedVf', 'feedLoss', 'feedLossF'].forEach(id =>
      $(`#${id}`).addEventListener('change', () => readFeedForm()));
    $('#feedEnabled').addEventListener('change', e => {
      state.feedEnabled = e.target.checked; afterChainChange();
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
  }

  function readFeedForm() {
    state.feed = {
      z0: +$('#feedZ0').value, length: +$('#feedLen').value,
      vf: +$('#feedVf').value, loss: +$('#feedLoss').value, lossf: +$('#feedLossF').value,
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
