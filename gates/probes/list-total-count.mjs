/**
 * G2 behavior oracle: list-total-count
 *
 * Selected by the `probe:list-total-count` label on a fixture issue (resolved in
 * gates/behavior-probes.ts) — never by issue number.
 *
 * Contract source (fixture issue "GET /invoices should report totalCount for the filtered set"):
 * the list route returns { invoices, totalCount } where totalCount counts the FILTERED set
 * before limit/offset; windowing and ordering of `invoices` are unchanged; no matches → 0 + [].
 *
 * Written from the acceptance criteria, not from any implementation. Do not weaken an assertion
 * to make a run pass — if the check and the issue disagree, the issue text is the contract.
 */
export const key = "list-total-count";

// Which fleet repo this oracle boots against ($DRYDOCK_CONFIG_DIR/repo-registry.json). Selection is by label; this is a
// guard so an invoice oracle can never be run against the jobs service and silently "pass".
export const repo = "lalanikarim/factory-fixture";
// Provenance only — never used to select this oracle (labels do that). Lets --regression tell
// "this feature's issue is still open" apart from "this shipped feature regressed".
export const sourceIssue = 42;

export const title = `GET /invoices reports totalCount for the filtered set, before paging`;

/**
 * @param {{ base: string, api: Function }} ctx  // ctx.api(base, method, path, body?) -> {status, body}
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function check({ base, api }) {
  const a1 = await api(base, "POST", "/invoices", { customerId: "tc-a", amountCents: 100 });
  const a2 = await api(base, "POST", "/invoices", { customerId: "tc-a", amountCents: 200 });
  const a3 = await api(base, "POST", "/invoices", { customerId: "tc-a", amountCents: 300 });
  await api(base, "POST", "/invoices", { customerId: "tc-b", amountCents: 400 });

  const filtered = await api(base, "GET", "/invoices?customer=tc-a");
  const paged = await api(base, "GET", "/invoices?customer=tc-a&limit=1&offset=1");
  const none = await api(base, "GET", "/invoices?customer=tc-none");

  const shapeOk = filtered.status === 200 && Array.isArray(filtered.body.invoices);
  const countOk = filtered.body.totalCount === 3;
  // Windowing must still apply to `invoices` while totalCount reports the whole filtered set.
  const pageOk = paged.status === 200 && paged.body.invoices.length === 1 &&
    paged.body.invoices[0].id === a2.body.id && paged.body.totalCount === 3;
  const emptyOk = none.status === 200 && none.body.totalCount === 0 && none.body.invoices.length === 0;

  return {
    ok: shapeOk && countOk && pageOk && emptyOk,
    detail: `filtered totalCount=${JSON.stringify(filtered.body.totalCount)} (want 3), limit=1&offset=1 -> ${JSON.stringify(paged.body.invoices?.map((i) => i.id))}/totalCount=${JSON.stringify(paged.body.totalCount)} (want [${a2.body.id}]/3), no-match totalCount=${JSON.stringify(none.body.totalCount)} len=${none.body.invoices?.length} (want 0/0); created ids ${[a1.body.id, a2.body.id, a3.body.id]}`,
  };
}
