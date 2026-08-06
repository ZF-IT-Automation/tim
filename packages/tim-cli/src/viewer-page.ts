// Self-contained viewer page: no CDN, no external font, no external script.
// Everything the browser needs is in this string, so the viewer works
// offline and cannot leak the tree to a third party.
// The inline script deliberately avoids template literals — this file is
// itself a TS template literal.

export const VIEWER_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TIM viewer</title>
<style>
  :root {
    --bg: #14161a; --panel: #1b1e24; --line: #2a2f38; --fg: #e6e8ec;
    --dim: #9aa3b2; --accent: #6fb2ff; --warn: #f0a04b; --secret: #e06c75;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f7f9; --panel: #ffffff; --line: #dde1e7; --fg: #1c2027;
      --dim: #5d6675; --accent: #1a6fd4; --warn: #a35c11; --secret: #b3261e;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    height: 100vh; display: flex; flex-direction: column;
  }
  header {
    padding: 8px 12px; border-bottom: 1px solid var(--line); background: var(--panel);
    display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  }
  header h1 { font-size: 13px; margin: 0; letter-spacing: .06em; text-transform: uppercase; }
  header .meta { color: var(--dim); }
  input {
    background: var(--bg); color: var(--fg); border: 1px solid var(--line);
    border-radius: 3px; padding: 3px 6px; font: inherit; min-width: 220px;
  }
  button {
    background: var(--bg); color: var(--fg); border: 1px solid var(--line);
    border-radius: 3px; padding: 3px 8px; font: inherit; cursor: pointer;
  }
  button:hover { border-color: var(--accent); color: var(--accent); }
  main { flex: 1; display: flex; min-height: 0; }
  #tree { width: 55%; overflow: auto; padding: 8px 12px; border-right: 1px solid var(--line); }
  #inspector { flex: 1; overflow: auto; padding: 12px; background: var(--panel); }
  .kids { margin-left: 14px; border-left: 1px dotted var(--line); padding-left: 8px; }
  .row { display: flex; align-items: baseline; gap: 6px; padding: 1px 3px; border-radius: 3px; cursor: default; }
  .row:hover { background: rgba(127,127,127,.12); }
  .row.sel { background: rgba(111,178,255,.18); outline: 1px solid var(--accent); }
  .caret { width: 12px; color: var(--dim); cursor: pointer; user-select: none; flex: none; }
  .caret.leaf { opacity: .25; cursor: default; }
  .title { cursor: pointer; white-space: pre-wrap; }
  .title:hover { text-decoration: underline; }
  .b {
    font-size: 11px; padding: 0 4px; border: 1px solid var(--line);
    border-radius: 3px; color: var(--dim); flex: none;
  }
  .b.kind { color: var(--accent); border-color: var(--accent); }
  .b.rd { color: var(--warn); border-color: var(--warn); }
  .b.secret { color: var(--secret); border-color: var(--secret); }
  .b.hidden { color: var(--secret); border-color: var(--secret); }
  h2 { font-size: 14px; margin: 0 0 4px; }
  .k { color: var(--dim); }
  pre {
    background: var(--bg); border: 1px solid var(--line); border-radius: 3px;
    padding: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
    margin: 4px 0 12px;
  }
  table { border-collapse: collapse; margin-bottom: 12px; }
  td { padding: 1px 10px 1px 0; vertical-align: top; }
  .err { color: var(--secret); }
  .empty { color: var(--dim); padding: 2px 0 2px 18px; }
</style>
</head>
<body>
<header>
  <h1>TIM viewer</h1>
  <span class="meta" id="dbmeta">loading…</span>
  <span style="flex:1"></span>
  <input id="jump" placeholder="entry id or label (P0001)" autocomplete="off">
  <button id="jumpbtn">Go</button>
  <button id="reload">Reload projects</button>
</header>
<main>
  <div id="tree"></div>
  <div id="inspector"><span class="k">Select a node.</span></div>
