/**
 * Right-click menus. `openContextMenu` records what was clicked and where;
 * ContextMenuHost renders the menu that fits that target (see
 * contextMenuItems.ts for what each target offers).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Check } from 'lucide-react';
import { PALETTE } from '@/lib/palette';
import { useStore } from '@/store/useStore';
import { buildContextMenu, describeElements, hasActions, type ContextTarget, type MenuEnv, type MenuNode } from './contextMenuItems';
import { confirmDialog, promptDialog } from './Modal';

interface OpenMenu {
  x: number;
  y: number;
  target: ContextTarget;
}

interface ContextMenuState {
  menu: OpenMenu | null;
  open: (menu: OpenMenu) => void;
  close: () => void;
}

export const useContextMenuStore = create<ContextMenuState>((set) => ({
  menu: null,
  open: (menu) => set({ menu }),
  close: () => set({ menu: null }),
}));

/** Minimal shape shared by React's synthetic mouse event and the native one. */
interface MenuEvent {
  clientX: number;
  clientY: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export function openContextMenu(e: MenuEvent, target: ContextTarget): void {
  e.preventDefault();
  e.stopPropagation();
  useContextMenuStore.getState().open({ x: e.clientX, y: e.clientY, target });
}

export function closeContextMenu(): void {
  useContextMenuStore.getState().close();
}

export function isContextMenuOpen(): boolean {
  return useContextMenuStore.getState().menu !== null;
}

const EDGE_GAP = 8;

export function ContextMenuHost() {
  const menu = useContextMenuStore((s) => s.menu);
  // Remount on every open so the position and keyboard cursor start fresh.
  return menu ? <ContextMenuView key={`${menu.x}:${menu.y}`} menu={menu} /> : null;
}

function ContextMenuView({ menu }: { menu: OpenMenu }) {
  const store = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y, ready: false });
  const [active, setActive] = useState(-1);

  const env = useMemo<MenuEnv>(() => {
    const s = store;
    return {
      store: s,
      copy: (text, message) => {
        navigator.clipboard
          .writeText(text)
          .then(() => s.toast('success', message))
          .catch(() => s.toast('error', 'The browser would not let us write to the clipboard.'));
      },
      renameTable: (tableId) => {
        const table = s.diagram.tables.find((t) => t.id === tableId);
        if (!table) return;
        void promptDialog({ title: `Rename "${table.name}"`, label: 'Table name', value: table.name, confirmLabel: 'Rename' }).then((name) => {
          const next = name?.trim();
          if (next && next !== table.name) s.updateTable(tableId, { name: next });
        });
      },
      removeGroup: (groupId) => {
        const group = s.diagram.groups.find((g) => g.id === groupId);
        if (!group) return;
        const members = s.diagram.tables.filter((t) => t.groupId === groupId);
        const ids = new Set(members.map((t) => t.id));
        const touched = s.diagram.relationships.filter((r) => ids.has(r.sourceTableId) !== ids.has(r.targetTableId)).length;
        void confirmDialog({
          title: `Delete "${group.name}" and its ${members.length} table${members.length === 1 ? '' : 's'}?`,
          message: touched
            ? `${touched} connection${touched === 1 ? '' : 's'} to the rest of the diagram will go with them. This can be undone with Ctrl+Z.`
            : 'This can be undone with Ctrl+Z.',
          confirmLabel: 'Delete tables',
          danger: true,
        }).then((ok) => ok && s.deleteGroup(groupId, true));
      },
      remove: ({ tableIds = [], noteIds = [] }) => {
        const touched = s.diagram.relationships.filter((r) => tableIds.includes(r.sourceTableId) || tableIds.includes(r.targetTableId)).length;
        if (!touched) {
          s.removeElements({ tableIds, noteIds });
          return;
        }
        const count = tableIds.length + noteIds.length;
        const what =
          tableIds.length === 1 && !noteIds.length
            ? `"${s.diagram.tables.find((t) => t.id === tableIds[0])?.name ?? 'this table'}"`
            : describeElements({ tableIds, noteIds });
        void confirmDialog({
          title: `Delete ${what}?`,
          message: `${touched} connection${touched === 1 ? '' : 's'} touching ${count === 1 ? 'it' : 'them'} will be removed too.`,
          confirmLabel: 'Delete',
          danger: true,
        }).then((ok) => ok && s.removeElements({ tableIds, noteIds }));
      },
    };
  }, [store]);

  const items = useMemo(() => buildContextMenu(menu.target, env), [menu.target, env]);
  const actionable = useMemo(() => items.flatMap((item, i) => (item.kind === 'action' && !item.disabled ? [i] : [])), [items]);

  /* Nothing to show (the target was deleted under us) -> close. */
  useEffect(() => {
    if (!hasActions(items)) closeContextMenu();
  }, [items]);

  /* Keep the menu inside the viewport. */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const x = menu.x + width > window.innerWidth - EDGE_GAP ? Math.max(EDGE_GAP, menu.x - width) : menu.x;
    const y = menu.y + height > window.innerHeight - EDGE_GAP ? Math.max(EDGE_GAP, window.innerHeight - height - EDGE_GAP) : menu.y;
    setPos({ x, y, ready: true });
    el.focus({ preventScroll: true });
  }, [menu.x, menu.y]);

  /* Dismissal: a click elsewhere, a wheel, a resize, or leaving the window.
     Deliberately not the scroll event: focusing the clicked node makes React
     Flow scroll it into view, which would close the menu as it opens. */
  useEffect(() => {
    const outside = (e: Event) => !ref.current?.contains(e.target as Node);
    const onPointerDown = (e: MouseEvent) => {
      if (outside(e)) closeContextMenu();
    };
    const onWheel = (e: WheelEvent) => {
      if (outside(e)) closeContextMenu();
    };
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('wheel', onWheel, true);
    window.addEventListener('resize', closeContextMenu);
    window.addEventListener('blur', closeContextMenu);
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('resize', closeContextMenu);
      window.removeEventListener('blur', closeContextMenu);
    };
  }, []);

  /* Keyboard driving. Capture phase so the app's global shortcuts stay quiet. */
  useEffect(() => {
    const run = (index: number) => {
      const item = items[index];
      if (item?.kind === 'action' && !item.disabled) {
        closeContextMenu();
        item.run();
      }
    };
    const step = (delta: number) => {
      if (!actionable.length) return;
      const at = actionable.indexOf(active);
      const next = at === -1 ? (delta > 0 ? 0 : actionable.length - 1) : (at + delta + actionable.length) % actionable.length;
      setActive(actionable[next]);
    };
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
        case 'Tab':
          closeContextMenu();
          break;
        case 'ArrowDown':
          step(1);
          break;
        case 'ArrowUp':
          step(-1);
          break;
        case 'Home':
          setActive(actionable[0] ?? -1);
          break;
        case 'End':
          setActive(actionable[actionable.length - 1] ?? -1);
          break;
        case 'Enter':
        case ' ':
          if (active >= 0) run(active);
          else return;
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [items, actionable, active]);

  const style: React.CSSProperties = { left: pos.x, top: pos.y, visibility: pos.ready ? 'visible' : 'hidden' };

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={style}
      role="menu"
      tabIndex={-1}
      aria-label="Context menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <MenuRow key={item.id} item={item} active={i === active} onHover={() => setActive(item.kind === 'action' && !item.disabled ? i : -1)} />
      ))}
    </div>
  );
}

