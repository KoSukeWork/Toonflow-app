import { unlink } from "@toonflow/file";
import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().delete("/", validateFields({
  directory: z.string().min(1).max(4096), sessionFile: z.string().regex(/^[\w-]+\.jsonl$/),
}), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req, req.body.directory);
  const { path } = await u.agent.resolveSessionPath(cwd, req.body.sessionFile);
  const release = u.workspaceFile.lockWorkspaceFiles([path]);
  try { await unlink(path); }
  finally { release(); }
  res.json(success());
});
