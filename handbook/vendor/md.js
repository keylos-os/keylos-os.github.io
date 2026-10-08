/* keylos handbook — minimal Markdown renderer (CommonMark subset + GFM tables).
 * Supports: ATX headings with GitHub-style anchors, paragraphs, emphasis, strong, inline code,
 * links, images, fenced code blocks, blockquotes, ordered/unordered lists (nested by indent),
 * tables with alignment, horizontal rules, hard breaks via trailing double space.
 * No external dependencies. Exposes window.KeylosMd.render(src, opts) and slug(text).
 */
(function () {
  'use strict';

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // GitHub-compatible heading slug: lowercase, drop punctuation except '-' and '_', spaces → '-'.
  function slug(text) {
    return text
      .replace(/<[^>]+>/g, '')
      .replace(/`/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
  }

  function inline(s, opts) {
    // protect code spans first
    var codes = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = esc(s);
    // images
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, function (_, alt, src, title) {
      var u = opts.resolve ? opts.resolve(src, 'img') : src;
      return '<img src="' + u + '" alt="' + alt + '"' + (title ? ' title="' + title + '"' : '') + ' loading="lazy">';
    });
    // links
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, text, href) {
      var u = opts.resolve ? opts.resolve(href, 'link') : href;
      var ext = /^https?:/.test(href) ? ' target="_blank" rel="noopener"' : '';
      return '<a href="' + u + '"' + ext + '>' + text + '</a>';
    });
    // autolinks
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/ {2}$/g, '<br>');
    s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return '<code>' + esc(codes[+i]) + '</code>'; });
    return s;
  }

  function splitRow(line) {
    var t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    var cells = [], cur = '', inCode = false;
    for (var i = 0; i < t.length; i++) {
      var ch = t[i];
      if (ch === '`') inCode = !inCode;
      if (ch === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
      if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  }

  function render(src, opts) {
    opts = opts || {};
    var lines = src.replace(/\r\n?/g, '\n').split('\n');
    var out = [], i = 0, headings = [], used = {};

    function headingId(text) {
      var base = slug(text), id = base, k = 1;
      while (used[id]) { id = base + '-' + k++; }
      used[id] = true;
      return id;
    }

    function isBlockStart(l) {
      return /^(#{1,6})\s/.test(l) || /^\s*```/.test(l) || /^>\s?/.test(l) || /^\s*([-*+]|\d+[.)])\s+/.test(l) ||
        /^\s*\|/.test(l) || /^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(l.trim());
    }

    function list(start) {
      var m0 = lines[start].match(/^(\s*)([-*+]|\d+[.)])\s+/);
      var indent = m0[1].length, ordered = /\d/.test(m0[2]);
      var items = [], j = start;
      while (j < lines.length) {
        var l = lines[j];
        var m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m && m[1].length === indent && (/\d/.test(m[2]) === ordered)) {
          items.push({ text: [m[3]], sub: [] });
          j++;
          continue;
        }
        if (m && m[1].length > indent && items.length) {
          var r = list(j);
          items[items.length - 1].sub.push(r.html);
          j = r.next;
          continue;
        }
        if (l.trim() !== '' && /^\s+\S/.test(l) && items.length && !m) {
          items[items.length - 1].text.push(l.trim());
          j++;
          continue;
        }
        if (l.trim() === '' && j + 1 < lines.length && /^\s+([-*+]|\d+[.)])\s+/.test(lines[j + 1]) &&
            lines[j + 1].match(/^(\s*)/)[1].length >= indent && items.length) { j++; continue; }
        break;
      }
      var tag = ordered ? 'ol' : 'ul';
      var html = '<' + tag + '>' + items.map(function (it) {
        return '<li>' + inline(it.text.join(' '), opts) + it.sub.join('') + '</li>';
      }).join('') + '</' + tag + '>';
      return { html: html, next: j };
    }

    while (i < lines.length) {
      var line = lines[i];
      if (line.trim() === '') { i++; continue; }

      var fence = line.match(/^\s*```\s*([\w+-]*)/);
      if (fence) {
        var buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push('<pre><code' + (fence[1] ? ' class="lang-' + fence[1] + '"' : '') + '>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }

      var h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        var lvl = h[1].length, id = headingId(h[2]);
        headings.push({ level: lvl, text: h[2].replace(/`/g, ''), id: id });
        out.push('<h' + lvl + ' id="' + id + '">' + inline(h[2], opts) +
          ' <a class="anchor" href="' + (opts.anchorHref ? opts.anchorHref(id) : '#' + id) + '">#</a></h' + lvl + '>');
        i++;
        continue;
      }

      if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(line.trim())) { out.push('<hr>'); i++; continue; }

      if (/^>\s?/.test(line)) {
        var q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
        out.push('<blockquote>' + render(q.join('\n'), Object.assign({}, opts, { nested: true })).html + '</blockquote>');
        continue;
      }

      if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        var head = splitRow(line);
        var aligns = splitRow(lines[i + 1]).map(function (c) {
          c = c.trim();
          return c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '';
        });
        i += 2;
        var rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
        function cell(tag, c, k) {
          return '<' + tag + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + inline(c, opts) + '</' + tag + '>';
        }
        out.push('<div class="table"><table><thead><tr>' + head.map(function (c, k) { return cell('th', c, k); }).join('') +
          '</tr></thead><tbody>' + rows.map(function (r) {
            return '<tr>' + head.map(function (_, k) { return cell('td', r[k] || '', k); }).join('') + '</tr>';
          }).join('') + '</tbody></table></div>');
        continue;
      }

      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        var r = list(i);
        out.push(r.html);
        i = r.next;
        continue;
      }

      var para = [];
      while (i < lines.length && lines[i].trim() !== '' && (para.length === 0 || !isBlockStart(lines[i]))) {
        para.push(lines[i]);
        i++;
      }
      out.push('<p>' + inline(para.join('\n'), opts).replace(/\n/g, ' ') + '</p>');
    }
    return { html: out.join('\n'), headings: headings };
  }

  window.KeylosMd = { render: render, slug: slug };
})();
