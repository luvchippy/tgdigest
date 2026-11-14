/**
 * 标准 RSS 2.0 适配器。
 *
 * 适用于没有公开 JSON 接口、但提供 /rss.xml 的站点。
 * 典型代表：Flarum 论坛（例如 1a2x）。这类站点 /api/discussions 可能返回 404，
 * 但 RSS 是开放的，description 里带正文摘要，够 AI 判断值不值得推。
 *
 * 不额外抓详情页：RSS 每次只给最近 20~30 条且不分页，抓详情收益低、请求量大。
 */
import { requestText } from '../lib/http.mjs';
import { excerpt, stripHtml, toISO } from '../lib/parse.mjs';

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}

function idFromLink(link) {
  const byTPath = String(link).match(/\/t\/(\d+)/);
  if (byTPath) return byTPath[1];
  const byTail = String(link).match(/(\d+)\/?$/);
  if (byTail) return byTail[1];
  return String(link);
}

export async function fetchRss(source, ctx) {
  const base = source.baseUrl.replace(/\/$/, '');
  const feedUrl = source.feedUrl || base + '/rss.xml';

  const xml = await requestText(feedUrl, { timeout: 25000, allowJina: false });

  const blocks = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  if (!blocks.length) throw new Error('RSS 里没有 item');

  const out = [];
  for (const b of blocks) {
    const title = stripHtml(tag(b, 'title'));
    const link = tag(b, 'link') || tag(b, 'guid');
    if (!title || !link) continue;

    const created = toISO(tag(b, 'pubDate'));
    if (!ctx.withinWindow(created)) continue;

    const desc = stripHtml(tag(b, 'description'));
    const category = stripHtml(tag(b, 'category'));

    out.push({
      sourceId: source.id,
      sourceName: source.name,
      id: idFromLink(link),
      title,
      url: link,
      createdAt: created,
      category: category || undefined,
      text: excerpt(desc, 1200),
      replies: [],
    });
  }

  ctx.sample?.(source.id, feedUrl, out[0]);
  console.log('  [' + source.id + '] RSS ' + blocks.length + ' 条，窗口内 ' + out.length + ' 条');
  return out;
}
