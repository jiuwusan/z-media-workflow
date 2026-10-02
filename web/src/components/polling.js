import { onMounted, onUnmounted } from 'vue';
export function usePolling(callback, interval = 3000, enabled = () => true) {
  let timer, active = true, busy = false;
  async function tick() {
    clearTimeout(timer);
    if (!active || document.hidden || !enabled() || busy) return;
    busy = true;
    try { await callback(); } catch { /* Views retain their own error state. */ }
    finally { busy = false; if (active && !document.hidden && enabled()) timer = setTimeout(tick, interval); }
  }
  const visibility = () => { clearTimeout(timer); if (!document.hidden) tick(); };
  onMounted(() => { document.addEventListener('visibilitychange', visibility); tick(); });
  onUnmounted(() => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); });
  return tick;
}
