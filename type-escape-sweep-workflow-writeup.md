# Anatomy of a Dynamic Workflow: The Type-Escape Sweep

A fully transparent, decision-by-decision writeup of the multi-agent workflow that produced
[`type-escape-sweep-report.md`](./type-escape-sweep-report.md). Written for future practitioners
who want to understand not just *what* the workflow did, but *why it was shaped the way it was* —
how the phase count was chosen, how the agent count per phase was chosen, what each agent was told,
and every tradeoff taken along the way.

This document is self-contained. You do not need to have seen the run to understand it.

---

## Part 0 — What is a Claude Code dynamic workflow?

A **dynamic workflow** is a deterministic JavaScript orchestration script that Claude Code writes
on the fly and then executes. It coordinates many **subagents** — independent Claude instances, each
with its own fresh context window and its own tools — to do work that a single context either could
not hold or could not do with enough independence.

The key word is **deterministic**. Inside a normal turn, *Claude* decides what to do next, step by
step, in natural language. Inside a workflow, a *script* decides: the loops, the fan-out, the
conditionals, the ordering are all real code. The model's judgment is confined to the inside of each
subagent. This matters because:

- **Control flow is reliable.** "Run these 9 things in parallel, then for each result run a verifier"
  is a `for` loop, not a hope. The orchestration cannot drift, forget a step, or lose track of which
  items it has processed.
- **Context stays clean.** Each subagent's tool calls, file reads, and intermediate reasoning happen
  in *its own* context, not the main one. The main conversation only receives each subagent's final
  answer. A 1.4-million-token sweep across 56 files cost the main thread almost nothing.
- **Independence is structural.** Nine finder agents looking at nine different parts of the codebase
  genuinely cannot see each other's work. That independence is what makes an adversarial check
  meaningful — a verifier that shares context with the thing it's verifying isn't really checking.

### The five primitives

A workflow script is plain JavaScript (not TypeScript) with five orchestration hooks:

| Primitive | What it does |
|---|---|
| `agent(prompt, opts)` | Spawn one subagent. Returns its final text, or — with `opts.schema` — a validated JSON object. The unit of work. |
| `parallel(thunks)` | Run an array of functions concurrently. **A barrier**: waits for *all* of them before returning. |
| `pipeline(items, stage1, stage2, …)` | Run each item through every stage independently, **with no barrier between stages**. Item A can be in stage 3 while item B is still in stage 1. |
| `phase(title)` | Label the subsequent agents for the live progress display. |
| `log(message)` | Emit a progress line to the user. |

Two structural facts shape every workflow:

1. **Concurrency is capped** at roughly `min(16, cpu_cores − 2)` simultaneous agents. You may *submit*
   hundreds; they queue and drain as slots free. A lifetime cap of 1000 agents per workflow is a
   runaway backstop.
2. **The script itself has no filesystem or shell access.** Only the *subagents* can read files, run
   commands, or call tools. The script is pure orchestration logic operating on the JSON the agents
   return.

### `pipeline` vs `parallel` — the single most important design choice

This distinction drives most workflow architecture, so it's worth stating plainly.

- `parallel()` is a **barrier**. Nothing downstream starts until *everything* in the batch finishes.
  Correct only when a later step genuinely needs *all* prior results at once — deduping across the
  full set, early-exiting on a zero count, comparing findings against each other.
- `pipeline()` has **no barrier between stages**. Each item flows through all stages on its own.
  Wall-clock time equals the slowest single *item's chain*, not the sum of the slowest stage at each
  step. This is the default for multi-stage work.

If you find yourself writing `const a = await parallel(...); const b = a.map(transform); const c = await
parallel(b...)` and that middle `transform` has no cross-item dependency, you have paid for a barrier
you didn't need. That exact smell is what `pipeline` exists to remove.

### How a workflow gets triggered

