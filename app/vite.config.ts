import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

function isEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function readJsonBody(req: import('http').IncomingMessage) {
  return new Promise<any>((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('リクエストが大きすぎます。'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('JSONの形式が正しくありません。'));
      }
    });
    req.on('error', reject);
  });
}

function buildHtml(title: string, payload: Record<string, string>) {
  const rows = Object.entries(payload)
    .map(([key, value]) => `<tr><th style="text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid #eee;white-space:nowrap;">${escapeHtml(key)}</th><td style="padding:8px;border-bottom:1px solid #eee;white-space:pre-wrap;">${escapeHtml(value || '未入力')}</td></tr>`)
    .join('');
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#111;"><h2 style="margin:0 0 16px;">家系行脚：${escapeHtml(title)}</h2><p>WEBアプリから問い合わせ・情報提供が送信されました。</p><table style="border-collapse:collapse;width:100%;max-width:720px;">${rows}</table></div>`;
}

function localSendMailApi(): Plugin {
  return {
    name: 'local-send-mail-api',
    configureServer(server) {
      const env = loadEnv('', process.cwd(), '');
      server.middlewares.use('/api/send-mail', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: 'POSTのみ対応しています。' }));
          return;
        }

        try {
          const body = await readJsonBody(req);
          const title = String(body?.title || body?.subject || '問い合わせ').slice(0, 80);
          const payload = Object.fromEntries(
            Object.entries(body?.payload || (body?.html ? { 内容: body.html } : {})).map(([key, value]) => [String(key), typeof value === 'string' ? value : String(value ?? '')])
          ) as Record<string, string>;
          const bodyText = Object.values(payload).join('\n');
          if (!bodyText.trim()) throw new Error('送信内容が空です。');
          if (bodyText.length > 5000) throw new Error('本文が長すぎます。');

          const toEmail = env.CONTACT_TO_EMAIL;
          const ccEmail = env.CONTACT_CC_EMAIL;
          const fromEmail = env.MAIL_FROM;
          const apiKey = env.BREVO_API_KEY;

          if (!apiKey) throw new Error('BREVO_API_KEY が .env.local にありません。');
          if (!isEmail(fromEmail)) throw new Error('MAIL_FROM が .env.local に正しく設定されていません。');
          if (!isEmail(toEmail)) throw new Error('CONTACT_TO_EMAIL が .env.local に正しく設定されていません。');

          const brevoBody = {
            sender: { email: fromEmail, name: env.MAIL_FROM_NAME || '家系ラーメン運営' },
            to: [{ email: toEmail }],
            subject: `【家系行脚】${title}`,
            htmlContent: buildHtml(title, payload),
            textContent: Object.entries(payload).map(([key, value]) => `${key}: ${value || '未入力'}`).join('\n'),
            replyTo: isEmail(payload['送信者']) ? { email: payload['送信者'] } : undefined,
            cc: isEmail(ccEmail) ? [{ email: ccEmail }] : undefined,
          };

          console.log('[local-send-mail-api] Brevo送信開始', { toEmail, fromEmail, title });

          const brevoResponse = await fetch(BREVO_API_URL, {
            method: 'POST',
            headers: { accept: 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
            body: JSON.stringify(brevoBody),
          });

          const responseText = await brevoResponse.text().catch(() => '');
          let responseBody: any = {};
          try {
            responseBody = responseText ? JSON.parse(responseText) : {};
          } catch {
            responseBody = { raw: responseText };
          }

          if (!brevoResponse.ok) {
            console.error('[local-send-mail-api] Brevo送信失敗', { status: brevoResponse.status, responseBody });
            throw new Error(`Brevo送信エラー: ${brevoResponse.status} ${responseText}`);
          }

          console.log('[local-send-mail-api] Brevo送信成功', responseBody);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, provider: 'brevo', messageId: responseBody?.messageId || null }));
        } catch (error) {
          console.error('[local-send-mail-api] APIエラー', error);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'メール送信に失敗しました。' }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localSendMailApi()],
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
