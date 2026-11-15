/**
 * 祈祷申込書（紙・B6・1人1枚）に印刷する内容を、予約受付の表の1行から作る。
 * 印刷ページ（/admin/print/）で使う。
 */

import { FEE_BASE, eraOf, normalizeDate, normalizeTime } from './reservation';

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
  /** ご祈願（フォームで選ばれたまま。その他のご祈願も含む） */
  prayers: string[];
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
  /** 住所と建物名（祝詞で読み上げやすいよう、建物名は改行して書く） */
  address: string[];
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

  // ご祈願は、フォームで選ばれたものをそのまま書く（「交通安全（新車祓）」なども、かっこまで含めて）
  const prayerNames = [...new Set(onSheet)];
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
      prayers: prayerNames,
      notes,
      fee,
      name: text(f['名前']),
      kana: text(f['ふりがな']),
      gender: text(f['性別']),
      birth: birthEra ? { era: birthEra.era, year: birthEra.year, month: bm, day: bd } : null,
      kazoe: birthKey ? prayerYear - Number(birthKey.slice(0, 4)) + 1 : null,
      zip: text(f['郵便番号']).replace(/^(\d{3})(\d{4})$/, '$1-$2'),
      address: [text(f['住所']), text(f['建物名等'])].filter(Boolean),
      tel: text(f['電話番号']),
    },
  };
}
