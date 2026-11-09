/**
 * AI 审核层：把一批帖子交给模型打分，输出 {keep, score, tags, why}。
 * 供应商可插拔，默认 GitHub Models（在 Actions 里用内置 GITHUB_TOKEN，无需额外付费 key）。
 */

const BATCH_SIZE = Number(process.env.REVIEW_BATCH_SIZE ?? 20);

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

async function chat(messages, { timeout = 90000 } = {}) {
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
    return cfg.kind === 'gemini'
      ? (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text).join('')
      : data.choices?.[0]?.message?.content ?? '';
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
  for (let offset = 0; offset < items.length; offset += BATCH_SIZE) {
    const batch = items.slice(offset, offset + BATCH_SIZE);
    const prompt = renderPrompt(template, profile, batch);
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
      try {
        const raw = await chat([
          { role: 'system', content: '你是严格的社区内容审核与编辑。只输出 JSON，不要任何解释、前缀或 markdown 围栏。' },
          { role: 'user', content: prompt },
        ]);
        const map = parseVerdicts(raw, batch.length);
        map.forEach((v, i) => verdicts.set(offset + i, v));
        ok = map.size > 0;
        if (!ok) throw new Error('no verdict parsed');
      } catch (err) {
        log(`  ! 审核批次 ${offset / BATCH_SIZE + 1} 第 ${attempt} 次失败: ${err.message}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    if (!ok) {
      const mode = process.env.FALLBACK_ON_REVIEW_ERROR ?? 'push';
      for (let i = 0; i < batch.length; i += 1) {
        if (!verdicts.has(offset + i)) {
          verdicts.set(offset + i, {
            keep: mode === 'push',
            score: mode === 'push' ? Number(process.env.MIN_SCORE ?? 6) : 0,
            tags: [],
            why: mode === 'push' ? 'AI 审核不可用，原样推送' : 'AI 审核不可用，已丢弃',
            error: 'review-failed',
          });
        }
      }
    }
  }
  return verdicts;
}
