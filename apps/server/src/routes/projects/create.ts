import { Router } from "express";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { createProject, projectNameSchema } from "@/utils/projects";

export default Router().post("/", validateFields({ name: projectNameSchema }), async (req, res) => {
  res.json(success(await createProject(req, req.body.name.trim())));
});
