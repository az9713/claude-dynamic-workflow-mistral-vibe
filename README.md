# Claude Code Dynamic Workflow — Type-Escape Sweep

A worked example of a **Claude Code dynamic workflow**: a real multi-agent run against the
[Mistral Vibe](https://github.com/mistralai/mistral-vibe) codebase, captured end to end — the script, the
design reasoning, a line-by-line code reading, the findings it produced, and a screen recording of the run.

> **The codebase audited here** is Mistral Vibe. A learning-oriented fork with a 6-phase deep-dive guide to
> the Vibe agent harness lives at [**az9713/mistral-vibe-tutorial**](https://github.com/az9713/mistral-vibe-tutorial) —
> this repo is its companion, focused on the dynamic-workflow run.

## Watch the run

A **4×-speed** recording (~4:48 — the actual run took about 25 minutes) is included in this repo as
[`claude_code_workflow_mistral_vibe_web_4x.mp4`](./claude_code_workflow_mistral_vibe_web_4x.mp4).

The player embedded below is the full-length capture at normal speed:

https://github.com/user-attachments/assets/d1ef7fea-9c9b-4d7b-b0e7-ab47a49583a4

## What a "type-escape sweep" is

Mistral Vibe is checked by **Pyright in strict mode** — a type checker that, before the code ever runs,
verifies that values are used consistently with their declared types and flags mismatches as errors. A
**type escape** is any spot where the code deliberately *tells the checker to stop checking*: a `cast(...)`
(assert a type without proof), a `# type: ignore` / `# pyright: ignore` (silence an error), an `Any`
annotation (opt out entirely), or a 3-arg `getattr(x, "name", default)` (look an attribute up by string,
invisibly to the checker). Each escape is a small blind spot — sometimes unavoidable, often a latent bug.

A **sweep** is an *exhaustive* audit of all of them: find every escape, and for each one judge whether it is
genuinely necessary or could be re-typed properly. "Sweep" means coverage, not sampling — a `grep` finds the
*lines*, but deciding whether each line is *safe* requires reading the surrounding code, which is a judgment
task repeated hundreds of times.

## The goal

Audit every place in `vibe/core/` where the code tells the type checker to stop checking — each `cast(...)`,
`# type: ignore`, `Any` annotation, `# pyright: ignore`, and 3-arg `getattr(...)` — and decide, for each one,
whether it is **genuinely necessary** or **removable** (could be re-typed properly). Output a single ranked
fix-list. Read-only: the workflow reports, it does not edit code.

## What a dynamic workflow is

A dynamic workflow is a **deterministic JavaScript script that orchestrates many independent AI subagents**.
The script controls the loops, fan-out, and ordering (real code, not model improvisation); each *subagent* is a
separate Claude instance with its own fresh context and its own tools. The script never reads a file or runs a
command itself — it only decides who runs, in what order, with what instructions, and what to do with their
structured answers. This keeps control flow reliable, keeps the main conversation's context clean, and makes
the agents' independence *structural* (a verifier genuinely cannot see the finding it's checking).

## Why a workflow is the right shape for this sweep

A sweep is not one task — it is *hundreds of small, near-identical judgment tasks* plus a final
consolidation. That profile matches a dynamic workflow almost exactly, on four counts:

- **Volume + breadth.** There were ~370 escapes across ~56 files. A single agent reading all of that
  sequentially would exhaust its context window and start *summarizing* instead of cataloguing — coverage
  would silently degrade. Fanning the reading across nine agents keeps each one's working set small and sharp.
- **The judgment must be independent to be trustworthy.** The check is *adversarial*: a skeptic tries to prove
  each escape is removable. That only means something if the skeptic did **not** produce the finding it is
  judging. Subagents have separate context by construction, so the finder/verifier split is real, not
  cosmetic — exactly what a plain script or a single agent cannot give you.
- **The items are independent of each other.** Judging a `cast` in one file needs nothing from the judgment of
  a `cast` in another. Independent items are the textbook case for fanning out in parallel.
- **It still needs a single convergent finish.** Ranking everything and spotting cross-file clusters requires
  one mind that sees *all* the verdicts at once. A workflow expresses this "many produce, one integrates" shape
  directly: parallel fan-out for find+verify, then a single synthesis agent.

A plain `grep` gives you the lines but no judgment. A single chat turn gives you judgment but drowns in volume
and can't be adversarial with itself. The workflow is the shape that gives you *exhaustive coverage,
independent judgment, and a consolidated result* at once — which is why this sweep is run as one.

## Phases and agents

The run used **3 phases and 19 agents**, in a *divergent-then-convergent* shape:

| Phase | Agents | What each agent did |
|---|---|---|
| **1. Find** | 9 finders (one per subsystem "bucket") | Read its assigned files and catalogue *every* type escape with `file:line`, kind, and surrounding context. No judgment. |
| **2. Verify** | 9 adversarial skeptics (one per bucket) | Re-open the files *cold* and rule each escape REMOVABLE or NECESSARY. Default verdict is REMOVABLE — the escape is "guilty until proven innocent" and the skeptic must sketch a concrete re-typing before it's allowed to call one NECESSARY. |
| **3. Synthesize** | 1 synthesizer | See all verdicts at once; produce one ranked fix-list, group escapes by shared root cause into clusters, and name the highest-leverage fixes. |

The 9 buckets were **balanced by escape count** (from a pre-run grep), not by file count — so the one file with
~51 escapes got its own agent, while 16 small files were swept into a single "misc" bucket. Find and Verify run
as a **pipeline** (no barrier between them): the moment a bucket's finder finishes, its verifier starts, even
while heavier buckets are still being catalogued.

## The run, by the numbers

- **~25 minutes** wall-clock, fully in the background.
- **~4% of one week's Claude Code usage.**
- **19 agents** · **353 escapes verified** · **272 REMOVABLE (77%) / 81 NECESSARY (23%)** · ~1.43M subagent tokens.

## Files in this repo

| File | What it is |
|---|---|
| [`workflow-type-escape-sweep.md`](./workflow-type-escape-sweep.md) | The idea explained from scratch (pre-run design; assumes no prior knowledge of type checkers or workflows). |
| [`type-escape-sweep.workflow.js`](./type-escape-sweep.workflow.js) | The actual runnable workflow script (124 lines). |
| [`type-escape-sweep-script-explained.md`](./type-escape-sweep-script-explained.md) | That script, dissected line by line, with 13 transferable learnings. |
| [`type-escape-sweep-workflow-writeup.md`](./type-escape-sweep-workflow-writeup.md) | The design decisions: why 3 phases, why 9+9+1 agents, why a pipeline. |
| [`type-escape-sweep-report.md`](./type-escape-sweep-report.md) | The findings: all 353 escapes, tiered and clustered, with proposed re-types. |
| `claude_code_workflow_mistral_vibe_web_4x.mp4` | Screen recording of the run, **sped up 4×** (6.5 MB, 720p, no audio; ~4:48 — the run itself was ~25 min). |

## Suggested reading order

1. **`workflow-type-escape-sweep.md`** — what the sweep is and why, from the ground up.
2. **`type-escape-sweep.workflow.js`** — skim the script.
3. **`type-escape-sweep-script-explained.md`** — the same script, explained line by line.
4. **`type-escape-sweep-workflow-writeup.md`** — the reasoning behind every structural choice.
5. **`type-escape-sweep-report.md`** — what it found.

> **Note:** the screen recording here is compressed **and sped up 4×** (`_web_4x.mp4`, 6.5 MB, 720p, no
> audio). The original full-length 1.5 GB capture is not tracked — it exceeds GitHub's 100 MiB limit.
