"""Failure history: durable, queryable record of every validation run (observability of historic failures).

Every caller (Git pre-commit, Arch_review_Agent, Test Agent, CI) records through `architecture.validate`, so history
is captured once, in one place, with one schema. Sinks:

* sqlite (default, local query store) - stdlib only, WAL mode, retention-pruned, gitignored.
  Path: policy.yaml history.path, overridable with $ARCH_HISTORY_DB (e.g. a shared CI cache volume).
* ledger (team-wide, in git) - every agent run and review is also written as one small JSON file under
  history.ledger.path (.agent-metrics/arch-history/), committed with the work. One file per event, so teammates'
  ledgers merge without conflicts. Before any query the sqlite store imports ledger files it has not seen, so
  everyone's lessons cover the whole team's denials. Turn off with $ARCH_HISTORY_LEDGER=off or point it elsewhere.
* OTLP/HTTP JSON logs (opt-in, team-wide) - set $ARCH_OTLP_ENDPOINT (or OTEL_EXPORTER_OTLP_ENDPOINT) to an
  OpenTelemetry Collector; best effort with a short timeout, never affects the decision.

Recording never raises: a broken history store must not block a commit or a review.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sqlite3
import urllib.request
from contextlib import closing
from pathlib import Path

SCHEMA_VERSION = 1
DEFAULT_PATH = "evidence/history/architecture-history.sqlite"
DEFAULT_RECORD_OUTCOMES = ("BLOCK", "WARN", "WAIVED")
LEDGER_SCHEMA = "arch-history-ledger/v1"
DEFAULT_LEDGER_PATH = ".agent-metrics/arch-history"
# Lessons are about agents; per-commit, CI and test runs would only churn the shared ledger.
DEFAULT_LEDGER_EXCLUDE = ("git-pre-commit", "ci", "selfcheck", "unspecified", "unittest")
LEDGER_MESSAGE_MAX = 500
_OFF = ("0", "off", "false", "no")

DDL = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
    run_id          TEXT PRIMARY KEY,
    ts              TEXT NOT NULL,
    checkpoint      TEXT NOT NULL,
    caller          TEXT NOT NULL,
    decision        TEXT NOT NULL,
    exit_code       INTEGER NOT NULL,
    branch          TEXT,
    head            TEXT,
    policy_version  TEXT,
    policy_sha256   TEXT,
    rules_evaluated INTEGER,
    changed_files   INTEGER,
    findings_block  INTEGER NOT NULL DEFAULT 0,
    findings_warn   INTEGER NOT NULL DEFAULT 0,
    findings_waived INTEGER NOT NULL DEFAULT 0,
    review_requests INTEGER NOT NULL DEFAULT 0,
    duration_ms     INTEGER,
    bundle_path     TEXT
);
CREATE INDEX IF NOT EXISTS ix_runs_ts ON runs(ts);
CREATE INDEX IF NOT EXISTS ix_runs_branch ON runs(branch, checkpoint, ts);
CREATE TABLE IF NOT EXISTS findings (
    run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    finding_id      TEXT NOT NULL,
    rule_id         TEXT NOT NULL,
    category        TEXT,
    severity        TEXT,
    outcome         TEXT NOT NULL,
    status          TEXT NOT NULL,
    validator       TEXT,
    validation_mode TEXT,
    file            TEXT,
    line            INTEGER,
    message         TEXT,
    exception_id    TEXT,
    PRIMARY KEY (run_id, finding_id)
);
CREATE INDEX IF NOT EXISTS ix_findings_rule ON findings(rule_id);
CREATE INDEX IF NOT EXISTS ix_findings_file ON findings(file);
CREATE INDEX IF NOT EXISTS ix_findings_fid ON findings(finding_id);
CREATE TABLE IF NOT EXISTS agent_reviews (
    review_id         TEXT PRIMARY KEY,
    run_id            TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
    ts                TEXT NOT NULL,
    agent             TEXT NOT NULL,
    requester         TEXT,
    task_id           TEXT,
    iteration         INTEGER,
    previous_review_id TEXT,
    status            TEXT NOT NULL,
    decision          TEXT NOT NULL,
    resolved          INTEGER,
    persisting        INTEGER,
    introduced        INTEGER
);
CREATE INDEX IF NOT EXISTS ix_reviews_task ON agent_reviews(task_id, ts);
CREATE TABLE IF NOT EXISTS ledger_imports (name TEXT PRIMARY KEY);
"""


def config(pack) -> dict:
    cfg = dict(pack.manifest.get("history") or {})
    cfg.setdefault("enabled", True)
    cfg.setdefault("path", DEFAULT_PATH)
    cfg.setdefault("retention_days", 365)
    cfg.setdefault("record_outcomes", list(DEFAULT_RECORD_OUTCOMES))
    cfg.setdefault("otlp", {})
    ledger = dict(cfg.get("ledger") or {})
    ledger.setdefault("enabled", True)
    ledger.setdefault("path", DEFAULT_LEDGER_PATH)
    ledger.setdefault("exclude_callers", list(DEFAULT_LEDGER_EXCLUDE))
    cfg["ledger"] = ledger
    return cfg


