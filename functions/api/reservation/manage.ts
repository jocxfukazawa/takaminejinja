/**
 * 予約の確認・変更・キャンセル（予約された方が、メールのリンクから使う。/reservation/manage/）
 *
 *   GET  /api/reservation/manage?no=W000121&k=…   予約の内容と、変更・キャンセルできるか
 *   POST /api/reservation/manage  { no, k, action: 'cancel' }                    予約全体をキャンセル
 *   POST /api/reservation/manage  { no, k, action: 'change', date, time? }       日時（事前申込は日にち）を変える
 *
 * k は予約番号から計算した記号（src/lib/manage-key.ts）。リンクを受け取った方だけが使える。
 * 期限：御祈祷の2時間前まで（時刻のない事前申込は、ご来社予定日の前日まで）。過ぎたらお電話で。
 * キャンセル：代表の方の行だけを「キャンセル」にする（ご家族の行は「家族のステータス同期（キャンセル）」がそろえ、
 *   メールとカレンダーは「予約キャンセル」のオートメーションが代表の方の行で1回だけ動く）。
 * 日時の変更：ご家族全員の行の日時を変え、Web の予約は「仮予約」に戻す（神社で確かめて改めて予約確定にする）。
 *   事前申込は日にちだけを変え、「事前申込」のまま。変更前の日時は「変更前の御祈祷日」「変更前の御祈祷時刻」に残す。
 *   代表の方の行の「変更受付日時」に変えた日時を入れる（Airtable の「予約の日時変更（Web）」がこれを見て、ご本人にメールを送る）。
 * どちらも、代表の方の行の「予約の詳細」のいちばん上に書き足す。
 * 神社やご本人へのメールは、Airtable のオートメーション（「予約キャンセル」「予約の日時変更（Web）」）が送る。
 */

import {
  AirtableError, F, closures, isConfigured, listRows, takenSlots, updateRecords, type AirtableEnv,
} from '../../../src/lib/airtable';
import { isManageKey, type ManageEnv } from '../../../src/lib/manage-key';
import { PHONE, SLOT_TIMES, advanceDates, bookableDates, dateLabel, isClosed, storedDate } from '../../../src/lib/reservation';

type Env = AirtableEnv & ManageEnv;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
const fail = (error: string, status = 400, extra: Record<string, unknown> = {}) => json({ ok: false, error, ...extra }, status);

const PHONE_NOTE = `お手数ですが、お電話（${PHONE}）でご連絡ください。`;
const CLOSED = ['キャンセル', '登録完了'];
const DEADLINE_MS = 2 * 60 * 60 * 1000;

const str = (v: unknown) => (Array.isArray(v) ? v.join('、') : v == null ? '' : String(v)).trim();
/** 「2026/11/23 (月)」などを '2026-11-23' に */
const dateKey = (v: unknown) => {
  const m = str(v).match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
};
const timeKey = (v: unknown) => {
  const m = str(v).match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
};
/** 日本時間の日時を、その瞬間の時刻（ミリ秒）に */
const jstMs = (date: string, time = '00:00') => {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh - 9, mm);
};
const nowLabel = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ').replace(/-/g, '/');

