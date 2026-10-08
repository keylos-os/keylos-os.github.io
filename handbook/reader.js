(function () {
  'use strict';
  var NAV = window.KEYLOS_NAV || [];
  var published = window.KEYLOS_PUBLISHED;
  var pages = new Set(published.pages), assets = new Set(published.assets);
  var content = document.getElementById('content'), nav = document.getElementById('nav');
  var toc = document.getElementById('toc'), crumb = document.getElementById('crumb');
  var q = document.getElementById('q'), results = document.getElementById('results');
  var request = 0;
  function dirname(p) { return p.slice(0, p.lastIndexOf('/') + 1); }
  function normalize(p) {
    var parts = [];
    p.split('/').forEach(function (s) {
      if (!s || s === '.') return;
      if (s === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else parts.push(s);
    });
    return parts.join('/');
  }
  function route() {
    var h;
    try { h = decodeURIComponent(location.hash.replace(/^#\/?/, '')); }
    catch (_) { return {path: 'publication-notes.md', anchor: ''}; }
    var k = h.indexOf('#'), p = (k < 0 ? h : h.slice(0, k)) || 'README.md';
    return {path: pages.has(p) ? p : 'publication-notes.md', anchor: k < 0 ? '' : h.slice(k + 1)};
  }
  function link(path, label, className) {
    var a = document.createElement('a');
    a.href = '#/' + path; a.textContent = label;
    if (className) a.className = className;
    return a;
  }
  function buildNav(active) {
    nav.replaceChildren();
    NAV.forEach(function (sec) {
      var d = document.createElement('details'), s = document.createElement('summary');
      s.textContent = sec.title; d.appendChild(s); d.open = !!sec.open;
      (sec.pages || []).forEach(function (pg) {
        var a = link(pg.path, pg.title, 'nav' + (pg.path === active ? ' active' : ''));
        if (pg.path === active) { d.open = true; a.setAttribute('aria-current', 'page'); }
        d.appendChild(a);
      });
      nav.appendChild(d);
    });
  }
  function resolve(href, kind, path) {
    if (/^(https?:|mailto:)/i.test(href)) return href;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return '#/publication-notes.md';
    if (href.charAt(0) === '#') return '#/' + path + href;
    var k = href.indexOf('#'), file = k < 0 ? href : href.slice(0, k);
    var frag = k < 0 ? '' : href.slice(k), target = normalize(dirname(path) + file);
    if (kind === 'img') return assets.has(target) ? target : '';
    if (file.endsWith('/')) target = normalize(target + '/README.md');
    return pages.has(target) ? '#/' + target + frag : '#/publication-notes.md';
  }
  async function render(path, anchor, navigation) {
    var mine = ++request;
    buildNav(path); crumb.textContent = path; content.setAttribute('aria-busy', 'true');
    try {
      var response = await fetch(path);
      if (!response.ok) throw new Error('This handbook page could not be loaded.');
      var source = await response.text();
      if (mine !== request) return;
      var rendered = KeylosMd.render(source, {
        resolve: function (href, kind) { return resolve(href, kind, path); },
        anchorHref: function (id) { return '#/' + path + '#' + id; }
      });
      content.innerHTML = rendered.html;
      toc.replaceChildren();
      var sections = rendered.headings.filter(function (h) { return h.level === 2; });
      if (sections.length > 2) {
        toc.appendChild(document.createTextNode('On this page: '));
        sections.forEach(function (h) { toc.appendChild(link(path + '#' + h.id, h.text)); });
      }
      document.title = (rendered.headings[0] ? rendered.headings[0].text : path) + ' — keylos handbook';
      var main = document.getElementById('main');
      var moveToContent = window.matchMedia('(max-width: 860px)').matches && (navigation || path !== 'README.md' || anchor);
      if (moveToContent) main.focus({preventScroll: true});
      var target = anchor && document.getElementById(anchor);
      if (target) target.scrollIntoView();
      else if (moveToContent) main.scrollIntoView();
      else window.scrollTo(0, 0);
    } catch (error) {
      if (mine !== request) return;
      content.replaceChildren(); toc.replaceChildren();
      var h = document.createElement('h1'); h.textContent = 'Unable to load this page';
      var p = document.createElement('p'); p.textContent = error.message;
      content.append(h, p, link('README.md', 'Return to the handbook'));
    } finally { if (mine === request) content.removeAttribute('aria-busy'); }
  }
  function search() {
    var term = q.value.trim().toLowerCase(), hits = [];
    results.replaceChildren(); nav.style.display = term ? 'none' : '';
    if (!term) return;
    NAV.forEach(function (sec) {
      (sec.pages || []).forEach(function (pg) {
        if (pg.title.toLowerCase().includes(term)) hits.push({path: pg.path, text: pg.title, where: sec.title});
        (pg.headings || []).forEach(function (h) {
          if (h.text.toLowerCase().includes(term)) hits.push({path: pg.path + '#' + h.id, text: h.text, where: pg.title});
        });
      });
    });
    hits.slice(0, 60).forEach(function (hit) {
      var a = link(hit.path, hit.text), small = document.createElement('small');
      small.textContent = hit.where; a.appendChild(small); results.appendChild(a);
    });
    if (!hits.length) results.textContent = 'No matching titles or headings.';
  }
  q.addEventListener('input', search);
  function show(event) { var r = route(); render(r.path, r.anchor, !!event); }
  window.addEventListener('hashchange', show); show();
})();
