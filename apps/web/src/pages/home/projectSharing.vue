<template>
  <el-dialog v-model="visible" :title="`${name} · 共享成员`" width="min(460px, 92vw)" appendToBody @closed="emit('close')">
    <el-form labelPosition="top" @submit.prevent="updateMember()">
      <el-form-item label="允许编辑此项目的账号">
        <el-input v-model.trim="username" autocomplete="off" :maxlength="40" />
      </el-form-item>
      <el-button type="primary" nativeType="submit" :loading="busy" :disabled="!username">添加成员</el-button>
    </el-form>
    <ul v-if="members.length" class="memberList">
      <li v-for="member in members" :key="member.id">
        <span>{{ member.username }}</span>
        <el-button text :disabled="busy" :aria-label="`移除 ${member.username}`" @click="updateMember(member.id)">移除</el-button>
      </li>
    </ul>
    <p v-if="error" role="alert">{{ error }}</p>
  </el-dialog>
</template>

<script setup lang="ts">
import axios from "axios";
import { onMounted, ref } from "vue";

const props = defineProps<{ projectId: string; name: string }>();
const emit = defineEmits<{ close: [] }>();
const visible = ref(true);
const members = ref<{ id: string; username: string }[]>([]);
const username = ref("");
const busy = ref(false);
const error = ref("");

async function loadMembers() {
  const { data } = await axios.get("/api/projects/members", { params: { id: props.projectId } });
  members.value = data.data;
}

function showError(cause: unknown) {
  error.value = axios.isAxiosError(cause) && cause.response?.data?.message || "读取或更新共享成员失败";
}

async function updateMember(userId?: string) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    if (userId) await axios.delete("/api/projects/unshare", { data: { id: props.projectId, userId } });
    else await axios.put("/api/projects/share", { id: props.projectId, username: username.value });
    username.value = "";
    await loadMembers();
  } catch (cause) { showError(cause); }
  finally { busy.value = false; }
}

onMounted(() => loadMembers().catch(showError));
</script>

<style scoped lang="scss">
.memberList {
  padding: 0;
  li { display: flex; align-items: center; justify-content: space-between; }
}
</style>
