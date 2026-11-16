'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const SRC_DIR = path.join(__dirname, '..', 'src');
const REAL_SAVES_DIR = '/tmp/htls_saves_ro';

let passed = 0;
let realSavesVerified = 0;

function ok(msg) {
  passed += 1;
  console.log('[PASS] ' + msg);
}

function skip(msg) {
  console.log('[SKIP] ' + msg);
}

function loadSandbox() {
  const ctx = {};
  ctx.global = ctx;
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.console = console;
  ctx.TextDecoder = TextDecoder;
  ctx.TextEncoder = TextEncoder;
  ctx.Uint8Array = Uint8Array;
  ctx.Uint8ClampedArray = Uint8ClampedArray;
  ctx.Int8Array = Int8Array;
  ctx.Int16Array = Int16Array;
  ctx.Int32Array = Int32Array;
  ctx.Uint16Array = Uint16Array;
  ctx.Uint32Array = Uint32Array;
  ctx.Float32Array = Float32Array;
  ctx.Float64Array = Float64Array;
  ctx.DataView = DataView;
  ctx.ArrayBuffer = ArrayBuffer;
  ctx.BigInt = BigInt;
  ctx.Map = Map;
  ctx.Set = Set;
  ctx.Object = Object;
  ctx.Array = Array;
  ctx.Function = Function;
  ctx.JSON = JSON;
  ctx.Math = Math;
  ctx.Date = Date;
  ctx.Number = Number;
  ctx.String = String;
  ctx.Boolean = Boolean;
  ctx.RegExp = RegExp;
  ctx.Error = Error;
  ctx.TypeError = TypeError;
  ctx.RangeError = RangeError;
  ctx.parseInt = parseInt;
  ctx.parseFloat = parseFloat;
  ctx.isNaN = isNaN;
  ctx.isFinite = isFinite;
  ctx.Promise = Promise;
  ctx.Symbol = Symbol;

  const files = ['htls-lz4-msgpack.js', 'catalog-data.js', 'editor-core.js'];
  for (const f of files) {
    const full = path.join(SRC_DIR, f);
    assert.ok(fs.existsSync(full), 'missing source file: ' + full);
    const code = fs.readFileSync(full, 'utf8');
    vm.runInNewContext(code, ctx, { filename: f, timeout: 30000 });
  }
  return ctx;
}

function toU8(x) {
  if (x instanceof Uint8Array) return x;
  if (x && x.buffer && typeof x.byteLength === 'number') {
    return new Uint8Array(x.buffer, x.byteOffset || 0, x.byteLength);
  }
  throw new Error('cannot coerce to Uint8Array');
}

function decodeMagic(magic) {
  if (magic instanceof Uint8Array) return new TextDecoder().decode(magic);
  return String(magic || '');
}

function statValue(detail, statKey) {
  const s = (detail && detail.stats || []).find((x) => x.key === statKey);
  return s ? s.value : undefined;
}

const ctx = loadSandbox();
const HtlsCodec = ctx.HtlsCodec;
const HtlsCatalog = ctx.HtlsCatalog;
const HtlsEditorCore = ctx.HtlsEditorCore;

assert.ok(HtlsCodec, 'HtlsCodec not exposed');
assert.ok(HtlsCatalog, 'HtlsCatalog not exposed');
assert.ok(HtlsEditorCore, 'HtlsEditorCore not exposed');
ok('modules loaded from src/ into VM sandbox');

assert.equal(typeof HtlsCodec.parseSave, 'function');
assert.equal(typeof HtlsCodec.serializeSave, 'function');
assert.equal(typeof HtlsCodec.getGameDataField, 'function');
assert.equal(typeof HtlsCodec.getCharacterIds, 'function');
assert.equal(typeof HtlsEditorCore.createSession, 'function');
assert.equal(typeof HtlsEditorCore.createDemoSave, 'function');
assert.ok(Array.isArray(HtlsEditorCore.PRESETS));
ok('required API surface present');

