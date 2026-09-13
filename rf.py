"""射频匹配推演台 —— 复阻抗 / 馈线 / 支节 / 网络求解核心

约定:
  频率一律使用 Hz; 电阻/电抗 Ω; 电感 H; 电容 F; 长度 m。
  元件链按 "从负载到源" 的顺序排列, 逐段向右(源端)变换。

元件 kind:
  Lser / Cser   串联电感/电容        {value: H/F}
  Lpar / Cpar   并联电感/电容        {value: H/F}
  line          传输线段             {z0, length, vf, loss, lossf}  loss = dB/100m @ lossf(Hz)
  stub          并联支节             {z0, length, vf, loss, lossf, terminal: 'short'|'open'}
"""
import math
import cmath
import copy
import uuid

C0 = 299_792_458.0
TWO_PI = 2.0 * math.pi


# ---------------------------------------------------------------- 基础工具

def dbg(x):
    return 20.0 * math.log10(max(abs(x), 1e-12))


def vswr_of(gamma_mag):
    m = min(max(gamma_mag, 0.0), 0.999999)
    return (1.0 + m) / (1.0 - m)


def gamma_of(zin, z0):
    g = (zin - z0) / (zin + z0)
    if abs(zin + z0) < 1e-30:
        return complex(0)
    return g


def metrics(zin, z0):
    g = gamma_of(zin, z0)
    mag = abs(g)
    return {
        "zin": zin,
        "gamma": g,
        "s11": mag,
        "vswr": vswr_of(mag),
        "rl": min(-dbg(mag), 100.0) if mag > 1e-10 else 100.0,
    }


# ---------------------------------------------------------------- 传输线

def line_gamma(el, f):
    """返回 (gamma 传播常数 /m, beta /m, alpha Np/m, Z0)。"""
    vf = max(float(el.get("vf", 1.0)), 1e-3)
    beta = TWO_PI * f / (vf * C0)
    loss_db100 = float(el.get("loss", 0.0))
    lossf = max(float(el.get("lossf", f)), 1e3)
    # dB/100m -> Np/m: 1 Np = 8.6858896 dB (振幅), 故 alpha = loss*ln10/2000
    alpha = loss_db100 * math.log(10.0) / 2000.0  # Np/m @ lossf
    alpha *= math.sqrt(max(f / lossf, 1e-9))
    return complex(alpha, beta), beta, alpha, float(el["z0"])


def line_zin(zl, el, f):
    gam, _, _, z0 = line_gamma(el, f)
    gl = gam * float(el["length"])
    t = cmath.tanh(gl)
    return z0 * (zl + z0 * t) / (z0 + zl * t)


def stub_yin(el, f):
    """并联支节输入导纳。"""
    gam, _, _, z0 = line_gamma(el, f)
    gl = gam * float(el["length"])
    if el.get("terminal", "short") == "short":
        zin = z0 * cmath.tanh(gl)
    else:  # open
        zin = z0 / cmath.tanh(gl)
    if abs(zin) < 1e-12:
        return complex(0, 1e9)
    return 1.0 / zin


# ---------------------------------------------------------------- 链变换

def apply_element(z, el, f):
    k = el["kind"]
    w = TWO_PI * f
    if k == "Lser":
        return z + 1j * w * el["value"]
    if k == "Cser":
        return z + 1.0 / (1j * w * el["value"])
    if k == "Lpar":
        return 1.0 / (1.0 / z + 1.0 / (1j * w * el["value"]))
    if k == "Cpar":
        return 1.0 / (1.0 / z + 1j * w * el["value"])
    if k == "line":
        return line_zin(z, el, f)
    if k == "stub":
        return 1.0 / (1.0 / z + stub_yin(el, f))
    raise ValueError("未知元件类型: " + k)


def chain_input(zl, chain, f, trace=False):
    """从负载 ZL 起逐段变换到源端。trace=True 时返回每步 (el, z)。"""
    z = complex(zl)
    steps = [(None, z)]
    for el in chain:
        z = apply_element(z, el, f)
        steps.append((el, z))
    return (z, steps) if trace else z


# ---------------------------------------------------------------- 负载模型

