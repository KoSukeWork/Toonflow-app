import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.post("/", validateFields({ path: z.string().min(1).max(4096) }), async (req, res) => {
  const root = await u.assets.getAssetsDirectory(req.query.directory);
  await u.assets.createAssetDirectory(root, req.body.path);
  res.json(success());
});
