import { requestJson } from '../lib/http.mjs';
import { excerpt, pick, toISO, tagList } from '../lib/parse.mjs';

/**
 * Discourse 站点适配器（nodeloc / linux.do）。
 * 已验证：GET {base}/latest.json 匿名可读，结构为 topic_list.topics[]。
 * 正文默认用 excerpt；需要全文时按需拉 {base}/t/{id}.json。
 */
export async function fetchDiscourse(source, ctx) {
  const pages = source.pages ?? 1;
  const out = [];
  for (let page = 0; page < pages; page += 1) {
    const url = `${source.baseUrl}/latest.json?page=${page}`;
    const data = await requestJson(url, { timeout: 25000 });
    const topics = data?.topic_list?.topics ?? [];
    if (!topics.length) break;

    for (const t of topics) {
      if (t.pinned || t.closed) continue;
      const created = toISO(t.created_at);
      if (!ctx.withinWindow(created)) continue;

      let body = t.excerpt ?? '';
      if (source.fetchDetail && ctx.needDetail) {
        try {
          const detail = await requestJson(`${source.baseUrl}/t/${t.id}.json`, { timeout: 20000 });
          const first = detail?.post_stream?.posts?.[0];
          if (first?.cooked) body = first.cooked;
        } catch {
          /* 详情失败时退回 excerpt，不丢帖 */
        }
      }

      out.push({
        sourceId: source.id,
        sourceName: source.name,
        id: String(t.id),
        title: pick(t, ['title', 'fancy_title']) ?? '(无标题)',
        url: `${source.baseUrl}/t/${t.slug && t.slug !== 'topic' ? t.slug : ''}${t.slug && t.slug !== 'topic' ? '/' : ''}${t.id}`,
        author: t.last_poster_username,
        createdAt: created,
        category: tagList(t.tags),
        stats: `${t.views ?? 0} 浏览 / ${t.like_count ?? 0} 赞 / ${t.posts_count ?? 0} 楼`,
        text: excerpt(body),
      });
    }
    if (topics.length < 25) break;
  }
  return out;
}
