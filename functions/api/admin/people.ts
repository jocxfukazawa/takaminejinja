/**
 * 登録済みの方を探す（神社の方だけ。紙の申込書の入力画面 /admin/paper/ から使う）
 *
 *   GET /api/admin/people?q=たかみね   … 個人の表を、名前・ふりがなの一部で探す（最大20件。死去の方は出さない）
 *   GET /api/admin/people?house=recXXX … その世帯の方の一覧（死去の方は出さない）
 *
 * 返す内容：名前・ふりがな・性別・生年月日（和暦も）と、その方の世帯（会社・団体でないもの）の住所・電話番号。
 * 予約受付の「既存個人ID」「既存世帯ID」に入れる値（個人の「Name」、世帯の「世帯・会社名」）も返す。
 *
 * 参拝の方の個人情報を返すので、Cloudflare Access のログインを通ってきたときだけ答える（src/lib/access.ts）。
 */

import { accessUser, type AccessEnv } from '../../../src/lib/access';
import { isConfigured, listTable, type AirtableEnv, type AirtableRecord } from '../../../src/lib/airtable';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const P = {
  name: 'Name', sei: '姓', mei: '名', seiKana: '姓（ふりがな）', meiKana: '名（ふりがな）',
  gender: '性別', birth: '生年月日', dead: '死去', house: '世帯ID', tel: '電話番号',
};
const H = {
  name: '世帯・会社名', kana: '世帯・会社名（ふりがな）', kind: '世帯・会社の種類',
  zip: '郵便番号', address: '住所', building: '建物名等', tel: '電話番号', members: '個人',
};
const MAX = 20;

const ERAS: [string, number, string][] = [
  ['令和', 2019, '2019-05-01'], ['平成', 1989, '1989-01-08'], ['昭和', 1926, '1926-12-25'],
  ['大正', 1912, '1912-07-30'], ['明治', 1868, '1868-01-25'],
];
/** 'YYYY-MM-DD' → 和暦 */
const toWareki = (key: string) => {
  const e = ERAS.find((x) => key >= x[2]);
  if (!e) return null;
  const [y, m, d] = key.split('-').map(Number);
  return { era: e[0], y: y - e[1] + 1, m, d };
};

const str = (v: unknown) => (Array.isArray(v) ? v.join('、') : v == null ? '' : String(v)).trim();
/** Airtable の式の文字（'…'）に入れられるようにする */
const quote = (s: string) => `'${s.replace(/\\/g, '').replace(/'/g, "\\'")}'`;
const isCompany = (h: AirtableRecord) => /会社|団体/.test(str(h.fields[H.kind]));

const personOut = (p: AirtableRecord, houses: Map<string, AirtableRecord>) => {
  const f = p.fields;
  const birth = str(f[P.birth]).slice(0, 10);
  const linked = (Array.isArray(f[P.house]) ? (f[P.house] as string[]) : []).map((id) => houses.get(id)).filter(Boolean) as AirtableRecord[];
  // その方自身の世帯（会社・団体でないもの）。なければ、つながっている最初の世帯
  const h = linked.find((x) => !isCompany(x)) ?? linked[0];
  return {
    id: p.id,
    name: str(f[P.name]),
    sei: str(f[P.sei]), mei: str(f[P.mei]), seiKana: str(f[P.seiKana]), meiKana: str(f[P.meiKana]),
    gender: str(f[P.gender]),
    birth: /^\d{4}-\d{2}-\d{2}$/.test(birth) ? birth : '',
    wareki: /^\d{4}-\d{2}-\d{2}$/.test(birth) ? toWareki(birth) : null,
    tel: str(f[P.tel]),
    house: h
      ? {
          id: h.id, name: str(h.fields[H.name]), company: isCompany(h),
          zip: str(h.fields[H.zip]), address: str(h.fields[H.address]), building: str(h.fields[H.building]), tel: str(h.fields[H.tel]),
        }
      : null,
  };
};

export const onRequestGet: PagesFunction<AirtableEnv & AccessEnv> = async ({ request, env }) => {
  if (!(await accessUser(request, env))) return json({ ok: false, error: 'ログインが必要です。ページを再読み込みして、ログインし直してください。' }, 403);
  if (!isConfigured(env)) return json({ ok: false, error: 'Airtable の設定がありません。' }, 500);
  const personTable = env.AIRTABLE_PERSON_TABLE || '個人';
  const houseTable = env.AIRTABLE_HOUSE_TABLE || '世帯・会社';
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').normalize('NFKC').replace(/[\s　'"\\]/g, '').slice(0, 30);
  const houseId = url.searchParams.get('house') ?? '';

  const personFields = Object.values(P);
  const houseFields = [H.name, H.kind, H.zip, H.address, H.building, H.tel, H.members];
  const readHouses = async (ids: string[]) => {
    const unique = [...new Set(ids)].filter((id) => /^rec\w+$/.test(id));
    if (!unique.length) return new Map<string, AirtableRecord>();
    const rows = await listTable(env, houseTable, {
      filterByFormula: `OR(${unique.map((id) => `RECORD_ID() = '${id}'`).join(', ')})`, 'fields[]': houseFields, pageSize: '100',
    });
    return new Map(rows.map((h) => [h.id, h]));
  };

  try {
    if (houseId) {
      // その世帯の方の一覧
      if (!/^rec\w+$/.test(houseId)) return json({ ok: false, error: '世帯の指定が正しくありません。' }, 400);
      const houses = await readHouses([houseId]);
      const h = houses.get(houseId);
      if (!h) return json({ ok: true, people: [] });
      const ids = (Array.isArray(h.fields[H.members]) ? (h.fields[H.members] as string[]) : []).filter((id) => /^rec\w+$/.test(id));
      if (!ids.length) return json({ ok: true, people: [] });
      const people = await listTable(env, personTable, {
        filterByFormula: `AND(NOT({${P.dead}}), OR(${ids.map((id) => `RECORD_ID() = '${id}'`).join(', ')}))`,
        'fields[]': personFields, pageSize: '100',
      });
      const all = await readHouses(people.flatMap((p) => (Array.isArray(p.fields[P.house]) ? (p.fields[P.house] as string[]) : [])));
      return json({ ok: true, people: people.map((p) => personOut(p, all)).sort((a, b) => (a.birth || '9').localeCompare(b.birth || '9')) });
    }

    if (q.length < 1) return json({ ok: true, people: [] });
    // 名前（空白を除いて）か、ふりがなに、入れた文字が含まれる方
    const name = `SUBSTITUTE(SUBSTITUTE({${P.sei}} & {${P.mei}}, ' ', ''), '　', '')`;
    const kana = `SUBSTITUTE(SUBSTITUTE({${P.seiKana}} & {${P.meiKana}}, ' ', ''), '　', '')`;
    const formula = `AND(NOT({${P.dead}}), OR(FIND(${quote(q)}, ${name}), FIND(${quote(q)}, ${kana})))`;
    const found = (await listTable(env, personTable, { filterByFormula: formula, 'fields[]': personFields, pageSize: '100', maxRecords: String(MAX + 1) })).slice(0, MAX + 1);
    const houses = await readHouses(found.flatMap((p) => (Array.isArray(p.fields[P.house]) ? (p.fields[P.house] as string[]) : [])));
    const people = found.slice(0, MAX).map((p) => personOut(p, houses));
    return json({ ok: true, people, more: found.length > MAX });
  } catch (e) {
    console.error('admin/people: Airtable の読み込みに失敗', e);
    return json({ ok: false, error: '個人の表を読み込めませんでした。少し待ってから、もう一度お試しください。' }, 502);
  }
};
