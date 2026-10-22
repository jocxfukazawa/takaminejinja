#!/usr/bin/env python3
"""WordPress (takaminejinja.jp) からコンテンツを取り込み、src/data/*.json と public/wp-content/uploads/ を生成する。

使い方:
    python3 scripts/import_wp.py [--cache DIR] [--no-download]

公開中のサイトのHTMLを取得して本文を抜き出す。お知らせ・祭典行事はREST APIで
公開されていないため、REST APIではなくHTMLから取り込む。
"""
import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from bs4 import BeautifulSoup

SITE = "https://www.takaminejinja.jp"
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "src" / "data"
PUBLIC = ROOT / "public"

FIXED_PAGES = ["about", "prayer", "access", "reservation", "contact", "thanks", "news", "event", "blog"]

uploads: set[str] = set()


def fetch(path: str, cache: Path | None) -> str:
    name = (path.strip("/") or "index").replace("/", "_") + ".html"
    if cache and (cache / name).exists():
        return (cache / name).read_text()
    with urllib.request.urlopen(SITE + path) as r:
        html = r.read().decode("utf-8")
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
        (cache / name).write_text(html)
    return html


def local_url(url: str) -> str:
    """サイト内の絶対URLを相対パスに置き換え、uploads を記録する。"""
    url = url.strip()
    for prefix in (SITE, "http://www.takaminejinja.jp", "https://takaminejinja.jp"):
        if url.startswith(prefix):
            url = url[len(prefix):] or "/"
    if url.startswith("/wp-content/uploads/"):
        uploads.add(urllib.parse.unquote(url.split("?")[0]))
    return url


def clean(el) -> str:
    """本文HTMLを整える: srcset等の削除、URLの相対化、画像の遅延読み込み。"""
    if el is None:
        return ""
    for tag in el.select("script, style, .p-entry__share, .single_share"):
        tag.decompose()
    for tag in el.find_all(True):
        if tag.has_attr("data-lazy"):  # slick スライダーの遅延読み込み
            tag["src"] = tag.attrs.pop("data-lazy")
        for attr in ("srcset", "sizes", "decoding", "fetchpriority", "loading", "id"):
            if attr in tag.attrs and not (attr == "id" and tag.name in ("h2", "h3", "h4")):
                del tag.attrs[attr]
        for attr in ("src", "href", "poster"):
            if tag.has_attr(attr):
                tag[attr] = local_url(tag[attr])
        if tag.has_attr("style"):
            tag["style"] = re.sub(
                r"url\((['\"]?)([^)'\"]+)\1\)",
                lambda m: f"url({m.group(1)}{local_url(m.group(2))}{m.group(1)})",
                tag["style"],
            )
        if tag.name in ("img", "iframe"):
            tag["loading"] = "lazy"
    html = el.decode_contents()
    html = re.sub(r"\n\s*\n+", "\n", html)
    return html.strip()


def img_src(el) -> str | None:
    img = el.select_one("img") if el else None
    return local_url(img["src"]) if img and img.has_attr("src") else None


def meta(soup, name: str) -> str | None:
    m = soup.select_one(f'meta[name="{name}"]') or soup.select_one(f'meta[property="{name}"]')
    return m.get("content") if m else None


def page_header(soup) -> dict:
    h = soup.select_one(".p-page-header")
    if not h:
        return {}
    title = h.select_one(".p-page-header__title")
    return {"headerTitle": title.get_text(strip=True) if title else "", "headerImg": img_src(h)}


def parse_fixed(slug: str, cache) -> dict:
    soup = BeautifulSoup(fetch(f"/{slug}/", cache), "lxml")
    title = soup.title.get_text().split(" - ")[0].strip()
    primary = soup.select_one(".l-primary")
    out = {"title": title, "description": meta(soup, "description"), **page_header(soup)}
    if slug == "contact":
        out["html"] = clean(primary.select_one(".step01"))
    elif slug in ("news", "event", "blog"):
        out["html"] = ""
    else:
        out["html"] = clean(primary)
    return out


def parse_entry(path: str, cache) -> tuple[dict, BeautifulSoup]:
    soup = BeautifulSoup(fetch(path, cache), "lxml")
    header = soup.select_one(".p-entry__header")
    time = header.select_one("time")
    return {
        "slug": path.strip("/").split("/")[-1],
        "title": header.select_one(".p-entry__title").get_text(strip=True),
        "date": time.get_text(strip=True) if time else "",
        "datetime": time.get("datetime") if time else "",
        "img": img_src(header.select_one(".p-entry__img")),
        "description": meta(soup, "description"),
        "html": clean(soup.select_one(".p-entry__body")),
    }, soup


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path, help="取得したHTMLを保存・再利用するディレクトリ")
    ap.add_argument("--no-download", action="store_true", help="画像・動画をダウンロードしない")
    args = ap.parse_args()
    DATA.mkdir(parents=True, exist_ok=True)

    pages = {slug: parse_fixed(slug, args.cache) for slug in FIXED_PAGES}

    # お知らせ: 一覧の順序とサムネイル
    news = []
    archive = BeautifulSoup(fetch("/news/", args.cache), "lxml")
    for li in archive.select(".p-news-list li"):
        a = li.select_one("a")
        entry, _ = parse_entry(local_url(a["href"]), args.cache)
        entry["thumb"] = img_src(li)
        news.append(entry)

    # 祭典・行事: 一覧の順序・画像・日付
    events = []
    archive = BeautifulSoup(fetch("/event/", args.cache), "lxml")
    for li in archive.select(".p-event-list__item"):
        a = li.select_one("a")
        entry, _ = parse_entry(local_url(a["href"]), args.cache)
        entry["listImg"] = img_src(li)
        entry["dateText"] = li.select_one(".p-article02__date").get_text(strip=True)
        events.append(entry)

    # ブログ: 一覧の順序とサムネイル
    blog = []
    archive = BeautifulSoup(fetch("/blog/", args.cache), "lxml")
    for art in archive.select(".p-blog-list__item"):
        a = art.select_one("a")
        entry, soup = parse_entry(local_url(a["href"]), args.cache)
        entry["thumb"] = img_src(art)
        entry["date"] = art.select_one("time").get_text(strip=True)
        cat = soup.select_one(".p-entry__category a, .p-article01__cat a")
        entry["category"] = cat.get_text(strip=True) if cat else ""
        blog.append(entry)

    # トップページ・共通部分で使う画像
    top = BeautifulSoup(fetch("/", args.cache), "lxml")
    for el in top.select("img[src], video[src], source[src]"):
        local_url(el["src"])
    for m in re.finditer(r"url\(([^)]+wp-content/uploads/[^)]+)\)", str(top)):
        local_url(m.group(1).strip("'\""))
    for link in top.select("link[rel*=icon]"):
        local_url(link["href"])

    for name, data in (("pages", pages), ("news", news), ("events", events), ("blog", blog)):
        (DATA / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(f"pages={len(pages)} news={len(news)} events={len(events)} blog={len(blog)} uploads={len(uploads)}")

    if args.no_download:
        return
    failed = []
    for path in sorted(uploads):
        dest = PUBLIC / path.lstrip("/")
        if dest.exists():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            with urllib.request.urlopen(SITE + urllib.parse.quote(path)) as r:
                dest.write_bytes(r.read())
        except Exception as e:  # noqa: BLE001
            failed.append(f"{path}: {e}")
    if failed:
        print("ダウンロード失敗:", *failed, sep="\n  ", file=sys.stderr)


if __name__ == "__main__":
    main()