In this environment, a workflow runs only when the user opts in — most simply by including the word
**"workflow"** in their message. The model then authors a script and the user approves it before it
runs. Workflows execute in the **background**: the tool call returns a task ID immediately, and a
notification arrives when the run completes. Progress is watchable live via `/workflows`.

Subagents in a workflow run in `acceptEdits` mode and inherit the session's tool permissions, but the
*script* cannot touch the disk. For a read-only analysis like this sweep, that sandbox is a feature,
not a limitation.

---

## Part 1 — The task that triggered this workflow

The user's prompt was a refined version of a shelved idea ("idea #2 — Type-escape sweep"):

> **workflow:** Type-escape sweep across `vibe/core/`.
> 1. Find every type-system escape (`cast`, `# type: ignore`, `Any`, 3-arg `getattr`, `# pyright: ignore`, etc.).
> 2. For each escape, **adversarially verify** (a skeptic agent that defaults to "removable" and must be
>    argued out of it): is the escape genuinely NECESSARY or UNNECESSARY? Require a concrete re-typing
>    sketch before ruling "necessary."
> 3. Output a single ranked fix-list, highest-confidence-removable first, with clusters. Report only;
>    don't edit code.

The task has a natural three-beat structure baked into its own numbering: **find → judge → synthesize**.
That structure is a strong hint, but I did not adopt it blindly — the reasoning for why those are the
right three phases (and not two, or four) is below.

### Why this task fits a workflow at all

Not every task should be a workflow. This one earned it on three counts:

1. **Breadth over depth.** "Find *every* escape across 56 files" is a coverage problem. One agent reading
   56 files sequentially would exhaust its context and start summarizing instead of cataloguing. Nine
   agents each reading ~6 files stay sharp.
2. **Independence improves the verdict.** The adversarial check only means something if the verifier did
   not produce the finding. Structural separation between finder and verifier is exactly what the
   subagent model provides.
3. **Volume.** ~370 escapes is too many to reason about carefully in one pass. Fanning the judgment out
   keeps each verifier's working set small enough to be rigorous.

If any of those three had been false — say, a five-file module with a dozen escapes — I would have done
it inline in the main thread, no workflow. Reaching for orchestration on a small task wastes tokens and
adds latency.

---

## Part 2 — Pre-flight: sizing the fan-out before writing a line of script

**Decision: I refused to choose a phase or agent count until I knew the size and shape of the problem.**

Before authoring the script I ran a single `grep` across `vibe/` for all the escape patterns at once,
in `count` mode, to get per-file occurrence counts:

```
\bcast\(|# type: ignore|#type:ignore|pyright: ignore|: Any\b|-> Any\b|\bAny\]|getattr\(
```

This returned **460 total occurrences across 94 files in `vibe/`**, of which **~370 lived in `vibe/core/`**
(the actual target) across ~56 files. Critically, it also gave me the *distribution*: a handful of files
dominated.

| File | Escapes (pre-grep) |
|---|---|
| `nuage/remote_workflow_event_translator.py` | 51 |
| `llm/backend/anthropic.py` | 34 |
| `config/_settings.py` | 19 |
| `llm/backend/openai_responses.py` | 15 |
| `core/types.py` | 14 |
| `tools/mcp/tools.py` | 14 |
| `llm/backend/generic.py`, `reasoning_adapter.py` | 12 each |
| `tools/base.py` | 12 |
| `utils/merge.py` | 11 |
| `tools/ui.py` | 10 |
| `tools/connectors/connector_registry.py` | 9 |
| `nuage/remote_workflow_event_models.py` | 8 |
| `mcp_sampling.py`, `telemetry/send.py` | 7 each |
| …~40 more files | 1–6 each |

This pre-flight grep is the single most important methodological step in the whole exercise, and the one
practitioners most often skip. **You cannot rationally choose how many agents to spawn until you know how
much work there is and how it clusters.** A flat "spawn one agent per file" would have created 56 agents,
many doing trivial 1-escape work while one wrestled 51 escapes alone — unbalanced load, wasted slots, and
a context-overload risk on the heavy file. The grep let me balance instead.

