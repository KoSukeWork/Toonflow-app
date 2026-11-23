import { lstat } from "@toonflow/file";
import { sendFile } from "@/utils/fileHttp";
import { sendStaticImage } from "@/utils/imageHttp";
import { basename } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";

const router = Router();

export default router.get("/", validateFields({ path: z.string().min(1).max(4096), download: z.literal("true").optional(), thumbnail: z.literal("true").optional() }, "query"), async (req, res, next) => {
  const root = await u.assets.getAssetsDirectory(req.query.directory);
  const { directory, path } = await u.workspaceFile.resolveWorkspacePath(root, req.query.path as string);
  u.workspaceFile.protectWorkspaceRoot(directory, path);
  const file = await lstat(path);
  if (!file.isFile()) throw Object.assign(new Error("只能读取文件"), { status: 400 });
  const download = req.query.download === "true";
  if (download) res.attachment(basename(path));
  res.set({ "Cache-Control": "no-store", "Content-Security-Policy": "sandbox", "X-Content-Type-Options": "nosniff" });
  if (await sendStaticImage(res, path, file.size, !download && req.query.thumbnail === "true")) return;
  await sendFile(res, path, { dotfiles: "allow" }, err => { if (err) next(err); });
});
