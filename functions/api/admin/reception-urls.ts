/**
 * 当日受付の、日ごとの URL（QR コードにするもの）を返す（神社の方だけ）。
 * 掲示用の QR コードのページ（/admin/reception-qr/）が使う。
 *
 *   GET /api/admin/reception-urls
 *
 * URL の記号は src/lib/reception-key.ts で、環境変数 RECEPTION_SECRET から計算する。
 * 本番（www）と印刷用のページ（admin）の両方に、同じ RECEPTION_SECRET を入れておくこと。
 * RECEPTION_ALWAYS_OPEN=1 のとき（試し）は、今日の URL も返す（そのページのドメインのもの）。
 */

import { accessUser, type AccessEnv } from '../../../src/lib/access';
import { RECEPTION_WINDOWS, dateLabel, jstNow } from '../../../src/lib/reservation';
import { receptionKey } from '../../../src/lib/reception-key';

interface Env extends AccessEnv {
  RECEPTION_SECRET?: string;
  RECEPTION_ALWAYS_OPEN?: string;
}

/** 参拝の方が開く本番のサイト */
const SITE = 'https://www.takaminejinja.jp';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!(await accessUser(request, env))) return json({ ok: false, error: 'ログインが必要です。' }, 403);
  if (!env.RECEPTION_SECRET) return json({ ok: false, error: '環境変数 RECEPTION_SECRET が設定されていません。' }, 500);

  const days = await Promise.all(
    RECEPTION_WINDOWS.map(async (w) => ({
      ...w,
      label: dateLabel(w.date),
      url: `${SITE}/reception/?k=${await receptionKey(env.RECEPTION_SECRET!, w.date)}`,
    })),
  );
  const today = jstNow().date;
  const test =
    env.RECEPTION_ALWAYS_OPEN === '1'
      ? {
          date: today,
          label: dateLabel(today),
          url: `${new URL(request.url).origin}/reception/?k=${await receptionKey(env.RECEPTION_SECRET, today)}`,
        }
      : null;
  return json({ ok: true, days, test });
};
