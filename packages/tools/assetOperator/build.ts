import { createToolConfig } from "@toonflow/tools-scaffold";

await createToolConfig({
  name: "assetOperator",
  displayName: "素材库管理",
  description: "查询、读取和维护素材库，将素材导入工作区或将生成结果归档入库。",
  prompt: `通过 assetOperator 查询和管理素材库。多人模式使用当前工程的素材库，单机模式使用本机素材库。
先查询和读取相关素材，再按用户要求维护；沿用当前会话已有授权，只有删除或覆盖不在授权范围内时才询问。
将工作区生成结果入库时使用 sourcePath；素材用于画布或生成参考前先 import 到当前工作区，使用返回的真实路径。`,
  author: "Toonflow",
  github: "https://github.com/HBAI-Ltd/Toonflow-app",
  configRules: [
    { type: "switch", field: "readOnly", title: "只读模式", value: false, info: "开启后禁止修改素材库；仍可查询、读取，以及复制素材到当前工作区。" },
  ],
}, import.meta.url);