function MenuRow({ item, active, onHover }: { item: MenuNode; active: boolean; onHover: () => void }) {
  if (item.kind === 'separator') return <div className="ctx-menu__sep" role="separator" />;
  if (item.kind === 'heading') {
    return (
      <div className="ctx-menu__heading">
        <span className="ctx-menu__heading-name">{item.label}</span>
        {item.detail && <span className="ctx-menu__heading-detail">{item.detail}</span>}
      </div>
    );
  }
  if (item.kind === 'caption') return <div className="ctx-menu__caption">{item.text}</div>;
  if (item.kind === 'swatches') {
    return (
      <div className="ctx-menu__swatches" onMouseEnter={onHover}>
        <span className="ctx-menu__swatches-label">{item.label}</span>
        <div className="swatches">
          {PALETTE.map((p) => (
            <button
              key={p.key}
              className={`swatch${item.value === p.key ? ' swatch--active' : ''}`}
              style={{ background: p.hue }}
              title={p.label}
              onClick={() => {
                closeContextMenu();
                item.pick(p.key);
              }}
            />
          ))}
        </div>
      </div>
    );
  }
  const Icon = item.icon;
  const classes = ['ctx-menu__item'];
  if (active) classes.push('ctx-menu__item--active');
  if (item.danger) classes.push('ctx-menu__item--danger');
  return (
    <button
      type="button"
      role="menuitem"
      className={classes.join(' ')}
      disabled={item.disabled}
      onMouseEnter={onHover}
      onClick={() => {
        closeContextMenu();
        item.run();
      }}
    >
      <span className="ctx-menu__icon">
        {item.checked !== undefined ? item.checked ? <Check /> : null : Icon ? <Icon /> : null}
      </span>
      <span className="ctx-menu__label">{item.label}</span>
      {item.hint && <span className="ctx-menu__hint">{item.hint}</span>}
    </button>
  );
}
