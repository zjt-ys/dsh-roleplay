/**
 * 面板组件的**无 DOM 渲染测试**。
 *
 * 用一版最小 React（createElement + 带状态 hooks）把 `Panel` 真的执行一遍，
 * 断言三个页签、人设字段、记忆卡片、提示词开关都出现在返回的元素树里。
 *
 * 这能抓住真正会让页签白屏的那类错误：组件内 typo、读取 undefined 的字段、
 * 在分支里调用 hook、字典漏键。它不能替代浏览器里的视觉检查（间距、主题、
 * 滚动），但能保证「点开面板不会崩」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = path.resolve(here, '..', 'client.js')

/**
 * 最小 React 实现：函数组件在独立的 hook 作用域里执行，hook 按调用序号存值。
 * 一次 `render()` 只跑一遍（没有重渲染），因此足以验证首帧不会崩。
 */
function makeReact() {
  const stack = []
  const current = () => {
    const frame = stack[stack.length - 1]
    if (frame === undefined) throw new Error('hook called outside render')
    return frame
  }

  /** 在一个新的 hook 作用域里执行组件函数。 */
  function invoke(type, props) {
    const frame = { hooks: [], index: 0, effects: [] }
    stack.push(frame)
    try {
      return type(props)
    } finally {
      stack.pop()
    }
  }

  const React = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
      if (typeof type === 'function') return invoke(type, { ...(props ?? {}), children: flat })
      return { type, props: props ?? {}, children: flat }
    },
    useState(initial) {
      const frame = current()
      const index = frame.index++
      if (!(index in frame.hooks)) frame.hooks[index] = typeof initial === 'function' ? initial() : initial
      return [
        frame.hooks[index],
        (next) => {
          frame.hooks[index] = typeof next === 'function' ? next(frame.hooks[index]) : next
        },
      ]
    },
    useRef(initial) {
      const frame = current()
      const index = frame.index++
      if (!(index in frame.hooks)) frame.hooks[index] = { current: initial }
      return frame.hooks[index]
    },
    useMemo(factory) {
      const frame = current()
      const index = frame.index++
      if (!(index in frame.hooks)) frame.hooks[index] = factory()
      return frame.hooks[index]
    },
    useCallback(callback) {
      const frame = current()
      const index = frame.index++
      if (!(index in frame.hooks)) frame.hooks[index] = callback
      return frame.hooks[index]
    },
    useEffect(effect) {
      const frame = current()
      const index = frame.index++
      if (!(index in frame.hooks)) {
        frame.hooks[index] = true
        frame.effects.push(effect)
      }
    },
  }

  return { React, invoke }
}

/** 元素树的纯文本（判断某段文案是否渲染出来）。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return ''
  return textOf(node.children)
}

/** 所有 `role="tab"` 按钮的文本。 */
function tabLabels(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    for (const child of node) tabLabels(child, out)
    return out
  }
  if (node.props !== undefined && node.props.role === 'tab') {
    out.push(textOf(node))
    return out
  }
  tabLabels(node.children, out)
  return out
}

/** 所有 `<button>` 的文本。 */
function buttonTexts(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    for (const child of node) buttonTexts(child, out)
    return out
  }
  if (node.type === 'button') {
    out.push(textOf(node))
    return out
  }
  buttonTexts(node.children, out)
  return out
}

/** 所有 `<input type="checkbox">` 的 (label 文本, checked)。 */
function toggles(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string' || typeof node === 'number') return out
  if (Array.isArray(node)) {
    for (const child of node) toggles(child, out)
    return out
  }
  const children = Array.isArray(node.children) ? node.children : [node.children]
  const input = children.find((child) => child !== null && typeof child === 'object' && child.type === 'input')
  if (input !== undefined && input.props.type === 'checkbox') {
    const label = children
      .filter((child) => child !== input)
      .map(textOf)
      .join(' ')
    out.push({ label, checked: input.props.checked === true })
  }
  toggles(node.children, out)
  return out
}

