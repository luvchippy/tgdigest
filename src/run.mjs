/**
 * 单轮管线：抓取 -> 去重 -> AI 审核 -> 推送 Telegram。
 * 每小时跑一次，每轮都会发一条消息（哪怕本轮没有值得推的内容）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getAdapter } from './sources/index.mjs';
import { reviewItems } from './review.mjs';
import { sendTelegram, escapeHtml } from './notify.mjs';
import { loadState, pruneState, markSeen, saveState, postKey } from './state.mjs';

const root = process.cwd();
const config = JSON.parse(fs.readFileSync(path.join(root, 'config/sources.json'), 'utf8'));
const promptTemplate = fs.readFileSync(path.join(root, 'prompts/review.md'), 'utf8');

const cfg = {
  windowHours: Number(process.env.WINDOW_HOURS ?? 1.5),
  minScore: Number(process.env.MIN_SCORE ?? 6),
  // 0 = 不封顶
  maxPerSource: Number(process.env.MAX_PER_SOURCE ?? 0),
  maxCandidates: Number(process.env.MAX_CANDIDATES ?? 600),
  dryRun: process.env.DRY_RUN === '1',
  profile: process.env.INTEREST_PROFILE ??
    '关注 VPS/云主机优惠与线路质量、开源项目与自建服务、网络与运维故障、AI 自动化工具、值得踩坑的交易与投诉。',
};
const log = (...a) => console.log(...a);

const now = Date.now();
const windowStart = now - cfg.windowHours * 3600_000;
const withinWindow = (iso) => {
  if (!iso) return true;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? true : t >= windowStart;
};

const state = pruneState(loadState(), now);
const active = config.sources.filter((s) => s.enabled);
const errors = [];
const fresh = [];

await Promise.all(active.map(async (source) => {
  const t0 = Date.now();
  try {
    const items = await getAdapter(source.adapter)(source, { withinWindow, needDetail: true });
    let added = 0;
    for (const item of items) {
      if (state.seen[postKey(item)]) continue;
      fresh.push(item);
      added += 1;
    }
    log(`  ${source.name}: 抓到 ${items.length} 条，新帖 ${added} 条  ${Date.now() - t0}ms`);
  } catch (err) {
    log(`  ${source.name}: 失败 - ${err.message}`);
    errors.push({ source: source.name, error: err.message.slice(0, 160) });
  }
}));

fresh.sort((a, b) => (Date.parse(b.createdAt ?? 0) || 0) - (Date.parse(a.createdAt ?? 0) || 0));
const candidates = fresh.slice(0, cfg.maxCandidates);
if (fresh.length > candidates.length) {
  log(`超过单轮上限，本轮只审最新的 ${candidates.length}/${fresh.length} 条`);
}

log(`送审 ${candidates.length} 条`);
const verdicts = candidates.length
  ? await reviewItems(candidates, { template: promptTemplate, profile: cfg.profile, log })
  : new Map();

const scored = candidates
  .map((item, i) => ({ ...item, verdict: verdicts.get(i) }))
  .filter((x) => x.verdict && x.verdict.keep && x.verdict.score >= cfg.minScore)
  .sort((a, b) => b.verdict.score - a.verdict.score);   // 高分在前，全局排序

let selected = scored;
if (cfg.maxPerSource > 0) {
  const perSource = new Map();
  selected = [];
  for (const item of scored) {
    const n = perSource.get(item.sourceId) ?? 0;
    if (n >= cfg.maxPerSource) continue;
    perSource.set(item.sourceId, n + 1);
    selected.push(item);
  }
}

function buildMessage() {
  const stamp = new Date(now).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const degraded = selected.some((s) => s.verdict.error === 'review-failed');
  let out = `📮 <b>论坛速递 ${stamp}</b>\n`;
  out += `${active.length} 站 · 新帖 ${fresh.length} 条 · 推送 <b>${selected.length}</b> 条`;
  if (degraded) out += '\n<i>AI 审核不可用，本轮为未打分直推</i>';

  if (!selected.length) {
    out += '\n\n本轮没有达到推送标准的内容。';
  } else {
    selected.forEach((item, i) => {
      const score = item.verdict.error === 'review-failed' ? '' : ` <b>${item.verdict.score}</b>`;
      const src = escapeHtml(item.sourceName);
      out += `\n\n${i + 1}. <a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a>${score}\n`;
      out += `   ▸ ${src}`;
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

// 本轮处理过的候选全部记账，避免下一轮重复
markSeen(state, candidates, now);
saveState(state);
log(`命中 ${scored.length} 条，推送 ${selected.length} 条`);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  try {
    fs.appendFileSync(summary, [
      '## 论坛速递',
      '',
      `- 新帖：${fresh.length}，送审：${candidates.length}，命中：${scored.length}，推送：${selected.length}`,
      errors.length ? `- 失败源：${errors.map((e) => `${e.source}(${e.error})`).join('；')}` : '- 失败源：无',
      '',
      ...selected.map((s) => `- [${s.sourceName}] ${s.title} — ${s.verdict.score}/${s.verdict.why}`),
    ].join('\n') + '\n');
  } catch { /* 本地无此文件 */ }
}

if (errors.length === active.length) process.exitCode = 1;
