#!/usr/bin/env python3
"""Extract Ho Tu Lo Shu catalog data into src/catalog-data.js."""
import argparse
import json
import re
import sys
from pathlib import Path

DEFAULT_SOURCE_DIR = "/home/jiyoung/workspace/무협위키/.local/graph/ho-tu-lo-shu-data/tables_ko"
DEFAULT_OUTPUT = "src/catalog-data.js"

CJK_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]")
TAG_RE = re.compile(r"<[^>]*>")
PAREN_CJK_RE = re.compile(r"\([^)]*[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF][^)]*\)|\[[^\]]*[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF][^\]]*\]|（[^）]*[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF][^）]*）")

STATS = {
    "HP": ("HP", "기본", 0, 999999),
    "MaxHP": ("최대 HP", "기본", 0, 999999),
    "MP": ("MP", "기본", 0, 999999),
    "MaxMP": ("최대 MP", "기본", 0, 999999),
    "AP": ("AP", "기본", 0, 999999),
    "MaxAP": ("최대 AP", "기본", 0, 999999),
    "RecoverAP": ("AP 회복", "기본", 0, 999999),
    "Speed": ("속도", "기본", 0, 999999),
    "Physique": ("체력", "기본", 0, 999999),
    "Intelligence": ("지능", "기본", 0, 999999),
    "ZOC": ("이동 범위", "기본", 0, 999999),
    "Money": ("소지금", "성향·재화", 0, 999999999),
    "Madness": ("광기", "성향·재화", 0, 999999),
    "Moral": ("명성", "성향·재화", -999999, 999999),
    "Reputation": ("평판", "성향·재화", -999999, 999999),
    "YinAndYang": ("음양", "성향·재화", -999999, 999999),
    "Friendship": ("우정", "성향·재화", 0, 999999),
    "Fight": ("권법", "병기·무학", 0, 999999),
    "Sword": ("검법", "병기·무학", 0, 999999),
    "Blade": ("도법", "병기·무학", 0, 999999),
    "Spear": ("창곤", "병기·무학", 0, 999999),
    "Arrow": ("암기·궁술", "병기·무학", 0, 999999),
    "Short": ("단병", "병기·무학", 0, 999999),
    "Doctor": ("의술", "생활·기예", 0, 999999),
    "Poison": ("독술", "생활·기예", 0, 999999),
    "Neigong": ("내공", "생활·기예", 0, 999999),
    "Qinggong": ("경공", "생활·기예", 0, 999999),
    "HurbKnowledge": ("약초 지식", "생활·기예", 0, 999999),
    "MineralKnowledge": ("광물 지식", "생활·기예", 0, 999999),
    "StealKnowledge": ("도둑 지식", "생활·기예", 0, 999999),
    "BusinessKnowledge": ("상업 지식", "생활·기예", 0, 999999),
    "PercentageHP": ("HP 비율", "기본", 0, 100),
    "PercentageMP": ("MP 비율", "기본", 0, 100),
    "TalentPoint": ("재능 포인트", "기본", 0, 999999),
    "CurrentPower": ("현재 전투력", "기본", 0, 999999999),
    "PercentageMaxHP": ("최대 HP 비율", "기본", 0, 100),
    "PercentageMaxMP": ("최대 MP 비율", "기본", 0, 100),
    "Injured": ("부상", "상태이상", 0, 1),
    "Wounded": ("중상", "상태이상", 0, 1),
    "Poisoned": ("중독", "상태이상", 0, 1),
    "Sealed": ("봉인", "상태이상", 0, 1),
    "Confused": ("혼란", "상태이상", 0, 1),
    "Dazed": ("현기증", "상태이상", 0, 1),
    "Cramped": ("경련", "상태이상", 0, 1),
    "Sprained": ("삐끗함", "상태이상", 0, 1),
    "Exhausted": ("탈진", "상태이상", 0, 1),
    "Frozen": ("동결", "상태이상", 0, 1),
    "Drunk": ("취함", "상태이상", 0, 1),
}


def clean_text(value):
    """Remove markup, CJK-containing parentheses/brackets, CJK, and normalize spaces."""
    text = str(value or "")
    text = TAG_RE.sub("", text)
    text = PAREN_CJK_RE.sub("", text)
    text = CJK_RE.sub("", text)
    return " ".join(text.split()).strip()


def has_cjk(text):
    return bool(CJK_RE.search(str(text)))


def has_tag(text):
    return bool(TAG_RE.search(str(text)))


def read_rows(path):
    """Read TSV rows, skipping blanks and comment lines."""
    rows = []
    with path.open("r", encoding="utf-8-sig", errors="replace") as f:
        for raw in f:
            line = raw.rstrip("\n\r")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            rows.append(line.split("\t"))
    return rows


def cell(row, idx):
    return row[idx] if idx < len(row) else ""


def clean_int(value, default=0):
    text = clean_text(value)
    if not text:
        return default
    try:
        return int(float(text.replace(",", "")))
    except ValueError:
        return default


