import { requestJson } from '../lib/http.mjs';
import { excerpt, pick, toISO, findObjectArray, tagList } from '../lib/parse.mjs';

/**
 * n.ht（NHT 技术社区）适配器。
 *
 * 列表：GET /api/topics?page=N -> {code:200, data:[...], pagination:{page,per_page,total,total_pages}}
 * 详情：GET /api/topics/{id}  -> {code, data:{topic, replies, endorsed_reply}}
 *
 * 坑：这个接口按 id 升序分页，page=1 是最老的帖子（id=1 是建站公告）。
 * 原实现固定抓 page=1，于是永远只能拿到几个月前的帖子，被时间窗口全部滤掉。
 * 现在先读 pagination.total_pages，再从最后一页往前抓，保证先拿到最新的。
 */

const MAX_REPLIES = 5;

async function fetchReplies(baseUrl, id) {
  const data = await requestJson(baseUrl + '/api/topics/' + id, { timeout: 20000, retries: 1 });
  const replies = (data && data.data && data.data.replies) || [];
  return replies
    .filter((r) => r && !r.is_hidden && String(r.content || '').trim())
    .map((r) => ({
      author: (r.user && r.user.username) || r.username || ('uid' + (r.user_id || '?')),
      text: excerpt(r.content, 220),
      likes: Number(r.like_count || 0),
    }))
    .sort((a, b) => b.likes - a.likes)
    .slice(0, MAX_REPLIES);
}

function pageUrl(baseUrl, page) {
  return baseUrl + '/api/topics?page=' + page;
}

export async function fetchNht(source, ctx) {
  // 帖子不多（实测 105 条 / 6 页），用宽窗口 + seen 去重就够了
  const windowHours = Number(source.windowHours || 24);
  const cutoff = Date.now() - windowHours * 3600 * 1000;

  const first = await requestJson(pageUrl(source.baseUrl, 1), { timeout: 25000 });
  const totalPages = Math.max(1, Number((first && first.pagination && first.pagination.total_pages) || 1));
  const wantPages = Math.max(1, Number(source.pages || 2));
  const startPage = Math.max(1, totalPages - wantPages + 1);

  console.log('  [nht] 共 ' + totalPages + ' 页，抓第 ' + startPage + '~' + totalPages + ' 页');

  const out = [];
  const seen = new Set();

  for (let page = totalPages; page >= startPage; page -= 1) {
    const data = page === 1 ? first : await requestJson(pageUrl(source.baseUrl, page), { timeout: 25000 });
    const list = Array.isArray(data && data.data) ? data.data : findObjectArray(data);
    if (!list.length) continue;

    for (const t of list) {
      if (t.is_hidden) continue;
      const id = pick(t, ['id', 'topic_id', 'tid']);
      if (id === undefined || seen.has(String(id))) continue;

      const created = toISO(pick(t, ['created_at', 'createdAt', 'published_at']));
      const ts = created ? Date.parse(created) : NaN;
      if (!Number.isNaN(ts) && ts < cutoff) continue;
      seen.add(String(id));

      let replies = [];
      if (source.fetchDetail) {
        try { replies = await fetchReplies(source.baseUrl, id); } catch (e) { /* 单帖失败忽略 */ }
      }

      out.push({
        sourceId: source.id,
        sourceName: source.name,
        id: String(id),
        title: pick(t, ['title', 'subject']) || '(无标题)',
        url: source.baseUrl + '/t/' + id,
        author: t.username || (t.user_id ? 'uid' + t.user_id : undefined),
        createdAt: created,
        category: tagList(t.tags),
        stats: (t.view_count || 0) + ' 浏览 / ' + (t.replies_count || 0) + ' 回复',
        text: excerpt(t.content || t.summary || ''),
        replies,
      });
    }
  }

  console.log('  [nht] 窗口内 ' + out.length + ' 条');
  return out;
}
