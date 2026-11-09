import { requestJson } from '../lib/http.mjs';
import { excerpt, pick, toISO, findObjectArray, tagList } from '../lib/parse.mjs';

/**
 * 自建/未知结构站点的兜底适配器（nodeseek 走这条）。
 * 不写死字段路径：顺着配置里的候选接口依次尝试，谁返回了"帖子数组"就用谁。
 * 这样接口改版或字段更名时不会整体挂掉，probe 脚本能打出真实采样。
 */
export async function fetchGeneric(source, ctx) {
  const endpoints = source.endpoints ?? [];
  let lastErr;
  for (const path of endpoints) {
    const url = path.startsWith('http') ? path : source.baseUrl + path;
    try {
      const data = await requestJson(url, { timeout: 25000 });
      const list = findObjectArray(data);
      if (!list.length) {
        lastErr = new Error(`${url} 未找到帖子数组`);
        continue;
      }
      ctx.sample?.(source.id, url, list[0]);
      const out = [];
      for (const t of list) {
        const id = pick(t, ['id', 'post_id', 'topic_id', 'tid', 'thread_id']);
        if (id === undefined) continue;
        const created = toISO(pick(t, ['created_at', 'createdAt', 'published_at', 'date', 'time']));
        if (!ctx.withinWindow(created)) continue;
        const slug = pick(t, ['slug', 'url', 'link']);
        out.push({
          sourceId: source.id,
          sourceName: source.name,
          id: String(id),
          title: pick(t, ['title', 'subject', 'name', 'topic_title']) ?? '(无标题)',
          url: slug && String(slug).startsWith('http')
            ? String(slug)
            : (source.topicUrlPattern ?? '{base}/post-{id}-1')
                .replace('{base}', source.baseUrl)
                .replace('{id}', String(id)),
          author: pick(t, ['username', 'author', 'member', 'user']),
          createdAt: created,
          category: tagList(t.tags) ?? pick(t, ['category', 'node_name', 'board']),
          stats: t.view_count !== undefined || t.replies_count !== undefined
            ? `${t.view_count ?? 0} 浏览 / ${t.replies_count ?? 0} 回复`
            : undefined,
          text: excerpt(pick(t, ['content', 'excerpt', 'description', 'summary', 'body', 'preview']) ?? ''),
        });
      }
      return out;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('no endpoint worked');
}
