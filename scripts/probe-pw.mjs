import { chromium } from 'playwright';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ userAgent: UA, locale: 'zh-CN', viewport: { width: 1366, height: 900 } });

async function visit(url, label) {
  const page = await ctx.newPage();
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    const title = await page.title();
    const html = await page.content();
    const posts = (html.match(/post-\d+-1/g) ?? []).length;
    const blocked = /Just a moment|ipv6\s*已关闭|Verifying you are human/i.test(html.slice(0, 4000));
    console.log(`[${label}] title="${title}" len=${html.length} post链接=${posts} 被挡=${blocked} 耗时=${Date.now() - t0}ms`);
    await page.close();
    return { blocked, html };
  } catch (e) {
    console.log(`[${label}] 失败: ${e.message.slice(0, 120)}`);
    await page.close().catch(() => {});
    return { blocked: true, html: '' };
  }
}

await visit('https://www.nodeseek.com/page-2', 'page-2');

// 详情页取正文
const page = await ctx.newPage();
try {
  await page.goto('https://www.nodeseek.com/post-1041251-1', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  const body = await page.evaluate(() => {
    const el = document.querySelector('.post-content');
    return el ? el.innerText.slice(0, 300) : null;
  });
  console.log('[详情] title=' + (await page.title()));
  console.log('[详情正文] ' + (body ? body.replace(/\s+/g, ' ') : '(未找到 .post-content)'));
} catch (e) {
  console.log('[详情] 失败: ' + e.message.slice(0, 120));
}
await browser.close();
