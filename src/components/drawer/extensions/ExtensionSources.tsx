import { useMemo, useRef, useState } from 'react';
import { CloudDownload, Download, FileJson, Link2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { isServerDialect } from '@shared/types';
import { useStore } from '@/store/useStore';
import { useConnection } from '@/store/useConnection';
import { backendFor } from '@/lib/backend';
import { downloadText } from '@/lib/io';
import { definitionsFromDatabase, packFromDatabase } from '@/lib/extensions/fromDatabase';
import { parseExtensionPack, serializeExtensionPack, type ExtensionPack } from '@/lib/extensions/packs';
import { addExtensionPack, dropExtensionPack, extensionPacks, setLearnedExtensions } from '@/lib/extensions/registry';
import { confirmDialog } from '../../ui/Modal';
import { useExtensionCatalog } from './ExtensionsSection';

/** A URL a browser can actually fetch: anything else fails later with a confusing CORS error. */
function validUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Where definitions come from, and what has been loaded.
 *
 * Three ways in, in increasing order of how much they can be trusted:
 * a JSON pack from disk, the same from a URL, and reading the connected server's
 * own catalogs — which is the only one that describes the server the schema will
 * actually run on, and so is the only one that overrides everything else.
 */
export function ExtensionSources() {
  const dialect = useStore((s) => s.diagram.dialect);
  const toast = useStore((s) => s.toast);
  const addExtension = useStore((s) => s.addExtension);
  const enabled = useStore((s) => s.diagram.extensions);
  const conn = useConnection((s) => s.conn);
  const backend = useMemo(() => backendFor(conn), [conn]);
  useExtensionCatalog();

  const fileInput = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [found, setFound] = useState<{ label: string; installed: string[]; available: string[]; note?: string } | null>(null);
  const [open, setOpen] = useState(false);

  const packs = extensionPacks();
  const enabledNames = useMemo(() => new Set(enabled.map((e) => e.name.toLowerCase())), [enabled]);

  const acceptPack = (json: string, origin: string) => {
    const { pack, errors, warnings } = parseExtensionPack(json, { origin });
    if (!pack) {
      toast('error', errors[0] ?? 'That file is not an extension pack.');
      return;
    }
    addExtensionPack(pack);
    for (const w of warnings.slice(0, 2)) toast('info', w);
    const forThis = pack.extensions.filter((d) => d.dialect === dialect).length;
    toast(
      'success',
      `Loaded ${pack.extensions.length} definition${pack.extensions.length === 1 ? '' : 's'} from ${pack.name}` +
        (forThis === pack.extensions.length ? '.' : `, ${forThis} of them for ${dialect}.`),
    );
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    acceptPack(await f.text(), f.name);
  };

  const loadUrl = async () => {
    const parsed = validUrl(url);
    if (!parsed) {
      toast('error', 'Enter an http:// or https:// URL pointing at a pack file.');
      return;
    }
    setBusy('url');
    try {
      const res = await fetch(parsed.toString(), { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`The server answered ${res.status} ${res.statusText}.`);
      acceptPack(await res.text(), parsed.hostname + parsed.pathname);
      setUrl('');
    } catch (err) {
      // A cross-origin fetch the host does not allow fails without a usable
      // reason, so say what actually works instead of repeating the browser.
      toast(
        'error',
        `Could not fetch that URL: ${err instanceof Error ? err.message : String(err)} — the host has to allow cross-origin reads (raw.githubusercontent.com does). Otherwise download the file and load it from disk.`,
      );
    } finally {
      setBusy(null);
    }
  };

  const readFromDatabase = async () => {
    setBusy('db');
    try {
      const res = await backend.extensions();
      const defs = definitionsFromDatabase(res, conn.dialect);
      setLearnedExtensions(conn.dialect === dialect ? defs : []);
      setFound({
        label: backend.label,
        installed: res.extensions.filter((e) => e.installed).map((e) => e.name),
        available: res.extensions.filter((e) => !e.installed).map((e) => e.name),
        note: res.note,
      });
      if (conn.dialect !== dialect) {
        toast('info', `Connected to ${conn.dialect} but this diagram is ${dialect}; the definitions were read but not applied.`);
      } else {
        toast('success', `Read ${defs.length} installed extension${defs.length === 1 ? '' : 's'} from ${backend.label}.`);
      }
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const keepAsPack = async () => {
    setBusy('save');
    try {
      const res = await backend.extensions();
      const pack = packFromDatabase(res, conn.dialect, backend.label);
      if (pack.extensions.length === 0) {
        toast('info', 'That server has no extensions installed, so there is nothing to keep.');
        return;
      }
      addExtensionPack(pack);
      toast('success', `Kept ${pack.extensions.length} definition${pack.extensions.length === 1 ? '' : 's'} as a pack.`);
    } catch (e) {
      toast('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const removePack = async (p: ExtensionPack) => {
    const ok = await confirmDialog({
      title: `Remove "${p.name}"?`,
      message: `${p.extensions.length} definition(s) go with it. Extensions already declared in a diagram are unaffected — they just lose their autocomplete and checks.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (ok) dropExtensionPack(p.id);
  };

  const serverBacked = isServerDialect(conn.dialect);

  return (
    <div className="section ext-sources">
      <div className="section__head">
        <span className="section__title">Where definitions come from</span>
        <button className="btn btn--sm btn--ghost" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
          {packs.length > 0 && <span className="badge">{packs.length}</span>}
        </button>
      </div>

      {open && (
        <>
          <div className="small muted" style={{ marginBottom: 8 }}>
            The app ships with definitions for the usual extensions. For anything else, load a pack — one JSON file listing what a set of extensions provides —
            or read the definitions straight off a database you are connected to, which is the only source that is authoritative for the server this schema will
            run on. The format is documented in <code>docs/EXTENSION_PACK_FORMAT.md</code>.
          </div>

          <div className="row row--wrap" style={{ marginBottom: 8 }}>
            <button className="btn btn--sm" onClick={() => fileInput.current?.click()}>
              <FileJson /> Load a pack file
            </button>
            <input ref={fileInput} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={onFile} />
            <button className="btn btn--sm" onClick={readFromDatabase} disabled={busy !== null}>
              {busy === 'db' ? <RefreshCw className="spin" /> : <CloudDownload />} Read from {serverBacked ? 'the database' : 'the browser engine'}
            </button>
            {serverBacked && (
              <button className="btn btn--sm btn--ghost" onClick={keepAsPack} disabled={busy !== null} title="Save what the server reported so it survives a reload.">
                <Download /> Keep as a pack
              </button>
            )}
          </div>

          <div className="row" style={{ marginBottom: 10 }}>
            <input
              className="input input--sm grow"
              value={url}
              placeholder="https://…/extensions.json"
              spellCheck={false}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void loadUrl();
                }
              }}
            />
            <button className="btn btn--sm" onClick={loadUrl} disabled={busy !== null || !url.trim()}>
              {busy === 'url' ? <RefreshCw className="spin" /> : <Link2 />} Fetch
            </button>
          </div>

          {found && (
            <div className="list-item">
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="section__title grow">{found.label}</span>
                <span className="badge badge--success">{found.installed.length} installed</span>
                {found.available.length > 0 && <span className="badge">{found.available.length} available</span>}
              </div>
              {found.note && <div className="field__hint" style={{ marginBottom: 6 }}>{found.note}</div>}
              {found.installed.length > 0 && (
                <div className="ext-chips">
                  <span className="ext-chips__label">Installed</span>
                  <span className="chip-list">
                    {found.installed.map((n) => (
                      <button
                        key={n}
                        className={`chip${enabledNames.has(n.toLowerCase()) ? ' chip--on' : ''}`}
                        title={enabledNames.has(n.toLowerCase()) ? 'Already in this diagram' : 'Add to this diagram'}
                        onClick={() => addExtension(n)}
                      >
                        {enabledNames.has(n.toLowerCase()) ? n : <>+ {n}</>}
                      </button>
                    ))}
                  </span>
                </div>
              )}
              {found.available.length > 0 && (
                <div className="ext-chips">
                  <span className="ext-chips__label" title="On the server but not enabled in this database. Adding one here also generates the statement that enables it.">
                    Available
                  </span>
                  <span className="chip-list">
                    {found.available.slice(0, 30).map((n) => (
                      <button key={n} className="chip" onClick={() => addExtension(n)} title="Add to this diagram">
                        <Plus size={10} /> {n}
                      </button>
                    ))}
                    {found.available.length > 30 && <span className="chip">+{found.available.length - 30} more</span>}
                  </span>
                </div>
              )}
            </div>
          )}

          {packs.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="section__title" style={{ marginBottom: 4 }}>
                Loaded packs
              </div>
              {packs.map((p) => (
                <div key={p.id} className="row" style={{ marginBottom: 4 }}>
                  <span className="grow small" title={p.description}>
                    {p.name}
                    <span className="faint"> — {p.extensions.length} definition{p.extensions.length === 1 ? '' : 's'}</span>
                  </span>
                  <button
                    className="icon-btn"
                    title="Save this pack to a file"
                    onClick={() => downloadText(`${p.id.replace(/[^a-z0-9]+/gi, '-')}.extpack.json`, serializeExtensionPack(p))}
                  >
                    <Download />
                  </button>
                  <button className="icon-btn icon-btn--danger" title="Remove this pack" onClick={() => removePack(p)}>
                    <Trash2 />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
