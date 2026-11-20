import { createRouter, createWebHashHistory, type RouteLocationNormalized } from "vue-router";
import axios from "axios";
import { ElMessage } from "element-plus";
import { useHelloStore } from "@/stores/hello";
import { useWorkspaceStore } from "@/stores/workspace";
import { authState, loginDestination } from "@/lib/auth";
import type { RegisteredProject } from "@toonflow/server/auth";

const openedProjects = new WeakMap<RouteLocationNormalized, RegisteredProject>();
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: "/",
      redirect: "/hello",
    },
    {
      path: "/hello",
      beforeEnter: async () => await useHelloStore().load() ? { path: "/home", replace: true } : true,
      component: () => import("@/pages/hello/index.vue"),
    },
    {
      path: "/home",
      component: () => import("@/pages/home/index.vue"),
    },
    {
      path: "/login",
      component: () => import("@/pages/login/index.vue"),
    },
    {
      path: "/canvas",
      redirect: "/workspace",
    },
    {
      path: "/workspace/:projectId?",
      name: "workspace",
      component: () => import("@/pages/workspace/index.vue"),
    },
  ],
});

router.beforeEach(to => {
  const { enabled, user } = authState.value;
  if (!enabled) {
    if (to.path === "/login") return "/hello";
    if (to.name === "workspace" && to.params.projectId) return "/workspace";
    return;
  }
  if (!user && to.path !== "/login") return { path: "/login", query: { redirect: loginDestination(to.path) }, replace: true };
  if (user && to.path === "/login") return loginDestination(to.query.redirect);
  if (to.path === "/hello" || (to.name === "workspace" && !to.params.projectId)) return "/home";
});

router.beforeResolve(async to => {
  if (!authState.value.enabled || to.name !== "workspace") return;
  if (loginDestination(to.path) === "/home") return "/home";
  try {
    const { data } = await axios.post<{ data: RegisteredProject }>("/api/projects/open", { id: to.params.projectId });
    openedProjects.set(to, data.data);
  } catch (error) {
    if (axios.isAxiosError<{ message?: string }>(error) && error.response?.status === 401) return false;
    ElMessage.error(axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message || "无法打开项目" : "无法打开项目");
    return "/home";
  }
});

router.afterEach((to, _from, failure) => {
  if (failure || !authState.value.enabled || !authState.value.user) return;
  const store = useWorkspaceStore();
  const project = openedProjects.get(to);
  if (project) store.activateRegisteredProject(project);
  else store.project = null;
});

export default router;
