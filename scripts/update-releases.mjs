#!/usr/bin/env node
/**
 * GetFOSS Stable Release Tracker — Updater
 * ===========================================
 *
 * Fetches stable release data for every application listed in the catalog
 * (src/data/releases/software.json) and writes the consolidated result to
 * src/data/releases/releases.json.
 *
 * Supported release source types:
 *   - github                 → GitHub Releases API
 *   - gitlab                 → GitLab Releases API (gitlab.com and self-hosted instances)
 *   - gitea                  → Gitea Releases API
 *   - forgejo                → Forgejo Releases API (same shape as Gitea)
 *   - libreoffice-directory  → LibreOffice download directory listing (Apache autoindex)
 *   - mozilla-product-details → Mozilla product-details JSON API (Firefox)
 *   - ubuntu-cloud-images    → Ubuntu SimpleStreams JSON
 *   - blender-releases-page  → Blender.org RSS feed (release announcements)
 *
 * Behavior:
 *   - Filters out drafts and prereleases (stable releases only).
 *   - Limits history to 20 entries per application.
 *   - On per-application failure, preserves existing release history if present.
 *   - Never replaces valid historical data with an empty result.
 *   - Records the fetch timestamp and source URL for each application.
 *   - Reports per-application failures without stopping the whole run.
 *
 * Environment variables:
 *   - GITHUB_TOKEN (optional but strongly recommended for the GitHub API;
 *     the unauthenticated rate limit is 60 requests/hour, which is far below
 *     what this script needs).
 *
 * Exit codes:
 *   - 0  successful run (at least one application fetched successfully
 *        OR all failures preserved existing data)
 *   - 1  fatal error (catalog missing, JSON invalid, or every application
 *        failed with no existing data to preserve)
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const CATALOG_PATH = path.join(
  ROOT,
  process.env.GETFOSS_CATALOG_PATH || 'src/data/releases/software.json'
);
const RELEASES_PATH = path.join(
  ROOT,
  process.env.GETFOSS_RELEASES_PATH || 'src/data/releases/releases.json'
);

const MAX_HISTORY = 20;
const FETCH_TIMEOUT_MS = 30_000;
const HTTP_USER_AGENT = 'GetFOSS-Release-Tracker/1.0 (+https://www.getfoss.org/)';

// ---------------------------------------------------------------------------
// Catalog / releases I/O
// ---------------------------------------------------------------------------

async function loadCatalog() {
  let text;
  try {
    text = await fs.readFile(CATALOG_PATH, 'utf8');
  } catch (e) {
    throw new Error(`cannot read catalog at ${CATALOG_PATH}: ${e.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`catalog is not valid JSON: ${e.message}`);
  }
  if (!data || !Array.isArray(data.applications)) {
    throw new Error(
      'catalog is not iterable: expected shape { "schemaVersion": 1, "applications": [...] }'
    );
  }
  return data.applications;
}

async function loadExistingReleases() {
  try {
    const text = await fs.readFile(RELEASES_PATH, 'utf8');
    const data = JSON.parse(text);
    if (data && typeof data === 'object' && data.applications) {
      return data;
    }
  } catch {
    // File missing or invalid — return empty structure
  }
  return { schemaVersion: 1, lastUpdated: null, applications: {} };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // NOTE: we deliberately do NOT set a default User-Agent here.
    // Some servers (notably download.documentfoundation.org / LibreOffice)
    // reject requests that carry a non-browser User-Agent. Node's built-in
    // fetch sends a default UA that those servers accept. Callers that need
    // a specific UA (GitHub requires one) must set it in options.headers.
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetchWithTimeout(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  }
  return res.json();
}

async function fetchText(url, options = {}) {
  // Don't set Accept or User-Agent by default — let Node use its defaults,
  // which are accepted by strict servers like download.documentfoundation.org.
  const res = await fetchWithTimeout(url, options);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  }
  return res.text();
}

// ---------------------------------------------------------------------------
// GitHub Releases
// ---------------------------------------------------------------------------

function githubHeaders() {
  // GitHub API requires a User-Agent header — set it explicitly here.
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': HTTP_USER_AGENT,
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function fetchGitHubReleases(rs) {
  // GitHub returns up to 100 per page; we need 20 stable, so 1 page of 100 is plenty.
  const url = `https://api.github.com/repos/${rs.owner}/${rs.repository}/releases?per_page=100`;
  const data = await fetchJson(url, { headers: githubHeaders() });
  if (!Array.isArray(data)) {
    throw new Error('GitHub response is not an array');
  }
  return data
    .filter((r) => r && !r.draft && !r.prerelease)
    .map((r) => ({
      version: r.tag_name,
      name: r.name || r.tag_name,
      releaseDate: r.published_at || r.created_at || null,
      releaseUrl: r.html_url || `https://github.com/${rs.owner}/${rs.repository}/releases/tag/${r.tag_name}`,
      releaseNotes: typeof r.body === 'string' ? r.body : '',
    }))
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''))
    .slice(0, MAX_HISTORY);
}

// ---------------------------------------------------------------------------
// GitLab Releases
// ---------------------------------------------------------------------------

async function fetchGitLabReleases(rs) {
  // URL-encode the project path (e.g. "inkscape/inkscape" → "inkscape%2Finkscape")
  const encodedProject = encodeURIComponent(rs.project);
  const url = `${rs.host}/api/v4/projects/${encodedProject}/releases?per_page=100`;
  const data = await fetchJson(url);
  if (!Array.isArray(data)) {
    throw new Error('GitLab response is not an array');
  }
  return data
    .filter((r) => r && !r.upcoming_release)
    .map((r) => ({
      version: r.tag_name,
      name: r.name || r.tag_name,
      releaseDate: r.released_at || r.created_at || null,
      releaseUrl:
        (r._links && r._links.self) ||
        `${rs.host}/${rs.project}/-/releases/${r.tag_name}`,
      releaseNotes: typeof r.description === 'string' ? r.description : '',
    }))
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''))
    .slice(0, MAX_HISTORY);
}

// ---------------------------------------------------------------------------
// Gitea Releases
// ---------------------------------------------------------------------------

async function fetchGiteaReleases(rs) {
  // Gitea API supports `draft` and `pre-release` filters, but not every fork does.
  // We fetch with a high limit and filter in JS.
  const url = `${rs.host}/api/v1/repos/${rs.owner}/${rs.repository}/releases?limit=50&page=1&draft=false&pre-release=false`;
  const data = await fetchJson(url);
  if (!Array.isArray(data)) {
    throw new Error('Gitea response is not an array');
  }
  return data
    .filter((r) => r && !r.draft && !r.prerelease)
    .map((r) => ({
      version: r.tag_name,
      name: r.name || r.tag_name,
      releaseDate: r.created_at || r.published_at || null,
      releaseUrl:
        r.html_url ||
        `${rs.host}/${rs.owner}/${rs.repository}/releases/tag/${r.tag_name}`,
      releaseNotes: typeof r.body === 'string' ? r.body : '',
    }))
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''))
    .slice(0, MAX_HISTORY);
}

// ---------------------------------------------------------------------------
// Forgejo Releases (same API shape as Gitea)
// ---------------------------------------------------------------------------

async function fetchForgejoReleases(rs) {
  return fetchGiteaReleases(rs);
}

// ---------------------------------------------------------------------------
// LibreOffice download directory (Apache autoindex HTML)
// ---------------------------------------------------------------------------

async function fetchLibreOfficeReleases(rs) {
  // The LibreOffice stable releases are published as folders under
  // https://download.documentfoundation.org/libreoffice/stable/
  // Apache autoindex returns HTML table rows like:
  //   <tr><td>&nbsp;</td><td><a href="26.8.3/">26.8.3/</a></td>
  //       <td align="right">11-Nov-2026 18:34  </td><td align="right">  - </td></tr>
  // We parse this stable, predictable format. This is the official LibreOffice
  // release source — there is no JSON API. Not random website scraping.
  const html = await fetchText(rs.url);
  // Match: href="VERSION/" ... </a></td>...<td...>DD-Mon-YYYY HH:MM
  const versionRegex =
    /href="(\d+\.\d+\.\d+)\/"[^<]*<\/a>[^<]*?<td[^>]*>\s*(\d{2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2})/g;
  const releases = [];
  let match;
  while ((match = versionRegex.exec(html)) !== null) {
    const version = match[1];
    const dateStr = match[2];
    // Parse "11-Nov-2026 18:34" as UTC
    const parsed = new Date(dateStr + ' UTC');
    const isoDate = isNaN(parsed.getTime()) ? null : parsed.toISOString();
    releases.push({
      version,
      name: `LibreOffice ${version}`,
      releaseDate: isoDate,
      releaseUrl: `${rs.url}${version}/`,
      releaseNotes: '',
    });
  }
  // Fallback: if the date-aware regex didn't catch anything, try version-only
  if (releases.length === 0) {
    const simpleRegex = /href="(\d+\.\d+\.\d+)\/"/g;
    let m;
    while ((m = simpleRegex.exec(html)) !== null) {
      releases.push({
        version: m[1],
        name: `LibreOffice ${m[1]}`,
        releaseDate: null,
        releaseUrl: `${rs.url}${m[1]}/`,
        releaseNotes: '',
      });
    }
  }
  // Sort versions in descending order (semver-like string sort works for x.y.z)
  releases.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return releases.slice(0, MAX_HISTORY);
}

// ---------------------------------------------------------------------------
// Mozilla product-details (Firefox)
// ---------------------------------------------------------------------------

async function fetchMozillaReleases(rs) {
  // product-details.mozilla.org/1.0/firefox.json returns:
  //   { "releases": { "<key>": { "category": "...", "date": "...", "version": "...", ... } } }
  // Categories:
  //   major     → major version bumps (e.g. 161.0) — KEEP
  //   stability → minor stability updates (e.g. 160.0.1) — KEEP
  //   dev       → beta releases (e.g. 162.0b2) — SKIP (prerelease)
  //   esr       → Extended Support Release train (separate product variant) — SKIP
  // Additionally, "stability" entries whose KEY contains "esr" (e.g.
  // "firefox-115.46.0esr") are ESR point releases of an older major train — SKIP.
  const data = await fetchJson(rs.url);
  const releasesObj = data && data.releases ? data.releases : {};
  const releases = [];
  for (const [key, info] of Object.entries(releasesObj)) {
    if (!info || typeof info !== 'object') continue;
    const category = info.category || '';
    if (category !== 'major' && category !== 'stability') continue;
    // Exclude ESR train and ESR point releases (key contains "esr")
    if (key.toLowerCase().includes('esr')) continue;
    const version = info.version || key;
    // Skip beta/dev versions that slipped into stability (defensive)
    if (/[ab]\d$/.test(version) || version.toLowerCase().includes('beta')) continue;
    releases.push({
      version,
      name: `Firefox ${version}`,
      releaseDate: info.date || null,
      releaseUrl: `https://www.mozilla.org/firefox/${version}/releasenotes/`,
      releaseNotes: '',
    });
  }
  return releases
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''))
    .slice(0, MAX_HISTORY);
}

// ---------------------------------------------------------------------------
// Ubuntu cloud images SimpleStreams
// ---------------------------------------------------------------------------

async function fetchUbuntuReleases(rs) {
  // SimpleStreams JSON shape:
  //   {
  //     "products": {
  //       "com.ubuntu.cloud:server:22.04:amd64": {
  //         "release": "jammy", "release_codename": "Jammy Jellyfish",
  //         "release_title": "22.04 LTS",
  //         "versions": {
  //           "20240110": { "pubname": "ubuntu-jammy-...", "label": "release", ... },
  //           ...
  //         }
  //       }, ...
  //     }
  //   }
  // We extract one release entry per Ubuntu version (amd64 server only, to
  // avoid duplicates for i386/arm64/etc.). Sort by version number descending
  // (so 24.04 comes before 22.04, not by pubname which would put 17.04 first).
  const data = await fetchJson(rs.url);
  const products = data && data.products ? data.products : {};
  const releases = [];

  for (const [pid, product] of Object.entries(products)) {
    if (!product || !product.versions) continue;
    // Only amd64 server releases (one entry per Ubuntu version)
    if (!pid.includes(':server:') || !pid.endsWith(':amd64')) continue;

    // Extract version number from product id (e.g., "22.04" from "...:server:22.04:amd64")
    const m = pid.match(/server:(\d+\.\d+):amd64$/);
    if (!m) continue;
    const versionNumber = m[1];

    // Find the newest build for this version — vkey is YYYYMMDD, so lexical sort works.
    const versionEntries = Object.entries(product.versions);
    if (versionEntries.length === 0) continue;

    let newestKey = '';
    for (const [vkey] of versionEntries) {
      if (vkey > newestKey) newestKey = vkey;
    }
    const newest = product.versions[newestKey];

    // Convert vkey (YYYYMMDD) to ISO date
    let isoDate = null;
    if (/^\d{8}$/.test(newestKey)) {
      isoDate = `${newestKey.slice(0, 4)}-${newestKey.slice(4, 6)}-${newestKey.slice(6, 8)}T00:00:00Z`;
    }

    const releaseTitle = product.release_title || `Ubuntu ${versionNumber}`;
    releases.push({
      version: `Ubuntu ${versionNumber}`,
      name: releaseTitle,
      releaseDate: isoDate,
      releaseUrl: `https://cloud-images.ubuntu.com/releases/${versionNumber}/`,
      releaseNotes: '',
      _sortKey: parseFloat(versionNumber), // internal — stripped before output
    });
  }

  // Sort by version number descending (24.04 > 22.04 > 20.04 > ...)
  releases.sort((a, b) => b._sortKey - a._sortKey);

  // Strip internal sort key from output
  return releases.slice(0, MAX_HISTORY).map(({ _sortKey, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// Blender releases page (Blender.org RSS feed)
// ---------------------------------------------------------------------------

async function fetchBlenderReleasesPage(rs) {
  // The Blender.org /download/releases/ HTML page is protected by Cloudflare's
  // JavaScript challenge and cannot be fetched by a plain HTTP client.
  // However, the WordPress RSS feed at /feed/ is accessible and contains
  // release announcements tagged with category "release". We paginate through
  // the feed to collect up to 20 historical releases.
  //
  // Each RSS <item> for a release looks like:
  //   <item>
  //     <title>Blender 5.3 Release</title>
  //     <link>https://www.blender.org/press/blender-5-3-release/</link>
  //     <pubDate>Tue, 10 Nov 2026 17:58:03 +0000</pubDate>
  //     <category><![CDATA[release]]></category>
  //     ...
  //   </item>
  const releases = [];
  const MAX_PAGES = 20; // Safety limit — feed yields ~19 releases across ~14 pages
  let consecutiveEmpty = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? rs.url : `${rs.url}?paged=${page}`;
    let xml;
    try {
      xml = await fetchText(url);
    } catch (e) {
      // Fetch error on this page — stop paginating, use what we have.
      break;
    }
    if (!xml || !xml.includes('<item>')) {
      // No items at all on this page — end of feed.
      break;
    }

    // Extract all <item> blocks
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    let releasesThisPage = 0;
    while ((match = itemRegex.exec(xml)) !== null) {
      const item = match[1];

      // Extract categories
      const catMatches = [...item.matchAll(/<category><!\[CDATA\[(.*?)\]\]><\/category>/g)];
      const cats = catMatches.map((m) => m[1].toLowerCase());

      // Filter: only items tagged with "release" category
      if (!cats.includes('release')) continue;

      // Extract title, date, link
      const titleM = item.match(/<title>(.*?)<\/title>/);
      const dateM = item.match(/<pubDate>(.*?)<\/pubDate>/);
      const linkM = item.match(/<link>(.*?)<\/link>/);

      const title = titleM ? titleM[1].trim() : '';
      const dateStr = dateM ? dateM[1].trim() : '';
      const link = linkM ? linkM[1].trim() : '';

      // Extract version from title:
      //   "Blender 5.3 Release"       → "5.3"
      //   "Blender 5.2 LTS Release"   → "5.2 LTS"
      //   "Blender 2.83.1 LTS"        → "2.83.1 LTS"
      const versionMatch = title.match(/Blender\s+(\d+\.\d+(?:\.\d+)?)(?:\s+(LTS))?/i);
      let version;
      if (versionMatch) {
        version = versionMatch[1];
        if (versionMatch[2]) version += ` ${versionMatch[2]}`;
      } else {
        version = title; // Fallback: use full title
      }

      // Parse RSS date (e.g., "Tue, 10 Nov 2026 17:58:03 +0000")
      const parsed = new Date(dateStr);
      const isoDate = isNaN(parsed.getTime()) ? null : parsed.toISOString();

      releases.push({
        version,
        name: title,
        releaseDate: isoDate,
        releaseUrl: link,
        releaseNotes: '',
      });
      releasesThisPage++;
    }

    // Stop if we have enough releases
    if (releases.length >= MAX_HISTORY) break;

    // Track consecutive empty pages — if 3 in a row have no release items,
    // assume we've passed the last release in the archive and stop.
    if (releasesThisPage === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) break;
    } else {
      consecutiveEmpty = 0;
    }
  }

  return releases
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''))
    .slice(0, MAX_HISTORY);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function sourceApiUrl(rs) {
  switch (rs.type) {
    case 'github':
      return `https://api.github.com/repos/${rs.owner}/${rs.repository}/releases`;
    case 'gitlab':
      return `${rs.host}/api/v4/projects/${encodeURIComponent(rs.project)}/releases`;
    case 'gitea':
    case 'forgejo':
      return `${rs.host}/api/v1/repos/${rs.owner}/${rs.repository}/releases`;
    default:
      return rs.url || '';
  }
}

async function fetchReleasesFor(app) {
  const rs = app.releaseSource;
  if (!rs || !rs.type) {
    throw new Error('releaseSource is missing or has no type');
  }
  switch (rs.type) {
    case 'github':
      return fetchGitHubReleases(rs);
    case 'gitlab':
      return fetchGitLabReleases(rs);
    case 'gitea':
      return fetchGiteaReleases(rs);
    case 'forgejo':
      return fetchForgejoReleases(rs);
    case 'libreoffice-directory':
      return fetchLibreOfficeReleases(rs);
    case 'mozilla-product-details':
      return fetchMozillaReleases(rs);
    case 'ubuntu-cloud-images':
      return fetchUbuntuReleases(rs);
    case 'blender-releases-page':
      return fetchBlenderReleasesPage(rs);
    default:
      throw new Error(`unsupported releaseSource.type: "${rs.type}"`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('GetFOSS Stable Release Tracker — Updater');
  console.log('==========================================');

  if (!process.env.GITHUB_TOKEN) {
    console.log(
      '⚠ GITHUB_TOKEN is not set. Unauthenticated GitHub API requests are limited to 60/hour,'
    );
    console.log('  which will cause most GitHub-hosted apps to fail. Existing data will be preserved.');
    console.log('  Set GITHUB_TOKEN (e.g. via GitHub Actions secrets) for production use.');
    console.log();
  }

  const catalog = await loadCatalog();
  console.log(`Loaded catalog: ${catalog.length} applications from ${CATALOG_PATH}`);

  const existing = await loadExistingReleases();
  const existingCount = Object.keys(existing.applications || {}).length;
  console.log(`Loaded existing releases: ${existingCount} applications from ${RELEASES_PATH}`);
  console.log();

  const result = {
    schemaVersion: 1,
    lastUpdated: new Date().toISOString(),
    applications: {},
  };

  let successCount = 0;
  let preservedCount = 0;
  let emptyCount = 0;
  let failureCount = 0;
  const failures = [];

  for (let i = 0; i < catalog.length; i++) {
    const app = catalog[i];
    const appId = app.id;
    const pad = String(i + 1).padStart(String(catalog.length).length, ' ');
    process.stdout.write(`  [${pad}/${catalog.length}] ${appId.padEnd(28)} `);

    const existingApp = existing.applications && existing.applications[appId];
    const existingReleases = existingApp && Array.isArray(existingApp.releases) ? existingApp.releases : [];

    try {
      const releases = await fetchReleasesFor(app);

      if (Array.isArray(releases) && releases.length > 0) {
        // Successful fetch with data
        result.applications[appId] = {
          name: app.name,
          lastFetch: new Date().toISOString(),
          sourceUrl: sourceApiUrl(app.releaseSource),
          releases,
        };
        successCount++;
        console.log(`✓ ${releases.length} releases (latest: ${releases[0].version})`);
      } else {
        // Source returned no data — preserve existing if we have it, else mark empty
        if (existingReleases.length > 0) {
          result.applications[appId] = {
            ...existingApp,
            lastFetch: existingApp.lastFetch || null,
            sourceUrl: sourceApiUrl(app.releaseSource),
            releases: existingReleases,
          };
          preservedCount++;
          console.log(`⊘ empty result — preserved ${existingReleases.length} existing ${existingReleases.length === 1 ? 'entry' : 'entries'}`);
        } else {
          result.applications[appId] = {
            name: app.name,
            lastFetch: null,
            sourceUrl: sourceApiUrl(app.releaseSource),
            releases: [],
          };
          emptyCount++;
          console.log('⊘ empty result — no existing data to preserve');
        }
      }
    } catch (e) {
      // Per-app failure — preserve existing data if available
      const msg = e && e.message ? e.message : String(e);
      if (existingReleases.length > 0) {
        result.applications[appId] = {
          ...existingApp,
          lastFetch: existingApp.lastFetch || null,
          sourceUrl: sourceApiUrl(app.releaseSource),
          releases: existingReleases,
        };
        preservedCount++;
        console.log(`✗ FAILED — preserved ${existingReleases.length} existing ${existingReleases.length === 1 ? 'entry' : 'entries'} (${msg})`);
      } else {
        result.applications[appId] = {
          name: app.name,
          lastFetch: null,
          sourceUrl: sourceApiUrl(app.releaseSource),
          releases: [],
        };
        failureCount++;
        failures.push({ id: appId, error: msg });
        console.log(`✗ FAILED — no existing data (${msg})`);
      }
    }
  }

  // ---- Write releases.json ----
  const output = JSON.stringify(result, null, 2) + '\n';
  await fs.mkdir(path.dirname(RELEASES_PATH), { recursive: true });
  await fs.writeFile(RELEASES_PATH, output, 'utf8');
  const sizeKb = (Buffer.byteLength(output, 'utf8') / 1024).toFixed(1);

  console.log();
  console.log('==========================================');
  console.log('Summary:');
  console.log(`  ✓ Fetched fresh data:        ${successCount}`);
  console.log(`  ↻ Preserved existing data:    ${preservedCount} (on failure or empty result)`);
  console.log(`  ⊘ Empty result, no existing:  ${emptyCount}`);
  console.log(`  ✗ Failed, no existing data:   ${failureCount}`);
  console.log(`  Total applications:           ${catalog.length}`);
  console.log();
  console.log(`✓ Wrote ${RELEASES_PATH} (${sizeKb} KB)`);

  // ---- Exit code policy ----
  // Exit 0 if at least one app fetched fresh data, OR all failures had data to preserve.
  // Exit 1 only if the catalog itself was unreadable (handled by throw above)
  // or every single app failed with no data to preserve.
  if (failureCount === catalog.length) {
    console.error(`\n[FATAL] All ${catalog.length} applications failed with no existing data to preserve.`);
    if (failures.length > 0) {
      console.error('First 10 failures:');
      failures.slice(0, 10).forEach((f) => console.error(`  - ${f.id}: ${f.error}`));
    }
    process.exit(1);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(`\n[FATAL] ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
