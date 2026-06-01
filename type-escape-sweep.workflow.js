export const meta = {
  name: 'type-escape-sweep',
  description: 'Find every type-system escape in vibe/core/, adversarially verify each, output a ranked fix-list',
  phases: [
    { title: 'Find', detail: 'one finder per subsystem bucket — catalog every cast/ignore/Any/getattr' },
    { title: 'Verify', detail: 'adversarial skeptic per bucket — defaults REMOVABLE, must be argued to NECESSARY' },
    { title: 'Synthesize', detail: 'merge, cluster, rank into one fix-list' },
  ],
}

const ROOT = 'mistral-vibe-main/vibe/core'

// 9 subsystem buckets, balanced by escape count (counts from pre-grep)
const BUCKETS = [
  { key: 'llm-anthropic', files: [`${ROOT}/llm/backend/anthropic.py`, `${ROOT}/llm/backend/base.py`, `${ROOT}/llm/backend/vertex.py`] },
  { key: 'llm-other',     files: [`${ROOT}/llm/backend/openai_responses.py`, `${ROOT}/llm/backend/generic.py`, `${ROOT}/llm/backend/reasoning_adapter.py`, `${ROOT}/llm/backend/mistral.py`, `${ROOT}/llm/format.py`, `${ROOT}/llm/exceptions.py`] },
  { key: 'nuage-translator', files: [`${ROOT}/nuage/remote_workflow_event_translator.py`] },
  { key: 'nuage-rest',    files: [`${ROOT}/nuage/remote_workflow_event_models.py`, `${ROOT}/nuage/events.py`, `${ROOT}/nuage/streaming.py`, `${ROOT}/nuage/client.py`, `${ROOT}/nuage/agent_models.py`, `${ROOT}/nuage/remote_events_source.py`, `${ROOT}/nuage/workflow.py`] },
  { key: 'config',        files: [`${ROOT}/config/_settings.py`, `${ROOT}/config/layer.py`, `${ROOT}/config/builder.py`, `${ROOT}/config/layers/user.py`, `${ROOT}/config/layers/project.py`, `${ROOT}/config/layers/overrides.py`, `${ROOT}/config/orchestrator.py`, `${ROOT}/config/patch.py`] },
  { key: 'tools-mcp',     files: [`${ROOT}/tools/mcp/tools.py`, `${ROOT}/tools/connectors/connector_registry.py`, `${ROOT}/tools/mcp_sampling.py`, `${ROOT}/tools/mcp/registry.py`, `${ROOT}/tools/mcp_settings.py`] },
  { key: 'tools-core',    files: [`${ROOT}/tools/base.py`, `${ROOT}/tools/ui.py`, `${ROOT}/tools/manager.py`, `${ROOT}/tools/builtins/exit_plan_mode.py`, `${ROOT}/tools/builtins/ask_user_question.py`] },
  { key: 'core-top',      files: [`${ROOT}/types.py`, `${ROOT}/agent_loop.py`, `${ROOT}/tracing.py`, `${ROOT}/middleware.py`, `${ROOT}/logger.py`] },
  { key: 'misc',          files: [`${ROOT}/utils/merge.py`, `${ROOT}/utils/concurrency.py`, `${ROOT}/telemetry/send.py`, `${ROOT}/telemetry/build_metadata.py`, `${ROOT}/session/saved_sessions.py`, `${ROOT}/session/session_loader.py`, `${ROOT}/session/session_logger.py`, `${ROOT}/session/last_session_pointer.py`, `${ROOT}/skills/parser.py`, `${ROOT}/skills/models.py`, `${ROOT}/hooks/config.py`, `${ROOT}/agents/models.py`, `${ROOT}/experiments/__init__.py`, `${ROOT}/experiments/models.py`, `${ROOT}/audio_recorder/audio_recorder.py`, `${ROOT}/audio_player/audio_player.py`] },
]

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
          file: { type: 'string', description: 'path:line is enough but put path here' },
          line: { type: 'integer' },
          kind: { type: 'string', enum: ['cast', 'type-ignore', 'pyright-ignore', 'Any', 'getattr', 'other'] },
          snippet: { type: 'string', description: 'the offending line, trimmed' },
          context: { type: 'string', description: '1-2 sentences: what the surrounding code is doing and why the escape is there' },
        },
      },
    },
  },
}

const VERDICTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'kind', 'verdict', 'confidence', 'rationale'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          kind: { type: 'string' },
          verdict: { type: 'string', enum: ['REMOVABLE', 'NECESSARY'] },
          confidence: { type: 'number', description: '0..1 confidence in the verdict' },
          proposedRetype: { type: 'string', description: 'for REMOVABLE: the concrete re-typing (Protocol/generic/overload/precise annotation). for NECESSARY: the concrete reason it cannot be re-typed.' },
          rationale: { type: 'string', description: 'one-line justification' },
        },
      },
    },
  },
}

const results = await pipeline(
  BUCKETS,
  // STAGE 1 — finder
  (b) => agent(
    `You are cataloguing type-system escapes in a Pyright-strict Python codebase (Mistral Vibe).\n` +
    `Read EACH of these files in full and find EVERY type-system escape:\n${b.files.map(f => '  - ' + f).join('\n')}\n\n` +
    `Escape kinds to catch:\n` +
    `  - cast(...)            (kind: cast)\n` +
    `  - # type: ignore[...]  (kind: type-ignore)\n` +
    `  - # pyright: ignore    (kind: pyright-ignore)\n` +
    `  - Any annotations: ": Any", "-> Any", "Any]", "Any,", "Dict[str, Any]" etc (kind: Any)\n` +
    `  - getattr(x, "name", default)  — the 3-arg attribute-typing bypass only, NOT 2-arg (kind: getattr)\n` +
    `  - other type-erasure tricks: "# type: ignore"-via-comment casts, TYPE_CHECKING-gated lies (kind: other)\n\n` +
    `Use Grep to locate then Read to confirm each with surrounding context. Report the real 1-based line number. ` +
    `For each escape capture what the surrounding code is doing. Do NOT verify/judge yet — just catalog completely. Miss nothing.`,
    { label: `find:${b.key}`, phase: 'Find', schema: FINDINGS_SCHEMA },
  ),
  // STAGE 2 — adversarial skeptic
  (found, b) => agent(
    `You are a SKEPTICAL senior typing engineer reviewing type-system escapes in Mistral Vibe (Pyright strict).\n` +
    `Your DEFAULT verdict is REMOVABLE. An escape is guilty until proven innocent — you must be ARGUED into "NECESSARY".\n` +
    `An escape is only NECESSARY if you can name a concrete, unavoidable reason: genuinely runtime-only/dynamic type, ` +
    `a third-party UNTYPED boundary, unavoidable (de)serialization of unknown shape, or a Python typing limitation with no overload/Protocol/generic/TypeVar/TypedDict workaround.\n` +
    `Before ruling NECESSARY you MUST sketch the re-typing you tried and explain precisely why it fails. ` +
    `If a precise annotation, Protocol, generic, overload, TypedDict, or narrowing would work, the verdict is REMOVABLE and you give the concrete re-type.\n\n` +
    `Re-open the files yourself (Read) to judge in real context — do not trust the snippet alone. Files: ${b.files.join(', ')}.\n\n` +
    `Here are the catalogued escapes to judge (JSON):\n${JSON.stringify(found.escapes)}\n\n` +
    `Return a verdict for EVERY escape with a confidence and a one-line rationale.`,
    { label: `verify:${b.key}`, phase: 'Verify', schema: VERDICTS_SCHEMA },
  ),
).then(rs => rs)

const allVerdicts = results.filter(Boolean).flatMap(r => r.verdicts)
log(`Verified ${allVerdicts.length} escapes across ${results.filter(Boolean).length} buckets`)

phase('Synthesize')
const report = await agent(
  `You are assembling the final type-escape sweep report for Mistral Vibe's vibe/core/.\n` +
  `Here are all adversarially-verified verdicts (JSON):\n${JSON.stringify(allVerdicts)}\n\n` +
  `Produce a single Markdown report with:\n` +
  `1. A one-paragraph summary: total escapes, #REMOVABLE vs #NECESSARY, by kind.\n` +
  `2. A RANKED fix-list table, highest-confidence-REMOVABLE first, then lower-confidence REMOVABLE, then NECESSARY last. ` +
  `Columns: \`file:line\` | kind | verdict | proposed re-type / justification.\n` +
  `3. A "Clusters" section: group escapes sharing one root cause (e.g. same untyped dependency, same serialization boundary, same missing Protocol) so they can be fixed in one stroke. Name each cluster, list its members, and the single fix.\n` +
  `4. A short "Highest-leverage fixes" list: the 5 changes that eliminate the most escapes.\n` +
  `Output ONLY the Markdown. Be precise with file:line. Do not propose editing code beyond describing the re-type.`,
  { label: 'synthesize', phase: 'Synthesize' },
)

return { report, totalVerdicts: allVerdicts.length, buckets: results.filter(Boolean).length }
