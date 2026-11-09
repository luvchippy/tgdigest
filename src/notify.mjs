const TG = 'https://api.telegram.org';
const LIMIT = 3800;

export const escapeHtml = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 按行切分长文本，保持每条 <= 3800 字符，避免 4096 上限截断 */
export function chunk(text, limit = LIMIT) {
  const chunks = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > limit) {
      if (buf) chunks.push(buf);
      buf = line.length > limit ? line.slice(0, limit) : line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function callTelegram(token, method, payload) {
  const res = await fetch(`${TG}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const retryAfter = data?.parameters?.retry_after;
    const err = new Error(`telegram ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    err.retryAfter = retryAfter;
    throw err;
  }
  return data.result;
}

export async function sendTelegram(text, { token, chatId, log = () => {} }) {
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID 未配置');
  const parts = chunk(text);
  let sent = 0;
  for (let i = 0; i < parts.length; i += 1) {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await callTelegram(token, 'sendMessage', {
          chat_id: chatId,
          text: parts[i],
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          link_preview_options: { is_disabled: true },
        });
        sent += 1;
        break;
      } catch (err) {
        if (err.retryAfter) {
          await new Promise((r) => setTimeout(r, (err.retryAfter + 1) * 1000));
          continue;
        }
        if (attempt === 4) throw err;
        await new Promise((r) => setTimeout(r, 1200 * attempt));
      }
    }
    if (i < parts.length - 1) await new Promise((r) => setTimeout(r, 1200));
  }
  log(`  已发送 ${sent} 条 Telegram 消息`);
  return sent;
}