def db_path(pack, override: str | None = None) -> Path:
    raw = override or os.environ.get("ARCH_HISTORY_DB") or config(pack)["path"]
    p = Path(raw)
    return p if p.is_absolute() else (pack.root / p)


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.DatabaseError:
        pass
    conn.executescript(DDL)
    conn.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),))
    return conn


def _enabled(pack, context: dict) -> bool:
    if context.get("record_history") is False:
        return False
    if os.environ.get("ARCH_HISTORY", "").lower() in _OFF:
        return False
    return bool(config(pack)["enabled"])


def record(pack, result: dict, context: dict | None = None) -> dict:
    """Persist a validation result. Returns {recorded, store, path?, otlp?, error?}; never raises."""
    context = context or {}
    if not _enabled(pack, context):
        return {"recorded": False, "store": None, "reason": "disabled"}
    cfg = config(pack)
    path = db_path(pack, context.get("history_db"))
    status: dict = {"recorded": False, "store": "sqlite", "path": _display(pack, path)}
    try:
        with closing(connect(path)) as conn, conn:
            _insert_run(conn, result, set(cfg["record_outcomes"]))
            _prune(conn, cfg["retention_days"])
            shared = _write_ledger_run(pack, conn, result, cfg, context.get("history_db"))
        status["recorded"] = True
        if shared:
            status["ledger"] = shared
    except Exception as exc:  # history must never break validation
        status["error"] = f"{type(exc).__name__}: {exc}"
    otlp = export_otlp(pack, result)
    if otlp:
        status["otlp"] = otlp
    return status


def record_review(pack, review: dict, context: dict | None = None) -> bool:
    """Persist Arch_review_Agent review metadata (iteration tracking across agent calls). Never raises."""
    context = context or {}
    if not _enabled(pack, context):
        return False
    try:
        with closing(connect(db_path(pack, context.get("history_db")))) as conn, conn:
            row = _review_row(review)
            _insert_row(conn, "agent_reviews", row, "REPLACE")
            ledger = ledger_dir(pack, context.get("history_db"))
            if ledger and row["requester"]:
                _write_ledger(conn, ledger, row["ts"], "review", row["review_id"], {"review": row})
        return True
    except Exception:
        return False


def run_for_review(pack, review_id: str, history_db: str | None = None) -> str | None:
    try:
        with closing(connect(_store(pack, history_db))) as conn:
            row = conn.execute("SELECT run_id FROM agent_reviews WHERE review_id = ?", (review_id,)).fetchone()
            return row["run_id"] if row else None
    except Exception:
        return None


def findings_of_run(pack, run_id: str, history_db: str | None = None) -> list[dict]:
    try:
        with closing(connect(_store(pack, history_db))) as conn:
            return [dict(r) for r in conn.execute("SELECT * FROM findings WHERE run_id = ?", (run_id,))]
    except Exception:
        return []


def _run_rows(result: dict, outcomes: set[str]) -> tuple[dict, list[dict]]:
    findings = result.get("findings", [])
    by = lambda o: sum(1 for f in findings if f["outcome"] == o)
    repo = result.get("repository") or {}
    pol = result.get("policy") or {}
    run = {"run_id": result["run_id"], "ts": result["timestamp"], "checkpoint": result["checkpoint"],
           "caller": result.get("caller") or "unspecified", "decision": result["decision"],
           "exit_code": result.get("exit_code", 0), "branch": repo.get("branch"), "head": repo.get("head"),
           "policy_version": pol.get("version"), "policy_sha256": pol.get("content_sha256"),
           "rules_evaluated": (result.get("summary") or {}).get("rules_evaluated"),
           "changed_files": len((result.get("inputs") or {}).get("changed_files") or {}),
           "findings_block": by("BLOCK"), "findings_warn": by("WARN"), "findings_waived": by("WAIVED"),
           "review_requests": len(result.get("review_requests") or []), "duration_ms": result.get("duration_ms"),
           "bundle_path": (result.get("evidence") or {}).get("bundle_path")}
    rows = [{"run_id": result["run_id"], "finding_id": f["finding_id"], "rule_id": f["rule_id"],
             "category": f.get("category"), "severity": f.get("severity"), "outcome": f["outcome"],
             "status": f["status"], "validator": f.get("validator"), "validation_mode": f.get("validation_mode"),
             "file": f.get("file"), "line": int(f["line"]) if str(f.get("line") or "").isdigit() else None,
             "message": (f.get("message") or "")[:2000], "exception_id": (f.get("exception") or {}).get("id")}
            for f in findings if f["outcome"] in outcomes]
    return run, rows


