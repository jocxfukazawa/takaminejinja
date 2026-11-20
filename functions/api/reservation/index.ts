/**
 * ご祈祷予約の送信先（Cloudflare Pages Functions）
 *
 * 1. Turnstile でボット判定
 * 2. 入力内容と、日時が空いているかを確認
 * 3. Airtable の予約の表に、ご祈祷を受ける方1人につき1行、「仮予約」として書き込む
 *    一緒に受ける方の行には同じ予約番号を入れ、枠は1組として数える
 *    （受付メールは Airtable の Automations が、代表者の行ができたときに予約につき1通送る。
 *      本文には、入力内容をまとめた代表者の行の「予約の詳細」を差し込む）
 *
 * 環境変数は src/lib/airtable.ts と、Turnstile の TURNSTILE_SECRET_KEY。
 *
 * mode=reception は黒星祈願祭の当日受付（参拝の方がその場で入力する）：
 *   - 境内の QR コードに入れた合言葉（RECEPTION_KEY）と、受付の日時（RECEPTION_WINDOWS）を確かめる
 *   - その場で「予約確定」として書き込む。申込書は、社務所のパソコンで開いている
 *     当日受付の印刷ページ（/admin/reception/）が新しい受付を見つけて、自動で印刷する
 *   - 初穂料は、計算した金額以上で、ご本人が入れた金額にする
 *   - RECEPTION_ALWAYS_OPEN=1 にすると、受付の日時でなくても受け付ける（試しのときだけ。本番では設定しない）
 */

import {
  MAX_PERSONS, PHONE, PRAYERS, PRAYER_OTHER, SLOT_TIMES,
  advanceDates, bookableDates, feeSummary, wareki, isClosed, isValidBirthday, jstNow, receptionWindow, storedDate, type Extra,
} from '../../../src/lib/reservation';
import {
  AirtableError, F, closures, createRecords, deleteRecords, formatWebNo, isFirstInSlot, lastWebNumber, missingSettings,
  recordsWithNumbers, takenSlots, updateRecords, type AirtableEnv, type AirtableRecord,
} from '../../../src/lib/airtable';

