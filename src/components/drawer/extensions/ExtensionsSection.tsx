import { useMemo, useState, useSyncExternalStore } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Plus, Puzzle, Trash2 } from 'lucide-react';
import { dialectLabel, type DiagramExtension } from '@shared/types';
import { useStore } from '@/store/useStore';
import {
  diagramText,
  extensionCatalogVersion,
  extensionDefs,
  extensionIsUsed,
  extensionLabel,
  findExtensionDef,
  subscribeToExtensionCatalog,
} from '@/lib/extensions/registry';
import { extensionInstallPlan } from '@/lib/sql/generator';
import { confirmDialog } from '../../ui/Modal';
import { ExtensionSources } from './ExtensionSources';
import '@/styles/extensions.css';

/**
 * Re-render whenever the merged catalog changes — a pack loaded or dropped, or
 * definitions read off a server. The version number is the snapshot because the
 * catalog itself is rebuilt into new objects on every read.
 */
export function useExtensionCatalog(): number {
  return useSyncExternalStore(subscribeToExtensionCatalog, extensionCatalogVersion, extensionCatalogVersion);
}

function Chips({ label, items, title }: { label: string; items: string[]; title?: string }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, 12);
  return (
    <div className="ext-chips" title={title}>
      <span className="ext-chips__label">{label}</span>
      <span className="chip-list">
        {shown.map((t) => (
          <span key={t} className="chip">
            {t}
          </span>
        ))}
        {items.length > shown.length && <span className="chip">+{items.length - shown.length} more</span>}
      </span>
    </div>
  );
}

