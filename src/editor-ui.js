'use strict';
(function () {
  const D = document;
  const $ = (id) => D.getElementById(id);
  const Core = window.HtlsEditorCore;
  const Cat = window.HtlsCatalog || {};
  const state = {
    session: null,
    fileName: '저장파일.save',
    cid: null,
    filter: '',
    tab: 'summary',
    picker: null,
    serverToken: '',
    serverSaves: [],
    nativeReady: false,
    dirty: false
  };

  const tabList = [
    ['summary', 'tab-btn-summary', 'panel-summary'],
    ['chara', 'tab-btn-chara', 'panel-chara'],
    ['skills', 'tab-btn-skills', 'panel-skills'],
    ['inventory', 'tab-btn-inventory', 'panel-inventory'],
    ['party', 'tab-btn-party', 'panel-party'],
    ['atlas', 'tab-btn-atlas', 'panel-atlas']
  ];

  function el(tag, text, cls) {
    const n = D.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); return n; }
  function status(msg, bad) {
    const n = $('status-msg');
    if (!n) return;
    n.textContent = msg || '';
    n.className = bad ? 'error' : 'ok';
  }
  function setFile(name) {
    state.fileName = name || '저장파일.save';
    const b = $('file-badge');
    if (b) b.textContent = state.fileName;
    markDirty(false);
  }
  function markDirty(v) {
    state.dirty = !!v;
    const b = $('dirty-badge');
    if (b) {
      b.hidden = !state.dirty;
      b.textContent = state.dirty ? '미저장 변경' : '';
    }
  }
  function opt(text, value, selected) {
    const o = el('option', text);
    o.value = value === undefined || value === null ? '' : String(value);
    o.selected = !!selected;
    return o;
  }
  function button(text, fn, cls) {
    const b = el('button', text, cls || '');
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }
  function field(label, input) {
    const w = el('label', null, 'field');
    w.appendChild(el('span', label, 'field-label'));
    w.appendChild(input);
    return w;
  }
  function numInput(value, min, max, step) {
    const i = el('input');
    i.type = 'number';
    if (min !== undefined) i.min = String(min);
    if (max !== undefined) i.max = String(max);
    i.step = String(step || 1);
    i.value = value === undefined || value === null ? '' : String(value);
    return i;
  }
  function textInput(value, placeholder) {
    const i = el('input');
    i.type = 'text';
    i.value = value === undefined || value === null ? '' : String(value);
    if (placeholder) i.placeholder = placeholder;
    return i;
  }
  function selectInput(items, value, emptyText) {
    const s = el('select');
    if (emptyText !== undefined) s.appendChild(opt(emptyText, '', value === '' || value === null || value === undefined));
    (items || []).forEach((it) => {
      const id = it && (it.id !== undefined ? it.id : it.value);
      const name = it && (it.name !== undefined ? it.name : it.label);
      s.appendChild(opt(name !== undefined ? name : id, id, String(id) === String(value)));
    });
    return s;
  }
  function normalizeList(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'object') {
      return Object.keys(v).map((k) => {
        const entry = v[k];
        if (entry && typeof entry === 'object') {
          const text = entry.name || entry.label || entry.id || k;
          return Object.assign({}, entry, { id: k, name: String(text), label: String(text) });
        }
        return { id: k, name: entry, label: entry };
      });
    }
    return [];
  }
  function codeLabel(map, id) {
    if (!map) return id === null || id === undefined ? '' : String(id);
    if (Array.isArray(map)) {
      const f = map.find((x) => String(x.id !== undefined ? x.id : x.value) === String(id));
      return f ? (f.name || f.label || f.id) : String(id);
    }
    if (typeof map === 'object' && map[id] !== undefined) {
      const v = map[id];
      return typeof v === 'object' ? (v.name || v.label || id) : v;
    }
    return id === null || id === undefined ? '' : String(id);
  }
  function hasSession() {
    if (!state.session) {
      status('먼저 저장파일을 열어 주세요.', true);
      return false;
    }
    return true;
  }
  function refreshAll() {
    renderSummary();
    renderCharacters();
    renderCharacterDetail();
    renderSkillsTalents();
    renderInventory();
    renderParty();
    renderAtlas();
  }
  function applySession(session, name) {
    state.session = session;
    state.cid = null;
    const list = session.getCharacterList ? session.getCharacterList() : [];
    const player = list.find((x) => x.isPlayer) || list[0];
    state.cid = player ? player.id : null;
    setFile(name || state.fileName);
    const dl = $('btn-download-save');
    if (dl) dl.disabled = false;
    refreshAll();
    status('저장파일을 열었습니다.');
  }

  function u8ToB64(u8) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return btoa(s);
  }
  function b64ToU8(s) {
    const bin = atob(s || '');
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  function downloadU8(u8, name) {
    const blob = new Blob([u8], { type: 'application/octet-stream' });
    const a = el('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = name || state.fileName || '저장파일.save';
    D.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 800);
  }
  function saveBytes() {
    if (!hasSession()) return null;
    const u8 = state.session.syncHeaderAndSave();
    markDirty(false);
    return u8;
  }
  function openBytes(u8, name) {
    if (!Core || !Core.createSession) {
      status('편집기 핵심 모듈을 찾지 못했습니다.', true);
      return false;
    }
    try {
      applySession(Core.createSession(u8, name), name);
      return true;
    } catch (e) {
      status('저장파일을 여는 중 오류가 발생했습니다.', true);
      return false;
    }
  }

  function setupTabs() {
    const tabs = tabList.map((x) => $(x[1])).filter(Boolean);
    tabs.forEach((btn, idx) => {
      btn.addEventListener('click', () => activateTab(tabList[idx][0], false));
      btn.addEventListener('keydown', (ev) => {
        let next = -1;
        if (ev.key === 'ArrowRight') next = (idx + 1) % tabs.length;
        else if (ev.key === 'ArrowLeft') next = (idx + tabs.length - 1) % tabs.length;
        else if (ev.key === 'Home') next = 0;
        else if (ev.key === 'End') next = tabs.length - 1;
        if (next >= 0) {
          ev.preventDefault();
          activateTab(tabList[next][0], true);
          tabs[next].focus();
        }
      });
    });
    activateTab('summary', false);
  }
  function activateTab(name, focus) {
    const found = tabList.find((x) => x[0] === name) || tabList[0];
    state.tab = found[0];
    tabList.forEach((x) => {
      const b = $(x[1]);
      const p = $(x[2]);
      const on = x[0] === found[0];
      if (b) {
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
        b.className = on ? 'tab-btn active' : 'tab-btn';
      }
      if (p) {
        p.hidden = !on;
        p.classList.toggle('active', on);
      }
    });
  }

  function renderSummary() {
    const cards = clear($('summary-cards'));
    const grid = clear($('preset-grid'));
    const form = clear($('world-form'));
    if (!cards || !grid || !form) return;
    const s = state.session;
    if (!s) {
      cards.appendChild(el('p', '열린 저장파일이 없습니다.', 'empty'));
      return;
    }
    const h = s.parsed.header || {};
    const gf = (s._gameFields ? s._gameFields() : s.gameFields) || {};
    let ver = h.version !== undefined ? h.version : h.saveVersion;
    if (s.parsed && s.parsed.magic) {
      try {
        ver = s.parsed.magic instanceof Uint8Array
          ? new TextDecoder().decode(s.parsed.magic)
          : String(s.parsed.magic);
      } catch (e) {}
    }
    const add = (k, v) => {
      const c = el('div', null, 'card');
      c.appendChild(el('span', k, 'card-key'));
      c.appendChild(el('strong', v === undefined || v === null || v === '' ? '-' : v, 'card-value'));
      cards.appendChild(c);
    };
    add('파일', state.fileName);
    add('버전', ver);
    add('캐릭터 수', (s.getCharacterList ? s.getCharacterList().length : 0));
    add('난이도', codeLabel(Cat.difficulties, gf.Difficulty));
    add('경과 일수', gf.DaysFromBeginning);
    add('숙련 경험 배율', gf.SkillExpDistributionRate);
    add('동료 수', Array.isArray(gf.Teammates) ? gf.Teammates.length : 0);
    add('순간이동 해금', Array.isArray(gf.AvailableTeleporters) ? gf.AvailableTeleporters.length : 0);
    add('별명 해금', Array.isArray(gf.AvailableNicknames) ? gf.AvailableNicknames.length : 0);

    const presets = Core && Core.PRESETS ? Core.PRESETS : [];
    if (!presets.length) grid.appendChild(el('p', '사용 가능한 프리셋이 없습니다.', 'empty'));
    presets.forEach((p) => {
      const c = el('div', null, 'preset-card');
      c.appendChild(el('strong', p.name || p.id));
      c.appendChild(el('p', p.description || '', 'muted'));
      c.appendChild(button('적용', () => {
        try {
          Core.applyPreset(state.session, p.id);
          markDirty(true);
          refreshAll();
          status('프리셋을 적용했습니다.');
        } catch (e) {
          status('프리셋 적용 중 오류가 발생했습니다.', true);
        }
      }, 'primary'));
      grid.appendChild(c);
    });

    const diff = normalizeList(Cat.difficulties).length ? Cat.difficulties : [
      { id: 0, name: '보통' }, { id: 1, name: '어려움' }, { id: 2, name: '매우 어려움' }
    ];
    const dSel = selectInput(normalizeList(diff), gf.Difficulty);
    const days = numInput(gf.DaysFromBeginning, 0);
    const rate = numInput(gf.SkillExpDistributionRate, 0, undefined, 0.1);
    const uT = el('input'); uT.type = 'checkbox'; uT.checked = !!(gf.AvailableTeleporters && gf.AvailableTeleporters.length);
    const uN = el('input'); uN.type = 'checkbox'; uN.checked = !!(gf.AvailableNicknames && gf.AvailableNicknames.length);
    form.appendChild(field('난이도', dSel));
    form.appendChild(field('경과 일수', days));
    form.appendChild(field('숙련 경험 배율', rate));
    form.appendChild(field('순간이동 모두 해금', uT));
    form.appendChild(field('별명 모두 해금', uN));
    form.appendChild(button('세계 설정 저장', () => {
      try {
        s.setWorldSettings({
          difficulty: Number(dSel.value),
          daysFromBeginning: Number(days.value),
          skillExpRate: Number(rate.value),
          unlockAllTeleporters: uT.checked,
          unlockAllNicknames: uN.checked
        });
        markDirty(true);
        renderSummary();
        status('세계 설정을 저장했습니다.');
      } catch (e) {
        status('세계 설정 저장 중 오류가 발생했습니다.', true);
      }
    }, 'primary'));
  }

  function renderCharacters() {
    const filter = $('chara-filter');
    const sel = $('chara-select');
    const box = clear($('chara-basic-box'));
    const bar = clear($('stat-group-bar'));
    const grid = clear($('stats-grid'));
    if (!sel) return;
    const s = state.session;
    clear(sel);
    if (!s) {
      sel.appendChild(opt('열린 저장파일 없음', ''));
      if (box) box.appendChild(el('p', '캐릭터가 없습니다.', 'empty'));
      return;
    }
    const list = s.getCharacterList();
    const q = (filter ? filter.value : '').trim().toLowerCase();
    const shown = list.filter((c) => !q || String(c.name || '').toLowerCase().includes(q));
    shown.forEach((c) => {
      const isMate = !!(c.isTeammate || c.inParty);
      const label = (c.isPlayer ? '[플레이어] ' : '') + (c.name || c.id) + (isMate ? ' • 동료' : '');
      sel.appendChild(opt(label, c.id, String(c.id) === String(state.cid)));
    });
    if (!shown.length) {
      sel.appendChild(opt('검색 결과 없음', ''));
      return;
    }
    if (!shown.some((c) => String(c.id) === String(state.cid))) state.cid = shown[0].id;
    sel.value = String(state.cid);
    if (sel.dataset.bound !== '1') {
      sel.dataset.bound = '1';
      sel.addEventListener('change', () => {
        state.cid = isNaN(Number(sel.value)) ? sel.value : Number(sel.value);
        renderCharacterDetail();
        renderSkillsTalents();
        renderInventory();
        renderParty();
      });
    }
    if (filter && filter.dataset.bound !== '1') {
      filter.dataset.bound = '1';
      filter.addEventListener('input', () => renderCharacters());
    }
    if (bar && grid) {
      const d = s.getCharacterDetail(state.cid);
      if (d && d.stats) {
        const groups = [];
        d.stats.forEach((st) => { if (groups.indexOf(st.group) < 0) groups.push(st.group); });
        groups.forEach((g) => bar.appendChild(el('span', g || '기본', 'chip')));
      }
    }
    if (box) {
      if (!sel.value && !list.length) box.appendChild(el('p', '캐릭터가 없습니다.', 'empty'));
    }
  }

  function renderCharacterDetail() {
    const box = clear($('chara-basic-box'));
    const grid = clear($('stats-grid'));
    if (!box || !grid) return;
    if (!state.session || state.cid === null) {
      box.appendChild(el('p', '캐릭터를 선택해 주세요.', 'empty'));
      return;
    }
    const d = state.session.getCharacterDetail(state.cid);
    if (!d) {
      box.appendChild(el('p', '캐릭터 정보를 읽지 못했습니다.', 'empty'));
      return;
    }
    const surnames = textInput(d.name ? '' : '');
    surnames.placeholder = '성';
    const names = textInput(d.name || '');
    const level = numInput(d.level, 1, d.maxLevel || undefined);
    const exp = numInput(d.exp, 0, d.maxExp || undefined);
    const tp = numInput(d.talentPoint, 0);
    const nickname = selectInput(normalizeList(Cat.nicknames), d.nicknameId, '없음');
    const nei = selectInput(normalizeList(Cat.skills), d.currentNeiGongId, '없음');
    const qing = selectInput(normalizeList(Cat.skills), d.currentQingGongId, '없음');
    const tree = selectInput(normalizeList(Cat.talentTrees), d.currentSkillTreeId, '없음');
    box.appendChild(field('이름', names));
    box.appendChild(field('성', surnames));
    box.appendChild(field('레벨', level));
    box.appendChild(field('경험치', exp));
    box.appendChild(field('특성 점수', tp));
    box.appendChild(field('별명', nickname));
    box.appendChild(field('내공', nei));
    box.appendChild(field('경공', qing));
    box.appendChild(field('특성 계통', tree));
    box.appendChild(button('기본 정보 저장', () => {
      try {
        state.session.setCharacterBasics(state.cid, {
          surname: surnames.value,
          name: names.value,
          level: Number(level.value),
          exp: Number(exp.value),
          talentPoint: Number(tp.value),
          nicknameId: nickname.value === '' ? null : Number(nickname.value),
          currentNeiGongId: nei.value === '' ? null : Number(nei.value),
          currentQingGongId: qing.value === '' ? null : Number(qing.value),
          currentSkillTreeId: tree.value === '' ? null : Number(tree.value)
        });
        markDirty(true);
        renderCharacters();
        renderCharacterDetail();
        status('기본 정보를 저장했습니다.');
      } catch (e) {
        status('기본 정보 저장 중 오류가 발생했습니다.', true);
      }
    }, 'primary'));

    (d.stats || []).forEach((st) => {
      const w = el('div', null, 'stat-item');
      w.appendChild(el('span', st.label || st.key, 'stat-label'));
      const inp = numInput(st.value, st.min, st.max);
      const set = () => {
        try {
          let v = Number(inp.value);
          if (st.min !== undefined && v < st.min) v = st.min;
          if (st.max !== undefined && v > st.max) v = st.max;
          state.session.setCharacterStat(state.cid, st.key, v);
          markDirty(true);
          inp.value = String(v);
          status('능력치를 변경했습니다.');
        } catch (e) {
          status('능력치 변경 중 오류가 발생했습니다.', true);
        }
      };
      inp.addEventListener('change', set);
      w.appendChild(inp);
      w.appendChild(el('span', String(st.min) + ' ~ ' + String(st.max), 'muted'));
      grid.appendChild(w);
    });
  }

  function skillLabel(s) {
    const cat = s.category ? '[' + codeLabel(Cat.skills, s.category) + '] ' : '';
    return cat + (s.name || s.id);
  }
  function renderSkillsTalents() {
    const sk = clear($('skills-box'));
    const ta = clear($('talents-box'));
    if (!sk || !ta) return;
    if (!state.session || state.cid === null) {
      sk.appendChild(el('p', '캐릭터를 선택해 주세요.', 'empty'));
      ta.appendChild(el('p', '캐릭터를 선택해 주세요.', 'empty'));
      return;
    }
    const d = state.session.getCharacterDetail(state.cid);
    if (!d) return;
    (d.skills || []).forEach((s) => {
      const row = el('div', null, 'skill-row');
      row.appendChild(el('strong', skillLabel(s)));
      row.appendChild(el('span', s.isExpert ? '전문' : '일반', 'chip'));
      const learned = el('input'); learned.type = 'checkbox'; learned.checked = !!(s.currentExp > 0 || s.isExpert || s.clickedNodes);
      const expert = el('input'); expert.type = 'checkbox'; expert.checked = !!s.isExpert;
      const cur = numInput(s.currentExp || 0, 0, s.maxExp || undefined);
      const max = numInput(s.maxExp || 1, 0);
      row.appendChild(field('습득', learned));
      row.appendChild(field('전문', expert));
      row.appendChild(field('현재 숙련', cur));
      row.appendChild(field('최대 숙련', max));
      row.appendChild(button('저장', () => {
        try {
          state.session.setSkillMastery(state.cid, s.id, {
            learned: learned.checked,
            isExpert: expert.checked,
            currentExp: Number(cur.value),
            maxExp: Number(max.value)
          });
          markDirty(true);
          renderSkillsTalents();
          status('무공 숙련을 저장했습니다.');
        } catch (e) {
          status('무공 숙련 저장 중 오류가 발생했습니다.', true);
        }
      }));
      sk.appendChild(row);
    });
    if (!sk.childNodes.length) sk.appendChild(el('p', '무공 정보가 없습니다.', 'empty'));

    const talents = normalizeList(Cat.talents);
    const clicked = (d.clickedTalents || []).slice();
    const point = numInput(d.talentPoint, 0);
    ta.appendChild(field('남은 특성 점수', point));
    talents.forEach((t) => {
      const id = t.id !== undefined ? t.id : t.value;
      const cb = el('input'); cb.type = 'checkbox';
      cb.checked = clicked.indexOf(String(id)) >= 0 || clicked.indexOf(id) >= 0;
      const lab = el('label', null, 'talent-item');
      lab.appendChild(cb);
      lab.appendChild(el('span', t.name || t.label || id));
      ta.appendChild(lab);
    });
    ta.appendChild(button('특성 저장', () => {
      const nodes = [];
      ta.querySelectorAll('input[type=checkbox]').forEach((cb, i) => {
        if (cb.checked && talents[i]) nodes.push(talents[i].id !== undefined ? talents[i].id : talents[i].value);
      });
      try {
        state.session.setTalentNodes(state.cid, nodes, Number(point.value));
        markDirty(true);
        renderSkillsTalents();
        status('특성을 저장했습니다.');
      } catch (e) {
        status('특성 저장 중 오류가 발생했습니다.', true);
      }
    }, 'primary'));
  }

  function itemName(it) {
    if (!it) return '없음';
    if (typeof it === 'string' || typeof it === 'number') return String(it);
    if (it.ItemId) {
      const n = codeLabel(Cat.equipment, it.ItemId);
      if (n !== String(it.ItemId)) return n;
      const n2 = codeLabel(Cat.normalInventory, it.ItemId);
      if (n2 !== String(it.ItemId)) return n2;
      return String(it.ItemId);
    }
    return it.name || it.label || it.item || it.id || '없음';
  }
  function renderInventory() {
    const eq = clear($('equip-box'));
    const tb = clear($('inventory-toolbar'));
    const wr = clear($('inventory-table-wrap'));
    if (!eq || !tb || !wr) return;
    if (!state.session || state.cid === null) {
      wr.appendChild(el('p', '캐릭터를 선택해 주세요.', 'empty'));
      return;
    }
    const d = state.session.getCharacterDetail(state.cid);
    if (!d) return;
    const equipList = Array.isArray(d.equip)
      ? d.equip
      : Object.keys(d.equip || {}).map((slotKey) => ({
          slot: slotKey,
          label: codeLabel(Cat.equipSlots, slotKey),
          item: d.equip[slotKey]
        }));
    equipList.forEach((slot) => {
      const row = el('div', null, 'equip-row');
      row.appendChild(el('strong', slot.label || slot.slot));
      row.appendChild(el('span', itemName(slot.item)));
      row.appendChild(button('해제', () => {
        try {
          state.session.setEquipSlot(state.cid, slot.slot, null);
          markDirty(true);
          renderInventory();
          status('장비를 해제했습니다.');
        } catch (e) {
          status('장비 해제 중 오류가 발생했습니다.', true);
        }
      }));
      eq.appendChild(row);
    });
    if (!eq.childNodes.length) eq.appendChild(el('p', '장비 정보가 없습니다.', 'empty'));

    const invSel = selectInput(normalizeList(Cat.equipment).concat(normalizeList(Cat.normalInventory)), '', '아이템 선택');
    invSel.id = 'inventory-add-item';
    const addCount = numInput(1, 1);
    tb.appendChild(invSel);
    tb.appendChild(addCount);
    tb.appendChild(button('아이템 추가', () => {
      if (!invSel.value) { status('추가할 아이템을 선택해 주세요.', true); return; }
      try {
        state.session.addInventoryItem(state.cid, invSel.value, Number(addCount.value));
        markDirty(true);
        renderInventory();
        status('아이템을 추가했습니다.');
      } catch (e) {
        status('아이템 추가 중 오류가 발생했습니다.', true);
      }
    }, 'primary'));

    const table = el('table', null, 'inventory-table');
    const thead = el('thead');
    const hr = el('tr');
    ['번호', '이름', '코드', '수량', '내구도', '동작'].forEach((x) => hr.appendChild(el('th', x)));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    (d.inventory || []).forEach((it, idx) => {
      if (!it) return;
      const itemIndex = it.index !== undefined ? it.index : idx;
      const itemId = it.ItemId || it.itemId || '';
      const countVal = it.Count !== undefined ? it.Count : (it.count !== undefined ? it.count : 1);
      const durVal = it.Durable !== undefined ? it.Durable : (it.durability || 0);
      const maxDurVal = it.MaxDurable !== undefined ? it.MaxDurable : (it.maxDurability || 0);
      const tr = el('tr');
      tr.appendChild(el('td', itemIndex));
      tr.appendChild(el('td', itemName(it)));
      tr.appendChild(el('td', itemId));
      const cnt = numInput(countVal, 0);
      const cntTd = el('td');
      cntTd.appendChild(cnt);
      tr.appendChild(cntTd);
      tr.appendChild(el('td', String(durVal) + ' / ' + String(maxDurVal)));
      const ops = el('td');
      ops.appendChild(button('저장', () => {
        try {
          state.session.setInventoryCount(state.cid, itemIndex, Number(cnt.value));
          markDirty(true);
          renderInventory();
          status('수량을 저장했습니다.');
        } catch (e) {
          status('수량 저장 중 오류가 발생했습니다.', true);
        }
      }));
      ops.appendChild(button('삭제', () => {
        try {
          state.session.removeInventoryItem(state.cid, itemIndex);
          markDirty(true);
          renderInventory();
          status('아이템을 삭제했습니다.');
        } catch (e) {
          status('아이템 삭제 중 오류가 발생했습니다.', true);
        }
      }));
      const eqSel = selectInput(equipList.map((x) => ({ id: x.slot, name: x.label || x.slot })), '', '장비 위치');
      ops.appendChild(eqSel);
      ops.appendChild(button('장착', () => {
        if (!eqSel.value) return;
        try {
          state.session.setEquipSlot(state.cid, eqSel.value, itemIndex);
          markDirty(true);
          renderInventory();
          status('장비를 장착했습니다.');
        } catch (e) {
          status('장비 장착 중 오류가 발생했습니다.', true);
        }
      }));
      tr.appendChild(ops);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wr.appendChild(table);
  }

  function renderParty() {
    const pb = clear($('party-box'));
    const tb = clear($('teleporters-box'));
    const nb = clear($('nicknames-box'));
    if (!pb || !tb || !nb) return;
    if (!state.session) {
      pb.appendChild(el('p', '열린 저장파일이 없습니다.', 'empty'));
      return;
    }
    const allChars = state.session.getCharacterList();
    const partyChars = allChars.filter((c) => c.isPlayer || c.isTeammate || c.inParty);
    const reserveChars = allChars.filter((c) => !c.isPlayer && !c.isTeammate && !c.inParty).slice(0, 120);
    const list = partyChars.concat(reserveChars);
    list.forEach((c) => {
      const isMate = !!(c.isTeammate || c.inParty);
      const row = el('div', null, 'party-row');
      row.appendChild(el('span', c.name || c.id));
      row.appendChild(el('span', isMate ? '동료' : '대기', 'chip'));
      if (c.isPlayer) {
        row.appendChild(el('span', '플레이어', 'chip'));
      } else {
        row.appendChild(button(isMate ? '해제' : '추가', () => {
          try {
            if (isMate) state.session.removeTeammate(c.id);
            else state.session.addTeammate(c.id);
            markDirty(true);
            renderParty();
            renderCharacters();
            status('동료 설정을 변경했습니다.');
          } catch (e) {
            status('동료 설정 변경 중 오류가 발생했습니다.', true);
          }
        }));
      }
      pb.appendChild(row);
    });
    if (!pb.childNodes.length) pb.appendChild(el('p', '동료 정보가 없습니다.', 'empty'));

    const gf = (state.session._gameFields ? state.session._gameFields() : state.session.gameFields) || {};
    const tel = Array.isArray(gf.AvailableTeleporters) ? gf.AvailableTeleporters : [];
    normalizeList(Cat.teleporters).forEach((t) => {
      const id = t.id !== undefined ? t.id : t.value;
      const row = el('label', null, 'check-row');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = tel.indexOf(id) >= 0 || tel.indexOf(String(id)) >= 0;
      row.appendChild(cb);
      row.appendChild(el('span', t.name || t.label || id));
      tb.appendChild(row);
    });
    tb.appendChild(button('순간이동 해금 저장', () => {
      const values = [];
      tb.querySelectorAll('input[type=checkbox]').forEach((cb, i) => {
        const src = normalizeList(Cat.teleporters)[i];
        if (cb.checked && src) values.push(src.id !== undefined ? src.id : src.value);
      });
      try {
        state.session.setWorldSettings({
          difficulty: gf.Difficulty,
          daysFromBeginning: gf.DaysFromBeginning,
          skillExpRate: gf.SkillExpDistributionRate,
          unlockAllTeleporters: values.length === normalizeList(Cat.teleporters).length,
          unlockAllNicknames: !!(gf.AvailableNicknames && gf.AvailableNicknames.length)
        });
        markDirty(true);
        renderSummary();
        status('순간이동 설정을 저장했습니다.');
      } catch (e) {
        status('순간이동 설정 저장 중 오류가 발생했습니다.', true);
      }
    }, 'primary'));

    const nicks = Array.isArray(gf.AvailableNicknames) ? gf.AvailableNicknames : [];
    normalizeList(Cat.nicknames).forEach((n) => {
      const id = n.id !== undefined ? n.id : n.value;
      const row = el('label', null, 'check-row');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = nicks.indexOf(id) >= 0 || nicks.indexOf(String(id)) >= 0;
      row.appendChild(cb);
      row.appendChild(el('span', n.name || n.label || id));
      nb.appendChild(row);
    });
    nb.appendChild(button('별명 해금 저장', () => {
      const values = [];
      nb.querySelectorAll('input[type=checkbox]').forEach((cb, i) => {
        const src = normalizeList(Cat.nicknames)[i];
        if (cb.checked && src) values.push(src.id !== undefined ? src.id : src.value);
      });
      try {
        state.session.setWorldSettings({
          difficulty: gf.Difficulty,
          daysFromBeginning: gf.DaysFromBeginning,
          skillExpRate: gf.SkillExpDistributionRate,
          unlockAllTeleporters: !!(gf.AvailableTeleporters && gf.AvailableTeleporters.length),
          unlockAllNicknames: values.length === normalizeList(Cat.nicknames).length
        });
        markDirty(true);
        renderSummary();
        status('별명 설정을 저장했습니다.');
      } catch (e) {
        status('별명 설정 저장 중 오류가 발생했습니다.', true);
      }
    }, 'primary'));
  }

  function renderAtlas() {
    const vb = clear($('validation-box'));
    const db = clear($('diff-box'));
    const ab = clear($('atlas-box'));
    if (!vb || !db || !ab) return;
    if (!state.session) {
      vb.appendChild(el('p', '열린 저장파일이 없습니다.', 'empty'));
      return;
    }
    try {
      const v = state.session.validate();
      vb.appendChild(el('strong', v.ok ? '검증 통과' : '검증 오류', v.ok ? 'ok' : 'bad'));
      (v.errors || []).forEach((x) => vb.appendChild(el('p', x, 'error-line')));
    } catch (e) {
      vb.appendChild(el('p', '검증 중 오류가 발생했습니다.', 'bad'));
    }
    try {
      const diff = state.session.computeDiff();
      const pre = el('pre', JSON.stringify(diff, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
      db.appendChild(pre);
    } catch (e) {
      db.appendChild(el('p', '차이 계산 중 오류가 발생했습니다.', 'bad'));
    }
    const atlas = Cat.codeAtlas;
    if (atlas) {
      if (Array.isArray(atlas)) {
        atlas.forEach((x) => {
          ab.appendChild(el('div', (x.name || x.label || x.id) + ' : ' + (x.value !== undefined ? x.value : x.id), 'atlas-line'));
        });
      } else {
        Object.keys(atlas).forEach((k) => {
          const v = atlas[k];
          ab.appendChild(el('div', k + ' : ' + (typeof v === 'object' ? JSON.stringify(v) : v), 'atlas-line'));
        });
      }
    } else {
      ab.appendChild(el('p', '코드 도감 정보가 없습니다.', 'empty'));
    }
  }

  function openPicker(title, list, onPick) {
    const dlg = $('picker-dialog');
    if (!dlg || !dlg.showModal) return;
    state.picker = { list: list || [], onPick };
    $('picker-title').textContent = title || '선택';
    $('picker-search').value = '';
    renderPicker();
    dlg.showModal();
    setTimeout(() => $('picker-search').focus(), 0);
  }
  function renderPicker() {
    const box = clear($('picker-list'));
    const q = ($('picker-search').value || '').toLowerCase();
    (state.picker ? state.picker.list : []).filter((x) => {
      const name = String(x.name || x.label || x.id || x.value || '');
      return !q || name.toLowerCase().includes(q);
    }).forEach((x) => {
      box.appendChild(button(x.name || x.label || x.id || x.value, () => {
        const fn = state.picker && state.picker.onPick;
        const dlg = $('picker-dialog');
        if (dlg && dlg.open) dlg.close();
        if (fn) fn(x);
      }, 'picker-item'));
    });
  }
  function setupPicker() {
    const dlg = $('picker-dialog');
    if (!dlg) return;
    $('picker-close').addEventListener('click', () => dlg.close());
    $('picker-search').addEventListener('input', renderPicker);
    dlg.addEventListener('cancel', () => { state.picker = null; });
  }

  function setupTheme() {
    const btn = $('btn-theme');
    function set(theme) {
      D.documentElement.dataset.theme = theme;
      D.body.dataset.theme = theme;
      if (btn) btn.textContent = theme === 'dark' ? '밝게' : '어둡게';
      try { localStorage.setItem('htls-theme', theme); } catch (e) {}
    }
    let saved = 'light';
    try { saved = localStorage.getItem('htls-theme') || 'light'; } catch (e) {}
    set(saved);
    if (btn) btn.addEventListener('click', () => set(D.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  }

  function setupBrowser() {
    const input = $('file-input');
    const open = $('btn-file-open');
    const save = $('btn-download-save');
    const demo = $('btn-load-demo');
    if (open && input) open.addEventListener('click', () => input.click());
    if (input) input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) return;
      f.arrayBuffer().then((buf) => openBytes(new Uint8Array(buf), f.name)).catch(() => status('파일 읽기 오류', true));
      input.value = '';
    });
    if (save) save.addEventListener('click', () => {
      const u8 = saveBytes();
      if (u8) { downloadU8(u8, state.fileName); status('저장파일을 내려받았습니다.'); }
    });
    if (demo) demo.addEventListener('click', () => {
      try {
        if (!Core || !Core.createDemoSave) throw 0;
        openBytes(Core.createDemoSave(), '예제.save');
        status('예제 저장파일을 열었습니다.');
      } catch (e) {
        status('예제 저장파일을 만들지 못했습니다.', true);
      }
    });
  }

  function setupNative() {
    const wv = window.chrome && window.chrome.webview;
    if (!wv) return;
    const bar = $('native-bar');
    if (bar) bar.hidden = false;
    window.__htlsBridgeReady = true;
    $('btn-native-open').addEventListener('click', () => wv.postMessage(JSON.stringify({ cmd: 'open' })));
    $('btn-native-save').addEventListener('click', () => {
      const u8 = saveBytes();
      if (u8) wv.postMessage(JSON.stringify({ cmd: 'save', path: state.nativePath || '', expectedHash: state.nativeSha256 || '', dataB64: u8ToB64(u8), fileName: state.fileName }));
    });
    $('btn-native-save-copy').addEventListener('click', () => {
      const u8 = saveBytes();
      if (u8) wv.postMessage(JSON.stringify({ cmd: 'saveAs', path: state.nativePath || '', dataB64: u8ToB64(u8), fileName: state.fileName }));
    });
    wv.addEventListener('message', (ev) => {
      let m = ev.data;
      if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { m = {}; } }
      m = m || {};
      try {
        if (m.canceled) return;
        if (m.error) { status('네이티브 오류: ' + m.error, true); return; }
        const b64 = m.dataB64 || m.data || m.base64 || m.content;
        if (b64) {
          state.nativePath = m.path || state.nativePath;
          state.nativeSha256 = m.sha256 || state.nativeSha256;
          openBytes(b64ToU8(b64), m.fileName || m.name || state.fileName);
        } else if (m.backupPath || m.saved || m.type === 'saved') {
          if (m.path) state.nativePath = m.path;
          if (m.sha256) state.nativeSha256 = m.sha256;
          markDirty(false);
          status('네이티브 저장 및 백업 완료');
        } else if (m.paths || m.type === 'discover' || m.type === 'ready') {
          status('네이티브 연결 준비됨');
        }
      } catch (e) {
        status('네이티브 메시지 처리 오류', true);
      }
    });
  }

  function setupServer() {
    fetch('/api/info').then((r) => r.ok ? r.json() : null).then((info) => {
      if (!info || !info.token) return;
      state.serverToken = info.token;
      const bar = $('server-bar');
      if (bar) bar.hidden = false;
      const sel = $('server-save-select');
      clear(sel);
      (info.files || info.saves || []).forEach((f) => sel.appendChild(opt(typeof f === 'string' ? f : (f.name || f.file), typeof f === 'string' ? f : (f.name || f.file))));
      $('btn-server-load').addEventListener('click', () => {
        const name = sel.value;
        if (!name) { status('불러올 저장파일을 선택해 주세요.', true); return; }
        fetch('/api/load?name=' + encodeURIComponent(name), { headers: { 'X-HTLS-Token': state.serverToken } })
          .then((r) => { if (!r.ok) throw 0; return r.arrayBuffer(); })
          .then((b) => { if (openBytes(new Uint8Array(b), name)) status('서버 저장파일을 열었습니다.'); })
          .catch(() => status('서버 불러오기 오류', true));
      });
      $('btn-server-save').addEventListener('click', () => {
        const u8 = saveBytes();
        if (!u8) return;
        fetch('/api/save', {
          method: 'POST',
          headers: { 'X-HTLS-Token': state.serverToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: state.fileName, data: u8ToB64(u8) })
        }).then((r) => {
          if (!r.ok) throw 0;
          status('서버에 저장했습니다.');
        }).catch(() => status('서버 저장 오류', true));
      });
    }).catch(() => {});
  }

  function setupHeaderButtons() {
    const theme = $('btn-theme');
    if (theme && !theme.dataset.bound) theme.dataset.bound = '1';
  }

  D.addEventListener('DOMContentLoaded', () => {
    setupTabs();
    setupTheme();
    setupBrowser();
    setupNative();
    setupServer();
    setupPicker();
    setupHeaderButtons();
    refreshAll();
    status('준비됨');
  });
})();