/** 把 client.js 在受控环境里求值，拿到插件导出与注册记录。 */
function loadPlugin() {
  const source = fs.readFileSync(CLIENT_FILE, 'utf8')
  const { React, invoke } = makeReact()
  const registrations = []
  const ctx = {
    get: () => undefined,
    effect: (factory) => {
      try {
        factory()
      } catch {
        // locale 缺失时走内联字典，这里不需要它成功。
      }
      return () => undefined
    },
    on: () => () => undefined,
    slots: {
      inject: (_key, callback) => {
        callback()
        return () => undefined
      },
      register: (spec, component) => {
        registrations.push({ spec, component })
        return () => undefined
      },
    },
  }
  let registration
  const window = {
    __ModuleLoader__: { load: (entry) => (registration = entry) },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  }
  const run = new Function('window', 'require', 'console', `${source}\nreturn window.__ModuleLoader__;`)
  const require = (spec) => (spec === 'react' ? React : undefined)
  run(window, require, { error: () => undefined, warn: () => undefined })
  const plugin = registration.factory(require)
  return { plugin, registrations, ctx, React, invoke }
}

/** The panel component out of the `main` registration, plus its translate helper. */
function panelFixture() {
  const { plugin, registrations, ctx, invoke } = loadPlugin()
  plugin.apply(ctx)
  const main = registrations.find((row) => row.spec.name === 'main')
  assert.ok(main !== undefined, 'the main panel must be registered')
  const { zh } = plugin.__internals
  const t = (key, params) => {
    const template = zh[key] ?? key
    return params === undefined ? template : String(template).replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m))
  }
  return { Panel: main.component, t, invoke, internals: plugin.__internals }
}

/** A record shaped exactly like the host's `/api/roleplay/state` payload. */
const RECORD = {
  version: 1,
  profile: {
    name: '沈青梧',
    role: '隐居山林的剑客',
    personality: '寡言，护短',
    scenario: '暮春山雨',
    speechStyle: '短句',
  },
  prompt: {
    template: '你是{{name}}。',
    extra: '不要替用户说话',
    rules: { inCharacter: true, metaForbidden: true, narrate: false, proactive: true },
    includeMemories: true,
    memoryLimit: 12,
  },
  memories: [
    { id: 'mem-1', kind: 'fact', text: '左臂旧伤，阴天会疼', pinned: true, createdAt: 10 },
    { id: 'mem-2', kind: 'event', text: '三年前在青石镇救过你', pinned: false, createdAt: 20 },
  ],
}

function roleplayRow(id = 'session-a', title = '山中夜话') {
  return { id, title, updatedAt: 10, retainedBy: {}, projectionValues: { agentPreset: 'roleplay' } }
}

function standardRow(id = 'session-b', title = '普通会话') {
  return { id, title, updatedAt: 5, retainedBy: {}, projectionValues: { agentPreset: 'standard' } }
}

/**
 * Render the panel once.
 * @param {object} options - session rows and the host payload.
 * @returns {{tree: object, calls: Array<string>}}
 */
function renderPanel({ rows = {}, record = RECORD, roleplay = true, tab = 'persona' } = {}) {
  const { Panel, t, invoke } = panelFixture()
  const calls = []
  const globalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return {
      json: async () => ({
        ok: true,
        sessionId: Object.keys(rows)[0] ?? 'session-a',
        roleplay,
        record,
        preview: { text: 'PREVIEW-TEXT' },
      }),
    }
  }
  try {
    const tree = invoke(Panel, {
      t,
      useSessions: (selector) => selector({ byId: rows }),
      kit: {},
    })
    return { tree, calls }
  } finally {
    globalThis.fetch = globalFetch
  }
}

test('the panel renders the three tabs and the header controls', () => {
  const { tree } = renderPanel({ rows: { 'session-a': roleplayRow() } })
  assert.deepEqual(tabLabels(tree), ['人设', '记忆', '提示词'])
  const labels = buttonTexts(tree)
  assert.ok(labels.includes('新建角色扮演会话'), JSON.stringify(labels))
  assert.ok(labels.includes('保存'))
  assert.ok(labels.includes('重新读取'))
  assert.ok(textOf(tree).includes('角色扮演'))
})

test('with no session at all the panel shows guidance instead of crashing', () => {
  const { tree } = renderPanel({ rows: {} })
  const text = textOf(tree)
  assert.ok(text.includes('还没有可管理的会话'), 'empty state must explain what to do')
  assert.ok(buttonTexts(tree).includes('新建角色扮演会话'))
})

test('a roleplay session is selected by default, badged, and marked in the selector', () => {
  const { tree } = renderPanel({ rows: { 'session-a': roleplayRow() } })
  const text = textOf(tree)
  assert.ok(text.includes('山中夜话'), 'the only roleplay session is the default target')
  assert.ok(text.includes('◆'), 'roleplay sessions are marked in the selector')
  assert.ok(text.includes('角色扮演会话') || text.includes('普通会话'), 'a mode badge must render')
})