def _review_row(review: dict) -> dict:
    delta = review.get("delta") or {}
    req = review.get("requester") or {}
    return {"review_id": review["review_id"], "run_id": review.get("run_id"), "ts": review["timestamp"],
            "agent": review.get("agent", "arch-review-agent"), "requester": req.get("agent"),
            "task_id": req.get("task_id"), "iteration": req.get("iteration"),
            "previous_review_id": review.get("previous_review_id"), "status": review["status"],
            "decision": review["decision"], "resolved": len(delta.get("resolved", [])),
            "persisting": len(delta.get("persisting", [])), "introduced": len(delta.get("introduced", []))}


def _insert_row(conn, table: str, row: dict, conflict: str = "IGNORE"):
    """Insert by column name; keys this schema does not know (newer ledger writers) are ignored."""
    cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})")]
    keys = [c for c in cols if c in row]
    conn.execute(f"INSERT OR {conflict} INTO {table} ({','.join(keys)}) VALUES ({','.join('?' * len(keys))})",
                 [row[k] for k in keys])


def _insert_run(conn, result: dict, outcomes: set[str]):
    run, rows = _run_rows(result, outcomes)
    _insert_row(conn, "runs", run, "REPLACE")
    for row in rows:
        _insert_row(conn, "findings", row, "REPLACE")


# ---------------------------------------------------------------------------------------------- shared ledger

def ledger_dir(pack, history_db: str | None = None) -> Path | None:
    """Directory of the git-tracked ledger, or None when off. A per-call history_db is an isolated store."""
    env = os.environ.get("ARCH_HISTORY_LEDGER", "")
    if env.lower() in _OFF:
        return None
    if history_db and not env:
        return None
    cfg = config(pack)["ledger"]
    if not env and not cfg["enabled"]:
        return None
    p = Path(env or cfg["path"])
    return p if p.is_absolute() else (pack.repo_root / p)


def _write_ledger(conn, ledger: Path, ts: str, kind: str, event_id: str, body: dict) -> str:
    name = f"{ts[:7]}/{kind}-{event_id}.json"
    target = ledger / name
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps({"schema": LEDGER_SCHEMA, "kind": kind, **body}, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, target)
    conn.execute("INSERT OR IGNORE INTO ledger_imports(name) VALUES (?)", (name,))
    return name


def _write_ledger_run(pack, conn, result: dict, cfg: dict, history_db: str | None) -> str | None:
    ledger = ledger_dir(pack, history_db)
    caller = result.get("caller") or "unspecified"
    if not ledger or caller in cfg["ledger"]["exclude_callers"]:
        return None
    run, rows = _run_rows(result, set(cfg["record_outcomes"]))
    run["bundle_path"] = None  # local evidence bundles are not shared
    for row in rows:
        row["message"] = (row["message"] or "")[:LEDGER_MESSAGE_MAX]
    return _write_ledger(conn, ledger, run["ts"], "run", run["run_id"], {"run": run, "findings": rows})


def sync_ledger(pack, history_db: str | None = None) -> dict:
    """Import ledger files the local sqlite store has not seen yet. Idempotent; never raises."""
    ledger = ledger_dir(pack, history_db)
    status = {"imported": 0, "ledger": None}
    if not ledger or not ledger.is_dir():
        return status
    status["ledger"] = _display(pack, ledger)
    try:
        names = sorted(p.relative_to(ledger).as_posix() for p in ledger.glob("*/*.json"))
        if not names:
            return status
        cfg = config(pack)
        with closing(connect(db_path(pack, history_db))) as conn, conn:
            seen = {r["name"] for r in conn.execute("SELECT name FROM ledger_imports")}
            fresh = [n for n in names if n not in seen]
            # Runs before reviews: reviews reference their run.
            fresh.sort(key=lambda n: (n.split("/", 1)[1].startswith("review-"), n))
            cutoff = ((dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=cfg["retention_days"])).isoformat()
                      if cfg["retention_days"] else "")
            for name in fresh:
                try:
                    doc = json.loads((ledger / name).read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue  # unreadable or half-merged file: retry next time
                if doc.get("kind") == "run" and doc.get("run", {}).get("ts", "") >= cutoff:
                    _insert_row(conn, "runs", doc["run"])
                    for row in doc.get("findings") or []:
                        _insert_row(conn, "findings", row)
                elif doc.get("kind") == "review" and doc.get("review"):
                    row = dict(doc["review"])
                    if row.get("run_id") and not conn.execute(
                            "SELECT 1 FROM runs WHERE run_id = ?", (row["run_id"],)).fetchone():
                        row["run_id"] = None
                    _insert_row(conn, "agent_reviews", row)
                conn.execute("INSERT OR IGNORE INTO ledger_imports(name) VALUES (?)", (name,))
                status["imported"] += 1
    except Exception as exc:  # a bad ledger must never break validation or review
        status["error"] = f"{type(exc).__name__}: {exc}"
    return status


def _store(pack, history_db: str | None = None) -> Path:
    """The sqlite store for queries, after importing teammates' ledger entries."""
    sync_ledger(pack, history_db)
    return db_path(pack, history_db)


def _prune(conn, retention_days: int):
    if retention_days and retention_days > 0:
        cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=retention_days)).isoformat()
        conn.execute("DELETE FROM runs WHERE ts < ?", (cutoff,))