def load_at(samples, f):
    """对 R/X 采样按频率分段线性插值, 区间外钳位。samples: [(fHz,R,X)...]"""
    s = sorted(samples, key=lambda t: t[0])
    if len(s) == 1:
        return complex(s[0][1], s[0][2])
    if f <= s[0][0]:
        return complex(s[0][1], s[0][2])
    if f >= s[-1][0]:
        return complex(s[-1][1], s[-1][2])
    for i in range(len(s) - 1):
        f0, r0, x0 = s[i]
        f1, r1, x1 = s[i + 1]
        if f0 <= f <= f1:
            t = (f - f0) / (f1 - f0) if f1 > f0 else 0.0
            return complex(r0 + t * (r1 - r0), x0 + t * (x1 - x0))
    return complex(s[-1][1], s[-1][2])


def sweep_range(cfg):
    f1 = cfg["band"][0] * 1e6
    f2 = cfg["band"][1] * 1e6
    fs = [row[0] for row in cfg["samples"]]  # samples 已经是 Hz
    if fs:
        f1 = min(f1, min(fs))
        f2 = max(f2, max(fs))
    # 采样/频段过窄时, 向两侧各扩展 0.5 倍目标带宽, 便于观察带外曲线
    span = (cfg["band"][1] - cfg["band"][0]) * 1e6
    mid = 0.5 * (f1 + f2)
    if f2 - f1 < span:
        f1, f2 = mid - 0.75 * span, mid + 0.75 * span
    return max(f1, 1e3), max(f2, f1 + 1e3)


def evaluate(cfg, chain, n=201):
    """扫频评估: 返回各频点指标 + 带内最差 VSWR / 有效带宽。"""
    flo, fhi = sweep_range(cfg)
    if fhi <= flo:
        fhi = flo * 1.01
    freqs = [flo + (fhi - flo) * i / (n - 1) for i in range(n)]
    z0 = cfg["z0"]
    rows = []
    for f in freqs:
        zl = load_at(cfg["samples"], f)
        zin = chain_input(zl, chain, f)
        m = metrics(zin, z0)
        rows.append({"f": f, "r": zin.real, "x": zin.imag,
                     "s11": m["s11"], "vswr": m["vswr"],
                     "rl": m["rl"], "g_re": m["gamma"].real,
                     "g_im": m["gamma"].imag})
    b1, b2 = cfg["band"][0] * 1e6, cfg["band"][1] * 1e6
    limit = cfg.get("vswr_limit", 2.0)
    inband = [r for r in rows if b1 - 1e-6 <= r["f"] <= b2 + 1e-6] or rows
    worst = max(r["vswr"] for r in inband)
    worst_f = max(inband, key=lambda r: r["vswr"])["f"]
    # 有效带宽: 包含频段中心的最长连续达标区间
    bw = _contiguous_bw(rows, b1, b2, limit)
    return {
        "rows": rows,
        "worst_vswr": worst,
        "worst_f": worst_f,
        "bw_hz": bw,
        "bw_frac": bw / max(b2 - b1, 1e-9),
        "pass_frac": sum(1 for r in inband if r["vswr"] <= limit) / len(inband),
    }


def _contiguous_bw(rows, b1, b2, limit):
    idxs = [i for i, r in enumerate(rows) if b1 - 1e-6 <= r["f"] <= b2 + 1e-6]
    if not idxs:
        return 0.0
    lo_i, hi_i = idxs[0], idxs[-1]
    mid = (lo_i + hi_i) // 2
    if rows[mid]["vswr"] > limit:
        return 0.0
    l = mid
    while l > lo_i and rows[l - 1]["vswr"] <= limit:
        l -= 1
    r = mid
    while r < hi_i and rows[r + 1]["vswr"] <= limit:
        r += 1
    if len(rows) > 1:
        df = rows[1]["f"] - rows[0]["f"]
        return (r - l + 1) * df
    return b2 - b1


# ---------------------------------------------------------------- 器件应力

RATING_KEYS = ("vmax", "imax", "pmax")   # 硬限制额定项; q 只影响损耗, 不参与判定


def power_levels(cfg):
    """(峰值包络功率 W, 热平均功率 W) ← 发射功率 / 峰均比 / 占空比。"""
    pw = cfg.get("power") or {}
    p = max(float(pw.get("p_w", 100.0)), 0.0)
    par = max(float(pw.get("par_db", 0.0)), 0.0)
    duty = min(max(float(pw.get("duty", 1.0)), 0.0), 1.0)
    return p * 10.0 ** (par / 10.0), p * duty


