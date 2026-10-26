<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Dashboard from './components/Dashboard.vue';
import LoginView from './components/LoginView.vue';
import { api, errorMessage } from './api';
import type { AuthMe } from './types';

const me = ref<AuthMe | null>(null);
const loading = ref(true);
const bootError = ref<string | null>(null);
const showLogin = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  bootError.value = null;
  try {
    const next = await api<AuthMe>('/api/auth/me');
    me.value = next;
    showLogin.value = next.auth.signInRequired && !next.authenticated;
  } catch (error) {
    bootError.value = errorMessage(error);
  } finally {
    loading.value = false;
  }
}

function onSignedIn(next: AuthMe): void {
  me.value = next;
  showLogin.value = false;
}

async function signOut(): Promise<void> {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // The cookie may already be gone; reloading reflects the real state.
  }
  await load();
}

onMounted(load);
</script>

<template>
  <div class="app">
    <div v-if="loading" class="login">
      <div class="login-card"><h1>iCamify</h1><p class="sub">Connecting…</p></div>
    </div>

    <div v-else-if="bootError" class="login">
      <div class="login-card">
        <h1>iCamify</h1>
        <p class="error-text">{{ bootError }}</p>
        <button class="primary" @click="load">Retry</button>
      </div>
    </div>

    <LoginView
      v-else-if="showLogin && me"
      :auth="me.auth"
      :can-dismiss="me.auth.allowAnonymousViewing"
      @signed-in="onSignedIn"
      @dismiss="showLogin = false"
    />

    <Dashboard v-else-if="me" :me="me" @sign-out="signOut" @sign-in="showLogin = true" />
  </div>
</template>
