import { requestJson } from '../lib/http.mjs';
import { excerpt, pick, toISO, findObjectArray, tagList } from '../lib/parse.mjs';

/**
 * n.ht（NHT 技术社区）适配器。
 *
 * 列表：GET /api/topics?page=N -> {code:200, data:[...], pagination:{page,per_page,total,total_pages}}
 * 详情：GET /api/topics/{id}  -> {code, data:{topic, replies, endorsed_reply}}
 *
 * 两个实测结论：
 *   1. 排序是按「最后回复时间」倒序，page=1 就是最新的一批；置顶帖排在最前面（is_pinned）。
 *      所以必须从 page=1 开始抓，不能倒着抓（倒着抓拿到的是几个月前的死帖）。
 *   2. 全站只有一百多条帖，更新很慢，用 collect 那个 25 分钟窗口几乎永远抓不到东西。
 *      这里改用 source.windowHours（默认 24 小时），靠 seen 去重保证不重复入队。
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
  const windowHours = Number(source.windowHours || 24);
  const cutoff = Date.now() - windowHours * 3600 * 1000;
  const pages = Math.max(1, Number(source.pages || 2));

  const out = [];
  const seen = new Set();

  for (let page = 1; page <= pages; page += 1) {
    const data = await requestJson(pageUrl(source.baseUrl, page), { timeout: 25000 });
    const list = Array.isArray(data && data.data) ? data.data : findObjectArray(data);
    if (!list.length) break;

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

  console.log('  [nht] 窗口 ' + windowHours + 'h 内 ' + out.length + ' 条');
  return out;
}
