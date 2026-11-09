import { requestJson } from '../lib/http.mjs';
import { excerpt, pick, toISO, tagList } from '../lib/parse.mjs';

/**
 * Discourse 站点适配器（nodeloc / linux.do）。
 * 列表：GET {base}/latest.json -> topic_list.topics[]
 * 详情：GET {base}/t/{id}.json  -> post_stream.posts[]（第 1 条是楼主，其余是回复，带 like_count）
 */

const MAX_REPLIES = 5;

async function fetchDetail(baseUrl, topicId) {
  const data = await requestJson(`${baseUrl}/t/${topicId}.json`, { timeout: 20000, retries: 1 });
  const posts = data?.post_stream?.posts ?? [];
  if (!posts.length) return { replies: [], opLikes: 0 };
  const replies = posts
    .slice(1)
    .filter((p) => p.cooked && String(p.cooked).trim())
    .map((p) => ({
      author: p.username ?? p.name ?? '?',
      text: excerpt(p.cooked, 220),
      likes: Number(p.like_count ?? p.reaction_users_count ?? 0),
    }))
    .sort((a, b) => b.likes - a.likes)
    .slice(0, MAX_REPLIES);
  return { replies, opLikes: Number(posts[0]?.like_count ?? 0) };
}

export async function fetchDiscourse(source, ctx) {
  const pages = source.pages ?? 1;
  const detailLimit = source.detailLimit ?? 30;
  let detailUsed = 0;
  const out = [];
  for (let page = 0; page < pages; page += 1) {
    const data = await requestJson(`${source.baseUrl}/latest.json?page=${page}`, { timeout: 25000 });
    const topics = data?.topic_list?.topics ?? [];
    if (!topics.length) break;

    for (const t of topics) {
      if (t.pinned || t.closed) continue;
      const created = toISO(t.created_at);
      if (!ctx.withinWindow(created)) continue;

      const body = t.excerpt ?? '';
      let replies = [];
      let opLikes = Number(t.like_count ?? 0);

      if (source.fetchDetail && detailUsed < detailLimit) {
        detailUsed += 1;
        try {
          const detail = await fetchDetail(source.baseUrl, t.id);
          if (detail.replies.length) replies = detail.replies;
          if (detail.opLikes) opLikes = detail.opLikes;
        } catch {
          /* 详情失败就退回列表摘要，不丢帖 */
        }
      }

      const slugPart = t.slug && t.slug !== 'topic' ? `${t.slug}/` : '';
      out.push({
        sourceId: source.id,
        sourceName: source.name,
        id: String(t.id),
        title: pick(t, ['title', 'fancy_title']) ?? '(无标题)',
        url: `${source.baseUrl}/t/${slugPart}${t.id}`,
        author: t.last_poster_username,
        createdAt: created,
        category: tagList(t.tags),
        stats: `${t.views ?? 0} 浏览 / ${opLikes} 赞 / ${t.posts_count ?? 0} 回复`,
        text: excerpt(body),
        replies,
      });
    }
    if (topics.length < 25) break;
  }
  return out;
}
