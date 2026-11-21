import { inject, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue";
import type { NodeMediaValue } from "./values";
import { useNodePreviewReady } from "./useNodePreviewReady";

type ImageSize = { width: number; height: number };
type FileUrl = { url: Promise<string>; release(): void; imageSize?(): Promise<ImageSize | undefined>; invalidated?: Readonly<Ref<boolean>> };

export interface WorkspaceFiles {
  list(path?: string): Promise<{ directory: string; entries: { name: string; path: string; type: "file" | "directory" }[] }>;
  read(path: string): Promise<ArrayBuffer>;
  acquireUrl?(path: string, mimeType: string, thumbnail?: boolean): FileUrl;
  download?(path: string, mimeType: string, fileName: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readTextSnapshot(path: string): Promise<{ text: string; revision: string; encoding: "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" }>;
  writeTextSnapshot(path: string, text: string, snapshot: { revision: string; encoding: "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" }): Promise<string>;
  readJson<T = unknown>(path: string): Promise<T>;
  write(path: string, content: string | Blob | ArrayBuffer, exclusive?: boolean): Promise<void>;
  writeJson(path: string, data: unknown, exclusive?: boolean): Promise<void>;
  rename(path: string, target: string): Promise<void>;
  remove(path: string, recursive?: boolean): Promise<void>;
  mkdir(path: string): Promise<void>;
}

function getNodeDirectory(nodeId: string) {
  if (!nodeId || /[\\/]/.test(nodeId) || nodeId === "." || nodeId === "..") throw new Error("节点 ID 不能作为文件夹名称");
  return `assets/${nodeId}`;
}

export async function uploadNodeFile(files: WorkspaceFiles, nodeId: string, file: File) {
  const directory = getNodeDirectory(nodeId);
  for (const path of ["assets", directory]) {
    await files.mkdir(path).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
      if (error.response?.data?.data?.code !== "EEXIST") throw error;
    });
  }
  const extension = file.name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0].toLowerCase() ?? "";
  const path = `${directory}/${crypto.randomUUID()}${extension}`;
  await files.write(path, file, true);
  return path;
}

export function useNodeFiles() {
  const createFiles = inject<(() => WorkspaceFiles) | undefined>("workspaceFiles", undefined);
  const retainNodeFiles = inject("retainNodeFiles", false);

  function getWorkspaceFiles() {
    if (!createFiles) throw new Error("当前画布未提供工作区文件能力");
    return createFiles();
  }

  function uploadFile(nodeId: string, file: File) {
    // ACT: 多步上传共用开始时的工作区，避免切换项目后写入另一目录。
    return uploadNodeFile(getWorkspaceFiles(), nodeId, file);
  }

  async function removeNodeFiles(nodeId: string) {
    const directory = getNodeDirectory(nodeId);
    // ACT: 支持撤销的画布保留节点素材，不随节点删除物理文件。
    if (retainNodeFiles) return;
    await getWorkspaceFiles().remove(directory, true).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
      if (error.response?.data?.data?.code !== "ENOENT") throw error;
    });
  }

  function acquireFileUrl(value: NodeMediaValue, thumbnail = false): FileUrl {
    const files = getWorkspaceFiles();
    const shared = files.acquireUrl?.(value.url, value.mimeType, thumbnail);
    if (shared) return shared;
    const url = files.read(value.url).then(content => URL.createObjectURL(new Blob([content], { type: value.mimeType })));
    return { url, release: () => { void url.then(value => URL.revokeObjectURL(value), () => {}); } };
  }

  function useFileUrl(file: MaybeRefOrGetter<NodeMediaValue | undefined>, onError: (error: unknown) => void, options?: { thumbnail?: boolean; imageSize?: Ref<ImageSize | undefined> }) {
    const fileUrl = ref("");
    const previewReady = useNodePreviewReady();
    const revision = ref(0);
    watch([() => toValue(file), previewReady, revision], async ([value, ready], _previous, onCleanup) => {
      let cancelled = false;
      let acquired: FileUrl | undefined;
      let stop: (() => void) | undefined;
      onCleanup(() => {
        cancelled = true;
        stop?.();
        acquired?.release();
      });
      fileUrl.value = "";
      if (options?.imageSize) options.imageSize.value = undefined;
      if (!value || !ready) return;
      try {
        acquired = acquireFileUrl(value, options?.thumbnail);
        if (acquired.invalidated) stop = watch(acquired.invalidated, () => revision.value++, { once: true });
        const [url, size] = await Promise.all([acquired.url, options?.imageSize ? acquired.imageSize?.() : undefined]);
        if (cancelled || acquired.invalidated?.value) return;
        if (options?.imageSize) options.imageSize.value = size;
        fileUrl.value = url;
      } catch (error) {
        if (!cancelled) onError(error);
      }
    }, { immediate: true });
    return fileUrl;
  }

  return { getWorkspaceFiles, uploadFile, removeNodeFiles, acquireFileUrl, useFileUrl };
}