The grep deliberately over-matched (it catches some 2-arg `getattr` and `Any` substrings that aren't real
escapes). That's intentional: at the sizing stage a false positive costs nothing, a false negative means
an undersized fan-out. The agents themselves do the precise classification later.

---

## Part 3 — Deciding the number of phases (and what they are)

**Decision: three phases — Find, Verify, Synthesize.**

I evaluated the obvious alternatives explicitly:

### Could it be one phase?
A single "find and judge and rank" agent per bucket. **Rejected.** It collapses the adversarial check —
the same agent that finds an escape is biased toward justifying its own classification. The user's prompt
specifically asked for a *skeptic* that defaults to "removable." That demand is structurally impossible to
honor if finder and judge are the same context. The separation is the point.

### Could it be two phases (Find+Verify merged, then Synthesize)?
Same objection. Merging find and verify forfeits independence. The whole value proposition of the
adversarial step is that the verifier re-opens the file *cold* and tries to refute a claim it did not
make.

### Could it be four or more phases?
A natural candidate fourth phase: a **second, independent verifier** per finding (a 2-of-3 or majority
vote), or a **completeness critic** that asks "what did the finders miss?" Both are legitimate
escalations. I **rejected them for this run** on a cost/value judgment:

- The task is **analysis, not a merge-blocking gate.** The output is a prioritized fix-list a human will
  read and sanity-check, not an automated code change. A single adversarial pass already filters out the
  most obvious over-claims; a second voting layer roughly doubles verify-phase cost for a marginal
  confidence gain on a non-destructive deliverable.
- The verifiers already emit a **`confidence` score per verdict**, which captures most of what a second
  vote would tell me, at a fraction of the cost. Low-confidence verdicts are surfaced as such in the
  report's tiers, so the reader knows where to apply their own scrutiny.

So the honest framing is: **three phases is the *minimum* that preserves the adversarial property the task
demands, and the marginal phases I left out were a deliberate, cost-aware choice — not an oversight.** For a
merge-blocking or security-critical version of this workflow, I would have added the majority-vote verify
layer and the completeness critic. I noted this tradeoff explicitly to the user.

### The three phases, defined

| # | Phase | Purpose | Agent shape |
|---|---|---|---|
| 1 | **Find** | Exhaustively catalogue every escape with `file:line`, kind, snippet, and surrounding-code context. No judgment. | 9 finders, one per bucket |
| 2 | **Verify** | Re-open the files cold and adversarially rule each escape REMOVABLE or NECESSARY, skeptic-default, with a forced re-typing sketch. | 9 verifiers, one per bucket |
| 3 | **Synthesize** | Merge all verdicts into one ranked fix-list, cluster by root cause, name the highest-leverage fixes. | 1 synthesizer |

---

## Part 4 — Deciding the number of agents in each phase

This is the part practitioners most want to see reasoned out, so it gets the most detail.

### Phase 1 (Find): why 9 agents, and why *these* 9

The agent count here is a **bucketing decision**, and it is governed by two competing pressures:

- **Too few buckets** → each finder reads too many files, its context fills with source code, and it starts
  summarizing instead of cataloguing. Coverage degrades silently. This is the dangerous failure mode
  because it looks like success.
- **Too many buckets** → trivial 1-escape agents waste concurrency slots and add fixed per-agent overhead
  (spawn cost, prompt tokens) with no benefit. Also, splitting a single file's escapes across two agents
  would fragment context that belongs together.

The balancing rule I applied: **one bucket per coherent subsystem, sized so each holds roughly 30–50
escapes**, with the natural module boundaries of the codebase as the seams. The pre-grep distribution made
the seams obvious — `nuage/`, `llm/backend/`, `config/`, `tools/`, etc. are real architectural units, and
escapes cluster by unit because each subsystem has its own characteristic boundary (JSON for nuage, SDK
dicts for the backends, TypeVar introspection for tools).

