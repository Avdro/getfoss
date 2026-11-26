#!/usr/bin/env node

/**
 * GetFOSS — Pre-release Builds updater
 *
 * Reads:
 *   src/data/prereleases/software.json
 *
 * Writes:
 *   src/data/prereleases/releases.json
 *
 * Separate updater for pre-release builds.
 * Does not modify the Stable Releases catalogue.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

const SOFTWARE_FILE = path.join(
  ROOT,
  'src/data/prereleases/software.json'
);

const RELEASES_FILE = path.join(
  ROOT,
  'src/data/prereleases/releases.json'
);

const HISTORY_LIMIT = 30;
const REQUEST_TIMEOUT_MS = 25000;

const USER_AGENT =
  'GetFOSS-PreRelease-Updater/1.0 (+https://www.getfoss.org)';

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));


async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  return response.json();
}


async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': USER_AGENT,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }

  return response.text();
}


function parseGitHubRepo(sourceUrl) {
  const match = sourceUrl.match(
    /^https?:\/\/github\.com\/([^/]+\/[^/]+)/i
  );

  return match
    ? match[1].replace(/\.git$/i, '')
    : null;
}


function parseGitLabProject(sourceUrl) {
  const match = sourceUrl.match(
    /^https?:\/\/([^/]+)\/(.+)$/i
  );

  if (!match) return null;

  const host = match[1];

  const projectPath = match[2]
    .replace(/\/-\/.*$/, '')
    .replace(/\.git$/i, '');

  return {
    host,
    projectPath,
    encodedPath: encodeURIComponent(projectPath),
  };
}


function classifyPreRelease(release) {
  const text = [
    release.name,
    release.tag_name,
    release.tag,
    release.description,
    release.body,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (
    /\b(nightly|nightlies|daily|snapshot|master|main|trunk)\b/.test(text)
  ) {
    return 'Nightly';
  }

  if (/\b(alpha|alpha[-._ ]?\d*|a\d+)\b/.test(text)) {
    return 'Alpha';
  }

  if (/\b(beta|beta[-._ ]?\d*|b\d+)\b/.test(text)) {
    return 'Beta';
  }

  if (
    /\b(rc|release[-._ ]?candidate|candidate)\b/.test(text)
  ) {
    return 'Release Candidate';
  }

  if (
    /\b(dev|development|preview|pre[-._ ]?release|unstable|testing|canary|edge)\b/.test(text)
  ) {
    return 'Development';
  }

  return release.prerelease ? 'Preview' : null;
}


function normalizeRelease(release, app, sourceType) {
  const tag =
    release.tag_name ||
    release.tag ||
    release.name ||
    'Development build';

  const publishedAt =
    release.published_at ||
    release.released_at ||
    release.created_at ||
    release.commit?.committed_date ||
    null;

  const releaseType = classifyPreRelease(release);

  if (!releaseType) return null;

  const assets = Array.isArray(release.assets)
    ? release.assets
    : Array.isArray(release.assets?.links)
      ? release.assets.links
      : [];

  const downloadUrl =
    release.html_url ||
    release._links?.self ||
    release.web_url ||
    release.url ||
    app.website;

  return {
    version: String(tag).replace(/^v(?=\d)/i, ''),
    tag,
    name: release.name || tag,
    releaseType,
    date: publishedAt,
    url: downloadUrl,
    source: sourceType,
    prerelease: true,

    assets: assets.slice(0, 20).map((asset) => ({
      name:
        asset.name ||
        asset.filename ||
        asset.direct_asset_url ||
        'Download',

      url:
        asset.browser_download_url ||
        asset.direct_asset_url ||
        asset.url ||
        null,
    })),
  };
}


async function getGitHubReleases(app) {
  const repo = parseGitHubRepo(app.sourceUrl);

  if (!repo) {
    throw new Error(
      `Cannot parse GitHub repository: ${app.sourceUrl}`
    );
  }

  const url =
    `https://api.github.com/repos/${repo}/releases?per_page=100`;

  const data = await fetchJson(url);

  return data
    .filter(
      (release) =>
        release &&
        !release.draft &&
        release.prerelease
    )
    .map((release) =>
      normalizeRelease(release, app, 'GitHub')
    )
    .filter(Boolean);
}


async function getGitLabReleases(app) {
  const project = parseGitLabProject(app.sourceUrl);

  if (!project) {
    throw new Error(
      `Cannot parse GitLab project: ${app.sourceUrl}`
    );
  }

  const base =
    `https://${project.host}/api/v4/projects/${project.encodedPath}`;

  let releases = [];

  try {
    const data = await fetchJson(
      `${base}/releases?per_page=100`
    );

    releases = data
      .filter(
        (release) =>
          release && !release.upcoming_release
      )
      .map((release) =>
        normalizeRelease(release, app, 'GitLab')
      )
      .filter(Boolean);

  } catch (error) {
    console.log(
      `[INFO] ${app.name}: GitLab Releases API unavailable: ${error.message}`
    );
  }

  if (releases.length) {
    return releases;
  }

  // GitLab tags do not have a universal prerelease flag.
  // Only explicitly marked development tags are accepted.

  const tags = await fetchJson(
    `${base}/repository/tags?per_page=100`
  );

  return tags
    .filter(
      (tag) =>
        tag &&
        /\b(alpha|beta|rc|nightly|snapshot|dev|preview|unstable|testing|canary)\b/i.test(
          tag.name || ''
        )
    )
    .map((tag) =>
      normalizeRelease(
        {
          tag_name: tag.name,
          name: tag.name,
          created_at:
            tag.commit?.committed_date || null,
          web_url:
            `${app.sourceUrl.replace(/\/$/, '')}/-/tree/${encodeURIComponent(tag.name)}`,
          prerelease: true,
        },
        app,
        'GitLab'
      )
    )
    .filter(Boolean);
}


async function getBlenderDailyBuilds(app) {
  const html = await fetchText(
    'https://builder.blender.org/download/daily/'
  );

  const matches = [
    ...html.matchAll(
      /href=["']([^"']*(?:linux|windows|macos)[^"']*\.(?:tar\.xz|zip|dmg))["']/gi
    ),
  ]
    .map((match) => match[1])
    .filter((href) => !href.startsWith('#'));

  const unique = [
    ...new Set(matches),
  ].slice(0, HISTORY_LIMIT);

  return unique.map((href, index) => {
    const url = new URL(
      href,
      'https://builder.blender.org/download/daily/'
    ).toString();

    const filename = path.basename(
      new URL(url).pathname
    );

    const dateMatch = filename.match(/(\d{8})/);

    const date = dateMatch
      ? `${dateMatch[1].slice(0, 4)}-${dateMatch[1].slice(4, 6)}-${dateMatch[1].slice(6, 8)}`
      : null;

    return {
      version: filename,
      tag: filename,
      name: `Blender Daily Build ${index + 1}`,
      releaseType: 'Nightly',
      date,
      url,
      source: 'Blender Daily Builds',
      prerelease: true,

      assets: [
        {
          name: filename,
          url,
        },
      ],
    };
  });
}


async function updateApplication(app) {
  const source = app.releaseSource || {};

  let releases;

  if (source.type === 'blender-daily-builds') {
    releases = await getBlenderDailyBuilds(app);

  } else if (source.type === 'github') {
    releases = await getGitHubReleases(app);

  } else if (source.type === 'gitlab') {
    releases = await getGitLabReleases(app);

  } else {
    throw new Error(
      `Unsupported release source type: ${source.type || 'missing'}`
    );
  }

  const unique = new Map();

  for (const release of releases) {
    const key =
      `${release.tag}|${release.date || ''}`;

    if (!unique.has(key)) {
      unique.set(key, release);
    }
  }

  return [...unique.values()]
    .sort((a, b) =>
      String(b.date || '').localeCompare(
        String(a.date || '')
      )
    )
    .slice(0, HISTORY_LIMIT);
}


async function main() {
  const software = JSON.parse(
    await fs.readFile(SOFTWARE_FILE, 'utf8')
  );

  const applications = Array.isArray(software)
    ? software
    : software.applications;

  if (!Array.isArray(applications)) {
    throw new Error(
      'software.json must contain an applications array.'
    );
  }

  let previous = {
    schemaVersion: 1,
    updatedAt: null,
    applications: [],
  };

  try {
    previous = JSON.parse(
      await fs.readFile(RELEASES_FILE, 'utf8')
    );
  } catch {
    // First run: create the data file.
  }

  const previousById = new Map(
    (previous.applications || []).map(
      (item) => [item.id, item]
    )
  );

  const output = [];
  let successCount = 0;

  for (const app of applications) {
    try {
      console.log(
        `[INFO] Updating ${app.name}...`
      );

      const releases =
        await updateApplication(app);

      output.push({
        id: app.id,
        name: app.name,
        slug: app.slug,
        releaseCount: releases.length,
        releases,
        updatedAt: new Date().toISOString(),
      });

      successCount += 1;

      console.log(
        `[OK] ${app.name}: ${releases.length} pre-release(s)`
      );

    } catch (error) {
      console.log(
        `[WARN] ${app.name}: ${error.message}`
      );

      const old = previousById.get(app.id);

      output.push(
        old || {
          id: app.id,
          name: app.name,
          slug: app.slug,
          releaseCount: 0,
          releases: [],
          updatedAt: null,
          error: error.message,
        }
      );
    }

    // Avoid sending requests too quickly.
    await sleep(350);
  }

  const result = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    applications: output,
  };

  await fs.mkdir(
    path.dirname(RELEASES_FILE),
    { recursive: true }
  );

  await fs.writeFile(
    RELEASES_FILE,
    `${JSON.stringify(result, null, 2)}\n`
  );

  console.log('');

  console.log(
    `[DONE] Updated ${successCount}/${applications.length} applications.`
  );

  console.log(
    `[DONE] Saved ${RELEASES_FILE}`
  );
}


main().catch((error) => {
  console.error(
    `[FATAL] ${error.stack || error.message}`
  );

  process.exitCode = 1;
});
