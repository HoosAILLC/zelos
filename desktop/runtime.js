/**
 * desktop/runtime.js — the Zelos core, running inside the Electron main process.
 *
 * There is no second Node process. `zelos.mjs` and this file do the same six
 * things — load the config, open and migrate the database, build the server,
 * arm the scheduler, bind 127.0.0.1, hand back the URL — and forking a child
 * would only buy a second copy of sqlite fighting over the same WAL, plus a pipe
 * to marshal shutdown across. Electron's main process *is* Node; the core is
 * imported into it directly.
 *
 * Nothing here imports Electron, and the core is reached through `root` rather
 * than a static specifier, because that path moves when the app is packaged:
 * in development the core sits next to this file at `../core`, and in a build it
 * is unpacked into `Contents/Resources`. One argument, one place to be wrong.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** How long a shutdown waits for the socket before leaving anyway. */
const CLOSE_GRACE_MS = 3_000;
/** And how long it waits for an aborted sweep to put the database down. */
const SWEEP_GRACE_MS = 2_000;

/**
 * A sweep is aborted, not killed: the run still has to unwind past whatever
 * await it was sitting on. Closing the database out from under it turns that
 * unwind into "database is not open" on a write that was already doomed — so
 * wait for it, briefly, and carry on regardless if it will not let go.
 */
async function waitForSweepToSettle(server, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (server.zelos.sweeps.status().running && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 25).unref?.(); });
  }
}

async function loadCore(root) {
  const load = (rel) => import(pathToFileURL(path.join(root, 'core', rel)).href);
  const [config, db, server, sweep, logmod] = await Promise.all([
    load('config.mjs'),
    load('db.mjs'),
    load('server.mjs'),
    load('sweep.mjs').catch(() => null), // optional: a broken sweep engine must not stop the board
    load('log.mjs'),
  ]);
  return { config, db, server, sweep, log: logmod };
}

/**
 * Start everything and bind the port.
 *
 * `home` and `port` come from the shell's own flags; both are optional and both
 * default to what the core would have chosen on its own. A `port` of 0 means
 * "any free port", which is what the tests use so they never collide with a
 * Zelos the user is actually running.
 *
 * Resolves a handle carrying the URL to open (token included — it is the only
 * way in), the pieces the shell needs to drive, and a `stop()` that is safe to
 * call twice.
 */
export async function startCore({ root, home = null, port = null } = {}) {
  if (!root) throw new TypeError('startCore needs the directory the core lives in');
  // Before anything resolves where Zelos keeps its data.
  if (home) process.env.ZELOS_HOME = path.resolve(home);

  const core = await loadCore(root);

  const config = core.config.loadConfig();
  const where = core.config.paths();

  // A packaged app has no terminal, so the log file is the only place a
  // diagnosis can come from. core/log.mjs redacts on the way in.
  const logger = core.log.createLogger({
    dir: where.logsDir,
    level: process.env.ZELOS_LOG_LEVEL || 'info',
    name: 'desktop',
  });

  const db = core.db.open(where.db);
  core.db.migrate(db);

  const server = core.server.createServer({ db, config, logger });

  // Same ordering as the CLI launcher: the server exists first so the
  // scheduler's progress has somewhere to be reported, then the scheduler is
  // adopted, then both start.
  let scheduler = null;
  if (config.sweep.auto && !core.sweep?.Scheduler) {
    logger.error('desktop: the sweep engine did not load, so nothing will sweep on a schedule');
  } else if (config.sweep.auto) {
    try {
      scheduler = new core.sweep.Scheduler({
        db,
        config,
        onProgress: (progress) => server.zelos.sweeps.relay('progress', progress),
        onRun: (result) => server.zelos.sweeps.relay(result?.ok === false ? 'failed' : 'done', result),
      });
      server.zelos.useScheduler(scheduler);
    } catch (err) {
      scheduler = null;
      logger.error('desktop: the sweep scheduler could not start; sweeps must be run by hand', { error: err.message });
    }
  }

  const bound = await core.server.listen(server, { port: port === null ? undefined : port });
  scheduler?.start();

  let stopping = null;

  const handle = {
    root,
    config,
    paths: where,
    db,
    server,
    scheduler,
    logger,
    port: bound.port,
    url: bound.url,
    tokenUrl: bound.tokenUrl,
    token: server.sessionToken,

    /**
     * Run a sweep now. This goes straight to the supervisor rather than through
     * the HTTP API: the tray is inside the process that owns it, so there is no
     * socket, no token and no round trip to get wrong. Progress still reaches
     * the open board, because every listener on /api/sweep/stream is attached to
     * this same supervisor.
     */
    async sweepNow(mode = 'auto') {
      try {
        return await server.zelos.sweeps.start(mode);
      } catch (err) {
        // A 409 from the supervisor means one is already running — which, for a
        // menu item, is the answer rather than a failure.
        logger.info('desktop: sweep not started', { reason: err.message });
        return { started: false, reason: err.message };
      }
    },

    sweepStatus() {
      return server.zelos.sweeps.status();
    },

    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        try { scheduler?.stop(); } catch { /* it was already stopping */ }
        server.zelos.sweeps.abort();
        await waitForSweepToSettle(server, SWEEP_GRACE_MS);
        await new Promise((resolve) => {
          const done = setTimeout(resolve, CLOSE_GRACE_MS);
          done.unref?.();
          // An open SSE stream holds its socket for as long as the board is
          // open, which is forever as far as server.close() is concerned.
          server.closeAllConnections?.();
          server.close(() => {
            clearTimeout(done);
            resolve();
          });
        });
        try { core.db.close(db); } catch (err) { logger.warn('desktop: the database did not close cleanly', { error: err.message }); }
        logger.close?.();
      })();
      return stopping;
    },
  };

  logger.info('desktop: the core is up', { port: bound.port, home: where.home, root });
  return handle;
}
