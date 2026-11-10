/**
 * Cloudflare Worker：GitHub Actions 外部调度器
 *
 * 背景：本仓库的 GitHub 原生 schedule 定时器基本不工作（实测 24 小时只有 3.5% 的
 * cron 槽位真的投递，连纯 echo 的 heartbeat 一天也只跑 2 次）。所以改用 Cloudflare
 * Cron Trigger 主动调 GitHub API 触发 workflow_dispatch。
 *
 * 现在 dispatch 的是「长驻循环」：一次 job 内跑 24 轮 × 10 分钟 ≈ 4.75 小时，
 * Worker 每 6 小时拉一次，前后两段天然接续，等于 24/7 连续采集。
 *
 * 环境变量：
 *   GH_TOKEN     必填，Fine-grained PAT，需要 Actions: Read and write
 *   GH_REPO      必填，例如 luvchippy/tgdigest
 *   GH_WORKFLOW  必填，workflow 文件名，例如 digest.yml
 *   GH_REF       选填，默认 main
 *   GH_ROUNDS    选填，每轮循环数，默认 24
 *
 * Cron Trigger（Cloudflare dash 里填，Cron 表达式不能带注释）：
 *   每 6 小时第 7 分钟
 */

async function dispatch(env) {
  const repo = env.GH_REPO;
  const wf = env.GH_WORKFLOW || 'digest.yml';
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${wf}/dispatches`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'cf-worker-forum-digest',
    },
    body: JSON.stringify({
      ref: env.GH_REF || 'main',
      inputs: {
        mode: 'loop',
        rounds: String(env.GH_ROUNDS || '24'),
      },
    }),
  });

  const text = await res.text();
  console.log(`dispatch ${wf} mode=loop rounds=${env.GH_ROUNDS || 24} status=${res.status} ${text.slice(0, 200)}`);
  return res.status;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.searchParams.has('run')) {
      return new Response(
        'forum-digest cron worker. 访问 ?run=1 立即触发一次 24 轮长驻循环。',
        { headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }
    const status = await dispatch(env);
    return new Response(`dispatch -> HTTP ${status}\n`, {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
