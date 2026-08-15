# opencode2-extra-tool

An OpenCode V2 plugin that provides the `todowrite` tool.

## Install

```jsonc
{
  "plugins": ["@vaur94/opencode2-extra-tool@0.1.0"]
}
```

`todowrite` replaces the current session's full structured task list. Its input is
`{ todos: [{ content, status, priority }] }`; an empty list clears it.
