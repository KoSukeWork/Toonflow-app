import { Router } from "express";
import { success } from "@/lib/responseFormat";
import { listProjects } from "@/utils/projects";

export default Router().get("/", (req, res) => {
  res.json(success(listProjects(req)));
});
