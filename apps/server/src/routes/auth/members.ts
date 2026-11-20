import { Router } from "express";
import { listMembers } from "@/utils/auth";
import { success } from "@/lib/responseFormat";

export default Router().get("/", (req, res) => {
  res.json(success(listMembers(req)));
});