def has_ratings(el):
    return any(el.get(k) for k in RATING_KEYS)


def _el_abcd(el, f):
    """元件 ABCD (负载侧→源侧), 应力分析计入 Q 与传输线损耗 (匹配计算仍为理想)。"""
    k = el["kind"]
    w = TWO_PI * f
    one = 1.0 + 0.0j
    zero = 0.0 + 0.0j
    if k in ("Lser", "Cser"):
        x = w * el["value"] if k == "Lser" else -1.0 / (w * el["value"])
        q = el.get("q")
        z = complex(abs(x) / q, x) if q else complex(0.0, x)   # ESR = |X|/Q
        return one, z, zero, one
    if k in ("Lpar", "Cpar"):
        x = w * el["value"] if k == "Lpar" else -1.0 / (w * el["value"])
        q = el.get("q")
        y = complex(1.0 / (q * abs(x)), -1.0 / x) if q else complex(0.0, -1.0 / x)
        return one, zero, y, one
    if k == "line":
        gam, _, _, z0 = line_gamma(el, f)
        gl = gam * float(el["length"])
        ch, sh = cmath.cosh(gl), cmath.sinh(gl)
        return ch, z0 * sh, sh / z0, ch
    if k == "stub":
        return one, zero, stub_yin(el, f), one
    raise ValueError("未知元件类型: " + k)


def _wave_extremes(v_src, i_src, el, f):
    """已知源端 V/I, 求传输线(或支节)沿线 |V|max、|I|max (RMS)。
    V(x) = a·e^{γx} + b·e^{-γx}, 峰值位置解析枚举, 含端点。"""
    gam, beta, _, z0 = line_gamma(el, f)
    L = float(el["length"])
    if L <= 0.0 or beta <= 0.0:
        return abs(v_src), abs(i_src)

    def ext(p, q):
        best = abs(p + q)  # x = 0
        gl = gam * L
        best = max(best, abs(p * cmath.exp(gl) + q * cmath.exp(-gl)))  # x = L
        phi = cmath.phase(p * q.conjugate())
        # |V|² 中 cos(2βx+φ) 取 +1 的位置: x = (πk - φ/2)/β
        k_lo = int(math.floor(phi / TWO_PI)) + 1
        k_hi = int(math.floor((beta * L + phi / 2.0) / math.pi))
        for kk in range(k_lo, k_hi + 1):
            x = (math.pi * kk - phi / 2.0) / beta
            if 0.0 < x < L:
                gx = gam * x
                best = max(best, abs(p * cmath.exp(gx) + q * cmath.exp(-gx)))
        return best

    a = 0.5 * (v_src - i_src * z0)
    b = 0.5 * (v_src + i_src * z0)
    c = 0.5 * (i_src - v_src / z0)
    d = 0.5 * (i_src + v_src / z0)
    return ext(a, b), ext(c, d)


def stress_at(chain, zin, f, z0):
    """1W 可用功率下自源端向负载逐段反推 V/I, 求每段电压/电流/损耗 (RMS)。
    返回 {p_in, p_load, elements:[{uid,kind,v,i,p}], nodes:[(v,i)…](负载侧→源侧)}"""
    g = abs(gamma_of(zin, z0))
    p_in = max(1.0 - g * g, 0.0)
    elements = [{"uid": e.get("uid"), "kind": e["kind"], "v": 0.0, "i": 0.0, "p": 0.0}
                for e in chain]
    nodes = [(0.0j, 0.0j)] * (len(chain) + 1)
    if p_in <= 0.0 or zin.real <= 1e-9:
        return {"p_in": 0.0, "p_load": 0.0, "elements": elements, "nodes": nodes}
    i = complex(math.sqrt(p_in / zin.real), 0.0)
    v = i * zin
    nodes[len(chain)] = (v, i)
    for k in range(len(chain) - 1, -1, -1):
        el = chain[k]
        A, B, C, D = _el_abcd(el, f)
        v2 = D * v - B * i          # 互易网络 det=1, 逆矩阵 [D -B; -C A]
        i2 = A * i - C * v
        diss = max((v * i.conjugate()).real - (v2 * i2.conjugate()).real, 0.0)
        kk = el["kind"]
        if kk in ("Lser", "Cser"):
            ve, ie = abs(B * i), abs(i)
        elif kk in ("Lpar", "Cpar"):
            ve, ie = abs(v), abs(C * v)
        elif kk == "line":
            ve, ie = _wave_extremes(v, i, el, f)
        else:  # stub: 结电压 × 支节导纳 → 沿线极值
            ve, ie = _wave_extremes(v, v * stub_yin(el, f), el, f)
        elements[k] = {"uid": el.get("uid"), "kind": kk, "v": ve, "i": ie, "p": diss}
        v, i = v2, i2
        nodes[k] = (v, i)
    return {"p_in": p_in, "p_load": max((v * i.conjugate()).real, 0.0),
            "elements": elements, "nodes": nodes}


