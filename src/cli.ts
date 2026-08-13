#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { listCommand } from './commands/list.ts';
import { doctorCommand } from './commands/doctor.ts';
import { startCommand, EXIT_OK, EXIT_VALIDATION } from './commands/start.ts';
import { stopCommand } from './commands/stop.ts';
import { mcpStatusCommand, mcpSyncCommand } from './commands/mcpSync.ts';
import { newCommand } from './commands/new.ts';
import { archiveCommand, unarchiveCommand } from './commands/archive.ts';
import { describeCommand, workAddCommand, workDoneCommand, workListCommand } from './commands/work.ts';
import { mcpInstallCommand } from './commands/mcpInstall.ts';
import { mcpRegisterCommand } from './commands/mcpRegister.ts';
import { getMeta, loadConfig, loadState, saveState, setMeta } from './config.ts';
import { mountedDesks } from './desks.ts';
import { auditMcp } from './mcp.ts';
import { readAllPiers, resolvePier } from './discover.ts';
import { color, humanAge, humanBytes } from './ui.ts';

const USAGE = `minato — lifecycle and MCP wiring for local Urbit moons

usage
  minato new [shortname] [--planet <ship|url>] [--dir <path>] [--port <n>]
             [--hosted] [--desk <desk>] [--no-mcp] [--dry-run] [--yes]
  minato list [--state <s>] [--size] [--all] [--json]
  minato inspect <moon>
  minato doctor [moon] [--json]
  minato name <moon|pier-path> <shortname>
  minato describe <moon> <one-line description>
  minato work [moon] [--json]                    directory of work in flight
  minato work add <moon> "<note>" [--desk d] [--repo r] [--branch b] [--link url]
  minato work done <moon> <id>
  minato archive <moon> [--note <text>]     mark never-boot
  minato unarchive <moon>
  minato start <moon> [--port <n>] [--yes]
  minato stop <moon> [--yes] [--timeout <s>]
  minato restart <moon> [--port <n>] [--yes]
  minato mcp status [--json]
  minato mcp install <moon> [--repo <path>] [--click <path>] [--dry-run]
  minato mcp register <moon> [--name <entry>] [--dry-run]
  minato mcp sync [--dry-run] [--yes]

<moon> is a shortname, ship name, or pier path.

exit codes
  0 ok   2 bad input   4 safety refusal   5 operation failed
`;

