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

/**
 * 分页 HTML 主列表。
 * 实测结构：主列表锚点是 <a href="https://www.nodeseek.com/post-N-1" target="">标题</a>，无 class；
 * 同一帖还有一条 <a href=".../post-N-1#2" class="info-item info-last-comment-time">13min ago</a>。
 * 所以：只要不带 # 锚点、不带 info-item 类、文本非空的第 1 页链接。主列表在页面最前面，取前 30 条避开侧栏推荐。
 */
export function parseListHtml(html, limit = 30) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const attrs = m[1];
    if (/class="[^"]*info-item/.test(attrs)) continue;
    const href = attrs.match(/href="([^"]+)"/)?.[1];
    if (!href || href.includes('#')) continue;
    const id = href.match(/\/post-(\d+)-1$/)?.[1];
    if (!id || seen.has(id)) continue;
    const title = decodeEntities(stripHtml(m[2]));
    if (!title || /^\d+\s*(min|hour|day|month|year)s?\s*ago$/i.test(title)) continue;
    seen.add(id);
    out.push({ id, title, url: `${'https://www.nodeseek.com'}/post-${id}-1` });
    if (out.length >= limit) break;
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
  // 注意：这里必须关掉 jina 兜底，它返回 markdown，HTML 解析器认不出来
  for (let page = 2; page <= (source.pages ?? 1); page += 1) {
    try {
      const html = await requestText(`${baseUrl}/page-${page}`, { timeout: 20000, allowJina: false });
      const list = parseListHtml(html);
      let added = 0;
      for (const p of list) {
        if (!byId.has(p.id)) {
          byId.set(p.id, { ...p, createdAt: undefined });
          added += 1;
        }
      }
      console.log(`  [nodeseek] page-${page}: 解析 ${list.length} 条, 新增 ${added} 条 (html ${html.length} 字节)`);
    } catch (err) {
      console.log(`  [nodeseek] page-${page} 失败: ${err.message.slice(0, 140)}`);
    }
  }

  const all = [...byId.values()];
  const fresh = all.filter((p) => ctx.withinWindow(p.createdAt));

  // 正文抓取：限流 + 3 并发，40 条约 30 秒
  if (source.fetchDetail !== false) {
    const limit = source.detailLimit ?? 40;
    const queue = fresh.slice(0, limit);
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const item = queue[cursor++];
        item.text = excerpt(await fetchBody(baseUrl, item.id));
        await new Promise((r) => setTimeout(r, 150));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
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
