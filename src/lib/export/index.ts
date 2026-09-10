import type { Diagram } from '@shared/types';
import { fileSlug } from '../io';
import { generateMarkdown } from '../markdownExport';
import { generateSchema } from '../sql/generator';
import { exportDbml } from './dbml';
import { exportMermaid } from './mermaid';

export type ExportFormat = 'sql' | 'mermaid' | 'dbml' | 'markdown';

export interface ExportFormatMeta {
  id: ExportFormat;
  label: string;
  extension: string;
  mime: string;
  hint?: string;
}

export const EXPORT_FORMATS: ExportFormatMeta[] = [
  {
    id: 'sql',
    label: 'SQL script',
    extension: 'sql',
    mime: 'text/sql',
    hint: 'Carries the connections SQL cannot express — data flows, serialized copies, dependencies and the query tagged on each one — as comments at the end, so Import SQL brings them back.',
  },
  { id: 'mermaid', label: 'Mermaid ER diagram', extension: 'mmd', mime: 'text/plain', hint: 'Paste into a GitHub README inside a ```mermaid fence, or into mermaid.live.' },
  { id: 'dbml', label: 'DBML', extension: 'dbml', mime: 'text/plain', hint: 'Opens in dbdiagram.io and dbdocs.' },
  { id: 'markdown', label: 'Markdown data dictionary', extension: 'md', mime: 'text/markdown', hint: 'A README-ready reference with one section per table.' },
];

export interface ExportOutput {
  text: string;
  filename: string;
  mime: string;
  warnings: string[];
}

export function exportDiagram(d: Diagram, format: ExportFormat): ExportOutput {
  const meta = EXPORT_FORMATS.find((f) => f.id === format) ?? EXPORT_FORMATS[0];
  const filename = `${fileSlug(d.name)}.${meta.extension}`;
  switch (meta.id) {
    case 'mermaid':
      return { text: exportMermaid(d), filename, mime: meta.mime, warnings: [] };
    case 'dbml':
      return { text: exportDbml(d), filename, mime: meta.mime, warnings: [] };
    case 'markdown':
      return { text: generateMarkdown(d), filename, mime: meta.mime, warnings: [] };
    default: {
      const out = generateSchema(d);
      return { text: out.script, filename, mime: meta.mime, warnings: out.warnings };
    }
  }
}
