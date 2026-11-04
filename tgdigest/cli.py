import argparse
import datetime
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from . import llm, notifier
from .article import fetch_article, is_forum_url, make_session
from .report import apply_verdicts, collect, finalize, render_blocks, render_md
from .source_tg import fetch_channel
from .store import Store


def _since_iso(hours: float, since: str | None = None) -> str:
    if since:
        return since
    return (datetime.datetime.now(datetime.timezone.utc)
            - datetime.timedelta(hours=hours)).isoformat(timespec="seconds")


def channels_of(args) -> list[str]:
    """--channel accepts "a,b,c" or repeated flags; "@" prefixes are tolerated."""
    raw = getattr(args, "channel", None) or []
    if isinstance(raw, str):
        raw = [raw]
    out = []
    for chunk in raw:
        for part in chunk.split(","):
            name = part.strip().lstrip("@")
            if name and name not in out:
                out.append(name)
    return out


def cmd_fetch(args):
    store = Store(args.db)
    total = 0
    for channel in channels_of(args):
        try:
            msgs = fetch_channel(channel, pages=args.pages, proxy=args.proxy)
        except Exception as exc:
            print(f"! fetch @{channel} failed: {type(exc).__name__}: {exc}"[:200], file=sys.stderr)
            continue
        if not msgs:
            print(f"! no messages parsed for @{channel}", file=sys.stderr)
            continue
        store.upsert_messages(msgs)
        total += len(msgs)
        print(f"@{channel}: {len(msgs)} messages  id_range={msgs[0].msg_id}..{msgs[-1].msg_id}")
        print(f"  time_range={msgs[0].posted_at} .. {msgs[-1].posted_at}"
              f"  total_in_db={store.count(channel)}")
    return 0 if total else 2


def _host_of(url: str) -> str:
    return re.sub(r"^https?://([^/]+).*", r"\1", url).lower()


def cmd_enrich(args):
    store = Store(args.db)
    rows = store.recent(channels_of(args), args.limit)
    arts = store.article_map()
    todo = []
    for r in rows:
        links = [x for x in (r["links"] or "").split("\n") if x]
        if not links:
            continue
        url = links[0]
        prev = arts.get(url)
        if prev and (prev["body"] or prev["status"] == 404):
            continue
        if not is_forum_url(url):
            # Vendor pages and consoles never yield discussion; mark once, skip forever.
            if not prev:
                store.save_article(url, 0, "skipped", "", "", [], 0, "non-forum")
            continue
        todo.append(url)
    todo = list(dict.fromkeys(todo))
    print(f"pending {len(todo)} forum urls (cached {len(arts)})")
    if not todo:
        return 0

    by_host: dict[str, list[str]] = {}
    for u in todo:
        by_host.setdefault(_host_of(u), []).append(u)

    lock = threading.Lock()
    stats = {"ok": 0, "fail": 0, "done": 0}
    reasons: dict[str, int] = {}

    def note(art):
        if art.ok:
            key = "ok"
        elif art.status:
            key = f"http {art.status}"
        else:
            err = art.error or "unknown"
            key = err.split(":")[0][:40]
        stats["ok" if art.ok else "fail"] += 1
        stats["done"] += 1
        reasons[key] = reasons.get(key, 0) + 1

    def work(host: str, urls: list[str]):
        session = make_session(args.proxy)
        throttled = 0  # consecutive 429s for this host
        for u in urls:
            if throttled >= 2:
                # Circuit breaker: CI egress IPs are heavily rate limited by
                # Cloudflare forums. Stop hammering, leave the rest for next run.
                print(f"  ! {host} throttled, deferring {urls.index(u)} remaining urls")
                break
            art = None
            for attempt in range(3):
                art = fetch_article(u, args.proxy, session=session)
                if art.ok or art.status == 404:
                    break
                if art.status == 429:
                    time.sleep(6.0 + attempt * 6)
                    continue
                if art.error and "Timeout" not in art.error:
                    break
                time.sleep(2.0 + attempt * 2)
            with lock:
                store.save_article(u, art.status, art.site, art.title, art.body,
                                   art.comments, art.reply_count, art.error)
                note(art)
                if stats["done"] % 25 == 0:
                    print(f'  {stats["done"]}/{len(todo)}')
            throttled = throttled + 1 if art.status == 429 else 0
            time.sleep(args.delay)

    with ThreadPoolExecutor(max_workers=min(args.workers, len(by_host))) as ex:
        futs = [ex.submit(work, h, us) for h, us in by_host.items()]
        for f in as_completed(futs):
            f.result()
    print(f'enriched ok={stats["ok"]} fail={stats["fail"]}')
    print("enrich breakdown: " + " · ".join(f"{k} {v}" for k, v in sorted(reasons.items(), key=lambda x: -x[1])))
    for host, n in sorted(((h, len(u)) for h, u in by_host.items()), key=lambda x: -x[1]):
        print(f"  host {host}: {n} urls")
    return 0


