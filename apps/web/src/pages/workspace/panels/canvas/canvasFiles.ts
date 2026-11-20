import type { Edge, Node, ViewportTransform } from "@vue-flow/core";
import axios from "axios";
import type useWorkspaceFiles from "@/lib/workspaceFiles";
import type { TextSnapshot } from "@/lib/workspaceFiles";
import { isCanvasFile } from "@/pages/workspace/canvasFile";

type Files = ReturnType<typeof useWorkspaceFiles>;
export type CanvasFile = { toonflowCanvas: true; nodes: Node[]; edges: Edge[]; viewport: ViewportTransform; [key: string]: unknown };
export type CanvasSnapshot = { data: CanvasFile; disk: TextSnapshot };
export type DocumentNode = { canvasPath: string; nodeId: string; label: string; nodeType?: string; parentNode?: string };
export type DocumentNodeOptions = { canvasPath?: string; includeGroups?: boolean; signal?: AbortSignal; onError?: (path: string, error: unknown) => void };

export async function readCanvasSnapshot(files: Files, path: string, signal?: AbortSignal): Promise<CanvasSnapshot> {
  const disk = await files.readTextSnapshot(path, { signal });
  signal?.throwIfAborted();
  const data = JSON.parse(disk.text) as CanvasFile | null;
  if (data?.toonflowCanvas !== true || !Array.isArray(data.nodes) || !Array.isArray(data.edges) || !data.viewport
    || ![data.viewport.x, data.viewport.y, data.viewport.zoom].every(Number.isFinite) || data.viewport.zoom <= 0) {
    throw new Error(`画布文件格式无效：${path}`);
  }
  return { data, disk };
}

function validateCopyCanvas(data: CanvasFile, path: string) {
  if (data.nodes.some(node => !node || typeof node.id !== "string" || !node.id || /[\\/\0]/.test(node.id) || [".", ".."].includes(node.id))) {
    throw new Error(`画布节点无效：${path}`);
  }
  const ids = new Set(data.nodes.map(node => node.id));
  if (ids.size !== data.nodes.length || data.edges.some(edge => !edge || !ids.has(edge.source) || !ids.has(edge.target))) {
    throw new Error(`画布节点或连线无效：${path}`);
  }
}

export async function readCanvasFiles(files: Files, path = "", options: Omit<DocumentNodeOptions, "canvasPath"> = {}) {
  const { signal, onError } = options;
  signal?.throwIfAborted();
  const entries = path ? (await files.list(path.slice(0, path.lastIndexOf("/") + 1), signal)).entries.filter(entry => entry.path === path) : (await files.list("", signal)).entries;
  signal?.throwIfAborted();
  if (path && !entries.length) throw new Error("文件或目录不存在");
  const canvases: { id: string; name: string; data: CanvasFile }[] = [];
  for (let index = 0; index < entries.length; index++) {
    signal?.throwIfAborted();
    const entry = entries[index]!;
    try {
      if (entry.type === "directory") {
        if (entry.name.toLowerCase() !== "assets") entries.push(...(await files.list(entry.path, signal)).entries);
        continue;
      }
      if (!/\.json$/i.test(entry.name) || !await isCanvasFile(files, entry.path, signal)) continue;
      const { data } = await readCanvasSnapshot(files, entry.path, signal);
      validateCopyCanvas(data, entry.path);
      canvases.push({ id: entry.path, name: entry.name.slice(0, -5), data });
    } catch (error) {
      signal?.throwIfAborted();
      if (!onError || axios.isCancel(error) || error instanceof Error && error.name === "AbortError") throw error;
      onError(entry.path, error);
    }
  }
  return canvases;
}

