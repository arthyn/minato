import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface MountedDesk {
  name: string;
  path: string;
  /** Has a docket, so it is a front-end app rather than a bare desk. */
  docket: boolean;
  /** Newest mtime among its source files — when work last happened here. */
  lastTouched: Date | null;
}

/** Directories that are part of a pier's plumbing, never a mounted desk. */
const NOT_DESKS = new Set(['.urb', '.bin', '.run', 'node_modules']);

/**
 * A mounted desk is a directory Clay has synced to the filesystem. `sys.kelvin`
 * is the reliable marker: every desk carries one, while `desk.bill` and a
 * docket are optional.
 */
function isDesk(dir: string): boolean {
  return existsSync(join(dir, 'sys.kelvin'));
}

/**
 * Sample mtimes a couple of levels down rather than walking the whole desk.
 * Desks hold thousands of files and this runs for every pier in `list`.
 */
function newestMtime(dir: string, depth = 2): Date | null {
  let newest: Date | null = null;
  const visit = (path: string, left: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const child = join(path, entry);
      let st;
      try {
        st = statSync(child);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (left > 0) visit(child, left - 1);
      } else if (!newest || st.mtime > newest) {
        newest = st.mtime;
      }
    }
  };
  visit(dir, depth);
  return newest;
}

/**
 * Desks currently mounted into a pier — a free, always-accurate record of what
 * is being worked on there, needing no bookkeeping from the user.
 */
export function mountedDesks(pierPath: string): MountedDesk[] {
  let entries: string[];
  try {
    entries = readdirSync(pierPath);
  } catch {
    return [];
  }

  const desks: MountedDesk[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.') || NOT_DESKS.has(entry)) continue;
    const path = join(pierPath, entry);
    try {
      if (!statSync(path).isDirectory() || !isDesk(path)) continue;
    } catch {
      continue;
    }
    desks.push({
      name: entry,
      path,
      docket: existsSync(join(path, 'desk.docket-0')),
      lastTouched: newestMtime(path),
    });
  }
  return desks.sort((a, b) => a.name.localeCompare(b.name));
}