def _display(pack, path: Path) -> str:
    try:
        return path.resolve().relative_to(pack.repo_root).as_posix()
    except ValueError:
        return str(path)


# ---------------------------------------------------------------------------------------------- queries

def query(pack, q: dict | None = None) -> dict:
    """architecture.get_failure_history(query).

    query keys (all optional): since_days (30), checkpoint, caller (prefix), branch, rule_id, category,
    file (path prefix), outcomes (["BLOCK","WARN"]), limit (10), min_occurrences (2), history_db,
    include_pending_review (false: semantic rules merely awaiting judgment are not counted as failures).
    """
    q = dict(q or {})
    path = _store(pack, q.get("history_db"))
    since_days = int(q.get("since_days", 30))
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=since_days)).isoformat()
    limit = int(q.get("limit", 10))
    outcomes = list(q.get("outcomes") or ["BLOCK", "WARN"])
    base = {"store": {"type": "sqlite", "path": _display(pack, path), "exists": path.exists()},
            "window": {"since_days": since_days, "since": since}, "filters": {k: v for k, v in q.items() if k != "history_db"}}
    if not path.exists():
        return dict(base, totals={"runs": 0}, decision_trend=[], top_rules=[], top_files=[], recurring_findings=[],
                    by_caller=[], exceptions_used=[])

    run_where, run_args = ["r.ts >= ?"], [since]
    for key, col in (("checkpoint", "r.checkpoint"), ("branch", "r.branch")):
        if q.get(key):
            run_where.append(f"{col} = ?")
            run_args.append(q[key])
    if q.get("caller"):
        run_where.append("r.caller LIKE ?")
        run_args.append(q["caller"] + "%")
    f_where, f_args = list(run_where), list(run_args)
    f_where.append("f.outcome IN (%s)" % ",".join("?" * len(outcomes)))
    f_args.extend(outcomes)
    if not q.get("include_pending_review", False):
        f_where.append("f.status <> 'needs_review'")
    for key, col in (("rule_id", "f.rule_id"), ("category", "f.category")):
        if q.get(key):
            f_where.append(f"{col} = ?")
            f_args.append(q[key])
    if q.get("file"):
        f_where.append("f.file LIKE ?")
        f_args.append(q["file"].replace("\\", "/") + "%")
    rw, fw = " AND ".join(run_where), " AND ".join(f_where)
    join = "FROM findings f JOIN runs r ON r.run_id = f.run_id"

    with closing(connect(path)) as conn:
        rows = lambda sql, args: [dict(r) for r in conn.execute(sql, args)]
        totals = rows(f"SELECT COUNT(*) runs, SUM(decision='BLOCK') block_runs, SUM(decision='WARN') warn_runs, "
                      f"SUM(decision='PASS') pass_runs FROM runs r WHERE {rw}", run_args)[0]
        totals.update(rows(f"SELECT COUNT(*) findings, COUNT(DISTINCT f.rule_id) distinct_rules, "
                           f"COUNT(DISTINCT f.file) distinct_files {join} WHERE {fw}", f_args)[0])
        trend = rows(f"SELECT substr(r.ts,1,10) day, COUNT(*) runs, SUM(decision='BLOCK') block, SUM(decision='WARN') warn, "
                     f"SUM(decision='PASS') pass FROM runs r WHERE {rw} GROUP BY day ORDER BY day", run_args)
        top_rules = rows(f"SELECT f.rule_id, f.category, f.severity, COUNT(*) failures, COUNT(DISTINCT f.run_id) runs, "
                         f"COUNT(DISTINCT f.file) distinct_files, SUM(f.outcome='BLOCK') blocks, MIN(r.ts) first_seen, "
                         f"MAX(r.ts) last_seen {join} WHERE {fw} GROUP BY f.rule_id ORDER BY failures DESC, f.rule_id "
                         f"LIMIT ?", f_args + [limit])
        top_files = rows(f"SELECT f.file, COUNT(*) failures, GROUP_CONCAT(DISTINCT f.rule_id) rules, MAX(r.ts) last_seen "
                         f"{join} WHERE {fw} AND f.file IS NOT NULL GROUP BY f.file ORDER BY failures DESC, f.file "
                         f"LIMIT ?", f_args + [limit])
        recurring = rows(f"SELECT f.finding_id, f.rule_id, f.file, f.line, MAX(f.message) message, COUNT(*) occurrences, "
                         f"MIN(r.ts) first_seen, MAX(r.ts) last_seen, "
                         f"GROUP_CONCAT(DISTINCT r.caller) callers {join} WHERE {fw} GROUP BY f.finding_id "
                         f"HAVING COUNT(*) >= ? ORDER BY occurrences DESC, last_seen DESC LIMIT ?",
                         f_args + [int(q.get("min_occurrences", 2)), limit])
        latest = {(r["branch"], r["checkpoint"]): r["ts"] for r in rows(
            f"SELECT r.branch, r.checkpoint, MAX(r.ts) ts FROM runs r WHERE {rw} GROUP BY r.branch, r.checkpoint", run_args)}
        for item in recurring:
            last = rows("SELECT r.branch, r.checkpoint, r.ts FROM findings f JOIN runs r ON r.run_id = f.run_id "
                        "WHERE f.finding_id = ? ORDER BY r.ts DESC LIMIT 1", [item["finding_id"]])[0]
            item["still_open"] = latest.get((last["branch"], last["checkpoint"])) == last["ts"]
            item["callers"] = sorted(set((item["callers"] or "").split(",")))
        by_caller = rows(f"SELECT r.caller, COUNT(*) runs, SUM(decision='BLOCK') block_runs, SUM(decision='WARN') warn_runs, "
                         f"MAX(r.ts) last_run FROM runs r WHERE {rw} GROUP BY r.caller ORDER BY runs DESC", run_args)
        exc = rows(f"SELECT f.exception_id, f.rule_id, COUNT(*) hits, MAX(r.ts) last_seen FROM findings f "
                   f"JOIN runs r ON r.run_id = f.run_id WHERE {rw} AND f.exception_id IS NOT NULL "
                   f"GROUP BY f.exception_id, f.rule_id ORDER BY hits DESC", run_args)
    for r in top_rules:
        r["severity"] = r["severity"] or (pack.rules.get(r["rule_id"]) or {}).get("severity")
    for r in top_files:
        r["rules"] = sorted(set((r["rules"] or "").split(",")))
    return dict(base, totals=totals, decision_trend=trend, top_rules=top_rules, top_files=top_files,
                recurring_findings=recurring, by_caller=by_caller, exceptions_used=exc)