def clean_float(value, default=0.0):
    text = clean_text(value)
    if not text:
        return default
    try:
        return float(text.replace(",", ""))
    except ValueError:
        return default


def valid_name(name):
    return bool(name) and name.lower() not in {"temp", "test"} and not has_cjk(name)


def extract_normal_inventory(source_dir):
    result = {}
    path = source_dir / "normalinventoryitem.txt"
    if not path.exists():
        return result
    for row in read_rows(path):
        item_id = clean_text(cell(row, 0))
        name = clean_text(cell(row, 1))
        if not item_id or not valid_name(name):
            continue
        result[item_id] = {
            "id": item_id,
            "name": name,
            "description": clean_text(cell(row, 3)),
            "category": clean_text(cell(row, 4)),
            "price": clean_int(cell(row, 5)),
            "weight": clean_float(cell(row, 9)),
            "effects": clean_text(cell(row, 16)),
        }
    return result


def extract_equipment(source_dir):
    result = {}
    path = source_dir / "equipinventoryitem.txt"
    if not path.exists():
        return result
    for row in read_rows(path):
        item_id = clean_text(cell(row, 0))
        name = clean_text(cell(row, 1))
        if not item_id or not valid_name(name):
            continue
        cat_code = clean_int(cell(row, 4))
        if cat_code == 201:
            category = "Cloth"
        elif cat_code == 202:
            category = "Jewelry"
        elif cat_code == 203:
            category = "Fashion"
        else:
            category = "Weapon"
        result[item_id] = {
            "id": item_id,
            "name": name,
            "description": clean_text(cell(row, 3)),
            "category": category,
            "categoryCode": cat_code,
            "price": clean_int(cell(row, 5)),
            "weight": clean_float(cell(row, 9)),
            "level": clean_int(cell(row, 11)),
            "durability": clean_int(cell(row, 12)),
            "maxDurability": clean_int(cell(row, 13)),
            "hurt": clean_text(cell(row, 14)),
            "hurtDiff": clean_int(cell(row, 15)),
            "effects": clean_text(cell(row, 16)),
        }
    return result


def extract_skills(source_dir):
    names = {
        301: "권법",
        302: "검법",
        303: "도법",
        304: "창곤",
        305: "암기·궁술",
        306: "단병",
        307: "내공",
        308: "경공",
        309: "특수",
        310: "기타",
        318: "전속무학",
    }
    result = {}
    path = source_dir / "skilltreeitem.txt"
    if not path.exists():
        return result
    for row in read_rows(path):
        item_id = clean_text(cell(row, 0))
        name = clean_text(cell(row, 1))
        if not item_id or not valid_name(name):
            continue
        cat_code = clean_int(cell(row, 4))
        result[item_id] = {
            "id": item_id,
            "name": name,
            "description": clean_text(cell(row, 3)),
            "categoryCode": cat_code,
            "category": names.get(cat_code, ""),
            "treeId": clean_text(cell(row, 11)),
            "weaponType": clean_text(cell(row, 12)),
        }
    return result


def extract_talents(source_dir):
    trees = {"0": "동", "1": "정", "2": "강", "3": "유", "4": "교", "5": "졸"}
    result = {}
    path = source_dir / "talentitem.txt"
    if not path.exists():
        return result
    for row in read_rows(path):
        raw_id = clean_text(cell(row, 0))
        name = clean_text(cell(row, 1))
        if not raw_id or not valid_name(name):
            continue
        tree_key = raw_id.split("_", 1)[0] if "_" in raw_id else ""
        result[raw_id] = {
            "id": raw_id,
            "name": name,
            "description": clean_text(cell(row, 2)),
            "tree": tree_key,
            "treeName": trees.get(tree_key, ""),
        }
    return result


def extract_nicknames(source_dir):
    result = {}
    path = source_dir / "nicknameitem.txt"
    if not path.exists():
        return result
    for row in read_rows(path):
        item_id = clean_text(cell(row, 0))
        name = clean_text(cell(row, 1))
        if not item_id or not valid_name(name):
            continue
        result[item_id] = {
            "id": item_id,
            "name": name,
            "description": clean_text(cell(row, 2)),
            "bonus": clean_text(cell(row, 3)),
        }
    return result


def extract_simple_map(source_dir, filename):
    result = {}
    path = source_dir / filename
    if not path.exists():
        return result
    for row in read_rows(path):
        item_id = clean_text(cell(row, 0))
        name = clean_text(cell(row, 1))
        if not item_id or not valid_name(name):
            continue
        result[item_id] = name
    return result


def extract_buffs(source_dir):
    result = {}
    path = source_dir / "bufferitem.txt"
    if not path.exists():
        return result
    for row in read_rows(path):
        item_id = clean_text(cell(row, 0))
        name = clean_text(cell(row, 1))
        if not item_id or not valid_name(name):
            continue
        result[item_id] = {
            "id": item_id,
            "name": name,
            "description": clean_text(cell(row, 2)),
        }
    return result


