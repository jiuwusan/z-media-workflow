<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Film } from '@element-plus/icons-vue';
import { api } from '../api/index.js';
import { usePolling } from '../components/polling.js';

const items = ref([]), libraries = ref([]), total = ref(0), page = ref(1);
const libraryId = ref(''), type = ref(''), search = ref(''), sort = ref('date_desc');
const loading = ref(false), error = ref(''), dialog = ref(false), selected = ref(null);
const failedPosters = ref(new Set());
const posterVersion = ref(0);
const name = ref(''), year = ref(undefined), job = ref(null), busy = ref(false), confirming = ref(false), dialogError = ref('');
const entry = computed(() => job.value?.items[0]);
const running = computed(() => job.value && ['queued', 'running'].includes(job.value.status));
const canSelect = computed(() => !busy.value && !confirming.value && job.value?.status === 'needs_review' && entry.value?.status === 'needs_review');
let listRequest = 0, dialogRequest = 0;
const libraryName = id => libraries.value.find(l => l.ItemId === id)?.Name ?? id;
function dateLabel(value) { const date = new Date(value ?? ''); return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '—'; }
function providerLabel(candidate) { return Object.entries(candidate.ProviderIds ?? {}).map(([key, value]) => `${key}: ${value}`).join(' · '); }

async function load() {
  const request = ++listRequest;
  loading.value = true; error.value = '';
  try {
    const currentLibraries = await api('/media/libraries', { quiet: true });
    if (request !== listRequest) return;
    libraries.value = currentLibraries;
    if (libraryId.value && !currentLibraries.some(l => l.ItemId === libraryId.value)) { libraryId.value = ''; page.value = 1; }
    const query = new URLSearchParams({ page: page.value, pageSize: 20, sort: sort.value, search: search.value });
    if (libraryId.value) query.set('libraryId', libraryId.value);
    if (type.value) query.set('type', type.value);
    const result = await api(`/media/items?${query}`, { quiet: true });
    if (request !== listRequest) return;
    const lastPage = Math.max(1, Math.ceil(result.total / 20));
    if (page.value > lastPage) { page.value = lastPage; return load(); }
    items.value = result.items; total.value = result.total; failedPosters.value = new Set(); posterVersion.value++;
  } catch (e) { if (request === listRequest) { items.value = []; total.value = 0; error.value = e.message; } }
  finally { if (request === listRequest) loading.value = false; }
}
function filterChanged() { page.value = 1; load(); }

async function pollJob() {
  const id = job.value?.id, request = dialogRequest;
  if (!dialog.value || !id) return;
  try {
    const result = await api(`/workflows/${id}`, { quiet: true });
    if (!dialog.value || request !== dialogRequest || job.value?.id !== id) return;
    job.value = result; dialogError.value = '';
    if (!['queued', 'running'].includes(result.status) && confirming.value) {
      confirming.value = false;
      if (result.status === 'completed') { ElMessage.success('识别结果已保存'); await load(); }
    }
  } catch (e) { if (request === dialogRequest) dialogError.value = e.message; }
}
const tick = usePolling(pollJob, 1000, () => dialog.value && Boolean(running.value));
async function find() {
  if (busy.value || confirming.value || running.value || !name.value.trim()) return;
  const request = ++dialogRequest;
  busy.value = true; dialogError.value = '';
  try {
    const identity = { name: name.value.trim(), year: year.value ?? null };
    const result = job.value?.status === 'needs_review'
      ? await api(`/workflows/${job.value.id}/search`, { method: 'POST', body: { itemId: selected.value.Id, ...identity }, quiet: true })
      : await api(`/media/${encodeURIComponent(selected.value.Id)}/identify`, { method: 'POST', body: identity, quiet: true });
    if (request !== dialogRequest || !dialog.value) return;
    job.value = result; tick();
  } catch (e) { if (request === dialogRequest) dialogError.value = e.message; }
  finally { if (request === dialogRequest) busy.value = false; }
}
function identify(item) {
  selected.value = item; name.value = item.Name ?? ''; year.value = item.ProductionYear ?? undefined;
  job.value = null; dialogError.value = ''; dialog.value = true; find();
}
function closed() { dialogRequest++; busy.value = false; job.value = null; selected.value = null; }
async function confirm(candidate) {
  if (!canSelect.value) return;
  busy.value = true;
  const request = dialogRequest;
  try {
    await ElMessageBox.confirm(`将“${selected.value.Name}”识别为“${candidate.Name}”${candidate.ProductionYear ? `（${candidate.ProductionYear}）` : ''}，并应用到 Jellyfin？`, '确认媒体纠错', { confirmButtonText: '确认并应用', cancelButtonText: '取消' });
    if (request !== dialogRequest || !dialog.value) return;
    confirming.value = true; dialogError.value = '';
    job.value = await api(`/workflows/${job.value.id}/confirm`, { method: 'POST', body: { itemId: selected.value.Id, candidateId: candidate.candidateId }, quiet: true });
    tick();
  } catch (e) { confirming.value = false; if (request === dialogRequest && e instanceof Error) dialogError.value = e.message; }
  finally { if (request === dialogRequest) busy.value = false; }
}
onMounted(load);
onBeforeUnmount(() => { listRequest++; dialogRequest++; });
</script>