def finding_history(pack, finding_ids: list[str], history_db: str | None = None) -> dict[str, dict]:
    """{finding_id: {occurrences, first_seen, last_seen, callers}} for findings seen before."""
    path = _store(pack, history_db)
    if not finding_ids or not path.exists():
        return {}
    out = {}
    try:
        with closing(connect(path)) as conn:
            for i in range(0, len(finding_ids), 500):
                chunk = finding_ids[i:i + 500]
                for r in conn.execute(
                        "SELECT f.finding_id, COUNT(*) occurrences, MIN(r.ts) first_seen, MAX(r.ts) last_seen, "
                        "GROUP_CONCAT(DISTINCT r.caller) callers FROM findings f JOIN runs r ON r.run_id = f.run_id "
                        "WHERE f.finding_id IN (%s) GROUP BY f.finding_id" % ",".join("?" * len(chunk)), chunk):
                    out[r["finding_id"]] = {"occurrences": r["occurrences"], "first_seen": r["first_seen"],
                                            "last_seen": r["last_seen"], "callers": sorted(set((r["callers"] or "").split(",")))}
    except Exception:
        return {}
    return out


def hotspots(pack, files: list[str], since_days: int = 90, limit: int = 10, history_db: str | None = None) -> list[dict]:
    """Rules that historically failed on the given files (or their directories)."""
    path = _store(pack, history_db)
    if not files or not path.exists():
        return []
    dirs = sorted({f.replace("\\", "/").rsplit("/", 1)[0] + "/" for f in files if "/" in f})
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=since_days)).isoformat()
    clauses = " OR ".join(["f.file LIKE ?"] * len(dirs)) or "0"
    try:
        with closing(connect(path)) as conn:
            return [dict(r, files=sorted(set((r["files"] or "").split(",")))) for r in conn.execute(
                f"SELECT f.rule_id, COUNT(*) failures, SUM(f.outcome='BLOCK') blocks, MAX(r.ts) last_seen, "
                f"GROUP_CONCAT(DISTINCT f.file) files FROM findings f JOIN runs r ON r.run_id = f.run_id "
                f"WHERE r.ts >= ? AND f.outcome IN ('BLOCK','WARN') AND f.status <> 'needs_review' AND ({clauses}) GROUP BY f.rule_id "
                f"ORDER BY failures DESC LIMIT ?", [since] + [d + "%" for d in dirs] + [limit])]
    except Exception:
        return []


