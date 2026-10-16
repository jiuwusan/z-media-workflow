import { createRouter, createWebHistory } from 'vue-router';
import { api, hasSession, setSession } from '../api/index.js';
const router = createRouter({ history: createWebHistory(), routes: [
  { path: '/login', component: () => import('../views/Login.vue') },
  { path: '/setup', component: () => import('../views/Setup.vue') },
  { path: '/', component: () => import('../views/Dashboard.vue'), meta: { title: '工作流概览', subtitle: '从下载完成，到媒体就绪。' } },
  { path: '/library', component: () => import('../views/Library.vue'), meta: { title: '媒体库', subtitle: '浏览全部电影和电视剧，手动纠正媒体识别结果。' } },
  { path: '/rss', component: () => import('../views/Rss.vue'), meta: { title: 'RSS 订阅', subtitle: '管理订阅源并浏览订阅文章。' } },
  { path: '/download-rules', component: () => import('../views/DownloadRules.vue'), meta: { title: '自动下载规则', subtitle: '设置订阅文章匹配条件和下载分类，管理 qBittorrent 自动下载规则。' } },
  { path: '/jobs', component: () => import('../views/Jobs.vue'), meta: { title: '工作流任务', subtitle: '跟踪扫描、识别和媒体信息确认的每一步。' } },
  { path: '/jobs/:id', component: () => import('../views/JobDetail.vue'), meta: { title: '任务详情', subtitle: '查看处理结果，并确认需要人工判断的候选。' } },
  { path: '/media', component: () => import('../views/Media.vue'), meta: { title: '媒体识别', subtitle: '为尚未识别的电视剧和电影补齐媒体信息。' } },
  { path: '/torrent-naming', component: () => import('../views/TorrentNaming.vue'), meta: { title: '种子文件命名规范检查', subtitle: '检查已有种子的剧集文件，为缺少季号的文件补齐命名。' } },
  { path: '/notifications', component: () => import('../views/Notifications.vue'), meta: { title: '种子通知', subtitle: '配置新增种子与下载完成通知，生成回调命令。' } },
  { path: '/torrent-cleanup', component: () => import('../views/TorrentCleanup.vue'), meta: { title: '种子清理', subtitle: '预览并清理文件丢失的种子，设置是否同时删除下载文件。' } },
  { path: '/configuration', component: () => import('../views/Configuration.vue'), meta: { title: '基础配置', subtitle: '管理服务连接、管理员账号、访问地址和运行参数。' } },
  { path: '/:pathMatch(.*)*', redirect: '/' }
] });
router.beforeEach(async to => {
  const state = await api('/setup/status', { quiet: true });
  if (!state.initialized) return to.path === '/setup' ? undefined : '/setup';
  if (to.path === '/setup') return '/login';
  if (to.path === '/login') return;
  if (!hasSession()) {
    try { setSession(await api('/auth/session', { quiet: true })); } catch { return '/login'; }
  }
});
window.addEventListener('auth-expired', () => { if (!['/login', '/setup'].includes(router.currentRoute.value.path)) router.replace('/login'); });
export default router;
