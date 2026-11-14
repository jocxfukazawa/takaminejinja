/**
 * ご祈祷予約の送信先（Cloudflare Pages Functions）
 *
 * 1. Turnstile でボット判定
 * 2. 入力内容と、日時が空いているかを確認
 * 3. Airtable の予約の表に、ご祈祷を受ける方1人につき1行、「仮予約」として書き込む
 *    一緒に受ける方の行には同じ予約番号を入れ、枠は1組として数える
 *    （受付メールは Airtable の Automations が、代表者の行ができたときに予約につき1通送る。
 *      祈願内容ごとの案内は、代表者の行の「祈願の案内」のリンク先からまとめて差し込む）
 *
 * 環境変数は src/lib/airtable.ts と、Turnstile の TURNSTILE_SECRET_KEY。
 */

import {
  MAX_PERSONS, PHONE, PRAYERS, PRAYER_OTHER, SLOT_TIMES,
  bookableDates, feeSummary, isClosed, isValidBirthday, storedDate, type Extra,
} from '../../../src/lib/reservation';
import {
  AirtableError, F, closures, createRecords, deleteRecords, isFirstInSlot, missingSettings, takenSlots, type AirtableEnv,
} from '../../../src/lib/airtable';

interface Env extends AirtableEnv {
  TURNSTILE_SECRET_KEY?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const fail = (error: string, status = 400, extra: Record<string, unknown> = {}) =>
  json({ ok: false, error, ...extra }, status);

const UNAVAILABLE = `ただいまWEBでの予約を受け付けられません。お手数ですが、お電話（${PHONE}）でご予約ください。`;
/**
 * 受け付けられなかったときに、原因の種類を添える（神社で原因を調べるため。予約の中身や設定の値は含めない）
 */
const cause = (step: string, e: unknown) =>
  e instanceof AirtableError
    ? { reason: 'airtable', step, type: e.type, detail: e.message.replace(/^Airtable \d+ \S+: /, '').slice(0, 200) }
    : { reason: 'airtable', step, type: 'NETWORK' };

const SLOT_TAKEN = '選ばれた日時は、ほかの予約で埋まりました。お手数ですが、別の日時をお選びください。';

async function verifyTurnstile(token: string, secret: string, ip: string | null) {
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const data = (await res.json()) as { success: boolean };
    return data.success;
  } catch (e) {
    console.error('reservation: Turnstile の検証に失敗', e);
    return false;
  }
}

/** 全角・半角の空白を整えて、前後の空白を取る */
const clean = (v: FormDataEntryValue | null) => String(v ?? '').replace(/[ 　]+/g, ' ').trim();
/** 改行を残したまま整える（複数行の欄） */
const cleanMultiline = (v: FormDataEntryValue | null) =>
  String(v ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).join('\n').trim();
