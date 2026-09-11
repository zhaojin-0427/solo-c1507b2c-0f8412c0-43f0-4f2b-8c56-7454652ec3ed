/* 史密斯圆图 (阻抗坐标) Canvas 绘制 */
const SmithChart = (() => {
  let canvas, ctx, cv;
  let R = 200, cx = 0, cy = 0, scale = 1;
  const RGRID = [0.2, 0.5, 1, 2, 5];
  const XGRID = [0.2, 0.5, 1, 2, 5];

  function mount(c) {
    canvas = c;
    ctx = c.getContext('2d');
    cv = { devicePixelRatio: window.devicePixelRatio || 1 };
  }

  function setup() {
    const cssSize = canvas.clientWidth || 560;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssSize * dpr;
    canvas.height = cssSize * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    R = cssSize / 2 - 34;
    cx = cssSize / 2;
    cy = cssSize / 2;
    return cssSize;
  }

  // 归一化阻抗 (rz, ix) -> 圆图坐标 (0,0 圆心, 1 外圆半径), y 向上
  function z2xy(rz, ix) {
    const d = (rz + 1) * (rz + 1) + ix * ix;
    return [(rz * rz + ix * ix - 1) / d, 2 * ix / d];
  }

  function drawGrid() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 1;
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 外圆
    ctx.strokeStyle = '#3a4a61';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();

    // 等电阻圆: 圆心 (r/(r+1), 0), 半径 1/(r+1)
    ctx.strokeStyle = '#2c3a4e';
    ctx.fillStyle = '#6b7c93';
    for (const r of RGRID) {
      const [gx] = z2xy(r, 0);
      const rad = 1 / (r + 1);
      ctx.beginPath(); ctx.arc(cx + gx * R, cy, rad * R, 0, Math.PI * 2); ctx.stroke();
      ctx.fillText(String(r), cx + gx * R, cy + 10);
    }
    // x=0 直径
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();

    // 等电抗弧: 圆图坐标圆心 (1, 1/x)、半径 1/|x|, 取上/下半平面内的弧
    for (const x of XGRID) {
      for (const sgn of [1, -1]) {
        const xv = sgn * x;
        const ccx = cx + 1 * R, ccy = cy - (1 / xv) * R;
        const rad = (1 / Math.abs(xv)) * R;
        const px = x * x / (x * x + 1);
        const py = sgn * 2 * x / (x * x + 1);
        const ang0 = Math.atan2(-(1 / xv), -1);                    // 过 (1,0)
        const ang1 = Math.atan2(py - 1 / xv, px - 1);             // 过与外圆交点
        ctx.beginPath();
        ctx.arc(ccx, ccy, rad, ang1, ang0, sgn < 0);
        ctx.stroke();
        if (sgn > 0) ctx.fillText('+j' + x, cx + px * R - 4, cy - py * R - 7);
        else ctx.fillText('-j' + x, cx + px * R - 4, cy - py * R + 9);
      }
    }
    // 频率方向箭头 (沿外圆 toward generator = 顺时针)
    ctx.strokeStyle = '#5a6d88';
    ctx.fillStyle = '#5a6d88';
    const aa = -Math.PI * 0.30;
    ctx.beginPath();
    ctx.arc(cx, cy, R + 8, aa - 0.35, aa);
    ctx.stroke();
    ctx.beginPath();
    const ex = cx + (R + 8) * Math.cos(aa), ey = cy + (R + 8) * Math.sin(aa);
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex + 7 * Math.cos(aa + 0.5), ey + 7 * Math.sin(aa + 0.5));
    ctx.lineTo(ex + 7 * Math.cos(aa - 0.5), ey + 7 * Math.sin(aa - 0.5));
    ctx.closePath(); ctx.fill();
    ctx.fillText('向源端 →', cx, cy - R - 16);

    // 中心标记
    ctx.fillStyle = '#8fa3bd';
    ctx.beginPath(); ctx.arc(cx, cy, 2.2, 0, 7); ctx.fill();
  }

  function toPx(g) {
    // 反射系数 g={r,i} (i 为 +j 虚部, 图中上半为 +j)
    return [cx + g.r * R, cy - g.i * R];
  }

  function traceRows(rows, color, width, clipMag) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let pen = false;
    for (const row of rows) {
      const mag = Math.hypot(row.g_re, row.g_im);
      if (clipMag && mag > clipMag) { pen = false; continue; }
      const [px, py] = toPx({ r: row.g_re, i: row.g_im });
      if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  function dot(row, color, radius = 4, hollow = false) {
    const mag = Math.hypot(row.g_re, row.g_im);
    if (mag > 1.6) return;
    const [px, py] = toPx({ r: row.g_re, i: row.g_im });
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    if (hollow) { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke(); }
    else { ctx.fillStyle = color; ctx.fill(); }
  }

  function drawSteps(steps, z0) {
    // 逐段变换折线 + 标记。归一化阻抗 rz=R/Z0, ix=X/Z0, 图中上半平面为 +jX
    ctx.strokeStyle = '#4fa3ff88';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    steps.forEach((s, k) => {
      const rz = s.r / z0, ix = s.x / z0;
      const [gx, gy] = z2xy(rz, ix);
      const [px, py] = [cx + clamp16(gx) * R, cy - clamp16(gy) * R];
      if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
    steps.forEach((s, k) => {
      const rz = s.r / z0, ix = s.x / z0;
      const [gx, gy] = z2xy(rz, ix);
      ctx.fillStyle = k === steps.length - 1 ? '#7ee787' : '#9cc5ff';
      const [px, py] = [cx + clamp16(gx) * R, cy - clamp16(gy) * R];
      ctx.beginPath(); ctx.arc(px, py, k === steps.length - 1 ? 4.5 : 2.6, 0, 7);
      ctx.fill();
    });
  }

  function clamp16(v) { return Math.max(-1.6, Math.min(1.6, v)); }

  function pickGamma(evt) {
    const rect = canvas.getBoundingClientRect();
    const px = evt.clientX - rect.left, py = evt.clientY - rect.top;
    return { r: (px - cx) / R, i: -(py - cy) / R };
  }

  function render({ current, baseline, overlays, steps, z0, endDot }) {
    setup();
    drawGrid();
    if (baseline && baseline.length) traceRows(baseline, '#ffd166', 1.2, 1.6);
    if (overlays) for (const ov of overlays) traceRows(ov.rows, '#ff6b9d', 1.2, 1.6);
    if (current && current.length) {
      traceRows(current, '#4fa3ff', 2, null);
      // 起止频点
      dot(current[0], '#4fa3ff', 2.5);
      dot(current[current.length - 1], '#4fa3ff', 3.5);
    }
    if (steps) drawSteps(steps, z0);
    if (endDot) dot(endDot, '#7ee787', 5);
  }

  return { mount, render, pickGamma, toPx, get geom() { return { cx, cy, R }; } };
})();