Nine fell out of that rule. Here are the exact buckets, the files in each, and the escape budget that
justified the split:

| # | Bucket key | Files | ~Escapes | Rationale for the boundary |
|---|---|---|---|---|
| 1 | `llm-anthropic` | `anthropic.py`, `backend/base.py`, `vertex.py` | ~36 | Anthropic is 34 alone; `vertex` reuses its payload shape and `base` defines the shared union — they belong together. |
| 2 | `llm-other` | `openai_responses.py`, `generic.py`, `reasoning_adapter.py`, `mistral.py`, `format.py`, `exceptions.py` | ~51 | The non-Anthropic backends share a chat-completions idiom; grouping them lets one verifier see the common pattern. |
| 3 | `nuage-translator` | `remote_workflow_event_translator.py` | ~51 | **A whole bucket for one file.** At 51 escapes it is too heavy to share; isolating it keeps the finder's context entirely on that file's JSON-normalization logic. |
| 4 | `nuage-rest` | 7 remaining `nuage/` files | ~21 | The rest of nuage, which shares the translator's JSON-boundary character — verifying them next to each other surfaces the common root cause. |
| 5 | `config` | 8 `config/` files (`_settings`, `layer`, `layers/*`, `builder`, `orchestrator`, `patch`) | ~38 | The config layer's escapes nearly all trace to two shared abstractions (`ConfigPatch`, `_read_config`); one verifier seeing all of them spots the cluster. |
| 6 | `tools-mcp` | `mcp/tools.py`, `connector_registry.py`, `mcp_sampling.py`, `mcp/registry.py`, `mcp_settings.py` | ~37 | The MCP/connector boundary is its own beast — external JSON-schema contracts. Distinct from the rest of `tools/`. |
| 7 | `tools-core` | `tools/base.py`, `ui.py`, `manager.py`, two builtins | ~26 | The TypeVar-introspection escapes (`get_args`/`get_type_hints`) live here and nowhere else; isolating them gives that hard, irreducible cluster one focused verifier. |
| 8 | `core-top` | `types.py`, `agent_loop.py`, `tracing.py`, `middleware.py`, `logger.py` | ~26 | The top-level loop files — heterogeneous, but all "core spine." |
| 9 | `misc` | 16 small files (`utils/`, `telemetry/`, `session/`, `skills/`, `hooks/`, `agents/`, `experiments/`, `audio*`) | ~46 | The long tail of 1–11-escape files, swept together so they don't each waste an agent. This is the "everything else" bucket, sized by count rather than by subsystem. |

A few principles visible in that table, worth extracting for reuse:

- **A single file can deserve its own agent** (bucket 3). Don't split by file count; split by *work*.
- **Group by shared root cause where you can predict it** (buckets 5, 6, 7). When you suspect escapes will
  cluster around one abstraction, putting them in one verifier's context lets that verifier *name the
  cluster* — which is exactly what the synthesis phase needs.
- **Sweep the long tail into one bucket** (bucket 9) rather than spawning a dozen near-empty agents.

### Phase 2 (Verify): why also 9 — the 1:1 pipeline coupling

The verify phase has the **same 9 agents** as find, because of how the two phases are wired: a
`pipeline(BUCKETS, finder, verifier)`. Each bucket flows finder → verifier as an independent chain. The
verifier for a bucket consumes exactly that bucket's findings.

This 1:1 coupling is a deliberate alternative to the other natural design — **per-escape verification**,
where you'd flatten all ~370 findings and spawn one skeptic per escape. I considered it and rejected it:

- **~370 verify agents** is an order of magnitude more spawns, more tokens, and more wall-clock, for a
  deliverable that doesn't need that granularity.
- **Per-bucket verification preserves useful context.** A verifier judging all of nuage's escapes at once
  can see that thirty of them are the *same* JSON-boundary mistake and rule on them coherently, then the
  synthesizer can collapse them into one cluster. A per-escape verifier sees each in isolation and loses
  that signal.
