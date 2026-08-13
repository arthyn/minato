import { loadConfig, loadState } from '../config.ts';
import { livenessDegraded, readAllPiers } from '../discover.ts';
import { getMeta } from '../config.ts';
import { color, humanAge, humanBytes, stateLabel, table } from '../ui.ts';

export interface ListOptions {
  state?: string;
  json?: boolean;
  size?: boolean;
  all?: boolean;
}

export async function listCommand(opts: ListOptions): Promise<number> {
  const config = loadConfig();
  const state = loadState();
  let piers = readAllPiers(config, state, { withSize: opts.size });

  // Computed before filtering: `--state running` would otherwise hide the fact
  // that some piers could not be assessed at all, and an empty result would
  // read as "nothing is running" when the truth is "this could not be told".
  const degraded = livenessDegraded(piers);
  const undetermined = piers.filter((p) => p.state === 'unknown');

  if (opts.state) piers = piers.filter((p) => p.state === opts.state);
  else if (!opts.all) piers = piers.filter((p) => !p.archived);

  // Most operationally relevant first: what's up, what's broken, then the rest.
  const order = { running: 0, ambiguous: 1, unknown: 2, stopped: 3, stale: 4, archived: 5 };
  piers.sort((a, b) => order[a.state] - order[b.state] || a.ship.localeCompare(b.ship));

  if (opts.json) {
    // Normal runs keep the plain-array contract. Degraded runs return an
    // object instead, so a caller cannot mistake a partial answer for a full
    // one without noticing the shape change.
    process.stdout.write(
      `${JSON.stringify(
        degraded
          ? {
              liveness: 'inferred',
              message:
                'The process table was unavailable. Ships shown as running were confirmed ' +
                'from .vere.lock. Piers with state "unknown" could NOT be assessed — that is ' +
                'not evidence they are stopped. start/stop are unavailable in this mode.',
              undetermined: undetermined.map((p) => p.ship),
              piers,
            }
          : piers,
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (piers.length === 0) {
    process.stdout.write('no piers found\n');
    return 0;
  }

  if (degraded) {
    process.stdout.write(
      `${color('yellow', 'LIVENESS INFERRED')} — no process table (sandboxed?).\n` +
        `Ships marked ${color('yellow', '*')} were confirmed from .vere.lock only. ` +
        `${undetermined.length} pier(s) show ${color('red', 'unknown')}:\n` +
        'that means undetermined, NOT stopped. start/stop are unavailable here.\n\n',
    );
  }

  const headers = ['SHORT', 'SHIP', 'STATE', 'PORT', 'VERE', 'ACTIVITY'];
  if (opts.size) headers.push('SIZE');
  headers.push('FOR', '');

  const rows = piers.map((p) => {
    const row = [
      color('bold', p.shortname),
      p.ship,
      stateLabel(p.state) + (p.livenessSource === 'inferred' ? color('yellow', '*') : ''),
      // A port on a stopped pier is only the last one it used — never a live
      // endpoint, so it is parenthesised rather than shown as if reachable.
      p.ports.public
        ? p.state === 'running'
          ? String(p.ports.public)
          : color('dim', `(${p.ports.public})`)
        : color('dim', '-'),
      p.vere ?? color('dim', '?'),
      humanAge(p.lastActivity),
    ];
    if (opts.size) row.push(humanBytes(p.sizeBytes));

    // What the moon is for, and how much is open on it. Kept in the default
    // table because a record nobody sees is a record nobody maintains.
    const meta = getMeta(state, p.path);
    const open = meta.work?.length ?? 0;
    const badge = open ? color('yellow', `${open}▸ `) : '';
    const desc = meta.description ?? '';
    const trimmed = desc.length > 38 ? `${desc.slice(0, 37)}…` : desc;
    row.push(
      badge + (trimmed || (p.state === 'running' ? color('dim', '(no description)') : '')),
    );

    const errs = p.issues.filter((i) => i.level === 'error').length;
    const warns = p.issues.filter((i) => i.level === 'warn').length;
    const flags = [
      errs ? color('red', `${errs} error`) : '',
      warns ? color('yellow', `${warns} warn`) : '',
    ].filter(Boolean);
    row.push(flags.join(' '));
    return row;
  });

  process.stdout.write(`${table(headers, rows)}\n`);

  const running = piers.filter((p) => p.state === 'running').length;
  const issues = piers.reduce((n, p) => n + p.issues.length, 0);
  process.stdout.write(
    color('dim', `\n${piers.length} piers, ${running} running, ${issues} issues (minato doctor)\n`),
  );
  return 0;
}