def _el_ratio(el, v, i, p):
    """(最差应力比, 主导额定项); 未设额定 → (None, None)。"""
    best = None
    governs = None
    for key, val in (("vmax", v), ("imax", i), ("pmax", p)):
        lim = el.get(key)
        if lim and lim > 0.0:
            r = val / lim
            if best is None or r > best:
                best, governs = r, key
    return best, governs


def stress_summary(cfg, chain, freqs):
    """扫频应力汇总: 每元件带内最差 V/I/P、最差应力比及频点、违规统计。
    电压/电流按峰值包络功率, 损耗按热平均功率; 违规阈值 = 1 - min_margin。"""
    z0 = cfg["z0"]
    p_peak, p_therm = power_levels(cfg)
    spk = math.sqrt(max(p_peak, 0.0))
    margin = min(max(float(cfg.get("min_margin", 0.2)), 0.0), 0.95)
    per = {}
    order = []
    for el in chain:
        uid = el.get("uid")
        if uid not in per:
            per[uid] = {"uid": uid, "kind": el["kind"],
                        "v": 0.0, "i": 0.0, "p": 0.0,
                        "v_f": None, "i_f": None, "p_f": None,
                        "rk": {}, "ratio": None, "ratio_f": None, "governs": None}
            order.append(uid)
    for f in freqs:
        zl = load_at(cfg["samples"], f)
        zin = chain_input(zl, chain, f)
        st = stress_at(chain, zin, f, z0)
        for el, rec in zip(chain, st["elements"]):
            a = per[el.get("uid")]
            vv, ii, pp = rec["v"] * spk, rec["i"] * spk, rec["p"] * p_therm
            if vv > a["v"]:
                a["v"], a["v_f"] = vv, f
            if ii > a["i"]:
                a["i"], a["i_f"] = ii, f
            if pp > a["p"]:
                a["p"], a["p_f"] = pp, f
            for key, val in (("vmax", vv), ("imax", ii), ("pmax", pp)):
                lim = el.get(key)
                if lim and lim > 0.0:
                    r = val / lim
                    cur = a["rk"].get(key)
                    if cur is None or r > cur[0]:
                        a["rk"][key] = (r, f)
                    if a["ratio"] is None or r > a["ratio"]:
                        a["ratio"], a["ratio_f"], a["governs"] = r, f, key
    violations = 0   # 超过 (1-最小裕量) 的 元件×额定 数
    hard = 0         # 超过 100% 额定 (硬限制) 的数
    worst_ratio = None
    worst_uid = worst_f = None
    for uid in order:
        a = per[uid]
        for key, (r, _f) in a["rk"].items():
            if r > 1.0:
                hard += 1
            if r > 1.0 - margin:
                violations += 1
        if a["ratio"] is not None and (worst_ratio is None or a["ratio"] > worst_ratio):
            worst_ratio, worst_uid, worst_f = a["ratio"], uid, a["ratio_f"]
    return {"rated": any(has_ratings(e) for e in chain),
            "violations": violations, "hard": hard,
            "worst_ratio": worst_ratio, "worst_uid": worst_uid, "worst_f": worst_f,
            "elements": per}


# ---------------------------------------------------------------- E 系列