/** その予約（予約グループ）の行と、今の様子 */
async function load(env: Env, no: string) {
  const rows = await listRows(env, {
    filterByFormula: `OR({予約番号} = '${no}', {予約グループ} = '${no}')`,
    'fields[]': ['予約番号', '予約グループ', '代表者', '名前', '御祈祷内容', F.status, '受付経路', F.date, F.time, F.method, '予約の詳細'],
  });
  const rep = rows.find((r) => r.fields['予約番号'] === no) ?? rows.find((r) => r.fields['代表者']) ?? rows[0];
  if (!rep) return null;
  const members = rows.filter((r) => str(r.fields['予約グループ']) === no || r.id === rep.id);
  const f = rep.fields;
  const status = str(f[F.status]);
  const route = str(f['受付経路']);
  const method = str(f[F.method]);
  const date = dateKey(f[F.date]);
  const time = timeKey(f[F.time]);
  // 期限：時刻があればその2時間前、時刻がなければ（事前申込）その日の0時（＝前日まで）。郵送など日付がなければ期限なし
  const deadline = date ? jstMs(date, time || '00:00') - (time ? DEADLINE_MS : 0) : Infinity;
  const open = !CLOSED.includes(status) && Date.now() < deadline;
  let reason = '';
  if (status === 'キャンセル') reason = 'この予約は、キャンセルされています。';
  else if (status === '登録完了') reason = 'この予約のご祈祷は終わっています。';
  else if (!open) reason = `変更・キャンセルの期限（${time ? 'ご祈祷の2時間前' : 'ご来社予定日の前日'}）を過ぎました。${PHONE_NOTE}`;
  const canChange = open && method === '来社' && ['Webフォーム', '事前申込'].includes(route);
  return { rows, members, rep, status, route, method, date, time, open, canCancel: open, canChange, reason };
}

const summary = (r: NonNullable<Awaited<ReturnType<typeof load>>>, no: string) => ({
  no,
  status: r.status,
  route: r.route,
  method: r.method,
  advance: r.route === '事前申込',
  date: r.date,
  dateLabel: r.date ? dateLabel(r.date) : '',
  time: r.time,
  people: r.members
    .filter((m) => str(m.fields[F.status]) !== 'キャンセル' || r.status === 'キャンセル')
    .map((m) => ({ name: str(m.fields['名前']), prayers: Array.isArray(m.fields['御祈祷内容']) ? m.fields['御祈祷内容'] : [str(m.fields['御祈祷内容'])].filter(Boolean) })),
  canCancel: r.canCancel,
  canChange: r.canChange,
  reason: r.reason,
});

