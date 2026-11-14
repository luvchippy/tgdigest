/**
 * Cloudflare Worker：GitHub Actions 外部调度器
 *
 * GitHub 原生 cron 在这个仓库的投递率只有约 3.5%，完全指望不上。
 * 这里用 Cloudflare Cron Trigger 每 30 分钟主动调 GitHub API，同时拉起两个 workflow：
 *
 *   forum-collect（digest.yml）  长驻抓取，入队
 *   forum-review （review.yml）  增量审核，攒够阈值推送
 *
 * 为什么两个都要拉：review 平时靠 workflow_run 在 collect 结束时触发，
 * 但 collect 一跑就是 2 小时，中间 review 只能等——一旦原生 cron 也不投递，
 * 队列就会一直堆着不审。这里每 30 分钟补一刀，保证审核不停。
 *
 * 环境变量：
 *   GH_TOKEN           必填，Fine-grained PAT，需要 Actions: Read and write
 *   GH_REPO            必填，例如 luvchippy/tgdigest
 *   GH_WORKFLOW        选填，抓取 workflow，默认 digest.yml
 *   GH_REVIEW_WORKFLOW 选填，审核 workflow，默认 review.yml
 *   GH_REF             选填，默认 main
 *   GH_ROUNDS          选填，抓取循环轮数，默认 24
 *
 * Cron Trigger（Cloudflare dash 里填，不能带注释）：
 *   7,37 * * * *   每 30 分钟
 *
 * 注意：GitHub 对 workflow_dispatch 的 inputs 做严格校验，载荷里出现
 * workflow 中未声明的字段会直接返回 422。digest.yml 里保留了一个 mode
 * 输入专门给这里用，别删。
 */

async function dispatch(env, workflow, inputs) {
  const repo = env.GH_REPO;
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'cf-worker-forum-digest',
    },
    body: JSON.stringify({ ref: env.GH_REF || 'main', inputs }),
  });

  const text = await res.text();

  // 必须抛错：只 console.log 的话 Cloudflare 侧一片 success，
  // 而 GitHub 那边可能因为 422/401 什么都没发生，故障会静默堆积
  // （曾经就这样白跑 18 小时）。
  if (!res.ok) {
    throw new Error(`dispatch ${workflow} failed: ${res.status} ${text.slice(0, 300)}`);
  }

  console.log(`dispatch ${workflow} ok`);
  return res.status;
}

async function dispatchAll(env) {
  const collectWf = env.GH_WORKFLOW || 'digest.yml';
  const reviewWf = env.GH_REVIEW_WORKFLOW || 'review.yml';

  const results = await Promise.allSettled([
    dispatch(env, collectWf, {
      mode: 'loop',
      rounds: String(env.GH_ROUNDS || '24'),
    }),
    dispatch(env, reviewWf, {}),
  ]);

  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length) {
    throw new Error(failures.map((f) => String(f.reason)).join(' | '));
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatchAll(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.searchParams.has('run')) {
      return new Response(
        'forum-digest cron worker. 访问 ?run=1 立即拉起一次抓取 + 一次审核。',
        { headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }
    try {
      await dispatchAll(env);
      return new Response('dispatch ok（collect + review）\n', {
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
