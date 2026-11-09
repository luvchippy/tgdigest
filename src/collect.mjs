/**
 * 阶段一：收集（每 10 分钟一次）。
 * 只做搬运：抓新帖 -> 去重 -> 追加进当天队列。不打分、不推送。
 * 每 10 分钟是为了追上 NodeSeek 的 RSS：它一次只给最新 20 条，实测只覆盖约 10 分钟。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getAdapter } from './sources/index.mjs';
import { loadState, pruneState, markSeen, saveState, postKey } from './state.mjs';

const root = process.cwd();
const config = JSON.parse(fs.readFileSync(path.join(root, 'config/sources.json'), 'utf8'));

const windowMinutes = Number(process.env.COLLECT_WINDOW_MINUTES ?? 20);
const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// 北京时间切天
const dayKey = (d = new Date()) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
const queueFile = path.join(dataDir, `queue-${dayKey()}.jsonl`);

const now = Date.now();
const windowStart = now - windowMinutes * 60_000;
const withinWindow = (iso) => {
  if (!iso) return true;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? true : t >= windowStart;
};

const log = (...a) => console.log(...a);
const state = pruneState(loadState(), now);
const active = config.sources.filter((s) => s.enabled);
const errors = [];
const collected = [];

await Promise.all(active.map(async (source) => {
  const t0 = Date.now();
  try {
    const items = await getAdapter(source.adapter)(source, { withinWindow, needDetail: true });
    let added = 0;
    for (const item of items) {
      const key = postKey(item);
      if (state.seen[key]) continue;
      state.seen[key] = now;
      collected.push(item);
      added += 1;
    }
    log(`  ${source.name}: 抓到 ${items.length} 条，新增 ${added} 条  ${Date.now() - t0}ms`);
  } catch (err) {
    log(`  ${source.name}: 失败 - ${err.message}`);
    errors.push({ source: source.name, error: err.message.slice(0, 160) });
  }
}));

if (collected.length) {
  fs.appendFileSync(queueFile, collected.map((i) => JSON.stringify({
    sourceId: i.sourceId,
    sourceName: i.sourceName,
    id: i.id,
    title: i.title,
    url: i.url,
    author: i.author,
    createdAt: i.createdAt,
    category: i.category,
    stats: i.stats,
    text: (i.text ?? '').slice(0, 600),
  })).join('\n') + '\n');
}

saveState(state);

const total = fs.existsSync(queueFile)
  ? fs.readFileSync(queueFile, 'utf8').split('\n').filter(Boolean).length
  : 0;
log(`本轮新增 ${collected.length} 条，当天队列累计 ${total} 条`);

fs.writeFileSync(path.join(dataDir, 'last-errors.json'), JSON.stringify(errors));

// 清理 3 天前的队列，避免仓库膨胀
for (const f of fs.readdirSync(dataDir)) {
  const m = f.match(/^queue-(\d{4}-\d{2}-\d{2})\.jsonl$/);
  if (!m) continue;
  if ((now - Date.parse(m[1])) > 3 * 86400_000) {
    try { fs.unlinkSync(path.join(dataDir, f)); } catch { /* 忽略 */ }
  }
}

if (errors.length === active.length) process.exitCode = 1;
