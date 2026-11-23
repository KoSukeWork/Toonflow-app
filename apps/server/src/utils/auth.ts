import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { writeAtomic } from "@toonflow/file";
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { getRuntimePlatform } from "@/lib/platform";
import type { AuthUser } from "@/types/auth";

export type { AuthUser } from "@/types/auth";

const cookieName = "toonflowSession";
const sessionDuration = 7 * 24 * 60 * 60 * 1000;
const requestUsers = new WeakMap<Request, AuthUser>();
const currentRequest = new AsyncLocalStorage<Request>();
const loginAttempts = new Map<string, { count: number; expires: number }>();
let verifying = 0;

export const usernameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}$/);
export const passwordSchema = z.string().min(12).max(128);
type StoredAuthUser = Omit<AuthUser, "disabled"> & { disabled: number };

export function isMultiUserEnabled() {
  return process.env.TOONFLOW_MULTI_USER === "1" && !getRuntimePlatform().host;
}

export function getRequestUser(request: Request) {
  return requestUsers.get(request);
}

export function getCurrentUser() {
  const request = getCurrentRequest();
  return request && getRequestUser(request);
}

export function getCurrentRequest() {
  return currentRequest.getStore();
}

export function requireRequestUser(request: Request) {
  const user = getRequestUser(request);
  if (!user) throw Object.assign(new Error("请先登录"), { status: 401 });
  return user;
}

export function runAsRequestUser(request: Request, user: AuthUser, next: () => void) {
  requestUsers.set(request, user);
  currentRequest.run(request, next);
}

