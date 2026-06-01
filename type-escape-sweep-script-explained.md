# The Workflow Script, Line by Line

A close reading of [`type-escape-sweep.workflow.js`](./type-escape-sweep.workflow.js) — the 124-line
JavaScript program that orchestrated 19 AI agents to audit Mistral Vibe's type system. This document
dissects the script segment by segment so that by the end you can read *any* Claude Code dynamic workflow,
and write your own.

Read this alongside [`type-escape-sweep-workflow-writeup.md`](./type-escape-sweep-workflow-writeup.md),
which covers the *design decisions*. This document covers the *code*.

> **Mental model to hold throughout:** this script is not the work. It is the *conductor*. It never reads a
> Python file, never runs a grep, never judges a `cast`. It only decides *who runs, in what order, with what
> instructions, and what to do with their answers*. All the actual thinking happens inside `agent()` calls —
> each of which is a separate AI with its own fresh mind. The script is pure choreography.

---

## Segment 1 — The manifest (lines 1–9)

```js
export const meta = {
  name: 'type-escape-sweep',
  description: 'Find every type-system escape in vibe/core/, adversarially verify each, output a ranked fix-list',
  phases: [
    { title: 'Find', detail: 'one finder per subsystem bucket — catalog every cast/ignore/Any/getattr' },
    { title: 'Verify', detail: 'adversarial skeptic per bucket — defaults REMOVABLE, must be argued to NECESSARY' },
    { title: 'Synthesize', detail: 'merge, cluster, rank into one fix-list' },
  ],
}
```

**Line 1** — `export const meta` is **mandatory** and must be the very first thing in the script. The runtime
reads it *before* executing anything, to populate the approval dialog and the `/workflows` progress display.

**Lines 2–3** — `name` and `description` are the only required fields. The `description` is what the user sees
in the permission prompt before they approve the run — so it should state plainly what the workflow will do.

**Lines 4–8** — `phases` is an array of `{title, detail}` literals, one per logical stage. These titles are
matched *by exact string* against the `phase: '...'` arguments later in the script (lines 89, 102, 109, 120).
When a `phase('Find')` call or a `{phase: 'Find'}` option fires, its agents are grouped under this "Find" box
in the live display. **The titles here and the strings below must match character-for-character** or you get
orphan progress groups.

> **Key learning #1 — `meta` must be a pure literal.** No variables, no function calls, no template
> interpolation, no spreads. The runtime parses it statically before running the body. `name: \`sweep-${x}\``
> would crash. This is why `ROOT` and `BUCKETS` are declared *after* `meta`, not folded into it.

---

## Segment 2 — Configuration constants (lines 11–24)

```js
const ROOT = 'mistral-vibe-main/vibe/core'

// 9 subsystem buckets, balanced by escape count (counts from pre-grep)
const BUCKETS = [
  { key: 'llm-anthropic', files: [`${ROOT}/llm/backend/anthropic.py`, …] },
  { key: 'llm-other',     files: [ … 6 files … ] },
  { key: 'nuage-translator', files: [`${ROOT}/nuage/remote_workflow_event_translator.py`] },
  …
  { key: 'misc',          files: [ … 16 files … ] },
]
```