interface Env extends AirtableEnv {
  TURNSTILE_SECRET_KEY?: string;
  /** 当日受付の合言葉（境内の QR コードの URL に入れる） */
  RECEPTION_KEY?: string;
  /** 1 にすると、当日受付を日時に関係なく受け付ける（試しのときだけ） */
  RECEPTION_ALWAYS_OPEN?: string;
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


/**
 * 書き込んだ行の予約番号が、先に入った別の行と重なっていたら、空いている続き番号に付け直す。
 * 「予約の詳細」の中の番号も書き換える
 */
async function renumberIfTaken(
  env: Env,
  records: AirtableRecord[],
  numbers: string[],
  onFixed: (numbers: string[]) => void,
) {
  const ours = new Set(records.map((r) => r.id));
  for (let attempt = 0; attempt < 3; attempt++) {
    const same = await recordsWithNumbers(env, numbers);
    const first = new Map<string, string>();
    for (const r of same) {
      const no = String(r.fields['予約番号']);
      if (!first.has(no)) first.set(no, r.id);
    }
    if (numbers.every((no) => ours.has(first.get(no) ?? ''))) return records;
    const start = (await lastWebNumber(env)) + 1;
    const fixed = numbers.map((_, n) => formatWebNo(start + n));
    await updateRecords(
      env,
      records.map((r, n) => {
        const fields: Record<string, unknown> = { 予約番号: fixed[n], 予約グループ: fixed[0] };
        const details = r.fields['予約の詳細'];
        if (typeof details === 'string') fields['予約の詳細'] = details.split(numbers[0]).join(fixed[0]);
        return { id: r.id, fields };
      }),
    );
    numbers = fixed;
    onFixed(fixed);
  }
  return records;
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

  const mode = clean(form.get('mode'));
  const advance = mode === 'advance';
  const reception = mode === 'reception';
  if (reception) {
    if (!env.RECEPTION_KEY || clean(form.get('k')) !== env.RECEPTION_KEY) {
      return fail('このページは、神社に掲示している QR コードから開いてください。', 403);
    }
    if (env.RECEPTION_ALWAYS_OPEN !== '1' && !receptionWindow()) {
      return fail('ただいま、こちらでの受付の時間外です。社務所の受付でお申し込みください。', 403);
    }
  }

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
  // 当日受付：その日に神社でお受けになる。初穂料はその場（受付）でお納めいただく。メールアドレスは任意
  if (reception) {
    v.method = '来社';
    v.payment = PAY_ONSITE;
    v.date = jstNow().date;
    v.time = '';
  }
  const required: [string, string][] = [
    [v.address, '住所'], [v.tel, '電話番号'], ...(reception ? [] : [[v.email, 'メールアドレス'] as [string, string]]),
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
  if ((v.email || !reception) && !EMAIL_RE.test(v.email)) return fail('メールアドレスの形式が正しくありません。');
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
      father: clean(get('father')),
      fatherKana: clean(get('father-kana')),
      mother: clean(get('mother')),
      motherKana: clean(get('mother-kana')),
      car: cleanMultiline(get('car')),
    };
    const personRequired: [string, string][] = [
      [p.sei, 'お名前（姓）'], [p.mei, 'お名前（名）'], [p.seiKana, 'ふりがな（せい）'], [p.meiKana, 'ふりがな（めい）'],
      [p.gender, '性別'], [p.birthday, '生年月日'],
    ];
    for (const [value, label] of personRequired) {
      if (!value) return fail(`「${label}」を入力してください。${who}`);
    }
    if (Object.entries(p).some(([k, s]) => s.length > (k === 'car' ? 1000 : 200))) {
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
    if (extras.has('parents')) {
      if (!p.father && !p.mother) return fail(`父母のお名前を入力してください（どちらかお一人でも構いません）。${who}`);
      if (p.father && !p.fatherKana) return fail(`父のお名前のふりがなを入力してください。${who}`);
      if (p.mother && !p.motherKana) return fail(`母のお名前のふりがなを入力してください。${who}`);
    }
    // 父母のお名前は、Airtable の「父母の名前」に今までと同じ形でまとめて入れる（例: 父　高嶺　太郎（たかみね　たろう））
    const parents = [
      ...(p.father ? [`父　${p.father}（${p.fatherKana}）`] : []),
      ...(p.mother ? [`母　${p.mother}（${p.motherKana}）`] : []),
    ].join('\n');
    if (extras.has('car') && !p.car) return fail(`車名とナンバーを入力してください。${who}`);
    people.push({ ...p, parents, prayerNames, extras });
  }

  // ── 日時の確認 ──
  // 事前申し込み（年始・黒星祈願祭）：来社予定日だけを受け取り、時刻の枠は使わない
  if (advance) {
    if (v.method !== '来社') return fail('事前申し込みは、神社にお越しになる方が対象です。');
    if (!advanceDates().includes(v.date)) {
      return fail('選ばれた日の事前申し込みは締め切りました。当日、直接お越しください。', 400, { refresh: true });
    }
  }
  // 通常の予約（来社のみ。郵送は枠を使わない）
  const visiting = !advance && !reception && v.method === '来社';
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
  // 予約番号は1人に1つ（紙の申込書の通し番号にあたる）。続き番号で、代表者の番号を「予約グループ」として全員に入れる
  // 予約全体の初穂料（クレジットカードのお支払いの案内で、予約につき1回だけ伝える）
  const fee = feeSummary(people);
  // 当日受付：計算した金額を最初に入れておき、ご本人が増やせる（減らすことはできない）
  let total = fee.total;
  if (reception) {
    total = Number(digits(form.get('fee-total')));
    if (!total || total < fee.total) return fail(`初穂料は ${fee.total.toLocaleString('ja-JP')}円以上でご入力ください。`);
    if (total > 10_000_000) return fail('初穂料の金額をご確認ください。');
  }

  let start: number;
  try {
    start = (await lastWebNumber(env)) + 1;
  } catch (e) {
    console.error('reservation: 番号を決められなかった', e);
    return fail(UNAVAILABLE, 502, cause('番号の発行', e));
  }
  const numbersFrom = (first: number) => people.map((_, n) => formatWebNo(first + n));
  let numbers = numbersFrom(start);
  const reservationNo = () => numbers[0];

  // 神社へのお知らせメール用に、予約全体の詳しい内容を1つの文章にまとめる（代表者の行に入れる）。
  // 祈願内容ごとの欄（父母の名前、車など）も、入力のあった方の分をすべて載せる
  const multiple = people.length > 1;
  // ごきょうだいなどで前の方と同じ父母のお名前なら、繰り返さずに「（○人目と同じ）」と書く
  const parentsLine = (p: (typeof people)[number], n: number) => {
    const same = people.findIndex((q, k) => k < n && q.extras.has('parents') && q.parents === p.parents);
    return same >= 0 ? `父母の名前：（${same + 1}人目と同じ）` : `父母の名前：\n${p.parents}`;
  };
  const details = [
    ...(advance ? [`申込番号：${numbers[0]}`, `ご来社予定日：${storedDate(v.date)}`] : []),
    ...(reception ? [`受付番号：${numbers[0]}`, `当日受付：${storedDate(v.date)}`] : []),
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
      ...(p.extras.has('parents') ? [parentsLine(p, n)] : []),
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
    ...(reception ? [`お納めいただく初穂料：${total.toLocaleString('ja-JP')}円`] : []),
    `連絡事項：${v.message}`,
    ...(multiple && !advance && !reception ? ['', `予約番号：${numbers[0]}`] : []),
  ].join('\n');
  const rows = people.map((p, n) => {
    const fields: Record<string, unknown> = {
      名前: `${p.sei}　${p.mei}`,
      [F.status]: reception ? '予約確定' : advance ? '事前申込' : '仮予約',
      受付経路: reception ? '当日受付' : advance ? '事前申込' : 'Webフォーム',
      予約番号: numbers[n],
      予約グループ: numbers[0],
      代表者: n === 0,
      予約の初穂料合計: total,
      初穂料の内訳: total > fee.total ? `${fee.text}\nお納めいただく初穂料　${total.toLocaleString('ja-JP')}円` : fee.text,
      [F.date]: visiting || advance || reception ? storedDate(v.date) : '',
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

  // ほぼ同時に申し込みがあり、同じ番号が付いてしまった場合は、後から入った方の番号を付け直す
  try {
    records = await renumberIfTaken(env, records, numbers, (fixed) => {
      numbers = fixed;
    });
  } catch (e) {
    console.error('reservation: 番号の重なりの確認に失敗', e);
  }

  if (reception) return json({ ok: true, no: reservationNo(), total });
  return json(advance ? { ok: true, no: reservationNo() } : { ok: true });
};

