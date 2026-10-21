<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api/index.js';
import { copyText } from '../utils/clipboard.js';
import CleanupHistory from './CleanupHistory.vue';
const historyPanel=ref(null);
const deleteFiles = ref(false), savedDeleteFiles = ref(false), loaded = ref(false), loading = ref(false), saving = ref(false), busy = ref(false), error = ref(''), result = ref(null);
const callUrl = new URL('/api/qbittorrent/cleanup-missing-files', window.location.origin).href;
const authRequired = ref(true), callReady = ref(false), callError = ref(''), callLoading = ref(false);
const shellQuote = value => `'${value.replaceAll("'", "'\"'\"'")}'`;
const callCommand = computed(() => `curl -q --fail-with-body --silent --show-error --connect-timeout 5 --max-time 120 --request POST ${authRequired.value ? "--header 'Authorization: Bearer <WORKFLOW_API_TOKEN>' " : ''}--header 'Content-Type: application/json' --data '{"dryRun":false}' ${shellQuote(callUrl)}`);
async function loadCall() {
  callLoading.value = true; callError.value = '';
  try { const details = await api('/notifications/context', { quiet: true }); authRequired.value = details.webhookAuthRequired; callReady.value = true; }
  catch (e) { callError.value = e.message; }
  finally { callLoading.value = false; }
}
async function copyCall(command = false) {
  try { await copyText(command ? callCommand.value : callUrl); ElMessage.success(command && authRequired.value ? 'curl 命令已复制，请替换令牌占位符' : command ? 'curl 命令已复制' : '调用链接已复制'); }
  catch { ElMessage.info('复制失败，请手动复制下方内容'); }
}
async function load() {
  loading.value = true;
  loaded.value = false;
  result.value = null;
  try { const settings = await api('/qbittorrent/cleanup-settings', { quiet: true }); deleteFiles.value = savedDeleteFiles.value = settings.deleteFiles; loaded.value = true; error.value = ''; }
  catch (e) { loaded.value = false; error.value = e.message; }
  finally { loading.value = false; }
}
async function save() {
  if (!loaded.value || loading.value || saving.value || busy.value) return;
  saving.value = true;
  error.value = ''; result.value = null;
  try { const settings = await api('/qbittorrent/cleanup-settings', { method: 'PUT', body: { deleteFiles: deleteFiles.value }, quiet: true }); deleteFiles.value = savedDeleteFiles.value = settings.deleteFiles; ElMessage.success('清理设置已保存'); }
  catch (e) { deleteFiles.value = savedDeleteFiles.value; error.value = e.message; }
  finally { saving.value = false; }
}
async function cleanup(dryRun) {
  if (!loaded.value || loading.value || saving.value || busy.value) return;
  busy.value = true;
  try {
    if (!dryRun) await ElMessageBox.confirm(savedDeleteFiles.value ? '将清理所有 missingFiles 种子，同时删除其下载文件。继续？' : '将清理所有 missingFiles 种子任务，保留下载文件。继续？', '确认清理', { type: 'warning', confirmButtonText: '执行清理', cancelButtonText: '取消' });
    result.value = await api('/qbittorrent/cleanup-missing-files', { method: 'POST', body: { dryRun, expectedDeleteFiles: savedDeleteFiles.value } });
    error.value = '';
  } catch (e) { if (e.data) result.value = e.data; if (e instanceof Error) error.value = e.message; }
  finally { busy.value = false;historyPanel.value?.load(); }
}
onMounted(load);
onMounted(loadCall);
</script>
<template>
  <section class="panel">
    <div class="panel-header"><h2>文件丢失种子清理</h2><el-button :disabled="loading || busy || saving" @click="load">读取清理设置</el-button></div>
    <div class="panel-body">
      <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" />
      <el-form label-position="top" :disabled="!loaded || busy || saving">
        <div class="cleanup-setting">
          <div class="cleanup-setting-row"><span class="cleanup-setting-title">同时删除下载文件</span><el-switch v-model="deleteFiles" :loading="saving" aria-label="同时删除下载文件" @change="save" /></div>
          <p class="muted">{{ deleteFiles ? '清理种子时，同时删除下载文件。' : '仅删除种子任务，保留下载文件。' }}</p>
          <p class="muted" aria-live="polite">{{ saving ? '正在保存设置…' : '自动保存，手动清理与定时调用共用。' }}</p>
        </div>
        <div class="button-group">
        <el-button :loading="busy" @click="cleanup(true)">预览清理</el-button>
        <el-button type="danger" :loading="busy" @click="cleanup(false)">清理文件丢失种子</el-button>
        </div>
      </el-form>
      <p class="muted">仅处理 missingFiles（文件丢失），不处理其他状态，不触发媒体扫描。</p>
      <div v-if="result">
        <p>{{ result.dryRun ? '清理预览' : '清理结果' }}：匹配 {{ result.matchedCount }} 个，已删除 {{ result.deletedCount }} 个，跳过 {{ result.skippedCount }} 个，失败 {{ result.failedCount }} 个。{{ result.deleteFiles ? '同时删除下载文件' : '保留下载文件' }}。</p>
        <el-table :data="result.items"><el-table-column prop="name" label="种子名称" min-width="220" /><el-table-column label="状态" width="110"><template #default="{ row }">{{ { would_delete: '待清理', deleted: '已删除', skipped: '已跳过', failed: '失败' }[row.status] }}</template></el-table-column><el-table-column label="说明" min-width="200"><template #default="{ row }">{{ row.reason || row.error || '' }}</template></el-table-column></el-table>
      </div>
    </div>
  </section>
  <section class="panel">
    <div class="panel-header"><h2>定时调用</h2><div class="button-group"><el-button size="small" @click="copyCall()">复制调用链接</el-button><el-button size="small" :disabled="!callReady" @click="copyCall(true)">复制 curl 命令</el-button></div></div>
    <div class="panel-body">
      <el-alert v-if="callError" :title="callError" type="error" :closable="false" show-icon><el-button :loading="callLoading" @click="loadCall">重新读取</el-button></el-alert>
      <el-input :model-value="callUrl" readonly aria-label="定时调用链接" />
      <p class="muted">使用 POST 调用，权限与通知一致。{{ callReady ? (authRequired ? '需替换命令中的 <WORKFLOW_API_TOKEN>。' : '当前通知免认证，命令无需令牌。') : '正在读取认证设置。' }}执行时按已保存的“同时删除下载文件”开关清理。</p>
      <pre v-if="callReady" class="code">{{ callCommand }}</pre>
    </div>
  </section>
  <CleanupHistory ref="historyPanel" />
</template>
<style scoped>
.cleanup-setting { padding: 12px 16px; margin-bottom: 18px; border: 1px solid var(--el-border-color); border-radius: 8px; background: #f8fafb; }
.cleanup-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.cleanup-setting-title { font-size: 14px; font-weight: 500; }
.cleanup-setting-row :deep(.el-switch) { flex-shrink: 0; }
.cleanup-setting p { margin: 4px 0 0; line-height: 1.7; }
</style>
