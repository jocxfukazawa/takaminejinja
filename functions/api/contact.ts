/**
 * お問い合わせフォームの送信先（Cloudflare Pages Functions）
 *
 * 1. Turnstile でボット判定
 * 2. 社務所へ通知メールを送信
 * 3. お客様へ控え（自動返信）メールを送信
 *
 * メール送信には Resend (https://resend.com) の API を使う。
 * 必要な環境変数（Cloudflare Pages の「設定 → 変数とシークレット」で設定）:
 *   TURNSTILE_SECRET_KEY  Turnstile のシークレットキー
 *   RESEND_API_KEY        Resend の API キー
 *   MAIL_TO               お問い合わせの受信先（社務所のメールアドレス）
 *   MAIL_FROM             送信元（例: 高嶺神社 <noreply@takaminejinja.jp>）。Resend で認証済みのドメインであること
 */

interface Env {
  TURNSTILE_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
  MAIL_TO?: string;
  MAIL_FROM?: string;
}

const FIELDS = [
  { name: 'your-name', label: 'お名前', required: true },
  { name: 'kana-name', label: 'ふりがな', required: true },
  { name: 'your-email', label: 'メールアドレス', required: true },
  { name: 'address', label: 'ご住所', required: false },
  { name: 'tel', label: '電話番号', required: false },
  { name: 'subject', label: '件名', required: true },
  { name: 'goshuin-amulet', label: '御朱印・御守りの予約', required: false },
  { name: 'your-message', label: 'お問い合わせ内容', required: true },
] as const;

const MAX_LENGTH: Record<string, number> = { 'your-message': 2000 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

async function verifyTurnstile(token: string, secret: string, ip: string | null) {
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const data = (await res.json()) as { success: boolean };
    return data.success;
  } catch (e) {
    console.error('contact: Turnstile の検証に失敗', e);
    return false;
  }
}

async function sendMail(env: Env, mail: { to: string; subject: string; text: string; replyTo?: string }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.TURNSTILE_SECRET_KEY || !env.RESEND_API_KEY || !env.MAIL_TO || !env.MAIL_FROM) {
    console.error('contact: 環境変数が設定されていません');
    return json({ ok: false, error: 'ただいまフォームをご利用いただけません。お電話でお問い合わせください。' }, 500);
  }

  const form = await request.formData();

  // 人には見えない項目に入力があればボットとみなし、成功したふりをする
  if (String(form.get('website') ?? '')) return json({ ok: true });

  const token = String(form.get('cf-turnstile-response') ?? '');
  if (!token || !(await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, request.headers.get('CF-Connecting-IP')))) {
    return json({ ok: false, error: '認証に失敗しました。ページを再読み込みして、もう一度お試しください。' }, 400);
  }

  const values: Record<string, string> = {};
  for (const f of FIELDS) {
    const value = form
      .getAll(f.name)
      .map((v) => String(v).trim())
      .filter(Boolean)
      .join('、');
    if (f.required && !value) return json({ ok: false, error: `「${f.label}」は必須です。` }, 400);
    if (value.length > (MAX_LENGTH[f.name] ?? 400)) {
      return json({ ok: false, error: `「${f.label}」が長すぎます。` }, 400);
    }
    values[f.name] = value;
  }
  if (!EMAIL_RE.test(values['your-email'])) {
    return json({ ok: false, error: 'メールアドレスの形式が正しくありません。' }, 400);
  }

  const summary = FIELDS.map((f) => `■${f.label}\n${values[f.name] || '（未入力）'}`).join('\n\n');

  try {
    await sendMail(env, {
      to: env.MAIL_TO,
      subject: `【高嶺神社】お問い合わせ：${values.subject}`,
      replyTo: values['your-email'],
      text: `ホームページのお問い合わせフォームから送信がありました。\n\n${summary}\n`,
    });
  } catch (e) {
    console.error('contact: 通知メールの送信に失敗', e);
    return json({ ok: false, error: '送信に失敗しました。時間をおいて再度お試しいただくか、お電話でお問い合わせください。' }, 502);
  }

  try {
    await sendMail(env, {
      to: values['your-email'],
      subject: '【高嶺神社】お問い合わせありがとうございます',
      text:
        `${values['your-name']} 様\n\n` +
        'この度は高嶺神社へお問い合わせいただき、誠にありがとうございます。\n' +
        '以下の内容で承りました。改めて担当者よりご連絡させていただきます。\n\n' +
        `${summary}\n\n` +
        '──────────────────\n' +
        '【幸せを運ぶ宮】高嶺神社\n' +
        '〒678-1241 兵庫県赤穂郡上郡町山野里2745\n' +
        'TEL. 0791-52-6464（つながらない場合は0791-52-0666）\n' +
        'https://www.takaminejinja.jp/\n',
    });
  } catch (e) {
    // 社務所には届いているので、控えの失敗はお客様にはエラーとしない
    console.error('contact: 控えメールの送信に失敗', e);
  }

  return json({ ok: true });
};
