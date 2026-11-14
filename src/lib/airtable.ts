/**
 * ご祈祷予約で使う Airtable とのやりとり（Pages Functions から使う）。
 *
 * 必要な環境変数（Cloudflare Pages の「設定 → 変数とシークレット」）:
 *   AIRTABLE_TOKEN          個人用アクセストークン（シークレット）。予約の base だけを読み書きできる権限で作る
 *   AIRTABLE_BASE_ID        base の ID（app で始まる）
 *   AIRTABLE_TABLE          予約の表（名前か tbl で始まる ID）
 *   AIRTABLE_CLOSURE_TABLE  受付停止日の表（名前か ID）
 */

import { normalizeDate, normalizeTime, type Closure } from './reservation';

export interface AirtableEnv {
  AIRTABLE_TOKEN?: string;
  AIRTABLE_BASE_ID?: string;
  AIRTABLE_TABLE?: string;
  AIRTABLE_CLOSURE_TABLE?: string;
  /** 動作確認用に差し替えるときだけ設定する */
  AIRTABLE_API_URL?: string;
}

export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

/** 予約の表の項目名 */
export const F = {
  status: '予約ステータス',
  date: '御祈祷日',
  time: '御祈祷時刻',
  method: '祈祷方法',
} as const;

/** この状態の予約は枠を空ける */
const CANCELLED = 'キャンセル';
/** この方法の予約は枠を使わない */
const BY_MAIL = '郵送';

const REQUIRED = ['AIRTABLE_TOKEN', 'AIRTABLE_BASE_ID', 'AIRTABLE_TABLE', 'AIRTABLE_CLOSURE_TABLE'] as const;

/** 設定されていない環境変数の名前（値は返さない） */
export const missingSettings = (env: AirtableEnv) => REQUIRED.filter((k) => !env[k]);

export const isConfigured = (env: AirtableEnv) => missingSettings(env).length === 0;

/** Airtable が返したエラー。type は AUTHENTICATION_REQUIRED、INVALID_FILTER_BY_FORMULA などの種類 */
export class AirtableError extends Error {
  constructor(public status: number, public type: string, message: string) {
    super(`Airtable ${status} ${type}: ${message}`);
  }
}

function tableUrl(env: AirtableEnv, table: string) {
  const api = env.AIRTABLE_API_URL || 'https://api.airtable.com/v0';
  return `${api}/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`;
}

async function call(env: AirtableEnv, url: string, init: RequestInit = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    let type = 'UNKNOWN';
    let message = text;
    try {
      const e = (JSON.parse(text) as { error?: string | { type?: string; message?: string } }).error;
      type = typeof e === 'string' ? e : e?.type ?? type;
      message = typeof e === 'string' ? '' : e?.message ?? '';
    } catch { /* JSON でなければそのまま */ }
    throw new AirtableError(res.status, type, message);
  }
  return res.json();
}

async function listAll(env: AirtableEnv, table: string, params: Record<string, string | string[]>) {
  const records: AirtableRecord[] = [];
  let offset = '';
  do {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
    }
    if (offset) q.set('offset', offset);
    const data = (await call(env, `${tableUrl(env, table)}?${q}`)) as { records: AirtableRecord[]; offset?: string };
    records.push(...data.records);
    offset = data.offset ?? '';
  } while (offset);
  return records;
}

/**
 * 枠を使っている予約（キャンセル以外・郵送以外で、昨日以降の日付）。
 * 日付の書き方がそろっていない行も取りこぼさないよう、読めない日付の行も含めて取り、こちらで判定し直す。
 */
async function activeBookings(env: AirtableEnv) {
  const parsed = `DATETIME_PARSE(LEFT({${F.date}}, 10), 'YYYY/MM/DD')`;
  const formula =
    `AND({${F.status}} != '${CANCELLED}', {${F.method}} != '${BY_MAIL}', {${F.date}} != '', ` +
    `OR(ISERROR(${parsed}), IS_AFTER(${parsed}, DATEADD(TODAY(), -2, 'days'))))`;
  const records = await listAll(env, env.AIRTABLE_TABLE!, {
    filterByFormula: formula,
    'fields[]': [F.status, F.date, F.time, F.method],
    pageSize: '100',
  });
  return records
    .filter((r) => r.fields[F.status] !== CANCELLED && r.fields[F.method] !== BY_MAIL)
    .map((r) => ({ ...r, slot: slotKey(r.fields[F.date], r.fields[F.time]) }))
    .filter((r): r is AirtableRecord & { slot: string } => r.slot !== null);
}

const slotKey = (date: unknown, time: unknown) => {
  const d = normalizeDate(date);
  const t = normalizeTime(time);
  return d && t ? `${d} ${t}` : null;
};

/** 埋まっている枠（'YYYY-MM-DD HH:MM'） */
export async function takenSlots(env: AirtableEnv): Promise<Set<string>> {
  return new Set((await activeBookings(env)).map((r) => r.slot));
}

/** 今日以降の受付停止の設定 */
export async function closures(env: AirtableEnv): Promise<Closure[]> {
  const records = await listAll(env, env.AIRTABLE_CLOSURE_TABLE!, {
    filterByFormula: `IS_AFTER({日付}, DATEADD(TODAY(), -2, 'days'))`,
    'fields[]': ['日付', '開始時刻', '終了時刻'],
    pageSize: '100',
  });
  return records
    .map((r) => ({
      date: normalizeDate(r.fields['日付']),
      start: normalizeTime(r.fields['開始時刻']),
      end: normalizeTime(r.fields['終了時刻']),
    }))
    .filter((c): c is Closure => c.date !== null);
}

export async function createRecord(env: AirtableEnv, fields: Record<string, unknown>): Promise<AirtableRecord> {
  const data = (await call(env, tableUrl(env, env.AIRTABLE_TABLE!), {
    method: 'POST',
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  })) as { records: AirtableRecord[] };
  return data.records[0];
}

export async function deleteRecord(env: AirtableEnv, id: string) {
  await call(env, `${tableUrl(env, env.AIRTABLE_TABLE!)}/${id}`, { method: 'DELETE' });
}

/**
 * 書き込んだ予約が、その枠の最初の1件かどうか。
 * ほぼ同時に同じ枠へ申し込みがあったときに、後の方を取り消すために使う。
 */
export async function isFirstInSlot(env: AirtableEnv, record: AirtableRecord, slot: string) {
  const same = (await activeBookings(env)).filter((r) => r.slot === slot);
  same.sort((a, b) => a.createdTime.localeCompare(b.createdTime) || a.id.localeCompare(b.id));
  return same.length === 0 || same[0].id === record.id;
}