def _load_items(args, store, with_verdicts: bool = False):
    since = _since_iso(args.hours, args.since)
    items = collect(store, channels_of(args), since)
    if with_verdicts:
        apply_verdicts(items, store.load_verdicts([i["key"] for i in items]))
    return since, items


def cmd_report(args):
    store = Store(args.db)
    since, items = _load_items(args, store, with_verdicts=True)
    entries = finalize(items)
    out = args.out or f"data/report-{datetime.datetime.now():%Y%m%d-%H%M}.md"
    text = render_md(entries, channels_of(args), since, out)
    print(f"wrote {out}  ({len(items)} messages → {len(entries)} events)")
    print()
    print(text[:1200])
    return 0


def cmd_analyze(args):
    store = Store(args.db)
    since, items = _load_items(args, store)
    if not items:
        print("nothing to analyze")
        return 0
    # Daily runs revisit the same window; only ask the model about keys we lack.
    known = set() if args.refresh else set(store.load_verdicts([i["key"] for i in items]))
    todo = [i for i in items if i["key"] not in known]
    print(f"analyzing {len(todo)}/{len(items)} items via {args.base} / {args.model}")
    verdicts = llm.analyze(todo, base=args.base, key=args.key, model=args.model) if todo else {}
    if verdicts:
        store.save_verdicts(verdicts, args.model)
    # Fresh verdicts only cover new keys; the rest come back from the database.
    apply_verdicts(items, store.load_verdicts([i["key"] for i in items]))
    entries = finalize(items)
    out = args.out or f"data/digest-{datetime.datetime.now():%Y%m%d-%H%M}.md"
    render_md(entries, channels_of(args), since, out)
    print(f"llm verdicts {len(verdicts)}/{len(items)} -> {out} ({len(entries)} events)")
    for e in entries[:8]:
        print(f'  [{e["label"]}] {e["rep"]["summary"][:60]}')
    return 0


def cmd_push(args):
    token = args.token or os.environ.get("TG_BOT_TOKEN")
    if not token:
        print("! TG_BOT_TOKEN missing", file=sys.stderr)
        return 2
    chat_id = args.chat_id or os.environ.get("TG_CHAT_ID")
    if not chat_id:
        chat_id = notifier.discover_chat_id(token)
        if not chat_id:
            print("! no private chat found: send /start to the bot once, then retry",
                  file=sys.stderr)
            return 3
        print(f"discovered chat_id={chat_id}")
    chat_id = int(chat_id)

    store = Store(args.db)
    since, items = _load_items(args, store, with_verdicts=True)
    if not items:
        print("nothing to push")
        return 0
    ok = sum(1 for i in items if i["article_ok"])
    stats = {"llm": sum(1 for i in items if i.get("cluster")), "enrich": f"{ok}/{len(items)}"}
    entries = finalize(items)
    # Watermark: an event is only "delivered" once every member was delivered.
    # Comparing the whole member set survives clustering shifts between runs.
    sent = set() if args.reset else store.pushed_keys()
    fresh = [e for e in entries
             if not all(m["key"] in sent for m in e["members"])]
    print(f"events {len(entries)} -> fresh {len(fresh)} (already delivered {len(entries) - len(fresh)})")
    if not fresh:
        print("nothing new to push")
        return 0
    blocks = render_blocks(fresh, channels_of(args), since, stats)
    if args.dry_run:
        print("\n\n---8<---\n\n".join(blocks)[:3000])
        print(f"[dry-run] {len(notifier.chunk_blocks(blocks))} messages would be sent")
        return 0
    n = notifier.push(token, chat_id, blocks)
    store.mark_pushed_keys([m["key"] for e in fresh for m in e["members"]])
    store.mark_pushed(datetime.date.today().isoformat(), len(fresh))
    print(f"pushed {n} messages to chat {chat_id} ({len(fresh)} events)")
    return 0


def cmd_chatid(args):
    token = args.token or os.environ.get("TG_BOT_TOKEN")
    print(notifier.whoami(token))
    cid = notifier.discover_chat_id(token)
    print("chat_id:", cid)
    return 0 if cid else 3


