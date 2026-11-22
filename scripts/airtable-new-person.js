/**
 * 予約受付の「新規登録」ボタン：新しい方の「個人」と「世帯・会社」を作り、予約受付の行に ID を書き戻す
 * （Airtable のオートメーション「When a button is clicked」→「Run script」に貼り付けて使う）
 *
 * 「IDチェック」も兼ねる。どの予約でもこのボタンを押せばよい（すでにいる方は作らず、ID を書き戻すだけ）。
 * 押した行と、同じ予約グループのご家族をまとめて扱う（キャンセルの行は除く）。
 *   - すでにいる方（名前＋生年月日が同じ）は、その方と、その方自身の世帯の ID を書き戻す。
 *     会社・団体にだけつながっている方は、団体の代表としての登録なので、ご本人としては使わない。
 *   - 世帯：同じ予約の中で、住所（＋建物名等）が同じ方は1つの世帯にまとめる。
 *       1) その住所の方に、すでに既存世帯IDが入っていれば、その世帯を使う
 *       2) 世帯・会社の表に、同じ住所の世帯が1つだけあれば、その世帯を使う（2つ以上あれば、作らずに知らせる）
 *          種類が「会社・団体」の行は、住所が同じでも使わない（ご自宅を連絡先にしている団体など）
 *       3) どれもなければ、新しく作る（世帯・会社名・ふりがな・郵便番号・住所・建物名等・電話番号）
 *   - 個人：既存個人IDが空の方だけ作る（姓・名・ふりがな・性別・生年月日・元号/年/月/日、代表の方は電話番号）。
 *       続柄は空のまま（後で手で入れる）。
 *       作る前に、同じ名前・同じ生年月日の方が個人の表にいないか調べる。いれば作らず、その方の ID を使う。
 *   - 最後に、予約受付の行の「既存個人ID」「既存世帯ID」に、作った（見つけた）方の ID を書き戻す。
 *     予約ステータスは変えない。確かめてから、いつもどおり「登録完了」にする。
 *   - 七五三詣・初宮詣など「父母の名前」が入っている予約：
 *       新しい世帯は父の名前で作り（父の名前がなければ母）、父・母も個人として作って同じ世帯につなぐ。
 *       使う世帯が今ある世帯なら、その世帯に同じ名前の方がいれば、その方は作らない。
 *       電話番号は、子ではなく父（いなければ母）の個人に入れる。
 *   - そのほかの新しい世帯の名前は、代表の方の名前にする。
 *   - 転居：すでにいる方の世帯の住所と、この行の住所が違えば「要確認」にして知らせる（ID は書き戻す）。
 *       この行の「世帯の住所を更新」にチェックを入れて押し直すと、その世帯の住所などを書き換える（世帯の全員の住所が変わる）。
 *   - 生年月日：「生年月日」が空で、元号・年・月・日が入っていれば、そこから読み、「生年月日」にも書き戻す（紙の申込書の分）。
 *   - 生年月日が分からない方は、名前と住所で探す（同じ名前の方が、同じ住所の世帯に1人だけいれば、その方を使う）。
 *   - 名前だけ同じ方（生年月日が違う・空）が個人の表にいれば、何も作らずに止めて知らせる。
 *       同じ方なら、既存個人IDを手で入れる（または IDチェック）。
 *       別人だと確かめたときは、予約受付の行の「同姓同名の別人として登録」にチェックを入れて、もう一度押す
 *       （父・母は、代表の方の行のチェックで判断する）。
 *
 * 入力（Input variables）：recordId ＝ トリガーの「Airtable record ID」
 * DRY_RUN = true のあいだは、何も作らずに、作る予定だけを出す。
 */

// ── 設定 ──
const DRY_RUN = true; // true：作らずに、作る予定だけ出す。false：本当に作る

const T_RESERVE = '予約受付';
const T_PERSON = '個人';
const T_HOUSE = '世帯・会社';

// 予約受付の項目
const R = {
  name: '名前', kana: 'ふりがな', gender: '性別', birth: '生年月日',
  zip: '郵便番号', address: '住所', building: '建物名等', tel: '電話番号',
  group: '予約グループ', rep: '代表者', status: '予約ステータス',
  personId: '既存個人ID', houseId: '既存世帯ID', parents: '父母の名前',
  // 名前だけ同じ方が個人の表にいても、別人として作ってよいときにチェックを入れる項目（チェックボックス）
  allow: '同姓同名の別人として登録',
  // 転居：チェックを入れて押すと、その方の世帯の住所・建物名等・郵便番号・電話番号を、この行の内容に書き換える（チェックボックス）
  updateAddr: '世帯の住所を更新',
  // 紙の申込書から入れるときの生年月日（和暦）。「生年月日」が空なら、ここから読む
  era: '元号', y: '年', m: '月', d: '日',
};
// 個人の項目
const P = {
  sei: '姓', mei: '名', seiKana: '姓（ふりがな）', meiKana: '名（ふりがな）',
  gender: '性別', birth: '生年月日', era: '元号', y: '年', m: '月', d: '日',
  tel: '電話番号', house: '世帯ID',
};
// 世帯・会社の項目
const H = {
  name: '世帯・会社名', kana: '世帯・会社名（ふりがな）', kind: '世帯・会社の種類',
  zip: '郵便番号', address: '住所', building: '建物名等', tel: '電話番号',
};
const SKIP_STATUS = ['キャンセル'];

