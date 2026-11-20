import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { listProjectMembers } from "@/utils/projects";

export default Router().get("/", validateFields({ id: z.uuid() }, "query"), (req, res) => {
  res.json(success(listProjectMembers(req, req.query.id as string)));
});
