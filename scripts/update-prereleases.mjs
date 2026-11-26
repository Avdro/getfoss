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
 * Supports GitHub Releases + explicitly labelled GitHub tags,
 * GitLab Releases + explicitly labelled GitLab tags.
 * This updater is independent from Stable Releases.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOFTWARE_FILE = path.join(ROOT, 'src/data/prereleases/software.json');
const RELEASES_FILE = path.join(ROOT, 'src/data/prereleases/releases.json');

const HISTORY_LIMIT = 30;
const REQUEST_TIMEOUT_MS = 25_000;
const USER_AGENT = 'GetFOSS-PreRelease-Updater/2.0 (+https://www.getfoss.org)';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url, options = {}) {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  if (process.env.GITHUB_TOKEN && /api\.github\.com/i.test(url)) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = response.status === 403
      ? ' (API rate limit or access restriction)'
      : '';
    throw new Error(`HTTP ${response.status}${detail}: ${url}`);
  }

  return response;
}

async function fetchJson(url) {
  const response = await request(url);
  return response.json();
}

function getGitHubSource(app) {
  const source = app.releaseSource || {};
  let owner = source.owner;
  let repository = source.repository;

  if ((!owner || !repository) && app.sourceUrl) {
    const match = app.sourceUrl.match(
      /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/i
    );

    if (match) {
      owner ||= match[1];
      repository ||= match[2].replace(/\.git$/i, '');
    }
  }

  if (!owner || !repository) {
    throw new Error(
      'GitHub source requires releaseSource.owner and releaseSource.repository'
    );
  }

  return { owner, repository };
}

function getGitLabSource(app) {
  const source = app.releaseSource || {};
  let host = source.host || 'https://gitlab.com';
  let project = source.project || source.projectPath;

  if (!project && app.sourceUrl) {
    const match = app.sourceUrl.match(/^https?:\/\/([^/]+)\/(.+)$/i);

    if (match) {
      host = `https://${match[1]}`;
      project = match[2]
        .replace(/\/-\/.*$/, '')
        .replace(/\.git$/i, '')
        .replace(/\/+$/, '');
    }
  }

  if (!project) {
    throw new Error(
      'GitLab source requires releaseSource.project or a valid sourceUrl'
    );
  }

  return {
    host: String(host).replace(/\/+$/, ''),
    project: String(project).replace(/^\/+|\/+$/g, ''),
  };
}

/**
 * Classify using ONLY the release name/tag.
 * Descriptions and release notes are deliberately excluded.
 */
function classifyPreRelease({ name = '', tag = '', prerelease = false } = {}) {
  const text = `${name} ${tag}`.toLowerCase();

  const has = (pattern) => pattern.test(text);

  if (
    has(/(?:^|[^a-z])(?:nightly|nightlies|daily|snapshot|canary)(?:[^a-z]|$)/)
  ) {
    return 'Nightly';
  }

  if (
    has(/(?:^|[^a-z])alpha(?:[._+-]?\d*)?(?:$|[^a-z])/)
  ) {
    return 'Alpha';
  }

  if (
    has(/(?:^|[^a-z])beta(?:[._+-]?\d*)?(?:$|[^a-z])/)
  ) {
    return 'Beta';
  }

  if (
    has(/(?:^|[^a-z])(?:rc|release[._ -]?candidate|candidate)(?:[._+-]?\d*)?(?:$|[^a-z])/)
  ) {
    return 'Release Candidate';
  }

  if (
    has(/(?:^|[^a-z])(?:dev|development|preview|pre[._ -]?release|unstable|testing|edge)(?:[._+-]?\d*)?(?:$|[^a-z])/)
  ) {
    return 'Development';
  }

  return prerelease ? 'Preview' : null;
}

