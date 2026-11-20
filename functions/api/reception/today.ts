/**
 * 当日受付のページ（/reception/）が開いたときに、今日の受付の様子を返す。
 *
 *   GET /api/reception/today?k=その日だけの記号
 *
 * 記号が今日のものでなければ 403。今日のものなら、受付中かどうか、受付時間、行事の名前を返す。
 * 行事の名前は「当日受付の日」の表に入っていれば出す（空ならページに出さない）。
 */

import { receptionDays, type AirtableEnv } from '../../../src/lib/airtable';
import { dateLabel, jstNow, receptionWindow } from '../../../src/lib/reservation';
import { isReceptionKey } from '../../../src/lib/reception-key';

interface Env extends AirtableEnv {
  RECEPTION_SECRET?: string;
  RECEPTION_ALWAYS_OPEN?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const today = jstNow().date;
  const k = new URL(request.url).searchParams.get('k') ?? '';
  if (!(await isReceptionKey(env.RECEPTION_SECRET, today, k))) {
    return json({ ok: false, error: 'このページは、神社に掲示している今日の QR コードから開いてください。' }, 403);
  }
  try {
    const days = await receptionDays(env);
    const day = receptionWindow(days) ?? days.find((d) => d.date === today) ?? null;
    const open = !!receptionWindow(days) || env.RECEPTION_ALWAYS_OPEN === '1';
    return json({ ok: true, open, date: today, label: dateLabel(today), from: day?.from ?? '', to: day?.to ?? '', event: day?.event ?? '' });
  } catch (e) {
    console.error('reception/today: 当日受付の日を読み込めなかった', e);
    return json({ ok: false, error: 'ただいま受付できません。社務所の受付でお申し込みください。' }, 502);
  }
};
