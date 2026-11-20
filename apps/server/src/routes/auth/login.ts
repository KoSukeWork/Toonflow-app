import { Router } from "express";
import { passwordSchema, startSession, usernameSchema, verifyLogin } from "@/utils/auth";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ username: usernameSchema, password: passwordSchema }), async (req, res) => {
  const user = await verifyLogin(req, req.body.username, req.body.password);
  startSession(req, res, user);
  res.json(success(user));
});
