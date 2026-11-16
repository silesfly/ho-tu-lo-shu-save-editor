#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""하락군협전 세이브 에디터 v1.0 (htls_editor.py)"""
import argparse
import hashlib
import json
import os
import random
import re
import secrets
import shutil
import struct
import sys
import tempfile
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# ---------- 상수 ----------
MAGIC_10 = b"HELUO_1_0"
MAGIC_11 = b"HELUO_1_1"
MAGIC_LEN = 9
EXT_TYPE = 99
GAME_EXE = "J2.exe"
SIM_ENV = "HTLS_SIMULATE_GAME_RUNNING"
RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}

# ---------- 한글 메시지 ----------
K_ERR_MAGIC = "알 수 없는 세이브 파일 형식입니다."
K_ERR_PATH = "허용되지 않은 경로입니다."
K_ERR_EXT = "확장자는 .save 여야 합니다."
K_ERR_GAME = "게임이 실행 중입니다. 종료 후 다시 시도하세요."
K_ERR_PARSE = "세이브 파일을 해석할 수 없습니다."
K_OK = "성공"
K_BAK = "백업 생성 완료"
K_WRITE = "저장 완료"

# ---------- 오류 ----------
class SaveError(Exception):
    pass

# ---------- LZ4 ----------
def lz4_decompress_block(src, expected):
    out = bytearray()
    i = 0
    n = len(src)
    while i < n and len(out) < expected:
        token = src[i]; i += 1
        ll = token >> 4
        if ll == 15:
            while True:
                b = src[i]; i += 1; ll += b
                if b != 255: break
        out += src[i:i+ll]; i += ll
        if i >= n: break
        if i + 2 > n: raise SaveError(K_ERR_PARSE)
        off = src[i] | (src[i+1] << 8); i += 2
        if off == 0 or off > len(out): raise SaveError(K_ERR_PARSE)
        ml = (token & 0xF) + 4
        if (token & 0xF) == 15:
            while True:
                b = src[i]; i += 1; ml += b
                if b != 255: break
        start = len(out) - off
        for k in range(ml):
            out.append(out[start + k])
    if len(out) != expected:
        raise SaveError(K_ERR_PARSE)
    return bytes(out)

def lz4_compress_block(data):
    n = len(data)
    out = bytearray()
    if n == 0:
        return bytes(out)
    HASH_SIZE = 1 << 16
    table = [-1] * HASH_SIZE
    anchor = 0
    i = 0
    LIMIT = n - 12
    def h4(p):
        v = data[p] | (data[p+1] << 8) | (data[p+2] << 16) | (data[p+3] << 24)
        return ((v * 2654435761) & 0xFFFFFFFF) >> 16
    while i < LIMIT:
        h = h4(i) & 0xFFFF
        ref = table[h]
        table[h] = i
        if ref >= 0 and ref < i and i - ref <= 65535 and data[ref:ref+4] == data[i:i+4]:
            ln = 4
            while i + ln < n - 5 and ref + ln < i and data[i+ln] == data[ref+ln]:
                ln += 1
            emit_match(out, data, anchor, i, ref, ln)
            i += ln
            anchor = i
        else:
            i += 1
    # last literals
    emit_last_literals(out, data, anchor, n)
    return bytes(out)