**Line 11** — `ROOT` is a path prefix, factored out so the bucket definitions stay readable and so retargeting
the whole sweep to another directory is a one-line change. Note the path is **relative to the session's working
directory** (`C:\Users\simon\Downloads\mistral_vibe_me\`), which is why it begins with `mistral-vibe-main/`.
Subagents inherit that cwd, so they resolve these paths correctly.

**Line 13** — The comment records *provenance*: the bucket sizes came from a pre-grep, not from guesswork. This
is the kind of comment future maintainers need — it tells them the structure is data-driven and where the data
came from.

**Lines 14–24** — `BUCKETS` is the heart of the script's *data*. Each entry is `{key, files}`:
- `key` is a short identifier used to label that bucket's agents in the UI (`find:llm-anthropic`,
  `verify:config`, …). It is the thread you follow in the progress view.
- `files` is the work assignment — the exact files that bucket's finder must read.

The buckets are **balanced by escape count**, not by file count. That is why bucket 3 (`nuage-translator`,
line 17) holds a *single* file while bucket 9 (`misc`, line 23) holds *sixteen*. The translator had ~51 escapes;
each `misc` file had only 1–11. Equalizing the *work*, not the file tally, keeps every agent's context similarly
loaded.

> **Key learning #2 — the data structure you fan out over is the most important design choice in the script.**
> `BUCKETS` *is* the parallelism plan. The number of buckets becomes the number of agents (per stage). How you
> draw the bucket boundaries determines load balance, whether related code lands in one context, and whether the
> later synthesis can spot clusters. Spend your design effort here, not on the prompts.

> **Key learning #3 — template literals build the file paths.** Backtick strings with `${ROOT}` interpolation
> are ordinary JavaScript. The script is plain JS (not TypeScript) — no type annotations, no `import`s beyond the
> injected globals. Everything is built from standard language features plus the five workflow hooks.

---

## Segment 3 — The output contracts (lines 26–72)

Two JSON Schemas. They are not documentation — they are *enforced contracts* that the runtime validates every
agent's output against before the script ever sees it.

### `FINDINGS_SCHEMA` (lines 26–47)

```js
const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['escapes'],
  properties: {
    escapes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'kind', 'snippet', 'context'],
        properties: {
          file:    { type: 'string', … },
          line:    { type: 'integer' },
          kind:    { type: 'string', enum: ['cast','type-ignore','pyright-ignore','Any','getattr','other'] },
          snippet: { type: 'string', … },
          context: { type: 'string', description: '1-2 sentences: what the surrounding code is doing …' },
        },
      },
    },
  },
}
```

**Line 28 / 35** — `additionalProperties: false` forbids the agent from inventing extra fields. The shape is
locked.

**Line 36** — `required` lists every per-escape field. Because `context` is required, a finder *cannot* report
an escape without also explaining the surrounding code — the schema forces the very thing that makes the next
phase efficient.

**Line 40** — `kind` is an `enum`. The agent must classify each escape into one of six exact categories; it
cannot return a free-form label. This is how the script guarantees the downstream data is clean enough to count
and group.

**Lines 38, 41, 42** — the `description` strings inside the schema are *instructions to the model*, delivered at
the exact field it's filling. "the offending line, trimmed" on `snippet` shapes the value without bloating the
prose prompt.

### `VERDICTS_SCHEMA` (lines 49–72)

Same shape, different payload: each item carries `verdict` (an `enum` of exactly `REMOVABLE`/`NECESSARY`, line
64), a numeric `confidence` (line 65), a `proposedRetype` (line 66), and a one-line `rationale` (line 67).

Note `proposedRetype` is **not** in the `required` list (line 59) while `verdict`, `confidence`, and `rationale`
are. That is deliberate: a verdict must always come with a confidence and a justification, but the re-type sketch
is conditional — its `description` (line 66) tells the model to fill it differently for REMOVABLE vs NECESSARY.

> **Key learning #4 — schemas are how you turn an AI into a function.** Without a schema, `agent()` returns a
> blob of prose you have to parse and pray over. *With* a schema, it returns a validated JavaScript object —
> `result.escapes` is just an array, every element guaranteed to have the fields you required. The runtime makes
> the model *retry* if it returns malformed output, so your script never handles a broken response. This is the
> difference between orchestrating data and wrangling text.

> **Key learning #5 — field `description`s are micro-prompts.** Putting "0..1 confidence in the verdict" on the
> `confidence` field is more reliable than explaining the scale in the prose prompt, because the instruction sits
> exactly where the model is generating that value.

---

## Segment 4 — The pipeline: find → verify (lines 74–104)

This is the engine. Everything before it was setup; this is where agents actually run.

```js
const results = await pipeline(
  BUCKETS,
  // STAGE 1 — finder
  (b) => agent( FINDER_PROMPT, { label: `find:${b.key}`, phase: 'Find', schema: FINDINGS_SCHEMA }),
  // STAGE 2 — adversarial skeptic
  (found, b) => agent( VERIFY_PROMPT, { label: `verify:${b.key}`, phase: 'Verify', schema: VERDICTS_SCHEMA }),
).then(rs => rs)
```

**Line 74** — `await pipeline(...)`. `pipeline` takes the array of items first, then any number of *stage
functions*. Each item is pushed through every stage **independently** — there is no barrier between stage 1 and
stage 2. The moment `find:core-top` finishes, `verify:core-top` starts, even if `find:nuage-translator` (the
heavy one) is still running. This is the central efficiency win, and choosing `pipeline` over `parallel` here is
the single most consequential line in the file.

**Line 75** — `BUCKETS` is the items array. Nine buckets → nine independent chains.

**Lines 77–90 — Stage 1, the finder.** `(b) => agent(...)` is a stage function. Its argument `b` is one bucket.
It returns an `agent()` call — spawning one finder subagent for that bucket.
- The prompt (lines 78–88) is built by string concatenation. `${b.files.map(f => '  - ' + f).join('\n')}` (line
  79) injects that bucket's specific file list into the instructions — *this* is how nine agents get nine
  different assignments from one stage function.
- The options object (line 89): `label` names it in the UI, `phase: 'Find'` files it under the Find box,
  `schema: FINDINGS_SCHEMA` forces structured output. Because a schema is present, this `agent()` call returns a
  validated `{escapes: [...]}` object, not text.

**Lines 92–103 — Stage 2, the verifier.** `(found, b) => agent(...)`. **Read the parameters carefully:** a
pipeline stage receives `(previousResult, originalItem, index)`. So `found` is *stage 1's output* (the
`{escapes}` object) and `b` is *the original bucket*. The verifier uses both: `b.files` (line 99) to know which
files to re-open, and `found.escapes` (line 100) to know what to judge.
- **Line 100** — `JSON.stringify(found.escapes)` serializes the finder's catalogue straight into the verifier's
  prompt. This is the hand-off: one agent's structured output becomes the next agent's input, with the script as
  the courier.
- **Line 102** — same options pattern, different `phase` ('Verify') and `schema` (`VERDICTS_SCHEMA`).

**Line 104** — `.then(rs => rs)` is a no-op (it returns its input unchanged). Harmless, but it could be deleted;
`const results = await pipeline(...)` alone would be identical. Worth pointing out precisely *because* it does
nothing — not every line in real code is load-bearing.

> **Key learning #6 — a pipeline stage is just a function, and its signature is the API.** The finder is
> `(b) => …`; the verifier is `(found, b) => …`. The first stage gets the raw item; every later stage gets
> `(whatThePreviousStageReturned, theOriginalItem, itsIndex)`. Knowing that the original item is *always*
> available in later stages means you don't have to thread context through return values — the verifier reaches
> `b.files` directly even though stage 1 didn't pass it along.

> **Key learning #7 — independence is the product.** The finder and verifier for a bucket are *different agents
> with different prompts and no shared memory*. The verifier re-reads the files cold (line 99). That structural
> separation is what makes "adversarially verify" mean something — you cannot rubber-stamp a finding you never
> saw being made.

> **Key learning #8 — one stage function, N agents.** You write the finder logic *once*. The pipeline runs it
> nine times, once per bucket, each spawning its own agent. You never write "agent 1, agent 2, …". The fan-out is
> the loop, and the loop is `pipeline` iterating `BUCKETS`.

---

## Segment 5 — The join: collect and report progress (lines 106–107)

```js
const allVerdicts = results.filter(Boolean).flatMap(r => r.verdicts)
log(`Verified ${allVerdicts.length} escapes across ${results.filter(Boolean).length} buckets`)
```

**Line 106** — `results` is an array of nine `{verdicts: [...]}` objects (one per bucket, from stage 2).
- `.filter(Boolean)` drops any `null` entries. **A stage that throws drops that item to `null`** rather than
  crashing the whole workflow — so this filter is defensive: if one bucket's agent had errored, the run would
  still complete with the other eight. Resilience by default.
- `.flatMap(r => r.verdicts)` flattens nine per-bucket arrays into one flat list of all 353 verdicts. This is
  plain JavaScript array work — the script *is* allowed to compute, just not to touch the filesystem.

**Line 107** — `log(...)` emits a narrator line to the user's progress view. It does not affect the run; it's for
human visibility ("Verified 353 escapes across 9 buckets"). Use `log` at the natural seams of the workflow so the
watcher understands what just happened.

> **Key learning #9 — between fan-out and synthesis, you do ordinary data work in plain JS.** Flattening,
> filtering, deduping, counting — these are not agent jobs. Spending an AI call to concatenate arrays would be
> waste. The script handles the mechanical glue; agents handle only the judgment.

> **Key learning #10 — `.filter(Boolean)` is the standard safety belt.** Because failed agents become `null`,
> filtering for truthiness before you use the results means one flaky agent can't sink the run. Build this in by
> habit.

---

## Segment 6 — Synthesis: the single convergent agent (lines 109–121)

```js
phase('Synthesize')
const report = await agent(
  `You are assembling the final type-escape sweep report …
   Here are all adversarially-verified verdicts (JSON):\n${JSON.stringify(allVerdicts)}\n\n
   Produce a single Markdown report with: 1. summary … 2. RANKED fix-list … 3. Clusters … 4. Highest-leverage …
   Output ONLY the Markdown. …`,
  { label: 'synthesize', phase: 'Synthesize' },
)
```

**Line 109** — `phase('Synthesize')` opens a new progress group. Unlike the inline `{phase: 'Find'}` options
used inside the pipeline, here it's called as a standalone statement because there's only one agent to file under
it. Either form works; the title still must match `meta.phases` (line 7).

**Lines 110–121** — a *single* `agent()` call, awaited directly. There is no `pipeline` or `parallel` here
because synthesis is **convergent** — its whole job is to see all 353 verdicts at once and produce one coherent
artifact. Fanning it out would defeat its purpose.
- **Line 112** — `JSON.stringify(allVerdicts)` pours the entire flattened verdict set into the prompt. The
  synthesizer's input *is* the combined output of all nine verifiers.
- **Lines 113–119** — the prompt enumerates the four required sections of the report (summary, ranked table,
  clusters, leverage list). Numbered, explicit instructions; the model fills them in.
- **Line 120** — note the options object has `label` and `phase` but **no `schema`**. This is the one agent whose
  output is meant for a *human* — flowing Markdown prose and tables — so a schema would only get in the way. Free
  text is the correct output type for a final report.

> **Key learning #11 — match topology to the shape of the work.** Divergent work (find every X, judge each
> independently) → fan out with `pipeline`/`parallel`. Convergent work (rank everything, find cross-cutting
> patterns) → a single agent that sees the whole set. Most real workflows are *divergent then convergent*: many
> agents produce, one agent integrates. This script is the canonical shape.

> **Key learning #12 — schema the machine-readable stages, free-text the human-readable one.** The finders and
> verifiers fed *the script*, so they were schema'd. The synthesizer feeds *you*, so it wasn't. Decide per agent:
> who consumes this output?

---

## Segment 7 — The return value (line 123)

```js
return { report, totalVerdicts: allVerdicts.length, buckets: results.filter(Boolean).length }
```

**Line 123** — whatever the script returns becomes the workflow's final result, delivered to the main
conversation when the background run completes. Here it returns the Markdown `report` plus two summary counts.
The main thread (me) then took `report` and wrote it to disk as `type-escape-sweep-report.md`.

> **Key learning #13 — the script's `return` is the hand-back to the main agent.** The workflow runs in the
> background; its return value is how its product re-enters the conversation. Return the finished artifact (and
> any metadata you want surfaced), then the main thread decides what to do with it — write a file, summarize,
> kick off a follow-up.

---

## The whole thing in one breath

Stripped to its skeleton, the entire 124-line script is:

```js
export const meta = { … }                       // 1. declare yourself (pure literal)
const BUCKETS = [ … ]                            // 2. define the work, balanced
const FINDINGS_SCHEMA = { … }                    // 3. contract the structured outputs
const VERDICTS_SCHEMA = { … }

