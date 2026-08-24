# -*- coding: utf-8 -*-
"""
TrackFeature 埋点验证核心工具。

子命令：
  cols                          打印 t_app_log 列结构
  devicekeys [--after-id ID]    列出高水位后的设备 session_ref
  dist [--after-id ID]          高水位后的 event_id 分布统计
  latest EVENT_ID [opts]        打印某事件最近一条记录（全字段）
  audit [opts]                  对 catalog 中全部事件做字段校验，输出 JSON 结果
  watermark                     读取全表 MAX(id) 高水位
  verify EVENT_ID [opts]        仅校验 id > 高水位的新记录

通用 opts：
  --device KEY     仅匹配该 device_key（输出只保留单向 session_ref）
  --after-id ID    全表 MAX(id) 基线；验收查询只允许 id > ID
  --out FILE       结果写入文件（JSON）
凭据从 config/db.json 读取（已 gitignore）。
"""
import sys, os, json, argparse, time, hashlib, re

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_TABLE = "t_app_log"
SAFE_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_ACTIVE_DB_CONFIG = None


def configure_db(path=None):
    """设置本进程 DB 配置覆盖；路径与配置内容都不会写入验收输出。"""
    global _ACTIVE_DB_CONFIG
    _ACTIVE_DB_CONFIG = str(path) if path else None


def db_config_path(path=None):
    return (
        str(path)
        if path
        else _ACTIVE_DB_CONFIG
        or os.environ.get("TRACKFEATURE_DB_CONFIG")
        or os.path.join(BASE, "config", "db.json")
    )


def load_cfg(path=None):
    try:
        with open(db_config_path(path), encoding="utf-8") as f:
            value = json.load(f)
        if not isinstance(value, dict):
            raise ValueError
        return value
    except Exception:
        raise RuntimeError("DB 配置不可用（路径与凭据已隐藏）") from None


def load_catalog():
    with open(os.path.join(BASE, "catalog", "events.json"), encoding="utf-8") as f:
        return json.load(f)


def connect(config_path=None):
    import pymysql
    if config_path:
        configure_db(config_path)
    c = load_cfg()
    try:
        return pymysql.connect(
            host=c["host"], port=int(c["port"]), user=c["user"],
            password=c["password"], database=c["database"],
            charset=c.get("charset", "utf8mb4"), connect_timeout=8,
            cursorclass=pymysql.cursors.DictCursor,
            autocommit=True,  # 否则 REPEATABLE READ 下长连接看不到查询后新插入的行（轮询验证会一直 missing）
        )
    except Exception:
        raise RuntimeError("DB 连接失败（host/凭据详情已隐藏）") from None


def table():
    try:
        name = load_cfg().get("table", DEFAULT_TABLE)
    except RuntimeError:
        # 纯单元测试不需要本地私密 db.json；真实连接仍会在 connect() 明确失败。
        name = DEFAULT_TABLE
    if not SAFE_IDENTIFIER.fullmatch(name):
        raise ValueError("DB table 必须是安全 SQL 标识符")
    return name


def session_ref(device_key):
    """返回 device_key 的单向会话引用；验收结果不得输出原始设备键。"""
    if device_key is None or str(device_key).strip() == "":
        return None
    digest = hashlib.sha256(str(device_key).encode("utf-8")).hexdigest()
    return "sha256:" + digest


def public_row(row):
    """复制 DB 行并把原始 device_key 替换为不可逆 session_ref。"""
    result = {k: v for k, v in row.items() if k != "device_key"}
    if "device_key" in row:
        result["session_ref"] = session_ref(row.get("device_key"))
    return result


# ---------------- 字段校验引擎 ----------------
def _is_empty(v):
    return v is None or (isinstance(v, str) and v.strip() == "")


def check_rule(col, val, rule, pagecodes):
    """返回 (ok, reason)。"""
    if rule.get("notEmpty") and _is_empty(val):
        return False, f"{col} 为空"
    if "equals" in rule and str(val) != str(rule["equals"]):
        return False, f"{col}={val!r} 期望={rule['equals']!r}"
    if "oneOf" in rule:
        cand = [str(x) for x in rule["oneOf"]]
        if str(val) not in cand:
            return False, f"{col}={val!r} 不在 {rule['oneOf']}"
    if rule.get("positive"):
        try:
            if float(val) <= 0:
                return False, f"{col}={val!r} 必须为正数"
        except (TypeError, ValueError):
            return False, f"{col}={val!r} 不是有效正数"
    if rule.get("pageCode"):
        if _is_empty(val):
            return False, f"{col} 页面来源为空"
        if str(val) not in pagecodes:
            return False, f"{col}={val!r} 非法页面编码"
    return True, ""