E_BASE = {
    "E6":  [10, 15, 22, 33, 47, 68],
    "E12": [10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82],
    "E24": [10, 11, 12, 13, 15, 16, 18, 20, 22, 24, 27, 30,
            33, 36, 39, 43, 47, 51, 56, 62, 68, 75, 82, 91],
    "E96": [100, 102, 105, 107, 110, 113, 115, 118, 121, 124, 127, 130,
            133, 137, 140, 143, 147, 150, 154, 158, 162, 165, 169, 174,
            178, 182, 187, 191, 196, 200, 205, 210, 215, 221, 226, 232,
            237, 243, 249, 255, 261, 267, 274, 280, 287, 294, 301, 309,
            316, 324, 332, 340, 348, 357, 365, 374, 383, 392, 402, 412,
            422, 432, 442, 453, 464, 475, 487, 499, 511, 523, 536, 549,
            562, 576, 590, 604, 619, 634, 649, 665, 681, 698, 715, 732,
            750, 768, 787, 806, 825, 845, 866, 887, 909, 931, 953, 976],
}


def nearest_e(series, value):
    """在 E 系列中找最接近 value(>0) 的标准值, 允许跨数量级。"""
    base = E_BASE[series]
    scale = 10 ** math.floor(math.log10(value))
    mant = value / scale
    best = None
    for decade in (-1, 0, 1):
        for b in base:
            v = b / (base[0] / 10.0) * scale * (10.0 ** decade)
            if best is None or abs(v - value) < abs(best - value):
                best = v
    return best


# ---------------------------------------------------------------- 求解器

def _line_defaults(cfg, length):
    fd = cfg["feed"]
    el = {"kind": "line", "z0": fd["z0"], "length": length,
          "vf": fd["vf"], "loss": fd["loss"], "lossf": fd["lossf"]}
    for key in RATING_KEYS:          # 求解器生成的线段与主馈线同型号, 继承其额定
        if fd.get(key):
            el[key] = fd[key]
    return el


def _stub_defaults(cfg, length, terminal):
    el = _line_defaults(cfg, length)
    el["kind"] = "stub"
    el["terminal"] = terminal
    return el


def _split_chain(cfg):
    """用户元件按 place 拆分: before=天线侧(主馈线之前), after=源侧。"""
    before = [copy.deepcopy(e) for e in cfg["chain"] if e.get("place") == "before"]
    after = [copy.deepcopy(e) for e in cfg["chain"] if e.get("place") != "before"]
    return before, after


def _reference_chain(cfg):
    """到达求解参考面之前(负载侧)的已有链。
    plane=load 时计入天线侧用户元件; plane=source 时计入全部已有结构。"""
    before, after = _split_chain(cfg)
    if cfg.get("plane", "load") == "source":
        pre = list(before)
        if cfg.get("mainline"):
            pre.append(copy.deepcopy(cfg["mainline"]))
        pre.extend(after)
        return pre
    return before


def _reference_load(cfg, f):
    """在参考频率、参考面处看到的阻抗。"""
    zl0 = load_at(cfg["samples"], f)
    return chain_input(zl0, _reference_chain(cfg), f)


def _assemble(cfg, matcher, matcher_at):
    """拼成完整链 (负载 -> 源)。
    plane=load: 天线端匹配, 网络在主馈线之前。
    plane=source: 发射机端匹配, 网络在主馈线之后。"""
    ml = [copy.deepcopy(cfg["mainline"])] if cfg.get("mainline") else []
    m = copy.deepcopy(matcher)
    before, after = _split_chain(cfg)
    if cfg.get("plane", "load") == "load":
        return before + m + ml + after
    return before + ml + after + m


def _count_components(chain):
    return sum(1 for e in chain
               if e["kind"] in ("Lser", "Cser", "Lpar", "Cpar")) + \
        sum(1 for e in chain if e["kind"] == "stub")