def build_stats():
    return {
        key: {
            "label": label,
            "group": group,
            "min": minimum,
            "max": maximum,
        }
        for key, (label, group, minimum, maximum) in STATS.items()
    }


def build_catalog(source_dir):
    return {
        "generatedBy": "tools/extract_catalog.py",
        "stats": build_stats(),
        "difficulties": {
            "0": "쉬움",
            "1": "보통",
            "2": "어려움",
            "3": "종사",
            "4": "없음",
            "5": "확장 난이도",
        },
        "equipSlots": {
            "MajorWeapon": "주무기",
            "MinorWeapon": "보조무기",
            "Cloth": "의복",
            "Jewelry": "장신구",
            "Book": "비급",
            "Fashion": "외형 의상",
        },
        "talentTrees": {
            "0": "동",
            "1": "정",
            "2": "강",
            "3": "유",
            "4": "교",
            "5": "졸",
        },
        "codeAtlas": {
            "saveFormat": "HELUO_1_1",
            "inventoryNoList": "inventoryNoList sync",
            "TalentData": "TalentData",
            "SkillTree": "SkillTree",
            "CharacterData": "Character.Data",
            "modCompatibility": "mod compatibility",
            "normalInventory": "normalInvetoryItem",
            "equipment": "equipInventoryItem",
            "skills": "skillTreeItem",
            "talents": "talentItem",
            "nicknames": "nicknameItem",
            "areas": "areaItem",
            "teleporters": "teleporterItem",
            "npcs": "npcItem",
            "buffs": "bufferItem",
        },
        "normalInventory": extract_normal_inventory(source_dir),
        "equipment": extract_equipment(source_dir),
        "skills": extract_skills(source_dir),
        "talents": extract_talents(source_dir),
        "nicknames": extract_nicknames(source_dir),
        "areas": extract_simple_map(source_dir, "areaitem.txt"),
        "teleporters": extract_simple_map(source_dir, "teleporteritem.txt"),
        "npcNames": extract_simple_map(source_dir, "npcitem.txt"),
        "buffs": extract_buffs(source_dir),
    }


def check_no_forbidden(data):
    text = json.dumps(data, ensure_ascii=False)
    if has_cjk(text):
        raise SystemExit("error: catalog still contains CJK text")
    if has_tag(text):
        raise SystemExit("error: catalog still contains <...> tags")


def check_existing(output):
    if not output.exists():
        raise SystemExit(f"error: missing {output}")
    text = output.read_text(encoding="utf-8")
    marker = "  return {"
    start = text.find(marker)
    if start < 0:
        raise SystemExit("error: catalog-data.js parse marker not found")
    start += len("  return ")
    end = text.rfind(";\n}));")
    if end < 0:
        end = text.rfind(";")
    payload = text[start:end].strip()
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"error: catalog-data.js does not parse: {exc}")
    required = [
        "stats", "difficulties", "equipSlots", "talentTrees", "codeAtlas",
        "normalInventory", "equipment", "skills", "talents", "nicknames",
        "areas", "teleporters", "npcNames", "buffs",
    ]
    missing = [key for key in required if key not in data]
    if missing:
        raise SystemExit(f"error: missing keys: {', '.join(missing)}")
    if len(data.get("stats", {})) != 48:
        raise SystemExit("error: stats must contain all 48 Character.Data keys")
    if has_cjk(text):
        raise SystemExit("error: catalog-data.js contains CJK text")
    if has_tag(text):
        raise SystemExit("error: catalog-data.js contains <...> tags")
    print(f"OK: {output} parses and contains required keys")


def write_umd(output, catalog):
    check_no_forbidden(catalog)
    payload = json.dumps(catalog, ensure_ascii=False, indent=2, sort_keys=True)
    js = (
        "/* Auto-generated by tools/extract_catalog.py. Do not edit manually. */\n"
        "(function (root, factory) {\n"
        "  if (typeof module === 'object' && module.exports) module.exports = factory();\n"
        "  else root.HtlsCatalog = factory();\n"
        "}(typeof window !== 'undefined' ? window : this, function () {\n"
        f"  return {payload};\n"
        "}));\n"
    )
    assert not has_cjk(js), "output contains CJK"
    assert not has_tag(js), "output contains <...> tags"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(js, encoding="utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Extract Ho Tu Lo Shu catalog data")
    parser.add_argument("--source-dir", default=DEFAULT_SOURCE_DIR)
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args(argv)

    output = Path(args.output)
    if args.check_only:
        check_existing(output)
        return 0

    source_dir = Path(args.source_dir)
    if not source_dir.is_dir():
        raise SystemExit(f"error: source dir not found: {source_dir}")

    catalog = build_catalog(source_dir)
    if len(catalog.get("stats", {})) != 48:
        raise SystemExit("error: stats metadata must contain 48 keys")
    write_umd(output, catalog)
    print(f"wrote {output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
