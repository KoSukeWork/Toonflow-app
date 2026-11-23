import { Router } from "express";
import { changePassword, endSession, passwordSchema } from "@/utils/auth";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().put("/", validateFields({ currentPassword: passwordSchema, newPassword: passwordSchema }), async (req, res) => {
  await changePassword(req, req.body.currentPassword, req.body.newPassword);
  endSession(req, res);
  res.json(success());
});
