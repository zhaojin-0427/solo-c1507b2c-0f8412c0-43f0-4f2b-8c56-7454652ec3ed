"""射频匹配推演台 —— Flask 后端 + SQLite 存储。"""
import os
import sys
import json
import copy
import sqlite3
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))

from flask import Flask, request, jsonify, g, send_from_directory

import rf

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE, "matchlab.db")

app = Flask(__name__, static_folder=os.path.join(BASE, "static"), static_url_path="/static")


# ---------------------------------------------------------------- 数据库

def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def _close_db(exc):
    d = g.pop("db", None)
    if d is not None:
        d.close()


def init_db():
    con = sqlite3.connect(DB_PATH)
    con.execute(
        """CREATE TABLE IF NOT EXISTS projects (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL,
               updated REAL NOT NULL,
               state TEXT NOT NULL
           )""")
    con.execute(
        """CREATE TABLE IF NOT EXISTS versions (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               project_id INTEGER NOT NULL,
               label TEXT NOT NULL,
               created REAL NOT NULL,
               state TEXT NOT NULL,
               summary TEXT DEFAULT '',
               FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
           )""")
    con.commit()
    con.close()


# ---------------------------------------------------------------- 输入规整

def parse_samples(text):
    """解析粘贴的频率/R/X 采样。允许逗号/空白/分号/制表符分隔, 自动跳过非数字行。"""
    rows = []
    for raw in (text or "").splitlines():
        line = raw.replace(";", " ").replace(",", " ")
        parts = [p for p in line.split() if p]
        nums = []
        ok = True
        for p in parts:
            p2 = p.replace("MHz", "").replace("mhz", "").replace("f=", "").replace(
                "F=", "").replace("R=", "").replace("X=", "").replace("Ω", "").replace(
                "ohm", "").replace("Ohm", "").strip()
            try:
                nums.append(float(p2))
            except ValueError:
                ok = False
                break
        if ok and len(nums) >= 3:
            f, r, x = nums[0], nums[1], nums[2]
            if f > 0:
                rows.append((f * 1e6, r, x))
    rows.sort(key=lambda t: t[0])
    # 同频去重
    dedup = []
    for row in rows:
        if dedup and abs(row[0] - dedup[-1][0]) < 1e-3:
            dedup[-1] = row
        else:
            dedup.append(row)
    return dedup


def normalize_cfg(payload):
    feed_in = payload.get("feed") or {}
    band = payload.get("band") or [7.0, 7.3]
    flen = float(feed_in.get("length", 0.0))
    mainline = None
    if payload.get("feed_enabled", True) and flen > 0:
        mainline = {"kind": "line", "uid": "mainline", "main": True,
                    "z0": float(feed_in.get("z0", 50.0)), "length": flen,
                    "vf": float(feed_in.get("vf", 0.66)),
                    "loss": float(feed_in.get("loss", 0.0)),
                    "lossf": float(feed_in.get("lossf", 10.0)) * 1e6}
    cfg = {
        "z0": float(payload.get("z0", 50.0)),
        "band": [float(band[0]), float(band[1])],
        "vswr_limit": float(payload.get("vswr_limit", 2.0)),
        "eseries": payload.get("eseries", "E24"),
        "plane": payload.get("plane", "load"),
        "samples": parse_samples(payload.get("samples_text", "")),
        "mainline": mainline,
        # 客户端可能发"有效链"(含主馈线); 剔除其中的主馈线, 只保留用户元件
        "chain": [e for e in _clean_chain(payload.get("chain") or [])
                  if e.get("uid") != "mainline" and not e.get("main")],
        "feed": {
            "z0": float(feed_in.get("z0", 50.0)),
            "length": flen,
            "vf": float(feed_in.get("vf", 0.66)),
            "loss": float(feed_in.get("loss", 0.0)),
            "lossf": float(feed_in.get("lossf", 10.0)) * 1e6,
        },
    }
    return cfg


