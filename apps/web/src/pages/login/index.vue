<template>
  <main class="loginPage">
    <el-card class="loginCard" shadow="never">
      <img :src="logoUrl" alt="" width="48" height="48" />
      <h1>登录 Toonflow</h1>
      <el-form labelPosition="top" @submit.prevent="submit">
        <el-form-item label="账号">
          <el-input v-model.trim="username" name="username" autocomplete="username" :maxlength="40" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="password" type="password" name="password" autocomplete="current-password" :maxlength="128" showPassword />
        </el-form-item>
        <p v-if="loginError" class="loginError" role="alert">{{ loginError }}</p>
        <el-button class="signInButton" type="primary" nativeType="submit" :loading="loading" :disabled="!username || !password">登录</el-button>
      </el-form>
    </el-card>
  </main>
</template>

<script setup lang="ts">
import axios from "axios";
import { ref } from "vue";
import { useRoute } from "vue-router";
import logoUrl from "@toonflow/assets/logo.svg";
import { signIn } from "@/lib/auth";

const route = useRoute();
const username = ref("");
const password = ref("");
const loading = ref(false);
const loginError = ref("");

async function submit() {
  if (loading.value || !username.value || !password.value) return;
  loading.value = true;
  loginError.value = "";
  try {
    await signIn(username.value, password.value, route.query.redirect);
  } catch (error) {
    loginError.value = axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message || "登录失败，请重试" : "登录失败，请重试";
    loading.value = false;
  }
}
</script>

<style lang="scss" scoped>
.loginPage {
  display: grid;
  min-height: 100dvh;
  place-items: center;
  padding: 24px;
  background: var(--el-fill-color-light);

  .loginCard {
    width: min(100%, 380px);

    h1 { margin: 12px 0 24px; }
    .signInButton { width: 100%; }
    .loginError { color: var(--el-color-danger); }
  }
}
</style>
