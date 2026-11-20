import u from "@/utils";
import { Router } from "express";
import { success } from "@/lib/responseFormat";
import { getRequestUser } from "@/utils/auth";

const router = Router();

export default router.get("/", (req, res) => {
  u.mcpControl.assertAppRequest(req);
  res.set("Cache-Control", "no-store");
  const user = getRequestUser(req);
  if (user) {
    res.json(success(u.preferences.readUserSettings(user)));
    return;
  }
  const settings = u.conf.get("settings", {});
  if (u.cleanNodeMenuSettings(settings)) u.conf.set("settings", settings);
  res.json(success(settings));
});
