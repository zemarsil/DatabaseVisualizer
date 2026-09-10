import { useMemo, useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { selectSelectedTable, useStore } from '@/store/useStore';
import { generateDropStatements, generateSchema, generateTableSql } from '@/lib/sql/generator';
import { downloadText } from '@/lib/io';
import { EXPORT_FORMATS, exportDiagram, type ExportFormat } from '@/lib/export';
import { DIALECTS } from '@shared/types';
import { diagramScope } from '@/lib/sqlScope';
import { SqlCode } from '../ui/SqlEditor';

export function SqlPanel() {
  const diagram = useStore((s) => s.diagram);
  const selected = useStore(selectSelectedTable);
  const toast = useStore((s) => s.toast);
  const [scope, setScope] = useState<'schema' | 'table'>('schema');
  const [withDrops, setWithDrops] = useState(false);
  const [format, setFormat] = useState<ExportFormat>('sql');

  const isSql = format === 'sql';
  const effectiveScope = isSql && scope === 'table' && selected ? 'table' : 'schema';
  const generated = useMemo(() => generateSchema(diagram), [diagram]);
  const sqlScope = useMemo(() => diagramScope(diagram), [diagram]);
  const exported = useMemo(() => (isSql ? null : exportDiagram(diagram, format)), [diagram, format, isSql]);
  const text = useMemo(() => {
    if (exported) return exported.text;
    if (effectiveScope === 'table' && selected) return generateTableSql(diagram, selected.id);
    const drops = withDrops ? generateDropStatements(diagram).join('\n') + '\n\n' : '';
    return drops + generated.script;
  }, [exported, effectiveScope, selected, diagram, generated, withDrops]);

  const dialect = DIALECTS.find((d) => d.id === diagram.dialect)?.label ?? diagram.dialect;
  const meta = EXPORT_FORMATS.find((f) => f.id === format)!;
  const filename = exported ? exported.filename : exportDiagram(diagram, 'sql').filename;

  return (
    <>
      <div className="drawer__toolbar">
        <select className="select select--sm" value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)} title="Output format">
          {EXPORT_FORMATS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        {isSql && (
          <div className="row">
            <button className={`btn btn--sm${effectiveScope === 'schema' ? ' btn--active' : ''}`} onClick={() => setScope('schema')}>
              Whole schema
            </button>
            <button className={`btn btn--sm${effectiveScope === 'table' ? ' btn--active' : ''}`} onClick={() => setScope('table')} disabled={!selected} title={selected ? '' : 'Select a table first'}>
              {selected ? `Table: ${selected.name}` : 'Selected table'}
            </button>
          </div>
        )}
        {isSql && effectiveScope === 'schema' && (
          <label className="checkbox small">
            <input type="checkbox" checked={withDrops} onChange={(e) => setWithDrops(e.target.checked)} /> Prefix DROP TABLE statements
          </label>
        )}
        <span className="grow" />
        <span className="badge">{isSql ? dialect : meta.label}</span>
        {isSql && <span className="muted small">{generated.statements.length} statements</span>}
        <button
          className="btn btn--sm"
          onClick={() => {
            void navigator.clipboard.writeText(text);
            toast('success', `${isSql ? 'SQL' : meta.label} copied to the clipboard.`);
          }}
        >
          <Copy /> Copy
        </button>
        <button className="btn btn--sm" onClick={() => downloadText(filename, text, meta.mime)}>
          <Download /> Download .{meta.extension}
        </button>
      </div>
      {isSql && generated.warnings.length > 0 && (
        <ul className="msg-list" style={{ marginBottom: 8 }}>
          {generated.warnings.map((w, i) => (
            <li key={i} className="warn">
              ⚠ {w}
            </li>
          ))}
        </ul>
      )}
      {!isSql && meta.hint && (
        <div className="small muted" style={{ marginBottom: 6 }}>
          {meta.hint}
        </div>
      )}
      {isSql ? (
        <SqlCode sql={text || '-- Add a table to see its CREATE TABLE statement here.'} scope={sqlScope} className="code-block--fill" />
      ) : (
        <pre className="code-block code-block--fill">{text}</pre>
      )}
    </>
  );
}
