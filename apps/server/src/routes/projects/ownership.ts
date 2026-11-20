import { Router } from "express";
import { success } from "@/lib/responseFormat";
import { listProjectOwnership } from "@/utils/projects";

export default Router().get("/", (req, res) => {
  res.json(success(listProjectOwnership(req)));
});