function normalizeRelease(
  item,
  app,
  sourceType,
  fallbackUrl,
  tagOverride = null
) {
  const tag = String(
    tagOverride ||
    item.tag_name ||
    item.tag ||
    item.name ||
    ''
  ).trim();

  if (!tag) return null;

  const releaseType = classifyPreRelease({
    name: item.name || item.title || '',
    tag,
    prerelease: Boolean(item.prerelease),
  });

  if (!releaseType) return null;

  const dateValue =
    item.published_at ||
    item.released_at ||
    item.created_at ||
    item.commit?.committer?.date ||
    item.commit?.author?.date ||
    null;

  const date = dateValue && !Number.isNaN(Date.parse(dateValue))
    ? new Date(dateValue).toISOString()
    : null;

  const rawAssets = Array.isArray(item.assets)
    ? item.assets
    : Array.isArray(item.assets?.links)
      ? item.assets.links
      : [];

  const assets = rawAssets.slice(0, 20)
    .map((asset) => ({
      name:
        asset.name ||
        asset.filename ||
        asset.label ||
        'Download',

      url:
        asset.browser_download_url ||
        asset.direct_asset_url ||
        asset.url ||
        asset.external_url ||
        null,
    }))
    .filter((asset) => asset.url);

  return {
    version: tag.replace(/^v(?=\d)/i, ''),
    tag,
    name: item.name || item.title || `${app.name} ${tag}`,
    releaseType,
    date,
    url:
      item.html_url ||
      item.web_url ||
      item._links?.self ||
      item.url ||
      fallbackUrl,
    source: sourceType,
    prerelease: true,
    assets,
  };
}

function sortAndLimit(releases) {
  const unique = new Map();

  for (const release of releases.filter(Boolean)) {
    const key = `${release.tag}|${release.date || ''}`;

    if (!unique.has(key)) {
      unique.set(key, release);
    }
  }

  return [...unique.values()]
    .sort((a, b) =>
      String(b.date || '').localeCompare(String(a.date || ''))
    )
    .slice(0, HISTORY_LIMIT);
}

async function getGitHubReleases(app) {
  const { owner, repository } = getGitHubSource(app);

  const base = `https://api.github.com/repos/${owner}/${repository}`;

  const [releaseData, tagData] = await Promise.all([
    fetchJson(`${base}/releases?per_page=100`),
    fetchJson(`${base}/tags?per_page=100`),
  ]);

  if (!Array.isArray(releaseData) || !Array.isArray(tagData)) {
    throw new Error('GitHub API returned an unexpected response');
  }

  const releases = [];

  for (const item of releaseData) {
    if (!item || item.draft) continue;

    const normalized = normalizeRelease(
      item,
      app,
      'GitHub',
      `https://github.com/${owner}/${repository}/releases/tag/${encodeURIComponent(item.tag_name || '')}`
    );

    if (normalized) {
      releases.push(normalized);
    }
  }

  // Some projects publish preview builds as Git tags
  // without creating formal GitHub Release entries.
  for (const item of tagData) {
    if (!item?.name) continue;

    const releaseType = classifyPreRelease({
      tag: item.name,
    });

    if (!releaseType) continue;

    const tagUrl =
      `https://github.com/${owner}/${repository}/tree/${encodeURIComponent(item.name)}`;

    const normalized = normalizeRelease(
      {
        tag_name: item.name,
        name: item.name,
        commit: item.commit,
        html_url: tagUrl,
      },
      app,
      'GitHub',
      tagUrl,
      item.name
    );

    if (normalized) {
      releases.push(normalized);
    }
  }

  return sortAndLimit(releases);
}

