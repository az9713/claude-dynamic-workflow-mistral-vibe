# Workflow: Type-Escape Sweep

> A Claude Code dynamic-workflow design for the Mistral Vibe codebase.
> Status: **designed, not yet run.** This is workflow idea #2 of six (see `mistral-vibe-main/CLAUDE.md:151`).
> Audience: assumes **no prior experience** with type checkers, Pyright, or multi-agent workflows. Everything is explained from the ground up.

---

## 1. The one-sentence version

Find every place in the Vibe codebase where the code *tells the type checker to stop checking* — then have independent AI agents try to prove each of those spots is actually a hidden bug waiting to happen.

If that sentence has three words you're unsure about ("type checker", "stop checking", "hidden bug"), the next section explains all of them.

---

## 2. Background: what a type checker is, and why "escapes" matter

### 2.1 What is a type?

In Python, every value has a *type*: `5` is an `int`, `"hi"` is a `str`, `[1,2]` is a `list[int]`. A type is a promise about what a value is and what you can do with it. You can add two `int`s; you cannot call `.upper()` on an `int` (only `str` has `.upper()`).

### 2.2 What is a type checker?

Normally Python only discovers a type mistake when the code *runs* — and only if that exact line happens to execute. So a bug like calling `.upper()` on a number might sit silently in a rarely-used branch for months, then crash in production.

A **type checker** is a separate program that reads your code *without running it* and flags these mistakes ahead of time. **Pyright** is the type checker Vibe uses (Microsoft's; it's what powers Python support in VS Code). Vibe runs it in **"strict" mode**, the most aggressive setting, and it **gates CI** — meaning: if Pyright finds a type problem, the automated checks fail and the code can't be merged.

You can see this is real in the repo:

- `pyproject.toml:160` — `pyright>=1.1.403` is a required dev dependency.
- `pyproject.toml:186` — `[tool.pyright]` configuration block.
- `AGENTS.md:13` — `uv run pyright — strict type check.`
- `AGENTS.md:41` — *"Pyright is strict and gates CI; fix types at the source."*

So in this codebase, passing Pyright is not optional. That sounds airtight. It isn't — and that gap is the entire reason this workflow exists.

### 2.3 What is a "type escape"?

Sometimes a developer knows something the type checker can't figure out. Maybe the value really is a `str`, but Pyright can only see that it *might* be `str | None`. To keep the code mergeable, the developer reaches for an **escape hatch**: a piece of syntax that says *"trust me, stop checking here."*

That is a **type escape**. The danger is simple and worth stating plainly:

> An escape silences the checker. If the developer's belief is **wrong**, Pyright will **not** catch it — and you're back to the original problem: a crash that only appears at runtime, in production, possibly months later.

Every escape is therefore a small, deliberate hole in the safety net. Most are fine. Some are wrong. The sweep finds them all and sorts the fine ones from the wrong ones.

---

## 3. The four escape hatches the sweep hunts for

Vibe's own contributor rules (`AGENTS.md:43`) draw a sharp line:

> *"No inline `# type: ignore` or `# noqa`. Fix with refined signatures (TypeVar, Protocol), `isinstance` guards, `typing.cast` when control flow guarantees the type, or a small typed wrapper at the boundary."*

So the project **bans** the bluntest escape (`# type: ignore`) but **explicitly sanctions** `cast`. That makes `cast` the most interesting target: it's *allowed*, so it's everywhere, and each use is an unverified human promise. Here are the four patterns, from most to least dangerous.

### 3.1 `typing.cast(T, x)` — the unchecked assertion

```python
from typing import cast
value = cast(str, raw_input)   # "Pyright, treat raw_input as a str. Trust me."
```

`cast` does **nothing at runtime** — it doesn't convert, validate, or check anything. It only changes what Pyright *believes*. If `raw_input` is actually `None`, the code sails past the type checker and crashes later on `value.upper()`. This is the highest-value target precisely because it's sanctioned and silent.

### 3.2 `# type: ignore` — "skip this whole line"

```python
result = some_function(a, b)  # type: ignore
```

Tells Pyright to ignore *all* errors on that line. Blunter than `cast` because it suppresses *everything*, including unrelated mistakes. Vibe **bans** these — so any that the sweep finds are either rule violations that slipped through, or live in code Pyright doesn't check (tests, scripts). Both are worth surfacing.

### 3.3 `Any` — "could be literally anything"

```python
def handle(payload: Any) -> Any: ...
```

`Any` is the type that's compatible with everything. The moment a value becomes `Any`, type checking effectively *switches off* for it and everything downstream — Pyright stops complaining because `Any` can do anything. It spreads quietly: one `Any` parameter can disable checking across a whole call chain. Note: not every `Any` is bad (some boundaries genuinely are dynamic), which is exactly why a human-or-agent judgment step is needed rather than a blanket ban.