- The skeptic-default adversarial property is fully preserved at bucket granularity — the verifier still
  re-opens files it didn't catalogue and still must argue each escape out of "removable."

So: **9 verifiers, paired 1:1 with finders via the pipeline, judging at bucket granularity.** The number
wasn't chosen for the verify phase independently; it inherited the find phase's bucketing, which is the
correct coupling for a find→judge pipeline.

### Phase 3 (Synthesize): why exactly 1

Synthesis is a **convergent** step — its entire job is to see *everything at once* and produce a single
coherent artifact: one ranked list, cross-bucket clusters, a global top-5. That is definitionally a
single-context job. Fanning it out would defeat its purpose; you cannot rank findings against each other,
or notice that a nuage escape and a config escape share a root cause, from inside a shard that only sees
part of the set. **One synthesizer, fed the flattened array of all 353 verdicts.**

### Total: 9 + 9 + 1 = 19 agents

Which is exactly what the run reported.

---

## Part 5 — Why a pipeline, not a barrier

**Decision: `pipeline(BUCKETS, finder, verifier)`, then a single synthesis agent after.**

The find→verify relationship is **per-item**: bucket 3's verifier needs bucket 3's findings and nothing
else. There is no cross-bucket dependency between finding and verifying. That is the textbook signature of
a pipeline, not a barrier.

Concretely, the payoff: bucket 3 (`nuage-translator`, the heavy 51-escape file) takes the longest to
*find*. With a pipeline, the light buckets (e.g. `core-top`) finish finding early and their verifiers start
*immediately* — while bucket 3 is still being catalogued. With a barrier (`parallel` all finders, then
`parallel` all verifiers), every verifier would idle until the slowest finder returned. On a 9-bucket job
with a 2–3× spread between fastest and slowest bucket, that wasted idle time is real.

The **one** place I *do* use a barrier is implicit and correct: after the pipeline completes, I flatten all
verdicts and hand them to the single synthesizer. Synthesis genuinely needs *all* verdicts at once — it is
the one cross-item step in the whole workflow — so it correctly waits for the full set. The code expresses
this as a plain `await pipeline(...)` followed by the synthesis `agent()` call; the pipeline's completion is
the natural join point.

```js
const results = await pipeline(BUCKETS, finder, verifier)   // no inter-stage barrier
const allVerdicts = results.filter(Boolean).flatMap(r => r.verdicts)
const report = await agent(synthesisPrompt(allVerdicts))     // the one genuine join
```

---

## Part 6 — The agents in detail: what each was actually told

The quality of a workflow lives in its prompts. Here is the design intent behind each of the three
agent types.

### The finder (Phase 1) — exhaustiveness over judgment

Design goals: (a) catch *everything*, (b) classify *nothing*. Mixing judgment into the finder would
contaminate the adversarial separation, so the finder was explicitly told to *catalogue only*.

Key instructions embedded in the finder prompt:

- An explicit enumeration of the five escape kinds with their schema tags (`cast`, `type-ignore`,
  `pyright-ignore`, `Any`, `getattr`, plus `other`), including the precise rule "**3-arg `getattr` only, not
  2-arg**" — because 2-arg `getattr(x, "name")` is ordinary attribute access, not a typing escape, and
  over-reporting it would pollute the verify phase.
- "**Use Grep to locate then Read to confirm each with surrounding context.**" — find-then-confirm, so each
  reported line is backed by a real read, not a grep guess.
- "**Report the real 1-based line number.**" — because the whole report's value is navigability; a wrong
  line number makes a finding useless.
- "**Do NOT verify/judge yet — just catalog completely. Miss nothing.**" — the exhaustiveness mandate, and
  the firewall against premature judgment.

