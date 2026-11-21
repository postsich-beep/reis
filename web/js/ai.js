// Виклик Claude API. Ключ вводить водій у налаштуваннях; зберігається лише на цьому телефоні.
import { S } from './core.js';
import { http } from './platform.js';

export const hasKey = () => !!(S.apiKey && S.apiKey.trim().length > 20);

export async function askClaude({ system, messages, model, maxTokens = 700, timeout = 45000 }) {
  if (!hasKey()) { const e = new Error('nokey'); e.code = 'nokey'; throw e; }
  const r = await http('https://api.anthropic.com/v1/messages', {
    method: 'POST', viaNative: true, timeout,
    headers: {
      'content-type': 'application/json', 'x-api-key': S.apiKey.trim(), 'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'          // потрібен лише в браузерній версії
    },
    body: JSON.stringify({ model: model || S.model, max_tokens: maxTokens, system, messages })
  });
  let j = null; try { j = JSON.parse(r.text); } catch (_) {}
  if (r.status !== 200 || !j) {
    const e = new Error((j && j.error && j.error.message) || ('HTTP ' + r.status)); e.status = r.status; throw e;
  }
  return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
}
