import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { openProject } from "@/utils/projects";

export default Router().post("/", validateFields({ id: z.uuid() }), async (req, res) => {
  res.json(success(await openProject(req, req.body.id)));
});
