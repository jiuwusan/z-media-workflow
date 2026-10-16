<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { DataAnalysis, Connection, Filter, Tickets, Film, Collection, EditPen, Bell, Delete, Tools, SwitchButton, Menu, ArrowRight } from '@element-plus/icons-vue';
import { api, setSession } from './api/index.js';
const route = useRoute(), router = useRouter(), expanded = ref(false);
const links = [{ path: '/', label: '概览', icon: DataAnalysis }, { path: '/library', label: '媒体库', icon: Collection }, { path: '/rss', label: '订阅管理', icon: Connection }, { path: '/download-rules', label: '下载规则', icon: Filter }, { path: '/jobs', label: '任务管理', icon: Tickets }, { path: '/media', label: '媒体识别', icon: Film }, { path: '/torrent-naming', label: '命名检查', icon: EditPen }, { path: '/notifications', label: '种子通知', icon: Bell }, { path: '/torrent-cleanup', label: '种子清理', icon: Delete }, { path: '/configuration', label: '基础配置', icon: Tools }];
async function logout() { try { await api('/auth/logout', { method: 'POST' }); setSession(null); await router.push('/login'); } catch {} }
</script>
<template>
  <router-view v-if="['/login', '/setup'].includes(route.path)" />
  <div v-else class="shell">
    <div v-if="expanded" class="sidebar-backdrop" @click="expanded = false"></div>
    <aside class="sidebar" :class="{ expanded }">
      <router-link to="/" class="brand"><span class="brand-symbol">m<span>f</span></span><div>Media Flow<small>媒体工作流管理</small></div></router-link>
      <div class="nav-caption">工作空间</div>
      <nav><router-link v-for="link in links" :key="link.path" :to="link.path" :class="{ active: link.path === '/' ? route.path === '/' : route.path.startsWith(link.path) }" @click="expanded = false"><el-icon><component :is="link.icon" /></el-icon>{{ link.label }}<el-icon class="nav-arrow"><ArrowRight /></el-icon></router-link></nav>
      <div class="sidebar-note"><span class="live-dot"></span>自动化，从这里连接<small>qBittorrent → Jellyfin</small></div>
      <button class="logout" @click="logout"><el-icon><SwitchButton /></el-icon>退出登录</button>
    </aside>
    <main class="main" :class="{ 'main-rss': route.path === '/rss' }">
      <header class="topbar"><div><button class="mobile-menu" aria-label="展开导航" @click="expanded = !expanded"><el-icon><Menu /></el-icon></button><span>工作空间</span><span class="breadcrumb-divider">/</span><strong>{{ route.meta.title }}</strong></div><span class="admin-chip"><span class="avatar">M</span>管理员</span></header>
      <div class="workspace"><div class="page-heading"><div><div class="eyebrow">MEDIA WORKFLOW</div><h1>{{ route.meta.title }}</h1><p>{{ route.meta.subtitle }}</p></div><span class="workspace-badge">个人媒体中心</span></div><router-view :key="route.path" /></div>
    </main>
  </div>
</template>
<style scoped>
.sidebar nav { min-height: 0; overflow-y: auto; }
.brand, .nav-caption, .sidebar-note, .logout { flex-shrink: 0; }
@media (min-width: 901px) {
  .main-rss { height: 100dvh; display: flex; flex-direction: column; min-height: 0; }
  .main-rss > .topbar { flex-shrink: 0; }
  .main-rss > .workspace { flex: 1; min-height: 0; width: 100%; max-width: none; display: flex; flex-direction: column; }
  .main-rss .page-heading { flex-shrink: 0; }
  .main-rss .workspace > :deep(.rss-page) { flex: 1; min-height: 0; }
}
</style>
