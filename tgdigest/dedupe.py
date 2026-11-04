import re
from difflib import SequenceMatcher

_KEEP = re.compile(r"[^0-9a-zA-Z\u4e00-\u9fff]+")


def _norm_title(text: str) -> str:
    """Strip URLs, punctuation and filler so near-identical titles collide."""
    t = re.sub(r"https?://\S+", " ", text or "")
    return _KEEP.sub("", t).lower()


def _bigrams(s: str) -> set:
    return {s[i:i + 2] for i in range(len(s) - 1)} if len(s) > 1 else {s}


def similarity(a: str, b: str) -> float:
    na, nb = _norm_title(a), _norm_title(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    ga, gb = _bigrams(na), _bigrams(nb)
    jac = len(ga & gb) / max(len(ga | gb), 1)
    seq = SequenceMatcher(None, na, nb).ratio()
    return max(jac, seq * 0.95)


def group(records, threshold: float = 0.55):
    """records: iterable of (key, text, url, richness). Returns {key: root_key}."""
    ordered = sorted(records, key=lambda r: -r[3])
    roots: list[tuple[str, str]] = []
    mapping: dict[str, str] = {}
    by_url: dict[str, str] = {}
    for key, text, url, _rich in ordered:
        if url and url in by_url:
            mapping[key] = by_url[url]
            continue
        matched = None
        for root_key, root_text in roots:
            if similarity(text, root_text) >= threshold:
                matched = root_key
                break
        root = matched or key
        mapping[key] = root
        roots.append((root, text))
        if url:
            by_url[url] = root
    return mapping
