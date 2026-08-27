import { describe, expect, test } from "bun:test";
import plugin from "../src/index";
import {
  addTaskFlowContext,
  createTaskFlowStore,
  parseTaskFlowPlan,
  registerTaskFlow,
  resumeIncompleteTaskFlow,
  taskFlowFinalReportOf,
  taskFlowHistorySnapshots,
  taskFlowSnapshot,
  taskFlowToolFactory,
  type TaskFlowPlan,
  type TaskFlowState,
} from "../src/taskflow";

const activePlan: TaskFlowPlan = {
  title: "Ship taskflow",
  objective: "Finish the full requested scope",
  acceptanceCriteria: ["All checks pass"],
  steps: [
    { id: "plan", content: "Define the plan", status: "completed" },
    { id: "review", content: "Review the result", status: "pending", agent: "reviewer" },
  ],
};

function memoryPersistence() {
  const values = new Map<string, unknown>();
  return {
    values,
    persistence: {
      read: async (sessionID: string) => values.get(sessionID),
      write: async (state: TaskFlowState) => {
        values.set(state.sessionID, structuredClone(state));
      },
    },
  };
}

describe("taskflow", () => {
  test("persists the full plan and isolates active state by session", async () => {
    const memory = memoryPersistence();
    const store = createTaskFlowStore(memory.persistence, () => 100);
    const tool = taskFlowToolFactory(store);

    const result = await tool.execute(activePlan, { sessionID: "session-a" });

    expect(result.output.plan).toEqual(activePlan);
    expect(result.output.snapshot.summary).toEqual({
      total: 2,
      pending: 1,
      inProgress: 0,
      completed: 1,
      cancelled: 0,
      completionRatio: 0.5,
    });
    expect(await store.get("session-a")).toMatchObject({ sessionID: "session-a", revision: 1, plan: activePlan });
    expect((await store.get("session-a"))?.change).toEqual({ kind: "initial", fields: [] });
    expect(result.content).not.toMatch(/revision|definition|progress/i);
    expect(JSON.stringify(result.output)).not.toMatch(/revision|change/i);
    expect((await store.get("session-a"))?.plan).toEqual(activePlan);
    expect(await store.get("session-b")).toBeUndefined();
  });

  test("hydrates durable state and keeps one continuation per revision across restarts", async () => {
    const memory = memoryPersistence();
    const first = createTaskFlowStore(memory.persistence, () => 100);
    await first.update("session-a", activePlan);
    const sent: Array<{ sessionID: string; revision: number }> = [];
    const send = async (sessionID: string, _text: string, revision: number) => {
      sent.push({ sessionID, revision });
    };

    const second = createTaskFlowStore(memory.persistence, () => 200);
    expect(await resumeIncompleteTaskFlow(second, "session-a", send)).toBe(true);
    const third = createTaskFlowStore(memory.persistence, () => 300);
    expect(await resumeIncompleteTaskFlow(third, "session-a", send)).toBe(false);
    expect(sent).toEqual([{ sessionID: "session-a", revision: 1 }]);
    expect((await third.get("session-a"))?.continuationCount).toBe(1);
    expect((await third.get("session-a"))?.history.every((item) => !("history" in item))).toBe(true);

    await third.update("session-a", activePlan);
    expect(await resumeIncompleteTaskFlow(third, "session-a", send)).toBe(true);
    expect(sent.at(-1)).toEqual({ sessionID: "session-a", revision: 2 });
  });

  test("keeps revision history in durable state without creating audit messages", async () => {
    const store = createTaskFlowStore();
    await store.update("session-a", activePlan);
    await store.update("session-a", {
      ...activePlan,
      steps: activePlan.steps.map((step) => ({ ...step, status: "completed" as const })),
    });

    const state = await store.get("session-a");
    expect(state).toBeDefined();
    expect(taskFlowHistorySnapshots(state!)).toHaveLength(2);
    expect(taskFlowHistorySnapshots(state!).map((item) => item.revision)).toEqual([2, 1]);
    expect(JSON.stringify(taskFlowHistorySnapshots(state!))).not.toContain("history");
  });

  test("records step transition timing and completion telemetry", async () => {
    const memory = memoryPersistence();
    let now = 100;
    const store = createTaskFlowStore(memory.persistence, () => now);
    await store.update("session-a", activePlan);
    now = 200;
    await store.update("session-a", {
      ...activePlan,
      steps: activePlan.steps.map((step) =>
        step.id === "review" ? { ...step, status: "in_progress" as const } : step,
      ),
    });
    expect((await store.get("session-a"))?.change).toEqual({
      kind: "progress",
      fields: ["step_status"],
    });
    now = 350;
    const completed = await store.update("session-a", {
      ...activePlan,
      steps: activePlan.steps.map((step) => ({ ...step, status: "completed" as const })),
    });

    expect(completed.stepTelemetry.review).toEqual({ startedAt: 200, completedAt: 350 });
    expect(completed.completedAt).toBe(350);
    expect(completed.change).toEqual({ kind: "progress", fields: ["step_status"] });
    expect(taskFlowSnapshot(completed).summary.completed).toBe(2);
  });

  test("classifies plan definition changes separately from progress", async () => {
    const store = createTaskFlowStore();
    await store.update("session-a", activePlan);
    const changed = await store.update("session-a", {
      ...activePlan,
      objective: "Finish the revised requested scope",
    });

    expect(changed.change).toEqual({ kind: "definition", fields: ["objective"] });
  });

  test("keeps definition and status causes when both change together", async () => {
    const store = createTaskFlowStore();
    await store.update("session-a", activePlan);
    const changed = await store.update("session-a", {
      ...activePlan,
      objective: "Finish the revised requested scope",
      steps: activePlan.steps.map((step) =>
        step.id === "review" ? { ...step, status: "in_progress" as const } : step,
      ),
    });

    expect(changed.change).toEqual({
      kind: "definition",
      fields: ["objective", "step_status"],
    });
  });

  test("stores a bounded final report only for the completed revision", async () => {
    const memory = memoryPersistence();
    const store = createTaskFlowStore(memory.persistence, () => 500);
    const incomplete = await store.update("session-a", activePlan);
    expect(
      await store.recordFinalReport("session-a", incomplete.revision, {
        createdAt: 400,
        text: "Too early",
      }),
    ).toEqual(incomplete);

    const complete = await store.update("session-a", {
      ...activePlan,
      steps: activePlan.steps.map((step) => ({ ...step, status: "completed" as const })),
    });
    const withReport = await store.recordFinalReport("session-a", complete.revision, {
      createdAt: 600,
      text: "## Delivered\n\nAll checks passed.",
    });

    expect(withReport?.finalReport).toEqual({
      revision: complete.revision,
      createdAt: 600,
      text: "## Delivered\n\nAll checks passed.",
    });
    const restarted = createTaskFlowStore(memory.persistence);
    expect((await restarted.get("session-a"))?.finalReport).toEqual(withReport?.finalReport);

    const unchanged = await restarted.update("session-a", {
      ...activePlan,
      steps: activePlan.steps.map((step) => ({ ...step, status: "completed" as const })),
    });
    expect(unchanged.change).toEqual({ kind: "unchanged", fields: [] });
    expect(unchanged.finalReport).toBeUndefined();
  });

  test("serializes concurrent updates so revisions stay unique", async () => {
    const memory = memoryPersistence();
    const store = createTaskFlowStore(memory.persistence, () => 100);
    const [first, second] = await Promise.all([
      store.update("session-a", activePlan),
      store.update("session-a", activePlan),
    ]);
    expect([first.revision, second.revision]).toEqual([1, 2]);
    expect((await store.get("session-a"))?.revision).toBe(2);
  });

  test("normalizes bounded text and uses a prototype-free telemetry index", async () => {
    const plan = parseTaskFlowPlan({
      title: "  Ship  ",
      objective: "  Finish  ",
      acceptanceCriteria: ["  Checks pass  "],
      steps: [{ id: "  __proto__  ", content: "  Review  ", status: "in_progress" }],
    });
    const store = createTaskFlowStore();
    const state = await store.update("session-a", plan);

    expect(plan).toEqual({
      title: "Ship",
      objective: "Finish",
      acceptanceCriteria: ["Checks pass"],
      steps: [{ id: "__proto__", content: "Review", status: "in_progress" }],
    });
    expect(Object.getPrototypeOf(state.stepTelemetry)).toBeNull();
    expect(state.stepTelemetry.__proto__).toEqual({ startedAt: expect.any(Number) });
    expect(() =>
      parseTaskFlowPlan({
        ...activePlan,
        steps: Array.from({ length: 201 }, (_, index) => ({
          id: String(index),
          content: "Step",
          status: "pending",
        })),
      }),
    ).toThrow("must not contain more than 200 items");
  });

  test("adds plan guidance without registering or injecting an agent", async () => {
    const store = createTaskFlowStore();
    await store.update("session-a", activePlan);
    const system: Array<{ type: "text"; text: string }> = [];
    const messages = [
      { metadata: { taskflow: "plan", revision: 1 } },
      { metadata: { taskflow: "report", revision: 1 } },
      { metadata: { taskflow: "continue", revision: 1 } },
      { metadata: { source: "user" } },
    ];

    await addTaskFlowContext(store, { sessionID: "session-a", system, messages });

    expect(system).toHaveLength(1);
    expect(system[0]?.text).toContain("reviewer");
    expect(system[0]?.text).toContain("remaining work");
    expect(system[0]?.text).not.toMatch(/revision|snapshot/i);
    expect(messages).toEqual([
      { metadata: { taskflow: "continue", revision: 1 } },
      { metadata: { source: "user" } },
    ]);
    const otherSystem: Array<{ type: "text"; text: string }> = [];
    await addTaskFlowContext(store, { sessionID: "session-b", system: otherSystem });
    expect(otherSystem).toEqual([]);
  });

  test("extracts the latest assistant text as the final report", () => {
    expect(
      taskFlowFinalReportOf(
        [
          {
            type: "assistant",
            time: { created: 101 },
            content: [
              { type: "reasoning", text: "private reasoning" },
              { type: "text", text: "Older answer" },
            ],
          },
          {
            type: "assistant",
            time: { created: 202 },
            content: [{ type: "text", text: "## Final report\nDone" }],
          },
        ],
        200,
      ),
    ).toEqual({ createdAt: 202, text: "## Final report\nDone" });
    expect(
      taskFlowFinalReportOf(
        {
          data: [
            {
              type: "assistant",
              time: { created: 101 },
              content: [{ type: "text", text: "Report from the context response" }],
            },
          ],
        },
        100,
      ),
    ).toEqual({ createdAt: 101, text: "Report from the context response" });
  });

  test("asks for a final report after the plan is complete", async () => {
    const store = createTaskFlowStore();
    await store.update("session-a", {
      ...activePlan,
      steps: activePlan.steps.map((step) => ({ ...step, status: "completed" as const })),
    });
    const system: Array<{ type: "text"; text: string }> = [];

    await addTaskFlowContext(store, { sessionID: "session-a", system });

    expect(system[0]?.text).toContain("final report");
    expect(system[0]?.text).toContain("actual work");
    expect(system[0]?.text).not.toMatch(/revision|snapshot|telemetry/i);
  });
});

