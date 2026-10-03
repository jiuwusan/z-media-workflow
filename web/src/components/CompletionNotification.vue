<script setup>
import { ref, onMounted, computed } from 'vue';
import { ElMessage } from 'element-plus';
import { api } from '../api/index.js';
const props = defineProps({ callbackUrl: String, authRequired: { type: Boolean, default: true } });
const form = ref({ enabled: false, program: '' });
const loaded = ref(false), loading = ref(false), saving = ref(false), error = ref('');
const platform = ref('curl'), scriptPath = ref('/config/z-media-workflow/.env.notify.curl');
const envTemplate = computed(() => {
  const url = props.callbackUrl || 'http://172.29.0.1:3000/api/webhooks/qbittorrent/completed';
  return platform.value === 'curl'
    ? `url = "${url}"\nrequest = "POST"\nheader = "Authorization: Bearer 填入服务端独立WORKFLOW_API_TOKEN"\nsilent\nshow-error\nfail\nconnect-timeout = 5\nmax-time = 15\nretry = 2\nretry-delay = 1\nretry-max-time = 45\nretry-connrefused`
    : `WORKFLOW_CALLBACK_URL=${url}\nWORKFLOW_API_TOKEN=填入服务端独立WORKFLOW_API_TOKEN`;
});
function changePlatform(value) { scriptPath.value = value === 'curl' ? '/config/z-media-workflow/.env.notify.curl' : value === 'windows' ? 'E:\\personal\\z-media-workflow\\scripts\\notify-completed.mjs' : '/opt/z-media-workflow/scripts/notify-completed.mjs'; }
function generate() {
  if (platform.value === 'curl' && !props.authRequired) {
    const url = props.callbackUrl || 'http://172.29.0.1:3000/api/webhooks/qbittorrent/completed';
    form.value.program = `curl -q --fail --silent --show-error --connect-timeout 5 --max-time 15 --retry 2 --retry-connrefused --data-urlencode "hash=%I" "${url}"`;
    return;
  }
  if (!scriptPath.value.trim() || /["\r\n\0]/.test(scriptPath.value)) { ElMessage.error('脚本路径不能为空，也不能包含双引号或换行'); return; }
  form.value.program = platform.value === 'curl' ? `curl -q --config "${scriptPath.value.trim()}" --data-urlencode "hash=%I"` : `node "${scriptPath.value.trim()}" "%I"`;
}
async function load() {
  loading.value = true;
  try { form.value = await api('/qbittorrent/completion-notification', { quiet: true }); loaded.value = true; error.value = ''; }
  catch (e) { loaded.value = false; error.value = e.message; }
  finally { loading.value = false; }
}
async function save() {
  if (form.value.enabled && !form.value.program.trim()) { ElMessage.error('启用通知时请填写完成命令'); return; }
  saving.value = true;
  try { form.value = await api('/qbittorrent/completion-notification', { method: 'PUT', body: form.value }); ElMessage.success('已保存到 qBittorrent，并回读确认'); }
  catch {} finally { saving.value = false; }
}
async function copy(value) { try { await navigator.clipboard.writeText(value); ElMessage.success('已复制'); } catch { ElMessage.info('请手动复制配置内容'); } }
onMounted(load);
</script>

<template>
  <section class="panel">
    <div class="panel-header"><h2>下载完成通知</h2><el-button :loading="loading" :disabled="saving" @click="load">读取 qBittorrent 配置</el-button></div>
    <div class="panel-body">
      <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="notice" />
      <el-form label-position="top" :disabled="!loaded || loading || saving">
        <el-form-item label="下载完成后运行外部程序"><el-switch v-model="form.enabled" aria-label="启用下载完成通知" /><span class="muted" style="margin-left:12px">{{ form.enabled ? '启用' : '停用' }}</span></el-form-item>
        <el-form-item label="完成通知命令"><el-input v-model="form.program" aria-label="完成通知命令" maxlength="4096" placeholder='curl -q --config "/config/z-media-workflow/.env.notify.curl" --data-urlencode "hash=%I"' /></el-form-item>
        <el-button type="primary" :loading="saving" @click="save">保存通知配置</el-button>
      </el-form>
      <p class="muted">对应 qBittorrent 下载设置中的“torrent 完成时运行”。保存后直接更新远程 qBittorrent。</p>
      <div class="config-row"><label>生成命令模板</label>
        <el-form label-position="top" style="margin-top:12px">
          <el-form-item label="通知方式"><el-select v-model="platform" aria-label="通知方式" @change="changePlatform"><el-option label="curl（无需 Node.js）" value="curl" /><el-option label="Linux / Docker · Node.js" value="linux" /><el-option label="Windows · Node.js" value="windows" /></el-select></el-form-item>
          <el-form-item v-if="platform !== 'curl' || authRequired" :label="platform === 'curl' ? 'qBittorrent 内的 curl 配置文件路径' : 'qBittorrent 内的脚本绝对路径'"><el-input v-model="scriptPath" aria-label="通知文件路径" /></el-form-item>
          <el-button :disabled="!loaded || loading || saving" @click="generate">生成通知命令</el-button>
        </el-form>
        <p class="muted">模板生成后需点击保存。%I 为 v1 信息哈希；纯 v2 torrent 使用 %J。%K 是 Torrent ID，不能传给此脚本。</p>
      </div>
      <template v-if="platform === 'curl' && !authRequired">
        <el-alert title="内网回调无需 token、Node.js 或配置文件，直接保存生成的 curl 命令即可。管理接口仍需登录。" type="info" show-icon :closable="false" />
        <p class="muted" style="line-height:1.9">curl 直接将 hash 发送到上面的回调地址。WEBHOOK_AUTH_ENABLED=false 仅关闭下载完成回调认证。</p>
      </template>
      <template v-else>
        <div class="config-row"><label>{{ platform === 'curl' ? 'curl 配置文件（.env.notify.curl）' : '脚本旁的 .env.notify 配置' }}</label><pre class="code">{{ envTemplate }}</pre><el-button size="small" @click="copy(envTemplate)">复制通知环境模板</el-button></div>
        <el-alert :title="platform === 'curl' ? 'qBittorrent 容器仅需 curl，无需 Node.js 或通知脚本。配置文件必须在该容器内可读。' : '脚本及 Node.js 22+ 必须位于 qBittorrent 所在机器或容器内。'" type="info" show-icon :closable="false" />
        <p class="muted" style="line-height:1.9">配置文件需部署在 qBittorrent 容器内。认证启用时填写独立回调令牌。Node.js 方式需将脚本与 .env.notify 放在同一目录。</p>
      </template>
      <p class="muted">启用后仅在后续下载完成时发送通知；现有已完成下载可在媒体识别页面扫描。</p>
    </div>
  </section>
</template>
