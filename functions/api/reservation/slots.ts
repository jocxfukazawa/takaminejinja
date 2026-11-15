/**
 * 予約できる日時の一覧を返す（予約フォームが読み込む）。
 * 埋まっているかどうかだけを返し、予約の中身は返さない。
 */

import { availability } from '../../../src/lib/reservation';
import { AirtableError, closures, missingSettings, takenSlots, type AirtableEnv } from '../../../src/lib/airtable';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export const onRequestGet: PagesFunction<AirtableEnv> = async ({ env }) => {
  // うまくいかないときは、原因の種類だけを返す（予約の中身や設定の値は返さない）
  const missing = missingSettings(env);
  if (missing.length) {
    console.error('reservation/slots: 環境変数が設定されていません', missing);
    return json({ ok: false, reason: 'missing-settings', missing }, 500);
  }
  let step = '予約の表';
  try {
    const taken = await takenSlots(env);
    step = '受付停止日の表';
    const closed = await closures(env);
    return json({ ok: true, dates: availability(taken, closed) });
  } catch (e) {
    console.error(`reservation/slots: ${step}の読み込みに失敗`, e);
    const detail = e instanceof AirtableError
      ? { status: e.status, type: e.type, message: e.message.replace(/^Airtable \d+ \S+: /, '').slice(0, 200) }
      : { type: 'NETWORK' };
    return json({ ok: false, reason: 'airtable', step, ...detail }, 502);
  }
};
