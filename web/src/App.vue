<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { DataAnalysis, Connection, Tickets, Film, Setting, SwitchButton, Menu, ArrowRight } from '@element-plus/icons-vue';
import { api, setSession } from './api/index.js';
const route = useRoute(), router = useRouter(), expanded = ref(false);
const links = [{ path: '/', label: '概览', icon: DataAnalysis }, { path: '/rss', label: 'RSS 订阅', icon: Connection }, { path: '/jobs', label: '工作流任务', icon: Tickets }, { path: '/media', label: '媒体识别', icon: Film }, { path: '/settings', label: '连接与通知', icon: Setting }];
async function logout() { try { await api('/auth/logout', { method: 'POST' }); setSession(null); await router.push('/login'); } catch {} }
</script>
<template>
  <router-view v-if="route.path === '/login'" />
  <div v-else class="shell">
    <div v-if="expanded" class="sidebar-backdrop" @click="expanded = false"></div>
    <aside class="sidebar" :class="{ expanded }">
      <router-link to="/" class="brand"><span class="brand-symbol">m<span>f</span></span><div>Media Flow<small>媒体工作流管理</small></div></router-link>
      <div class="nav-caption">工作空间</div>
      <nav><router-link v-for="link in links" :key="link.path" :to="link.path" :class="{ active: link.path === '/' ? route.path === '/' : route.path.startsWith(link.path) }" @click="expanded = false"><el-icon><component :is="link.icon" /></el-icon>{{ link.label }}<el-icon class="nav-arrow"><ArrowRight /></el-icon></router-link></nav>
      <div class="sidebar-note"><span class="live-dot"></span>自动化，从这里连接<small>qBittorrent → Jellyfin</small></div>
      <button class="logout" @click="logout"><el-icon><SwitchButton /></el-icon>退出登录</button>
    </aside>
    <main class="main">
      <header class="topbar"><div><button class="mobile-menu" aria-label="展开导航" @click="expanded = !expanded"><el-icon><Menu /></el-icon></button><span>工作空间</span><span class="breadcrumb-divider">/</span><strong>{{ route.meta.title }}</strong></div><span class="admin-chip"><span class="avatar">M</span>管理员</span></header>
      <div class="workspace"><div class="page-heading"><div><div class="eyebrow">MEDIA WORKFLOW</div><h1>{{ route.meta.title }}</h1><p>{{ route.meta.subtitle }}</p></div><span class="workspace-badge">个人媒体中心</span></div><router-view :key="route.path" /></div>
    </main>
  </div>
</template>
