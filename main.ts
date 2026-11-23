// Token launch radar, entrypoint (Node 22, standard library only).
//
// Reads the sealed snapshot, scores every pre-token protocol with the
// category-calibrated model in lib/model.ts, and writes the entry's
// /output: board.json, data.js, the dashboard, the screenshots and the
// dossier the judge reads (buildDossier from the vendored make.fun
// library). The run is deterministic: same snapshot in, same bytes out.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

const TEXT_MAX_BYTES = 65_536;
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The value of --name <value> or --name=<value>, else `fallback`. */
function flag(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < args.length) return args[at + 1]!;
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = flag('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`radar: no snapshot at ${inputFile} (pass --input <snapshot.json|directory>)\n`);
  process.exit(2);
}
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`radar: board refused: ${issue}\n`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/** Copy a directory tree of regular files into `to`, skipping dot-names. */
function copyTree(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      copied.push(...copyTree(src, dst));
    } else if (entry.isFile()) {
      copyFileSync(src, dst);
      copied.push(entry.name);
    }
  }
  return copied;
}

const dashboardFiles = copyTree(join(here, 'dashboard'), join(outDir, 'dashboard'));
const shotNames = copyTree(join(here, 'screenshots'), join(outDir, 'screenshots'));
if (shotNames.length < 3) {
  process.stderr.write(`radar: screenshots/ holds ${shotNames.length} image(s): hand in 3\n`);
  process.exit(1);
}
for (const name of shotNames) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`radar: screenshots/${name}: bad image name\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output
// and compares bytes, so the call below must match it exactly.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: { max: 4, max_bytes: 524_288 },
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

const dashBytes = dashboardFiles.reduce((n, f) => n + statSync(join(here, 'dashboard', f)).size, 0);
if (dashBytes > TEXT_MAX_BYTES) {
  process.stderr.write(
    `radar: warning: dashboard source is ${dashBytes} bytes, past the ${TEXT_MAX_BYTES} the dossier shows whole\n`,
  );
}
const dossierBytes = statSync(join(outDir, 'dossier.json')).size;
process.stdout.write(
  `radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ` +
    `${board.length} rows (${radar.early_size} early), ${radar.live_size} live set aside\n` +
    `radar: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ` +
    `dashboard (${dashboardFiles.length} files, ${dashBytes} bytes), ` +
    `screenshots (${shotNames.length}), dossier.json (${dossierBytes} bytes)\n`,
);
