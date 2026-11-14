/**
 * ご祈祷予約のルール。予約フォーム（ブラウザ）と送信処理（Pages Functions）の両方で使う。
 *
 * 日付はすべて日本時間で扱い、内部では 'YYYY-MM-DD'、時刻は 'HH:MM' で表す。
 * Airtable には Google フォームのときと同じ書き方（'2026/11/09 (月)'、'09:00'）で保存する。
 */

/** 受付する時刻（30分ごとに1組） */
export const SLOT_TIMES = [
  '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
  '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30',
];

/** 何日先まで受け付けるか（今日から数えて） */
export const DAYS_AHEAD = 32;

/** 翌日の予約を受け付ける締め切り（前日のこの時刻まで） */
export const NEXT_DAY_CUTOFF_HOUR = 20;

/** 1回の予約で一緒にご祈祷を受けられる人数（代表の方を含む） */
export const MAX_PERSONS = 20;

/** 追加で聞く項目 */
export type Extra = 'haraobi' | 'parents' | 'car';

/** ご祈願内容と、それぞれで追加で聞く項目 */
export const PRAYERS: { name: string; extras: Extra[] }[] = [
  { name: '黒星祓（厄除け）', extras: [] },
  { name: '初宮詣', extras: ['parents'] },
  { name: '交通安全（新車祓）', extras: ['car'] },
  { name: '交通安全（その他）', extras: [] },
  { name: '商売繁盛', extras: [] },
  { name: '家内安全', extras: [] },
  { name: '健康安全', extras: [] },
  { name: '学業成就', extras: [] },
  { name: '合格祈願', extras: [] },
  { name: '安産祈願', extras: ['haraobi'] },
  { name: '病気（怪我）平癒祈願', extras: [] },
  { name: '七五三詣', extras: ['parents'] },
  { name: '事業安全', extras: [] },
];

/** 「その他」を選んだときの値 */
export const PRAYER_OTHER = 'その他';

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, '0');

/** 日本時間の今の日付と時刻 */
function nowInJapan(now: number) {
  const jst = new Date(now + 9 * 60 * 60 * 1000);
  return {
    date: Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()),
    hour: jst.getUTCHours(),
  };
}

