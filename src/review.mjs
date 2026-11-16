/**
 * AI 审核层：把一批帖子交给模型打分，输出 {keep, score, tags, why}。
 * 供应商可插拔，默认 GitHub Models（在 Actions 里用内置 GITHUB_TOKEN，无需额外付费 key）。
 */

const BATCH_SIZE = Number(process.env.REVIEW_BATCH_SIZE ?? 10);

function providerConfig() {
  // 默认策略：配了自定义 base url 就用它（DeepSeek 等中转服务），否则回落到 GitHub Models
  const name = process.env.REVIEW_PROVIDER
    ?? (process.env.REVIEW_BASE_URL ? 'openai-compatible' : 'github-models');

  if (name === 'openai-compatible') {
    const base = process.env.REVIEW_BASE_URL;
    if (!base) throw new Error('REVIEW_BASE_URL 未配置');
    const key = process.env.REVIEW_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
    if (!key) throw new Error('REVIEW_API_KEY 未配置');
    return {
      kind: 'openai',
      url: base.replace(/\/+$/, '') + '/chat/completions',
      model: process.env.REVIEW_MODEL ?? 'deepseek-v4.1-flash-1017',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    };
  }

  if (name === 'gemini') {
    const model = process.env.REVIEW_MODEL ?? 'gemini-2.5-flash';
    return {
      kind: 'gemini',
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '' },
      model,
    };
  }
  const presets = {
    'github-models': {
      url: 'https://models.github.ai/inference/chat/completions',
      token: process.env.GITHUB_MODELS_TOKEN ?? process.env.GITHUB_TOKEN,
      model: process.env.REVIEW_MODEL ?? 'openai/gpt-4.1-mini',
    },
    deepseek: {
      url: 'https://api.deepseek.com/chat/completions',
      token: process.env.DEEPSEEK_API_KEY,
      model: process.env.REVIEW_MODEL ?? 'deepseek-chat',
    },
    openai: {
      url: (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1') + '/chat/completions',
      token: process.env.OPENAI_API_KEY,
      model: process.env.REVIEW_MODEL ?? 'gpt-4o-mini',
    },
  };
  const p = presets[name];
  if (!p) throw new Error(`unknown REVIEW_PROVIDER: ${name}`);
  return {
    kind: 'openai',
    url: p.url,
    model: p.model,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${p.token ?? ''}` },
  };
}

async function chat(messages, { timeout = 180000 } = {}) {
  const cfg = providerConfig();
  const body = cfg.kind === 'gemini'
    ? {
        contents: [{ role: 'user', parts: [{ text: messages.map((m) => m.content).join('\n\n') }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }
    : {
        model: cfg.model,
        messages,
        temperature: 0.2,
        // 该模型带长思维链（reasoning_content），max_tokens 给小了 JSON 会被截断，
        // 表现为整批解析失败、全部条目丢失。
        max_tokens: Number(process.env.REVIEW_MAX_TOKENS ?? 16000),
        // 部分托管模型不支持 response_format，硬带会整批 400；靠提示词 + 解析容错兜住
        ...(process.env.REVIEW_JSON_MODE === '1' ? { response_format: { type: 'json_object' } } : {}),
      };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: cfg.headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`review provider ${res.status}: ${text.slice(0, 300)}`);
    const data = JSON.parse(text);
    if (cfg.kind === 'gemini') {
      return {
        content: (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text).join(''),
        finishReason: data.candidates?.[0]?.finishReason ?? '',
      };
    }
    return {
      content: data.choices?.[0]?.message?.content ?? '',
      // length 表示被 max_tokens 截断：该模型思维链很长，JSON 会写一半就断
      finishReason: data.choices?.[0]?.finish_reason ?? '',
    };
  } finally {
    clearTimeout(timer);
  }
}

export function parseVerdicts(raw, expected) {
  if (!raw) throw new Error('empty model output');
  const clean = raw.replace(/^```(?:json)?/gm, '').replace(/```$/gm, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    // 模型偶尔在 JSON 前后加解释文字；数组起点可能早于第一个 '{'
    const objStart = clean.indexOf('{');
    const arrStart = clean.indexOf('[');
    const start = arrStart >= 0 && (objStart < 0 || arrStart < objStart) ? arrStart : objStart;
    const end = Math.max(clean.lastIndexOf('}'), clean.lastIndexOf(']'));
    if (start < 0 || end <= start) throw new Error('model output is not JSON');
    parsed = JSON.parse(clean.slice(start, end + 1));
  }
  const arr = Array.isArray(parsed) ? parsed : parsed.results ?? parsed.items ?? parsed.data;
  if (!Array.isArray(arr)) throw new Error('model output missing results[]');

  const byIndex = new Map();
  arr.forEach((v, i) => {
    const idx = Number(v.i ?? v.index ?? v.id ?? i + 1) - 1;
    if (idx < 0 || idx >= expected) return;
    const score = Math.max(0, Math.min(10, Number(v.score ?? (v.keep ? 6 : 0)) || 0));
    byIndex.set(idx, {
      keep: v.keep === undefined ? score >= 5 : Boolean(v.keep),
      score,
      tags: Array.isArray(v.tags) ? v.tags.slice(0, 4).map(String) : [],
      why: String(v.why ?? v.reason ?? '').slice(0, 120),
    });
  });
  return byIndex;
}

function renderPrompt(template, profile, items) {
  const lines = items.map((it, i) => {
    const parts = [`[${i + 1}] 来源=${it.sourceName} 标题=${it.title}`];
    const meta = [it.category && `板块=${it.category}`, it.stats && `数据=${it.stats}`].filter(Boolean).join(' ');
    if (meta) parts.push(meta);
    parts.push(`正文=${it.text || '(无正文)'}`);
    if (Array.isArray(it.replies) && it.replies.length) {
      parts.push('热门评论=\n' + it.replies
        .map((r) => `  - ${r.author}${r.likes ? `(${r.likes}赞)` : ''}：${r.text}`)
        .join('\n'));
    } else {
      parts.push('热门评论=(暂无)');
    }
    return parts.join('\n');
  });
  return template
    .replace('{{PROFILE}}', profile)
    .replace('{{COUNT}}', String(items.length))
    .replace('{{ITEMS}}', lines.join('\n\n'));
}

/**
 * @returns {Promise<Map<number,{keep:boolean,score:number,tags:string[],why:string,error?:string}>>}
 */
export async function reviewItems(items, { template, profile, log = () => {} }) {
  const verdicts = new Map();

  const batches = [];
  for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
    batches.push({ offset, batch: items.slice(offset, offset + BATCH_SIZE) });
  }

  // 批处理改成并发：串行时 216 条要跑 36 分钟，把整个抓取循环都堵住了。
  const CONCURRENCY = Math.max(1, Number(process.env.REVIEW_CONCURRENCY ?? 3));
  // 审核没成功的条目默认丢弃：宁可少推，也不要把没经过筛选的帖子当成好帖发出去。
  const failMode = process.env.FALLBACK_ON_REVIEW_ERROR ?? 'drop';

  let cursor = 0;

  // 只有"正文很短 + 带图"的帖子才附图：那类帖子正文几乎没信息，图就是内容本身。
  // 长文帖的配图属于锦上添花，带上只会白烧 token（该模型思维链很长）。
  // 图床普遍有防盗链，让模型服务端自己去下载会 403（实测整批 400）。
  // 这里改成由 runner 先下载、转成 data URL 内联传过去，绕开对方的下载环节。
  async function toDataUrl(url) {
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          referer: new URL(url).origin + '/',
        },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return null;
      const type = res.headers.get('content-type') ?? '';
      if (!type.startsWith('image/')) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      // 单张限 2MB：太大的图 base64 之后会把上下文顶爆
      if (!buf.length || buf.length > 2 * 1024 * 1024) return null;
      return 'data:' + type.split(';')[0] + ';base64,' + buf.toString('base64');
    } catch {
      return null;
    }
  }

  async function collectImages(batch, max = 3) {
    const urls = [];
    for (const item of batch) {
      if (!Array.isArray(item.images) || !item.images.length) continue;
      if (String(item.text || '').length >= 300) continue;
      for (const u of item.images) {
        if (urls.length >= max) return urls;
        if (typeof u !== 'string' || !u.startsWith('http')) continue;
        // 矢量图接口不收，带上会让整批 400
        if (/\.svg(\?|$)/i.test(u)) continue;
        if (!urls.includes(u)) urls.push(u);
      }
    }
    const out = [];
    for (const u of urls) {
      const dataUrl = await toDataUrl(u);
      if (dataUrl) out.push(dataUrl);
    }
    return out;
  }

  async function runOne({ offset, batch, depth = 0 }) {
    const prompt = renderPrompt(template, profile, batch);
    let images = await collectImages(batch);
    if (images.length) log(`  · 批次 ${offset / BATCH_SIZE + 1} 附带 ${images.length} 张图`);
    let ok = false;
    let truncated = false;

    for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
      try {
        const userContent = images.length
          ? [
              { type: 'text', text: prompt },
              ...images.map((u) => ({ type: 'image_url', image_url: { url: u } })),
            ]
          : prompt;
        const res = await chat([
          { role: 'system', content: '你是严格的社区内容审核与编辑。只输出 JSON，不要任何解释、前缀或 markdown 围栏。' },
          { role: 'user', content: userContent },
        ]);
        const raw = res.content ?? '';

        // finish_reason=length 表示 JSON 写到一半被 max_tokens 截断。
        // 这种情况重试同一批多半还是截断，直接拆半各跑一次更有效。
        if (res.finishReason === 'length' && batch.length > 1 && depth < 3) {
          truncated = true;
          break;
        }

        const map = parseVerdicts(raw, batch.length);
        map.forEach((v, i) => verdicts.set(offset + i, v));
        ok = map.size > 0;
        if (!ok) throw new Error('no verdict parsed');
      } catch (err) {
        log(`  ! 审核批次 ${offset / BATCH_SIZE + 1} 第 ${attempt} 次失败: ${err.message}`);
        // 图片相关的报错（图床挡了、格式不支持）不该拖垮整批：
        // 丢掉图用纯文本重来，宁可少看图也不能丢帖子。
        if (images.length && /image/i.test(err.message)) {
          log('    → 图片加载失败，本批降级为纯文本重试');
          images = [];
          attempt -= 1;
          continue;
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }

    if (truncated) {
      const mid = Math.ceil(batch.length / 2);
      log(`  ! 批次 ${offset / BATCH_SIZE + 1} 被 max_tokens 截断，拆成 ${mid}+${batch.length - mid} 重试`);
      await runOne({ offset, batch: batch.slice(0, mid), depth: depth + 1 });
      await runOne({ offset: offset + mid, batch: batch.slice(mid), depth: depth + 1 });
      return;
    }

    if (!ok) {
      for (let i = 0; i < batch.length; i += 1) {
        if (!verdicts.has(offset + i)) {
          verdicts.set(offset + i, {
            keep: failMode === 'push',
            score: failMode === 'push' ? Number(process.env.MIN_SCORE ?? 6) : 0,
            tags: [],
            why: failMode === 'push' ? 'AI 审核不可用，原样推送' : 'AI 审核不可用，已丢弃',
            error: 'review-failed',
          });
        }
      }
    }
  }

  async function worker() {
    while (cursor < batches.length) {
      const my = batches[cursor];
      cursor += 1;
      await runOne(my);
    }
  }

  const n = Math.min(CONCURRENCY, batches.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return verdicts;
}
