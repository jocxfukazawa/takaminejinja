/**
 * ご祈祷予約の送信先（Cloudflare Pages Functions）
 *
 * 1. Turnstile でボット判定
 * 2. 入力内容と、日時が空いているかを確認
 * 3. Airtable の予約の表に「仮予約」として書き込む
 *    （受付メールは Airtable の Automations が「受付経路 = Webフォーム」の行ができたときに送る）
 *
 * 環境変数は src/lib/airtable.ts と、Turnstile の TURNSTILE_SECRET_KEY。
 */

import {
  PHONE, PRAYERS, PRAYER_OTHER, SLOT_TIMES,
  bookableDates, isClosed, isValidBirthday, storedDate, type Extra,
} from '../../../src/lib/reservation';
import {
  F, closures, createRecord, deleteRecord, isConfigured, isFirstInSlot, takenSlots, type AirtableEnv,
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENDERS = ['男', '女', '回答しない'];
const METHODS = ['来社', '郵送'];
const PAYMENTS = ['当日ご社頭でお納め', '事前にクレジットカードでお納め'];

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!isConfigured(env) || !env.TURNSTILE_SECRET_KEY) {
    console.error('reservation: 環境変数が設定されていません');
    return fail(UNAVAILABLE, 500);
  }

  const form = await request.formData();

  // 人には見えない項目に入力があればボットとみなし、成功したふりをする
  if (clean(form.get('website'))) return json({ ok: true });

  const token = String(form.get('cf-turnstile-response') ?? '');
  if (!token || !(await verifyTurnstile(token, env.TURNSTILE_SECRET_KEY, request.headers.get('CF-Connecting-IP')))) {
    return fail('認証に失敗しました。ページを再読み込みして、もう一度お試しください。');
  }

  // ── 入力の確認 ──
  const v = {
    sei: clean(form.get('sei')),
    mei: clean(form.get('mei')),
    seiKana: clean(form.get('sei-kana')),
    meiKana: clean(form.get('mei-kana')),
    special: clean(form.get('special')),
    gender: clean(form.get('gender')),
    birthday: clean(form.get('birthday')),
    zip: digits(form.get('zip')),
    address: cleanMultiline(form.get('address')),
    building: clean(form.get('building')),
    tel: digits(form.get('tel')),
    email: clean(form.get('email')),
    prayer: clean(form.get('prayer')),
    prayerOther: clean(form.get('prayer-other')),
    method: clean(form.get('method')),
    date: clean(form.get('date')),
    time: clean(form.get('time')),
    payment: clean(form.get('payment')),
    haraobi: clean(form.get('haraobi')),
    parents: cleanMultiline(form.get('parents')),
    siblings: cleanMultiline(form.get('siblings')),
    car: cleanMultiline(form.get('car')),
    message: cleanMultiline(form.get('message')),
  };

  const required: [string, string][] = [
    [v.sei, 'お名前（姓）'], [v.mei, 'お名前（名）'], [v.seiKana, 'ふりがな（せい）'], [v.meiKana, 'ふりがな（めい）'],
    [v.gender, '性別'], [v.birthday, '生年月日'], [v.address, '住所'], [v.tel, '電話番号'], [v.email, 'メールアドレス'],
    [v.prayer, 'ご祈願内容'], [v.method, 'ご祈祷方法'], [v.payment, '初穂料の納め方'],
  ];
  for (const [value, label] of required) {
    if (!value) return fail(`「${label}」を入力してください。`);
  }
  const tooLong = Object.entries(v).find(([k, s]) => s.length > (['address', 'parents', 'siblings', 'car', 'message'].includes(k) ? 2000 : 200));
  if (tooLong) return fail('入力された内容が長すぎます。');
  if (!GENDERS.includes(v.gender)) return fail('性別を選んでください。');
  if (!isValidBirthday(v.birthday)) return fail('生年月日を正しく入力してください。');
  if (v.zip && v.zip.length !== 7) return fail('郵便番号は7桁の数字で入力してください。');
  if (v.tel.length < 10 || v.tel.length > 11) return fail('電話番号を正しく入力してください。');
  if (!EMAIL_RE.test(v.email)) return fail('メールアドレスの形式が正しくありません。');
  if (!METHODS.includes(v.method)) return fail('ご祈祷方法を選んでください。');
  if (!PAYMENTS.includes(v.payment)) return fail('初穂料の納め方を選んでください。');

  const prayer = PRAYERS.find((p) => p.name === v.prayer);
  if (!prayer && v.prayer !== PRAYER_OTHER) return fail('ご祈願内容を選んでください。');
  if (v.prayer === PRAYER_OTHER && !v.prayerOther) return fail('ご祈願内容（その他）を入力してください。');
  const extras = new Set<Extra>(prayer?.extras ?? []);
  if (extras.has('haraobi') && !['あり', 'なし'].includes(v.haraobi)) return fail('腹帯のお祓いの有無を選んでください。');
  if (extras.has('parents') && !v.parents) return fail('父母のお名前を入力してください。');
  if (extras.has('car') && !v.car) return fail('車名とナンバーを入力してください。');

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
      return fail(UNAVAILABLE, 502);
    }
  }

  // ── Airtable へ書き込む（項目名は Google フォームから取り込んでいたときと同じ） ──
  const fields: Record<string, unknown> = {
    名前: `${v.sei}　${v.mei}`,
    [F.status]: '仮予約',
    受付経路: 'Webフォーム',
    [F.date]: visiting ? storedDate(v.date) : '',
    [F.time]: visiting ? v.time : '',
    ふりがな: `${v.seiKana}　${v.meiKana}`,
    名前の特殊文字: v.special,
    性別: v.gender,
    生年月日: v.birthday.replace(/-/g, '/'),
    郵便番号: v.zip,
    住所: v.address,
    建物名等: v.building,
    電話番号: v.tel,
    メールアドレス: v.email,
    御祈祷内容: prayer ? prayer.name : v.prayerOther,
    [F.method]: v.method,
    納入方法: v.payment,
    腹帯のお祓い: extras.has('haraobi') ? v.haraobi : '',
    父母の名前: extras.has('parents') ? v.parents : '',
    兄弟姉妹: extras.has('siblings') ? v.siblings : '',
    '車名・ナンバー': extras.has('car') ? v.car : '',
    連絡事項: v.message,
  };
  // 空の項目は送らない（単一選択に空の選択肢ができないように）
  for (const k of Object.keys(fields)) if (fields[k] === '') delete fields[k];

  let record;
  try {
    record = await createRecord(env, fields);
  } catch (e) {
    console.error('reservation: Airtable への書き込みに失敗', e);
    return fail(UNAVAILABLE, 502);
  }

  // ほぼ同時に同じ枠へ申し込みがあった場合は、先に入った方を残す
  if (visiting) {
    try {
      if (!(await isFirstInSlot(env, record, slot))) {
        await deleteRecord(env, record.id);
        return fail(SLOT_TAKEN, 409, { refresh: true });
      }
    } catch (e) {
      // 確認できなくても予約は入っている。重なっていれば神社の確認の段階で調整する
      console.error('reservation: 重複の確認に失敗', e);
    }
  }

  return json({ ok: true });
};
