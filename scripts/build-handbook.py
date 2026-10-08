#!/usr/bin/env python3
"""Build an allowlisted public handbook snapshot without editing its source.

Run from any directory. By default reads ../../docs and writes ../handbook.
--include-specs is a separate, explicit publication choice: it copies ONLY each
component's spec.md, never its implementation, metadata or working notes.
No network access, source generation, Git operations or publication is performed.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import posixpath
import re
import shutil
import tempfile
import unicodedata
from urllib.parse import unquote, urlsplit

SECTIONS = (
    "01-overview", "02-architecture", "03-components", "04-contracts",
    "05-integrity", "06-security", "07-agents", "08-state", "09-experience",
    "10-operations", "11-decisions", "12-guides", "13-reference",
)
COMPONENTS = (
    "aide", "atrium", "bench", "boot", "broker", "compat", "config", "courier",
    "cri", "depot", "devd", "fleet", "forge", "gate", "hearth", "installer",
    "journal", "keylos", "kish", "ledger", "loom", "net", "pkgs", "portals",
    "protocols", "sdk", "strata", "tlog", "vault", "vouch", "warden",
)
LINK = re.compile(r'(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)')
SECRET = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=]{32,}|\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b")
DENIED = {"AGENTS.md", "IMPLEMENTATION.md", "SPEC-NOTES.md", "ISSUES.md", "DURABLE_EXECUTION_IDEA.md"}
MARKER = ".generated-handbook"


def text(path: Path) -> str:
    if path.is_symlink():
        raise ValueError(f"Refusing symlink: {path}")
    value = path.read_text(encoding="utf-8")
    if SECRET.search(value):
        raise ValueError(f"Possible credential material in {path.name}; publication stopped")
    return value


def headings(source: str) -> set[str]:
    used: set[str] = set()
    fenced = False
    for line in source.splitlines():
        if re.match(r"^\s*```", line):
            fenced = not fenced
        if fenced:
            continue
        match = re.match(r"^#{1,6}\s+(.*?)\s*#*\s*$", line)
        if not match:
            continue
        value = re.sub(r"<[^>]+>", "", match[1]).replace("`", "").strip().lower()
        value = "".join(c for c in value if c.isalnum() or c in " _-" or unicodedata.category(c).startswith(("L", "N")))
        base = re.sub(r"\s", "-", value)
        slug, n = base, 1
        while slug in used:
            slug, n = f"{base}-{n}", n + 1
        used.add(slug)
    return used


def transform_links(source: str, transform) -> str:
    """Match the reader's link syntax, leaving fenced and inline code alone."""
    result, fenced = [], False
    for line in source.splitlines(keepends=True):
        if re.match(r"^\s*```", line):
            fenced = not fenced
            result.append(line)
            continue
        if not fenced:
            def replace(match):
                if line[:match.start()].count("`") % 2:
                    return match[0]
                target = transform(match[3], bool(match[1]))
                return match[0][:match.start(3) - match.start()] + target + match[0][match.end(3) - match.start():]
            line = LINK.sub(replace, line)
        result.append(line)
    return "".join(result)


READER_JS = r"""
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
"""


