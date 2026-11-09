import { chromium } from 'playwright';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ userAgent: UA, locale: 'zh-CN', viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();

const cookieNames = async () => (await ctx.cookies()).map((c) => c.name).join(',');

// 第一步：列表页过挑战
await page.goto('https://www.nodeseek.com/page-2', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(7000);
console.log('[列表] title="' + (await page.title()) + '" cookies=' + (await cookieNames()));

// 第二步：模拟真人点击进帖（带 referer 和已通过的 cookie）
try {
  const href = await page.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find((x) => {
      const h = x.getAttribute('href') || '';
      return /post-\d+-1$/.test(h) && !/info-item/.test(x.className || '');
    });
    return a ? a.getAttribute('href') : null;
  });
  console.log('[候选链接] ' + href);

  if (href) {
    await page.goto(new URL(href, 'https://www.nodeseek.com').toString(), {
      waitUntil: 'domcontentloaded', referer: 'https://www.nodeseek.com/page-2', timeout: 60000,
    });
    await page.waitForTimeout(20000);
    let body = await page.evaluate(() => document.querySelector('.post-content')?.innerText ?? '');
    if (!body) {
      await page.waitForTimeout(25000);
      body = await page.evaluate(() => document.querySelector('.post-content')?.innerText ?? '');
    }
    console.log('[点击进帖] title="' + (await page.title()) + '" cookies=' + (await cookieNames()));
    console.log('[正文] ' + (body ? body.replace(/\s+/g, ' ').slice(0, 400) : '(仍然没有 .post-content)'));
  }
} catch (e) {
  console.log('[点击进帖] 失败: ' + e.message.slice(0, 120));
}

// 第三步：换一个详情页直连，等 40 秒
try {
  const p2 = await ctx.newPage();
  await p2.goto('https://www.nodeseek.com/post-1041222-1', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p2.waitForTimeout(40000);
  const body2 = await p2.evaluate(() => document.querySelector('.post-content')?.innerText ?? '');
  console.log('[直连长等] title="' + (await p2.title()) + '" 正文=' + (body2 ? body2.replace(/\s+/g, ' ').slice(0, 200) : '(无)'));
  await p2.close();
} catch (e) {
  console.log('[直连长等] 失败: ' + e.message.slice(0, 100));
}

await browser.close();