export async function copyCanvasFiles(files: Files, path: string, target: string, draft?: CanvasFile) {
  const canvases = draft ? [{ id: path, name: "", data: draft }] : await readCanvasFiles(files, path);
  if (!canvases.length) { await files.copy(path, target); return []; }
  if (draft) validateCopyCanvas(draft, path);
  const temporary = `.toonflowCopy${crypto.randomUUID()}`;
  const root = (await files.list()).entries;
  const assets = root.some(entry => entry.type === "directory" && entry.path === "assets") ? (await files.list("assets")).entries : [];
  const owned = new Set(assets.filter(entry => entry.type === "directory").map(entry => entry.name));
  const copiedAssets: string[] = [];
  let createdAssets = false;
  let copied = false;
  try {
    if (!draft) {
      await files.copy(path, temporary);
      copied = true;
    }
    for (const canvas of canvases) {
      const ids = new Map(canvas.data.nodes.map(node => [node.id, crypto.randomUUID()]));
      const paths = new Map<string, string>();
      for (const [id, next] of ids) {
        if (!owned.has(id)) continue;
        const destination = `assets/${next}`;
        await files.copy(`assets/${id}`, destination);
        copiedAssets.push(destination);
        paths.set(`assets/${id}`, destination);
      }
      // ACT: 节点所属素材整体独立复制；未归属本画布节点的公共素材继续引用原文件。
      const remapPath = (value: string) => {
        const normalized = value.replaceAll("\\", "/");
        for (const [source, destination] of paths) if (normalized === source || normalized.startsWith(`${source}/`)) return destination + normalized.slice(source.length);
        return value;
      };
      const remapReference = (value: string) => {
        try {
          const reference = JSON.parse(decodeURIComponent(value));
          if (Array.isArray(reference) && reference.length === 2 && ids.has(reference[0])) return encodeURIComponent(JSON.stringify([ids.get(reference[0]), reference[1]]));
        } catch { /* 普通文本不是节点参考标识。 */ }
        return value;
      };
      const remapData = (value: unknown): unknown => {
        if (typeof value === "string") return remapPath(value);
        if (Array.isArray(value)) return value.map(remapData);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapData(item)]));
        return value;
      };
      for (const node of canvas.data.nodes) {
        const id = node.id;
        const textPath = node.data?.textPath;
        const draftText = draft && node.type === "remote-textNode" && typeof node.data?.textSnapshot === "string" ? node.data.textSnapshot : undefined;
        node.id = ids.get(id)!;
        if (node.parentNode) node.parentNode = ids.get(node.parentNode) ?? node.parentNode;
        Object.assign(node, { selected: false });
        Reflect.deleteProperty(node, "initialized");
        node.data = remapData(node.data) as Node["data"];
        if (typeof textPath === "string" || draftText !== undefined) {
          const destination = `assets/${node.id}/content.md`;
          if (draftText !== undefined || typeof textPath === "string" && remapPath(textPath) !== destination) {
            if (!root.some(entry => entry.path === "assets") && !createdAssets) {
              createdAssets = await files.mkdir("assets").then(() => true, (error: { response?: { data?: { data?: { code?: string } } } }) => {
                if (error.response?.data?.data?.code !== "EEXIST") throw error;
                return false;
              });
              root.push({ name: "assets", path: "assets", type: "directory" });
            }
            if (!copiedAssets.includes(`assets/${node.id}`)) {
              await files.mkdir(`assets/${node.id}`);
              copiedAssets.push(`assets/${node.id}`);
            }
            if (draftText !== undefined) {
              const existing = await files.readTextSnapshot(destination).catch(error => {
                if (axios.isAxiosError(error) && error.response?.status === 404) return undefined;
                throw error;
              });
              if (existing) await files.writeTextSnapshot(destination, draftText, existing);
              else await files.write(destination, draftText, true);
              delete node.data.textSnapshot;
            } else if (typeof textPath === "string") await files.copy(textPath, destination);
          }
          node.data.textPath = destination;
        }
        if (node.data?.referenceOrder && typeof node.data.referenceOrder === "object") {
          for (const [handle, order] of Object.entries(node.data.referenceOrder)) {
            if (Array.isArray(order)) node.data.referenceOrder[handle] = order.map(value => typeof value === "string" ? remapReference(value) : value);
          }
        }
        if (Array.isArray(node.data?.promptModel)) for (const line of node.data.promptModel) {
          if (!Array.isArray(line)) continue;
          for (const tag of line) if (tag?.type === "Custom" && typeof tag.html === "string") {
            tag.html = tag.html.replace(/(data-reference-id=["'])([^"']+)(["'])/g, (_match: string, before: string, value: string, after: string) => before + remapReference(value) + after);
          }
        }
      }
      for (const edge of canvas.data.edges) Object.assign(edge, { id: crypto.randomUUID(), source: ids.get(edge.source)!, target: ids.get(edge.target)!, selected: false });
      const suffix = canvas.id.slice(path.length);
      if (draft) await files.writeJson(target, canvas.data, true);
      else {
        const stagingPath = temporary + suffix;
        const { disk } = await readCanvasSnapshot(files, stagingPath);
        await files.writeTextSnapshot(stagingPath, `${JSON.stringify(canvas.data, null, 2)}\n`, disk);
      }
      canvas.id = target + suffix;
      canvas.name = canvas.id.split("/").at(-1)!.slice(0, -5);
    }
    // 所有正文、素材和引用完成后才发布副本，目标已存在时仍由 rename 拒绝覆盖。
    if (!draft) await files.rename(temporary, target);
    copied = false;
    return canvases.map(({ id, name }) => ({ id, name }));
  } catch (error) {
    const cleanup = await Promise.allSettled([...copiedAssets, ...(copied ? [temporary] : [])].map(path => files.remove(path, true)));
    if (createdAssets) cleanup.push(...await Promise.allSettled([files.remove("assets")]));
    if (cleanup.some(result => result.status === "rejected")) throw new Error(`复制失败且部分副本未能清理，请检查“${target}”：${error instanceof Error ? error.message : "文件操作失败"}`);
    throw error;
  }
}
