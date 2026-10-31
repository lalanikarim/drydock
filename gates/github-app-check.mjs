// Verify the configured GitHub App: identity, installation target, permission grants, and which
// repositories the installation can actually see. Reads .env; prints no secret material.
//
//   node --experimental-strip-types gates/github-app-check.mjs [--json]
//
// This is a read-only probe: it mints a 9-minute JWT (the app's own credential), reads the app and
// installation records, and requests an installation token to list accessible repositories. It does
// not write anything to GitHub.

import { readFileSync, existsSync } from "node:fs";
import { createSign } from "node:crypto";

const API = "https://api.github.com";

function loadEnv(path = ".env") {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = { ...loadEnv(), ...process.env };
const appId = env.GITHUB_APP_ID;
const keyPath = env.GITHUB_APP_PRIVATE_KEY_PATH;
const installationId = env.GITHUB_APP_INSTALLATION_ID;

if (!appId || !keyPath || !installationId) {
  console.error("GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH and GITHUB_APP_INSTALLATION_ID are all required");
  process.exit(2);
}
if (!existsSync(keyPath)) {
  console.error(`private key not found at ${keyPath}`);
  process.exit(2);
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function mintJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId }));
  const signingInput = `${header}.${claims}`;
  const sig = createSign("RSA-SHA256").update(signingInput).sign(readFileSync(keyPath, "utf8"));
  return `${signingInput}.${b64url(sig)}`;
}

async function gh(path, { token, method = "GET", accept = "application/vnd.github+json" } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
      "User-Agent": "drydock-app-check",
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

const jwt = mintJwt();

const appRes = await gh("/app", { token: jwt });
if (appRes.status !== 200) {
  console.error(`app identity check failed: HTTP ${appRes.status} ${JSON.stringify(appRes.body).slice(0, 300)}`);
  console.error("(a 401 here usually means the JWT could not be verified against this App ID — wrong key or wrong app)");
  process.exit(1);
}
const app = appRes.body;

const instRes = await gh(`/app/installations/${installationId}`, { token: jwt });
if (instRes.status !== 200) {
  console.error(`installation check failed: HTTP ${instRes.status} ${JSON.stringify(instRes.body).slice(0, 300)}`);
  process.exit(1);
}
const inst = instRes.body;

// The installation token is what the factory would actually use. Its `permissions` block is the
// authoritative statement of what that token can do.
const tokRes = await gh(`/app/installations/${installationId}/access_tokens`, { token: jwt, method: "POST" });
if (tokRes.status !== 201) {
  console.error(`installation token failed: HTTP ${tokRes.status} ${JSON.stringify(tokRes.body).slice(0, 300)}`);
  process.exit(1);
}
const installToken = tokRes.body.token;

// Paginate: `repository_selection: all` means every repo in the account, including ones created
// later, so a single page tells you nothing about the real blast radius. Count them all.
const repos = [];
let page = 1;
for (; page <= 30; page += 1) {
  const res = await gh(`/installation/repositories?per_page=100&page=${page}`, { token: installToken });
  repos.push(...(res.body.repositories ?? []));
  if (repos.length >= (res.body.total_count ?? repos.length)) break;
  if ((res.body.repositories ?? []).length === 0) break;
}
const truncated = page > 30;

// Read probes against the repos the factory cares about — read-only, no side effects.
const targets = ["lalanikarim/drydock", "lalanikarim/factory-fixture", "lalanikarim/factory-fixture-2"];
const reads = {};
for (const full of targets) {
  const issues = await gh(`/repos/${full}/issues?per_page=1`, { token: installToken, accept: "application.github+json" });
  const prs = await gh(`/repos/${full}/pulls?per_page=1`, { token: installToken });
  reads[full] = { issues: issues.status, pulls: prs.status };
}

const want = { contents: "write", pull_requests: "write", issues: "read" };
const perms = inst.permissions ?? {};
const missing = Object.entries(want).filter(([k, level]) => {
  const have = perms[k];
  return level === "write" ? have !== "write" : !have;
});

/** What the installation may do in each repo the factory actually manages. */
const targetRepos = {};
for (const full of targets) {
  const hit = repos.find((r) => r.full_name === full);
  // /installation/repositories does not include per-repo permission flags; the installation's own
  // `permissions` block is the authoritative grant and applies to every listed repo.
  targetRepos[full] = hit ? { listed: true, private: hit.private } : { listed: false };
}

const report = {
  app: {
    slug: app.slug,
    id: app.id,
    owner: app.owner?.login,
    name: app.name,
    permissions_requested: app.permissions,
    events: app.events,
  },
  installation: {
    id: inst.id,
    account: inst.account?.login,
    target_type: inst.target_type,
    repository_selection: inst.repository_selection,
    permissions_granted: inst.permissions,
    events: inst.events,
  },
  token: {
    expires_at: tokRes.body.expires_at,
    permissions: tokRes.body.permissions,
    repositories_count: tokRes.body.repositories?.length ?? "not returned",
  },
  accessible_repository_count: repos.length,
  accessible_repository_count_truncated: truncated,
  accessible_private_count: repos.filter((r) => r.private).length,
  managed_repositories: targetRepos,
  accessible_repositories_sample: repos.slice(0, 10).map((r) => r.full_name),
  read_probes: reads,
  required_scopes_missing: missing.map(([k, v]) => `${k}:${v}`),
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`App:        ${report.app.name} (slug ${report.app.slug}, id ${report.app.id}, owned by ${report.app.owner})`);
  console.log(`Events:     ${report.app.events.join(", ") || "(none)"}`);
  console.log(`Install:    ${inst.id} on ${report.installation.account} (${report.installation.target_type}), repos: ${report.installation.repository_selection}`);
  console.log(`Granted:    ${Object.entries(perms).map(([k, v]) => `${k}:${v}`).join(", ")}`);
  console.log(`Token:      ok, expires ${report.token.expires_at}`);
  console.log(`Reach:      ${repos.length}${truncated ? "+" : ""} repositories (${report.accessible_private_count} private) — selection: ${report.installation.repository_selection}`);
  console.log(`Managed repos:`);
  for (const [name, t] of Object.entries(targetRepos)) {
    if (!t.listed) { console.log(`  - ${name}: NOT in the installation's repo list`); continue; }
    console.log(`  - ${name}${t.private ? " (private)" : ""}`);
  }
  console.log(`Read probes:`);
  for (const [name, r] of Object.entries(reads)) console.log(`  - ${name}: issues HTTP ${r.issues}, pulls HTTP ${r.pulls}`);
  console.log(`Factory needs contents:write, pull_requests:write, issues:read → ${missing.length === 0 ? "ALL PRESENT" : `MISSING: ${report.required_scopes_missing.join(", ")}`}`);
}

