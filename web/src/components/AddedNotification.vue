<script setup>
import { ref, onMounted, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api/index.js';
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
</script>
<template>
  <section class="panel">
    <div class="panel-header"><h2>新增种子通知</h2><el-button :loading="loading" :disabled="saving" @click="load">读取新增通知配置</el-button></div>
    <div class="panel-body">
      <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" />
      <el-form label-position="top" :disabled="!loaded || loading || saving">
        <el-form-item label="添加种子后运行外部程序"><el-switch v-model="form.enabled" aria-label="启用新增种子通知" /></el-form-item>
        <el-form-item label="新增种子通知命令"><el-input v-model="form.program" aria-label="新增种子通知命令" maxlength="4096" /></el-form-item>
        <el-form-item v-if="authRequired" label="qBittorrent 容器内的 curl 配置文件"><el-input v-model="configPath" aria-label="新增通知文件路径" /></el-form-item>
        <div class="button-group"><el-button @click="generate">生成新增通知命令</el-button><el-button type="primary" :loading="saving" @click="save">保存新增通知配置</el-button></div>
      </el-form>
      <p class="muted">通知仅检查“命名检查”页面中配置的剧集分类，为缺少季号的剧集文件补充季号。通知模板生成后需保存才生效；配置分类或检查已有种子请前往<router-link to="/torrent-naming">命名检查</router-link>。</p>
      <pre v-if="authRequired" class="code">{{ envTemplate }}</pre>
      <p v-else class="muted">内网回调直接使用 curl，无需 Node.js、token 或配置文件。</p>
    </div>
  </section>
</template>