def cmd_run(args):
    """fetch → enrich → analyze → push. Safe to run several times a day:
    only events whose representative was never delivered get pushed."""
    if args.force:
        args.reset = True
    for step, fn in (("fetch", cmd_fetch), ("enrich", cmd_enrich)):
        print(f"--- {step} ---")
        rc = fn(args)
        if rc not in (0, None):
            print(f"! {step} failed rc={rc}", file=sys.stderr)

    print("--- analyze ---")
    rc = cmd_analyze(args)
    if rc not in (0, None):
        print("! analyze failed, falling back to rule labels", file=sys.stderr)
    if args.no_push:
        return 0
    print("--- push ---")
    return cmd_push(args)


def cmd_list(args):
    store = Store(args.db)
    for row in store.recent(channels_of(args), args.limit):
        links = [x for x in row["links"].split("\n") if x]
        print(f'{row["msg_id"]:>7} | {row["posted_at"][:19]} | {row["text"][:50]!r} | {links[0] if links else "-"}')
    return 0


def _add_window(p, default_hours=24.0):
    p.add_argument("--hours", type=float, default=default_hours)
    p.add_argument("--since", default=None)


def main(argv=None):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    p = argparse.ArgumentParser(prog="tgdigest")
    p.add_argument("--db", default="data/tgdigest.db")
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("fetch")
    f.add_argument("--channel", required=True, help="频道名，多个用逗号分隔")
    f.add_argument("--pages", type=int, default=1)
    f.add_argument("--proxy", default=None)
    f.set_defaults(func=cmd_fetch)

    e = sub.add_parser("enrich")
    e.add_argument("--channel", required=True)
    e.add_argument("--limit", type=int, default=100)
    e.add_argument("--workers", type=int, default=4, help="concurrent hosts")
    e.add_argument("--delay", type=float, default=2.0, help="seconds between requests per host")
    e.add_argument("--proxy", default=None)
    e.set_defaults(func=cmd_enrich)

    rp = sub.add_parser("report")
    rp.add_argument("--channel", required=True)
    _add_window(rp)
    rp.add_argument("--out", default=None)
    rp.set_defaults(func=cmd_report)

    an = sub.add_parser("analyze")
    an.add_argument("--channel", required=True)
    _add_window(an)
    an.add_argument("--base", default=llm.DEFAULT_BASE)
    an.add_argument("--model", default=llm.DEFAULT_MODEL)
    an.add_argument("--key", default=None)
    an.add_argument("--out", default=None)
    an.add_argument("--refresh", action="store_true", help="re-ask the model for known items")
    an.set_defaults(func=cmd_analyze)

    pu = sub.add_parser("push")
    pu.add_argument("--channel", required=True)
    _add_window(pu)
    pu.add_argument("--token", default=None)
    pu.add_argument("--chat-id", type=int, default=None)
    pu.add_argument("--dry-run", action="store_true")
    pu.add_argument("--reset", action="store_true", help="ignore the push watermark")
    pu.set_defaults(func=cmd_push)

    ci = sub.add_parser("chatid")
    ci.add_argument("--token", default=None)
    ci.set_defaults(func=cmd_chatid)

    ru = sub.add_parser("run")
    ru.add_argument("--channel", required=True)
    _add_window(ru)
    ru.add_argument("--pages", type=int, default=5)
    ru.add_argument("--limit", type=int, default=120)
    ru.add_argument("--workers", type=int, default=4)
    ru.add_argument("--delay", type=float, default=2.0)
    ru.add_argument("--proxy", default=None)
    ru.add_argument("--base", default=llm.DEFAULT_BASE)
    ru.add_argument("--model", default=llm.DEFAULT_MODEL)
    ru.add_argument("--key", default=None)
    ru.add_argument("--token", default=None)
    ru.add_argument("--chat-id", type=int, default=None)
    ru.add_argument("--out", default=None)
    ru.add_argument("--force", action="store_true", help="re-push everything")
    ru.add_argument("--reset", action="store_true", help="ignore the push watermark")
    ru.add_argument("--refresh", action="store_true")
    ru.add_argument("--no-push", action="store_true")
    ru.add_argument("--dry-run", action="store_true")
    ru.set_defaults(func=cmd_run)

    l = sub.add_parser("list")
    l.add_argument("--channel", required=True)
    l.add_argument("--limit", type=int, default=20)
    l.set_defaults(func=cmd_list)

    args = p.parse_args(argv)
    for attr in ("channel", "pages", "proxy", "limit", "workers", "delay"):
        if not hasattr(args, attr):
            setattr(args, attr, None)
    if getattr(args, "limit", None) is None:
        args.limit = 100
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
