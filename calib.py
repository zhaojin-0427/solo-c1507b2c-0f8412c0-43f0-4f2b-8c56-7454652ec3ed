"""一端口 OSL 校准 —— 标准件模型 / 扫线解析 / 最小二乘求解 / 修正

约定 (与 rf.py 一致): 频率 Hz, 电容 F, 电感 H, 延时 s,
损耗 dB (单向幅度, 参考频率 loss_f Hz, 按 sqrt(f/loss_f) 缩放)。

三系数误差模型:
    Γm = ed + er·Γt / (1 - es·Γt)     ed 方向性 / es 源匹配 / er 反射跟踪
线性化为 Γm = a + b·Γt + c·Γt·Γm (a = ed, c = es, er = b + a·c),
在共同频点上对全部标准件扫线做复最小二乘。
修正: Γa = (Γm - ed) / (er + es·(Γm - ed))
"""
import cmath
import hashlib
import json
import math

TWO_PI = 2.0 * math.pi
LN10_20 = math.log(10.0) / 20.0

STD_KEYS = ("open", "short", "load")
STD_LABEL = {"open": "开路", "short": "短路", "load": "负载"}

RESIDUAL_LIMIT = 0.02   # 残差检查门限 (|Γ| 单位)
COND_WARN = 1e7         # 正规方程条件数警示阈值
COND_DROP = 1e10        # 条件数超过则剔除该频点


# ---------------------------------------------------------------- 标准件模型

def _fnum(v, default):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    return x if math.isfinite(x) else default


def normalize_standards(raw, z0=50.0):
    """规整标准件定义 (SI 单位)。缺省 = 理想开路/短路/匹配负载, 无偏移。"""
    out = {}
    for key in STD_KEYS:
        d = (raw or {}).get(key) or {}
        el = {"delay": max(_fnum(d.get("delay"), 0.0), 0.0),
              "loss": max(_fnum(d.get("loss"), 0.0), 0.0),
              "loss_f": max(_fnum(d.get("loss_f"), 1e9), 1.0)}
        if key == "open":
            el["c"] = max(_fnum(d.get("c"), 0.0), 0.0)
        elif key == "short":
            el["l"] = max(_fnum(d.get("l"), 0.0), 0.0)
        else:
            el["r"] = max(_fnum(d.get("r"), z0), 1e-6)
        out[key] = el
    return out


def gamma_true(std_key, std, f, z0):
    """标准件在校准参考面的真实反射系数 (含偏移延时与损耗)。"""
    w = TWO_PI * f
    if std_key == "open":
        c = std.get("c", 0.0)
        zt = complex(0.0, -1.0 / (w * c)) if c > 0.0 else complex(1e30, 0.0)
    elif std_key == "short":
        zt = complex(0.0, w * std.get("l", 0.0))
    else:
        zt = complex(std.get("r", z0), 0.0)
    gt = (zt - z0) / (zt + z0)
    tau = std.get("delay", 0.0)
    loss = std.get("loss", 0.0)
    if tau > 0.0 or loss > 0.0:
        alpha = loss * LN10_20 * math.sqrt(max(f / max(std.get("loss_f", 1e9), 1.0), 1e-12))
        gt *= cmath.exp(-2.0 * complex(alpha, w * tau))
    return gt


# ---------------------------------------------------------------- 扫线解析

UNIT_MULT = {"hz": 1.0, "khz": 1e3, "mhz": 1e6, "ghz": 1e9}


def _to_gamma(fmt, a, b):
    if fmt == "ri":
        return complex(a, b)
    mag = 10.0 ** (a / 20.0) if fmt == "db" else a
    ph = math.radians(b)
    return complex(mag * math.cos(ph), mag * math.sin(ph))


