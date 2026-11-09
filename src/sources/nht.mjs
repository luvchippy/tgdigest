import { requestJson } from '../lib/http.mjs';
import { excerpt, pick, toISO, findObjectArray, tagList } from '../lib/parse.mjs';

/**
 * n.ht（NHT 技术社区）适配器。
 * 列表：GET /api/topics?page=1 -> {code:200, data:[{id,title,content,tags,...}]}，content 就是正文
 * 详情：GET /api/topics/{id}  -> {code, data:{topic, replies:[{content, like_count, user,...}], endorsed_reply}}
 */

const MAX_REPLIES = 5;

async function fetchReplies(baseUrl, id) {
  const data = await requestJson(`${baseUrl}/api/topics/${id}`, { timeout: 20000, retries: 1 });
  const replies = data?.data?.replies ?? [];
  return replies
    .filter((r) => r && !r.is_hidden && String(r.content ?? '').trim())
    .map((r) => ({
      author: r.user?.username ?? r.username ?? `uid${r.user_id ?? '?'}`,
      text: excerpt(r.content, 220),
      likes: Number(r.like_count ?? 0),
    }))
    .sort((a, b) => b.likes - a.likes)
    .slice(0, MAX_REPLIES);
}

export async function fetchNht(source, ctx) {
  const pages = source.pages ?? 1;
  const out = [];
  for (let page = 1; page <= pages; page += 1) {
    const data = await requestJson(`${source.baseUrl}/api/topics?page=${page}`, { timeout: 25000 });
    const list = Array.isArray(data?.data) ? data.data : findObjectArray(data);
    if (!list.length) break;

    for (const t of list) {
      if (t.is_hidden) continue;
      const id = pick(t, ['id', 'topic_id', 'tid']);
      const created = toISO(pick(t, ['created_at', 'createdAt', 'published_at']));
      if (!ctx.withinWindow(created)) continue;

      let replies = [];
      if (source.fetchDetail) {
        try { replies = await fetchReplies(source.baseUrl, id); } catch { /* 忽略单帖失败 */ }
      }

      out.push({
        sourceId: source.id,
        sourceName: source.name,
        id: String(id),
        title: pick(t, ['title', 'subject']) ?? '(无标题)',
        url: `${source.baseUrl}/t/${id}`,
        author: t.username ?? (t.user_id ? `uid${t.user_id}` : undefined),
        createdAt: created,
        category: tagList(t.tags),
        stats: `${t.view_count ?? 0} 浏览 / ${t.replies_count ?? 0} 回复`,
        text: excerpt(t.content ?? t.summary ?? ''),
        replies,
      });
    }
    if (list.length < 10) break;
  }
  return out;
}
