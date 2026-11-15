"""
日本郵便の郵便番号データ（utf_ken_all.csv）から、予約フォームの住所の自動入力に使うファイルを作る。

    python3 scripts/build_zipcode.py utf_ken_all.csv

- 出力先: public/zip/<郵便番号の頭3桁>.json  （例: public/zip/678.json）
- 中身: {"6781181": ["兵庫県赤穂市有年楢原"], ...}  1つの番号に複数の町域があるときは候補を並べる
- データは日本郵便のサイトの「住所の郵便番号（1レコード1行、UTF-8形式）」の「全国一括」
  https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html
  年に1〜2回入れ替えれば十分（新しい番号ができたときに備えて）
"""

import csv
import json
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'public' / 'zip'


def clean_town(town: str) -> str:
    """町域の注記を取り除く（「以下に掲載がない場合」「（その他）」「〇〇一円」など）"""
    if town == '以下に掲載がない場合' or town.endswith('の次に番地がくる場合'):
        return ''
    if town.endswith('一円') and town != '一円':
        return ''
    # かっこ書きの注記（「（１〜１９丁目）」「（次のビルを除く）」など）は住所に含めない
    return re.sub(r'（.*）$', '', town)


def rows(path: str):
    """CSV を読み、町域が複数行に分かれている行をつないで返す"""
    with open(path, encoding='utf-8', newline='') as f:
        pending = None
        for r in csv.reader(f):
            zipcode, pref, city, town = r[2], r[6], r[7], r[8]
            if pending:
                # かっこが閉じるまで、同じ番号の次の行の町域をつなげる
                pending[3] += town
                if '）' in town:
                    yield pending
                    pending = None
                continue
            if '（' in town and '）' not in town:
                pending = [zipcode, pref, city, town]
                continue
            yield [zipcode, pref, city, town]


def main(src: str):
    by_zip: dict[str, list[str]] = defaultdict(list)
    for zipcode, pref, city, town in rows(src):
        address = pref + city + clean_town(town)
        if address not in by_zip[zipcode]:
            by_zip[zipcode].append(address)

    # 注記を外すと同じになる候補（例: 「〇〇町」と「〇〇町（地階）」）は、上で1つにまとめている
    by_prefix: dict[str, dict[str, list[str]]] = defaultdict(dict)
    for zipcode, addresses in sorted(by_zip.items()):
        by_prefix[zipcode[:3]][zipcode] = addresses

    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    for prefix, data in by_prefix.items():
        (OUT / f'{prefix}.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{len(by_zip)} 件の郵便番号を {len(by_prefix)} ファイルに書き出しました')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('使い方: python3 scripts/build_zipcode.py utf_ken_all.csv')
    main(sys.argv[1])
