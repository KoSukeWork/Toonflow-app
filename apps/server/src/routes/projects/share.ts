import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { usernameSchema } from "@/utils/auth";
import { shareProject } from "@/utils/projects";

export default Router().put("/", validateFields({ id: z.uuid(), username: usernameSchema }), (req, res) => {
  shareProject(req, req.body.id, req.body.username);
  res.json(success());
});
