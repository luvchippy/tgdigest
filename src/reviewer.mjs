/**
 * 阶段二：增量审核 + 攒够阈值批量推送。
 *
 * 与抓取彻底解耦。抓取 workflow 只往 data/queue-*.jsonl 追加；
 * 本脚本每次运行只处理"还没有审核结论"的帖子，把结论落到 data/reviewed-*.jsonl。
 *
 * 三个文件各自只追加、互不覆盖：
 *   data/queue-{date}.jsonl            抓取写入
 *   data/reviewed-{date}.jsonl         本脚本写入（key + verdict）
 *   data/sent-{date}.jsonl             本脚本写入（key + 推送时间）
 *   data/review-failures-{date}.jsonl  本脚本写入（失败原因，供下次排查）
 * 配合 .gitattributes 的 data/*.jsonl merge=union，两个 workflow 并行不会打架。
 *
 * 一条帖子只要没拿到 verdict，就会在下一次运行里被重新送审——
 * 这是"一条不落"的保证；失败最多重试 MAX_REVIEW_ATTEMPTS 次，之后放弃并留日志。
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
  maxCandidates: Number(process.env.MAX_CANDIDATES ?? 20000),
  pushThreshold: Number(process.env.PUSH_THRESHOLD ?? 20),
  maxAttempts: Number(process.env.MAX_REVIEW_ATTEMPTS ?? 3),
  dryRun: process.env.DRY_RUN === '1',
  profile: process.env.INTEREST_PROFILE ??
    '关注 VPS/云主机优惠与线路质量、开源项目与自建服务、网络与运维故障、AI 自动化工具、值得踩坑的交易与投诉。',
};
const log = (...a) => console.log(...a);
const now = Date.now();
const date = new Date(now).toISOString().slice(0, 10);

function readJsonl(prefix) {
  if (!fs.existsSync(dataDir)) return [];
  const files = fs.readdirSync(dataDir).filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl')).sort();
  const out = [];
  for (const file of files) {
    for (const line of fs.readFileSync(path.join(dataDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
  }
  return out;
}

function appendJsonl(name, rows) {
  if (!rows.length) return;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.appendFileSync(path.join(dataDir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const keyOf = (it) => `${it.sourceId}:${it.id}`;

// ---------- 读现状 ----------
const queue = new Map();
for (const it of readJsonl('queue-')) {
  if (it && it.sourceId && it.id) queue.set(keyOf(it), it);
}

const reviewed = new Map();
for (const r of readJsonl('reviewed-')) {
  if (r && r.key) reviewed.set(r.key, r);
}

const sent = new Set(readJsonl('sent-').map((r) => r.key).filter(Boolean));

const failCount = new Map();
for (const f of readJsonl('review-failures-')) {
  if (f && f.key) failCount.set(f.key, Math.max(failCount.get(f.key) ?? 0, Number(f.attempt) || 0));
}

log(`队列 ${queue.size} 条 · 已审 ${reviewed.size} 条 · 已推送 ${sent.size} 条`);

// ---------- 找出还没审核的 ----------
const pending = [];
for (const [key, item] of queue) {
  if (reviewed.has(key)) continue;
  if (sent.has(key)) continue;
  if ((failCount.get(key) ?? 0) >= cfg.maxAttempts) continue;
  pending.push(item);
  if (pending.length >= cfg.maxCandidates) break;
}

log(`待审 ${pending.length} 条`);

// ---------- 审核 ----------
let verdicts = new Map();
if (pending.length) {
  verdicts = await reviewItems(pending, { template: promptTemplate, profile: cfg.profile, log });
}

const reviewedRows = [];
const failRows = [];

pending.forEach((item, i) => {
  const key = keyOf(item);
  const v = verdicts.get(i);

  if (v && !v.error) {
    reviewedRows.push({
      key,
      sourceId: item.sourceId,
      id: item.id,
      title: item.title,
      keep: !!v.keep,
      score: Number(v.score) || 0,
      tags: v.tags ?? [],
      why: v.why ?? '',
      at: now,
    });
    return;
  }

  // 审核失败：不写 reviewed，下次还会重试；但把原因记下来
  const attempt = (failCount.get(key) ?? 0) + 1;
  failRows.push({
    key,
    sourceId: item.sourceId,
    id: item.id,
    title: item.title,
    url: item.url,
    attempt,
    reason: v?.error ?? 'no verdict',
    detail: (v?.why ?? '').slice(0, 200),
    at: now,
  });

  if (attempt >= cfg.maxAttempts) {
    // 重试到上限仍然失败，标记放弃，避免无限消耗
    reviewedRows.push({
      key,
      sourceId: item.sourceId,
      id: item.id,
      title: item.title,
      keep: false,
      score: 0,
      tags: [],
      why: '审核多次失败，已放弃',
      error: 'abandoned',
      at: now,
    });
  }
});

appendJsonl(`reviewed-${date}.jsonl`, reviewedRows);
appendJsonl(`review-failures-${date}.jsonl`, failRows);

for (const r of reviewedRows) reviewed.set(r.key, r);
if (failRows.length) log(`审核失败 ${failRows.length} 条（已写 review-failures-${date}.jsonl，下次重试）`);

// ---------- 挑出够格推送的 ----------
const eligible = [];
for (const [key, r] of reviewed) {
  if (sent.has(key)) continue;
  if (!r.keep || r.error) continue;
  if ((Number(r.score) || 0) < cfg.minScore) continue;
  const item = queue.get(key);
  if (!item) continue;          // 队列里没有原文（已被清理），跳过
  eligible.push({ ...item, verdict: r });
}
eligible.sort((a, b) => (b.verdict.score ?? 0) - (a.verdict.score ?? 0));

let selected = eligible;
if (cfg.maxPerSource > 0) {
  const per = new Map();
  selected = [];
  for (const it of eligible) {
    const n = per.get(it.sourceId) ?? 0;
    if (n >= cfg.maxPerSource) continue;
    per.set(it.sourceId, n + 1);
    selected.push(it);
  }
}

log(`达标待推 ${selected.length} 条 / 阈值 ${cfg.pushThreshold} 条`);

// ---------- 攒够阈值才推送 ----------
if (selected.length < cfg.pushThreshold) {
  log('未达推送阈值，保留到下次运行');
} else {
  const stamp = new Date(now).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });

  let out = `📮 <b>论坛精选 ${stamp}</b>\n`;
  out += `本期 <b>${selected.length}</b> 条（队列 ${queue.size} 条 · 已审 ${reviewed.size} 条）`;
  if (failRows.length) out += `\n<i>${failRows.length} 条审核失败，已记录待重试</i>`;

  selected.forEach((item, i) => {
    const score = item.verdict.score ? ` <b>${item.verdict.score}</b>` : '';
    out += `\n\n${i + 1}. <a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a>${score}\n`;
    out += `   ▸ ${escapeHtml(item.sourceName)}`;
    if (item.stats) out += ` · ${escapeHtml(item.stats)}`;
    if (item.category) out += ` · ${escapeHtml(item.category)}`;
    if (item.verdict.why) out += `\n   ▸ ${escapeHtml(item.verdict.why)}`;
  });

  if (cfg.dryRun) {
    log('--- DRY RUN 预览 ---');
    log(out);
  } else {
    await sendTelegram(out, {
      token: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID,
      log,
    });
    appendJsonl(`sent-${date}.jsonl`, selected.map((it) => ({ key: keyOf(it), at: now, score: it.verdict.score })));
    log(`已推送 ${selected.length} 条`);
  }
}

log(`本轮：送审 ${pending.length} · 成功 ${reviewedRows.length - failRows.length} · 失败 ${failRows.length} · 推送 ${selected.length >= cfg.pushThreshold ? selected.length : 0}`);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  try {
    fs.appendFileSync(summary, [
      '## 论坛审核', '',
      `- 队列：${queue.size}，已审：${reviewed.size}，已推送：${sent.size}`,
      `- 本轮送审：${pending.length}，失败：${failRows.length}`,
      `- 达标待推：${selected.length}（阈值 ${cfg.pushThreshold}）`,
    ].join('\n') + '\n');
  } catch { /* 本地无 */ }
}
