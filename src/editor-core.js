(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./htls-lz4-msgpack.js'),
      require('./catalog-data.js')
    );
  } else {
    root.HtlsEditorCore = factory(root.HtlsCodec, root.HtlsCatalog);
  }
})(typeof self !== 'undefined' ? self : this, function (Codec, Catalog) {
  'use strict';

  if (!Codec) throw new Error('HtlsCodec is required');
  if (!Catalog) throw new Error('HtlsCatalog is required');

  var GAME_FIELD_KEYS = [
    'PlayerSurname',
    'PlayerName',
    'Difficulty',
    'DaysFromBeginning',
    'SkillExpDistributionRate',
    'SkillExpDistributionLevel',
    'Teammates',
    'AvailableTeleporters',
    'AvailableNicknames',
    'inventoryNoList'
  ];

  var EQUIP_SLOTS = [
    'MajorWeapon',
    'MinorWeapon',
    'Cloth',
    'Jewelry',
    'Book',
    'Fashion'
  ];

  var STAT_KEYS = [
    'Money',
    'Moral',
    'Reputation',
    'YinAndYang',
    'Madness',
    'Injured',
    'Poisoned',
    'Bleeding',
    'Fatigue',
    'Drunk'
  ];

  var STATUS_KEYS = [
    'Confused',
    'Cramped',
    'Dazed',
    'Drunk',
    'Exhausted',
    'Frozen',
    'Injured',
    'Poisoned',
    'Sealed',
    'Sprained',
    'Wounded'
  ];

  var BIGINT_ZERO = BigInt(0);

  function isBigInt(value) {
    return typeof value === 'bigint';
  }

  function cloneValue(value) {
    if (value === null || value === undefined) return value;
    if (isBigInt(value)) return value;
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (Array.isArray(value)) {
      var arr = new Array(value.length);
      for (var i = 0; i < value.length; i++) arr[i] = cloneValue(value[i]);
      return arr;
    }
    if (typeof value === 'object') {
      var out = {};
      var keys = Object.keys(value);
      for (var j = 0; j < keys.length; j++) {
        out[keys[j]] = cloneValue(value[keys[j]]);
      }
      return out;
    }
    return value;
  }

  function sameValue(a, b) {
    if (a === b) return true;
    if (isBigInt(a) || isBigInt(b)) {
      if (!isBigInt(a) || !isBigInt(b)) return false;
      return a === b;
    }
    if (a === null || b === null || a === undefined || b === undefined) {
      return a === b;
    }
    if (a instanceof Uint8Array || b instanceof Uint8Array) {
      if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (var j = 0; j < a.length; j++) {
        if (!sameValue(a[j], b[j])) return false;
      }
      return true;
    }
    if (typeof a === 'object' || typeof b === 'object') {
      if (typeof a !== 'object' || typeof b !== 'object') return false;
      var ak = Object.keys(a);
      var bk = Object.keys(b);
      if (ak.length !== bk.length) return false;
      for (var k = 0; k < ak.length; k++) {
        var key = ak[k];
        if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
        if (!sameValue(a[key], b[key])) return false;
      }
      return true;
    }
    return false;
  }

  function toFiniteInt(value, fallback) {
    var n = Number(value);
    if (!isFinite(n)) return fallback;
    return Math.trunc(n);
  }

  function clampInt(value, min, max, fallback) {
    var n = toFiniteInt(value, fallback);
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  function isPositiveInteger(value) {
    return typeof value === 'number' && isFinite(value) && value > 0 && Math.floor(value) === value;
  }

  function getHeader(parsed) {
    return parsed && parsed.header ? parsed.header : {};
  }

  function getGameField(parsed, key) {
    if (typeof Codec.getGameDataField === 'function') {
      return Codec.getGameDataField(parsed, key);
    }
    return undefined;
  }

  function setGameField(parsed, key, value) {
    if (typeof Codec.setGameDataField === 'function') {
      Codec.setGameDataField(parsed, key, value);
    }
  }

  function getCharacterIds(parsed) {
    if (typeof Codec.getCharacterIds === 'function') {
      return Codec.getCharacterIds(parsed) || [];
    }
    if (parsed && Array.isArray(parsed.characterSlices)) {
      return parsed.characterSlices.map(function (slice) { return String(slice.cid); });
    }
    return [];
  }

  function getCharacter(parsed, cid) {
    return Codec.getCharacter(parsed, String(cid));
  }

  function setCharacter(parsed, cid, ch) {
    Codec.setCharacter(parsed, String(cid), ch);
  }

  function characterName(cid, ch, gameFields) {
    cid = String(cid);
    if (cid === 'Player') {
      var surname = gameFields && gameFields.PlayerSurname ? String(gameFields.PlayerSurname) : '';
      var name = gameFields && gameFields.PlayerName ? String(gameFields.PlayerName) : '';
      var full = surname + name;
      return full || '주인공';
    }
    if (Catalog && Catalog.npcNames && Catalog.npcNames[cid]) {
      return String(Catalog.npcNames[cid]);
    }
    if (ch && ch.NicknameID && Catalog && Catalog.nicknames && Catalog.nicknames[ch.NicknameID]) {
      var nick = Catalog.nicknames[ch.NicknameID];
      if (typeof nick === 'string') return nick;
      if (nick && nick.name) return String(nick.name);
    }
    return cid;
  }

  function getCatalogStats() {
    if (!Catalog || !Catalog.stats) return [];
    if (Array.isArray(Catalog.stats)) return Catalog.stats;
    return Object.keys(Catalog.stats).map(function (key) {
      var val = Catalog.stats[key];
      return {
        key: key,
        name: val && val.name ? val.name : key,
        label: val && val.label ? val.label : key
      };
    });
  }

  function getTeleporterKeys() {
    return Catalog && Catalog.teleporters ? Object.keys(Catalog.teleporters) : [];
  }

  function getNicknameKeys() {
    return Catalog && Catalog.nicknames ? Object.keys(Catalog.nicknames) : [];
  }

  function normalizeInventoryNoList(list) {
    if (!Array.isArray(list)) return [];
    return list.map(function (v) { return toFiniteInt(v, 0); });
  }

  function maxInventoryNo(list) {
    var max = 0;
    var arr = normalizeInventoryNoList(list);
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] > max) max = arr[i];
    }
    return max;
  }

  function containsPositiveUniqueInventoryNos(list) {
    if (!Array.isArray(list)) return false;
    var seen = Object.create(null);
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (!isPositiveInteger(n)) return false;
      if (seen[n]) return false;
      seen[n] = true;
    }
    return true;
  }

  function extractInvNo(item) {
    if (!item || typeof item.Id !== 'string') return null;
    var m = /^InvNo(\d+)$/.exec(item.Id);
    if (!m) return null;
    var n = Number(m[1]);
    return isFinite(n) && n > 0 ? n : null;
  }

  function validateInventoryItemIds(ch) {
    if (!ch || !Array.isArray(ch.Inventory)) return true;
    var seen = Object.create(null);
    for (var i = 0; i < ch.Inventory.length; i++) {
      var item = ch.Inventory[i];
      if (!item) continue;
      if (typeof item.Id === 'string' && item.Id !== null) {
        if (!/^InvNo\d+$/.test(item.Id)) return false;
        if (seen[item.Id]) return false;
        seen[item.Id] = true;
      } else if (item.Id !== null && item.Id !== undefined) {
        return false;
      }
    }
    return true;
  }

  function validateCharacterFiniteStats(ch) {
    if (!ch || !ch.Data || typeof ch.Data !== 'object') return true;
    var keys = Object.keys(ch.Data);
    for (var i = 0; i < keys.length; i++) {
      var val = ch.Data[keys[i]];
      if (val && typeof val === 'object' && 'Base' in val) val = val.Base;
      if (typeof val === 'number') {
        if (!isFinite(val) || Math.floor(val) !== val) return false;
      } else if (val !== null && val !== undefined && typeof val !== 'object') {
        return false;
      }
    }
    return true;
  }

  function makeItem(itemId, count, id, overrides) {
    var item = {
      ItemId: String(itemId),
      Count: toFiniteInt(count, 1),
      Durability: 16,
      MaxDurability: 16,
      Weight: 2,
      EffectId: [],
      IsNew: false,
      Stolen: false,
      Level: 1,
      Hurt: {},
      HurtDifference: 0.0,
      ForgeMaterials: {},
      QualityTitle: '',
      QuenchHoleCount: 0,
      QuenchEffect: [],
      ReforgeType: -1,
      Id: id === undefined ? null : id
    };
    if (overrides && typeof overrides === 'object') {
      var keys = Object.keys(overrides);
      for (var i = 0; i < keys.length; i++) item[keys[i]] = overrides[keys[i]];
    }
    return item;
  }

  function makeCharacter(cid, gameFields) {
    var isPlayer = String(cid) === 'Player';
    var ch = {
      Id: String(cid),
      Equip: {
        MajorWeapon: null,
        MinorWeapon: null,
        Cloth: null,
        Jewelry: null,
        Book: null,
        Fashion: null
      },
      TakeWeaponMode: 0,
      NicknameID: 'nick001',
      TalentData: {
        NewPoint: 0,
        ClickedNodes: []
      },
      CurrentNeiGongID: '',
      CurrentQingGongID: '',
      Data: {},
      SkillTree: {
        LearnedSkill: {},
        CurrentSkillTreeId: ''
      },
      Inventory: [],
      LearnedSkills: null,
      MaxLevel: 100,
      Exp: 0,
      MaxExp: 1000,
      Level: 1,
      expPow2: 1,
      expPow1: 5,
      expPow0: 50,
      UniqueId: null
    };

    var statKeys = getCatalogStats();
    for (var i = 0; i < statKeys.length; i++) {
      var key = statKeys[i].key || statKeys[i].id || statKeys[i];
      if (key) ch.Data[String(key)] = { Base: 0 };
    }
    var requiredStats = [
      'HP', 'MP', 'SP', 'Stamina', 'Strength', 'Agility', 'Constitution',
      'Intelligence', 'Willpower', 'Charisma', 'Luck', 'Attack', 'Defense',
      'Speed', 'Critical', 'Dodge', 'Hit', 'MagicAttack', 'MagicDefense',
      'MaxHP', 'MaxMP', 'MaxSP', 'MaxStamina', 'Money'
    ];
    for (var r = 0; r < requiredStats.length; r++) {
      if (!ch.Data[requiredStats[r]]) ch.Data[requiredStats[r]] = { Base: requiredStats[r] === 'HP' ? 500 : 0 };
    }
    for (var n = 0; n < 23; n++) {
      var k = 'Stat' + n;
      if (!ch.Data[k]) ch.Data[k] = { Base: 0 };
    }

    if (isPlayer) {
      ch.NicknameID = '';
      ch.CurrentNeiGongID = 'it30701';
      ch.CurrentQingGongID = 'it30801';
      ch.SkillTree.CurrentSkillTreeId = 'it30100';
    }

    return ch;
  }

  function makeDemoSave() {
    var header = {
      saveTime: BigInt('-8584485087972118123'),
      playedTime: BigInt('36000000000'),
      playedDays: 0,
      trackedQuestId: 'SSTS01',
      modName: '',
      modId: '',
      teammateNames: ['Player', 'ns0002'],
      difficulty: 1,
      screenShotData: new Uint8Array(0),
      playerName: '감주',
      playerLevel: 1
    };

    var gameFields = {
      PlayerSurname: '감',
      PlayerName: '주',
      Difficulty: 1,
      DaysFromBeginning: 0,
      SkillExpDistributionRate: 0.75,
      SkillExpDistributionLevel: 0,
      Teammates: ['Player', 'ns0002', 'n00001'],
      AvailableTeleporters: getTeleporterKeys().slice(0, 2),
      AvailableNicknames: getNicknameKeys().slice(0, 2),
      inventoryNoList: [1]
    };

    if (gameFields.AvailableTeleporters.length === 0) gameFields.AvailableTeleporters = ['t01', 't02'];
    if (gameFields.AvailableNicknames.length === 0) gameFields.AvailableNicknames = ['defaultNickname', 'nick001'];

    var player = makeCharacter('Player', gameFields);
    var npc2 = makeCharacter('ns0002', gameFields);
    var npc1 = makeCharacter('n00001', gameFields);

    player.NicknameID = gameFields.AvailableNicknames[0] || 'nick001';
    player.TalentData.NewPoint = 103;
    player.TalentData.ClickedNodes = ['0_TalentNode000'];
    player.SkillTree.LearnedSkill['it30100'] = {
      Name: null,
      CurrentExp: 0,
      MaxExp: 2000000,
      IsBackup: false,
      IsExpert: true,
      ClickedNodes: ['SkillTree000_000']
    };
    player.SkillTree.CurrentSkillTreeId = 'it30100';
    player.CurrentNeiGongID = 'it30701';
    player.CurrentQingGongID = 'it30801';

    var equipped = makeItem('eq10101', 1, 'InvNo1');
    player.Inventory.push(equipped);
    player.Equip.MajorWeapon = cloneValue(equipped);

    player.Inventory.push(makeItem('it40101', 1, null));

    var characterMap = {
      Player: player,
      ns0002: npc2,
      n00001: npc1
    };

    var gameDataObj = {
      PlayerSurname: gameFields.PlayerSurname,
      PlayerName: gameFields.PlayerName,
      Difficulty: gameFields.Difficulty,
      DaysFromBeginning: gameFields.DaysFromBeginning,
      SkillExpDistributionRate: gameFields.SkillExpDistributionRate,
      SkillExpDistributionLevel: gameFields.SkillExpDistributionLevel,
      Teammates: gameFields.Teammates,
      AvailableTeleporters: gameFields.AvailableTeleporters,
      AvailableNicknames: gameFields.AvailableNicknames,
      inventoryNoList: gameFields.inventoryNoList,
      Character: characterMap
    };

    var b0 = Codec.encodeLz4Block(Codec.encodeAst(Codec.plainToAst(header)));
    var b1 = Codec.encodeLz4Block(Codec.encodeAst(Codec.plainToAst(gameDataObj)));
    var magicBytes = new TextEncoder().encode('HELUO_1_1');
    var out = new Uint8Array(magicBytes.length + b0.length + b1.length);
    out.set(magicBytes, 0);
    out.set(b0, magicBytes.length);
    out.set(b1, magicBytes.length + b0.length);
    return out;
  }

  function HtlsSession(fileBytes, fileName) {
    if (!(this instanceof HtlsSession)) return new HtlsSession(fileBytes, fileName);

    this.fileName = fileName || 'save.save';
    this.bytes = fileBytes instanceof Uint8Array ? new Uint8Array(fileBytes) : fileBytes;
    this.parsed = Codec.parseSave(this.bytes);

    this._charCache = Object.create(null);
    this._baselineChars = Object.create(null);
    this._touched = Object.create(null);
    this._touchedSet = {};
    this._gameDirty = Object.create(null);
    this._gameTouched = {};

    this._baselineHeader = cloneValue(this.parsed.header || {});
    this._baselineGameFields = Object.create(null);

    for (var i = 0; i < GAME_FIELD_KEYS.length; i++) {
      var key = GAME_FIELD_KEYS[i];
      this._baselineGameFields[key] = cloneValue(getGameField(this.parsed, key));
    }

    this._baselineCharacters = Object.create(null);
  }

  HtlsSession.prototype._gameFields = function () {
    var out = {};
    for (var i = 0; i < GAME_FIELD_KEYS.length; i++) {
      var key = GAME_FIELD_KEYS[i];
      out[key] = getGameField(this.parsed, key);
    }
    return out;
  };

  HtlsSession.prototype._isTouched = function (cid) {
    return !!this._touchedSet[String(cid)];
  };

  HtlsSession.prototype._markTouched = function (cid) {
    cid = String(cid);
    this._touched[cid] = true;
    this._touchedSet[cid] = true;
  };

  HtlsSession.prototype._markGameField = function (key) {
    this._gameDirty[key] = true;
    this._gameTouched[key] = true;
  };

  HtlsSession.prototype._ensureBaselineCharacter = function (cid) {
    cid = String(cid);
    if (this._baselineChars[cid]) return this._baselineChars[cid];
    if (this._charCache[cid]) {
      this._baselineChars[cid] = cloneValue(this._charCache[cid]);
      if (!this._baselineCharacters[cid]) this._baselineCharacters[cid] = true;
      return this._baselineChars[cid];
    }
    var ch = getCharacter(this.parsed, cid);
    var copy = cloneValue(ch);
    this._charCache[cid] = ch;
    this._baselineChars[cid] = copy;
    this._baselineCharacters[cid] = true;
    return this._baselineChars[cid];
  };

  HtlsSession.prototype._getMutableCharacter = function (cid) {
    cid = String(cid);
    this._ensureBaselineCharacter(cid);
    if (!this._charCache[cid]) {
      var ch = getCharacter(this.parsed, cid);
      this._charCache[cid] = ch;
    }
    return this._charCache[cid];
  };

  HtlsSession.prototype.getCharacterList = function () {
    var gameFields = this._gameFields();
    var teammates = Array.isArray(gameFields.Teammates) ? gameFields.Teammates.map(String) : [];
    var ids = [];
    var seen = Object.create(null);

    for (var t = 0; t < teammates.length; t++) {
      if (!seen[teammates[t]]) {
        seen[teammates[t]] = true;
        ids.push(teammates[t]);
      }
    }

    var slices = Array.isArray(this.parsed.characterSlices) ? this.parsed.characterSlices : [];
    for (var i = 0; i < slices.length; i++) {
      var cid = String(slices[i].cid);
      if (!seen[cid]) {
        seen[cid] = true;
        ids.push(cid);
      }
    }

    return ids.map(function (cid) {
      var cached = this._charCache[cid] || null;
      var level = 1;
      var maxLevel = 100;
      if (cached) {
        level = toFiniteInt(cached.Level, 1);
        maxLevel = toFiniteInt(cached.MaxLevel, 100);
      }
      return {
        id: cid,
        name: characterName(cid, cached, gameFields),
        level: level,
        maxLevel: maxLevel,
        isPlayer: cid === 'Player',
        isTeammate: teammates.indexOf(cid) !== -1
      };
    }, this);
  };

  HtlsSession.prototype.getCharacter = function (cid) {
    cid = String(cid);
    this._ensureBaselineCharacter(cid);
    return this._charCache[cid];
  };

  HtlsSession.prototype.getCharacterDetail = function (cid) {
    var ch = this.getCharacter(cid);
    var gameFields = this._gameFields();
    var stats = [];
    var catalogStats = getCatalogStats();

    for (var i = 0; i < catalogStats.length; i++) {
      var def = catalogStats[i];
      var key = typeof def === 'string' ? def : (def.key || def.id || def.name);
      if (!key) continue;
      var raw = ch.Data && ch.Data[key] !== undefined ? ch.Data[key] : null;
      var value = raw && typeof raw === 'object' && 'Base' in raw ? raw.Base : raw;
      stats.push({
        key: key,
        name: def && def.name ? def.name : key,
        label: def && def.label ? def.label : (def && def.name ? def.name : key),
        value: value === undefined ? null : value
      });
    }

    var equip = {};
    for (var e = 0; e < EQUIP_SLOTS.length; e++) {
      var slot = EQUIP_SLOTS[e];
      equip[slot] = ch.Equip && ch.Equip[slot] ? cloneValue(ch.Equip[slot]) : null;
    }

    var skills = [];
    if (ch.SkillTree && ch.SkillTree.LearnedSkill && typeof ch.SkillTree.LearnedSkill === 'object') {
      var skillIds = Object.keys(ch.SkillTree.LearnedSkill);
      for (var s = 0; s < skillIds.length; s++) {
        var skillId = skillIds[s];
        var skill = ch.SkillTree.LearnedSkill[skillId] || {};
        skills.push({
          itemId: skillId,
          id: skillId,
          name: skill.Name || null,
          currentExp: toFiniteInt(skill.CurrentExp, 0),
          maxExp: toFiniteInt(skill.MaxExp, 0),
          isBackup: !!skill.IsBackup,
          isExpert: !!skill.IsExpert,
          clickedNodes: Array.isArray(skill.ClickedNodes) ? cloneValue(skill.ClickedNodes) : []
        });
      }
    }

    return {
      id: String(cid),
      name: characterName(cid, ch, gameFields),
      level: toFiniteInt(ch.Level, 1),
      maxLevel: toFiniteInt(ch.MaxLevel, 100),
      exp: toFiniteInt(ch.Exp, 0),
      maxExp: toFiniteInt(ch.MaxExp, 0),
      nicknameId: ch.NicknameID || '',
      currentNeiGongId: ch.CurrentNeiGongID || '',
      currentQingGongId: ch.CurrentQingGongID || '',
      currentSkillTreeId: ch.SkillTree ? (ch.SkillTree.CurrentSkillTreeId || '') : '',
      talentPoint: ch.TalentData ? toFiniteInt(ch.TalentData.NewPoint, 0) : 0,
      stats: stats,
      equip: equip,
      skills: skills,
      clickedTalents: ch.TalentData && Array.isArray(ch.TalentData.ClickedNodes) ? cloneValue(ch.TalentData.ClickedNodes) : [],
      inventory: Array.isArray(ch.Inventory) ? cloneValue(ch.Inventory) : []
    };
  };

  HtlsSession.prototype.setCharacterStat = function (cid, key, value) {
    var ch = this._getMutableCharacter(cid);
    key = String(key);

    var min = 0;
    var max = 999999;
    if (key === 'Money') {
      max = 999999999;
    } else if (key === 'Moral' || key === 'Reputation' || key === 'YinAndYang' || key === 'Madness') {
      min = -999999;
      max = 999999;
    } else if (
      key === 'Injured' || key === 'Poisoned' || key === 'Bleeding' ||
      key === 'Fatigue' || key === 'Drunk'
    ) {
      max = 9999;
    }

    var intValue = clampInt(value, min, max, 0);
    if (!ch.Data) ch.Data = {};
    if (!ch.Data[key] || typeof ch.Data[key] !== 'object') {
      ch.Data[key] = { Base: intValue };
    } else {
      ch.Data[key].Base = intValue;
    }
    this._markTouched(cid);
    return intValue;
  };

  HtlsSession.prototype.setCharacterBasics = function (cid, basics) {
    var ch = this._getMutableCharacter(cid);
    var gameFields = this._gameFields();
    basics = basics || {};

    if (basics.surname !== undefined) {
      gameFields.PlayerSurname = String(basics.surname);
      setGameField(this.parsed, 'PlayerSurname', gameFields.PlayerSurname);
      this._markGameField('PlayerSurname');
    }
    if (basics.name !== undefined) {
      gameFields.PlayerName = String(basics.name);
      setGameField(this.parsed, 'PlayerName', gameFields.PlayerName);
      this._markGameField('PlayerName');
    }

    if (basics.level !== undefined) {
      ch.Level = clampInt(basics.level, 1, Math.max(1, toFiniteInt(ch.MaxLevel, 100)), 1);
    }
    if (basics.exp !== undefined) {
      ch.Exp = Math.max(0, clampInt(basics.exp, 0, 2147483647, 0));
    }
    if (basics.talentPoint !== undefined) {
      if (!ch.TalentData) ch.TalentData = { NewPoint: 0, ClickedNodes: [] };
      ch.TalentData.NewPoint = Math.max(0, clampInt(basics.talentPoint, 0, 999999999, 0));
    }
    if (basics.nicknameId !== undefined) {
      ch.NicknameID = String(basics.nicknameId || '');
    }
    if (basics.currentNeiGongId !== undefined) {
      ch.CurrentNeiGongID = String(basics.currentNeiGongId || '');
    }
    if (basics.currentQingGongId !== undefined) {
      ch.CurrentQingGongID = String(basics.currentQingGongId || '');
    }
    if (basics.currentSkillTreeId !== undefined) {
      if (!ch.SkillTree) ch.SkillTree = { LearnedSkill: {}, CurrentSkillTreeId: '' };
      ch.SkillTree.CurrentSkillTreeId = String(basics.currentSkillTreeId || '');
    }

    this._markTouched(cid);
    return ch;
  };

  HtlsSession.prototype.addInventoryItem = function (cid, itemId, count) {
    var ch = this._getMutableCharacter(cid);
    itemId = String(itemId);
    count = Math.max(1, toFiniteInt(count, 1));
    if (!Array.isArray(ch.Inventory)) ch.Inventory = [];

    var list = normalizeInventoryNoList(getGameField(this.parsed, 'inventoryNoList') || []);
    var isEquipment = /^eq/.test(itemId);

    if (isEquipment) {
      var nextNo = maxInventoryNo(list) + 1;
      list.push(nextNo);
      setGameField(this.parsed, 'inventoryNoList', list);
      this._markGameField('inventoryNoList');
      var item = makeItem(itemId, count, 'InvNo' + nextNo);
      ch.Inventory.push(item);
      this._markTouched(cid);
      return item;
    }

    for (var i = 0; i < ch.Inventory.length; i++) {
      var existing = ch.Inventory[i];
      if (existing && existing.ItemId === itemId && existing.Id === null) {
        existing.Count = toFiniteInt(existing.Count, 0) + count;
        this._markTouched(cid);
        return existing;
      }
    }

    var newItem = makeItem(itemId, count, null);
    ch.Inventory.push(newItem);
    this._markTouched(cid);
    return newItem;
  };

  HtlsSession.prototype.setInventoryCount = function (cid, index, count) {
    var ch = this._getMutableCharacter(cid);
    index = toFiniteInt(index, -1);
    if (!Array.isArray(ch.Inventory) || index < 0 || index >= ch.Inventory.length) {
      throw new Error('Inventory index out of range: ' + index);
    }
    var item = ch.Inventory[index];
    if (!item) throw new Error('Inventory item is null at index: ' + index);
    item.Count = Math.max(1, toFiniteInt(count, 1));
    this._markTouched(cid);
    return item;
  };

  HtlsSession.prototype.removeInventoryItem = function (cid, index) {
    var ch = this._getMutableCharacter(cid);
    index = toFiniteInt(index, -1);
    if (!Array.isArray(ch.Inventory) || index < 0 || index >= ch.Inventory.length) {
      throw new Error('Inventory index out of range: ' + index);
    }

    var removed = ch.Inventory.splice(index, 1)[0];
    var invNo = extractInvNo(removed);
    if (invNo !== null) {
      var list = normalizeInventoryNoList(getGameField(this.parsed, 'inventoryNoList') || []);
      var out = [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] !== invNo) out.push(list[i]);
      }
      setGameField(this.parsed, 'inventoryNoList', out);
      this._markGameField('inventoryNoList');
    }

    this._markTouched(cid);
    return removed;
  };

  HtlsSession.prototype.setSkillMastery = function (cid, skillItemId, values) {
    var ch = this._getMutableCharacter(cid);
    skillItemId = String(skillItemId);
    values = values || {};

    if (!ch.SkillTree) ch.SkillTree = { LearnedSkill: {}, CurrentSkillTreeId: '' };
    if (!ch.SkillTree.LearnedSkill || typeof ch.SkillTree.LearnedSkill !== 'object') {
      ch.SkillTree.LearnedSkill = {};
    }

    var learned = values.learned !== undefined ? !!values.learned : true;
    if (!learned) {
      delete ch.SkillTree.LearnedSkill[skillItemId];
      this._markTouched(cid);
      return null;
    }

    var skill = ch.SkillTree.LearnedSkill[skillItemId];
    if (!skill) {
      skill = {
        Name: null,
        CurrentExp: 0,
        MaxExp: 2000000,
        IsBackup: false,
        IsExpert: false,
        ClickedNodes: []
      };
      ch.SkillTree.LearnedSkill[skillItemId] = skill;
    }

    if (values.isExpert !== undefined) skill.IsExpert = !!values.isExpert;
    if (values.currentExp !== undefined) {
      skill.CurrentExp = Math.max(0, toFiniteInt(values.currentExp, 0));
    }
    if (values.maxExp !== undefined) {
      skill.MaxExp = Math.max(0, toFiniteInt(values.maxExp, 0));
    }

    this._markTouched(cid);
    return skill;
  };

  HtlsSession.prototype.setTalentNodes = function (cid, clickedNodes, newPoint) {
    var ch = this._getMutableCharacter(cid);
    if (!ch.TalentData) ch.TalentData = { NewPoint: 0, ClickedNodes: [] };
    if (Array.isArray(clickedNodes)) {
      ch.TalentData.ClickedNodes = clickedNodes.map(String);
    }
    if (newPoint !== undefined) {
      ch.TalentData.NewPoint = Math.max(0, clampInt(newPoint, 0, 999999999, 0));
    }
    this._markTouched(cid);
    return ch.TalentData;
  };

  HtlsSession.prototype.setEquipSlot = function (cid, slotKey, invIndexOrNull) {
    var ch = this._getMutableCharacter(cid);
    slotKey = String(slotKey);
    if (EQUIP_SLOTS.indexOf(slotKey) === -1) {
      throw new Error('Unknown equipment slot: ' + slotKey);
    }
    if (!ch.Equip) ch.Equip = {};

    if (invIndexOrNull === null || invIndexOrNull === undefined) {
      ch.Equip[slotKey] = null;
      this._markTouched(cid);
      return null;
    }

    var index = toFiniteInt(invIndexOrNull, -1);
    if (!Array.isArray(ch.Inventory) || index < 0 || index >= ch.Inventory.length) {
      throw new Error('Inventory index out of range: ' + index);
    }
    if (!ch.Inventory[index]) throw new Error('Inventory item is null at index: ' + index);

    ch.Equip[slotKey] = cloneValue(ch.Inventory[index]);
    this._markTouched(cid);
    return ch.Equip[slotKey];
  };

  HtlsSession.prototype.setPartyTeammates = function (teammates) {
    if (!Array.isArray(teammates)) throw new Error('teammates must be an array');
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < teammates.length; i++) {
      var cid = String(teammates[i]);
      if (!seen[cid]) {
        seen[cid] = true;
        out.push(cid);
      }
    }
    setGameField(this.parsed, 'Teammates', out);
    this._markGameField('Teammates');
    return out;
  };

  HtlsSession.prototype.addTeammate = function (cid) {
    cid = String(cid);
    this._ensureBaselineCharacter(cid);
    var teammates = Array.isArray(getGameField(this.parsed, 'Teammates'))
      ? getGameField(this.parsed, 'Teammates').map(String)
      : [];
    if (teammates.indexOf(cid) === -1) teammates.push(cid);
    return this.setPartyTeammates(teammates);
  };

  HtlsSession.prototype.removeTeammate = function (cid) {
    cid = String(cid);
    var teammates = Array.isArray(getGameField(this.parsed, 'Teammates'))
      ? getGameField(this.parsed, 'Teammates').map(String)
      : [];
    var out = [];
    for (var i = 0; i < teammates.length; i++) {
      if (teammates[i] !== cid) out.push(teammates[i]);
    }
    return this.setPartyTeammates(out);
  };

  HtlsSession.prototype.setWorldSettings = function (settings) {
    settings = settings || {};
    var changed = {};

    if (settings.difficulty !== undefined) {
      var diff = clampInt(settings.difficulty, 0, 5, 1);
      setGameField(this.parsed, 'Difficulty', diff);
      this._markGameField('Difficulty');
      changed.Difficulty = diff;
    }

    if (settings.daysFromBeginning !== undefined) {
      var days = Math.max(0, clampInt(settings.daysFromBeginning, 0, 999999, 0));
      setGameField(this.parsed, 'DaysFromBeginning', days);
      this._markGameField('DaysFromBeginning');
      changed.DaysFromBeginning = days;
    }

    if (settings.skillExpRate !== undefined) {
      var rate = Number(settings.skillExpRate);
      if (!isFinite(rate)) rate = 0.75;
      if (rate < 0) rate = 0;
      setGameField(this.parsed, 'SkillExpDistributionRate', rate);
      this._markGameField('SkillExpDistributionRate');
      changed.SkillExpDistributionRate = rate;
    }

    if (settings.unlockAllTeleporters) {
      var tp = getTeleporterKeys();
      setGameField(this.parsed, 'AvailableTeleporters', tp);
      this._markGameField('AvailableTeleporters');
      changed.AvailableTeleporters = tp;
    }

    if (settings.unlockAllNicknames) {
      var nn = getNicknameKeys();
      setGameField(this.parsed, 'AvailableNicknames', nn);
      this._markGameField('AvailableNicknames');
      changed.AvailableNicknames = nn;
    }

    return changed;
  };

  HtlsSession.prototype.validate = function () {
    var result = { ok: true, errors: [], warnings: [] };
    var parsed = this.parsed;
    var magicStr = parsed && parsed.magic instanceof Uint8Array
      ? new TextDecoder().decode(parsed.magic)
      : (parsed ? String(parsed.magic || '') : '');

    if (!parsed || (magicStr !== 'HELUO_1_0' && magicStr !== 'HELUO_1_1')) {
      result.ok = false;
      result.errors.push('지원하지 않는 세이브 헤더 형식입니다.');
    }

    var ids = getCharacterIds(parsed);
    if (ids.indexOf('Player') === -1) {
      result.ok = false;
      result.errors.push('주인공(Player) 데이터가 존재하지 않습니다.');
    }

    var teammates = getGameField(parsed, 'Teammates');
    if (!Array.isArray(teammates) || teammates.length === 0) {
      result.ok = false;
      result.errors.push('동료 목록이 비어 있습니다.');
    }

    var invNoList = getGameField(parsed, 'inventoryNoList');
    if (!containsPositiveUniqueInventoryNos(invNoList)) {
      result.ok = false;
      result.errors.push('가방 고유번호 목록(inventoryNoList)에 중복 또는 잘못된 값이 있습니다.');
    }

    var touchedIds = Object.keys(this._touchedSet);
    for (var i = 0; i < touchedIds.length; i++) {
      var cid = touchedIds[i];
      var ch = this._charCache[cid];
      if (!ch) continue;

      if (!validateInventoryItemIds(ch)) {
        result.ok = false;
        result.errors.push('인물(' + cid + ')의 장비 고유번호가 중복되거나 올바르지 않습니다.');
      }

      if (!validateCharacterFiniteStats(ch)) {
        result.ok = false;
        result.errors.push('인물(' + cid + ')의 능력치에 정수가 아닌 값이 포함되어 있습니다.');
      }
    }

    return result;
  };

  HtlsSession.prototype.computeDiff = function () {
    var diff = {
      changed: false,
      header: {},
      gameFields: {},
      characters: {}
    };

    var currentHeader = cloneValue(this.parsed.header || {});
    var headerKeys = {};
    var i;
    var baseHeaderKeys = Object.keys(this._baselineHeader || {});
    for (i = 0; i < baseHeaderKeys.length; i++) headerKeys[baseHeaderKeys[i]] = true;
    var curHeaderKeys = Object.keys(currentHeader);
    for (i = 0; i < curHeaderKeys.length; i++) headerKeys[curHeaderKeys[i]] = true;

    var hk = Object.keys(headerKeys);
    for (i = 0; i < hk.length; i++) {
      var hKey = hk[i];
      if (!sameValue(this._baselineHeader[hKey], currentHeader[hKey])) {
        diff.header[hKey] = {
          before: cloneValue(this._baselineHeader[hKey]),
          after: cloneValue(currentHeader[hKey])
        };
        diff.changed = true;
      }
    }

    for (i = 0; i < GAME_FIELD_KEYS.length; i++) {
      var gKey = GAME_FIELD_KEYS[i];
      var before = this._baselineGameFields[gKey];
      var after = getGameField(this.parsed, gKey);
      if (!sameValue(before, after)) {
        diff.gameFields[gKey] = {
          before: cloneValue(before),
          after: cloneValue(after)
        };
        diff.changed = true;
      }
    }

    var cids = {};
    var baseCids = Object.keys(this._baselineChars);
    for (i = 0; i < baseCids.length; i++) cids[baseCids[i]] = true;
    var touchedCids = Object.keys(this._touchedSet);
    for (i = 0; i < touchedCids.length; i++) cids[touchedCids[i]] = true;
    var cacheCids = Object.keys(this._charCache);
    for (i = 0; i < cacheCids.length; i++) cids[cacheCids[i]] = true;

    var cidKeys = Object.keys(cids);
    for (i = 0; i < cidKeys.length; i++) {
      var cid = cidKeys[i];
      var baseChar = this._baselineChars[cid];
      var curChar = this._charCache[cid];
      if (!baseChar && curChar) {
        baseChar = cloneValue(curChar);
        this._baselineChars[cid] = baseChar;
      }
      if (!sameValue(baseChar, curChar)) {
        diff.characters[cid] = {
          before: cloneValue(baseChar),
          after: cloneValue(curChar)
        };
        diff.changed = true;
      }
    }

    return diff;
  };

  HtlsSession.prototype.syncHeaderAndSave = function () {
    var gameFields = this._gameFields();
    var touchedIds = Object.keys(this._touchedSet);

    for (var i = 0; i < GAME_FIELD_KEYS.length; i++) {
      var key = GAME_FIELD_KEYS[i];
      var value = getGameField(this.parsed, key);
      setGameField(this.parsed, key, cloneValue(value));
    }

    for (var t = 0; t < touchedIds.length; t++) {
      var cid = touchedIds[t];
      if (this._charCache[cid]) {
        setCharacter(this.parsed, cid, this._charCache[cid]);
      }
    }

    var header = this.parsed.header || (this.parsed.header = {});
    if (header && typeof header === 'object') {
      header.playedDays = Math.max(0, toFiniteInt(gameFields.DaysFromBeginning, toFiniteInt(header.playedDays, 0)));

      if (gameFields.Difficulty !== undefined) {
        header.difficulty = clampInt(gameFields.Difficulty, 0, 5, toFiniteInt(header.difficulty, 1));
      }

      var teammates = Array.isArray(gameFields.Teammates) ? gameFields.Teammates.map(String) : [];
      header.teammateNames = teammates.slice();

      var magicStr = this.parsed.magic instanceof Uint8Array
        ? new TextDecoder().decode(this.parsed.magic)
        : String(this.parsed.magic || '');
      if (magicStr === 'HELUO_1_1') {
        var fullName = String(gameFields.PlayerSurname || '') + String(gameFields.PlayerName || '');
        if (fullName) header.playerName = fullName;

        var player = this._charCache['Player'];
        if (player) {
          header.playerLevel = Math.max(1, toFiniteInt(player.Level, toFiniteInt(header.playerLevel, 1)));
        }
      }
    }

    this.parsed._headerDirty = true;
    return Codec.serializeSave(this.parsed);
  };

  var PRESETS = [
    {
      id: 'rich_hero',
      name: '은전·기혈·내력 부자',
      description: '주인공 은전 최대(999,999,999) 및 기혈·내력 완전 회복'
    },
    {
      id: 'hero_max_stats',
      name: '주인공 전능력치 극한',
      description: '주인공 전투·병기·생활 능력치 극대화 및 상태이상 초기화'
    },
    {
      id: 'hero_all_talents',
      name: '주인공 감오 전체 개방',
      description: '주인공 감오 포인트 +200 및 6대 감오 전체 노드 개방'
    },
    {
      id: 'party_heal_cleanse',
      name: '파티 전원 회복·정화',
      description: '현재 파티원 전원의 기혈·내력 최대 회복 및 11종 상태이상 정화'
    },
    {
      id: 'unlock_teleporters',
      name: '전송 거점 전체 개방',
      description: '카탈로그의 모든 전송 거점과 칭호 해금'
    },
    {
      id: 'hero_master_skills',
      name: '주인공 보유 무공 숙련',
      description: '주인공이 보유한 모든 무공 숙련 개방 및 경험치 완충'
    }
  ];

  function applyPreset(session, presetId) {
    if (!(session instanceof HtlsSession)) {
      throw new Error('유효한 세이브 세션이 아닙니다.');
    }

    var preset = null;
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].id === presetId) {
        preset = PRESETS[i];
        break;
      }
    }
    if (!preset) throw new Error('알 수 없는 프리셋입니다: ' + presetId);

    var player = session.getCharacter('Player');
    switch (preset.id) {
      case 'rich_hero':
        session.setCharacterStat('Player', 'Money', 999999999);
        if (player && player.Data) {
          var mhp = player.Data.MaxHP && player.Data.MaxHP.Base ? Math.max(99999, player.Data.MaxHP.Base) : 99999;
          var mmp = player.Data.MaxMP && player.Data.MaxMP.Base ? Math.max(50000, player.Data.MaxMP.Base) : 50000;
          session.setCharacterStat('Player', 'MaxHP', mhp);
          session.setCharacterStat('Player', 'HP', mhp);
          session.setCharacterStat('Player', 'MaxMP', mmp);
          session.setCharacterStat('Player', 'MP', mmp);
        }
        break;

      case 'hero_max_stats': {
        var maxKeys = ['HP','MaxHP','MP','MaxMP','RecoverAP','Speed','Physique','Intelligence','ZOC','Fight','Sword','Blade','Spear','Arrow','Short','Doctor','Poison','Neigong','Qinggong','HurbKnowledge','MineralKnowledge','StealKnowledge','BusinessKnowledge'];
        for (var k = 0; k < maxKeys.length; k++) {
          var sk = maxKeys[k];
          var val = (sk === 'HP' || sk === 'MaxHP') ? 99999 : (sk === 'MP' || sk === 'MaxMP') ? 50000 : (sk === 'RecoverAP') ? 10 : (sk === 'ZOC') ? 100 : 500;
          session.setCharacterStat('Player', sk, val);
        }
        for (var s = 0; s < STATUS_KEYS.length; s++) {
          session.setCharacterStat('Player', STATUS_KEYS[s], 0);
        }
        break;
      }

      case 'hero_all_talents': {
        var allTalents = Catalog && Catalog.talents ? Object.keys(Catalog.talents) : ['0_TalentNode000'];
        var curPts = player && player.TalentData ? toFiniteInt(player.TalentData.NewPoint, 0) : 0;
        session.setTalentNodes('Player', allTalents, curPts + 200);
        break;
      }

      case 'party_heal_cleanse': {
        var mates = (session.parsed && getGameField(session.parsed, 'Teammates')) || ['Player'];
        if (!Array.isArray(mates) || mates.length === 0) mates = ['Player'];
        for (var m = 0; m < mates.length; m++) {
          var cid = String(mates[m]);
          var ch = session.getCharacter(cid);
          if (!ch) continue;
          var chMhp = ch.Data && ch.Data.MaxHP ? toFiniteInt(ch.Data.MaxHP.Base, 1000) : 1000;
          var chMmp = ch.Data && ch.Data.MaxMP ? toFiniteInt(ch.Data.MaxMP.Base, 500) : 500;
          session.setCharacterStat(cid, 'HP', Math.max(1000, chMhp));
          session.setCharacterStat(cid, 'MP', Math.max(500, chMmp));
          for (var z = 0; z < STATUS_KEYS.length; z++) {
            session.setCharacterStat(cid, STATUS_KEYS[z], 0);
          }
        }
        break;
      }

      case 'unlock_teleporters':
        session.setWorldSettings({ unlockAllTeleporters: true, unlockAllNicknames: true });
        break;

      case 'hero_master_skills': {
        var st = player && player.SkillTree && player.SkillTree.LearnedSkill ? player.SkillTree.LearnedSkill : {};
        var skIds = Object.keys(st);
        for (var x = 0; x < skIds.length; x++) {
          var existing = st[skIds[x]] || {};
          var mexp = toFiniteInt(existing.MaxExp, 2000000) || 2000000;
          session.setSkillMastery('Player', skIds[x], {
            learned: true,
            isExpert: true,
            currentExp: mexp,
            maxExp: mexp
          });
        }
        break;
      }
    }

    return preset;
  }

  HtlsSession.prototype.applyPreset = function (presetId) {
    return applyPreset(this, presetId);
  };

  function createSession(bytes, name) {
    return new HtlsSession(bytes, name);
  }

  function createDemoSave() {
    return makeDemoSave();
  }

  var api = {
    HtlsSession: HtlsSession,
    createSession: createSession,
    PRESETS: PRESETS,
    applyPreset: function (session, presetId) {
      return applyPreset(session, presetId);
    },
    createDemoSave: createDemoSave
  };

  return api;
});
