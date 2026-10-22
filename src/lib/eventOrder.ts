/**
 * 祭典・行事を「次に行うものから順」に並べる。
 * ビルド時（Astro）とブラウザの両方で同じ計算を使う。
 */

/** 毎年の開催日。day か nth+weekday（例: 第2日曜日）のどちらかを指定する */
export interface Schedule {
  month: number;
  day?: number;
  /** 複数日にわたる場合の最終日（同じ月） */
  endDay?: number;
  /** 第n週（1〜5） */
  nth?: number;
  /** 曜日（0=日曜〜6=土曜） */
  weekday?: number;
}

/** 日本時間の今日（UTCの0時として表す） */
export function todayInJapan(now = Date.now()): number {
  const jst = new Date(now + 9 * 60 * 60 * 1000);
  return Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate());
}

function occurrence(s: Schedule, year: number): { start: number; end: number } {
  let day = s.day ?? 1;
  if (s.nth && s.weekday !== undefined) {
    const firstWeekday = new Date(Date.UTC(year, s.month - 1, 1)).getUTCDay();
    day = 1 + ((s.weekday - firstWeekday + 7) % 7) + (s.nth - 1) * 7;
  }
  const start = Date.UTC(year, s.month - 1, day);
  const end = s.endDay ? Date.UTC(year, s.month - 1, s.endDay) : start;
  return { start, end };
}

/** 今日以降で最も近い開催の開始日（開催中ならその開始日） */
export function nextStart(s: Schedule, today: number): number {
  const year = new Date(today).getUTCFullYear();
  const thisYear = occurrence(s, year);
  return thisYear.end >= today ? thisYear.start : occurrence(s, year + 1).start;
}

/** 次に行うものから順に並べ替える。同じ日は元の並び順を保つ */
export function orderBySchedule<T>(items: T[], getSchedule: (item: T) => Schedule, today = todayInJapan()): T[] {
  return items
    .map((item, index) => ({ item, index, key: nextStart(getSchedule(item), today) }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map((x) => x.item);
}
