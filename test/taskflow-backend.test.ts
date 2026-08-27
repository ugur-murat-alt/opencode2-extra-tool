import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTaskFlowBackend } from "../src/taskflow-backend";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("taskflow backend", () => {
  test("serves authenticated snapshots on loopback and removes discovery on cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taskflow-backend-"));
    const discoveryFile = join(directory, "backend.json");
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const backend = await startTaskFlowBackend(
      async (sessionID) => ({ sessionID, revision: 2 }),
      {
        discoveryFile,
        readHistory: async (sessionID) => [
          { sessionID, revision: 1 },
          { sessionID, revision: 2 },
        ],
      },
    );
    cleanups.push(() => backend.dispose());
    const discovery = JSON.parse(await readFile(discoveryFile, "utf8")) as {
      url: string;
      token: string;
    };

    const unauthorized = await fetch(`${discovery.url}v1/taskflows/session-a`);
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`${discovery.url}v1/taskflows/session-a`, {
      headers: { authorization: `Bearer ${discovery.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: true,
      snapshot: { sessionID: "session-a", revision: 2 },
    });
    const historyResponse = await fetch(`${discovery.url}v1/taskflows/session-a/history`, {
      headers: { authorization: `Bearer ${discovery.token}` },
    });
    expect(historyResponse.status).toBe(200);
    expect(await historyResponse.json()).toEqual({
      available: true,
      items: [
        { sessionID: "session-a", revision: 1 },
        { sessionID: "session-a", revision: 2 },
      ],
    });

    await cleanups.pop()?.();
    expect(await Bun.file(discoveryFile).exists()).toBe(false);
  });
});
