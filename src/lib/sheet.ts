/**
 * 祈祷申込書（紙・B6・1人1枚）に印刷する内容を、予約受付の表の1行から作る。
 * 印刷ページ（/admin/print/）で使う。
 */

import { FEE_BASE, eraOf, normalizeDate, normalizeTime, shichigosanFee } from './reservation';

/** この申込書ではなく、別の申込書（七五三詣・初宮詣の申込書）で受け付けるご祈願 */
export const SEPARATE_FORM = ['七五三詣', '初宮詣'];
const SHICHIGOSAN = '七五三詣';
const HATSUMIYA = '初宮詣';
const FEE_HATSUMIYA = 8000;

export interface SheetRow {
  id: string;
  fields: Record<string, unknown>;
}

export interface Sheet {
  no: string;
  group: string;
  /** 受付・祈祷日（令和の年・月・日）。郵送などで日付がなければ null */
  date: { year: number; month: number; day: number } | null;
  /** ご祈願（フォームで選ばれたまま。その他のご祈願も含む） */
  prayers: string[];
  /** 備考に書く行 */
  notes: string[];
  /** 初穂料（円）。0 なら空欄 */
  fee: number;
  /** 事前にクレジットカードでお納め。備考ではなく初穂料の欄に小さく書く */
  card: boolean;
  /** ご祈祷の時刻（例: 10:30）。備考ではなく受付・祈祷日の欄に日付に続けて書く */
  time: string;
  /** 車名とナンバー（1行ずつ）。新車祓でなければ空 */
  car: string[];
  name: string;
  kana: string;
  gender: string;
  birth: { era: string; year: number; month: number; day: number } | null;
  kazoe: number | null;
  zip: string;
  /** 住所と建物名（祝詞で読み上げやすいよう、建物名は改行して書く） */
  address: string[];
  tel: string;
}

/** 七五三詣・初宮詣の申込書（父母の欄がある） */
export interface ChildSheet extends Omit<Sheet, 'prayers' | 'car'> {
  kind: 'shichigosan' | 'hatsumiya';
  father: { name: string; kana: string };
  mother: { name: string; kana: string };
  /** 生年月日（並べ替え・ごきょうだいの年上の方を決めるのに使う） */
  birthKey: string;
}

const text = (v: unknown) => (v == null ? '' : Array.isArray(v) ? v.join('、') : String(v)).trim();
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : text(v) ? text(v).split(/[、,]\s*/) : []);

/**
 * 1行を申込書の内容にする。
 * separate はこの申込書に書かないご祈願（七五三詣・初宮詣）。それしかない方は sheet が null になる
 */
export function toSheet(row: SheetRow): { sheet: Sheet | null; separate: string[] } {
  const f = row.fields;
  const prayers = list(f['御祈祷内容']);
  const separate = prayers.filter((p) => SEPARATE_FORM.includes(p));
  const onSheet = prayers.filter((p) => !SEPARATE_FORM.includes(p));
  if (!onSheet.length) return { sheet: null, separate };

  // ご祈願は、フォームで選ばれたものをそのまま書く（「交通安全（新車祓）」なども、かっこまで含めて）
  const prayerNames = [...new Set(onSheet)];
  const haraobi = text(f['腹帯のお祓い']);

  // 初穂料：その方のご祈願1件につき 5,000円。安産祈願で腹帯のお祓いありは 8,000円
  const fee = onSheet.reduce((sum, p) => sum + (p === '安産祈願' && haraobi === 'あり' ? 8000 : FEE_BASE), 0);

  const common = commonFields(row);
  // 車名とナンバーは祝詞で読み上げるので、備考ではなく専用の欄に横書きで大きく書く
  const car = text(f['車名・ナンバー']).split(/\s*\n\s*/).filter(Boolean);
  // カード払いは備考ではなく、初穂料の欄に小さく書く
  const card = common.notesAfter.includes('カード払い');
  // 時刻は備考ではなく、受付・祈祷日の欄に日付に続けて書く
  const time = normalizeTime(f['御祈祷時刻'])?.replace(/^0/, '') ?? '';
  const notes = [...common.notesBefore.filter((n) => !n.endsWith('〜')), ...(haraobi === 'あり' ? ['腹帯のお祓い'] : []), ...common.notesAfter.filter((n) => n !== 'カード払い')];
  const { notesBefore, notesAfter, birthKey, ...rest } = common;
  return { separate, sheet: { ...rest, prayers: prayerNames, notes, fee, card, time, car } };
}

/** 父母の名前（「父　高嶺 太郎（たかみね たろう）」の行）を父と母に分ける */
export function parseParents(v: unknown) {
  const out = { father: { name: '', kana: '' }, mother: { name: '', kana: '' } };
  for (const line of text(v).split(/\n/)) {
    const m = line.trim().match(/^(父|母)[\s　:：]*(.+?)(?:[（(]\s*(.+?)\s*[）)])?$/);
    if (!m) continue;
    out[m[1] === '父' ? 'father' : 'mother'] = { name: m[2].trim(), kana: (m[3] ?? '').trim() };
  }
  return out;
}

/**
 * 1行から、七五三詣・初宮詣の申込書を作る（その方が選んだもの1枚ずつ）。
 * 七五三詣の初穂料とごきょうだいの有無は、ご家族みんなを見てから childFees で入れる
 */
