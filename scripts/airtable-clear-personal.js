/**
 * 予約受付の表から、古い行の個人情報を消す（Airtable のオートメーションの「Run script」に貼り付けて使う）
 *
 * 対象：予約ステータスが「登録完了」「キャンセル」「仮予約」で、御祈祷日から2年が過ぎた行
 *   （御祈祷日が空の行＝郵送などは、受付日時から2年が過ぎた行）
 *   （登録完了の行は、台帳＝世帯・会社／個人／御祈祷・御供 に写し終わっているので、ここにあるのは写し）
 * 空にする：名前・ふりがな・生年月日・住所・電話番号・メールアドレスなど、ご本人が分かる項目
 * 残す：予約番号・予約グループ・御祈祷日・御祈祷内容・予約ステータス・受付経路・初穂料など（件数の集計に使える）
 *   予約番号は、Web の予約の続き番号を決めるのに使うので、必ず残す
 * 消した行には「個人情報を消した日」に今日の日付を入れる（その行は次から対象にしない）
 *
 * 最初は DRY_RUN = true のまま「Test」で動かし、消す予定の件数と行を確かめる。
 * 確かめたら DRY_RUN = false にして保存し、オートメーションを ON にする。
 * 消した項目は元に戻せない。
 */

// ── 設定 ──
const DRY_RUN = true; // true：消さずに、消す予定の行を出すだけ。false：本当に消す
const TABLE = '予約受付';
const YEARS = 2; // 御祈祷日から何年過ぎたら消すか
const STATUSES = ['登録完了', 'キャンセル', '仮予約'];
const DATE_FIELD = '御祈祷日';
const CREATED_FIELD = '受付日時'; // 「Created time」の項目（御祈祷日が空の行に使う）
const STATUS_FIELD = '予約ステータス';
const DONE_FIELD = '個人情報を消した日'; // 日付の項目を、前もって作っておく
const CLEAR_FIELDS = [
  '名前', 'ふりがな', '名前の特殊文字', '生年月日',
  '郵便番号', '住所', '建物名等', '電話番号', 'メールアドレス',
  '父母の名前', '車名・ナンバー', '連絡事項', '予約の詳細',
];

// ── ここから下は変えない ──
const table = base.getTable(TABLE);
const names = new Set(table.fields.map((f) => f.name));
const hasCreated = names.has(CREATED_FIELD);
if (!hasCreated) console.log(`「${CREATED_FIELD}」の項目がないので、御祈祷日が空の行は対象にしません。`);
if (!names.has(DONE_FIELD)) throw new Error(`「${DONE_FIELD}」の項目（日付）を、${TABLE}の表に作ってください。`);
const clear = CLEAR_FIELDS.filter((n) => names.has(n));
const missing = CLEAR_FIELDS.filter((n) => !names.has(n));
if (missing.length) console.log(`表にない項目（飛ばします）：${missing.join('、')}`);

// 日本時間の今日と、その2年前の日付（YYYY-MM-DD）
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const [y, m, d] = today.split('-').map(Number);
const limit = `${y - YEARS}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** 御祈祷日（「2026/11/21 (土)」「2026-11-21」「2026/1/9」など）を YYYY-MM-DD にする */
const dateKey = (v) => {
  const s = typeof v === 'string' ? v : v ? String(v) : '';
  const mm = s.match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
  return mm ? `${mm[1]}-${mm[2].padStart(2, '0')}-${mm[3].padStart(2, '0')}` : null;
};
const statusOf = (r) => {
  const v = r.getCellValue(STATUS_FIELD);
  return v && typeof v === 'object' ? v.name : String(v ?? '');
};

/** 受付日時（UTC の日時）を、日本時間の日付 YYYY-MM-DD にする */
const createdKey = (r) => {
  const v = hasCreated ? r.getCellValue(CREATED_FIELD) : null;
  const t = v ? Date.parse(String(v)) : NaN;
  return Number.isNaN(t) ? null : new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10);
};

const query = await table.selectRecordsAsync({
  fields: [DATE_FIELD, STATUS_FIELD, DONE_FIELD, '予約番号', ...(hasCreated ? [CREATED_FIELD] : []), ...clear],
});
const targets = [];
let noDate = 0;
for (const r of query.records) {
  if (r.getCellValue(DONE_FIELD)) continue; // もう消した行
  if (!STATUSES.includes(statusOf(r))) continue;
  // 御祈祷日。空なら受付日時
  const key = dateKey(r.getCellValueAsString(DATE_FIELD)) ?? createdKey(r);
  if (!key) {
    noDate++;
    continue;
  }
  // その日がちょうど2年前の日より前（2年が過ぎた）の行
  if (key < limit) targets.push({ r, key });
}

console.log(`今日：${today}　対象：御祈祷日（空なら受付日時）が ${limit} より前で、${STATUSES.join('・')}の行`);
console.log(`個人情報を消す行：${targets.length}件${DRY_RUN ? '（試し運転なので、まだ消していません）' : ''}`);
if (noDate) console.log(`御祈祷日も受付日時も分からない行：${noDate}件は、対象にしていません。`);
for (const { r, key } of targets.slice(0, 50)) {
  console.log(`${key}　${statusOf(r)}　${r.getCellValueAsString('予約番号') || '（番号なし）'}　${r.getCellValueAsString('名前')}`);
}
if (targets.length > 50) console.log(`…ほか ${targets.length - 50}件`);

if (!DRY_RUN && targets.length) {
  const blank = Object.fromEntries(clear.map((n) => [n, null]));
  const updates = targets.map(({ r }) => ({ id: r.id, fields: { ...blank, [DONE_FIELD]: today } }));
  // 一度に50行ずつ書き換える
  for (let i = 0; i < updates.length; i += 50) {
    await table.updateRecordsAsync(updates.slice(i, i + 50));
  }
  console.log(`${updates.length}件の個人情報を消しました。`);
}
output.set('count', targets.length);
