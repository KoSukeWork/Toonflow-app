type MediaInput =
  | { type: "url"; url: string; mimeType?: string; name?: string }
  | { type: "base64"; data: string; mimeType: string; name?: string }
  | { type: "binary"; data: Uint8Array; mimeType: string; name?: string };
type ImagePipeline = {
  png(options?: { compressionLevel?: number; palette?: boolean }): ImagePipeline;
  bytes(): Promise<Uint8Array>;
};
type ImageTool = { new(input: Uint8Array, options?: { maxPixels?: number }): ImagePipeline };
type ImageRequest = {
  model: string;
  prompt: string;
  images?: MediaInput[];
  mask?: unknown;
  n?: number;
  ratio?: string;
  size?: string;
  quality?: string;
  outputFormat?: string;
  other?: Record<string, unknown>;
};
type MediaAsset = { mediaType: "image"; type: "binary"; data: Uint8Array; mimeType: string };

type Context = {
  config: { baseUrl?: string; apiKey?: string };
  signal?: AbortSignal;
  tool: {
    fetch: typeof globalThis.fetch;
    errorMessage(value: unknown): string;
    image: ImageTool;

  };
};
type Connection = { baseUrl: string; headers: Record<string, string>; signal: AbortSignal; tool: Context["tool"] };
const maxImageBytes = 100 * 1024 * 1024;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + "格式无效");
  return value as Record<string, unknown>;
}

function readInput(context: Context, request: ImageRequest) {
  context.signal?.throwIfAborted();
  const base = typeof context.config.baseUrl === "string" ? context.config.baseUrl.trim() : "";
  if (!base || /\s/.test(base) || !URL.canParse(base)) throw new Error("请填写有效的MJ桥接器地址");
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("请填写HTTP(S)服务根地址，可带端口，不带路径、账号密码或查询参数");
  }
  const apiKey = typeof context.config.apiKey === "string" ? context.config.apiKey.trim() : "";
  if (apiKey.length < 24 || /\s/.test(apiKey)) throw new Error("请填写至少24个字符的原始API Key，不加Bearer前缀");
  if (request.model !== "imagine" && request.model !== "selectImage") throw new Error("请选择MJ生图或选图模型");
  if (typeof request.prompt !== "string" || !request.prompt.trim()) throw new Error("请填写画图描述，或在选图模型中只填1～4");
  if (request.images !== undefined && !Array.isArray(request.images)) throw new Error("连入图片须为数组");
  if (request.mask !== undefined) throw new Error("此供应商不支持蒙版");
  if (request.n !== undefined && request.n !== 1) throw new Error("两个模型每次都返回1张图片");
  if (request.size !== undefined && request.size !== "默认") throw new Error("尺寸请选默认，实际像素由MJ决定");
  if (request.ratio !== undefined && request.ratio !== "1:1") throw new Error("此首版仅开放已确认的1:1四宫格");
  if (request.quality !== undefined) throw new Error("此版本不映射独立画质档位，使用MJ客户端设置");
  if (request.other !== undefined && (!request.other || typeof request.other !== "object"
    || Array.isArray(request.other) || Object.keys(request.other).length)) throw new Error("此版本不接受额外参数");
  if (typeof context.tool.image !== "function") throw new Error("当前Toonflow宿主未提供图片处理能力");
  let prompt = request.prompt.trim();
  if (request.model === "selectImage") {
    if (!/^[1-4]$/.test(prompt)) throw new Error("选图模型的提示词只能填写1、2、3或4");
    if (request.images?.length !== 1) throw new Error("请连入生图模型返回的1张原始四宫格");
    if (request.outputFormat !== undefined) throw new Error("选图模型保留MJ原始单图格式，不支持指定输出编码");
  } else {
    if (request.images?.length) throw new Error("生图模型不接收参考图；连接四宫格选图时请选择选图模型");
    if (request.outputFormat !== undefined && request.outputFormat !== "png") throw new Error("生图模型固定返回携带任务记录的PNG");
    const ratios = [...prompt.matchAll(/(?:^|\s)--ar\s+([^\s]+)/gi)];
    const flags = [...prompt.matchAll(/(?:^|\s)--ar\b/gi)];
    if (flags.length > 1 || flags.length !== ratios.length || ratios.some(match => match[1] !== "1:1")) throw new Error("请仅使用一个--ar 1:1，或省略比例参数");
    if (!ratios.length) prompt += " --ar 1:1";
    if (prompt.length > 8000) throw new Error("追加比例后的提示词不能超过8000个字符");
  }
  return { baseUrl: url.origin, apiKey, prompt };
}

