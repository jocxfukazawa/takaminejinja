/**
 * Cloudflare Access（Cloudflare のログイン）を通ってきたリクエストかを確かめる。
 * 神社の方だけが使うページ（申込書の印刷など）のデータを返す前に使う。
 *
 * Access を通ると、リクエストに署名つきの「Cf-Access-Jwt-Assertion」が付く。
 * ヘッダーがあるだけでは信用せず、Cloudflare の公開鍵で署名を確かめ、宛先（AUD）と有効期限も確かめる。
 *
 * 必要な環境変数:
 *   ACCESS_TEAM_DOMAIN  例: takaminejinja-pages.cloudflareaccess.com
 *   ACCESS_AUD          Access のアプリケーションの「AUD タグ」。複数あるときはカンマ区切り
 */

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

/** ログインしているメールアドレス（確かめられなければ null） */
export async function accessUser(request: Request, env: AccessEnv, now = Date.now()): Promise<string | null> {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  const team = env.ACCESS_TEAM_DOMAIN;
  const auds = (env.ACCESS_AUD ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  if (!token || !team || !auds.length) return null;
  try {
    const [h, p, sig] = token.split('.');
    const header = json(h) as { kid?: string; alg?: string };
    const payload = json(p) as { aud?: string | string[]; exp?: number; iss?: string; email?: string };
    if (header.alg !== 'RS256') return null;

    const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
    const { keys } = (await res.json()) as { keys: (JsonWebKey & { kid?: string })[] };
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;

    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.some((a) => a && auds.includes(a))) return null;
    if (!payload.exp || payload.exp * 1000 < now) return null;
    if (payload.iss !== `https://${team}`) return null;
    return payload.email ?? '';
  } catch {
    return null;
  }
}
