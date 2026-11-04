import html as htmllib
import re

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

_BLOCK_SPLIT = '<div class="tgme_widget_message_wrap'
_RE_POST = re.compile(r'data-post="([^/]+)/(\d+)"')
_RE_TIME = re.compile(r'<time datetime="([^"]+)"')
_RE_TEXT = re.compile(r'tgme_widget_message_text[^>]*>(.*?)</div>', re.S)
_RE_HREF = re.compile(r'href="(https?://[^"]+)"')
_RE_FWD = re.compile(r'tgme_widget_message_forwarded_from_name[^>]*>(.*?)</a>', re.S)


def _plain(fragment: str) -> str:
    s = re.sub(r"<br\s*/?>", "\n", fragment)
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"[ \t]+", " ", htmllib.unescape(s)).strip()


def parse_page(doc: str) -> list:
    from .models import Message

    out = []
    for block in doc.split(_BLOCK_SPLIT)[1:]:
        m_post = _RE_POST.search(block)
        m_time = _RE_TIME.search(block)
        if not m_post or not m_time:
            continue
        channel, msg_id = m_post.group(1), int(m_post.group(2))
        m_text = _RE_TEXT.search(block)
        inner = m_text.group(1) if m_text else ""
        links = list(dict.fromkeys(_RE_HREF.findall(inner)))
        m_fwd = _RE_FWD.search(block)
        out.append(Message(
            channel=channel,
            msg_id=msg_id,
            posted_at=m_time.group(1),
            text=_plain(inner),
            html=inner,
            links=links,
            has_media="tgme_widget_message_photo_wrap" in block,
            has_buttons="tgme_widget_message_inline_button" in block,
            forward_from=_plain(m_fwd.group(1)) if m_fwd else None,
        ))
    return out


def fetch_page(channel: str, before: int | None = None, session=None, proxy: str | None = None) -> str:
    url = f"https://t.me/s/{channel}"
    if before:
        url += f"?before={before}"
    proxies = {"http": proxy, "https": proxy} if proxy else None
    r = (session or requests).get(
        url,
        headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"},
        proxies=proxies,
        timeout=30,
    )
    r.raise_for_status()
    return r.text


def fetch_channel(channel: str, pages: int = 1, proxy: str | None = None,
                  until_id: int | None = None) -> list:
    """Walk backwards through the web preview, newest page first."""
    session = requests.Session()
    collected = []
    before = None
    for _ in range(pages):
        doc = fetch_page(channel, before=before, session=session, proxy=proxy)
        batch = parse_page(doc)
        if not batch:
            break
        collected.extend(batch)
        before = min(m.msg_id for m in batch)
        if until_id is not None and before <= until_id:
            break
    dedup = {m.msg_id: m for m in collected}
    return sorted(dedup.values(), key=lambda m: m.msg_id)