export async function initializeAccounts(app: Express, dataDirectory: string) {
  const file = resolve(dataDirectory, "accounts.sqlite");
  await writeAtomic(file, "", { mode: 0o600, exclusive: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const db = new Database(file, { readwrite: true, strict: true });
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, passwordHash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')), disabled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS sessions (
        tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, directory TEXT NOT NULL, directoryKey TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        ownerId TEXT NOT NULL REFERENCES users(id), lastOpenedAt INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS projectsByOwner ON projects(ownerId, lastOpenedAt);
      CREATE TABLE IF NOT EXISTS projectMembers (
        projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        lastOpenedAt INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (projectId, userId)
      );
      CREATE INDEX IF NOT EXISTS projectsByMember ON projectMembers(userId, lastOpenedAt);
      CREATE TRIGGER IF NOT EXISTS addProjectOwner AFTER INSERT ON projects BEGIN
        INSERT INTO projectMembers(projectId, userId) VALUES (NEW.id, NEW.ownerId);
      END;
      INSERT OR IGNORE INTO projectMembers SELECT id, ownerId, lastOpenedAt FROM projects;
    `);
    if (!(db.query("PRAGMA table_info(users)").all() as { name: string }[]).some(column => column.name === "disabled")) {
      db.exec("ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0");
    }
    if (!db.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()) {
      const username = usernameSchema.safeParse(process.env.TOONFLOW_ADMIN_USERNAME || "admin");
      const password = passwordSchema.safeParse(process.env.TOONFLOW_ADMIN_PASSWORD);
      if (!username.success || !password.success) {
        throw new Error("首次启用多用户模式时，请设置有效的 TOONFLOW_ADMIN_USERNAME 和 12 至 128 字符的 TOONFLOW_ADMIN_PASSWORD");
      }
      const passwordHash = await Bun.password.hash(password.data);
      db.query(`
        INSERT INTO users (id, username, passwordHash, role) SELECT ?, ?, ?, 'admin'
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')
      `).run(randomUUID(), username.data, passwordHash);
    }
  } catch (error) {
    db.close();
    throw error;
  }
  app.locals.accounts = db;
}

export function getAccountDatabase(request: Request): Database {
  const db = request.app.locals.accounts as Database | undefined;
  if (!db) throw Object.assign(new Error("未启用多用户模式"), { status: 404 });
  return db;
}

function requestTokenHash(request: Request) {
  const token = request.get("cookie")?.match(/(?:^|;\s*)toonflowSession=([A-Za-z0-9_-]{43})(?=;|$)/)?.[1];
  return token ? createHash("sha256").update(token).digest("hex") : undefined;
}

export function readSession(request: Request) {
  const tokenHash = requestTokenHash(request);
  if (!tokenHash) return undefined;
  const user = getAccountDatabase(request).query<StoredAuthUser, [string, number]>(`
    SELECT users.id, users.username, users.role, users.disabled FROM sessions JOIN users ON sessions.userId = users.id
    WHERE sessions.tokenHash = ? AND expires > ? AND users.disabled = 0
  `).get(tokenHash, Date.now());
  return user ? { ...user, disabled: Boolean(user.disabled) } : undefined;
}

async function verifyPassword(request: Request, username: string, password: string, changing = false) {
  const db = getAccountDatabase(request);
  const now = Date.now();
  for (const [ip, attempt] of loginAttempts) if (attempt.expires <= now) loginAttempts.delete(ip);
  const ip = request.ip ?? request.socket.remoteAddress ?? "";
  const attempt = loginAttempts.get(ip) ?? { count: 0, expires: now + 5 * 60 * 1000 };
  // ACT: 代理后的来源共享限额。限制 Argon2 并发与地址数，避免登录请求占满服务资源。
  if (verifying >= 4 || attempt.count >= 15 || (!loginAttempts.has(ip) && loginAttempts.size >= 4096)) {
    throw Object.assign(new Error("登录尝试过多，请稍后再试"), { status: 429 });
  }
  attempt.count++;
  loginAttempts.set(ip, attempt);
  verifying++;
  try {
    const account = db.query<AuthUser & { passwordHash: string }, [string]>("SELECT * FROM users WHERE username = ?").get(username);
    const fallback = account ?? db.query<{ passwordHash: string }, []>("SELECT passwordHash FROM users LIMIT 1").get();
    if (!fallback || !(await Bun.password.verify(password, fallback.passwordHash)) || !account) {
      if (changing) throw Object.assign(new Error("当前密码不正确"), { status: 400 });
      throw Object.assign(new Error("账号或密码不正确"), { status: 401 });
    }
    attempt.count--;
    if (account.disabled) throw Object.assign(new Error("该账号已停用"), { status: 403 });
    return account;
  } finally { verifying--; }
}

function cookieOptions(request: Request) {
  return { httpOnly: true, sameSite: "strict" as const, secure: request.secure || process.env.TOONFLOW_SECURE_COOKIES === "1", path: "/" };
}

export async function login(request: Request, response: Response, username: string, password: string): Promise<AuthUser> {
  const account = await verifyPassword(request, username, password);
  const db = getAccountDatabase(request);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const previousTokenHash = requestTokenHash(request);
  const now = Date.now();
  db.transaction(() => {
    db.query("DELETE FROM sessions WHERE expires <= ? OR tokenHash = ?").run(now, previousTokenHash ?? null);
    // 只为刚验证的密码签发会话，防止改密期间仍在验证的旧密码重新登录。
    if (!db.query("INSERT INTO sessions SELECT ?, id, ? FROM users WHERE id = ? AND passwordHash = ? AND disabled = 0")
      .run(tokenHash, now + sessionDuration, account.id, account.passwordHash).changes) {
      throw Object.assign(new Error("账号或密码不正确"), { status: 401 });
    }
  })();
  response.cookie(cookieName, token, { ...cookieOptions(request), maxAge: sessionDuration });
  return { id: account.id, username: account.username, role: account.role, disabled: false };
}

async function replacePassword(request: Request, userId: string, previousHash: string, password: string) {
  const db = getAccountDatabase(request);
  const hash = await Bun.password.hash(password);
  db.transaction(() => {
    if (readSession(request)?.id !== requireRequestUser(request).id) throw Object.assign(new Error("请重新登录"), { status: 401 });
    if (!db.query("UPDATE users SET passwordHash = ? WHERE id = ? AND passwordHash = ?").run(hash, userId, previousHash).changes) {
      throw Object.assign(new Error("密码已变更，请重试"), { status: 409 });
    }
    db.query("DELETE FROM sessions WHERE userId = ?").run(userId);
  })();
}

export async function changePassword(request: Request, currentPassword: string, newPassword: string) {
  const user = requireRequestUser(request);
  const account = await verifyPassword(request, user.username, currentPassword, true);
  if (currentPassword === newPassword) throw Object.assign(new Error("新密码须与当前密码不同"), { status: 400 });
  await replacePassword(request, user.id, account.passwordHash, newPassword);
}

export async function resetPassword(request: Request, userId: string, newPassword: string) {
  const admin = requireRequestUser(request);
  if (admin.role !== "admin") throw Object.assign(new Error("仅管理员可以重置用户密码"), { status: 403 });
  if (admin.id === userId) throw Object.assign(new Error("请使用修改密码更改自己的密码"), { status: 400 });
  const account = getAccountDatabase(request).query<{ passwordHash: string }, [string]>("SELECT passwordHash FROM users WHERE id = ?").get(userId);
  if (!account) throw Object.assign(new Error("找不到该账号"), { status: 404 });
  await replacePassword(request, userId, account.passwordHash, newPassword);
}

export function endSession(request: Request, response: Response) {
  const tokenHash = requestTokenHash(request);
  if (tokenHash) getAccountDatabase(request).query("DELETE FROM sessions WHERE tokenHash = ?").run(tokenHash);
  response.clearCookie(cookieName, cookieOptions(request));
}

export function listMembers(request: Request) {
  const members = getAccountDatabase(request).query<StoredAuthUser, []>("SELECT id, username, role, disabled FROM users ORDER BY username").all();
  return members.map(member => ({ ...member, disabled: Boolean(member.disabled) }));
}

export async function createMember(request: Request, username: string, password: string): Promise<AuthUser> {
  const db = getAccountDatabase(request);
  const passwordHash = await Bun.password.hash(password);
  const id = randomUUID();
  if (!db.query("INSERT INTO users (id, username, passwordHash, role) VALUES (?, ?, ?, 'member') ON CONFLICT(username) DO NOTHING").run(id, username, passwordHash).changes) {
    throw Object.assign(new Error("账号已存在"), { status: 409 });
  }
  return { id, username, role: "member", disabled: false };
}

export function setAccountDisabled(request: Request, userId: string, disabled: boolean): AuthUser {
  const admin = requireRequestUser(request);
  if (admin.role !== "admin") throw Object.assign(new Error("仅管理员可以停用或启用账号"), { status: 403 });
  if (admin.id === userId) throw Object.assign(new Error("不能停用或启用当前登录账号"), { status: 400 });
  const db = getAccountDatabase(request);
  const user = db.query<StoredAuthUser, [string]>("SELECT id, username, role, disabled FROM users WHERE id = ?").get(userId);
  if (!user) throw Object.assign(new Error("找不到该账号"), { status: 404 });
  db.transaction(() => {
    db.query("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, userId);
    if (disabled) db.query("DELETE FROM sessions WHERE userId = ?").run(userId);
  })();
  return { ...user, disabled };
}
