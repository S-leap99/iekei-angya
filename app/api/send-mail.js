const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [String(key), typeof value === 'string' ? value : String(value ?? '')])
  );
}

function buildHtml(title, payload) {
  const rows = Object.entries(payload)
    .map(([key, value]) => `<tr><th style="text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid #eee;white-space:nowrap;">${escapeHtml(key)}</th><td style="padding:8px;border-bottom:1px solid #eee;white-space:pre-wrap;">${escapeHtml(value || '未入力')}</td></tr>`)
    .join('');

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#111;">
      <h2 style="margin:0 0 16px;">家系行脚：${escapeHtml(title)}</h2>
      <p>WEBアプリから問い合わせ・情報提供が送信されました。</p>
      <table style="border-collapse:collapse;width:100%;max-width:720px;">${rows}</table>
    </div>
  `;
}

async function sendBrevoMail({ toEmail, ccEmail, title, payload }) {
  const apiKey = process.env.BREVO_API_KEY;
  const fromEmail = process.env.MAIL_FROM;
  const fromName = process.env.MAIL_FROM_NAME || '家系ラーメン運営';

  if (!apiKey) throw new Error('BREVO_API_KEY が設定されていません。');
  if (!isEmail(fromEmail)) throw new Error('MAIL_FROM が正しく設定されていません。');
  if (!isEmail(toEmail)) throw new Error('CONTACT_TO_EMAIL が正しく設定されていません。');

  const body = {
    sender: { email: fromEmail, name: fromName },
    to: [{ email: toEmail }],
    subject: `【家系行脚】${title}`,
    htmlContent: buildHtml(title, payload),
    textContent: Object.entries(payload).map(([key, value]) => `${key}: ${value || '未入力'}`).join('\n'),
    replyTo: isEmail(payload['送信者']) ? { email: payload['送信者'] } : undefined,
    cc: isEmail(ccEmail) ? [{ email: ccEmail }] : undefined,
  };

  console.log('[send-mail] Brevo送信開始', { toEmail, fromEmail, title });

  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text().catch(() => '');
  let responseBody = {};
  try {
    responseBody = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseBody = { raw: responseText };
  }

  if (!response.ok) {
    console.error('[send-mail] Brevo送信失敗', { status: response.status, responseBody });
    throw new Error(`Brevo送信エラー: ${response.status} ${responseText}`);
  }

  console.log('[send-mail] Brevo送信成功', responseBody);
  return responseBody;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'POSTのみ対応しています。' });
  }

  try {
    const title = String(req.body?.title || req.body?.subject || '問い合わせ').slice(0, 80);
    const payload = normalizePayload(req.body?.payload || (req.body?.html ? { 内容: req.body.html } : {}));

    const bodyText = Object.values(payload).join('\n');
    if (!bodyText.trim()) return res.status(400).json({ ok: false, error: '送信内容が空です。' });
    if (bodyText.length > 5000) return res.status(400).json({ ok: false, error: '本文が長すぎます。' });

    // 宛先はサーバー側の環境変数のみを使います。フロントから宛先を渡さないことで、運営メールを隠します。
    const toEmail = process.env.CONTACT_TO_EMAIL;
    const ccEmail = process.env.CONTACT_CC_EMAIL;

    const brevoResult = await sendBrevoMail({ toEmail, ccEmail, title, payload });
    return res.status(200).json({ ok: true, provider: 'brevo', messageId: brevoResult?.messageId || null });
  } catch (error) {
    console.error('[send-mail] APIエラー', error);
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'メール送信に失敗しました。' });
  }
}
