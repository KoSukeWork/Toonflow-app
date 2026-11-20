import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().get("/", validateFields({
  directory: z.string().min(1).max(4096), sessionFile: z.string().regex(/^[\w-]+\.jsonl$/),
}, "query"), async (req, res) => {
  const { directory, sessionFile } = req.query as { directory: string; sessionFile: string };
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const { path } = await u.agent.resolveSessionPath(cwd, sessionFile);
  res.set("Cache-Control", "no-store").json(success(await u.agent.getAgentSession(cwd, path)));
});
