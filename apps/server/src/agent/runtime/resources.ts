import { t } from "@/lib/i18n";
import { readFile } from "@toonflow/file";
import { dirname, join } from "node:path";
import { DefaultResourceLoader, SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildSystemPrompt } from "@/agent/runtime/prompt";
import { loadAgentSkills } from "@/agent/skills";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { isMemoryEnabled, readDocument } from "@/utils/personalization";
import conf from "@/utils/conf";
import { isMultiUserEnabled } from "@/utils/auth";
import { getRuntimePlatform } from "@/lib/platform";

// 多人模式只从服务端管理的位置解析 SDK 包、扩展和资源，项目文件通过业务入口读取。
export function agentResourcePaths(cwd: string) {
  const root = isMultiUserEnabled() ? join(dirname(conf.path), "agentRuntime") : cwd;
  return { cwd: root, agentDir: join(root, ".agent") };
}

export async function createAgentResources(cwd: string, tools: ToolDefinition[], settings = SettingsManager.inMemory(), instructions = "") {
  const savedPrompt = conf.get("settings", {}).agentSystemPrompt;
  const systemPrompt = typeof savedPrompt === "string" ? savedPrompt : undefined;
  const paths = agentResourcePaths(cwd);
  const { path: agentsPath } = await resolveWorkspacePath(cwd, "AGENTS.md");
  const agentsContent = await readFile(agentsPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw new Error(t`读取工作区 AGENTS.md 失败：${error.message}`, { cause: error });
  });
  const [globalAgents, memory] = await Promise.all([readDocument("agents"), isMemoryEnabled() ? readDocument("memory") : { content: "" }]);
  const skills = loadAgentSkills(cwd);
  const sdkSkills = tools.some(tool => tool.name === "skillOperator")
    ? { ...skills, skills: skills.skills.map(skill => ({ ...skill, disableModelInvocation: true })) }
    : skills;
  const resourceLoader = new DefaultResourceLoader({
    ...paths,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    // ACT: 仅自动载入工作区根目录的 AGENTS.md，关闭 SDK 向父目录和其他指令文件的自动扫描。
    noContextFiles: true,
    agentsFilesOverride: () => ({ agentsFiles: agentsContent.trim() ? [{ path: agentsPath, content: agentsContent.replace(/^\uFEFF/, "") }] : [] }),
    // ACT: 技能正文按需读取；每个会话独立创建 loader，避免 SDK 的会话绑定互相覆盖。
    skillsOverride: () => sdkSkills,
    systemPrompt: "",
    systemPromptOverride: () => [buildSystemPrompt({ systemPrompt, tools, skills: skills.skills, platform: getRuntimePlatform().os }), instructions].filter(Boolean).join("\n\n"),
    appendSystemPrompt: [
      globalAgents.content.trim() ? `## 全局协作规范（AGENTS.md）\n${globalAgents.content}` : "",
      memory.content.trim() ? `## 全局长期记忆\n以下是跨对话保存的偏好与事实，使用前核对适用项目，以用户本轮要求为准。\n<global_memory>\n${memory.content}\n</global_memory>` : "",
    ].filter(Boolean),
  });
  await resourceLoader.reload();
  return { agentDir: paths.agentDir, settingsManager: settings, resourceLoader };
}
