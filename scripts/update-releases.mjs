import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(ROOT, 'src/data/releases/software.json');
const RELEASES_PATH = path.join(ROOT, 'src/data/releases/releases.json');

const HISTORY_LIMIT = 20;
const REQUEST_DELAY_MS = 300;
const MAX_RELEASE_PAGES = 5;
const MAX_NOTES_LENGTH = 800;

const USER_AGENT = 'GetFOSS-Release-Tracker/1.0';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeHtml(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function cleanText(value = '') {
  return decodeHtml(
    String(value)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
  ).trim();
}

async function fetchResponse(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, application/xml, text/xml, text/html, text/plain, */*',
      ...options.headers,
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  return response;
}

async function fetchJson(url, options = {}) {
  const response = await fetchResponse(url, options);
  return response.json();
}

async function fetchText(url, options = {}) {
  const response = await fetchResponse(url, options);
  return response.text();
}

function isStableRelease(release) {
  const text = [
    release.tag_name,
    release.name,
    release.version,
    release.title,
  ].filter(Boolean).join(' ');

  if (release.draft === true || release.prerelease === true) {
    return false;
  }

  return !/(^|[\s._-])(alpha|beta|nightly|canary|dev|development|preview|pre-release|prerelease|rc\d*|release-candidate)([\s._-]|$)/i.test(text);
}

function parseDate(value) {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function normalizeRelease(release) {
  const version = String(
    release.version ??
    release.tag_name ??
    release.tag ??
    release.name ??
    ''
  ).trim();

  if (!version) return null;

  const date = parseDate(
    release.published_at ??
    release.released_at ??
    release.created_at ??
    release.date ??
    release.timestamp
  );

  const url =
    release.html_url ??
    release.url ??
    release.release_notes_url ??
    release.download_url ??
    null;

  const notes = cleanText(
    release.body ??
    release.description ??
    release.notes ??
    ''
  ).slice(0, MAX_NOTES_LENGTH);

  return {
    version,
    date,
    url,
    notes,
  };
}

function compareVersions(a, b) {
  const parse = (value) => {
    const numbers = String(value).match(/\d+/g);
    return numbers ? numbers.map(Number) : [0];
  };

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i += 1) {
    const difference = (right[i] ?? 0) - (left[i] ?? 0);
    if (difference !== 0) return difference;
  }

  return String(b).localeCompare(String(a));
}

function sortAndLimit(releases) {
  const unique = new Map();

  for (const release of releases) {
    if (!release?.version) continue;

    const key = release.version.toLowerCase();

    if (!unique.has(key)) {
      unique.set(key, release);
    }
  }

  return [...unique.values()]
    .sort((a, b) => {
      if (a.date && b.date && a.date !== b.date) {
        return b.date.localeCompare(a.date);
      }

      return compareVersions(a.version, b.version);
    })
    .slice(0, HISTORY_LIMIT);
}

function parseAutoIndex(html) {
  const entries = [];
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorRegex)) {
    const href = decodeHtml(match[1]).trim();
    const label = cleanText(match[2]);

    if (!href || href === '../' || href.startsWith('?')) continue;

    const start = match.index + match[0].length;
    const followingText = cleanText(html.slice(start, start + 180));

    entries.push({
      href,
      label,
      followingText,
    });
  }

  return entries;
}

function parseArchiveDate(value) {
  const match = String(value).match(
    /\b(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2})\b/
  );

  if (!match) return null;

  const months = {
    jan: '01', feb: '02', mar: '03', apr: '04',
    may: '05', jun: '06', jul: '07', aug: '08',
    sep: '09', oct: '10', nov: '11', dec: '12',
  };

  const month = months[match[2].toLowerCase()];
  if (!month) return null;

  return `${match[3]}-${month}-${match[1].padStart(2, '0')}T${match[4]}:${match[5]}:00.000Z`;
}

function isPreReleaseVersion(version) {
  return /(alpha|beta|nightly|canary|dev|preview|pre|rc)/i.test(version);
}

async function getGitHubReleases(application) {
  const { owner, repository } = application.releaseSource;

  const releases = [];

  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const url = `https://api.github.com/repos/${owner}/${repository}/releases?per_page=100&page=${page}`;

    const data = await fetchJson(url, {
      headers: {
        Accept: 'application/vnd.github+json',
      },
    });

    if (!Array.isArray(data) || data.length === 0) break;

    for (const item of data) {
      if (!isStableRelease(item)) continue;

      const release = normalizeRelease(item);
      if (release) releases.push(release);
    }

    if (data.length < 100) break;
    await sleep(REQUEST_DELAY_MS);
  }

  return sortAndLimit(releases);
}

async function getGitLabReleases(application) {
  const { host, project } = application.releaseSource;
  const encodedProject = encodeURIComponent(project);
  const baseUrl = `${host.replace(/\/$/, '')}/api/v4/projects/${encodedProject}/releases`;

  const releases = [];

  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const url = `${baseUrl}?per_page=100&page=${page}`;

    const data = await fetchJson(url);

    if (!Array.isArray(data) || data.length === 0) break;

    for (const item of data) {
      if (!isStableRelease(item)) continue;

      const release = normalizeRelease({
        version: item.tag_name,
        name: item.name,
        description: item.description,
        released_at: item.released_at,
        created_at: item.created_at,
        url: item._links?.self,
      });

      if (release) {
        release.url = `${host.replace(/\/$/, '')}/${project}/-/releases/${encodeURIComponent(item.tag_name)}`;
        releases.push(release);
      }
    }

    if (data.length < 100) break;
    await sleep(REQUEST_DELAY_MS);
  }

  return sortAndLimit(releases);
}

async function getGiteaReleases(application) {
  const { host, owner, repository } = application.releaseSource;
  const baseUrl = `${host.replace(/\/$/, '')}/api/v1/repos/${owner}/${repository}/releases`;

  const releases = [];

  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const url = `${baseUrl}?limit=50&page=${page}`;
    const data = await fetchJson(url);

    if (!Array.isArray(data) || data.length === 0) break;

    for (const item of data) {
      if (!isStableRelease(item)) continue;

      const release = normalizeRelease({
        tag_name: item.tag_name,
        name: item.name,
        body: item.body,
        published_at: item.published_at,
        created_at: item.created_at,
        html_url: item.html_url,
      });

      if (release) releases.push(release);
    }

    if (data.length < 50) break;
    await sleep(REQUEST_DELAY_MS);
  }

  return sortAndLimit(releases);
}

/*
 * Blender:
 * The releases API currently returns 404, so use Blender's official
 * download archive instead of the unavailable API.
 */
async function getBlenderReleases() {
  const archiveRoot = 'https://download.blender.org/release/';
  const rootHtml = await fetchText(archiveRoot);
  const directories = parseAutoIndex(rootHtml);

  const blenderDirectories = directories
    .filter((entry) => /^Blender\d+\.\d+\/$/i.test(entry.href))
    .map((entry) => entry.href);

  const releases = [];

  for (const directory of blenderDirectories) {
    const series = directory.match(/Blender(\d+\.\d+)/i)?.[1];
    if (!series) continue;

    try {
      const html = await fetchText(`${archiveRoot}${directory}`);
      const entries = parseAutoIndex(html);

      for (const entry of entries) {
        const filename = entry.href.split('/').pop();

        if (!/^blender-/i.test(filename)) continue;
        if (!/\.(tar\.xz|tar\.bz2|zip|dmg|msi|exe)$/i.test(filename)) continue;
        if (isPreReleaseVersion(filename)) continue;

        const versionMatch = filename.match(
          /blender-(\d+\.\d+(?:\.\d+)?)(?:[-_])/i
        );

        if (!versionMatch) continue;

        const version = versionMatch[1];
        const date = parseArchiveDate(entry.followingText);

        releases.push({
          version,
          date,
          url: `${archiveRoot}${directory}`,
          notes: `Blender ${version} stable release.`,
        });
      }
    } catch (error) {
      console.log(`[INFO] Blender ${series}: ${error.message}`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  const result = sortAndLimit(releases);

  if (result.length === 0) {
    throw new Error('No stable Blender versions found in the official archive.');
  }

  return result;
}

/*
 * Krita and Kdenlive:
 * Their official KDE application RSS feeds provide stable release history.
 */
async function getKdeReleases(application) {
  const feedUrl = `https://apps.kde.org/${application.id}/index.xml`;
  const xml = await fetchText(feedUrl);

  const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
  const releases = [];

  for (const match of items) {
    const item = match[1];

    const getTag = (tag) => {
      const result = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return result ? cleanText(result[1]) : '';
    };

    const title = getTag('title');
    const link = getTag('link');
    const pubDate = getTag('pubDate');
    const description = getTag('description');

    const versionMatch = title.match(/\d+\.\d+(?:\.\d+){0,2}/);
    if (!versionMatch || isPreReleaseVersion(title)) continue;

    const release = normalizeRelease({
      version: versionMatch[0],
      date: pubDate,
      url: link,
      notes: description,
    });

    if (release) releases.push(release);
  }

  const result = sortAndLimit(releases);

  if (result.length === 0) {
    throw new Error('No stable releases found in the official KDE RSS feed.');
  }

  return result;
}

/*
 * VLC:
 * Parse the official VideoLAN archive's Apache-style directory listing.
 * The archive is under /pub/videolan/vlc/, not /vlc/ alone.
 */
async function getVlcReleases() {
  const archiveUrl = 'https://download.videolan.org/pub/videolan/vlc/';
  const html = await fetchText(archiveUrl);
  const entries = parseAutoIndex(html);
  const releases = [];

  for (const entry of entries) {
    const match = entry.href.match(/^(\d+\.\d+(?:\.\d+){0,2})\/$/);

    if (!match) continue;

    const version = match[1];
    if (isPreReleaseVersion(version)) continue;

    releases.push({
      version,
      date: parseArchiveDate(entry.followingText),
      url: `${archiveUrl}${entry.href}`,
      notes: `VLC ${version} stable release.`,
    });
  }

  const result = sortAndLimit(releases);

  if (result.length === 0) {
    throw new Error('Could not read stable versions from the official VideoLAN archive.');
  }

  return result;
}

async function getLibreOfficeReleases() {
  const archiveUrl = 'https://download.documentfoundation.org/libreoffice/stable/';
  const html = await fetchText(archiveUrl);
  const entries = parseAutoIndex(html);
  const releases = [];

  for (const entry of entries) {
    const match = entry.href.match(/^(\d+\.\d+(?:\.\d+)?)\/$/);
    if (!match) continue;

    const version = match[1];

    releases.push({
      version,
      date: parseArchiveDate(entry.followingText),
      url: `${archiveUrl}${entry.href}`,
      notes: `LibreOffice ${version} stable release.`,
    });
  }

  const result = sortAndLimit(releases);

  if (result.length === 0) {
    throw new Error('No stable LibreOffice versions found in the official archive.');
  }

  return result;
}

async function getFirefoxReleases() {
  const versionsUrl = 'https://product-details.mozilla.org/1.0/firefox_versions.json';
  const data = await fetchJson(versionsUrl);

  const version = data.LATEST_FIREFOX_VERSION;
  if (!version) {
    throw new Error('Mozilla did not provide the latest Firefox version.');
  }

  const releases = [{
    version,
    date: null,
    url: 'https://www.mozilla.org/firefox/releases/',
    notes: `Firefox ${version} stable release.`,
  }];

  return releases;
}

async function getReleases(application) {
  switch (application.id) {
    case 'blender':
      return getBlenderReleases();

    case 'krita':
    case 'kdenlive':
      return getKdeReleases(application);

    case 'vlc':
      return getVlcReleases();

    default:
      break;
  }

  const source = application.releaseSource;

  if (!source) {
    throw new Error('Release source is not configured.');
  }

  switch (source.type) {
    case 'github':
      return getGitHubReleases(application);

    case 'gitlab':
      return getGitLabReleases(application);

    case 'gitea':
      return getGiteaReleases(application);

    case 'libreoffice-directory':
      return getLibreOfficeReleases();

    case 'mozilla-product-details':
      return getFirefoxReleases();

    default:
      throw new Error(`Unsupported release source: ${source.type}`);
  }
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function main() {
  const catalog = await readJson(CATALOG_PATH);

  let releaseData;

  try {
    releaseData = await readJson(RELEASES_PATH);
  } catch {
    releaseData = {
      schemaVersion: 1,
      lastUpdated: null,
      applications: {},
    };
  }

  if (!releaseData.applications || typeof releaseData.applications !== 'object') {
    releaseData.applications = {};
  }

  let successful = 0;
  let failed = 0;

  for (const application of catalog) {
    try {
      const releases = await getReleases(application);

      if (!Array.isArray(releases) || releases.length === 0) {
        throw new Error('No stable releases returned.');
      }

      const latest = releases[0];

      releaseData.applications[application.id] = {
        latestVersion: latest.version,
        latestDate: latest.date,
        releases,
        updatedAt: new Date().toISOString(),
      };

      console.log(
        `[OK] ${application.name}: ${latest.version} (${releases.length} releases)`
      );

      successful += 1;
    } catch (error) {
      console.error(`[ERROR] ${application.name}: ${error.message}`);
      console.log(`[INFO] ${application.name}: keeping previously saved release data.`);

      failed += 1;
    }

    await sleep(REQUEST_DELAY_MS);
  }

  if (successful > 0) {
    releaseData.lastUpdated = new Date().toISOString();
    await writeJson(RELEASES_PATH, releaseData);
  }

  console.log('\nRelease update summary:');
  console.log(`Successful: ${successful}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[FATAL] ${error.message}`);
  process.exitCode = 1;
});
