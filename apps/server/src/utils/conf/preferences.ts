import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { AuthUser } from "@/types/auth";
import { providerSchema } from "@/utils/ai";
import conf, { cleanNodeMenuSettings } from "@/utils/conf";

type SettingsChange = { key: string; before?: unknown; value?: unknown };

const personalFields = {
  ui: z.record(z.string(), z.json()),
  general: z.record(z.string(), z.json()),
  documentExtensions: z.record(z.string(), z.string()),
  helloCompleted: z.boolean(),
  personalization: z.strictObject({ memoryEnabled: z.boolean().optional() }),
};
const sharedKeys = new Set(["customProviders", "mediaProviderConfigs", "mcp", "ffmpeg", "agentSystemPrompt"]);
const publicProvider = providerSchema.pick({ models: true }).extend({ id: z.string(), label: z.string() });

function userPreferences(user: AuthUser) {
  return { helloCompleted: true, ...conf.get("userPreferences", {})[user.id] } as Record<string, unknown>;
}

export function readUserSettings(user: AuthUser) {
  const settings = conf.get("settings", {});
  const preferences = userPreferences(user);
  if (user.role === "admin") return { ...Object.fromEntries(Object.entries(settings).filter(([key]) => sharedKeys.has(key))), ...preferences };
  const providers = Array.isArray(settings.customProviders) ? settings.customProviders : [];
  const customProviders = providers.flatMap(provider => {
    const parsed = publicProvider.safeParse(provider);
    return parsed.success ? [parsed.data] : [];
  });
  return { ...preferences, customProviders };
}

export function updateUserSettings(user: AuthUser, changes: SettingsChange[], validateShared: (settings: Record<string, unknown>) => void) {
  const store = conf.store;
  const previous = store.settings ?? {};
  const shared = { ...previous };
  const personal = userPreferences(user);
  let sharedChanged = false;
  for (const change of changes) {
    const isPersonal = Object.hasOwn(personalFields, change.key);
    if (!isPersonal && !(user.role === "admin" && sharedKeys.has(change.key))) {
      throw Object.assign(new Error("没有权限修改此设置"), { status: 403 });
    }
    const target = isPersonal ? personal : shared;
    if (isPersonal && change.value !== undefined) personalFields[change.key as keyof typeof personalFields].parse(change.value);
    if (isDeepStrictEqual(target[change.key], change.value)) continue;
    if (!isDeepStrictEqual(target[change.key], change.before)) {
      throw Object.assign(new Error("此项设置已在其他页面修改，请刷新后重新编辑"), { status: 409 });
    }
    if (!Object.hasOwn(change, "value")) delete target[change.key];
    else target[change.key] = change.value;
    if (!isPersonal) sharedChanged = true;
  }
  if (sharedChanged) validateShared(shared);
  if (changes.some(({ key }) => key === "general")) cleanNodeMenuSettings(personal);
  // ACT: LAN 单进程中同步比较并一次落盘，避免一次操作的个人和团队配置部分成功。
  conf.store = { ...store, settings: shared, userPreferences: { ...store.userPreferences, [user.id]: personal } };
  return { previous, sharedChanged, nodeMenu: (personal.general as { nodeMenu?: unknown } | undefined)?.nodeMenu ?? null };
}