Output was forced through a JSON schema (`FINDINGS_SCHEMA`) with one object per escape carrying `file`,
`line`, `kind`, `snippet`, and `context` (a 1–2 sentence note on what the surrounding code is doing). That
`context` field is what makes the next phase efficient — the verifier gets a running start.

### The verifier (Phase 2) — the adversarial skeptic

This is the heart of the workflow, and its prompt was written to be genuinely hostile to escapes:

- "**Your DEFAULT verdict is REMOVABLE. An escape is guilty until proven innocent — you must be ARGUED into
  'NECESSARY'.**" — the skeptic-default the user asked for, stated as a hard prior.
- A closed list of what *counts* as a legitimate necessity: "genuinely runtime-only/dynamic type, a
  third-party UNTYPED boundary, unavoidable (de)serialization of unknown shape, or a Python typing
  limitation with no overload/Protocol/generic/TypeVar/TypedDict workaround." This prevents the model from
  inventing vague justifications.
- "**Before ruling NECESSARY you MUST sketch the re-typing you tried and explain precisely why it fails.**"
  — the forced-work requirement. This is the single most important line: it makes "this is fine" expensive.
  A model that has to *write down* the Protocol it would use, and then show why it doesn't compile, cannot
  hand-wave.
- "**Re-open the files yourself (Read) to judge in real context — do not trust the snippet alone.**" — the
  independence mandate. The verifier must look with its own eyes, not rubber-stamp the finder's snippet.

Output schema (`VERDICTS_SCHEMA`): one verdict per escape with `verdict` (REMOVABLE/NECESSARY),
`confidence` (0–1), `proposedRetype` (the concrete re-typing for REMOVABLE, or the concrete reason it's
impossible for NECESSARY), and a one-line `rationale`.

The `confidence` field deserves a note: it is what let me *not* add a second verify layer. Instead of a
majority vote raising confidence, the single verifier self-reports it, and the synthesizer tiers the report
by it. A reader applies extra scrutiny precisely where confidence is low. This is a deliberate
cost/transparency tradeoff — cheaper than a vote, and arguably more informative because it's graded rather
than binary.

### The synthesizer (Phase 3) — convergence and leverage

The synthesizer was asked for four specific artifacts, in order:

1. A one-paragraph summary with totals by verdict and by kind.
2. A **ranked** fix-list table, highest-confidence-REMOVABLE first, NECESSARY last — so a human reads it
   top-down in priority order.
3. A **clusters** section grouping escapes that share one root cause, "so they can be fixed in one stroke."
   This is the highest-value output: it turns 272 individual removals into ~11 coherent fixes.
4. A **highest-leverage fixes** list: the 5 changes that eliminate the most escapes.

The clustering instruction is why per-bucket verification (Part 4) was the right call — verifiers that saw
whole subsystems had already half-formed the clusters in their rationales, giving the synthesizer the raw
material to consolidate across buckets.

---

## Part 7 — Why structured output (schemas) everywhere

Every find and verify agent was given a JSON schema via `opts.schema`. This is not decoration:

- **Validation happens at the tool-call layer.** A subagent that returns malformed output is made to retry
  by the harness, before the script ever sees it. The script never parses free text or handles a
  half-broken table.
- **It forces completeness.** A schema requiring `verdict`, `confidence`, and `rationale` on every item
  means the verifier cannot quietly skip an escape — every catalogued escape comes back with a full
  verdict.
- **It makes the script's job trivial.** `results.flatMap(r => r.verdicts)` works because every result is a
  validated object of known shape. No defensive coding.

The synthesizer was the one agent *without* a schema — its job is to produce prose-and-tables Markdown for a
human, so free text is the correct output type there.

---

## Part 8 — Execution results and telemetry

The run completed in a single shot, exit-clean. Reported telemetry:

| Metric | Value |
|---|---|
| Agents spawned | **19** (9 find + 9 verify + 1 synthesize) |
| Escapes verified | **353** |
| Verdict split | **272 REMOVABLE (77%) / 81 NECESSARY (23%)** |
| Subagent tokens | **1,429,439** |
| Tool uses (across all agents) | **233** |
| Wall-clock | **~21 minutes** (1,258,804 ms) |
| Buckets completed | 9 / 9 |

