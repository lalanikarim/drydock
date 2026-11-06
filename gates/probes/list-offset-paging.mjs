/**
 * G2 behavior oracle: list-offset-paging
 *
 * Selected by the `probe:list-offset-paging` label on a fixture issue (resolved in
 * gates/behavior-probes.ts) — never by issue number.
 *
 * Written from the issue's acceptance criteria, NOT from any implementation: this is the
 * independent signal that "the suite passes" cannot provide, because a worker that deletes
 * an assertion stays green. Do not weaken an assertion to make a run pass; if the check and
 * the issue disagree, the issue text is the contract — fix whichever is wrong in review.
 *
 * `detail` must be self-diagnosing: it is the only thing printed on failure.
 */
export const key = "list-offset-paging";

// Which fleet repo this oracle boots against ($DRYDOCK_CONFIG_DIR/repo-registry.json). Selection is by label; this is a
// guard so an invoice oracle can never be run against the jobs service and silently "pass".
export const repo = "lalanikarim/factory-fixture";
// Provenance only — never used to select this oracle (labels do that). Lets --regression tell
// "this feature's issue is still open" apart from "this shipped feature regressed".
export const sourceIssue = 33;

export const title = `?offset=N windows the filtered list; bad offset -> 400; past end -> empty 200`;

/**
 * @param {{ base: string, api: Function }} ctx  // ctx.api(base, method, path, body?) -> {status, body}
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function check({ base, api }) {
  // Issue: ?offset=N windows the filtered list; bad offset → 400; past end → empty 200.
        const ids = [];
        for (let i = 0; i < 5; i++) {
          const created = await api(base, "POST", "/invoices", { customerId: `c33-${i}`, amountCents: 100 + i });
          ids.push(created.body.id);
        }
        const win = await api(base, "GET", "/invoices?offset=2&limit=2");
        const zero = await api(base, "GET", "/invoices?offset=0&limit=2");
        const absent = await api(base, "GET", "/invoices?limit=2");
        const pastEnd = await api(base, "GET", "/invoices?offset=99");
        const badOffset = await api(base, "GET", "/invoices?offset=-1");
        const badText = await api(base, "GET", "/invoices?offset=abc");
        const winOk = win.status === 200 && JSON.stringify(win.body.invoices.map((i) => i.id)) === JSON.stringify(ids.slice(2, 4));
        const sameOk = zero.status === 200 && absent.status === 200 && JSON.stringify(zero.body.invoices.map((i) => i.id)) === JSON.stringify(absent.body.invoices.map((i) => i.id));
        const emptyOk = pastEnd.status === 200 && Array.isArray(pastEnd.body.invoices) && pastEnd.body.invoices.length === 0;
        const rejectOk = badOffset.status === 400 && badText.status === 400;
        return {
          ok: winOk && sameOk && emptyOk && rejectOk,
          detail: `offset=2&limit=2 -> ${JSON.stringify(win.body.invoices?.map((i) => i.id))} (want ${JSON.stringify(ids.slice(2, 4))}), offset=0==absent=${sameOk}, past end ${pastEnd.status}/len${pastEnd.body.invoices?.length}, offset=-1 ${badOffset.status} & abc ${badText.status} (want 400)`,
        };
}
