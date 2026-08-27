# opencode2-extra-tool

An OpenCode V2 plugin that provides the `todowrite` and `taskflow` tools.

## Install

```jsonc
{
  "plugins": ["@vaur94/opencode2-extra-tool@0.2.1"]
}
```

`todowrite` replaces the current session's full structured task list. Its input is
`{ todos: [{ content, status, priority }] }`; an empty list clears it.

## Taskflow

`taskflow` stores a full, session-scoped task plan with an objective, acceptance
criteria, and ordered steps. The current state, durable revision history, step
transition times, and continuation counters use OpenCode's plugin storage. Plan
and report history is kept out of the model conversation, so bookkeeping does not
create extra assistant turns or distract the agent. When an incomplete session
becomes idle, the plugin queues one continuation message for that plan revision
so the agent can resume the remaining steps.

A step may name an existing agent. The plugin only records that assignment and
instructs the active agent to use OpenCode's existing delegation flow; it never
registers or injects an additional agent.

Plan snapshots classify updates as initial, progress, definition, or unchanged;
definition changes identify the affected title, objective, acceptance criteria,
step structure/content, agent assignment, and step status fields. Once all steps
are complete, the latest assistant response is stored as a bounded final report
for that revision and is included in the read-only snapshot.

Current plans and per-revision continuation markers are restored after an
OpenCode service restart. The plugin also publishes a token-protected, read-only
loopback endpoint discovered through
`${XDG_STATE_HOME:-~/.local/state}/opencode2-extra-tool/taskflow-backend.json`.
This endpoint is intended for a local bridge such as `opencode2-web`; it is not
exposed directly to browsers.
