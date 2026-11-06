/**
 * G2 behavior oracle: summary-customer-scope
 *
 * Selected by the `probe:summary-customer-scope` label on a fixture issue (resolved in
 * gates/behavior-probes.ts) — never by issue number.
 *
 * Contract source (fixture issue "GET /summary should accept ?customer= to scope the totals"):
 * the summary route accepts ?customer=<id> and computes the existing numeric fields over that
 * customer's invoices only; a customer with no invoices returns zeroes with status 200; the
 * voided-exclusion rule still applies inside the scope; an absent param is whole-ledger as today.
 *
 * Deliberately NOT asserted: the per-status count fields added by the earlier summary issue. The
 * contract here names only the numeric totals, so a run neither gains nor loses on those.
 */
export const key = "summary-customer-scope";

// Which fleet repo this oracle boots against ($DRYDOCK_CONFIG_DIR/repo-registry.json). Selection is by label; this is a
// guard so an invoice oracle can never be run against the jobs service and silently "pass".
export const repo = "lalanikarim/factory-fixture";
// Provenance only — never used to select this oracle (labels do that). Lets --regression tell
// "this feature's issue is still open" apart from "this shipped feature regressed".
export const sourceIssue = 44;

export const title = `GET /summary?customer= computes the totals for one customer only`;

/**
 * @param {{ base: string, api: Function }} ctx  // ctx.api(base, method, path, body?) -> {status, body}
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function check({ base, api }) {
  const openA = await api(base, "POST", "/invoices", { customerId: "scope-a", amountCents: 100 });
  const paidA = await api(base, "POST", "/invoices", { customerId: "scope-a", amountCents: 200 });
  const voidedA = await api(base, "POST", "/invoices", { customerId: "scope-a", amountCents: 999 });
  await api(base, "POST", "/invoices", { customerId: "scope-b", amountCents: 50 });
  await api(base, "PUT", `/invoices/${paidA.body.id}/status`, { status: "paid" });
  await api(base, "PUT", `/invoices/${voidedA.body.id}/status`, { status: "voided" });

  const scoped = await api(base, "GET", "/summary?customer=scope-a");
  const other = await api(base, "GET", "/summary?customer=scope-b");
  const miss = await api(base, "GET", "/summary?customer=scope-none");
  const whole = await api(base, "GET", "/summary");

  // A: open 100 + paid 200 count (999 is voided and excluded); B: open 50 only.
  const scopedOk = scoped.status === 200 && scoped.body.invoiceCount === 2 &&
    scoped.body.totalCents === 300 && scoped.body.openCents === 100 && scoped.body.paidCents === 200;
  const otherOk = other.status === 200 && other.body.invoiceCount === 1 && other.body.totalCents === 50;
  const missOk = miss.status === 200 && [miss.body.invoiceCount, miss.body.totalCents, miss.body.openCents, miss.body.paidCents].every((v) => v === 0);
  // Unscoped stays whole-ledger: the three non-voided invoices (100 open A, 200 paid A, 50 open B).
  const wholeOk = whole.status === 200 && whole.body.invoiceCount === 3 && whole.body.totalCents === 350;

  return {
    ok: scopedOk && otherOk && missOk && wholeOk,
    detail: `?customer=scope-a -> ${JSON.stringify(scoped.body)} (want count 2/total 300/open 100/paid 200), scope-b -> ${JSON.stringify(other.body)} (want 1/50), no-match ${miss.status} ${JSON.stringify(miss.body)} (want zeros), unscoped -> ${JSON.stringify(whole.body)} (want 3/350); seeded voided=999 must stay excluded`,
  };
}
