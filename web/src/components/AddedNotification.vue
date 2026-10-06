<script setup>
import { ref, onMounted, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api/index.js';
import { useRouter } from 'vue-router';
const router = useRouter(), checking = ref(false);
const props = defineProps({ callbackUrl: String, authRequired: { type: Boolean, default: true } });
const form = ref({ enabled: false, program: '' });
const loaded = ref(false), loading = ref(false), saving = ref(false), error = ref('');
const configPath = ref('/config/z-media-workflow/.env.notify-added.curl');
const envTemplate = computed(() => `url = "${props.callbackUrl}"\nrequest = "POST"\nheader = "Authorization: Bearer 填入服务端独立WORKFLOW_API_TOKEN"\nsilent\nshow-error\nfail\nconnect-timeout = 5\nmax-time = 15\nretry = 2\nretry-connrefused`);
async function load() {
  loading.value = true;
  try { form.value = await api('/qbittorrent/added-notification', { quiet: true }); loaded.value = true; error.value = ''; }
  catch (e) { loaded.value = false; error.value = e.message; }
  finally { loading.value = false; }
}
function generate() {
  if (props.authRequired) {
    if (!configPath.value.trim() || /["\r\n\0]/.test(configPath.value)) { ElMessage.error('配置文件路径无效'); return; }
    form.value.program = `curl -q --config "${configPath.value.trim()}" --data-urlencode "hash=%I"`;
  } else form.value.program = `curl -q --fail --silent --show-error --connect-timeout 5 --max-time 15 --retry 2 --retry-connrefused --data-urlencode "hash=%I" "${props.callbackUrl}"`;
}
async function save() {
  if (form.value.enabled && !form.value.program.trim()) { ElMessage.error('启用通知时请填写通知命令'); return; }
  saving.value = true;
  try { form.value = await api('/qbittorrent/added-notification', { method: 'PUT', body: form.value }); ElMessage.success('新增种子通知已保存，并回读确认'); }
  catch {} finally { saving.value = false; }
}
onMounted(load);
async function checkExisting() {
  checking.value = true;
  try { const job = await api('/workflows/check-torrents', { method: 'POST', body: {} }); await router.push(`/jobs/${job.id}`); }
  catch {} finally { checking.value = false; }
}
</script>
<template>
  <section class="panel">
    <div class="panel-header"><h2>新增种子通知</h2><div class="toolbar"><el-button :loading="checking" @click="checkExisting">检查已有种子</el-button><el-button :loading="loading" :disabled="saving" @click="load">读取新增通知配置</el-button></div></div>
    <div class="panel-body">
      <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" />
      <el-form label-position="top" :disabled="!loaded || loading || saving">
        <el-form-item label="添加种子后运行外部程序"><el-switch v-model="form.enabled" aria-label="启用新增种子通知" /></el-form-item>
        <el-form-item label="新增种子通知命令"><el-input v-model="form.program" aria-label="新增种子通知命令" maxlength="4096" /></el-form-item>
        <el-form-item v-if="authRequired" label="qBittorrent 容器内的 curl 配置文件"><el-input v-model="configPath" aria-label="新增通知文件路径" /></el-form-item>
        <el-button @click="generate">生成新增通知命令</el-button><el-button type="primary" :loading="saving" @click="save">保存新增通知配置</el-button>
      </el-form>
      <p class="muted">仅检查分类名称包含 series 的种子（不区分大小写）。文件中有 E/EP 集号但缺少季号时，由 AI 判断季号，再通过 qBittorrent 规范文件名；不确定时保留原名。“检查已有种子”会批量检查符合分类条件的下载中及已完成种子，不依赖通知开关。通知模板生成后需保存才生效。</p>
      <pre v-if="authRequired" class="code">{{ envTemplate }}</pre>
      <p v-else class="muted">内网回调直接使用 curl，无需 Node.js、token 或配置文件。</p>
    </div>
  </section>
</template>
