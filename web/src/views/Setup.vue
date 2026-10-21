<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import { api, setSession } from '../api/index.js';
const router = useRouter(), step = ref(0), busy = ref(false), error = ref(''), csrf = ref(''), confirmPassword = ref('');
const form = reactive({ ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: '', PUBLIC_URL: `${window.location.origin}/`, QBT_URL: 'http://localhost:8080/', QBT_API_KEY: '', JELLYFIN_URL: 'http://localhost:8096/', JELLYFIN_API_KEY: '', DEEPSEEK_URL: 'https://api.deepseek.com/', DEEPSEEK_API_KEY: '', DEEPSEEK_MODEL: 'deepseek-flash', WORKFLOW_CALLBACK_URL: '', WEBHOOK_AUTH_ENABLED: false });
const connections = [{ title: 'qBittorrent', url: 'QBT_URL', key: 'QBT_API_KEY' }, { title: 'Jellyfin', url: 'JELLYFIN_URL', key: 'JELLYFIN_API_KEY' }, { title: 'DeepSeek', url: 'DEEPSEEK_URL', key: 'DEEPSEEK_API_KEY' }];
const cursorText=ref(''),cursorPreview=ref(null),cursorChoice=ref(null);
const unmatchedScopes=computed(()=>{
  if(!cursorPreview.value)return 0;
  const normalize=value=>new URL(value).href.replace(/\/+$/,'');
  try{return Object.keys(cursorPreview.value.data.libraries).filter(scope=>normalize(JSON.parse(scope)[0])!==normalize(form.JELLYFIN_URL)).length;}
  catch{return cursorPreview.value.libraries;}
});
function previewCursor(){
  try{
    if(new TextEncoder().encode(cursorText.value).length>10*1024*1024)throw new Error('游标 JSON 不得超过 10 MiB');
    const value=JSON.parse(cursorText.value);
    if(value.version!==1||!value.libraries||Array.isArray(value.libraries)||typeof value.libraries!=='object')throw new Error('仅支持 version 1 的完整游标 JSON');
    let ids=0;for(const [scope,cursor]of Object.entries(value.libraries)){const key=JSON.parse(scope);if(!Array.isArray(key)||key.length!==3||!['Movie','Series'].includes(key[2])||!['ids','pending','undated'].every(k=>Array.isArray(cursor[k])))throw new Error('游标范围或 ID 列表无效');ids+=['ids','pending','undated'].reduce((n,k)=>n+new Set(cursor[k]).size,0);}
    cursorPreview.value={data:value,libraries:Object.keys(value.libraries).length,ids};error.value='';
  }catch(e){cursorPreview.value=null;error.value=e.message;}
}
function chooseCursor(mode){if(mode==='import'&&!cursorPreview.value)return;cursorChoice.value=mode==='import'?{mode,data:cursorPreview.value.data}:{mode};if(mode==='skip'){cursorText.value='';cursorPreview.value=null;}error.value='';step.value=3;}
function clear(){form.ADMIN_PASSWORD=confirmPassword.value=cursorText.value='';for(const c of connections)form[c.key]='';cursorPreview.value=cursorChoice.value=null;}
onBeforeUnmount(clear);
onMounted(async () => { try { csrf.value = (await api('/setup/status', { quiet: true })).csrfToken; } catch (e) { error.value = e.message; } });
function next() {
  error.value = '';
  if (step.value === 0 && (!form.ADMIN_USERNAME.trim() || form.ADMIN_PASSWORD.length < 8 || form.ADMIN_PASSWORD !== confirmPassword.value)) { error.value = '请填写用户名、至少 8 位的密码，并确保两次密码一致。'; return; }
  if (step.value === 1) {
    for (const connection of connections) {
      let url; try { url = new URL(form[connection.url]); } catch {}
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || !form[connection.key].trim()) { error.value = `请填写有效的 ${connection.title} 地址和 API 密钥。`; return; }
    }
  }
  if(step.value===2){error.value='请同步游标或选择跳过';return;}step.value++;
}
async function save() {
  busy.value = true; error.value = '';
  try { await api('/setup', { method: 'POST', body: { ...form,cursor:cursorChoice.value }, csrf: csrf.value, quiet: true }); clear();setSession(null); await router.replace('/login'); }
  catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
</script>
<template>
  <main class="setup-page"><section class="panel setup-panel">
    <div class="panel-body"><div class="eyebrow">MEDIA FLOW</div><h1>首次运行配置</h1><p class="muted">创建你的工作空间，连接下载、媒体库和识别服务。</p>
      <el-steps :active="step" finish-status="success" align-center><el-step title="管理员账号" /><el-step title="服务连接" /><el-step title="游标同步" /><el-step title="完成配置" /></el-steps>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <el-form label-position="top" :disabled="busy" @submit.prevent="step < 3 ? next() : save()">
        <div v-show="step === 0">
          <el-form-item label="管理员用户名"><el-input v-model="form.ADMIN_USERNAME" aria-label="管理员用户名" autocomplete="username" /></el-form-item>
          <el-form-item label="管理员密码"><el-input v-model="form.ADMIN_PASSWORD" aria-label="管理员密码" type="password" show-password autocomplete="new-password" maxlength="1024" placeholder="至少 8 位" /></el-form-item>
          <el-form-item label="确认密码"><el-input v-model="confirmPassword" aria-label="确认密码" type="password" show-password autocomplete="new-password" maxlength="1024" /></el-form-item>
        </div>
        <div v-show="step === 1">
          <section v-for="connection in connections" :key="connection.key"><h3>{{ connection.title }}</h3><el-row :gutter="16"><el-col :xs="24" :sm="12"><el-form-item label="服务地址"><el-input v-model="form[connection.url]" :aria-label="`${connection.title} 地址`" /></el-form-item></el-col><el-col :xs="24" :sm="12"><el-form-item label="API 密钥"><el-input v-model="form[connection.key]" :aria-label="`${connection.title} API 密钥`" type="password" show-password autocomplete="off" /></el-form-item></el-col></el-row></section>
          <el-form-item label="DeepSeek 模型"><el-input v-model="form.DEEPSEEK_MODEL" aria-label="DeepSeek 模型" /></el-form-item>
        </div>
        <div v-show="step === 2">
          <h3>游标同步（可跳过）</h3><p class="muted">如需延续旧识别进度，请粘贴 media-cursors.json 的完整内容；系统不会自动读取该文件。</p>
          <el-input v-model="cursorText" type="textarea" :rows="9" aria-label="游标 JSON" placeholder="粘贴完整游标 JSON" @input="cursorPreview = null" />
          <el-button style="margin-top:12px" @click="previewCursor">校验并预览</el-button>
          <p v-if="cursorPreview">{{ cursorPreview.libraries }} 个范围，{{ cursorPreview.ids }} 个媒体 ID</p>
          <el-alert v-if="unmatchedScopes" :title="`${unmatchedScopes} 个范围与当前 Jellyfin 地址不匹配，将保留原地址，不用于当前服务；对应存量媒体可能重新识别。请在初始化前确认。`" type="warning" :closable="false" show-icon />
          <el-alert title="跳过将使用空游标，存量媒体可能重新进入待识别范围。初始化完成后不再提供手动同步入口。" type="info" :closable="false" show-icon />
        </div>
        <div v-show="step === 3">
          <el-form-item label="面板访问地址"><el-input v-model="form.PUBLIC_URL" aria-label="面板访问地址" /></el-form-item>
          <el-form-item label="下载完成回调地址（可选）"><el-input v-model="form.WORKFLOW_CALLBACK_URL" aria-label="下载完成回调地址" placeholder="留空时根据面板地址生成" /></el-form-item>
          <el-form-item label="下载回调认证"><el-switch v-model="form.WEBHOOK_AUTH_ENABLED" aria-label="下载回调认证" /></el-form-item>
          <p class="muted">回调令牌会自动生成并保存。清理下载文件默认关闭，可在登录后的“种子清理”中设置。</p>
          <p>游标：{{ cursorChoice?.mode === 'import' ? '同步所选数据' : '已跳过，使用空游标' }}</p>
          <p class="muted">保存后即可登录。后续配置在“基础配置”页面修改。请备份数据目录中的 passkey 文件，用于找回账号和重置密码。</p>
        </div>
        <div class="setup-actions"><el-button v-if="step > 0" @click="step--; error = ''">上一步</el-button><el-button v-if="step < 2" type="primary" native-type="submit">下一步</el-button><template v-else-if="step === 2"><el-button @click="chooseCursor('skip')">跳过</el-button><el-button type="primary" :disabled="!cursorPreview" @click="chooseCursor('import')">同步并继续</el-button></template><el-button v-else type="primary" native-type="submit" :loading="busy" :disabled="!csrf || !cursorChoice">保存并进入登录</el-button></div>
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
