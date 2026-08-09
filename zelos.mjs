#!/usr/bin/env node
/**
 * zelos.mjs — the launcher.
 *
 * Bare `zelos` is the whole product: open the database, migrate it, start the
 * local server, print the one URL that gets you in, and open a browser at it.
 * Three subcommands hang off the side of that — `sweep`, `doctor` and `mcp` —
 * and none of them changes what the bare invocation does.
 *
 * Three ordering rules shape this file:
 *
 *   1. `--home` has to be in the environment BEFORE anything resolves where
 *      Zelos lives, so the heavy modules are imported after flags are parsed,
 *      not at the top of the file. That also makes `--help` and `--version`
 *      instant: neither pays for sqlite, TLS or the model adapter.
 *   2. The app must start even when nothing is configured. A missing model, no
 *      mail account, an unreachable keychain — none of those are a reason to
 *      refuse to boot. Walking the user through setup is the UI's job, and the
 *      UI cannot do it if the server never came up.
 *   3. `zelos mcp` owns stdout: it is a JSON-RPC channel, and one stray banner
 *      line corrupts the stream. Everything conversational goes to stderr.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `
Zelos — a local-first second brain.

  zelos [options]           Run it. This is the one you want.
  zelos sweep [options]     Read your sources once, think about them, print
                            what changed, and stop.
  zelos doctor [options]    Check every part of the setup and say, in plain
                            words, what to do about whatever is wrong.
  zelos mcp [options]       Serve the read-only MCP tools on stdin/stdout so
                            another AI client can read your board.

Options:
  --port <n>      Port to listen on (default 7777, or $ZELOS_PORT).
                  If it is busy, Zelos walks up until it finds a free one.
  --home <dir>    Where Zelos keeps its data (default ~/.zelos).
  --no-open       Do not open a browser; just print the URL.
  --sweep-now     Run a sweep immediately on start.
  --mode <kind>   sweep only: "full" asks the model, "light" just re-reads
                  your sources and re-sorts the board. Default full.
  --json          sweep and doctor only: print the result as JSON instead of
                  as sentences.
  --version       Print the version and exit.
  --help          Print this and exit.

Zelos listens on 127.0.0.1 only, and every request to its API needs the
session token printed in the launch URL. That token is new on every launch,
so the previous URL stops working when you restart.
`.trimStart();

/* ------------------------------------------------------------------ *
 * Flags
 * ------------------------------------------------------------------ */

/** The closed set. `run` is what a bare invocation means. */
export const COMMANDS = Object.freeze(['run', 'sweep', 'doctor', 'mcp']);

/** Which command each option is meaningful for. A flag that silently does
 *  nothing is a lie, so using one anywhere else is an error, not a shrug. */
const FLAG_SCOPE = {
  '--port': ['run'],
  '--no-open': ['run'],
  '--sweep-now': ['run'],
  '--mode': ['sweep'],
  '--json': ['sweep', 'doctor'],
  '--home': COMMANDS,
};

const SWEEP_MODES = ['auto', 'light', 'full'];

