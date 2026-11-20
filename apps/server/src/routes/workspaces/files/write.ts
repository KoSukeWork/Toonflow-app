import { Router } from "express";
import { readFile } from "@toonflow/file";
import { createHash } from "node:crypto";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

function staleFile(message: string) {
  return Object.assign(new Error(message), { status: 409, code: "ESTALE" });
}

function isCanvas(bytes: Buffer) {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  const text = new TextDecoder(encoding).decode(bytes);
  try { return JSON.parse(text)?.toonflowCanvas === true; }
  catch { return false; }
}

export default router.put("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().max(4096), exclusive: z.enum(["true", "false"]).optional(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(), encoding: z.enum(["utf-8", "utf-8-bom", "utf-16le", "utf-16be"]).optional() }, "query"), async (req, res) => {
  if (!req.is("application/octet-stream") || (req.body !== undefined && !Buffer.isBuffer(req.body))) {
    throw Object.assign(new Error("请发送文件原始内容"), { status: 400 });
  }
  const expectedRevision = req.query.expectedRevision;
  const exclusive = req.query.exclusive === "true";
  const root = await u.workspace.resolveWorkspace(req, req.query.directory as string);
  const { directory, path } = await u.workspaceFile.resolveWorkspacePath(root, req.query.path as string).catch((error: NodeJS.ErrnoException) => {
    if (expectedRevision && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw staleFile("文件已被删除或移动，未覆盖磁盘内容");
    }
    throw error;
  });
  u.workspaceFile.protectWorkspaceRoot(directory, path);
  const release = u.workspaceFile.lockWorkspaceFiles([path]);
  let revision: string | undefined;
  try {
    let bytes = req.body ?? Buffer.alloc(0);
    if (expectedRevision) {
      const previous = await readFile(path).catch(error => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR") throw staleFile("文件已被删除、移动或替换，未覆盖磁盘内容");
        throw error;
      });
      if (createHash("sha256").update(previous).digest("hex") !== expectedRevision) {
        throw staleFile("文件已被其他编辑器修改，请重新载入磁盘版本或另存副本");
      }
    } else if (req.app.locals.accounts && !exclusive && /\.json$/i.test(path)) {
      // ACT: 旧页面和插件也必须带实际读取的版本才能覆盖画布，普通 JSON 文件继续使用通用写入协议。
      if (isCanvas(bytes)) throw staleFile("新建画布需要独占写入，保存已有画布需要当前文件版本");
      const previous = await readFile(path).catch(error => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (previous && isCanvas(previous)) throw staleFile("保存画布需要当前文件版本，请重新载入后保存");
    }
    if (req.query.encoding && req.query.encoding !== "utf-8") {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (req.query.encoding === "utf-8-bom") bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]);
      else {
        const encoded = Buffer.from(text, "utf16le");
        if (req.query.encoding === "utf-16be") encoded.swap16();
        bytes = Buffer.concat([Buffer.from(req.query.encoding === "utf-16be" ? [0xfe, 0xff] : [0xff, 0xfe]), encoded]);
      }
    }
    await u.workspaceFile.writeWorkspaceFile(path, bytes, exclusive);
    if (expectedRevision) revision = createHash("sha256").update(bytes).digest("hex");
  }
  finally { release(); }
  res.json(success(revision ? { revision } : undefined));
});