// -----------------------------------------------------------------------------------------------
// Opt-in write probe. Creating and deleting a git ref is the smallest thing that proves the token
// can do what the factory does (push a branch) without touching file content, opening a PR, or
// creating an issue. Off by default: it is still a mutation, and on the fixture repos it would need
// sign-off like any other mutating gate.
//
//   node gates/github-app-check.mjs --probe-push lalanikarim/drydock
// -----------------------------------------------------------------------------------------------
const probeIdx = process.argv.indexOf("--probe-push");
if (probeIdx !== -1) {
  const repo = process.argv[probeIdx + 1];
  if (!repo) {
    console.error("--probe-push needs an owner/repo argument");
    process.exit(2);
  }
  const ref = `refs/heads/chore/app-write-probe-${Date.now()}`;
  const head = await gh(`/repos/${repo}/git/ref/heads/main`, { token: installToken });
  if (head.status !== 200) {
    console.error(`probe aborted: cannot read main on ${repo} (HTTP ${head.status})`);
    process.exit(1);
  }
  const sha = head.body.object.sha;
  const created = await fetch(`${API}/repos/${repo}/git/refs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${installToken}`, Accept: "application/vnd.github+json", "User-Agent": "drydock-app-check", "Content-Type": "application/json" },
    body: JSON.stringify({ ref, sha }),
  });
  if (created.status !== 201) {
    const detail = (await created.text()).slice(0, 300);
    console.log(`WRITE PROBE ${repo}: could not create a ref (HTTP ${created.status}) — contents:write is NOT effective here`);
    console.log(`  ${detail}`);
    process.exitCode = 1;
  } else {
    // Path-style, not ?ref_name=: that query parameter does not exist on the delete endpoint, and a
    // 404 there leaves the probe ref behind (learned the first time it ran). Slashes stay literal.
    // The path parameter keeps the heads/ namespace (DELETE …/git/refs/heads/<branch>); stripping it
    // yields a 422 because "chore/x" is not a valid ref namespace.
    const name = ref.replace(/^refs\//, "").split("/").map(encodeURIComponent).join("/");
    const deleted = await fetch(`${API}/repos/${repo}/git/refs/${name}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${installToken}`, Accept: "application/vnd.github+json", "User-Agent": "drydock-app-check" },
    });
    console.log(`WRITE PROBE ${repo}: created ${ref} at ${sha.slice(0, 8)} and deleted it (HTTP ${deleted.status})`);
    if (deleted.status !== 204) console.log(`  WARNING: the probe ref may still exist — delete ${ref} manually`);
  }
}
