import type { Context as PluginContext } from "@opencode-ai/plugin/promise/plugin";
import { startTaskFlowBackend, type TaskFlowBackend } from "./taskflow-backend";

const TASKFLOW_STATUSES = ["pending", "in_progress", "completed", "blocked", "cancelled"] as const;
type TaskFlowStatus = (typeof TASKFLOW_STATUSES)[number];
const TASKFLOW_STATE_VERSION = 1 as const;
const TASKFLOW_STORAGE_PREFIX = "taskflow/session/";
const TASKFLOW_LIMITS = {
  title: 500,
  objective: 20_000,
  acceptanceCriteria: 100,
  acceptanceCriterion: 2_000,
  steps: 200,
  stepID: 256,
  stepContent: 5_000,
  agent: 256,
  finalReport: 20_000,
  continuation: 12_000,
} as const;
const TASKFLOW_HISTORY_LIMIT = 200;

const TASKFLOW_CHANGE_KINDS = ["initial", "progress", "definition", "unchanged"] as const;
const TASKFLOW_CHANGE_FIELDS = [
  "title",
  "objective",
  "acceptance_criteria",
  "step_structure",
  "step_content",
  "agent_assignment",
  "step_status",
] as const;
export type TaskFlowChangeKind = (typeof TASKFLOW_CHANGE_KINDS)[number];
export type TaskFlowChangeField = (typeof TASKFLOW_CHANGE_FIELDS)[number];
export type TaskFlowChange = {
  kind: TaskFlowChangeKind;
  fields: TaskFlowChangeField[];
};
export type TaskFlowFinalReport = {
  revision: number;
  createdAt: number;
  text: string;
};

export type TaskFlowStep = {
  id: string;
  content: string;
  status: TaskFlowStatus;
  agent?: string;
};

export type TaskFlowPlan = {
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  steps: TaskFlowStep[];
};

export type TaskFlowStepTelemetry = {
  startedAt?: number;
  completedAt?: number;
  blockedAt?: number;
  cancelledAt?: number;
};

export type TaskFlowRevision = {
  version: typeof TASKFLOW_STATE_VERSION;
  sessionID: string;
  plan: TaskFlowPlan;
  revision: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  resumedRevision?: number;
  continuationCount: number;
  lastContinuationAt?: number;
  stepTelemetry: Record<string, TaskFlowStepTelemetry>;
  change?: TaskFlowChange;
  finalReport?: TaskFlowFinalReport;
};

export type TaskFlowState = TaskFlowRevision & {
  history: TaskFlowRevision[];
};

export type TaskFlowSnapshot = TaskFlowRevision & {
  summary: {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    blocked: number;
    cancelled: number;
    completionRatio: number;
  };
};

type TaskFlowPersistence = {
  read: (sessionID: string) => Promise<unknown>;
  write: (state: TaskFlowState) => Promise<void>;
};

export type TaskFlowStore = {
  get: (sessionID: string) => Promise<TaskFlowState | undefined>;
  update: (sessionID: string, plan: TaskFlowPlan) => Promise<TaskFlowState>;
  markResumed: (sessionID: string, revision: number) => Promise<TaskFlowState | undefined>;
  recordFinalReport: (
    sessionID: string,
    revision: number,
    report: { createdAt: number; text: string },
  ) => Promise<TaskFlowState | undefined>;
};

function storageKey(sessionID: string): string {
  return `${TASKFLOW_STORAGE_PREFIX}${encodeURIComponent(sessionID)}`;
}

function finiteTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseTelemetry(value: unknown): Record<string, TaskFlowStepTelemetry> {
  const result = Object.create(null) as Record<string, TaskFlowStepTelemetry>;
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const startedAt = finiteTime(item.startedAt);
    const completedAt = finiteTime(item.completedAt);
    const blockedAt = finiteTime(item.blockedAt);
    const cancelledAt = finiteTime(item.cancelledAt);
    result[id] = {
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(blockedAt === undefined ? {} : { blockedAt }),
      ...(cancelledAt === undefined ? {} : { cancelledAt }),
    };
  }
  return result;
}

