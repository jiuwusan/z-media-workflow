export async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; } catch {}
  }
  const input = document.createElement('textarea');
  input.value = value; input.readOnly = true;
  input.style.cssText = 'position:fixed;left:-9999px;top:0';
  const focused = document.activeElement;
  document.body.append(input);
  try { input.select(); if (!document.execCommand('copy')) throw new Error('复制失败'); }
  finally { input.remove(); focused?.focus?.(); }
}
