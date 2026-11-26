import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(ROOT, 'src/data/releases/software.json');
const RELEASES_PATH = path.join(ROOT, 'src/data/releases/releases.json');

const HISTORY_LIMIT = 20;
const REQUEST_DELAY_MS = 300;
const MAX_RELEASE_PAGES = 5;
const MAX_NOTES_LENGTH = 800;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function fetchResponse(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json, text/html',
      'User-Agent': 'GetFOSS-Release-Tracker',
      ...headers,
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  return response;
}

async function fetchJson(url, headers = {}) {
  const response = await fetchResponse(url, headers);
  return response.json();
}

async function fetchText(url) {
  const response = await fetchResponse(url);
  return response.text();
}

function isStableVersion(version) {
  if (!version) return false;

  const value = String(version).trim().replace(/^v/i, '');

  if (!/\d/.test(value)) return false;

  return !/(^|[._+-])(alpha|beta|rc|nightly|dev|development|preview|pre|canary|snapshot|unstable|testing)([._+-]|\d|$)/i.test(value)
    && !/(?:a|b|rc)\d+$/i.test(value);
}

function normalizeRelease({ version, date, url, notes = '' }) {
  if (!version || !isStableVersion(version)) return null;

  const parsedDate = date ? new Date(date) : null;
  const validDate = parsedDate && !Number.isNaN(parsedDate.valueOf());

  return {
    version: String(version).trim().replace(/^v/i, ''),
    date: validDate ? parsedDate.toISOString().slice(0, 10) : null,
    url: url || null,
    notes: typeof notes === 'string'
      ? notes.trim().slice(0, MAX_NOTES_LENGTH)
      : '',
  };
}

function compareVersions(a, b) {
  const first = String(a).match(/\d+/g)?.map(Number) || [];
  const second = String(b).match(/\d+/g)?.map(Number) || [];
  const length = Math.max(first.length, second.length);

  for (let i = 0; i < length; i++) {
    const difference = (first[i] || 0) - (second[i] || 0);
    if (difference !== 0) return difference;
  }

  return 0;
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
      if (a.date && b.date && a.date !== b.date) {
        return b.date.localeCompare(a.date);
      }

      if (a.date && !b.date) return -1;
      if (!a.date && b.date) return 1;

      return compareVersions(b.version, a.version);
    })
    .slice(0, HISTORY_LIMIT);
}

async function getGitHubReleases(source) {
  const headers = process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {};

  const releases = [];

  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const url = `https://api.github.com/repos/${source.owner}/${source.repository}/releases?per_page=100&page=${page}`;
    const data = await fetchJson(url, headers);

    if (!Array.isArray(data)) {
      throw new Error('Unexpected GitHub API response.');
    }

    releases.push(
      ...data
        .filter((release) => !release.draft && !release.prerelease)
        .map((release) =>
          normalizeRelease({
            version: release.tag_name,
            date: release.published_at,
            url: release.html_url,
            notes: release.body,
          }),
        )
        .filter(Boolean),
    );

    if (data.length < 100) break;
  }

  return releases;
}

async function getGitLabReleases(source) {
  const project = encodeURIComponent(source.project);
  const url = `${source.host}/api/v4/projects/${project}/releases?per_page=100&order_by=released_at&sort=desc`;
  const data = await fetchJson(url);

  if (!Array.isArray(data)) {
    throw new Error('Unexpected GitLab API response.');
  }

  return data
    .filter((release) => !release.upcoming_release)
    .map((release) =>
      normalizeRelease({
        version: release.tag_name,
        date: release.released_at,
        url: release._links?.self
          || `${source.host}/${source.project}/-/releases/${encodeURIComponent(release.tag_name)}`,
        notes: release.description,
      }),
    )
    .filter(Boolean);
}

async function getGiteaReleases(source) {
  const url = `${source.host}/api/v1/repos/${source.owner}/${source.repository}/releases?limit=100`;
  const data = await fetchJson(url);

  if (!Array.isArray(data)) {
    throw new Error('Unexpected Gitea API response.');
  }

  return data
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) =>
      normalizeRelease({
        version: release.tag_name,
        date: release.published_at || release.created_at,
        url: release.html_url,
        notes: release.body,
      }),
    )
    .filter(Boolean);
}

async function getMozillaReleases(source) {
  const baseUrl = new URL('.', source.url).href;

  const [versions, majorHistory, stabilityHistory] = await Promise.all([
    fetchJson(source.versionsUrl),
    fetchJson(new URL('firefox_history_major_releases.json', baseUrl)),
    fetchJson(new URL('firefox_history_stability_releases.json', baseUrl)),
  ]);

  const releases = new Map();

  for (const history of [majorHistory, stabilityHistory]) {
    for (const [version, date] of Object.entries(history)) {
      const release = normalizeRelease({
        version,
        date,
        url: `https://www.mozilla.org/firefox/${version}/releasenotes/`,
      });

      if (release) releases.set(release.version, release);
    }
  }

  const latestVersion = versions.LATEST_FIREFOX_VERSION;

  if (latestVersion && isStableVersion(latestVersion)) {
    const existing = releases.get(latestVersion);

    if (!existing) {
      const release = normalizeRelease({
        version: latestVersion,
        date: versions.LAST_RELEASE_DATE,
        url: `https://www.mozilla.org/firefox/${latestVersion}/releasenotes/`,
      });

      if (release) releases.set(release.version, release);
    }
  }

  return [...releases.values()];
}

async function getLibreOfficeReleases(source) {
  const html = await fetchText(source.url);
  const releases = [];
  const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    const link = row.match(/href=["']([^"']*?)(\d+\.\d+\.\d+)\/?["']/i);

    if (!link) continue;

    const version = link[2];
    const dateMatch = row.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    const releaseUrl = new URL(link[1], source.url).href;

    const release = normalizeRelease({
      version,
      date: dateMatch?.[1] || null,
      url: releaseUrl,
    });

    if (release) releases.push(release);
  }

  if (releases.length === 0) {
    throw new Error('Could not find stable versions in the LibreOffice directory.');
  }

  return releases;
}

async function getReleases(application) {
  const source = application.releaseSource;

  if (!source?.type) {
    throw new Error('Release source is not configured.');
  }

  switch (source.type) {
    case 'github':
      return getGitHubReleases(source);

    case 'gitlab':
      return getGitLabReleases(source);

    case 'gitea':
      return getGiteaReleases(source);

    case 'mozilla-product-details':
      return getMozillaReleases(source);

    case 'libreoffice-directory':
      return getLibreOfficeReleases(source);

    default:
      throw new Error(`Unsupported release source type: ${source.type}`);
  }
}

async function main() {
  const catalog = await readJson(CATALOG_PATH);
  const stored = await readJson(RELEASES_PATH);

  if (!Array.isArray(catalog.applications)) {
    throw new Error('The software catalog does not contain an applications array.');
  }

  stored.applications ||= {};

  let successful = 0;
  let failed = 0;

  for (const application of catalog.applications) {
    const previous = stored.applications[application.id];

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

      if (history.length === 0) {
        throw new Error('Could not determine stable release history.');
      }

      stored.applications[application.id] = {
        latestStable: history[0],
        history,
        lastChecked: new Date().toISOString(),
      };

      console.log(
        `[OK] ${application.name}: ${history[0].version} (${history.length} releases)`,
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

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Release update failed:', error);
  process.exitCode = 1;
});