### 3.4 `getattr(x, "field", default)` — the stringly-typed dodge

```python
name = getattr(obj, "name", "unknown")
```

Looking up an attribute by a **string name** is invisible to Pyright — it can't verify that `obj` has a `name` attribute, nor what type it returns. The `default` value makes it worse: it papers over the case where the attribute is missing, so a typo (`"naem"`) silently returns `"unknown"` forever instead of erroring. A frequent source of "why is this field always empty?" bugs.

---

## 4. Why a "sweep", and why "adversarial"

Two design choices in the name need justifying.

**"Sweep"** = exhaustive coverage, not sampling. A normal grep finds the *lines*, but a line of text doesn't tell you whether the escape is *safe*. Judging safety requires reading the surrounding function, understanding what guarantees the control flow actually provides, and checking the assumption against reality. That's a reading task per hit, and there are hundreds of hits — too many for one pass of attention. So the work is fanned out across many agents working in parallel.

**"Adversarial"** = each suspect escape is handed to an agent whose *job is to break it*, not to bless it. This matters because of a well-known failure mode: if you ask "is this code okay?", an AI tends to find reasons it's okay (confirmation bias). If you instead ask "**prove this `cast` can receive the wrong type — find the input that breaks it**", you get a genuinely critical read. The agent defaults to "this is a real bug" and must be *forced off that position by evidence*. Only escapes that survive a determined attempt to break them are marked safe.

This is why CLAUDE.md (`:156`) calls this idea *"the best showcase of Opus 4.8's improved honesty"* — the whole technique depends on the verifier being willing to say "yes, this one is genuinely broken" rather than reflexively reassuring.

---

## 5. How the workflow is shaped

A Claude Code **dynamic workflow** is a small script that orchestrates many AI sub-agents deterministically — it decides what runs in parallel, what waits, and how results combine. You don't write the agents' reasoning; you write the *control flow*. Here is the shape for this sweep:

```
        ┌─────────────────────────────────────────────────────┐
        │ PHASE 1 — FIND  (parallel finders, one lens each)    │
        │   finder A: all `cast(...)`        → list of hits    │
        │   finder B: all `# type: ignore`   → list of hits    │
        │   finder C: all `: Any` signatures → list of hits    │
        │   finder D: all `getattr(x,"f",d)` → list of hits    │
        └─────────────────────────────────────────────────────┘
                              │  (barrier: wait for all four)
                              ▼
        ┌─────────────────────────────────────────────────────┐
        │ DEDUP  — merge the four lists, drop duplicates,       │
        │          group by file (plain code, no agent)         │
        └─────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────────────────┐
        │ PHASE 2 — VERIFY  (one adversarial agent per hit)     │
        │   "Try to prove this escape receives a wrong type.    │
        │    Find a concrete input that breaks it. Default to   │
        │    REAL-BUG unless you can show it's guaranteed safe." │
        │   → verdict: {real | safe}, reasoning, breaking input │
        └─────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────────────────┐
        │ PHASE 3 — SYNTHESIZE  → one ranked report             │
        │   confirmed real bugs first, with file:line + fix     │
        └─────────────────────────────────────────────────────┘
