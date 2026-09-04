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
      <h4>Building a diagram</h4>
      <p>
        Double-click the canvas (or press <K k="T" />) to add a table. Select a table to edit its columns in the inspector on the right. Drag from the small
        handle next to a column to a column in another table to create a foreign key. Drag from the orange handle in a table header to another table to add a
        data-flow link, then tag it with the query that moves the data.
      </p>
      <h4>Right-click</h4>
      <p>
        Everything on screen has its own menu. The canvas adds a table or a note exactly where you clicked (and holds undo, detangle, fit and the
        drawers); a table header offers rename, duplicate, colour, <em>Copy CREATE TABLE</em>, trace and delete; a column row toggles PK / NN / UQ / AI,
        inserts a column below it, indexes it or deletes it; a connection swaps its direction, converts between a foreign key and a data flow, or copies
        its tagged query. Right-clicking one of several selected tables acts on the whole group. Notes and the table list on the left have menus too, and
        the arrow keys with <K k="Enter" /> drive whichever menu is open.
      </p>
      <h4>Working with SQL</h4>
      <p>
        The SQL tab shows the CREATE TABLE script for the whole diagram (or the selected table). The Import tab turns CREATE TABLE statements into tables.
        Switching the dialect in the top bar translates column types between PostgreSQL and MariaDB.
      </p>
      <h4>Untangle and trace</h4>
      <p>
        Detangle runs a layered layout that ranks referenced tables before the tables that reference them and minimises edge crossings. Trace finds the
        shortest chain of connections between two tables and writes the JOIN query for it.
      </p>
      <h4>Database</h4>
      <p>
        The Database tab talks to the local API server: it can start a PostgreSQL or MariaDB container through Docker, run the generated schema against any
        reachable database, and pull an existing schema into the diagram.
      </p>
      <h4>Shortcuts</h4>
      <div className="help-grid">
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
          <K k="T" />
        </span>
        <span>Add table</span>
        <span>
          <K k="N" />
        </span>
        <span>Add note</span>
        <span>
          <K k="L" />
        </span>
        <span>Detangle (auto layout)</span>
        <span>
          <K k="F" />
        </span>
        <span>Fit diagram to the window</span>
        <span>
          <K k="Shift" /> + click
        </span>
        <span>Select several tables (then Trace connects the first two)</span>
        <span>
          <K k="Delete" />
        </span>
        <span>Delete the selection</span>
        <span>Right-click</span>
        <span>Menu for whatever is under the pointer</span>
        <span>
          <K k="Esc" />
        </span>
        <span>Clear selection / cancel picking</span>
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