const toKey = (utc: number) => {
  const d = new Date(utc);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/** 予約できる日（'YYYY-MM-DD'）の一覧。翌日（20時を過ぎたら翌々日）から DAYS_AHEAD 日後まで */
export function bookableDates(now = Date.now()): string[] {
  const { date, hour } = nowInJapan(now);
  const first = hour < NEXT_DAY_CUTOFF_HOUR ? 1 : 2;
  const dates: string[] = [];
  for (let i = first; i <= DAYS_AHEAD; i++) dates.push(toKey(date + i * DAY_MS));
  return dates;
}

/** 'YYYY-MM-DD' の曜日（0=日〜6=土） */
const weekday = (key: string) => new Date(`${key}T00:00:00Z`).getUTCDay();

/** 画面に出す日付（例: 11月9日（月）） */
export function dateLabel(key: string): string {
  const [, m, d] = key.split('-').map(Number);
  return `${m}月${d}日（${WEEKDAYS[weekday(key)]}）`;
}

/** Airtable に保存する日付（Google フォームと同じ書き方。例: 2026/11/09 (月)） */
export function storedDate(key: string): string {
  return `${key.replace(/-/g, '/')} (${WEEKDAYS[weekday(key)]})`;
}

/**
 * Airtable の「御祈祷日」の文字を 'YYYY-MM-DD' にそろえる。
 * '2026/11/09 (月)'、'2025/11/25'、'2025/1/5' などを受け付ける。読めなければ null
 */
export function normalizeDate(text: unknown): string | null {
  const m = String(text ?? '').match(/(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/);
  return m ? `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}` : null;
}

/** 「御祈祷時刻」の文字を 'HH:MM' にそろえる。'9:00'、'09:00'、'10:00:00' などを受け付ける */
export function normalizeTime(text: unknown): string | null {
  const m = String(text ?? '').match(/(\d{1,2})\s*[:：]\s*(\d{2})/);
  return m ? `${pad(Number(m[1]))}:${m[2]}` : null;
}

/** 受付停止の設定（Airtable の「受付停止日」の1行） */
export interface Closure {
  date: string;
  /** 空なら、その日の最初から */
  start: string | null;
  /** 空なら、その日の最後まで（この時刻の回は受け付ける） */
  end: string | null;
}

/** その時刻が受付停止にあたるか */
export function isClosed(date: string, time: string, closures: Closure[]): boolean {
  return closures.some(
    (c) => c.date === date && (!c.start || time >= c.start) && (!c.end || time < c.end),
  );
}

/** 予約できる日時の一覧。taken は埋まっている 'YYYY-MM-DD HH:MM' */
export function availability(taken: Set<string>, closures: Closure[], now = Date.now()) {
  return bookableDates(now).map((date) => ({
    date,
    label: dateLabel(date),
    slots: SLOT_TIMES.map((time) => ({
      time,
      available: !taken.has(`${date} ${time}`) && !isClosed(date, time, closures),
    })),
  }));
}

/** 生年月日の入力（'YYYY-MM-DD'）が正しい日付か */
export function isValidBirthday(key: string, now = Date.now()): boolean {
  const m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return toKey(t) === key && Number(m[1]) >= 1900 && t <= nowInJapan(now).date;
}

/** 予約がうまくいかないときに案内する電話番号 */
export const PHONE = '0791-52-6464';

/**
 * 初穂料（お支払いの案内で使う目安の金額）。
 * ご祈願1件 5,000円。初宮詣 8,000円。安産祈願は腹帯のお祓いありなら 8,000円。
 * 七五三詣は、同じ予約のごきょうだいの人数で決まる（1人 5,000円、2人 8,000円、3人 10,000円）。
 */
export const FEE_BASE = 5000;
const FEE_BY_PRAYER: Record<string, number> = { 初宮詣: 8000 };
const FEE_HARAOBI = 8000;
const SHICHIGOSAN = '七五三詣';
/** 七五三詣の、ごきょうだいの人数ごとの金額。4人目からは1人 2,000円を足す（仮の決まり） */
const SHICHIGOSAN_FEES = [0, 5000, 8000, 10000];
const SHICHIGOSAN_EXTRA = 2000;

export const shichigosanFee = (n: number) =>
  n < SHICHIGOSAN_FEES.length ? SHICHIGOSAN_FEES[n] : SHICHIGOSAN_FEES.at(-1)! + (n - SHICHIGOSAN_FEES.length + 1) * SHICHIGOSAN_EXTRA;

const yen = (n: number) => `${n.toLocaleString('ja-JP')}円`;

/** 予約全体の初穂料の合計と内訳（例: 「七五三詣（2名）　8,000円」） */
export function feeSummary(people: { prayerNames: string[]; haraobi?: string }[]) {
  const lines = new Map<string, { count: number; fee: number }>();
  const addLine = (label: string, fee: number) => {
    const line = lines.get(label) ?? { count: 0, fee: 0 };
    lines.set(label, { count: line.count + 1, fee: line.fee + fee });
  };
  let children = 0;
  for (const p of people) {
    for (const name of p.prayerNames) {
      if (name === SHICHIGOSAN) children++;
      else if (name === '安産祈願' && p.haraobi === 'あり') addLine('安産祈願（腹帯のお祓いあり）', FEE_HARAOBI);
      else addLine(name, FEE_BY_PRAYER[name] ?? FEE_BASE);
    }
  }
  const items = [...lines].map(([label, l]) => ({ label: l.count > 1 ? `${label}（${l.count}件）` : label, fee: l.fee }));
  if (children) items.unshift({ label: children > 1 ? `${SHICHIGOSAN}（ごきょうだい${children}名）` : SHICHIGOSAN, fee: shichigosanFee(children) });
  const total = items.reduce((sum, i) => sum + i.fee, 0);
  return { total, text: [...items.map((i) => `${i.label}　${yen(i.fee)}`), `合計　${yen(total)}`].join('\n') };
}