// Catalog hygiene check
const CJK_RE = /[\u4E00-\u9FFF]/;
const TAG_RE = /<[^>]+>/;
const catalogViolations = [];
function walkCatalog(node, labelPath) {
  if (node == null) return;
  const t = typeof node;
  if (t === 'string') {
    if (CJK_RE.test(node)) catalogViolations.push({ path: labelPath, reason: 'CJK', value: node });
    if (TAG_RE.test(node)) catalogViolations.push({ path: labelPath, reason: 'TAG', value: node });
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) walkCatalog(node[i], labelPath + '[' + i + ']');
    return;
  }
  if (t === 'object') {
    for (const k of Object.keys(node)) walkCatalog(node[k], labelPath + '.' + k);
  }
}
walkCatalog(HtlsCatalog, 'HtlsCatalog');
assert.equal(catalogViolations.length, 0, 'catalog hygiene violations: ' + JSON.stringify(catalogViolations.slice(0, 10)));
ok('catalog has zero CJK/Hanzi and zero <...> tags');

// Demo save unit and roundtrip tests
const demoU8 = toU8(HtlsEditorCore.createDemoSave());
assert.ok(demoU8.length > 0);
const demoParsed = HtlsCodec.parseSave(demoU8);
assert.equal(decodeMagic(demoParsed.magic), 'HELUO_1_1');
ok('demo save magic = HELUO_1_1');

const demoSession = HtlsEditorCore.createSession(demoU8, 'demo.save');
const demoValid = demoSession.validate();
assert.equal(demoValid.ok, true, 'demo validate failed: ' + JSON.stringify(demoValid.errors));

const demoCharList = demoSession.getCharacterList();
const playerEntry = demoCharList.find((c) => c.isPlayer === true);
assert.ok(playerEntry, 'Player character missing');
const playerKey = playerEntry.id;
ok('demo save has Player character');

demoSession.setCharacterBasics(playerKey, { name: '검객', level: 77, exp: 50000 });
demoSession.setWorldSettings({ daysFromBeginning: 1234, unlockAllTeleporters: true });
demoSession.setCharacterStat(playerKey, 'Money', 4321);
const detailAfter = demoSession.getCharacterDetail(playerKey);
assert.ok(detailAfter.name.endsWith('검객'), 'unexpected character name: ' + detailAfter.name);
assert.equal(detailAfter.level, 77);
assert.equal(statValue(detailAfter, 'Money'), 4321);
ok('basics, world settings, and Money stat updates work');

const normalAdd = Object.keys(HtlsCatalog.normalInventory)[0];
const equipAdd = Object.keys(HtlsCatalog.equipment)[0];
const skillAdd = Object.keys(HtlsCatalog.skills)[0];
const talentAdd = Object.keys(HtlsCatalog.talents)[0];
demoSession.addInventoryItem(playerKey, normalAdd, 3);
demoSession.addInventoryItem(playerKey, equipAdd, 1);
demoSession.setSkillMastery(playerKey, skillAdd, { currentExp: 9999, maxExp: 9999, isExpert: true });
demoSession.setTalentNodes(playerKey, [talentAdd], 10);
ok('added item, equip, skill mastery, and talent node');

// Verify all 6 presets
const expectedPresets = [
  'rich_hero',
  'hero_max_stats',
  'hero_all_talents',
  'party_heal_cleanse',
  'unlock_teleporters',
  'hero_master_skills',
];
const presetIds = new Set(HtlsEditorCore.PRESETS.map((p) => p.id));
for (const p of expectedPresets) {
  assert.ok(presetIds.has(p), 'missing preset: ' + p);
  const fresh = HtlsEditorCore.createSession(toU8(HtlsEditorCore.createDemoSave()), 'preset-' + p + '.save');
  HtlsEditorCore.applyPreset(fresh, p);
  const v = fresh.validate();
  assert.equal(v.ok, true, 'preset ' + p + ' invalid: ' + JSON.stringify(v.errors));
}
ok('all 6 presets apply cleanly on demo save');