def _clean_chain(chain):
    out = []
    for e in chain:
        k = e.get("kind")
        el = {"kind": k, "uid": e.get("uid") or str(uuid.uuid4())[:8]}
        if k in ("Lser", "Cser", "Lpar", "Cpar"):
            el["value"] = float(e["value"])
        elif k in ("line", "stub"):
            el.update(z0=float(e.get("z0", 50.0)), length=float(e.get("length", 0.0)),
                      vf=float(e.get("vf", 0.66)), loss=float(e.get("loss", 0.0)),
                      lossf=float(e.get("lossf", 10e6)))
            if k == "line" and e.get("main"):
                el["main"] = True
            if k == "stub":
                el["terminal"] = e.get("terminal", "short")
        else:
            continue
        if e.get("place") == "before":
            el["place"] = "before"
        out.append(el)
    return out


def rows_json(rows):
    return [{"f": r["f"], "r": r["r"], "x": r["x"], "s11": r["s11"],
             "vswr": r["vswr"], "rl": r["rl"],
             "g_re": r["g_re"], "g_im": r["g_im"]} for r in rows]


# ---------------------------------------------------------------- API: 计算

def full_chain(cfg, extra=None):
    """实际参与计算的链: 天线侧用户元件 + [主馈线] + 源侧用户元件 + 附加链。"""
    before = [copy.deepcopy(e) for e in cfg["chain"] if e.get("place") == "before"]
    after = [copy.deepcopy(e) for e in cfg["chain"] if e.get("place") != "before"]
    out = list(before)
    if cfg.get("mainline"):
        out.append(copy.deepcopy(cfg["mainline"]))
    out.extend(after)
    if extra:
        out.extend(copy.deepcopy(extra))
    return out


@app.post("/api/evaluate")
def api_evaluate():
    cfg = normalize_cfg(request.get_json(force=True))
    if not cfg["samples"]:
        return jsonify({"error": "未解析到有效的 频率/电阻/电抗 采样"}), 400
    ev = rf.evaluate(cfg, full_chain(cfg), n=201)
    return jsonify({"rows": rows_json(ev["rows"]),
                    "worst_vswr": ev["worst_vswr"], "worst_f": ev["worst_f"],
                    "bw_hz": ev["bw_hz"], "bw_frac": ev["bw_frac"],
                    "pass_frac": ev["pass_frac"]})


@app.post("/api/trace")
def api_trace():
    """指定频点逐段追溯复阻抗变换。"""
    p = request.get_json(force=True)
    cfg = normalize_cfg(p)
    if not cfg["samples"]:
        return jsonify({"error": "无采样"}), 400
    f = float(p["f"]) * 1e6
    zl = rf.load_at(cfg["samples"], f)
    z, steps = rf.chain_input(zl, full_chain(cfg), f, trace=True)
    out = []
    for i, (el, zz) in enumerate(steps):
        m = rf.metrics(zz, cfg["z0"])
        out.append({"index": i, "element": el,
                    "r": zz.real, "x": zz.imag,
                    "g": (1.0 / zz).real, "b": (1.0 / zz).imag,
                    "g_re": m["gamma"].real, "g_im": m["gamma"].imag,
                    "vswr": m["vswr"], "rl": m["rl"]})
    return jsonify({"f": f, "steps": out})


@app.post("/api/solve")
def api_solve():
    cfg = normalize_cfg(request.get_json(force=True))
    if not cfg["samples"]:
        return jsonify({"error": "未解析到有效的采样"}), 400
    if cfg["band"][1] <= cfg["band"][0]:
        return jsonify({"error": "目标频段无效"}), 400
    cands = rf.solve(cfg)
    for c in cands:
        c["rows"] = rows_json(c["rows"])
    return jsonify({"candidates": cands})


@app.post("/api/montecarlo")
def api_montecarlo():
    p = request.get_json(force=True)
    cfg = normalize_cfg(p)
    raw_chain = p.get("candidate_chain")
    if raw_chain:
        # 候选链已是完整链(含标记为主馈线的段), 直接整体抽样
        cfg["mainline"] = None
        cfg["chain"] = _clean_chain(raw_chain)
    chain = full_chain(cfg)
    locks = set(p.get("locks") or [])
    mc = rf.monte_carlo(cfg, chain, locks,
                        seed=int(p.get("seed", 1)),
                        tol=float(p.get("tol", 0.05)),
                        len_tol=float(p.get("len_tol", 0.0)),
                        n=int(p.get("n", 500)))
    return jsonify(mc)


