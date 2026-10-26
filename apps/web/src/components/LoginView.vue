<script setup lang="ts">
import { ref } from 'vue';
import { api, errorMessage } from '../api';
import type { AuthMe } from '../types';

const props = defineProps<{ auth: AuthMe['auth']; canDismiss?: boolean }>();
const emit = defineEmits<{ (event: 'signed-in', me: AuthMe): void; (event: 'dismiss'): void }>();

const username = ref('');
const password = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

async function submit(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: username.value, password: password.value }),
    });
    const me = await api<AuthMe>('/api/auth/me');
    emit('signed-in', me);
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login">
    <form class="login-card" @submit.prevent="submit">
      <h1>iCamify</h1>
      <p class="sub">Sign in to view your cameras.</p>

      <div class="field">
        <label for="username">Username</label>
        <input id="username" v-model="username" autocomplete="username" required autofocus />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" v-model="password" type="password" autocomplete="current-password" required />
      </div>

      <button class="primary" type="submit" :disabled="busy" style="width: 100%">
        {{ busy ? 'Signing in…' : 'Sign in' }}
      </button>

      <p v-if="error" class="error-text">{{ error }}</p>
      <p v-if="props.auth.userCount === 0" class="hint">
        No accounts exist yet. Generate a hash with <code>icamify user hash</code> and add it to
        <code>auth.users</code>, then restart the server.
      </p>
      <p v-if="props.canDismiss" class="hint">
        <button class="ghost" type="button" @click="emit('dismiss')">Continue without signing in</button>
      </p>
    </form>
  </div>
</template>
