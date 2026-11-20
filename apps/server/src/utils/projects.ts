import { randomUUID } from "node:crypto";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { lstat, mkdir, realpath, rmdir, unlink, writeAtomic } from "@toonflow/file";
import type { Express, Request } from "express";
import { z } from "zod";
import { getAccountDatabase, requireRequestUser } from "@/utils/auth";
import { isWithin, lockWorkspaceFiles } from "@/utils/workspace/files";
import type { RegisteredProject } from "@/types/auth";

export const projectNameSchema = z.string().trim().min(1).max(128);

export async function initializeProjects(app: Express, dataDirectory: string) {
  const workspaceRoot = resolve(dataDirectory, "workspaces");
  await mkdir(workspaceRoot, { recursive: true });
  if (!(await lstat(workspaceRoot)).isDirectory()) throw new Error("服务器工作区根目录必须是普通文件夹");
  app.locals.projectRoot = await realpath(workspaceRoot);
}

function projectRoot(request: Request): string {
  return request.app.locals.projectRoot;
}

function directoryKey(path: string) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function projectUnavailable() {
  return Object.assign(new Error("项目不存在或当前账号无法访问"), { status: 404 });
}

async function verifyDirectory(root: string, directory: string) {
  const absolutePath = resolve(root, directory);
  const info = await lstat(absolutePath);
  if (!info.isDirectory() || relative(absolutePath, await realpath(absolutePath))) {
    throw Object.assign(new Error("项目目录必须位于服务器工作区内，且不能使用符号链接"), { status: 403 });
  }
  return absolutePath;
}

export async function resolveOwnedProjectDirectory(request: Request, path: string) {
  const user = requireRequestUser(request);
  if (!isAbsolute(path)) throw Object.assign(new Error("工作目录必须是绝对路径"), { status: 400 });
  const root = projectRoot(request);
  const directory = getAccountDatabase(request).query<{ directory: string }, [string, string]>(
    "SELECT directory FROM projects WHERE ownerId = ? AND directoryKey = ?",
  ).get(user.id, directoryKey(relative(root, path)))?.directory;
  if (!directory) throw projectUnavailable();
  return verifyDirectory(root, directory);
}

export function listProjects(request: Request): RegisteredProject[] {
  const user = requireRequestUser(request);
  return getAccountDatabase(request).query<RegisteredProject, [string]>(
    "SELECT id, directory, name, lastOpenedAt FROM projects WHERE ownerId = ? ORDER BY lastOpenedAt DESC, name",
  ).all(user.id).map(project => ({ ...project, directory: resolve(projectRoot(request), project.directory) }));
}

export async function createProject(request: Request, name: string): Promise<RegisteredProject> {
  const user = requireRequestUser(request);
  const id = randomUUID();
  const root = projectRoot(request);
  const directory = resolve(root, id);
  const canvas = resolve(directory, "画布1.json");
  const db = getAccountDatabase(request);
  await verifyDirectory(root, "");
  const release = lockWorkspaceFiles([directory]);
  let createdDirectory = false;
  let wroteCanvas = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    createdDirectory = true;
    await writeAtomic(canvas, JSON.stringify({ toonflowCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }), { exclusive: true });
    wroteCanvas = true;
    db.query("INSERT INTO projects (id, directory, directoryKey, name, ownerId) VALUES (?, ?, ?, ?, ?)").run(id, id, id, name, user.id);
  } catch (error) {
    if (wroteCanvas) await unlink(canvas).catch(console.error);
    if (createdDirectory) await rmdir(directory).catch(console.error);
    throw error;
  } finally { release(); }
  return { id, directory, name, lastOpenedAt: 0 };
}

export async function registerProject(request: Request, path: string, ownerId: string, name?: string): Promise<RegisteredProject> {
  const root = projectRoot(request);
  if (isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || /[:\x00-\x1f]/.test(part))) {
    throw Object.assign(new Error("请输入服务器工作区内的相对目录"), { status: 400 });
  }
  const requested = resolve(root, path);
  if (!isWithin(root, requested) || !relative(root, requested)) {
    throw Object.assign(new Error("不能登记服务器工作区根目录或其上级目录"), { status: 400 });
  }
  const absolutePath = await verifyDirectory(root, path);
  const directory = relative(root, absolutePath);
  const projectName = name || basename(absolutePath);
  const db = getAccountDatabase(request);
  const id = randomUUID();
  // ACT: 仅登记时扫描已有目录，禁止工程重叠。打开和文件访问按归属索引查询。
  const release = lockWorkspaceFiles([absolutePath]);
  try {
    db.transaction(() => {
      if (!db.query("SELECT 1 FROM users WHERE id = ?").get(ownerId)) throw Object.assign(new Error("指定的账号不存在"), { status: 404 });
      const existing = db.query<{ directory: string }, []>("SELECT directory FROM projects").all();
      if (existing.some(project => {
        const registered = resolve(root, project.directory);
        return isWithin(registered, absolutePath) || isWithin(absolutePath, registered);
      })) throw Object.assign(new Error("该目录或其上下级目录已经登记为项目"), { status: 409 });
      db.query("INSERT INTO projects (id, directory, directoryKey, name, ownerId) VALUES (?, ?, ?, ?, ?)").run(id, directory, directoryKey(directory), projectName, ownerId);
    })();
  } finally { release(); }
  return { id, directory: absolutePath, name: projectName, lastOpenedAt: 0 };
}

export async function openProject(request: Request, id: string): Promise<RegisteredProject> {
  const user = requireRequestUser(request);
  const db = getAccountDatabase(request);
  const found = db.query<{ directory: string }, [string, string]>("SELECT directory FROM projects WHERE id = ? AND ownerId = ?").get(id, user.id);
  if (!found) throw projectUnavailable();
  const directory = await verifyDirectory(projectRoot(request), found.directory);
  const project = db.query<RegisteredProject, [number, string, string]>(
    "UPDATE projects SET lastOpenedAt = ? WHERE id = ? AND ownerId = ? RETURNING id, directory, name, lastOpenedAt",
  ).get(Date.now(), id, user.id);
  if (!project) throw projectUnavailable();
  return { ...project, directory };
}

export function renameProject(request: Request, id: string, name: string) {
  const user = requireRequestUser(request);
  if (!getAccountDatabase(request).query("UPDATE projects SET name = ? WHERE id = ? AND ownerId = ?").run(name, id, user.id).changes) {
    throw projectUnavailable();
  }
}
