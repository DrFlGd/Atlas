// @ts-check
/**
 * Checks whether a built app binary holds the code that fetches map images
 * from other servers, which only a build with `ATLAS_ENABLE_DOWNLOADS=1`
 * has ("Download map images", "Download location photos", "View map page and
 * save images as I browse").
 *
 *   node apps/desktop/scripts/check-binary.js [path/to/binary]
 *
 * For a viewer (`ATLAS_ENABLE_DOWNLOADS=0`) it fails when any of the markers
 * below is in the binary, so a viewer that could download cannot be
 * released by mistake; for a build with downloads (`ATLAS_ENABLE_DOWNLOADS=1`)
 * it fails when one is missing. Without the variable it expects what the
 * last `pnpm desktop:build` recorded (`src-tauri/atlas-build.json`), and a
 * viewer when there is no record. The binary defaults to the release build.
 * The markers are names of the download commands and texts of the
 * downloader and of the page script that saves map images, all of which are
 * compiled into the binary as they are.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { BUILD_RECORD, downloadsEnabled } from './build.js';

/** Texts only the download code puts into the binary. */
export const DOWNLOAD_MARKERS = [
  // Commands (the handler and the permission table name them).
  'tiles_start',
  'download_settings_set',
  'view_open',
  'photos_start',
  // A line the downloader writes to the activity log.
  'not asked for, because the area above them',
  // The script that keeps the map images a page loads.
  'var PREFIXES = ',
];

/**
 * Whether the binary under test should have downloads: as
 * `ATLAS_ENABLE_DOWNLOADS` says when it is set, else as the last build
 * recorded, else not.
 * @param {string | undefined} [value] the variable's value
 */
export async function expectDownloads(value = process.env.ATLAS_ENABLE_DOWNLOADS) {
  if (value !== undefined && value.trim() !== '') return downloadsEnabled(value);
  const record = await readFile(BUILD_RECORD, 'utf8').then(
    (text) => /** @type {{ downloads?: unknown }} */ (JSON.parse(text)),
    () => null,
  );
  return record?.downloads === true;
}

/**
 * The markers found in a binary.
 * @param {string} path
 */
export async function downloadMarkersIn(path) {
  const bytes = await readFile(path);
  return DOWNLOAD_MARKERS.filter((marker) => bytes.includes(Buffer.from(marker, 'utf8')));
}

/**
 * Checks a binary against the build it should be; returns the problem, or
 * null when it is as it should be.
 * @param {string} path @param {boolean} downloads
 */
export async function checkBinary(path, downloads) {
  const found = await downloadMarkersIn(path);
  if (downloads) {
    const missing = DOWNLOAD_MARKERS.filter((marker) => !found.includes(marker));
    return missing.length > 0
      ? `${path} was meant to download map images but lacks: ${missing.join(', ')}`
      : null;
  }
  return found.length > 0
    ? `${path} is a viewer build but holds download code: ${found.join(', ')}`
    : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const path =
    process.argv[2] ??
    fileURLToPath(new URL(`../src-tauri/target/release/atlas-desktop${exe}`, import.meta.url));
  const downloads = await expectDownloads();
  const found = await downloadMarkersIn(path);
  for (const marker of DOWNLOAD_MARKERS) {
    console.log(`${found.includes(marker) ? 'found ' : 'absent'} ${JSON.stringify(marker)}`);
  }
  const problem = await checkBinary(path, downloads);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(
    downloads
      ? `${path} holds the download code, as a build with downloads should.`
      : `${path} holds no download code.`,
  );
}
