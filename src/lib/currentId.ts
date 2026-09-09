/**
 * Which library entry the workspace on screen belongs to. Kept in its own
 * module, free of any other import, because both the library (which writes the
 * entry) and the store (which migrates an older single-diagram autosave into
 * a workspace) need it, and importing one from the other would be a cycle.
 */
import { newId } from './ids';

const CURRENT_KEY = 'dbviz:currentId';

export function newWorkspaceId(): string {
  return newId('dgm');
}

export function getCurrentWorkspaceId(): string {
  try {
    const id = localStorage.getItem(CURRENT_KEY);
    if (id) return id;
    const fresh = newWorkspaceId();
    localStorage.setItem(CURRENT_KEY, fresh);
    return fresh;
  } catch {
    return 'dgm_session';
  }
}

export function setCurrentWorkspaceId(id: string): void {
  try {
    localStorage.setItem(CURRENT_KEY, id);
  } catch {
    /* ignore */
  }
}