export function toChildSheets(row: SheetRow): ChildSheet[] {
  const prayers = list(row.fields['御祈祷内容']);
  const { notesBefore, notesAfter, ...rest } = commonFields(row);
  const parents = parseParents(row.fields['父母の名前']);
  // 備考の欄は狭いので、時刻とカード払いは別の欄に書く（備考の字を大きくするため）
  const time = normalizeTime(row.fields['御祈祷時刻'])?.replace(/^0/, '') ?? '';
  const card = notesAfter.includes('カード払い');
  return SEPARATE_FORM.filter((p) => prayers.includes(p)).map((p) => ({
    ...rest,
    ...parents,
    kind: p === SHICHIGOSAN ? 'shichigosan' : 'hatsumiya',
    time,
    card,
    notes: [...notesBefore, ...notesAfter].filter((n) => n !== 'カード払い' && !n.endsWith('〜')),
    fee: p === HATSUMIYA ? FEE_HATSUMIYA : 0,
  }));
}

/**
 * 七五三詣の初穂料は、ごきょうだいの分をまとめて年上の方の申込書にだけ書く（下の方は空欄）。
 * 備考に「兄弟のご祈祷　有」か「無」を書く。同じ予約グループ（なければ同じ予約番号）をごきょうだいとみなす
 */
export function childFees(sheets: ChildSheet[]) {
  const families = new Map<string, ChildSheet[]>();
  for (const s of sheets) {
    if (s.kind !== 'shichigosan') continue;
    const key = s.group || s.no;
    families.set(key, [...(families.get(key) ?? []), s]);
  }
  for (const children of families.values()) {
    // 生年月日の早い方が年上（分からなければ予約番号の順）
    const order = [...children].sort((a, b) => (a.birthKey || '9999').localeCompare(b.birthKey || '9999') || a.no.localeCompare(b.no));
    order.forEach((s, i) => {
      s.fee = i === 0 ? shichigosanFee(children.length) : 0;
      s.notes.push(`兄弟のご祈祷　${children.length > 1 ? '有' : '無'}`);
    });
  }
  return sheets;
}

/**
 * 当日受付で、計算した金額より多くお納めいただく方は、その分を代表の方の最初の申込書に足して書く。
 * 予約全体の金額は、代表の方の行の「予約の初穂料合計」（当日受付ではご本人が入力した金額）
 */
export function addReceptionExtra(rows: SheetRow[], sheets: (Sheet | ChildSheet)[]) {
  for (const rep of rows) {
    const f = rep.fields;
    if (text(f['受付経路']) !== '当日受付' || !f['代表者']) continue;
    const no = text(f['予約番号']);
    const total = Number(f['予約の初穂料合計']) || 0;
    const mine = sheets.filter((s) => (s.group || s.no) === no);
    const extra = total - mine.reduce((sum, s) => sum + s.fee, 0);
    const target = mine.find((s) => s.no === no);
    if (extra > 0 && target) target.fee += extra;
  }
}

/** 普通の申込書と七五三詣・初宮詣の申込書で同じところ */
function commonFields(row: SheetRow) {
  const f = row.fields;
  const notesBefore: string[] = [];
  const time = normalizeTime(f['御祈祷時刻']);
  if (time) notesBefore.push(`${time.replace(/^0/, '')}〜`);
  if (text(f['祈祷方法']) === '郵送') notesBefore.push('郵送');
  if (text(f['受付経路']) === '事前申込') notesBefore.push('事前申込');
  const notesAfter: string[] = [];
  const special = text(f['名前の特殊文字']);
  if (special) notesAfter.push(`特殊文字：${special}`);
  const pay = text(f['納入方法']);
  if (pay === '事前にクレジットカードでお納め') notesAfter.push('カード払い');
  else if (pay === 'その他') notesAfter.push('納め方：その他');

  const dateKey = normalizeDate(f['御祈祷日']);
  const date = dateKey ? eraOf(dateKey) : null;
  const birthKey = normalizeDate(f['生年月日']);
  const birthEra = birthKey ? eraOf(birthKey) : null;
  const [, bm, bd] = birthKey ? birthKey.split('-').map(Number) : [];
  // 数え年は、ご祈祷の年で数える（日付がなければ今年）
  const prayerYear = dateKey ? Number(dateKey.slice(0, 4)) : new Date().getFullYear();

  return {
    notesBefore,
    notesAfter,
    birthKey: birthKey ?? '',
    no: text(f['予約番号']),
    group: text(f['予約グループ']),
    date: date && dateKey ? { year: date.year, month: Number(dateKey.slice(5, 7)), day: Number(dateKey.slice(8, 10)) } : null,
    name: text(f['名前']),
    kana: text(f['ふりがな']),
    gender: text(f['性別']),
    birth: birthEra ? { era: birthEra.era, year: birthEra.year, month: bm, day: bd } : null,
    kazoe: birthKey ? prayerYear - Number(birthKey.slice(0, 4)) + 1 : null,
    zip: text(f['郵便番号']).replace(/^(\d{3})(\d{4})$/, '$1-$2'),
    address: [text(f['住所']), text(f['建物名等'])].filter(Boolean),
    tel: text(f['電話番号']),
  };
}
