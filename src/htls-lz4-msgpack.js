(function (global, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else global.HtlsCodec = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
  const MAX_UNCOMPRESSED_BYTES = 96 * 1024 * 1024;
  const MAX_DEPTH = 64;

  function toU8(v) {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return Uint8Array.from(v || []);
  }

  function readU32BE(b, p) {
    return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  }

  function readI32BE(b, p) {
    return (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
  }

  function writeU32BE(out, p, v) {
    out[p] = (v >>> 24) & 255;
    out[p + 1] = (v >>> 16) & 255;
    out[p + 2] = (v >>> 8) & 255;
    out[p + 3] = v & 255;
  }

  function writeI32BE(out, p, v) {
    writeU32BE(out, p, v >>> 0);
  }

  function ensureOut(out, pos, need) {
    if (pos + need <= out.length) return out;
    let cap = out.length || 16;
    while (cap < pos + need) cap = Math.max(cap * 2, pos + need);
    const n = new Uint8Array(cap);
    n.set(out.subarray(0, pos));
    return n;
  }

  function lz4DecompressBlock(src, expectedSize) {
    src = toU8(src);
    if (src.length > MAX_COMPRESSED_BYTES) throw new Error('LZ4 compressed block too large');
    const expected = expectedSize >>> 0;
    if (expected > MAX_UNCOMPRESSED_BYTES) throw new Error('LZ4 uncompressed block too large');
    let out = new Uint8Array(expected || Math.max(16, src.length * 4));
    let ip = 0;
    let op = 0;

    function needOut(n) {
      if (op + n <= MAX_UNCOMPRESSED_BYTES && op + n <= out.length) return;
      let cap = out.length || 16;
      while (cap < op + n) cap = Math.max(cap * 2, op + n);
      if (cap > MAX_UNCOMPRESSED_BYTES) cap = MAX_UNCOMPRESSED_BYTES;
      if (cap < op + n) throw new Error('LZ4 output too large');
      const nout = new Uint8Array(cap);
      nout.set(out.subarray(0, op));
      out = nout;
    }

    while (ip < src.length) {
      const token = src[ip++];
      let litLen = token >>> 4;
      if (litLen === 15) {
        let v;
        do {
          if (ip >= src.length) throw new Error('Bad LZ4 literal length');
          v = src[ip++];
          litLen += v;
          if (litLen > MAX_UNCOMPRESSED_BYTES) throw new Error('LZ4 literal too large');
        } while (v === 255);
      }
      if (ip + litLen > src.length) throw new Error('Bad LZ4 literal');
      needOut(litLen);
      out.set(src.subarray(ip, ip + litLen), op);
      ip += litLen;
      op += litLen;

      if (ip >= src.length) break;
      if (ip + 2 > src.length) throw new Error('Bad LZ4 offset');
      const offset = src[ip] | (src[ip + 1] << 8);
      ip += 2;
      if (offset === 0 || offset > op) throw new Error('Bad LZ4 offset');

      let matchLen = token & 15;
      if (matchLen === 15) {
        let v;
        do {
          if (ip >= src.length) throw new Error('Bad LZ4 match length');
          v = src[ip++];
          matchLen += v;
          if (matchLen > MAX_UNCOMPRESSED_BYTES) throw new Error('LZ4 match too large');
        } while (v === 255);
      }
      matchLen += 4;
      needOut(matchLen);
      let mp = op - offset;
      for (let i = 0; i < matchLen; i++) out[op++] = out[mp++];
    }

    if (expected && op !== expected) throw new Error('LZ4 size mismatch');
    return out.slice(0, op);
  }

  function lz4CompressBlock(src) {
    src = toU8(src);
    const n = src.length;
    if (n > MAX_UNCOMPRESSED_BYTES) throw new Error('LZ4 input too large');
    let out = new Uint8Array(Math.max(16, n + (n >>> 8) + 16));
    let op = 0;

    function putByte(v) {
      out = ensureOut(out, op, 1);
      out[op++] = v & 255;
    }

    function putBytes(start, len) {
      out = ensureOut(out, op, len);
      out.set(src.subarray(start, start + len), op);
      op += len;
    }

    function putLen(len) {
      while (len >= 255) {
        putByte(255);
        len -= 255;
      }
      putByte(len);
    }

    if (n < 13) {
      putByte((n << 4) | 0);
      if (n >= 15) putLen(n - 15);
      putBytes(0, n);
      return out.slice(0, op);
    }

    const hash = new Int32Array(65536).fill(-1);
    const last = n - 5;
    let anchor = 0;
    let ip = 0;

    function hash4(p) {
      const v = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0;
      return Math.imul(v, 2654435761) >>> 16;
    }

    while (ip <= last) {
      const h = hash4(ip);
      let match = hash[h];
      hash[h] = ip;
      if (match < 0 || match >= ip || ip - match > 65535) {
        ip++;
        continue;
      }
      if (src[match] !== src[ip] || src[match + 1] !== src[ip + 1] ||
          src[match + 2] !== src[ip + 2] || src[match + 3] !== src[ip + 3]) {
        ip++;
        continue;
      }

      const litLen = ip - anchor;
      let mlen = 4;
      while (ip + mlen < last && src[match + mlen] === src[ip + mlen]) mlen++;

      const tokenPos = op;
      putByte(0);
      let token = 0;
      if (litLen >= 15) {
        token |= 15 << 4;
        putLen(litLen - 15);
      } else {
        token |= litLen << 4;
      }
      putBytes(anchor, litLen);
      const offset = ip - match;
      putByte(offset & 255);
      putByte((offset >>> 8) & 255);
      const mlenCode = mlen - 4;
      if (mlenCode >= 15) {
        token |= 15;
        putLen(mlenCode - 15);
      } else {
        token |= mlenCode;
      }
      out[tokenPos] = token;

      ip += mlen;
      anchor = ip;
      if (ip >= 2 && ip - 2 <= last) hash[hash4(ip - 2)] = ip - 2;
    }

    const litLen = n - anchor;
    const tokenPos = op;
    putByte(0);
    let token = 0;
    if (litLen >= 15) {
      token |= 15 << 4;
      putLen(litLen - 15);
    } else {
      token |= litLen << 4;
    }
    putBytes(anchor, litLen);
    out[tokenPos] = token;

    return out.slice(0, op);
  }

  function decodeLz4Block(bytes, pos) {
    bytes = toU8(bytes);
    pos = pos || 0;
    if (pos >= bytes.length) throw new Error('Unexpected end of LZ4 block');
    const tag = bytes[pos];

    if (tag === 0xc9) {
      if (pos + 6 > bytes.length) throw new Error('Truncated LZ4 block');
      const total = readU32BE(bytes, pos + 1);
      if (total > MAX_COMPRESSED_BYTES) throw new Error('LZ4 frame too large');
      const end = pos + 6 + total;
      if (end > bytes.length) throw new Error('Truncated LZ4 frame');
      const extType = bytes[pos + 5];
      if (extType !== 99) throw new Error('Unsupported ext type');
      const sizeTag = bytes[pos + 6];
      let p = pos + 7;
      let usize;
      if (sizeTag === 0xd2) {
        if (p + 4 > end) throw new Error('Truncated LZ4 size');
        usize = readU32BE(bytes, p) >>> 0;
        p += 4;
      } else if (sizeTag === 0xd1) {
        usize = ((bytes[p] << 8) | bytes[p + 1]) >>> 0;
        p += 2;
      } else if (sizeTag === 0xd0) {
        usize = bytes[p] | 0;
        if (usize < 0) usize += 4294967296;
        p += 1;
      } else if (sizeTag === 0xce) {
        if (p + 4 > end) throw new Error('Truncated LZ4 size');
        usize = readU32BE(bytes, p) >>> 0;
        p += 4;
      } else if (sizeTag === 0xcd) {
        usize = (bytes[p] << 8) | bytes[p + 1];
        p += 2;
      } else if (sizeTag === 0xcc) {
        usize = bytes[p];
        p += 1;
      } else if (sizeTag <= 0x7f) {
        usize = sizeTag;
      } else {
        throw new Error('Unsupported LZ4 uncompressed length type');
      }
      if (usize > MAX_UNCOMPRESSED_BYTES) throw new Error('LZ4 uncompressed block too large');
      const compressed = bytes.subarray(p, end);
      return { payload: lz4DecompressBlock(compressed, usize), nextPos: end, compressed: true };
    }

    if (tag === 0xc8 || tag === 0xc7) {
      let p = pos + 1;
      let len;
      if (tag === 0xc8) {
        if (p + 2 > bytes.length) throw new Error('Truncated ext16');
        len = (bytes[p] << 8) | bytes[p + 1];
        p += 2;
      } else {
        len = bytes[p++];
      }
      if (p >= bytes.length) throw new Error('Truncated ext type');
      const extType = bytes[p++];
      if (extType === 99 && len >= 1) {
        const sizeTag = bytes[p++];
        let usize;
        if (sizeTag === 0xd2) {
          if (p + 4 > bytes.length) throw new Error('Truncated LZ4 size');
          usize = readU32BE(bytes, p) >>> 0;
          p += 4;
        } else if (sizeTag === 0xd1) {
          usize = ((bytes[p] << 8) | bytes[p + 1]) >>> 0;
          p += 2;
        } else if (sizeTag === 0xd0) {
          usize = bytes[p] | 0;
          if (usize < 0) usize += 4294967296;
          p += 1;
        } else if (sizeTag === 0xce) {
          usize = readU32BE(bytes, p) >>> 0;
          p += 4;
        } else if (sizeTag === 0xcd) {
          usize = (bytes[p] << 8) | bytes[p + 1];
          p += 2;
        } else if (sizeTag === 0xcc) {
          usize = bytes[p++];
        } else if (sizeTag <= 0x7f) {
          usize = sizeTag;
        } else {
          throw new Error('Unsupported LZ4 length tag');
        }
        const end = p + (len - (p - (pos + 1 + (tag === 0xc8 ? 2 : 1) + 1)));
        const actualEnd = pos + 1 + (tag === 0xc8 ? 2 : 1) + 1 + len;
        if (actualEnd > bytes.length) throw new Error('Truncated LZ4 ext');
        const compressed = bytes.subarray(p, actualEnd);
        return {
          payload: lz4DecompressBlock(compressed, usize),
          nextPos: actualEnd,
          compressed: true
        };
      }
      const extEnd = p + (len - 1);
      if (extEnd > bytes.length) throw new Error('Truncated ext');
      return { payload: bytes.subarray(pos, extEnd), nextPos: extEnd, compressed: false };
    }

    const next = mpSkip(bytes, pos, 0);
    return { payload: bytes.subarray(pos, next), nextPos: next, compressed: false };
  }

  function encodeLz4Block(payloadBytes) {
    const payload = toU8(payloadBytes);
    if (payload.length > MAX_UNCOMPRESSED_BYTES) throw new Error('Payload too large');
    const lz4 = lz4CompressBlock(payload);
    const out = new Uint8Array(1 + 4 + 1 + 1 + 4 + lz4.length);
    let p = 0;
    out[p++] = 0xc9;
    writeU32BE(out, p, 5 + lz4.length);
    p += 4;
    out[p++] = 0x63;
    out[p++] = 0xd2;
    writeI32BE(out, p, payload.length);
    p += 4;
    out.set(lz4, p);
    return out;
  }

  function mpSkip(bytes, pos, depth) {
    bytes = toU8(bytes);
    if (!(depth >= 0)) depth = 0;
    if (depth > MAX_DEPTH) throw new Error('MessagePack nesting too deep');
    const b = bytes[pos];
    if (b === undefined) throw new Error('Unexpected end of MessagePack');

    if (b <= 0x7f) return pos + 1;
    if (b >= 0xe0) return pos + 1;
    if (b >= 0x80 && b <= 0x8f) {
      let p = pos + 1;
      const n = b & 15;
      for (let i = 0; i < n * 2; i++) p = mpSkip(bytes, p, depth + 1);
      return p;
    }
    if (b >= 0x90 && b <= 0x9f) {
      let p = pos + 1;
      const n = b & 15;
      for (let i = 0; i < n; i++) p = mpSkip(bytes, p, depth + 1);
      return p;
    }
    if (b >= 0xa0 && b <= 0xbf) return pos + 1 + (b & 31);

    switch (b) {
      case 0xc0: case 0xc2: case 0xc3: return pos + 1;
      case 0xc4: return pos + 2 + bytes[pos + 1];
      case 0xc5: return pos + 3 + ((bytes[pos + 1] << 8) | bytes[pos + 2]);
      case 0xc6: return pos + 5 + readU32BE(bytes, pos + 1);
      case 0xc7: return pos + 3 + bytes[pos + 1];
      case 0xc8: return pos + 4 + ((bytes[pos + 1] << 8) | bytes[pos + 2]);
      case 0xc9: return pos + 6 + readU32BE(bytes, pos + 1);
      case 0xca: return pos + 5;
      case 0xcb: return pos + 9;
      case 0xcc: return pos + 2;
      case 0xcd: return pos + 3;
      case 0xce: return pos + 5;
      case 0xcf: return pos + 9;
      case 0xd0: return pos + 2;
      case 0xd1: return pos + 3;
      case 0xd2: return pos + 5;
      case 0xd3: return pos + 9;
      case 0xd4: return pos + 3;
      case 0xd5: return pos + 4;
      case 0xd6: return pos + 6;
      case 0xd7: return pos + 10;
      case 0xd8: return pos + 18;
      case 0xd9: return pos + 2 + bytes[pos + 1];
      case 0xda: return pos + 3 + ((bytes[pos + 1] << 8) | bytes[pos + 2]);
      case 0xdb: return pos + 5 + readU32BE(bytes, pos + 1);
      case 0xdc: return skipN(bytes, pos + 3, (bytes[pos + 1] << 8) | bytes[pos + 2], depth);
      case 0xdd: return skipN(bytes, pos + 5, readU32BE(bytes, pos + 1), depth);
      case 0xde: return skipN(bytes, pos + 3, 2 * ((bytes[pos + 1] << 8) | bytes[pos + 2]), depth);
      case 0xdf: return skipN(bytes, pos + 5, 2 * readU32BE(bytes, pos + 1), depth);
    }
    throw new Error('Unsupported MessagePack tag 0x' + b.toString(16));
  }

  function skipN(bytes, pos, n, depth) {
    let p = pos;
    for (let i = 0; i < n; i++) p = mpSkip(bytes, p, depth + 1);
    return p;
  }

  function parseMapSlices(bytes) {
    bytes = toU8(bytes);
    const entries = [];
    const b = bytes[0];
    let p = 0;
    let n;
    if (b >= 0x80 && b <= 0x8f) {
      n = b & 15;
      p = 1;
    } else if (b === 0xde) {
      n = (bytes[1] << 8) | bytes[2];
      p = 3;
    } else if (b === 0xdf) {
      n = readU32BE(bytes, 1);
      p = 5;
    } else {
      throw new Error('Expected MessagePack map');
    }
    for (let i = 0; i < n; i++) {
      const ks = p;
      p = mpSkip(bytes, p, 0);
      const key = decodeAst(bytes.subarray(ks, p));
      const rawKeyBytes = bytes.slice(ks, p);
      const vs = p;
      p = mpSkip(bytes, p, 0);
      entries.push({ key, rawKeyBytes, rawValBytes: bytes.slice(vs, p) });
    }
    return { entries };
  }

  function buildMapFromSlices(entries) {
    let size = 1;
    let count = entries.length;
    if (count < 16) size = 1;
    else if (count < 65536) size = 3;
    else size = 5;
    for (const e of entries) size += e.rawKeyBytes.length + e.rawValBytes.length;
    const out = new Uint8Array(size);
    let p = 0;
    if (count < 16) out[p++] = 0x80 | count;
    else if (count < 65536) {
      out[p++] = 0xde;
      out[p++] = (count >>> 8) & 255;
      out[p++] = count & 255;
    } else {
      out[p++] = 0xdf;
      writeU32BE(out, p, count);
      p += 4;
    }
    for (const e of entries) {
      out.set(e.rawKeyBytes, p);
      p += e.rawKeyBytes.length;
      out.set(e.rawValBytes, p);
      p += e.rawValBytes.length;
    }
    return out;
  }

  function decodeAst(bytes) {
    bytes = toU8(bytes);
    let p = 0;
    function dec(depth) {
      if (depth > MAX_DEPTH) throw new Error('MessagePack nesting too deep');
      const b = bytes[p++];
      if (b <= 0x7f) return { t: 'pfixint', v: b };
      if (b >= 0xe0) return { t: 'nfixint', v: b - 256 };
      if (b >= 0x80 && b <= 0x8f) {
        const n = b & 15;
        const entries = [];
        for (let i = 0; i < n; i++) {
          const key = dec(depth + 1);
          const val = dec(depth + 1);
          entries.push({ key, val });
        }
        return { t: 'map', v: entries };
      }
      if (b >= 0x90 && b <= 0x9f) return { t: 'arr', v: Array.from({ length: b & 15 }, () => dec(depth + 1)) };
      if (b >= 0xa0 && b <= 0xbf) {
        const len = b & 31;
        const v = bytes.slice(p, p + len);
        p += len;
        return { t: 'fixstr', v };
      }
      switch (b) {
        case 0xc0: return { t: 'nil', v: null };
        case 0xc2: return { t: 'bool', v: false };
        case 0xc3: return { t: 'bool', v: true };
        case 0xca: {
          const raw = bytes.slice(p, p + 4); p += 4;
          return { t: 'f32', v: new DataView(raw.buffer, raw.byteOffset, 4).getFloat32(0, false), raw };
        }
        case 0xcb: {
          const raw = bytes.slice(p, p + 8); p += 8;
          return { t: 'f64', v: new DataView(raw.buffer, raw.byteOffset, 8).getFloat64(0, false), raw };
        }
        case 0xcc: return { t: 'u8', v: bytes[p++] };
        case 0xcd: {
          const v = (bytes[p] << 8) | bytes[p + 1]; p += 2;
          return { t: 'u16', v };
        }
        case 0xce: {
          const v = readU32BE(bytes, p); p += 4;
          return { t: 'u32', v };
        }
        case 0xcf: {
          let v = 0n;
          for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(bytes[p++]);
          return { t: 'u64', v };
        }
        case 0xd0: {
          let v = bytes[p++];
          if (v & 0x80) v -= 256;
          return { t: 'i8', v };
        }
        case 0xd1: {
          let v = (bytes[p] << 8) | bytes[p + 1]; p += 2;
          if (v & 0x8000) v -= 0x10000;
          return { t: 'i16', v };
        }
        case 0xd2: {
          const v = readI32BE(bytes, p); p += 4;
          return { t: 'i32', v };
        }
        case 0xd3: {
          let v = BigInt.asIntN(64, BigInt(readI32BE(bytes, p)) << 32n | BigInt(readU32BE(bytes, p + 4)));
          p += 8;
          return { t: 'i64', v };
        }
        case 0xd9: {
          const len = bytes[p++];
          const v = bytes.slice(p, p + len); p += len;
          return { t: 'str8', v };
        }
        case 0xda: {
          const len = (bytes[p] << 8) | bytes[p + 1]; p += 2;
          const v = bytes.slice(p, p + len); p += len;
          return { t: 'str16', v };
        }
        case 0xdb: {
          const len = readU32BE(bytes, p); p += 4;
          const v = bytes.slice(p, p + len); p += len;
          return { t: 'str32', v };
        }
        case 0xc4: {
          const len = bytes[p++];
          const v = bytes.slice(p, p + len); p += len;
          return { t: 'bin8', v };
        }
        case 0xc5: {
          const len = (bytes[p] << 8) | bytes[p + 1]; p += 2;
          const v = bytes.slice(p, p + len); p += len;
          return { t: 'bin16', v };
        }
        case 0xc6: {
          const len = readU32BE(bytes, p); p += 4;
          const v = bytes.slice(p, p + len); p += len;
          return { t: 'bin32', v };
        }
        case 0xdc: {
          const n = (bytes[p] << 8) | bytes[p + 1]; p += 2;
          return { t: 'arr', v: Array.from({ length: n }, () => dec(depth + 1)) };
        }
        case 0xdd: {
          const n = readU32BE(bytes, p); p += 4;
          return { t: 'arr', v: Array.from({ length: n }, () => dec(depth + 1)) };
        }
        case 0xde: {
          const n = (bytes[p] << 8) | bytes[p + 1]; p += 2;
          const entries = [];
          for (let i = 0; i < n; i++) entries.push({ key: dec(depth + 1), val: dec(depth + 1) });
          return { t: 'map', v: entries };
        }
        case 0xdf: {
          const n = readU32BE(bytes, p); p += 4;
          const entries = [];
          for (let i = 0; i < n; i++) entries.push({ key: dec(depth + 1), val: dec(depth + 1) });
          return { t: 'map', v: entries };
        }
        case 0xd4: return readExt(1);
        case 0xd5: return readExt(2);
        case 0xd6: return readExt(4);
        case 0xd7: return readExt(8);
        case 0xd8: return readExt(16);
        case 0xc7: {
          const len = bytes[p++];
          return readExt(len);
        }
        case 0xc8: {
          const len = (bytes[p] << 8) | bytes[p + 1]; p += 2;
          return readExt(len);
        }
        case 0xc9: {
          const len = readU32BE(bytes, p); p += 4;
          return readExt(len);
        }
      }
      throw new Error('Unsupported MessagePack tag 0x' + b.toString(16));
    }
    function readExt(len) {
      const type = bytes[p++];
      const data = bytes.slice(p, p + len);
      p += len;
      return { t: 'ext', type, v: data };
    }
    const node = dec(0);
    return node;
  }

  function encodeAst(node) {
    const parts = [];
    let total = 0;
    function put(u8) {
      parts.push(u8);
      total += u8.length;
    }
    function enc(n, depth) {
      if (depth > MAX_DEPTH) throw new Error('MessagePack nesting too deep');
      switch (n.t) {
        case 'pfixint': put(Uint8Array.of(n.v & 0x7f)); break;
        case 'nfixint': put(Uint8Array.of(n.v & 0xff)); break;
        case 'nil': put(Uint8Array.of(0xc0)); break;
        case 'bool': put(Uint8Array.of(n.v ? 0xc3 : 0xc2)); break;
        case 'u8': put(Uint8Array.of(0xcc, n.v & 255)); break;
        case 'u16': put(Uint8Array.of(0xcd, (n.v >>> 8) & 255, n.v & 255)); break;
        case 'u32': {
          const a = new Uint8Array(5); a[0] = 0xce; writeU32BE(a, 1, n.v); put(a); break;
        }
        case 'u64': {
          const a = new Uint8Array(9); a[0] = 0xcf;
          let v = BigInt(n.v);
          for (let i = 8; i >= 1; i--) { a[i] = Number(v & 255n); v >>= 8n; }
          put(a); break;
        }
        case 'i8': put(Uint8Array.of(0xd0, n.v & 255)); break;
        case 'i16': put(Uint8Array.of(0xd1, (n.v >>> 8) & 255, n.v & 255)); break;
        case 'i32': {
          const a = new Uint8Array(5); a[0] = 0xd2; writeI32BE(a, 1, n.v); put(a); break;
        }
        case 'i64': {
          const a = new Uint8Array(9); a[0] = 0xd3;
          let v = BigInt.asUintN(64, BigInt(n.v));
          for (let i = 8; i >= 1; i--) { a[i] = Number(v & 255n); v >>= 8n; }
          put(a); break;
        }
        case 'f32': {
          const a = new Uint8Array(5); a[0] = 0xca;
          if (n.raw && n.raw.length === 4) a.set(n.raw, 1);
          else new DataView(a.buffer).setFloat32(1, n.v, false);
          put(a); break;
        }
        case 'f64': {
          const a = new Uint8Array(9); a[0] = 0xcb;
          if (n.raw && n.raw.length === 8) a.set(n.raw, 1);
          else new DataView(a.buffer).setFloat64(1, n.v, false);
          put(a); break;
        }
        case 'fixstr': case 'str8': case 'str16': case 'str32': {
          const v = toU8(n.v);
          if (n.t === 'fixstr' || v.length < 32) {
            if (v.length < 32 && n.t === 'fixstr') put(Uint8Array.of(0xa0 | v.length));
            else if (v.length < 256) put(Uint8Array.of(0xd9, v.length));
            else if (v.length < 65536) put(Uint8Array.of(0xda, (v.length >>> 8) & 255, v.length & 255));
            else { const a = new Uint8Array(5); a[0] = 0xdb; writeU32BE(a, 1, v.length); put(a); }
          } else if (v.length < 256) put(Uint8Array.of(0xd9, v.length));
          else if (v.length < 65536) put(Uint8Array.of(0xda, (v.length >>> 8) & 255, v.length & 255));
          else { const a = new Uint8Array(5); a[0] = 0xdb; writeU32BE(a, 1, v.length); put(a); }
          put(v);
          break;
        }
        case 'bin8': case 'bin16': case 'bin32': {
          const v = toU8(n.v);
          if (v.length < 256) put(Uint8Array.of(0xc4, v.length));
          else if (v.length < 65536) put(Uint8Array.of(0xc5, (v.length >>> 8) & 255, v.length & 255));
          else { const a = new Uint8Array(5); a[0] = 0xc6; writeU32BE(a, 1, v.length); put(a); }
          put(v);
          break;
        }
        case 'arr': {
          const v = n.v || [];
          if (v.length < 16) put(Uint8Array.of(0x90 | v.length));
          else if (v.length < 65536) put(Uint8Array.of(0xdc, (v.length >>> 8) & 255, v.length & 255));
          else { const a = new Uint8Array(5); a[0] = 0xdd; writeU32BE(a, 1, v.length); put(a); }
          for (const x of v) enc(x, depth + 1);
          break;
        }
        case 'map': {
          const v = n.v || [];
          if (v.length < 16) put(Uint8Array.of(0x80 | v.length));
          else if (v.length < 65536) put(Uint8Array.of(0xde, (v.length >>> 8) & 255, v.length & 255));
          else { const a = new Uint8Array(5); a[0] = 0xdf; writeU32BE(a, 1, v.length); put(a); }
          for (const e of v) { enc(e.key, depth + 1); enc(e.val, depth + 1); }
          break;
        }
        case 'ext': {
          const v = toU8(n.v);
          if (v.length === 1) put(Uint8Array.of(0xd4, n.type & 255));
          else if (v.length === 2) put(Uint8Array.of(0xd5, n.type & 255));
          else if (v.length === 4) put(Uint8Array.of(0xd6, n.type & 255));
          else if (v.length === 8) put(Uint8Array.of(0xd7, n.type & 255));
          else if (v.length === 16) put(Uint8Array.of(0xd8, n.type & 255));
          else if (v.length < 256) put(Uint8Array.of(0xc7, v.length, n.type & 255));
          else if (v.length < 65536) put(Uint8Array.of(0xc8, (v.length >>> 8) & 255, v.length & 255, n.type & 255));
          else { const a = new Uint8Array(6); a[0] = 0xc9; writeU32BE(a, 1, v.length); a[5] = n.type & 255; put(a); }
          put(v);
          break;
        }
        default: throw new Error('Unknown AST node type: ' + n.t);
      }
    }
    enc(node, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const part of parts) { out.set(part, p); p += part.length; }
    return out;
  }

  function astToPlain(node) {
    switch (node.t) {
      case 'nil': return null;
      case 'bool': return node.v;
      case 'pfixint': case 'nfixint': case 'u8': case 'u16': case 'u32':
      case 'i8': case 'i16': case 'i32':
        return node.v;
      case 'u64': case 'i64': return node.v;
      case 'f32': case 'f64': return node.v;
      case 'fixstr': case 'str8': case 'str16': case 'str32':
        return new TextDecoder().decode(node.v);
      case 'bin8': case 'bin16': case 'bin32': return node.v;
      case 'arr': return node.v.map(astToPlain);
      case 'map': {
        const obj = {};
        for (const e of node.v) {
          const k = astToPlain(e.key);
          obj[typeof k === 'bigint' ? k.toString() : k] = astToPlain(e.val);
        }
        return obj;
      }
      case 'ext': return { type: node.type, data: node.v };
    }
    return node.v;
  }

  function plainToAst(val, templateAst) {
    if (templateAst) {
      switch (templateAst.t) {
        case 'nil': if (val == null) return { t: 'nil', v: null }; break;
        case 'bool': if (typeof val === 'boolean') return { t: 'bool', v: val }; break;
        case 'pfixint': if (typeof val === 'number' && Number.isInteger(val) && val >= 0 && val <= 0x7f) return { t: 'pfixint', v: val }; break;
        case 'nfixint': if (typeof val === 'number' && Number.isInteger(val) && val >= -32 && val <= -1) return { t: 'nfixint', v: val }; break;
        case 'u8': if (typeof val === 'number' && Number.isInteger(val) && val >= 0 && val <= 0xff) return { t: 'u8', v: val }; break;
        case 'u16': if (typeof val === 'number' && Number.isInteger(val) && val >= 0 && val <= 0xffff) return { t: 'u16', v: val }; break;
        case 'u32': if (typeof val === 'number' && Number.isInteger(val) && val >= 0 && val <= 0xffffffff) return { t: 'u32', v: val }; break;
        case 'i8': if (typeof val === 'number' && Number.isInteger(val) && val >= -128 && val <= 127) return { t: 'i8', v: val }; break;
        case 'i16': if (typeof val === 'number' && Number.isInteger(val) && val >= -32768 && val <= 32767) return { t: 'i16', v: val }; break;
        case 'i32': if (typeof val === 'number' && Number.isInteger(val) && val >= -2147483648 && val <= 2147483647) return { t: 'i32', v: val }; break;
        case 'u64': case 'i64':
          if (typeof val === 'bigint' || typeof val === 'number') return { t: templateAst.t, v: BigInt(val) };
          break;
        case 'f32':
          if (typeof val === 'number') return { t: 'f32', v: val, raw: templateAst.v === val ? templateAst.raw : undefined };
          break;
        case 'f64':
          if (typeof val === 'number') return { t: 'f64', v: val, raw: templateAst.v === val ? templateAst.raw : undefined };
          break;
        case 'fixstr': case 'str8': case 'str16': case 'str32':
          if (typeof val === 'string') return { t: templateAst.t, v: new TextEncoder().encode(val) };
          break;
        case 'bin8': case 'bin16': case 'bin32':
          if (val instanceof Uint8Array) return { t: templateAst.t, v: val };
          break;
        case 'arr':
          if (Array.isArray(val)) {
            return {
              t: 'arr',
              v: val.map((x, i) => plainToAst(x, templateAst.v[i]))
            };
          }
          break;
        case 'map':
          if (val && typeof val === 'object' && !(val instanceof Uint8Array)) {
            const entries = [];
            const keys = Object.keys(val);
            for (let i = 0; i < keys.length; i++) {
              const k = keys[i];
              let te = templateAst.v.find(e => astToPlain(e.key) === k);
              entries.push({
                key: te ? te.key : { t: 'fixstr', v: new TextEncoder().encode(k) },
                val: plainToAst(val[k], te ? te.val : undefined)
              });
            }
            return { t: 'map', v: entries };
          }
          break;
        case 'ext':
          if (val && typeof val === 'object' && ('type' in val || 'data' in val)) {
            return {
              t: 'ext',
              type: val.type !== undefined ? val.type : templateAst.type,
              v: val.data !== undefined ? val.data : val.v
            };
          }
          break;
      }
    }
    if (val === null || val === undefined) return { t: 'nil', v: null };
    if (typeof val === 'boolean') return { t: 'bool', v: val };
    if (typeof val === 'bigint') return { t: val < 0n ? 'i64' : 'u64', v: val };
    if (typeof val === 'number') {
      if (Number.isInteger(val)) {
        if (val >= 0 && val <= 0x7f) return { t: 'pfixint', v: val };
        if (val < 0 && val >= -32) return { t: 'nfixint', v: val };
        if (val >= 0 && val <= 0xff) return { t: 'u8', v: val };
        if (val >= 0 && val <= 0xffff) return { t: 'u16', v: val };
        if (val >= 0 && val <= 0xffffffff) return { t: 'u32', v: val };
        if (val >= -128 && val <= 127) return { t: 'i8', v: val };
        if (val >= -32768 && val <= 32767) return { t: 'i16', v: val };
        if (val >= -2147483648 && val <= 2147483647) return { t: 'i32', v: val };
        return { t: 'f64', v: val };
      }
      return { t: 'f64', v: val };
    }
    if (typeof val === 'string') return { t: 'fixstr', v: new TextEncoder().encode(val) };
    if (val instanceof Uint8Array) return { t: 'bin8', v: val };
    if (Array.isArray(val)) return { t: 'arr', v: val.map(x => plainToAst(x)) };
    if (typeof val === 'object') {
      if (val.type !== undefined && val.data !== undefined) return { t: 'ext', type: val.type, v: toU8(val.data) };
      return {
        t: 'map',
        v: Object.keys(val).map(k => ({
          key: { t: 'fixstr', v: new TextEncoder().encode(k) },
          val: plainToAst(val[k])
        }))
      };
    }
    return { t: 'nil', v: null };
  }

  function fixAstToPlainValue(node) {
    if (node && node.t === 'fixstr') return new TextDecoder().decode(node.v);
    if (node && node.t && node.t.indexOf('str') >= 0) return new TextDecoder().decode(node.v);
    if (node && (node.t === 'u8' || node.t === 'u16' || node.t === 'u32' ||
                 node.t === 'i8' || node.t === 'i16' || node.t === 'i32' ||
                 node.t === 'pfixint' || node.t === 'nfixint')) return node.v;
    return astToPlain(node);
  }
  function astKeyToString(node) { return fixAstToPlainValue(node); }

  function parseSave(fileBytes) {
    const bytes = toU8(fileBytes);
    if (bytes.length < 18) throw new Error('Save file too short');
    const magic = bytes.subarray(0, 9);
    const magicText = new TextDecoder().decode(magic);
    if (magicText !== 'HELUO_1_0' && magicText !== 'HELUO_1_1') {
      throw new Error('Unsupported save magic');
    }

    const block0 = decodeLz4Block(bytes, 9);
    const headerAst = decodeAst(block0.payload);
    const header = astToPlain(headerAst);

    const block1 = decodeLz4Block(bytes, block0.nextPos);
    const gameDataSlices = parseMapSlices(block1.payload);

    const charEntry = gameDataSlices.entries.find(e => astKeyToString(e.key) === 'Character');
    const characterSlices = [];
    if (charEntry) {
      const cm = parseMapSlices(charEntry.rawValBytes);
      for (const e of cm.entries) {
        let cid = astKeyToString(e.key);
        if (typeof cid === 'string' && /^-?\d+$/.test(cid)) cid = Number(cid);
        characterSlices.push({ cid, rawKeyBytes: e.rawKeyBytes, rawValBytes: e.rawValBytes });
      }
    }

    return {
      magic,
      headerAst,
      header,
      gameDataSlices,
      characterSlices,
      _charCache: new Map(),
      _charTemplates: new Map(),
      _charDirty: new Set(),
      _gameDirty: new Set(),
      _characterDirty: false,
      _block0: block0,
      _block1: block1
    };
  }

  function getGameDataField(parsed, key) {
    const e = parsed.gameDataSlices.entries.find(x => astKeyToString(x.key) === key);
    if (!e) return undefined;
    return astToPlain(decodeAst(e.rawValBytes));
  }

  function setGameDataField(parsed, key, val) {
    let e = parsed.gameDataSlices.entries.find(x => astKeyToString(x.key) === key);
    if (!e) {
      e = { key: { t: 'fixstr', v: new TextEncoder().encode(key) }, rawKeyBytes: encodeAst({ t: 'fixstr', v: new TextEncoder().encode(key) }), rawValBytes: null };
      parsed.gameDataSlices.entries.push(e);
    }
    e.rawValBytes = encodeAst(plainToAst(val));
    parsed._gameDirty.add(key);
    return parsed;
  }

  function getCharacterIds(parsed) {
    return parsed.characterSlices.map(x => x.cid);
  }

  function getCharacter(parsed, cid) {
    const sid = String(cid);
    if (parsed._charCache.has(sid)) return parsed._charCache.get(sid);
    const e = parsed.characterSlices.find(x => String(x.cid) === sid);
    if (!e) return undefined;
    const ast = decodeAst(e.rawValBytes);
    parsed._charTemplates.set(sid, ast);
    const plain = astToPlain(ast);
    parsed._charCache.set(sid, plain);
    return plain;
  }

  function setCharacter(parsed, cid, charObj) {
    const sid = String(cid);
    let e = parsed.characterSlices.find(x => String(x.cid) === sid);
    if (!e) {
      const keyBytes = encodeAst(typeof cid === 'number' ? plainToAst(cid) : { t: 'fixstr', v: new TextEncoder().encode(sid) });
      e = { cid, rawKeyBytes: keyBytes, rawValBytes: null };
      parsed.characterSlices.push(e);
    }
    let tpl = parsed._charTemplates.get(sid);
    if (!tpl && e.rawValBytes) {
      tpl = decodeAst(e.rawValBytes);
      parsed._charTemplates.set(sid, tpl);
    }
    e.rawValBytes = encodeAst(plainToAst(charObj, tpl));
    parsed._charCache.set(sid, charObj);
    parsed._charDirty.add(sid);
    parsed._characterDirty = true;
    return parsed;
  }

  function serializeSave(parsed) {
    const gameEntries = parsed.gameDataSlices.entries.slice();

    if (parsed._characterDirty) {
      const chars = parsed.characterSlices.map(e => ({
        rawKeyBytes: e.rawKeyBytes,
        rawValBytes: (e.rawValBytes && e.rawValBytes.length ? e.rawValBytes : encodeAst(plainToAst(getCharacter(parsed, e.cid))))
      }));
      const charMapBytes = buildMapFromSlices(chars);
      let ce = gameEntries.find(x => astKeyToString(x.key) === 'Character');
      if (!ce) {
        ce = {
          key: { t: 'fixstr', v: new TextEncoder().encode('Character') },
          rawKeyBytes: encodeAst({ t: 'fixstr', v: new TextEncoder().encode('Character') }),
          rawValBytes: charMapBytes
        };
        gameEntries.push(ce);
      } else {
        ce.rawValBytes = charMapBytes;
      }
      parsed._characterDirty = false;
    }

    const gameDataBytes = buildMapFromSlices(gameEntries);
    const headerNode = parsed._headerDirty ? plainToAst(parsed.header, parsed.headerAst) : parsed.headerAst;
    const block0 = encodeLz4Block(encodeAst(headerNode));
    const block1 = encodeLz4Block(gameDataBytes);
    const out = new Uint8Array(9 + block0.length + block1.length);
    out.set(parsed.magic || new TextEncoder().encode('HELUO_1_0'), 0);
    out.set(block0, 9);
    out.set(block1, 9 + block0.length);
    return out;
  }

  return {
    MAX_COMPRESSED_BYTES,
    MAX_UNCOMPRESSED_BYTES,
    MAX_DEPTH,
    lz4DecompressBlock,
    lz4CompressBlock,
    decodeLz4Block,
    encodeLz4Block,
    mpSkip,
    parseMapSlices,
    buildMapFromSlices,
    decodeAst,
    encodeAst,
    astToPlain,
    plainToAst,
    parseSave,
    getGameDataField,
    setGameDataField,
    getCharacterIds,
    getCharacter,
    setCharacter,
    serializeSave
  };
});
