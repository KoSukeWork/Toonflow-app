import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { projectNameSchema, renameProject } from "@/utils/projects";

export default Router().put("/", validateFields({ id: z.uuid(), name: projectNameSchema }), (req, res) => {
  renameProject(req, req.body.id, req.body.name.trim());
  res.json(success());
});