def validate_row(row, ev, catalog):
    """校验一条 DB 记录是否符合事件规格。返回 dict 结果。"""
    pub_req = catalog["publicRequired"]
    pub_rules = catalog.get("publicValueRules", {})
    pagecodes = catalog.get("pageCodes", {})
    problems = []

    # 公共必填
    for col in pub_req:
        if _is_empty(row.get(col)):
            problems.append(f"公共参数 {col} 为空")
    # 公共值规则
    for col, rule in pub_rules.items():
        if col in row and not _is_empty(row.get(col)):
            ok, why = check_rule(col, row.get(col), rule, pagecodes)
            if not ok:
                problems.append("公共值校验: " + why)
        elif rule.get("notEmpty") and _is_empty(row.get(col)):
            problems.append(f"公共值校验: {col} 为空")
    # 事件必填
    for col in ev.get("requiredParams", []):
        if _is_empty(row.get(col)):
            problems.append(f"事件参数 {col} 为空")
    # 事件值规则
    for col, rule in ev.get("valueRules", {}).items():
        if not _is_empty(row.get(col)):
            ok, why = check_rule(col, row.get(col), rule, pagecodes)
            if not ok:
                problems.append("事件值校验: " + why)
    # 条件参数：某些字段仅在特定场景下必填（如 A1001012 event_result==2 时 error_message 必填）
    for cond in ev.get("conditional", []):
        when = cond.get("when", {})
        if all(str(row.get(k)) == str(v) for k, v in when.items()):
            for col in cond.get("require", []):
                if _is_empty(row.get(col)):
                    problems.append(f"条件必填 {col} 为空（当 {when}）")
    return {"ok": len(problems) == 0, "problems": problems}


# ---------------- 严格高水位查询 ----------------
def _column(name):
    if not SAFE_IDENTIFIER.fullmatch(name):
        raise ValueError(f"非法字段名: {name}")
    return name


def max_id(conn):
    """读取全表高水位。不得按事件、设备或 create_time 缩小基线范围。"""
    with conn.cursor() as cur:
        cur.execute(f"SELECT COALESCE(MAX(id), 0) max_id FROM {table()}")
        row = cur.fetchone() or {"max_id": 0}
    return int(row.get("max_id") or 0)


def _strict_where(after_id, event_id=None, device=None, extra=None):
    if after_id is None or int(after_id) < 0:
        raise ValueError("after_id 必须是非负整数")
    cond, args = ["id>%s"], [int(after_id)]
    if event_id:
        cond.append("event_id=%s")
        args.append(event_id)
    if device:
        cond.append("device_key=%s")
        args.append(device)
    for key, value in (extra or {}).items():
        cond.append(f"{_column(key)}=%s")
        args.append(value)
    return " WHERE " + " AND ".join(cond), args


def query_rows_after_id(conn, after_id, event_id=None, device=None, extra=None, limit=None):
    """查询严格晚于全表高水位的记录；create_time 不参与边界或回退。"""
    where, args = _strict_where(after_id, event_id, device, extra)
    sql = f"SELECT * FROM {table()}{where} ORDER BY id ASC"
    if limit is not None:
        sql += " LIMIT %s"
        args.append(int(limit))
    with conn.cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchall()


def count_rows_after_id(conn, after_id, event_id=None, device=None, extra=None):
    """统计严格晚于高水位且满足全部等值条件的记录。"""
    where, args = _strict_where(after_id, event_id, device, extra)
    with conn.cursor() as cur:
        cur.execute(f"SELECT COUNT(*) c FROM {table()}{where}", args)
        return int(cur.fetchone()["c"])


