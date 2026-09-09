import { describe, expect, it } from 'vitest';
import { columnKeyAction, FLAG_SHORTCUT, rovingIndex, type ColumnField, type KeySpec } from '../src/lib/editorKeys';

const key = (k: string, mods: Partial<KeySpec> = {}): KeySpec => ({ key: k, ...mods });
const inField = (field: ColumnField, nameEmpty = false) => ({ field, nameEmpty });

describe('columnKeyAction — adding rows', () => {
  it('adds below on Enter and above on Shift+Enter, from any part of the row', () => {
    for (const field of ['name', 'type', 'flags'] as const) {
      expect(columnKeyAction(key('Enter'), inField(field))).toEqual({ kind: 'add', where: 'below' });
      expect(columnKeyAction(key('Enter', { shiftKey: true }), inField(field))).toEqual({ kind: 'add', where: 'above' });
    }
  });

  it('answers Enter on a flag button too, so a toggle does not cost a trip back to the type box', () => {
    // The whole point of the toolbar: tab in, Space to tick NN, Enter for the next column.
    expect(columnKeyAction(key('Enter'), inField('flags'))).toEqual({ kind: 'add', where: 'below' });
  });
});

describe('columnKeyAction — flags', () => {
  it('maps Alt+P/N/U/I onto the four toggles', () => {
    expect(columnKeyAction(key('p', { altKey: true }), inField('name'))).toEqual({ kind: 'toggle', flag: 'primaryKey' });
    expect(columnKeyAction(key('n', { altKey: true }), inField('type'))).toEqual({ kind: 'toggle', flag: 'nullable' });
    expect(columnKeyAction(key('u', { altKey: true }), inField('name'))).toEqual({ kind: 'toggle', flag: 'unique' });
    expect(columnKeyAction(key('i', { altKey: true }), inField('flags'))).toEqual({ kind: 'toggle', flag: 'autoIncrement' });
  });

  it('reads the physical key, because Alt rewrites `key` on macOS', () => {
    // Option+P arrives as "π" on a Mac; the code says which key was actually struck.
    expect(columnKeyAction({ key: 'π', code: 'KeyP', altKey: true }, inField('name'))).toEqual({ kind: 'toggle', flag: 'primaryKey' });
  });

  it('leaves Alt combos it does not own alone', () => {
    expect(columnKeyAction(key('x', { altKey: true }), inField('name'))).toBeNull();
    expect(columnKeyAction(key('Enter', { altKey: true }), inField('name'))).toBeNull();
  });

  it('ignores Ctrl+Alt and Cmd+Alt, which belong to the browser and the desktop', () => {
    expect(columnKeyAction(key('p', { altKey: true, ctrlKey: true }), inField('name'))).toBeNull();
    expect(columnKeyAction(key('p', { altKey: true, metaKey: true }), inField('name'))).toBeNull();
  });

  it('labels its buttons from the same map it binds', () => {
    expect(FLAG_SHORTCUT).toEqual({ primaryKey: 'P', nullable: 'N', unique: 'U', autoIncrement: 'I' });
  });
});

describe('columnKeyAction — moving around and deleting', () => {
  it('walks rows with the arrow keys from the name box', () => {
    expect(columnKeyAction(key('ArrowDown'), inField('name'))).toEqual({ kind: 'step', delta: 1 });
    expect(columnKeyAction(key('ArrowUp'), inField('name'))).toEqual({ kind: 'step', delta: -1 });
  });

  it('leaves the type box its own arrows, which walk the list of type suggestions', () => {
    expect(columnKeyAction(key('ArrowDown'), inField('type'))).toBeNull();
    expect(columnKeyAction(key('ArrowUp'), inField('type'))).toBeNull();
  });

  it('leaves Shift+Arrow alone, so selecting text still works', () => {
    expect(columnKeyAction(key('ArrowDown', { shiftKey: true }), inField('name'))).toBeNull();
  });

  it('deletes an unnamed row on Ctrl+Backspace, wherever in the row the cursor is', () => {
    expect(columnKeyAction(key('Backspace', { ctrlKey: true }), inField('name', true))).toEqual({ kind: 'delete' });
    expect(columnKeyAction(key('Backspace', { metaKey: true }), inField('type', true))).toEqual({ kind: 'delete' });
  });

  it('keeps a named row when Backspace is only editing its text', () => {
    expect(columnKeyAction(key('Backspace', { ctrlKey: true }), inField('name', false))).toBeNull();
    expect(columnKeyAction(key('Backspace'), inField('name', true))).toBeNull();
  });

  it('lets Escape out of the field', () => {
    expect(columnKeyAction(key('Escape'), inField('name'))).toEqual({ kind: 'blur' });
  });

  it('passes ordinary typing through', () => {
    expect(columnKeyAction(key('a'), inField('name'))).toBeNull();
    expect(columnKeyAction(key('Tab'), inField('type'))).toBeNull();
  });
});

describe('rovingIndex', () => {
  it('moves left and right, wrapping at both ends', () => {
    expect(rovingIndex('ArrowRight', 0, 5)).toBe(1);
    expect(rovingIndex('ArrowRight', 4, 5)).toBe(0);
    expect(rovingIndex('ArrowLeft', 0, 5)).toBe(4);
  });

  it('jumps to the ends with Home and End', () => {
    expect(rovingIndex('Home', 3, 5)).toBe(0);
    expect(rovingIndex('End', 0, 5)).toBe(4);
  });

  it('keeps up and down for the caller in a horizontal row, so they can mean "next row"', () => {
    expect(rovingIndex('ArrowDown', 0, 5)).toBeNull();
    expect(rovingIndex('ArrowUp', 0, 5)).toBeNull();
  });

  it('takes up and down as well when the row wraps onto several lines', () => {
    expect(rovingIndex('ArrowDown', 0, 10, 'both')).toBe(1);
    expect(rovingIndex('ArrowUp', 0, 10, 'both')).toBe(9);
  });

  it('has nothing to move to in an empty row', () => {
    expect(rovingIndex('ArrowRight', 0, 0)).toBeNull();
  });
});
