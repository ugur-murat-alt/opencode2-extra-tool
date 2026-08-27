import { describe, expect, test } from "bun:test";
import {
  createTodoStore,
  parseTodos,
  registerTodoWriteTool,
  todowriteToolFactory,
  type TodoItem,
} from "../src/todowrite";

describe("parseTodos", () => {
  test("preserves values and removes unknown fields", () => {
    expect(
      parseTodos([{ content: "  first  ", status: "completed", priority: "high", extra: true }]),
    ).toEqual([{ content: "  first  ", status: "completed", priority: "high" }]);
  });

  test("rejects invalid input", () => {
    expect(() => parseTodos(undefined)).toThrow(/todos must be an array/);
    expect(() => parseTodos([null])).toThrow(/todos\[0\] must be an object/);
    expect(() => parseTodos([{ content: "x", status: "pending" }])).toThrow(/priority must be a string/);
  });

  test("rejects unsupported status and priority values", () => {
    expect(() =>
      parseTodos([{ content: "x", status: "blocked", priority: "high" }]),
    ).toThrow(/status must be one of/);
    expect(() =>
      parseTodos([{ content: "x", status: "pending", priority: "urgent" }]),
    ).toThrow(/priority must be one of/);
  });
});

describe("todowrite", () => {
  test("stores todos per session and clears them with an empty list", async () => {
    const store = createTodoStore();
    const tool = todowriteToolFactory(store);
    const sessionATodos: TodoItem[] = [{ content: "first", status: "in_progress", priority: "high" }];
    const sessionBTodos: TodoItem[] = [{ content: "second", status: "pending", priority: "low" }];
    const result = await tool.execute(
      { todos: sessionATodos },
      { sessionID: "session-a" },
    );
    expect(result.output.todos).toHaveLength(1);
    expect(store.get("session-a")).toEqual(sessionATodos);
    expect(store.get("session-b")).toEqual([]);

    await tool.execute({ todos: sessionBTodos }, { sessionID: "session-b" });
    expect(store.get("session-a")).toEqual(sessionATodos);
    expect(store.get("session-b")).toEqual(sessionBTodos);

    const cleared = await tool.execute({ todos: [] }, { sessionID: "session-a" });
    expect(cleared.content).toBe("[]");
    expect(store.get("session-a")).toEqual([]);
    expect(store.get("session-b")).toEqual(sessionBTodos);
  });

  test("reminds every tenth update independently for each session", async () => {
    const tool = todowriteToolFactory(createTodoStore());
    const input = { todos: [{ content: "step", status: "pending", priority: "low" }] };
    const reminder = "TODO'yu unutma.";
    const execute = (sessionID: string) => tool.execute(input, { sessionID });

    for (let step = 0; step < 9; step += 1) {
      expect((await execute("session-a")).content).not.toContain(reminder);
    }
    expect((await execute("session-b")).content).not.toContain(reminder);
    expect((await execute("session-a")).content).toContain(reminder);
    expect((await execute("session-a")).content).not.toContain(reminder);

    for (let step = 1; step < 9; step += 1) {
      expect((await execute("session-b")).content).not.toContain(reminder);
    }
    expect((await execute("session-b")).content).toContain(reminder);
  });

  test("uses the V1-compatible tool name and permission", () => {
    const tool = todowriteToolFactory(createTodoStore());
    expect(tool.name).toBe("todowrite");
    expect(tool.options).toEqual({ codemode: false, permission: "todowrite" });
  });

  test("advertises the supported status and priority values", () => {
    const tool = todowriteToolFactory(createTodoStore());
    expect(tool.input).toMatchObject({
      properties: {
        todos: {
          items: {
            properties: {
              status: { enum: ["pending", "in_progress", "completed", "cancelled"] },
              priority: { enum: ["high", "medium", "low"] },
            },
          },
        },
      },
    });
  });
});

describe("todowrite registration", () => {
  test("registers the todowrite tool", async () => {
    const added: unknown[] = [];
    const context = {
      tool: {
        transform: async (
          transform: (tools: { add: (tool: unknown) => void }) => void,
        ) => {
          transform({ add: (tool) => added.push(tool) });
          return { dispose: async () => {} };
        },
      },
    } as unknown as Parameters<typeof registerTodoWriteTool>[0];

    const cleanup = await registerTodoWriteTool(context);

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ name: "todowrite" });
    await cleanup();
  });
});