def values_equal(actual, expected):
    # 显式数值范围属于权威 expected 的一部分，不是“忽略字段”或同事件回退。
    # 仅接受闭区间 min/max；未知谓词结构一律不匹配。
    if isinstance(expected, dict):
        if not expected or set(expected) - {"min", "max"}:
            return False
        if "min" not in expected and "max" not in expected:
            return False
        try:
            value = float(actual)
            if "min" in expected and value < float(expected["min"]):
                return False
            if "max" in expected and value > float(expected["max"]):
                return False
            return True
        except (TypeError, ValueError):
            return False
    if expected is None:
        return actual is None
    if actual is None:
        return False
    if isinstance(expected, bool):
        value = str(actual).strip().lower()
        return value in ({"1", "true"} if expected else {"0", "false"})
    return str(actual) == str(expected)


def mismatched_fields(row, expected):
    """返回所有不匹配字段；不会忽略未知字段或只匹配部分 expected。"""
    return [key for key, value in (expected or {}).items()
            if not values_equal(row.get(key), value)]


def exact_matches(rows, expected):
    """只返回全部 expected 字段完全一致的行，禁止回退到同事件任意行。"""
    return [row for row in rows if not mismatched_fields(row, expected)]


# ---------------- 子命令 ----------------
def cmd_now(args):
    conn = connect()
    with conn.cursor() as cur:
        cur.execute("SELECT NOW() n")
        print(cur.fetchone()["n"])


def cmd_watermark(args):
    print(json.dumps({"after_id": max_id(connect())}, ensure_ascii=False))


def cmd_cols(args):
    conn = connect()
    with conn.cursor() as cur:
        cur.execute(f"SHOW COLUMNS FROM {table()}")
        for r in cur.fetchall():
            print(r["Field"], r["Type"])


def cmd_devicekeys(args):
    conn = connect()
    where, params = _strict_where(args.after_id)
    sql = (f"SELECT device_key, car_model, channel, country_iso, MAX(id) last_id, "
           f"COUNT(*) cnt FROM {table()}{where} GROUP BY device_key ORDER BY last_id DESC")
    with conn.cursor() as cur:
        cur.execute(sql, params)
        for r in cur.fetchall():
            print(f"{session_ref(r['device_key'])}  last_id={r['last_id']}  cnt={r['cnt']}  "
                  f"{r['car_model']}/{r['channel']}/{r['country_iso']}")


def cmd_dist(args):
    conn = connect()
    w, a = _strict_where(args.after_id, device=args.device)
    sql = f"SELECT event_id, COUNT(*) cnt, MAX(id) last_id FROM {table()}{w} GROUP BY event_id ORDER BY event_id"
    with conn.cursor() as cur:
        cur.execute(sql, a)
        for r in cur.fetchall():
            print(f"{r['event_id']}  cnt={r['cnt']:>5}  last_id={r['last_id']}")


def cmd_latest(args):
    conn = connect()
    rows = query_rows_after_id(conn, after_id=args.after_id,
                               event_id=args.event_id, device=args.device)
    if not rows:
        print(f"[无记录] {args.event_id}")
        return
    r = rows[-1]
    cat = load_catalog()
    ev = next((e for e in cat["events"] if e["id"] == args.event_id), None)
    print(json.dumps({k: str(v) for k, v in public_row(r).items() if v is not None},
                     ensure_ascii=False, indent=2))
    if ev:
        res = validate_row(r, ev, cat)
        print("校验:", "PASS" if res["ok"] else "FAIL", res["problems"])


def cmd_audit(args):
    """对 catalog 全部事件校验 id > after_id 的严格候选。"""
    conn = connect()
    cat = load_catalog()
    out = []
    for ev in cat["events"]:
        rows = query_rows_after_id(conn, after_id=args.after_id, event_id=ev["id"],
                                   device=args.device, limit=args.samples)
        if not rows:
            out.append({"event": ev["id"], "name": ev["name"], "priority": ev["priority"],
                        "found": 0, "ok": None, "problems": ["数据库无记录（严格 id 高水位后）"]})
            continue
        # 多样本：全部校验，任一失败则记录
        sample_results = [validate_row(r, ev, cat) for r in rows]
        allok = all(s["ok"] for s in sample_results)
        probs = []
        for s in sample_results:
            for p in s["problems"]:
                if p not in probs:
                    probs.append(p)
        out.append({"event": ev["id"], "name": ev["name"], "priority": ev["priority"],
                    "found": len(rows), "ok": allok, "problems": probs,
                    "latest_id": int(rows[-1]["id"])})
    result = {"after_id": args.after_id, "session_ref": session_ref(args.device), "events": out}
    txt = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(txt)
        print("WROTE", args.out)
    else:
        print(txt)
    # 摘要
    npass = sum(1 for e in out if e["ok"] is True)
    nfail = sum(1 for e in out if e["ok"] is False)
    nmiss = sum(1 for e in out if e["ok"] is None)
    print(f"\n[摘要] PASS={npass} FAIL={nfail} 无数据={nmiss} / 共{len(out)}", file=sys.stderr)