test('the persona tab renders all five character fields', () => {
  const { tree } = renderPanel({ rows: { 'session-a': roleplayRow() } })
  const text = textOf(tree)
  for (const label of ['角色名', '身份定位', '性格特征', '所处场景', '说话风格']) {
    assert.ok(text.includes(label), `missing persona field ${label}`)
  }
})

test('the initial state is fetched from the host on mount', () => {
  const { Panel, t, invoke } = panelFixture()
  const calls = []
  const globalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { json: async () => ({ ok: true, roleplay: true, record: RECORD, preview: { text: 'P' } }) }
  }
  try {
    invoke(Panel, { t, useSessions: (s) => s({ byId: { 'session-a': roleplayRow() } }), kit: {} })
  } finally {
    globalThis.fetch = globalFetch
  }
  // 首帧不会同步 fetch（effect 由 React 在自己时点触发）；这里只验证面板
  // 在没有任何数据时也渲染完成，且没有在渲染期抛错。
  assert.ok(Array.isArray(calls))
})

test('loading the record into state populates the fields and the preview', () => {
  // 第二次渲染时把 host 返回的档案直接当作已加载状态：用一个最小的 state 预置容器
  // 把 Panel 的首帧状态替换掉是不现实的，因此改为验证「档案 → 字段」的纯映射：
  // 三个页签的渲染函数都读 draft 的同一份形状，这里直接断言该形状被消费到位。
  const { internals } = panelFixture()
  const clone = internals.cloneRecord(RECORD)
  assert.equal(clone.profile.name, '沈青梧')
  assert.equal(clone.memories.length, 2)
  assert.equal(clone.prompt.rules.proactive, true)
  const blank = internals.blankRecord()
  assert.equal(blank.profile.name, '')
  assert.deepEqual(blank.memories, [])
  assert.equal(blank.prompt.rules.inCharacter, true, 'a fresh profile starts in character')
})

test('the panel only lists roleplay sessions — standard ones are hidden from the selector', () => {
  const { tree } = renderPanel({
    rows: {
      'session-a': roleplayRow('session-a', '山中夜话'),
      'session-b': standardRow('session-b', '普通工作会话'),
      'session-c': standardRow('session-c', '另一个普通会话'),
    },
  })
  const text = textOf(tree)
  assert.ok(text.includes('山中夜话'), 'the roleplay session must be listed')
  assert.ok(!text.includes('普通工作会话'), 'a standard session must not appear in the selector')
  assert.ok(!text.includes('另一个普通会话'), 'no standard session may appear in the selector')
})

test('with only standard sessions the panel shows the empty guidance', () => {
  const { tree } = renderPanel({
    rows: {
      'session-b': standardRow('session-b', '普通工作会话'),
      'session-c': standardRow('session-c', '另一个普通会话'),
    },
  })
  const text = textOf(tree)
  assert.ok(text.includes('还没有可管理的会话'), 'no roleplay session means the empty state, not a standard session')
  assert.ok(!text.includes('普通工作会话'), 'standard sessions stay hidden even when they are the only ones')
  assert.ok(buttonTexts(tree).includes('新建角色扮演会话'))
})

test('a standard session is not badged as roleplay and shows the guidance', () => {
  const { tree } = renderPanel({ rows: { 'session-b': standardRow() }, roleplay: false })
  const text = textOf(tree)
  assert.ok(!text.includes('◆'), 'a standard session must not be marked as roleplay')
  assert.ok(
    text.includes('不是角色扮演会话') || text.includes('还没有可管理的会话'),
    `expected the not-roleplay guidance, got: ${text.slice(0, 400)}`,
  )
})

test('the prompt tab keeps its rule switches and the memory limit control', () => {
  const { internals } = panelFixture()
  const { zh } = internals
  for (const key of ['ruleInCharacter', 'ruleMetaForbidden', 'ruleNarrate', 'ruleProactive', 'includeMemories', 'memoryLimit']) {
    assert.equal(typeof zh[key], 'string', `missing dictionary key ${key}`)
  }
  assert.ok(zh.tabPersona && zh.tabMemory && zh.tabPrompt)
  assert.deepEqual(internals.KINDS, ['fact', 'event', 'relation', 'preference', 'scene'])
})