# ---------------------------------------------------------------- API: 项目

@app.get("/api/projects")
def api_projects():
    con = db()
    items = con.execute("SELECT id, name, updated FROM projects ORDER BY updated DESC").fetchall()
    return jsonify([dict(i) for i in items])


@app.post("/api/projects")
def api_project_save():
    p = request.get_json(force=True)
    name = (p.get("name") or "未命名项目").strip()[:80]
    state = json.dumps(p.get("state", {}), ensure_ascii=False)
    con = db()
    pid = p.get("id")
    now = time.time()
    if pid:
        con.execute("UPDATE projects SET name=?, updated=?, state=? WHERE id=?",
                    (name, now, state, pid))
    else:
        cur = con.execute("INSERT INTO projects(name, updated, state) VALUES(?,?,?)",
                          (name, now, state))
        pid = cur.lastrowid
    con.commit()
    return jsonify({"id": pid, "name": name, "updated": now})


@app.get("/api/projects/<int:pid>")
def api_project_get(pid):
    row = db().execute("SELECT * FROM projects WHERE id=?", (pid,)).fetchone()
    if not row:
        return jsonify({"error": "项目不存在"}), 404
    return jsonify({"id": row["id"], "name": row["name"],
                    "updated": row["updated"], "state": json.loads(row["state"])})


@app.delete("/api/projects/<int:pid>")
def api_project_delete(pid):
    con = db()
    con.execute("DELETE FROM versions WHERE project_id=?", (pid,))
    con.execute("DELETE FROM projects WHERE id=?", (pid,))
    con.commit()
    return jsonify({"ok": True})


@app.get("/api/projects/<int:pid>/versions")
def api_versions(pid):
    items = db().execute(
        "SELECT id, label, created, summary FROM versions WHERE project_id=? ORDER BY created DESC",
        (pid,)).fetchall()
    return jsonify([dict(i) for i in items])


@app.post("/api/projects/<int:pid>/versions")
def api_version_save(pid):
    p = request.get_json(force=True)
    con = db()
    if not con.execute("SELECT 1 FROM projects WHERE id=?", (pid,)).fetchone():
        return jsonify({"error": "项目不存在"}), 404
    label = (p.get("label") or time.strftime("%Y-%m-%d %H:%M"))[:80]
    summary = (p.get("summary") or "")[:200]
    state = json.dumps(p.get("state", {}), ensure_ascii=False)
    cur = con.execute(
        "INSERT INTO versions(project_id,label,created,state,summary) VALUES(?,?,?,?,?)",
        (pid, label, time.time(), state, summary))
    con.commit()
    return jsonify({"id": cur.lastrowid, "label": label})


@app.get("/api/versions/<int:vid>")
def api_version_get(vid):
    row = db().execute("SELECT * FROM versions WHERE id=?", (vid,)).fetchone()
    if not row:
        return jsonify({"error": "版本不存在"}), 404
    return jsonify({"id": row["id"], "project_id": row["project_id"],
                    "label": row["label"], "created": row["created"],
                    "state": json.loads(row["state"])})


@app.delete("/api/versions/<int:vid>")
def api_version_delete(vid):
    con = db()
    con.execute("DELETE FROM versions WHERE id=?", (vid,))
    con.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------- 页面

@app.get("/favicon.svg")
def favicon():
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
           '<circle cx="16" cy="16" r="14" fill="none" stroke="#4fa3ff" stroke-width="2"/>'
           '<path d="M4 16h24M16 2a14 10 0 0 1 0 28M16 2a14 10 0 0 0 0 28" '
           'fill="none" stroke="#4fa3ff" stroke-width="1.4" opacity="0.7"/>'
           '<circle cx="20" cy="12" r="2.4" fill="#7ee787"/></svg>')
    from flask import Response
    return Response(svg, mimetype="image/svg+xml")


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    init_db()
    app.run(host="0.0.0.0", port=5000, debug=False)
