import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { transferProjectOwnership } from "@/utils/projects";

export default Router().put("/", validateFields({ id: z.uuid(), expectedOwnerId: z.uuid(), newOwnerId: z.uuid() }), (req, res) => {
  const { id, expectedOwnerId, newOwnerId } = req.body;
  res.json(success(transferProjectOwnership(req, id, expectedOwnerId, newOwnerId)));
});
