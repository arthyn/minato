import { getMeta, loadConfig, loadState, saveState, setMeta } from '../config.ts';
import { readAllPiers, resolvePier } from '../discover.ts';
import { color, confirm } from '../ui.ts';
import { EXIT_OK, EXIT_SAFETY } from './start.ts';

export interface ArchiveOptions {
  moon: string;
  note?: string;
  yes?: boolean;
}

/**
 * Mark a pier as never-boot.
 *
 * The common case is a copy of a ship whose live instance runs somewhere else:
 * booting it would put two instances of the same ship on the network, which can
 * corrupt the live one. `start` and `restart` refuse outright for archived
 * piers, with no override — undoing it requires `unarchive`.
 */
export async function archiveCommand(opts: ArchiveOptions): Promise<number> {
  const config = loadConfig();
  const state = loadState();
  const piers = readAllPiers(config, state);
  const pier = resolvePier(piers, opts.moon);

  if (pier.state === 'running') {
    process.stderr.write(
      `${color('red', 'refusing to archive')} ~${pier.ship}: it is running on port ` +
        `${pier.ports.public ?? '?'}.\nStop it first if you really mean to archive it.\n`,
    );
    return EXIT_SAFETY;
  }

  setMeta(state, pier.path, { archived: true, ...(opts.note ? { notes: opts.note } : {}) });
  saveState(state);
  process.stdout.write(
    `${color('green', 'archived')} ~${pier.ship}\n  ${pier.path}\n` +
      color('dim', '  start/restart will now refuse for this pier\n'),
  );
  return EXIT_OK;
}

export async function unarchiveCommand(opts: ArchiveOptions): Promise<number> {
  const config = loadConfig();
  const state = loadState();
  const piers = readAllPiers(config, state);
  const pier = resolvePier(piers, opts.moon);

  if (!pier.archived) {
    process.stdout.write(`~${pier.ship} is not archived\n`);
    return EXIT_OK;
  }

  const note = getMeta(state, pier.path).notes;
  process.stdout.write(`${color('bold', `~${pier.ship}`)}\n  ${pier.path}\n`);
  if (note) process.stdout.write(`  note: ${note}\n`);
  process.stdout.write(
    color(
      'yellow',
      '\nIf this pier is a copy of a ship that runs elsewhere, booting it puts a\n' +
        'second instance of that ship on the network and can corrupt the live one.\n',
    ),
  );

  if (!opts.yes && !(await confirm('unarchive anyway?'))) {
    process.stdout.write('cancelled\n');
    return EXIT_OK;
  }

  setMeta(state, pier.path, { archived: false });
  saveState(state);
  process.stdout.write(`${color('green', 'unarchived')} ~${pier.ship}\n`);
  return EXIT_OK;
}
