<template>
  <el-dialog v-model="visible" :title="`${ownAccount ? '修改密码' : '重置密码'} · ${account.username}`" width="min(420px, 92vw)" appendToBody
    :closeOnClickModal="false" :closeOnPressEscape="!saving" :showClose="!saving" @closed="emit('close')">
    <el-form labelPosition="top" :disabled="saving" @submit.prevent="submit">
      <el-form-item v-if="ownAccount" label="当前密码">
        <el-input v-model="currentPassword" type="password" autocomplete="current-password" :maxlength="128" showPassword />
      </el-form-item>
      <el-form-item label="新密码（12–128 个字符）">
        <el-input v-model="newPassword" type="password" autocomplete="new-password" :maxlength="128" showPassword />
      </el-form-item>
      <el-form-item label="确认新密码" :error="confirmation && confirmation !== newPassword ? '两次输入的新密码不一致' : ''">
        <el-input v-model="confirmation" type="password" autocomplete="new-password" :maxlength="128" showPassword />
      </el-form-item>
      <p>保存后，该账号在所有设备上都需要重新登录。</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <el-button type="primary" nativeType="submit" :loading="saving" :disabled="!canSubmit">{{ ownAccount ? "修改密码" : "重置密码" }}</el-button>
    </el-form>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import axios from "axios";
import { ElMessage } from "element-plus";
import type { AuthUser } from "@toonflow/server/auth";
import { authState, changeOwnPassword } from "@/lib/auth";

const props = defineProps<{ account: AuthUser }>();
const emit = defineEmits<{ close: [] }>();
const visible = ref(true);
const currentPassword = ref("");
const newPassword = ref("");
const confirmation = ref("");
const error = ref("");
const saving = ref(false);
const ownAccount = computed(() => props.account.id === authState.value.user?.id);
const canSubmit = computed(() => (!ownAccount.value || !!currentPassword.value) && newPassword.value.length >= 12 && confirmation.value === newPassword.value);

async function submit() {
  if (!canSubmit.value || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    if (ownAccount.value) {
      await changeOwnPassword(currentPassword.value, newPassword.value);
    } else {
      await axios.put("/api/auth/resetPassword", { userId: props.account.id, newPassword: newPassword.value });
      ElMessage.success(`已重置 ${props.account.username} 的密码`);
      visible.value = false;
    }
  } catch (cause) {
    error.value = axios.isAxiosError(cause) && cause.response?.data?.message || "密码更新失败，请重试";
  } finally { saving.value = false; }
}
</script>
