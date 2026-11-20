import type { RequestHandler } from "express";
import { error } from "@/lib/responseFormat";
import { readSession, runAsRequestUser } from "@/utils/auth";

const bundles = new Set(["GET /api/nodes/files", "GET /api/ext/read"]);

const memberRoutes = new Set([
  "POST /api/auth/logout",
  "GET /api/projects/list",
  "POST /api/projects/create",
  "POST /api/projects/open",
  "PUT /api/projects/rename",
  "GET /api/workspaces/check",
  "GET /api/workspaces/files/list",
  "GET /api/workspaces/files/read",
  "PUT /api/workspaces/files/write",
  "POST /api/workspaces/files/mkdir",
  "POST /api/workspaces/files/copy",
  "POST /api/workspaces/files/rename",
  "DELETE /api/workspaces/files/remove",
  "GET /api/settings/get",
  "PUT /api/settings/save",
  "GET /api/settings/personalization/get",
  "PUT /api/settings/personalization/save",
  "GET /api/nodes/get",
  "GET /api/ext/list",
  "GET /api/ai/models",
  "POST /api/ai/generate",
  "GET /api/ai/media/models",
  "POST /api/ai/media/generate",
  "POST /api/ai/media/price",
]);

const adminRoutes = new Set([
  "GET /api/auth/members",
  "POST /api/auth/createMember",
  "POST /api/projects/register",
  "POST /api/providers/models",
  "GET /api/providers/media/list",
  "POST /api/providers/media/models",
  "POST /api/providers/media/add",
  "PUT /api/providers/media/save",
  "DELETE /api/providers/media/delete",
  "POST /api/providers/media/validate",
  "POST /api/nodes/install",
  "PUT /api/nodes/save",
  "PUT /api/nodes/setEnabled",
  "DELETE /api/nodes/uninstall",
  "POST /api/ext/install",
  "PUT /api/ext/save",
  "PUT /api/ext/setEnabled",
  "DELETE /api/ext/uninstall",
  "GET /api/tools/get",
  "POST /api/tools/install",
  "PUT /api/tools/save",
  "PUT /api/tools/setEnabled",
  "DELETE /api/tools/uninstall",
  "GET /api/skills/get",
  "GET /api/skills/list",
  "GET /api/skills/read",
  "POST /api/skills/install",
  "POST /api/skills/create",
  "PUT /api/skills/save",
  "PUT /api/skills/move",
  "PUT /api/skills/order",
  "PUT /api/skills/setEnabled",
  "DELETE /api/skills/uninstall",
  "GET /api/plugins/export",
]);

export const multiUserAccess: RequestHandler = (req, res, next) => {
  if (!/^\/(?:api|mcp|a2a)(?:\/|$)/i.test(req.path)) return next();
  res.set("Cache-Control", "no-store");
  const route = `${req.method} ${req.path.replace(/\/$/, "")}`;
  if (route === "GET /api/auth/status") return next();
  if (route === "POST /api/auth/login") {
    if (req.get("x-toonflow-workspace") !== "1" || (req.get("sec-fetch-site") && req.get("sec-fetch-site") !== "same-origin")) {
      return void res.status(403).json(error("仅允许当前站点发起登录", null, 403));
    }
    if (!req.is("application/json")) return void res.status(415).json(error("请使用 JSON 提交登录信息", null, 415));
    return next();
  }
  const user = readSession(req);
  if (!user) return void res.status(401).json(error("请先登录", null, 401));
  if (!bundles.has(route) && req.get("x-toonflow-user") !== user.id) {
    return void res.status(401).json(error("登录账号已变更，请重新加载页面", null, 401));
  }
  // ACT: 精确匹配方法与路径，由各工程接口继续校验所请求的项目。新增接口默认关闭。
  if (!bundles.has(route) && !memberRoutes.has(route) && !(user.role === "admin" && adminRoutes.has(route))) {
    return void res.status(403).json(error("当前账号无权访问此功能", null, 403));
  }
  res.set("Cross-Origin-Resource-Policy", "same-origin");
  runAsRequestUser(req, user, next);
};
