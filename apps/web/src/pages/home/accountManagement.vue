<template>
  <el-dialog v-model="visible" title="账号和项目管理" width="min(520px, 92vw)" appendToBody @open="loadMembers">
    <p v-if="message" role="status">{{ message }}</p>
    <el-tabs v-model="activeTab">
      <el-tab-pane label="现有用户" name="users">
        <el-scrollbar maxHeight="50vh">
          <ul class="memberList">
            <li v-for="member in members" :key="member.id">
              <span>{{ member.username }} · {{ member.role === "admin" ? "管理员" : "成员" }}{{ member.disabled ? " · 已停用" : "" }}</span>
              <span class="memberActions">
                <el-button text :disabled="loading || saving" @click="passwordAccount = member">{{ member.id === authState.user?.id ? "修改密码" : "重置密码" }}</el-button>
                <el-button v-if="member.id !== authState.user?.id" text :type="member.disabled ? 'success' : 'danger'" :disabled="loading || saving" @click="toggleMember(member)">{{ member.disabled ? "启用账号" : "停用账号" }}</el-button>
              </span>
            </li>
          </ul>
        </el-scrollbar>
      </el-tab-pane>
      <el-tab-pane label="创建成员" name="members">
        <el-form labelPosition="top" @submit.prevent="addMember">
          <el-form-item label="账号（3–40 位，以英文字母或数字开头，可含点、下划线和短横线）">
            <el-input v-model.trim="username" autocomplete="off" :maxlength="40" />
          </el-form-item>
          <el-form-item label="密码（12–128 个字符）">
            <el-input v-model="password" type="password" autocomplete="new-password" :maxlength="128" showPassword />
          </el-form-item>
          <el-button type="primary" nativeType="submit" :loading="saving" :disabled="!validUsername || password.length < 12">创建成员</el-button>
        </el-form>
      </el-tab-pane>
      <el-tab-pane label="登记已有项目" name="register">
        <el-form labelPosition="top" @submit.prevent="register">
          <el-form-item label="服务器工作区内的相对目录">
            <el-input v-model.trim="path" :maxlength="4096" />
          </el-form-item>
          <el-form-item label="项目所有者">
            <el-select v-model="ownerId" :loading="loading">
              <el-option v-for="member in members" :key="member.id" :label="member.username" :value="member.id" />
            </el-select>
          </el-form-item>
          <el-button type="primary" nativeType="submit" :loading="saving" :disabled="!path || !ownerId">登记项目</el-button>
        </el-form>
      </el-tab-pane>
      <el-tab-pane label="转移所有权" name="transfer">
        <el-form labelPosition="top" @submit.prevent="transfer">
          <el-form-item label="项目">
            <el-select v-model="transferProjectId" filterable :loading="loadingProjects" :disabled="saving" @change="newOwnerId = ''">
              <el-option v-for="item in projects" :key="item.id" :label="`${item.name} · ${item.directory}`" :value="item.id" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="transferProject" label="当前所有者">{{ transferProject.ownerUsername }}</el-form-item>
          <el-form-item label="新所有者">
            <el-select v-model="newOwnerId" filterable :loading="loading" :disabled="saving || !transferProject">
              <el-option v-for="member in transferCandidates" :key="member.id" :label="member.username" :value="member.id" />
            </el-select>
          </el-form-item>
          <el-button type="primary" nativeType="submit" :loading="saving" :disabled="!transferProject || !newOwner">转移所有权</el-button>
        </el-form>
      </el-tab-pane>
    </el-tabs>
  </el-dialog>
  <passwordDialog v-if="visible && passwordAccount" :account="passwordAccount" @close="passwordAccount = undefined" />
</template>

<script setup lang="ts">
import axios from "axios";
import { computed, ref, watch } from "vue";
import { ElMessageBox } from "element-plus";
import type { AuthUser, ProjectOwnership } from "@toonflow/server/auth";
import { authState } from "@/lib/auth";
import passwordDialog from "./passwordDialog.vue";

const visible = defineModel<boolean>({ default: false });
const emit = defineEmits<{ projectsChanged: [] }>();
const activeTab = ref<"users" | "members" | "register" | "transfer">("users");
const passwordAccount = ref<AuthUser>();
const message = ref("");
const loading = ref(false);
const saving = ref(false);
const username = ref("");
const password = ref("");
const path = ref("");
const ownerId = ref("");
const members = ref<AuthUser[]>([]);
const projects = ref<ProjectOwnership[]>([]);
const loadingProjects = ref(false);
const transferProjectId = ref("");
const newOwnerId = ref("");
const transferProject = computed(() => projects.value.find(item => item.id === transferProjectId.value));
const transferCandidates = computed(() => members.value.filter(member => member.id !== transferProject.value?.ownerId));
const newOwner = computed(() => transferCandidates.value.find(member => member.id === newOwnerId.value));
const validUsername = computed(() => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}$/.test(username.value));
watch(visible, open => {
  if (open) return;
  password.value = "";
  passwordAccount.value = undefined;
  message.value = "";
  newOwnerId.value = "";
});
watch([visible, activeTab], ([open, tab]) => {
  if (open && tab === "transfer") void loadProjects();
});

