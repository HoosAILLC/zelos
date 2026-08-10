/**
 * test/router-table.mjs — the router's route table, read out of the router.
 *
 * Not a test file. It holds one function, and it exists because the same list
 * was hand-written in two suites and both were wrong in the same way.
 *
 * `test/security.test.mjs` makes the "no /api route answers a stranger" claim
 * and `test/ai-security.test.mjs` makes the "an AI token authorises no other
 * route" claim, and each iterated a literal restating core/server.mjs's `ROUTES`
 * beside it: 19 of 27 routes in the first, 23 of 27 in the second. Neither
 * listed `/api/sample-data` — three handlers that seed and destroy board rows.
 * Measured by mutation on the first of them: gutting both write handlers, and
 * separately adding an unauthenticated pre-gate carve-out that returned the
 * whole config, each left the suite at 1022 pass / 0 fail. The same carve-out on
 * a route that WAS in the literal turned it red, which is what isolated the gap
 * to the list rather than to the gate.
 *
 * Nothing warned, because nothing compared the list with the table: a route
 * added to core/server.mjs arrived already exempt from both adversarial passes.
 * So the table is parsed out of the source. A route added there is covered the
 * moment it is added, and a route this parser cannot read is a failure rather
 * than a silent omission.
 *
 * Two things a caller still owes its readers, because neither belongs here:
 *
 *  - Prove the paths reach the router. A parser that quietly emitted
 *    "/api/heXlth" would leave a suite asserting 401 on a path that does not
 *    exist — which every path answers, since both gates run before routing.
 *    That is a green test proving nothing, i.e. the same failure as the literal
 *    it replaced. Both callers probe with OPTIONS, which matches no route and
 *    runs no handler: the router answers out of the table alone.
 *  - `/api/mcp` is deliberately absent from `ROUTES` (core/server.mjs:2045) —
 *    it is lifted out of the pipeline before the session gate because it takes
 *    the other credential. So this function's output is exactly "every route
 *    that is not MCP", and the AI-token suite asserts that rather than assuming
 *    it.
 *
 * test/security.test.mjs still carries its own copy of this parser at :159. It
 * is not one of the files this pass owns, and the swap is one import plus a
 * deletion; until it happens, the two derivations read the same table from the
 * same file, so neither can drift away from the router — only from each other.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Routes whose handler needs a query string to be worth requesting at all. */
const ROUTE_QUERY = { '/api/search': '?q=x' };

/** -> [[method, requestPath], ...] for every route core/server.mjs serves. */
export function readRouterTable() {
  const source = fs.readFileSync(path.join(REPO, 'core', 'server.mjs'), 'utf8');
  const block = /\nconst ROUTES = \[\n([\s\S]*?)\n\];/.exec(source);
  if (!block) throw new Error('core/server.mjs has no ROUTES array this parser can read — fix the parser, do not restate the table');

  // `const ID = '([A-Za-z0-9_.:-]{1,80})'` — the segment pattern the table
  // interpolates for :id routes. A sample id stands in for it.
  const idConst = /\nconst ID = '(.+?)';/.exec(source);
  if (!idConst) throw new Error('core/server.mjs no longer defines ID; the :id routes cannot be turned into paths');
  const SAMPLE_ID = 'probe.id-1';
  if (!new RegExp(`^${idConst[1]}$`).test(SAMPLE_ID)) {
    throw new Error(`the sample id ${SAMPLE_ID} no longer matches the router's ID pattern ${idConst[1]}`);
  }

  // Two shapes appear in the table: a regex literal, and `new RegExp(`…`)` for
  // the ones that interpolate ID. `\/(.+?)\/\s*,` is anchored on the `/,` that
  // closes a literal, because the pattern bodies contain escaped slashes.
  const ROUTE = /\[\s*'([A-Z]+)'\s*,\s*(?:\/(.+?)\/\s*,|new RegExp\(`(.+?)`\)\s*,)/g;
  const rows = [];
  for (const m of block[1].matchAll(ROUTE)) {
    const method = m[1];
    const pattern = (m[2] ?? m[3])
      .replaceAll('${ID}', SAMPLE_ID)      // the interpolated segment
      .replaceAll('\\/', '/')              // an escaped slash is just a slash
      .replace(/^\^/, '')
      .replace(/\$$/, '');
    if (/[\\^$*+?()[\]{}|]/.test(pattern)) {
      throw new Error(`this parser cannot turn ${method} ${m[2] ?? m[3]} into a request path — it left ${pattern}`);
    }
    rows.push([method, `${pattern}${ROUTE_QUERY[pattern] ?? ''}`]);
  }

  // Every line of the table has to have been read. A row this regex skipped
  // would be a route silently exempt from the tests below it, which is the exact
  // failure this derivation exists to end.
  const declared = block[1].split('\n').filter((line) => /^\s*\['[A-Z]+'/.test(line)).length;
  if (rows.length !== declared) {
    throw new Error(`core/server.mjs declares ${declared} routes and this parser read ${rows.length}`);
  }
  if (rows.length < 25) throw new Error(`only ${rows.length} routes were read — the parser is broken`);
  return rows;
}
