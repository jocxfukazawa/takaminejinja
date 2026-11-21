/**
 * 予約受付の「新規登録」ボタン：新しい方の「個人」と「世帯・会社」を作り、予約受付の行に ID を書き戻す
 * （Airtable のオートメーション「When a button is clicked」→「Run script」に貼り付けて使う）
 *
 * 押した行と、同じ予約グループのご家族をまとめて扱う（キャンセルの行は除く）。
 *   - 世帯：同じ予約の中で、住所（＋建物名等）が同じ方は1つの世帯にまとめる。
 *       1) その住所の方に、すでに既存世帯IDが入っていれば、その世帯を使う
 *       2) 世帯・会社の表に、同じ住所の世帯が1つだけあれば、その世帯を使う（2つ以上あれば、作らずに知らせる）
 *       3) どれもなければ、新しく作る（郵便番号・住所・建物名等・電話番号・ふりがなの姓）
 *   - 個人：既存個人IDが空の方だけ作る（姓・名・ふりがな・性別・生年月日・元号/年/月/日、代表の方は電話番号）。
 *       続柄は空のまま（後で手で入れる）。
 *       作る前に、同じ名前・同じ生年月日の方が個人の表にいないか調べる。いれば作らず、その方の ID を使う。
 *   - 最後に、予約受付の行の「既存個人ID」「既存世帯ID」に、作った（見つけた）方の ID を書き戻す。
 *     予約ステータスは変えない。確かめてから、いつもどおり「登録完了」にする。
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
  personId: '既存個人ID', houseId: '既存世帯ID',
};
// 個人の項目
const P = {
  sei: '姓', mei: '名', seiKana: '姓（ふりがな）', meiKana: '名（ふりがな）',
  gender: '性別', birth: '生年月日', era: '元号', y: '年', m: '月', d: '日',
  tel: '電話番号', house: '世帯ID',
};
// 世帯・会社の項目
const H = {
  kana: '世帯・会社名（ふりがな）', kind: '世帯・会社の種類',
  zip: '郵便番号', address: '住所', building: '建物名等', tel: '電話番号',
};
const SKIP_STATUS = ['キャンセル'];

// ── ここから下は変えない ──
const { recordId } = input.config();
const reserve = base.getTable(T_RESERVE);
const person = base.getTable(T_PERSON);
const house = base.getTable(T_HOUSE);

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

// ── 押した行と、同じ予約グループの行 ──
const rFields = Object.keys(R).filter((k) => hasR(k)).map((k) => R[k]);
const all = await reserve.selectRecordsAsync({ fields: rFields });
const clicked = all.getRecord(recordId);
if (!clicked) throw new Error('押した行が見つかりません。');
const groupNo = str(clicked, hasR('group') ? R.group : null);
const rows = (groupNo ? all.records.filter((r) => str(r, R.group) === groupNo) : [clicked])
  .filter((r) => !SKIP_STATUS.includes(str(r, hasR('status') ? R.status : null)));
const repRow = rows.find((r) => hasR('rep') && r.getCellValue(R.rep)) ?? rows[0];
console.log(`予約グループ：${groupNo || '（なし）'}　${rows.length}名`);

// ── 今ある個人・世帯 ──
const pAll = await person.selectRecordsAsync({ fields: [P.sei, P.mei, ...(hasP('birth') ? [P.birth] : []), P.house] });
const hAll = await house.selectRecordsAsync({ fields: [H.address, ...(hasH('building') ? [H.building] : [])] });
const houseByName = new Map(hAll.records.filter(idOf).map((h) => [idOf(h), h]));
const personKey = (sei, mei, birth) => `${norm(sei)}${norm(mei)}|${birth ?? ''}`;
const personIndex = new Map();
for (const p of pAll.records) {
  const b = hasP('birth') ? birthKey(p.getCellValueAsString(P.birth)) : null;
  if (!b) continue;
  const k = personKey(p.getCellValueAsString(P.sei), p.getCellValueAsString(P.mei), b);
  personIndex.set(k, [...(personIndex.get(k) ?? []), p]);
}
const addrOf = (r, a, b) => norm(`${r.getCellValueAsString(a)}${b ? r.getCellValueAsString(b) : ''}`);
const housesByAddr = new Map();
for (const h of hAll.records) {
  const k = addrOf(h, H.address, hasH('building') ? H.building : null);
  if (k) housesByAddr.set(k, [...(housesByAddr.get(k) ?? []), h]);
}

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
    if (pid) return { r, existing: true };
    const [sei, mei] = splitName(str(r, R.name));
    const birth = birthKey(str(r, R.birth));
    const found = birth ? personIndex.get(personKey(sei, mei, birth)) ?? [] : [];
    if (found.length > 1) problems.push(`${sei}　${mei}：同じ名前・生年月日の方が個人の表に${found.length}人います。既存個人IDを手で入れてください。`);
    return { r, sei, mei, birth, found: found.length === 1 ? found[0] : null, skip: found.length > 1 };
  });

  // 世帯：1) 既存世帯IDが入っている方  2) 見つかった個人の世帯  3) 同じ住所の世帯  4) 新しく作る
  let houseRec = null;
  for (const r of members) {
    const hid = str(r, R.houseId);
    if (hid && houseByName.get(hid)) { houseRec = houseByName.get(hid); break; }
  }
  if (!houseRec) {
    const linked = people.map((p) => p.found?.getCellValue(P.house)?.[0]).find(Boolean);
    if (linked) houseRec = hAll.getRecord(linked.id);
  }
  let houseNew = null;
  if (!houseRec) {
    const same = addr ? housesByAddr.get(addr) ?? [] : [];
    if (same.length === 1 && !idOf(same[0])) {
      problems.push(`住所「${str(members[0], R.address)}」の世帯が見つかりましたが、その世帯の ID が空です（レコードID ${same[0].id}）。世帯・会社の表でその行を確かめてから、もう一度押してください。`);
      continue;
    } else if (same.length === 1) {
      houseRec = same[0];
      console.log(`同じ住所の世帯が見つかりました：${idOf(houseRec)}`);
    } else if (same.length > 1) {
      problems.push(`住所「${str(members[0], R.address)}」の世帯が${same.length}つあります（${same.map((h) => idOf(h) || `ID が空：${h.id}`).join('、')}）。既存世帯IDを手で入れてから、もう一度押してください。`);
      continue;
    } else if (!addr) {
      problems.push(`${str(members[0], R.name)}：住所が空なので、世帯を作れません。`);
      continue;
    } else {
      const src = members.includes(repRow) ? repRow : members[0];
      const [seiKana] = splitName(str(src, hasR('kana') ? R.kana : null));
      houseNew = {
        [H.address]: str(src, R.address),
        ...(hasH('building') && hasR('building') ? { [H.building]: str(src, R.building) } : {}),
        ...(hasH('zip') && hasR('zip') ? { [H.zip]: str(src, R.zip) } : {}),
        ...(hasH('tel') && hasR('tel') ? { [H.tel]: str(src, R.tel) } : {}),
        ...(hasH('kana') && seiKana ? { [H.kana]: seiKana } : {}),
        ...(kindChoice ? { [H.kind]: kindChoice } : {}),
      };
    }
  }

  for (const p of people) {
    if (p.existing || p.skip) { plan.push({ row: p.r, houseRec, houseNew, keepPerson: true }); continue; }
    if (p.found) { plan.push({ row: p.r, houseRec, houseNew, personRec: p.found }); continue; }
    if (!p.sei) { problems.push('名前が空の行があります。'); continue; }
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
      console.log(`${p.sei}　${p.mei}：生年月日が分からないので、空のまま作ります。`);
    }
    if (p.r === repRow && hasP('tel') && hasR('tel') && str(p.r, R.tel)) fields[P.tel] = str(p.r, R.tel);
    plan.push({ row: p.r, houseRec, houseNew, personNew: fields });
  }
}

// ── 予定を出す ──
for (const x of plan) {
  const who = str(x.row, R.name);
  const h = x.houseRec ? `既存の世帯 ${idOf(x.houseRec) || `（ID が空：${x.houseRec.id}）`}` : '新しい世帯を作る';
  const p = x.keepPerson ? '個人はそのまま' : x.personRec ? `既存の個人 ${idOf(x.personRec)} を使う` : '新しい個人を作る';
  console.log(`${who}：${p}／${h}`);
}
if (DRY_RUN) {
  for (const m of problems) console.log(`⚠ ${m}`);
  console.log('試し運転なので、まだ何も作っていません。');
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
      // 見つかった個人に世帯がなければ、つなぐ
      if (x.houseId && !x.personRec.getCellValue(P.house)?.length) {
        await person.updateRecordAsync(x.personRec.id, { [P.house]: [{ id: x.houseId }] });
      }
    }
  }
  // 作った ID（いちばん左の項目）を読み直して、予約受付に書き戻す
  const pNow = await person.selectRecordsAsync({ fields: [P.sei] });
  const hNow = await house.selectRecordsAsync({ fields: [H.address] });
  const updates = [];
  for (const x of plan) {
    const f = {};
    const pName = x.personId ? idOf(pNow.getRecord(x.personId)) : '';
    const hName = x.houseId ? idOf(hNow.getRecord(x.houseId)) : '';
    if (pName && !str(x.row, R.personId)) f[R.personId] = pName;
    if (hName && !str(x.row, R.houseId)) f[R.houseId] = hName;
    if (x.personId && !pName) problems.push(`${str(x.row, R.name)}：個人の ID が読めませんでした（レコードID ${x.personId}）。既存個人IDを手で入れてください。`);
    if (x.houseId && !hName) problems.push(`${str(x.row, R.name)}：世帯の ID が読めませんでした（レコードID ${x.houseId}）。既存世帯IDを手で入れてください。`);
    if (Object.keys(f).length) updates.push({ id: x.row.id, fields: f });
  }
  for (let i = 0; i < updates.length; i += 50) await reserve.updateRecordsAsync(updates.slice(i, i + 50));
  console.log(`世帯 ${madeHouse.size}件、個人 ${plan.filter((x) => x.personNew).length}件を作り、${updates.length}行に ID を書き戻しました。`);
  for (const m of problems) console.log(`⚠ ${m}`);
  output.set('result', problems.length ? 'needs-check' : 'done');
}
