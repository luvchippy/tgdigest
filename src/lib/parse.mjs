/** 通用归一化：不依赖单一字段名，兼容自建论坛的接口漂移 */

export function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return v;
  }
  return undefined;
}

export function stripHtml(input = '') {
  return String(input)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function excerpt(text, max = 700) {
  const t = stripHtml(text);
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** 在任意 JSON 结构里寻找最像"帖子列表"的对象数组，用于接口未知时兜底 */
export function findObjectArray(root, depth = 0) {
  const found = [];
  const walk = (node, d) => {
    if (!node || d > 6) return;
    if (Array.isArray(node)) {
      const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length >= 2) {
        let score = 0;
        for (const o of objs.slice(0, 5)) {
          if (pick(o, ['title', 'subject', 'name'])) score += 2;
          if (pick(o, ['created_at', 'createdAt', 'published_at', 'date', 'time'])) score += 1;
          if (pick(o, ['id', 'post_id', 'topic_id', 'thread_id', 'tid'])) score += 1;
        }
        if (score >= 4) found.push({ arr: objs, score });
      }
      for (const x of objs.slice(0, 3)) walk(x, d + 1);
      return;
    }
    if (typeof node === 'object') {
      for (const k of Object.keys(node)) walk(node[k], d + 1);
    }
  };
  walk(root, depth);
  found.sort((a, b) => b.score - a.score);
  return found[0]?.arr ?? [];
}

/** Discourse 的 tags 可能是字符串数组，也可能是 {name,slug} 对象数组 */
export function tagList(tags) {
  if (!Array.isArray(tags)) return undefined;
  const out = tags
    .map((t) => (typeof t === 'string' ? t : t?.name ?? t?.slug ?? t?.id))
    .filter(Boolean)
    .map(String);
  return out.length ? out.join(',') : undefined;
}

export function toISO(raw) {
  if (!raw) return undefined;
  if (typeof raw === 'number') {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return new Date(ms).toISOString();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