async function responseBytes(response: Response, signal: AbortSignal, maxBytes: number, truncate = false): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        if (!truncate) throw new Error("MJ响应超过读取上限");
        chunks.push(value.subarray(0, maxBytes - size));
        size = maxBytes;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function bridgeRequest(connection: Connection, path: string, body?: unknown, key?: string, image = false) {
  if (body !== undefined && !key) throw new Error("提交MJ操作必须提供幂等键");
  const controller = new AbortController();
  const signal = AbortSignal.any([connection.signal, controller.signal]);
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    signal.throwIfAborted();
    const headers: Record<string, string> = { ...connection.headers, Accept: image ? "image/*" : "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (key) headers["Idempotency-Key"] = key;
    const response = await connection.tool.fetch(connection.baseUrl + path, {
      method: body === undefined ? "GET" : "POST", headers,
      body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal,
    });
    const bytes = await responseBytes(response, signal, response.ok ? image ? maxImageBytes : 1024 * 1024 : 16 * 1024, !response.ok);
    if (!response.ok) {
      const detail = connection.tool.errorMessage(new TextDecoder().decode(bytes));
      throw new Error("MJ接口请求失败：HTTP " + response.status + (detail ? "，" + detail : ""));
    }
    const mimeType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (image && (!bytes.byteLength || !["image/png", "image/jpeg", "image/webp"].includes(mimeType))) throw new Error("MJ未返回有效的PNG、JPEG或WebP图片");
    signal.throwIfAborted();
    return { bytes, mimeType };
  } catch (error) {
    connection.signal.throwIfAborted();
    if (controller.signal.aborted) throw new Error("MJ接口等待超过120秒；提交结果可能未确认，请先在桥接器核实，勿重复生成");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(connection: Connection, path: string, body?: unknown, key?: string) {
  const { bytes } = await bridgeRequest(connection, path, body, key);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("MJ桥接器未返回有效JSON；提交时请先核实是否已受理"); }
  return object(value, "MJ响应");
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function taskId(task: Record<string, unknown>): string {
  if (typeof task.task_id !== "string" || !/^task_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(task.task_id)) {
    throw new Error("MJ未返回有效任务编号，请先核实提交状态，勿重新生图");
  }
  return task.task_id;
}

async function waitTask(connection: Connection, initial: Record<string, unknown>, parentId?: string, actionId?: string) {
  const id = taskId(initial);
  let task = initial;
  while (true) {
    connection.signal.throwIfAborted();
    if (taskId(task) !== id || task.parent_task_id !== (parentId ?? null)) throw new Error("MJ返回了不匹配的任务或父任务");
    const request = object(task.request, "MJ任务请求");
    if (parentId ? request.kind !== "action" || request.action_id !== actionId : request.kind !== "command" || request.command !== "imagine") {
      throw new Error("MJ返回了不匹配的任务类型或动作");
    }
    const detail = connection.tool.errorMessage(task.error);
    if (task.status === "succeeded") {
      if (task.error != null) throw new Error("MJ任务完成但仍包含错误：" + (detail || "未知错误"));
      return task;
    }
    if (task.status === "failed" || task.status === "cancelled") throw new Error("MJ任务失败或取消：" + (detail || String(task.status)));
    if (["awaiting_input", "awaiting_selection", "submission_unknown", "timed_out", "result_fetch_failed"].includes(String(task.status))) {
      throw new Error("MJ任务需要在桥接器控制台处理或对账：" + task.status + (detail ? "，" + detail : "") + "；不要重新提交");
    }
    if (!["queued", "queued_input", "preparing", "submission_attempted", "submitted", "running", "importing"].includes(String(task.status))) {
      throw new Error("MJ返回未知任务状态");
    }
    if ((task.status === "queued" || task.status === "queued_input") && task.error != null) {
      throw new Error("MJ任务仍保留在队列，请先在桥接器处理客户端状态：" + (detail || "客户端未就绪"));
    }
    await waitForPoll(connection.signal);
    task = await requestJson(connection, "/v1/tasks/" + id);
  }
}

async function requireReady(connection: Connection) {
  const health = await requestJson(connection, "/health");
  const client = object(health.client, "MJ客户端状态");
  const queue = object(health.queue, "MJ队列状态");
  if (health.service !== "mj-desktop-api-bridge" || health.authenticated !== true) throw new Error("地址不是已认证的MJ桥接器");
  if (client.ready !== true) throw new Error("MJ客户端未就绪：" + (connection.tool.errorMessage(client.message) || "请在桥接器处理登录和频道状态"));
  if (queue.paused === true || queue.blocked_task) throw new Error("MJ队列已暂停或有待处理任务，请先在桥接器控制台处理");
}

function findAction(actions: unknown, label: string, actionable: boolean): Record<string, unknown> {
  if (!Array.isArray(actions)) throw new Error("MJ未返回按钮列表");
  const matches = actions.filter(value => value && typeof value === "object" && (value as Record<string, unknown>).label === label);
  if (matches.length !== 1) throw new Error("MJ的" + label + "按钮不存在或不唯一，不能确认标准四宫格");
  const action = object(matches[0], "MJ按钮");
  if (action.kind !== "upscale" || typeof action.action_id !== "string" || !/^action_[0-9a-f]{24}$/.test(action.action_id)) throw new Error("MJ的" + label + "不是有效选图动作");
  if (actionable && (action.enabled !== true || action.visible !== true)) throw new Error("MJ的" + label + "按钮当前不可用");
  return action;
}

async function downloadImage(connection: Connection, task: Record<string, unknown>): Promise<MediaAsset> {
  if (!Array.isArray(task.images) || task.images.length !== 1) throw new Error("MJ任务未返回唯一图片，不猜测或混用多个结果");
  const image = object(task.images[0], "MJ图片信息");
  if (image.index !== 0 || image.kind !== "image" || typeof image.bytes !== "number" || !Number.isInteger(image.bytes)
    || image.bytes <= 0 || image.bytes > maxImageBytes) throw new Error("MJ图片信息无效或超过100 MiB");
  const result = await bridgeRequest(connection, "/v1/tasks/" + taskId(task) + "/images/0", undefined, undefined, true);
  if (result.bytes.byteLength !== image.bytes || result.mimeType !== image.mime) throw new Error("MJ下载内容与任务图片信息不一致");
  return { mediaType: "image", type: "binary", data: result.bytes, mimeType: result.mimeType };
}

type PngChunk = { type: string; start: number; end: number };
const recordKeyword = "toonflowMj";

function crc32(data: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngParts(input: Uint8Array): { bytes: Buffer; chunks: PngChunk[] } {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length > maxImageBytes || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
    throw new Error("选图需要本供应商生成并保留任务记录的PNG原图");
  }
  const chunks: PngChunk[] = [];
  let ended = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length || chunks.length >= 100_000) throw new Error("PNG结构不完整或区块过多");
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > bytes.length) throw new Error("PNG区块长度无效");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if ((!chunks.length && (type !== "IHDR" || length !== 13)) || (chunks.length > 0 && type === "IHDR")) throw new Error("PNG图片头无效");
    chunks.push({ type, start: offset, end });
    if (type === "IEND") {
      if (length || end !== bytes.length) throw new Error("PNG结束区块无效");
      ended = true;
      break;
    }
    offset = end;
  }
  if (!ended) throw new Error("PNG缺少结束区块");
  return { bytes, chunks };
}

