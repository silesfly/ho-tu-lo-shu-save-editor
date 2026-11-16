#!/usr/bin/env python3
import hashlib
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
OUT_DIR = os.path.join(HERE, "dist")
OUT_NAME = "HoTuLoShuSaveEditor-v1.0.html"
OUT_PATH = os.path.join(OUT_DIR, OUT_NAME)
PAGE = os.path.join(SRC, "editor-page.html")
SCRIPTS = ["htls-lz4-msgpack.js", "catalog-data.js", "editor-core.js", "editor-ui.js"]
MAX_BYTES = 10 * 1024 * 1024

CJK_RE = re.compile(
    r"[\u2E80-\u2EFF\u2F00-\u2FDF\u3000-\u303F\u3040-\u30FF\u3100-\u312F\u3190-\u31BF"
    r"\u31C0-\u31EF\u3200-\u32FF\u3300-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F"
    r"\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]"
)
HANZI_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]")
URL_RE = re.compile(r"https?://|ftp://|wss?://|(?<![:\w])//")
SCRIPT_SRC_RE = re.compile(r"<script[^>]*\bsrc\s*=", re.IGNORECASE)


def read_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def inline_script(page_html, script_name):
    script_path = os.path.join(SRC, script_name)
    if not os.path.exists(script_path):
        raise SystemExit(f"missing script: {script_name}")
    body = read_text(script_path).replace("</script", "<\\/script")
    pattern = re.compile(
        r'<script\s+src="' + re.escape(script_name) + r'"\s*></script>',
        re.IGNORECASE,
    )
    tag = "<script>" + body + "</script>"
    new_html, n = pattern.subn(lambda _m: tag, page_html, count=1)
    if n == 0:
        raise SystemExit(f"script tag not found: {script_name}")
    return new_html


def build():
    if not os.path.isfile(PAGE):
        raise SystemExit(f"missing page: {PAGE}")
    page = read_text(PAGE)
    for name in SCRIPTS:
        page = inline_script(page, name)

    if SCRIPT_SRC_RE.search(page):
        raise SystemExit("external script src tag remains")

    if URL_RE.search(page):
        m = URL_RE.search(page)
        raise SystemExit(f"external URL pattern found: {m.group(0)!r}")

    for m in HANZI_RE.finditer(page):
        raise SystemExit(f"CJK/Hanzi char found: U+{ord(m.group(0)):04X}")

    data = page.encode("utf-8")
    size = len(data)
    if size >= MAX_BYTES:
        raise SystemExit(f"output too large: {size} bytes >= {MAX_BYTES}")

    digest = hashlib.sha256(data).hexdigest()

    os.makedirs(OUT_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".htls-", suffix=".html", dir=OUT_DIR)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, OUT_PATH)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass

    print(f"output: {OUT_PATH}")
    print(f"size: {size} bytes ({size / 1024:.1f} KiB)")
    print(f"sha256: {digest}")


if __name__ == "__main__":
    try:
        build()
    except SystemExit as e:
        if e.code:
            print(f"error: {e}", file=sys.stderr)
        raise
