type MediaInput =
  | { type: "url"; url: string; mimeType?: string; name?: string }
  | { type: "base64"; data: string; mimeType: string; name?: string }
  | { type: "binary"; data: Uint8Array; mimeType: string; name?: string };

type VideoMode = "text" | "singleImage" | "startEndRequired" | "endFrameOptional" | "startFrameOptional"
  | (`${"image" | "video" | "audio"}Reference:${number}`)[];

type VideoRequest = {
  model: string;
  prompt: string;
  mode?: VideoMode;
  images?: MediaInput[];
  videos?: MediaInput[];
  audios?: MediaInput[];
  firstFrame?: MediaInput;
  lastFrame?: MediaInput;
  duration?: number;
  ratio?: string;
  resolution?: string;
  generateAudio?: boolean;
  watermark?: boolean;
  other?: Record<string, unknown>;
};

type MediaAsset = { mediaType: "video"; type: "binary"; data: Uint8Array; mimeType: "video/mp4" };
type Context = {
  config: { baseUrl?: string; apiKey?: string };
  signal?: AbortSignal;
  tool: { fetch: typeof globalThis.fetch; errorMessage(value: unknown): string };
};
type Connection = { baseUrl: string; headers: Record<string, string>; signal: AbortSignal; tool: Context["tool"] };
type FetchOptions = {
  label: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | Blob;
  maxBytes?: number;
  mimeType?: string;
};
type Condition = { type: "image"; file_id: string; role: "keyframe" | "reference"; frame_index?: number };

const maxMediaBytes = 100 * 1024 * 1024;

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
        if (!truncate) throw new Error(`响应超过${Math.round(maxBytes / 1024)} KiB读取上限`);
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

