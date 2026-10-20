<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api, setSession } from '../api/index.js';
const loading = ref(false), saving = ref(false), loaded = ref(false), error = ref(''), revision = ref(''), restartRequired = ref(false), tab = ref('connections'), confirmPassword = ref('');
const form = reactive({}), secretFields = ref({});
const runtime = ref(null), restarting = ref(false), savedForm = ref(''), router = useRouter();
const dirty = computed(() => loaded.value && JSON.stringify(form) !== savedForm.value);
let active = true, restartAbort;
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
    ['REQUEST_TIMEOUT_MS', '接口请求超时（毫秒）', 'number'], ['POLL_INTERVAL_MS', '轮询间隔（毫秒）', 'number'], ['SCAN_TIMEOUT_MS', '媒体扫描超时（毫秒）', 'number'], ['LIBRARY_REFRESH_WAIT_MS', '媒体库刷新后等待时间（毫秒，0 表示不等待）', 'number'], ['VERIFY_TIMEOUT_MS', '验证超时（毫秒）', 'number'], ['TORRENT_FILES_TIMEOUT_MS', '种子文件等待超时（毫秒）', 'number'], ['INGEST_RETRIES', '识别重试次数', 'number'], ['MAX_QUEUE', '最大队列长度', 'number'], ['MAX_JOBS', '最大保留任务数', 'number'], ['JOB_TTL_MS', '任务保留时间（毫秒）', 'number'], ['SHUTDOWN_TIMEOUT_MS', '关闭服务等待时间（毫秒）', 'number'], ['MEDIA_CURSOR_FILE', '媒体游标文件路径']
  ] }
];
function clearSecrets() { for (const key of Object.keys(secretFields.value)) form[key] = ''; confirmPassword.value = ''; }
function apply(view) {
  for (const key of Object.keys(form)) delete form[key];
  Object.assign(form, view.values); secretFields.value = view.secretFields; clearSecrets();
  revision.value = view.revision; restartRequired.value = view.restartRequired; loaded.value = true;
  savedForm.value = JSON.stringify(form);
}
async function load() {
  loading.value = true; loaded.value = false; error.value = '';
  try {
    const [view, status] = await Promise.all([api('/config', { quiet: true }), api('/service/status', { quiet: true })]);
    apply(view); runtime.value = status;
  }
  catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}
async function save() {
  if (!loaded.value || loading.value || saving.value || restarting.value) return;
  error.value = '';
  if (form.ADMIN_PASSWORD && form.ADMIN_PASSWORD !== confirmPassword.value) { error.value = '两次输入的管理员密码不一致'; tab.value = 'account'; return; }
  saving.value = true;
  try { apply(await api('/config', { method: 'PUT', body: { values: { ...form }, revision: revision.value }, quiet: true })); ElMessage.success(restartRequired.value ? '基础配置已保存，重启服务后生效' : '基础配置已保存'); }
  catch (e) { error.value = e.message; }
  finally { saving.value = false; }
}
async function restart() {
  if (!loaded.value || loading.value || saving.value || restarting.value || dirty.value || !runtime.value?.supported) return;
  try {
    await ElMessageBox.confirm('将重启服务以加载已保存配置。任务历史和登录会话会清空，服务恢复后需要重新登录。继续？', '重启服务', { confirmButtonText: '确认重启', cancelButtonText: '取消', type: 'warning' });
  } catch { return; }
  if (!active) return;
  restarting.value = true; error.value = ''; restartAbort = new AbortController();
  try {
    const accepted = await api('/service/restart', { method: 'POST', body: { revision: revision.value }, quiet: true });
    const deadline = Date.now() + 60000;
    while (active && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!active) return;
      try {
        const response = await fetch('/health', { cache: 'no-store', signal: AbortSignal.any([restartAbort.signal, AbortSignal.timeout(2000)]) });
        if (!response.ok) continue;
        const result = (await response.json()).data;
        if (result?.status === 'ok' && result.instanceId && result.instanceId !== accepted.instanceId) {
          clearSecrets(); setSession(null); await router.replace('/login'); return;
        }
      } catch { /* The listener is briefly unavailable while PM2 starts the new process. */ }
    }
    if (active) throw new Error('暂未连接到重启后的服务，请稍后刷新；如果修改了监听地址或端口，请检查 Docker 端口映射及访问地址。');
  } catch (e) { if (active) error.value = e.message; }
  finally { if (active) restarting.value = false; }
}
function bounds(key) { return { PORT: [1, 65535], INGEST_RETRIES: [0, 5], MAX_JOBS: [10, 10000], MAX_QUEUE: [1, 1000], LIBRARY_REFRESH_WAIT_MS: [0, 100000000] }[key] ?? [1, 100000000]; }
onMounted(load);

onBeforeUnmount(() => { active = false; restartAbort?.abort(); clearSecrets(); });
</script>
<template>
  <section class="panel" aria-label="基础配置表单">
    <div class="panel-header"><h2>配置内容</h2></div>
    <div class="panel-body">
    <el-alert title="密码和密钥留空表示保留原值。保存后请重启服务，当前运行配置会继续使用至重启。" type="info" show-icon :closable="false" />
    <el-alert v-if="restartRequired" title="存在已保存但尚未生效的配置，请重启服务。" type="warning" show-icon :closable="false" />
    <el-alert v-if="restarting" title="正在重启服务，请稍候。恢复后将进入登录页。" type="info" show-icon :closable="false" />
    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" />
    <el-form label-position="top" :disabled="!loaded || loading || saving || restarting" class="configuration-form" @submit.prevent="save">
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
    <p v-if="loaded && !runtime?.supported" class="muted">当前服务未由 PM2 管理，无法从页面重启。请使用 PM2 启动服务。</p>
    <p v-else-if="dirty" class="muted">有未保存的修改，请先保存配置，再重启服务。</p>
    <div class="configuration-actions"><el-button :disabled="loading || saving || restarting" @click="load">重新读取</el-button><el-button type="warning" :disabled="!loaded || loading || saving || dirty || !runtime?.supported" :loading="restarting" @click="restart">重启服务</el-button><el-button type="primary" :disabled="!loaded || loading || restarting" :loading="saving" @click="save">保存基础配置</el-button></div>
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
