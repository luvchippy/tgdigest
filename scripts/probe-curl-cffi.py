"""验证 curl_cffi（模拟 Chrome TLS 指纹）能否通过 NodeSeek 的 Cloudflare 防护。"""
from curl_cffi import requests as creq

TARGETS = [
    "https://www.nodeseek.com/page-2",
    "https://www.nodeseek.com/post-1041251-1",
    "https://www.nodeseek.com/post-1041222-1",
]

for impersonate in ["chrome", "chrome131", "safari"]:
    print(f"===== impersonate={impersonate} =====")
    for url in TARGETS:
        try:
            r = creq.get(url, impersonate=impersonate, timeout=45, allow_redirects=True)
            txt = r.text
            blocked = ("Just a moment" in txt) or ("ipv6已关闭" in txt) or ("请稍候" in txt[:3000])
            print(f"  {url}\n    status={r.status_code} len={len(txt)} blocked={blocked} 有正文容器={'post-content' in txt}")
            if "post-content" in txt:
                import re
                m = re.search(r'<article[^>]*post-content[^>]*>(.{0,200})', txt, re.S)
                if m:
                    text = re.sub(r"<[^>]+>", " ", m.group(1))
                    print("   正文片段: " + re.sub(r"\s+", " ", text)[:180])
        except Exception as e:
            print(f"  {url}\n    EXC {type(e).__name__}: {str(e)[:120]}")
