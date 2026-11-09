import { requestText } from '../lib/http.mjs';
import { excerpt, stripHtml, toISO } from '../lib/parse.mjs';

/**
 * NodeSeek 适配器（2026-11 实测确认的接入方式）：
 *   列表主源  GET /rss.xml          200，标准 RSS 2.0，含 title/link/guid/category/dc:creator/pubDate
 *   列表补源  GET /page-2 ...       200，服务端渲染 HTML，主列表锚点 class 含 post-title
 *   正文      GET /post-{id}-1      200，正文在 .post-content，兜底 <meta name="description">
 * 没有公开的 JSON API（/api/posts 等均 404），所以走 RSS + HTML。
 */

const decodeEntities = (s = '') =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
   .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');

const cdata = (s = '') => s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();

function rssTag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decodeEntities(cdata(m[1])) : undefined;
}

export function parseRss(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const link = rssTag(block, 'link');
    const id = (rssTag(block, 'guid') || link?.match(/post-(\d+)/)?.[1] || '').trim();
    if (!id || !link) continue;
    out.push({
      id,
      title: rssTag(block, 'title') ?? '(无标题)',
      url: link,
      author: rssTag(block, 'dc:creator'),
      category: rssTag(block, 'category'),
      createdAt: toISO(rssTag(block, 'pubDate')),
      pinned: false,
    });
  }
  return out;
}

/** 分页 HTML 主列表：只认带 post-title 类名的锚点，避开侧边栏推荐的老帖 */
export function parseListHtml(html) {
  const out = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const attrs = m[1];
    if (!/post-title/i.test(attrs)) continue;
    const href = attrs.match(/href="([^"]+)"/)?.[1];
    const id = href?.match(/post-(\d+)-/)?.[1];
    const title = decodeEntities(stripHtml(m[2]));
    if (!id || !title) continue;
    out.push({ id, title, url: `${'https://www.nodeseek.com'}/post-${id}-1` });
  }
  return out;
}

/** 详情页正文：优先 .post-content，兜底 meta description；都失败返回空串（仍可用标题审核） */
async function fetchBody(baseUrl, id) {
  try {
    const html = await requestText(`${baseUrl}/post-${id}-1`, { timeout: 15000, retries: 1 });
    const div = html.match(/<div[^>]*class="[^"]*\bpost-content\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (div) {
      const text = stripHtml(div[1]);
      if (text.length > 20) return text;
    }
    const meta = html.match(/<meta[^>]+(?:property|name)="(?:og:description|description)"[^>]+content="([^"]+)"/i)
      ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+(?:property|name)="(?:og:description|description)"/i);
    return meta ? decodeEntities(meta[1]) : '';
  } catch {
    return '';
  }
}

export async function fetchNodeseek(source, ctx) {
  const baseUrl = source.baseUrl;
  const rss = parseRss(await requestText(`${baseUrl}/rss.xml`, { timeout: 25000 }));
  const byId = new Map(rss.map((p) => [p.id, p]));

  // 分页补更早的帖子（RSS 只覆盖最近 20 条）
  for (let page = 2; page <= (source.pages ?? 1); page += 1) {
    try {
      const html = await requestText(`${baseUrl}/page-${page}`, { timeout: 20000 });
      for (const p of parseListHtml(html)) {
        if (!byId.has(p.id)) byId.set(p.id, { ...p, createdAt: undefined });
      }
    } catch { /* 分页失败不影响 RSS 主源 */ }
  }

  const all = [...byId.values()];
  const fresh = all.filter((p) => ctx.withinWindow(p.createdAt));

  // 只为配置了正文抓取的站点拉详情，控制请求量
  const limit = source.detailLimit ?? 30;
  let fetched = 0;
  for (const p of fresh) {
    if (fetched >= limit) break;
    if (source.fetchDetail === false) break;
    fetched += 1;
    const body = await fetchBody(baseUrl, p.id);
    p.text = excerpt(body);
    if (fetched % 5 === 0) await new Promise((r) => setTimeout(r, 250));
  }

  return fresh.map((p) => ({
    sourceId: source.id,
    sourceName: source.name,
    id: p.id,
    title: p.title,
    url: p.url,
    author: p.author,
    createdAt: p.createdAt,
    category: p.category,
    text: p.text ?? '',
  }));
}