def solve(cfg):
    """搜索 L 型网络 / 单支节候选。返回 {"candidates": [...], "excluded": n}。
    应力超过硬限制(额定 100%)的组合被排除; 候选按 违规数 → 最差裕量 →
    驻波比 → 带宽 → 元件数 排序。"""
    f0 = cfg.get("center") or 0.5 * (cfg["band"][0] + cfg["band"][1])
    f0 *= 1e6
    z0 = float(cfg["z0"])
    zl = _reference_load(cfg, f0)
    plane = cfg.get("plane", "load")
    at = plane  # 参考面即网络插入位置
    cands = []

    def make_candidate(cid, label, chain, stub_len=0.0):
        for e in chain:
            e.setdefault("uid", e.get("uid") or ("ml" if e.get("main") else uuid.uuid4().hex[:8]))
        ev = evaluate(cfg, chain, n=161)
        return {
            "id": cid, "label": label, "chain": chain,
            "worst_vswr": ev["worst_vswr"], "worst_f": ev["worst_f"],
            "bw_hz": ev["bw_hz"], "bw_frac": ev["bw_frac"],
            "count": _count_components(chain), "stub_len": stub_len,
            "rows": ev["rows"], "mc": None,
        }

    series = cfg.get("eseries", "E24")
    w = TWO_PI * f0
    R, X = zl.real, zl.imag
    n_out = [0]

    # ---------- L 型网络解析解
    D = R * R + X * X
    l_solutions = []  # (标签, [元件链 局部])

    # 拓扑 A: 并联(负载侧) + 串联(源侧), 条件 D >= R*z0
    if D >= R * z0 - 1e-9 and R > 1e-9:
        disc = R * (D - R * z0)
        if disc >= 0:
            for s in (+1, -1):
                bp = s * math.sqrt(max(disc, 0.0)) / (math.sqrt(z0) * D)
                B = X / D + bp
                Xs = bp * z0 * D / R
                par = _reactive_par(B, w)
                ser = _reactive_ser(Xs, w)
                if par and ser:
                    l_solutions.append(("L 型·并联%s+串联%s" % (par[1], ser[1]),
                                        [par[0], ser[0]]))

    # 拓扑 B: 串联(负载侧) + 并联(源侧), 条件 z0 >= R
    if z0 >= R - 1e-9 and R > 1e-9:
        disc2 = R * (z0 - R)
        for s in (+1, -1):
            X1 = s * math.sqrt(max(disc2, 0.0))
            Xs = X1 - X
            B = X1 / (R * z0) if R * z0 > 0 else 0.0
            ser = _reactive_ser(Xs, w)
            par = _reactive_par(B, w)
            if ser and par:
                l_solutions.append(("L 型·串联%s+并联%s" % (ser[1], par[1]),
                                    [ser[0], par[0]]))

    seen = set()
    for label, net in l_solutions:
        full = _assemble(cfg, net, at)
        sig = tuple(sorted((e["kind"], round(e.get("value", 0.0), 15)) for e in net))
        if sig in seen:
            continue
        seen.add(sig)
        n_out[0] += 1
        cids = []
        c = make_candidate("L%di" % n_out[0], label + "(理想值)", full)
        cands.append(c)
        # E 系列取整
        snapped = copy.deepcopy(full)
        snap_desc = []
        for e in snapped:
            if e["kind"] in ("Lser", "Lpar"):
                e["value"] = nearest_e(series, e["value"])
                snap_desc.append(fmt_l(e["value"]))
            elif e["kind"] in ("Cser", "Cpar"):
                e["value"] = nearest_e(series, e["value"])
                snap_desc.append(fmt_c(e["value"]))
        c2 = make_candidate("L%d" % n_out[0],
                            label + "(%s %s)" % (series, "/".join(snap_desc)), snapped)
        cands.append(c2)

    # ---------- 单支节 (数值搜索)
    fd = cfg["feed"]
    lam = fd["vf"] * C0 / f0
    z0l = fd["z0"]
    stub_cands = _stub_search(zl, z0l, fd, f0, lam)
    for terminal, d, l in stub_cands:
        seg = _line_defaults(cfg, d)
        stub = _stub_defaults(cfg, l, terminal)
        matcher = [seg, stub]
        full = _assemble(cfg, matcher, at)
        n_out[0] += 1
        tname = "短路" if terminal == "short" else "开路"
        label = "单支节·%s  d=%.3fm %s长=%.3fm" % (tname, d, tname, l)
        cands.append(make_candidate("S%d" % n_out[0], label, full, stub_len=l))

    # ---------- 应力校核: 排除超硬限制组合, 标注裕量违规
    b1, b2 = cfg["band"][0] * 1e6, cfg["band"][1] * 1e6
    ngrid = 61
    grid = [b1 + (b2 - b1) * i / (ngrid - 1) for i in range(ngrid)] if b2 > b1 else [b1]
    kept = []
    excluded = 0
    for c in cands:
        st = stress_summary(cfg, c["chain"], grid)
        c["stress"] = {"rated": st["rated"], "violations": st["violations"],
                       "worst_ratio": st["worst_ratio"], "worst_f": st["worst_f"],
                       "worst_uid": st["worst_uid"]}
        if st["hard"] > 0:
            excluded += 1
            continue
        kept.append(c)
    kept.sort(key=lambda c: (c["stress"]["violations"],
                             c["stress"]["worst_ratio"] if c["stress"]["worst_ratio"] is not None else 0.0,
                             round(c["worst_vswr"], 4),
                             -round(c["bw_hz"], 9), c["count"],
                             round(c["stub_len"], 9)))
    for i, c in enumerate(kept):
        c["rank"] = i + 1
    return {"candidates": kept, "excluded": excluded}


