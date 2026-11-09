/**
 * Cloudflare Worker：NodeSeek 转发器 v2
 *
 * v1 已验证：Worker 能绕过 Cloudflare 挑战（不再返回 "Just a moment"），
 * RSS 原样返回正常；但 HTML 页面（首页/翻页/详情）会被 nodeseek 回一个
 * "提醒，ipv6已关闭" 的提示页。同一出口 RSS 能过 HTML 不能过，说明不是网络层问题，
 * 而是服务端对请求头做指纹判断。v2 补齐真实浏览器的全套头，并在疑似被挡时自动重试。
 */

const ALLOW_HOSTS = ['www.nodeseek.com', 'nodeseek.com'];

const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'cache-control': 'max-age=0',
  'upgrade-insecure-requests': '1',
  'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
};

/** 服务端明确返回了拦截/提示页，而不是真正的内容 */
const looksBlocked = (text) =>
  /ipv6\s*已关闭|closed IPv6|Just a moment|cf_chl_|Attention Required|Verifying you are human|ing security verification/i.test(
    text.slice(0, 5000),
  );

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);

    let target = incoming.searchParams.get('url') || request.headers.get('x-target');
    if (!target && incoming.pathname.length > 1) {
      target = decodeURIComponent(incoming.pathname.slice(1)) + incoming.search;
    }
    if (!target) return new Response('missing url', { status: 400 });

    if (env.TOKEN) {
      const given = incoming.searchParams.get('token') || request.headers.get('x-token');
      if (given !== env.TOKEN) return new Response('bad token', { status: 401 });
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return new Response('bad url', { status: 400 });
    }
    if (parsed.protocol !== 'https:' || !ALLOW_HOSTS.includes(parsed.hostname)) {
      return new Response('host not allowed', { status: 403 });
    }

    // RSS / XML 直接用基础头，HTML 用浏览器全套头
    const isFeed = /\.(xml|rss)$|\/rss|\/feed/i.test(parsed.pathname);
    const headers = isFeed
      ? { 'user-agent': BROWSER_HEADERS['user-agent'], accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8' }
      : {
          ...BROWSER_HEADERS,
          // 首次访问没有 referer，模拟从站内点进去的第二次请求
          referer: 'https://www.nodeseek.com/',
        };

    let res;
    let body = '';
    let attempt = 0;
    for (attempt = 1; attempt <= 3; attempt += 1) {
      res = await fetch(parsed.toString(), { method: 'GET', redirect: 'follow', headers });
      body = await res.text();
      if (res.ok && !looksBlocked(body)) break;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 350 * attempt));
    }

    return new Response(body, {
      status: res.status,
      headers: {
        'content-type': res.headers.get('content-type') || 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-proxy-attempt': String(attempt),
        'x-proxy-blocked': looksBlocked(body) ? '1' : '0',
      },
    });
  },
};
