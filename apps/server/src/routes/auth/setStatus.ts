import { Router } from "express";
import { z } from "zod";
import { setAccountDisabled } from "@/utils/auth";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().put("/", validateFields({ userId: z.uuid(), disabled: z.boolean() }), (req, res) => {
  res.json(success(setAccountDisabled(req, req.body.userId, req.body.disabled)));
});