Note the relationship between the pre-grep estimate (~370) and the verified count (353). The grep
over-counted (by design — it caught some 2-arg `getattr` and non-escape `Any` substrings); the finders'
precise classification trimmed it to 353 real escapes. The two numbers being close is a good sign: it means
the finders didn't *under*-report (which would have shown up as a count far below 370). The ~370→353 shrink
is the false-positive trim, not a coverage gap.

The full findings, all four tiers and eleven clusters, are in
[`type-escape-sweep-report.md`](./type-escape-sweep-report.md).

---

## Part 9 — Every decision, catalogued

A flat list of the choices made, for quick scanning and critique:

| Decision | Choice | Why |
|---|---|---|
| Use a workflow at all? | Yes | Breadth (56 files), independence (adversarial check), volume (~370 items). |
| Sizing method | Pre-grep in count mode, all patterns at once | Can't size the fan-out without knowing the distribution. |
| Grep precision | Deliberately over-match | At sizing time, false positives are free; false negatives undersize the run. |
| Phase count | 3 (find/verify/synthesize) | Minimum that preserves the adversarial separation. |
| Phases rejected | 1-phase, 2-phase | Both collapse finder/verifier independence. |
| Phases deferred | 2nd verify vote, completeness critic | Cost/value: analysis deliverable, not a blocking gate; `confidence` field substitutes for a vote. |
| Find agent count | 9 buckets | One per subsystem, ~30–50 escapes each; balance load, preserve context. |
| Bucketing seam | Module boundaries | Escapes cluster by subsystem; lets verifiers name clusters. |
| One file as its own bucket | `nuage` translator (51 escapes) | Too heavy to share; isolate to keep context focused. |
| Long-tail handling | One `misc` bucket of 16 small files | Avoid a dozen near-empty agents. |
| Verify agent count | 9, paired 1:1 with finders | Pipeline coupling; bucket-granular verification preserves cluster signal. |
| Per-escape verify? | Rejected | ~370 agents for no deliverable benefit; loses cluster context. |
| Synthesize agent count | 1 | Convergent step; needs all verdicts at once. |
| Topology | `pipeline`, not `parallel` barrier | Find→verify is per-item; pipeline lets fast buckets verify while slow buckets still find. |
| Output typing | JSON schema on find + verify; free text on synthesize | Validation, completeness, trivial script logic; prose for the human-facing report. |
| Confidence handling | Self-reported 0–1, tiered in report | Cheaper than a vote, graded rather than binary. |
| Scope | Read-only ("report only") | Matches the workspace's learning-territory rule; no code touched. |

---

## Part 10 — Limitations and what I'd do differently

Stated plainly, because a transparent report names its own weaknesses:

1. **No compiler in the loop.** The verifiers *read* the code but did not *run* Pyright. Claims like
   "verified 0 errors" are model assertions, not compiler output. The honest next step before acting on any
   Tier-A removal is `uv run pyright` on a branch with the change applied. A stronger version of this
   workflow would give each verifier a `bash` step that actually applies its proposed re-type to a scratch
   copy and runs Pyright, turning every verdict from *asserted* to *proven*. I did not do this because the
   task said "report only," and because per-verifier compiler runs would multiply cost and wall-clock
   substantially.
2. **Single adversarial pass.** For a non-destructive analysis this is adequate, but for a merge-gating use
   I would add a majority-vote verify layer (3 independent skeptics, kill on 2-of-3 refute) and a
   completeness critic phase that asks "which files or escape kinds did the finders under-cover?"
3. **Bucket boundaries were hand-drawn from one grep.** They're good, but a heavy file hiding inside the
   `misc` bucket could in principle have starved for attention. The escape counts made that unlikely here
   (the `misc` files top out at 11), but on a less-uniform codebase I'd iterate the bucketing once after
   seeing finder output sizes.