def _reactive_ser(x, w):
    if abs(x) < 1e-12:
        return None
    if x > 0:
        return {"kind": "Lser", "value": x / w}, "电感"
    return {"kind": "Cser", "value": -1.0 / (w * x)}, "电容"


def _reactive_par(b, w):
    if abs(b) < 1e-12:
        return None
    if b > 0:  # 并联容性电纳 +jwC
        return {"kind": "Cpar", "value": b / w}, "电容"
    return {"kind": "Lpar", "value": -1.0 / (w * b)}, "电感"


def _stub_search(zl, z0l, fd, f, lam):
    """在 d∈(0,λ/2] 上找使线输入导纳实部=1/Z0 的位置, 配支节抵消虚部。"""
    gam0 = complex(0.0, TWO_PI * f / (fd["vf"] * C0))
    rho = (zl - z0l) / (zl + z0l)

    def y_at(d):
        t = cmath.tanh(gam0 * d)
        zin = z0l * (zl + z0l * t) / (z0l + zl * t)
        return 1.0 / zin

    N = 2001
    ds = [lam * 0.5 * i / (N - 1) for i in range(1, N)]
    gvals = [y_at(d).real - 1.0 / z0l for d in ds]
    roots = []
    for i in range(len(ds) - 1):
        if gvals[i] == 0 or gvals[i] * gvals[i + 1] < 0:
            lo, hi = ds[i], ds[i + 1]
            for _ in range(40):
                mid = 0.5 * (lo + hi)
                if y_at(mid).real - 1.0 / z0l > 0:
                    if gvals[i] > 0:
                        lo = mid
                    else:
                        hi = mid
                else:
                    if gvals[i] > 0:
                        hi = mid
                    else:
                        lo = mid
            roots.append(0.5 * (lo + hi))

    out = []
    for terminal in ("short", "open"):
        for d in roots:
            B = -y_at(d).imag
            el = _stub_defaults({"feed": fd}, 0.0, terminal)
            l = _stub_length(B, el, f, lam)
            if l is None:
                continue
            d2, l2 = _refine_stub(zl, fd, f, d, l, terminal)
            out.append((terminal, d2, l2))
    # 去重(同终端 d 接近)
    out.sort(key=lambda t: (t[0], t[1]))
    uniq = []
    for t in out:
        if not uniq or abs(t[1] - uniq[-1][1]) > lam * 0.01 or t[0] != uniq[-1][0]:
            uniq.append(t)
    return uniq[:4]


def _stub_length(B, el, f, lam):
    """由所需并联电纳 B(S) 求支节长度 (0, λ/2]。"""
    z0s = el["z0"]
    if abs(B) < 1e-9:
        ang = 0.0
    else:
        if el["terminal"] == "short":  # B = -1/(Z0 tan βl)
            ang = math.atan(-1.0 / (B * z0s))
        else:                          # B = tan βl / Z0
            ang = math.atan(B * z0s)
    while ang <= 1e-9:
        ang += math.pi
    beta = TWO_PI * f / (el["vf"] * C0)
    l = ang / beta  # = ang*lam/2π
    if not (0.0 < l <= 0.5 * lam + 1e-9):
        return None
    return min(l, 0.5 * lam)


def _refine_stub(zl, fd, f, d, l, terminal, steps=4):
    """计入损耗后在 (d,l) 附近做小网格微调。"""
    best = (d, l)
    best_g = None
    for i in range(-steps, steps + 1):
        for j in range(-steps, steps + 1):
            dd = d * (1.0 + 0.02 * i / steps)
            ll = l * (1.0 + 0.02 * j / steps)
            seg = {"z0": fd["z0"], "length": dd, "vf": fd["vf"],
                   "loss": fd["loss"], "lossf": fd["lossf"]}
            stub = dict(seg, kind="stub", terminal=terminal, length=ll)
            z = line_zin(zl, seg, f)
            z = 1.0 / (1.0 / z + stub_yin(stub, f))
            g = abs(gamma_of(z, fd["z0"]))
            if best_g is None or g < best_g:
                best_g, best = g, (dd, ll)
    return best


