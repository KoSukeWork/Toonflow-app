import { open } from "@toonflow/file";
import { createHash } from "node:crypto";
import { extname } from "node:path";
import type { Response } from "express";

const formats: Readonly<Record<string, "png" | "jpeg" | "webp">> = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp" };
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const previewSize = 512;
const maxSourceBytes = 24 * 1024 * 1024;
const maxPreviewBytes = 32 * 1024 * 1024;
const maxPreviewEntries = 256;
const maxActive = 3;
const maxWaiting = 48;
const waiting: (() => void)[] = [];
let active = 0;

type Preview = { bytes: Buffer; width: number; height: number; digest: string };
const previews = new Map<string, Preview | undefined>();
const converting = new Map<string, Promise<Preview | undefined>>();
let previewBytes = 0;

function digest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stillImage(bytes: Buffer, format: "png" | "jpeg" | "webp") {
  if (format === "jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (format === "png") {
    if (!bytes.subarray(0, 8).equals(pngSignature)) return false;
    // APNG 和有 EXIF 的 PNG 交给浏览器，以保留动画和方向。
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const next = offset + 12 + bytes.readUInt32BE(offset);
      if (next > bytes.length) return false;
      const kind = bytes.toString("ascii", offset + 4, offset + 8);
      if (kind === "acTL" || kind === "eXIf") return false;
      if (kind === "IEND") return true;
      offset = next;
    }
    return false;
  }
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return false;
  // VP8X 标记动画和 EXIF，其他 WebP 格式没有这些扩展特性。
  const kind = bytes.toString("ascii", 12, 16);
  return kind === "VP8 " || kind === "VP8L" || (kind === "VP8X" && bytes.length > 20 && !(bytes[20]! & 0x0a));
}

async function convertPreview(bytes: Buffer, format: string): Promise<Preview | undefined> {
  if (typeof Bun.Image !== "function") return;
  try {
    const image = new Bun.Image(bytes, { maxPixels: 24_000_000, autoOrient: true });
    const dimensions = await image.metadata();
    if (dimensions.format !== format || Math.max(dimensions.width, dimensions.height) <= previewSize) return;
    const resized = await image.resize(previewSize, previewSize, { fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).buffer();
    if (resized.length >= bytes.length) return;
    // JPEG 的 EXIF 旋转可交换输出宽高。布局使用原尺寸比例，避免缩略图像素取整改变节点宽度。
    const swapped = (dimensions.width - dimensions.height) * (image.width - image.height) < 0;
    return {
      bytes: resized,
      width: swapped ? dimensions.height : dimensions.width,
      height: swapped ? dimensions.width : dimensions.height,
      digest: digest(resized),
    };
  } catch { /* 可选解码能力不足或原图无法转换时仍可读取原图。 */ }
}

function getPreview(sourceDigest: string, bytes: Buffer, format: string) {
  if (previews.has(sourceDigest)) {
    const preview = previews.get(sourceDigest);
    previews.delete(sourceDigest);
    previews.set(sourceDigest, preview);
    return preview;
  }
  const pending = converting.get(sourceDigest);
  if (pending) return pending;
  const conversion = convertPreview(bytes, format).then(preview => {
    previews.set(sourceDigest, preview);
    previewBytes += preview?.bytes.length ?? 0;
    while (previewBytes > maxPreviewBytes || previews.size > maxPreviewEntries) {
      const oldest = previews.keys().next().value!;
      previewBytes -= previews.get(oldest)?.bytes.length ?? 0;
      previews.delete(oldest);
    }
    return preview;
  }).finally(() => { converting.delete(sourceDigest); });
  converting.set(sourceDigest, conversion);
  return conversion;
}

// 调用方必须先解析并授权真实文件路径。读取原始字节计算版本，覆盖原地替换、移动和恢复旧文件。
export async function sendStaticImage(res: Response, path: string, size: number, thumbnail: boolean) {
  const format = formats[extname(path).toLowerCase()];
  const request = res.req;
  if (!format || !size || size > maxSourceBytes || request.get("range")) return false;
  // ACT: 同时最多读取及转换 3 张，排队时只持有请求，溢出沿用原图流式响应。
  if (active >= maxActive) {
    if (waiting.length >= maxWaiting) return false;
    await new Promise<void>(resolve => { waiting.push(resolve); });
  } else active++;
  try {
    if (res.destroyed || request.aborted) return true;
    const file = await open(path, "r");
    let bytes: Buffer;
    try {
      const info = await file.stat();
      if (!info.isFile() || !info.size || info.size > maxSourceBytes) return false;
      bytes = await file.readFile();
    } finally { await file.close(); }
    if (bytes.length > maxSourceBytes || !stillImage(bytes, format)) return false;
    if (res.destroyed || request.aborted) return true;
    const sourceDigest = digest(bytes);
    const preview = thumbnail ? await getPreview(sourceDigest, bytes, format) : undefined;
    if (res.destroyed || request.aborted) return true;
    const etag = '"' + (thumbnail ? "preview-" : "original-") + sourceDigest + (preview ? "-" + preview.digest : "") + '"';
    res.set({ "Cache-Control": "private, no-cache", ETag: etag });
    if (request.app.locals.accounts) {
      res.vary("Cookie");
      res.vary("X-Toonflow-User");
    }
    const matches = request.get("if-none-match")?.split(",").some(value => {
      const tag = value.trim();
      return tag === "*" || tag.replace(/^W\//, "") === etag;
    });
    if (matches) {
      res.status(304).end();
      return true;
    }
    if (preview) res.set("X-Toonflow-Image-Size", preview.width + "x" + preview.height);
    res.type(preview ? "image/webp" : "image/" + format).send(preview?.bytes ?? bytes);
    return true;
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
