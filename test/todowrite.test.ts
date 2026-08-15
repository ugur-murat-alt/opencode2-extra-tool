import { describe, expect, test } from "bun:test";
import { createTodoStore, parseTodos, todowriteToolFactory } from "../src/todowrite";

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
});

describe("todowrite", () => {
  test("stores todos per session and clears them with an empty list", async () => {
    const store = createTodoStore();
    const tool = todowriteToolFactory(store);
    const result = await tool.execute(
      { todos: [{ content: "first", status: "in_progress", priority: "high" }] },
      { sessionID: "session-a" },
    );
    expect(result.output.todos).toHaveLength(1);
    expect(store.get("session-a")).toHaveLength(1);

    const cleared = await tool.execute({ todos: [] }, { sessionID: "session-a" });
    expect(cleared.content).toBe("[]");
    expect(store.get("session-a")).toEqual([]);
  });

  test("uses the V1-compatible tool name and permission", () => {
    const tool = todowriteToolFactory(createTodoStore());
    expect(tool.name).toBe("todowrite");
    expect(tool.options).toEqual({ codemode: false, permission: "todowrite" });
  });
});
