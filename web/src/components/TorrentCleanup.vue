<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api/index.js';
const deleteFiles = ref(false), savedDeleteFiles = ref(false), loaded = ref(false), loading = ref(false), saving = ref(false), busy = ref(false), error = ref(''), result = ref(null);
const dirty = computed(() => deleteFiles.value !== savedDeleteFiles.value);
async function load() {
  loading.value = true;
  loaded.value = false;
  result.value = null;
  try { const settings = await api('/qbittorrent/cleanup-settings', { quiet: true }); deleteFiles.value = savedDeleteFiles.value = settings.deleteFiles; loaded.value = true; error.value = ''; }
  catch (e) { loaded.value = false; error.value = e.message; }
  finally { loading.value = false; }
}
async function save() {
  saving.value = true;
  try { const settings = await api('/qbittorrent/cleanup-settings', { method: 'PUT', body: { deleteFiles: deleteFiles.value } }); deleteFiles.value = savedDeleteFiles.value = settings.deleteFiles; result.value = null; ElMessage.success('清理设置已保存'); }
  catch {} finally { saving.value = false; }
}
async function cleanup(dryRun) {
  busy.value = true;
  try {
    if (!dryRun) await ElMessageBox.confirm(savedDeleteFiles.value ? '将清理所有 missingFiles 种子，同时删除其下载文件。继续？' : '将清理所有 missingFiles 种子任务，保留下载文件。继续？', '确认清理', { type: 'warning', confirmButtonText: '执行清理', cancelButtonText: '取消' });
    result.value = await api('/qbittorrent/cleanup-missing-files', { method: 'POST', body: { dryRun, expectedDeleteFiles: savedDeleteFiles.value } });
    error.value = '';
  } catch (e) { if (e.data) result.value = e.data; if (e instanceof Error) error.value = e.message; }
  finally { busy.value = false; }
}
onMounted(load);
</script>
<template>
  <section class="panel">
    <div class="panel-header"><h2>文件丢失种子清理</h2><el-button :disabled="loading || busy || saving" @click="load">读取清理设置</el-button></div>
    <div class="panel-body">
      <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" />
      <el-form label-position="top" :disabled="!loaded || busy || saving">
        <el-form-item label="同时删除下载文件"><el-switch v-model="deleteFiles" aria-label="同时删除下载文件" /></el-form-item>
        <p class="muted">{{ deleteFiles ? '清理种子任务时，同时删除其下载文件。' : '仅删除种子任务，保留下载文件。' }} 设置保存后统一用于页面清理和外部定时调用，重启后保留。</p>
        <p v-if="dirty" class="muted">设置尚未保存，请先保存再清理。</p>
        <el-button type="primary" :loading="saving" @click="save">保存清理设置</el-button>
        <el-button :disabled="dirty" :loading="busy" @click="cleanup(true)">预览清理</el-button>
        <el-button type="danger" :disabled="dirty" :loading="busy" @click="cleanup(false)">清理文件丢失种子</el-button>
      </el-form>
      <p class="muted">仅处理 missingFiles（文件丢失），不处理其他状态，不触发媒体扫描。</p>
      <div v-if="result">
        <p>{{ result.dryRun ? '清理预览' : '清理结果' }}：匹配 {{ result.matchedCount }} 个，已删除 {{ result.deletedCount }} 个，跳过 {{ result.skippedCount }} 个，失败 {{ result.failedCount }} 个。{{ result.deleteFiles ? '同时删除下载文件' : '保留下载文件' }}。</p>
        <el-table :data="result.items"><el-table-column prop="name" label="种子名称" min-width="220" /><el-table-column label="状态" width="110"><template #default="{ row }">{{ { would_delete: '待清理', deleted: '已删除', skipped: '已跳过', failed: '失败' }[row.status] }}</template></el-table-column><el-table-column label="说明" min-width="200"><template #default="{ row }">{{ row.reason || row.error || '' }}</template></el-table-column></el-table>
      </div>
    </div>
  </section>
</template>
