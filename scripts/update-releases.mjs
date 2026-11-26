import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(ROOT, 'src/data/releases/software.json');
const RELEASES_PATH = path.join(ROOT, 'src/data/releases/releases.json');

const HISTORY_LIMIT = 20;
const REQUEST_DELAY_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'GetFOSS-Release-Tracker',
      ...headers,
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  return response.json();
}

function isStableVersion(version) {
  if (!version) return false;

  return !/(^|[._+-])(alpha|beta|bet[a0-9]|rc[0-9]*|nightly|dev|development|preview|pre|canary|snapshot|unstable)([._+-]|$)/i.test(
    version,
  ) && !/(a|b|rc)\d+$/i.test(version);
}

function normalizeRelease({
  version,
  date,
  url,
  notes = '',
}) {
  if (!version || !isStableVersion(version)) return null;

  const parsedDate = date ? new Date(date) : null;

  return {
    version: String(version),
    date:
      parsedDate && !Number.isNaN(parsedDate.valueOf())
        ? parsedDate.toISOString().slice(0, 10)
        : null,
    url: url || null,
    notes: typeof notes === 'string' ? notes : '',
  };
}

function sortAndLimit(releases) {
  const unique = new Map();

  for (const release of releases) {
    if (!release?.version || !isStableVersion(release.version)) continue;

    const existing = unique.get(release.version);

    if (!existing || (release.date && !existing.date)) {
      unique.set(release.version, release);
    }
  }

  return [...unique.values()]
    .sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date.localeCompare(a.date);
    })
    .slice(0, HISTORY_LIMIT);
}

async function getGitHubReleases(source) {
  const url = `https://api.github.com/repos/${source.owner}/${source.repository}/releases?per_page=100`;

  const headers = process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {};

  const data = await fetchJson(url, headers);

  return data
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) =>
      normalizeRelease({
        version: release.tag_name,
        date: release.published_at,
        url: release.html_url,
        notes: release.body,
      }),
    )
    .filter(Boolean);
}

async function getGitLabReleases(source) {
  const project = encodeURIComponent(source.project);
  const url = `${source.host}/api/v4/projects/${project}/releases?per_page=100&order_by=released_at&sort=desc`;

  const data = await fetchJson(url);

  return data
    .map((release) =>
      normalizeRelease({
        version: release.tag_name,
        date: release.released_at,
        url: release._links?.self || `${source.host}/${source.project}/-/releases/${encodeURIComponent(release.tag_name)}`,
        notes: release.description,
      }),
    )
    .filter(Boolean);
}

async function getGiteaReleases(source) {
  const url = `${source.host}/api/v1/repos/${source.owner}/${source.repository}/releases?limit=100&draft=false&pre-release=false`;

  const data = await fetchJson(url);

  return data
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) =>
      normalizeRelease({
        version: release.tag_name,
        date: release.published_at,
        url: release.html_url,
        notes: release.body,
      }),
    )
    .filter(Boolean);
}

async function getMozillaReleases(source) {
  const data = await fetchJson(source.url);
  const releases = Object.values(data.releases || {});

  return releases
    .filter((release) => ['major', 'stability'].includes(release.category))
    .map((release) =>
      normalizeRelease({
        version: release.version,
        date: release.date,
        url: `https://www.mozilla.org/firefox/${release.version}/releasenotes/`,
        notes: release.description || '',
      }),
    )
    .filter(Boolean);
}

async function getReleases(application) {
  const source = application.releaseSource;

  switch (source.type) {
    case 'github':
      return getGitHubReleases(source);

    case 'gitlab':
      return getGitLabReleases(source);

    case 'gitea':
      return getGiteaReleases(source);

    case 'mozilla-product-details':
      return getMozillaReleases(source);

    default:
      throw new Error(`Unsupported release source type: ${source.type}`);
  }
}

async function main() {
  const catalog = await readJson(CATALOG_PATH);
  const stored = await readJson(RELEASES_PATH);

  stored.applications ||= {};

  let successful = 0;
  let failed = 0;
  let skipped = 0;

  for (const application of catalog.applications) {
    const previous = stored.applications[application.id];

    if (application.releaseSource.type === 'libreoffice-directory') {
      console.log(`[SKIP] ${application.name}: LibreOffice adapter is not implemented yet.`);
      skipped++;
      continue;
    }

    try {
      await sleep(REQUEST_DELAY_MS);

      const fetched = await getReleases(application);

      if (fetched.length === 0) {
        throw new Error('No stable releases found. Existing data was preserved.');
      }

      const history = sortAndLimit([
        ...fetched,
        ...(previous?.history || []),
      ]);

      const latestStable = history[0];

      if (!latestStable) {
        throw new Error('Could not determine the latest stable release.');
      }

      stored.applications[application.id] = {
        latestStable,
        history,
        lastChecked: new Date().toISOString(),
      };

      console.log(
        `[OK] ${application.name}: ${latestStable.version} (${history.length} releases)`,
      );

      successful++;
    } catch (error) {
      console.error(`[ERROR] ${application.name}: ${error.message}`);
      failed++;
    }
  }

  if (successful > 0) {
    stored.lastUpdated = new Date().toISOString();
    await writeJson(RELEASES_PATH, stored);
  }

  console.log('\nRelease update summary:');
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped: ${skipped}`);

  if (failed > 0 || skipped > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Release update failed:', error);
  process.exitCode = 1;
});
