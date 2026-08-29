import assert from "node:assert/strict";
import test from "node:test";

import {
  TRACKED_RELEASES,
  checkTrackedReleases,
  normalizeMarker,
  selectLatestRelease,
} from "../src/check.js";

const ENV = Object.freeze({
  GITHUB_TOKEN: "test-token",
  GITHUB_OWNER: "kapdon",
  GITHUB_REPO: "pacman-repo",
  GITHUB_REF: "main",
  GITHUB_WORKFLOW: "publish.yml",
});

const TAGS = Object.freeze({
  "tolaria-alpha-bin": "alpha-v2027.8.30-alpha.0001",
  "tolaria-bin": "v2027-08-28",
  "easycli-bin": "v0.2.65",
});

function releasesFor(upstream) {
  if (upstream === "refactoringhq/tolaria") {
    return [
      { tag_name: TAGS["tolaria-alpha-bin"], draft: false, prerelease: true },
      { tag_name: TAGS["tolaria-bin"], draft: false, prerelease: false },
    ];
  }
  return [
    { tag_name: TAGS["easycli-bin"], draft: false, prerelease: false },
  ];
}

function mockFetch({ stalePackage, inFlight = false, marker404 = false } = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url: url.toString(), init });

    if (url.hostname === "api.github.com" && url.pathname.endsWith("/releases")) {
      const upstream = url.pathname.split("/").slice(2, 4).join("/");
      return Response.json(releasesFor(upstream));
    }

    if (url.hostname === "kapdon.github.io") {
      const packageName = url.pathname.split("/").at(-1).replace(/\.txt$/, "");
      if (packageName === stalePackage) {
        if (marker404) return new Response("", { status: 404 });
        return new Response("older-tag\n");
      }
      return new Response(`${TAGS[packageName]}\n`);
    }

    if (url.pathname.endsWith("/runs")) {
      return Response.json({
        workflow_runs: [{ status: inFlight ? "in_progress" : "completed" }],
      });
    }

    if (url.pathname.endsWith("/dispatches")) {
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected request: ${url}`);
  };
  return { calls, fetchImpl };
}

test("selectLatestRelease skips drafts and selects the requested channel", () => {
  const record = TRACKED_RELEASES[0];
  const tag = selectLatestRelease(
    [
      { tag_name: "bad-draft", draft: true, prerelease: true },
      { tag_name: TAGS[record.package], draft: false, prerelease: true },
    ],
    record,
  );
  assert.equal(tag, TAGS[record.package]);
});

test("normalizeMarker removes only trailing line endings", () => {
  const record = TRACKED_RELEASES[2];
  assert.equal(normalizeMarker("v0.2.65\r\n", record), "v0.2.65");
  assert.throws(
    () => normalizeMarker("v0.2.65\nextra\n", record),
    /Unexpected published release tag/,
  );
});

test("does nothing when every tracked package is current", async () => {
  const { calls, fetchImpl } = mockFetch();
  const result = await checkTrackedReleases(ENV, fetchImpl);
  assert.equal(result.outcome, "current");
  assert.equal(calls.filter((call) => call.url.includes("/releases?")).length, 2);
  assert.equal(calls.some((call) => call.url.endsWith("/dispatches")), false);
});

test("dispatches only the first stale package", async () => {
  const { calls, fetchImpl } = mockFetch({ stalePackage: "tolaria-bin" });
  const result = await checkTrackedReleases(ENV, fetchImpl);
  assert.deepEqual(result.dispatched, {
    package: "tolaria-bin",
    tag: TAGS["tolaria-bin"],
  });
  const dispatch = calls.find((call) => call.url.endsWith("/dispatches"));
  assert.deepEqual(JSON.parse(dispatch.init.body), {
    ref: "main",
    inputs: {
      package: "tolaria-bin",
      release_tag: TAGS["tolaria-bin"],
    },
  });
});

test("waits when the publisher already has an active run", async () => {
  const { calls, fetchImpl } = mockFetch({
    stalePackage: "easycli-bin",
    inFlight: true,
  });
  const result = await checkTrackedReleases(ENV, fetchImpl);
  assert.equal(result.outcome, "waiting");
  assert.equal(calls.some((call) => call.url.endsWith("/dispatches")), false);
});

test("treats a missing marker as stale", async () => {
  const { fetchImpl } = mockFetch({
    stalePackage: "tolaria-alpha-bin",
    marker404: true,
  });
  const result = await checkTrackedReleases(ENV, fetchImpl);
  assert.equal(result.outcome, "dispatched");
  assert.equal(result.dispatched.package, "tolaria-alpha-bin");
});

test("rejects malformed upstream tags", async () => {
  const record = TRACKED_RELEASES[2];
  assert.throws(
    () =>
      selectLatestRelease(
        [{ tag_name: "main", draft: false, prerelease: false }],
        record,
      ),
    /Unexpected upstream release tag/,
  );
});