function showError(error: unknown) {
  message.value = axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message || "操作失败，请重试" : "操作失败，请重试";
}

async function loadMembers() {
  loading.value = true;
  try {
    const { data } = await axios.get<{ data: AuthUser[] }>("/api/auth/members");
    members.value = data.data;
    ownerId.value ||= authState.value.user?.id ?? "";
  } catch (error) { showError(error); }
  finally { loading.value = false; }
}

async function loadProjects() {
  if (loadingProjects.value) return;
  loadingProjects.value = true;
  try {
    const { data } = await axios.get<{ data: ProjectOwnership[] }>("/api/projects/ownership");
    projects.value = data.data;
  } catch (error) { showError(error); }
  finally { loadingProjects.value = false; }
}

async function addMember() {
  if (saving.value || !validUsername.value || password.value.length < 12) return;
  saving.value = true;
  message.value = "";
  try {
    const { data } = await axios.post<{ data: AuthUser }>("/api/auth/createMember", { username: username.value, password: password.value });
    members.value.push(data.data);
    ownerId.value = data.data.id;
    message.value = `成员 ${data.data.username} 已创建`;
    username.value = "";
    password.value = "";
  } catch (error) { showError(error); }
  finally { saving.value = false; }
}

async function toggleMember(member: AuthUser) {
  const disabled = !member.disabled;
  const action = disabled ? "停用" : "启用";
  const confirmed = await ElMessageBox.confirm(
    `${disabled ? "停用后该账号将立即退出所有设备，且不能登录" : "启用后该账号可以重新登录"}。确定${action} ${member.username} 吗？`,
    `${action}账号`,
    { type: disabled ? "warning" : "info", confirmButtonText: action, cancelButtonText: "取消" },
  ).then(() => true, () => false);
  if (!confirmed || !visible.value || saving.value) return;
  saving.value = true;
  message.value = "";
  try {
    const { data } = await axios.put<{ data: AuthUser }>("/api/auth/setStatus", { userId: member.id, disabled });
    members.value = members.value.map(item => item.id === member.id ? data.data : item);
    message.value = `${member.username} 已${action}`;
  } catch (error) { showError(error); }
  finally { saving.value = false; }
}

async function register() {
  if (saving.value || !ownerId.value || !path.value) return;
  saving.value = true;
  message.value = "";
  try {
    await axios.post("/api/projects/register", { path: path.value, ownerId: ownerId.value });
    path.value = "";
    message.value = "项目已登记";
    emit("projectsChanged");
  } catch (error) { showError(error); }
  finally { saving.value = false; }
}

async function transfer() {
  const project = transferProject.value;
  const owner = newOwner.value;
  if (saving.value || !project || !owner) return;
  saving.value = true;
  message.value = "";
  try {
    const confirmed = await ElMessageBox.confirm(
      `将“${project.name}”从 ${project.ownerUsername} 转移给 ${owner.username}？原所有者将失去访问权限，其他共享编辑者可以继续使用项目。`,
      "转移项目所有权",
      { type: "warning", confirmButtonText: "转移", cancelButtonText: "取消" },
    ).then(() => true, () => false);
    if (!confirmed || !visible.value || authState.value.user?.role !== "admin") return;
    const { data } = await axios.put<{ data: ProjectOwnership }>("/api/projects/transferOwnership", {
      id: project.id, expectedOwnerId: project.ownerId, newOwnerId: owner.id,
    });
    projects.value = projects.value.map(item => item.id === project.id ? data.data : item);
    newOwnerId.value = "";
    message.value = `项目已转移给 ${data.data.ownerUsername}`;
    emit("projectsChanged");
  } catch (error) {
    showError(error);
    if (axios.isAxiosError(error) && error.response?.status === 409) await loadProjects();
  } finally { saving.value = false; }
}
</script>

<style scoped lang="scss">
.memberList {
  margin: 0;
  padding: 0;

  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 0;
    overflow-wrap: anywhere;
  }

  .memberActions {
    display: flex;
    flex-shrink: 0;
    gap: 4px;
  }
}
</style>
