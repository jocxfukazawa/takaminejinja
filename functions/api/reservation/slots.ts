/**
 * 予約できる日時の一覧を返す（予約フォームが読み込む）。
 * 埋まっているかどうかだけを返し、予約の中身は返さない。
 */

import { availability } from '../../../src/lib/reservation';
import { closures, isConfigured, takenSlots, type AirtableEnv } from '../../../src/lib/airtable';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export const onRequestGet: PagesFunction<AirtableEnv> = async ({ env }) => {
  if (!isConfigured(env)) {
    console.error('reservation/slots: 環境変数が設定されていません');
    return json({ ok: false }, 500);
  }
  try {
    const [taken, closed] = await Promise.all([takenSlots(env), closures(env)]);
    return json({ ok: true, dates: availability(taken, closed) });
  } catch (e) {
    console.error('reservation/slots: Airtable の読み込みに失敗', e);
    return json({ ok: false }, 502);
  }
};
