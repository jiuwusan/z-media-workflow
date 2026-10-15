<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api/index.js';
import AddedNotification from '../components/AddedNotification.vue';
import CompletionNotification from '../components/CompletionNotification.vue';
const context = ref(null), loading = ref(false), error = ref('');
async function load() {
  loading.value = true; error.value = '';
  try { context.value = await api('/notifications/context', { quiet: true }); }
  catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}
onMounted(load);
</script>
<template>
  <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon><el-button :loading="loading" @click="load">重新读取</el-button></el-alert>
  <div v-loading="loading">
    <AddedNotification v-if="context" :callback-url="context.addedCallbackUrl" :auth-required="context.webhookAuthRequired" />
    <CompletionNotification v-if="context" :callback-url="context.callbackUrl" :auth-required="context.webhookAuthRequired" />
  </div>
</template>