# ---------------------------------------------------------------------------------------------- lessons (learning loop)

def _agent_clause(agent: str) -> tuple[str, list]:
    # Matches direct callers ("test-agent") and calls made through Arch_review_Agent ("arch-review-agent:test-agent").
    return "(r.caller = ? OR r.caller LIKE ?)", [agent, "%:" + agent]


def agent_rule_denials(pack, agent: str, since_days: int = 90, exclude_run_id: str | None = None,
                       history_db: str | None = None) -> dict[str, dict]:
    """{rule_id: {denials, warnings, runs, last_seen}} of past verifier failures for one agent."""
    path = _store(pack, history_db)
    if not agent or not path.exists():
        return {}
    clause, args = _agent_clause(agent)
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=since_days)).isoformat()
    try:
        with closing(connect(path)) as conn:
            return {r["rule_id"]: {k: r[k] for k in ("denials", "warnings", "runs", "last_seen")} for r in conn.execute(
                f"SELECT f.rule_id, SUM(f.outcome='BLOCK') denials, SUM(f.outcome='WARN') warnings, "
                f"COUNT(DISTINCT f.run_id) runs, MAX(r.ts) last_seen FROM findings f JOIN runs r ON r.run_id = f.run_id "
                f"WHERE {clause} AND r.ts >= ? AND r.run_id <> ? AND f.outcome IN ('BLOCK','WARN') "
                f"AND f.status <> 'needs_review' GROUP BY f.rule_id", args + [since, exclude_run_id or ""])}
    except Exception:
        return {}


