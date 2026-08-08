"use strict";
// Self-contained viewer page: no CDN, no external font, no external script.
// Everything the browser needs is in this string, so the viewer works
// offline and cannot leak the tree to a third party.
// The inline script deliberately avoids template literals — this file is
// itself a TS template literal.
Object.defineProperty(exports, "__esModule", { value: true });
exports.VIEWER_PAGE = void 0;
exports.VIEWER_PAGE = `<!doctype html>
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
  #right { flex: 1; display: flex; flex-direction: column; min-width: 0; background: var(--panel); }
  #tabs { display: flex; gap: 4px; padding: 6px 12px 0; border-bottom: 1px solid var(--line); }
  #tabs button { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  #tabs button.on { color: var(--accent); border-color: var(--accent); border-bottom-color: var(--panel); }
  .pane { flex: 1; overflow: auto; padding: 12px; }
  .pane[hidden] { display: none; }
  #toolpane { display: flex; gap: 12px; align-items: flex-start; }
  #toollist { width: 190px; flex: none; overflow: auto; }
  #toollist div {
    padding: 2px 4px; border-radius: 3px; cursor: pointer; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  #toollist div:hover { background: rgba(127,127,127,.12); }
  #toollist div.on { background: rgba(111,178,255,.18); color: var(--accent); }
  #toolform { flex: 1; min-width: 0; }
  .field { margin-bottom: 6px; }
  .field label { display: block; color: var(--dim); font-size: 11px; }
  .field input, .field textarea, #simpane input, #simpane select {
    width: 100%; background: var(--bg); color: var(--fg); border: 1px solid var(--line);
    border-radius: 3px; padding: 3px 6px; font: inherit; min-width: 0;
  }
  .field textarea { min-height: 48px; resize: vertical; }
  .req { color: var(--warn); }
  .forced { color: var(--warn); font-size: 11px; margin-bottom: 6px; }
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
  <label class="meta"><input type="checkbox" id="showhidden"> show deleted</label>
  <button id="reload">Reload projects</button>
</header>
<main>
  <div id="tree"></div>
  <div id="right">
    <div id="tabs">
      <button data-pane="inspector" class="on">Node</button>
      <button data-pane="toolpane">Read tools</button>
      <button data-pane="simpane">Session start</button>
    </div>
    <div id="inspector" class="pane"><span class="k">Select a node.</span></div>
    <div id="toolpane" class="pane" hidden>
      <div id="toollist"></div>
      <div id="toolform"></div>
    </div>
    <div id="simpane" class="pane" hidden>
      <div class="field">
        <label for="simproject">project</label>
        <select id="simproject"></select>
      </div>
      <div class="field">
        <label for="simtokens">maxTokens (blank = configured default)</label>
        <input id="simtokens" placeholder="e.g. 700" autocomplete="off">
      </div>
      <div class="field">
        <label for="simsession">sessionId (blank = the project's most recent; the result names it)</label>
        <input id="simsession" placeholder="from tim_resume_list" autocomplete="off">
      </div>
      <div class="field">
        <label for="simorigin">directive origin</label>
        <select id="simorigin">
          <option value="marker">marker (.tim-project)</option>
          <option value="session">session (TIM session metadata)</option>
        </select>
      </div>
      <button id="simrun">Simulate session start</button>
      <div id="simout"></div>
    </div>
  </div>
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

  // Whether the "show deleted" toggle is on. Read live rather than captured:
  // the same predicate decides which children get fetched and whether a row
  // offers a caret at all.
  function showHidden() {
    return document.getElementById('showhidden').checked;
  }

  function expandableCount(n) {
    return n.childCount + (showHidden() ? n.hiddenChildCount : 0);
  }

  function decorate(row, n) {
    if (n.hidden) badge(row, 'deleted', 'hidden');
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
    var open = expandableCount(n);
    var caret = el('span', 'caret' + (open ? '' : ' leaf'), open ? '+' : '·');
    var kids = el('div', 'kids');
    kids.style.display = 'none';

    caret.onclick = function () {
      if (!expandableCount(n)) return;
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
    var q = '/api/children?id=' + encodeURIComponent(id) + (showHidden() ? '&hidden=1' : '');
    return api(q).then(function (data) {
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
    // Clicking a node means "show me this node", even from another tab.
    var nodeTab = document.querySelector('#tabs button[data-pane="inspector"]');
    if (nodeTab && inspEl.hidden) nodeTab.click();
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
      var others = data.otherRoots || [];
      if (!data.projects.length && !others.length) {
        treeEl.appendChild(el('div', 'empty', 'No root entries.'));
        return;
      }
      data.projects.forEach(function (p) { makeRow(p, treeEl); });
      // Parentless non-project entries: reachable from nowhere else, which is
      // exactly why they are worth showing.
      if (others.length) {
        var head = el('div', 'empty', 'other roots (no metadata.kind="project")');
        head.style.paddingTop = '10px';
        treeEl.appendChild(head);
        others.forEach(function (r) { makeRow(r, treeEl); });
      }
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
  // ── Read-tool panel ─────────────────────────────────────────────────────
  // Forms are generated from the JSON Schema the MCP server itself answers
  // ListTools with, so a field can never describe a parameter the server would
  // reject. Values are typed as JSON when the schema says non-string, because
  // "5" and 5 are different arguments and the server checks.

  var toolListEl = document.getElementById('toollist');
  var toolFormEl = document.getElementById('toolform');
  var toolsLoaded = false;

  function schemaOf(tool, key) {
    return (tool.inputSchema.properties || {})[key] || {};
  }

  function isRequired(tool, key) {
    return (tool.inputSchema.required || []).indexOf(key) !== -1;
  }

  function fieldValue(tool, key, raw) {
    var text = raw.trim();
    if (!text) return undefined;
    var spec = schemaOf(tool, key);
    if (spec.type === 'string') return raw;
    // Numbers, booleans, arrays and objects arrive as text; parse so the
    // server sees the type its schema asks for. Unparseable text is passed
    // through unchanged so the server's own error explains the problem.
    try { return JSON.parse(text); } catch (e) { return raw; }
  }

  function renderTool(tool) {
    toolFormEl.textContent = '';
    toolFormEl.appendChild(el('h2', null, tool.name));
    toolFormEl.appendChild(el('div', 'k', tool.description));

    if (tool.forced) {
      toolFormEl.appendChild(el('div', 'forced',
        'the viewer pins ' + JSON.stringify(tool.forced) + ' on this call'));
    }

    var keys = Object.keys(tool.inputSchema.properties || {});
    var inputs = {};
    keys.forEach(function (key) {
      var spec = schemaOf(tool, key);
      if (tool.forced && tool.forced[key] !== undefined) return;
      var wrap = el('div', 'field');
      var label = el('label', null, key + (spec.type ? ' : ' + spec.type : ''));
      if (isRequired(tool, key)) label.appendChild(el('span', 'req', ' *'));
      if (spec.description) label.appendChild(el('span', 'k', ' — ' + spec.description));
      var input = el(spec.type === 'object' || spec.type === 'array' ? 'textarea' : 'input');
      if (spec.default !== undefined) input.placeholder = 'default: ' + JSON.stringify(spec.default);
      wrap.appendChild(label);
      wrap.appendChild(input);
      toolFormEl.appendChild(wrap);
      inputs[key] = input;
    });
    if (!keys.length) toolFormEl.appendChild(el('div', 'k', '(no parameters)'));

    var run = el('button', null, 'Call ' + tool.name);
    var out = el('div');
    run.onclick = function () {
      var args = {};
      Object.keys(inputs).forEach(function (key) {
        var v = fieldValue(tool, key, inputs[key].value);
        if (v !== undefined) args[key] = v;
      });
      out.textContent = '';
      out.appendChild(el('div', 'k', 'calling…'));
      api('/api/tool?name=' + encodeURIComponent(tool.name) +
          '&args=' + encodeURIComponent(JSON.stringify(args)))
        .then(function (data) {
          out.textContent = '';
          out.appendChild(el('pre', null, data.text || '(empty response)'));
        })
        .catch(function (e) {
          out.textContent = '';
          out.appendChild(el('div', 'err', e.message));
        });
    };
    toolFormEl.appendChild(run);
    toolFormEl.appendChild(out);
  }

  function loadTools() {
    if (toolsLoaded) return Promise.resolve();
    toolsLoaded = true;
    return api('/api/tools').then(function (data) {
      toolListEl.textContent = '';
      data.tools.forEach(function (tool) {
        var item = el('div', null, tool.name);
        item.onclick = function () {
          Array.prototype.forEach.call(toolListEl.children, function (c) { c.className = ''; });
          item.className = 'on';
          renderTool(tool);
        };
        toolListEl.appendChild(item);
      });
    }).catch(function (e) {
      toolsLoaded = false;
      toolListEl.appendChild(el('div', 'err', e.message));
    });
  }

  // ── Session-start simulation ────────────────────────────────────────────
  // Read-only by construction: tim_preview_briefing assembles the text a start
  // hook would emit without creating a session, writing a marker, or running
  // configured hooks.

  function loadSimProjects() {
    var sel = document.getElementById('simproject');
    if (sel.options.length) return Promise.resolve();
    return api('/api/projects').then(function (data) {
      data.projects.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.label || p.id;
        o.textContent = (p.label ? p.label + ' — ' : '') + p.title;
        sel.appendChild(o);
      });
    });
  }

  document.getElementById('simrun').onclick = function () {
    var out = document.getElementById('simout');
    var args = {
      project: document.getElementById('simproject').value,
      origin: document.getElementById('simorigin').value,
    };
    var tokens = document.getElementById('simtokens').value.trim();
    if (tokens) args.maxTokens = Number(tokens);
    var session = document.getElementById('simsession').value.trim();
    if (session) args.sessionId = session;

    out.textContent = '';
    out.appendChild(el('div', 'k', 'simulating…'));
    api('/api/tool?name=tim_preview_briefing&args=' + encodeURIComponent(JSON.stringify(args)))
      .then(function (data) {
        out.textContent = '';
        out.appendChild(el('pre', null, data.text));
      })
      .catch(function (e) {
        out.textContent = '';
        out.appendChild(el('div', 'err', e.message));
      });
  };

  Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (btn) {
    btn.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
        b.className = b === btn ? 'on' : '';
      });
      Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (p) {
        p.hidden = p.id !== btn.dataset.pane;
      });
      if (btn.dataset.pane === 'toolpane') loadTools();
      if (btn.dataset.pane === 'simpane') loadSimProjects();
    };
  });

  document.getElementById('reload').onclick = function () { loadStats(); loadProjects(); };
  // Toggling rebuilds the tree: already-loaded child lists were fetched under
  // the old filter, so patching them in place would leave a mixed view.
  document.getElementById('showhidden').onchange = function () { loadProjects(); };

  loadStats();
  loadProjects();
})();
</script>
</body>
</html>
`;
//# sourceMappingURL=viewer-page.js.map