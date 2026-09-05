import { useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { X } from 'lucide-react';

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
}

interface DialogState {
  confirm: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null;
  prompt: (PromptOptions & { resolve: (value: string | null) => void }) | null;
  help: boolean;
  setHelp: (open: boolean) => void;
}

export const useDialogStore = create<DialogState>((set) => ({
  confirm: null,
  prompt: null,
  help: false,
  setHelp: (open) => set({ help: open }),
}));

/** Promise-based confirm dialog: `if (await confirmDialog({...})) ...` */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useDialogStore.setState({
      confirm: {
        ...opts,
        resolve: (ok) => {
          useDialogStore.setState({ confirm: null });
          resolve(ok);
        },
      },
    });
  });
}

/** Promise-based text prompt: `const name = await promptDialog({...})` (null when cancelled). */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    useDialogStore.setState({
      prompt: {
        ...opts,
        resolve: (value) => {
          useDialogStore.setState({ prompt: null });
          resolve(value);
        },
      },
    });
  });
}

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={wide ? { width: 'min(720px, calc(100vw - 32px))' } : undefined} role="dialog" aria-modal="true">
        <div className="modal__head">
          <span className="grow">{title}</span>
          <button className="icon-btn" onClick={onClose} title="Close">
            <X />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  );
}

function HelpContent() {
  const K = ({ k }: { k: string }) => <span className="kbd">{k}</span>;
  return (
    <div className="help">
      <h4>Find anything</h4>
      <p>
        <K k="Ctrl" /> <K k="K" /> opens the command palette. Type a table name to jump to it, or the first letters of any action (export, detangle,
        collapse, switch dialect, open a tab) and press <K k="Enter" />. Everything in the menus is in there, and what you used last floats to the top.
      </p>
      <h4>Building a diagram</h4>
      <p>
        Double-click the canvas (or press <K k="T" />) to add a table. Select a table to edit its columns in the inspector on the right: <K k="Enter" /> in a
        column name adds the next column below it, <K k="Shift" /> + <K k="Enter" /> inserts one above, and <K k="Ctrl" /> + <K k="Backspace" /> on an
        empty name removes it, so a whole table can be typed without touching the mouse. Drag the grip at the left of a row to reorder columns. Drag from
        the small handle next to a column to a column in another table to create a foreign key. Drag from the orange handle in a table header to another
        table to add a data-flow link, then tag it with the query that moves the data. The Table / View switch at the top of the inspector turns a table
        into a view: paste its SELECT and <em>Detect from SQL</em> draws the links from the tables it reads.
      </p>
      <h4>Grouping tables</h4>
      <p>
        Press <K k="G" /> (or the group button in the top bar) to draw a region around the selected tables, so a second database&apos;s tables stay visually
        apart from the schema you are designing. Drag a table into or out of a region to change what is in it, and drag a region by its title bar to move
        everything inside it. Tick <em>These tables live in another database</em> in the inspector and the group turns external: the generated script documents
        those tables instead of creating them, and nothing runs against them when you apply the schema. Detangle keeps each group together. Right-click the
        canvas → <em>Group by schema</em> boxes tables by their schema prefix in one go.
      </p>
      <h4>Right-click</h4>
      <p>
        Everything on screen has its own menu. The canvas adds a table, a view or a note exactly where you clicked, pastes, groups by schema, snaps everything
        to the grid, and holds undo, detangle, fit and the drawers; a table header offers rename, duplicate, colour, copy / cut, <em>Copy CREATE TABLE</em>,
        how much of it to show, focus, trace and delete; a column row toggles PK / NN / UQ / AI, inserts a column below it, indexes it or deletes it; a
        connection swaps its direction, switches between the four connection kinds, or copies its tagged query. Right-clicking inside a group you boxed
        with Shift + drag acts on all of it at once, and adds align and distribute. Notes and the table list on the left have menus too, and the arrow keys
        with <K k="Enter" /> drive whichever menu is open.
      </p>
      <h4>Reading a big diagram</h4>
      <p>
        The chevron in a table header cycles between every column, keys only, and header only; the View menu does it for all tables at once, and zooming far
        out collapses everything automatically until you zoom back in. Select a table and press <K k="." /> to focus on it: everything more than one hop away
        fades, <K k="]" /> and <K k="[" /> widen or narrow the neighbourhood, <K k="Esc" /> clears it. Connections carry 1 / N cardinality labels, and tables
        that only exist to join two others get an N:M badge.
      </p>
      <h4>Working with SQL</h4>
      <p>
        The SQL tab shows the CREATE TABLE script for the whole diagram (or the selected table), and can switch to Mermaid, DBML or Markdown. The Import tab
        turns CREATE TABLE / CREATE VIEW statements into tables and views; dropping a .sql file on the canvas does the same, and pasting DDL with{' '}
        <K k="Ctrl" /> <K k="V" /> imports it. Switching the dialect in the top bar translates column types between PostgreSQL, MariaDB and SQLite. The
        Problems tab lints the schema (missing keys, foreign keys onto non-unique columns, type mismatches, duplicate names, reserved words) and fixes most
        findings with one click; it also suggests foreign keys from column names such as <em>customer_id</em>.
      </p>
      <h4>Untangle and trace</h4>
      <p>
        Detangle runs a layered layout that ranks referenced tables before the tables that reference them and minimises edge crossings. Trace finds the
        shortest chain of connections between two tables and writes the JOIN query for it; <em>Run</em> sends it to the Query tab.
      </p>
      <h4>Database</h4>
      <p>
        The Database tab talks to the local API server: it can start a PostgreSQL or MariaDB container through Docker, run the generated schema against any
        reachable database, and pull an existing schema into the diagram. <em>Migrate</em> compares the diagram with the live database and writes the ALTER
        statements that bring it up to date; <em>Seed</em> generates INSERT rows that respect foreign keys, uniqueness and enums. With the SQLite dialect
        selected the database runs inside the browser instead, no server needed, and the Query tab runs read-only SELECTs against whichever one is connected.
      </p>
      <h4>Saving</h4>
      <p>
        Every diagram is kept in this browser automatically; <em>File → Open recent…</em> lists them with thumbnails. Save a checkpoint before a risky change
        (Diagram panel in the inspector, or <em>File → Save checkpoint…</em>) and restore it later. <K k="Ctrl" /> <K k="S" /> downloads a .dbviz.json
        file, <em>Copy share link</em> puts the whole diagram in a URL, and the export menu writes PNG, SVG, SQL, Markdown, Mermaid or DBML.
      </p>
      <h4>Shortcuts</h4>
      <div className="help-grid">
        <span>
          <K k="Ctrl" /> <K k="K" />
        </span>
        <span>Command palette</span>
        <span>
          <K k="Ctrl" /> <K k="Z" />
        </span>
        <span>Undo</span>
        <span>
          <K k="Ctrl" /> <K k="Shift" /> <K k="Z" />
        </span>
        <span>Redo</span>
        <span>
          <K k="Ctrl" /> <K k="S" />
        </span>
        <span>Save diagram file</span>
        <span>
          <K k="Ctrl" /> <K k="O" />
        </span>
        <span>Open diagram file</span>
        <span>
          <K k="Ctrl" /> <K k="C" /> / <K k="X" /> / <K k="V" />
        </span>
        <span>Copy, cut and paste the selected tables (also pastes DDL, DBML or a .dbviz.json)</span>
        <span>
          <K k="T" />
        </span>
        <span>Add table</span>
        <span>
          <K k="N" />
        </span>
        <span>Add note</span>
        <span>
          <K k="G" />
        </span>
        <span>Group the selected tables</span>
        <span>
          <K k="L" />
        </span>
        <span>Detangle (auto layout)</span>
        <span>
          <K k="F" />
        </span>
        <span>Fit diagram to the window</span>
        <span>
          <K k="F2" />
        </span>
        <span>Rename the selected table in place</span>
        <span>
          <K k="." />
        </span>
        <span>Focus on the selected table; <K k="[" /> / <K k="]" /> change how many hops stay visible</span>
        <span>
          <K k="←" /> <K k="↑" /> <K k="↓" /> <K k="→" />
        </span>
        <span>Nudge the selection by 10 px (<K k="Shift" /> for 50)</span>
        <span>
          <K k="Enter" /> in a column name
        </span>
        <span>Add the next column (<K k="Shift" /> inserts above; <K k="Ctrl" /> + <K k="Backspace" /> deletes an empty row)</span>
        <span>
          <K k="Shift" /> + click
        </span>
        <span>Add a table or note to the selection (then Trace connects the first two tables)</span>
        <span>
          <K k="Shift" /> + drag
        </span>
        <span>Draw a box to select everything it touches, then drag the group to move it</span>
        <span>
          <K k="Delete" />
        </span>
        <span>Delete the selection</span>
        <span>Right-click</span>
        <span>Menu for whatever is under the pointer</span>
        <span>
          <K k="Esc" />
        </span>
        <span>Clear focus / selection, cancel picking</span>
        <span>
          <K k="?" />
        </span>
        <span>This help</span>
      </div>
    </div>
  );
}

