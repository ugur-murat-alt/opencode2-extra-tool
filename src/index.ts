import * as OpenCodePlugin from "@opencode-ai/plugin";
import { registerTodoWriteTool } from "./todowrite";

export const PLUGIN_ID = "opencode2-extra-tool";

export default OpenCodePlugin.Plugin.define({
  id: PLUGIN_ID,
  setup: async (ctx) => {
    await registerTodoWriteTool(ctx);
  },
});

export { createTodoStore, parseTodos, registerTodoWriteTool, todowriteToolFactory } from "./todowrite";
