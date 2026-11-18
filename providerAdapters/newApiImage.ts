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

type MediaAsset = { mediaType: "image"; type: "binary"; data: Uint8Array; mimeType: "image/png" };

type Context = {
  config: { baseUrl?: string; apiKey?: string; responsesModel?: string };
  signal?: AbortSignal;
  tool: { fetch: typeof globalThis.fetch; errorMessage(value: unknown): string };
};

function base64Bytes(value: string, label: string): Uint8Array {
  const content = value.replace(/\s/g, "");
  // ACT: 与宿主媒体文件限制保持一致，单个本地输入或输出最多100 MB；不是平台能力声明。
  if (!content || content.length > Math.ceil(100_000_000 / 3) * 4
    || !/^[a-zA-Z0-9+/]+={0,2}$/.test(content) || content.length % 4 === 1) {
    throw new Error(`${label}的Base64内容无效或超过100 MB`);
  }
  const bytes = Buffer.from(content, "base64");
  if (!bytes.byteLength || bytes.byteLength > 100_000_000) throw new Error(`${label}为空或超过100 MB`);
  return bytes;
}

function imageReference(input: MediaInput, index: number): string {
  const label = `参考图 ${index + 1}`;
  if (!input || typeof input !== "object") throw new Error(`${label}内容无效`);
  if (input.type === "url") {
    if (typeof input.url !== "string" || !URL.canParse(input.url)) throw new Error(`${label}地址无效`);
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error(`${label}须使用不含账号密码的HTTP(S)图片地址`);
    }
    return input.url;
  }
  if (input.type !== "base64" && input.type !== "binary") throw new Error(`${label}来源类型不支持`);
  const mimeType = typeof input.mimeType === "string" ? input.mimeType.toLowerCase() : "";
  if (!/^image\/[a-z0-9][a-z0-9.+-]*$/.test(mimeType)) throw new Error(`${label}缺少有效的图片格式`);
  let bytes: Uint8Array;
  if (input.type === "base64") {
    if (typeof input.data !== "string") throw new Error(`${label}的Base64内容无效`);
    const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(input.data);
    if (dataUrl && dataUrl[1].toLowerCase() !== mimeType) throw new Error(`${label}的图片格式与内容声明不一致`);
    bytes = base64Bytes(dataUrl?.[2] ?? input.data, label);
  } else {
    if (!ArrayBuffer.isView(input.data) || input.data.BYTES_PER_ELEMENT !== 1) throw new Error(`${label}的图片字节无效`);
    bytes = input.data;
    if (!bytes.byteLength || bytes.byteLength > 100_000_000) throw new Error(`${label}为空或超过100 MB`);
  }
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

async function responseText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      // ACT: 沿用skill的完整响应解析，最多读取200 MB；需要更大输出时再改为逐事件处理。
      if (bytes > 200_000_000) throw new Error("平台响应超过适配器的200 MB读取上限");
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    return parts.join("") + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function imageResult(value: unknown, context: Context): string | undefined {
  const pending: unknown[] = [value];
  let result: string | undefined;
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index--) pending.push(item[index]);
      continue;
    }
    const entry = item as Record<string, unknown>;
    if (entry.error != null || entry.type === "error") {
      throw new Error(`图片生成失败：${context.tool.errorMessage(entry.error ?? entry) || "平台返回错误"}`);
    }
    if (entry.type === "image_generation_call" && typeof entry.result === "string" && entry.result) {
      result ??= entry.result;
    }
    const children = Object.values(entry);
    for (let index = children.length - 1; index >= 0; index--) {
      if (children[index] && typeof children[index] === "object") pending.push(children[index]);
    }
  }
  return result;
}

function imageFromResponse(raw: string, context: Context): string {
  const text = raw.trim();
  let result: string | undefined;
  if (text.startsWith("{")) {
    let payload: unknown;
    try { payload = JSON.parse(text); }
    catch { throw new Error("平台返回的JSON结果不完整或无法解析"); }
    result = imageResult(payload, context);
  } else {
    for (const block of text.replace(/\r\n?/g, "\n").split("\n\n")) {
      const data = block.split("\n").filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trim()).join("\n").trim();
      if (!data || data === "[DONE]") continue;
      let payload: unknown;
      try { payload = JSON.parse(data); }
      catch { throw new Error("平台返回的流式事件不完整或无法解析"); }
      const image = imageResult(payload, context);
      result ??= image;
    }
  }
  if (!result) throw new Error("平台未返回最终图片，请确认调用模型支持image_generation图片工具");
  return result;
}

