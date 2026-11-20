/**
 * 申込書を PDF にして、プリンター（エプソンのメールプリント）へメールで送る。当日受付で使う。
 *
 * 1. 申込書の HTML（src/lib/sheet-html.ts）を、Cloudflare の Browser Rendering で PDF にする
 * 2. その PDF を、メール送信サービス Resend で、プリンターのメールアドレスへ添付して送る
 *
 * 必要な環境変数:
 *   CF_ACCOUNT_ID      Cloudflare のアカウント ID
 *   CF_BROWSER_TOKEN   Browser Rendering を使える API トークン（「Browser Rendering - Edit」の権限）
 *   RESEND_API_KEY     Resend の API キー
 *   PRINT_EMAIL_FROM   送り主（Resend で確認済みのドメインのアドレス。例: print@takaminejinja.jp）
 *   PRINT_EMAIL_TO     プリンターのメールアドレス（エプソンのメールプリント用）
 */

export interface PrinterEnv {
  CF_ACCOUNT_ID?: string;
  CF_BROWSER_TOKEN?: string;
  RESEND_API_KEY?: string;
  PRINT_EMAIL_FROM?: string;
  PRINT_EMAIL_TO?: string;
  /** テスト用（本物の API の代わり） */
  CF_API_URL?: string;
  RESEND_API_URL?: string;
}

const KEYS = ['CF_ACCOUNT_ID', 'CF_BROWSER_TOKEN', 'RESEND_API_KEY', 'PRINT_EMAIL_FROM', 'PRINT_EMAIL_TO'] as const;

/** 設定が足りない項目の名前（値は返さない） */
export const missingPrinterSettings = (env: PrinterEnv) => KEYS.filter((k) => !env[k]);

export class PrintError extends Error {
  constructor(public step: 'pdf' | 'mail', message: string) {
    super(message);
  }
}

/** HTML を PDF にする（用紙の大きさは HTML の @page のとおり＝B6） */
export async function htmlToPdf(env: PrinterEnv, html: string): Promise<ArrayBuffer> {
  const api = env.CF_API_URL || 'https://api.cloudflare.com/client/v4';
  const res = await fetch(`${api}/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/pdf`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CF_BROWSER_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      html,
      // 日本語のフォントを読み込み終わってから PDF にする
      gotoOptions: { waitUntil: 'networkidle0', timeout: 30000 },
      pdfOptions: { preferCSSPageSize: true, printBackground: true },
    }),
  });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('pdf')) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new PrintError('pdf', `PDF を作れませんでした（${res.status}）${text}`);
  }
  return res.arrayBuffer();
}

const base64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** PDF をプリンターのメールアドレスへ送る */
export async function mailToPrinter(env: PrinterEnv, pdf: ArrayBuffer, filename: string, subject: string) {
  const api = env.RESEND_API_URL || 'https://api.resend.com';
  const res = await fetch(`${api}/emails`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.PRINT_EMAIL_FROM,
      to: [env.PRINT_EMAIL_TO],
      subject,
      text: subject,
      attachments: [{ filename, content: base64(pdf) }],
    }),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new PrintError('mail', `プリンターへ送れませんでした（${res.status}）${text}`);
  }
}