def cmd_verify(args):
    """轮询等待严格高水位后的唯一精确事件记录并校验。"""
    conn = connect()
    cat = load_catalog()
    ev = next((e for e in cat["events"] if e["id"] == args.event_id), None)
    if not ev:
        print("未知事件", args.event_id); sys.exit(2)
    try:
        expected = json.loads(args.match) if args.match else {}
    except json.JSONDecodeError:
        print("--match 必须是 JSON 对象")
        sys.exit(2)
    if not isinstance(expected, dict):
        print("--match 必须是 JSON 对象")
        sys.exit(2)
    deadline = time.monotonic() + (args.timeout or 60)
    while True:
        rows = query_rows_after_id(conn, after_id=args.after_id,
                                   event_id=args.event_id, device=args.device)
        matching = exact_matches(rows, expected)
        if len(matching) > 1:
            print(f"[歧义] 找到 {len(matching)} 条完全匹配记录；严格验收拒绝任取一条")
            sys.exit(4)
        if len(matching) == 1:
            r = matching[0]
            res = validate_row(r, ev, cat)
            print(json.dumps({k: str(v) for k, v in public_row(r).items() if v is not None},
                             ensure_ascii=False, indent=2))
            print("校验:", "PASS" if res["ok"] else "FAIL", res["problems"])
            sys.exit(0 if res["ok"] else 1)
        if time.monotonic() > deadline:
            detail = []
            for row in rows:
                detail.append({"id": row.get("id"),
                               "mismatched_fields": mismatched_fields(row, expected)})
            print(json.dumps({
                "status": "timeout_no_exact_match",
                "event_id": args.event_id,
                "after_id": args.after_id,
                "session_ref": session_ref(args.device),
                "candidate_mismatches": detail,
            }, ensure_ascii=False))
            sys.exit(3)
        time.sleep(args.interval or 3)


def main():
    p = argparse.ArgumentParser()
    p.add_argument(
        "--db-config",
        help="可选 DB JSON 路径覆盖；也可用 TRACKFEATURE_DB_CONFIG，路径/凭据不回显",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("now"); sp.set_defaults(fn=cmd_now)

    sp = sub.add_parser("watermark"); sp.set_defaults(fn=cmd_watermark)

    sp = sub.add_parser("cols"); sp.set_defaults(fn=cmd_cols)

    sp = sub.add_parser("devicekeys"); sp.add_argument("--after-id", type=int, default=0)
    sp.set_defaults(fn=cmd_devicekeys)

    sp = sub.add_parser("dist"); sp.add_argument("--device"); sp.add_argument("--after-id", type=int, default=0)
    sp.set_defaults(fn=cmd_dist)

    sp = sub.add_parser("latest"); sp.add_argument("event_id")
    sp.add_argument("--device", required=True); sp.add_argument("--after-id", type=int, required=True)
    sp.set_defaults(fn=cmd_latest)

    sp = sub.add_parser("audit"); sp.add_argument("--device", required=True)
    sp.add_argument("--after-id", type=int, required=True); sp.add_argument("--samples", type=int)
    sp.add_argument("--out"); sp.set_defaults(fn=cmd_audit)

    sp = sub.add_parser("verify"); sp.add_argument("event_id")
    sp.add_argument("--device", required=True); sp.add_argument("--after-id", type=int, required=True)
    sp.add_argument("--match", help="全部 expected 字段的 JSON 对象；不匹配时不回退到同事件其他行")
    sp.add_argument("--timeout", type=int, default=60); sp.add_argument("--interval", type=int, default=3)
    sp.set_defaults(fn=cmd_verify)

    args = p.parse_args()
    configure_db(args.db_config)
    args.fn(args)


if __name__ == "__main__":
    main()
