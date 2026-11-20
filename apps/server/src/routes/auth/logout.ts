import { Router } from "express";
import { endSession, requireRequestUser } from "@/utils/auth";
import { success } from "@/lib/responseFormat";

export default Router().post("/", (req, res) => {
  requireRequestUser(req);
  endSession(req, res);
  res.json(success());
});
