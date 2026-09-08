/**
 * Markdown -> HTML for the clipboard's rich-text flavor.
 *
 * Editors that accept rich text (Obsidian, Notion, Google Docs, a mail client)
 * read `text/html` and convert it back into their own markup, so putting the
 * data dictionary on the clipboard as HTML is what makes it arrive in Obsidian
 * as a Markdown table. Plain-text targets never see this flavor; they get the
 * SQL instead.
 *
 * Like src/lib/markdown.tsx this is not a general Markdown implementation: it
 * covers exactly what markdownExport.ts emits (ATX headings, pipe tables,
 * fenced code, bullet lists, paragraphs, and inline code/bold/italic/links).
 */

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function attr(v: string): string {
  return esc(v).replace(/"/g, '&quot;');
}

/** Table cells arrive with their pipes backslash-escaped; HTML needs them plain. */
function unescapePipes(v: string): string {
  return v.replace(/\\\|/g, '|');
}

// The underscore rule only fires at word boundaries: column names such as
// `customer_id | order_id` must not turn into one italic run.
const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])|\[([^\]]+)\]\(([^)\s]+)\)/;

function inline(text: string): string {
  let out = '';
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out += esc(rest);
      break;
    }
    out += esc(rest.slice(0, m.index));
    if (m[1] !== undefined) out += `<code>${esc(m[1])}</code>`;
    else if (m[2] !== undefined) out += `<strong>${inline(m[2])}</strong>`;
    else if (m[3] !== undefined) out += `<em>${inline(m[3])}</em>`;
    else if (m[4] !== undefined) out += `<em>${inline(m[4])}</em>`;
    // A same-page anchor means nothing once the HTML is on the clipboard, and
    // the browser rewrites it to about:blank#… on the way; keep just the label.
    else if (m[6].startsWith('#')) out += inline(m[5]);
    else out += `<a href="${attr(m[6])}">${inline(m[5])}</a>`;
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/** Split a table row on unescaped pipes, dropping the leading and trailing one. */
function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const out: string[] = [];
  let cell = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      cell += '\\|';
      i++;
    } else if (ch === '|') {
      out.push(cell.trim());
      cell = '';
    } else {
      cell += ch;
    }
  }
  out.push(cell.trim());
  return out.map(unescapePipes);
}

function isRule(line: string): boolean {
  return /^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];

  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      const lang = fence[1] ? ` class="language-${attr(fence[1])}"` : '';
      out.push(`<pre><code${lang}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isRule(lines[i + 1])) {
      flush();
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      const thead = `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`;
      const tbody = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table>${thead}<tbody>${tbody}</tbody></table>`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
      continue;
    }

    if (!line.trim()) {
      flush();
      i++;
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flush();
  return out.join('\n');
}