</main>
<script>
(function () {
  var treeEl = document.getElementById('tree');
  var inspEl = document.getElementById('inspector');
  var rows = {};      // entry id -> row element
  var boxes = {};     // entry id -> children container
  var selected = null;

  function api(path) {
    return fetch(path, { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + r.status);
        return body;
      });
    });
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function badge(row, text, cls) {
    row.appendChild(el('span', 'b ' + (cls || ''), text));
  }

  function decorate(row, n) {
    if (n.kind) badge(row, n.kind, 'kind');
    if (n.label) badge(row, n.label);
    if (n.type && n.type !== n.kind) badge(row, 'type=' + n.type);
    if (n.taskStatus) badge(row, 'status=' + n.taskStatus);
    // render_depth is DISPLAYED, never obeyed: nodes with 0 stay visible.
    if (n.renderDepth !== null && n.renderDepth !== undefined) {
      badge(row, 'render_depth=' + n.renderDepth, 'rd');
    }
    if (n.seq !== null && n.seq !== undefined) badge(row, 'seq=' + n.seq);
    if (n.batchIndex !== null && n.batchIndex !== undefined) badge(row, 'batch=' + n.batchIndex);
    if (n.secret) badge(row, n.redacted ? 'secret (redacted)' : 'secret', 'secret');
    if (n.childCount) badge(row, n.childCount + ' children');
    if (n.hiddenChildCount) badge(row, '+' + n.hiddenChildCount + ' deleted', 'hidden');
    if (n.contentChars) badge(row, n.contentChars + ' chars');
  }

  function makeRow(n, container) {
    var wrap = el('div');
    var row = el('div', 'row');
    var caret = el('span', 'caret' + (n.childCount ? '' : ' leaf'), n.childCount ? '+' : '·');
    var kids = el('div', 'kids');
    kids.style.display = 'none';

    caret.onclick = function () {
      if (!n.childCount) return;
      if (kids.style.display === 'none') {
        kids.style.display = '';
        caret.textContent = '−';
        if (!kids.dataset.loaded) loadChildren(n.id, kids);
      } else {
        kids.style.display = 'none';
        caret.textContent = '+';
      }
    };

    var title = el('span', 'title', n.title || '(untitled)');
    title.onclick = function () { select(n.id); };

    row.appendChild(caret);
    row.appendChild(title);
    decorate(row, n);
    wrap.appendChild(row);
    wrap.appendChild(kids);
    container.appendChild(wrap);

    rows[n.id] = row;
    boxes[n.id] = { box: kids, caret: caret };
    return kids;
  }

  function loadChildren(id, kids) {
    kids.dataset.loaded = '1';
    kids.appendChild(el('div', 'empty', 'loading…'));
    return api('/api/children?id=' + encodeURIComponent(id)).then(function (data) {
      kids.textContent = '';
      if (!data.children.length) kids.appendChild(el('div', 'empty', '(no children)'));
      // Every child is rendered — no cap, no budget, no render_depth skip.
      data.children.forEach(function (c) { makeRow(c, kids); });
      return data;
    }).catch(function (e) {
      kids.textContent = '';
      kids.appendChild(el('div', 'empty err', e.message));
    });
  }

  function expand(id) {
    var entry = boxes[id];
    if (!entry) return Promise.resolve();
    if (entry.box.style.display === 'none') {
      entry.box.style.display = '';
      entry.caret.textContent = '−';
    }
    if (entry.box.dataset.loaded) return Promise.resolve();
    return loadChildren(id, entry.box);
  }

  function select(id) {
    inspEl.textContent = '';
    inspEl.appendChild(el('div', 'k', 'loading…'));
    return api('/api/node?id=' + encodeURIComponent(id)).then(function (data) {
      var n = data.node;
      if (selected && rows[selected]) rows[selected].classList.remove('sel');
      selected = n.id;
      if (rows[n.id]) {
        rows[n.id].classList.add('sel');
        rows[n.id].scrollIntoView({ block: 'nearest' });
      }
      renderInspector(n);
      return n;
    }).catch(function (e) {
      inspEl.textContent = '';
      inspEl.appendChild(el('div', 'err', e.message));
    });
  }

  function kv(table, key, value) {
    var tr = document.createElement('tr');
    tr.appendChild(el('td', 'k', key));
    tr.appendChild(el('td', null, value));
    table.appendChild(tr);
  }

  function renderInspector(n) {
    inspEl.textContent = '';
    inspEl.appendChild(el('h2', null, n.title || '(untitled)'));

    var crumbs = el('div', 'k');
    n.path.forEach(function (c, i) {
      if (i) crumbs.appendChild(document.createTextNode(' / '));
      var link = el('span', 'title', c.label ? c.label + ' ' + c.title : c.title);
      link.onclick = function () { reveal(c.id); };
      crumbs.appendChild(link);
    });
    if (n.path.length) inspEl.appendChild(crumbs);

    var t = document.createElement('table');
    kv(t, 'id', n.id);
    kv(t, 'parent', n.parentId || '(root)');
    kv(t, 'kind', n.kind || '—');
    kv(t, 'label', n.label || '—');
    kv(t, 'render_depth', n.renderDepth === null ? '(unset)' : String(n.renderDepth));
    kv(t, 'children', n.childCount + (n.hiddenChildCount ? ' (+' + n.hiddenChildCount + ' deleted/irrelevant)' : ''));
    kv(t, 'tags', n.tags.length ? n.tags.join(' ') : '—');
    kv(t, 'depth / conf', n.depth + ' / ' + n.confidence);
    kv(t, 'visibility', String(n.visibility));
    kv(t, 'flags', [n.favorite ? 'favorite' : '', n.irrelevant ? 'irrelevant' : '', n.secret ? 'secret' : '']
      .filter(Boolean).join(' ') || '—');
    kv(t, 'created', n.createdAt);
    kv(t, 'updated', n.updatedAt);
    kv(t, 'accessed', n.accessedAt);
    inspEl.appendChild(t);

    inspEl.appendChild(el('div', 'k', 'content (' + n.contentChars + ' chars, untruncated)'));
    inspEl.appendChild(el('pre', null, n.content === null
      ? (n.redacted ? '[secret — redacted; restart with --show-secrets to render]' : '')
      : (n.content || '(empty)')));

    inspEl.appendChild(el('div', 'k', 'metadata'));
    inspEl.appendChild(el('pre', null, JSON.stringify(n.metadata, null, 2)));
  }

  // Expand the whole ancestor chain, then select — used by jump-to-id and
  // by breadcrumb clicks so a node found by id lands in context.
  function reveal(id) {
    return api('/api/node?id=' + encodeURIComponent(id)).then(function (data) {
      var chain = data.node.path.map(function (c) { return c.id; });
      var step = Promise.resolve();
      chain.forEach(function (cid) {
        step = step.then(function () { return expand(cid); });
      });
      return step.then(function () { return select(data.node.id); });
    }).catch(function (e) {
      inspEl.textContent = '';
      inspEl.appendChild(el('div', 'err', e.message));
    });
  }

  function loadProjects() {
    treeEl.textContent = '';
    rows = {}; boxes = {};
    return api('/api/projects').then(function (data) {
      if (!data.projects.length) {
        treeEl.appendChild(el('div', 'empty', 'No entries with metadata.kind="project".'));
        return;
      }
      data.projects.forEach(function (p) { makeRow(p, treeEl); });
    }).catch(function (e) {
      treeEl.appendChild(el('div', 'err', e.message));
    });
  }

  function loadStats() {
    return api('/api/stats').then(function (s) {
      document.getElementById('dbmeta').textContent =
        s.databasePath + ' · ' + (s.readOnly ? 'read-only' : 'READ-WRITE') +
        ' · schema v' + s.schemaVersion +
        ' · ' + s.projectCount + ' projects · ' + s.totalEntries + ' entries · ' +
        s.hiddenEntries + ' deleted/irrelevant · ' + s.secretEntries + ' secret-marked' +
        (s.showSecrets ? ' · SECRETS SHOWN' : ' · secrets redacted');
    });
  }

  document.getElementById('jumpbtn').onclick = function () {
    var v = document.getElementById('jump').value.trim();
    if (v) reveal(v);
  };
  document.getElementById('jump').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('jumpbtn').onclick();
  });
  document.getElementById('reload').onclick = function () { loadStats(); loadProjects(); };

  loadStats();
  loadProjects();
})();
</script>
</body>
</html>
`;
