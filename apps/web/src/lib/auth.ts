import axios, { type AxiosInstance } from "axios";
import { shallowRef } from "vue";
import type { AuthState } from "@toonflow/server/auth";
import { setNodeAiRequestIdentity } from "@toonflow/nodes-scaffold/nodeAi";

export const authState = shallowRef<AuthState>({ enabled: false, user: null });
const sessionChangeKey = "toonflow.sessionChanged";
const projectRoute = /^\/workspace\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export function loginDestination(value: unknown) {
  return typeof value === "string" && projectRoute.test(value) ? value : "/home";
}

export async function loadAuthState() {
  try {
    const { data } = await axios.get<{ data: AuthState }>("/api/auth/status", { timeout: 12000 });
    authState.value = data.data;
  } catch (error) {
    // ACT: 旧版本远程服务没有状态接口，继续使用单机启动流程。
    if (!axios.isAxiosError(error) || error.response?.status !== 404) throw error;
  }
  if (!authState.value.enabled) return;
  if (authState.value.user) setNodeAiRequestIdentity(authState.value.user.id);
  window.addEventListener("storage", event => {
    if (event.key === sessionChangeKey) window.location.reload();
  });
  window.addEventListener("pageshow", event => {
    if (event.persisted) window.location.reload();
  });
}

export function apiIdentityHeaders(): Record<string, string> {
  const user = authState.value.user;
  return user ? { "x-toonflow-user": user.id } : {};
}

export function registerApiIdentity(client: AxiosInstance) {
  const requests = client.interceptors.request.use(config => {
    const user = authState.value.user;
    if (user) {
      const url = new URL(client.getUri(config), window.location.href);
      if (url.origin === window.location.origin && url.pathname.startsWith("/api/")) config.headers.set("x-toonflow-user", user.id);
    }
    return config;
  });
  const responses = client.interceptors.response.use(undefined, (error: unknown) => {
    if (authState.value.user && axios.isAxiosError(error) && error.response?.status === 401 && error.config) {
      const url = new URL(client.getUri(error.config), window.location.href);
      if (url.origin === window.location.origin && url.pathname.startsWith("/api/")) window.location.reload();
    }
    return Promise.reject(error);
  });
  return () => {
    client.interceptors.request.eject(requests);
    client.interceptors.response.eject(responses);
  };
}

function reloadForSession(path: string) {
  // ACT: 整页重载同时丢弃 Pinia、文件预览和尚未执行的设置保存队列。
  try { localStorage.setItem(sessionChangeKey, crypto.randomUUID()); }
  catch { /* 服务端仍拒绝旧页面与新账号混用。 */ }
  const url = new URL(window.location.href);
  url.hash = path;
  history.replaceState(null, "", url);
  window.location.reload();
}

export async function signIn(username: string, password: string, destination: unknown) {
  await axios.post("/api/auth/login", { username, password }, { headers: { "x-toonflow-workspace": "1" } });
  reloadForSession(loginDestination(destination));
}

export async function switchAccount() {
  await axios.post("/api/auth/logout");
  reloadForSession("/login");
}

export async function changeOwnPassword(currentPassword: string, newPassword: string) {
  await axios.put("/api/auth/changePassword", { currentPassword, newPassword });
  reloadForSession("/login");
}
