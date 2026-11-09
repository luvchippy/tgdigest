/**
 * 阶段二：审核推送（每小时一次）。
 * 读当天队列 -> AI 逐条打分 -> 按分数从高到低推送 -> 清空队列。
 * 每轮都会发一条消息，哪怕没有达标内容。
 */
import fs from 'node:fs';
import path from 'node:path';
import { reviewItems } from './review.mjs';
import { sendTelegram, escapeHtml } from './notify.mjs';

const root = process.cwd();
const dataDir = path.join(root, 'data');
const promptTemplate = fs.readFileSync(path.join(root, 'prompts/review.md'), 'utf8');

const cfg = {
  minScore: Number(process.env.MIN_SCORE ?? 6),
  maxPerSource: Number(process.env.MAX_PER_SOURCE ?? 0),
  maxCandidates: Number(process.env.MAX_CANDIDATES ?? 600),
  dryRun: process.env.DRY_RUN === '1',
  profile: process.env.INTEREST_PROFILE ??
    '关注 VPS/云主机优惠与线路质量、开源项目与自建服务、网络与运维故障、AI 自动化工具、值得踩坑的交易与投诉。',
};
const log = (...a) => console.log(...a);

function readQueue() {
  if (!fs.existsSync(dataDir)) return { items: [], files: [] };
  const files = fs.readdirSync(dataDir).filter((f) => /^queue-.*\.jsonl$/.test(f)).sort();
  const byKey = new Map();
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(dataDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        byKey.set(`${item.sourceId}:${item.id}`, item);
      } catch { /* 跳过坏行 */ }
    }
  }
  return { items: [...byKey.values()], files };
}

const errors = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'last-errors.json'), 'utf8')); } catch { return []; }
})();

const now = Date.now();
const { items, files } = readQueue();
log(`队列 ${files.length} 个文件，去重后 ${items.length} 条`);

items.sort((a, b) => (Date.parse(b.createdAt ?? 0) || 0) - (Date.parse(a.createdAt ?? 0) || 0));
const candidates = items.slice(0, cfg.maxCandidates);
if (items.length > candidates.length) log(`超过单轮上限，只审最新 ${candidates.length}/${items.length} 条`);

const verdicts = candidates.length
  ? await reviewItems(candidates, { template: promptTemplate, profile: cfg.profile, log })
  : new Map();

const scored = candidates
  .map((item, i) => ({ ...item, verdict: verdicts.get(i) }))
  .filter((x) => x.verdict && x.verdict.keep && x.verdict.score >= cfg.minScore)
  .sort((a, b) => b.verdict.score - a.verdict.score);

let selected = scored;
if (cfg.maxPerSource > 0) {
  const per = new Map();
  selected = [];
  for (const item of scored) {
    const n = per.get(item.sourceId) ?? 0;
    if (n >= cfg.maxPerSource) continue;
    per.set(item.sourceId, n + 1);
    selected.push(item);
  }
}

function buildMessage() {
  const stamp = new Date(now).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const degraded = selected.some((s) => s.verdict.error === 'review-failed');
  let out = `📮 <b>论坛速递 ${stamp}</b>\n`;
  out += `新帖 ${items.length} 条 · 达标 ${scored.length} 条 · 推送 <b>${selected.length}</b> 条`;
  if (degraded) out += '\n<i>AI 审核不可用，本轮为未打分直推</i>';

  if (!selected.length) {
    out += '\n\n本轮没有达到推送标准的内容。';
  } else {
    selected.forEach((item, i) => {
      const score = item.verdict.error === 'review-failed' ? '' : ` <b>${item.verdict.score}</b>`;
      out += `\n\n${i + 1}. <a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a>${score}\n`;
      out += `   ▸ ${escapeHtml(item.sourceName)}`;
      if (item.stats) out += ` · ${escapeHtml(item.stats)}`;
      if (item.category) out += ` · ${escapeHtml(item.category)}`;
      if (item.verdict.why && item.verdict.error !== 'review-failed') out += `\n   ▸ ${escapeHtml(item.verdict.why)}`;
    });
  }

  if (errors.length) {
    out += '\n\n' + errors.map((e) => `⚠️ ${escapeHtml(e.source)}：${escapeHtml(e.error)}`).join('\n');
  }
  return out;
}

const message = buildMessage();
if (cfg.dryRun) {
  log('--- DRY RUN 预览 ---');
  log(message);
} else {
  await sendTelegram(message, {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
    log,
  });
}

if (!cfg.dryRun) {
  for (const file of files) {
    try { fs.unlinkSync(path.join(dataDir, file)); } catch { /* 已删 */ }
  }
  try { fs.unlinkSync(path.join(dataDir, 'last-errors.json')); } catch { /* 无 */ }
}

log(`送审 ${candidates.length} 条，达标 ${scored.length} 条，推送 ${selected.length} 条`);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  try {
    fs.appendFileSync(summary, [
      '## 论坛速递', '',
      `- 队列：${items.length}，送审：${candidates.length}，达标：${scored.length}，推送：${selected.length}`,
      errors.length ? `- 失败源：${errors.map((e) => `${e.source}(${e.error})`).join('；')}` : '- 失败源：无',
      '', ...selected.map((s) => `- [${s.sourceName}] ${s.title} — ${s.verdict.score}/${s.verdict.why}`),
    ].join('\n') + '\n');
  } catch { /* 本地无 */ }
}
