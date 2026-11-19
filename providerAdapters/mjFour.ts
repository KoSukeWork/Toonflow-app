type ImageRequest = {
  model: string;
  prompt: string;
  images?: unknown[];
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
  if (request.model !== "imagine") throw new Error("请选择Midjourney模型");
  if (typeof request.prompt !== "string" || !request.prompt.trim()) throw new Error("请输入画图描述");
  if (request.images !== undefined && (!Array.isArray(request.images) || request.images.length)) throw new Error("此版本仅支持文字生图，不接收参考图片");
  if (request.mask !== undefined) throw new Error("此版本不支持蒙版");
  if (request.n !== undefined && request.n !== 4) throw new Error("此供应商固定返回4张图片");
  if (request.size !== undefined && request.size !== "默认") throw new Error("尺寸请选默认，实际像素由MJ决定");
  if (request.ratio !== undefined && request.ratio !== "1:1") throw new Error("此首版仅开放已确认的1:1四宫格");
  if (request.quality !== undefined) throw new Error("此版本不映射独立画质档位，使用MJ客户端设置");
  if (request.other !== undefined && (!request.other || typeof request.other !== "object"
    || Array.isArray(request.other) || Object.keys(request.other).length)) throw new Error("此版本不接受额外参数");
  let prompt = request.prompt.trim();
  const ratios = [...prompt.matchAll(/(?:^|\s)--ar\s+([^\s]+)/gi)];
  const flags = [...prompt.matchAll(/(?:^|\s)--ar\b/gi)];
  if (flags.length > 1 || flags.length !== ratios.length || ratios.some(match => match[1] !== "1:1")) {
    throw new Error("请仅使用一个--ar 1:1，或省略比例参数");
  }
  if (!ratios.length) prompt += " --ar 1:1";
  if (prompt.length > 8000) throw new Error("追加比例后的提示词不能超过8000个字符");
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

export default {
  "id": "mjFour",
  "label": "MJ（原生四张）",
  "version": "2.0.0",
  "readme": "生成一次四宫格，再顺序查询原任务的实时U1、U2、U3、U4按钮，通过返回的action_id分别创建子任务，等待并下载4张MJ原生单图。保留每张原文件的像素和格式，不进行裁切、缩放或后续Upscale动作，不保证像素比四宫格裁切更大。比切分版额外执行4个选图任务，耗时及额度按MJ规则处理；有一步失败时不伪装为完整4张。依据mj-api-bridge仓库实现，仅接入/imagine文生图，MJ版本、频道和其他模型设置沿用桥接器及原客户端。服务地址和API Key在表单配置，原客户端须保持登录和可用。首版比例仅开放已确认的1:1，尺寸选默认，实际像素由MJ模型决定，不承诺2K或4K；不接收参考图、蒙版或额外参数。每次固定返回4张；Toonflow默认显示第一张，其余可在该节点的历史记录中选择并设为当前结果。请求均带鉴权，图片从配置的桥接器下载，不依赖限时签名地址。每个提交使用独立幂等键，不自动重试生成或选图。状态不明、弹窗、下拉选择或下载失败时停止并报告任务编号，请先在桥接器处理或对账。HTTP请求最多等待120秒，整体最多2小时；取消或超时只停止本地等待，不保证取消上游任务。单张文件不超过100 MiB，失败时已生成的结果仍保存在桥接器。",
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
      "label": "Midjourney（跟随客户端设置）",
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
    }
  ],
  async generateImage(this: Context, request: ImageRequest): Promise<MediaAsset[]> {
    const settings = readInput(this, request);
    if (request.outputFormat !== undefined) throw new Error("原生四张版保留MJ文件格式，不支持指定输出编码");
    const controller = new AbortController();
    const signal = this.signal ? AbortSignal.any([this.signal, controller.signal]) : controller.signal;
    // ACT: 两小时是本地等待上限，不代表MJ队列或生成的服务承诺。
    const timeout = setTimeout(() => controller.abort(), 2 * 60 * 60 * 1000);
    const connection: Connection = { baseUrl: settings.baseUrl, headers: { Authorization: "Bearer " + settings.apiKey }, signal, tool: this.tool };
    const operation = "toonflowMj" + Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const tasks: string[] = [];
    try {
      await requireReady(connection);
      const submitted = await requestJson(connection, "/v1/tasks", { command: "imagine", prompt: settings.prompt, expect: "image" }, operation + "Grid");
      const parentId = taskId(submitted);
      tasks.push(parentId);
      const grid = await waitTask(connection, submitted);
      for (const label of ["U1", "U2", "U3", "U4"]) findAction(grid.actions, label, false);
      const result: MediaAsset[] = [];
      for (const label of ["U1", "U2", "U3", "U4"]) {
        signal.throwIfAborted();
        const controls = await requestJson(connection, "/v1/tasks/" + parentId + "/actions");
        if (taskId(controls) !== parentId) throw new Error("MJ按钮列表不属于本次四宫格");
        const action = findAction(controls.actions, label, true);
        const actionId = action.action_id as string;
        const submittedAction = await requestJson(connection, "/v1/tasks/" + parentId + "/actions",
          { action_id: actionId, expect: "image" }, operation + label);
        tasks.push(taskId(submittedAction));
        const child = await waitTask(connection, submittedAction, parentId, actionId);
        result.push(await downloadImage(connection, child));
      }
      signal.throwIfAborted();
      return result;
    } catch (error) {
      this.signal?.throwIfAborted();
      const detail = controller.signal.aborted ? "MJ等待超过2小时，请先在桥接器检查任务状态，勿重复生成"
        : this.tool.errorMessage(error) || "MJ生成失败，请检查桥接器、客户端和网络";
      throw new Error(detail + (tasks.length ? "\n已创建任务：" + tasks.join("、") : ""));
    } finally {
      clearTimeout(timeout);
    }
  },
};
