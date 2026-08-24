# -*- coding: utf-8 -*-
"""
devbench 埋点 mysql mode 助手：被 buried-point.js 调用，用 pymysql 跑只读查询。
stdin：第一行 = JSON 连接配置 {host,port,user,password,database,charset}；其余 = SQL。
stdout：JSON {"count":N,"rows":[...]}（rows 用 str 兜底序列化）；出错则 {"error":"..."} 且退出码 1。
凭据只经 stdin 传入、不落盘、不打印。
"""
import sys, json

def main():
    data = sys.stdin.read()
    nl = data.find("\n")
    if nl < 0:
        print(json.dumps({"error": "缺少 SQL（stdin 第一行应为连接 JSON，其后为 SQL）"}, ensure_ascii=False)); sys.exit(1)
    try:
        cfg = json.loads(data[:nl])
    except Exception as e:
        print(json.dumps({"error": "连接配置 JSON 解析失败: %s" % e}, ensure_ascii=False)); sys.exit(1)
    sql = data[nl + 1:].strip()
    if not sql:
        print(json.dumps({"error": "SQL 为空"}, ensure_ascii=False)); sys.exit(1)
    try:
        import pymysql
    except Exception:
        print(json.dumps({"error": "本机缺少 pymysql（pip install pymysql）"}, ensure_ascii=False)); sys.exit(1)
    try:
        conn = pymysql.connect(
            host=cfg["host"], port=int(cfg.get("port", 3306)), user=cfg["user"],
            password=cfg.get("password", ""), database=cfg.get("database"),
            charset=cfg.get("charset", "utf8mb4"), connect_timeout=int(cfg.get("connectTimeout", 8)),
            cursorclass=pymysql.cursors.DictCursor, autocommit=True,
        )
    except Exception as e:
        print(json.dumps({"error": "连接失败: %s" % e}, ensure_ascii=False)); sys.exit(1)
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
            rows = cur.fetchall() or []
        print(json.dumps({"count": len(rows), "rows": rows}, ensure_ascii=False, default=str))
    except Exception as e:
        print(json.dumps({"error": "查询失败: %s" % e}, ensure_ascii=False)); sys.exit(1)
    finally:
        try: conn.close()
        except Exception: pass

if __name__ == "__main__":
    main()
