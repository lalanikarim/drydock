// #238 — live verification of the body-hash check, against GitHub, once, for real.
//
// Why a gate script and not a test: this needs the factory's credential and a network path to api.github.com. The
// hermetic suite pins the *contract* (tri-state verdicts, hostile fakes); this proves the contract against the bytes
// GitHub actually returns — that `--jq .body` is the same content the REST JSON carries, and that a bad repo/issue or
// a dead credential produces `error`, never a sha.
//
//   node gates/scope-claim-live.mjs [owner/repo] [issueNumber] [--against <sha256>]
//
// `--against` compares against a previously recorded hash (e.g. a ledger's `bodyShaAtAbort`) and prints the verdict
// through the production comparison function, so what you see is what `delegate` would have logged.
//
// The end-to-end "contradicted" log line needs a wall-budget abort on an issue that has one, which cannot be
// manufactured without burning a full budget:
//
//   grep -n "byte-identical to the one at abort" /tmp/fleet-<sha>.log
//
// That is deliberate — see the PR: reporting a false claim is worth exactly as much as detecting it honestly, and
// more than a synthetic abort that costs 40 minutes of inference to stage.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { fetchIssueProjection } from "../factory/gh-read.ts";
import { sanitizeUntrusted } from "../factory/untrusted.ts";
import { compareIssueText, hashIssueText, makeGhIssueProber } from "../factory/issue-body-sha.ts";

const pExecFile = promisify(execFile);
const [, , repoArg = "lalanikarim/drydock", issueArg = "220", ...rest] = process.argv;
const againstIdx = rest.indexOf("--against");
const against = againstIdx >= 0 ? rest[againstIdx + 1] : undefined;
const issueNumber = Number(issueArg);

if (!/^\d+$/.test(issueArg)) {
  console.error(`usage: node gates/scope-claim-live.mjs [owner/repo] [issueNumber] [--against <sha256>]`);
  process.exit(2);
}
// Which credential reads the issue is stated, not assumed. Production passes the factory's own App installation
// token (`auth.token()`); this gate runs as whoever invoked it — ambient `gh` auth included. That difference does not
// affect what is being verified (byte equality of a body both identities can read), but on a private repo an ambient
// identity that cannot see it fails LOUDLY here, which is the point of printing the mode at all.
const explicit = process.env.FACTORY_GITHUB_TOKEN ?? process.env.GH_TOKEN;
const credentialMode = explicit ? "explicit token from the environment" : "ambient gh auth (the invoking user, not the factory App)";

const probe = makeGhIssueProber({ repo: repoArg, ...(explicit ? { token: explicit } : {}) });
const probed = await probe(issueNumber);

if ("error" in probed) {
  console.log(`FAIL — the prober reported unknown, not a hash: ${probed.error}`);
  console.log("This is the correct posture (a failed read must never look like a pass), but it is not evidence either way.");
  process.exit(1);
}

// Cross-check through an independent path: full JSON over the REST API, hashed in-process. If `--jq .body` were
// normalizing or truncating anything, these two hashes would differ and the check would be measuring its own tooling.
const { stdout } = await pExecFile("gh", ["api", `repos/${repoArg}/issues/${issueNumber}`], {
  env: { ...process.env, ...(explicit ? { GH_TOKEN: explicit } : {}) },
  maxBuffer: 8 * 1024 * 1024,
});
const issue = JSON.parse(stdout);
// Rebuild production's projection independently: `fetchIssueProjection` asks gh for
// `.title + "\n--- body ---\n" + (.body // "")` and sanitizes. Doing the same arithmetic here, from the full REST
// payload rather than a jq filter, is what would have caught the bug this gate exists to catch — a prober hashing a
// different projection than the worker was shown reports "clear" forever (#238).
const projection = sanitizeUntrusted(`${String(issue?.title ?? "")}\n--- body ---\n${String(issue?.body ?? "")}`);
const crossSha = hashIssueText(projection);

console.log(`repo/issue      : ${repoArg} #${issueNumber}`);
console.log(`credential      : ${credentialMode}`);
console.log(`prober sha256   : ${probed.sha}`);
console.log(`cross-check sha : ${crossSha}  (gh api full JSON, hashed in-process)`);
console.log(`projection len  : ${probed.textLength} chars (title + separator + body, sanitized)`);
// The comparison that actually matters: the string hashed at ABORT comes from `fetchIssueProjection`, which is what
// `factory/worker.ts` feeds the model. If the retry side drifts from it, every verdict is "clear" and the check is
// dead in production while green in tests — the exact bug this gate was written for.
const abortSide = hashIssueText(await fetchIssueProjection(repoArg, issueNumber, { ...process.env, ...(explicit ? { GH_TOKEN: explicit } : {}) }));
console.log(`abort-side sha  : ${abortSide}  (fetchIssueProjection — what the worker is shown and what abort hashes)`);
console.log(`hashes agree    : ${probed.sha === crossSha ? "yes — the check hashes the real issue text" : "NO — the prober is measuring its own tooling"}`);
console.log(`abort == retry  : ${abortSide === probed.sha ? "yes — both sides of #238 hash the same projection" : "NO — every comparison would report 'clear' and the check is dead"}`);

if (against) {
  const verdict = compareIssueText(against, probed);
  console.log(`--against       : ${against.slice(0, 16)}…`);
  console.log(`verdict         : ${verdict.verdict} — ${verdict.detail}`);
}

process.exit(probed.sha === crossSha && abortSide === probed.sha ? 0 : 1);