```

Key mechanics, in plain terms:

- **Phase 1 uses a *barrier*** (wait for all four finders) because the dedup step genuinely needs *all* hits at once — the same line can match two patterns (e.g. a `cast` involving `Any`) and you only want to verify it once.
- **Phase 2 fans out**: each surviving hit gets its own agent, running many at a time (the harness caps concurrency at roughly a dozen and queues the rest). One slow hit doesn't block the others.
- **The verifier returns *structured output*** — a fixed JSON shape `{verdict, reasoning, breaking_input, suggested_fix}` — so Phase 3 can sort and rank mechanically instead of re-reading prose.
- **Optional hardening**: spawn *three* verifiers per hit and take a majority vote. A bug only counts as "real" if at least two of three independent agents can break it. This kills plausible-but-wrong findings.

---

## 6. What this looks like on the real codebase

A quick scan of `mistral-vibe-main/vibe/` (combining all four patterns) found **~238 occurrences across 70 files**. That's the raw surface *before* filtering — many will be legitimate. The hotspots, where the sweep would concentrate:

| File | Hits | Why it's a hotspot |
|---|---:|---|
| `vibe/core/nuage/remote_workflow_event_translator.py` | 31 | Translates external event payloads — a classic boundary where data arrives untyped and gets `cast`. |
| `vibe/cli/textual_ui/app.py` | 28 | UI framework (Textual) glue; framework objects are often loosely typed. |
| `vibe/core/types.py` | 13 | The shared type definitions themselves. |
| `vibe/core/tools/base.py` | 10 | Tool base class — generic machinery, prone to `Any`. |
| `vibe/core/tools/ui.py` | 9 | UI tool surface. |
| `vibe/core/config/_settings.py` | 9 | Config parsing — untyped TOML/dict input. |
| `vibe/core/utils/merge.py` | 8 | Generic dict-merging utility — inherently `Any`-ish. |

**Reading the pattern:** the escapes cluster at **boundaries** — where data enters from outside (network events, TOML config, the UI framework). That is exactly where they're both most *necessary* (the outside world is genuinely untyped) and most *dangerous* (the outside world is where wrong assumptions actually bite). A sweep result that simply confirms "escapes live at boundaries, and here are the three that don't hold" is already a useful map.

> Caveat on the count: the `: Any` and `getattr(` patterns catch many *legitimate* uses. The 238 figure is the work-list *to triage*, not a bug count. The verify phase is what separates the two — expect the confirmed-real list to be a small fraction.

---

## 7. How to run it

Per `CLAUDE.md:162`, dynamic workflows in this environment are triggered by **including the word `workflow` in your prompt** and describing the task. The flow:

1. In a Claude Code session in this directory, prompt something like:
   *"Run a **workflow** that sweeps the Vibe codebase for type escapes (`cast`, `# type: ignore`, `Any`, `getattr` defaults) and adversarially verifies each one."*
2. Claude writes the workflow script and shows it to you. **Approve it to run.** (Nothing executes without your approval.)
3. Watch live progress with the `/workflows` command.
4. After a successful run, press `s` in `/workflows` to **save it as a reusable `/<name>` command** so you can re-run it later without rewriting the script.

You stay in the loop: you approve the script before it runs, and you read the final report.

---

## 8. What you get out of it

A single ranked report, confirmed bugs first. Each entry:

- **`file:line`** — clickable location of the escape.
- **Pattern** — which of the four it is.
- **Verdict** — `real` or `safe`, with the vote tally if majority-voting was used.
- **Reasoning** — *why* it's broken or safe, in one or two sentences.
- **Breaking input** (for real bugs) — a concrete value that slips through the escape and causes a wrong result or crash.
- **Suggested fix** — usually one of the four sanctioned remedies from `AGENTS.md:43`: a refined signature (`TypeVar`/`Protocol`), an `isinstance` guard, a narrower `cast`, or a typed wrapper at the boundary.

---

## 9. What this workflow is NOT

- **Not a linter run.** Ruff and Pyright already pass on this code by definition (CI gates them). This sweep targets exactly the holes that Pyright *cannot* see *because* an escape told it not to look.
- **Not a refactor.** It produces a report and suggested fixes; it doesn't rewrite the codebase. (You could chain a fix phase, but that's a separate decision.)
- **Not a verdict on code quality.** Most escapes are legitimate engineering at real boundaries. The output is "here are the few that don't hold," not "escapes are bad."
- **Not related to Vibe's own internal "workflow" code.** Note the name collision: `vibe/core/nuage/remote_workflow_event_translator.py` is *Vibe's* feature called "workflow," and it also happens to be the top escape hotspot. The *Claude Code* workflow described here is the orchestration tool doing the sweeping. Two different "workflows." (`CLAUDE.md:178` flags this same naming trap.)

---

## Appendix: glossary

| Term | Plain meaning |
|---|---|
| **Type** | A promise about what a value is (`int`, `str`, …) and what you can do with it. |
| **Type checker** | A program (here: **Pyright**) that reads code without running it and flags type mistakes early. |
| **Strict mode** | Pyright's most aggressive setting; the more it checks, the more developers reach for escapes. |
| **Gates CI** | If the check fails, the code can't be merged. |
| **Type escape / escape hatch** | Syntax that tells the checker to stop checking here (`cast`, `# type: ignore`, `Any`, `getattr`). |
| **`cast(T, x)`** | An *unchecked* assertion: changes what the checker believes, does nothing at runtime. |
| **`Any`** | The "anything goes" type; turns checking *off* for whatever it touches. |
| **Boundary** | Where data enters from outside (network, config files, UI framework) — untyped by nature. |
| **Fan-out** | Splitting work across many agents running in parallel. |
| **Barrier** | A wait-point: don't proceed until *all* parallel tasks finish. |
| **Adversarial verification** | An agent whose job is to *break* a claim, not confirm it — defaults to "broken" until proven safe. |
| **Structured output** | Forcing an agent to answer in a fixed data shape (JSON) so results can be sorted by code. |

---

*Sources in this repo: `mistral-vibe-main/CLAUDE.md:151-160` (the six workflow ideas), `AGENTS.md:13,41-43` (Pyright policy and sanctioned fixes), `pyproject.toml:160,186` (Pyright config). The companion memory file `project-workflow-ideas.md` referenced by CLAUDE.md does not currently exist — only the six titles in CLAUDE.md survive.*
