<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api/index.js';
import { flattenRssFeeds } from '../utils/rss.js';
const feeds = ref([]), selected = ref(''), loading = ref(false), error = ref(''), feedDialog = ref(false), saving = ref(false), feedForm = ref({ url: '', path: '' });
const currentFeed = computed(() => feeds.value.find(f => f.path === selected.value));
async function load() { loading.value = true; try { feeds.value = flattenRssFeeds(await api('/qbittorrent/rss', { quiet: true })); if (!feeds.value.some(f => f.path === selected.value)) selected.value = feeds.value[0]?.path ?? ''; error.value = ''; } catch (e) { error.value = e.message; } finally { loading.value = false; } }
async function addFeed() { saving.value = true; try { await api('/qbittorrent/rss/feeds', { method: 'POST', body: feedForm.value }); feedDialog.value = false; feedForm.value = { url: '', path: '' }; ElMessage.success('订阅已添加'); await load(); } catch {} finally { saving.value = false; } }
async function removeFeed(feed) { try { await ElMessageBox.confirm(`删除订阅“${feed.name}”？已下载的文件会保留。`, '删除订阅', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }); await api('/qbittorrent/rss/feeds', { method: 'DELETE', body: { path: feed.path } }); await load(); } catch {} }
async function refresh() { try { await api('/qbittorrent/rss/refresh', { method: 'POST', body: { path: selected.value } }); ElMessage.success('已请求刷新订阅'); await load(); } catch {} }

const external = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : undefined; } catch { return undefined; } };
onMounted(load);
</script>
<template><div class="rss-page"><el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="notice" /><div class="rss-layout" v-loading="loading"><section class="panel"><div class="panel-header"><h2>订阅源 <span class="muted">{{ feeds.length }}</span></h2><el-button size="small" type="primary" plain @click="feedDialog = true">添加</el-button></div><div class="feed-list"><button v-for="feed in feeds" :key="feed.path" class="feed" :class="{ active: selected === feed.path }" @click="selected = feed.path">{{ feed.path }}<span>{{ feed.url }}</span></button><div v-if="!feeds.length" class="empty-hint">添加你的第一个 RSS 订阅源。</div></div><div class="feed-actions"><el-button size="small" @click="load">重新读取</el-button><el-button v-if="currentFeed" size="small" type="danger" text @click="removeFeed(currentFeed)">删除选中</el-button></div></section><section class="panel"><div class="panel-header"><h2>{{ currentFeed?.name || '订阅文章' }}</h2><el-button size="small" :disabled="!selected" @click="refresh">刷新订阅</el-button></div><div class="table-wrap"><el-table :data="currentFeed?.articles || []" height="100%"><el-table-column label="文章" min-width="120"><template #default="{ row }"><a v-if="external(row.link)" :href="external(row.link)" target="_blank" rel="noopener noreferrer" class="article-title">{{ row.title }}</a><span v-else>{{ row.title }}</span></template></el-table-column><el-table-column label="发布时间" width="170"><template #default="{ row }">{{ row.date ? new Date(row.date).toLocaleString('zh-CN') : '—' }}</template></el-table-column><template #empty><div class="empty-hint">该订阅尚无文章，可尝试刷新。</div></template></el-table></div></section></div><el-dialog v-model="feedDialog" title="添加 RSS 订阅" width="min(520px, 94vw)"><el-form label-position="top" @submit.prevent="addFeed"><el-form-item label="订阅 URL"><el-input v-model="feedForm.url" placeholder="https://example.com/rss" /></el-form-item><el-form-item label="名称 / 路径（可选）"><el-input v-model="feedForm.path" placeholder="例如：电视剧\\我的订阅" /></el-form-item></el-form><template #footer><el-button @click="feedDialog = false">取消</el-button><el-button type="primary" :loading="saving" :disabled="!feedForm.url" @click="addFeed">添加订阅</el-button></template></el-dialog></div></template>

<style scoped>
.rss-page { display: flex; flex-direction: column; min-width: 0; }
.rss-layout { min-height: 0; }
.rss-layout > .panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; margin-bottom: 0; }
.rss-layout .panel-header, .feed-actions { flex-shrink: 0; }
.rss-layout .panel-header h2 { min-width: 0; overflow-wrap: anywhere; }
.feed-list { max-height: 240px; overflow: auto; min-height: 0; }
.rss-layout .table-wrap { height: clamp(320px, 60dvh, 640px); min-height: 0; }
.article-title { overflow-wrap: anywhere; }
@media (min-width: 901px) {
  .rss-layout { flex: 1; }
  .feed-list { flex: 1; max-height: none; }
  .rss-layout .table-wrap { flex: 1; height: auto; }
}
</style>
