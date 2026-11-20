import { randomUUID } from "node:crypto";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { lstat, mkdir, realpath, rmdir, unlink, writeAtomic } from "@toonflow/file";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { getAccountDatabase, getCurrentRequest, requireRequestUser } from "@/utils/auth";
import { isWithin, lockWorkspaceFiles } from "@/utils/workspace/files";
import type { ProjectOwnership, RegisteredProject } from "@/types/auth";

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

const projectRequests = new Map<string, Set<Response>>();
const revokedProjectResponses = new WeakSet<Response>();
const projectSelection = `SELECT p.id, p.directory, p.name, m.lastOpenedAt,
  CASE WHEN p.ownerId = m.userId THEN 'owner' ELSE 'editor' END AS accessRole
  FROM projects p JOIN projectMembers m ON m.projectId = p.id WHERE m.userId = ?`;

export async function resolveProjectDirectory(request: Request, path: string) {
  const user = requireRequestUser(request);
  if (!isAbsolute(path)) throw Object.assign(new Error("工作目录必须是绝对路径"), { status: 400 });
  const root = projectRoot(request);
  const project = getAccountDatabase(request).query<RegisteredProject, [string, string]>(projectSelection + " AND p.directoryKey = ?")
    .get(user.id, directoryKey(relative(root, path)));
  if (!project) throw projectUnavailable();
  const response = request.res;
  if (response && !response.destroyed) {
    const key = project.id + ":" + user.id;
    const active = projectRequests.get(key) ?? new Set<Response>();
    if (!active.has(response)) {
      active.add(response);
      projectRequests.set(key, active);
      const release = () => {
        response.off("finish", release);
        response.off("close", release);
        active.delete(response);
        if (!active.size && projectRequests.get(key) === active) projectRequests.delete(key);
      };
      response.once("finish", release);
      response.once("close", release);
    }
  }
  const directory = await verifyDirectory(root, project.directory);
  if (response?.destroyed) throw projectUnavailable();
  return directory;
}

export function listProjects(request: Request): RegisteredProject[] {
  const user = requireRequestUser(request);
  return getAccountDatabase(request).query<RegisteredProject, [string]>(
    projectSelection + " ORDER BY m.lastOpenedAt DESC, p.name",
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
  return { id, directory, name, lastOpenedAt: 0, accessRole: "owner" };
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
  return { id, directory: absolutePath, name: projectName, lastOpenedAt: 0, accessRole: "owner" };
}

export async function openProject(request: Request, id: string): Promise<RegisteredProject> {
  const user = requireRequestUser(request);
  const db = getAccountDatabase(request);
  const found = db.query<RegisteredProject, [string, string]>(projectSelection + " AND p.id = ?").get(user.id, id);
  if (!found) throw projectUnavailable();
  const directory = await verifyDirectory(projectRoot(request), found.directory);
  const lastOpenedAt = Date.now();
  if (!db.query("UPDATE projectMembers SET lastOpenedAt = ? WHERE projectId = ? AND userId = ?").run(lastOpenedAt, id, user.id).changes) throw projectUnavailable();
  return { ...found, lastOpenedAt, directory };
}

function ownedProjectDatabase(request: Request, id: string) {
  const db = getAccountDatabase(request);
  if (!db.query("SELECT 1 FROM projects WHERE id = ? AND ownerId = ?").get(id, requireRequestUser(request).id)) throw projectUnavailable();
  return db;
}

export function listProjectMembers(request: Request, id: string) {
  return ownedProjectDatabase(request, id).query<{ id: string; username: string }, [string, string]>(
    "SELECT u.id, u.username FROM projectMembers m JOIN users u ON u.id = m.userId WHERE m.projectId = ? AND u.id <> ? ORDER BY u.username",
  ).all(id, requireRequestUser(request).id);
}

export function shareProject(request: Request, id: string, username: string) {
  const db = ownedProjectDatabase(request, id);
  const member = db.query<{ id: string }, [string]>("SELECT id FROM users WHERE username = ?").get(username);
  if (!member) throw Object.assign(new Error("找不到该账号"), { status: 404 });
  if (member.id === requireRequestUser(request).id) throw Object.assign(new Error("你已经是项目所有者"), { status: 400 });
  db.query("INSERT OR IGNORE INTO projectMembers(projectId,userId) VALUES (?,?)").run(id, member.id);
}

export function unshareProject(request: Request, id: string, userId: string) {
  const db = ownedProjectDatabase(request, id);
  if (requireRequestUser(request).id === userId) throw Object.assign(new Error("无法移除项目所有者"), { status: 400 });
  db.query("DELETE FROM projectMembers WHERE projectId = ? AND userId = ?").run(id, userId);
  cancelProjectRequests(id, userId);
}

function cancelProjectRequests(projectId: string, userId: string) {
  for (const response of projectRequests.get(projectId + ":" + userId) ?? []) {
    revokedProjectResponses.add(response);
    response.destroy();
  }
}

export function assertCurrentProjectRequest() {
  const response = getCurrentRequest()?.res;
  if (response && revokedProjectResponses.has(response)) throw projectUnavailable();
}

function projectAdminDatabase(request: Request) {
  if (requireRequestUser(request).role !== "admin") throw Object.assign(new Error("仅管理员可以管理项目归属"), { status: 403 });
  return getAccountDatabase(request);
}

const ownershipSelection = `SELECT p.id, p.directory, p.name, p.ownerId, u.username AS ownerUsername
  FROM projects p JOIN users u ON u.id = p.ownerId`;

export function listProjectOwnership(request: Request) {
  return projectAdminDatabase(request).query<ProjectOwnership, []>(
    ownershipSelection + " ORDER BY p.name COLLATE NOCASE, p.directory",
  ).all();
}

export function transferProjectOwnership(request: Request, id: string, expectedOwnerId: string, newOwnerId: string): ProjectOwnership {
  const db = projectAdminDatabase(request);
  const project = db.query<ProjectOwnership, [string]>(ownershipSelection + " WHERE p.id = ?").get(id);
  if (!project) throw projectUnavailable();
  if (project.ownerId === newOwnerId) return project;
  if (project.ownerId !== expectedOwnerId) throw Object.assign(new Error("项目所有者已经变更，请刷新后重新选择"), { status: 409 });
  const next = db.query<{ username: string }, [string]>("SELECT username FROM users WHERE id = ?").get(newOwnerId);
  if (!next) throw Object.assign(new Error("指定的账号不存在"), { status: 404 });

  // ACT: 文件操作占用工程时由锁返回 409；归属和成员记录在同一次事务提交。
  const release = lockWorkspaceFiles([resolve(projectRoot(request), project.directory)]);
  try {
    db.transaction(() => {
      db.query("UPDATE projects SET ownerId = ? WHERE id = ?").run(newOwnerId, id);
      db.query("INSERT OR IGNORE INTO projectMembers(projectId, userId) VALUES (?, ?)").run(id, newOwnerId);
      db.query("DELETE FROM projectMembers WHERE projectId = ? AND userId = ?").run(id, project.ownerId);
    })();
    cancelProjectRequests(id, project.ownerId);
  } finally { release(); }

  return { ...project, ownerId: newOwnerId, ownerUsername: next.username };
}

export function renameProject(request: Request, id: string, name: string) {
  const user = requireRequestUser(request);
  if (!getAccountDatabase(request).query("UPDATE projects SET name = ? WHERE id = ? AND ownerId = ?").run(name, id, user.id).changes) {
    throw projectUnavailable();
  }
}