const demoOutU8 = toU8(demoSession.syncHeaderAndSave());
const demoOutParsed = HtlsCodec.parseSave(demoOutU8);
const demoOutSession = HtlsEditorCore.createSession(demoOutU8, 'demo-out.save');
assert.equal(demoOutSession.validate().ok, true, 'reparsed demo invalid');

const outDetail = demoOutSession.getCharacterDetail(playerKey);
assert.equal(statValue(outDetail, 'Money'), 4321);
assert.equal(outDetail.level, 77);
assert.equal(HtlsCodec.getGameDataField(demoOutParsed, 'DaysFromBeginning'), 1234);
assert.equal(demoOutParsed.header.playerLevel, 77);
ok('reparsed demo preserves edits and header sync');

const invList = HtlsCodec.getGameDataField(demoOutParsed, 'inventoryNoList');
assert.ok(Array.isArray(invList) && invList.length > 0, 'inventoryNoList empty');
assert.equal(new Set(invList).size, invList.length, 'inventoryNoList has duplicates');
ok('inventoryNoList is unique (size=' + invList.length + ')');

// i64 and f32 type preservation roundtrip
const demoSer = HtlsCodec.parseSave(toU8(HtlsCodec.serializeSave(demoParsed)));
assert.equal(typeof demoParsed.header.saveTime, 'bigint');
assert.equal(demoSer.header.saveTime, demoParsed.header.saveTime);
assert.equal(typeof demoParsed.header.playedTime, 'bigint');
assert.equal(demoSer.header.playedTime, demoParsed.header.playedTime);
const origRate = HtlsCodec.getGameDataField(demoParsed, 'SkillExpDistributionRate');
const newRate = HtlsCodec.getGameDataField(demoSer, 'SkillExpDistributionRate');
assert.equal(newRate, origRate);
ok('serializeSave preserves i64 and f32 field types and values');

// Real save sweep
if (!fs.existsSync(REAL_SAVES_DIR)) {
  skip('real saves not mounted');
} else {
  const entries = fs.readdirSync(REAL_SAVES_DIR).filter((n) => n.toLowerCase().endsWith('.save')).sort();
  if (entries.length === 0) {
    skip('no *.save files in ' + REAL_SAVES_DIR);
  } else {
    let firstHandled = false;
    for (const name of entries) {
      const p = path.join(REAL_SAVES_DIR, name);
      const bytes = new Uint8Array(fs.readFileSync(p));
      const sess = HtlsEditorCore.createSession(bytes, name);
      const v = sess.validate();
      assert.equal(v.ok, true, 'real save invalid: ' + name + ' :: ' + JSON.stringify(v.errors));
      realSavesVerified += 1;

      if (!firstHandled) {
        firstHandled = true;
        const origParsed = HtlsCodec.parseSave(bytes);
        const beforeIds = HtlsCodec.getCharacterIds(origParsed).slice().sort();

        HtlsEditorCore.applyPreset(sess, 'rich_hero');
        sess.setCharacterStat('Player', 'Money', 888777666);

        const outBytes = toU8(sess.syncHeaderAndSave());
        const reparsed = HtlsCodec.parseSave(outBytes);
        const reparsedSess = HtlsEditorCore.createSession(outBytes, name);
        assert.equal(reparsedSess.validate().ok, true, 'real save reparse invalid');
        assert.equal(statValue(reparsedSess.getCharacterDetail('Player'), 'Money'), 888777666);

        const afterIds = HtlsCodec.getCharacterIds(reparsed).slice().sort();
        assert.deepEqual(afterIds, beforeIds, 'NPC IDs not preserved losslessly');
        ok('real save ' + name + ': rich_hero + Money edit persisted; NPC IDs preserved (' + afterIds.length + ')');
      } else {
        ok('real save validated: ' + name);
      }
    }
    assert.equal(realSavesVerified, entries.length);
    ok('real save sweep complete: ' + realSavesVerified + ' file(s) verified');
  }
}

console.log('[SUMMARY] passed=' + passed + ' realSavesVerified=' + realSavesVerified);
process.exit(0);