// ── ここから下は変えない ──
const { recordId } = input.config();
const reserve = base.getTable(T_RESERVE);
const person = base.getTable(T_PERSON);
const house = base.getTable(T_HOUSE);

// ── 結果を、押した行に書き込む（インターフェースのその行の画面で読めるように） ──
const RESULT_FIELD = '確認・登録の結果'; // 長い文字（Long text）
const STATE_FIELD = '確認・登録の状態'; // 単一選択（完了・要確認・エラー・試し運転）。なくてもよい
const logs = [];
const log = (m) => { logs.push(String(m)); console.log(m); };
let state = '';
const GUIDE = {
  完了: '個人・世帯の確認が終わりました。中身がよければ、予約ステータスを「登録完了」にしてください。',
  要確認: '止まったか、手で確かめることがあります。下の ⛔・⚠ の行を読んで直してから、もう一度「確認・登録」を押してください。',
  試し運転: '試し運転なので、まだ何も作っていません。',
  エラー: 'スクリプトが途中で止まりました。下の内容を読んでください。',
};
const writeResult = async () => {
  const names = new Set(reserve.fields.map((f) => f.name));
  const when = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ').replace(/-/g, '/');
  const fields = {};
  if (names.has(RESULT_FIELD)) fields[RESULT_FIELD] = [`【${state}】${when}`, GUIDE[state] ?? '', '', ...logs].join('\n');
  const sf = reserve.fields.find((f) => f.name === STATE_FIELD);
  if (sf && (sf.options?.choices ?? []).some((c) => c.name === state)) fields[STATE_FIELD] = { name: state };
  if (Object.keys(fields).length) await reserve.updateRecordAsync(recordId, fields);
  else console.log(`（結果を書き込む「${RESULT_FIELD}」の項目が、予約受付の表にありません）`);
};