const results = await pipeline(BUCKETS,          // 4. fan out: find → verify, per item, no barrier
  (b)        => agent(find,   {schema: FINDINGS_SCHEMA}),
  (found, b) => agent(verify, {schema: VERDICTS_SCHEMA}),
)
const all = results.filter(Boolean).flatMap(r => r.verdicts)   // 5. join in plain JS

const report = await agent(synthesize(all))      // 6. converge: one agent sees everything
return { report }                                // 7. hand back the artifact
```

Seven moves: **declare, define the work, contract the outputs, fan out, join, converge, return.** Almost every
"audit a large codebase / process many items / find-and-judge-and-rank" workflow you will ever write is a
variation on exactly this skeleton. Learn this one and you can read them all.

---

## The thirteen learnings, collected

1. `meta` must be a pure literal — the runtime parses it before running anything.
2. The data structure you fan out over (`BUCKETS`) is the most important design choice; spend your effort there.
3. The script is plain JavaScript — template literals, `.map`, `.filter`; no TypeScript, no imports.
4. Schemas turn an AI into a typed function — validated objects, automatic retries on malformed output.
5. Field `description`s inside a schema are micro-prompts, delivered where the value is generated.
6. A pipeline stage is a function whose signature is `(previousResult, originalItem, index)`.
7. Finder and verifier are separate agents with no shared memory — independence is the product.
8. You write a stage's logic once; the pipeline runs it N times, one agent per item.
9. Between fan-out and synthesis, do ordinary data work (flatten/filter/count) in plain JS, not in agents.
10. `.filter(Boolean)` is the standard safety belt — failed agents become `null`, not a crash.
11. Match topology to the work: divergent → fan out; convergent → a single agent.
12. Schema the stages that feed the script; free-text the stage that feeds the human.
13. The script's `return` value is how the background run hands its product back to the main conversation.

---

## Try it yourself

To convert this script into a *different* audit, you change three things and nothing else:

- **`BUCKETS`** — point `files` at your target codebase, re-balanced from a fresh pre-grep.
- **The finder prompt** — change "type-system escapes" and the `kind` enum to your target (dead code, SQL
  injection sinks, deprecated calls, missing error handling…).
- **The verifier rubric** — change what counts as NECESSARY vs REMOVABLE, but **keep the skeptic-default and the
  "show your work before you wave it through" requirement** — that's the part that makes the judgment trustworthy.

The topology — fan out with a pipeline, join in JS, converge in one agent — stays exactly as it is. That
skeleton is the transferable asset; the prompts and buckets are just today's subject matter.
