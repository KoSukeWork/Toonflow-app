import { lstat, mkdir, readFile, readdir, writeAtomic } from "@toonflow/file";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";

// 旧数据只有 initialized。取对应镜像 /app/build 下原厂文件的 SHA-256。
// 有两个哈希时依次对应 toonflow:arm64 (d2bb411ad856)、toonflow:cusARM64 (8e6f6e0a684f)。
const legacyHashes: Readonly<Record<string, readonly string[]>> = {
  "audioGenerationNode.umd.js": ["68ea4bbd794b969bb639452a0f612d2b5c5fc9ff64cf58e2ca857603ba40ae5e", "df45c55374db7f929fe47f26d80390ce4bf9b388562af6aa79db433000157866"],
  "audioNode.umd.js": ["9c8549f7c28a64af9ff73858a987bf76b4e947b8ef663369b625ec06eed2d4c1", "2ebaa207c198ffd5359ea61232564a259a0c6f5fc15f1b4556d0b896b2bb674f"],
  "director3dNode.umd.js": ["91c68c9cd12592f25122c4e7bcd2f602603d4d44221d2aacee312c96ae6f63be", "8067247e9e7d6eb434dc949f5f1c54931fd164277d28026b2684d62b09099bd0"],
  "imageGenerationNode.umd.js": ["59a27140f42adde85a79bb57d646ad14d69c29b5e3772d1505e509326f4a30a6", "4fbe72497a0cc7fd20da331df0809e914d13fc10da89c91842a32d5f8baf1490"],
  "imageNode.umd.js": ["1ba6be224f0822b1069a7650ab921e2a1edd01f40224bb3daaa5cf405e16d43f", "a4a005682417ba64528af261531051f5d2c522af2fe2cc28ed4e6d5cd5aa4a9d"],
  "textNode.umd.js": ["ed5367af79aa3962286bdee49decdcafc6c937818ad1133ccbd3179521829af9", "6113d3a3b52b0857b4cd34800ebafb6db914e114d3653eebffe069820b242012"],
  "videoGenerationNode.umd.js": ["5c2fecf94795b76aa8a20e073061a2be9cff942a9ef37c3d53991bdae38ac72c", "1c4a1b6f6382ece30d0a8851d11c82abb3ca9bef5869736a689ca8d143bd76a8"],
  "videoNode.umd.js": ["3484cbe79845b38d5084ae7deb35cb658f5619ddc263c5a8d6eb26443973e368", "f2eb034586a4638df7cd486f8bdd3e7937b5f484422665344741c928cc0152f2"],
  "askUser.tool.js": ["9812dcf92697640c80b1107322c7bf88b2d4c77aa86f21ed7aa7ef76ccf27251", "d63a9905794bafddda690775fdf73c6c761c5e84f38a457cccf8e0c4cd7e555c"],
  "assetOperator.tool.js": ["e5102437050e8f1c796fda19c58e5165c29de053a09205655c779647fc23f196"],
  "browser.tool.js": ["e27991c3f0508bf9e0cea0d20ae13076992fec954911b8c4bac2596280574dc4"],
  "canvas.tool.js": ["213951b6b2828b7385587ccbf56f14c0adb25dba0e92ff9c6c1538c57134b588"],
  "ffmpeg.tool.js": ["c382908a8fc2724663e016d35430f279fee0cd3ba7168886adc88e38bfcb71f0"],
  "mediaGeneration.tool.js": ["9c1b50aff104ea953b5e37a420ccd135ac92f8e73a37d6949688c18f721e613e"],
  "skillOperator.tool.js": ["3702d338b871a366bdad2cc867e9e7a9db598658dde3e524f9d35e4b24e25f1b"],
  "webFetch.tool.js": ["114e256b22bad04c012aa2fb421315c07c9446cead4d0e60e59dc791344a5749"],
  "webSearch.tool.js": ["3e54e3f4f9d12162bf3d3fe21d8aaaa0146d32a89914754813d1cb5998d7b2b8"],
  "workspace.tool.js": ["d2ef81ce344b56603bad448430f68ee400fbf30ad9fb728dce724dd655505484"],
};
const hashesSchema = z.record(z.string(), z.array(z.string().regex(/^[a-f0-9]{64}$/)));

function ignoreMissing(error: NodeJS.ErrnoException): undefined {
  if (error.code !== "ENOENT") throw error;
  return undefined;
}

function sha256(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

export default async function initializeLanPlugins(targetDirectory: string, sourceDirectory: string, fileFilter: RegExp) {
  const entries = await readdir(sourceDirectory, { withFileTypes: true }).catch(ignoreMissing);
  const files = entries?.filter(file => file.isFile() && fileFilter.test(file.name));
  if (!files?.length) return;

  await mkdir(targetDirectory, { recursive: true });
  if (!(await lstat(targetDirectory)).isDirectory()) throw new Error(`插件目录必须是真实目录：${targetDirectory}`);
  const marker = resolve(targetDirectory, "initialized");
  const initialized = await lstat(marker).catch(ignoreMissing);
  const hashesPath = resolve(targetDirectory, "bundledHashes.json");
  const saved = await readFile(hashesPath, "utf8").catch(ignoreMissing);
  const hashes = hashesSchema.parse(JSON.parse(saved ?? "{}"));
  const bundles = await Promise.all(files.map(async ({ name }) => {
    const content = await readFile(resolve(sourceDirectory, name));
    return { name, content, hash: sha256(content) };
  }));

  // ACT: 先登记构建原件，再逐个原子替换。即使中途失败后换了构建，已更新的文件也能被识别。
  let hashesChanged = false;
  for (const { name, hash } of bundles) {
    const known = hashes[name] ??= [];
    if (known.includes(hash)) continue;
    known.push(hash);
    hashesChanged = true;
  }
  if (hashesChanged) await writeAtomic(hashesPath, JSON.stringify(hashes));

  for (const { name, content } of bundles) {
    const target = resolve(targetDirectory, name);
    const current = await lstat(target).catch(ignoreMissing);
    if (!current) {
      if (!initialized) await writeAtomic(target, content, { exclusive: true, mode: 0o644 });
      continue;
    }
    if (!current.isFile()) continue;
    const installed = await readFile(target);
    if (installed.equals(content)) continue;
    const installedHash = sha256(installed);
    if (hashes[name]?.includes(installedHash) || legacyHashes[name]?.includes(installedHash)) {
      await writeAtomic(target, content, { mode: current.mode & 0o777 });
    }
  }
  if (!initialized) await writeAtomic(marker, "", { exclusive: true, mode: 0o644 });
}
