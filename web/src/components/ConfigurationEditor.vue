<script setup>
import { ref, reactive, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api/index.js';
const loading = ref(false), saving = ref(false), loaded = ref(false), error = ref(''), revision = ref(''), restartRequired = ref(false), tab = ref('connections'), confirmPassword = ref('');
const form = reactive({}), secretFields = ref({});
const groups = [
  { name: 'connections', title: '服务连接', fields: [
    ['QBT_URL', 'qBittorrent 地址'], ['QBT_API_KEY', 'qBittorrent API 密钥', 'secret'], ['JELLYFIN_URL', 'Jellyfin 地址'], ['JELLYFIN_API_KEY', 'Jellyfin API 密钥', 'secret'], ['DEEPSEEK_URL', 'DeepSeek 地址'], ['DEEPSEEK_API_KEY', 'DeepSeek API 密钥', 'secret'], ['DEEPSEEK_MODEL', 'DeepSeek 模型']
  ] },
  { name: 'account', title: '账号与访问', fields: [
    ['ADMIN_USERNAME', '管理员用户名'], ['ADMIN_PASSWORD', '新管理员密码', 'secret'], ['PUBLIC_URL', '面板访问地址'], ['HOST', '监听地址'], ['PORT', '监听端口', 'number'], ['COOKIE_SECURE', '仅通过 HTTPS 发送登录 cookie', 'boolean'], ['TRUST_PROXY', '信任反向代理', 'boolean'], ['SESSION_TTL_MS', '登录会话有效期（毫秒）', 'number']
  ] },
  { name: 'callbacks', title: '回调与目录', fields: [
    ['WORKFLOW_CALLBACK_URL', '下载完成回调地址（可选）'], ['WEBHOOK_AUTH_ENABLED', '下载回调认证', 'boolean'], ['WORKFLOW_API_TOKEN', '回调与定时清理令牌', 'secret'], ['QBT_PATH_PREFIX', 'qBittorrent 路径前缀'], ['JELLYFIN_PATH_PREFIX', 'Jellyfin 路径前缀']
  ] },
  { name: 'advanced', title: '运行参数', fields: [
    ['REQUEST_TIMEOUT_MS', '接口请求超时（毫秒）', 'number'], ['POLL_INTERVAL_MS', '轮询间隔（毫秒）', 'number'], ['SCAN_TIMEOUT_MS', '媒体扫描超时（毫秒）', 'number'], ['VERIFY_TIMEOUT_MS', '验证超时（毫秒）', 'number'], ['TORRENT_FILES_TIMEOUT_MS', '种子文件等待超时（毫秒）', 'number'], ['INGEST_RETRIES', '识别重试次数', 'number'], ['MAX_QUEUE', '最大队列长度', 'number'], ['MAX_JOBS', '最大保留任务数', 'number'], ['JOB_TTL_MS', '任务保留时间（毫秒）', 'number'], ['SHUTDOWN_TIMEOUT_MS', '关闭服务等待时间（毫秒）', 'number'], ['MEDIA_CURSOR_FILE', '媒体游标文件路径']
  ] }
];
function clearSecrets() { for (const key of Object.keys(secretFields.value)) form[key] = ''; confirmPassword.value = ''; }
function apply(view) {
  for (const key of Object.keys(form)) delete form[key];
  Object.assign(form, view.values); secretFields.value = view.secretFields; clearSecrets();
  revision.value = view.revision; restartRequired.value = view.restartRequired; loaded.value = true;
}
async function load() {
  loading.value = true; loaded.value = false; error.value = '';
  try { apply(await api('/config', { quiet: true })); }
  catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}
async function save() {
  if (!loaded.value || loading.value || saving.value) return;
  error.value = '';
  if (form.ADMIN_PASSWORD && form.ADMIN_PASSWORD !== confirmPassword.value) { error.value = '两次输入的管理员密码不一致'; tab.value = 'account'; return; }
  saving.value = true;
  try { apply(await api('/config', { method: 'PUT', body: { values: { ...form }, revision: revision.value }, quiet: true })); ElMessage.success(restartRequired.value ? '基础配置已保存，重启服务后生效' : '基础配置已保存'); }
  catch (e) { error.value = e.message; }
  finally { saving.value = false; }
}
function bounds(key) { return { PORT: [1, 65535], INGEST_RETRIES: [0, 5], MAX_JOBS: [10, 10000], MAX_QUEUE: [1, 1000] }[key] ?? [1, 100000000]; }
onMounted(load);
onBeforeUnmount(clearSecrets);
</script>
<template>
  <section class="panel" aria-label="基础配置表单">
    <div class="panel-header"><h2>配置内容</h2></div>
    <div class="panel-body">
    <el-alert title="密码和密钥留空表示保留原值。保存后请重启服务，当前运行配置会继续使用至重启。" type="info" show-icon :closable="false" />
    <el-alert v-if="restartRequired" title="存在已保存但尚未生效的配置，请重启服务。" type="warning" show-icon :closable="false" />
    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" />
    <el-form label-position="top" :disabled="!loaded || loading || saving" class="configuration-form" @submit.prevent="save">
      <el-tabs v-model="tab"><el-tab-pane v-for="group in groups" :key="group.name" :label="group.title" :name="group.name">
        <div class="configuration-fields"><el-row :gutter="16"><el-col v-for="[key, label, type] in group.fields" :key="key" :xs="24" :sm="12">
          <el-form-item :label="label">
            <el-switch v-if="type === 'boolean'" v-model="form[key]" :aria-label="label" />
            <el-input-number v-else-if="type === 'number'" v-model="form[key]" :aria-label="label" :min="bounds(key)[0]" :max="bounds(key)[1]" controls-position="right" />
            <el-input v-else v-model="form[key]" :aria-label="label" :type="type === 'secret' ? 'password' : 'text'" :show-password="type === 'secret'" :autocomplete="type === 'secret' ? 'new-password' : 'off'" :placeholder="type === 'secret' ? (secretFields[key] ? '已配置，留空保留' : '未配置') : ''" />
          </el-form-item>
          <el-form-item v-if="key === 'ADMIN_PASSWORD' && form.ADMIN_PASSWORD" label="确认新管理员密码"><el-input v-model="confirmPassword" aria-label="确认新管理员密码" type="password" show-password autocomplete="new-password" /></el-form-item>
        </el-col></el-row></div>
      </el-tab-pane></el-tabs>
    </el-form>
    <div class="configuration-actions"><el-button :disabled="loading || saving" @click="load">重新读取</el-button><el-button type="primary" :disabled="!loaded || loading" :loading="saving" @click="save">保存基础配置</el-button></div>
    </div>
  </section>
</template>
<style scoped>
.configuration-form { margin-top: 20px; }
.configuration-fields { padding: 4px 8px; }
.configuration-actions { display: flex; justify-content: flex-end; margin-top: 20px; }
.el-input-number { width: 100%; }
.el-alert + .el-alert { margin-top: 12px; }
</style>