<template>
  <el-alert title="查看全部电影和电视剧。需要纠错时点击“识别”，手动选择并确认候选后才会更新媒体信息。" type="info" show-icon :closable="false" class="notice" />
  <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="notice" />
  <section class="panel library-page">
    <div class="panel-header"><h2>媒体海报墙 <span class="muted">{{ total }} 项</span></h2><el-button :loading="loading" @click="load">刷新列表</el-button></div>
    <div class="panel-body library-filters">
      <el-select v-model="libraryId" aria-label="媒体库筛选" @change="filterChanged"><el-option label="全部媒体库" value="" /><el-option v-for="lib in libraries" :key="lib.ItemId" :label="lib.Name" :value="lib.ItemId" /></el-select>
      <el-select v-model="type" aria-label="媒体类型筛选" @change="filterChanged"><el-option label="全部类型" value="" /><el-option label="电影" value="Movie" /><el-option label="电视剧" value="Series" /></el-select>
      <el-input v-model="search" aria-label="搜索媒体名称" placeholder="搜索媒体名称" clearable :maxlength="300" @keyup.enter="filterChanged" @clear="filterChanged" />
      <el-button @click="filterChanged">搜索</el-button>
      <el-select v-model="sort" aria-label="媒体排序" @change="filterChanged"><el-option label="添加时间倒序" value="date_desc" /><el-option label="添加时间正序" value="date_asc" /><el-option label="名称正序" value="name_asc" /><el-option label="年份倒序" value="year_desc" /></el-select>
    </div>
    <div v-loading="loading" class="poster-wall-body">
      <div v-if="items.length" class="poster-wall" aria-label="媒体海报墙">
        <article v-for="item in items" :key="item.Id" class="media-card" :aria-label="item.Name">
          <div class="poster-frame">
            <img v-if="!failedPosters.has(item.Id)" :key="`${item.Id}:${posterVersion}`" :src="`/api/media/${encodeURIComponent(item.Id)}/poster`" :alt="`${item.Name} 海报`" loading="lazy" decoding="async" @error="failedPosters.add(item.Id)" />
            <div v-else class="poster-placeholder" aria-label="暂无海报"><el-icon><Film /></el-icon><span>{{ item.Name }}</span><small>暂无海报</small></div>
            <span class="poster-type">{{ item.Type === 'Series' ? '电视剧' : '电影' }}</span>
          </div>
          <div class="media-card-content">
            <h3 :title="item.Name">{{ item.Name }}</h3>
            <div class="media-card-meta"><span>{{ item.ProductionYear || '年份未知' }}</span><span :title="libraryName(item.LibraryId)">{{ libraryName(item.LibraryId) }}</span></div>
            <div class="media-card-footer"><span :title="`${item.Path}\n添加时间：${dateLabel(item.DateCreated)}`" class="media-file">{{ item.Path?.replace(/\\/g, '/').split('/').pop() || '路径未知' }}</span><el-button type="primary" plain size="small" @click="identify(item)">识别</el-button></div>
          </div>
        </article>
      </div>
      <el-empty v-else-if="!loading" description="没有符合条件的媒体。" :image-size="80" />
    </div>
    <div class="pagination"><span class="muted">包含已识别条目 · 默认最新添加优先</span><el-pagination v-model:current-page="page" :total="total" :page-size="20" layout="prev, pager, next" @current-change="load" /></div>
  </section>
  <el-dialog v-model="dialog" title="识别媒体 · 手动纠错" width="min(760px, 94vw)" :close-on-click-modal="false" :close-on-press-escape="!confirming" :show-close="!confirming" @closed="closed">
    <template v-if="selected">
      <p class="current-name">当前名称：{{ selected.Name }}</p><p class="path current-path">{{ selected.Path }}</p>
      <el-alert title="搜索不会修改媒体信息，请选择正确候选并确认。" type="info" show-icon :closable="false" />
      <el-form class="correction-search" label-position="top" @submit.prevent="find">
        <el-form-item label="名称"><el-input v-model="name" aria-label="纠错搜索名称" :maxlength="300" :disabled="busy || running || confirming" @keyup.enter="find" /></el-form-item>
        <el-form-item label="年份（可选）"><el-input-number v-model="year" aria-label="纠错搜索年份" :min="1800" :max="new Date().getFullYear() + 5" :precision="0" :controls="false" :readonly="busy || running || confirming" /></el-form-item>
        <el-button type="primary" :loading="busy || running" :disabled="!name.trim() || confirming" @click="find">搜索候选</el-button>
      </el-form>
      <el-alert v-if="dialogError || job?.error || entry?.error" :title="dialogError || job?.error || entry?.error" type="error" show-icon :closable="false" />
      <p v-if="running" class="muted">{{ job.stage }}，请稍候…</p>
      <el-alert v-if="entry?.candidateSearchWarning" :title="`补充候选搜索未成功：${entry.candidateSearchWarning}`" type="warning" show-icon :closable="false" />
      <el-alert v-if="job?.status === 'completed'" title="识别结果已保存，元数据由 Jellyfin 后台加载。" type="success" show-icon :closable="false" />
      <el-alert v-if="entry?.refreshWarning" :title="`识别结果已保存，后台刷新请求失败：${entry.refreshWarning}`" type="warning" show-icon :closable="false" />
      <div v-if="entry?.candidates.length" class="candidate-grid correction-candidates"><article v-for="candidate in entry.candidates" :key="candidate.candidateId" class="candidate">
        <h4>{{ candidate.Name }}</h4><span class="muted">{{ candidate.ProductionYear || '年份未知' }}</span><p class="path">{{ providerLabel(candidate) }}</p>
        <el-button type="primary" plain :disabled="!canSelect" @click="confirm(candidate)">选择此候选</el-button>
      </article></div>
      <el-empty v-else-if="job?.status === 'needs_review'" description="未找到候选，请调整名称或年份后重新搜索。" :image-size="65" />
    </template>
    <template #footer><el-button :disabled="confirming" @click="dialog = false">关闭</el-button></template>
  </el-dialog>
