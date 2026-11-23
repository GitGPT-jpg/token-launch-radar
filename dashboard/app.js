// Token Launch Radar dashboard. Reads window.RADAR (written beside this
// page by main.ts) and renders the board, the filters, the detail view and
// the live-token comparison. No network: every byte shown is in data.js.
//
// Hash routes, so a view can be linked and screenshotted directly:
//   #detail=<slug>    open one protocol's detail view
//   #chain=<chain>    filter the board to one chain
//   #category=<name>  filter the board to one category
//   #q=<text>         filter the board by name or slug
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;

  var rows = DATA.rows || [];
  var live = DATA.live || [];
  var watchlist = {};
  (DATA.watchlist_slugs || []).forEach(function (s) { watchlist[s] = true; });

  var state = {
    q: '', chain: 'all', category: 'all', watchlistOnly: false,
    tab: 'board', sort: 'rank', dir: 1, selected: null,
  };

  // ---- formatting -------------------------------------------------------
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }
  function fmtUsdFull(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return days + 'd';
  }

  // ---- tiny DOM helpers --------------------------------------------------
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function numCell(value) {
    var td = el('td', 'num');
    td.textContent = value;
    return td;
  }

  // ---- header chips, footer, multiples ------------------------------------
  function renderMeta() {
    var chips = document.getElementById('chips');
    var items = [
      ['Snapshot', DATA.as_of],
      ['Watchlist', DATA.watchlist_size + ' protocols'],
      ['Board', DATA.board_size + ' rows'],
      ['Early finds', DATA.early_size + ' below the floor'],
      ['Global multiple', '×' + DATA.global_multiple],
      ['Model', DATA.model_version],
    ];
    items.forEach(function (pair) {
      var chip = el('span', 'chip');
      chip.appendChild(el('span', null, pair[0] + ': '));
      chip.appendChild(el('b', null, String(pair[1])));
      chips.appendChild(chip);
    });
    document.getElementById('asof').textContent = DATA.as_of;
    document.getElementById('floor').textContent = fmtUsdFull(DATA.floor_usd);
    document.getElementById('modelver').textContent = DATA.model_version;

    var tbody = document.querySelector('#multiples tbody');
    Object.keys(DATA.multiples || {})
      .sort()
      .forEach(function (cat) {
        var m = DATA.multiples[cat];
        var tr = el('tr');
        tr.appendChild(el('td', null, cat));
        var tdMult = el('td', 'num', '×' + m.multiple.toFixed(4));
        tr.appendChild(tdMult);
        tr.appendChild(el('td', 'num', String(m.sample)));
        tbody.appendChild(tr);
      });
    var tr = el('tr');
    tr.appendChild(el('td', null, 'Global (fallback)'));
    tr.appendChild(el('td', 'num', '×' + DATA.global_multiple.toFixed(4)));
    tr.appendChild(el('td', 'num', 'all token protocols'));
    tbody.appendChild(tr);
  }

  // ---- filter controls -----------------------------------------------------
  function fillSelects() {
    var chainSel = document.getElementById('chain');
    var catSel = document.getElementById('category');
    var chains = {};
    var cats = {};
    rows.forEach(function (r) {
      (r.chains || []).forEach(function (c) { chains[c] = true; });
      if (r.category) cats[r.category] = true;
    });
    Object.keys(chains).sort().forEach(function (c) {
      chainSel.appendChild(el('option', null, c)).value = c;
    });
    Object.keys(cats).sort().forEach(function (c) {
      catSel.appendChild(el('option', null, c)).value = c;
    });
  }

  // ---- filtering and sorting ----------------------------------------------
  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (state.watchlistOnly && !watchlist[r.slug]) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) === -1) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (q && (r.name.toLowerCase().indexOf(q) === -1 && r.slug.toLowerCase().indexOf(q) === -1)) return false;
      return true;
    });
    var key = state.sort;
    var dir = state.dir;
    function val(r) {
      if (key === 'chains') return (r.chains || [])[0] || '';
      if (key === 'name') return r.name.toLowerCase();
      if (key === 'category') return (r.category || '').toLowerCase();
      return r[key];
    }
    out.sort(function (a, b) {
      var va = val(a);
      var vb = val(b);
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === 'string') return va < vb ? -dir : va > vb ? dir : 0;
      return (va - vb) * dir;
    });
    return out;
  }

  // ---- board table ----------------------------------------------------------
  function renderBoard() {
    var tbody = document.querySelector('#board tbody');
    tbody.innerHTML = '';
    var list = filteredRows();
    list.forEach(function (r) {
      var tr = el('tr');
      if (state.selected === r.slug) tr.className = 'selected';
      var rankTd = el('td');
      var badge = el('span', 'rank-badge' + (r.rank <= 10 ? ' top' : ''), String(r.rank));
      rankTd.appendChild(badge);
      tr.appendChild(rankTd);
      var nameTd = el('td', 'name');
      nameTd.appendChild(el('span', null, r.name));
      nameTd.appendChild(el('span', 'slug', r.slug));
      tr.appendChild(nameTd);
      var catTd = el('td');
      catTd.appendChild(el('span', 'tag', r.category || 'Uncategorized'));
      if (watchlist[r.slug]) catTd.appendChild(el('span', 'tag watch', 'watchlist'));
      tr.appendChild(catTd);
      var chainTd = el('td');
      (r.chains || []).slice(0, 2).forEach(function (c) {
        chainTd.appendChild(el('span', 'tag', c));
      });
      if ((r.chains || []).length > 2) chainTd.appendChild(el('span', 'tag', '+' + (r.chains.length - 2)));
      tr.appendChild(chainTd);
      tr.appendChild(numCell(fmtUsd(r.tvl_usd)));
      var pctTd = numCell(fmtPct(r.change_7d));
      if (r.change_7d !== null && r.change_7d !== undefined) {
        pctTd.className = 'num ' + (r.change_7d >= 0 ? 'pos' : 'neg');
      }
      tr.appendChild(pctTd);
      var impTd = numCell(fmtUsd(r.implied_value_usd));
      impTd.style.fontWeight = '700';
      tr.appendChild(impTd);
      tr.appendChild(numCell('×' + r.base_multiple.toFixed(2)));
      tr.appendChild(numCell(fmtAge(r.age_days)));
      tr.addEventListener('click', function () { selectRow(r.slug); });
      tbody.appendChild(tr);
    });
    document.getElementById('count').textContent =
      'Showing ' + list.length + ' of ' + rows.length + ' rows · ' +
      rows.filter(function (r) { return watchlist[r.slug]; }).length + ' on the watchlist · ' +
      'click a row for its model breakdown and farm plan.';
    document.querySelectorAll('#board thead th').forEach(function (th) {
      th.classList.toggle('sorted', th.getAttribute('data-sort') === state.sort);
    });
  }

  // ---- live table ------------------------------------------------------------
  function renderLive() {
    var tbody = document.querySelector('#live tbody');
    tbody.innerHTML = '';
    live.forEach(function (r) {
      var tr = el('tr');
      var nameTd = el('td', 'name');
      nameTd.appendChild(el('span', null, r.name));
      nameTd.appendChild(el('span', 'slug', r.slug));
      tr.appendChild(nameTd);
      tr.appendChild(el('td', null, r.category || 'Uncategorized'));
      var chainTd = el('td');
      (r.chains || []).slice(0, 3).forEach(function (c) {
        chainTd.appendChild(el('span', 'tag', c));
      });
      tr.appendChild(chainTd);
      tr.appendChild(numCell(fmtUsd(r.tvl_usd)));
      var mcTd = numCell(fmtUsd(r.mcap_usd));
      mcTd.style.fontWeight = '700';
      tr.appendChild(mcTd);
      var ratio = r.mcap_usd && r.tvl_usd ? r.mcap_usd / r.tvl_usd : null;
      tr.appendChild(numCell(ratio === null ? 'n/a' : '×' + ratio.toFixed(2)));
      var pctTd = numCell(fmtPct(r.change_7d));
      if (r.change_7d !== null && r.change_7d !== undefined) {
        pctTd.className = 'num ' + (r.change_7d >= 0 ? 'pos' : 'neg');
      }
      tr.appendChild(pctTd);
      tbody.appendChild(tr);
    });
  }

  // ---- detail view ------------------------------------------------------------
  function renderDetail() {
    var box = document.getElementById('detail');
    var row = null;
    if (state.selected) {
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].slug === state.selected) { row = rows[i]; break; }
      }
    }
    if (!row) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.innerHTML = '';
    var close = el('button', 'close', 'Close');
    close.type = 'button';
    close.addEventListener('click', function () { selectRow(null); });
    box.appendChild(close);
    box.appendChild(el('h2', null, '#' + row.rank + ' — ' + row.name));
    box.appendChild(el('p', 'sub',
      (row.category || 'Uncategorized') + ' · ' + (row.chains || []).join(', ') +
      ' · listed ' + (row.listed_at || 'unknown date') + ' · ' + fmtAge(row.age_days) + ' old' +
      (watchlist[row.slug] ? ' · on the watchlist' : ' · below the watchlist floor')));
    var grid = el('div', 'model-grid');
    var cells = [
      ['TVL', fmtUsdFull(row.tvl_usd), 'the snapshot figure'],
      ['Category multiple', '×' + row.base_multiple.toFixed(4), 'median FDV/TVL of its category'],
      ['Base value', fmtUsdFull(row.base_usd), 'TVL × multiple'],
      ['7d growth', fmtPct(row.growth_pct) + ' → ×' + row.growth_multiplier.toFixed(2), 'clamped −50% to +100%'],
      ['Maturity', '×' + row.maturity_multiplier.toFixed(2), fmtAge(row.age_days) + ' old'],
    ];
    cells.forEach(function (c) {
      var cell = el('div', 'model-cell');
      cell.appendChild(el('div', 'label', c[0]));
      cell.appendChild(el('div', 'value', c[1]));
      cell.appendChild(el('div', 'formula', c[2]));
      grid.appendChild(cell);
    });
    var total = el('div', 'model-cell total');
    total.appendChild(el('div', 'label', 'Implied value'));
    total.appendChild(el('div', 'value', fmtUsdFull(row.implied_value_usd)));
    total.appendChild(el('div', 'formula', 'base × growth × maturity'));
    grid.appendChild(total);
    box.appendChild(grid);
    var farm = el('div', 'farm');
    farm.appendChild(el('h3', null, 'Farm plan — ' + row.farm_steps.length + ' steps'));
    var ol = el('ol');
    row.farm_steps.forEach(function (step) {
      var li = el('li');
      var costAt = step.indexOf(' Cost: ');
      var timeAt = step.indexOf(' Time: ');
      if (costAt > 0 && timeAt > costAt) {
        li.appendChild(document.createTextNode(step.slice(0, costAt) + ' '));
        var cost = el('span', 'cost', step.slice(costAt + 1, timeAt));
        li.appendChild(cost);
        li.appendChild(document.createTextNode(' ' + step.slice(timeAt + 1)));
      } else {
        li.textContent = step;
      }
      ol.appendChild(li);
    });
    farm.appendChild(ol);
    box.appendChild(farm);
  }

  // ---- tabs, selection, hash ---------------------------------------------------
  function selectRow(slug) {
    state.selected = slug;
    renderBoard();
    renderDetail();
    if (slug) {
      var row = null;
      rows.forEach(function (r) { if (r.slug === slug) row = r; });
      if (row) {
        var box = document.getElementById('detail');
        box.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function setTab(tab) {
    state.tab = tab;
    document.getElementById('tab-board').classList.toggle('active', tab === 'board');
    document.getElementById('tab-live').classList.toggle('active', tab === 'live');
    document.querySelector('.board-wrap').hidden = tab !== 'board';
    document.getElementById('live-wrap').hidden = tab !== 'live';
    document.querySelector('.filters').style.visibility = tab === 'board' ? 'visible' : 'hidden';
    if (tab === 'live') { state.selected = null; renderDetail(); }
  }

  function applyHash() {
    var hash = (window.location.hash || '').replace(/^#/, '');
    // A new hash is a new view: clear the old selection and filters first.
    state.selected = null;
    state.q = '';
    state.chain = 'all';
    state.category = 'all';
    document.getElementById('q').value = '';
    document.getElementById('chain').value = 'all';
    document.getElementById('category').value = 'all';
    if (!hash) return;
    hash.split('&').forEach(function (part) {
      var kv = part.split('=');
      var k = decodeURIComponent(kv[0] || '');
      var v = decodeURIComponent(kv[1] || '');
      if (k === 'detail' && v) {
        state.selected = v;
        document.getElementById('method').open = false;
      } else if (k === 'chain' && v) {
        state.chain = v;
        document.getElementById('chain').value = v;
      } else if (k === 'category' && v) {
        state.category = v;
        document.getElementById('category').value = v;
      } else if (k === 'q' && v) {
        state.q = v;
        document.getElementById('q').value = v;
      } else if (k === 'tab' && (v === 'live' || v === 'board')) {
        setTab(v);
      }
    });
  }

  function bind() {
    document.getElementById('q').addEventListener('input', function (e) {
      state.q = e.target.value;
      renderBoard();
    });
    document.getElementById('chain').addEventListener('change', function (e) {
      state.chain = e.target.value;
      renderBoard();
    });
    document.getElementById('category').addEventListener('change', function (e) {
      state.category = e.target.value;
      renderBoard();
    });
    document.getElementById('watchlist-only').addEventListener('change', function (e) {
      state.watchlistOnly = e.target.checked;
      renderBoard();
    });
    document.getElementById('tab-board').addEventListener('click', function () { setTab('board'); });
    document.getElementById('tab-live').addEventListener('click', function () { setTab('live'); });
    document.querySelectorAll('#board thead th').forEach(function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        if (state.sort === key) {
          state.dir = -state.dir;
        } else {
          state.sort = key;
          state.dir = key === 'name' || key === 'category' || key === 'chains' ? 1 : -1;
        }
        renderBoard();
      });
    });
    window.addEventListener('hashchange', function () {
      applyHash();
      renderBoard();
      renderDetail();
    });
  }

  renderMeta();
  fillSelects();
  bind();
  applyHash();
  renderBoard();
  renderLive();
  renderDetail();
})();
