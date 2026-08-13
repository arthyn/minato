import { execFileSync } from 'node:child_process';
import type { Proc } from './live.ts';

export type SessionKind = 'screen' | 'tmux' | 'daemon';

export interface SessionInfo {
  kind: 'screen' | 'tmux';
  name: string;
}

/** Sessions minato creates are prefixed, so its own are distinguishable. */
export function sessionName(shortname: string): string {
  return `minato-${shortname}`;
}

function have(tool: string): boolean {
  try {
    execFileSync('command', ['-v', tool], { stdio: 'ignore', shell: '/bin/sh' });
    return true;
  } catch {
    return false;
  }
}

export function sessionToolAvailable(kind: SessionKind): boolean {
  return kind === 'daemon' ? true : have(kind);
}

/**
 * Classify how a running ship is supervised, by walking up from its king.
 *
 * The trees differ by tool and neither looks like a plain shell:
 *   screen:  SCREEN -> login -> .run
 *   tmux:    tmux server -> .run
 *
 * So a session-managed ship must not be reported as terminal-bound — it
 * survives the terminal, which is the whole point of running it this way.
 */
export function detectSession(procs: Proc[], kingPid: number): SessionInfo | null {
  let pid = kingPid;
  for (let depth = 0; depth < 6; depth += 1) {
    const proc = procs.find((p) => p.pid === pid);
    if (!proc || proc.ppid <= 1) return null;
    const parent = procs.find((p) => p.pid === proc.ppid);
    if (!parent) return null;

    const command = parent.command;
    if (/(^|\/)SCREEN\b/.test(command) || /(^|\/)screen\b/.test(command)) {
      // `SCREEN -dmS <name> …` carries the session name in argv.
      const name = command.match(/-[a-zA-Z]*S\s+(\S+)/)?.[1] ?? '';
      return { kind: 'screen', name };
    }
    if (/(^|\/)tmux\b/.test(command)) {
      return { kind: 'tmux', name: tmuxSessionFor(proc.pid) ?? '' };
    }
    pid = parent.pid;
  }
  return null;
}

/** tmux's server argv carries no session name, so ask tmux which pane owns it. */
function tmuxSessionFor(pid: number): string | null {
  try {
    const out = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_pid} #{session_name}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      const [panePid, name] = line.trim().split(/\s+/);
      if (Number(panePid) === pid) return name;
    }
  } catch {
    // no server, or tmux unavailable
  }
  return null;
}

/** Argv that launches `command` inside a detached session of the given kind. */
export function wrapForSession(
  kind: SessionKind,
  name: string,
  command: string,
  args: string[],
): { file: string; argv: string[] } {
  if (kind === 'screen') {
    return { file: 'screen', argv: ['-dmS', name, command, ...args] };
  }
  if (kind === 'tmux') {
    return { file: 'tmux', argv: ['new-session', '-d', '-s', name, command, ...args] };
  }
  return { file: command, argv: args };
}

/** Command the user runs to get a dojo on a session-managed ship. */
export function attachCommand(session: SessionInfo): string[] {
  return session.kind === 'screen'
    ? ['screen', '-r', session.name]
    : ['tmux', 'attach', '-t', session.name];
}
