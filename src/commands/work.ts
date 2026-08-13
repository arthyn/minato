import { getMeta, loadConfig, loadState, saveState, setMeta } from '../config.ts';
import { readAllPiers, resolvePier } from '../discover.ts';
import { mountedDesks } from '../desks.ts';
import type { Pier, State, WorkItem } from '../types.ts';
import { color, humanAge, table } from '../ui.ts';
import { EXIT_OK, EXIT_VALIDATION } from './start.ts';

export interface DescribeOptions {
  moon: string;
  description: string;
}

export interface WorkOptions {
  moon?: string;
  note?: string;
  id?: string;
  desk?: string;
  repo?: string;
  branch?: string;
  link?: string;
  json?: boolean;
  all?: boolean;
}

export async function describeCommand(opts: DescribeOptions): Promise<number> {
  const config = loadConfig();
  const state = loadState();
  const pier = resolvePier(readAllPiers(config, state), opts.moon);

  const description = opts.description.trim();
  setMeta(state, pier.path, { description: description || undefined });
  saveState(state);

  process.stdout.write(
    description
      ? `~${pier.ship}: ${color('bold', description)}\n`
      : `cleared the description for ~${pier.ship}\n`,
  );
  return EXIT_OK;
}

/** Slug from the note, so `work add` needs no id in the common case. */
function deriveId(note: string, existing: WorkItem[]): string {
  const base =
    note
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .split('-')
      .slice(0, 3)
      .join('-') || 'work';
  if (!existing.some((w) => w.id === base)) return base;
  for (let n = 2; ; n += 1) {
    if (!existing.some((w) => w.id === `${base}-${n}`)) return `${base}-${n}`;
  }
}

export async function workAddCommand(opts: WorkOptions): Promise<number> {
  if (!opts.moon || !opts.note) {
    process.stderr.write('usage: minato work add <moon> "<what you are doing>" [--desk d] [--repo r] [--branch b] [--link url]\n');
    return EXIT_VALIDATION;
  }
  const config = loadConfig();
  const state = loadState();
  const pier = resolvePier(readAllPiers(config, state), opts.moon);
  const existing = getMeta(state, pier.path).work ?? [];

  const item: WorkItem = {
    id: opts.id ?? deriveId(opts.note, existing),
    note: opts.note,
    ...(opts.desk ? { desk: opts.desk } : {}),
    ...(opts.repo ? { repo: opts.repo } : {}),
    ...(opts.branch ? { branch: opts.branch } : {}),
    ...(opts.link ? { link: opts.link } : {}),
    started: new Date().toISOString(),
  };

  setMeta(state, pier.path, { work: [...existing, item] });
  saveState(state);
  process.stdout.write(
    `${color('green', 'tracking')} ${color('bold', item.id)} on ~${pier.ship}\n  ${item.note}\n`,
  );
  return EXIT_OK;
}

export async function workDoneCommand(opts: WorkOptions): Promise<number> {
  if (!opts.moon || !opts.id) {
    process.stderr.write('usage: minato work done <moon> <id>\n');
    return EXIT_VALIDATION;
  }
  const config = loadConfig();
  const state = loadState();
  const pier = resolvePier(readAllPiers(config, state), opts.moon);
  const existing = getMeta(state, pier.path).work ?? [];

  const remaining = existing.filter((w) => w.id !== opts.id);
  if (remaining.length === existing.length) {
    process.stderr.write(
      `no work item "${opts.id}" on ~${pier.ship}` +
        (existing.length ? ` (have: ${existing.map((w) => w.id).join(', ')})` : ' (none tracked)') +
        '\n',
    );
    return EXIT_VALIDATION;
  }

  setMeta(state, pier.path, { work: remaining });
  saveState(state);
  process.stdout.write(`${color('green', 'closed')} ${opts.id} on ~${pier.ship}\n`);
  return EXIT_OK;
}

function renderMoon(pier: Pier, state: State): string {
  const meta = getMeta(state, pier.path);
  const lines: string[] = [];
  const stateTag = pier.state === 'running' ? color('green', 'running') : color('dim', pier.state);
  lines.push(`${color('bold', pier.shortname)} ${color('dim', `~${pier.ship}`)}  ${stateTag}`);
  if (meta.description) lines.push(`  ${meta.description}`);

  const work = meta.work ?? [];
  if (work.length) {
    for (const w of work) {
      const bits = [w.desk && `%${w.desk}`, w.branch, w.link].filter(Boolean).join('  ');
      lines.push(
        `  ${color('yellow', '•')} ${color('bold', w.id)}  ${w.note}` +
          (bits ? `\n      ${color('dim', bits)}` : '') +
          `\n      ${color('dim', `opened ${humanAge(new Date(w.started))}`)}`,
      );
    }
  }

  // Mounted desks are derived, not recorded, so they are always accurate even
  // when nobody has kept the work list current.
  const desks = mountedDesks(pier.path).filter((d) => d.name !== 'base');
  if (desks.length) {
    lines.push(`  ${color('dim', `desks: ${desks.map((d) => d.name).join(', ')}`)}`);
  }
  if (!meta.description && !work.length && !desks.length) {
    lines.push(color('dim', '  (nothing recorded — minato describe / minato work add)'));
  }
  return lines.join('\n');
}

/** Directory of work across every moon, or a single moon's detail. */
export async function workListCommand(opts: WorkOptions): Promise<number> {
  const config = loadConfig();
  const state = loadState();
  const piers = readAllPiers(config, state);

  if (opts.moon) {
    const pier = resolvePier(piers, opts.moon);
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          { ship: pier.ship, ...getMeta(state, pier.path), desks: mountedDesks(pier.path) },
          null,
          2,
        )}\n`,
      );
      return EXIT_OK;
    }
    process.stdout.write(`${renderMoon(pier, state)}\n`);
    return EXIT_OK;
  }

  // Moons with something recorded first, then running ones, so the directory
  // opens on whatever is actually live.
  const interesting = piers.filter((p) => {
    if (p.archived && !opts.all) return false;
    const meta = getMeta(state, p.path);
    return Boolean(meta.description) || (meta.work?.length ?? 0) > 0 || p.state === 'running';
  });

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        interesting.map((p) => ({
          ship: p.ship,
          shortname: p.shortname,
          state: p.state,
          ...getMeta(state, p.path),
          desks: mountedDesks(p.path).map((d) => d.name),
        })),
        null,
        2,
      )}\n`,
    );
    return EXIT_OK;
  }

  if (interesting.length === 0) {
    process.stdout.write('nothing tracked yet — minato describe <moon> "<what it is for>"\n');
    return EXIT_OK;
  }

  const order = { running: 0, ambiguous: 1, unknown: 2, stopped: 3, stale: 4, archived: 5 };
  interesting.sort((a, b) => order[a.state] - order[b.state] || a.ship.localeCompare(b.ship));
  process.stdout.write(`${interesting.map((p) => renderMoon(p, state)).join('\n\n')}\n`);

  const untracked = piers.filter(
    (p) => !p.archived && p.state === 'running' && !getMeta(state, p.path).description,
  );
  if (untracked.length) {
    process.stdout.write(
      color(
        'dim',
        `\n${untracked.length} running moon(s) have no description: ` +
          `${untracked.map((p) => p.shortname).join(', ')}\n`,
      ),
    );
  }
  return EXIT_OK;
}

export { table };
