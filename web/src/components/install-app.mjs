// Browser effects stay injectable so installation can be tested without real services.
export function createInstallController(browser, onChange) {
  const display = browser.matchMedia('(display-mode: standalone)')
  let pending = null
  let installed = false
  let destroyed = false
  let busy = false
  let guide = null
  const hidden = () => installed || display.matches || browser.navigator.standalone === true
  const secure = () => browser.isSecureContext && /^https?:$/.test(browser.location.protocol)
  function publish() {
    if (destroyed) return
    if (hidden()) { pending = null; guide = null }
    onChange({ hidden: hidden(), busy, guide })
  }
  function showGuide(message = '') {
    if (destroyed || hidden()) return
    const agent = browser.navigator.userAgent
    const ios = /iPhone|iPad|iPod/i.test(agent) || (/Macintosh/i.test(agent) && browser.navigator.maxTouchPoints > 1)
    const embedded = /MicroMessenger|\bQQ\/|Weibo|FBAN|FBAV|Instagram|DingTalk|AlipayClient/i.test(agent)
    let description
    let steps
    if (!secure()) {
      description = '请先通过 HTTPS 网址打开网站，再添加到桌面。本机开发也可使用 localhost 或 127.0.0.1。'
      steps = ['打开本站的 HTTPS 地址，本地文件和普通 HTTP 地址无法直接安装网页应用。', '重新点击“添加到桌面”，或使用浏览器菜单中的安装选项。']
    } else if (embedded) {
      description = '当前为应用内置浏览器，请先在系统浏览器中打开。'
      steps = ['点击右上角菜单，选择“在浏览器中打开”，或复制链接到系统浏览器。', ios ? '在 Safari 中点击分享，再选择“添加到主屏幕”。' : '在 Chrome 或系统浏览器菜单选择“安装应用”或“添加到主屏幕”。']
    } else if (ios) {
      description = '在 iPhone 或 iPad 上，通过分享菜单添加到主屏幕。'
      steps = ['点击浏览器分享按钮；找不到时请用 Safari 打开本站。', '选择“添加到主屏幕”；若提供“作为网页 App 打开”，请开启。', '确认添加，之后即可从主屏幕上的 Media Flow 图标打开。']
    } else if (/Android/i.test(agent)) {
      description = '在安卓手机上，可以从浏览器菜单安装或添加到主屏幕。'
      steps = ['使用 Chrome、Edge 或支持安装的系统浏览器打开本站。', '从菜单选择“安装应用”或“添加到主屏幕”，按提示确认。', '之后即可从主屏幕或应用列表打开 Media Flow。']
    } else if (/Macintosh/i.test(agent) && /Safari/i.test(agent) && !/Chrome|Chromium|Edg|OPR/i.test(agent)) {
      description = '在 Mac 上，可以将网站添加到程序坞。'
      steps = ['在 Safari 的“文件”或分享菜单选择“添加到程序坞”。', '确认名称并添加，从程序坞或应用程序打开。', '没有该选项时，可改用新版 Chrome 或 Edge。']
    } else {
      description = '在电脑上安装后，可从桌面、开始菜单或应用列表打开；入口位置由系统和浏览器决定。'
      steps = ['用 Chrome 或 Edge 点击地址栏安装图标，或打开浏览器菜单。', '选择“安装 Media Flow”“将此页面安装为应用”或“将此站点作为应用安装”。', '需要桌面图标时，在浏览器应用管理中创建快捷方式；没有安装选项时，可将网站链接拖到桌面。']
    }
    guide = { description: message ? message + ' ' + description : description, steps }
    publish()
  }
  function beforeInstall(event) {
    if (destroyed || hidden() || !secure()) return
    event.preventDefault()
    pending = event
  }
  function appInstalled() { installed = true; publish() }
  browser.addEventListener('beforeinstallprompt', beforeInstall)
  browser.addEventListener('appinstalled', appInstalled)
  if (display.addEventListener) display.addEventListener('change', publish)
  else display.addListener(publish)
  publish()
  return {
    async install() {
      if (destroyed || busy || hidden()) return
      if (!pending) { showGuide(); return }
      const prompt = pending
      pending = null
      busy = true
      publish()
      try {
        await prompt.prompt()
        const choice = await prompt.userChoice
        if (choice?.outcome === 'dismissed') showGuide('本次未添加，也可以手动添加。')
      } catch {
        showGuide('浏览器未能打开安装窗口，请按以下步骤添加。')
      } finally {
        busy = false
        publish()
      }
    },
    dismiss() { guide = null; publish() },
    destroy() {
      destroyed = true
      pending = null
      browser.removeEventListener('beforeinstallprompt', beforeInstall)
      browser.removeEventListener('appinstalled', appInstalled)
      if (display.removeEventListener) display.removeEventListener('change', publish)
      else display.removeListener(publish)
    },
  }
}
