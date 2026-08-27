import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type SnapshotReader = (sessionID: string) => Promise<JsonValue | undefined>;
type HistoryReader = (sessionID: string) => Promise<JsonValue[] | undefined>;

export type TaskFlowBackend = { dispose: () => Promise<void> };
export type TaskFlowBackendOptions = {
  discoveryFile?: string;
  readHistory?: HistoryReader;
};

function discoveryPath(): string {
  return (
    process.env.OPENCODE_TASKFLOW_DISCOVERY_FILE ??
    join(
      process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
      "opencode2-extra-tool",
      "taskflow-backend.json",
    )
  );
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function send(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("taskflow backend address unavailable");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function startTaskFlowBackend(
  readSnapshot: SnapshotReader,
  options: TaskFlowBackendOptions = {},
): Promise<TaskFlowBackend> {
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (request, response) => {
    try {
      if (!authorized(request.headers.authorization, token)) return send(response, 401, { error: "unauthorized" });
      if (request.method !== "GET") return send(response, 405, { error: "method_not_allowed" });
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const historyMatch = /^\/v1\/taskflows\/([^/]+)\/history$/.exec(url.pathname);
      const snapshotMatch = /^\/v1\/taskflows\/([^/]+)$/.exec(url.pathname);
      const match = historyMatch ?? snapshotMatch;
      if (!match) return send(response, 404, { error: "not_found" });
      const sessionID = decodeURIComponent(match[1] ?? "").trim();
      if (!sessionID || sessionID.length > 256) return send(response, 400, { error: "invalid_session" });
      if (historyMatch) {
        const history = options.readHistory ? await options.readHistory(sessionID) : [];
        return send(response, 200, { available: true, items: history ?? [] });
      }
      const snapshot = await readSnapshot(sessionID);
      return send(response, 200, { available: true, snapshot: snapshot ?? null });
    } catch {
      return send(response, 500, { error: "internal_error" });
    }
  });
  const port = await listen(server);
  const file = options.discoveryFile ?? discoveryPath();
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const payload = JSON.stringify({
    version: 1,
    url: `http://127.0.0.1:${port}/`,
    token,
  });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    await close(server);
    throw error;
  }
  return {
    dispose: async () => {
      await close(server);
      try {
        const current = JSON.parse(await readFile(file, "utf8")) as { token?: unknown };
        if (current.token === token) await unlink(file);
      } catch {
        // A newer plugin instance may already own the discovery file.
      }
    },
  };
}