def emit_match(out, data, anchor, i, ref, ln):
    lit_len = i - anchor
    mlen = ln - 4
    tok_pos = len(out); out.append(0)
    token = 0
    if lit_len >= 15:
        token |= 0xF0; out.extend(b"\xff" * ((lit_len - 15) // 255))
        out.append((lit_len - 15) % 255)
    else:
        token |= lit_len << 4
    if mlen >= 15:
        token |= 0x0F
    else:
        token |= mlen
    out[tok_pos] = token
    out += data[anchor:i]
    off = i - ref
    out.append(off & 0xFF); out.append((off >> 8) & 0xFF)
    if mlen >= 15:
        rem = mlen - 15
        out.extend(b"\xff" * (rem // 255))
        out.append(rem % 255)

def emit_last_literals(out, data, anchor, n):
    lit_len = n - anchor
    if lit_len == 0:
        return
    if lit_len >= 15:
        out.append(0xF0)
        rem = lit_len - 15
        out.extend(b"\xff" * (rem // 255))
        out.append(rem % 255)
    else:
        out.append(lit_len << 4)
    out += data[anchor:n]

# ---------- MessagePack AST ----------
class MpTag:
    __slots__ = ("kind", "value")
    def __init__(self, kind, value):
        self.kind = kind
        self.value = value
    def __repr__(self):
        return f"MpTag({self.kind},{self.value!r})"

class MpMap:
    """순서 보존, 원시 바이트 보존 맵"""
    __slots__ = ("entries",)  # list of [key, value, raw_key_bytes, raw_val_bytes]
    def __init__(self, entries=None):
        self.entries = entries if entries is not None else []
    def get(self, k, default=None):
        for e in self.entries:
            if e[0] == k:
                return e[1]
        return default
    def set(self, k, v):
        for e in self.entries:
            if e[0] == k:
                e[1] = v; e[2] = None; e[3] = None
                return
        self.entries.append([k, v, None, None])
    def keys(self):
        return [e[0] for e in self.entries]
    def __contains__(self, k):
        return any(e[0] == k for e in self.entries)

class MpExt:
    __slots__ = ("type", "data")
    def __init__(self, type_, data):
        self.type = type_; self.data = data

class MpBin(bytes):
    pass

class MpF32(float):
    pass
class MpI64(int):
    pass
class MpU64(int):
    pass

# ---------- MessagePack 파서 ----------
class MpParser:
    def __init__(self, data, start=0, end=None):
        self.data = data
        self.i = start
        self.end = end if end is not None else len(data)
    def remain(self):
        return self.end - self.i
    def read(self, n):
        if self.i + n > self.end: raise SaveError(K_ERR_PARSE)
        b = self.data[self.i:self.i+n]; self.i += n
        return b
    def parse(self):
        return self._parse_value()
    def _parse_value(self):
        start = self.i
        b = self.read(1)[0]
        if b <= 0x7f: 
            return b
        if b >= 0xe0:
            return b - 0x100
        if 0x80 <= b <= 0x8f:
            return self._parse_map(b & 0x0F)
        if 0x90 <= b <= 0x9f:
            return self._parse_array(b & 0x0F)
        if 0xa0 <= b <= 0xbf:
            return self._parse_str(b & 0x1F)
        if b == 0xc0: return None
        if b == 0xc2: return False
        if b == 0xc3: return True
        if b == 0xc4: return self._parse_bin(self._read_uint(1))
        if b == 0xc5: return self._parse_bin(self._read_uint(2))
        if b == 0xc6: return self._parse_bin(self._read_uint(4))
        if b in (0xc7, 0xc8, 0xc9):
            n = self._read_uint(1 << (b - 0xc7))
            et = self.read(1)[0]
            return MpExt(et, self.read(n))
        if b == 0xca:
            return MpF32(struct.unpack(">f", self.read(4))[0])
        if b == 0xcb:
            return struct.unpack(">d", self.read(8))[0]
        if b == 0xcc: return self._read_uint(1)
        if b == 0xcd: return self._read_uint(2)
        if b == 0xce: return self._read_uint(4)
        if b == 0xcf: return MpU64(self._read_uint(8))
        if b == 0xd0: return self._read_int(1)
        if b == 0xd1: return self._read_int(2)
        if b == 0xd2: return self._read_int(4)
        if b == 0xd3: return MpI64(self._read_int(8))
        if b == 0xd4: 
            et = self.read(1)[0]; return MpExt(et, self.read(1))
        if b == 0xd5: 
            et = self.read(1)[0]; return MpExt(et, self.read(2))
        if b == 0xd6: 
            et = self.read(1)[0]; return MpExt(et, self.read(4))
        if b == 0xd7: 
            et = self.read(1)[0]; return MpExt(et, self.read(8))
        if b == 0xd8: 
            et = self.read(1)[0]; return MpExt(et, self.read(16))
        if b == 0xd9: return self._parse_str(self._read_uint(1))
        if b == 0xda: return self._parse_str(self._read_uint(2))
        if b == 0xdb: return self._parse_str(self._read_uint(4))
        if b == 0xdc: return self._parse_array(self._read_uint(2))
        if b == 0xdd: return self._parse_array(self._read_uint(4))
        if b == 0xde: return self._parse_map(self._read_uint(2))
        if b == 0xdf: return self._parse_map(self._read_uint(4))
        raise SaveError(K_ERR_PARSE)
    def _read_uint(self, n):
        v = 0
        for _ in range(n):
            v = (v << 8) | self.read(1)[0]
        return v
    def _read_int(self, n):
        v = self._read_uint(n)
        bits = n * 8
        if v & (1 << (bits - 1)):
            v -= 1 << bits
        return v
    def _parse_str(self, n):
        b = self.read(n)
        try:
            return b.decode("utf-8")
        except Exception:
            return b.decode("latin-1")
    def _parse_bin(self, n):
        return MpBin(self.read(n))
    def _parse_array(self, n):
        return [self._parse_value() for _ in range(n)]
    def _parse_map(self, n):
        m = MpMap()
        for _ in range(n):
            ks = self.i
            k = self._parse_value()
            ke = self.i
            rawk = self.data[ks:ke]
            vs = self.i
            v = self._parse_value()
            ve = self.i
            rawv = self.data[vs:ve]
            m.entries.append([k, v, rawk, rawv])
        return m

# ---------- MessagePack 직렬화 ----------
def _pack_uint(v, fixed_ok=True):
    if fixed_ok:
        if v <= 0x7f: return bytes([v])
        if v <= 0xff: return b"\xcc" + bytes([v])
        if v <= 0xffff: return b"\xcd" + struct.pack(">H", v)
        if v <= 0xffffffff: return b"\xce" + struct.pack(">I", v)
    return b"\xcf" + struct.pack(">Q", v & 0xFFFFFFFFFFFFFFFF)

def _pack_int(v):
    if v >= 0: return _pack_uint(v)
    if v >= -32: return bytes([v & 0xff])
    if v >= -128: return b"\xd0" + struct.pack(">b", v)
    if v >= -32768: return b"\xd1" + struct.pack(">h", v)
    if v >= -2147483648: return b"\xd2" + struct.pack(">i", v)
    return b"\xd3" + struct.pack(">q", v)

def _pack_str(s):
    b = s.encode("utf-8")
    n = len(b)
    if n < 32: return bytes([0xa0 | n]) + b
    if n <= 0xff: return b"\xd9" + bytes([n]) + b
    if n <= 0xffff: return b"\xda" + struct.pack(">H", n) + b
    return b"\xdb" + struct.pack(">I", n) + b

def _pack_bin(b):
    n = len(b)
    if n <= 0xff: return b"\xc4" + bytes([n]) + b
    if n <= 0xffff: return b"\xc5" + struct.pack(">H", n) + b
    return b"\xc6" + struct.pack(">I", n) + b

def mp_pack(v):
    if v is None: return b"\xc0"
    if v is True: return b"\xc3"
    if v is False: return b"\xc2"
    if isinstance(v, MpU64): return b"\xcf" + struct.pack(">Q", int(v) & 0xFFFFFFFFFFFFFFFF)
    if isinstance(v, MpI64): return b"\xd3" + struct.pack(">q", int(v))
    if isinstance(v, MpF32): return b"\xca" + struct.pack(">f", float(v))
    if isinstance(v, MpBin): return _pack_bin(bytes(v))
    if isinstance(v, MpExt):
        d = v.data; et = v.type
        n = len(d)
        if n == 1: return b"\xd4" + bytes([et]) + d
        if n == 2: return b"\xd5" + bytes([et]) + d
        if n == 4: return b"\xd6" + bytes([et]) + d
        if n == 8: return b"\xd7" + bytes([et]) + d
        if n == 16: return b"\xd8" + bytes([et]) + d
        if n <= 0xff: return b"\xc7" + bytes([n, et]) + d
        if n <= 0xffff: return b"\xc8" + struct.pack(">H", n) + bytes([et]) + d
        return b"\xc9" + struct.pack(">I", n) + bytes([et]) + d
    if isinstance(v, dict): return _pack_map(MpMap([[k, val, None, None] for k, val in v.items()]))
    if isinstance(v, MpMap):
        return _pack_map(v)
    if isinstance(v, (list, tuple)):
        return _pack_array(list(v))
    if isinstance(v, str): return _pack_str(v)
    if isinstance(v, (bytes, bytearray)): return _pack_bin(bytes(v))
    if isinstance(v, bool): return b"\xc3" if v else b"\xc2"
    if isinstance(v, int): return _pack_int(v)
    if isinstance(v, float): return b"\xcb" + struct.pack(">d", v)
    raise SaveError(K_ERR_PARSE)

def _pack_map(m):
    n = len(m.entries)
    if n <= 15: out = bytearray([0x80 | n])
    elif n <= 0xffff: out = bytearray(b"\xde" + struct.pack(">H", n))
    else: out = bytearray(b"\xdf" + struct.pack(">I", n))
    for k, val, rk, rv in m.entries:
        out += rk if rk is not None else mp_pack(k)
        out += rv if rv is not None else mp_pack(val)
    return bytes(out)

def _pack_array(a):
    n = len(a)
    if n <= 15: out = bytearray([0x90 | n])
    elif n <= 0xffff: out = bytearray(b"\xdc" + struct.pack(">H", n))
    else: out = bytearray(b"\xdd" + struct.pack(">I", n))
    for x in a:
        out += mp_pack(x)
    return bytes(out)

# ---------- ext32 LZ4 블록 ----------
def decode_lz4_ext(ext):
    if ext.type != EXT_TYPE:
        raise SaveError(K_ERR_PARSE)
    d = ext.data
    if len(d) < 1:
        raise SaveError(K_ERR_PARSE)
    p = MpParser(d, 0)
    expected = int(p.parse())
    payload = d[p.i:]
    if expected < 0 or expected > 96 * 1024 * 1024:
        raise SaveError(K_ERR_PARSE)
    return lz4_decompress_block(payload, expected)

def encode_lz4_ext(raw):
    comp = lz4_compress_block(raw)
    data = b"\xd2" + struct.pack(">i", len(raw)) + comp
    return mp_pack(MpExt(EXT_TYPE, data))

# ---------- 블록 파싱/직렬화 ----------
def _parse_one_block(buf, off):
    p = MpParser(buf, off)
    v = p.parse()
    return v, p.i

def parse_save_bytes(data):
    if len(data) < MAGIC_LEN or data[:MAGIC_LEN] not in (MAGIC_10, MAGIC_11):
        raise SaveError(K_ERR_MAGIC)
    magic = data[:MAGIC_LEN]
    off = MAGIC_LEN
    header_val, off = _parse_one_block(data, off)
    gamedata_val, off = _parse_one_block(data, off)
    # unwrap Ext -> bytes (lz4 raw) -> msgpack
    def materialize(val):
        if isinstance(val, MpExt) and val.type == EXT_TYPE:
            raw = decode_lz4_ext(val)
            p = MpParser(raw)
            return p.parse()
        if isinstance(val, (bytes, bytearray)):
            try:
                p = MpParser(bytes(val)); return p.parse()
            except Exception:
                return val
        return val
    header = materialize(header_val)
    gamedata = materialize(gamedata_val)
    return {"magic": magic, "header": header, "gamedata": gamedata}

def parse_save(path):
    with open(path, "rb") as f:
        return parse_save_bytes(f.read())

def serialize_save(save):
    magic = save.get("magic") or MAGIC_10
    if magic not in (MAGIC_10, MAGIC_11):
        magic = MAGIC_10
    hb = mp_pack(save["header"])
    gb = mp_pack(save["gamedata"])
    out = bytearray(magic)
    out += encode_lz4_ext(hb)
    out += encode_lz4_ext(gb)
    return bytes(out)

# ---------- 검증/동기화 ----------
def validate_save(save):
    if "header" not in save or "gamedata" not in save:
        raise SaveError(K_ERR_PARSE)
    if not isinstance(save["header"], MpMap):
        raise SaveError(K_ERR_PARSE)
    if not isinstance(save["gamedata"], MpMap):
        raise SaveError(K_ERR_PARSE)
    return True

def _map_set_if_has(m, k, v):
    if k in m:
        m.set(k, v)

def sync_header(save):
    header = save["header"]
    gd = save["gamedata"]
    sn = gd.get("PlayerSurname") or ""
    gn = gd.get("PlayerName") or ""
    if (sn or gn) and "playerName" in header:
        header.set("playerName", f"{sn}{gn}")
    gd_diff = gd.get("Difficulty")
    if gd_diff is not None and "difficulty" in header:
        header.set("difficulty", gd_diff)
    gd_days = gd.get("DaysFromBeginning")
    if gd_days is not None and "playedDays" in header:
        header.set("playedDays", gd_days)
    tm = gd.get("Teammates")
    if tm is not None and "teammateNames" in header:
        header.set("teammateNames", list(tm))
    ch_map = gd.get("Character")
    if isinstance(ch_map, MpMap) and "playerLevel" in header:
        pl = ch_map.get("Player")
        if isinstance(pl, MpMap) and pl.get("Level") is not None:
            header.set("playerLevel", pl.get("Level"))
    return save

# ---------- 프리셋 ----------
def _hero_chars(gd):
    ch = gd.get("Character")
    if isinstance(ch, MpMap):
        return ch.entries
    return []

def _iter_hero_chars(gd):
    ch = gd.get("Character")
    if isinstance(ch, MpMap):
        for k, v, rk, rv in ch.entries:
            if isinstance(v, MpMap):
                yield k, v

def apply_preset(save, name):
    gd = save["gamedata"]
    if name == "rich_hero":
        _map_set_if_has(gd, "inventoryNoList", gd.get("inventoryNoList"))
        for _, cm in _iter_hero_chars(gd):
            if "Money" in cm: cm.set("Money", 99999999)
            elif "money" in cm: cm.set("money", 99999999)
    elif name == "hero_max_stats":
        for _, cm in _iter_hero_chars(gd):
            for key in list(cm.keys()):
                if key in ("Str","Dex","Int","Con","Luk","STR","DEX","INT","CON","LUK"):
                    cm.set(key, 9999)
                if key in ("StrMax","DexMax","IntMax","ConMax","LukMax"):
                    cm.set(key, 9999)
    elif name == "hero_all_talents":
        for _, cm in _iter_hero_chars(gd):
            if "Talents" in cm:
                t = cm.get("Talents")
                if isinstance(t, list):
                    t[:] = list(range(1, 100))
                    cm.set("Talents", t)
    elif name == "party_heal_cleanse":
        for _, cm in _iter_hero_chars(gd):
            if "Hp" in cm: cm.set("Hp", 99999)
            if "Mp" in cm: cm.set("Mp", 99999)
            for k in ("Poison","Bleed","Burn","Stun","Confuse","Blind","Silence"):
                if k in cm: cm.set(k, 0)
    elif name == "unlock_teleporters":
        lst = gd.get("AvailableTeleporters")
        if not isinstance(lst, list):
            lst = []
        for i in range(1, 200):
            s = f"T{i:03d}"
            if s not in lst: lst.append(s)
        gd.set("AvailableTeleporters", lst)
    elif name == "hero_master_skills":
        for _, cm in _iter_hero_chars(gd):
            if "Skills" in cm:
                sk = cm.get("Skills")
                if isinstance(sk, list):
                    sk[:] = list(range(1, 200))
                    cm.set("Skills", sk)
    else:
        raise SaveError("알 수 없는 프리셋입니다.")
    return save

PRESETS = {
    "rich_hero": "부유한 영웅",
    "hero_max_stats": "능력치 최대",
    "hero_all_talents": "모든 재능",
    "party_heal_cleanse": "파티 회복/정화",
    "unlock_teleporters": "순간이동 해제",
    "hero_master_skills": "모든 기술 습득",
}

# ---------- 보안/경로 ----------
def _is_windows():
    return os.name == "nt"

def secure_path(path, must_exist=False):
    if not isinstance(path, str) or not path:
        raise SaveError(K_ERR_PATH)
    if "\x00" in path or path.startswith("\\\\") or path.startswith("//"):
        raise SaveError(K_ERR_PATH)
    if ".." in path.split(os.sep) or ".." in path.split("/"):
        raise SaveError(K_ERR_PATH)
    base = os.path.basename(path)
    if base.upper().split(".")[0] in RESERVED_NAMES:
        raise SaveError(K_ERR_PATH)
    # ADS
    if ":" in (os.path.splitdrive(path)[1] if _is_windows() else path):
        raise SaveError(K_ERR_PATH)
    if not base.lower().endswith(".save"):
        raise SaveError(K_ERR_EXT)
    if os.path.islink(path):
        raise SaveError(K_ERR_PATH)
    cur = os.path.dirname(os.path.abspath(path))
    while True:
        if os.path.islink(cur):
            raise SaveError(K_ERR_PATH)
        parent = os.path.dirname(cur)
        if parent == cur or not os.path.exists(cur):
            break
        cur = parent
    if must_exist:
        if not os.path.isfile(path):
            raise SaveError(K_ERR_PATH)
    return path

def check_game_running():
    if os.environ.get(SIM_ENV) == "1":
        raise SaveError(K_ERR_GAME)
    if os.name == "nt":
        try:
            import subprocess
            out = subprocess.run(["tasklist", "/FI", f"IMAGENAME eq {GAME_EXE}"],
                                 capture_output=True, timeout=3, text=True)
            if GAME_EXE.lower() in (out.stdout or "").lower():
                raise SaveError(K_ERR_GAME)
        except SaveError:
            raise
        except Exception:
            pass
    else:
        import glob
        for p in glob.glob("/proc/[0-9]*/comm"):
            try:
                with open(p, "r", encoding="utf-8", errors="replace") as pf:
                    if pf.read().strip() == GAME_EXE:
                        raise SaveError(K_ERR_GAME)
            except SaveError:
                raise
            except Exception:
                pass

def _sha256(data):
    return hashlib.sha256(data).hexdigest()

def backup_and_write(path, data):
    check_game_running()
    secure_path(path)
    bak = None
    if os.path.exists(path):
        with open(path, "rb") as f:
            orig = f.read()
        h = _sha256(orig)
        stem = path
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        rnd = secrets.token_hex(4)
        bak = f"{stem}.backup-{ts}-{rnd}.bak"
        bak_fd = os.open(bak, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(bak_fd, "wb") as bf:
                bak_fd = None
                bf.write(orig)
                bf.flush()
                os.fsync(bf.fileno())
        finally:
            if bak_fd is not None:
                os.close(bak_fd)
        with open(bak, "rb") as f:
            bak_hash = _sha256(f.read())
        if bak_hash != h:
            raise SaveError(K_BAK)

    abs_dir = os.path.dirname(os.path.abspath(path))
    data_hash = _sha256(data)
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=abs_dir,
            prefix=os.path.basename(path) + ".pending-",
            suffix=".tmp",
            delete=False,
        ) as tf:
            tmp_path = tf.name
            tf.write(data)
            tf.flush()
            os.fsync(tf.fileno())
        with open(tmp_path, "rb") as rf:
            if _sha256(rf.read()) != data_hash:
                raise SaveError(K_ERR_PATH)
        os.replace(tmp_path, path)
        tmp_path = None
    finally:
        if tmp_path is not None and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    return bak

# ---------- 데모 ----------
def _make_demo_gamedata():
    gd = MpMap()
    gd.set("PlayerSurname", "김")
    gd.set("PlayerName", "무명")
    gd.set("Difficulty", 2)
    gd.set("DaysFromBeginning", 1)
    gd.set("SkillExpDistributionRate", MpF32(1.0))
    gd.set("SkillExpDistributionLevel", 0)
    gd.set("Teammates", ["홍길동"])
    gd.set("AvailableTeleporters", ["T001","T002"])
    gd.set("AvailableNicknames", ["초보"])
    gd.set("inventoryNoList", [1,2,3])
    chars = MpMap()
    cm = MpMap()
    cm.set("Hp", 100); cm.set("Mp", 50)
    cm.set("Str", 5); cm.set("Dex", 5); cm.set("Int", 5); cm.set("Con", 5); cm.set("Luk", 5)
    cm.set("Skills", [1,2,3])
    cm.set("Talents", [1,2,3])
    chars.set("player", cm)
    gd.set("Character", chars)
    gd.set("NpcEntitiesSaveData", MpBin(b""))
    gd.set("EventCubeEntitiesSaveData", MpBin(b""))
    gd.set("ScreenShot", MpBin(b""))
    gd.set("Flag", MpMap())
    gd.set("Quest", MpMap())
    return gd

def _make_demo_header(with_name):
    h = MpMap()
    h.set("saveTime", MpI64(int(time.time())))
    h.set("playedTime", MpI64(0))
    h.set("playedDays", 1)
    h.set("trackedQuestId", "")
    h.set("modName", "")
    h.set("modId", "")
    h.set("teammateNames", [])
    h.set("difficulty", 2)
    h.set("screenShotData", MpBin(b""))
    if with_name:
        h.set("playerName", "무명")
        h.set("playerLevel", 1)
    return h

def create_demo_save(out_path, version="1_0"):
    magic = MAGIC_11 if version == "1_1" else MAGIC_10
    save = {
        "magic": magic,
        "header": _make_demo_header(version == "1_1"),
        "gamedata": _make_demo_gamedata(),
    }
    data = serialize_save(save)
    with open(out_path, "wb") as f:
        f.write(data)
    return save

# ---------- CLI 출력 ----------
def pretty(obj, indent=0):
    pad = "  " * indent
    if isinstance(obj, MpMap):
        lines = ["{"]
        for k, v, _, _ in obj.entries:
            lines.append(f"{pad}  {k!r}: {pretty(v, indent+1)},")
        lines.append(pad + "}")
        return "\n".join(lines)
    if isinstance(obj, list):
        if len(obj) <= 5 and all(not isinstance(x,(MpMap,list)) for x in obj):
            return "[" + ", ".join(pretty(x, indent) for x in obj) + "]"
        lines = ["["]
        for v in obj:
            lines.append(f"{pad}  {pretty(v, indent+1)},")
        lines.append(pad + "]")
        return "\n".join(lines)
    if isinstance(obj, MpExt):
        return f"MpExt(타입={obj.type}, 길이={len(obj.data)})"
    if isinstance(obj, bytes):
        return f"바이너리({len(obj)}바이트)"
    if isinstance(obj, float): return f"{obj!r}"
    return repr(obj)

def _to_jsonable(obj):
    if isinstance(obj, MpMap):
        return {str(k): _to_jsonable(v) for k, v, _, _ in obj.entries}
    if isinstance(obj, list):
        return [_to_jsonable(x) for x in obj]
    if isinstance(obj, bytes):
        return {"__bin__": obj.hex()}
    if isinstance(obj, MpExt):
        return {"__ext__": obj.type, "data": obj.data.hex()}
    if isinstance(obj, MpF32): return float(obj)
    return obj

# ---------- CLI 명령 ----------
def cmd_demo(args):
    p = secure_path(args.out) if args.out.lower().endswith(".save") else (args.out + ".save")
    if not p.lower().endswith(".save"): p += ".save"
    d = os.path.dirname(os.path.abspath(p))
    os.makedirs(d, exist_ok=True)
    ver = "1_1" if getattr(args, "version", "1_0") == "1_1" else "1_0"
    create_demo_save(p, ver)
    print(f"{K_OK}: {p}")

def cmd_inspect(args):
    safe = secure_path(args.save, must_exist=True)
    save = parse_save(safe)
    print(f"형식: {save['magic'].decode('ascii')}")
    print("== 머리글 ==")
    print(pretty(save["header"]))
    print("== 게임 데이터 ==")
    gd = save["gamedata"]
    small = MpMap()
    for k, v, _, _ in gd.entries:
        if k in ("NpcEntitiesSaveData","EventCubeEntitiesSaveData","ScreenShot","Flag","Quest"):
            small.entries.append([k, f"<원본 유지: {type(v).__name__}>", None, None])
        else:
            small.entries.append([k, v, None, None])
    print(pretty(small))

def cmd_validate(args):
    safe = secure_path(args.save, must_exist=True)
    save = parse_save(safe)
    validate_save(save)
    print(K_OK)

def cmd_presets(_args):
    for k, v in PRESETS.items():
        print(f"{k}\t{v}")

def cmd_edit(args):
    src = secure_path(args.save, must_exist=True)
    out = args.out or src
    out = secure_path(out) if out.lower().endswith(".save") else (out + ".save")
    save = parse_save(src)
    validate_save(save)
    if args.preset:
        for p in args.preset:
            apply_preset(save, p)
    gd = save["gamedata"]
    ch_map = gd.get("Character")
    if args.money is not None:
        if isinstance(ch_map, MpMap) and isinstance(ch_map.get("Player"), MpMap):
            pl = ch_map.get("Player")
            pdata = pl.get("Data")
            if isinstance(pdata, MpMap):
                pm = pdata.get("Money")
                if isinstance(pm, MpMap):
                    pm.set("Base", int(args.money))
                else:
                    m_map = MpMap()
                    m_map.set("Base", int(args.money))
                    pdata.set("Money", m_map)
    if args.level is not None:
        if isinstance(ch_map, MpMap) and isinstance(ch_map.get("Player"), MpMap):
            ch_map.get("Player").set("Level", int(args.level))
        hdr = save["header"]
        if "playerLevel" in hdr: hdr.set("playerLevel", int(args.level))
    sync_header(save)
    validate_save(save)
    data = serialize_save(save)
    backup_and_write(out, data)
    print(f"{K_WRITE}: {out}")

# ---------- HTTP 서버 ----------
HTML_DEFAULT = "dist/HoTuLoShuSaveEditor-v1.0.html"

def _safe_root_save(root, name, must_exist=False):
    if not isinstance(name, str) or not name:
        raise SaveError(K_ERR_PATH)
    real_root = os.path.realpath(root)
    joined = os.path.abspath(os.path.join(real_root, name))
    if not joined.startswith(real_root + os.sep):
        raise SaveError(K_ERR_PATH)
    real_target = os.path.realpath(joined)
    if not real_target.startswith(real_root + os.sep):
        raise SaveError(K_ERR_PATH)
    return secure_path(joined, must_exist=must_exist)

class ApiHandler(BaseHTTPRequestHandler):
    server_version = "HTLS/1.0"
    def log_message(self, *a): pass
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def _origin_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"): return False
        origin = self.headers.get("Origin")
        if origin:
            oh = urlparse(origin).hostname
            if oh not in ("127.0.0.1", "localhost"): return False
        sfs = self.headers.get("Sec-Fetch-Site")
        if sfs and sfs not in ("same-origin", "none"): return False
        return True
    def _token_ok(self):
        exp = getattr(self.server, "token", "")
        got = self.headers.get("X-HTLS-Token", "")
        return secrets.compare_digest(exp, got)
    def do_GET(self):
        if not self._origin_ok():
            return self._send(403, {"오류": "출처 거부"})
        u = urlparse(self.path)
        if u.path == "/":
            html = os.path.join(getattr(self.server, "root", "."), HTML_DEFAULT)
            if not os.path.isfile(html):
                return self._send(404, "화면 파일 없음", "text/plain; charset=utf-8")
            with open(html, "rb") as hf:
                return self._send(200, hf.read(), "text/html; charset=utf-8")
        if u.path == "/api/info":
            root = getattr(self.server, "root", ".")
            saves = sorted(
                fn for fn in os.listdir(root)
                if fn.lower().endswith(".save") and os.path.isfile(os.path.join(root, fn))
                and not os.path.islink(os.path.join(root, fn))
            )
            return self._send(200, {
                "ok": True,
                "이름": "하락군협전 세이브 에디터",
                "버전": "1.0",
                "token": getattr(self.server, "token", ""),
                "saves": saves,
                "프리셋": list(PRESETS.keys())
            })
        if u.path == "/api/load":
            q = parse_qs(u.query)
            name = (q.get("name") or [""])[0]
            try:
                root = getattr(self.server, "root", ".")
                full = _safe_root_save(root, name, must_exist=True)
                save = parse_save(full)
                validate_save(save)
                with open(full, "rb") as sf:
                    raw = sf.read()
                return self._send(200, raw, "application/octet-stream")
            except SaveError as e:
                return self._send(400, {"오류": str(e)})
            except Exception as e:
                return self._send(500, {"오류": str(e)})
        return self._send(404, {"오류":"없음"})
    def do_POST(self):
        if not self._origin_ok():
            return self._send(403, {"오류": "출처 거부"})
        if not self._token_ok():
            return self._send(401, {"오류": "토큰 거부"})
        ct = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ct != "application/json":
            return self._send(415, {"오류": "형식 거부"})
        u = urlparse(self.path)
        if u.path != "/api/save":
            return self._send(404, {"오류":"없음"})
        try:
            import base64
            ln = int(self.headers.get("Content-Length") or 0)
            if ln <= 0 or ln > 48 * 1024 * 1024:
                return self._send(413, {"오류": "요청 크기 초과"})
            body = self.rfile.read(ln)
            req = json.loads(body.decode("utf-8"))
            name = req.get("name", "")
            root = getattr(self.server, "root", ".")
            full = _safe_root_save(root, name, must_exist=False)
            b64 = req.get("data") or req.get("dataB64")
            if b64:
                raw = base64.b64decode(b64, validate=True)
                save = parse_save_bytes(raw)
                validate_save(save)
                bak = backup_and_write(full, raw)
                return self._send(200, {"ok": True, "결과": K_WRITE, "backupPath": bak})
            return self._send(400, {"오류": K_ERR_PARSE})
        except SaveError as e:
            return self._send(400, {"오류": str(e)})
        except Exception as e:
            return self._send(500, {"오류": str(e)})

def cmd_serve(args):
    root = os.path.abspath(args.dir or ".")
    port = int(args.port)
    host = args.host
    if host not in ("127.0.0.1", "localhost"):
        host = "127.0.0.1"
    srv = ThreadingHTTPServer((host, port), ApiHandler)
    srv.root = root
    srv.token = secrets.token_hex(16)
    print(f"주소: http://{host}:{port}/")
    print(f"토큰: {srv.token}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass

# ---------- 진입점 ----------
def build_parser():
    p = argparse.ArgumentParser(prog="htls_editor.py", description="하락군협전 세이브 에디터")
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("demo", help="데모 세이브 생성")
    d.add_argument("out")
    d.add_argument("--version", default="1_0", choices=["1_0","1_1"])
    d.set_defaults(func=cmd_demo)
    i = sub.add_parser("inspect", help="세이브 내용 보기")
    i.add_argument("save"); i.set_defaults(func=cmd_inspect)
    v = sub.add_parser("validate", help="세이브 검증")
    v.add_argument("save"); v.set_defaults(func=cmd_validate)
    pr = sub.add_parser("presets", help="프리셋 목록")
    pr.set_defaults(func=cmd_presets)
    e = sub.add_parser("edit", help="세이브 편집")
    e.add_argument("save")
    e.add_argument("--preset", action="append", default=[])
    e.add_argument("--money", type=int)
    e.add_argument("--level", type=int)
    e.add_argument("--out")
    e.set_defaults(func=cmd_edit)
    s = sub.add_parser("serve", help="웹 서버 실행")
    s.add_argument("--dir", default=".")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8765)
    s.set_defaults(func=cmd_serve)
    return p

def main(argv=None):
    p = build_parser()
    a = p.parse_args(argv)
    try:
        a.func(a)
    except SaveError as e:
        print(f"오류: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"오류: {e}", file=sys.stderr)
        sys.exit(2)

if __name__ == "__main__":
    main()
