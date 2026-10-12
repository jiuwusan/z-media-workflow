<script setup>
import { ref, reactive, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api, setSession } from '../api/index.js';
const router = useRouter(), step = ref(0), busy = ref(false), error = ref(''), csrf = ref(''), confirmPassword = ref('');
const form = reactive({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: '', PUBLIC_URL: `${window.location.origin}/`, QBT_URL: 'http://localhost:8080/', QBT_API_KEY: '', JELLYFIN_URL: 'http://localhost:8096/', JELLYFIN_API_KEY: '', DEEPSEEK_URL: 'https://api.deepseek.com/', DEEPSEEK_API_KEY: '', DEEPSEEK_MODEL: 'deepseek-flash', WORKFLOW_CALLBACK_URL: '', WEBHOOK_AUTH_ENABLED: false });
const connections = [{ title: 'qBittorrent', url: 'QBT_URL', key: 'QBT_API_KEY' }, { title: 'Jellyfin', url: 'JELLYFIN_URL', key: 'JELLYFIN_API_KEY' }, { title: 'DeepSeek', url: 'DEEPSEEK_URL', key: 'DEEPSEEK_API_KEY' }];
onMounted(async () => { try { csrf.value = (await api('/setup/status', { quiet: true })).csrfToken; } catch (e) { error.value = e.message; } });
function next() {
  error.value = '';
  if (step.value === 0 && (!form.ADMIN_USERNAME.trim() || form.ADMIN_PASSWORD.length < 12 || form.ADMIN_PASSWORD !== confirmPassword.value)) { error.value = '请填写用户名、至少 12 位的密码，并确保两次密码一致。'; return; }
  if (step.value === 1) {
    for (const connection of connections) {
      let url; try { url = new URL(form[connection.url]); } catch {}
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || !form[connection.key].trim()) { error.value = `请填写有效的 ${connection.title} 地址和 API 密钥。`; return; }
    }
  }
  step.value++;
}
async function save() {
  busy.value = true; error.value = '';
  try { await api('/setup', { method: 'POST', body: { ...form }, csrf: csrf.value, quiet: true }); form.ADMIN_PASSWORD = confirmPassword.value = ''; for (const connection of connections) form[connection.key] = ''; setSession(null); await router.replace('/login'); }
  catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
</script>
<template>
  <main class="setup-page"><section class="panel setup-panel">
    <div class="panel-body"><div class="eyebrow">MEDIA FLOW</div><h1>首次运行配置</h1><p class="muted">创建你的工作空间，连接下载、媒体库和识别服务。</p>
      <el-steps :active="step" finish-status="success" align-center><el-step title="管理员账号" /><el-step title="服务连接" /><el-step title="完成配置" /></el-steps>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <el-form label-position="top" :disabled="busy" @submit.prevent="step < 2 ? next() : save()">
        <div v-show="step === 0">
          <el-form-item label="管理员用户名"><el-input v-model="form.ADMIN_USERNAME" aria-label="管理员用户名" autocomplete="username" /></el-form-item>
          <el-form-item label="管理员密码"><el-input v-model="form.ADMIN_PASSWORD" aria-label="管理员密码" type="password" show-password autocomplete="new-password" maxlength="1024" placeholder="至少 12 位" /></el-form-item>
          <el-form-item label="确认密码"><el-input v-model="confirmPassword" aria-label="确认密码" type="password" show-password autocomplete="new-password" maxlength="1024" /></el-form-item>
        </div>
        <div v-show="step === 1">
          <section v-for="connection in connections" :key="connection.key"><h3>{{ connection.title }}</h3><el-row :gutter="16"><el-col :xs="24" :sm="12"><el-form-item label="服务地址"><el-input v-model="form[connection.url]" :aria-label="`${connection.title} 地址`" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="API 密钥"><el-input v-model="form[connection.key]" :aria-label="`${connection.title} API 密钥`" type="password" show-password autocomplete="off" /></el-form-item></el-col></el-row></section>
          <el-form-item label="DeepSeek 模型"><el-input v-model="form.DEEPSEEK_MODEL" aria-label="DeepSeek 模型" /></el-form-item>
        </div>
        <div v-show="step === 2">
          <el-form-item label="面板访问地址"><el-input v-model="form.PUBLIC_URL" aria-label="面板访问地址" /></el-form-item>
          <el-form-item label="下载完成回调地址（可选）"><el-input v-model="form.WORKFLOW_CALLBACK_URL" aria-label="下载完成回调地址" placeholder="留空时根据面板地址生成" /></el-form-item>
          <el-form-item label="下载回调认证"><el-switch v-model="form.WEBHOOK_AUTH_ENABLED" aria-label="下载回调认证" /></el-form-item>
          <p class="muted">回调令牌会自动生成并保存。清理下载文件默认关闭，可在登录后的“连接与通知”中设置。</p>
          <p class="muted">保存后即可登录。后续配置可在本地配置文件中修改。</p>
        </div>
        <div class="setup-actions"><el-button v-if="step > 0" @click="step--; error = ''">上一步</el-button><el-button v-if="step < 2" type="primary" native-type="submit">下一步</el-button><el-button v-else type="primary" native-type="submit" :loading="busy" :disabled="!csrf">保存并进入登录</el-button></div>
      </el-form>
    </div>
  </section></main>
</template>
<style scoped>
.setup-page { min-height: 100vh; padding: 32px 16px; background: var(--el-fill-color-light); }
.setup-panel { max-width: 820px; margin: auto; }
h1 { margin: 12px 0; }
.el-steps { margin: 28px 0; }
.el-alert { margin-bottom: 20px; }
.setup-actions { display: flex; justify-content: flex-end; margin-top: 24px; }
@media (max-width: 600px) { .setup-page { padding: 16px 8px; } }
</style>
