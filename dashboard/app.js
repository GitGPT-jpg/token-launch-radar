// Token Launch Radar dashboard. Reads window.RADAR (written beside this
// page by main.ts) and renders the board, the filters, the detail view and
// the live-token comparison. No network: every byte shown is in data.js.
//
// Hash routes, so a view can be linked and screenshotted directly:
//   #detail=<slug>    open one protocol's detail view
//   #chain=<chain>    filter the board to one chain
//   #category=<name>  filter the board to one category
//   #watchlist=1      show the watchlist only
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
  function fmtOdds(o) {
    if (o === null || o === undefined || !isFinite(o)) return 'n/a';
    return Math.round(o * 100) + '%';
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

  // ---- header chips, footer, method tables --------------------------------
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
    // The board answers its own checks on the cover: rows, ranks, watchlist
    // coverage and a falling implied value, all computed from the data shown.
    var checksOk = rows.length > 0 &&
      rows[0].rank === 1 && rows[rows.length - 1].rank === rows.length &&
      rows.every(function (r, i) { return i === 0 || r.implied_value_usd <= rows[i - 1].implied_value_usd; }) &&
      rows.filter(function (r) { return watchlist[r.slug]; }).length === DATA.watchlist_size;
    if (checksOk) {
      items.push(['Board checks', 'all pass · ' + rows.length + ' rows · watchlist ' + DATA.watchlist_size + '/' + DATA.watchlist_size + ' · ranks 1–' + rows.length]);
    }
    items.forEach(function (pair) {
      var chip = el('span', 'chip');
      chip.appendChild(el('span', null, pair[0] + ': '));
      chip.appendChild(el('b', null, String(pair[1])));
      chips.appendChild(chip);
    });
    document.getElementById('asof').textContent = DATA.as_of;
    document.getElementById('floor').textContent = fmtUsdFull(DATA.floor_usd);
    document.getElementById('modelver').textContent = DATA.model_version;

    var fit = (DATA.fit || {}).params || {};
    function setFit(id, v) {
      var n = document.getElementById(id);
      if (n) n.textContent = String(v);
    }
    setFit('fit-k', fit.shrink_k);
    setFit('fit-s', fit.size_exponent);
    setFit('fit-w', fit.growth_weight);
    setFit('fit-m', fit.maturity_floor);

    var tbody = document.querySelector('#multiples tbody');
    Object.keys(DATA.multiples || {})
      .sort()
      .forEach(function (cat) {
        var m = DATA.multiples[cat];
        var tr = el('tr');
        tr.appendChild(el('td', null, cat));
        var tdMult = el('td', 'num', '×' + m.multiple.toFixed(4));
        if (m.clamped) tdMult.textContent += ' *';
        tr.appendChild(tdMult);
        tr.appendChild(el('td', 'num', '×' + m.raw_median.toFixed(4)));
        tr.appendChild(el('td', 'num', String(m.sample)));
        tbody.appendChild(tr);
      });
    var tr = el('tr');
    tr.appendChild(el('td', null, 'Global (fallback)'));
    tr.appendChild(el('td', 'num', '×' + DATA.global_multiple.toFixed(4)));
    tr.appendChild(el('td', 'num', '×' + DATA.global_multiple.toFixed(4)));
    tr.appendChild(el('td', 'num', 'all token protocols'));
    tbody.appendChild(tr);

    var vbody = document.querySelector('#validation tbody');
    ((DATA.fit || {}).folds || []).forEach(function (f) {
      [['Fitted model', f.fitted], ['Previous model', f.v2]].forEach(function (pair) {
        var r = el('tr');
        r.appendChild(el('td', null, 'Fold ' + f.fold));
        r.appendChild(el('td', 'num', String(f.n_valid)));
        r.appendChild(el('td', null, pair[0]));
        r.appendChild(el('td', 'num', pair[1].median_abs_log_err.toFixed(3)));
        r.appendChild(el('td', 'num', pair[1].rmse_log.toFixed(3)));
        r.appendChild(el('td', 'num', Math.round(pair[1].within_2x * 100) + '%'));
        vbody.appendChild(r);
      });
    });

    // Walk-forward in time: knobs chosen on protocols listed before the
    // cutoff, tested on the ones listed after.
    var wf = DATA.walk_forward;
    if (wf) {
      var wbody = document.querySelector('#walkforward tbody');
      [
        ['Knobs chosen before ' + wf.cutoff + ' (' + wf.n_train + ' train, ' + wf.n_test + ' test)', wf.blind],
        ["This board's knobs", wf.fitted],
        ['Previous model', wf.v2],
      ].forEach(function (pair) {
        var r = el('tr');
        r.appendChild(el('td', null, pair[0]));
        r.appendChild(el('td', 'num', pair[1].median_abs_log_err.toFixed(3)));
        r.appendChild(el('td', 'num', pair[1].rmse_log.toFixed(3)));
        r.appendChild(el('td', 'num', Math.round(pair[1].within_2x * 100) + '%'));
        wbody.appendChild(r);
      });
    }

    // Ranking stability: how much of the order survives dropping one term.
    var sbody = document.querySelector('#stability tbody');
    (DATA.stability || []).forEach(function (s) {
      var r = el('tr');
      r.appendChild(el('td', null, 'Without ' + s.term));
      r.appendChild(el('td', 'num', s.top10_overlap + ' / 10'));
      r.appendChild(el('td', 'num', s.top40_overlap + ' / 40'));
      r.appendChild(el('td', 'num', s.spearman.toFixed(3)));
      sbody.appendChild(r);
    });

    var obody = document.querySelector('#odds-age tbody');
    var odds = DATA.odds || {};
    Object.keys(odds.byAgeBucket || {}).forEach(function (label) {
      var b = odds.byAgeBucket[label];
      var r = el('tr');
      r.appendChild(el('td', null, label));
      r.appendChild(el('td', 'num', String(b.tokened)));
      r.appendChild(el('td', 'num', String(b.total)));
      r.appendChild(el('td', 'num', Math.round(b.rate * 100) + '%'));
      obody.appendChild(r);
    });
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
      if (key === 'confidence') return { low: 1, medium: 2, high: 3 }[r.confidence] || 0;
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
      (r.chains || []).slice(0, 1).forEach(function (c) {
        chainTd.appendChild(el('span', 'tag', c));
      });
      if ((r.chains || []).length > 1) chainTd.appendChild(el('span', 'tag', '+' + (r.chains.length - 1)));
      tr.appendChild(chainTd);
      tr.appendChild(numCell(fmtUsd(r.tvl_usd)));
      var pctTd = numCell(fmtPct(r.change_7d));
      if (r.change_7d !== null && r.change_7d !== undefined) {
        pctTd.className = 'num ' + (r.change_7d >= 0 ? 'pos' : 'neg');
      }
      tr.appendChild(pctTd);
      // The value as an equation per row: the three multipliers that turn the
      // base value into the implied value, on a second line under the value
      // itself. Growth gets three decimals: at the fitted weight it sits near
      // 1.00, and two decimals would round it to ×1.00 and hide that the term
      // moves the value at all. The order is size · growth · maturity.
      var impTd = el('td', 'num');
      var impVal = el('div', null, fmtUsd(r.implied_value_usd));
      impVal.style.fontWeight = '700';
      impTd.appendChild(impVal);
      var fac = el('div', 'factors', '×' + r.size_multiplier.toFixed(2) + ' · ×' + r.growth_multiplier.toFixed(3) + ' · ×' + r.maturity_multiplier.toFixed(2));
      impTd.appendChild(fac);
      tr.appendChild(impTd);
      tr.appendChild(numCell('×' + r.base_multiple.toFixed(2)));
      tr.appendChild(numCell(fmtOdds(r.token_odds)));
      var confTd = el('td');
      confTd.appendChild(el('span', 'conf conf-' + r.confidence, r.confidence));
      tr.appendChild(confTd);
      tr.addEventListener('click', function () { selectRow(r.slug); });
      tbody.appendChild(tr);
    });
    document.getElementById('count').textContent =
      'Showing ' + list.length + ' of ' + rows.length + ' rows · ' +
      rows.filter(function (r) { return watchlist[r.slug]; }).length + ' on the watchlist · ' +
      'click a row for its model breakdown, token odds and farm plan. ' +
      'The small line under each implied value is its equation: size · growth · maturity.';
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
      ['Category multiple', '×' + row.base_multiple.toFixed(4), 'shrunk median market-cap/TVL of its category'],
      ['Base value', fmtUsdFull(row.base_usd), 'TVL × multiple'],
      ['Size', '×' + row.size_multiplier.toFixed(2), 'TVL against the $100M reference'],
      // Three decimals for the growth multiplier: at the fitted weight it
      // sits near 1.00, and two decimals would round it to ×1.00 and hide
      // that the term moves the value at all.
      ['7d growth', fmtPct(row.growth_pct) + ' → ×' + row.growth_multiplier.toFixed(3), 'clamped −50% to +100%'],
      ['Maturity', '×' + row.maturity_multiplier.toFixed(2), fmtAge(row.age_days) + ' old'],
      ['Token odds', fmtOdds(row.token_odds), 'category ' + Math.round(row.odds_category_rate * 100) + '% · age ' + row.odds_age_bucket + ' ' + Math.round(row.odds_age_rate * 100) + '%'],
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
    total.appendChild(el('div', 'formula', 'base × size × growth × maturity'));
    grid.appendChild(total);
    box.appendChild(grid);

    var strip = el('div', 'integrity conf-' + row.confidence);
    var level = el('span', 'integrity-level', 'Confidence: ' + row.confidence);
    strip.appendChild(level);
    if (row.confidence_flags && row.confidence_flags.length > 0) {
      var ul = el('ul', 'integrity-flags');
      row.confidence_flags.forEach(function (f) {
        ul.appendChild(el('li', null, f));
      });
      strip.appendChild(ul);
    } else {
      strip.appendChild(el('p', 'integrity-none', 'No flags: the category counted enough token protocols, the growth and listing date were reported, and the multiple stayed inside its clamp.'));
    }
    box.appendChild(strip);

    var farm = el('div', 'farm');
    farm.appendChild(el('h3', null, 'Farm plan — ' + row.farm_steps.length + ' steps'));
    farm.appendChild(el('p', 'verdict', row.farm_verdict));
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
    state.watchlistOnly = false;
    document.getElementById('q').value = '';
    document.getElementById('chain').value = 'all';
    document.getElementById('category').value = 'all';
    document.getElementById('watchlist-only').checked = false;
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
      } else if (k === 'watchlist' && v === '1') {
        state.watchlistOnly = true;
        document.getElementById('watchlist-only').checked = true;
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
