import datetime
import html
import json
import re

from .dedupe import group
from .rules import classify_rule
from .textutil import clean as clean_text

BUCKETS = [
    ("tech", "🔥 技术与干货"),
    ("freebie", "💰 白嫖与优惠"),
    ("maybe", "📌 待判断"),
    ("ad", "🗑 已过滤（广告与噪音）"),
]
LOCAL_TZ = datetime.timezone(datetime.timedelta(hours=8))


def _clean(s: str, limit: int) -> str:
    return clean_text(s, limit, drop_urls=True)


def _fmt_time(iso: str) -> str:
    try:
        dt = datetime.datetime.fromisoformat((iso or "").replace("Z", "+00:00"))
        return dt.astimezone(LOCAL_TZ).strftime("%m-%d %H:%M")
    except Exception:
        return (iso or "")[5:16].replace("T", " ")


def _norm_label(label: str | None) -> str:
    label = (label or "").strip().lower()
    return label if label in ("tech", "freebie", "ad", "noise") else "noise"


def collect(store, channel: str, since_iso: str):
    rows = store.since(channel, since_iso)
    arts = store.article_map()
    items = []
    for r in rows:
        links = [x for x in (r["links"] or "").split("\n") if x]
        url = links[0] if links else None
        art = arts.get(url) if url else None
        body = (art["body"] if art else "") or ""
        comments = json.loads(art["comments"]) if art and art["comments"] else []
        reply_count = int(art["reply_count"]) if art else 0
        hay = (r["text"] or "") + "\n" + body
        v = classify_rule(hay, url, reply_count)
        items.append({
            "key": f'{r["channel"]}/{r["msg_id"]}',
            "msg_id": r["msg_id"],
            "posted_at": r["posted_at"],
            "title": _clean(r["text"], 120),
            "url": url,
            "article_ok": bool(art and art["body"]),
            "reply_count": reply_count,
            "body": body,
            "comments": comments,
            "label_rule": v.label,
            "score": v.score,
            "reason": v.reason,
            "label": "ad" if v.label == "ad" else ("freebie" if v.label == "freebie"
                     else ("tech" if v.label == "tech" else "noise")),
            "summary": "",
            "caveat": "",
            "cluster": None,
            "worth": {"tech": 0.6, "freebie": 0.5}.get(v.label, 0.1),
        })
    return items


def apply_verdicts(items, verdicts: dict):
    for it in items:
        v = verdicts.get(it["key"]) or {}
        if v:
            it["label"] = _norm_label(v.get("label"))
            it["summary"] = (v.get("summary") or "").strip()
            it["caveat"] = (v.get("caveat") or "").strip()
            it["cluster"] = (v.get("cluster") or "").strip() or None
            try:
                it["worth"] = float(v.get("worth") or 0.0)
            except (TypeError, ValueError):
                it["worth"] = 0.0
        if not it["summary"]:
            it["summary"] = _clean(it["body"], 110) or it["title"]
    return items


def _richness(it) -> float:
    return it["worth"] * 1000 + len(it["body"]) + it["reply_count"] * 120


def finalize(items):
    """Cluster same-event posts (LLM slug first, similarity fallback), pick a representative."""
    clusters: dict[str, list] = {}
    order: list[str] = []
    for it in items:
        c = it.get("cluster") or it["key"]
        if c not in clusters:
            clusters[c] = []
            order.append(c)
        clusters[c].append(it)

    singles = [c for c in order if len(clusters[c]) == 1]
    if len(singles) > 1:
        recs = []
        for c in singles:
            it = clusters[c][0]
            recs.append((it["key"], f'{it["title"]} {_clean(it["body"], 160)}',
                         it["url"], _richness(it)))
        mapping = group(recs, 0.62)
        merged: dict[str, list] = {}
        keep: list[str] = []
        for c in order:
            it = clusters[c][0]
            root = mapping.get(it["key"], it["key"]) if len(clusters[c]) == 1 else c
            if root not in merged:
                merged[root] = []
                keep.append(root)
            merged[root].extend(clusters[c])
        clusters, order = merged, keep

    entries = []
    for c in order:
        members = clusters[c]
        rep = max(members, key=_richness)
        entries.append({
            "cluster": c,
            "members": members,
            "rep": rep,
            "label": rep["label"],
            "count": len(members),
            "worth": rep["worth"],
        })
    return entries


