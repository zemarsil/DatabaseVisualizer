import { useMemo, useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { selectSelectedTable, useStore } from '@/store/useStore';
import { generateDropStatements, generateSchema, generateTableSql } from '@/lib/sql/generator';
import { downloadText, fileSlug } from '@/lib/io';
import { DIALECTS } from '@shared/types';

export function SqlPanel() {
  const diagram = useStore((s) => s.diagram);
  const selected = useStore(selectSelectedTable);
  const toast = useStore((s) => s.toast);
  const [scope, setScope] = useState<'schema' | 'table'>('schema');
  const [withDrops, setWithDrops] = useState(false);

  const effectiveScope = scope === 'table' && selected ? 'table' : 'schema';
  const generated = useMemo(() => generateSchema(diagram), [diagram]);
  const text = useMemo(() => {
    if (effectiveScope === 'table' && selected) return generateTableSql(diagram, selected.id);
    const drops = withDrops ? generateDropStatements(diagram).join('\n') + '\n\n' : '';
    return drops + generated.script;
  }, [effectiveScope, selected, diagram, generated, withDrops]);

  const dialect = DIALECTS.find((d) => d.id === diagram.dialect)?.label ?? diagram.dialect;

  return (
    <>
      <div className="drawer__toolbar">
        <div className="row">
          <button className={`btn btn--sm${effectiveScope === 'schema' ? ' btn--active' : ''}`} onClick={() => setScope('schema')}>
            Whole schema
          </button>
          <button className={`btn btn--sm${effectiveScope === 'table' ? ' btn--active' : ''}`} onClick={() => setScope('table')} disabled={!selected} title={selected ? '' : 'Select a table first'}>
            {selected ? `Table: ${selected.name}` : 'Selected table'}
          </button>
        </div>
        {effectiveScope === 'schema' && (
          <label className="checkbox small">
            <input type="checkbox" checked={withDrops} onChange={(e) => setWithDrops(e.target.checked)} /> Prefix DROP TABLE statements
          </label>
        )}
        <span className="grow" />
        <span className="badge">{dialect}</span>
        <span className="muted small">
          {generated.statements.length} statements
        </span>
        <button
          className="btn btn--sm"
          onClick={() => {
            void navigator.clipboard.writeText(text);
            toast('success', 'SQL copied to the clipboard.');
          }}
        >
          <Copy /> Copy
        </button>
        <button className="btn btn--sm" onClick={() => downloadText(`${fileSlug(diagram.name)}.sql`, text, 'text/sql')}>
          <Download /> Download .sql
        </button>
      </div>
      {generated.warnings.length > 0 && (
        <ul className="msg-list" style={{ marginBottom: 8 }}>
          {generated.warnings.map((w, i) => (
            <li key={i} className="warn">
              ⚠ {w}
            </li>
          ))}
        </ul>
      )}
      <pre className="code-block code-block--fill">{text || '-- Add a table to see its CREATE TABLE statement here.'}</pre>
    </>
  );
}