function PromptModal({ prompt }: { prompt: PromptOptions & { resolve: (value: string | null) => void } }) {
  const [value, setValue] = useState(prompt.value ?? '');
  const submit = () => prompt.resolve(value);
  return (
    <Modal
      title={prompt.title}
      onClose={() => prompt.resolve(null)}
      footer={
        <>
          <button className="btn" onClick={() => prompt.resolve(null)}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={!value.trim()}>
            {prompt.confirmLabel ?? 'OK'}
          </button>
        </>
      }
    >
      <div className="field">
        {prompt.label && <span className="field__label">{prompt.label}</span>}
        <input
          className="input"
          value={value}
          placeholder={prompt.placeholder}
          spellCheck={false}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) submit();
          }}
        />
      </div>
    </Modal>
  );
}

export function DialogHost() {
  const confirm = useDialogStore((s) => s.confirm);
  const prompt = useDialogStore((s) => s.prompt);
  const help = useDialogStore((s) => s.help);
  const setHelp = useDialogStore((s) => s.setHelp);
  return (
    <>
      {confirm && (
        <Modal
          title={confirm.title}
          onClose={() => confirm.resolve(false)}
          footer={
            <>
              <button className="btn" onClick={() => confirm.resolve(false)}>
                {confirm.cancelLabel ?? 'Cancel'}
              </button>
              <button className={`btn ${confirm.danger ? 'btn--danger' : 'btn--primary'}`} onClick={() => confirm.resolve(true)} autoFocus>
                {confirm.confirmLabel ?? 'Confirm'}
              </button>
            </>
          }
        >
          {confirm.message}
        </Modal>
      )}
      {prompt && <PromptModal key={prompt.title} prompt={prompt} />}
      {help && (
        <Modal title="How to use Database Visualizer" onClose={() => setHelp(false)} wide>
          <HelpContent />
        </Modal>
      )}
    </>
  );
}
