const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cloudflare / WAF 挑战页、以及 nodeseek 的 IPv6 拒绝页，命中即视为抓取失败而不是数据 */
const CHALLENGE = /just a moment|cf-browser-verification|cf_chl_|Attention Required|Enable JavaScript and cookies|Verifying you are human|ipv6\s*已关闭|closed IPv6/i;

/** 真实浏览器会带的指纹头，缺了容易被 WAF 打成机器人 */
const BROWSER_HEADERS = {
  'upgrade-insecure-requests': '1',
  'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
};

/**
 * 带重试、超时、可选代理前缀与 Jina Reader 兜底的文本请求。
 * 失败抛出最后一个错误，调用方决定降级策略。
 */
export async function requestText(url, opts = {}) {
  const {
    headers = {},
    timeout = 20000,
    retries = 3,
    json = false,
    allowJina = process.env.ENABLE_JINA_FALLBACK === '1',
  } = opts;

  const targets = [{ url, headers: {} }];
  // 自建 Cloudflare Worker 转发优先；只对 NodeSeek 用，避免把其它站塞进去白挨一次 403
  if (process.env.PROXY_PREFIX && process.env.PROXY_ENABLED === '1' && /nodeseek\.com/i.test(url)) {
    const prefix = process.env.PROXY_PREFIX;
    const sep = prefix.includes('?') ? (prefix.endsWith('?') || prefix.endsWith('=') ? '' : '&') : '?';
    const token = process.env.PROXY_TOKEN ? `${sep}token=${encodeURIComponent(process.env.PROXY_TOKEN)}` : '';
    targets.unshift({
      url: prefix + encodeURIComponent(url) + token,
      headers: { 'x-target': url },
    });
  }
  if (allowJina) {
    targets.push({ url: 'https://r.jina.ai/' + url, headers: { 'x-respond-with': 'text' } });
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(700 * 2 ** (attempt - 1) + Math.random() * 500);
    for (const t of targets) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeout);
      try {
        const res = await fetch(t.url, {
          signal: ac.signal,
          redirect: 'follow',
          headers: {
            'user-agent': DEFAULT_UA,
            accept: json
              ? 'application/json,text/plain,*/*'
              : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'cache-control': 'max-age=0',
            ...(json ? {} : BROWSER_HEADERS),
            ...headers,
            ...t.headers,
          },
        });
        const body = await res.text();
        if (!res.ok) {
          lastErr = new Error(`HTTP ${res.status} ${t.url} :: ${body.slice(0, 160).replace(/\s+/g, ' ')}`);
          continue;
        }
        if (CHALLENGE.test(body.slice(0, 4000))) {
          lastErr = new Error(`WAF challenge ${t.url}`);
          continue;
        }
        return body;
      } catch (err) {
        lastErr = new Error(`${t.url} :: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw lastErr ?? new Error('request failed');
}

export async function requestJson(url, opts = {}) {
  const body = await requestText(url, { ...opts, json: true });
  try {
    return JSON.parse(body);
  } catch {
    // Jina Reader 会把 JSON 包进代码块，或前后加标题
    const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch { /* 继续尝试 */ }
    }
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw new Error(`non-JSON response from ${url}: ${body.slice(0, 120)}`);
  }
}
