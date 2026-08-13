import { spawnSync } from 'node:child_process';
import { loadConfig, loadState } from '../config.ts';
import { readAllPiers, resolvePier } from '../discover.ts';
import { attachCommand } from '../session.ts';
import { color } from '../ui.ts';
import { EXIT_OK, EXIT_VALIDATION } from './start.ts';

export interface DojoOptions {
  moon: string;
  /** Print the attach command instead of running it. */
  print?: boolean;
}

/**
 * Attach to a ship's dojo.
 *
 * Only possible when the ship runs inside a screen/tmux session: a `-d` daemon
 * has no terminal to attach to at all, which is the trade that mode makes.
 */
export async function dojoCommand(opts: DojoOptions): Promise<number> {
  const config = loadConfig();
  const pier = resolvePier(readAllPiers(config, loadState()), opts.moon);

  if (pier.state !== 'running') {
    process.stderr.write(`~${pier.ship} is ${pier.state}; nothing to attach to\n`);
    return EXIT_VALIDATION;
  }
  if (!pier.session) {
    process.stderr.write(
      `${color('red', 'no session')} ~${pier.ship} is running detached, so it has no terminal.\n` +
        `Restart it inside one to get a dojo:\n` +
        `  minato restart ${pier.shortname} --session tmux\n`,
    );
    return EXIT_VALIDATION;
  }

  const argv = attachCommand(pier.session);
  if (opts.print) {
    process.stdout.write(`${argv.join(' ')}\n`);
    return EXIT_OK;
  }

  // Hand the terminal over; this replaces minato for the rest of the session.
  const res = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit' });
  return res.status ?? EXIT_OK;
}