export default {
  id: "newApiImage",
  label: "NewAPI GPT Image",
  version: "2.0.0",
  readme: "依据newapi-imagegen skill及其newapi_responses_image.py脚本适配。通过配置的基础地址追加/responses，以Bearer密钥调用image_generation工具。支持文字画图和单张、多张参考图；参考图可使用HTTP(S)地址、Base64或内存字节，具体格式及数量限制由平台校验。当前仅启用已确认的默认参数：1024x1024、1:1、high画质、PNG格式。调用模型初始值沿用当前Codex配置的gpt-6.1-sol，可在表单修改；此字段是Responses调用模型，图片工具不传model、background或action，由平台选择默认图片模型和行为。与skill一致，取首个image_generation_call.result作为最终图片；不返回预览图或任务编号。平台地址和密钥由表单填写，不读取本机Codex配置或凭据文件。单次最多等待15分钟，不自动重试；本地单图及结果上限100 MB，完整响应读取上限200 MB。不支持蒙版、组图数量控制或额外参数。",
  rules: [
    {
      type: "input",
      field: "baseUrl",
      title: "平台基础地址",
      value: "",
      props: { placeholder: "填写Codex中配置的base_url，保留原有路径，不含/responses" },
      validate: [
        { required: true, whitespace: true, message: "请填写平台基础地址", trigger: "blur" },
        { type: "string", pattern: "^https?://\\S+$", message: "请输入HTTP(S)基础地址", trigger: "blur" },
      ],
    },
    {
      type: "input",
      field: "apiKey",
      title: "API Key",
      value: "",
      props: { type: "password", showPassword: true, autocomplete: "off", placeholder: "在此填写平台的API Key" },
      validate: [
        { required: true, whitespace: true, message: "请填写API Key", trigger: "blur" },
        { type: "string", pattern: "^\\S+$", message: "API Key不能包含空白字符", trigger: "blur" },
      ],
    },
    {
      type: "input",
      field: "responsesModel",
      title: "调用模型（Responses）",
      value: "gpt-6.1-sol",
      props: { placeholder: "填写平台支持图片工具的Responses模型名" },
      validate: [
        { required: true, whitespace: true, message: "请填写调用模型", trigger: "blur" },
        { type: "string", pattern: "^\\S+$", message: "调用模型名不能包含空白字符", trigger: "blur" },
      ],
    },
  ],
  models: [
    {
      id: "gptImageDefault",
      label: "GPT Image（平台默认）",
      type: "image",
      mode: ["text", "singleImage", "multiReference"],
      imageSizes: ["1024x1024"],
      imageRatios: ["1:1"],
    },
  ],
  async generateImage(this: Context, request: ImageRequest): Promise<MediaAsset[]> {
    this.signal?.throwIfAborted();
    const apiKey = typeof this.config.apiKey === "string" ? this.config.apiKey.trim() : "";
    if (!apiKey || /\s/.test(apiKey)) throw new Error("请在供应商配置中填写有效的API Key");
    const baseUrl = typeof this.config.baseUrl === "string" ? this.config.baseUrl.trim().replace(/\/+$/, "") : "";
    if (!baseUrl || !URL.canParse(baseUrl)) throw new Error("请填写有效的平台基础地址");
    const url = new URL(baseUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("平台基础地址须为不含账号密码、查询参数或片段的HTTP(S)地址");
    }
    if (url.pathname.endsWith("/responses")) throw new Error("请填写平台基础地址，去掉末尾的/responses");
    const responsesModel = typeof this.config.responsesModel === "string" ? this.config.responsesModel.trim() : "";
    if (!responsesModel || /\s/.test(responsesModel)) throw new Error("请填写有效的Responses调用模型");
    if (request.model !== "gptImageDefault") throw new Error("请选择GPT Image（平台默认）模型");
    if (typeof request.prompt !== "string" || !request.prompt.trim()) throw new Error("请输入画图描述");
    if (request.images !== undefined && !Array.isArray(request.images)) throw new Error("参考图须为图片数组");
    if (request.mask !== undefined) throw new Error("此适配文件暂不支持蒙版");
    if (request.n !== undefined && request.n !== 1) throw new Error("此适配文件仅返回首张最终图片，不支持指定生成数量");
    if (request.size !== undefined && request.size !== "1024x1024") throw new Error("当前仅启用默认尺寸1024x1024");
    if (request.ratio !== undefined && request.ratio !== "1:1") throw new Error("当前仅启用1:1方形图片");
    if (request.quality !== undefined && request.quality !== "high") throw new Error("当前仅启用high高清画质");
    if (request.outputFormat !== undefined && request.outputFormat !== "png") throw new Error("当前仅启用PNG输出格式");
    if (request.other !== undefined && (!request.other || typeof request.other !== "object"
      || Array.isArray(request.other) || Object.keys(request.other).length)) throw new Error("此适配文件不接受额外参数");
    const controller = new AbortController();
    const signal = this.signal ? AbortSignal.any([this.signal, controller.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(), 900_000);
    try {
      const content: Record<string, string>[] = [{ type: "input_text", text: request.prompt.trim() }];
      for (const [index, input] of (request.images ?? []).entries()) {
        signal.throwIfAborted();
        content.push({ type: "input_image", image_url: imageReference(input, index) });
      }
      signal.throwIfAborted();
      const response = await this.tool.fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          model: responsesModel,
          input: [{ role: "user", content }],
          tools: [{ type: "image_generation", size: "1024x1024", quality: "high", output_format: "png" }],
          stream: true,
        }),
        signal,
      });
      const raw = await responseText(response, signal);
      signal.throwIfAborted();
      if (!response.ok) {
        const detail = this.tool.errorMessage(raw);
        throw new Error(`图片生成请求失败：HTTP ${response.status}${detail ? `，${detail}` : ""}`);
      }
      const bytes = base64Bytes(imageFromResponse(raw, this), "生成图片");
      const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
      if (!pngSignature.every((value, index) => bytes[index] === value)) throw new Error("平台返回的图片不是约定的PNG格式");
      signal.throwIfAborted();
      return [{ mediaType: "image", type: "binary", data: bytes, mimeType: "image/png" }];
    } catch (error) {
      this.signal?.throwIfAborted();
      if (controller.signal.aborted) throw new Error("图片生成等待超过15分钟，请先在平台核实此次调用是否完成，避免重复付费");
      throw new Error(this.tool.errorMessage(error) || "图片生成失败，请检查网络和供应商配置");
    } finally {
      clearTimeout(timeout);
    }
  },
};
