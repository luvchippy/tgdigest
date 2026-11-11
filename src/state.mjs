import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// 记录格式从「单个 JSON 对象」改成 jsonl：每行一条 <key> <ts>。
// 原因：整文件重写的 JSON 在 git rebase 时必然冲突，一冲突整轮数据就提交不上去。
// jsonl 配合 .gitattributes 的 merge=union，两边追加的行会自动合并。
const STATE_FILE = process.env.STATE_FILE ?? path.join(process.cwd(), 'state', 'seen.jsonl');
const LEGACY_JSON = path.join(process.cwd(), 'state', 'seen.json');
const TTL_DAYS = Number(process.env.STATE_TTL_DAYS ?? 21);

export const postKey = (item) =>
  createHash('sha1').update(`${item.sourceId}:${item.id}`).digest('hex').slice(0, 16);

export function loadState() {
  const seen = {};
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.trim().match(/^(\S+)\s+(\d+)$/);
      if (m) seen[m[1]] = Number(m[2]);
    }
  } catch { /* 首次运行 */ }

  if (Object.keys(seen).length === 0) {
    // 兼容旧的 state/seen.json，只读一次，之后以 jsonl 为准
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8'));
      Object.assign(seen, legacy.seen ?? {});
    } catch { /* 没有旧文件 */ }
  }

  return { version: 1, seen };
}

export function pruneState(state, now = Date.now()) {
  const cutoff = now - TTL_DAYS * 86400_000;
  for (const [key, ts] of Object.entries(state.seen)) {
    if (!ts || ts < cutoff) delete state.seen[key];
  }
  return state;
}

export function markSeen(state, items, now = Date.now()) {
  for (const item of items) state.seen[postKey(item)] = now;
  return state;
}

export function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const lines = Object.entries(state.seen)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, ts]) => `${key} ${ts}`);
  fs.writeFileSync(STATE_FILE, lines.join('\n') + '\n');
}
