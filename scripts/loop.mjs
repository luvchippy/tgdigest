/**
 * 长驻抓取循环：一个 job 内连续抓，规避 GitHub cron 投递率过低的问题。
 *
 * 这里只做一件事——把新帖追加进 data/queue-{date}.jsonl。
 * 审核完全交给独立的 forum-review workflow：
 *   抓取跑多久都不会被 AI 拖慢，AI 那边也不会因为抓取被封而停摆。
 *
 * 实测 GitHub 原生 cron 在这个仓库的投递率只有约 3.5%，
 * 所以节奏由 Cloudflare Worker 每 30 分钟调一次 workflow_dispatch 提供；
 * 单 job 内跑 24 轮，遇到 Cloudflare 403 就提前收工，交给下一次换 IP。
 */
import { execSync } from 'node:child_process';

const ROUNDS = Number(process.env.LOOP_ROUNDS ?? 24);
const INTERVAL_MS = Number(process.env.LOOP_INTERVAL_MS ?? 600_000);

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: 'inherit', ...opts });
    return true;
  } catch (e) {
    log('  命令失败:', cmd.split(' ')[0], String(e.message).slice(0, 120));
    return false;
  }
}

function commit(msg) {
  run('git add -A data state 2>/dev/null || true');
  const changed = (() => {
    try {
      execSync('git diff --staged --quiet', { stdio: 'ignore' });
      return false;
    } catch {
      return true;
    }
  })();
  if (!changed) return;
  run(`git commit -m "${msg} [skip ci]" -q || true`);
  for (let i = 0; i < 3; i += 1) {
    if (run('git pull --rebase --autostash -q && git push -q')) return;
    log('  push 冲突，重试', i + 1);
    try { execSync('git rebase --abort', { stdio: 'ignore' }); } catch { /* 无 rebase */ }
  }
}

log(`抓取循环启动：${ROUNDS} 轮 × ${Math.round(INTERVAL_MS / 60000)} 分钟`);

let nodeSeekFailStreak = 0;

for (let round = 1; round <= ROUNDS; round += 1) {
  log(`===== 第 ${round}/${ROUNDS} 轮 =====`);

  // 第 1 轮把列表翻深、详情额度拉满：补回上一个 run 因限流中断留下的缺口，
  // 以及换 IP 的空窗期，保证 NodeSeek 的帖子一条不漏。
  const nsEnv = round === 1
    ? 'NODESEEK_PAGES=8 NODESEEK_DETAIL=900 '
    : 'NODESEEK_PAGES=4 NODESEEK_DETAIL=200 ';
  const nsOk = run(nsEnv + 'python scripts/fetch-nodeseek.py');
  if (nsOk) {
    nodeSeekFailStreak = 0;
  } else {
    nodeSeekFailStreak += 1;
  }

  // 被 Cloudflare 限流时不把 RSS 的裸标题灌进队列：那会把正文覆盖率从 ~91% 拉到 ~79%
  run(nsOk ? 'node src/collect.mjs' : 'SKIP_NODESEEK=1 node src/collect.mjs');
  commit('chore(collect): queue update');

  if (nodeSeekFailStreak >= 2) {
    log(`NodeSeek 连续 ${nodeSeekFailStreak} 轮全站被拦（本机 IP 已被 Cloudflare 限流），提前结束本次 run，交给下一次换 IP`);
    break;
  }

  if (round < ROUNDS) {
    log(`休眠 ${Math.round(INTERVAL_MS / 60000)} 分钟`);
    await sleep(INTERVAL_MS);
  }
}

log('抓取循环结束');