try {

/** 表にない項目を、まとめて知らせる */
const check = (table, map, required) => {
  const names = new Set(table.fields.map((f) => f.name));
  const missing = required.map((k) => map[k]).filter((n) => !names.has(n));
  if (missing.length) throw new Error(`「${table.name}」の表に、次の項目がありません：${missing.join('、')}`);
  return (k) => names.has(map[k]);
};
check(reserve, R, ['name', 'birth', 'address', 'personId', 'houseId']);
const hasP = check(person, P, ['sei', 'mei', 'house']);
const hasH = check(house, H, ['address']);
const hasR = check(reserve, R, ['name']);

/** いちばん左の項目（ID）。空の行は Airtable が「Unnamed record」と返すので、空にする */
const idOf = (r) => (r && r.name && r.name !== 'Unnamed record' ? r.name : '');
const str = (r, f) => (f ? r.getCellValueAsString(f).trim() : '');
/** 比べるための文字（全角・半角、空白、ハイフンの違いをならす） */
const norm = (s) => String(s ?? '').normalize('NFKC').replace(/[\s　]/g, '').replace(/[‐‑‒–—―−ーｰ-]/g, '-').toLowerCase();
const splitName = (s) => {
  const parts = String(s ?? '').trim().split(/[\s　]+/);
  return parts.length >= 2 ? [parts[0], parts.slice(1).join('　')] : [parts[0] ?? '', ''];
};

/** 生年月日（「1980/01/02」「1980-1-2」「昭和55年1月2日」など）を YYYY-MM-DD にする */
const ERAS = [
  ['令和', 2019, '2019-05-01'], ['平成', 1989, '1989-01-08'], ['昭和', 1926, '1926-12-25'],
  ['大正', 1912, '1912-07-30'], ['明治', 1868, '1868-01-25'],
];
const birthKey = (s) => {
  const t = String(s ?? '').normalize('NFKC');
  let m = t.match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = t.match(/(令和|平成|昭和|大正|明治)\s*(元|\d{1,2})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) {
    const era = ERAS.find((e) => e[0] === m[1]);
    const y = era[1] + (m[2] === '元' ? 1 : Number(m[2])) - 1;
    return `${y}-${m[3].padStart(2, '0')}-${m[4].padStart(2, '0')}`;
  }
  return null;
};
/** 予約受付の行の生年月日：「生年月日」、なければ元号・年・月・日（和暦） */
const rowBirth = (r) => {
  const b = birthKey(str(r, R.birth));
  if (b) return { key: b, fromParts: false };
  if (!hasR('era') || !hasR('y')) return { key: null };
  const era = ERAS.find((e) => e[0] === str(r, R.era));
  const y = Number(String(str(r, R.y)).normalize('NFKC').replace('元', '1'));
  const m = Number(str(r, hasR('m') ? R.m : null));
  const d = Number(str(r, hasR('d') ? R.d : null));
  if (!era || !y || !m || !d) return { key: null };
  return { key: `${era[1] + y - 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, fromParts: true };
};
/** YYYY-MM-DD → [元号, 年, 月, 日] */
const toEra = (key) => {
  const era = ERAS.find((e) => key >= e[2]);
  if (!era) return null;
  const [y, m, d] = key.split('-').map(Number);
  return [era[0], y - era[1] + 1, m, d];
};

/** 単一選択の選択肢から、合うものを選ぶ（なければ null） */
const choice = (table, fieldName, want) => {
  const f = table.fields.find((x) => x.name === fieldName);
  const opts = f?.options?.choices ?? [];
  for (const w of want) {
    const hit = opts.find((o) => o.name === w);
    if (hit) return { name: hit.name };
  }
  return null;
};
const GENDER = { 男性: ['男', '男性'], 男: ['男', '男性'], 女性: ['女', '女性'], 女: ['女', '女性'], その他: ['その他'] };
const kindChoice = (() => {
  const f = house.fields.find((x) => x.name === H.kind);
  const opts = f?.options?.choices ?? [];
  const hit = opts.find((o) => o.name === '世帯') ?? opts.find((o) => o.name.includes('世帯') && !o.name.includes('会社'))
    ?? opts.find((o) => o.name.includes('個人'));
  return hit ? { name: hit.name } : null;
})();

/** 書き込める項目か（数式などは書き込めない） */
const writable = (table, name) => {
  const f = table.fields.find((x) => x.name === name);
  return !!f && !['formula', 'rollup', 'lookup', 'multipleLookupValues', 'autoNumber', 'createdTime', 'lastModifiedTime', 'count'].includes(f.type);
};
/** 父母の名前（「父　高嶺　太郎（たかみね　たろう）」の行が並んだもの）を読む */
const parseParents = (text) => {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.trim().match(/^(父|母)[\s\u3000:：]*([^（(]+?)\s*(?:[（(]([^）)]*)[）)])?\s*$/);
    if (!m) continue;
    const [sei, mei] = splitName(m[2]);
    const [seiKana, meiKana] = splitName(m[3] ?? '');
    if (sei) out.push({ role: m[1], sei, mei, seiKana, meiKana });
  }
  return out;
};

// ── 押した行と、同じ予約グループの行 ──
const rFields = Object.keys(R).filter((k) => hasR(k)).map((k) => R[k]);
const all = await reserve.selectRecordsAsync({ fields: rFields });
const clicked = all.getRecord(recordId);
if (!clicked) throw new Error('押した行が見つかりません。');
const groupNo = str(clicked, hasR('group') ? R.group : null);
const rows = (groupNo ? all.records.filter((r) => str(r, R.group) === groupNo) : [clicked])
  .filter((r) => !SKIP_STATUS.includes(str(r, hasR('status') ? R.status : null)));
const repRow = rows.find((r) => hasR('rep') && r.getCellValue(R.rep)) ?? rows[0];
log(`予約グループ：${groupNo || '（なし）'}　${rows.length}名`);

// ── 今ある個人・世帯 ──
// いちばん左の項目（ID）も読むため、項目をしぼらずに読む
const pAll = await person.selectRecordsAsync();
const hAll = await house.selectRecordsAsync();
const houseByName = new Map(hAll.records.filter(idOf).map((h) => [idOf(h), h]));
/** 会社・団体の行は、住所が同じでもご家族の世帯にしない */
const isCompany = (h) => !!h && hasH('kind') && /会社|団体/.test(h.getCellValueAsString(H.kind));
/** その方自身の世帯（会社・団体でない、つながっている世帯） */
const ownHouseOf = (p) => (p.getCellValue(P.house) ?? []).map((l) => hAll.getRecord(l.id)).find((h) => h && !isCompany(h)) ?? null;
/** 会社・団体にだけつながっている方（団体の代表としての登録。ご本人としては使わない） */
const companyOnly = (p) => { const hs = (p.getCellValue(P.house) ?? []).map((l) => hAll.getRecord(l.id)).filter(Boolean); return hs.length > 0 && hs.every(isCompany); };
const personKey = (sei, mei, birth) => `${norm(sei)}${norm(mei)}|${birth ?? ''}`;
const personIndex = new Map();
/** 名前だけの索引（名前だけ同じ方を見つけて止めるため） */
const nameIndex = new Map();
for (const p of pAll.records) {
  const nk = `${norm(p.getCellValueAsString(P.sei))}${norm(p.getCellValueAsString(P.mei))}`;
  if (nk) nameIndex.set(nk, [...(nameIndex.get(nk) ?? []), p]);
  // 日付の項目は、表示の形（2026/1/2、1/2/2026 など）によらず YYYY-MM-DD で読む
  const raw = hasP('birth') ? p.getCellValue(P.birth) : null;
  const b = raw ? birthKey(typeof raw === 'string' ? raw : p.getCellValueAsString(P.birth)) : null;
  if (!b || companyOnly(p)) continue;
  const k = personKey(p.getCellValueAsString(P.sei), p.getCellValueAsString(P.mei), b);
  personIndex.set(k, [...(personIndex.get(k) ?? []), p]);
}
/** 名前だけ同じ方の説明（ID・生年月日・世帯） */
const describe = (p) => {
  const raw = hasP('birth') ? p.getCellValue(P.birth) : null;
  const b = raw ? birthKey(typeof raw === 'string' ? raw : p.getCellValueAsString(P.birth)) : null;
  const h = (p.getCellValue(P.house) ?? []).map((l) => idOf(hAll.getRecord(l.id)) || l.name).filter(Boolean).join('・');
  return `${idOf(p) || p.id}（生年月日 ${b ?? '空'}${h ? `、世帯 ${h}` : ''}）`;
};
const allowed = (r) => hasR('allow') && !!r.getCellValue(R.allow);
/** 名前だけ同じ方がいて、別人のチェックもないので止める理由 */
const blocks = [];

/**
 * 住所を比べるための形にそろえる。書き方の違いで別の住所とみなさないように：
 *   都道府県・「〇〇郡」を外す（「赤穂郡上郡町…」と「上郡町…」を同じにする）、「大字」を外す、
 *   漢数字の丁目・番地を数字に、「丁目・番地・番・号・の」をハイフンに、「ヶ・ケ」をそろえる、全角・半角・空白をそろえる
 */
const KANJI_NUM = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const kanjiToNum = (k) => {
  if (!k.includes('十')) return Number([...k].map((c) => KANJI_NUM[c]).join(''));
  const [a, b] = k.split('十');
  return (a ? KANJI_NUM[a] : 1) * 10 + (b ? KANJI_NUM[b] : 0);
};
const addrKey = (address, building = '') => {
  let s = norm(`${address}${building}`);
  s = s.replace(/^(東京都|北海道|京都府|大阪府|.{2,3}県)/, '');
  s = s.replace(/^[^0-9-]{2,5}?郡/, ''); // 郡の名前は2字以上（「上郡町」の「上郡」は外さない）
  s = s.replace(/大字/g, '').replace(/[ヶヵケ]/g, 'ケ');
  s = s.replace(/([〇一二三四五六七八九十]+)(?=丁目|番地|番|号)/g, (k) => String(kanjiToNum(k)));
  s = s.replace(/([0-9]+)丁目/g, '$1-').replace(/([0-9]+)番地?/g, '$1-').replace(/([0-9]+)号/g, '$1');
  s = s.replace(/([0-9])の(?=[0-9])/g, '$1-').replace(/-+/g, '-').replace(/-$/, '').replace(/-(?=[^0-9])/g, '');
  return s;
};
const addrOf = (r, a, b) => addrKey(r.getCellValueAsString(a), b ? r.getCellValueAsString(b) : '');
const housesByAddr = new Map();
/** 建物名を除いた住所での索引（片方に建物名がないときに使う） */
const housesByStreet = new Map();
for (const h of hAll.records) {
  if (isCompany(h)) continue;
  const k = addrOf(h, H.address, hasH('building') ? H.building : null);
  if (k) housesByAddr.set(k, [...(housesByAddr.get(k) ?? []), h]);
  const k2 = addrKey(h.getCellValueAsString(H.address));
  if (k2) housesByStreet.set(k2, [...(housesByStreet.get(k2) ?? []), h]);
}

/** 元号・年・月・日から読んだ生年月日を、予約受付の「生年月日」に書き戻す行 */
const birthBack = new Map();
const birthField = reserve.fields.find((f) => f.name === R.birth);
const birthValue = (key) => (birthField?.type === 'date' ? key : key.replace(/-/g, '/'));

// ── 住所ごとに分けて、世帯を決める ──
const plan = []; // { row, houseRec | houseNew, personRec | personNew }
const problems = [];
const byAddr = new Map();
for (const r of rows) {
  const k = addrOf(r, R.address, hasR('building') ? R.building : null);
  byAddr.set(k, [...(byAddr.get(k) ?? []), r]);
}

for (const [addr, members] of byAddr) {
  // 個人：既存個人IDが空の方は、同じ名前・生年月日の方を探す
  const people = members.map((r) => {
    const pid = str(r, R.personId);
    if (pid) { const rb0 = rowBirth(r); return { r, existing: true, birth: rb0.key, birthFromParts: rb0.fromParts }; }
    const [sei, mei] = splitName(str(r, R.name));
    const rb = rowBirth(r);
    const birth = rb.key;
    let found = birth ? personIndex.get(personKey(sei, mei, birth)) ?? [] : [];
    // 生年月日が分からない方は、名前と住所で探す（同じ住所の世帯にいる、同じ名前の方）
    if (!birth && !found.length) {
      const rAddr = addrKey(str(r, R.address));
      const byAddr2 = rAddr ? (nameIndex.get(`${norm(sei)}${norm(mei)}`) ?? []).filter((p) => {
        const h = ownHouseOf(p);
        return h && addrKey(h.getCellValueAsString(H.address)) === rAddr;
      }) : [];
      if (byAddr2.length === 1) {
        found = byAddr2;
        log(`${sei}　${mei}：生年月日がないので、名前と住所で見つけました（${idOf(byAddr2[0])}）`);
      } else if (byAddr2.length > 1) {
        problems.push(`${sei}　${mei}：同じ名前の方が、同じ住所の世帯に${byAddr2.length}人います。既存個人IDを手で入れてください。`);
        found = byAddr2;
      }
    }
    if (found.length > 1) problems.push(`${sei}　${mei}：同じ名前・生年月日の方が個人の表に${found.length}人います。既存個人IDを手で入れてください。`);
    if (!found.length) {
      const same = nameIndex.get(`${norm(sei)}${norm(mei)}`) ?? [];
      if (same.length && !allowed(r)) {
        blocks.push(`${sei}　${mei}：名前が同じ方が個人の表にいます → ${same.map(describe).join('、')}`);
      }
    }
    return { r, sei, mei, birth, birthFromParts: rb.fromParts, found: found.length === 1 ? found[0] : null, skip: found.length > 1 };
  });

  for (const p of people) if (p.birthFromParts && p.birth && !str(p.r, R.birth)) birthBack.set(p.r.id, birthValue(p.birth));

  // 父母（七五三詣・初宮詣など）
  const parents = parseParents(members.map((r) => str(r, hasR('parents') ? R.parents : null)).find(Boolean));
  const headParent = parents.find((x) => x.role === '父') ?? parents.find((x) => x.role === '母') ?? null;

  // 世帯：1) 既存世帯IDが入っている方  2) 見つかった個人の世帯  3) 同じ住所の世帯  4) 新しく作る
  let houseRec = null;
  for (const r of members) {
    const hid = str(r, R.houseId);
    if (hid && houseByName.get(hid)) { houseRec = houseByName.get(hid); break; }
  }
  if (!houseRec) {
    // 見つかった個人の世帯（会社・団体の行は使わない）
    const linked = people.map((p) => p.found?.getCellValue(P.house)?.[0]).find((l) => l && !isCompany(hAll.getRecord(l.id)));
    if (linked) houseRec = hAll.getRecord(linked.id);
  }
  let houseNew = null;
  let noHouse = false;
  if (!houseRec) {
    let same = addr ? housesByAddr.get(addr) ?? [] : [];
    // 見つからず、どちらかに建物名がないときは、建物名を除いた住所で探す
    if (!same.length && addr) {
      const rowBuilding = hasR('building') ? str(members[0], R.building) : '';
      same = (housesByStreet.get(addrKey(str(members[0], R.address))) ?? [])
        .filter((h) => !rowBuilding || !(hasH('building') && h.getCellValueAsString(H.building).trim()));
      if (same.length === 1) log(`建物名を除いた住所で、同じ世帯を見つけました：${idOf(same[0])}`);
    }
    if (same.length === 1 && !idOf(same[0])) {
      problems.push(`住所「${str(members[0], R.address)}」の世帯が見つかりましたが、その世帯の ID が空です（レコードID ${same[0].id}）。世帯・会社の表でその行を確かめてから、もう一度押してください。`);
      continue;
    } else if (same.length === 1) {
      houseRec = same[0];
      log(`同じ住所の世帯が見つかりました：${idOf(houseRec)}`);
    } else if (same.length > 1) {
      problems.push(`住所「${str(members[0], R.address)}」の世帯が${same.length}つあります（${same.map((h) => idOf(h) || `ID が空：${h.id}`).join('、')}）。既存世帯IDを手で入れてから、もう一度押してください。`);
      continue;
    } else if (!addr) {
      // 住所が空：すでにいる方は ID を書き戻せるが、新しい世帯・個人は作れない
      noHouse = true;
    } else {
      const src = members.includes(repRow) ? repRow : members[0];
      // 世帯の名前：父母の名前があれば父（いなければ母）、なければ代表の方
      const head = headParent ?? { ...Object.fromEntries(['sei', 'mei'].map((k, i) => [k, splitName(str(src, R.name))[i]])),
        ...Object.fromEntries(['seiKana', 'meiKana'].map((k, i) => [k, splitName(str(src, hasR('kana') ? R.kana : null))[i]])) };
      const headName = [head.sei, head.mei].filter(Boolean).join('　');
      const headKana = [head.seiKana, head.meiKana].filter(Boolean).join('　');
      houseNew = {
        ...(writable(house, H.name) && headName ? { [H.name]: headName } : {}),
        [H.address]: str(src, R.address),
        ...(hasH('building') && hasR('building') ? { [H.building]: str(src, R.building) } : {}),
        ...(hasH('zip') && hasR('zip') ? { [H.zip]: str(src, R.zip) } : {}),
        ...(hasH('tel') && hasR('tel') ? { [H.tel]: str(src, R.tel) } : {}),
        ...(hasH('kana') && headKana ? { [H.kana]: headKana } : {}),
        ...(kindChoice ? { [H.kind]: kindChoice } : {}),
      };
    }
  }

  for (const p of people) {
    if (p.existing || p.skip) { plan.push({ row: p.r, houseRec, houseNew, keepPerson: true }); continue; }
    if (p.found) { plan.push({ row: p.r, houseRec, houseNew, personRec: p.found }); continue; }
    if (!p.sei) { problems.push('名前が空の行があります。'); continue; }
    if (noHouse) { problems.push(`${p.sei}　${p.mei}：個人の表に見つからず、住所も空なので、作れません。住所を入れるか、既存世帯ID を入れてから、もう一度押してください。`); continue; }
    const [seiKana, meiKana] = splitName(str(p.r, hasR('kana') ? R.kana : null));
    const fields = {
      [P.sei]: p.sei, [P.mei]: p.mei,
      ...(hasP('seiKana') && seiKana ? { [P.seiKana]: seiKana } : {}),
      ...(hasP('meiKana') && meiKana ? { [P.meiKana]: meiKana } : {}),
    };
    const g = choice(person, P.gender, GENDER[str(p.r, hasR('gender') ? R.gender : null)] ?? []);
    if (hasP('gender') && g) fields[P.gender] = g;
    if (p.birth) {
      if (hasP('birth')) fields[P.birth] = p.birth;
      const era = toEra(p.birth);
      const eraChoice = era && hasP('era') ? choice(person, P.era, [era[0]]) : null;
      if (eraChoice) {
        fields[P.era] = eraChoice;
        if (hasP('y')) fields[P.y] = era[1];
        if (hasP('m')) fields[P.m] = era[2];
        if (hasP('d')) fields[P.d] = era[3];
      }
    } else {
      log(`${p.sei}　${p.mei}：生年月日が分からないので、空のまま作ります。`);
    }
    if (!headParent && p.r === repRow && hasP('tel') && hasR('tel') && str(p.r, R.tel)) fields[P.tel] = str(p.r, R.tel);
    plan.push({ row: p.r, houseRec, houseNew, personNew: fields });
  }

  // 父母も個人として作り、同じ世帯につなぐ（今ある世帯に同じ名前の方がいれば作らない）
  const tel = str(members.includes(repRow) ? repRow : members[0], hasR('tel') ? R.tel : null);
  for (const pa of parents) {
    if (noHouse) { problems.push(`${pa.role}　${pa.sei}　${pa.mei}：住所が空なので、作れません。`); continue; }
    const label = `${pa.role}　${pa.sei}　${pa.mei}`;
    if (houseRec) {
      const inHouse = pAll.records.find((x) => (x.getCellValue(P.house) ?? []).some((l) => l.id === houseRec.id)
        && norm(x.getCellValueAsString(P.sei) + x.getCellValueAsString(P.mei)) === norm(pa.sei + pa.mei));
      if (inHouse) { log(`${label}：世帯にすでにいらっしゃるので、作りません（${idOf(inHouse)}）`); continue; }
    }
    const same = nameIndex.get(`${norm(pa.sei)}${norm(pa.mei)}`) ?? [];
    if (same.length && !members.some(allowed)) {
      blocks.push(`${label}：名前が同じ方が個人の表にいます → ${same.map(describe).join('、')}`);
    }
    const fields = { [P.sei]: pa.sei, [P.mei]: pa.mei,
      ...(hasP('seiKana') && pa.seiKana ? { [P.seiKana]: pa.seiKana } : {}),
      ...(hasP('meiKana') && pa.meiKana ? { [P.meiKana]: pa.meiKana } : {}) };
    const g = choice(person, P.gender, pa.role === '父' ? ['男', '男性'] : ['女', '女性']);
    if (hasP('gender') && g) fields[P.gender] = g;
    if (pa === headParent && hasP('tel') && tel) fields[P.tel] = tel;
    plan.push({ row: null, label, houseRec, houseNew, personNew: fields });
  }
}

// ── 転居：すでにいる方の世帯の住所と、この行の住所を比べる ──
const houseUpdates = new Map(); // 世帯のレコードID → { house, fields, from, to }
const sameAddress = (h, r) => {
  const hb = hasH('building') ? h.getCellValueAsString(H.building).trim() : '';
  const rb = hasR('building') ? str(r, R.building) : '';
  if (addrOf(h, H.address, hasH('building') ? H.building : null) === addrOf(r, R.address, hasR('building') ? R.building : null)) return true;
  // 片方に建物名がなければ、建物名を除いて比べる
  return (!hb || !rb) && addrKey(h.getCellValueAsString(H.address)) === addrKey(str(r, R.address));
};
const fullAddr = (a, b) => [a, b].map((v) => String(v ?? '').trim()).filter(Boolean).join(' ');
if (!blocks.length) {
  const seen = new Set();
  for (const x of plan) {
    if (!x.row || !str(x.row, R.address)) continue;
    const h = x.personRec ? ownHouseOf(x.personRec)
      : x.keepPerson ? (houseByName.get(str(x.row, R.houseId)) ?? null) : null;
    if (!h || isCompany(h) || seen.has(h.id) || sameAddress(h, x.row)) continue;
    seen.add(h.id);
    const from = fullAddr(h.getCellValueAsString(H.address), hasH('building') ? h.getCellValueAsString(H.building) : '');
    const to = fullAddr(str(x.row, R.address), hasR('building') ? str(x.row, R.building) : '');
    const wantUpdate = hasR('updateAddr') && rows.some((r) => r.getCellValue(R.updateAddr));
    if (wantUpdate) {
      const fields = { [H.address]: str(x.row, R.address) };
      if (hasH('building')) fields[H.building] = hasR('building') ? str(x.row, R.building) : '';
      if (hasH('zip')) fields[H.zip] = hasR('zip') ? str(x.row, R.zip) : '';
      if (hasH('tel') && hasR('tel') && str(x.row, R.tel)) fields[H.tel] = str(x.row, R.tel);
      houseUpdates.set(h.id, { house: h, fields, from, to });
    } else {
      problems.push(`${str(x.row, R.name)}：世帯の住所と今回の住所が違います（転居かもしれません）\n`
        + `　世帯の表（${idOf(h)}）：${from}\n　今回：${to}\n`
        + `　→ 家族ごとの転居なら、この行の「${R.updateAddr}」にチェックを入れて、もう一度押してください（その世帯の全員の住所が変わります）。`
        + '一人だけ家を出た場合は、住所を変えずに、新しい世帯を作ってその方だけ移してください。'
        + (hasR('updateAddr') ? '' : `（予約受付の表に「${R.updateAddr}」のチェックボックスの項目を作ってください）`));
    }
  }
}

// ── 予定を出す（止まるときは出さない。作らないので、まぎらわしいため） ──
for (const x of blocks.length ? [] : plan) {
  const who = x.row ? str(x.row, R.name) : x.label;
  const own = x.personRec ? ownHouseOf(x.personRec) : null;
  const h = own ? `その方の世帯 ${idOf(own)}` : x.houseRec ? `既存の世帯 ${idOf(x.houseRec) || `（ID が空：${x.houseRec.id}）`}` : `新しい世帯を作る（${x.houseNew?.[H.name] ?? '名前なし'}）`;
  const p = x.keepPerson ? '個人はそのまま' : x.personRec ? `既存の個人 ${idOf(x.personRec)} を使う` : '新しい個人を作る';
  log(`${who}：${p}／${h}`);
}
if (blocks.length) {
  // 名前だけ同じ方がいるときは、取り違えを防ぐため、だれの分も作らない
  for (const m of blocks) log(`⛔ ${m}`);
  for (const m of problems) log(`⚠ ${m}`);
  log('');
  log('名前が同じ方が個人の表にいるので、何も作りませんでした。次のどれかをして、もう一度押してください。');
  log('・同じ方なら：その方の ID を「既存個人ID」に入れる');
  log('・父・母が同じ方なら：その方の世帯の ID を、お子さまの行の「既存世帯ID」に入れる（その世帯の父・母は作りません）');
  log(`・別人だと確かめたら：この行の「${R.allow}」にチェックを入れる`
    + (hasR('allow') ? '' : `（予約受付の表に「${R.allow}」のチェックボックスの項目を作ってください）`));
  state = '要確認';
  output.set('result', 'stopped');
} else if (DRY_RUN) {
  for (const u of houseUpdates.values()) log(`世帯 ${idOf(u.house)} の住所を書き換える予定です：${u.from} → ${u.to}`);
  for (const m of problems) log(`⚠ ${m}`);
  log('試し運転なので、まだ何も作っていません。');
  state = '試し運転';
  output.set('result', 'dry-run');
} else {
  // 世帯を作る（同じ予定は1回だけ）
  const madeHouse = new Map();
  for (const x of plan) {
    if (x.houseRec || !x.houseNew) continue;
    if (!madeHouse.has(x.houseNew)) madeHouse.set(x.houseNew, await house.createRecordAsync(x.houseNew));
    x.houseId = madeHouse.get(x.houseNew);
  }
  for (const x of plan) {
    if (x.houseRec) x.houseId = x.houseRec.id;
    if (x.personNew) {
      if (x.houseId) x.personNew[P.house] = [{ id: x.houseId }];
      x.personId = await person.createRecordAsync(x.personNew);
    } else if (x.personRec) {
      x.personId = x.personRec.id;
      // 見つかった方には、その方自身の世帯を書き戻す（なければ、この予約の世帯につなぐ）
      const own = ownHouseOf(x.personRec);
      if (own) x.houseId = own.id;
      // 見つかった個人に世帯がなければ、つなぐ
      if (x.houseId && !x.personRec.getCellValue(P.house)?.length) {
        await person.updateRecordAsync(x.personRec.id, { [P.house]: [{ id: x.houseId }] });
      }
    }
  }
  // 作った ID（いちばん左の項目）を読み直して、予約受付に書き戻す
  const pNow = await person.selectRecordsAsync();
  const hNow = await house.selectRecordsAsync();
  // 転居：世帯の住所を書き換える
  for (const u of houseUpdates.values()) {
    await house.updateRecordAsync(u.house.id, u.fields);
    log(`世帯 ${idOf(u.house)} の住所を書き換えました：${u.from} → ${u.to}`);
  }
  const updates = [];
  for (const x of plan) {
    if (!x.row) continue; // 父母の分は、予約受付に書き戻す行がない
    const f = {};
    const pName = x.personId ? idOf(pNow.getRecord(x.personId)) : '';
    const hName = x.houseId ? idOf(hNow.getRecord(x.houseId)) : '';
    if (pName && !str(x.row, R.personId)) f[R.personId] = pName;
    if (birthBack.has(x.row.id)) f[R.birth] = birthBack.get(x.row.id);
    // 住所を書き換えたら、チェックを外しておく（次に押したときにまた書き換えないように）
    if (houseUpdates.size && hasR('updateAddr') && x.row.getCellValue(R.updateAddr)) f[R.updateAddr] = false;
    if (hName && !str(x.row, R.houseId)) f[R.houseId] = hName;
    if (x.personId && !pName) problems.push(`${str(x.row, R.name)}：個人の ID が読めませんでした（レコードID ${x.personId}）。既存個人IDを手で入れてください。`);
    if (x.houseId && !hName) problems.push(`${str(x.row, R.name)}：世帯の ID が読めませんでした（レコードID ${x.houseId}）。既存世帯IDを手で入れてください。`);
    if (Object.keys(f).length) updates.push({ id: x.row.id, fields: f });
  }
  for (let i = 0; i < updates.length; i += 50) await reserve.updateRecordsAsync(updates.slice(i, i + 50));
  log(`世帯 ${madeHouse.size}件、個人 ${plan.filter((x) => x.personNew).length}件を作り、${updates.length}行に ID を書き戻しました。`);
  for (const m of problems) log(`⚠ ${m}`);
  state = problems.length ? '要確認' : '完了';
  output.set('result', problems.length ? 'needs-check' : 'done');
}
  await writeResult();
} catch (e) {
  // 思わぬところで止まったときも、何が起きたかと、どうすればよいかを書き込む
  state = 'エラー';
  const msg = String(e?.message ?? e);
  log(`内容：${msg}`);
  if (msg.includes('次の項目がありません')) log('→ 表の項目の名前が変わっていないか確かめてください。名前を戻すか、スクリプトの設定の項目名を直してください。');
  else if (msg.includes('押した行が見つかりません')) log('→ 行が消されたか、別の表のボタンから押された可能性があります。予約受付の行の画面から、もう一度押してください。');
  else if (/permission|権限/i.test(msg)) log('→ 書き込む権限がありません。Airtable の権限の設定を確かめてください。');
  else if (/cannot accept|Could not|invalid/i.test(msg)) log('→ 書き込もうとした値が、項目の種類と合いませんでした。項目の種類（日付・数字・選択肢など）が変わっていないか確かめてください。');
  else log('→ もう一度押してください。同じエラーが続くときは、この欄の文をそのまま管理者に伝えてください。');
  log('個人・世帯の表は、止まる前に作られた分だけ変わっている可能性があります。作りかけの行がないか確かめてください。');
  try { await writeResult(); } catch (e2) { console.log(`結果を書き込めませんでした：${e2?.message ?? e2}`); }
  throw e;
}

