/**
 * 予約の確認・変更・キャンセル用のリンクに入れる記号（例: /reservation/manage/?no=W000121&k=7F3K2Q9A9XHB）。
 *
 * 神社だけが知っている元の値（環境変数 MANAGE_SECRET。なければ RECEPTION_SECRET）と予約番号から計算する。
 * 予約番号だけを知っていても記号は作れないので、リンクを受け取った方（メールの宛先）だけがその予約を見たり変えたりできる。
 */

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export interface ManageEnv {
  MANAGE_SECRET?: string;
  RECEPTION_SECRET?: string;
}

const secretOf = (env: ManageEnv) => env.MANAGE_SECRET || env.RECEPTION_SECRET || '';

/** その予約番号の記号（12文字）。元の値が設定されていなければ空 */
export async function manageKey(env: ManageEnv, no: string): Promise<string> {
  const secret = secretOf(env);
  if (!secret || !no) return '';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`manage:${no}`)));
  return [...sig.slice(0, 12)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** 送られてきた記号が、その予約番号のものか */
export async function isManageKey(env: ManageEnv, no: string, k: string): Promise<boolean> {
  if (!/^[A-Z0-9]{12}$/i.test(k)) return false;
  const want = await manageKey(env, no);
  return !!want && want === k.toUpperCase();
}

/** 予約の確認・変更・キャンセル用のリンク */
export async function manageUrl(env: ManageEnv, origin: string, no: string): Promise<string> {
  const k = await manageKey(env, no);
  return k ? `${origin}/reservation/manage/?${new URLSearchParams({ no, k })}` : '';
}
