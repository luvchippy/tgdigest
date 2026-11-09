/**
 * Cloudflare Worker：GitHub Actions 外部调度器
 *
 * 背景：本仓库的 GitHub 原生 schedule 定时器不工作（实测 7 小时、40+ 次机会、
 * 零次触发，连纯 echo 的心跳 workflow 都不跑）。改用 Cloudflare Cron Trigger
 * 主动调 GitHub API 触发 workflow_dispatch。
 *
 * 环境变量：GH_TOKEN / GH_REPO / GH_WORKFLOW
 * Cron Triggers：
 *   5 * * * *                  -> digest
 *   2,12,22,32,42,52 * * * *   -> collect
 */

async function dispatch(mode, env) {
  const url = `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'cf-worker-forum-digest',
    },
    body: JSON.stringify({ ref: env.GH_REF || 'main', inputs: { mode } }),
  });
  const text = await res.text();
  console.log(`dispatch mode=${mode} status=${res.status} ${text.slice(0, 200)}`);
  return res.status;
}

export default {
  async scheduled(event, env, ctx) {
    const minuteField = String(event.cron || '').split(' ')[0];
    const mode = minuteField.includes(',') ? 'collect' : 'digest';
    ctx.waitUntil(dispatch(mode, env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const run = url.searchParams.get('run');
    if (!run) {
      return new Response('forum-digest cron worker. ?run=collect 或 ?run=digest 手动触发。', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    const status = await dispatch(run, env);
    return new Response(`dispatch ${run} -> HTTP ${status}\n`, {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
