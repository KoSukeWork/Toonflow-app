import { Router } from "express";
import { z } from "zod";
import { passwordSchema, resetPassword } from "@/utils/auth";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().put("/", validateFields({ userId: z.uuid(), newPassword: passwordSchema }), async (req, res) => {
  await resetPassword(req, req.body.userId, req.body.newPassword);
  res.json(success());
});
