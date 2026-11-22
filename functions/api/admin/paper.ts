/**
 * 紙の祈祷申込書を、予約受付の表に入れる（神社の方だけ。/admin/paper/ の入力画面から使う）
 *
 *   POST /api/admin/paper  （JSON）
 *
 * ご家族で共通の項目（御祈祷日・住所・電話番号など）は1回だけ受け取り、1人1行で書き込む。
 *   予約番号 ＝ 紙の申込書の番号（1人に1つ。ない申込書もあるので空でもよい）。
 *   ご家族をまとめるため、全員の「予約グループ」に同じ値を入れる（番号のある最初の方の番号。だれも番号がなければ「窓口-日時」）。
 *   受付経路「窓口」、予約ステータス「予約確定」、祈祷方法「来社」。
 *   生年月日は和暦（元号・年・月・日）で受け取り、Web の予約と同じ「YYYY/MM/DD」で入れる。
 *   画面で登録済みの方を選んだときは、その方の個人・世帯の ID を「既存個人ID」「既存世帯ID」に入れる。
 *   初穂料は、入っていれば「初穂料」の項目に入れる（その項目が数式などで書き込めなければ、入れずに知らせる）。
 *
 * Cloudflare Access のログインを通ってきたときだけ受け付ける（src/lib/access.ts）。
 */

import { accessUser, type AccessEnv } from '../../../src/lib/access';
import { AirtableError, F, createRecords, isConfigured, listRows, type AirtableEnv } from '../../../src/lib/airtable';
import { MAX_PERSONS, PRAYERS, PRAYER_OTHER, storedDate, type Extra } from '../../../src/lib/reservation';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
const fail = (error: string, status = 400) => json({ ok: false, error }, status);

/** 全角・半角をそろえ、前後の空白を取る */
const clean = (v: unknown) => String(v ?? '').normalize('NFKC').replace(/[​-‍﻿]/g, '').trim();
/** 名前などの文字（全角の空白は残す。前後の空白だけ取る） */
const text = (v: unknown) => String(v ?? '').replace(/[​-‍﻿]/g, '').trim();
const GENDERS = ['男', '女', '回答しない'];

/** 元号の始まりの日（その日からその元号） */
const ERAS: [string, number, string][] = [
  ['令和', 2019, '2019-05-01'], ['平成', 1989, '1989-01-08'], ['昭和', 1926, '1926-12-25'],
  ['大正', 1912, '1912-07-30'], ['明治', 1868, '1868-01-25'],
];

