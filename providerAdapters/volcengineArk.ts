type MediaInput =
  | { type: "url"; url: string; mimeType?: string; name?: string }
  | { type: "base64"; data: string; mimeType: string; name?: string }
  | { type: "binary"; data: Uint8Array; mimeType: string; name?: string };

type ImageRequest = {
  model: string;
  prompt: string;
  images?: MediaInput[];
  mask?: MediaInput;
  n?: number;
  ratio?: string;
  size?: string;
  quality?: string;
  outputFormat?: string;
  other?: Record<string, unknown>;
};

type MediaAsset = { mediaType: "image"; type: "binary"; data: Uint8Array; mimeType: string };

type Context = {
  config: { apiKey?: string };
  signal?: AbortSignal;
  tool: {
    fetch: typeof globalThis.fetch;
    errorMessage(value: unknown): string;
    media: { inspectImage(input: MediaInput): Promise<{ width: number; height: number; format: string }> };
  };
};

// 尺寸来自火山方舟图片生成 API 的 Seedream 5.5 图片生成场景说明。
const imageDimensions: Record<string, Record<string, string>> = {
  "1K": {
    "1:1": "1024x1024", "4:3": "1152x864", "3:4": "864x1152", "16:9": "1424x800",
    "9:16": "800x1424", "3:2": "1248x832", "2:3": "832x1248", "21:9": "1568x672",
  },
  "1.5K": {
    "1:1": "1536x1536", "4:3": "1792x1344", "3:4": "1344x1792", "16:9": "2048x1152",
    "9:16": "1152x2048", "3:2": "1872x1248", "2:3": "1248x1872", "21:9": "2352x1008",
  },
  "2K": {
    "1:1": "2048x2048", "4:3": "2368x1776", "3:4": "1776x2368", "16:9": "2816x1584",
    "9:16": "1584x2816", "3:2": "2496x1664", "2:3": "1664x2496", "21:9": "3136x1344",
  },
};

function base64Bytes(value: string, maxBytes: number, label: string): Uint8Array {
  const content = value.replace(/\s/g, "");
  if (!content || content.length > Math.ceil(maxBytes / 3) * 4
    || !/^[a-zA-Z0-9+/]+={0,2}$/.test(content) || content.length % 4 === 1) {
    throw new Error(`${label}的 Base64 内容无效或文件过大`);
  }
  const bytes = Buffer.from(content, "base64");
  if (!bytes.byteLength || bytes.byteLength > maxBytes) throw new Error(`${label}为空或文件过大`);
  return bytes;
}

