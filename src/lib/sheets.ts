/**
 * The actions behind the sheet tabs — the several diagrams that share one
 * workspace. They live here rather than in the tab strip because the tab's
 * menu, the command palette and the keyboard all offer the same things, and a
 * close that asks before dropping tables has to ask wherever it is triggered.
 */
import { sheetDiagram, useStore } from '@/store/useStore';
import { confirmDialog, promptDialog } from '@/components/ui/Modal';

/** Add a diagram to the workspace and switch to it. */
export function addSheet(): void {
  const s = useStore.getState();
  const id = s.addSheet();
  const name = sheetDiagram(useStore.getState(), id)?.name ?? 'the new diagram';
  s.toast('info', `Added "${name}" to this workspace. Every tab is saved in the same file.`);
}

/** Move to the next or previous tab, wrapping around, as Ctrl+PgUp/PgDn does in a spreadsheet. */
export function stepSheet(delta: number): void {
  const s = useStore.getState();
  if (s.sheetIds.length < 2) return;
  const at = s.sheetIds.indexOf(s.activeSheetId);
  const next = (at + delta + s.sheetIds.length) % s.sheetIds.length;
  s.switchSheet(s.sheetIds[next]);
}

export async function renameSheetWithPrompt(id: string): Promise<void> {
  const s = useStore.getState();
  const diagram = sheetDiagram(s, id);
  if (!diagram) return;
  const name = await promptDialog({ title: `Rename "${diagram.name}"`, label: 'Diagram name', value: diagram.name, confirmLabel: 'Rename' });
  if (name?.trim()) s.renameSheet(id, name);
}

/** Close a tab, asking first when there is something on it to lose. */
export async function closeSheetWithConfirm(id: string): Promise<void> {
  const s = useStore.getState();
  const diagram = sheetDiagram(s, id);
  if (!diagram) return;
  const last = s.sheetIds.length === 1;
  if (
    diagram.tables.length > 0 &&
    !(await confirmDialog({
      title: `Close "${diagram.name}"?`,
      message: last
        ? `Its ${diagram.tables.length} table${diagram.tables.length === 1 ? '' : 's'} go with it and the tab is left empty. The workspace as it was stays in the library (File → Open recent…).`
        : `Its ${diagram.tables.length} table${diagram.tables.length === 1 ? '' : 's'} go with it. The other diagrams in this workspace are untouched, and the workspace as it was stays in the library (File → Open recent…).`,
      confirmLabel: 'Close',
      danger: true,
    }))
  )
    return;
  s.closeSheet(id);
  s.toast('info', last ? `Closed "${diagram.name}". This tab is empty now.` : `Closed "${diagram.name}".`);
}