const OPTIONS = {
  state: { type: 'string' },
  planet: { type: 'string' },
  note: { type: 'string' },
  repo: { type: 'string' },
  click: { type: 'string' },
  name: { type: 'string' },
  mcp: { type: 'boolean' },
  'no-mcp': { type: 'boolean' },
  branch: { type: 'string' },
  link: { type: 'string' },
  id: { type: 'string' },
  ship: { type: 'string' },
  'key-file': { type: 'string' },
  dir: { type: 'string' },
  desk: { type: 'string' },
  hosted: { type: 'boolean' },
  port: { type: 'string' },
  timeout: { type: 'string' },
  size: { type: 'boolean' },
  all: { type: 'boolean' },
  json: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

async function inspectCommand(moon: string): Promise<number> {
  const config = loadConfig();
  const state = loadState();
  const piers = readAllPiers(config, state, { withSize: true });
  const pier = resolvePier(piers, moon);
  const meta = getMeta(state, pier.path);

  const field = (label: string, value: string): void => {
    process.stdout.write(`  ${color('dim', label.padEnd(12))}${value}\n`);
  };
  process.stdout.write(`${color('bold', `~${pier.ship}`)}\n`);
  if (meta.description) process.stdout.write(`  ${meta.description}\n`);
  field('shortname', pier.shortname);
  field('state', pier.state);
  field('path', pier.path);
  field('vere', pier.vere ?? 'unknown');
  field('ports', pier.ports.public ? `${pier.ports.public} public, ${pier.ports.loopback ?? '?'} loopback` : '-');
  field('pids', pier.pids.length ? pier.pids.join(', ') : '-');
  field('activity', humanAge(pier.lastActivity));
  field('size', humanBytes(pier.sizeBytes));

  // What this moon is associated with: the work recorded against it, the desks
  // it carries, and the agents that can reach it. Scattered across three
  // commands before, which meant nobody saw it.
  const work = meta.work ?? [];
  if (work.length) {
    process.stdout.write(`\n${color('bold', 'work in flight')}\n`);
    for (const w of work) {
      process.stdout.write(`  ${color('yellow', '•')} ${color('bold', w.id)}  ${w.note}\n`);
      const bits = [
        w.desk && `desk %${w.desk}`,
        w.repo && `repo ${w.repo}`,
        w.branch && `branch ${w.branch}`,
        w.link,
      ].filter(Boolean);
      for (const b of bits) process.stdout.write(`      ${color('dim', String(b))}\n`);
      process.stdout.write(`      ${color('dim', `opened ${humanAge(new Date(w.started))}`)}\n`);
    }
  } else if (!meta.description) {
    process.stdout.write(
      `\n${color('dim', `no work recorded — minato describe ${pier.shortname} "<what it is for>"`)}\n`,
    );
  }

  const desks = mountedDesks(pier.path).filter((d) => d.name !== 'base');
  if (desks.length) {
    process.stdout.write(`\n${color('bold', 'desks')}  ${color('dim', '(mounted, detected)')}\n`);
    for (const d of desks) {
      process.stdout.write(
        `  %${d.name}${d.docket ? color('dim', ' (app)') : ''}` +
          `${d.lastTouched ? color('dim', `  touched ${humanAge(d.lastTouched)}`) : ''}\n`,
      );
    }
  }

  const mine = auditMcp(config, piers).filter((e) => e.pier?.path === pier.path);
  if (mine.length) {
    process.stdout.write(`\n${color('bold', 'reachable by')}\n`);
    for (const e of mine) {
      const mark = e.status === 'ok' ? color('green', 'ok') : color('yellow', e.status);
      // Scope matters: the same name can exist globally and per-project, and
      // without it the two read as one duplicated entry.
      const scope = e.ref.scope === 'global' ? '' : color('dim', ` [${e.ref.scope}]`);
      process.stdout.write(
        `  ${mark}  ${e.ref.agent}${scope} "${e.ref.name}" -> ${e.ref.url}\n`,
      );
    }
  } else {
    process.stdout.write(
      `\n${color('dim', `no agent config points here — minato mcp register ${pier.shortname}`)}\n`,
    );
  }

  if (pier.issues.length) {
    process.stdout.write(`\n${color('bold', 'issues')}\n`);
    for (const issue of pier.issues) {
      const tag = issue.level === 'error' ? color('red', 'error') : color('yellow', ' warn');
      process.stdout.write(`  ${tag}  ${issue.message}\n`);
      if (issue.fix) process.stdout.write(`         ${color('dim', `fix: ${issue.fix}`)}\n`);
    }
  }
  return EXIT_OK;
}

async function nameCommand(moon: string, shortname: string): Promise<number> {
  const config = loadConfig();
  const state = loadState();
  const piers = readAllPiers(config, state);
  const pier = resolvePier(piers, moon);

  const taken = piers.find(
    (p) => p.path !== pier.path && p.shortname.toLowerCase() === shortname.toLowerCase(),
  );
  if (taken) {
    process.stderr.write(`shortname "${shortname}" is already used by ${taken.path}\n`);
    return EXIT_VALIDATION;
  }

  setMeta(state, pier.path, { shortname });
  saveState(state);
  process.stdout.write(`${pier.path} is now ${color('bold', shortname)}\n`);
  return EXIT_OK;
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ options: OPTIONS, allowPositionals: true });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return EXIT_VALIDATION;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (values.help || !command) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }

  const port = values.port ? Number(values.port) : undefined;
  if (values.port && !Number.isInteger(port)) {
    process.stderr.write(`invalid --port: ${values.port}\n`);
    return EXIT_VALIDATION;
  }

  switch (command) {
    case 'new':
      return newCommand({
        shortname: rest[0],
        planet: values.planet,
        ship: values.ship,
        keyFile: values['key-file'],
        dir: values.dir,
        desk: values.desk,
        hosted: values.hosted,
        port,
        dryRun: values['dry-run'],
        yes: values.yes,
        json: values.json,
        mcp: values['no-mcp'] ? false : true,
        mcpRepo: values.repo,
      });

    case 'list':
    case 'ls':
      return listCommand({ state: values.state, json: values.json, size: values.size, all: values.all });

    case 'inspect':
      if (!rest[0]) {
        process.stderr.write('inspect requires a moon\n');
        return EXIT_VALIDATION;
      }
      return inspectCommand(rest[0]);

    case 'doctor':
      return doctorCommand({ moon: rest[0], json: values.json });

    case 'archive':
      if (!rest[0]) {
        process.stderr.write('archive requires a moon\n');
        return EXIT_VALIDATION;
      }
      return archiveCommand({ moon: rest[0], note: values.note, yes: values.yes });

    case 'unarchive':
      if (!rest[0]) {
        process.stderr.write('unarchive requires a moon\n');
        return EXIT_VALIDATION;
      }
      return unarchiveCommand({ moon: rest[0], yes: values.yes });

    case 'describe':
      if (!rest[0] || rest.length < 2) {
        process.stderr.write('usage: minato describe <moon> <one-line description>\n');
        return EXIT_VALIDATION;
      }
      return describeCommand({ moon: rest[0], description: rest.slice(1).join(' ') });

    case 'work': {
      const sub = rest[0];
      if (sub === 'add') {
        return workAddCommand({
          moon: rest[1],
          note: rest.slice(2).join(' ') || undefined,
          desk: values.desk,
          repo: values.repo,
          branch: values.branch,
          link: values.link,
          id: values.id,
        });
      }
      if (sub === 'done' || sub === 'close') {
        return workDoneCommand({ moon: rest[1], id: rest[2] ?? values.id });
      }
      return workListCommand({ moon: sub, json: values.json, all: values.all });
    }

    case 'name':
      if (!rest[0] || !rest[1]) {
        process.stderr.write('name requires a moon and a shortname\n');
        return EXIT_VALIDATION;
      }
      return nameCommand(rest[0], rest[1]);

    case 'start':
      if (!rest[0]) {
        process.stderr.write('start requires a moon\n');
        return EXIT_VALIDATION;
      }
      return startCommand({ moon: rest[0], port, yes: values.yes, json: values.json });

    case 'stop':
      if (!rest[0]) {
        process.stderr.write('stop requires a moon\n');
        return EXIT_VALIDATION;
      }
      return stopCommand({
        moon: rest[0],
        yes: values.yes,
        timeout: values.timeout ? Number(values.timeout) : undefined,
      });

    case 'restart': {
      if (!rest[0]) {
        process.stderr.write('restart requires a moon\n');
        return EXIT_VALIDATION;
      }
      const stopped = await stopCommand({
        moon: rest[0],
        yes: values.yes,
        timeout: values.timeout ? Number(values.timeout) : undefined,
      });
      // Only boot again if the ship is confirmed down; otherwise this would be
      // the double-boot the safety rules exist to prevent.
      if (stopped !== EXIT_OK) return stopped;
      return startCommand({ moon: rest[0], port, yes: true, json: values.json });
    }

    case 'mcp': {
      const sub = rest[0] ?? 'status';
      if (sub === 'sync') {
        return mcpSyncCommand({ dryRun: values['dry-run'], yes: values.yes, json: values.json });
      }
      if (sub === 'status') return mcpStatusCommand({ json: values.json });
      if (sub === 'register') {
        if (!rest[1]) {
          process.stderr.write('usage: minato mcp register <moon>\n');
          return EXIT_VALIDATION;
        }
        return mcpRegisterCommand({
          moon: rest[1],
          name: values.name,
          click: values.click,
          yes: values.yes,
          dryRun: values['dry-run'],
        });
      }
      if (sub === 'install') {
        if (!rest[1]) {
          process.stderr.write('usage: minato mcp install <moon>\n');
          return EXIT_VALIDATION;
        }
        return mcpInstallCommand({
          moon: rest[1],
          repo: values.repo,
          click: values.click,
          yes: values.yes,
          dryRun: values['dry-run'],
        });
      }
      process.stderr.write(`unknown mcp subcommand: ${sub}\n`);
      return EXIT_VALIDATION;
    }

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return EXIT_VALIDATION;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: Error) => {
    process.stderr.write(`${color('red', 'error')} ${err.message}\n`);
    process.exit(EXIT_VALIDATION);
  });
