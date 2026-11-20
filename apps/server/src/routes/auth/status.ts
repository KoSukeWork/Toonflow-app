import { Router } from "express";
import { readSession } from "@/utils/auth";
import { success } from "@/lib/responseFormat";
import type { AuthState } from "@/types/auth";

export default Router().get("/", (req, res) => {
  const enabled = Boolean(req.app.locals.accounts);
  res.set({ "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin" })
    .json(success<AuthState>({ enabled, user: enabled ? readSession(req) ?? null : null }));
});
