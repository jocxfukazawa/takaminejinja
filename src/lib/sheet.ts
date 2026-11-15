/**
 * 祈祷申込書（紙・B6・1人1枚）に印刷する内容を、予約受付の表の1行から作る。
 * 印刷ページ（/admin/print/）で使う。
 */

import { FEE_BASE, eraOf, normalizeDate, normalizeTime } from './reservation';

/** 申込書の祈願の欄（右の列から、上から順）。この並びで印刷する */
export const SHEET_PRAYERS = [
  ['黒星祓', '事業安全', '商売繁昌', '交通安全'],
  ['家内安全', '健康安全', '学業成就', '合格祈願'],
  ['安産祈願', '平癒祈願', '焚き上げ祭', '人形供養祭'],
];

/** フォームのご祈願 → 申込書の欄 */
const TO_SHEET: Record<string, string> = {
  '黒星祓（厄除け）': '黒星祓',
  家内安全: '家内安全',
  安産祈願: '安産祈願',
  事業安全: '事業安全',
  健康安全: '健康安全',
  '病気（怪我）平癒祈願': '平癒祈願',
  商売繁盛: '商売繁昌',
  学業成就: '学業成就',
  '交通安全（新車祓）': '交通安全',
  '交通安全（その他）': '交通安全',
  合格祈願: '合格祈願',
};

/** この申込書ではなく、別の申込書で受け付けるご祈願 */
export const SEPARATE_FORM = ['七五三詣', '初宮詣'];

export interface SheetRow {
  id: string;
  fields: Record<string, unknown>;
}

export interface Sheet {
  no: string;
  group: string;
  /** 受付・祈祷日（令和の年・月・日）。郵送などで日付がなければ null */
  date: { year: number; month: number; day: number } | null;
  /** ○を付ける欄 */
  circled: string[];
  /** 備考に書く行 */
  notes: string[];
  /** 初穂料（円）。0 なら空欄 */
  fee: number;
  name: string;
  kana: string;
  gender: string;
  birth: { era: string; year: number; month: number; day: number } | null;
  kazoe: number | null;
  zip: string;
  address: string;
  tel: string;
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

  const circled = [...new Set(onSheet.map((p) => TO_SHEET[p]).filter(Boolean))];
  const others = onSheet.filter((p) => !TO_SHEET[p]);
  const haraobi = text(f['腹帯のお祓い']);

  // 初穂料：その方のご祈願1件につき 5,000円。安産祈願で腹帯のお祓いありは 8,000円
  const fee = onSheet.reduce((sum, p) => sum + (p === '安産祈願' && haraobi === 'あり' ? 8000 : FEE_BASE), 0);

  const notes: string[] = [];
  const time = normalizeTime(f['御祈祷時刻']);
  if (time) notes.push(`${time.replace(/^0/, '')}〜`);
  if (text(f['祈祷方法']) === '郵送') notes.push('郵送');
  if (text(f['受付経路']) === '事前申込') notes.push('事前申込');
  const car = text(f['車名・ナンバー']).replace(/\s*\n\s*/g, '　');
  if (car) notes.push(`ナンバー：${car}`);
  if (haraobi === 'あり') notes.push('腹帯のお祓い');
  for (const o of others) notes.push(o);
  const special = text(f['名前の特殊文字']);
  if (special) notes.push(`特殊文字：${special}`);
  const pay = text(f['納入方法']);
  if (pay === '事前にクレジットカードでお納め') notes.push('カード払い');
  else if (pay === 'その他') notes.push('納め方：その他');

  const dateKey = normalizeDate(f['御祈祷日']);
  const date = dateKey ? eraOf(dateKey) : null;
  const birthKey = normalizeDate(f['生年月日']);
  const birthEra = birthKey ? eraOf(birthKey) : null;
  const [, bm, bd] = birthKey ? birthKey.split('-').map(Number) : [];
  // 数え年は、ご祈祷の年で数える（日付がなければ今年）
  const prayerYear = dateKey ? Number(dateKey.slice(0, 4)) : new Date().getFullYear();

  return {
    separate,
    sheet: {
      no: text(f['予約番号']),
      group: text(f['予約グループ']),
      date: date && dateKey ? { year: date.year, month: Number(dateKey.slice(5, 7)), day: Number(dateKey.slice(8, 10)) } : null,
      circled,
      notes,
      fee,
      name: text(f['名前']),
      kana: text(f['ふりがな']),
      gender: text(f['性別']),
      birth: birthEra ? { era: birthEra.era, year: birthEra.year, month: bm, day: bd } : null,
      kazoe: birthKey ? prayerYear - Number(birthKey.slice(0, 4)) + 1 : null,
      zip: text(f['郵便番号']).replace(/^(\d{3})(\d{4})$/, '$1-$2'),
      address: [text(f['住所']), text(f['建物名等'])].filter(Boolean).join('　'),
      tel: text(f['電話番号']),
    },
  };
}
