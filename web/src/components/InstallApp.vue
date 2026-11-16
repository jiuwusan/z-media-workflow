<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createInstallController } from './install-app.mjs'

defineProps({ floating: Boolean })
const state = ref({ hidden: false, busy: false, guide: null })
const dialog = ref(null)
const button = ref(null)
let controller
onMounted(() => {
  controller = createInstallController(window, value => { state.value = value })
})
onBeforeUnmount(() => controller?.destroy())
watch(() => state.value.guide, async guide => {
  await nextTick()
  if (guide && !dialog.value?.open) dialog.value?.showModal()
  else if (!guide && dialog.value?.open) dialog.value.close()
})
function closeGuide() {
  controller?.dismiss()
  if (!state.value.hidden) button.value?.focus()
}
</script>

<template>
  <div class="install-app" :class="{ 'install-floating': floating }">
    <button v-if="!state.hidden" ref="button" class="install-button" type="button" :disabled="state.busy" @click="controller?.install()">
      {{ state.busy ? '正在打开…' : '添加到桌面' }}
    </button>
    <dialog ref="dialog" class="install-dialog" aria-labelledby="install-title" aria-describedby="install-description" @close="closeGuide">
      <div class="install-dialog-heading"><h2 id="install-title">添加到桌面</h2><button type="button" aria-label="关闭添加到桌面指引" @click="closeGuide">×</button></div>
      <template v-if="state.guide">
        <p id="install-description">{{ state.guide.description }}</p>
        <ol><li v-for="step in state.guide.steps" :key="step">{{ step }}</li></ol>
      </template>
      <button class="install-button" type="button" @click="closeGuide">知道了</button>
    </dialog>
  </div>
</template>

<style scoped>
.install-app { display: flex; }
.install-button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; border: 1px solid #d9e6e0; border-radius: 8px; padding: 7px 12px; background: #fff; color: #397967; font: inherit; font-size: 12px; line-height: 1.5; white-space: nowrap; cursor: pointer; }
.install-button:hover { background: #f0f6f3; }
.install-button:focus-visible, .install-dialog-heading button:focus-visible { outline: 2px solid #397967; outline-offset: 3px; }
.install-button:disabled { opacity: .6; cursor: wait; }
.install-dialog { width: min(460px, calc(100vw - 32px)); max-height: calc(100dvh - 40px); overflow-y: auto; margin: auto; border: 1px solid #dce3e7; border-radius: 14px; padding: 24px; background: #fff; color: #334155; box-shadow: 0 20px 80px #0003; font-size: 14px; line-height: 1.8; }
.install-dialog::backdrop { background: #122b3580; }
.install-dialog-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.install-dialog-heading h2 { margin: 0; font-size: 19px; color: #262626; }
.install-dialog-heading button { width: 32px; height: 32px; padding: 0; border: 0; border-radius: 6px; background: #f1f2f4; color: #475569; font-size: 24px; cursor: pointer; }
.install-dialog p { margin: 0 0 14px; }
.install-dialog ol { margin: 0 0 20px; padding-left: 22px; }
.install-dialog li + li { margin-top: 10px; }
.install-floating { position: fixed; right: 24px; top: 20px; z-index: 20; }
@media (max-width: 640px) {
  .install-floating { top: 12px; right: 12px; }
  .install-button { min-height: 44px; }
  .install-dialog-heading button { width: 44px; height: 44px; }
}
@media print { .install-app, .install-dialog { display: none !important; } .install-dialog::backdrop { display: none; } }
</style>
