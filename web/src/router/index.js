import { createRouter, createWebHistory } from 'vue-router';
import { api, hasSession, setSession } from '../api/index.js';
const router = createRouter({ history: createWebHistory(), routes: [
  { path: '/login', component: () => import('../views/Login.vue') },
  { path: '/', component: () => import('../views/Dashboard.vue'), meta: { title: '工作流概览', subtitle: '从下载完成，到媒体就绪。' } },
  { path: '/rss', component: () => import('../views/Rss.vue'), meta: { title: 'RSS 订阅', subtitle: '管理订阅源与 qBittorrent 自动下载规则。' } },
  { path: '/jobs', component: () => import('../views/Jobs.vue'), meta: { title: '工作流任务', subtitle: '跟踪扫描、识别和媒体信息确认的每一步。' } },
  { path: '/jobs/:id', component: () => import('../views/JobDetail.vue'), meta: { title: '任务详情', subtitle: '查看处理结果，并确认需要人工判断的候选。' } },
  { path: '/media', component: () => import('../views/Media.vue'), meta: { title: '媒体识别', subtitle: '为尚未识别的电视剧和电影补齐媒体信息。' } },
  { path: '/settings', component: () => import('../views/Settings.vue'), meta: { title: '连接与通知', subtitle: '检查服务连接，配置下载完成通知。' } },
  { path: '/:pathMatch(.*)*', redirect: '/' }
] });
router.beforeEach(async to => {
  if (to.path === '/login') return;
  if (!hasSession()) {
    try { setSession(await api('/auth/session', { quiet: true })); } catch { return '/login'; }
  }
});
window.addEventListener('auth-expired', () => { if (router.currentRoute.value.path !== '/login') router.replace('/login'); });
export default router;