describe("taskflow plugin integration", () => {
  test("registers taskflow with durable storage and a read-only backend", async () => {
    const tools: Array<{ name: string; execute?: Function }> = [];
    const contextHooks: Function[] = [];
    const synthetic: unknown[] = [];
    const storage = new Map<string, unknown>();
    let readBackend: ((sessionID: string) => Promise<unknown>) | undefined;
    let backendDisposed = false;
    let emitIdle = () => {};
    const idleEvent = new Promise<{ type: "session.idle"; data: { sessionID: string } }>((resolve) => {
      emitIdle = () => resolve({ type: "session.idle", data: { sessionID: "session-a" } });
    });
    let continuationSent = () => {};
    const continuation = new Promise<void>((resolve) => {
      continuationSent = resolve;
    });
    const context = {
      tool: {
        transform: async (transform: (draft: { add: (tool: unknown) => void }) => void) => {
          transform({ add: (tool) => tools.push(tool as (typeof tools)[number]) });
          return { dispose: async () => {} };
        },
      },
      storage: {
        get: async (key: string) => storage.get(key),
        set: async (key: string, value: unknown) => {
          storage.set(key, structuredClone(value));
        },
      },
      session: {
        hook: async (name: string, hook: Function) => {
          if (name === "context") contextHooks.push(hook);
          return { dispose: async () => {} };
        },
        synthetic: async (input: unknown) => {
          synthetic.push(input);
          if ((input as { resume?: boolean }).resume === true) continuationSent();
          return {};
        },
      },
      event: {
        subscribe: async function* () {
           yield {
             ...(await idleEvent),
             type: "session.execution.succeeded" as const,
           };
        },
      },
    } as unknown as Parameters<typeof registerTaskFlow>[0];

    expect(plugin.id).toBe("opencode2-extra-tool");
    const cleanup = await registerTaskFlow(context, {
      startBackend: async (read) => {
        readBackend = read;
        return { dispose: async () => { backendDisposed = true; } };
      },
    });
    const taskflow = tools.find((tool) => tool.name === "taskflow");
    expect(taskflow).toBeDefined();

    await taskflow?.execute?.(activePlan, { sessionID: "session-a" });
    expect(storage.size).toBe(1);
    expect(await readBackend?.("session-a")).toMatchObject({ revision: 1, plan: activePlan });
    expect(synthetic).toHaveLength(0);

    const system: Array<{ type: "text"; text: string }> = [];
    await contextHooks[0]?.({ sessionID: "session-a", system });
    expect(system[0]?.text).toContain("remaining work");

    emitIdle();
    await continuation;
    expect(synthetic[0]).toMatchObject({
      sessionID: "session-a",
      resume: true,
      metadata: { taskflow: "continue", revision: 1 },
    });

    await cleanup();
    expect(backendDisposed).toBe(true);
  });

  test("keeps the core tool available when the optional read-only backend fails", async () => {
    const tools: unknown[] = [];
    const originalError = console.error;
    console.error = () => undefined;
    const context = {
      tool: {
        transform: async (transform: (draft: { add: (tool: unknown) => void }) => void) => {
          transform({ add: (tool) => tools.push(tool) });
          return { dispose: async () => {} };
        },
      },
      storage: { get: async () => undefined, set: async () => undefined },
      session: {
        hook: async () => ({ dispose: async () => {} }),
        synthetic: async () => ({}),
      },
      event: {
        subscribe: async function* ({ signal }: { signal: AbortSignal }) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        },
      },
    } as unknown as Parameters<typeof registerTaskFlow>[0];
    try {
      const cleanup = await registerTaskFlow(context, {
        startBackend: async () => { throw new Error("no loopback"); },
      });
      expect(tools).toHaveLength(1);
      await cleanup();
    } finally {
      console.error = originalError;
    }
  });

  test("captures the latest assistant response when a plan becomes complete", async () => {
    const tools: Array<{ name: string; execute?: Function }> = [];
    const synthetic: unknown[] = [];
    const storage = new Map<string, unknown>();
    let emitIdle = () => {};
    const idleEvent = new Promise<{ type: "session.idle"; data: { sessionID: string } }>((resolve) => {
      emitIdle = () => resolve({ type: "session.idle", data: { sessionID: "session-a" } });
    });
    let reportCapturedResolve = () => {};
    const reportCaptured = new Promise<void>((resolve) => {
      reportCapturedResolve = resolve;
      const context = {
        tool: {
          transform: async (transform: (draft: { add: (tool: unknown) => void }) => void) => {
            transform({ add: (tool) => tools.push(tool as (typeof tools)[number]) });
            return { dispose: async () => {} };
          },
        },
        storage: {
          get: async (key: string) => storage.get(key),
          set: async (key: string, value: unknown) => {
            storage.set(key, structuredClone(value));
            if (
              value &&
              typeof value === "object" &&
              !Array.isArray(value) &&
              "finalReport" in value
            )
              reportCapturedResolve();
          },
        },
        session: {
          hook: async () => ({ dispose: async () => {} }),
          synthetic: async (input: unknown) => {
            synthetic.push(input);
            return {};
          },
          context: async () => {
            const state = storage.get("taskflow/session/session-a") as { createdAt: number };
            return [
              {
                type: "assistant",
                time: { created: Math.max(0, state.createdAt - 1) },
                content: [{ type: "text", text: "## Final report\nVerified." }],
              },
            ];
          },
        },
        event: {
          subscribe: async function* () {
           yield {
             ...(await idleEvent),
             type: "session.execution.succeeded" as const,
           };
          },
        },
      } as unknown as Parameters<typeof registerTaskFlow>[0];

      void (async () => {
        const cleanup = await registerTaskFlow(context);
        const tool = tools.find((item) => item.name === "taskflow");
        await tool?.execute?.(
          {
            ...activePlan,
            steps: activePlan.steps.map((step) => ({ ...step, status: "completed" })),
          },
          { sessionID: "session-a" },
        );
        emitIdle();
        await reportCaptured;
        expect(synthetic).toHaveLength(0);
        expect(
          (storage.get("taskflow/session/session-a") as TaskFlowState).finalReport?.text,
        ).toBe("## Final report\nVerified.");
        await cleanup();
      })().catch(() => undefined);
    });

    await reportCaptured;
  });
});
