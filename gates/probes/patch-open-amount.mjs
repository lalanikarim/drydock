/**
 * G2 behavior oracle: patch-open-amount
 *
 * Selected by the `probe:patch-open-amount` label on a fixture issue (resolved in
 * gates/behavior-probes.ts) — never by issue number.
 *
 * Written from the issue's acceptance criteria, NOT from any implementation: this is the
 * independent signal that "the suite passes" cannot provide, because a worker that deletes
 * an assertion stays green. Do not weaken an assertion to make a run pass; if the check and
 * the issue disagree, the issue text is the contract — fix whichever is wrong in review.
 *
 * `detail` must be self-diagnosing: it is the only thing printed on failure.
 */
export const key = "patch-open-amount";

// Which fleet repo this oracle boots against ($DRYDOCK_CONFIG_DIR/repo-registry.json). Selection is by label; this is a
// guard so an invoice oracle can never be run against the jobs service and silently "pass".
export const repo = "lalanikarim/factory-fixture";
// Provenance only — never used to select this oracle (labels do that). Lets --regression tell
// "this feature's issue is still open" apart from "this shipped feature regressed".
export const sourceIssue = 34;

export const title = `PATCH /invoices/:id edits amountCents only while open; other fields rejected`;

/**
 * @param {{ base: string, api: Function }} ctx  // ctx.api(base, method, path, body?) -> {status, body}
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function check({ base, api }) {
  // Issue: PATCH /invoices/:id edits amountCents only while open; other fields rejected.
        const open = await api(base, "POST", "/invoices", { customerId: "c34", amountCents: 100 });
        const patched = await api(base, "PATCH", `/invoices/${open.body.id}`, { amountCents: 250 });
        const paid = await api(base, "POST", "/invoices", { customerId: "c34b", amountCents: 300 });
        await api(base, "PUT", `/invoices/${paid.body.id}/status`, { status: "paid" });
        const patchPaid = await api(base, "PATCH", `/invoices/${paid.body.id}`, { amountCents: 1 });
        const paidAfter = await api(base, "GET", `/invoices/${paid.body.id}`);
        const badAmount = await api(base, "PATCH", `/invoices/${open.body.id}`, { amountCents: -5 });
        const afterBad = await api(base, "GET", `/invoices/${open.body.id}`);
        const smuggled = await api(base, "PATCH", `/invoices/${open.body.id}`, { amountCents: 500, status: "paid" });
        const smuggledAfter = await api(base, "GET", `/invoices/${open.body.id}`);
        const missing = await api(base, "PATCH", "/invoices/999999", { amountCents: 10 });
        const editOk = patched.status === 200 && patched.body.amountCents === 250;
        const immutableOk = patchPaid.status === 409 && paidAfter.body.amountCents === 300;
        const validateOk = badAmount.status === 400 && afterBad.body.amountCents === 250;
        const noSmuggleOk = smuggled.status === 400 && smuggledAfter.body.status === "open" && smuggledAfter.body.amountCents === 250;
        const notFoundOk = missing.status === 404;
        return {
          ok: editOk && immutableOk && validateOk && noSmuggleOk && notFoundOk,
          detail: `PATCH open ${patched.status} amount=${patched.body.amountCents} (want 200/250), PATCH paid ${patchPaid.status} amount=${paidAfter.body.amountCents} (want 409/300), bad amount ${badAmount.status} kept=${afterBad.body.amountCents} (want 400/250), smuggled status ${smuggled.status} status=${smuggledAfter.body.status} (want 400/open), unknown ${missing.status} (want 404)`,
        };
}
