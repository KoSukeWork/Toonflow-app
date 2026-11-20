import { defineStore } from "pinia";
import { ref } from "vue";
import axios from "axios";
import type { AgentAttachment } from "@/components/agent/types";
import type { RegisteredProject } from "@toonflow/server/auth";

export type Project = {
  id?: string;
  directory: string;
  name: string;
  lastOpenedAt: number;
};

export const useWorkspaceStore = defineStore("workspace", () => {
  const project = ref<Project | null>(null);
  const projectList = ref<Project[]>([]);
  const pendingAgentMessage = ref<{ directory: string; prompt: string; attachments?: AgentAttachment[]; model: string; reasoningEffort: string } | null>(null);

  async function openProject(path: string, previousDirectory = path, signal?: AbortSignal) {
    const { data } = await axios.get<{ code: number; data?: { directory: string }; message?: string }>("/api/workspaces/check", {
      params: { directory: path }, headers: { "x-toonflow-workspace": "1" }, signal,
    });
    signal?.throwIfAborted();
    if (data.code !== 200 || !data.data?.directory) throw new Error(data.message || "工作目录校验失败");
    const checkedDirectory = data.data.directory;
    pendingAgentMessage.value = null;
    const existing = projectList.value.find(project => project.directory === previousDirectory)
      ?? projectList.value.find(project => project.directory === checkedDirectory);
    project.value = { directory: checkedDirectory, name: existing?.name || checkedDirectory.split(/[\\/]/).filter(Boolean).at(-1) || checkedDirectory, lastOpenedAt: Date.now() };
    projectList.value = [
      project.value,
      ...projectList.value.filter(item => item.directory !== previousDirectory && item.directory !== checkedDirectory),
    ];
  }

  async function renameProject(path: string, name: string) {
    const target = projectList.value.find(item => item.directory === path);
    name = name.trim();
    if (!target || !name || target.name === name) return;
    if (target.id) await axios.put("/api/projects/rename", { id: target.id, name });
    target.name = name;
    if (project.value?.directory === path) project.value = target;
  }

  function removeProject(path: string) {
    projectList.value = projectList.value.filter(item => item.directory !== path);
    if (project.value?.directory === path) project.value = null;
  }

  async function loadProjects() {
    const { data } = await axios.get<{ data: RegisteredProject[] }>("/api/projects/list");
    projectList.value = data.data;
  }

  function activateRegisteredProject(value: RegisteredProject) {
    pendingAgentMessage.value = null;
    project.value = value;
    projectList.value = [value, ...projectList.value.filter(item => item.id !== value.id)];
  }

  return { project, projectList, pendingAgentMessage, openProject, renameProject, removeProject, loadProjects, activateRegisteredProject };
}, {
  persist: {
    key: "toonflow.projectList",
    pick: ["project", "projectList"],
  },
});