/** 数字以外を取り除く（全角数字も半角に） */
const digits = (v: FormDataEntryValue | null) =>
  String(v ?? '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\D/g, '');

/** 生年月日（'YYYY-MM-DD'）を和暦で（例: 昭和58年10月12日）。元年は「元年」と書く */
function wareki(key: string) {
  const [y, m, d] = key.split('-').map(Number);
  const eras: [string, number, number, number][] = [
    ['令和', 2019, 5, 1], ['平成', 1989, 1, 8], ['昭和', 1926, 12, 25], ['大正', 1912, 7, 30], ['明治', 1868, 1, 25],
  ];
  const n = y * 10000 + m * 100 + d;
  const era = eras.find(([, ey, em, ed]) => n >= ey * 10000 + em * 100 + ed);
  if (!era) return '';
  const year = y - era[1] + 1;
  return `${era[0]}${year === 1 ? '元' : year}年${m}月${d}日`;
}

/** 予約番号（例: W261114-7KQ2）。同じ予約で一緒に受ける方の行に同じ番号を入れる */
function newReservationNo(now = Date.now()) {
  const jst = new Date(now + 9 * 60 * 60 * 1000).toISOString();
  const day = jst.slice(2, 10).replace(/-/g, '');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const random = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => chars[b % chars.length]).join('');
  return `W${day}-${random}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENDERS = ['男', '女', '回答しない'];
const METHODS = ['来社', '郵送'];
const PAY_ONSITE = '当日ご社頭でお納め';
const PAY_OTHER = 'その他';
const PAYMENTS = [PAY_ONSITE, '事前にクレジットカードでお納め', PAY_OTHER];

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const missing = [...missingSettings(env), ...(env.TURNSTILE_SECRET_KEY ? [] : ['TURNSTILE_SECRET_KEY'])];
  if (missing.length) {
    console.error('reservation: 環境変数が設定されていません', missing);
    return fail(UNAVAILABLE, 500, { reason: 'missing-settings', type: missing.join(', ') });
  }

  const form = await request.formData();

  // 人には見えない項目に入力があればボットとみなし、成功したふりをする
  if (clean(form.get('website'))) return json({ ok: true });

  const token = String(form.get('cf-turnstile-response') ?? '');
  if (!token || !(await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, request.headers.get('CF-Connecting-IP')))) {
    return fail('認証に失敗しました。ページを再読み込みして、もう一度お試しください。');
  }

  // ── 入力の確認（全員に共通の項目） ──
  const v = {
    zip: digits(form.get('zip')),
    address: cleanMultiline(form.get('address')),
    building: clean(form.get('building')),
    tel: digits(form.get('tel')),
    email: clean(form.get('email')),
    method: clean(form.get('method')),
    date: clean(form.get('date')),
    time: clean(form.get('time')),
    payment: clean(form.get('payment')),
    message: cleanMultiline(form.get('message')),
  };
  const required: [string, string][] = [
    [v.address, '住所'], [v.tel, '電話番号'], [v.email, 'メールアドレス'],
    [v.method, 'ご祈祷方法'], [v.payment, '初穂料の納め方'],
  ];
  for (const [value, label] of required) {
    if (!value) return fail(`「${label}」を入力してください。`);
  }
  if (Object.entries(v).some(([k, s]) => s.length > (['address', 'message'].includes(k) ? 2000 : 200))) {
    return fail('入力された内容が長すぎます。');
  }
  if (v.zip && v.zip.length !== 7) return fail('郵便番号は7桁の数字で入力してください。');
  if (v.tel.length < 10 || v.tel.length > 11) return fail('電話番号を正しく入力してください。');
  if (!EMAIL_RE.test(v.email)) return fail('メールアドレスの形式が正しくありません。');
  if (!METHODS.includes(v.method)) return fail('ご祈祷方法を選んでください。');
  if (!PAYMENTS.includes(v.payment)) return fail('初穂料の納め方を選んでください。');
  if (v.method === '郵送' && v.payment === PAY_ONSITE) return fail('郵送の場合は、当日ご社頭でお納めいただくことはできません。初穂料の納め方を選び直してください。');
  if (v.payment === PAY_OTHER && !v.message) return fail('初穂料の納め方（その他）のご希望を、連絡事項にご記入ください。');

  // ── ご祈祷を受ける方（p0-sei、p3-sei… のように番号つきで届く。番号は飛ぶことがある） ──
  const indexes = [...new Set([...form.keys()].map((k) => k.match(/^p(\d{1,3})-sei$/)?.[1]).filter((i): i is string => !!i))]
    .map(Number)
    .sort((a, b) => a - b);
  if (indexes.length === 0) return fail('ご祈祷を受けられる方のお名前を入力してください。');
  if (indexes.length > MAX_PERSONS) return fail(`一度にご予約いただけるのは${MAX_PERSONS}名までです。`);

  const people = [];
  for (const [n, i] of indexes.entries()) {
    const get = (key: string) => form.get(`p${i}-${key}`);
    const who = indexes.length > 1 ? `（${n + 1}人目）` : '';
    const p = {
      sei: clean(get('sei')),
      mei: clean(get('mei')),
      seiKana: clean(get('sei-kana')),
      meiKana: clean(get('mei-kana')),
      special: clean(get('special')),
      gender: clean(get('gender')),
      birthday: clean(get('birthday')),
      prayerOther: clean(get('prayer-other')),
      haraobi: clean(get('haraobi')),
      parents: cleanMultiline(get('parents')),
      car: cleanMultiline(get('car')),
    };
    const personRequired: [string, string][] = [
      [p.sei, 'お名前（姓）'], [p.mei, 'お名前（名）'], [p.seiKana, 'ふりがな（せい）'], [p.meiKana, 'ふりがな（めい）'],
      [p.gender, '性別'], [p.birthday, '生年月日'],
    ];
    for (const [value, label] of personRequired) {
      if (!value) return fail(`「${label}」を入力してください。${who}`);
    }
    if (Object.entries(p).some(([k, s]) => s.length > (['parents', 'car'].includes(k) ? 1000 : 200))) {
      return fail(`入力された内容が長すぎます。${who}`);
    }
    if (!GENDERS.includes(p.gender)) return fail(`性別を選んでください。${who}`);
    if (!isValidBirthday(p.birthday)) return fail(`生年月日を正しく入力してください。${who}`);
    // ご祈願内容は1人で複数選べる（Airtable の「御祈祷内容」も複数選択）
    const chosen = [...new Set(form.getAll(`p${i}-prayer`).map(clean).filter(Boolean))];
    if (!chosen.length) return fail(`ご祈願内容を選んでください。${who}`);
    if (chosen.some((c) => c !== PRAYER_OTHER && !PRAYERS.some((x) => x.name === c))) return fail(`ご祈願内容を選び直してください。${who}`);
    if (chosen.includes(PRAYER_OTHER) && !p.prayerOther) return fail(`ご祈願内容（その他）を入力してください。${who}`);
    const prayerNames = chosen.map((c) => (c === PRAYER_OTHER ? p.prayerOther : c));
    const extras = new Set<Extra>(chosen.flatMap((c) => PRAYERS.find((x) => x.name === c)?.extras ?? []));
    if (extras.has('haraobi') && !['あり', 'なし'].includes(p.haraobi)) return fail(`腹帯のお祓いの有無を選んでください。${who}`);
    if (extras.has('parents') && !p.parents) return fail(`父母のお名前を入力してください。${who}`);
    if (extras.has('car') && !p.car) return fail(`車名とナンバーを入力してください。${who}`);
    people.push({ ...p, prayerNames, extras });
  }

  // ── 日時の確認（来社のみ。郵送は枠を使わない） ──
  const visiting = v.method === '来社';
  const slot = `${v.date} ${v.time}`;
  if (visiting) {
    if (!bookableDates().includes(v.date) || !SLOT_TIMES.includes(v.time)) {
      return fail('ご祈祷の日時を選び直してください。', 400, { refresh: true });
    }
    try {
      const [taken, closed] = await Promise.all([takenSlots(env), closures(env)]);
      if (isClosed(v.date, v.time, closed)) return fail('選ばれた日時は受付をしておりません。別の日時をお選びください。', 409, { refresh: true });
      if (taken.has(slot)) return fail(SLOT_TAKEN, 409, { refresh: true });
    } catch (e) {
      console.error('reservation: Airtable の読み込みに失敗', e);
      return fail(UNAVAILABLE, 502, cause('予約の確認', e));
    }
  }

  // ── Airtable へ書き込む（1人1行。項目名は Google フォームから取り込んでいたときと同じ） ──
  // 同じ予約の行には同じ予約番号を入れ、最初の方（代表者）の行に「代表者」のチェックを入れる
  const reservationNo = newReservationNo();
  const roster = people
    .map((p, n) => `${n + 1}. ${p.sei}　${p.mei}（${p.seiKana}　${p.meiKana}）　${p.prayerNames.join('・')}`)
    .join('\n');
  // 参拝者へのメールは予約につき1通（代表者の行から）。含まれる祈願の案内は、
  // Airtable の「祈願の案内」の表の行をリンクでつなぎ、その案内文をまとめて差し込む。
  // 「その他」で自由に書かれた祈願は案内の表にないので、リンクしない
  const guides = [...new Set(people.flatMap((p) => p.prayerNames))].filter((name) => PRAYERS.some((x) => x.name === name));

  // 予約全体の初穂料（クレジットカードのお支払いの案内で、予約につき1回だけ伝える）
  const fee = feeSummary(people);

  // 神社へのお知らせメール用に、予約全体の詳しい内容を1つの文章にまとめる（代表者の行に入れる）。
  // 祈願内容ごとの欄（父母の名前、車など）も、入力のあった方の分をすべて載せる
  const multiple = people.length > 1;
  const details = [
    ...(visiting ? [`ご祈祷希望日時：${storedDate(v.date)} ${v.time}`] : []),
    ...people.flatMap((p, n) => [
      ...(multiple ? ['', `【${n + 1}人目${n === 0 ? '（代表の方）' : ''}】`] : []),
      `お名前：${p.sei}　${p.mei}`,
      `ふりがな：${p.seiKana}　${p.meiKana}`,
      ...(p.special ? [`名前の特殊文字：${p.special}`] : []),
      `性別：${p.gender}`,
      `生年月日：${p.birthday.replace(/-/g, '/')}（${wareki(p.birthday)}）`,
      `ご祈願内容：${p.prayerNames.join('・')}`,
      ...(p.extras.has('haraobi') ? [`腹帯のお祓い：${p.haraobi}`] : []),
      ...(p.extras.has('parents') ? [`父母の名前：\n${p.parents}`] : []),
      ...(p.extras.has('car') ? [`車名・ナンバー：\n${p.car}`] : []),
    ]),
    '',
    `郵便番号：${v.zip}`,
    `住所：${v.address}`,
    `建物名：${v.building}`,
    `電話番号：${v.tel}`,
    `メールアドレス：${v.email}`,
    '',
    `御祈祷方法：${v.method}`,
    `初穂料について：${v.payment}`,
    `初穂料（目安）：\n${fee.text}`,
    `連絡事項：${v.message}`,
    ...(multiple ? ['', `予約番号：${reservationNo}`] : []),
  ].join('\n');
  const rows = people.map((p, n) => {
    const fields: Record<string, unknown> = {
      名前: `${p.sei}　${p.mei}`,
      [F.status]: '仮予約',
      受付経路: 'Webフォーム',
      予約番号: reservationNo,
      代表者: n === 0,
      祈願の案内: n === 0 && guides.length ? guides : '',
      // 2人以上のときだけ、全員の行に一覧を入れる（どの行から送るメールにも差し込めるように）
      同時に受ける方: people.length > 1 ? roster : '',
      予約の初穂料合計: fee.total,
      初穂料の内訳: fee.text,
      [F.date]: visiting ? storedDate(v.date) : '',
      [F.time]: visiting ? v.time : '',
      ふりがな: `${p.seiKana}　${p.meiKana}`,
      名前の特殊文字: p.special,
      性別: p.gender,
      生年月日: p.birthday.replace(/-/g, '/'),
      郵便番号: v.zip,
      住所: v.address,
      建物名等: v.building,
      電話番号: v.tel,
      メールアドレス: v.email,
      御祈祷内容: p.prayerNames,
      [F.method]: v.method,
      納入方法: v.payment,
      腹帯のお祓い: p.extras.has('haraobi') ? p.haraobi : '',
      父母の名前: p.extras.has('parents') ? p.parents : '',
      '車名・ナンバー': p.extras.has('car') ? p.car : '',
      連絡事項: n === 0 ? v.message : '',
      予約の詳細: n === 0 ? details : '',
    };
    // 空の項目は送らない（単一選択に空の選択肢ができないように）。チェックボックスは外したまま送らない
    for (const k of Object.keys(fields)) if (fields[k] === '' || fields[k] === false) delete fields[k];
    return fields;
  });

  let records;
  try {
    records = await createRecords(env, rows);
  } catch (e) {
    console.error('reservation: Airtable への書き込みに失敗', e);
    return fail(UNAVAILABLE, 502, cause('予約の書き込み', e));
  }

  // ほぼ同時に同じ枠へ申し込みがあった場合は、先に入った方を残す
  if (visiting) {
    const ids = new Set(records.map((r) => r.id));
    try {
      if (!(await isFirstInSlot(env, ids, slot))) {
        await deleteRecords(env, [...ids]);
        return fail(SLOT_TAKEN, 409, { refresh: true });
      }
    } catch (e) {
      // 確認できなくても予約は入っている。重なっていれば神社の確認の段階で調整する
      console.error('reservation: 重複の確認に失敗', e);
    }
  }

  return json({ ok: true });
};