const check = async (env: Env, no: string, k: string) => {
  if (!/^W\d{6}$/.test(no) || !(await isManageKey(env, no, k))) return null;
  return true;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!isConfigured(env)) return fail('ただいま確認できません。' + PHONE_NOTE, 500);
  const url = new URL(request.url);
  const no = (url.searchParams.get('no') ?? '').toUpperCase();
  const k = url.searchParams.get('k') ?? '';
  if (!(await check(env, no, k))) return fail('リンクが正しくありません。メールのリンクを、もう一度開いてください。', 403);
  try {
    const r = await load(env, no);
    if (!r) return fail('予約が見つかりませんでした。' + PHONE_NOTE, 404);
    return json({ ok: true, ...summary(r, no), advanceDates: r.route === '事前申込' ? advanceDates() : [] });
  } catch (e) {
    console.error('manage: 読み込みに失敗', e);
    return fail('ただいま確認できません。時間をおいてもう一度お試しいただくか、' + PHONE_NOTE, 502);
  }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!isConfigured(env)) return fail('ただいま受け付けできません。' + PHONE_NOTE, 500);
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return fail('送られた内容を読めませんでした。');
  }
  const no = str(body.no).toUpperCase();
  const k = str(body.k);
  const action = str(body.action);
  if (!(await check(env, no, k))) return fail('リンクが正しくありません。メールのリンクを、もう一度開いてください。', 403);

  let r;
  try {
    r = await load(env, no);
  } catch (e) {
    console.error('manage: 読み込みに失敗', e);
    return fail('ただいま受け付けできません。時間をおいてもう一度お試しいただくか、' + PHONE_NOTE, 502);
  }
  if (!r) return fail('予約が見つかりませんでした。' + PHONE_NOTE, 404);
  const before = `${r.date ? dateLabel(r.date) : '（日にちなし）'}${r.time ? ` ${r.time}` : ''}`;
  const details = str(r.rep.fields['予約の詳細']);

  if (action === 'cancel') {
    if (!r.canCancel) return fail(r.reason || 'この予約はキャンセルできません。' + PHONE_NOTE, 409);
    const line = `【キャンセル】${nowLabel()} に、お申し込みの方がWebでキャンセルされました（${before}）。`;
    try {
      // 代表の方の行だけを変える（ご家族の行は、オートメーションがそろえる）
      await updateRecords(env, [{ id: r.rep.id, fields: { [F.status]: 'キャンセル', 予約の詳細: details ? `${line}\n\n${details}` : line } }]);
    } catch (e) {
      console.error('manage: キャンセルの書き込みに失敗', e);
      return fail('ただいま受け付けできません。時間をおいてもう一度お試しいただくか、' + PHONE_NOTE, 502);
    }
    // 神社への知らせは、Airtable の「予約キャンセル」のオートメーションが送る
    return json({ ok: true, action: 'cancel' });
  }

  if (action === 'change') {
    if (!r.canChange) return fail(r.reason || 'この予約は、Webでは日時を変えられません。' + PHONE_NOTE, 409);
    const date = str(body.date);
    const time = str(body.time);
    const advance = r.route === '事前申込';
    if (advance) {
      if (!advanceDates().includes(date)) return fail('ご来社予定日を選び直してください。', 400, { refresh: true });
      if (date === r.date) return fail('今のご来社予定日と同じです。別の日をお選びください。');
    } else {
      if (!bookableDates().includes(date) || !SLOT_TIMES.includes(time)) return fail('ご祈祷の日時を選び直してください。', 400, { refresh: true });
      if (date === r.date && time === r.time) return fail('今の日時と同じです。別の日時をお選びください。');
      if (jstMs(date, time) - Date.now() < DEADLINE_MS) return fail('2時間以内の日時には変えられません。別の日時をお選びください。', 400, { refresh: true });
      try {
        const [taken, closed] = await Promise.all([takenSlots(env), closures(env)]);
        if (isClosed(date, time, closed)) return fail('選ばれた日時は受付をしておりません。別の日時をお選びください。', 409, { refresh: true });
        if (taken.has(`${date} ${time}`)) return fail('選ばれた日時は、ほかのご予約で埋まりました。別の日時をお選びください。', 409, { refresh: true });
      } catch (e) {
        console.error('manage: 空きの確認に失敗', e);
        return fail('ただいま受け付けできません。時間をおいてもう一度お試しいただくか、' + PHONE_NOTE, 502);
      }
    }
    const after = `${dateLabel(date)}${advance ? '' : ` ${time}`}`;
    const line = `【日時の変更】${nowLabel()} に、お申し込みの方がWebで変更されました（${before} → ${after}）。`;
    const targets = r.members.filter((m) => str(m.fields[F.status]) !== 'キャンセル');
    const update = (withBefore: boolean) =>
      updateRecords(env, targets.map((m) => ({
        id: m.id,
        fields: {
          [F.date]: storedDate(date),
          [F.time]: advance ? '' : time,
          [F.status]: advance ? '事前申込' : '仮予約',
          ...(withBefore ? { 変更前の御祈祷日: str(m.fields[F.date]), 変更前の御祈祷時刻: str(m.fields[F.time]) } : {}),
          ...(m.id === r.rep.id ? { 予約の詳細: details ? `${line}\n\n${details}` : line } : {}),
          // 「予約の日時変更（Web）」のメールのきっかけ（変えるたびに値が変わる）
          ...(withBefore && m.id === r.rep.id ? { 変更受付日時: nowLabel() } : {}),
        },
      })));
    try {
      try {
        await update(true);
      } catch (e) {
        // 「変更前の御祈祷日」「変更前の御祈祷時刻」「変更受付日時」の項目がない表なら、入れずに書き込み直す
        if (e instanceof AirtableError && /変更前|変更受付日時/.test(e.message)) await update(false);
        else throw e;
      }
    } catch (e) {
      console.error('manage: 変更の書き込みに失敗', e);
      return fail('ただいま受け付けできません。時間をおいてもう一度お試しいただくか、' + PHONE_NOTE, 502);
    }
    // 神社への知らせは、Airtable の「予約の日時変更（Web）」のオートメーションが送る
    return json({ ok: true, action: 'change', status: advance ? '事前申込' : '仮予約', dateLabel: dateLabel(date), time: advance ? '' : time });
  }

  return fail('操作を選び直してください。');
};

