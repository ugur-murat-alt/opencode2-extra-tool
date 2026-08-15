import type { ToolDomain } from "@opencode-ai/plugin/promise/tool";

export type TodoItem = {
  content: string;
  status: string;
  priority: string;
};

export type TodoStore = {
  update: (sessionID: string, todos: TodoItem[]) => void;
  get: (sessionID: string) => TodoItem[];
};

export function createTodoStore(): TodoStore {
  const bySession = new Map<string, TodoItem[]>();
  return {
    update: (sessionID, todos) => {
      if (todos.length === 0) bySession.delete(sessionID);
      else bySession.set(sessionID, todos);
    },
    get: (sessionID) => bySession.get(sessionID) ?? [],
  };
}

export function parseTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) {
    throw new Error("todowrite input: todos must be an array");
  }
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`todowrite input: todos[${index}] must be an object`);
    }
    const { content, status, priority } = item as Record<string, unknown>;
    if (typeof content !== "string") {
      throw new Error(`todowrite input: todos[${index}].content must be a string`);
    }
    if (typeof status !== "string") {
      throw new Error(`todowrite input: todos[${index}].status must be a string`);
    }
    if (typeof priority !== "string") {
      throw new Error(`todowrite input: todos[${index}].priority must be a string`);
    }
    return { content, status, priority };
  });
}

export type TodoWriteToolFactory = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  options: { codemode: false; permission: string };
  execute: (
    rawInput: unknown,
    toolCtx: { sessionID: string },
  ) => Promise<{ output: { todos: TodoItem[] }; content: string }>;
};

export function todowriteToolFactory(store: TodoStore): TodoWriteToolFactory {
  return {
    name: "todowrite",
    description:
      "Create and maintain a structured task list for the current coding session. Use it to track progress during multi-step work and keep todo statuses current.",
    input: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "The updated todo list",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Brief description of the task" },
              status: {
                type: "string",
                description: "Current status of the task: pending, in_progress, completed, cancelled",
              },
              priority: { type: "string", description: "Priority level of the task: high, medium, low" },
            },
            required: ["content", "status", "priority"],
          },
        },
      },
      required: ["todos"],
    },
    output: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: { type: "object" },
        },
      },
      required: ["todos"],
    },
    options: { codemode: false, permission: "todowrite" },
    execute: async (rawInput, toolCtx) => {
      const input = (rawInput ?? {}) as Record<string, unknown>;
      const todos = parseTodos(input.todos);
      store.update(toolCtx.sessionID, todos);
      return { output: { todos }, content: JSON.stringify(todos, null, 2) };
    },
  };
}

export async function registerTodoWriteTool(ctx: { tool: ToolDomain }): Promise<void> {
  const store = createTodoStore();
  await ctx.tool.transform((tools) => {
    tools.add(todowriteToolFactory(store) as never);
  });
}