def _entry_md(e, channel: str) -> list[str]:
    rep = e["rep"]
    out = [f'### {rep["summary"] or rep["title"]}']
    if e["count"] > 1:
        out.append(f'- 同事件 {e["count"]} 帖：' + " · ".join(
            f'[t.me/{channel}/{m["msg_id"]}](https://t.me/{channel}/{m["msg_id"]})'
            for m in e["members"][:12]))
    else:
        out.append(f'- 来源：[t.me/{channel}/{rep["msg_id"]}](https://t.me/{channel}/{rep["msg_id"]})'
                   + (f' → {rep["url"]}' if rep["url"] else ""))
    meta = [_fmt_time(rep["posted_at"])]
    if rep["reply_count"]:
        meta.append(f'{rep["reply_count"]} 回复')
    if rep["caveat"]:
        meta.append(f'⚠️ {rep["caveat"]}')
    if rep["label"] == "ad" and rep["reason"]:
        meta.append(f'判定：{rep["reason"]}')
    out.append("- " + " · ".join(meta))
    return out


def render_md(entries, channel: str, since_iso: str, out_path: str | None = None) -> str:
    total = sum(e["count"] for e in entries)
    lines = [f"# @{channel} 精简简报", "",
             f"数据起点 {since_iso[:16]} · 生成于 {datetime.datetime.now():%Y-%m-%d %H:%M}",
             f"原始 {total} 条 → 归并 {len(entries)} 条事件", ""]
    for label, heading in BUCKETS:
        bucket = sorted([e for e in entries if e["label"] == label],
                        key=lambda x: -x["worth"])
        if not bucket:
            continue
        lines.append(f"## {heading}（{len(bucket)}）")
        lines.append("")
        for e in bucket:
            lines.extend(_entry_md(e, channel))
            lines.append("")
    text = "\n".join(lines)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(text)
    return text


def _esc(s: str) -> str:
    return html.escape(clean_text(s or ""), quote=False)


def render_blocks(entries, channel: str, since_iso: str, stats: dict | None = None) -> list[str]:
    """One HTML block per event, packed into <=4096 messages by the notifier."""
    total = sum(e["count"] for e in entries)
    counts = {label: sum(1 for e in entries if e["label"] == label) for label, _ in BUCKETS}
    head = [
        f'<b>📰 @{channel} 精简简报</b>',
        f'{_fmt_time(since_iso)} 起 · 原始 {total} 条 → {len(entries)} 条事件',
        f'技术 {counts["tech"]} · 羊毛 {counts["freebie"]} · 待判 {counts["maybe"]} · 过滤 {counts["ad"]}',
    ]
    if stats:
        head.append(f'LLM 覆盖 {stats.get("llm", 0)} 条 · 正文成功率 {stats.get("enrich", "?")}')
    blocks = ["\n".join(head)]

    icons = {"tech": "🔥", "freebie": "💰", "maybe": "📌", "ad": "🗑"}
    for label, heading in BUCKETS:
        bucket = sorted([e for e in entries if e["label"] == label], key=lambda x: -x["worth"])
        if not bucket:
            continue
        blocks.append(f'\n<b>{heading}</b>（{len(bucket)}）')
        if label == "ad":
            reasons = {}
            for e in bucket:
                r = (e["rep"]["reason"] or "其他").split("、")[0]
                reasons[r] = reasons.get(r, 0) + 1
                # ads collapse to one summary line per reason
            detail = " · ".join(f"{k} {v}" for k, v in sorted(reasons.items(), key=lambda x: -x[1]))
            blocks.append(f'<i>已折叠 {len(bucket)} 条：{_esc(detail)}</i>')
            for e in bucket[:5]:
                rep = e["rep"]
                blocks.append(
                    f'{icons[label]} <a href="https://t.me/{channel}/{rep["msg_id"]}">'
                    f'{_esc(rep["summary"] or rep["title"])[:60]}</a>')
            continue
        for e in bucket:
            rep = e["rep"]
            body = [f'{icons[label]} <b>{_esc(rep["summary"] or rep["title"])}</b>']
            if e["count"] > 1:
                links = " · ".join(
                    f'<a href="https://t.me/{channel}/{m["msg_id"]}">#{m["msg_id"]}</a>'
                    for m in e["members"][:10])
                body.append(f'同一事件 {e["count"]} 帖：{links}')
            else:
                body.append(f'📍 <a href="https://t.me/{channel}/{rep["msg_id"]}">t.me/{channel}/{rep["msg_id"]}</a>'
                            + (f' → <a href="{html.escape(rep["url"])}">原帖</a>' if rep["url"] else ""))
            tail = [_fmt_time(rep["posted_at"])]
            if rep["reply_count"]:
                tail.append(f'{rep["reply_count"]} 回复')
            if rep["caveat"]:
                tail.append(f'⚠️ {_esc(rep["caveat"])[:60]}')
            body.append("🕐 " + " · ".join(tail))
            blocks.append("\n".join(body))
    return blocks
