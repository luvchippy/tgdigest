"""LLM 打分、跨帖聚类与一句话结论（OpenAI 兼容端点）。"""
import json
import os
import re
import time

import requests

DEFAULT_BASE = os.environ.get("LLM_BASE_URL", "https://napi.luvz.top/v1")
DEFAULT_MODEL = os.environ.get("LLM_MODEL", "deepseek-v4.1-flash-1017")
BATCH = 12
MAX_BODY = 400
MAX_REPLY = 150

SYSTEM = """你是中文技术资讯编辑。输入是 Telegram 技术频道转帖到论坛的帖子批次，每条带 id、标题、主帖正文、部分回复。

对每一条输出判断，要求：
1. label 取值：tech（真技术干货）/ freebie（可薅的免费或优惠）/ ad（商业推广、返利、抽奖拉新）/ noise（无信息量）。
2. summary：一句话说清"这是什么、值不值得点"，40 字以内。禁止复述标题，要基于正文和回复给出实质内容（具体工具名、结论、数字）。信息不足就写实际知道的部分。
3. cluster：同一事件的多个帖子填完全相同的短 slug（如 muse-giveaway、dx-repair）；不同事件务必填不同的值，独立事件用自身 id。
4. worth：0 到 1 的实用价值分。技术硬货与真实可薅的高，纯广告 0。
5. caveat：需要注意的坑（返利参数、限时、需要实名、有风险等），没有就空字符串。
6. 判 ad 时，仅当正文确实含促销/返利/抽奖/引流意图；论坛里的正常技术讨论即使提到价格也不算 ad。

只输出 JSON，形如 {"items":[{"id":"...","label":"...","cluster":"...","summary":"...","worth":0.0,"caveat":"..."}]}，不要任何解释或代码围栏。"""


def _clip(s: str, n: int) -> str:
    s = re.sub(r"\s+", " ", s or "").strip()
    return s[:n]


def build_payload(items: list[dict]) -> list[dict]:
    out = []
    for it in items:
        replies = []
        for c in (it.get("comments") or [])[:3]:
            replies.append(_clip(c[1] if isinstance(c, (list, tuple)) else str(c), MAX_REPLY))
        out.append({
            "id": it["key"],
            "title": _clip(it["title"], 120),
            "body": _clip(it.get("body", ""), MAX_BODY),
            "replies": replies,
            "rule_label": it.get("label_rule") or it.get("label"),
            "reply_count": it.get("reply_count", 0),
        })
    return out


def _extract_json(text: str) -> dict | None:
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?|\`\`\`$", "", text).strip()
    try:
        return json.loads(text)
    except Exception:
        pass
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def _post(base: str, key: str, model: str, messages: list, json_mode: bool) -> dict:
    body = {
        "model": model,
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": 4000,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    r = requests.post(
        base.rstrip("/") + "/chat/completions",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json=body,
        timeout=180,
    )
    r.raise_for_status()
    return r.json()


def analyze_batch(items: list[dict], base: str, key: str, model: str) -> dict:
    payload = build_payload(items)
    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    last_err = None
    for attempt, json_mode in enumerate((True, False, False)):
        try:
            data = _post(base, key, model, messages, json_mode)
            content = (data["choices"][0].get("message") or {}).get("content") or ""
            if not content.strip():
                last_err = "empty content"
                time.sleep(1.5)
                continue
            parsed = _extract_json(content)
            if parsed and isinstance(parsed.get("items"), list):
                return {str(x.get("id")): x for x in parsed["items"] if x.get("id")}
            last_err = "unparsable json"
        except Exception as exc:
            last_err = f"{type(exc).__name__}: {exc}"[:200]
        time.sleep(1.5 + attempt)
    print(f"  ! batch failed ({len(items)} items): {last_err}", flush=True)
    return {}


def analyze(items: list[dict], base: str | None = None, key: str | None = None,
            model: str | None = None) -> dict:
    """Returns {msg_key: verdict}. Missing keys keep their rule-based label."""
    base = base or DEFAULT_BASE
    key = key or os.environ.get("LLM_API_KEY") or os.environ.get("DEEPSEEK_API_KEY") or ""
    model = model or DEFAULT_MODEL
    if not key:
        print("! LLM_API_KEY unset, falling back to rules only", flush=True)
        return {}

    verdicts: dict[str, dict] = {}
    for i in range(0, len(items), BATCH):
        chunk = items[i:i + BATCH]
        got = analyze_batch(chunk, base, key, model)
        verdicts.update(got)
        print(f"  llm {min(i + BATCH, len(items))}/{len(items)} ok={len(got)}/{len(chunk)}", flush=True)
        time.sleep(1.0)
    return verdicts
