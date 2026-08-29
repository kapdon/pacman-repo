export const TRACKED_RELEASES = Object.freeze([
  Object.freeze({
    package: "tolaria-alpha-bin",
    name: "Tolaria alpha",
    upstream: "refactoringhq/tolaria",
    channel: "prerelease",
    tagPattern: /^alpha-v[0-9]+\.[0-9]+\.[0-9]+-alpha\.0*[0-9]+$/,
    markerUrl:
      "https://kapdon.github.io/pacman-repo/release-tags/tolaria-alpha-bin.txt",
  }),
  Object.freeze({
    package: "tolaria-bin",
    name: "Tolaria stable",
    upstream: "refactoringhq/tolaria",
    channel: "stable",
    tagPattern: /^v[0-9]{4}-[0-9]{2}-[0-9]{2}$/,
    markerUrl:
      "https://kapdon.github.io/pacman-repo/release-tags/tolaria-bin.txt",
  }),
  Object.freeze({
    package: "easycli-bin",
    name: "EasyCLI",
    upstream: "router-for-me/EasyCLIProxyAPI",
    channel: "stable",
    tagPattern: /^v[0-9]+\.[0-9]+\.[0-9]+$/,
    markerUrl:
      "https://kapdon.github.io/pacman-repo/release-tags/easycli-bin.txt",
  }),
]);

const GITHUB_API_VERSION = "2022-11-28";
const MAX_TAG_LENGTH = 255;

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "pacman-release-checker",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

async function githubRequest(fetchImpl, token, path, init = {}) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    ...init,
    headers: {
      ...githubHeaders(token),
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API ${path} returned HTTP ${response.status}`);
  }

  return response;
}

function assertTag(tag, record) {
  if (
    typeof tag !== "string" ||
    tag.length === 0 ||
    tag.length > MAX_TAG_LENGTH ||
    tag.includes("\r") ||
    tag.includes("\n") ||
    !record.tagPattern.test(tag)
  ) {
    throw new Error(`Unexpected upstream release tag for ${record.name}`);
  }
  return tag;
}

export function selectLatestRelease(releases, record) {
  if (!Array.isArray(releases)) {
    throw new Error(`Unexpected GitHub response for ${record.name}`);
  }

  const release = releases.find((candidate) => {
    if (!candidate || candidate.draft === true) return false;
    if (record.channel === "prerelease") return candidate.prerelease === true;
    if (record.channel === "stable") return candidate.prerelease === false;
    throw new Error(`Unsupported release channel for ${record.name}`);
  });

  if (!release) {
    throw new Error(`No ${record.channel} release found for ${record.name}`);
  }

  return assertTag(release.tag_name, record);
}

export function normalizeMarker(body, record) {
  const tag = body.replace(/[\r\n]+$/, "");
  if (
    tag.length > MAX_TAG_LENGTH ||
    tag.includes("\r") ||
    tag.includes("\n")
  ) {
    throw new Error(`Unexpected published release tag for ${record.name}`);
  }
  return tag;
}

async function readMarker(fetchImpl, record, nonce) {
  const separator = record.markerUrl.includes("?") ? "&" : "?";
  const response = await fetchImpl(
    `${record.markerUrl}${separator}check=${encodeURIComponent(nonce)}`,
    {
      headers: { "Cache-Control": "no-cache" },
      cache: "no-store",
    },
  );

  if (response.status === 404) return "";
  if (!response.ok) {
    throw new Error(
      `${record.name} release marker returned HTTP ${response.status}`,
    );
  }
  return normalizeMarker(await response.text(), record);
}

async function hasPublisherInFlight(fetchImpl, env) {
  const workflow = encodeURIComponent(env.GITHUB_WORKFLOW);
  const response = await githubRequest(
    fetchImpl,
    env.GITHUB_TOKEN,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${workflow}/runs?per_page=20&exclude_pull_requests=true`,
  );
  const payload = await response.json();
  if (!Array.isArray(payload.workflow_runs)) {
    throw new Error("Unexpected GitHub workflow-runs response");
  }
  return payload.workflow_runs.some((run) => run.status !== "completed");
}

async function dispatchPublisher(fetchImpl, env, record, tag) {
  const workflow = encodeURIComponent(env.GITHUB_WORKFLOW);
  await githubRequest(
    fetchImpl,
    env.GITHUB_TOKEN,
    `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: env.GITHUB_REF,
        inputs: {
          package: record.package,
          release_tag: tag,
        },
      }),
    },
  );
}

export async function checkTrackedReleases(env, fetchImpl = fetch) {
  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is not configured");
  }

  const releasesByUpstream = new Map();
  const checks = [];
  const nonce = crypto.randomUUID();

  for (const record of TRACKED_RELEASES) {
    let releases = releasesByUpstream.get(record.upstream);
    if (!releases) {
      const response = await githubRequest(
        fetchImpl,
        env.GITHUB_TOKEN,
        `/repos/${record.upstream}/releases?per_page=100`,
      );
      releases = await response.json();
      releasesByUpstream.set(record.upstream, releases);
    }

    const upstreamTag = selectLatestRelease(releases, record);
    const publishedTag = await readMarker(fetchImpl, record, nonce);
    checks.push({
      package: record.package,
      name: record.name,
      upstreamTag,
      publishedTag,
      current: upstreamTag === publishedTag,
    });
  }

  const stale = checks.find((check) => !check.current);
  if (!stale) {
    return { outcome: "current", checks };
  }

  if (await hasPublisherInFlight(fetchImpl, env)) {
    return { outcome: "waiting", checks };
  }

  const record = TRACKED_RELEASES.find(
    (candidate) => candidate.package === stale.package,
  );
  await dispatchPublisher(fetchImpl, env, record, stale.upstreamTag);
  return {
    outcome: "dispatched",
    dispatched: { package: stale.package, tag: stale.upstreamTag },
    checks,
  };
}