</template>

<style scoped>
.library-filters { display: flex; gap: 12px; flex-wrap: wrap; }
.library-filters > .el-select { width: 165px; }
.library-filters > .el-input { flex: 1; min-width: 170px; }
.poster-wall-body { padding: 0 24px 24px; min-height: 220px; }
.poster-wall { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 24px 18px; }
.media-card { min-width: 0; overflow: hidden; border: 1px solid #e4ecee; border-radius: 10px; background: #fff; transition: box-shadow .18s; }
.media-card:hover, .media-card:focus-within { box-shadow: 0 6px 20px #173d4612; }
.poster-frame { position: relative; aspect-ratio: 2 / 3; overflow: hidden; background: #e8efef; }
.poster-frame > img { display: block; width: 100%; height: 100%; object-fit: cover; }
.poster-type { position: absolute; top: 10px; left: 10px; padding: 4px 8px; border-radius: 5px; background: #15343bd9; color: #fff; font-size: 11px; }
.poster-placeholder { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; height: 100%; padding: 24px 18px; text-align: center; color: #65858a; background: linear-gradient(145deg, #e1eeeb, #f1f4f3); }
.poster-placeholder > .el-icon { font-size: 38px; color: #80aaa4; }
.poster-placeholder > span { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; font-size: 16px; line-height: 1.6; }
.poster-placeholder > small { color: #96a9aa; font-size: 11px; }
.media-card-content { padding: 12px; }
.media-card-content h3 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0 0 8px; font-size: 14px; line-height: 1.5; }
.media-card-meta { display: flex; justify-content: space-between; gap: 8px; color: #82989d; font-size: 11px; }
.media-card-meta > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.media-card-meta > span:first-child { flex-shrink: 0; }
.media-card-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid #edf2f2; }
.media-file { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #93a5aa; font-size: 10px; }
.media-card-footer .el-button { flex-shrink: 0; }
.current-name { margin-top: 0; font-weight: 600; }
.current-path { margin-bottom: 18px; overflow-wrap: anywhere; }
.correction-search { display: grid; grid-template-columns: minmax(0, 1fr) 140px auto; gap: 12px; align-items: end; margin-top: 18px; }
.correction-search .el-input-number { width: 100%; }
.correction-search > .el-button { margin-bottom: 18px; }
.correction-candidates { margin-top: 20px; }
.correction-candidates .path { overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .poster-wall-body { padding: 0 18px 18px; }
  .poster-wall { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 12px; }
  .media-card-content { padding: 10px; }
  .library-filters > .el-select, .library-filters > .el-input { width: 100%; min-width: 0; flex: auto; }
  .correction-search { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .correction-search > .el-button { margin-bottom: 18px; }
}
</style>
