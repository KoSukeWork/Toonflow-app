import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { projectNameSchema, registerProject } from "@/utils/projects";

export default Router().post("/", validateFields({ path: z.string().trim().min(1).max(4096), ownerId: z.uuid(), name: projectNameSchema.optional() }), async (req, res) => {
  res.json(success(await registerProject(req, req.body.path.trim(), req.body.ownerId, req.body.name?.trim())));
});
