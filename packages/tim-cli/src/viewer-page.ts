// Self-contained viewer page: no CDN, no external font, no external script.
// Everything the browser needs is in this string, so the viewer works offline
// and cannot leak the tree to a third party.
export const VIEWER_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TIM viewer</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f5f7fa; --panel: #fff; --panel2: #edf1f6; --line: #d5dce5;
    --fg: #202832; --dim: #586575; --accent: #1769c2; --warn: #8a4b00;
    --danger: #a32020; --focus: #1769c2;
    --kind-project: #3478c9; --kind-section: #7693b5; --kind-task: #33855b;
    --kind-bug: #c04444; --kind-idea: #8e62b8; --kind-decision: #a56b23;
    --kind-learning: #218b94; --kind-log: #79828d; --kind-tag: #bd7d18;
    --kind-other: #69768a;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #12161c; --panel: #1b2129; --panel2: #252d38; --line: #343e4b;
      --fg: #e6ebf2; --dim: #a6b1bf; --accent: #79b9ff; --warn: #f0b35d;
      --danger: #ff8585; --focus: #86c2ff;
      --kind-project: #73b4ff; --kind-section: #9bacc2; --kind-task: #68cf91;
      --kind-bug: #ff7979; --kind-idea: #c29aef; --kind-decision: #e2aa66;
      --kind-learning: #63cbd2; --kind-log: #a4afbb; --kind-tag: #f0bb5d;
      --kind-other: #aab6c8;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column;
    background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif;
  }
  button, input, select, textarea { font: inherit; color: inherit; }
  button, select, input, textarea {
    border: 1px solid var(--line); border-radius: 6px; background: var(--bg);
  }
  button { padding: 6px 10px; cursor: pointer; }
  button:hover { border-color: var(--accent); color: var(--accent); }
  button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible,
  [tabindex="0"]:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
  input, select, textarea { padding: 7px 9px; min-width: 0; }
  header {
    display: flex; flex-wrap: wrap; gap: 9px; align-items: center; padding: 9px 14px;
    border-bottom: 1px solid var(--line); background: var(--panel); z-index: 2;
  }
  header h1 { margin: 0 8px 0 0; font-size: 17px; letter-spacing: -.02em; white-space: nowrap; }
  #projectpicker { width: min(230px, 22vw); }
  #jump { flex: 1; min-width: 180px; max-width: 380px; }
  #viewtoggle { display: flex; gap: 0; }
  #viewtoggle button:first-child { border-radius: 6px 0 0 6px; }
  #viewtoggle button:last-child { border-radius: 0 6px 6px 0; margin-left: -1px; }
  #viewtoggle button.on { color: var(--accent); border-color: var(--accent); background: var(--panel2); }
  #stats { color: var(--dim); white-space: nowrap; font-size: 12px; }
  #movebar { color: var(--warn); font-size: 12px; }
  main { display: grid; grid-template-columns: 224px minmax(0, 1fr) 360px; flex: 1; min-height: 0; }
  aside { min-width: 0; overflow: auto; border-right: 1px solid var(--line); background: var(--panel); }
  .sidehead { padding: 12px 14px 7px; color: var(--dim); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; }
  #projectlist { padding: 0 8px 14px; }
  .project-item {
    width: 100%; display: flex; gap: 9px; align-items: flex-start; text-align: left;
    border-color: transparent; background: transparent; padding: 8px; margin: 1px 0;
  }
  .project-item:hover { color: var(--fg); background: var(--panel2); }
  .project-item.on { color: var(--accent); background: var(--panel2); border-color: var(--line); }
  .project-copy { min-width: 0; flex: 1; }
  .project-title { display: -webkit-box; overflow: hidden; overflow-wrap: anywhere; font-weight: 600; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .project-sub { display: block; margin-top: 2px; color: var(--dim); font-size: 11px; }
  #workspace { display: flex; min-width: 0; min-height: 0; flex-direction: column; }
  #graphControls {
    display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 8px 12px;
    border-bottom: 1px solid var(--line); background: var(--panel);
  }
  #graphControls[hidden] { display: none; }
  .toggle { display: inline-flex; align-items: center; gap: 5px; color: var(--dim); font-size: 12px; white-space: nowrap; }
  .toggle input { accent-color: var(--accent); }
  #depthwrap { display: inline-flex; align-items: center; gap: 7px; color: var(--dim); font-size: 12px; }
  #graphDepth { width: 116px; padding: 0; }
  #graphCount { margin-left: auto; color: var(--dim); font-size: 12px; }
  #legend { display: flex; gap: 9px; flex-wrap: wrap; padding: 5px 12px; color: var(--dim); font-size: 10px; }
  .legend-item { display: inline-flex; gap: 4px; align-items: center; }
  .swatch { width: 9px; height: 9px; border-radius: 50%; background: var(--swatch); }
  .view { flex: 1; min-height: 0; }
  .view[hidden] { display: none; }
  #tree { overflow: auto; padding: 14px; }
  #board {
    position: relative; display: flex; align-items: flex-start; gap: 38px;
    width: max-content; min-width: 100%; padding: 4px 4px 50px;
  }
  #wires { position: absolute; inset: 0 auto auto 0; pointer-events: none; color: var(--line); overflow: visible; }
  .col { flex: none; width: 252px; display: flex; flex-direction: column; gap: 8px; }
  .nwrap { display: flex; align-items: center; gap: 7px; }
  .node {
    flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid var(--line);
    border-left: 4px solid var(--node-kind, var(--line)); border-radius: 8px;
    background: var(--panel); cursor: pointer; box-shadow: 0 1px 2px #0000000b;
  }
  .node:hover { border-color: var(--accent); }
  .node.open { box-shadow: inset 0 0 0 1px var(--accent); }
  .node.sel { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--panel)); }
  .nmeta { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
  .ntitle { font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .kids { flex: none; color: var(--dim); font-size: 11px; white-space: nowrap; cursor: pointer; }
  .kids:hover { color: var(--accent); text-decoration: underline; }
  .kids.leaf { opacity: .55; cursor: default; }
  .b {
    display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 999px;
    padding: 1px 6px; color: var(--dim); font-size: 10px; line-height: 1.45; white-space: nowrap;
  }
  .b.kind { color: var(--kind-color, var(--accent)); border-color: color-mix(in srgb, var(--kind-color, var(--accent)) 55%, var(--line)); }
  .b.status { color: var(--kind-task); }
  .b.danger, .b.secret, .b.hidden { color: var(--danger); }
  .mono, code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .mono { overflow-wrap: anywhere; }
  .empty { color: var(--dim); padding: 14px; }
  .err { color: var(--danger); padding: 7px 0; }
  #graphView { position: relative; overflow: hidden; background: var(--bg); }
  #graphCanvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
  #graphCanvas.dragging { cursor: grabbing; }
  #graphTip {
    position: absolute; display: none; z-index: 1; max-width: 280px; pointer-events: none;
    padding: 7px 9px; border: 1px solid var(--line); border-radius: 7px;
    color: var(--fg); background: var(--panel); box-shadow: 0 4px 14px #0003; font-size: 12px;
  }
  #graphTip strong { display: block; overflow-wrap: anywhere; }
  #right { min-width: 0; min-height: 0; display: flex; flex-direction: column; border-left: 1px solid var(--line); background: var(--panel); }
  #tabs { display: flex; gap: 4px; padding: 7px 8px 0; border-bottom: 1px solid var(--line); }
  #tabs button { padding: 6px 8px; font-size: 12px; border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  #tabs button.on { color: var(--accent); border-color: var(--accent); border-bottom-color: var(--panel); }
  .pane { flex: 1; overflow: auto; padding: 14px; }
  .pane[hidden] { display: none; }
  #detailTitle { margin: 0 0 7px; font-size: 19px; line-height: 1.25; overflow-wrap: anywhere; }
  #crumbs { margin-bottom: 8px; color: var(--dim); font-size: 12px; overflow-wrap: anywhere; }
  .crumb { border: 0; padding: 0; color: var(--accent); background: transparent; font-size: inherit; }
  #detailBadges { display: flex; gap: 5px; flex-wrap: wrap; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; margin: 5px 0 12px; }
  td { padding: 3px 5px 3px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  td:first-child { width: 92px; color: var(--dim); }
  #content { margin: 5px 0 14px; line-height: 1.6; overflow-wrap: anywhere; }
  #content > :first-child { margin-top: 0; }
  #content h1, #content h2, #content h3 { line-height: 1.3; margin: 15px 0 6px; }
  #content h1 { font-size: 19px; } #content h2 { font-size: 17px; } #content h3 { font-size: 15px; }
  #content p { margin: 7px 0; }
  #content ul, #content ol { margin: 6px 0; padding-left: 22px; }
  #content code { padding: 1px 4px; border-radius: 4px; background: var(--panel2); font-size: .9em; }
  #content pre, pre.raw {
    background: var(--bg); border: 1px solid var(--line); border-radius: 7px;
    padding: 10px; overflow: auto; white-space: pre-wrap; word-break: break-word;
  }
  #content pre code { padding: 0; background: transparent; }
  details { margin: 10px 0; }
  summary { color: var(--dim); cursor: pointer; }
  #actions { border-top: 1px solid var(--line); margin-top: 12px; padding-top: 10px; }
  #actions button { margin: 0 5px 6px 0; }
  #actions .danger { color: var(--danger); border-color: var(--danger); }
  #actions .ask { border: 1px solid var(--warn); border-radius: 7px; padding: 9px; margin-top: 8px; }
  #actions .ask p { margin: 0 0 9px; }
  #toolpane:not([hidden]) { display: flex; gap: 10px; align-items: flex-start; }
  #toollist { width: 124px; flex: none; overflow: auto; }
  #toollist button { display: block; width: 100%; text-align: left; border: 0; background: transparent; padding: 5px; font-size: 11px; }
  #toollist button.on { color: var(--accent); background: var(--panel2); }
  #toolform { flex: 1; min-width: 0; }
  .field { margin: 0 0 8px; }
  .field label { display: block; color: var(--dim); font-size: 11px; }
  .field input, .field textarea, .field select { width: 100%; }
  .field textarea { min-height: 54px; resize: vertical; }
  .req { color: var(--warn); }
  .forced { color: var(--warn); font-size: 11px; margin-bottom: 7px; }
  #simpane select, #simpane input { width: 100%; }
  .small { color: var(--dim); font-size: 11px; }
  body.embed header { padding-top: 6px; padding-bottom: 6px; gap: 7px; }
  body.embed header h1 { font-size: 15px; }
  body.embed #tabs, body.embed #tabs button[data-pane="toolpane"], body.embed #tabs button[data-pane="simpane"] { display: none; }
  @media (max-width: 1050px) {
    main { grid-template-columns: 190px minmax(0, 1fr); }
    #right { position: absolute; right: 0; top: 58px; bottom: 0; width: min(390px, 45vw); box-shadow: -4px 0 18px #0002; }
  }
  @media (max-width: 680px) {
    header { gap: 6px; } header h1 { width: 100%; }
    #projectpicker { flex: 1; width: auto; } #jump { min-width: 130px; }
    main { grid-template-columns: 128px minmax(0, 1fr); }
    #right { top: 104px; width: min(360px, 78vw); }
    .project-item { padding: 6px; } .project-sub { display: none; }
  }
</style>
</head>
<body>
<header>
  <h1>TIM viewer</h1>
  <select id="projectpicker" aria-label="Choose project"><option value="">Choose project</option></select>
  <input id="jump" placeholder="Search title, entry id or label" autocomplete="off" aria-label="Search entries">
  <button id="jumpbtn" type="button">Go</button>
  <div id="viewtoggle" role="group" aria-label="View mode">
    <button id="treebtn" type="button" aria-pressed="true">Tree</button>
    <button id="graphbtn" type="button" aria-pressed="false">Graph</button>
  </div>
  <span id="stats" aria-live="polite">Loading…</span>
  <label class="toggle"><input type="checkbox" id="showhidden"> Deleted</label>
  <span id="movebar" hidden></span>
  <button id="reload" type="button" title="Reload projects">↻</button>
</header>
<main>
  <aside aria-label="Projects">
    <div class="sidehead">Projects</div>
    <div id="projectlist"><div class="empty">Loading…</div></div>
  </aside>
  <section id="workspace" aria-label="Memory tree and graph">
    <div id="graphControls" hidden>
      <label class="toggle"><input type="checkbox" id="graphTags"> Tags</label>
      <label class="toggle"><input type="checkbox" id="graphCross"> Cross-links</label>
      <label class="toggle"><input type="checkbox" id="graphSessions"> Sessions</label>
      <label id="depthwrap">Depth <input type="range" id="graphDepth" min="1" max="12" value="6"><span id="depthValue">6</span></label>
      <span id="graphCount" aria-live="polite"></span>
    </div>
    <div id="tree" class="view"><div id="board"><svg id="wires" aria-hidden="true"></svg></div></div>
    <div id="graphView" class="view" hidden>
      <div id="legend" aria-label="Node kind legend">
        <span class="legend-item"><i class="swatch" style="--swatch:var(--kind-project)"></i>Project</span>
        <span class="legend-item"><i class="swatch" style="--swatch:var(--kind-section)"></i>Section</span>
        <span class="legend-item"><i class="swatch" style="--swatch:var(--kind-task)"></i>Task</span>
        <span class="legend-item"><i class="swatch" style="--swatch:var(--kind-bug)"></i>Bug</span>
        <span class="legend-item"><i class="swatch" style="--swatch:var(--kind-idea)"></i>Idea</span>
        <span class="legend-item"><i class="swatch" style="--swatch:var(--kind-decision)"></i>Decision</span>
        <span class="legend-item"><i class="swatch" style="--swatch:var(--kind-learning)"></i>Learning</span>
        <span class="legend-item"><i class="swatch" style="--swatch:var(--kind-log)"></i>Log</span>
        <span class="legend-item"><i class="swatch" style="--swatch:var(--kind-tag)"></i>Tag</span>
        <span class="legend-item"><i class="swatch" style="--swatch:var(--kind-other)"></i>Other</span>
      </div>
      <canvas id="graphCanvas" aria-label="Interactive memory graph"></canvas>
      <div id="graphTip" role="status"></div>
    </div>
  </section>
  <section id="right" aria-label="Node details">
    <div id="tabs" role="tablist">
      <button type="button" data-pane="inspector" class="on" role="tab">Node</button>
      <button type="button" data-pane="toolpane" role="tab">Read tools</button>
      <button type="button" data-pane="simpane" role="tab">Session start</button>
    </div>
    <div id="inspector" class="pane" role="tabpanel"><span class="small">Select a node to see details.</span></div>
    <div id="toolpane" class="pane" role="tabpanel" hidden><div id="toollist"></div><div id="toolform"></div></div>
    <div id="simpane" class="pane" role="tabpanel" hidden>
      <div class="field"><label for="simproject">Project</label><select id="simproject"></select></div>
      <div class="field"><label for="simtokens">Max tokens (blank uses configured default)</label><input id="simtokens" placeholder="700" autocomplete="off"></div>
      <div class="field"><label for="simsession">Session ID (blank uses latest)</label><input id="simsession" autocomplete="off"></div>
      <div class="field"><label for="simorigin">Directive origin</label><select id="simorigin"><option value="marker">Marker (.tim-project)</option><option value="session">Session metadata</option></select></div>
      <button id="simrun" type="button">Simulate session start</button><div id="simout"></div>
    </div>
  </section>
</main>
<script>
(function () {
  var boardEl = document.getElementById('board');
  var wiresEl = document.getElementById('wires');
  var treeEl = document.getElementById('tree');
  var graphViewEl = document.getElementById('graphView');
  var canvas = document.getElementById('graphCanvas');
  var ctx = canvas.getContext('2d');
  var inspEl = document.getElementById('inspector');
  var columns = [];
  var nodeEls = Object.create(null);
  var selected = null;
  var selectedRoot = null;
  var projectData = { projects: [], otherRoots: [] };
  var pendingMove = null;
  var embedMode = new URLSearchParams(window.location.search).get('embed') === '1';
  if (embedMode) document.body.classList.add('embed');

  function api(path) {
    return fetch(path, { headers: { Accept: 'application/json' } }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
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
  function badge(row, text, cls) { row.appendChild(el('span', 'b ' + (cls || ''), text)); }
  function showHidden() { return document.getElementById('showhidden').checked; }
  function expandableCount(n) { return n.childCount + (showHidden() ? n.hiddenChildCount : 0); }
  function kindClass(kind) {
    if (kind === 'project') return 'project';
    if (kind === 'section') return 'section';
    if (kind === 'task') return 'task';
    if (kind === 'bug') return 'bug';
    if (kind === 'idea') return 'idea';
    if (kind === 'decision') return 'decision';
    if (kind === 'learning' || kind === 'lesson') return 'learning';
    if (kind === 'log') return 'log';
    if (kind === 'tag') return 'tag';
    return 'other';
  }
  function decorate(box, n) {
    box.style.setProperty('--node-kind', 'var(--kind-' + kindClass(n.kind) + ')');
    var meta = el('div', 'nmeta');
    if (n.label) badge(meta, n.label, 'mono');
    if (n.kind) badge(meta, n.kind, 'kind');
    if (n.taskStatus) badge(meta, n.taskStatus, 'status');
    if (n.hidden) badge(meta, 'deleted', 'hidden');
    if (n.secret) badge(meta, n.redacted ? 'secret · redacted' : 'secret', 'secret');
    if (n.renderDepth !== null && n.renderDepth !== undefined) badge(meta, 'render_depth ' + n.renderDepth);
    if (meta.childNodes.length) box.appendChild(meta);
  }
  function makeNode(n, col, rec, index) {
    var wrap = el('div', 'nwrap');
    var box = el('div', 'node');
    box.setAttribute('role', 'button');
    box.setAttribute('tabindex', '0');
    box.setAttribute('aria-label', (n.kind || 'entry') + ': ' + (n.title || n.id));
    decorate(box, n);
    box.appendChild(el('div', 'ntitle', n.title || '(untitled)'));
    box.onclick = function () { select(n.id); };
    box.onkeydown = function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(n.id); } };
    var count = expandableCount(n);
    var kids = el('span', 'kids' + (count ? '' : ' leaf'), 'Children: ' + count + (n.hiddenChildCount && !showHidden() ? ' · ' + n.hiddenChildCount + ' hidden' : ''));
    if (count) kids.onclick = function (event) { event.stopPropagation(); toggle(n.id, index); };
    wrap.appendChild(box); wrap.appendChild(kids); col.appendChild(wrap);
    rec.ids.push(n.id);
    nodeEls[n.id] = { wrap: wrap, box: box, kids: kids, col: index };
    return box;
  }
  function addColumn() {
    var rec = { el: el('div', 'col'), ids: [], openId: null };
    boardEl.appendChild(rec.el); columns.push(rec); return rec;
  }
  function truncateTo(k) {
    while (columns.length > k + 1) {
      var gone = columns.pop();
      gone.ids.forEach(function (id) { delete nodeEls[id]; });
      gone.el.remove();
    }
    var col = columns[k];
    if (col && col.openId) {
      if (nodeEls[col.openId]) nodeEls[col.openId].box.classList.remove('open');
      col.openId = null;
    }
  }
  function alignColumn(k, parentId) {
    var anchor = nodeEls[parentId], col = columns[k];
    if (!anchor || !col) return;
    col.el.style.marginTop = '0px';
    var first = col.el.querySelector('.nwrap');
    if (!first) return;
    var delta = anchor.wrap.getBoundingClientRect().top - first.getBoundingClientRect().top;
    col.el.style.marginTop = Math.max(0, delta) + 'px';
  }
  function wire(x1, y1, x2, y2) {
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    var dx = Math.max(18, (x2 - x1) / 2);
    path.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2);
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.4');
    return path;
  }
  function drawWires() {
    wiresEl.textContent = '';
    wiresEl.style.width = boardEl.offsetWidth + 'px'; wiresEl.style.height = boardEl.offsetHeight + 'px';
    var br = boardEl.getBoundingClientRect();
    for (var i = 0; i < columns.length - 1; i++) {
      var src = columns[i].openId ? nodeEls[columns[i].openId] : null;
      if (!src) continue;
      var s = src.kids.getBoundingClientRect(), x1 = s.right - br.left, y1 = s.top + s.height / 2 - br.top;
      columns[i + 1].ids.forEach(function (id) {
        var target = nodeEls[id]; if (!target) return;
        var r = target.box.getBoundingClientRect();
        wiresEl.appendChild(wire(x1, y1, r.left - br.left, r.top + r.height / 2 - br.top));
      });
    }
  }
  function toggle(id, index) {
    var col = columns[index]; if (!col) return Promise.resolve();
    var wasOpen = col.openId === id;
    truncateTo(index);
    if (wasOpen) { drawWires(); return Promise.resolve(); }
    col.openId = id;
    if (nodeEls[id]) nodeEls[id].box.classList.add('open');
    var rec = addColumn(); rec.el.appendChild(el('div', 'empty', 'Loading…'));
    var q = 'api/children?id=' + encodeURIComponent(id) + (showHidden() ? '&hidden=1' : '');
    return api(q).then(function (data) {
      rec.el.textContent = '';
      data.children.forEach(function (child) { makeNode(child, rec.el, rec, index + 1); });
      if (!data.children.length) rec.el.appendChild(el('div', 'empty', '(no children)'));
      alignColumn(index + 1, id); drawWires(); return data;
    }).catch(function (e) { rec.el.textContent = ''; rec.el.appendChild(el('div', 'err', e.message)); drawWires(); });
  }
  function expand(id) {
    var entry = nodeEls[id]; if (!entry) return Promise.resolve();
    if (columns[entry.col] && columns[entry.col].openId === id) return Promise.resolve();
    return toggle(id, entry.col);
  }

  function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function inlineMarkdown(text) {
    var codes = [];
    var out = escapeHtml(text).replace(/\u0060([^\u0060]+)\u0060/g, function (_, code) {
      var index = codes.push(code) - 1; return 'TIMCODETOKEN' + index + 'ENDTOKEN';
    });
    out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<strong>$1</strong>');
    out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>').replace(/_([^_\n]+)_/g, '<em>$1</em>');
    return out.replace(/TIMCODETOKEN(\d+)ENDTOKEN/g, function (_, index) { return '<code>' + codes[Number(index)] + '</code>'; });
  }
  function markdownHtml(source) {
    var lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
    var out = [], para = [], list = null, code = null;
    function flushPara() { if (para.length) { out.push('<p>' + para.map(inlineMarkdown).join('<br>') + '</p>'); para = []; } }
    function closeList() { if (list) { out.push('</' + list + '>'); list = null; } }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (code !== null) {
        if (/^\s*\u0060{3}/.test(line)) { out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>'); code = null; }
        else code.push(line);
        continue;
      }
      if (/^\s*\u0060{3}/.test(line)) { flushPara(); closeList(); code = []; continue; }
      if (!line.trim()) { flushPara(); closeList(); continue; }
      var heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
      if (heading) { flushPara(); closeList(); var level = Math.min(3, heading[1].length); out.push('<h' + level + '>' + inlineMarkdown(heading[2]) + '</h' + level + '>'); continue; }
      var item = line.match(/^\s*[-+*]\s+(.+)$/), ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (item || ordered) {
        flushPara(); var wanted = ordered ? 'ol' : 'ul';
        if (list !== wanted) { closeList(); list = wanted; out.push('<' + list + '>'); }
        out.push('<li>' + inlineMarkdown((item || ordered)[1]) + '</li>'); continue;
      }
      closeList(); para.push(line);
    }
    flushPara(); closeList();
    if (code !== null) out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
    return out.join('');
  }
  function humanDate(value) {
    if (!value) return '—';
    var date = new Date(value); return isNaN(date.getTime()) ? value : date.toLocaleString();
  }
  function taskMeta(n) {
    var m = n.metadata || {}, task = m.task && typeof m.task === 'object' ? m.task : {};
    return { status: task.status || m.status || '', priority: task.priority || m.priority || m.severity || '' };
  }
  function kv(table, key, value, mono) {
    var tr = document.createElement('tr'); tr.appendChild(el('td', null, key));
    tr.appendChild(el('td', mono ? 'mono' : null, value)); table.appendChild(tr);
  }
  function renderInspector(n) {
    inspEl.textContent = '';
    var task = taskMeta(n);
    var crumbs = el('div', null); crumbs.id = 'crumbs';
    (n.path || []).forEach(function (c, i) {
      if (i) crumbs.appendChild(document.createTextNode(' / '));
      var button = el('button', 'crumb', (c.label ? c.label + ' · ' : '') + (c.title || c.id));
      button.type = 'button'; button.onclick = function () { reveal(c.id); }; crumbs.appendChild(button);
    });
    if (n.path && n.path.length) inspEl.appendChild(crumbs);
    inspEl.appendChild(el('h2', null, n.title || '(untitled)')).id = 'detailTitle';
    var badges = el('div'); badges.id = 'detailBadges';
    if (n.kind) badge(badges, n.kind, 'kind');
    if (n.label) badge(badges, n.label, 'mono');
    if (task.status) badge(badges, task.status, 'status');
    if (task.priority) badge(badges, 'priority ' + task.priority);
    (n.tags || []).forEach(function (tag) { badge(badges, tag); });
    if (n.secret) badge(badges, n.redacted ? 'secret · redacted' : 'secret', 'secret');
    inspEl.appendChild(badges);
    var table = document.createElement('table');
    kv(table, 'id', n.id, true); kv(table, 'parent', n.parentId || '(root)', true);
    kv(table, 'type', n.type || '—'); kv(table, 'render depth', n.renderDepth === null ? '(unset)' : String(n.renderDepth));
    kv(table, 'children', n.childCount + (n.hiddenChildCount ? ' · ' + n.hiddenChildCount + ' hidden' : ''));
    kv(table, 'depth / confidence', n.depth + ' / ' + n.confidence);
    kv(table, 'created', humanDate(n.createdAt)); kv(table, 'updated', humanDate(n.updatedAt)); kv(table, 'accessed', humanDate(n.accessedAt));
    inspEl.appendChild(table);
    inspEl.appendChild(el('div', 'small', 'Content · ' + n.contentChars + ' characters'));
    var content = el('div'); content.id = 'content';
    if (n.content === null && n.redacted) content.textContent = '[secret content redacted]';
    else if (!n.content) content.textContent = '(empty)';
    else content.innerHTML = markdownHtml(n.content);
    inspEl.appendChild(content);
    var details = document.createElement('details');
    details.appendChild(el('summary', null, 'Raw metadata'));
    var raw = el('pre', 'raw mono', JSON.stringify(n.metadata, null, 2)); raw.classList.add('raw'); details.appendChild(raw);
    inspEl.appendChild(details);
    var actions = renderActions(n); if (actions) inspEl.appendChild(actions);
  }
  function select(id, scrollTree) {
    var nodeTab = document.querySelector('#tabs button[data-pane="inspector"]');
    if (nodeTab && inspEl.hidden && !embedMode) nodeTab.click();
    inspEl.textContent = ''; inspEl.appendChild(el('div', 'small', 'Loading…'));
    return api('api/node?id=' + encodeURIComponent(id)).then(function (data) {
      var n = data.node;
      if (selected && nodeEls[selected]) nodeEls[selected].box.classList.remove('sel');
      selected = n.id;
      if (nodeEls[n.id]) {
        nodeEls[n.id].box.classList.add('sel');
        if (scrollTree !== false && !treeEl.hidden) nodeEls[n.id].wrap.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      renderInspector(n); drawGraph(); return n;
    }).catch(function (e) { inspEl.textContent = ''; inspEl.appendChild(el('div', 'err', e.message)); });
  }
  function reportError(container, error) { container.textContent = ''; container.appendChild(el('div', 'err', error.message)); }

  function updateProjectSelection() {
    var active = null;
    Array.prototype.forEach.call(document.querySelectorAll('.project-item'), function (item) {
      item.classList.toggle('on', item.dataset.root === selectedRoot);
      item.setAttribute('aria-current', item.dataset.root === selectedRoot ? 'true' : 'false');
      if (item.dataset.root === selectedRoot) active = item;
    });
    var picker = document.getElementById('projectpicker');
    picker.value = projectData.projects.some(function (p) { return p.id === selectedRoot; }) ? selectedRoot : '';
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
  function addProjectButton(root, title, label, count, section) {
    var button = el('button', 'project-item'); button.type = 'button'; button.dataset.root = root.id;
    button.appendChild(el('span', 'project-copy'));
    var copy = button.firstChild;
    copy.appendChild(el('span', 'project-title', title || '(untitled)'));
    copy.appendChild(el('span', 'project-sub', (label ? label + ' · ' : '') + count + ' entries'));
    button.onclick = function () { openRoot(root.id); };
    section.appendChild(button);
  }
  function renderProjectList() {
    var list = document.getElementById('projectlist'), picker = document.getElementById('projectpicker');
    list.textContent = ''; picker.textContent = '';
    picker.appendChild(new Option('Choose project', ''));
    projectData.projects.forEach(function (p) {
      picker.appendChild(new Option((p.label ? p.label + ' · ' : '') + p.title, p.id));
      addProjectButton(p, p.title, p.label, typeof p.entryCount === 'number' ? p.entryCount : p.childCount, list);
    });
    if (projectData.otherRoots.length) {
      list.appendChild(el('div', 'sidehead', 'Other roots'));
      projectData.otherRoots.forEach(function (root) { addProjectButton(root, root.title, root.label, typeof root.entryCount === 'number' ? root.entryCount : root.childCount, list); });
    }
    updateProjectSelection();
  }
  function openRoot(id) {
    selectedRoot = id; updateProjectSelection();
    if (currentView === 'graph') return loadGraph();
    return loadTreeRoot(id);
  }
  function loadTreeRoot(id) {
    truncateTo(-1); nodeEls = Object.create(null); selected = null;
    var first = addColumn(); first.el.appendChild(el('div', 'empty', 'Loading…')); drawWires();
    if (!id) { first.el.textContent = ''; first.el.appendChild(el('div', 'empty', 'Choose a project to browse its entries.')); return Promise.resolve(); }
    var q = 'api/children?id=' + encodeURIComponent(id) + (showHidden() ? '&hidden=1' : '');
    return api(q).then(function (data) {
      first.el.textContent = ''; makeNode(data.parent, first.el, first, 0);
      return toggle(id, 0);
    }).catch(function (e) { first.el.textContent = ''; first.el.appendChild(el('div', 'err', e.message)); });
  }
  function loadProjects() {
    return api('api/projects').then(function (data) {
      projectData = data;
      var roots = data.projects.concat(data.otherRoots || []);
      if (!selectedRoot || !roots.some(function (r) { return r.id === selectedRoot; })) selectedRoot = roots.length ? roots[0].id : null;
      renderProjectList();
      if (currentView === 'graph') return loadGraph();
      return loadTreeRoot(selectedRoot);
    }).catch(function (e) { document.getElementById('projectlist').textContent = ''; document.getElementById('projectlist').appendChild(el('div', 'err', e.message)); });
  }
  function loadStats() {
    return api('api/stats').then(function (s) {
      document.getElementById('stats').textContent = s.projectCount + ' projects · ' + s.totalEntries + ' entries · ' + s.hiddenEntries + ' hidden';
    }).catch(function (e) { document.getElementById('stats').textContent = 'Stats unavailable: ' + e.message; });
  }
  function reveal(id) {
    return api('api/node?id=' + encodeURIComponent(id)).then(function (data) {
      var path = data.node.path || [];
      var rootId = path.length ? path[0].id : data.node.id;
      var step = Promise.resolve();
      if (currentView === 'graph') setView('tree');
      if (rootId !== selectedRoot) step = step.then(function () { return openRoot(rootId); });
      path.forEach(function (crumb) { step = step.then(function () { return expand(crumb.id); }); });
      return step.then(function () { return select(data.node.id); });
    }).catch(function (e) { inspEl.textContent = ''; inspEl.appendChild(el('div', 'err', e.message)); });
  }

  // Structure edits stay routed to the MCP server. The read-only DB handle
  // never receives writes; every failure is rendered beside the affected node.
  function mutate(name, args) {
    return fetch('api/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ name: name, args: args }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (body) { if (!r.ok) throw new Error(body.error || 'HTTP ' + r.status); return body; }); });
  }
  function renderMoveBar() {
    var bar = document.getElementById('movebar'); bar.textContent = '';
    if (!pendingMove) { bar.hidden = true; return; }
    bar.hidden = false; bar.appendChild(document.createTextNode('Moving ' + (pendingMove.title || pendingMove.id) + ' '));
    var cancel = el('button', null, 'Cancel'); cancel.onclick = function () { pendingMove = null; renderMoveBar(); if (selected) select(selected); };
    bar.appendChild(cancel);
  }
  function descendants(id) {
    return api('api/children?id=' + encodeURIComponent(id) + '&hidden=1').then(function (data) {
      var kids = data.children || [], ids = kids.map(function (c) { return c.id; });
      return kids.reduce(function (chain, child) { return chain.then(function (all) { return descendants(child.id).then(function (more) { return all.concat(more); }); }); }, Promise.resolve(ids));
    });
  }
  function afterMutation(focusId) {
    pendingMove = null; renderMoveBar();
    return loadStats().then(loadProjects).then(function () { if (focusId) return reveal(focusId); });
  }
  function deleteOne(n, box) {
    box.textContent = ''; box.appendChild(el('div', 'small', 'Deleting…'));
    mutate('tim_delete', { id: n.id }).then(function () { return afterMutation(n.parentId); }).catch(function (e) { reportError(box, e); });
  }
  function deleteSubtree(n, box) {
    box.textContent = ''; box.appendChild(el('div', 'small', 'Collecting descendants…'));
    descendants(n.id).then(function (ids) {
      box.textContent = ''; box.appendChild(el('div', 'small', 'Deleting ' + (ids.length + 1) + ' nodes…'));
      return (ids.length ? mutate('tim_update_many', { ids: ids, irrelevant: true }) : Promise.resolve())
        .then(function () { return mutate('tim_delete', { id: n.id }); });
    }).then(function () { return afterMutation(n.parentId); }).catch(function (e) { reportError(box, e); });
  }
  function reparentThenDelete(n, box) {
    box.textContent = ''; box.appendChild(el('div', 'small', 'Moving children up…'));
    api('api/children?id=' + encodeURIComponent(n.id) + '&hidden=1').then(function (data) {
      return (data.children || []).reduce(function (chain, child) {
        return chain.then(function () { return mutate('tim_move_entry', { id: child.id, newParentId: n.parentId }); });
      }, Promise.resolve()).then(function () { return mutate('tim_delete', { id: n.id }); });
    }).then(function () { return afterMutation(n.parentId); }).catch(function (e) { reportError(box, e); });
  }
  function askAboutChildren(n, box, count) {
    box.textContent = ''; var ask = el('div', 'ask');
    ask.appendChild(el('p', null, 'This node has ' + count + ' children. Choose what happens to them before deleting it.'));
    var up = el('button', null, 'Move children up, then delete'); up.onclick = function () { reparentThenDelete(n, box); };
    var down = el('button', 'danger', 'Delete children too'); down.onclick = function () { deleteSubtree(n, box); };
    var cancel = el('button', null, 'Cancel'); cancel.onclick = function () { select(n.id); };
    ask.appendChild(up); ask.appendChild(down); ask.appendChild(cancel); box.appendChild(ask);
    if (!n.parentId) box.appendChild(el('div', 'small', 'This is a root; moving children up makes them roots.'));
  }
  function renderActions(n) {
    if (embedMode) return null;
    var box = el('div'); box.id = 'actions';
    if (pendingMove && pendingMove.id !== n.id) {
      var here = el('button', null, 'Move selected entry here'), moving = pendingMove;
      here.onclick = function () { box.textContent = ''; box.appendChild(el('div', 'small', 'Moving…')); mutate('tim_move_entry', { id: moving.id, newParentId: n.id }).then(function () { return afterMutation(moving.id); }).catch(function (e) { reportError(box, e); }); };
      box.appendChild(here);
    }
    var move = el('button', null, pendingMove && pendingMove.id === n.id ? 'Cancel move' : 'Move…');
    move.onclick = function () { pendingMove = pendingMove && pendingMove.id === n.id ? null : { id: n.id, title: n.title }; renderMoveBar(); select(n.id); };
    box.appendChild(move);
    if (n.irrelevant) {
      var restore = el('button', null, 'Restore'); restore.onclick = function () { mutate('tim_update_many', { ids: [n.id], irrelevant: false }).then(function () { return afterMutation(n.id); }).catch(function (e) { reportError(box, e); }); };
      box.appendChild(restore);
    } else {
      var total = n.childCount + n.hiddenChildCount, del = el('button', 'danger', 'Delete…');
      del.onclick = function () { if (total) askAboutChildren(n, box, total); else {
        box.textContent = ''; var confirm = el('button', 'danger', 'Confirm delete');
        confirm.onclick = function () { deleteOne(n, box); }; var cancel = el('button', null, 'Cancel');
        cancel.onclick = function () { select(n.id); }; box.appendChild(confirm); box.appendChild(cancel);
      } };
      box.appendChild(del);
    }
    box.appendChild(el('div', 'small', 'Delete marks entries irrelevant. It does not erase their content.'));
    return box;
  }

  // Graph view: canvas rendering and a small force layout with grid-based
  // repulsion. No graph library or network-loaded assets.
  var currentView = 'tree';
  var graphData = null, graphNodes = [], graphLinks = [], graphById = Object.create(null);
  var graphAdj = Object.create(null), graphMatches = new Set(), graphHover = null;
  var camera = { x: 0, y: 0, scale: 1 }, alpha = 0, frame = 0, graphLoadedRoot = null;
  var pointer = null, draggingNode = null, graphHasFit = false;
  var graphColors = {};
  function graphColor(kind) {
    var cls = kindClass(kind), key = cls;
    if (!graphColors[key]) graphColors[key] = getComputedStyle(document.documentElement).getPropertyValue('--kind-' + cls).trim();
    return graphColors[key] || '#788394';
  }
  function canvasSize() {
    var rect = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!rect.width || !rect.height) return;
    var width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function graphPoint(node) { return { x: node.x * camera.scale + camera.x, y: node.y * camera.scale + camera.y }; }
  function screenWorld(x, y) { return { x: (x - camera.x) / camera.scale, y: (y - camera.y) / camera.scale }; }
  function nodeRadius(node) { return Math.max(4, Math.min(15, 3.2 + Math.sqrt(Math.max(0, node.degree + node.childCount)) * 1.25)); }
  function graphHit(x, y) {
    var world = screenWorld(x, y), best = null, distance = Infinity;
    for (var i = 0; i < graphNodes.length; i++) {
      var node = graphNodes[i], dx = node.x - world.x, dy = node.y - world.y;
      var hit = nodeRadius(node) + 5 / camera.scale, d2 = dx * dx + dy * dy;
      if (d2 < hit * hit && d2 < distance) { best = node; distance = d2; }
    }
    return best;
  }
  function graphBounds() {
    if (!graphNodes.length) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    graphNodes.forEach(function (n) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); });
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }
  function fitGraph() {
    canvasSize(); var rect = canvas.getBoundingClientRect(), bounds = graphBounds();
    if (!bounds || !rect.width || !rect.height) return;
    var width = Math.max(90, bounds.maxX - bounds.minX), height = Math.max(90, bounds.maxY - bounds.minY);
    camera.scale = Math.max(.08, Math.min(2.4, Math.min((rect.width - 70) / width, (rect.height - 70) / height)));
    camera.x = rect.width / 2 - ((bounds.minX + bounds.maxX) / 2) * camera.scale;
    camera.y = rect.height / 2 - ((bounds.minY + bounds.maxY) / 2) * camera.scale;
    graphHasFit = true; drawGraph();
  }
  function updateMatches() {
    var term = document.getElementById('jump').value.trim().toLocaleLowerCase();
    graphMatches = new Set();
    if (!term) return;
    graphNodes.forEach(function (n) {
      if ((n.title + ' ' + n.id + ' ' + (n.label || '')).toLocaleLowerCase().indexOf(term) !== -1) graphMatches.add(n.id);
    });
  }
  function drawGraph() {
    if (!ctx || graphViewEl.hidden) return;
    canvasSize(); var rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!graphNodes.length) return;
    var css = getComputedStyle(document.documentElement);
    var lineColor = css.getPropertyValue('--line').trim();
    var accentColor = css.getPropertyValue('--accent').trim();
    var fgColor = css.getPropertyValue('--fg').trim();
    var warnColor = css.getPropertyValue('--warn').trim();
    var hovered = graphHover && graphById[graphHover], near = new Set();
    if (hovered) { near.add(hovered.id); (graphAdj[hovered.id] || []).forEach(function (id) { near.add(id); }); }
    graphLinks.forEach(function (link) {
      var a = graphById[link.source], b = graphById[link.target]; if (!a || !b) return;
      var p = graphPoint(a), q = graphPoint(b);
      var active = !hovered || link.source === hovered.id || link.target === hovered.id;
      ctx.globalAlpha = hovered ? (active ? .8 : .08) : (link.type === 'child' ? .28 : .48);
      ctx.strokeStyle = link.type === 'child' ? lineColor : accentColor;
      ctx.lineWidth = link.type === 'child' ? 1 : 1.25;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    });
    graphNodes.forEach(function (node) {
      var p = graphPoint(node), radius = nodeRadius(node) * camera.scale;
      var active = !hovered || near.has(node.id), match = graphMatches.has(node.id), chosen = node.id === selected;
      ctx.globalAlpha = hovered ? (active ? 1 : .13) : 1;
      if (match) { ctx.beginPath(); ctx.arc(p.x, p.y, radius + 5, 0, Math.PI * 2); ctx.strokeStyle = warnColor; ctx.lineWidth = 2; ctx.stroke(); }
      ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = graphColor(node.kind); ctx.fill();
      if (node.external) { ctx.setLineDash([3, 2]); ctx.strokeStyle = graphColor(node.kind); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]); }
      else if (chosen) { ctx.strokeStyle = fgColor; ctx.lineWidth = 2; ctx.stroke(); }
      if (node.taskStatus) {
        ctx.beginPath(); ctx.arc(p.x, p.y, radius + 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = node.taskStatus === 'done' ? graphColor('task') : warnColor;
        ctx.lineWidth = 1.5; ctx.stroke();
      }
      if ((camera.scale > 1.45 && graphNodes.length < 1800) || node.id === graphHover || chosen || match) {
        var label = node.label || node.title || node.id;
        if (label.length > 44) label = label.slice(0, 41) + '…';
        ctx.globalAlpha = hovered ? (active ? 1 : .16) : .9;
        ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = fgColor;
        ctx.fillText(label, p.x + radius + 4, p.y + 4);
      }
    });
    ctx.globalAlpha = 1;
  }
  function tickGraph() {
    if (!graphNodes.length) return;
    var cellSize = 150, grid = Object.create(null);
    graphNodes.forEach(function (node, index) {
      var key = Math.floor(node.x / cellSize) + ':' + Math.floor(node.y / cellSize);
      (grid[key] || (grid[key] = [])).push(index);
    });
    var maxDist = 148;
    graphNodes.forEach(function (node, index) {
      if (node.pinned) return;
      var cx = Math.floor(node.x / cellSize), cy = Math.floor(node.y / cellSize);
      for (var gx = cx - 1; gx <= cx + 1; gx++) for (var gy = cy - 1; gy <= cy + 1; gy++) {
        var bucket = grid[gx + ':' + gy] || [];
        bucket.forEach(function (otherIndex) {
          if (otherIndex <= index) return;
          var other = graphNodes[otherIndex], dx = other.x - node.x, dy = other.y - node.y, d2 = dx * dx + dy * dy;
          if (!d2 || d2 > maxDist * maxDist) return;
          var d = Math.sqrt(d2), force = (maxDist - d) / d * .045 * alpha;
          var fx = dx * force, fy = dy * force;
          node.vx -= fx; node.vy -= fy; other.vx += fx; other.vy += fy;
        });
      }
    });
    graphLinks.forEach(function (link) {
      var a = graphById[link.source], b = graphById[link.target]; if (!a || !b) return;
      var dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || .01;
      var target = link.type === 'child' ? 76 : (link.type === 'tag' ? 52 : 118);
      var force = (d - target) * (link.type === 'child' ? .006 : .0035) * alpha;
      var fx = dx / d * force, fy = dy / d * force;
      if (!a.pinned) { a.vx += fx; a.vy += fy; }
      if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
    });
    graphNodes.forEach(function (node) {
      if (node.pinned) { node.vx = 0; node.vy = 0; return; }
      node.vx += -node.x * .00018 * alpha; node.vy += -node.y * .00018 * alpha;
      node.vx *= .84; node.vy *= .84; node.x += node.vx; node.y += node.vy;
    });
    alpha *= .986;
  }
  function animateGraph() {
    frame = 0;
    if (alpha > .025) { tickGraph(); drawGraph(); frame = requestAnimationFrame(animateGraph); }
    else { alpha = 0; drawGraph(); }
  }
  function startGraph() { alpha = 1; if (!frame) frame = requestAnimationFrame(animateGraph); }
  function graphQuery() {
    var params = new URLSearchParams();
    params.set('root', selectedRoot || '');
    params.set('depth', document.getElementById('graphDepth').value);
    if (document.getElementById('graphTags').checked) params.set('tags', '1');
    if (document.getElementById('graphCross').checked) params.set('cross', '1');
    if (document.getElementById('graphSessions').checked) params.set('include', 'sessions');
    if (showHidden()) params.set('hidden', '1');
    return params.toString();
  }
  function loadGraph() {
    if (!selectedRoot) { document.getElementById('graphCount').textContent = 'Choose a project'; graphNodes = []; drawGraph(); return Promise.resolve(); }
    document.getElementById('graphCount').textContent = 'Loading graph…';
    var priorRoot = graphLoadedRoot;
    graphLoadedRoot = selectedRoot;
    return api('api/graph?' + graphQuery()).then(function (data) {
      var old = graphById, rect = canvas.getBoundingClientRect();
      graphData = data; graphNodes = []; graphLinks = data.links || []; graphById = Object.create(null); graphAdj = Object.create(null);
      var count = document.getElementById('graphCount');
      count.textContent = data.nodes.length + ' nodes · ' + data.total + ' total' + (data.truncated ? ' · truncated' : '');
      data.nodes.forEach(function (raw, i) {
        var prior = old[raw.id], angle = i * 2.399963, radius = 24 * Math.sqrt(i);
        var node = Object.assign({}, raw, { x: prior ? prior.x : Math.cos(angle) * radius, y: prior ? prior.y : Math.sin(angle) * radius, vx: 0, vy: 0, pinned: false });
        graphNodes.push(node); graphById[node.id] = node; graphAdj[node.id] = [];
      });
      graphLinks.forEach(function (link) {
        if (graphAdj[link.source]) graphAdj[link.source].push(link.target);
        if (graphAdj[link.target]) graphAdj[link.target].push(link.source);
      });
      updateMatches(); canvasSize();
      if (!graphHasFit || priorRoot !== selectedRoot || !rect.width) fitGraph();
      else drawGraph();
      startGraph();
    }).catch(function (e) { document.getElementById('graphCount').textContent = 'Graph unavailable: ' + e.message; });
  }
  function setView(mode) {
    currentView = mode;
    treeEl.hidden = mode !== 'tree'; graphViewEl.hidden = mode !== 'graph';
    document.getElementById('graphControls').hidden = mode !== 'graph';
    document.getElementById('treebtn').classList.toggle('on', mode === 'tree');
    document.getElementById('graphbtn').classList.toggle('on', mode === 'graph');
    document.getElementById('treebtn').setAttribute('aria-pressed', mode === 'tree' ? 'true' : 'false');
    document.getElementById('graphbtn').setAttribute('aria-pressed', mode === 'graph' ? 'true' : 'false');
    try { localStorage.setItem('tim-viewer-view', mode); } catch (_) {}
    if (mode === 'graph') { graphHasFit = false; loadGraph(); }
    else { if (frame) cancelAnimationFrame(frame); frame = 0; alpha = 0; drawWires(); }
  }
  function centerGraph(node) {
    if (!node) return;
    var rect = canvas.getBoundingClientRect(); camera.x = rect.width / 2 - node.x * camera.scale; camera.y = rect.height / 2 - node.y * camera.scale; drawGraph();
  }
  function graphEnterSearch() {
    updateMatches(); drawGraph();
    var first = graphNodes.find(function (node) { return graphMatches.has(node.id); });
    if (first) { centerGraph(first); selectGraphNode(first); }
    else { var value = document.getElementById('jump').value.trim(); if (value) reveal(value); }
  }
  function selectGraphNode(node) {
    if (node.kind !== 'tag') return select(node.id, false);
    selected = node.id;
    inspEl.textContent = '';
    inspEl.appendChild(el('h2', null, node.title));
    var badges = el('div'); badges.id = 'detailBadges'; badge(badges, 'tag', 'kind'); inspEl.appendChild(badges);
    var related = graphLinks.filter(function (link) { return link.type === 'tag' && link.target === node.id; });
    inspEl.appendChild(el('div', 'small', 'Used by ' + related.length + ' entries'));
    var list = document.createElement('ul');
    related.forEach(function (link) {
      var item = document.createElement('li'), entry = graphById[link.source];
      var button = el('button', null, entry ? (entry.label ? entry.label + ' · ' : '') + entry.title : link.source);
      button.type = 'button'; button.onclick = function () { select(link.source, false); };
      item.appendChild(button); list.appendChild(item);
    });
    inspEl.appendChild(list); drawGraph();
  }

  // Pointer controls: wheel zooms around cursor, background drag pans, node
  // drag pins until release, and double-click background fits all nodes.
  canvas.addEventListener('wheel', function (event) {
    event.preventDefault(); var rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    var world = screenWorld(x, y), factor = event.deltaY < 0 ? 1.12 : .89;
    camera.scale = Math.max(.04, Math.min(6, camera.scale * factor)); camera.x = x - world.x * camera.scale; camera.y = y - world.y * camera.scale; drawGraph();
  }, { passive: false });
  canvas.addEventListener('pointerdown', function (event) {
    var rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top, hit = graphHit(x, y);
    canvas.setPointerCapture(event.pointerId);
    if (hit && hit.kind !== 'tag') { draggingNode = hit; hit.pinned = true; pointer = { kind: 'node', x: x, y: y }; }
    else pointer = { kind: 'pan', x: x, y: y, cx: camera.x, cy: camera.y };
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', function (event) {
    var rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    if (pointer && pointer.kind === 'pan') { camera.x = pointer.cx + x - pointer.x; camera.y = pointer.cy + y - pointer.y; drawGraph(); return; }
    if (pointer && pointer.kind === 'node' && draggingNode) { var world = screenWorld(x, y); draggingNode.x = world.x; draggingNode.y = world.y; drawGraph(); return; }
    var hit = graphHit(x, y), tip = document.getElementById('graphTip'); graphHover = hit ? hit.id : null;
    if (hit) {
      tip.textContent = ''; tip.appendChild(el('strong', null, hit.title || hit.id));
      tip.appendChild(el('span', 'small', (hit.kind || 'entry') + (hit.label ? ' · ' + hit.label : '')));
      tip.style.display = 'block'; tip.style.left = Math.min(x + 14, rect.width - 290) + 'px'; tip.style.top = Math.min(y + 14, rect.height - 65) + 'px';
    } else tip.style.display = 'none';
    drawGraph();
  });
  canvas.addEventListener('pointerup', function (event) {
    if (draggingNode) { draggingNode.pinned = false; draggingNode = null; startGraph(); }
    pointer = null; canvas.classList.remove('dragging');
  });
  canvas.addEventListener('pointercancel', function () { if (draggingNode) draggingNode.pinned = false; draggingNode = null; pointer = null; canvas.classList.remove('dragging'); });
  canvas.addEventListener('click', function (event) {
    if (pointer) return;
    var rect = canvas.getBoundingClientRect(), hit = graphHit(event.clientX - rect.left, event.clientY - rect.top);
    if (hit) selectGraphNode(hit);
  });
  canvas.addEventListener('dblclick', function (event) { var rect = canvas.getBoundingClientRect(); if (!graphHit(event.clientX - rect.left, event.clientY - rect.top)) fitGraph(); });

  // Read tool panel is generated from the server's JSON schemas. Calls remain
  // GETs through the local viewer and any failure appears in the panel.
  var toolListEl = document.getElementById('toollist'), toolFormEl = document.getElementById('toolform'), toolsLoaded = false;
  function schemaOf(tool, key) { return (tool.inputSchema.properties || {})[key] || {}; }
  function isRequired(tool, key) { return (tool.inputSchema.required || []).indexOf(key) !== -1; }
  function fieldValue(tool, key, raw) {
    if (!raw.trim()) return undefined;
    var spec = schemaOf(tool, key); if (spec.type === 'string') return raw;
    try { return JSON.parse(raw.trim()); } catch (_) { return raw; }
  }
  function renderTool(tool) {
    toolFormEl.textContent = ''; toolFormEl.appendChild(el('h2', null, tool.name));
    toolFormEl.appendChild(el('div', 'small', tool.description || ''));
    if (tool.forced) toolFormEl.appendChild(el('div', 'forced', 'Viewer pins ' + JSON.stringify(tool.forced)));
    var keys = Object.keys(tool.inputSchema.properties || {}), inputs = {};
    keys.forEach(function (key) {
      var spec = schemaOf(tool, key); if (tool.forced && tool.forced[key] !== undefined) return;
      var wrap = el('div', 'field'), label = el('label', null, key + (spec.type ? ' · ' + spec.type : ''));
      if (isRequired(tool, key)) label.appendChild(el('span', 'req', ' *'));
      if (spec.description) label.appendChild(el('span', 'small', ' · ' + spec.description));
      var input = el(spec.type === 'object' || spec.type === 'array' ? 'textarea' : 'input');
      if (spec.default !== undefined) input.placeholder = 'default: ' + JSON.stringify(spec.default);
      wrap.appendChild(label); wrap.appendChild(input); toolFormEl.appendChild(wrap); inputs[key] = input;
    });
    if (!keys.length) toolFormEl.appendChild(el('div', 'small', '(no parameters)'));
    var run = el('button', null, 'Call ' + tool.name), output = el('div');
    run.onclick = function () {
      var args = {}; Object.keys(inputs).forEach(function (key) { var value = fieldValue(tool, key, inputs[key].value); if (value !== undefined) args[key] = value; });
      output.textContent = ''; output.appendChild(el('div', 'small', 'Calling…'));
      api('api/tool?name=' + encodeURIComponent(tool.name) + '&args=' + encodeURIComponent(JSON.stringify(args)))
        .then(function (data) { output.textContent = ''; output.appendChild(el('pre', 'raw', data.text || '(empty response)')); })
        .catch(function (e) { reportError(output, e); });
    };
    toolFormEl.appendChild(run); toolFormEl.appendChild(output);
  }
  function loadTools() {
    if (toolsLoaded || embedMode) return Promise.resolve(); toolsLoaded = true;
    return api('api/tools').then(function (data) {
      toolListEl.textContent = '';
      data.tools.forEach(function (tool) {
        var item = el('button', null, tool.name); item.type = 'button';
        item.onclick = function () { Array.prototype.forEach.call(toolListEl.children, function (child) { child.classList.remove('on'); }); item.classList.add('on'); renderTool(tool); };
        toolListEl.appendChild(item);
      });
    }).catch(function (e) { toolsLoaded = false; reportError(toolListEl, e); });
  }
  function loadSimProjects() {
    if (embedMode) return Promise.resolve(); var selectEl = document.getElementById('simproject');
    if (selectEl.options.length) return Promise.resolve();
    return api('api/projects').then(function (data) { data.projects.forEach(function (p) { selectEl.appendChild(new Option((p.label ? p.label + ' · ' : '') + p.title, p.label || p.id)); }); })
      .catch(function (e) { reportError(document.getElementById('simout'), e); });
  }
  document.getElementById('simrun').onclick = function () {
    var out = document.getElementById('simout'), args = { project: document.getElementById('simproject').value, origin: document.getElementById('simorigin').value };
    var tokens = document.getElementById('simtokens').value.trim(), session = document.getElementById('simsession').value.trim();
    if (tokens) args.maxTokens = Number(tokens); if (session) args.sessionId = session;
    out.textContent = ''; out.appendChild(el('div', 'small', 'Simulating…'));
    api('api/tool?name=tim_preview_briefing&args=' + encodeURIComponent(JSON.stringify(args)))
      .then(function (data) { out.textContent = ''; out.appendChild(el('pre', 'raw', data.text)); }).catch(function (e) { reportError(out, e); });
  };
  Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (button) {
    if (embedMode && button.dataset.pane !== 'inspector') button.hidden = true;
    button.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) { b.classList.toggle('on', b === button); });
      Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (pane) { pane.hidden = pane.id !== button.dataset.pane; });
      if (button.dataset.pane === 'toolpane') loadTools();
      if (button.dataset.pane === 'simpane') loadSimProjects();
    };
  });

  document.getElementById('projectpicker').onchange = function (event) { if (event.target.value) openRoot(event.target.value); };
  document.getElementById('jumpbtn').onclick = function () { var value = document.getElementById('jump').value.trim(); if (!value) return; if (currentView === 'graph') graphEnterSearch(); else reveal(value); };
  document.getElementById('jump').addEventListener('input', function () { updateMatches(); drawGraph(); });
  document.getElementById('jump').addEventListener('keydown', function (event) { if (event.key === 'Enter') document.getElementById('jumpbtn').click(); });
  document.getElementById('treebtn').onclick = function () { setView('tree'); };
  document.getElementById('graphbtn').onclick = function () { setView('graph'); };
  document.getElementById('reload').onclick = function () { loadStats(); loadProjects(); };
  document.getElementById('showhidden').onchange = function () { if (currentView === 'graph') loadGraph(); else loadTreeRoot(selectedRoot); };
  ['graphTags', 'graphCross', 'graphSessions'].forEach(function (id) { document.getElementById(id).onchange = loadGraph; });
  document.getElementById('graphDepth').oninput = function (event) { document.getElementById('depthValue').textContent = event.target.value; };
  document.getElementById('graphDepth').onchange = loadGraph;
  window.addEventListener('resize', function () { drawWires(); if (currentView === 'graph') { canvasSize(); drawGraph(); } });
  window.addEventListener('keydown', function (event) {
    var target = event.target, editing = target && /INPUT|TEXTAREA|SELECT/.test(target.tagName);
    if (event.key === 'Escape') {
      var previous = selected; selected = null;
      document.getElementById('jump').value = ''; updateMatches();
      if (inspEl) { inspEl.textContent = ''; inspEl.appendChild(el('span', 'small', 'Select a node to see details.')); }
      if (previous && nodeEls[previous]) nodeEls[previous].box.classList.remove('sel'); drawGraph(); return;
    }
    if (editing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '/') { event.preventDefault(); document.getElementById('jump').focus(); }
    else if (event.key.toLowerCase() === 'g') setView(currentView === 'tree' ? 'graph' : 'tree');
  });

  var initialView = 'tree';
  try { var savedView = localStorage.getItem('tim-viewer-view'); if (savedView === 'graph' || savedView === 'tree') initialView = savedView; } catch (_) {}
  loadStats();
  loadProjects().then(function () { setView(initialView); });
})();
</script>
</body>
</html>
`;