def lessons(pack, q: dict | None = None) -> dict:
    """architecture.get_lessons(query): how often the verifier denied an agent, why, and what to do instead.

    query: agent (required; caller name, e.g. "test-agent"), checkpoint, since_days (90), limit (10),
    min_occurrences (2: a rule must fail in >= N runs to become a lesson), history_db.
    The `prompt` field is ready to inject into the agent's system prompt / instructions so it stops repeating
    the same mistakes; `fingerprint` changes only when the lessons change.
    """
    import hashlib
    q = dict(q or {})
    agent = q.get("agent") or q.get("caller")
    if not agent:
        raise ValueError("agent is required (the caller whose denials to learn from, e.g. 'test-agent')")
    since_days, limit, min_occ = int(q.get("since_days", 90)), int(q.get("limit", 10)), int(q.get("min_occurrences", 2))
    path = _store(pack, q.get("history_db"))
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=since_days)).isoformat()
    clause, cargs = _agent_clause(agent)
    where, args = [clause, "r.ts >= ?"], cargs + [since]
    if q.get("checkpoint"):
        where.append("r.checkpoint = ?")
        args.append(q["checkpoint"])
    rw = " AND ".join(where)
    out = {"schema": "arch-lessons/v1", "agent": agent, "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
           "window": {"since_days": since_days, "since": since, "checkpoint": q.get("checkpoint")},
           "store": {"type": "sqlite", "path": _display(pack, path), "exists": path.exists()},
           "denial_stats": {"runs": 0, "denied_runs": 0, "warned_runs": 0, "denial_rate": None, "trend": "insufficient_data"},
           "weekly": [], "denial_reasons": [], "iterations": {}, "lessons": [], "prompt": "", "fingerprint": None}
    if not path.exists():
        return out

    with closing(connect(path)) as conn:
        rows = lambda sql, a: [dict(r) for r in conn.execute(sql, a)]
        runs = rows(f"SELECT r.run_id, r.ts, r.decision FROM runs r WHERE {rw} ORDER BY r.ts", args)
        fails = rows(f"SELECT f.run_id, f.rule_id, f.outcome, f.status, f.file, f.message, f.category, f.severity, r.ts "
                     f"FROM findings f JOIN runs r ON r.run_id = f.run_id WHERE {rw} AND f.outcome IN ('BLOCK','WARN') "
                     f"AND f.status <> 'needs_review' ORDER BY r.ts", args)
        weekly = rows(f"SELECT strftime('%Y-W%W', substr(r.ts,1,10)) week, COUNT(*) runs, SUM(r.decision='BLOCK') denied "
                      f"FROM runs r WHERE {rw} GROUP BY week ORDER BY week", args)
        rv_args = [agent, since]
        reviews = rows("SELECT review_id, task_id, previous_review_id, decision, resolved, introduced FROM agent_reviews "
                       "WHERE requester = ? AND ts >= ? ORDER BY ts", rv_args)

    n = len(runs)
    denied = sum(1 for r in runs if r["decision"] == "BLOCK")
    stats = {"runs": n, "denied_runs": denied, "warned_runs": sum(1 for r in runs if r["decision"] == "WARN"),
             "denial_rate": round(denied / n, 3) if n else None, "trend": "insufficient_data"}
    if n >= 4:
        half = n // 2
        rate = lambda rs: sum(1 for r in rs if r["decision"] == "BLOCK") / len(rs)
        first, second = rate(runs[:half]), rate(runs[half:])
        stats.update(earlier_denial_rate=round(first, 3), recent_denial_rate=round(second, 3),
                     trend="improving" if second < first else "worsening" if second > first else "flat")
    for w in weekly:
        w["denial_rate"] = round(w["denied"] / w["runs"], 3) if w["runs"] else None

    # Group denials by rule; count re-introductions (failed, then a later run was clean of it, then failed again).
    order = {r["run_id"]: i for i, r in enumerate(runs)}
    by_rule: dict[str, dict] = {}
    for f in fails:
        g = by_rule.setdefault(f["rule_id"], {"rule_id": f["rule_id"], "category": f["category"], "severity": f["severity"],
                                              "denials": 0, "warnings": 0, "runs": set(), "files": {}, "messages": {},
                                              "statuses": set(), "first_seen": f["ts"], "last_seen": f["ts"]})
        g["denials" if f["outcome"] == "BLOCK" else "warnings"] += 1
        g["runs"].add(f["run_id"])
        g["statuses"].add(f["status"])
        g["last_seen"] = f["ts"]
        if f["file"]:
            g["files"][f["file"]] = g["files"].get(f["file"], 0) + 1
        msg = " ".join((f["message"] or "").split())
        g["messages"][msg] = g["messages"].get(msg, 0) + 1
    reasons = []
    for g in by_rule.values():
        idx = sorted(order[r] for r in g["runs"])
        reintroduced = sum(1 for a, b in zip(idx, idx[1:]) if b - a > 1)
        rule = pack.rules.get(g["rule_id"]) or {}
        top = lambda d, k: [{"value": v, "count": c} for v, c in sorted(d.items(), key=lambda x: (-x[1], x[0]))[:k]]
        reasons.append({
            "rule_id": g["rule_id"], "rule_title": rule.get("title"), "category": g["category"] or rule.get("category"),
            "severity": g["severity"] or rule.get("severity"), "denials": g["denials"], "warnings": g["warnings"],
            "runs": len(g["runs"]), "share_of_runs": round(len(g["runs"]) / n, 3) if n else None,
            "reintroduced": reintroduced, "statuses": sorted(g["statuses"]),
            "why": [{"message": m["value"], "count": m["count"]} for m in top(g["messages"], 3)],
            "top_files": [{"file": x["value"], "count": x["count"]} for x in top(g["files"], 3)],
            "first_seen": g["first_seen"], "last_seen": g["last_seen"],
            "remediation": rule.get("remediation"), "patterns": rule.get("patterns", []),
            "score": g["denials"] * 3 + g["warnings"] + reintroduced * 2,
        })
    reasons.sort(key=lambda r: (-r["score"], r["rule_id"]))

    tasks = {r["task_id"] for r in reviews if r["task_id"]}
    initial = [r for r in reviews if not r["previous_review_id"]]
    iterations = {"reviews": len(reviews), "tasks": len(tasks),
                  "avg_reviews_per_task": round(len(reviews) / len(tasks), 2) if tasks else None,
                  "first_pass_approval_rate": round(sum(1 for r in initial if r["decision"] != "BLOCK") / len(initial), 3)
                  if initial else None,
                  "findings_resolved": sum(r["resolved"] or 0 for r in reviews),
                  "findings_introduced_while_fixing": sum(r["introduced"] or 0 for r in reviews)}

    lessons_out = []
    for r in reasons:
        if r["runs"] < min_occ and not r["reintroduced"]:
            continue
        rem = r["remediation"] or {}
        lessons_out.append({
            "lesson_id": f"LESSON-{r['rule_id']}", "rule_id": r["rule_id"], "title": r["rule_title"],
            "severity": r["severity"], "priority": len(lessons_out) + 1,
            "evidence": {"denials": r["denials"], "warnings": r["warnings"], "runs": r["runs"],
                         "reintroduced": r["reintroduced"], "last_seen": r["last_seen"]},
            "mistake": r["why"][0]["message"] if r["why"] else None,
            "instead": rem.get("summary"), "steps": rem.get("steps", []), "patterns": r["patterns"],
            "watch_files": [f["file"] for f in r["top_files"]],
        })
        if len(lessons_out) >= limit:
            break

    prompt = ""
    if lessons_out:
        rate = f"{stats['denial_rate']:.0%}" if stats["denial_rate"] is not None else "n/a"
        lines = [f"## Lessons from past architecture reviews ({agent}, last {since_days} days)",
                 f"The verifier denied {denied} of {n} runs ({rate}; trend: {stats['trend']}). "
                 "Do not repeat these mistakes:", ""]
        for le in lessons_out:
            ev = le["evidence"]
            lines.append(f"{le['priority']}. **{le['rule_id']} - {le['title']}** (failed in {ev['runs']} run(s): "
                         f"{ev['denials']} blocking, {ev['warnings']} warning finding(s); reintroduced "
                         f"{ev['reintroduced']}x; last {ev['last_seen'][:10]})")
            if le["mistake"]:
                lines.append(f"   - Mistake: {le['mistake']}")
            if le["instead"]:
                lines.append(f"   - Instead: {le['instead']}")
            for s in le["steps"][:3]:
                lines.append(f"   - Step: {s}")
            if le["patterns"]:
                lines.append(f"   - Follow pattern(s): {', '.join(le['patterns'])} (architecture.get_pattern)")
        prompt = "\n".join(lines) + "\n"
    out.update(denial_stats=stats, weekly=weekly, denial_reasons=reasons[: max(limit, len(lessons_out))],
               iterations=iterations, lessons=lessons_out, prompt=prompt,
               fingerprint=hashlib.sha256(json.dumps([le["rule_id"] for le in lessons_out])
                                          .encode()).hexdigest()[:16] if lessons_out else None)
    return out


