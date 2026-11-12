/**
 * 巫女・舞姫の応募フォームの送信先（Cloudflare Pages Functions）
 *
 * お問い合わせフォーム（contact.ts）と同じ仕組みで、
 * Turnstile でボット判定 → 社務所へ通知 → 応募者へ控えを送る。
 * 環境変数も contact.ts と共通（TURNSTILE_SECRET_KEY / RESEND_API_KEY / MAIL_TO / MAIL_FROM）。
 */

interface Env {
  TURNSTILE_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
  MAIL_TO?: string;
  MAIL_FROM?: string;
}

interface Field {
  name: string;
  label: string;
  required?: boolean;
  /** 複数選択（チェックボックス） */
  multiple?: boolean;
  /** 選べる値（これ以外は受け付けない） */
  options?: readonly string[];
  max?: number;
}

const MIKO_GRADES = ['高校生', '大学生・専門学校生', '社会人', 'その他'] as const;
const MIKO_DAYS = ['正月（12月31日〜1月3日）', '黒星（厄除け）祈願祭', '春祭り', '夏祭り', '秋祭り'] as const;
const MAIHIME_GRADES = ['小学4年生', '小学5年生', '小学6年生', '中学1年生', '中学2年生', '中学3年生'] as const;

const FORMS = {
  miko: {
    title: '巫女の登録希望',
    nameField: 'your-name',
    fields: [
      { name: 'your-name', label: 'お名前', required: true },
      { name: 'kana-name', label: 'ふりがな', required: true },
      { name: 'age', label: 'ご年齢', required: true, max: 3 },
      { name: 'status', label: 'ご職業', required: true, options: MIKO_GRADES },
      { name: 'school', label: '学校名・学年', max: 100 },
      { name: 'consent', label: '保護者の同意・学校の許可', options: ['保護者の同意と学校の許可を得ています（または得る予定です）'] },
      { name: 'workplace', label: 'お勤め先', max: 100 },
      { name: 'work-permission', label: '勤務先の許可', options: ['勤務先の許可を得ています（または得る予定です）'] },
      { name: 'your-email', label: 'メールアドレス', required: true },
      { name: 'tel', label: '電話番号', required: true },
      { name: 'address', label: 'ご住所', required: true },
      { name: 'days', label: 'ご奉仕できそうなお祭り', required: true, multiple: true, options: MIKO_DAYS },
      { name: 'experience', label: '巫女のご経験', options: ['あり', 'なし'] },
      { name: 'agree', label: '募集内容の確認', required: true, options: ['募集内容を確認しました'] },
      { name: 'your-message', label: 'ご質問など', max: 2000 },
    ] as Field[],
  },
  maihime: {
    title: '舞姫の応募',
    nameField: 'child-name',
    fields: [
      { name: 'your-name', label: '保護者のお名前', required: true },
      { name: 'kana-name', label: '保護者のお名前（ふりがな）', required: true },
      { name: 'child-name', label: 'お子さまのお名前', required: true },
      { name: 'child-kana', label: 'お子さまのお名前（ふりがな）', required: true },
      { name: 'grade', label: 'お子さまの学年', required: true, options: MAIHIME_GRADES },
      { name: 'school', label: '学校名', max: 100 },
      { name: 'your-email', label: 'メールアドレス', required: true },
      { name: 'tel', label: '電話番号', required: true },
      { name: 'address', label: 'ご住所', required: true },
      {
        name: 'agree',
        label: '確認事項',
        required: true,
        multiple: true,
        options: ['1年を通して4つのお祭りでご奉仕できます', '練習日の神社までの送り迎えができます'],
      },
      { name: 'your-message', label: 'ご質問など', max: 2000 },
    ] as Field[],
  },
} as const;

