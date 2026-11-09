import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STATE_FILE = process.env.STATE_FILE ?? path.join(process.cwd(), 'state', 'seen.json');
const TTL_DAYS = Number(process.env.STATE_TTL_DAYS ?? 21);

export const postKey = (item) =>
  createHash('sha1').update(`${item.sourceId}:${item.id}`).digest('hex').slice(0, 16);

export function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { version: 1, seen: raw.seen ?? {} };
  } catch {
    return { version: 1, seen: {} };
  }
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
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 0) + '\n');
}