async function fetchBytes(connection: Connection, url: string, options: FetchOptions): Promise<Uint8Array> {
  const controller = new AbortController();
  const signal = AbortSignal.any([connection.signal, controller.signal]);
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    signal.throwIfAborted();
    const response = await connection.tool.fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      redirect: "error",
      signal,
    });
    const bytes = await responseBytes(response, signal, response.ok ? options.maxBytes ?? 64 * 1024 : 16 * 1024, !response.ok);
    if (!response.ok) {
      const detail = connection.tool.errorMessage(new TextDecoder().decode(bytes));
      throw new Error(`${options.label}失败：HTTP ${response.status}${detail ? `，${detail}` : ""}`);
    }
    if (options.mimeType && response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== options.mimeType) {
      throw new Error(`${options.label}未返回约定的${options.mimeType}内容`);
    }
    signal.throwIfAborted();
    return bytes;
  } catch (error) {
    connection.signal.throwIfAborted();
    if (controller.signal.aborted) throw new Error(`${options.label}等待超过120秒；提交超时时请先核实服务端是否已受理，避免重复生成`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(connection: Connection, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const headers = { ...connection.headers, "Content-Type": "application/json", Accept: "application/json" };
  const bytes = await fetchBytes(connection, connection.baseUrl + path, {
    label: "H3接口请求", method: body === undefined ? "GET" : "POST", headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("H3接口未返回有效的JSON结果"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("H3接口返回格式无效");
  return value as Record<string, unknown>;
}

async function imageBytes(connection: Connection, input: MediaInput, label: string): Promise<Uint8Array> {
  connection.signal.throwIfAborted();
  if (!input || typeof input !== "object") throw new Error(`${label}内容无效`);
  let bytes: Uint8Array;
  if (input.type === "url") {
    if (typeof input.url !== "string" || !URL.canParse(input.url)) throw new Error(`${label}地址无效`);
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(`${label}须使用不含账号密码的HTTP(S)图片地址`);
    // 素材下载不携带H3的Authorization；只有配置的服务地址接收API Key。
    bytes = await fetchBytes(connection, input.url, { label: `读取${label}`, maxBytes: maxMediaBytes });
  } else if (input.type === "base64") {
    if (typeof input.data !== "string") throw new Error(`${label}的Base64内容无效`);
    const dataUrl = /^data:image\/[^;,]+;base64,([\s\S]*)$/i.exec(input.data);
    const content = (dataUrl?.[1] ?? input.data).replace(/\s/g, "");
    if (!content || content.length > Math.ceil(maxMediaBytes / 3) * 4
      || !/^[a-zA-Z0-9+/]+={0,2}$/.test(content) || content.length % 4 === 1) throw new Error(`${label}的Base64内容无效或超过100 MiB`);
    bytes = Buffer.from(content, "base64");
  } else if (input.type === "binary") {
    if (!ArrayBuffer.isView(input.data) || input.data.BYTES_PER_ELEMENT !== 1) throw new Error(`${label}的图片字节无效`);
    bytes = input.data;
  } else {
    throw new Error(`${label}来源类型不支持`);
  }
  if (!bytes.byteLength || bytes.byteLength > maxMediaBytes) throw new Error(`${label}为空或超过100 MiB`);
  return bytes;
}

async function uploadImage(connection: Connection, input: MediaInput, label: string): Promise<string> {
  const bytes = await imageBytes(connection, input, label);
  const head = Buffer.from(bytes.subarray(0, 12));
  let extension: string;
  let mimeType: string;
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => head[index] === value)) {
    extension = "png";
    mimeType = "image/png";
  } else if (head[0] === 255 && head[1] === 216 && head[2] === 255) {
    extension = "jpg";
    mimeType = "image/jpeg";
  } else if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") {
    extension = "webp";
    mimeType = "image/webp";
  } else {
    throw new Error(`${label}须为PNG、JPEG或WebP图片`);
  }
  let boundary: string;
  do { boundary = `toonflowH3${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`; }
  while (Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(boundary));
  // 宿主没有FormData，使用Blob按接口的multipart字段file上传。
  const body = new Blob([
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="reference.${extension}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    new Uint8Array(bytes), `\r\n--${boundary}--\r\n`,
  ]);
  const response = await fetchBytes(connection, connection.baseUrl + "/v1/files", {
    label: `上传${label}`, method: "POST", body,
    headers: { ...connection.headers, "Content-Type": `multipart/form-data; boundary=${boundary}`, Accept: "application/json" },
  });
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(response)); }
  catch { throw new Error(`${label}上传结果不是有效的JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}上传结果无效`);
  const file = value as Record<string, unknown>;
  if (file.type !== "image" || typeof file.id !== "string" || !/^file_[a-f0-9]{32}$/.test(file.id)
    || file.bytes !== bytes.byteLength) throw new Error(`${label}上传未返回匹配的图片文件信息`);
  return file.id;
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 2000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export default {
  id: "h3",
  label: "H3（自部署）",
  version: "2.0.0",
  readme: "依据h3-api-dgx仓库的API实现适配，提供文字生视频、首帧/尾帧生视频及最多9张参考图生视频。支持480p、768p和4～15秒；接口未传参数时默认480p、5秒、16:9。比例支持16:9、9:16、1:1、4:3、3:4、21:9；有图片条件时还支持auto。输出为带声音的MP4，不能通过本接口关闭声音。参考图模式会先查询/v1/profiles，要求服务端启用lightx2v-ref2va-v0.1；不混用首尾帧、参考图，也不接收参考视频或音频。采样、随机种子及配方参数沿用服务端默认，不扩展额外参数。图片支持PNG/JPEG/WebP，自动上传并轮询当前任务，完成后携带鉴权下载视频，再交给Toonflow保存；不会把API Key放进视频地址。地址可填写HTTP(S)的IP或域名并带端口，使用服务根地址，不带/docs或/v1；API Key填写原始密钥，不加Bearer。密钥和实际地址不写入文件。每次HTTP请求最多等待120秒，整体最多等待4小时，不自动重试或重新提交。取消或超时只停止本地等待，DGX上已提交的任务可能继续运行，请先核实任务状态再生成。素材下载不携带H3密钥，所有HTTP请求不跟随重定向；请使用最终地址。输入和输出单文件上限100 MiB，与H3默认上传限制及Toonflow媒体文件限制一致。",
  rules: [
    {
      type: "input", field: "baseUrl", title: "H3服务地址", value: "",
      props: { placeholder: "填写含http://或https://的IP或域名，可带端口，不带/docs或/v1" },
      validate: [
        { required: true, whitespace: true, message: "请填写H3服务地址", trigger: "blur" },
        { type: "string", pattern: "^https?://\\S+$", message: "请输入HTTP(S)服务地址", trigger: "blur" },
      ],
    },
    {
      type: "input", field: "apiKey", title: "API Key", value: "",
      props: { type: "password", showPassword: true, autocomplete: "off", placeholder: "填写H3的原始API Key，不加Bearer" },
      validate: [
        { required: true, whitespace: true, message: "请填写H3的API Key", trigger: "blur" },
        { type: "string", min: 24, pattern: "^\\S+$", message: "密钥须至少24个字符且不含空白，不加Bearer前缀", trigger: "blur" },
      ],
    },
  ],
  models: [
    {
      id: "h3", label: "H3", type: "video", audio: true,
      mode: ["text", "endFrameOptional", "startFrameOptional", ["imageReference:9"]],
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["480p", "768p"] }],
    },
  ],
  async generateVideo(this: Context, request: VideoRequest): Promise<MediaAsset[]> {
    this.signal?.throwIfAborted();
    const baseUrl = typeof this.config.baseUrl === "string" ? this.config.baseUrl.trim().replace(/\/+$/, "") : "";
    if (!baseUrl || /\s/.test(baseUrl) || !URL.canParse(baseUrl)) throw new Error("请填写有效的H3服务地址");
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("H3地址须为不含账号密码、查询参数或片段的HTTP(S)地址");
    if (/\/(?:v1|docs|openapi\.json)$/.test(url.pathname)) throw new Error("请填写H3服务根地址，不要带/v1、/docs或/openapi.json");
    const apiKey = typeof this.config.apiKey === "string" ? this.config.apiKey.trim() : "";
    if (apiKey.length < 24 || /\s/.test(apiKey)) throw new Error("请填写至少24个字符的H3原始API Key，不加Bearer前缀");
    if (request.model !== "h3") throw new Error("请选择H3模型");
    if (typeof request.prompt !== "string" || !request.prompt.trim() || Array.from(request.prompt.trim()).length > 7000) throw new Error("请输入不超过7000个字符的视频描述");
    for (const field of ["images", "videos", "audios"] as const) {
      if (request[field] !== undefined && !Array.isArray(request[field])) throw new Error("参考素材须为数组");
    }
    if (request.videos?.length || request.audios?.length) throw new Error("当前H3配方仅支持参考图片，不支持参考视频或音频");
    if (request.generateAudio !== undefined && request.generateAudio !== true) throw new Error("H3始终生成带声音的视频，当前接口不能关闭声音");
    if (request.watermark !== undefined) throw new Error("当前H3接口不提供水印开关");
    if (request.other !== undefined && (!request.other || typeof request.other !== "object"
      || Array.isArray(request.other) || Object.keys(request.other).length)) throw new Error("此适配文件不接受额外参数，采样设置沿用服务端默认值");
    const images = request.images ?? [];
    const hasFirst = request.firstFrame !== undefined;
    const hasLast = request.lastFrame !== undefined;
    const hasFrames = hasFirst || hasLast;
    if (hasFrames && images.length) throw new Error("首尾帧和参考图不能同时使用");
    if (images.length > 9) throw new Error("H3最多支持9张参考图片");
    const mode = request.mode;
    if (mode === "text") {
      if (hasFrames || images.length) throw new Error("文字生视频模式不能传入图片");
    } else if (mode === "endFrameOptional") {
      if (!hasFirst || images.length) throw new Error("此模式需要首帧图片，尾帧可选");
    } else if (mode === "startFrameOptional") {
      if (!hasLast || images.length) throw new Error("此模式需要尾帧图片，首帧可选");
    } else if (mode === "startEndRequired") {
      if (!hasFirst || !hasLast || images.length) throw new Error("此模式需要同时提供首帧和尾帧");
    } else if (Array.isArray(mode)) {
      if (mode.length !== 1 || !/^imageReference:[1-9]$/.test(mode[0])) throw new Error("H3参考模式仅支持1至9张图片");
      if (hasFrames || !images.length || images.length > Number(mode[0].split(":")[1])) throw new Error("参考图数量不符合当前模式要求");
    } else if (mode !== undefined) {
      throw new Error("H3不支持当前生成模式");
    }
    const task = hasFrames ? "fl2va" : images.length ? "ref2va" : "t2va";
    const duration = request.duration ?? 5;
    if (!Number.isFinite(duration) || duration < 4 || duration > 15) throw new Error("H3视频时长须在4至15秒之间");
    const resolution = request.resolution ?? "480p";
    if (resolution !== "480p" && resolution !== "768p") throw new Error("H3分辨率仅支持480p或768p");
    const ratio = request.ratio ?? "16:9";
    if (!["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "auto"].includes(ratio) || task === "t2va" && ratio === "auto") {
      throw new Error("H3比例支持16:9、9:16、1:1、4:3、3:4、21:9；仅有图片条件时支持auto");
    }
    const controller = new AbortController();
    const signal = this.signal ? AbortSignal.any([this.signal, controller.signal]) : controller.signal;
    // ACT: 沿用仓库CLI的4小时等待上限；单GPU长队列可能超时，不能据此重新提交。
    const timeout = setTimeout(() => controller.abort(), 4 * 60 * 60 * 1000);
    const connection: Connection = { baseUrl, headers: { Authorization: `Bearer ${apiKey}` }, signal, tool: this.tool };
    let jobId = "";
    try {
      if (task === "ref2va") {
        const available = await requestJson(connection, "/v1/profiles");
        if (!Array.isArray(available.profiles)) throw new Error("H3未返回有效的配方列表");
        const profile = available.profiles.find((value: unknown) => value && typeof value === "object"
          && (value as Record<string, unknown>).id === "lightx2v-ref2va-v0.1") as Record<string, unknown> | undefined;
        if (!profile || !Array.isArray(profile.tasks) || !profile.tasks.includes("ref2va")
          || !Array.isArray(profile.reference_types) || !profile.reference_types.includes("image")) throw new Error("H3服务尚未启用参考图配方lightx2v-ref2va-v0.1");
        if (typeof profile.max_reference_images !== "number" || images.length > profile.max_reference_images) throw new Error("参考图数量超过H3服务当前开放的上限");
      }
      const conditions: Condition[] = [];
      if (hasFirst) conditions.push({ type: "image", role: "keyframe", frame_index: 0, file_id: await uploadImage(connection, request.firstFrame!, "首帧") });
      if (hasLast) conditions.push({ type: "image", role: "keyframe", frame_index: -1, file_id: await uploadImage(connection, request.lastFrame!, "尾帧") });
      for (const [index, input] of images.entries()) conditions.push({ type: "image", role: "reference", file_id: await uploadImage(connection, input, `参考图 ${index + 1}`) });
      signal.throwIfAborted();
      let job = await requestJson(connection, "/v1/videos", {
        task, profile: "auto", prompt: request.prompt.trim(), conditions,
        target: { short_edge: resolution === "768p" ? 768 : 480, aspect_ratio: ratio, duration_seconds: duration },
      });
      if (typeof job.id !== "string" || !/^video_[a-f0-9]{32}$/.test(job.id)) throw new Error("H3提交结果缺少有效任务编号，请先核实服务端是否已受理，避免重复生成");
      jobId = job.id;
      while (true) {
        signal.throwIfAborted();
        if (job.id !== jobId || typeof job.status !== "string" || !["queued", "loading", "running", "completed", "failed"].includes(job.status)) throw new Error("H3返回了不匹配的任务编号或未知状态");
        if (job.status === "failed") throw new Error(`H3生成失败：${this.tool.errorMessage(job.error) || "服务端任务执行失败"}`);
        if (job.status === "completed") {
          const bytes = await fetchBytes(connection, `${baseUrl}/v1/videos/${jobId}/content`, {
            label: "下载H3视频", headers: { ...connection.headers, Accept: "video/mp4" },
            mimeType: "video/mp4", maxBytes: maxMediaBytes,
          });
          if (!bytes.byteLength) throw new Error("H3返回了空视频文件");
          signal.throwIfAborted();
          return [{ mediaType: "video", type: "binary", data: bytes, mimeType: "video/mp4" }];
        }
        await waitForPoll(signal);
        job = await requestJson(connection, `/v1/videos/${jobId}`);
      }
    } catch (error) {
      this.signal?.throwIfAborted();
      const detail = controller.signal.aborted ? "H3等待超过4小时，服务端已提交的任务可能仍在运行，请先核实任务状态" : this.tool.errorMessage(error) || "H3生成失败，请检查服务地址、密钥和网络";
      throw new Error(`${detail}${jobId ? `\n任务编号：${jobId}` : ""}`);
    } finally {
      clearTimeout(timeout);
    }
  },
};
