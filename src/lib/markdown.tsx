/**
 * A hand-rolled renderer for the small subset of Markdown the walkthroughs in
 * docs/walkthroughs/ actually use (headings, paragraphs, bold/italic/code/
 * links, fenced code blocks, bullet lists, pipe tables). Not a general
 * Markdown implementation — see WALKTHROUGH_FORMAT.md for what is in scope.
 */
import type { ReactNode } from 'react';

let key = 0;

const INLINE = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)\s]+)\)/;

/** Bold, italic, inline code and links inside one line of prose. */
function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      nodes.push(rest);
      break;
    }
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    if (m[1] !== undefined) nodes.push(<code key={key++}>{m[1]}</code>);
    else if (m[2] !== undefined) nodes.push(<strong key={key++}>{m[2]}</strong>);
    else if (m[3] !== undefined) nodes.push(<em key={key++}>{m[3]}</em>);
    else if (m[4] !== undefined) {
      const href = m[5];
      const external = /^https?:/.test(href);
      nodes.push(
        <a key={key++} href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}>
          {m[4]}
        </a>,
      );
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return nodes;
}

function isTableRule(line: string): boolean {
  return /^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

function tableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** Renders a walkthrough body (front matter already stripped) to React nodes. The `# ` title is skipped; render it yourself. */
export function renderMarkdown(md: string): ReactNode[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  const endParagraph = () => {
    if (para.length) blocks.push(<p key={key++}>{inline(para.join(' '))}</p>);
    para = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      endParagraph();
      i++;
      continue;
    }

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      endParagraph();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '```') {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <pre key={key++} className="code-block">
          {codeLines.join('\n')}
        </pre>,
      );
      continue;
    }

    const heading = /^(#{2,4})\s+(.*)$/.exec(line);
    if (heading) {
      endParagraph();
      const level = heading[1].length;
      const text = inline(heading[2].trim());
      i++;
      blocks.push(level === 2 ? <h2 key={key++}>{text}</h2> : level === 3 ? <h3 key={key++}>{text}</h3> : <h4 key={key++}>{text}</h4>);
      continue;
    }
    if (/^#\s+/.test(line)) {
      // The `# ` title is rendered by the caller (the walkthrough's modal header).
      i++;
      continue;
    }

    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      endParagraph();
      const header = tableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        rows.push(tableRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={key++} className="wt-table-wrap">
          <table className="wt-table">
            <thead>
              <tr>
                {header.map((h, hi) => (
                  <th key={hi}>{inline(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^-\s+/.test(line)) {
      endParagraph();
      const items: string[] = [];
      while (i < lines.length && (/^-\s+/.test(lines[i]) || (lines[i].startsWith('  ') && items.length && lines[i].trim() !== ''))) {
        if (/^-\s+/.test(lines[i])) items.push(lines[i].replace(/^-\s+/, ''));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      blocks.push(
        <ul key={key++}>
          {items.map((it, ii) => (
            <li key={ii}>{inline(it)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    para.push(line.trim());
    i++;
  }
  endParagraph();
  return blocks;
}