async function getGitLabReleases(app) {
  const { host, project } = getGitLabSource(app);

  const encodedProject = encodeURIComponent(project);
  const base = `${host}/api/v4/projects/${encodedProject}`;

  const releases = [];

  try {
    const data = await fetchJson(
      `${base}/releases?per_page=100`
    );

    if (!Array.isArray(data)) {
      throw new Error('GitLab Releases API returned an unexpected response');
    }

    for (const item of data) {
      if (!item || item.upcoming_release) continue;

      const tag = item.tag_name || '';

      const normalized = normalizeRelease(
        item,
        app,
        'GitLab',
        `${host}/${project}/-/releases/${encodeURIComponent(tag)}`
      );

      if (normalized) {
        releases.push(normalized);
      }
    }
  } catch (error) {
    console.log(
      `[INFO] ${app.name}: GitLab Releases API: ${error.message}`
    );
  }

  // Also check explicitly labelled development tags.
  try {
    const tags = await fetchJson(
      `${base}/repository/tags?per_page=100`
    );

    if (!Array.isArray(tags)) {
      throw new Error('GitLab Tags API returned an unexpected response');
    }

    for (const item of tags) {
      if (
        !item?.name ||
        !classifyPreRelease({ tag: item.name })
      ) {
        continue;
      }

      const tagUrl =
        `${host}/${project}/-/tree/${encodeURIComponent(item.name)}`;

      const normalized = normalizeRelease(
        {
          tag_name: item.name,
          name: item.name,
          commit: item.commit,
          web_url: tagUrl,
        },
        app,
        'GitLab',
        tagUrl,
        item.name
      );

      if (normalized) {
        releases.push(normalized);
      }
    }
  } catch (error) {
    console.log(
      `[INFO] ${app.name}: GitLab Tags API: ${error.message}`
    );
  }

  if (!releases.length) {
    throw new Error('Could not retrieve GitLab releases or tags');
  }

  return sortAndLimit(releases);
}

async function updateApplication(app) {
  const type = app.releaseSource?.type;

  if (type === 'github') {
    return getGitHubReleases(app);
  }

  if (type === 'gitlab') {
    return getGitLabReleases(app);
  }

  throw new Error(
    `Unsupported release source type: ${type || 'missing'}`
  );
}

async function main() {
  console.log('GetFOSS — Pre-release Builds updater');
  console.log('====================================');

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

  const ids = new Set();

  for (const app of applications) {
    if (!app?.id || !app?.name || !app?.releaseSource?.type) {
      throw new Error(
        'Every application must have id, name and releaseSource.type.'
      );
    }

    if (ids.has(app.id)) {
      throw new Error(`Duplicate application id: ${app.id}`);
    }

    ids.add(app.id);
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
    // First run: create the output file.
  }

  const previousById = new Map(
    (Array.isArray(previous.applications)
      ? previous.applications
      : []
    ).map((item) => [item.id, item])
  );

  const output = [];

  let successCount = 0;
  let preservedCount = 0;
  let emptyCount = 0;
  let errorCount = 0;

  for (let index = 0; index < applications.length; index += 1) {
    const app = applications[index];
    const old = previousById.get(app.id);

    console.log(
      `[${index + 1}/${applications.length}] Updating ${app.name}...`
    );

    try {
      const releases = await updateApplication(app);

      output.push({
        id: app.id,
        name: app.name,
        slug: app.slug,
        releaseCount: releases.length,
        releases,
        updatedAt: new Date().toISOString(),
      });

      successCount += 1;

      if (releases.length === 0) {
        emptyCount += 1;
      }

      console.log(
        `[OK] ${app.name}: ${releases.length} pre-release(s)`
      );
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : String(error);

      console.log(
        `[WARN] ${app.name}: ${message}`
      );

      if (
        old &&
        Array.isArray(old.releases) &&
        old.releases.length > 0
      ) {
        output.push({
          ...old,
          name: app.name,
          slug: app.slug,
          releaseCount: old.releases.length,
          updatedAt: old.updatedAt || null,
          error: message,
        });

        preservedCount += 1;

        console.log(
          `[INFO] Preserved ${old.releases.length} previous entries`
        );
      } else {
        output.push({
          id: app.id,
          name: app.name,
          slug: app.slug,
          releaseCount: 0,
          releases: [],
          updatedAt: null,
          error: message,
        });

        errorCount += 1;
      }
    }

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
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8'
  );

  console.log('');
  console.log('====================================');
  console.log(`Updated successfully: ${successCount}/${applications.length}`);
  console.log(`Empty results:        ${emptyCount}`);
  console.log(`Preserved old data:   ${preservedCount}`);
  console.log(`Errors without data:  ${errorCount}`);
  console.log(`[DONE] Saved ${RELEASES_FILE}`);
}

main().catch((error) => {
  console.error(
    `[FATAL] ${error.stack || error.message}`
  );

  process.exitCode = 1;
});
