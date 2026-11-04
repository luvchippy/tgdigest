import sqlite3
from pathlib import Path

from .models import Message

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    channel      TEXT NOT NULL,
    msg_id       INTEGER NOT NULL,
    posted_at    TEXT NOT NULL,
    text         TEXT NOT NULL,
    html         TEXT NOT NULL,
    links        TEXT NOT NULL DEFAULT '',
    has_media    INTEGER NOT NULL DEFAULT 0,
    has_buttons  INTEGER NOT NULL DEFAULT 0,
    forward_from TEXT,
    PRIMARY KEY (channel, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_posted ON messages(channel, posted_at);

CREATE TABLE IF NOT EXISTS articles (
    url        TEXT PRIMARY KEY,
    status     INTEGER,
    site       TEXT,
    title      TEXT,
    body       TEXT,
    comments   TEXT,
    reply_count INTEGER DEFAULT 0,
    fetched_at TEXT,
    error      TEXT
);

CREATE TABLE IF NOT EXISTS digests (
    day        TEXT PRIMARY KEY,
    count      INTEGER NOT NULL DEFAULT 0,
    created_at TEXT
);

-- Push watermark: one row per event representative already delivered.
CREATE TABLE IF NOT EXISTS pushed (
    msg_key    TEXT PRIMARY KEY,
    pushed_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verdicts (
    msg_key    TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    category   TEXT,
    score      REAL,
    reason     TEXT,
    summary    TEXT,
    dup_of     TEXT,
    model      TEXT,
    created_at TEXT
);
"""


class Store:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Writers serialize on an external lock; the connection is shared across worker threads.
        self.db = sqlite3.connect(str(self.path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self._migrate()

    def _migrate(self):
        cols = {r["name"] for r in self.db.execute("PRAGMA table_info(articles)")}
        for col, ddl in (("comments", "TEXT"), ("reply_count", "INTEGER DEFAULT 0"),
                         ("site", "TEXT")):
            if col not in cols:
                self.db.execute(f"ALTER TABLE articles ADD COLUMN {col} {ddl}")
        self.db.commit()

    def upsert_messages(self, msgs: list[Message]) -> int:
        rows = [
            (m.channel, m.msg_id, m.posted_at, m.text, m.html, "\n".join(m.links),
             int(m.has_media), int(m.has_buttons), m.forward_from)
            for m in msgs
        ]
        self.db.executemany(
            """INSERT INTO messages
               (channel, msg_id, posted_at, text, html, links, has_media, has_buttons, forward_from)
               VALUES (?,?,?,?,?,?,?,?,?)
               ON CONFLICT(channel, msg_id) DO UPDATE SET
                 text=excluded.text, html=excluded.html, links=excluded.links""",
            rows,
        )
        self.db.commit()
        return len(rows)

    def max_msg_id(self, channel: str) -> int | None:
        r = self.db.execute("SELECT MAX(msg_id) m FROM messages WHERE channel=?", (channel,)).fetchone()
        return r["m"] if r and r["m"] else None

    def count(self, channel: str | None = None) -> int:
        sql = "SELECT COUNT(*) c FROM messages" + (" WHERE channel=?" if channel else "")
        r = self.db.execute(sql, (channel,) if channel else ()).fetchone()
        return r["c"]

    def recent(self, channel: str, limit: int = 20):
        return self.db.execute(
            "SELECT * FROM messages WHERE channel=? ORDER BY msg_id DESC LIMIT ?",
            (channel, limit)).fetchall()

    def since(self, channel: str, since_iso: str, limit: int = 2000):
        return self.db.execute(
            "SELECT * FROM messages WHERE channel=? AND posted_at>=? ORDER BY msg_id ASC LIMIT ?",
            (channel, since_iso, limit)).fetchall()

    def article_map(self) -> dict:
        out = {}
        for r in self.db.execute("SELECT * FROM articles"):
            out[r["url"]] = r
        return out

    def save_verdicts(self, verdicts: dict, model: str):
        import datetime
        now = datetime.datetime.now().isoformat(timespec="seconds")
        rows = [
            (k, str(v.get("label") or ""), str(v.get("cluster") or ""),
             float(v.get("worth") or 0.0), str(v.get("caveat") or ""),
             str(v.get("summary") or ""), None, model, now)
            for k, v in verdicts.items()
        ]
        self.db.executemany(
            """INSERT INTO verdicts (msg_key,label,category,score,reason,summary,dup_of,model,created_at)
               VALUES (?,?,?,?,?,?,?,?,?)
               ON CONFLICT(msg_key) DO UPDATE SET
                 label=excluded.label, category=excluded.category, score=excluded.score,
                 reason=excluded.reason, summary=excluded.summary, model=excluded.model,
                 created_at=excluded.created_at""",
            rows,
        )
        self.db.commit()
        return len(rows)

    def load_verdicts(self, msg_keys: list[str] | None = None) -> dict:
        sql = "SELECT * FROM verdicts"
        rows = self.db.execute(sql).fetchall()
        if msg_keys is not None:
            allow = set(msg_keys)
            rows = [r for r in rows if r["msg_key"] in allow]
        return {
            r["msg_key"]: {
                "label": r["label"],
                "cluster": r["category"],
                "worth": r["score"],
                "caveat": r["reason"],
                "summary": r["summary"],
            }
            for r in rows
        }

    def pushed_keys(self) -> set:
        return {r["msg_key"] for r in self.db.execute("SELECT msg_key FROM pushed")}

    def mark_pushed_keys(self, keys: list[str]):
        import datetime
        now = datetime.datetime.now().isoformat(timespec="seconds")
        self.db.executemany(
            "INSERT INTO pushed (msg_key,pushed_at) VALUES (?,?) "
            "ON CONFLICT(msg_key) DO UPDATE SET pushed_at=excluded.pushed_at",
            [(k, now) for k in keys])
        self.db.commit()

    def pushed_days(self, lookback: int = 30) -> set:
        return {r["day"] for r in self.db.execute(
            "SELECT day FROM digests ORDER BY day DESC LIMIT ?", (lookback,))}

    def mark_pushed(self, day: str, count: int):
        import datetime
        self.db.execute(
            "INSERT INTO digests (day,count,created_at) VALUES (?,?,?) "
            "ON CONFLICT(day) DO UPDATE SET count=excluded.count, created_at=excluded.created_at",
            (day, count, datetime.datetime.now().isoformat(timespec="seconds")))
        self.db.commit()

    def save_article(self, url: str, status: int, site: str, title: str, body: str,
                     comments, reply_count: int, error: str | None):
        import datetime
        import json
        self.db.execute(
            """INSERT INTO articles (url,status,site,title,body,comments,reply_count,fetched_at,error)
               VALUES (?,?,?,?,?,?,?,?,?)
               ON CONFLICT(url) DO UPDATE SET
                 status=excluded.status, site=excluded.site, title=excluded.title,
                 body=excluded.body, comments=excluded.comments,
                 reply_count=excluded.reply_count, fetched_at=excluded.fetched_at,
                 error=excluded.error""",
            (url, status, site, title, body, json.dumps(comments, ensure_ascii=False),
             reply_count, datetime.datetime.now().isoformat(timespec="seconds"), error))
        self.db.commit()
