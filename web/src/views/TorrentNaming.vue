<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import { useRouter } from 'vue-router';
import { api } from '../api/index.js';
const router = useRouter(), checking = ref(''), loading = ref(false), error = ref('');
const items = ref([]), page = ref(1), total = ref(0);
const seriesCategories = ref([]);
const selectedCategories = ref([]), categories = ref([]), settingsLoaded = ref(false), saving = ref(false), categoriesLoading = ref(false), settingsError = ref('');
const settingsDirty = computed(() => JSON.stringify(selectedCategories.value) !== JSON.stringify(seriesCategories.value));
async function loadCategories() {
  categoriesLoading.value = true; settingsError.value = '';
  try { categories.value = Object.keys(await api('/qbittorrent/categories', { quiet: true })); }
  catch (e) { categories.value = []; settingsError.value = e.message; }
  finally { categoriesLoading.value = false; }
}
async function loadSettings() {
  try { const settings = await api('/qbittorrent/naming-settings', { quiet: true }); seriesCategories.value = settings.seriesCategories; selectedCategories.value = [...settings.seriesCategories]; settingsLoaded.value = true; }
  catch (e) { settingsError.value = e.message; }
}
async function saveSettings() {
  if (!settingsLoaded.value || saving.value || checking.value) return;
  saving.value = true; settingsError.value = '';
  try {
    const settings = await api('/qbittorrent/naming-settings', { method: 'PUT', body: { seriesCategories: selectedCategories.value }, quiet: true });
    seriesCategories.value = settings.seriesCategories; selectedCategories.value = [...settings.seriesCategories];
    ElMessage.success('剧集分类已保存并生效'); await load();
  } catch (e) { settingsError.value = e.message; }
  finally { saving.value = false; }
}
async function load() {
  loading.value = true; error.value = '';
  try {
    const result = await api(`/qbittorrent/torrents?page=${page.value}&pageSize=20`, { quiet: true });
    items.value = result.items; total.value = result.total;
    if (!items.value.length && page.value > 1) { page.value = 1; await load(); }
  } catch (e) { items.value = []; total.value = 0; error.value = e.message; }
  finally { loading.value = false; }
}
onMounted(load);
onMounted(loadCategories);
onMounted(loadSettings);
async function checkTorrent(torrent) {
  if (checking.value || saving.value || settingsDirty.value || !settingsLoaded.value || !torrent.eligible) return;
  checking.value = torrent.hash;
  try {
    const job = await api('/workflows/check-torrents', { method: 'POST', body: { hash: torrent.hash } });
    await router.push(`/jobs/${job.id}`);
  } catch {} finally { checking.value = ''; }
}
</script>
<template>
  <section class="panel naming-settings">
    <div class="panel-header"><h2>剧集分类</h2><div class="category-actions"><el-button size="small" :loading="categoriesLoading" :disabled="saving" @click="loadCategories">刷新分类</el-button><el-button size="small" type="primary" :loading="saving" :disabled="!settingsLoaded || Boolean(checking)" @click="saveSettings">保存分类</el-button></div></div>
    <div class="panel-body naming-details">
      <el-alert v-if="settingsError" :title="settingsError" type="error" show-icon :closable="false"><el-button v-if="!settingsLoaded" @click="loadSettings">重新读取设置</el-button></el-alert>
      <el-form label-position="top" :disabled="!settingsLoaded || saving || Boolean(checking)" @submit.prevent="saveSettings">
        <el-form-item><el-select v-model="selectedCategories" multiple filterable :loading="categoriesLoading" aria-label="剧集分类" placeholder="请选择 qBittorrent 分类" style="width:100%"><el-option v-for="category in categories" :key="category" :label="category" :value="category" /></el-select></el-form-item>
        <p class="muted">{{ settingsDirty ? '分类已修改，请先保存再检查。' : '未选择时不检查；保存后立即生效，新增通知共用。' }}</p>
      </el-form>
    </div>
  </section>
  <section class="panel">
    <div class="panel-header"><h2>选择种子</h2><el-button :loading="loading" :disabled="Boolean(checking)" @click="load">刷新列表</el-button></div>
    <div class="panel-body naming-details">
      <p>种子按添加时间从新到旧排列。点击对应的“检查此种子”，仅检查该种子并进入任务详情。</p>
      <el-alert title="检查会自动补齐缺少的季号；无法可靠判断时默认使用 S01。已包含季号的文件会跳过。" type="info" :closable="false" show-icon />
      <p class="muted">当前生效的剧集分类：{{ seriesCategories.length ? seriesCategories.join('、') : '未配置' }}。不依赖通知开关。</p>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    </div>
    <div v-loading="loading">
      <ul class="torrent-list" aria-label="种子列表">
        <li v-for="torrent in items" :key="torrent.hash" class="torrent-row">
          <div class="torrent-name"><h3>{{ torrent.name }}</h3><span class="muted">分类：{{ torrent.category || '未分类' }}<template v-if="!torrent.eligible"> · 不支持命名检查</template></span></div>
          <div class="torrent-date"><small class="muted">添加时间</small><time>{{ torrent.addedOn > 0 ? new Date(torrent.addedOn * 1000).toLocaleString('zh-CN') : '未知' }}</time></div>
          <el-button type="primary" plain :loading="checking === torrent.hash" :disabled="loading || saving || !settingsLoaded || settingsDirty || Boolean(checking) || !torrent.eligible" @click="checkTorrent(torrent)">检查此种子</el-button>
        </li>
      </ul>
      <div v-if="!items.length && !loading && !error" class="empty-hint">暂无种子。</div>
    </div>
    <div class="pagination"><span class="muted">共 {{ total }} 个种子 · 添加时间倒序</span><el-pagination v-model:current-page="page" :total="total" :page-size="20" layout="prev, pager, next" :pager-count="5" :disabled="loading || Boolean(checking)" @current-change="load" /></div>
  </section>
</template>
<style scoped>
.naming-settings .panel-header { padding-top: 16px; padding-bottom: 16px; }
.naming-settings .panel-body { padding-top: 14px; padding-bottom: 14px; }
.naming-settings .el-form-item { margin-bottom: 8px; }
.naming-settings p { margin: 0; }
.category-actions { display: flex; gap: 8px; }
.naming-details { line-height: 1.8; overflow-wrap: anywhere; }
.naming-details p:first-child { margin-top: 0; }
.naming-details p:last-child { margin-bottom: 0; }
.torrent-list { padding: 0; margin: 0; list-style: none; }
.torrent-row { display: grid; grid-template-columns: minmax(0, 1fr) 180px auto; align-items: center; gap: 20px; padding: 20px 24px; border-top: 1px solid var(--el-border-color); }
.torrent-name { min-width: 0; overflow-wrap: anywhere; }
.torrent-name h3 { font-size: 14px; margin: 0 0 8px; }
.torrent-date { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
@media (max-width: 900px) { .torrent-row { grid-template-columns: minmax(0, 1fr) auto; } .torrent-name { grid-column: 1 / -1; } }
@media (max-width: 640px) { .torrent-row { padding: 18px; gap: 14px; } }
</style>
