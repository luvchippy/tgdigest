import json
import re
from dataclasses import dataclass, field
from urllib.parse import urlparse, urlunparse

from bs4 import BeautifulSoup
from curl_cffi import requests as creq

from .textutil import clean as clean_text

UA_LANG = {"Accept-Language": "zh-CN,zh;q=0.9"}

DISCOURSE = {"linux.do", "www.nodeloc.com", "nodeloc.com"}

# Non-Discourse forums: (topic body selector, reply selectors)
HTML_PROFILES = {
    "www.nodeseek.com": ("article.post-content", ["article.post-content"]),
    "www.v2ex.com": ("div.topic_content", ["div.reply_content"]),
}

# Only forums carry discussion worth summarizing. Vendor landing pages, cloud
# consoles and short-link redirectors are noise: they 403, redirect, or return
# JS shells, so fetching them only burns the workflow time budget.
FORUM_HOSTS = DISCOURSE | set(HTML_PROFILES)

MAX_COMMENTS = 8
MAX_BODY = 6000


def is_forum_url(url: str) -> bool:
    return urlparse(url).netloc.lower() in FORUM_HOSTS


def _soup_text(fragment: str) -> str:
    soup = BeautifulSoup(fragment, "lxml")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    return clean_text(soup.get_text("\n", strip=True))


def _discourse_json_url(url: str) -> str | None:
    p = urlparse(url)
    m = re.search(r"/t/(?:[^/]+/)?(\d+)", p.path)
    if not m:
        return None
    return urlunparse(p._replace(path=f"/t/{m.group(1)}.json", query="", fragment=""))


def _from_discourse_json(session, url: str) -> Article | None:
    js_url = _discourse_json_url(url)
    if not js_url:
        return None
    r = session.get(js_url, headers=UA_LANG, timeout=30)
    if r.status_code != 200 or not r.headers.get("content-type", "").startswith("application/json"):
        return None
    data = json.loads(r.text)
    posts = (data.get("post_stream") or {}).get("posts") or []
    if not posts:
        return None
    comments = []
    for p in posts[1:]:
        txt = _soup_text(p.get("cooked") or "")
        if txt:
            comments.append((p.get("username") or "?", txt[:400]))
    return Article(
        url=url,
        status=r.status_code,
        site="discourse",
        title=data.get("title") or "",
        body=_soup_text(posts[0].get("cooked") or "")[:3000],
        author=posts[0].get("username") or "",
        comments=comments[:MAX_COMMENTS],
        reply_count=max(int(data.get("posts_count") or 1) - 1, len(comments)),
    )


def _from_html(session, url: str, host: str) -> Article:
    body_sel, reply_sels = HTML_PROFILES.get(host, (None, []))
    r = session.get(url, headers=UA_LANG, timeout=30)
    soup = BeautifulSoup(r.text, "lxml")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()

    title = ""
    og = soup.find("meta", property="og:title")
    if og and og.get("content"):
        title = og["content"]
    elif soup.h1:
        title = soup.h1.get_text(" ", strip=True)

    node = soup.select_one(body_sel) if body_sel else None
    if node is None:
        best, best_len = None, 0
        for el in soup.find_all(["article", "main"]):
            txt = el.get_text(" ", strip=True)
            if len(txt) > best_len:
                best, best_len = el, len(txt)
        node = best
    body = re.sub(r"[ \t]+", " ", node.get_text("\n", strip=True)) if node else ""

    comments = []
    for sel in reply_sels:
        nodes = soup.select(sel)
        for el in nodes[1:] if host == "www.nodeseek.com" else nodes:
            txt = re.sub(r"[ \t]+", " ", el.get_text("\n", strip=True))
            if txt and not txt.startswith(body[:20]):
                comments.append(("anon", txt[:400]))
        if host == "www.nodeseek.com":
            break
    return Article(url=url, status=r.status_code, site="html", title=title,
                   body=body[:3000], comments=comments[:MAX_COMMENTS],
                   reply_count=len(comments))


def make_session(proxy: str | None = None):
    proxies = {"http": proxy, "https": proxy} if proxy else None
    return creq.Session(impersonate="chrome", proxies=proxies)


def fetch_article(url: str, proxy: str | None = None, session=None) -> Article:
    session = session or make_session(proxy)
    host = urlparse(url).netloc.lower()
    try:
        if host in DISCOURSE:
            art = _from_discourse_json(session, url)
            if art and art.ok:
                return art
        return _from_html(session, url, host)
    except Exception as exc:
        return Article(url=url, error=f"{type(exc).__name__}: {exc}"[:200])
