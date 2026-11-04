"""Telegram 私聊推送：HTML 渲染 + 4096 字符分片。"""
import html
import os
import time

import requests

API = "https://api.telegram.org/bot{token}/{method}"
LIMIT = 3900  # leave headroom under Telegram's 4096 hard limit


def _api(token: str, method: str, **params):
    """Telegram occasionally serves a mismatched cert from this network; retry, then fail."""
    last = None
    for attempt in range(4):
        try:
            r = requests.post(API.format(token=token, method=method), json=params, timeout=40)
            data = r.json()
            if not data.get("ok"):
                desc = data.get("description") or ""
                code = data.get("error_code")
                if code == 429:  # rate limited, honour retry_after
                    time.sleep(float((data.get("parameters") or {}).get("retry_after", 3)))
                    last = RuntimeError(f"{method} rate limited")
                    continue
                raise RuntimeError(f"{method} failed: {desc} [{code}]")
            return data["result"]
        except requests.exceptions.SSLError as exc:
            last = exc
            time.sleep(1.5 + attempt * 2)
        except requests.exceptions.RequestException as exc:
            last = exc
            time.sleep(1.5 + attempt * 2)
    raise RuntimeError(f"{method} unreachable: {type(last).__name__}: {last}")


def esc(s: str) -> str:
    return html.escape(s or "", quote=False)


def whoami(token: str) -> dict:
    return _api(token, "getMe")


def discover_chat_id(token: str) -> int | None:
    """Ask people to /start the bot, then read the newest private chat id."""
    data = _api(token, "getUpdates") or []
    for upd in reversed(data):
        msg = upd.get("message") or upd.get("edited_message") or {}
        chat = msg.get("chat") or {}
        if chat.get("type") == "private" and chat.get("id"):
            return int(chat["id"])
    return None


def send_html(token: str, chat_id: int, text: str) -> dict:
    return _api(token, "sendMessage", chat_id=chat_id, text=text,
                parse_mode="HTML", disable_web_page_preview=True)


def chunk_blocks(blocks: list[str], limit: int = LIMIT) -> list[str]:
    """Pack rendered blocks into messages without ever splitting one block."""
    chunks, cur = [], ""
    for b in blocks:
        if not b:
            continue
        if len(b) > limit:
            # A single oversized block: hard-split on line boundaries.
            lines, buf = b.split("\n"), ""
            for line in lines:
                if len(buf) + len(line) + 1 > limit:
                    if buf:
                        chunks.append(buf)
                    buf = line[:limit]
                else:
                    buf = f"{buf}\n{line}" if buf else line
            if buf:
                chunks.append(buf)
            continue
        if len(cur) + len(b) + 1 > limit:
            chunks.append(cur)
            cur = b
        else:
            cur = f"{cur}\n{b}" if cur else b
    if cur:
        chunks.append(cur)
    return chunks or [""]


def push(token: str, chat_id: int, blocks: list[str], delay: float = 1.5) -> int:
    chunks = chunk_blocks(blocks)
    for i, c in enumerate(chunks, 1):
        send_html(token, chat_id, c)
        if i < len(chunks):
            time.sleep(delay)
    return len(chunks)