def parse_reflection_text(text, fmt="ri", unit="mhz"):
    """解析粘贴的 频率+a+b 数据; 含 '#' 选项行时按 Touchstone .s1p 解析。
    返回 (points, warns): points=[(f_hz, re, im)] 升序, warns=[(kind, msg)]。"""
    fmt = (fmt or "ri").lower()
    if fmt not in ("ri", "ma", "db"):
        fmt = "ri"
    mult = UNIT_MULT.get((unit or "mhz").lower(), 1e6)
    raw = []
    for line in (text or "").splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("!"):
            continue
        if s.startswith("#"):                      # Touchstone 选项行: # MHz S MA R 50
            for t in s[1:].lower().split():
                if t in UNIT_MULT:
                    mult = UNIT_MULT[t]
                elif t in ("ri", "ma", "db"):
                    fmt = t
            continue
        s = s.split("!")[0]
        parts = s.replace(",", " ").replace(";", " ").split()
        nums = []
        ok = True
        for p in parts:
            p2 = (p.replace("MHz", "").replace("mhz", "")
                   .replace("GHz", "").replace("ghz", "")
                   .replace("kHz", "").replace("khz", "")
                   .replace("f=", "").replace("F=", "").strip())
            try:
                nums.append(float(p2))
            except ValueError:
                ok = False
                break
        if ok and len(nums) >= 3 and nums[0] > 0:
            raw.append((nums[0], nums[1], nums[2]))
    warns = []
    if len(raw) >= 2:
        if all(raw[i][0] > raw[i + 1][0] for i in range(len(raw) - 1)):
            warns.append(("order", "频率顺序颠倒(降序), 已自动反转"))
        elif any(raw[i][0] > raw[i + 1][0] for i in range(len(raw) - 1)):
            warns.append(("order", "频率顺序错乱(非递增), 已自动排序"))
    rows = sorted(raw, key=lambda t: t[0])
    pts = []
    dups = 0
    for fv, a, b in rows:
        f = fv * mult
        g = _to_gamma(fmt, a, b)
        if pts and abs(f - pts[-1][0]) <= max(pts[-1][0], 1.0) * 1e-9:
            pts[-1] = (f, g.real, g.imag)
            dups += 1
        else:
            pts.append((f, g.real, g.imag))
    if dups:
        warns.append(("order", "存在 %d 个重复频点, 已保留最后值" % dups))
    if pts:
        f_hi, f_lo = pts[-1][0], pts[0][0]
        if f_hi < 1e6:
            warns.append(("unit", "最高频点仅 %.4g Hz, 与射频频段不符 — "
                                   "疑似频率单位错误(如 MHz 被按 Hz 解析)" % f_hi))
        elif f_lo > 1e12:
            warns.append(("unit", "最低频点高达 %.4g Hz — "
                                  "疑似频率单位错误(如 Hz 被按 MHz 解析)" % f_lo))
    return pts, warns


# ---------------------------------------------------------------- 复数 3x3 最小二乘

def _solve3(m, y):
    """解 3x3 复线性方程组 m·x = y (高斯-约当消元, 部分主元)。
    返回 (x, cond): cond 为 Frobenius 条件数估计, 奇异时 inf。"""
    a = [row[:] for row in m]
    x = list(y)
    inv = [[1.0 if i == j else 0.0 for j in range(3)] for i in range(3)]
    for col in range(3):
        p = max(range(col, 3), key=lambda r: abs(a[r][col]))
        if abs(a[p][col]) < 1e-30:
            return [0j, 0j, 0j], float("inf")
        if p != col:
            a[col], a[p] = a[p], a[col]
            x[col], x[p] = x[p], x[col]
            inv[col], inv[p] = inv[p], inv[col]
        for r in range(3):
            if r == col:
                continue
            factor = a[r][col] / a[col][col]
            if factor:
                for k in range(col, 3):
                    a[r][k] -= factor * a[col][k]
                x[r] -= factor * x[col]
                for k in range(3):
                    inv[r][k] -= factor * inv[col][k]
    for i in range(3):
        d = a[i][i]
        x[i] /= d
        for k in range(3):
            inv[i][k] /= d
    norm_m = math.sqrt(sum(abs(v) ** 2 for row in m for v in row))
    norm_i = math.sqrt(sum(abs(v) ** 2 for row in inv for v in row))
    return x, norm_m * norm_i


