# Software Factory

Research repository on **coding agent software factories** — how autonomous coding agents are organized into production pipelines ("tickets in, reviewed pull requests out") — plus a feasibility assessment of building such a factory on **Pi Durable**.

## Contents

| File | What it is |
|---|---|
| [`research/coding-agent-software-factories.md`](research/coding-agent-software-factories.md) | Research notes: the concept, anatomy, evolution timeline (2019 → Feb 2026), products & platforms, design principles, reported results |
| [`research/coding-agent-software-factories.html`](research/coding-agent-software-factories.html) | Self-contained HTML report of the same research (open in a browser; no external dependencies) |
| [`research/pi-durable-feasibility.md`](research/pi-durable-feasibility.md) | Feasibility assessment: building a software factory on `@earendil-works/pi-durable`, with requirement mapping, PoC evidence, gaps, risks, and a recommended build path |
| [`research/drydock-explainer.md`](research/drydock-explainer.md) · [HTML](research/drydock-explainer.html) | Detailed explainer of how drydock works: component map, end-to-end flow (mermaid in md / inline SVG in html), intake security, worker/reviewer/merge-gate internals, feedback loop, fleet operation, and G0–G5 evidence |
| [`research/poc-plan-factory.md`](research/poc-plan-factory.md) · [HTML](research/poc-plan-factory.html) | PoC plan + results: the "issue → reviewed PR" loop on Pi Durable — all phases complete (G0–G5 passed, measured) |
| [`research/multi-repo-factory-plan.md`](research/multi-repo-factory-plan.md) | Next-phase plan: managing multiple repos simultaneously — Target 1 (N factories) spec with gates M1–M4, Target 2 (single orchestrator over M repos) as a gated follow-up with a funding decision rule |

## The implementation

[`factory/`](factory/) contains the pipeline itself: an **intake** that receives GitHub issues, a **sandboxed worker** that implements a fix in an isolated environment, an **independent reviewer** that evaluates the diff against the issue, and a **merge gate** that only lets a PR through once review passes. [`fleet/`](fleet/) layers a **supervisor** process on top of one or more factory instances and provides a **multi-repo adapter** so a single fleet can route tickets to the correct repository's pipeline. See [fleet/enable-self-work.md](fleet/enable-self-work.md) for how to bring the fleet up, and §5 of [research/multi-repo-factory-plan.md](research/multi-repo-factory-plan.md#5-migration-to-engram-core-drop-poc-wiring-for-a-proper-composition) for the design decisions behind the current architecture. A pull request like this one can be sent back for rework by commenting `/factory rebase` or `/factory instruct <what to change>`; only allowlisted human senders may do so. This is a research deployment running on local models against one author's own repositories — not a hosted product, and nothing here is packaged for other users.

## Key findings

**What a software factory is.** A managed system for producing software with repeatable inputs (tickets, alerts, webhooks), standardized tooling and isolated runtimes, measurable output, and retained context. The factory is the *process around* the agents: intake → runtime → implementation → independent review → verification → human approval at merge. Agents run unattended; humans own the merge.

**Evolution.** Code completion (2019) → AI pair programmers (Copilot/Cursor) → agent swarms ("throw tokens at it": Devin, Factory, 8090) → foundation-model inflection (Claude Code, GPT-5's 256K context) → agent managers (VibeKanban, Conductor, Codex app) → the Ralph Wiggums technique → true orchestrators (GasTown, Claude Flow, Sgai) → "dark factories" with humans out of the loop (StrongDM's Attractor).

**Pi Durable feasibility: high.** Every core factory primitive is a Pi Durable first-class feature, and a companion PoC verified nearly all of them under crash conditions (SIGKILL mid-run recovery, exactly-once intake, crash-durable approval gates, sandboxed per-conversation execution, lossless streaming). The factory PoC in [`poc/`](poc/) has since passed gates G0–G5 on a live fixture repo — issue → sandboxed worker → independent review → evidence on the PR → approval-gated merge with exactly-once semantics across a mid-approval crash, and a feedback loop where a recorded reviewer lesson verifiably changed the worker's fix pattern on an analogous issue. Phase 6 measured the loop: bounded issues run 129–433s at ~81–145K total tokens on one local GPU (~50–100 issues/night single-threaded). Remaining structural risks: local-model quality on long-horizon coding, and the experimental API.

## Methodology

Compiled 2026-10-18 from primary sources — factory.com, islo.dev, warp.dev, sandgarden.com (Cirello's "The Evolution of AI Factories"), guild.ai — cross-checked against a local Pi Durable proof-of-concept (PoC) run on local models. All claims in the reports carry source links; customer-reported metrics are labeled as such.

## License

MIT — see [LICENSE](LICENSE).
