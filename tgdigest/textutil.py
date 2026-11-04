import re

# Terminal colour codes survive copy-paste from shell output into forum posts.
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]|\[[0-9;]{1,3}m")
_URL = re.compile(r"https?://\S+")
_WS = re.compile(r"[ \t\u00a0]+")
_MULTI_NL = re.compile(r"\n{3,}")


def strip_ansi(s: str) -> str:
    return _ANSI.sub("", s or "")


def clean(s: str, limit: int | None = None, drop_urls: bool = False) -> str:
    t = strip_ansi(s or "")
    if drop_urls:
        t = _URL.sub(" ", t)
    t = _WS.sub(" ", t)
    t = _MULTI_NL.sub("\n\n", t).strip()
    return t[:limit] if limit else t
