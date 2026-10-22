import pagesJson from './pages.json';
import newsJson from './news.json';
import eventsJson from './events.json';
import blogJson from './blog.json';
import type { Schedule } from '../lib/eventOrder';

export const SITE_NAME = '【幸せを運ぶ宮】高嶺神社';
export const SITE_DESCRIPTION = '高嶺神社は、『家庭円満』のほか、厄除けや五穀豊穣、縁結びのご利益をいただけます。';
export const GA_ID = 'G-0EX7JF5LYT';

export const UPLOADS = '/wp-content/uploads';
export const ICON = `${UPLOADS}/2023/06/icon.png`;
export const LOGO = `${UPLOADS}/2023/07/02_takamine_yoko_02.png`;
export const LOGO_WHITE = `${UPLOADS}/2023/06/header_logo-1.png`;
export const FAVICON = `${UPLOADS}/2023/08/cropped-takamine_icon_02-scaled-1-32x32.jpg`;
export const APPLE_ICON = `${UPLOADS}/2023/08/cropped-takamine_icon_02-scaled-1-180x180.jpg`;
export const FOOTER_LINK_IMG = `${UPLOADS}/2023/06/footer_img01.png`;

export const NAV = [
  { href: '/about/', label: '高嶺神社について' },
  { href: '/news/', label: 'お知らせ' },
  { href: '/event/', label: '祭典・行事' },
  { href: '/prayer/', label: 'ご祈願・ご祈祷' },
  { href: '/reservation/', label: 'ご祈祷の予約' },
  { href: '/blog/', label: 'ブログ' },
  { href: '/access/', label: 'アクセス' },
  { href: '/contact/', label: 'お問い合わせ' },
];

export const ADDRESS = '〒678-1241 兵庫県赤穂郡上郡町山野里2745';
export const TEL = 'TEL. 0791-52-6464（つながらない場合は0791-52-0666）';
export const MAP_EMBED =
  'https://www.google.com/maps/embed?pb=!1m14!1m8!1m3!1d6548.035844014494!2d134.33828900000003!3d34.855777!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x355459e6025a089f%3A0x6467118f7df44f1!2z6auY5ba656We56S-!5e0!3m2!1sja!2sus!4v1689411926000!5m2!1sja!2sus';

export const SOCIAL = [
  { name: 'facebook', href: 'https://www.facebook.com/takaminejinja/' },
  { name: 'twitter', href: 'https://twitter.com/takaminejinja' },
  { name: 'instagram', href: 'https://www.instagram.com/takaminejinja/' },
] as const;

export interface Page {
  title: string;
  description: string | null;
  headerTitle?: string;
  headerImg?: string | null;
  html: string;
}

export interface Entry {
  slug: string;
  title: string;
  date: string;
  datetime: string;
  img: string | null;
  description: string | null;
  html: string;
}

export interface NewsEntry extends Entry {
  thumb: string | null;
}

export interface EventEntry extends Entry {
  listImg: string | null;
  dateText: string;
  schedule: Schedule;
}

export interface BlogEntry extends Entry {
  thumb: string | null;
  category: string;
}

export const pages = pagesJson as Record<string, Page>;
export const news = newsJson as NewsEntry[];
export const events = eventsJson as EventEntry[];
export const blog = blogJson as BlogEntry[];
