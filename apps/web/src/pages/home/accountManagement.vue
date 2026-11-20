<template>
  <el-dialog v-model="visible" title="账号和项目管理" width="min(520px, 92vw)" appendToBody @open="loadMembers">
    <p v-if="message" role="status">{{ message }}</p>
    <el-form labelPosition="top" @submit.prevent="addMember">
      <h3>创建成员</h3>
      <el-form-item label="账号（3–40 位，以英文字母或数字开头，可含点、下划线和短横线）">
        <el-input v-model.trim="username" autocomplete="off" :maxlength="40" />
      </el-form-item>
      <el-form-item label="密码（12–128 个字符）">
        <el-input v-model="password" type="password" autocomplete="new-password" :maxlength="128" showPassword />
      </el-form-item>
      <el-button type="primary" nativeType="submit" :loading="saving" :disabled="!validUsername || password.length < 12">创建成员</el-button>
    </el-form>
    <el-divider />
    <el-form labelPosition="top" @submit.prevent="register">
      <h3>登记已有项目</h3>
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
  </el-dialog>
</template>

<script setup lang="ts">
import axios from "axios";
import { computed, ref, watch } from "vue";
import type { AuthUser } from "@toonflow/server/auth";
import { authState } from "@/lib/auth";

const visible = defineModel<boolean>({ default: false });
const emit = defineEmits<{ registered: [] }>();
const message = ref("");
const loading = ref(false);
const saving = ref(false);
const username = ref("");
const password = ref("");
const path = ref("");
const ownerId = ref("");
const members = ref<AuthUser[]>([]);
const validUsername = computed(() => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}$/.test(username.value));
watch(visible, open => {
  if (open) return;
  password.value = "";
  message.value = "";
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

async function register() {
  if (saving.value || !ownerId.value || !path.value) return;
  saving.value = true;
  message.value = "";
  try {
    await axios.post("/api/projects/register", { path: path.value, ownerId: ownerId.value });
    path.value = "";
    message.value = "项目已登记";
    emit("registered");
  } catch (error) { showError(error); }
  finally { saving.value = false; }
}
</script>
