<script setup>
import { ref, computed, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api/index.js';
const feeds = ref([]), rules = ref({}), selected = ref(''), loading = ref(false), error = ref(''), feedDialog = ref(false), ruleDialog = ref(false), saving = ref(false), editing = ref(false), feedForm = ref({ url: '', path: '' }), ruleName = ref(''), ruleForm = ref({});
const categories = ref({});
const categoryOptions = computed(() => [...new Set([...Object.keys(categories.value), ruleForm.value.assignedCategory].filter(Boolean))]);
const ruleFeeds = computed(() => {
  const available = new Map(feeds.value.map(feed => [feed.url, { url: feed.url, label: feed.path }]));
  for (const url of ruleForm.value.affectedFeeds ?? []) if (!available.has(url)) available.set(url, { url, label: '已不可用的订阅源（取消勾选可移除）', unavailable: true });
  return [...available.values()];
});
function flatten(tree, prefix = '') { const result = []; for (const [name, node] of Object.entries(tree ?? {})) { if (!node || typeof node !== 'object') continue; const full = prefix ? `${prefix}\\${name}` : name; if (node.url) result.push({ ...node, name, path: full }); else result.push(...flatten(node, full)); } return result; }
const currentFeed = computed(() => feeds.value.find(f => f.path === selected.value));
const ruleRows = computed(() => Object.entries(rules.value).map(([name, rule]) => ({ ...rule, name, assignedCategory: rule.torrentParams?.category ?? rule.assignedCategory ?? '' })));
async function load() { loading.value = true; try { const [rss, r, c] = await Promise.all([api('/qbittorrent/rss', { quiet: true }), api('/qbittorrent/rss/rules', { quiet: true }), api('/qbittorrent/categories', { quiet: true })]); feeds.value = flatten(rss); rules.value = r; categories.value = c; if (!feeds.value.some(f => f.path === selected.value)) selected.value = feeds.value[0]?.path ?? ''; error.value = ''; } catch (e) { error.value = e.message; } finally { loading.value = false; } }
onMounted(load);
async function addFeed() { saving.value = true; try { await api('/qbittorrent/rss/feeds', { method: 'POST', body: feedForm.value }); feedDialog.value = false; feedForm.value = { url: '', path: '' }; ElMessage.success('订阅已添加'); await load(); } catch {} finally { saving.value = false; } }
async function removeFeed(feed) { try { await ElMessageBox.confirm(`删除订阅“${feed.name}”？已下载的文件会保留。`, '删除订阅', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }); await api('/qbittorrent/rss/feeds', { method: 'DELETE', body: { path: feed.path } }); await load(); } catch {} }
async function refresh() { try { await api('/qbittorrent/rss/refresh', { method: 'POST', body: { path: selected.value } }); ElMessage.success('已请求刷新订阅'); await load(); } catch {} }
function editRule(row) {
  editing.value = Boolean(row); ruleName.value = row?.name ?? '';
  ruleForm.value = { enabled: row?.enabled ?? true, useRegex: row?.useRegex ?? false, mustContain: row?.mustContain ?? '', mustNotContain: row?.mustNotContain ?? '', assignedCategory: row?.torrentParams?.category ?? row?.assignedCategory ?? '', affectedFeeds: [...(row?.affectedFeeds ?? [])] };
  ruleDialog.value = true;
}
async function saveRule() { saving.value = true; try { await api(`/qbittorrent/rss/rules/${encodeURIComponent(ruleName.value)}`, { method: 'PUT', body: ruleForm.value }); ruleDialog.value = false; ElMessage.success('下载规则已保存'); await load(); } catch {} finally { saving.value = false; } }
async function removeRule(name) { try { await ElMessageBox.confirm(`删除下载规则“${name}”？`, '删除规则', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }); await api(`/qbittorrent/rss/rules/${encodeURIComponent(name)}`, { method: 'DELETE' }); ElMessage.success('下载规则已删除'); await load(); } catch {} }
async function toggleRule(row) { saving.value = true; try { await api(`/qbittorrent/rss/rules/${encodeURIComponent(row.name)}`, { method: 'PUT', body: { enabled: !row.enabled, affectedFeeds: row.affectedFeeds ?? [] } }); await load(); } catch {} finally { saving.value = false; } }
const external = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) ? u.href : undefined; } catch { return undefined; } };
</script>
<template><el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="notice" /><div class="rss-layout" v-loading="loading"><section class="panel"><div class="panel-header"><h2>订阅源 <span class="muted">{{ feeds.length }}</span></h2><el-button size="small" type="primary" plain @click="feedDialog = true">添加</el-button></div><button v-for="feed in feeds" :key="feed.path" class="feed" :class="{ active: selected === feed.path }" @click="selected = feed.path">{{ feed.path }}<span>{{ feed.url }}</span></button><div v-if="!feeds.length" class="empty-hint">添加你的第一个 RSS 订阅源。</div><div class="feed-actions"><el-button size="small" @click="load">重新读取</el-button><el-button v-if="currentFeed" size="small" type="danger" text @click="removeFeed(currentFeed)">删除选中</el-button></div></section><section class="panel"><div class="panel-header"><h2>{{ currentFeed?.name || '订阅文章' }}</h2><el-button size="small" :disabled="!selected" @click="refresh">刷新订阅</el-button></div><div class="table-wrap"><el-table :data="currentFeed?.articles || []" max-height="380"><el-table-column label="文章" min-width="260"><template #default="{ row }"><a v-if="external(row.link)" :href="external(row.link)" target="_blank" rel="noopener noreferrer" class="article-title">{{ row.title }}</a><span v-else>{{ row.title }}</span></template></el-table-column><el-table-column label="发布时间" width="170"><template #default="{ row }">{{ row.date ? new Date(row.date).toLocaleString('zh-CN') : '—' }}</template></el-table-column><template #empty><div class="empty-hint">该订阅尚无文章，可尝试刷新。</div></template></el-table></div></section></div><section class="panel"><div class="panel-header"><div><h2>自动下载规则</h2><p class="muted">按条件匹配订阅文章，使用指定分类自动下载。</p></div><el-button type="primary" @click="editRule()">新建规则</el-button></div><div class="table-wrap"><el-table :data="ruleRows"><el-table-column prop="name" label="规则名称" min-width="140" /><el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'" round>{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column><el-table-column prop="mustContain" label="包含条件" min-width="140" show-overflow-tooltip /><el-table-column label="匹配模式" width="110"><template #default="{ row }">{{ row.useRegex ? '正则表达式' : '关键词' }}</template></el-table-column><el-table-column prop="mustNotContain" label="排除条件" min-width="140" show-overflow-tooltip /><el-table-column label="指定分类" min-width="120"><template #default="{ row }">{{ row.assignedCategory || '未分类' }}</template></el-table-column><el-table-column label="适用订阅源" min-width="160"><template #default="{ row }">{{ (row.affectedFeeds || []).map(url => feeds.find(f => f.url === url)?.path || '已不可用的订阅源').join('、') || '未选择' }}</template></el-table-column><el-table-column label="操作" width="210"><template #default="{ row }"><el-button text :disabled="saving" @click="toggleRule(row)">{{ row.enabled ? '停用' : '启用' }}</el-button><el-button text type="primary" @click="editRule(row)">编辑</el-button><el-button text type="danger" @click="removeRule(row.name)">删除</el-button></template></el-table-column></el-table></div></section><el-dialog v-model="feedDialog" title="添加 RSS 订阅" width="min(520px, 94vw)"><el-form label-position="top" @submit.prevent="addFeed"><el-form-item label="订阅 URL"><el-input v-model="feedForm.url" placeholder="https://example.com/rss" /></el-form-item><el-form-item label="名称 / 路径（可选）"><el-input v-model="feedForm.path" placeholder="例如：电视剧\\我的订阅" /></el-form-item></el-form><template #footer><el-button @click="feedDialog = false">取消</el-button><el-button type="primary" :loading="saving" :disabled="!feedForm.url" @click="addFeed">添加订阅</el-button></template></el-dialog><el-dialog v-model="ruleDialog" :title="editing ? '编辑下载规则' : '新建下载规则'" width="min(650px, 94vw)">
  <el-form label-position="top" @submit.prevent="saveRule">
    <el-form-item label="规则名称"><el-input v-model="ruleName" :disabled="editing" maxlength="200" /></el-form-item>
    <el-form-item><el-checkbox v-model="ruleForm.useRegex">使用正则表达式</el-checkbox></el-form-item>
    <el-form-item label="包含条件"><el-input v-model="ruleForm.mustContain" placeholder="关键词或正则表达式" /></el-form-item>
    <el-form-item label="排除条件"><el-input v-model="ruleForm.mustNotContain" /></el-form-item>
    <el-form-item label="指定分类">
      <el-select v-model="ruleForm.assignedCategory" filterable style="width:100%">
        <el-option label="未分类" value="" />
        <el-option v-for="category in categoryOptions" :key="category" :label="category" :value="category" />
      </el-select>
    </el-form-item>
    <el-form-item label="对以下订阅源应用规则">
      <el-checkbox-group v-model="ruleForm.affectedFeeds" class="rule-feed-list">
        <el-checkbox v-for="feed in ruleFeeds" :key="feed.url" :value="feed.url">{{ feed.label }}</el-checkbox>
      </el-checkbox-group>
      <span v-if="!ruleFeeds.length" class="muted">暂无订阅源，请先添加 RSS 订阅。</span>
    </el-form-item>
    <p class="muted">其他选项新建时使用 qBittorrent 默认设置，编辑时保留已有设置。下载分类的保存目录需位于 Jellyfin 媒体库挂载目录内。</p>
  </el-form>
  <template #footer><el-button @click="ruleDialog = false">取消</el-button><el-button type="primary" :loading="saving" :disabled="!ruleName.trim()" @click="saveRule">保存规则</el-button></template>
</el-dialog></template>
<style scoped>
.rule-feed-list { display: flex; flex-direction: column; width: 100%; max-height: 220px; overflow: auto; }
.rule-feed-list :deep(.el-checkbox) { margin-right: 0; height: auto; min-height: 32px; }
.rule-feed-list :deep(.el-checkbox__label) { white-space: normal; overflow-wrap: anywhere; }
</style>
