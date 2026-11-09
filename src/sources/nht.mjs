import { requestJson } from '../lib/http.mjs';
import { excerpt, pick, toISO, findObjectArray, tagList } from '../lib/parse.mjs';

/**
 * n.ht（NHT 技术社区）适配器。
 * 已验证：GET https://n.ht/api/topics?page=1 -> {code:200, data:[{id,title,content,tags,...}]}
 * content 即正文，无需二次请求。
 */
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
      });
    }
    if (list.length < 10) break;
  }
  return out;
}
