import conf from "conf";
import { mkdirSync, readdirSync, realpathSync } from "@toonflow/file";
import { resolve } from "node:path";
import tfRouter from "@toonflow/providers/language/tfRouter";
import type { RemoteTeam } from "@/utils/teams";
import type { A2aSettings } from "@/agent/a2a/settings";
import type { MobileLinkConfig } from "@/utils/mobileLink";
import { normalizeNodeMenu, serializeNodeMenu } from "@/lib/nodeMenu";

const autoInstallProviders = [tfRouter];
const dataDirectory = process.env.TOONFLOW_DATA_DIR ?? resolve(import.meta.dirname, "../../../../../data");
mkdirSync(dataDirectory, { recursive: true });
const configDirectory = realpathSync(dataDirectory);
process.env.TOONFLOW_DATA_DIR = configDirectory;

const config = new conf<{ settings: Record<string, unknown>; userPreferences: Record<string, Record<string, unknown>>; disabledSkills: string[]; toolConfigs: Record<string, Record<string, unknown>>; nodeConfigs: Record<string, Record<string, unknown>>; extConfigs: Record<string, Record<string, unknown>>; remoteConnections: Record<string, RemoteTeam>; a2a: A2aSettings; mobileLink: MobileLinkConfig }>({
  cwd: configDirectory,
  configName: "settings",
  configFileMode: 0o600,
  watch: true,
});

function removeUsageSettings(settings: Record<string, unknown>) {
  const privacy = settings?.privacy;
  if (!privacy || typeof privacy !== "object" || Array.isArray(privacy)) return false;
  if (!Object.hasOwn(privacy, "anonymousId") && !Object.hasOwn(privacy, "dataCollectionEnabled")) return false;
  Reflect.deleteProperty(privacy, "anonymousId");
  Reflect.deleteProperty(privacy, "dataCollectionEnabled");
  if (!Object.keys(privacy).length) delete settings.privacy;
  return true;
}

export function removeLegacySettings(settings: Record<string, unknown>) {
  let changed = removeUsageSettings(settings);
  // ACT: 只清理已废弃字段，保留其他设置和插件配置。
  for (const [record, key] of [
    [settings, "developerConfirmed"], [settings, "desktopUpdateSource"], [settings, "desktopUpdateCustomUrl"], [settings, "updateBoxSeenBuilds"],
    [settings.general, "systemPrompt"], [settings.stores, "toonflow.developer"],
  ] as const) {
    if (record && typeof record === "object" && !Array.isArray(record) && Object.hasOwn(record, key)) {
      Reflect.deleteProperty(record, key);
      changed = true;
    }
  }
  return changed;
}

export function cleanNodeMenuSettings(settings: Record<string, unknown>) {
  const general = settings.general;
  if (!general || typeof general !== "object" || Array.isArray(general) || !Object.hasOwn(general, "nodeMenu")) return false;
  const record = general as Record<string, unknown>;
  const installedTypes = new Set<string>();
  try {
    // ACT: 仅扫描已安装文件名；禁用节点保留配置，菜单清理与同步存盘间不插入异步等待。
    for (const file of readdirSync(resolve(configDirectory, "nodes"), { withFileTypes: true })) {
      if (file.isFile() && /^[a-z][a-zA-Z0-9]*\.umd\.js$/.test(file.name)) installedTypes.add(`remote-${file.name.slice(0, -7)}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const nodeMenu = serializeNodeMenu(normalizeNodeMenu(record.nodeMenu), installedTypes);
  if (!nodeMenu.length) {
    delete record.nodeMenu;
    return true;
  }
  if (JSON.stringify(record.nodeMenu) === JSON.stringify(nodeMenu)) return false;
  record.nodeMenu = nodeMenu;
  return true;
}

const store = config.store;
let changed = removeLegacySettings(store.settings ?? {});
if (Object.hasOwn(store, "desktopUpdateAttempt")) {
  Reflect.deleteProperty(store, "desktopUpdateAttempt");
  changed = true;
}
for (const preferences of Object.values(store.userPreferences ?? {})) {
  if (removeUsageSettings(preferences)) changed = true;
  if (Object.hasOwn(preferences, "updateBoxSeenBuilds")) {
    delete preferences.updateBoxSeenBuilds;
    changed = true;
  }
}
if (changed) config.store = store;

// ACT: 仅初始化尚未配置的文本供应商；已有列表（包括用户清空的列表）保持原样。
if (!config.has("settings.customProviders")) {
  config.set("settings.customProviders", autoInstallProviders.map(({ id, label, icon, version, apiUrl, protocol, models }) =>
    ({ id, label, icon, version, apiUrl, protocol, models, apiKey: "" })));
}

export default config;
