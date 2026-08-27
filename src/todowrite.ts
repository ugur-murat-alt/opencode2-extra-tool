import type { ToolDomain } from "@opencode-ai/plugin/promise/tool";

const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
type TodoStatus = (typeof TODO_STATUSES)[number];

const TODO_PRIORITIES = ["high", "medium", "low"] as const;
type TodoPriority = (typeof TODO_PRIORITIES)[number];

const TODO_REMINDER_INTERVAL = 10;
const TODO_REMINDER = "TODO'yu unutma.";

export type TodoItem = {
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
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
    if (!TODO_STATUSES.includes(status as TodoStatus)) {
      throw new Error(
        `todowrite input: todos[${index}].status must be one of: ${TODO_STATUSES.join(", ")}`,
      );
    }
    if (typeof priority !== "string") {
      throw new Error(`todowrite input: todos[${index}].priority must be a string`);
    }
    if (!TODO_PRIORITIES.includes(priority as TodoPriority)) {
      throw new Error(
        `todowrite input: todos[${index}].priority must be one of: ${TODO_PRIORITIES.join(", ")}`,
      );
    }
    return {
      content,
      status: status as TodoStatus,
      priority: priority as TodoPriority,
    };
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
  const updatesBySession = new Map<string, number>();

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
                enum: TODO_STATUSES,
                description: "Current status of the task: pending, in_progress, completed, cancelled",
              },
              priority: {
                type: "string",
                enum: TODO_PRIORITIES,
                description: "Priority level of the task: high, medium, low",
              },
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
      const updateCount = (updatesBySession.get(toolCtx.sessionID) ?? 0) + 1;
      updatesBySession.set(toolCtx.sessionID, updateCount);
      const reminder = updateCount % TODO_REMINDER_INTERVAL === 0 ? `\n${TODO_REMINDER}` : "";
      return {
        output: { todos },
        content: `${JSON.stringify(todos, null, 2)}${reminder}`,
      };
    },
  };
}

export async function registerTodoWriteTool(ctx: { tool: ToolDomain }): Promise<() => Promise<void>> {
  const store = createTodoStore();
  const registration = await ctx.tool.transform((tools) => {
    tools.add(todowriteToolFactory(store) as never);
  });
  return () => registration.dispose();
}
