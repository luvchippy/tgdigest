/**
 * Cloudflare Worker：GitHub Actions 外部调度器
 *
 * 背景：本仓库的 GitHub 原生 schedule 定时器基本不工作（实测 24 小时只有 3.5% 的
 * cron 槽位真的投递）。所以改用 Cloudflare Cron Trigger 主动调 GitHub API 触发
 * workflow_dispatch。
 *
 * 现在 dispatch 的是「长驻抓取」：一次 job 内跑 24 轮 × 10 分钟，遇 Cloudflare 403
 * 就提前收工；Worker 每 30 分钟拉一次，run 结束时立刻有新的接上，形成连续覆盖。
 *
 * 环境变量：
 *   GH_TOKEN     必填，Fine-grained PAT，需要 Actions: Read and write
 *   GH_REPO      必填，例如 luvchippy/tgdigest
 *   GH_WORKFLOW  必填，workflow 文件名，例如 digest.yml
 *   GH_REF       选填，默认 main
 *   GH_ROUNDS    选填，每轮循环数，默认 24
 *
 * Cron Trigger（Cloudflare dash 里填，不能带注释）：
 *   7,37 * * * *   每 30 分钟拉起一次
 *
 * 注意：GitHub 对 workflow_dispatch 的 inputs 做严格校验，载荷里出现
 * workflow 中未声明的字段会直接返回 422。digest.yml 里保留了一个 mode
 * 输入专门给这里用，别删。
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

  // 必须抛错：只 console.log 的话 Cloudflare 侧一片 success，
  // 而 GitHub 那边可能因为 422/401 什么都没发生，故障会静默堆积
  // （曾经就这样白跑 18 小时）。
  if (!res.ok) {
    throw new Error(`dispatch ${wf} failed: ${res.status} ${text.slice(0, 300)}`);
  }

  console.log(`dispatch ${wf} ok rounds=${env.GH_ROUNDS || 24}`);
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
        'forum-digest cron worker. 访问 ?run=1 立即触发一次 24 轮长驻抓取。',
        { headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }
    try {
      const status = await dispatch(env);
      return new Response(`dispatch -> HTTP ${status}\n`, {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    } catch (err) {
      return new Response(`dispatch failed: ${err.message}\n`, {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  },
};
