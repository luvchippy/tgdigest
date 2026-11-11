/**
 * 长驻循环：一次 job 内连续抓取，规避 GitHub cron 采样率过低的问题。
 * 实测 GitHub 对高频 cron 的投递率约 5%，15 小时只给 5 次机会，会出现 9 小时空白。
 * 所以改成一个 job 内每 10 分钟抓一轮、整点后补一次推送，靠 timeout 自然结束，
 * 后续排队的 run 接上，形成连续覆盖。
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const ROUNDS = Number(process.env.LOOP_ROUNDS ?? 24);
const INTERVAL_MS = Number(process.env.LOOP_INTERVAL_MS ?? 600_000);
const DIGEST_MODE = (process.env.DIGEST_MODE ?? 'hourly').trim().toLowerCase();
const DIGEST_UTC_HOUR = Number(process.env.DIGEST_UTC_HOUR ?? 1);
// hourly 模式下两次推送至少间隔 55 分钟；daily 模式下 20 小时，避免跨天重复推送
const DIGEST_GUARD_MS = DIGEST_MODE === 'daily' ? 20 * 60 * 60_000 : 55 * 60_000;
const stampFile = path.join(ROOT, 'data', 'last-digest.txt');

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

function shouldDigest() {
  const now = Date.now();
  const dt = new Date(now);
  // daily：只在指定 UTC 小时的整点后 12 分钟内触发（UTC 1 = 北京 09:00）
  if (DIGEST_MODE === 'daily' && dt.getUTCHours() !== DIGEST_UTC_HOUR) return false;
  try {
    const last = Number(fs.readFileSync(stampFile, 'utf8').trim());
    if (last && now - last < DIGEST_GUARD_MS) return false;
  } catch { /* 首次 */ }
  // 整点后 12 分钟内触发一次
  return dt.getUTCMinutes() < 12;
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

log(`长驻循环启动：${ROUNDS} 轮 × ${Math.round(INTERVAL_MS / 60000)} 分钟，推送模式 ${DIGEST_MODE}${DIGEST_MODE === 'daily' ? ` (UTC ${DIGEST_UTC_HOUR} 点)` : ''}`);

let nodeSeekFailStreak = 0;

for (let round = 1; round <= ROUNDS; round += 1) {
  log(`===== 第 ${round}/${ROUNDS} 轮 =====`);

  if (run('python scripts/fetch-nodeseek.py')) {
    nodeSeekFailStreak = 0;
  } else {
    nodeSeekFailStreak += 1;
  }
  run('node src/collect.mjs');
  commit('chore(collect): queue update');

  if (nodeSeekFailStreak >= 3) {
    log(`NodeSeek 连续 ${nodeSeekFailStreak} 轮全站被拦（本机 IP 已被 Cloudflare 限流），提前结束本次 run，交给下一次换 IP`);
    break;
  }

  if (shouldDigest()) {
    log('触发本轮审核推送');
    const ok = run('node src/digest.mjs');
    if (ok) {
      try {
        fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
        fs.writeFileSync(stampFile, String(Date.now()));
      } catch { /* 忽略 */ }
      commit('chore(digest): flush queue');
    }
  }

  if (round < ROUNDS) {
    log(`休眠 ${Math.round(INTERVAL_MS / 60000)} 分钟`);
    await sleep(INTERVAL_MS);
  }
}

log('长驻循环结束');
