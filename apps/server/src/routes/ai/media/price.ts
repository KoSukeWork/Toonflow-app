import { Router } from "express";
import { z } from "zod";
import { audioGenerationSchema, imageGenerationSchema, videoGenerationSchema } from "@toonflow/tool-media-generation/runtime";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import { translateMessage, validationOptions } from "@/lib/i18n";
import u from "@/utils";
import { getRequestUser } from "@/utils/auth";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096).optional(), mediaType: z.enum(["image", "video", "audio"]),
}), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const { directory, mediaType, ...request } = req.body;
  const multiUser = Boolean(getRequestUser(req));
  const schema = (mediaType === "image" ? imageGenerationSchema : mediaType === "video" ? videoGenerationSchema : audioGenerationSchema).extend({ prompt: z.string().trim().max(100000) });
  const parsed = schema.safeParse(request, validationOptions());
  if (!parsed.success) {
    res.status(400).json(error("参数错误", parsed.error.issues.map(issue => ({ ...issue, message: translateMessage(issue.message) })), 400));
    return;
  }
  const cwd = directory || multiUser ? await u.workspace.resolveWorkspace(req, directory ?? "") : undefined;
  const controller = new AbortController();
  const close = () => controller.abort();
  res.once("close", close);
  req.once("aborted", close);
  req.socket.once("close", close);
  try {
    const price = await u.mediaGeneration.getMediaPrice(cwd, mediaType, parsed.data, controller.signal);
    if (!res.destroyed) res.set("Cache-Control", "no-store").json(success(price));
  } catch (err) {
    if (!controller.signal.aborted) {
      if (!multiUser) throw err;
      res.status(502).json(error("查询媒体模型价格失败", null, 502));
    }
  } finally {
    res.off("close", close);
    req.off("aborted", close);
    req.socket.off("close", close);
  }
});