type FormType = keyof typeof FORMS;

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
    console.error('apply: Turnstile の検証に失敗', e);
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
    console.error('apply: 環境変数が設定されていません');
    return json({ ok: false, error: 'ただいまフォームをご利用いただけません。お電話でお申し込みください。' }, 500);
  }

  const form = await request.formData();

  // 人には見えない項目に入力があればボットとみなし、成功したふりをする
  if (String(form.get('website') ?? '')) return json({ ok: true });

  const type = String(form.get('form-type') ?? '') as FormType;
  const def = FORMS[type];
  if (!def) return json({ ok: false, error: 'フォームの種類が正しくありません。' }, 400);

  const token = String(form.get('cf-turnstile-response') ?? '');
  if (!token || !(await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, request.headers.get('CF-Connecting-IP')))) {
    return json({ ok: false, error: '認証に失敗しました。ページを再読み込みして、もう一度お試しください。' }, 400);
  }

  const values: Record<string, string> = {};
  for (const f of def.fields) {
    const list = form
      .getAll(f.name)
      .map((v) => String(v).trim())
      .filter(Boolean);
    if (f.options && list.some((v) => !f.options!.includes(v))) {
      return json({ ok: false, error: `「${f.label}」の選択が正しくありません。` }, 400);
    }
    // 確認事項（複数）はすべてにチェックが必要
    if (f.name === 'agree' && f.options && list.length !== f.options.length) {
      return json({ ok: false, error: `「${f.label}」をすべてご確認ください。` }, 400);
    }
    const value = list.join('、');
    if (f.required && !value) return json({ ok: false, error: `「${f.label}」は必須です。` }, 400);
    if (value.length > (f.max ?? 400)) return json({ ok: false, error: `「${f.label}」が長すぎます。` }, 400);
    values[f.name] = value;
  }
  if (!EMAIL_RE.test(values['your-email'])) {
    return json({ ok: false, error: 'メールアドレスの形式が正しくありません。' }, 400);
  }
  if (type === 'miko' && values.status === '高校生' && !values.consent) {
    return json({ ok: false, error: '高校生の方は、保護者の方の同意と学校の許可が必要です。' }, 400);
  }
  if (type === 'miko' && values.status === '社会人' && (!values.workplace || !values['work-permission'])) {
    return json({ ok: false, error: 'お勤めの方は、お勤め先のご記入と、勤務先の許可の確認が必要です。' }, 400);
  }

  const summary = def.fields
    .filter((f) => f.name !== 'consent' || values.status === '高校生')
    .filter((f) => !['workplace', 'work-permission'].includes(f.name) || values.status === '社会人')
    .map((f) => `■${f.label}\n${values[f.name] || '（未入力）'}`)
    .join('\n\n');

  try {
    await sendMail(env, {
      to: env.MAIL_TO,
      subject: `【高嶺神社】${def.title}：${values[def.nameField]} 様`,
      replyTo: values['your-email'],
      text: `ホームページの応募フォームから「${def.title}」がありました。\n\n${summary}\n`,
    });
  } catch (e) {
    console.error('apply: 通知メールの送信に失敗', e);
    return json({ ok: false, error: '送信に失敗しました。時間をおいて再度お試しいただくか、お電話でお申し込みください。' }, 502);
  }

  try {
    await sendMail(env, {
      to: values['your-email'],
      subject: '【高嶺神社】ご応募ありがとうございます',
      text:
        `${values['your-name']} 様\n\n` +
        'この度は高嶺神社の募集にお申し込みいただき、誠にありがとうございます。\n' +
        '以下の内容で承りました。改めて神社よりご連絡させていただきます。\n\n' +
        `${summary}\n\n` +
        '──────────────────\n' +
        '【幸せを運ぶ宮】高嶺神社\n' +
        '〒678-1241 兵庫県赤穂郡上郡町山野里2745\n' +
        'TEL. 0791-52-6464（つながらない場合は0791-52-0666）\n' +
        'https://www.takaminejinja.jp/\n',
    });
  } catch (e) {
    // 社務所には届いているので、控えの失敗は応募者にはエラーとしない
    console.error('apply: 控えメールの送信に失敗', e);
  }

  return json({ ok: true });
};
