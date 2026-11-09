/**
 * Cloudflare Worker：NodeSeek 转发器
 * 用途：GitHub Actions 的机房 IP 访问 nodeseek 会被 Cloudflare 挑战（403 Just a moment），
 *       Worker 出口在 Cloudflare 自己的网络上，访问同样托管在 Cloudflare 的 nodeseek 基本不会被拦。
 *
 * 用法：https://<你的worker域名>/?url=<编码后的完整目标地址>&token=<你的口令>
 * 也支持把目标地址放在 x-target 请求头里。
 *
 * 部署后把 PROXY_PREFIX 设成： https://<你的worker域名>/?url=
 * 并在 Worker 的环境变量里配置 TOKEN（可选，但公开仓库建议配上防滥用）
 */

const ALLOW_HOSTS = ['www.nodeseek.com', 'nodeseek.com'];

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);

    // 目标地址：优先 query 参数，其次 x-target 头
    let target = incoming.searchParams.get('url') || request.headers.get('x-target');
    if (!target && incoming.pathname.length > 1) {
      // 也支持 /https://www.nodeseek.com/xxx 这种直写形式
      target = decodeURIComponent(incoming.pathname.slice(1)) + incoming.search;
    }
    if (!target) return new Response('missing url', { status: 400 });

    // 口令校验（Worker 里配了 TOKEN 才启用）
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

    const upstream = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent': BROWSER_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'cache-control': 'no-cache',
        referer: 'https://www.nodeseek.com/',
      },
    });

    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-proxy-status': String(upstream.status),
      },
    });
  },
};