/** Supports both `--port 7777` and `--port=7777`. */
export function parseArgs(argv) {
  const out = {
    command: 'run',
    port: null,
    home: null,
    open: true,
    sweepNow: false,
    mode: null,
    json: false,
    version: false,
    help: false,
  };
  const used = new Set();
  let commandSeen = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let name = arg;
    let inline = null;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      name = arg.slice(0, eq);
      inline = arg.slice(eq + 1);
    }

    const valueOf = () => {
      if (inline !== null) return inline;
      const next = argv[++i];
      if (next === undefined) throw new Error(`${name} needs a value`);
      return next;
    };

    switch (name) {
      case '--port': case '-p': {
        // 0 is legal and means "any free port" — core/server.mjs listen()
        // implements it explicitly, so refusing it here would be the launcher
        // contradicting the server it starts.
        const port = Number(valueOf());
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be a port number, got ${port}`);
        out.port = port;
        used.add('--port');
        break;
      }
      case '--home':
        out.home = valueOf();
        used.add('--home');
        break;
      case '--no-open':
        out.open = false;
        used.add('--no-open');
        break;
      case '--sweep-now':
        out.sweepNow = true;
        used.add('--sweep-now');
        break;
      case '--mode': {
        const mode = valueOf();
        if (!SWEEP_MODES.includes(mode)) throw new Error(`--mode must be one of ${SWEEP_MODES.join(', ')}, got ${mode}`);
        out.mode = mode;
        used.add('--mode');
        break;
      }
      case '--json':
        out.json = true;
        used.add('--json');
        break;
      case '--version': case '-v':
        out.version = true;
        break;
      case '--help': case '-h':
        out.help = true;
        break;
      default: {
        if (arg.startsWith('-')) throw new Error(`unknown option ${arg}\n\nRun zelos --help to see what there is.`);
        // A bare word is the subcommand. `help` and `version` are accepted as
        // words too, because half the world types them that way.
        if (commandSeen) throw new Error(`unexpected argument ${arg}\n\nRun zelos --help to see what there is.`);
        commandSeen = true;
        if (arg === 'help') { out.help = true; break; }
        if (arg === 'version') { out.version = true; break; }
        if (arg === 'run') break;
        if (!COMMANDS.includes(arg)) {
          throw new Error(`unknown command ${arg}\n\nThere is ${COMMANDS.join(', ')}. Run zelos --help.`);
        }
        out.command = arg;
        break;
      }
    }
  }

  if (!out.help && !out.version) {
    for (const flag of used) {
      const scope = FLAG_SCOPE[flag] ?? COMMANDS;
      if (!scope.includes(out.command)) {
        throw new Error(`${flag} does not apply to "zelos ${out.command}" — it is for ${scope.map((c) => (c === 'run' ? 'zelos' : `zelos ${c}`)).join(' and ')}.`);
      }
    }
  }
  return out;
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/* ------------------------------------------------------------------ *
 * Browser
 * ------------------------------------------------------------------ */

/**
 * The URL is ours — built from the port we bound and the token we minted. It
 * is never derived from mail, a calendar or model output, and it is passed as
 * an argument to a known binary, never through a shell.
 */
function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {}); // no browser to open is not a failure to launch
    child.unref();
  } catch {
    /* likewise */
  }
}

/* ------------------------------------------------------------------ *
 * Banner
 * ------------------------------------------------------------------ */

const RULE = '━'.repeat(58);

function banner({ url, home, version, model, mailAccounts, calendars, auto }) {
  const lines = [
    '',
    `  ZELOS ${version}`,
    `  ${RULE}`,
    '',
    `  Open   ${url}`,
    '',
    `  Data   ${home}`,
    `  Model  ${model}`,
    `  Mail   ${mailAccounts}`,
    `  Cal    ${calendars}`,
    `  Sweep  ${auto}`,
    '',
    `  ${RULE}`,
    '  Listening on 127.0.0.1 only. The token in that URL is new every launch.',
    '  Ctrl-C to stop.',
    '',
  ];
  // Straight to stdout, not through the logger: the logger redacts anything
  // token-shaped, and this line is the one place the token has to be readable.
  process.stdout.write(`${lines.join('\n')}\n`);
}

/* ------------------------------------------------------------------ *
 * zelos doctor
 * ------------------------------------------------------------------ */

async function commandDoctor(flags) {
  const { doctor } = await import('./core/doctor.mjs');
  const { code, report, text } = await doctor({});
  process.stdout.write(flags.json ? `${JSON.stringify(report, null, 2)}\n` : text);
  return code;
}

/* ------------------------------------------------------------------ *
 * zelos sweep
 * ------------------------------------------------------------------ */

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** The human summary of one sweep. Numbers first, then anything that broke. */
function sweepSummary(result) {
  const s = result?.stats ?? {};
  const seconds = ((s.ms ?? 0) / 1000).toFixed(1);
  const lines = ['', `  ZELOS SWEEP`, `  ${RULE}`, ''];

  if (result?.ok) {
    lines.push(`  ${s.kind === 'light' ? 'Light' : 'Full'} sweep finished in ${seconds}s.`);
  } else {
    lines.push(`  Sweep failed after ${seconds}s.`);
    lines.push(`  ${result?.error ?? 'no reason given'}`);
  }
  lines.push('');
  lines.push(`  Read   ${plural(s.messages ?? 0, 'message')} and ${plural(s.events ?? 0, 'calendar entry', 'calendar entries')}`
    + `${(s.newMessages ?? 0) + (s.newEvents ?? 0) > 0 ? ` (${(s.newMessages ?? 0) + (s.newEvents ?? 0)} new)` : ''}`);
  if (result?.ok) {
    lines.push(`  Board  ${plural(s.items ?? 0, 'open item')}, ${s.now ?? 0} needing you now`);
  }
  if ((s.tokensIn ?? 0) + (s.tokensOut ?? 0) > 0) {
    lines.push(`  Model  ${s.tokensIn} tokens in, ${s.tokensOut} out`);
  }

  const failed = (s.sources ?? []).filter((src) => !src.ok);
  if (failed.length) {
    lines.push('');
    lines.push(`  ${plural(failed.length, 'source')} could not be read:`);
    for (const src of failed) lines.push(`    ${src.label}: ${src.error}`);
  }
  if (!result?.ok || failed.length) {
    lines.push('');
    lines.push('  Run `zelos doctor` — it checks every part of the setup and says,');
    lines.push('  in words, what to do about each thing that is wrong.');
  }

  lines.push('');
  lines.push(`  ${RULE}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function commandSweep(flags) {
  const { loadConfig, paths } = await import('./core/config.mjs');
  const { open: openDb, migrate, close: closeDb } = await import('./core/db.mjs');
  const { runSweep } = await import('./core/sweep.mjs');

  const config = loadConfig();
  const db = openDb(paths().db);
  migrate(db);

  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);

  // Progress goes to stderr so `zelos sweep --json | jq` still works.
  let lastPhase = null;
  let result;
  try {
    result = await runSweep({
      db,
      config,
      mode: flags.mode ?? 'full',
      signal: controller.signal,
      onProgress: ({ phase, message }) => {
        if (flags.json || phase === lastPhase) return;
        lastPhase = phase;
        process.stderr.write(`  … ${message}\n`);
      },
    });
  } catch (err) {
    process.stderr.write(`zelos sweep: ${err?.message ?? err}\n`);
    closeDb(db);
    return 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }

  process.stdout.write(flags.json ? `${JSON.stringify(result, null, 2)}\n` : sweepSummary(result));
  closeDb(db);
  return result.ok ? 0 : 1;
}

/* ------------------------------------------------------------------ *
 * zelos mcp
 * ------------------------------------------------------------------ */

/**
 * Rule 3 lives here: stdout is the JSON-RPC transport, so this function writes
 * nothing to it. The AI client on the other end spawned us and will close stdin
 * when it is done, which is what ends the server.
 */
async function commandMcp() {
  const { loadConfig } = await import('./core/config.mjs');
  const { log } = await import('./core/log.mjs');

  let serveStdio;
  try {
    ({ serveStdio } = await import('./core/mcp.mjs'));
  } catch (err) {
    process.stderr.write(`zelos mcp: this copy of Zelos has no MCP server (${err?.message ?? err})\n`);
    return 1;
  }

  if (loadConfig()?.ai?.enabled !== true) {
    // Not fatal — the server decides what to refuse, not the launcher. But an
    // assistant that gets an empty tool list deserves to know why, and stderr
    // is the one channel here that is not the JSON-RPC stream.
    log.warn('zelos mcp: AI access is switched off in Settings, so nothing is exposed yet');
  }

  try {
    /* The database and the config are deliberately left to serveStdio. It
       re-reads the config as it serves, so a scope switched off in Settings
       stops being answered without the AI client having to reconnect — a
       snapshot passed in from here would keep serving the old permissions. */
    await serveStdio({ logger: log });
    return 0;
  } catch (err) {
    process.stderr.write(`zelos mcp: ${err?.stack ?? err}\n`);
    return 1;
  }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

export async function main(argv = process.argv.slice(2)) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`zelos: ${err.message}\n`);
    return 2;
  }

  if (flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (flags.version) {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }

  // Rule 1: the home directory has to be settled before any module resolves it.
  if (flags.home) process.env.ZELOS_HOME = path.resolve(flags.home);

  if (flags.command === 'doctor') return commandDoctor(flags);
  if (flags.command === 'sweep') return commandSweep(flags);
  if (flags.command === 'mcp') return commandMcp(flags);

  const { loadConfig, paths } = await import('./core/config.mjs');
  const { open: openDb, migrate, close: closeDb } = await import('./core/db.mjs');
  const { createServer, listen } = await import('./core/server.mjs');
  const { isLocalAddress } = await import('./core/llm.mjs');
  const { log } = await import('./core/log.mjs');

  const config = loadConfig();
  const where = paths();
  const db = openDb(where.db);
  migrate(db);

  const server = createServer({ db, config });

  /* The scheduler is optional: if the sweep engine cannot be loaded, the board
     is still worth looking at and sweeps can still be run by hand. Its progress
     is relayed onto the same SSE stream a hand-started sweep uses, so a board
     that changes on its own says why. */
  let scheduler = null;
  if (config.sweep.auto) {
    try {
      const { Scheduler } = await import('./core/sweep.mjs');
      scheduler = new Scheduler({
        db,
        config,
        onProgress: (progress) => server.zelos.sweeps.relay('progress', progress),
        onRun: (result) => server.zelos.sweeps.relay(result?.ok === false ? 'failed' : 'done', result),
      });
      server.zelos.useScheduler(scheduler);
    } catch (err) {
      log.error('zelos: the sweep scheduler could not start; run sweeps by hand', { error: err.message });
    }
  }

  const { tokenUrl } = await listen(server, { port: flags.port ?? undefined });

  const modelLine = config.model.model
    ? `${config.model.label || config.model.protocol} · ${config.model.model}${isLocalAddress(config.model.baseUrl) ? ' (on this machine)' : ''}`
    : 'not set up yet — the app will walk you through it';
  const enabledMail = config.mail.filter((m) => m.enabled).length;
  const enabledCals = config.calendars.filter((c) => c.enabled).length;

  banner({
    url: tokenUrl,
    home: where.home,
    version: packageVersion(),
    model: modelLine,
    mailAccounts: enabledMail ? `${enabledMail} account${enabledMail === 1 ? '' : 's'}` : 'none yet',
    calendars: enabledCals ? `${enabledCals} calendar${enabledCals === 1 ? '' : 's'}` : 'none yet',
    auto: scheduler ? `every ${config.sweep.intervalMinutes}m between ${config.sweep.activeHours[0]}:00 and ${config.sweep.activeHours[1]}:00` : 'manual',
  });

  if (flags.open) openBrowser(tokenUrl);

  // Started after the banner so the URL is the first thing on screen.
  scheduler?.start();

  if (flags.sweepNow) {
    server.zelos.sweeps.start('full').catch((err) => {
      log.error('zelos: --sweep-now failed', { error: err.message });
    });
  }

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\n  Stopping (${signal}).\n`);
    try { scheduler?.stop(); } catch { /* it was already stopping */ }
    server.zelos.sweeps.abort();
    server.closeAllConnections?.(); // SSE clients hold the socket open forever
    server.close(() => {
      closeDb(db);
      process.exit(0);
    });
    // If a connection refuses to let go, leave anyway rather than hang a terminal.
    setTimeout(() => {
      closeDb(db);
      process.exit(0);
    }, 3_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Resolves only when the server closes, so `await main()` holds the process.
  await new Promise((resolve) => server.on('close', resolve));
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code || 0;
      /* A model probe or an IMAP check can leave a keep-alive socket behind.
         The work is finished and the output is written, so do not sit on
         someone's terminal waiting for a pool to time out. The timer is
         unref'd, so it fires only if something else is still holding the loop
         open — a clean run exits before it ever comes due. */
      setTimeout(() => process.exit(process.exitCode), 250).unref();
    },
    (err) => {
      process.stderr.write(`zelos: ${err?.stack || err}\n`);
      process.exit(1);
    },
  );
}