# ---------------------------------------------------------------------------------------------- OTLP export

def otlp_endpoint(pack) -> str | None:
    cfg = config(pack).get("otlp") or {}
    if cfg.get("enabled") is False:
        return None
    return os.environ.get("ARCH_OTLP_ENDPOINT") or (os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") if cfg.get("use_otel_env", True) else None)


def otlp_payload(pack, result: dict) -> dict:
    """OTLP/HTTP JSON logs payload: one record per run plus one per BLOCK/WARN finding."""
    cfg = config(pack).get("otlp") or {}
    ns = int(dt.datetime.fromisoformat(result["timestamp"]).timestamp() * 1e9)
    attr = lambda k, v: {"key": k, "value": {"intValue": str(v)} if isinstance(v, int) and not isinstance(v, bool)
                         else {"stringValue": "" if v is None else str(v)}}
    repo = result.get("repository") or {}
    common = [attr("architecture.run_id", result["run_id"]), attr("architecture.checkpoint", result["checkpoint"]),
              attr("architecture.caller", result.get("caller")), attr("vcs.ref.head.name", repo.get("branch")),
              attr("vcs.ref.head.revision", repo.get("head"))]
    sev = {"BLOCK": (17, "ERROR"), "WARN": (13, "WARN"), "PASS": (9, "INFO")}
    records = [{
        "timeUnixNano": str(ns), "severityNumber": sev[result["decision"]][0], "severityText": sev[result["decision"]][1],
        "body": {"stringValue": f"architecture.validate {result['checkpoint']} -> {result['decision']}"},
        "attributes": common + [attr("event.name", "architecture.run"), attr("architecture.decision", result["decision"]),
                                attr("architecture.findings.block", sum(f["outcome"] == "BLOCK" for f in result["findings"])),
                                attr("architecture.findings.warn", sum(f["outcome"] == "WARN" for f in result["findings"])),
                                attr("architecture.policy.version", (result.get("policy") or {}).get("version"))]}]
    for f in result["findings"]:
        if f["outcome"] not in ("BLOCK", "WARN"):
            continue
        records.append({
            "timeUnixNano": str(ns), "severityNumber": sev[f["outcome"]][0], "severityText": sev[f["outcome"]][1],
            "body": {"stringValue": f["message"]},
            "attributes": common + [attr("event.name", "architecture.finding"), attr("architecture.rule_id", f["rule_id"]),
                                    attr("architecture.finding_id", f["finding_id"]), attr("architecture.category", f.get("category")),
                                    attr("architecture.severity", f.get("severity")), attr("architecture.outcome", f["outcome"]),
                                    attr("architecture.status", f["status"]), attr("code.filepath", f.get("file")),
                                    attr("code.lineno", int(f["line"]) if str(f.get("line") or "").isdigit() else None)]})
    return {"resourceLogs": [{
        "resource": {"attributes": [attr("service.name", cfg.get("service_name", "architecture-policy")),
                                    attr("service.version", (result.get("policy") or {}).get("version"))]},
        "scopeLogs": [{"scope": {"name": "architecture-policy.history"}, "logRecords": records}]}]}


def export_otlp(pack, result: dict) -> dict | None:
    endpoint = otlp_endpoint(pack)
    if not endpoint:
        return None
    url = endpoint.rstrip("/") + ("" if endpoint.rstrip("/").endswith("/v1/logs") else "/v1/logs")
    timeout = float((config(pack).get("otlp") or {}).get("timeout_seconds", 2))
    try:
        req = urllib.request.Request(url, data=json.dumps(otlp_payload(pack, result)).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return {"exported": True, "endpoint": url, "status": resp.status}
    except Exception as exc:
        return {"exported": False, "endpoint": url, "error": f"{type(exc).__name__}: {exc}"}