4. **The synthesizer trusts the verifiers.** It ranks and clusters but does not re-judge. A bad verdict
   propagates. The `confidence` tiers mitigate this by flagging where to look, but they don't eliminate it.

None of these are reasons not to run it — the report is a strong, prioritized starting point. They are the
boundary of what a read-only, single-pass adversarial sweep can claim, stated so a practitioner knows
exactly how much to trust each row.

---

## Part 11 — Reproducibility

The exact workflow script was persisted by the harness at run time to:

```
…/workflows/scripts/type-escape-sweep-wf_774efd1e-cd4.js
```

Its essential shape, reconstructed:

```js
export const meta = {
  name: 'type-escape-sweep',
  description: 'Find every type-system escape in vibe/core/, adversarially verify each, output a ranked fix-list',
  phases: [
    { title: 'Find',       detail: 'one finder per subsystem bucket' },
    { title: 'Verify',     detail: 'adversarial skeptic per bucket — defaults REMOVABLE' },
    { title: 'Synthesize', detail: 'merge, cluster, rank into one fix-list' },
  ],
}

const ROOT = 'mistral-vibe-main/vibe/core'
const BUCKETS = [ /* 9 entries: {key, files:[…]} balanced by escape count */ ]

const FINDINGS_SCHEMA = { /* escapes[]: {file, line, kind, snippet, context} */ }
const VERDICTS_SCHEMA  = { /* verdicts[]: {file, line, kind, verdict, confidence, proposedRetype, rationale} */ }

const results = await pipeline(
  BUCKETS,
  (b)         => agent(FINDER_PROMPT(b),  { phase: 'Find',   schema: FINDINGS_SCHEMA, label: `find:${b.key}` }),
  (found, b)  => agent(VERIFY_PROMPT(b, found), { phase: 'Verify', schema: VERDICTS_SCHEMA, label: `verify:${b.key}` }),
)

const allVerdicts = results.filter(Boolean).flatMap(r => r.verdicts)
log(`Verified ${allVerdicts.length} escapes across ${results.filter(Boolean).length} buckets`)

phase('Synthesize')
const report = await agent(SYNTHESIS_PROMPT(allVerdicts), { phase: 'Synthesize', label: 'synthesize' })

return { report, totalVerdicts: allVerdicts.length, buckets: results.filter(Boolean).length }
```

To re-run or adapt it: change `ROOT` and the `BUCKETS` to retarget another codebase or another class of
escape, keep the find→verify→synthesize topology, and re-size the buckets from a fresh pre-grep. The pattern
generalizes to any "find every instance of X across a large codebase, adversarially judge each, and
prioritize" task — dead code, security sinks, deprecated API calls, `TODO`s worth doing — by swapping the
patterns and the verifier's rubric.

---

## Appendix — A reusable recipe for find→verify→synthesize workflows

1. **Pre-grep** the whole target for all patterns at once, in count mode. Over-match on purpose.
2. **Read the distribution.** Note the heavy files and the natural module seams.
3. **Bucket** by subsystem, sized so each holds a comfortable working set (here, ~30–50 items). One heavy
   file can be its own bucket; sweep the long tail into one.
4. **Phase count = the minimum that preserves the property you need.** If you need an adversarial check, you
   need find and verify *separated* — that's already two phases plus a synthesis = three.
5. **Pipeline, not barrier**, whenever the per-item stages have no cross-item dependency.
6. **Schema the structured phases; free-text the human-facing one.**
7. **Make "it's fine" expensive** — force the skeptic to do concrete work (write the fix it claims is
   impossible) before it's allowed to wave a finding through.
8. **Self-reported confidence, tiered in the output**, is a cheap substitute for a voting layer on
   non-blocking deliverables — and tell the reader where it's low.
9. **Name your limitations** in the report. A sweep that didn't run the compiler should say so.