/** 和暦 → 'YYYY-MM-DD'（ありえない日付なら null） */
export function warekiToKey(era: string, y: number, m: number, d: number): string | null {
  const e = ERAS.find((x) => x[0] === era);
  if (!e || !Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || y < 1 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const year = e[1] + y - 1;
  const dt = new Date(Date.UTC(year, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  const key = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // その元号の期間に入っているか（例：令和1年4月は平成）
  const next = ERAS[ERAS.indexOf(e) - 1];
  if (key < e[2] || (next && key >= next[2])) return null;
  return key;
}

interface PersonIn {
  no?: string; special?: string; sei?: string;
  /** 登録済みの方を選んだとき：個人の「Name」と、世帯の「世帯・会社名」（予約受付の既存個人ID・既存世帯ID に入れる） */
  personId?: string; houseId?: string;
  /** 同じ方の Airtable のレコードID（rec…）。台帳へは、名前ではなくこちらでつなぐ */
  personRec?: string; houseRec?: string; mei?: string; seiKana?: string; meiKana?: string; gender?: string;
  era?: string; y?: string | number; m?: string | number; d?: string | number;
  prayers?: string[]; other?: string; haraobi?: string; car?: string;
  father?: string; fatherKana?: string; mother?: string; motherKana?: string; fee?: string | number;
}

export const onRequestPost: PagesFunction<AirtableEnv & AccessEnv> = async ({ request, env }) => {
  const user = await accessUser(request, env);
  if (!user) return fail('ログインが必要です。ページを再読み込みして、ログインし直してください。', 403);
  if (!isConfigured(env)) return fail('Airtable の設定がありません。', 500);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return fail('送られた内容を読めませんでした。');
  }

  // ── ご家族で共通の項目 ──
  const date = clean(body.date);
  const time = clean(body.time);
  const zip = clean(body.zip).replace(/[^0-9]/g, '');
  const address = text(body.address);
  const building = text(body.building);
  const tel = clean(body.tel).replace(/[^0-9-]/g, '');
  const message = text(body.message);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('御祈祷日を入れてください。');
  if (time && !/^\d{1,2}:\d{2}$/.test(time)) return fail('時刻を「10:30」のように入れてください。');
  if (zip && zip.length !== 7) return fail('郵便番号は7桁で入れてください。');
  if (!address) return fail('住所を入れてください。');

  // ── 1人ずつ ──
  const list = Array.isArray(body.people) ? (body.people as PersonIn[]) : [];
  if (!list.length) return fail('お一人以上入れてください。');
  if (list.length > MAX_PERSONS) return fail(`一度に入れられるのは${MAX_PERSONS}人までです。`);
  const people = [];
  for (const [n, p] of list.entries()) {
    const who = `（${n + 1}人目）`;
    const no = clean(p.no).replace(/[^0-9A-Za-z-]/g, '');
    const sei = text(p.sei).replace(/[\s　]+/g, '');
    const mei = text(p.mei).replace(/[\s　]+/g, '');
    const seiKana = text(p.seiKana).replace(/[\s　]+/g, '');
    const meiKana = text(p.meiKana).replace(/[\s　]+/g, '');
    const gender = clean(p.gender);
    const special = text(p.special);
    if (no && /^W/i.test(no)) return fail(`申込書の番号に「W」は使えません（Web の予約の番号と区別するため）。${who}`);
    if (!sei) return fail(`お名前（姓）を入れてください。${who}`);
    if (gender && !GENDERS.includes(gender)) return fail(`性別を選び直してください。${who}`);
    // 生年月日（和暦）。入っていなければ空のまま
    let birth = '';
    const era = clean(p.era);
    const y = Number(clean(p.y).replace(/^元$/, '1'));
    const m = Number(clean(p.m));
    const d = Number(clean(p.d));
    if (era || clean(p.y) || clean(p.m) || clean(p.d)) {
      const key = warekiToKey(era, y, m, d);
      if (!key) return fail(`生年月日を正しく入れてください（${era}${clean(p.y)}年${clean(p.m)}月${clean(p.d)}日）。${who}`);
      birth = key.replace(/-/g, '/');
    }
    // ご祈願（複数）
    // ご祈願の名前は全角のかっこを含むので、全角・半角をそろえずに（前後の空白だけ取って）比べる
    const chosen = [...new Set((p.prayers ?? []).map(text).filter(Boolean))];
    if (!chosen.length) return fail(`ご祈願を選んでください。${who}`);
    if (chosen.some((c) => c !== PRAYER_OTHER && !PRAYERS.some((x) => x.name === c))) return fail(`ご祈願を選び直してください。${who}`);
    const other = text(p.other);
    if (chosen.includes(PRAYER_OTHER) && !other) return fail(`ご祈願（その他）を入れてください。${who}`);
    const prayerNames = chosen.map((c) => (c === PRAYER_OTHER ? other : c));
    const extras = new Set<Extra>(chosen.flatMap((c) => PRAYERS.find((x) => x.name === c)?.extras ?? []));
    const haraobi = clean(p.haraobi);
    const car = text(p.car);
    const father = text(p.father);
    const mother = text(p.mother);
    const parents = extras.has('parents')
      ? [
          ...(father ? [`父　${father}（${text(p.fatherKana)}）`] : []),
          ...(mother ? [`母　${mother}（${text(p.motherKana)}）`] : []),
        ].join('\n')
      : '';
    const feeText = clean(p.fee).replace(/[^0-9]/g, '');
    const fee = feeText ? Number(feeText) : 0;
    if (fee > 10_000_000) return fail(`初穂料の金額を確かめてください。${who}`);
    const personId = text(p.personId).slice(0, 200);
    const houseId = text(p.houseId).slice(0, 200);
    const personRec = /^rec\w{10,20}$/.test(text(p.personRec)) ? text(p.personRec) : '';
    const houseRec = /^rec\w{10,20}$/.test(text(p.houseRec)) ? text(p.houseRec) : '';
    people.push({ no, sei, mei, seiKana, meiKana, gender, special, birth, personId, houseId, personRec, houseRec, prayerNames, extras, haraobi, car, parents, fee });
  }

  // 番号の重なり（この入力の中、予約受付の表）。番号のない申込書は調べない
  const numbers = people.map((p) => p.no);
  const given = numbers.filter(Boolean);
  const dup = given.find((no, i) => given.indexOf(no) !== i);
  if (dup) return fail(`申込書の番号「${dup}」が2回入っています。`);
  const jst = new Date(Date.now() + 9 * 3600 * 1000).toISOString();
  const group = given[0] || `窓口-${jst.slice(0, 10).replace(/-/g, '')}-${jst.slice(11, 19).replace(/:/g, '')}`;
  if (given.length) try {
    // 紙の番号は年ごとに1から始まることがあるので、御祈祷日が1年以内の行だけを「同じ申込書」とみなす
    const formula = `OR(${given.map((n) => `{予約番号} = '${n.replace(/'/g, '')}'`).join(', ')})`;
    const found = await listRows(env, { filterByFormula: formula, 'fields[]': ['予約番号', F.date] });
    const near = found.filter((r) => {
      const m = String(r.fields[F.date] ?? '').match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
      if (!m) return true;
      const days = Math.abs(Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000;
      return days < 365;
    });
    if (near.length) {
      const nos = [...new Set(near.map((r) => String(r.fields['予約番号'])))].join('、');
      return fail(`申込書の番号「${nos}」は、すでに予約受付の表にあります。同じ申込書を二度入れていないか確かめてください。`, 409);
    }
  } catch (e) {
    console.error('admin/paper: 番号の確認に失敗', e);
    return fail('Airtable を読み込めませんでした。少し待ってから、もう一度押してください。', 502);
  }

  // ── 同じ御祈祷日に、同じ名前（または同じ方）の行がすでにないか（電話の予約などを重ねて入れないように） ──
  // 見つかったら書き込まずに知らせる。画面で確かめて「重ねて登録する」を選ぶと、confirmDuplicate を付けて送り直してくる
  if (body.confirmDuplicate !== true) {
    try {
      const day = date.replace(/-/g, '/');
      const filterByFormula = `AND(LEFT({${F.date}}, 10) = '${day}', {${F.status}} != 'キャンセル')`;
      const base = ['予約番号', '名前', '受付経路', F.status, '既存個人ID'];
      // 「既存個人レコードID」の項目がない表でも動くよう、なければ外して読み直す
      const sameDay = await listRows(env, { filterByFormula, 'fields[]': [...base, '既存個人レコードID'] }).catch((e) => {
        if (e instanceof AirtableError && /レコードID/.test(e.message)) return listRows(env, { filterByFormula, 'fields[]': base });
        throw e;
      });
      const key = (v: unknown) => String(v ?? '').normalize('NFKC').replace(/[\s　]/g, '');
      const duplicates = [];
      for (const p of people) {
        const me = key(`${p.sei}${p.mei}`);
        for (const r of sameDay) {
          const f = r.fields;
          const same = (me && key(f['名前']) === me)
            || (p.personRec && f['既存個人レコードID'] === p.personRec)
            || (p.personId && key(f['既存個人ID']) === key(p.personId));
          if (same) duplicates.push({ name: `${p.sei}　${p.mei}`.trim(), no: String(f['予約番号'] ?? ''), route: String(f['受付経路'] ?? ''), status: String(f[F.status] ?? ''), rowName: String(f['名前'] ?? '') });
        }
      }
      if (duplicates.length) {
        return json({ ok: false, duplicates, error: '同じ御祈祷日に、同じ方の予約がすでに予約受付にあります。' }, 409);
      }
    } catch (e) {
      console.error('admin/paper: 同じ方の予約の確認に失敗', e);
      return fail('Airtable を読み込めませんでした。少し待ってから、もう一度押してください。', 502);
    }
  }

  // ── 1人1行で書き込む ──
  const rows = (withFee: boolean, withRec = true) =>
    people.map((p, n) => {
      const fields: Record<string, unknown> = {
        名前: [p.sei, p.mei].filter(Boolean).join('　'),
        ふりがな: [p.seiKana, p.meiKana].filter(Boolean).join('　'),
        [F.status]: '予約確定',
        受付経路: '窓口',
        予約番号: p.no,
        予約グループ: group,
        代表者: n === 0,
        [F.date]: storedDate(date),
        [F.time]: time ? time.padStart(5, '0') : '',
        [F.method]: '来社',
        名前の特殊文字: p.special,
        // 登録済みの方を選んだときは、その方の ID を入れておく（「確認・登録」は探し直さずにこの方を使う）
        既存個人ID: p.personId,
        既存世帯ID: p.houseId,
        ...(withRec ? { 既存個人レコードID: p.personRec, 既存世帯レコードID: p.houseRec } : {}),
        性別: p.gender,
        生年月日: p.birth,
        郵便番号: zip,
        住所: address,
        建物名等: building,
        電話番号: tel,
        御祈祷内容: p.prayerNames,
        腹帯のお祓い: p.extras.has('haraobi') ? p.haraobi : '',
        父母の名前: p.parents,
        '車名・ナンバー': p.extras.has('car') ? p.car : '',
        連絡事項: n === 0 ? message : '',
        ...(withFee && p.fee ? { 初穂料: p.fee } : {}),
      };
      // 空の項目は送らない（単一選択に空の選択肢ができないように）。チェックボックスは外したまま送らない
      for (const k of Object.keys(fields)) if (fields[k] === '' || fields[k] === false) delete fields[k];
      return fields;
    });

  const anyFee = people.some((p) => p.fee);
  let warning = '';
  try {
    // 「既存個人レコードID」「既存世帯レコードID」の項目がまだない表でも書き込めるよう、なければ外して書き込み直す
    const anyRec = people.some((p) => p.personRec || p.houseRec);
    const write = async (withFee: boolean) => {
      try {
        await createRecords(env, rows(withFee, true));
      } catch (e) {
        if (anyRec && e instanceof AirtableError && /レコードID/.test(e.message)) await createRecords(env, rows(withFee, false));
        else throw e;
      }
    };
    try {
      await write(true);
    } catch (e) {
      // 「初穂料」が数式などで書き込めないときは、初穂料を入れずに書き込み直す
      if (anyFee && e instanceof AirtableError && /初穂料/.test(e.message)) {
        await write(false);
        warning = '予約受付の「初穂料」は書き込めない項目だったので、初穂料は入れていません。';
      } else {
        throw e;
      }
    }
  } catch (e) {
    console.error('admin/paper: Airtable への書き込みに失敗', e);
    const detail = e instanceof AirtableError ? `（${e.message}）` : '';
    return fail(`予約受付の表に書き込めませんでした。${detail}`, 502);
  }
  return json({ ok: true, numbers, names: people.map((p) => [p.sei, p.mei].filter(Boolean).join('　')), warning });
};