def _ls3(rows):
    """最小二乘拟合 Γm = a + b·Γt + c·Γt·Γm。rows: [(gt, gm)…]
    返回 (a, b, c, cond)。"""
    m = [[0j] * 3 for _ in range(3)]
    y = [0j] * 3
    for gt, gm in rows:
        r = (1.0 + 0j, gt, gt * gm)
        for i in range(3):
            ci = r[i].conjugate()
            y[i] += ci * gm
            for j in range(3):
                m[i][j] += ci * r[j]
    x, cond = _solve3(m, y)
    return x[0], x[1], x[2], cond


def _interp_points(points, f):
    """[(f,re,im)] 升序复线性插值, 区间外钳位。"""
    if f <= points[0][0]:
        return complex(points[0][1], points[0][2])
    if f >= points[-1][0]:
        return complex(points[-1][1], points[-1][2])
    lo, hi = 0, len(points) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if points[mid][0] <= f:
            lo = mid
        else:
            hi = mid
    f0, r0, i0 = points[lo]
    f1, r1, i1 = points[hi]
    t = (f - f0) / (f1 - f0) if f1 > f0 else 0.0
    return complex(r0 + t * (r1 - r0), i0 + t * (i1 - i0))


# ---------------------------------------------------------------- OSL 求解

def solve_osl(standards, sweeps_by_std, z0, residual_limit=RESIDUAL_LIMIT):
    """在共同频点上最小二乘求解三系数误差模型。
    sweeps_by_std: {std: [{"label": str, "points": [(f,re,im)…]}…]} (每件可多次扫线)
    返回结果 dict; ok=False 时无系数。"""
    diags = []
    for key in STD_KEYS:
        if not sweeps_by_std.get(key):
            diags.append({"level": "error", "kind": "missing",
                          "msg": "缺少%s标准件扫线" % STD_LABEL[key]})
    if any(d["level"] == "error" for d in diags):
        return _failed(diags, residual_limit)

    all_sw = [(key, j, sw["label"], sw["points"])
              for key in STD_KEYS for j, sw in enumerate(sweeps_by_std[key])]
    lo = max(sw[3][0][0] for sw in all_sw)
    hi = min(sw[3][-1][0] for sw in all_sw)
    if hi <= lo:
        diags.append({"level": "error", "kind": "gap",
                      "msg": "各标准件扫线频率范围无交集 — 请检查频率单位是否一致"})
        return _failed(diags, residual_limit)

    def in_range(pts):
        return [p for p in pts if lo - 1e-3 <= p[0] <= hi + 1e-3]

    # 共同频点网格: 取交集内最稀疏的扫线, 其余扫线插值到该网格
    ref = min(all_sw, key=lambda t: len(in_range(t[3])))
    grid = [p[0] for p in in_range(ref[3])]
    if len(grid) < 2:
        diags.append({"level": "error", "kind": "gap",
                      "msg": "共同频段内频点不足(<2 点), 无法求解"})
        return _failed(diags, residual_limit)

    # 覆盖缺口: 网格间隔远大于中位间隔
    if len(grid) >= 3:
        steps = [grid[i + 1] - grid[i] for i in range(len(grid) - 1)]
        med = sorted(steps)[len(steps) // 2]
        n_gap = 0
        for i, s in enumerate(steps):
            if med > 0 and s > 3.0 * med:
                n_gap += 1
                if n_gap <= 5:
                    diags.append({"level": "warn", "kind": "gap",
                                  "msg": "共同频点存在覆盖缺口: %.4f~%.4f MHz"
                                         % (grid[i] / 1e6, grid[i + 1] / 1e6)})

    if len(all_sw) == 3:
        diags.append({"level": "info", "kind": "redundancy",
                      "msg": "每件标准件仅 1 组扫线: 方程恰好定解, 残差恒为 0 — "
                             "建议每件标准件提供 ≥2 组扫线以暴露重复性问题"})

    # 逐频点最小二乘
    freqs, eds, ess, ers, conds, rmss = [], [], [], [], [], []
    std_res = {k: [] for k in STD_KEYS}
    sweep_sq = {(key, j): [] for key, j, _l, _p in all_sw}
    n_cond_warn = n_drop = bad_pts = 0
    worst_cond = (0.0, None)
    worst_rms = (0.0, None)
    for f in grid:
        rows = []
        meta = []
        for key, j, _label, pts in all_sw:
            gm = _interp_points(pts, f)
            gt = gamma_true(key, standards[key], f, z0)
            rows.append((gt, gm))
            meta.append((key, j))
        a, b, c, cond = _ls3(rows)
        if not math.isfinite(cond) or cond > COND_DROP:
            n_drop += 1
            continue
        ed, es, er = a, c, b + a * c
        res2 = []
        per_std = {k: [] for k in STD_KEYS}
        for (gt, gm), (key, j) in zip(rows, meta):
            gm_model = ed + er * gt / (1.0 - es * gt)
            r2 = abs(gm - gm_model) ** 2
            res2.append(r2)
            per_std[key].append(r2)
            sweep_sq[(key, j)].append(r2)
        rms = math.sqrt(sum(res2) / len(res2))
        if cond > COND_WARN:
            n_cond_warn += 1
        if cond > worst_cond[0]:
            worst_cond = (cond, f)
        if rms > residual_limit:
            bad_pts += 1
        if rms > worst_rms[0]:
            worst_rms = (rms, f)
        freqs.append(f)
        eds.append([ed.real, ed.imag])
        ess.append([es.real, es.imag])
        ers.append([er.real, er.imag])
        conds.append(cond)
        rmss.append(rms)
        for key in STD_KEYS:
            std_res[key].append(math.sqrt(sum(per_std[key]) / len(per_std[key])))

    if n_drop:
        diags.append({"level": "warn", "kind": "cond",
                      "msg": "方程病态: %d 个频点正规方程条件数 > %.0e, 已剔除"
                             % (n_drop, COND_DROP)})
    if len(freqs) < 2:
        diags.append({"level": "error", "kind": "cond",
                      "msg": "方程病态: 有效频点不足, 无法求解"})
        return _failed(diags, residual_limit)
    if n_cond_warn:
        diags.append({"level": "warn", "kind": "cond",
                      "msg": "方程病态风险: %d 个频点条件数 > %.0e (最差 %.2e @ %.4f MHz)"
                             % (n_cond_warn, COND_WARN, worst_cond[0],
                                (worst_cond[1] or 0.0) / 1e6)})

    # 重复扫线残差: 每组扫线对模型的 RMS 偏差
    sweeps_rep = []
    over_limit = False
    for (key, j), sq in sorted(sweep_sq.items()):
        if not sq:
            continue
        r = math.sqrt(sum(sq) / len(sq))
        over = r > residual_limit
        over_limit = over_limit or over
        sweeps_rep.append({"standard": key, "index": j, "rms": r, "over": over})
    for s in sweeps_rep:
        if s["over"]:
            diags.append({"level": "warn", "kind": "residual",
                          "msg": "重复扫线残差超限: %s 第%d组 RMS=%.4f > 门限 %.4f"
                                 % (STD_LABEL[s["standard"]], s["index"] + 1,
                                    s["rms"], residual_limit)})

    rms_global = math.sqrt(sum(r * r for r in rmss) / len(rmss))
    if bad_pts:
        diags.append({"level": "warn", "kind": "residual",
                      "msg": "%d 个频点残差超限 (最差 %.4f @ %.4f MHz)"
                             % (bad_pts, worst_rms[0], (worst_rms[1] or 0.0) / 1e6)})
    if rms_global > residual_limit:
        diags.append({"level": "warn", "kind": "residual",
                      "msg": "整体残差 RMS %.4f 超出门限 %.4f" % (rms_global, residual_limit)})

    residual_ok = rms_global <= residual_limit and not over_limit and bad_pts == 0
    return {
        "ok": True, "residual_ok": residual_ok,
        "diagnostics": diags,
        "freqs": freqs, "ed": eds, "es": ess, "er": ers,
        "cond": conds, "rms": rmss, "std_res": std_res,
        "rms_global": rms_global, "residual_limit": residual_limit,
        "f_range": [freqs[0], freqs[-1]], "n_points": len(freqs),
        "sweeps": sweeps_rep,
    }


def _failed(diags, limit):
    return {"ok": False, "residual_ok": False, "diagnostics": diags,
            "freqs": [], "rms_global": None, "residual_limit": limit}


# ---------------------------------------------------------------- 待测件修正

def _interp_array(freqs, vals, f):
    """在求解网格上线性插值 (标量或 [re,im]), 区间外钳位。"""
    if f <= freqs[0]:
        return vals[0]
    if f >= freqs[-1]:
        return vals[-1]
    lo, hi = 0, len(freqs) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if freqs[mid] <= f:
            lo = mid
        else:
            hi = mid
    t = (f - freqs[lo]) / (freqs[hi] - freqs[lo]) if freqs[hi] > freqs[lo] else 0.0
    v0, v1 = vals[lo], vals[hi]
    if isinstance(v0, (list, tuple)):
        return [v0[0] + t * (v1[0] - v0[0]), v0[1] + t * (v1[1] - v0[1])]
    return v0 + t * (v1 - v0)


def _z_of_gamma(g, z0):
    d = 1.0 - g
    if abs(d) < 1e-12:
        return complex(1e12, 0.0)
    return z0 * (1.0 + g) / d


def correct_points(solution, points, z0):
    """用求解结果修正待测件扫线。points=[(f,re,im)]。
    返回 (rows, dropped): 校准覆盖范围外的频点被丢弃并计数。"""
    freqs = solution["freqs"]
    lo, hi = freqs[0], freqs[-1]
    rows = []
    dropped = 0
    for f, re, im in points:
        if f < lo - 1e-3 or f > hi + 1e-3:
            dropped += 1
            continue
        ed = _interp_array(freqs, solution["ed"], f)
        es = _interp_array(freqs, solution["es"], f)
        er = _interp_array(freqs, solution["er"], f)
        edc, esc, erc = complex(*ed), complex(*es), complex(*er)
        gm = complex(re, im)
        num = gm - edc
        den = erc + esc * num
        ga = num / den if abs(den) > 1e-30 else complex(0.0)
        zr = _z_of_gamma(gm, z0)
        zc = _z_of_gamma(ga, z0)
        rows.append({
            "f": f,
            "gr": [gm.real, gm.imag], "gc": [ga.real, ga.imag],
            "zr": [zr.real, zr.imag], "zc": [zc.real, zc.imag],
            "ed": ed, "es": es, "er": er,
            "cond": _interp_array(freqs, solution["cond"], f),
            "rms": _interp_array(freqs, solution["rms"], f),
            "std": {k: _interp_array(freqs, solution["std_res"][k], f)
                    for k in STD_KEYS},
        })
    return rows, dropped


# ---------------------------------------------------------------- 溯源哈希

def solution_digest(solution):
    """求解结果摘要哈希 (采用时冻结, 用于输入哈希溯源)。"""
    payload = json.dumps({k: solution[k] for k in ("freqs", "ed", "es", "er")},
                         sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


def input_hash(kit_id, digest, points):
    """校准组 + 求解摘要 + 待测件原始输入 的联合哈希。"""
    h = hashlib.sha256()
    h.update(("kit:%d;" % kit_id).encode())
    h.update(digest.encode())
    for f, re, im in points:
        h.update(("%.6e,%.6e,%.6e;" % (f, re, im)).encode())
    return h.hexdigest()