function parseTaskFlowChange(value: unknown): TaskFlowChange | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const kind = source.kind;
  if (
    typeof kind !== "string" ||
    !TASKFLOW_CHANGE_KINDS.includes(kind as TaskFlowChangeKind)
  )
    return undefined;
  const fields = Array.isArray(source.fields)
    ? source.fields.flatMap((field) =>
        typeof field === "string" && TASKFLOW_CHANGE_FIELDS.includes(field as TaskFlowChangeField)
          ? [field as TaskFlowChangeField]
          : [],
      )
    : [];
  return { kind: kind as TaskFlowChangeKind, fields };
}

function parseFinalReport(value: unknown, revision: number): TaskFlowFinalReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const reportRevision = Number(source.revision);
  const createdAt = finiteTime(source.createdAt);
  const text = typeof source.text === "string" ? source.text.trim() : "";
  if (
    !Number.isSafeInteger(reportRevision) ||
    reportRevision !== revision ||
    createdAt === undefined ||
    text.length === 0 ||
    text.length > TASKFLOW_LIMITS.finalReport
  )
    return undefined;
  return { revision, createdAt, text };
}

function parseTaskFlowRevision(raw: unknown, sessionID: string): TaskFlowRevision | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.version !== TASKFLOW_STATE_VERSION || value.sessionID !== sessionID) return undefined;
  const revision = Number(value.revision);
  const createdAt = finiteTime(value.createdAt);
  const updatedAt = finiteTime(value.updatedAt);
  if (!Number.isInteger(revision) || revision < 1 || createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  let plan: TaskFlowPlan;
  try {
    plan = parseTaskFlowPlan(value.plan);
  } catch {
    return undefined;
  }
  const resumedRevision = Number(value.resumedRevision);
  const continuationCount = Number(value.continuationCount);
  const completedAt = finiteTime(value.completedAt);
  const lastContinuationAt = finiteTime(value.lastContinuationAt);
  const change = parseTaskFlowChange(value.change);
  const finalReport = parseFinalReport(value.finalReport, revision);
  return {
    version: TASKFLOW_STATE_VERSION,
    sessionID,
    plan,
    revision,
    createdAt,
    updatedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(Number.isInteger(resumedRevision) && resumedRevision >= 1 ? { resumedRevision } : {}),
    continuationCount:
      Number.isInteger(continuationCount) && continuationCount >= 0 ? continuationCount : 0,
    ...(lastContinuationAt === undefined ? {} : { lastContinuationAt }),
    stepTelemetry: parseTelemetry(value.stepTelemetry),
    ...(change === undefined ? {} : { change }),
    ...(finalReport === undefined ? {} : { finalReport }),
  };
}

function historyWithCurrent(
  raw: unknown,
  current: TaskFlowRevision,
): TaskFlowRevision[] {
  const byRevision = new Map<number, TaskFlowRevision>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const revision = parseTaskFlowRevision(item, current.sessionID);
      if (revision) byRevision.set(revision.revision, revision);
    }
  }
  byRevision.set(current.revision, current);
  return [...byRevision.values()]
    .sort((left, right) => left.revision - right.revision)
    .slice(-TASKFLOW_HISTORY_LIMIT);
}

function historyWithRevision(
  history: TaskFlowRevision[] | undefined,
  current: TaskFlowRevision,
): TaskFlowRevision[] {
  return historyWithCurrent(
    [...(history ?? []).filter((item) => item.revision !== current.revision), current],
    current,
  );
}

function revisionOf(state: TaskFlowState): TaskFlowRevision {
  const { history: _history, ...revision } = state;
  return revision;
}