function ExtensionCard({ e, usageText }: { e: DiagramExtension; usageText: string }) {
  const dialect = useStore((s) => s.diagram.dialect);
  const diagram = useStore((s) => s.diagram);
  const updateExtension = useStore((s) => s.updateExtension);
  const deleteExtension = useStore((s) => s.deleteExtension);
  useExtensionCatalog();
  const [open, setOpen] = useState(false);

  const def = findExtensionDef(e.name, dialect);
  const used = def ? extensionIsUsed(diagram, def, usageText) : true;
  const plan = extensionInstallPlan(dialect, e);

  const onDelete = async () => {
    const ok = await confirmDialog({
      title: `Stop depending on "${e.name}"?`,
      message: used
        ? 'Something in this diagram appears to use it, so the generated SQL may stop working. This can be undone with Ctrl+Z.'
        : 'This can be undone with Ctrl+Z.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) deleteExtension(e.id);
  };

  return (
    <div className="list-item">
      <div className="row">
        <button className="icon-btn" onClick={() => setOpen((o) => !o)} title={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDown /> : <ChevronRight />}
        </button>
        <span className="faint" title="Extension">
          <Puzzle size={14} />
        </span>
        <span className="ext-name grow" title={def?.summary}>
          {e.name}
          {def && def.label && def.label !== e.name && <span className="faint small"> — {def.label}</span>}
        </span>
        {e.version && <span className="badge">v{e.version}</span>}
        {!def && (
          <span className="badge badge--warn" title="Nothing here defines this extension, so it gets no autocomplete or checks. The generated SQL is unaffected.">
            no definition
          </span>
        )}
        {def?.source === 'database' && (
          <span className="badge badge--success" title="Read off the connected server, so this is exactly what that server provides.">
            from server
          </span>
        )}
        {def?.source === 'pack' && (
          <span className="badge badge--accent" title="From a definition pack you loaded.">
            pack
          </span>
        )}
        {def && !used && (
          <span className="badge badge--warn" title="Nothing in this diagram uses the types or functions it provides.">
            unused
          </span>
        )}
        <button className="icon-btn icon-btn--danger" onClick={onDelete} title="Remove this extension">
          <Trash2 />
        </button>
      </div>

      {open && (
        <div className="ext-detail">
          {def?.summary && <div className="small muted">{def.summary}</div>}
          <div className="row row--wrap">
            <label className="field field--tight">
              <span className="field__label">Version</span>
              <input
                className="input input--sm input--mono"
                value={e.version ?? ''}
                placeholder="server default"
                spellCheck={false}
                onChange={(ev) => updateExtension(e.id, { version: ev.target.value.trim() || undefined })}
              />
            </label>
            {dialect === 'postgresql' && (
              <label className="field field--tight">
                <span className="field__label">Schema</span>
                <input
                  className="input input--sm input--mono"
                  value={e.schema ?? ''}
                  placeholder="server default"
                  spellCheck={false}
                  onChange={(ev) => updateExtension(e.id, { schema: ev.target.value.trim() || undefined })}
                />
              </label>
            )}
          </div>
          <label className="field field--full">
            <span className="field__label">Why this schema needs it</span>
            <input
              className="input input--sm"
              value={e.comment ?? ''}
              placeholder="e.g. embeddings on documents.body_vector"
              onChange={(ev) => updateExtension(e.id, { comment: ev.target.value || undefined })}
            />
          </label>

          <Chips label="Types" items={(def?.types ?? []).map((t) => t.example ?? t.name)} title="Offered in every column's TYPE box." />
          <Chips label="Functions" items={(def?.functions ?? []).map((f) => f.name)} />
          <Chips label="Index methods" items={def?.indexMethods ?? []} title="USING <method> on a CREATE INDEX." />
          <Chips label="Operator classes" items={def?.operatorClasses ?? []} />
          {def?.requires?.length ? <Chips label="Needs first" items={def.requires} /> : null}

          {def?.note && <div className="field__hint">{def.note}</div>}
          {/* Exactly what the script will contain: the generator answers, so the two cannot disagree. */}
          <div className="ext-sql">{[...plan.statements, ...plan.comments].join("\n") || "Nothing is generated for this one."}</div>
          {plan.warning && <div className="field__hint">{plan.warning}</div>}
          {def?.docsUrl && (
            <a className="link-btn small" href={def.docsUrl} target="_blank" rel="noreferrer noopener">
              Documentation <ExternalLink size={12} />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/** The picker: type any name, or take one from what the catalog knows for this engine. */
function AddExtension() {
  const dialect = useStore((s) => s.diagram.dialect);
  const extensions = useStore((s) => s.diagram.extensions);
  const addExtension = useStore((s) => s.addExtension);
  const toast = useStore((s) => s.toast);
  useExtensionCatalog();
  const [name, setName] = useState('');

  const enabled = useMemo(() => new Set(extensions.map((e) => e.name.toLowerCase())), [extensions]);
  const catalog = useMemo(() => extensionDefs(dialect).filter((d) => !enabled.has(d.name.toLowerCase())), [dialect, enabled]);
  // A handful of one-click suggestions; the rest are in the autocomplete.
  const suggestions = catalog.slice(0, 8);

  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (enabled.has(trimmed.toLowerCase())) {
      toast('info', `${trimmed} is already enabled.`);
      return;
    }
    addExtension(trimmed);
    setName('');
  };

  return (
    <div className="section">
      <div className="row">
        <input
          className="input input--sm input--mono grow"
          value={name}
          list={`extensions-${dialect}`}
          placeholder={dialect === 'mariadb' ? 'plugin library, e.g. ha_connect' : 'extension name, e.g. vector'}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(name);
            }
          }}
        />
        <button className="btn btn--sm" onClick={() => add(name)} disabled={!name.trim()}>
          <Plus /> Add
        </button>
      </div>
      <datalist id={`extensions-${dialect}`}>
        {catalog.map((d) => (
          <option key={d.name} value={d.name}>
            {d.summary ?? extensionLabel(d)}
          </option>
        ))}
      </datalist>
      {suggestions.length > 0 && (
        <div className="chip-list" style={{ marginTop: 6 }}>
          {suggestions.map((d) => (
            <button key={d.name} className="chip" title={d.summary} onClick={() => add(d.name)}>
              + {d.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Extensions the schema depends on. Lives beside custom types because both
 * answer the same question — what a column is allowed to be — one from inside
 * the diagram and one from the engine.
 */
export function ExtensionsSection() {
  const dialect = useStore((s) => s.diagram.dialect);
  const diagram = useStore((s) => s.diagram);
  const extensions = diagram.extensions;
  // Scanning the whole diagram for names an extension provides is the expensive
  // part of "is this one used?", so every card shares one scan.
  const usageText = useMemo(() => diagramText(diagram), [diagram]);

  return (
    <div className="ext-section">
      <div className="drawer__toolbar">
        <h3 style={{ margin: 0 }}>Extensions</h3>
        <span className="grow" />
        <span className="faint small">{dialectLabel(dialect)}</span>
      </div>
      <div className="small muted" style={{ marginBottom: 10 }}>
        What the engine has to have loaded before this schema will run: PostGIS for a <code>geometry</code> column, pgvector for an embedding, pg_trgm for a
        fuzzy-search index. Declaring one puts <code>CREATE EXTENSION</code> at the top of the generated SQL, offers its types in every column's TYPE box, and
        lets Problems tell you when a column needs an extension you have not enabled. The diagram stores only the name — the definitions live outside it, so a
        file you share stays small and still opens for someone who has never heard of the extension.
      </div>

      <AddExtension />

      {extensions.length === 0 ? (
        <div className="faint small">No extensions yet — this schema uses only what the engine has out of the box.</div>
      ) : (
        <div className="ext-list">
          {extensions.map((e) => (
            <ExtensionCard key={e.id} e={e} usageText={usageText} />
          ))}
        </div>
      )}

      <ExtensionSources />
    </div>
  );
}