async function imageReference(context: Context, input: MediaInput, index: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const label = `参考图 ${index + 1}`;
  if (!input || typeof input !== "object") throw new Error(`${label}内容无效`);
  if (input.type === "url") {
    if (typeof input.url !== "string" || !URL.canParse(input.url)) throw new Error(`${label}地址无效`);
    const url = new URL(input.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      throw new Error(`${label}须使用不含账号密码的 HTTP(S) 图片地址`);
    }
    // ACT: URL 图片由平台校验格式、30 MB 和尺寸限制，避免本地重复下载。
    return input.url;
  }
  if (input.type !== "base64" && input.type !== "binary") throw new Error(`${label}来源类型不支持`);
  const mimeType = typeof input.mimeType === "string" ? input.mimeType.toLowerCase() : "";
  if (!["image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff", "image/gif", "image/heic", "image/heif"].includes(mimeType)) {
    throw new Error(`${label}格式须为 JPEG、PNG、WebP、BMP、TIFF、GIF、HEIC 或 HEIF`);
  }
  let bytes: Uint8Array;
  if (input.type === "base64") {
    if (typeof input.data !== "string") throw new Error(`${label}的 Base64 内容无效`);
    const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(input.data);
    if (dataUrl && dataUrl[1].toLowerCase() !== mimeType) throw new Error(`${label}的图片格式与内容声明不一致`);
    bytes = base64Bytes(dataUrl?.[2] ?? input.data, 30_000_000, label);
  } else {
    if (!ArrayBuffer.isView(input.data) || input.data.BYTES_PER_ELEMENT !== 1) throw new Error(`${label}的图片字节无效`);
    bytes = input.data;
  }
  if (!bytes.byteLength || bytes.byteLength > 30_000_000) throw new Error(`${label}须为非空图片且不超过30 MB`);
  const info = await context.tool.media.inspectImage({ type: "binary", data: bytes, mimeType });
  signal.throwIfAborted();
  if (!Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width <= 14 || info.height <= 14
    || info.width * info.height > 36_000_000 || info.width / info.height < 1 / 16 || info.width / info.height > 16) {
    throw new Error(`${label}的宽高须大于14像素，总像素不超过3600万，宽高比须在1:16至16:1之间`);
  }
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

export default {
  id: "volcengineArk",
  label: "火山方舟",
  version: "2.0.0",
  readme: "接入火山方舟官方 Seedream 5.5（doubao-seedream-5-5-261028）。支持文字画图、单张或最多10张参考图，每次生成1张。分辨率可选1K、1.5K、2K，未指定时默认2K；选择画面比例时按官方尺寸表转换。支持PNG、JPEG输出，默认PNG，水印沿用平台默认设置。请先在火山方舟开通该模型，再在本供应商配置中填写API Key，不要在聊天中发送密钥。URL参考图须能被平台访问；本地参考图不超过30 MB。不支持蒙版、独立画质档位、组图或额外参数。不会自动重试生成请求。官方文档：https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh",
  rules: [
    {
      type: "input",
      field: "apiKey",
      title: "API Key",
      value: "",
      props: { type: "password", showPassword: true, autocomplete: "off", placeholder: "在此填写火山方舟的 API Key" },
      validate: [
        { required: true, whitespace: true, message: "请填写火山方舟的 API Key", trigger: "blur" },
        { type: "string", pattern: "^\\S+$", message: "API Key 不能包含空白字符", trigger: "blur" },
      ],
    },
  ],
  models: [
    {
      id: "doubao-seedream-5-5-261028",
      label: "Seedream 5.5",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1K", "1.5K", "2K"],
      imageRatios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    },
  ],
  async generateImage(this: Context, request: ImageRequest): Promise<MediaAsset[]> {
    this.signal?.throwIfAborted();
    const apiKey = typeof this.config.apiKey === "string" ? this.config.apiKey.trim() : "";
    if (!apiKey || /\s/.test(apiKey)) throw new Error("请在供应商配置中填写有效的火山方舟 API Key");
    if (request.model !== "doubao-seedream-5-5-261028") throw new Error("此适配文件仅支持 Seedream 5.5");
    if (typeof request.prompt !== "string" || !request.prompt.trim()) throw new Error("请输入画图描述");
    if (request.mask !== undefined) throw new Error("此适配文件不支持蒙版，请使用参考图和文字描述编辑图片");
    if (request.n !== undefined && request.n !== 1) throw new Error("Seedream 5.5 每次只能生成1张图片");
    if (request.quality !== undefined) throw new Error("Seedream 5.5 不支持独立画质档位，请选择分辨率");
    if (request.other !== undefined && (!request.other || typeof request.other !== "object"
      || Array.isArray(request.other) || Object.keys(request.other).length)) throw new Error("此适配文件不接受额外参数");
    if (request.images !== undefined && !Array.isArray(request.images)) throw new Error("参考图须为图片数组");
    const references = request.images ?? [];
    if (references.length > 10) throw new Error("Seedream 5.5 最多支持10张参考图");
    const size = request.size ?? "2K";
    if (typeof size !== "string" || !Object.hasOwn(imageDimensions, size)) throw new Error("分辨率请选择1K、1.5K或2K");
    const dimensions = imageDimensions[size];
    if (request.ratio !== undefined && (typeof request.ratio !== "string" || !Object.hasOwn(dimensions, request.ratio))) {
      throw new Error("画面比例请选择1:1、4:3、3:4、16:9、9:16、3:2、2:3或21:9");
    }
    const outputFormat = request.outputFormat ?? "png";
    if (outputFormat !== "png" && outputFormat !== "jpeg") throw new Error("输出图片格式仅支持png或jpeg");
    const controller = new AbortController();
    const signal = this.signal ? AbortSignal.any([this.signal, controller.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(), 300_000);
    try {
      const images: string[] = [];
      for (let index = 0; index < references.length; index++) {
        images.push(await imageReference(this, references[index], index, signal));
      }
      signal.throwIfAborted();
      const body: Record<string, unknown> = {
        model: request.model,
        prompt: request.prompt.trim(),
        size: request.ratio === undefined ? size : dimensions[request.ratio],
        output_format: outputFormat,
        response_format: "b64_json",
      };
      if (images.length) body.image = images;
      const response = await this.tool.fetch("https://ark.cn-beijing.volces.com/api/v3/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
      let result: unknown;
      try { result = await response.json(); }
      catch {
        signal.throwIfAborted();
        throw new Error(response.ok ? "火山方舟未返回有效的JSON结果" : `图片生成请求失败：HTTP ${response.status}`);
      }
      signal.throwIfAborted();
      if (!response.ok) {
        const detail = this.tool.errorMessage(result);
        throw new Error(`图片生成请求失败：HTTP ${response.status}${detail ? `，${detail}` : ""}`);
      }
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("火山方舟返回的图片结果格式无效");
      const payload = result as Record<string, unknown>;
      if (payload.error != null) throw new Error(`图片生成失败：${this.tool.errorMessage(payload.error) || "平台返回错误"}`);
      if (!Array.isArray(payload.data) || payload.data.length !== 1) throw new Error("火山方舟未返回单张图片结果");
      const image: unknown = payload.data[0];
      if (!image || typeof image !== "object" || Array.isArray(image)) throw new Error("火山方舟返回的图片内容无效");
      const asset = image as Record<string, unknown>;
      if (asset.error != null) throw new Error(`图片生成失败：${this.tool.errorMessage(asset.error) || "平台返回错误"}`);
      if (typeof asset.b64_json !== "string") throw new Error("火山方舟未返回图片的Base64内容");
      const bytes = base64Bytes(asset.b64_json, 100_000_000, "生成图片");
      signal.throwIfAborted();
      return [{ mediaType: "image", type: "binary", data: bytes, mimeType: `image/${outputFormat}` }];
    } catch (error) {
      this.signal?.throwIfAborted();
      if (controller.signal.aborted) throw new Error("图片生成等待超过5分钟，请先在火山方舟查看请求状态，避免重复付费生成");
      throw new Error(this.tool.errorMessage(error) || "图片生成失败，请检查网络和供应商配置");
    } finally {
      clearTimeout(timeout);
    }
  },
};
