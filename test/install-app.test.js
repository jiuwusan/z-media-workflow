import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const controllerUrl = new URL('../web/src/components/install-app.mjs', import.meta.url)
async function fixture(options = {}) {
  assert.ok(existsSync(controllerUrl), 'desktop install controller must exist')
  const { createInstallController } = await import(controllerUrl.href)
  const browser = new EventTarget()
  const display = new EventTarget()
  display.matches = options.standalone ?? false
  browser.matchMedia = () => display
  browser.isSecureContext = options.secure ?? true
  browser.location = { protocol: options.protocol ?? 'https:' }
  browser.navigator = { userAgent: options.agent ?? 'Chrome', maxTouchPoints: options.touch ?? 0, standalone: options.iosStandalone ?? false }
  let state
  const controller = createInstallController(browser, value => { state = value })
  return { browser, display, controller, state: () => state }
}
function promptEvent(outcome = 'accepted', failure = false) {
  const event = new Event('beforeinstallprompt', { cancelable: true })
  event.calls = 0
  event.prompt = async () => { event.calls++; if (failure) throw new Error('unavailable') }
  event.userChoice = Promise.resolve({ outcome })
  return event
}

test('desktop manifest and web/index.html preserve relative installed assets', () => {
  const manifestPath = new URL('../web/public/manifest.webmanifest', import.meta.url)
  assert.ok(existsSync(manifestPath), 'desktop manifest must exist')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.scope, './')
  assert.equal(Object.hasOwn(manifest, 'id'), false)
  assert.equal(manifest.start_url, './')
  assert.deepEqual(manifest.icons.map(icon => icon.src), ['./icon-192.png', './icon-512.png'])
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
  assert.match(html, /href="%BASE_URL%manifest.webmanifest"/)
  assert.match(html, /href="%BASE_URL%icon-180.png"/)
})

test('native install requires click, consumes each event once, and accepted is not installed', async () => {
  const f = await fixture()
  const event = promptEvent()
  f.browser.dispatchEvent(event)
  assert.equal(event.defaultPrevented, true)
  assert.equal(event.calls, 0)
  await f.controller.install()
  assert.equal(event.calls, 1)
  assert.equal(f.state().hidden, false)
  await f.controller.install()
  assert.equal(event.calls, 1)
  assert.ok(f.state().guide)
  f.browser.dispatchEvent(new Event('appinstalled'))
  assert.equal(f.state().hidden, true)
  assert.equal(f.state().guide, null)
  f.controller.destroy()
})

test('dismissed and failed native prompts give manual instructions and reset busy state', async () => {
  for (const [outcome, failure, message] of [['dismissed', false, /未添加/], ['accepted', true, /未能/]]) {
    const f = await fixture()
    f.browser.dispatchEvent(promptEvent(outcome, failure))
    await f.controller.install()
    assert.match(f.state().guide.description, message)
    assert.equal(f.state().busy, false)
    f.controller.dismiss()
    assert.equal(f.state().guide, null)
    f.controller.destroy()
  }
})

test('standalone launches hide the entry and display mode changes close guidance', async () => {
  for (const options of [{ standalone: true }, { iosStandalone: true }]) {
    const f = await fixture(options)
    await f.controller.install()
    assert.equal(f.state().hidden, true)
    assert.equal(f.state().guide, null)
    f.controller.destroy()
  }
  const f = await fixture()
  await f.controller.install()
  f.display.matches = true
  f.display.dispatchEvent(new Event('change'))
  assert.equal(f.state().guide, null)
  assert.equal(f.state().hidden, true)
  f.controller.destroy()
})

test('manual guidance covers secure origin, embedded browser, iPad, Android, Mac Safari and desktop', async () => {
  const cases = [
    [{ secure: false }, /HTTPS/],
    [{ protocol: 'file:' }, /HTTPS/],
    [{ agent: 'MicroMessenger iPhone' }, /内置浏览器/],
    [{ agent: 'Macintosh Safari', touch: 5 }, /iPhone|iPad/],
    [{ agent: 'Android Chrome' }, /安卓/],
    [{ agent: 'Macintosh Safari' }, /Mac/],
    [{ agent: 'Chrome Windows' }, /电脑/],
  ]
  for (const [options, expected] of cases) {
    const f = await fixture(options)
    await f.controller.install()
    assert.match(f.state().guide.description, expected)
    assert.ok(f.state().guide.steps.length >= 2)
    f.controller.destroy()
  }
})

test('destroy unregisters listeners and pending installs cannot reopen guidance', async () => {
  const f = await fixture()
  const event = promptEvent()
  let reject
  event.prompt = () => new Promise((resolve, failure) => { reject = failure })
  f.browser.dispatchEvent(event)
  const installing = f.controller.install()
  assert.equal(f.state().busy, true)
  f.controller.destroy()
  reject(new Error('closed'))
  await installing
  assert.equal(f.state().guide, null)
  f.browser.dispatchEvent(new Event('appinstalled'))
  assert.equal(f.state().hidden, false)
})