def main() -> None:
    site = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=site.parent)
    parser.add_argument("--output", type=Path, default=site, help="Website root; only managed handbook/ and specs/ are replaced")
    parser.add_argument("--include-specs", action="store_true", help="Explicitly include component spec.md snapshots (not enabled by default)")
    args = parser.parse_args()
    workspace, output = args.workspace.resolve(), args.output.resolve()
    docs = workspace / "docs"
    if output == workspace or output == docs or output.is_relative_to(docs):
        raise ValueError("Output must be a separate website directory")
    for name in ("handbook", "specs"):
        old = output / name
        if old.exists() and (old.is_symlink() or not (old / MARKER).is_file()):
            raise ValueError(f"Refusing to replace unmanaged directory: {old}")

    # Positive allowlist: no root workspace files, .dev, generators, VCS data,
    # implementation notes, build artifacts or arbitrary component files.
    sources = [docs / "README.md", docs / "CONTRIBUTING.md"]
    for section in SECTIONS:
        if (docs / section).is_symlink():
            raise ValueError(f"Refusing symlinked section: {section}")
        sources += sorted((docs / section).rglob("*.md"))
    sources = [p for p in sources if p.name not in DENIED and not any(s.startswith('.') for s in p.relative_to(docs).parts)]
    if any(not p.resolve().is_relative_to(docs.resolve()) for p in sources):
        raise ValueError("A handbook source escapes the docs directory")
    mapping = {p.resolve(): Path("handbook") / p.relative_to(docs) for p in sources}
    assets = sorted((docs / "images").glob("*.svg"))
    mapping.update({p.resolve(): Path("handbook/images") / p.name for p in assets})
    specs = [workspace / name / 'spec.md' for name in COMPONENTS]
    if any(not p.is_file() or p.parent.is_symlink() or p.is_symlink() for p in specs):
        raise ValueError("Every allowlisted component must have a regular spec.md file")
    if args.include_specs:
        mapping.update({p.resolve(): Path("specs") / p.parent.name / "spec.md" for p in specs})
    raw = {mapping[p.resolve()]: text(p) for p in sources + (specs if args.include_specs else [])}
    unavailable = "# Specification not yet published\n\n> This website publishes the engineering handbook. Detailed repository specifications are not included in this edition.\n\nRead the [component overview](03-components/README.md) for the design and how the pieces fit together.\n\n"
    unavailable += "\n".join(f"## {p.parent.name}\n\nThis specification is not published here. Read the [{p.parent.name} overview](03-components/{p.parent.name}.md).\n" for p in specs)
    if not args.include_specs:
        raw[Path("handbook/specification-unavailable.md")] = unavailable
    raw[Path("handbook/publication-notes.md")] = "# About this handbook edition\n\n> This is a published snapshot of the engineering handbook.\n\nLocal working notes, implementation records and draft proposals are not part of this edition. Links to those materials lead here. No repository access is required to read the handbook.\n\nRead the [handbook](README.md), browse the [repository catalogue](13-reference/repo-catalogue.md), or explore [architecture decisions](11-decisions/README.md).\n"
    anchors = {p: headings(value) for p, value in raw.items()}
    counts: Counter = Counter()

    def rewrite(src: Path, dst: Path, href: str, image: bool) -> str:
        if urlsplit(href).scheme or href.startswith('//'):
            return href
        file, _, fragment = href.partition('#')
        source_target = (src.parent / unquote(file)).resolve() if file else src.resolve()
        if file.endswith('/'):
            source_target /= 'README.md'
        mapped = mapping.get(source_target)
        if not mapped:
            if source_target == workspace / 'README.md':
                mapped, fragment = Path('handbook/13-reference/repo-catalogue.md'), ''
                counts['workspace_index_links'] += 1
            elif source_target.name == 'spec.md' and source_target in [p.resolve() for p in specs]:
                mapped, fragment = Path('handbook/specification-unavailable.md'), source_target.parent.name
                counts['unpublished_spec_links'] += 1
            elif source_target.is_relative_to(workspace / '.dev') or source_target.name in DENIED:
                mapped, fragment = Path('handbook/publication-notes.md'), ''
                counts['excluded_working_note_links'] += 1
            else:
                raise ValueError(f"Unallowlisted {'image' if image else 'link'} in {src.relative_to(workspace)}: {href}")
        if fragment and mapped in anchors and unquote(fragment) not in anchors[mapped]:
            raise ValueError(f"Missing anchor in {mapped}: {fragment}")
        counts['checked_source_links'] += 1
        relative = posixpath.relpath(mapped.as_posix(), dst.parent.as_posix())
        return relative + ('#' + fragment if fragment else '')

    for src in sources + (specs if args.include_specs else []):
        dst = mapping[src.resolve()]
        raw[dst] = transform_links(raw[dst], lambda h, i, src=src, dst=dst: rewrite(src, dst, h, i))

    # Publication-only correction: the source inventory predates implemented
    # services. Keep normative specs intact and identify development maturity.
    status = Path('handbook/13-reference/status.md')
    raw[status] = raw[status].replace(
        'Every repository is specified as a complete v1.0. Nothing here is implemented yet.',
        'Every repository is specified as a complete v1.0. This table records specification coverage, not implementation completeness.',
    )
    raw[status] = raw[status].replace('## Repositories',
        '**Publication note — October 2026:** The development tracker marks S0–S3 complete, with follow-up work still open. '
        'Authority services, confinement and durable coordination have development implementations and integration tests. '
        'The S3 loom proof uses a gate test double; the integrated workstation and release hardening are still ahead. '
        'The specification counts below are the source handbook’s inventory snapshot. '
        'See [development status](https://keylos-os.github.io/#status).\n\n## Repositories', 1)

    # The source nav is JSON, not executed. In handbook-only mode even private
    # specification heading metadata is omitted from the publication.
    nav_source = text(docs / 'nav.js')
    match = re.search(r'window\.KEYLOS_NAV\s*=\s*(\[.*\]);\s*$', nav_source, re.S)
    if not match:
        raise ValueError('Unrecognized nav.js format')
    nav = []
    for section in json.loads(match[1]):
        pages = []
        for page in section['pages']:
            target = mapping.get((docs / page['path']).resolve())
            if target and target in raw:
                pages.append({**page, 'path': posixpath.relpath(target.as_posix(), 'handbook')})
        if pages:
            nav.append({**section, 'pages': pages})
    nav.append({'title': 'Publication', 'pages': [
        {'title': 'About this edition', 'path': 'publication-notes.md', 'headings': []},
        *([] if args.include_specs else [{'title': 'Specifications', 'path': 'specification-unavailable.md', 'headings': []}]),
    ]})
    published = {'pages': sorted(posixpath.relpath(p.as_posix(), 'handbook') for p in raw),
                 'assets': sorted(posixpath.relpath(mapping[p.resolve()].as_posix(), 'handbook') for p in assets)}
    html = text(docs / 'index.html').split('<script>\n', 1)[0]
    html = html.replace('<title>keylos handbook</title>', '<title>keylos engineering handbook</title>\n<meta name="description" content="The keylos engineering handbook: architecture, capabilities, agents, integrity and state.">\n<link rel="icon" href="../assets/keylos-mark.png">')
    html = html.replace('<div class="brand">', '<div class="brand"><a href="../">← keylos</a></div>\n    <div class="brand">', 1)
    html = html.replace('id="q" type="search"', 'id="q" aria-label="Search handbook titles and headings" type="search"')
    html = html.replace('<nav id="nav">', '<nav id="nav" aria-label="Handbook sections">')
    html = html.replace('<main>', '<main id="main" tabindex="-1">\n    <p class="edition">Design &amp; specification handbook · Early development · <a href="../#status">Implementation status</a></p>')
    html = html.replace('<body>', '<body>\n<a class="skip" href="#main">Skip to content</a>')
    html = html.replace('</style>', '.edition { color: var(--muted); font-size: 13px; } .edition a { color: var(--link); }\n'
        '.layout, aside, main, .content { min-width: 0; }\n'
        '.content { overflow-wrap: anywhere; }\n'
        '.content pre, .content .table { max-width: 100%; overflow-x: auto; }\n'
        '.content pre, .content table { overflow-wrap: normal; }\n'
        '.content pre code { white-space: pre; }\n'
        '@media (max-width: 860px) { .layout { grid-template-columns: minmax(0, 1fr); } aside { overflow-wrap: anywhere; } }\n'
        '.skip { position:absolute; left:-9999px; } .skip:focus { left:16px; top:8px; z-index:10; padding:8px; background:var(--bg); }\n'
        ':focus-visible { outline: 2px solid var(--link); outline-offset: 3px; }\n</style>')
    # The skip link focuses the main landmark without changing the reader route.
    html = html.replace('href="#main"', 'href="#main" onclick="event.preventDefault(); document.getElementById(\'main\').focus();"')
    html = html.replace('<script src="nav.js"></script>', '<script src="nav.js"></script>\n<script src="published.js"></script>')
    html += '<script src="reader.js"></script>\n</body>\n</html>\n'

    # Validate generated links too, including the edition notice pages.
    image_targets = {mapping[p.resolve()] for p in assets}
    for dst, value in raw.items():
        def validate(href, image):
            if urlsplit(href).scheme or href.startswith('//'):
                return href
            file, _, fragment = href.partition('#')
            target = Path(posixpath.normpath(posixpath.join(dst.parent.as_posix(), unquote(file)))) if file else dst
            if target not in (image_targets if image else raw):
                raise ValueError(f'Broken published link in {dst}: {href}')
            if fragment and target in anchors and unquote(fragment) not in anchors[target]:
                raise ValueError(f'Broken published anchor in {dst}: {href}')
            counts['validated_published_links'] += 1
            return href
        transform_links(value, validate)

    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='keylos-handbook-') as temporary:
        stage = Path(temporary)
        files = {**{p: v.encode() for p, v in raw.items()},
                 Path('handbook/index.html'): html.encode(),
                 Path('handbook/reader.js'): READER_JS.strip().encode() + b'\n',
                 Path('handbook/nav.js'): ('// Generated by scripts/build-handbook.py.\nwindow.KEYLOS_NAV = ' + json.dumps(nav, ensure_ascii=False, indent=1) + ';\n').encode(),
                 Path('handbook/published.js'): ('window.KEYLOS_PUBLISHED = ' + json.dumps(published, ensure_ascii=False, indent=1) + ';\n').encode(),
                 Path('handbook/vendor/md.js'): text(docs / 'vendor/md.js').encode()}
        files.update({mapping[p.resolve()]: text(p).encode() for p in assets})
        manifest = {'format': 1, 'includeSpecs': args.include_specs,
                    'handbookPages': len(sources), 'specificationPages': len(specs) if args.include_specs else 0,
                    'images': len(assets), 'validation': dict(sorted(counts.items())),
                    'files': {p.as_posix(): hashlib.sha256(b).hexdigest() for p, b in sorted(files.items())}}
        files[Path('handbook/build-manifest.json')] = (json.dumps(manifest, indent=2) + '\n').encode()
        for path, data in files.items():
            target = stage / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        for name in ('handbook', 'specs'):
            target = stage / name
            if target.exists():
                (target / MARKER).write_text('Managed by scripts/build-handbook.py\n')
            old = output / name
            if old.exists():
                shutil.rmtree(old)
            if target.exists():
                shutil.move(str(target), str(old))
    print(json.dumps({k: v for k, v in manifest.items() if k != 'files'}, indent=2))


if __name__ == '__main__':
    main()
