"""用 curl_cffi（模拟 Chrome TLS 指纹）抓 NodeSeek 列表与正文。

实测结论：impersonate="chrome" / "safari" 能过 NodeSeek 的 Cloudflare 防护并取到 .post-content 正文；
"chrome131" 反而被 403。所以这里固定用 chrome。
输出 JSON 数组到 $NODESEEK_RAW（默认 /tmp/nodeseek-raw.json），供 Node 的抓取层直接读取。
"""
import json
import os
import re
import sys
import time

from bs4 import BeautifulSoup
from curl_cffi import requests as creq

BASE = "https://www.nodeseek.com"
PAGES = int(os.environ.get("NODESEEK_PAGES", "3"))
DETAIL_LIMIT = int(os.environ.get("NODESEEK_DETAIL", "20"))
OUT = os.environ.get("NODESEEK_RAW", "/tmp/nodeseek-raw.json")
IMPERSONATE = os.environ.get("NODESEEK_IMPERSONATE", "chrome")

BLOCK_HINT = re.compile(r"Just a moment|ipv6\s*已关闭|请稍候|Verifying you are human", re.I)


def strip_tags(fragment: str) -> str:
    fragment = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", fragment, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", fragment)
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
                .replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'"))
    return re.sub(r"\s+", " ", text).strip()


def parse_list(html: str):
    """主列表锚点：href 指向 /post-N-1、不带 # 锚点、不带 info-item 类。主列表在页面最前，取前 30 条。"""
    out, seen = [], set()
    for m in re.finditer(r'<a\b([^>]*)>([\s\S]*?)</a>', html):
        attrs, inner = m.group(1), m.group(2)
        if 'info-item' in attrs:
            continue
        href_m = re.search(r'href="([^"]+)"', attrs)
        if not href_m:
            continue
        href = href_m.group(1)
        if "#" in href:
            continue
        id_m = re.search(r"/post-(\d+)-1$", href)
        if not id_m:
            continue
        pid = id_m.group(1)
        if pid in seen:
            continue
        title = strip_tags(inner)
        if not title or re.match(r"^\d+\s*(min|hour|day|month|year)s?\s*ago$", title, re.I):
            continue
        seen.add(pid)
        out.append({"id": pid, "title": title, "url": f"{BASE}/post-{pid}-1"})
        if len(out) >= 30:
            break
    return out


def extract_body(html: str) -> str:
    m = re.search(r'<(article|div)[^>]*class="[^"]*\bpost-content\b[^"]*"[^>]*>([\s\S]*?)</\1>', html, re.I)
    if m:
        text = strip_tags(m.group(2))
        if len(text) > 20:
            return text
    m = re.search(r'<meta[^>]+(?:property|name)="(?:og:description|description)"[^>]+content="([^"]+)"', html, re.I)
    return strip_tags(m.group(1)) if m else ""


def extract_comments(html: str, limit: int = 5) -> list:
    """评论区结构：<div class="comment-container"> 内 <ul class="comments"> 的 <li class="content-item">。"""
    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        return []

    out = []
    for li in soup.select("ul.comments li.content-item"):
        name_el = li.select_one(".author-name")
        author = name_el.get_text(strip=True) if name_el else "?"
        body_el = li.select_one(".content-content") or li.select_one(".comment-content") or li
        text = re.sub(r"\s+", " ", body_el.get_text(" ", strip=True)).strip()
        if author and text.startswith(author):
            text = text[len(author):].strip()
        if len(text) < 4:
            continue
        out.append({"author": author, "text": text[:220], "likes": 0})
        if len(out) >= limit:
            break
    return out


def extract_stats(html: str) -> str:
    """浏览 / 点赞 / 回复。结构不稳，取不到就返回空串，不编造。"""
    views = re.search(r'([\d,]+)\s*(?:次)?浏览', html)
    likes = re.search(r'href="#star[^"]*"[^>]*>\s*</use>\s*</svg>\s*<span[^>]*>([\d,]+)</span>', html)
    parts = []
    if views:
        parts.append(f"{views.group(1)} 浏览")
    if likes:
        parts.append(f"{likes.group(1)} 赞")
    return " / ".join(parts)


def main() -> int:
    session = creq.Session(impersonate=IMPERSONATE)
    posts = {}

    for page in range(1, PAGES + 1):
        url = BASE + ("/" if page == 1 else f"/page-{page}")
        try:
            r = session.get(url, timeout=45, allow_redirects=True)
            if r.status_code != 200:
                print(f"  [py] page-{page} HTTP {r.status_code}", file=sys.stderr)
                continue
            if BLOCK_HINT.search(r.text[:4000]):
                print(f"  [py] page-{page} 被拦截页挡住", file=sys.stderr)
                continue
            listed = parse_list(r.text)
            added = 0
            for p in listed:
                if p["id"] not in posts:
                    posts[p["id"]] = p
                    added += 1
            print(f"  [py] page-{page}: 解析 {len(listed)} 条, 新增 {added} 条, {len(r.text)} 字节", file=sys.stderr)
        except Exception as e:
            print(f"  [py] page-{page} 失败: {type(e).__name__}: {str(e)[:100]}", file=sys.stderr)

    for i, p in enumerate(list(posts.values())[:DETAIL_LIMIT]):
        try:
            r = session.get(p["url"], timeout=45, allow_redirects=True)
            if r.status_code == 200 and not BLOCK_HINT.search(r.text[:4000]):
                p["text"] = extract_body(r.text)[:1200]
                p["replies"] = extract_comments(r.text)
                stats = extract_stats(r.text)
                if stats:
                    p["stats"] = stats
        except Exception:
            pass
        if i % 5 == 4:
            time.sleep(0.3)

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(list(posts.values()), f, ensure_ascii=False)

    with_body = sum(1 for p in posts.values() if p.get("text"))
    with_replies = sum(1 for p in posts.values() if p.get("replies"))
    print(f"  [py] 共 {len(posts)} 条，{with_body} 条有正文，{with_replies} 条有评论 -> {OUT}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
