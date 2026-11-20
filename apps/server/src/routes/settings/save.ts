import u from "@/utils";
import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { maxSystemPromptLength } from "@/agent/runtime/prompt";
import { t } from "@/lib/i18n";
import { getRequestUser } from "@/utils/auth";

const router = Router();

const settingsSchema = z.record(z.string(), z.json()).and(z.object({
  agentSystemPrompt: z.string().max(maxSystemPromptLength, { error: () => t`系统提示词不能超过 ${maxSystemPromptLength} 个字符` }).optional(),
  desktopUpdateSource: z.enum(["official", "github", "custom"]).optional(),
  desktopUpdateCustomUrl: z.string().max(2048).refine(value => !value || u.desktop.isValidUpdateUrl(value),
    "自定义更新源必须是不含账号、查询参数或锚点的 HTTP(S) 地址").optional(),
  mcp: z.object({ enabled: z.boolean().optional(), token: z.string().optional(), port: z.number().int().min(1).max(65535).optional() }).optional(),
})).refine(value => value.desktopUpdateSource !== "custom" || !!value.desktopUpdateCustomUrl, {
  path: ["desktopUpdateCustomUrl"], message: "选择自定义更新源前，请先填写有效地址",
});
const validateSnapshot = validateFields({ settings: settingsSchema });
const validateChanges = validateFields({
  owner: z.string().min(1).max(128),
  settings: z.never().optional(),
  changes: z.array(z.strictObject({ key: z.string().min(1).max(64), before: z.json().optional(), value: z.json().optional() })).min(1).max(32),
});

export default router.put("/", (req, res, next) => (getRequestUser(req) ? validateChanges : validateSnapshot)(req, res, next), async (req, res) => {
  u.mcpControl.assertAppRequest(req);
  const user = getRequestUser(req);
  if (user) {
    if (String(user.id) !== req.body.owner) throw Object.assign(new Error("登录账号已切换，请刷新后再保存"), { status: 409 });
    const { previous, sharedChanged, nodeMenu } = u.preferences.updateUserSettings(user, req.body.changes, value => settingsSchema.parse(value));
    const models = sharedChanged ? await u.ai.refreshProviderModels(previous) : {};
    res.json(success({ ...models, ...(req.body.changes.some((change: { key: string }) => change.key === "general") ? { nodeMenu } : {}) }, "设置已保存"));
    return;
  }
  const { settings } = req.body;
  u.removeLegacySettings(settings);
  u.cleanNodeMenuSettings(settings);
  const previousSettings = u.conf.get("settings", {});
  u.conf.set("settings", settings);
  const [models] = await Promise.all([u.ai.refreshProviderModels(previousSettings), u.mcpRuntime.reloadMcpRuntime()]);
  res.json(success({ ...models, nodeMenu: u.conf.get("settings.general.nodeMenu") ?? null }, "设置已保存"));
});
