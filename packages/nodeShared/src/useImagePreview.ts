import { onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import { useNodeFiles } from "@toonflow/nodes-scaffold/workspaceFiles";
import type { NodeMediaValue } from "@toonflow/nodes-scaffold/values";

export function useImagePreview(file: MaybeRefOrGetter<NodeMediaValue | undefined>, onError: (error: unknown) => void) {
  const files = useNodeFiles();
  const imageSize = ref<{ width: number; height: number }>();
  const previewUrl = files.useFileUrl(file, onError, { thumbnail: true, imageSize });
  const originalUrl = ref("");
  let original: ReturnType<typeof files.acquireFileUrl> | undefined;
  let stopWatching: (() => void) | undefined;

  function release() {
    originalUrl.value = "";
    stopWatching?.();
    original?.release();
    original = undefined;
  }

  watch(() => toValue(file), release, { flush: "sync" });
  onScopeDispose(release);

  async function loadOriginal() {
    const source = toValue(file);
    if (!source) return "";
    let acquired: typeof original;
    try {
      const next = files.acquireFileUrl(source);
      if (original?.url === next.url) next.release();
      else {
        release();
        original = next;
        stopWatching = next.invalidated && watch(next.invalidated, release, { flush: "sync", once: true });
      }
      acquired = original;
      const url = await acquired?.url;
      if (acquired !== original || !url) return "";
      originalUrl.value = url;
      return url;
    } catch (error) {
      if (acquired === original) {
        release();
        onError(error);
      }
      return "";
    }
  }

  async function downloadOriginal() {
    const source = toValue(file);
    if (!source) return;
    const name = source.url.split(/[\\/]/).at(-1) || "image";
    const workspace = files.getWorkspaceFiles();
    if (workspace.download) {
      await workspace.download(source.url, source.mimeType, name);
      return;
    }
    // 旧宿主仍可用原图 Blob URL，沿用宿主对下载链接的处理。
    const url = await loadOriginal();
    if (!url) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
  }

  return { previewUrl, imageSize, originalUrl, loadOriginal, downloadOriginal };
}
