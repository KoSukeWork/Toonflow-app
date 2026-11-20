import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { unshareProject } from "@/utils/projects";

export default Router().delete("/", validateFields({ id: z.uuid(), userId: z.uuid() }), (req, res) => {
  unshareProject(req, req.body.id, req.body.userId);
  res.json(success());
});