# ---------------------------------------------------------------- 容差抽样

def _mulberry32(seed):
    a = seed & 0xFFFFFFFF

    def rnd():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = (((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF)
        t ^= t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0
    return rnd


def monte_carlo(cfg, chain, locks, seed=1, tol=0.05, len_tol=0.0, n=500):
    """固定种子按元件容差抽样。locks: 被锁定元件 uid 集合。
    返回电气(VSWR)达标比例; 链中有额定值时同时统计应力合格与双合格比例。"""
    rnd = _mulberry32(int(seed))
    b1, b2 = cfg["band"][0] * 1e6, cfg["band"][1] * 1e6
    limit = cfg.get("vswr_limit", 2.0)
    ngrid = 61
    grid = [b1 + (b2 - b1) * i / (ngrid - 1) for i in range(ngrid)]
    sgrid = grid[::2]  # 应力用半密度网格, 控制耗时
    has_rt = any(has_ratings(e) for e in chain)
    p_peak, p_therm = power_levels(cfg)
    spk = math.sqrt(max(p_peak, 0.0))
    z0 = cfg["z0"]
    worsts = []
    ratios = []
    passed = 0
    stress_ok = 0
    both_ok = 0
    for _ in range(n):
        trial = copy.deepcopy(chain)
        for e in trial:
            if e.get("uid") in locks:
                continue
            if e["kind"] in ("Lser", "Cser", "Lpar", "Cpar") and tol > 0:
                e["value"] *= 1.0 + (rnd() * 2.0 - 1.0) * tol
            elif e["kind"] in ("line", "stub") and len_tol > 0:
                e["length"] = max(0.0, e["length"] * (1.0 + (rnd() * 2.0 - 1.0) * len_tol))
        wmax = 0.0
        for f in grid:
            zl = load_at(cfg["samples"], f)
            zin = chain_input(zl, trial, f)
            wmax = max(wmax, metrics(zin, cfg["z0"])["vswr"])
        worsts.append(wmax)
        rmax = 0.0
        if has_rt:
            for f in sgrid:
                zl = load_at(cfg["samples"], f)
                zin = chain_input(zl, trial, f)
                st = stress_at(trial, zin, f, z0)
                for el, rec in zip(trial, st["elements"]):
                    r, _ = _el_ratio(el, rec["v"] * spk, rec["i"] * spk, rec["p"] * p_therm)
                    if r is not None and r > rmax:
                        rmax = r
            ratios.append(rmax)
        ok_v = wmax <= limit
        ok_s = rmax <= 1.0
        if ok_v:
            passed += 1
        if has_rt and ok_s:
            stress_ok += 1
        if ok_v and (not has_rt or ok_s):
            both_ok += 1
    worsts.sort()
    out = {
        "n": n, "seed": seed, "tol": tol, "len_tol": len_tol,
        "yield": passed / n,
        "p50": worsts[n // 2],
        "p95": worsts[min(n - 1, int(round(0.95 * (n - 1))))],
        "worst": worsts[-1],
        "stress_yield": (stress_ok / n) if has_rt else None,
        "both_yield": (both_ok / n) if has_rt else None,
    }
    if has_rt:
        ratios.sort()
        out["ratio_p50"] = ratios[n // 2]
        out["ratio_p95"] = ratios[min(n - 1, int(round(0.95 * (n - 1))))]
        out["ratio_worst"] = ratios[-1]
    return out


# ---------------------------------------------------------------- 显示格式

def fmt_l(v):
    a = abs(v)
    if a >= 0.1:
        return "%.3g H" % v
    if a >= 1e-4:
        return "%.3g mH" % (v * 1e3)
    if a >= 1e-7:
        return "%.3g µH" % (v * 1e6)
    return "%.3g nH" % (v * 1e9)


def fmt_c(v):
    a = abs(v)
    if a >= 1e-3:
        return "%.3g F" % v
    if a >= 1e-6:
        return "%.3g µF" % (v * 1e6)
    if a >= 1e-9:
        return "%.3g nF" % (v * 1e9)
    return "%.3g pF" % (v * 1e12)