function isRecordChunk(bytes: Buffer, chunk: PngChunk): boolean {
  const key = Buffer.from(recordKeyword + "\0", "ascii");
  return chunk.type === "tEXt" && chunk.end - chunk.start - 12 >= key.length
    && bytes.subarray(chunk.start + 8, chunk.start + 8 + key.length).equals(key);
}

function writeGridRecord(png: Uint8Array, id: string): Uint8Array {
  taskId({ task_id: id });
  const { bytes, chunks } = pngParts(png);
  if (chunks.some(chunk => isRecordChunk(bytes, chunk))) throw new Error("四宫格已包含MJ任务记录");
  // ACT: 只在PNG的tEXt区块记录非秘密任务号；没有全局“最近一次任务”，不依赖进程寿命。
  const data = Buffer.from(recordKeyword + "\0" + JSON.stringify({ version: 1, taskId: id }), "utf8");
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write("tEXt", 4, 4, "ascii");
  chunk.set(data, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
  const end = chunks[chunks.length - 1].start;
  const result = Buffer.concat([bytes.subarray(0, end), chunk, bytes.subarray(end)]);
  if (result.length > maxImageBytes) throw new Error("携带任务记录的图片超过100 MiB");
  return result;
}

function readGridRecord(png: Uint8Array): { taskId: string; png: Uint8Array } {
  const { bytes, chunks } = pngParts(png);
  const records = chunks.filter(chunk => isRecordChunk(bytes, chunk));
  if (records.length !== 1) throw new Error("图片没有唯一的MJ任务记录，请连接本供应商生图模型的原始四宫格，不要使用截图或切图");
  const chunk = records[0];
  if (chunk.end - chunk.start > 2048 || bytes.readUInt32BE(chunk.end - 4) !== crc32(bytes.subarray(chunk.start + 4, chunk.end - 4))) throw new Error("MJ图片任务记录损坏");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8", chunk.start + 8 + recordKeyword.length + 1, chunk.end - 4)); }
  catch { throw new Error("MJ图片任务记录无法解析"); }
  const record = object(value, "MJ图片任务记录");
  if (record.version !== 1 || Object.keys(record).length !== 2 || !Object.hasOwn(record, "taskId")) throw new Error("MJ图片任务记录版本或字段无效");
  const id = taskId({ task_id: record.taskId });
  return { taskId: id, png: Buffer.concat([bytes.subarray(0, chunk.start), bytes.subarray(chunk.end)]) };
}

async function gridPng(imageTool: ImageTool, bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  const result = await new imageTool(bytes, { maxPixels: 25_000_000 }).png({ compressionLevel: 6, palette: false }).bytes();
  signal.throwIfAborted();
  if (!result.byteLength || result.byteLength > maxImageBytes) throw new Error("四宫格为空或超过100 MiB");
  return result;
}

async function referenceBytes(connection: Connection, input: MediaInput): Promise<Uint8Array> {
  connection.signal.throwIfAborted();
  if (!input || typeof input !== "object") throw new Error("连入图片无效");
  let bytes: Uint8Array;
  if (input.type === "base64") {
    if (typeof input.data !== "string") throw new Error("连入图片Base64无效");
    const data = /^data:image\/png;base64,([\s\S]*)$/i.exec(input.data);
    const content = (data?.[1] ?? input.data).replace(/\s/g, "");
    if (!content || content.length > Math.ceil(maxImageBytes / 3) * 4 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(content) || content.length % 4 === 1) throw new Error("连入图片Base64无效或超过100 MiB");
    bytes = Buffer.from(content, "base64");
  } else if (input.type === "binary") {
    if (!ArrayBuffer.isView(input.data) || input.data.BYTES_PER_ELEMENT !== 1) throw new Error("连入图片字节无效");
    bytes = input.data;
  } else if (input.type === "url") {
    if (typeof input.url !== "string" || !URL.canParse(input.url)) throw new Error("连入图片地址无效");
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("连入图片须使用不含账号密码的HTTP(S)地址");
    const controller = new AbortController();
    const signal = AbortSignal.any([connection.signal, controller.signal]);
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      // 读取外部PNG不发送MJ的API Key。
      const response = await connection.tool.fetch(input.url, { redirect: "error", signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error("读取连入图片失败：HTTP " + response.status); }
      bytes = await responseBytes(response, signal, maxImageBytes);
    } catch (error) {
      connection.signal.throwIfAborted();
      if (controller.signal.aborted) throw new Error("读取连入图片等待超过120秒");
      throw error;
    } finally { clearTimeout(timeout); }
  } else {
    throw new Error("连入图片来源类型不支持");
  }
  if (!bytes.byteLength || bytes.byteLength > maxImageBytes) throw new Error("连入图片为空或超过100 MiB");
  connection.signal.throwIfAborted();
  return bytes;
}

export default {
  "id": "mj",
  "label": "MJ（生图与选图）",
  "version": "2.0.0",
  "readme": "一个供应商、两个模型，共用可配置的服务地址和API Key。节点A选择“生图”，填写画图描述，返回完整四宫格PNG；文件的toonflowMj文本元信息记录原MJ任务号，不含密钥。把A的图片输出连入节点B，B选择“选图”，提示词只填1、2、3或4，对应左上、右上、左下、右下；B从连入PNG读取任务号，核对图片与桥接器原任务匹配，再只执行对应的一个U动作并返回原生单图，不新建imagine任务。生成模型不裁切四宫格，选图模型不一次执行全部U，也不自动执行后续Upscale。记录随图片文件保留，不依赖全局变量或进程内最近任务；桥接器仍须保留原任务及图片，客户端须能访问原频道与消息。连接原始输出；截图、裁切、重新压缩、替换图片等操作可能丢失或破坏关联，将报错而不重新生图。图片信息中的任务号只用于配置的桥接器，外部图片地址不接收MJ密钥。两个模型每次均返回1张；首版仅1:1，尺寸默认，MJ模型、频道及其他设置沿用桥接器和原客户端，不承诺2K/4K或U操作一定增加像素。PNG处理上限2500万像素，单张文件上限100 MiB。每次提交有幂等键，不自动重试；遇弹窗、待对账或下载失败时停止并报告任务编号。每个HTTP请求最多120秒，整体最多2小时；取消或超时只停止本地等待，已提交的MJ任务可能继续。",
  "rules": [
    {
      "type": "input",
      "field": "baseUrl",
      "title": "MJ桥接器地址",
      "value": "",
      "props": {
        "placeholder": "填写含http://或https://的IP或域名，可带端口，不带路径"
      },
      "validate": [
        {
          "required": true,
          "whitespace": true,
          "message": "请填写MJ桥接器地址",
          "trigger": "blur"
        },
        {
          "type": "string",
          "pattern": "^https?://\\S+$",
          "message": "请输入HTTP(S)服务根地址",
          "trigger": "blur"
        }
      ]
    },
    {
      "type": "input",
      "field": "apiKey",
      "title": "API Key",
      "value": "",
      "props": {
        "type": "password",
        "showPassword": true,
        "autocomplete": "off",
        "placeholder": "填写桥接器的原始API Key，不加Bearer"
      },
      "validate": [
        {
          "required": true,
          "whitespace": true,
          "message": "请填写API Key",
          "trigger": "blur"
        },
        {
          "type": "string",
          "min": 24,
          "pattern": "^\\S+$",
          "message": "密钥须至少24个字符且不含空白，不加Bearer",
          "trigger": "blur"
        }
      ]
    }
  ],
  "models": [
    {
      "id": "imagine",
      "label": "1. 生图（四宫格并记录）",
      "type": "image",
      "mode": [
        "text"
      ],
      "imageSizes": [
        "默认"
      ],
      "imageRatios": [
        "1:1"
      ]
    },
    {
      "id": "selectImage",
      "label": "2. 选图（连接四宫格，输入1～4）",
      "type": "image",
      "mode": [
        "singleImage"
      ],
      "imageSizes": [
        "默认"
      ],
      "imageRatios": [
        "1:1"
      ]
    }
  ],
  async generateImage(this: Context, request: ImageRequest): Promise<MediaAsset[]> {
    const settings = readInput(this, request);
    const controller = new AbortController();
    const signal = this.signal ? AbortSignal.any([this.signal, controller.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(), 2 * 60 * 60 * 1000);
    const connection: Connection = { baseUrl: settings.baseUrl, headers: { Authorization: "Bearer " + settings.apiKey }, signal, tool: this.tool };
    const tasks: string[] = [];
    try {
      if (request.model === "imagine") {
        await requireReady(connection);
        const key = "toonflowMjGrid" + Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        const submitted = await requestJson(connection, "/v1/tasks", { command: "imagine", prompt: settings.prompt, expect: "image" }, key);
        const id = taskId(submitted);
        tasks.push(id);
        const grid = await waitTask(connection, submitted);
        for (const label of ["U1", "U2", "U3", "U4"]) findAction(grid.actions, label, false);
        const image = await downloadImage(connection, grid);
        const png = await gridPng(this.tool.image, image.data, signal);
        const data = writeGridRecord(png, id);
        signal.throwIfAborted();
        return [{ mediaType: "image", type: "binary", data, mimeType: "image/png" }];
      }
      const bytes = await referenceBytes(connection, request.images![0]);
      const record = readGridRecord(bytes);
      const parentId = record.taskId;
      tasks.push(parentId);
      await requireReady(connection);
      const parent = await requestJson(connection, "/v1/tasks/" + parentId);
      if (taskId(parent) !== parentId || parent.status !== "succeeded") throw new Error("图片对应的原MJ任务尚未完成或已不可用，请先在桥接器核实");
      const grid = await waitTask(connection, parent);
      const original = await downloadImage(connection, grid);
      const expected = await gridPng(this.tool.image, original.data, signal);
      const connected = await gridPng(this.tool.image, record.png, signal);
      // 不信任PNG内的任务号本身；先核对连接的四宫格，避免记录被改写后选错任务。
      if (!Buffer.from(connected).equals(Buffer.from(expected))) throw new Error("连入图片与原MJ四宫格不匹配，请连接生图模型的原始输出");
      const controls = await requestJson(connection, "/v1/tasks/" + parentId + "/actions");
      if (taskId(controls) !== parentId) throw new Error("MJ按钮列表不属于连入图片的原任务");
      const action = findAction(controls.actions, "U" + settings.prompt, true);
      const actionId = action.action_id as string;
      const key = "toonflowMjSelect" + parentId + actionId;
      const submitted = await requestJson(connection, "/v1/tasks/" + parentId + "/actions",
        { action_id: actionId, expect: "image" }, key);
      tasks.push(taskId(submitted));
      const child = await waitTask(connection, submitted, parentId, actionId);
      const selected = await downloadImage(connection, child);
      signal.throwIfAborted();
      return [selected];
    } catch (error) {
      this.signal?.throwIfAborted();
      const detail = controller.signal.aborted ? "MJ等待超过2小时，请先在桥接器检查任务状态，勿重复生成"
        : this.tool.errorMessage(error) || "MJ生成或选图失败，请检查图片来源、桥接器和客户端";
      throw new Error(detail + (tasks.length ? "\n相关任务：" + tasks.join("、") : ""));
    } finally {
      clearTimeout(timeout);
    }
  },
};
