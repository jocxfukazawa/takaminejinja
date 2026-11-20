/**
 * 当日受付の URL に入れる「その日だけの記号」（例: /reception/?k=7F3K2Q9A）。
 *
 * 神社だけが知っている元の値（環境変数 RECEPTION_SECRET）と日付から計算する。
 * 日付が違えば記号も変わるので、9日の QR コードは9日にしか使えない（写真に撮られても翌日には使えない）。
 * 外からは元の値が分からないので、ほかの日の記号を推測できない。
 */

/** 読み間違えにくい文字だけを使う（0/O、1/I/L などを除く） */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** その日（2027-01-09）の記号（8文字） */
export async function receptionKey(secret: string, date: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`reception:${date}`)));
  return [...sig.slice(0, 8)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** 送られてきた記号が、その日のものか */
export async function isReceptionKey(secret: string | undefined, date: string, k: string): Promise<boolean> {
  if (!secret || !/^[A-Z0-9]{8}$/i.test(k)) return false;
  return (await receptionKey(secret, date)) === k.toUpperCase();
}
