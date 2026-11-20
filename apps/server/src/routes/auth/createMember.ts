import { Router } from "express";
import { createMember, passwordSchema, usernameSchema } from "@/utils/auth";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({ username: usernameSchema, password: passwordSchema }), async (req, res) => {
  const user = await createMember(req, req.body.username, req.body.password);
  res.json(success(user));
});
