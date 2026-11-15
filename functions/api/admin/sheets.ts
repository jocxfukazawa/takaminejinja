/**
 * 祈祷申込書の印刷用に、予約受付の表から Web の予約・事前申し込みを返す（神社の方だけ）。
 *
 *   GET /api/admin/sheets?date=2027-01-10   その日の予約・事前申し込み（キャンセルを除く）
 *   GET /api/admin/sheets?no=W000121        その予約番号の予約（同じ予約グループのご家族も）
 *
 * Cloudflare Access のログインを通ってきたときだけ答える（src/lib/access.ts）。
 */

import { accessUser, type AccessEnv } from '../../../src/lib/access';
import { isConfigured, listRows, type AirtableEnv } from '../../../src/lib/airtable';
import { toSheet } from '../../../src/lib/sheet';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const FIELDS = [
  '予約番号', '予約グループ', '代表者', '予約ステータス', '受付経路', '御祈祷日', '御祈祷時刻', '祈祷方法',
  '名前', 'ふりがな', '名前の特殊文字', '性別', '生年月日', '郵便番号', '住所', '建物名等', '電話番号',
  '御祈祷内容', '腹帯のお祓い', '車名・ナンバー', '納入方法',
];

export const onRequestGet: PagesFunction<AirtableEnv & AccessEnv> = async ({ request, env }) => {
  if (!(await accessUser(request, env))) return json({ ok: false, error: 'ログインが必要です。' }, 403);
  if (!isConfigured(env)) return json({ ok: false, error: 'Airtable の設定がありません。' }, 500);

  const url = new URL(request.url);
  const date = url.searchParams.get('date') ?? '';
  const no = (url.searchParams.get('no') ?? '').toUpperCase();
  const web = `OR({受付経路} = 'Webフォーム', {受付経路} = '事前申込')`;
  let formula: string;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    formula = `AND(${web}, {予約ステータス} != 'キャンセル', LEFT({御祈祷日}, 10) = '${date.replace(/-/g, '/')}')`;
  } else if (/^W\d{6}$/.test(no)) {
    formula = `AND(${web}, OR({予約番号} = '${no}', {予約グループ} = '${no}'))`;
  } else {
    return json({ ok: false, error: '日付か予約番号を指定してください。' }, 400);
  }

  try {
    const rows = await listRows(env, { filterByFormula: formula, 'fields[]': FIELDS, 'sort[0][field]': '予約番号' });
    const sheets = [];
    const separate = [];
    for (const row of rows) {
      const { sheet, separate: other } = toSheet(row);
      if (sheet) sheets.push(sheet);
      if (other.length) {
        separate.push({ no: String(row.fields['予約番号'] ?? ''), name: String(row.fields['名前'] ?? ''), prayers: other });
      }
    }
    return json({ ok: true, sheets, separate });
  } catch (e) {
    console.error('admin/sheets: Airtable の読み込みに失敗', e);
    return json({ ok: false, error: 'Airtable を読み込めませんでした。' }, 502);
  }
};
