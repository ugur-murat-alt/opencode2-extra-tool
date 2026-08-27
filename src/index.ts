import * as OpenCodePlugin from "@opencode-ai/plugin";
import { registerTaskFlow } from "./taskflow";
import { registerTodoWriteTool } from "./todowrite";

export const PLUGIN_ID = "opencode2-extra-tool";

export default OpenCodePlugin.Plugin.define({
  id: PLUGIN_ID,
  setup: async (ctx) => {
    const disposeTodo = await registerTodoWriteTool(ctx);
    try {
      const disposeTaskFlow = await registerTaskFlow(ctx);
      return async () => {
        await Promise.all([disposeTaskFlow(), disposeTodo()]);
      };
    } catch (error) {
      await disposeTodo();
      throw error;
    }
  },
});

export { createTodoStore, parseTodos, registerTodoWriteTool, todowriteToolFactory } from "./todowrite";