export function parseTaskFlowState(raw: unknown, sessionID: string): TaskFlowState | undefined {
  const current = parseTaskFlowRevision(raw, sessionID);
  if (!current || !raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const history = (raw as Record<string, unknown>).history;
  return { ...current, history: historyWithCurrent(history, current) };
}

function telemetryFor(
  previous: TaskFlowState | undefined,
  plan: TaskFlowPlan,
  now: number,
): Record<string, TaskFlowStepTelemetry> {
  const previousSteps = new Map(previous?.plan.steps.map((step) => [step.id, step]));
  const result = Object.create(null) as Record<string, TaskFlowStepTelemetry>;
  for (const step of plan.steps) {
    const oldStatus = previousSteps.get(step.id)?.status;
    const old = previous?.stepTelemetry[step.id] ?? {};
    if (step.status === "pending") {
      result[step.id] = {};
      continue;
    }
    if (step.status === "in_progress") {
      result[step.id] = {
        startedAt: oldStatus === "in_progress" && old.startedAt !== undefined ? old.startedAt : now,
      };
      continue;
    }
    if (step.status === "completed") {
      result[step.id] = {
        startedAt: old.startedAt ?? now,
        completedAt: oldStatus === "completed" && old.completedAt !== undefined ? old.completedAt : now,
      };
      continue;
    }
    if (step.status === "blocked") {
      result[step.id] = {
        ...(old.startedAt === undefined ? {} : { startedAt: old.startedAt }),
        blockedAt: oldStatus === "blocked" && old.blockedAt !== undefined ? old.blockedAt : now,
      };
      continue;
    }
    result[step.id] = {
      ...(old.startedAt === undefined ? {} : { startedAt: old.startedAt }),
      cancelledAt: oldStatus === "cancelled" && old.cancelledAt !== undefined ? old.cancelledAt : now,
    };
  }
  return result;
}

function taskFlowChange(
  previous: TaskFlowPlan | undefined,
  current: TaskFlowPlan,
): TaskFlowChange {
  if (!previous) return { kind: "initial", fields: [] };
  const fields: TaskFlowChangeField[] = [];
  if (previous.title !== current.title) fields.push("title");
  if (previous.objective !== current.objective) fields.push("objective");
  if (
    previous.acceptanceCriteria.length !== current.acceptanceCriteria.length ||
    previous.acceptanceCriteria.some(
      (criterion, index) => criterion !== current.acceptanceCriteria[index],
    )
  )
    fields.push("acceptance_criteria");
  if (
    previous.steps.length !== current.steps.length ||
    previous.steps.some((step, index) => step.id !== current.steps[index]?.id)
  )
    fields.push("step_structure");
  const previousByID = new Map(previous.steps.map((step) => [step.id, step]));
  let contentChanged = false;
  let agentChanged = false;
  let statusChanged = false;
  for (const step of current.steps) {
    const old = previousByID.get(step.id);
    if (!old) continue;
    if (old.content !== step.content) contentChanged = true;
    if (old.agent !== step.agent) agentChanged = true;
    if (old.status !== step.status) statusChanged = true;
  }
  if (contentChanged) fields.push("step_content");
  if (agentChanged) fields.push("agent_assignment");
  const definitionChanged = fields.length > 0;
  if (statusChanged) fields.push("step_status");
  if (definitionChanged) return { kind: "definition", fields };
  if (statusChanged) return { kind: "progress", fields: ["step_status"] };
  return { kind: "unchanged", fields: [] };
}

export function createTaskFlowStore(
  persistence: TaskFlowPersistence = {
    read: async () => undefined,
    write: async () => undefined,
  },
  now: () => number = Date.now,
): TaskFlowStore {
  const bySession = new Map<string, TaskFlowState>();
  const loading = new Map<string, Promise<TaskFlowState | undefined>>();
  const mutations = new Map<string, Promise<void>>();
  const get = async (sessionID: string) => {
    const current = bySession.get(sessionID);
    if (current) return current;
    const active = loading.get(sessionID);
    if (active) return active;
    const task = persistence.read(sessionID).then((raw) => {
      const state = parseTaskFlowState(raw, sessionID);
      if (state) bySession.set(sessionID, state);
      return state;
    }).finally(() => loading.delete(sessionID));
    loading.set(sessionID, task);
    return task;
  };
  const mutate = async <T>(sessionID: string, operation: () => Promise<T>): Promise<T> => {
    const previous = mutations.get(sessionID) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    const settled = task.then(() => undefined, () => undefined);
    mutations.set(sessionID, settled);
    try {
      return await task;
    } finally {
      if (mutations.get(sessionID) === settled) mutations.delete(sessionID);
    }
  };
  return {
    get,
    update: (sessionID, plan) => mutate(sessionID, async () => {
      const previous = await get(sessionID);
      const timestamp = now();
      const complete = unfinishedSteps(plan).length === 0;
      const revision: TaskFlowRevision = {
        version: TASKFLOW_STATE_VERSION,
        sessionID,
        plan,
        revision: (previous?.revision ?? 0) + 1,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
        ...(complete ? { completedAt: previous?.completedAt ?? timestamp } : {}),
        ...(previous?.resumedRevision === undefined
          ? {}
          : { resumedRevision: previous.resumedRevision }),
        continuationCount: previous?.continuationCount ?? 0,
        ...(previous?.lastContinuationAt === undefined
          ? {}
          : { lastContinuationAt: previous.lastContinuationAt }),
        stepTelemetry: telemetryFor(previous, plan, timestamp),
        change: taskFlowChange(previous?.plan, plan),
      };
      const state: TaskFlowState = {
        ...revision,
        history: historyWithRevision(previous?.history, revision),
      };
      await persistence.write(state);
      bySession.set(sessionID, state);
      return state;
    }),
    markResumed: (sessionID, revision) => mutate(sessionID, async () => {
      const previous = await get(sessionID);
      if (!previous || previous.revision !== revision) return previous;
      const nextRevision: TaskFlowRevision = {
        ...revisionOf(previous),
        resumedRevision: revision,
        continuationCount: previous.continuationCount + 1,
        lastContinuationAt: now(),
      };
      const state: TaskFlowState = {
        ...nextRevision,
        history: historyWithRevision(previous.history, nextRevision),
      };
      await persistence.write(state);
      bySession.set(sessionID, state);
      return state;
    }),
    recordFinalReport: (sessionID, revision, report) => mutate(sessionID, async () => {
      const previous = await get(sessionID);
      const text = report.text.trim();
      if (
        !previous ||
        previous.revision !== revision ||
        unfinishedSteps(previous.plan).length > 0 ||
        finiteTime(report.createdAt) === undefined ||
        text.length === 0 ||
        text.length > TASKFLOW_LIMITS.finalReport
      )
        return previous;
      if (
        previous.finalReport?.revision === revision &&
        previous.finalReport.text === text
      )
        return previous;
      const revisionState: TaskFlowRevision = {
        ...revisionOf(previous),
        finalReport: { revision, createdAt: report.createdAt, text },
      };
      const state: TaskFlowState = {
        ...revisionState,
        history: historyWithRevision(previous.history, revisionState),
      };
      await persistence.write(state);
      bySession.set(sessionID, state);
      return state;
    }),
  };
}

function requireString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`taskflow input: ${path} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.length > maxLength) {
    throw new Error(`taskflow input: ${path} must not exceed ${maxLength} characters`);
  }
  return result;
}

export function parseTaskFlowPlan(raw: unknown): TaskFlowPlan {
  if (!raw || typeof raw !== "object") throw new Error("taskflow input must be an object");
  const input = raw as Record<string, unknown>;
  if (!Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.length === 0) {
    throw new Error("taskflow input: acceptanceCriteria must be a non-empty array");
  }
  if (input.acceptanceCriteria.length > TASKFLOW_LIMITS.acceptanceCriteria) {
    throw new Error(
      `taskflow input: acceptanceCriteria must not contain more than ${TASKFLOW_LIMITS.acceptanceCriteria} items`,
    );
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new Error("taskflow input: steps must be a non-empty array");
  }
  if (input.steps.length > TASKFLOW_LIMITS.steps) {
    throw new Error(`taskflow input: steps must not contain more than ${TASKFLOW_LIMITS.steps} items`);
  }
  const acceptanceCriteria = input.acceptanceCriteria.map((criterion, index) =>
    requireString(
      criterion,
      `acceptanceCriteria[${index}]`,
      TASKFLOW_LIMITS.acceptanceCriterion,
    ),
  );
  const stepIDs = new Set<string>();
  const steps = input.steps.map((rawStep, index): TaskFlowStep => {
    if (!rawStep || typeof rawStep !== "object") {
      throw new Error(`taskflow input: steps[${index}] must be an object`);
    }
    const step = rawStep as Record<string, unknown>;
    const id = requireString(step.id, `steps[${index}].id`, TASKFLOW_LIMITS.stepID);
    if (stepIDs.has(id)) throw new Error(`taskflow input: duplicate step id: ${id}`);
    stepIDs.add(id);
    const status = requireString(step.status, `steps[${index}].status`, 32);
    if (!TASKFLOW_STATUSES.includes(status as TaskFlowStatus)) {
      throw new Error(
        `taskflow input: steps[${index}].status must be one of: ${TASKFLOW_STATUSES.join(", ")}`,
      );
    }
    const agent =
      step.agent === undefined
        ? undefined
        : requireString(step.agent, `steps[${index}].agent`, TASKFLOW_LIMITS.agent);
    return {
      id,
      content: requireString(
        step.content,
        `steps[${index}].content`,
        TASKFLOW_LIMITS.stepContent,
      ),
      status: status as TaskFlowStatus,
      ...(agent === undefined ? {} : { agent }),
    };
  });
  return {
    title: requireString(input.title, "title", TASKFLOW_LIMITS.title),
    objective: requireString(input.objective, "objective", TASKFLOW_LIMITS.objective),
    acceptanceCriteria,
    steps,
  };
}

function remainingSteps(plan: TaskFlowPlan): TaskFlowStep[] {
  return plan.steps.filter((step) => step.status === "pending" || step.status === "in_progress");
}

function unfinishedSteps(plan: TaskFlowPlan): TaskFlowStep[] {
  return plan.steps.filter(
    (step) => step.status === "pending" || step.status === "in_progress" || step.status === "blocked",
  );
}

function formatProgress(plan: TaskFlowPlan): string {
  const groups: Array<[TaskFlowStatus, string]> = [
    ["completed", "Tamamlananlar"],
    ["in_progress", "Sürdürülenler"],
    ["pending", "Yapılacaklar"],
    ["blocked", "Engellenenler"],
    ["cancelled", "İptal edilenler"],
  ];
  return groups
    .flatMap(([status, label]) => {
      const steps = plan.steps
        .filter((step) => step.status === status)
        .map((step) => `${step.id}: ${step.content}${step.agent ? ` [agent: ${step.agent}]` : ""}`);
      return steps.length === 0 ? [] : [`${label}: ${steps.join("; ")}`];
    })
    .join(" | ");
}

function continuationMessage(plan: TaskFlowPlan): string {
  const before =
    "BU SİSTEM MESAJIDIR! Taskflow'da tamamlanmamış işler var. Kullanıcıya yanıt vermeden önce devam edebildiğin kalan adımları tamamla. Tamamladığın işleri completed, sürdürdüğün işi in_progress, henüz başlamadıklarını pending olarak işaretle ve ilerlemeyi taskflow aracını kullanarak anlamlı aşamalarda güncelle. İş doğrulanmış bir engel nedeniyle devam ettirilemiyorsa ilgili adımı blocked olarak işaretle; yalnızca blocked işler kaldığında otomatik uyandırma durur. Şu ana kadar yaptıkların ve yapacağın işler: ";
  const after =
    ". Gerçek çalışmayı ve kontrolleri tamamladıktan sonra kullanıcıya sonucu, engelleri ve riskleri özetle; Taskflow'un iç takip ayrıntılarını yanıta dahil etme.";
  const truncated = " [iş listesi mesaj sınırında kısaltıldı]";
  const available = TASKFLOW_LIMITS.continuation - before.length - after.length;
  const progress = formatProgress(plan);
  const bounded =
    progress.length <= available
      ? progress
      : `${progress.slice(0, Math.max(0, available - truncated.length))}${truncated}`;
  return `${before}${bounded}${after}`;
}

export function taskFlowSnapshot(
  state: TaskFlowRevision & { history?: TaskFlowRevision[] },
): TaskFlowSnapshot {
  const { history: _history, ...revision } = state;
  const summary = {
    total: revision.plan.steps.length,
    pending: 0,
    inProgress: 0,
    completed: 0,
    blocked: 0,
    cancelled: 0,
    completionRatio: 0,
  };
  for (const step of revision.plan.steps) {
    if (step.status === "pending") summary.pending += 1;
    else if (step.status === "in_progress") summary.inProgress += 1;
    else if (step.status === "completed") summary.completed += 1;
    else if (step.status === "blocked") summary.blocked += 1;
    else summary.cancelled += 1;
  }
  summary.completionRatio = summary.total === 0 ? 0 : summary.completed / summary.total;
  return { ...revision, summary };
}

export function taskFlowHistorySnapshots(state: TaskFlowState): TaskFlowSnapshot[] {
  return [...state.history]
    .sort((left, right) => right.revision - left.revision)
    .map((revision) => taskFlowSnapshot(revision));
}

type TaskFlowTool = {
  name: "taskflow";
  description: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  options: { codemode: false; permission: "taskflow" };
  execute: (
    rawInput: unknown,
    toolContext: { sessionID: string },
  ) => Promise<{
    output: { plan: TaskFlowPlan; snapshot: { summary: TaskFlowSnapshot["summary"] } };
    content: string;
  }>;
};

export function taskFlowToolFactory(store: TaskFlowStore): TaskFlowTool {
  return {
    name: "taskflow",
    description:
      "Persist and track the complete plan for the current session until every required step is finished. Update step statuses at meaningful milestones. Use blocked only when a verified blocker prevents further work; blocked work pauses automatic continuation without completing the plan. Do not repeat an unchanged plan after every action.",
    input: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: TASKFLOW_LIMITS.title,
          description: "Short task title",
        },
        objective: {
          type: "string",
          minLength: 1,
          maxLength: TASKFLOW_LIMITS.objective,
          description: "Full task objective and scope",
        },
        acceptanceCriteria: {
          type: "array",
          minItems: 1,
          maxItems: TASKFLOW_LIMITS.acceptanceCriteria,
          items: {
            type: "string",
            minLength: 1,
            maxLength: TASKFLOW_LIMITS.acceptanceCriterion,
          },
          description: "Observable conditions required for completion",
        },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: TASKFLOW_LIMITS.steps,
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, maxLength: TASKFLOW_LIMITS.stepID },
              content: {
                type: "string",
                minLength: 1,
                maxLength: TASKFLOW_LIMITS.stepContent,
              },
              status: {
                type: "string",
                enum: TASKFLOW_STATUSES,
                description:
                  "pending: not started; in_progress: actively worked; completed: finished and verified; blocked: cannot continue because of a verified blocker; cancelled: intentionally removed from scope",
              },
              agent: {
                type: "string",
                minLength: 1,
                maxLength: TASKFLOW_LIMITS.agent,
                description:
                  "Optional existing agent to use through OpenCode's normal delegation flow",
              },
            },
            required: ["id", "content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "objective", "acceptanceCriteria", "steps"],
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: { plan: { type: "object" }, snapshot: { type: "object" } },
      required: ["plan", "snapshot"],
    },
    options: { codemode: false, permission: "taskflow" },
    execute: async (rawInput, toolContext) => {
      const plan = parseTaskFlowPlan(rawInput);
      const state = await store.update(toolContext.sessionID, plan);
      const remaining = remainingSteps(plan);
      const unfinished = unfinishedSteps(plan);
      return {
        // Keep internal revision/change metadata in the authenticated backend
        // and audit record, not in the model-facing tool result.
        output: { plan, snapshot: { summary: taskFlowSnapshot(state).summary } },
        content:
          unfinished.length === 0
            ? "Taskflow durumu güncellendi. Planlanan bütün işler tamamlandı. Kullanıcıya yapılan işleri, kontrolleri ve kalan riskleri anlatan kısa bir sonuç raporu ver; iç takip ayrıntılarını yanıta dahil etme."
            : remaining.length === 0
              ? "Taskflow durumu güncellendi. Yalnızca blocked adımlar kaldığı için otomatik uyandırma durduruldu; plan tamamlanmış sayılmadı. Kullanıcıya doğrulanmış engelleri ve çalışmanın devam etmesi için gerekenleri bildir."
              : `Taskflow durumu güncellendi. Devam edilebilir kalan adım sayısı: ${remaining.length}. Kullanıcıya yanıt vermeden önce çalışmayı sürdür; anlamlı aşamalarda durumları taskflow aracıyla güncelle. Doğrulanmış bir engel varsa ilgili adımı blocked olarak işaretle.`,
      };
    },
  };
}

type ContextMessage = { metadata?: Record<string, unknown> };
type ContextEvent = {
  sessionID: string;
  system: Array<{ type: "text"; text: string }>;
  messages?: ContextMessage[];
};

function removeTaskFlowAuditMessages(messages: ContextMessage[] | undefined): void {
  if (!messages) return;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const kind = messages[index]?.metadata?.taskflow;
    if (kind === "plan" || kind === "report") messages.splice(index, 1);
  }
}

export async function addTaskFlowContext(store: TaskFlowStore, event: ContextEvent): Promise<void> {
  removeTaskFlowAuditMessages(event.messages);
  const state = await store.get(event.sessionID);
  if (!state) return;
  if (unfinishedSteps(state.plan).length === 0) {
    if (!state.finalReport) {
      event.system.push({
        type: "text",
        text: "Taskflow tamamlandı. Kullanıcıya gerçek çalışmayı anlatan kısa bir sonuç raporu ver: yapılan değişiklikler veya sonuç, tamamlanan ya da iptal edilen adımlar, kabul koşullarının durumu, doğrulama kontrolleri ve kalan engeller veya riskler. Kullanıcı açıkça istemedikçe Taskflow'un iç takip ayrıntılarını yanıta dahil etme.",
      });
    }
  }
}

type SendContinuation = (sessionID: string, text: string, revision: number) => Promise<void>;

export async function resumeIncompleteTaskFlow(
  store: TaskFlowStore,
  sessionID: string,
  send: SendContinuation,
): Promise<boolean> {
  const state = await store.get(sessionID);
  if (!state || remainingSteps(state.plan).length === 0 || state.resumedRevision === state.revision) {
    return false;
  }
  await send(
    sessionID,
    continuationMessage(state.plan),
    state.revision,
  );
  await store.markResumed(sessionID, state.revision);
  return true;
}

export function taskFlowFinalReportOf(
  raw: unknown,
  after: number,
): { createdAt: number; text: string } | undefined {
  const messages: unknown[] = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === "object" &&
        !Array.isArray(raw) &&
        Array.isArray((raw as Record<string, unknown>).data)
      ? ((raw as Record<string, unknown>).data as unknown[])
      : [];
  let result: { createdAt: number; text: string } | undefined;
  for (const rawMessage of messages) {
    if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) continue;
    const message = rawMessage as Record<string, unknown>;
    if (message.type !== "assistant") continue;
    const messageTime =
      message.time && typeof message.time === "object" && !Array.isArray(message.time)
        ? finiteTime((message.time as Record<string, unknown>).created)
        : undefined;
    if (messageTime === undefined || messageTime < after || !Array.isArray(message.content)) continue;
    const text = message.content
      .flatMap((part) => {
        if (!part || typeof part !== "object" || Array.isArray(part)) return [];
        const item = part as Record<string, unknown>;
        return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
      })
      .join("\n")
      .trim();
    if (!text) continue;
    if (!result || messageTime >= result.createdAt)
      result = {
        createdAt: messageTime,
        text: text.slice(0, TASKFLOW_LIMITS.finalReport),
      };
  }
  return result;
}

async function captureTaskFlowFinalReport(
  ctx: TaskFlowPluginContext,
  store: TaskFlowStore,
  sessionID: string,
): Promise<void> {
  const state = await store.get(sessionID);
  if (
    !state ||
    unfinishedSteps(state.plan).length > 0 ||
    state.finalReport?.revision === state.revision
  )
    return;
  let messages: unknown;
  try {
    messages = await ctx.session.context({ sessionID });
  } catch (error) {
    console.error("taskflow final report unavailable", error);
    return;
  }
  // The assistant message starts before the taskflow tool runs, so its
  // message timestamp can precede state.createdAt. At session.idle the latest
  // assistant text is the response that completed this plan turn; use the
  // complete context rather than a tool-call timestamp boundary.
  const report = taskFlowFinalReportOf(messages, 0);
  if (!report) return;
  const next = await store.recordFinalReport(sessionID, state.revision, report);
  if (!next?.finalReport) return;
}

type TaskFlowPluginContext = Pick<PluginContext, "event" | "session" | "storage" | "tool">;
type RegisterTaskFlowOptions = {
  startBackend?: (read: (sessionID: string) => Promise<TaskFlowSnapshot | undefined>) => Promise<TaskFlowBackend>;
};

export async function registerTaskFlow(
  ctx: TaskFlowPluginContext,
  options: RegisterTaskFlowOptions = {},
): Promise<() => Promise<void>> {
  const store = createTaskFlowStore({
    read: (sessionID) => ctx.storage.get(storageKey(sessionID)),
    write: (state) => ctx.storage.set(storageKey(state.sessionID), state as never),
  });
  let backend: TaskFlowBackend = { dispose: async () => undefined };
  try {
    const readSnapshot = async (sessionID: string) => {
      const state = await store.get(sessionID);
      return state ? taskFlowSnapshot(state) : undefined;
    };
    backend = options.startBackend
      ? await options.startBackend(readSnapshot)
      : await startTaskFlowBackend(readSnapshot, {
          readHistory: async (sessionID) => {
            const state = await store.get(sessionID);
            return state ? taskFlowHistorySnapshots(state) : [];
          },
        });
  } catch (error) {
    console.error("taskflow read-only backend unavailable", error);
  }
  let toolRegistration: { dispose: () => Promise<void> } | undefined;
  let contextRegistration: { dispose: () => Promise<void> } | undefined;
  try {
    toolRegistration = await ctx.tool.transform((tools) => {
      tools.add(
        taskFlowToolFactory(store) as never,
      );
    });
    contextRegistration = await ctx.session.hook("context", (event) =>
      addTaskFlowContext(store, event as ContextEvent),
    );
  } catch (error) {
    await Promise.all([
      toolRegistration?.dispose(),
      contextRegistration?.dispose(),
      backend.dispose(),
    ]);
    throw error;
  }
  const controller = new AbortController();
  const eventTask = (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
       // beta-18314 emits session.execution.succeeded at the end of a turn;
       // session.idle is kept for runtimes that expose the older idle marker.
       if (event.type !== "session.idle" && event.type !== "session.execution.succeeded") continue;
      await resumeIncompleteTaskFlow(
        store,
        event.data.sessionID,
        async (sessionID, text, revision) => {
          await ctx.session.synthetic({
            sessionID,
            text,
            description: "Taskflow continuation",
            metadata: { taskflow: "continue", revision },
            delivery: "queue",
            resume: true,
          });
        },
      );
      await captureTaskFlowFinalReport(ctx, store, event.data.sessionID);
    }
  })();
  void eventTask.catch((error) => {
    if (!controller.signal.aborted) console.error("taskflow event stream failed", error);
  });

  return async () => {
    controller.abort();
    await Promise.all([
      toolRegistration?.dispose(),
      contextRegistration?.dispose(),
      backend.dispose(),
    ]);
    await eventTask.catch(() => undefined);
  };
}
