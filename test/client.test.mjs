/**
 * 浏览器半的**纯函数**回归测试。
 *
 * client.js 是模块加载器包体（依赖 `window.__ModuleLoader__` 与 `require('react')`），
 * 所以这里用一个最小桩在 Node 里把它加载起来，只断言那些不渲染 DOM 也能验证的
 * 契约：注册了哪些插槽、`inject` 面、`sessionRows` 的数据投影，以及三份字典的
 * 键是否对齐（漏键会在界面上直接显示成 key）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = path.resolve(here, '..', 'client.js')

/** 极简 React 桩：只要 createElement 与常用 hooks 存在即可。 */
function reactStub() {
  const noop = () => undefined
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useCallback: (fn) => fn,
    useEffect: noop,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, noop],
  }
}

/**
 * 把 client.js 加载进一个受控环境，返回它导出的插件对象与所有注册记录。
 * @param {object} [options] - 覆盖项。
 * @returns {{plugin: object, registrations: Array, effects: number, ctx: object, localeRegistrations: Array}}
 */
function loadClient(options = {}) {
  const source = fs.readFileSync(CLIENT_FILE, 'utf8')
  const registrations = []
  const localeRegistrations = []
  const effects = []

  const slots = {
    inject: (key, callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => undefined
    },
    register: (spec, component) => {
      registrations.push({ spec, component })
      return () => undefined
    },
  }

  const localeService = options.noLocale
    ? undefined
    : {
        register: (ns, dicts) => {
          localeRegistrations.push({ ns, dicts })
          return () => undefined
        },
        bind: () => (key) => (key === 'title' ? '角色扮演' : key),
      }

  const services = new Map([
    ['slots', slots],
    ['locale', localeService],
    ['uiWorkspace', options.workspace],
  ])

  const ctx = {
    get: (name) => services.get(name),
    effect: (factory, label) => {
      const disposer = factory()
      effects.push({ label, disposer })
      return () => undefined
    },
    on: () => () => undefined,
  }
  // 声明的服务以属性形式暴露（真实 runner 只对 inject 里声明过的名字开这个门）。
  if (localeService !== undefined) ctx.locale = localeService
  if (!options.noSlots) ctx.slots = slots

  let registration
  const window = {
    __ModuleLoader__: {
      load: (entry) => {
        registration = entry
      },
    },
    localStorage: {
      getItem: () => (options.remembered ?? null),
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  }

  const require = (specifier) => {
    if (specifier === 'react') return reactStub()
    throw new Error(`unexpected require: ${specifier}`)
  }

  const run = new Function('window', 'require', 'console', `${source}\nreturn window.__ModuleLoader__;`)
  run(window, require, { error: () => undefined, warn: () => undefined, log: () => undefined })
  assert.ok(registration !== undefined, 'client.js must call window.__ModuleLoader__.load')
  const plugin = registration.factory(require)
  return { plugin, registrations, effects, ctx, localeRegistrations, entry: registration, pluginLoader: registration }
}

test('the bundle registers under its package id and exports a plugin object', () => {
  const { entry, plugin } = loadClient()
  assert.equal(entry.id, 'dsh-roleplay')
  assert.equal(plugin.name, 'dsh-roleplay')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
})

test('apply registers the sidebar icon and the main panel with matching ids', () => {
  const { plugin, ctx, registrations } = loadClient()
  plugin.apply(ctx)
  const rail = registrations.find((row) => row.spec.name === 'sidebar.panellist')
  const main = registrations.find((row) => row.spec.name === 'main')
  assert.ok(rail !== undefined, 'sidebar.panellist must be registered')
  assert.ok(main !== undefined, 'main must be registered')
  assert.equal(rail.spec.id, 'roleplay')
  assert.equal(main.spec.key, 'roleplay', 'the rail id must address the same main key')
  assert.equal(rail.spec.locale, 'dsh-roleplay')
  assert.equal(typeof rail.spec.label, 'function', 'label must be a thunk so it follows the locale')
})

test('both registrations declare the locale namespace and the panel injects its kit', () => {
  const { plugin, ctx, registrations } = loadClient()
  plugin.apply(ctx)
  const main = registrations.find((row) => row.spec.name === 'main')
  assert.equal(main.spec.locale, 'dsh-roleplay')
  const injected = main.spec.inject()
  assert.ok(Object.hasOwn(injected, 'kit'), 'the panel gets its service bag through inject')
  assert.ok(Object.hasOwn(injected.kit, 'uiWorkspace'))
})

test('dictionaries register under the shipped locale ids (zh / en), not zh-CN', () => {
  const { plugin, ctx, localeRegistrations } = loadClient()
  plugin.apply(ctx)
  assert.equal(localeRegistrations.length, 1)
  const { ns, dicts } = localeRegistrations[0]
  assert.equal(ns, 'dsh-roleplay')
  assert.deepEqual(Object.keys(dicts).sort(), ['en', 'zh'])
})

test('every zh key exists in en and vice versa', () => {
  const { plugin } = loadClient()
  const { zh, en } = plugin.__internals
  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.deepEqual(enKeys, zhKeys, 'a missing key would render as its raw id in the UI')
})

test('a half-registered locale service degrades to the inline dictionary instead of throwing', () => {
  const { plugin, ctx } = loadClient({ noLocale: true })
  assert.doesNotThrow(() => plugin.apply(ctx))
})

test('sessionRows excludes subagents, reads agentPreset from projectionValues, and sorts newest first', () => {
  const { plugin } = loadClient()
  const { sessionRows } = plugin.__internals
  const snapshot = {
    byId: {
      'session-a': { id: 'session-a', title: '旧会话', updatedAt: 10, retainedBy: {}, projectionValues: { agentPreset: 'standard' } },
      'session-b': { id: 'session-b', title: '角色会话', updatedAt: 30, retainedBy: { mainView: 1 }, projectionValues: { agentPreset: 'roleplay' } },
      'session-c': { id: 'session-c', updatedAt: 20, retainedBy: {}, origin: 'subagent' },
      'session-d': { id: 'session-d', updatedAt: 5, retainedBy: {} },
    },
  }
  const rows = sessionRows(snapshot)
  assert.deepEqual(rows.map((row) => row.id), ['session-b', 'session-a', 'session-d'])
  assert.equal(rows[0].roleplay, true)
  assert.equal(rows[0].retained, true)
  assert.equal(rows[1].roleplay, false)
  assert.equal(rows[2].title, 'session-d', 'a missing title falls back to the id')
})

test('sessionRows tolerates a snapshot that has not loaded yet', () => {
  const { plugin } = loadClient()
  const { sessionRows } = plugin.__internals
  assert.deepEqual(sessionRows(undefined), [])
  assert.deepEqual(sessionRows({}), [])
  assert.deepEqual(sessionRows({ byId: { x: null } }), [])
})

test('the client never requires a Harness client package', () => {
  const source = fs.readFileSync(CLIENT_FILE, 'utf8')
  assert.ok(!source.includes('@deepseek-ai/dsh-client'), 'client half must not import Harness Client packages')
  const requires = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
  assert.deepEqual([...new Set(requires)], ['react'], 'react is the only module-table word used')
})

test('the panel styles use only theme tokens for colour', () => {
  const source = fs.readFileSync(CLIENT_FILE, 'utf8')
  const styleBlock = source.slice(source.indexOf('const S = {'), source.indexOf('/* ── data plumbing'))
  const colourLines = styleBlock
    .split('\n')
    .filter((line) => /(color|background|border)\s*:/.test(line) && !line.includes('var(--dsw-'))
    .filter((line) => /#[0-9a-fA-F]{3,8}|rgb\(|hsl\(/.test(line))
  assert.deepEqual(colourLines, [], 'literal colours break light/dark; use --dsw-alias-* tokens')
})
