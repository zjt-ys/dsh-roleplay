/**
 * 宿主半行为测试：用假 ctx / 假 agent 验证**最关键的一条契约**——
 *
 *   只有 agentPreset === 'roleplay' 的会话才会注册提示词 section/context 和
 *   roleplay_memory 工具；普通会话一个都不注册。
 *
 * 这条用真实进程里的 Cordis 很难低成本复现（要起 session + agent），而它又
 * 正是「只有新对话选择角色扮演模式才调用插件」这一需求的落点，所以用最小
 * 桩把它钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply, PRESET_ID } from '../index.js'
import { renderMemoryContext, renderPersonaSection } from '../prompt.js'

/** 记录式 event bus：`ctx.on(name, fn)` 的桩。 */
function eventBus() {
  const listeners = new Map()
  return {
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        listeners.set(name, current.filter((entry) => entry !== fn))
      }
    },
    emit(name, payload) {
      for (const fn of [...(listeners.get(name) ?? [])]) fn(payload)
    },
    count(name) {
      return (listeners.get(name) ?? []).length
    },
  }
}

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-roleplay-host-'))
}

/**
 * 构造一个够用的宿主 ctx：systemPrompt/tools 记录注册，agent 作用域用
 * `scope.effect` 折叠成一个可单独调用的 disposer。
 */
function hostStub({ bus, home, presets = {}, sections = [], contexts = [], tools = [], commands = [], routes = [] }) {
  const ownerEffects = []
  const hostCtx = {
    logger: { info: () => undefined, warn: () => undefined },
    on: bus.on,
    get(name) {
      if (name === 'agentPresets') {
        return {
          composedPreset: (agentCtx) => presets[agentCtx?.tag],
        }
      }
      if (name === 'webServer') {
        return {
          register(route) {
            routes.push(route)
            return () => undefined
          },
        }
      }
      if (name === 'agents') return undefined
      return undefined
    },
    inject(names, callback) {
      // 只在需要的能力都在时才激活，模拟真实注入语义。
      const available = names.some((name) => name === 'webServer' || name === 'commands' || name === 'agents')
      if (!available) return undefined
      const scoped = {
        ...hostCtx,
        webServer: hostCtx.get('webServer'),
        commands: {
          register(definition) {
            commands.push(definition)
            return () => undefined
          },
        },
        agents: { list: () => [] },
      }
      return callback(scoped)
    },
    effect(factory) {
      const dispose = factory()
      ownerEffects.push(dispose)
      return () => undefined
    },
    systemPrompt: {
      getSectionOrder: () => 0,
      getContextOrder: () => 100,
      section(section) {
        sections.push(section)
        return () => undefined
      },
      context(context) {
        contexts.push(context)
        return () => undefined
      },
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => undefined
      },
    },
  }
  return { hostCtx, ownerEffects }
}

/** Build an agent whose ctx records prompt/tool registrations in the given arrays. */
function agentStub(id, presetId, presets, scoped) {
  const agentCtx = { tag: id }
  const registrations = { sections: [], contexts: [], tools: [], effects: 0 }
  agentCtx.effect = (factory, label) => {
    registrations.effects += 1
    const dispose = factory()
    registrations[label ?? 'effect'] = dispose
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }
  agentCtx.systemPrompt = {
    section: (section) => {
      registrations.sections.push(section)
      return () => undefined
    },
    context: (context) => {
      registrations.contexts.push(context)
      return () => undefined
    },
  }
  agentCtx.tools = {
    register: (definition) => {
      registrations.tools.push(definition)
      return () => undefined
    },
  }
  presets[id] = presetId
  return {
    agent: { id, ctx: agentCtx, session: { header: { id, agentPreset: presetId } } },
    registrations,
  }
}

test('a roleplay session gets its persona section, memory context and the memory tool', async () => {
  const home = tempHome()
  const bus = eventBus()
  const sections = []
  const contexts = []
  const tools = []
  const presets = {}
  const { hostCtx } = hostStub({ bus, home, presets, sections, contexts, tools })
  try {
    apply(hostCtx, { home })
    const { agent, registrations } = agentStub('session-hero', PRESET_ID, presets, hostCtx)

    // Seed one saved profile so rendering has content.
    bus.emit('agent/created', { agent, source: 'startup' })
    assert.equal(registrations.sections.length, 1, 'exactly one persona section')
    assert.equal(registrations.contexts.length, 1, 'exactly one memory context')
    assert.equal(registrations.tools.length, 1, 'exactly one model-facing tool')

    const section = registrations.sections[0]
    assert.equal(section.name, 'roleplay:persona')
    assert.equal(section.interpolate, false, 'prompt.js does its own {{...}} substitution')
    assert.equal(typeof section.text, 'function', 'text must be a thunk so edits apply without a restart')

    const context = registrations.contexts[0]
    assert.equal(context.name, 'roleplay:memory')
    assert.equal(context.interpolate, false)

    assert.equal(registrations.tools[0].name, 'roleplay_memory')
    assert.deepEqual(registrations.tools[0].parameters.required, ['action'])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a standard session gets nothing at all', async () => {
  const home = tempHome()
  const bus = eventBus()
  const presets = {}
  const { hostCtx } = hostStub({ bus, home, presets })
  try {
    apply(hostCtx, { home })
    const { agent, registrations } = agentStub('session-plain', 'standard', presets, hostCtx)
    bus.emit('agent/created', { agent, source: 'startup' })
    assert.equal(registrations.effects, 0, 'no agent-scoped effect may be registered')
    assert.deepEqual(registrations.sections, [])
    assert.deepEqual(registrations.contexts, [])
    assert.deepEqual(registrations.tools, [])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('the section thunk reflects the file on disk, so sidebar edits reach the next request', async () => {
  const home = tempHome()
  const bus = eventBus()
  const presets = {}
  const { hostCtx } = hostStub({ bus, home, presets })
  try {
    apply(hostCtx, { home })
    const { agent, registrations } = agentStub('session-live', PRESET_ID, presets, hostCtx)
    bus.emit('agent/created', { agent, source: 'startup' })
    const section = registrations.sections[0]
    const context = registrations.contexts[0]

    // Nothing saved yet → the setup-guidance text, and no memory context.
    assert.match(section.text(), /还没有设定角色/)
    assert.equal(context.text(), '')

    // Save a profile the way the sidebar does (same JSON shape, same directory).
    const file = path.join(home, 'roleplay', 'sessions', 'session-live.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sessionId: 'session-live',
        title: '',
        updatedAt: Date.now(),
        record: {
          profile: { name: '沈青梧', role: '剑客', personality: '寡言', scenario: '山雨', speechStyle: '短句' },
          memories: [{ id: 'mem-1', kind: 'fact', text: '怕水', pinned: true, createdAt: 1 }],
        },
      }),
      'utf8',
    )

    const after = section.text()
    assert.match(after, /沈青梧/, 'the same live agent must see the new profile')
    assert.ok(!after.includes('{{name}}'), 'placeholders are gone')
    assert.match(context.text(), /怕水/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('agent/disposed releases the per-agent registrations', async () => {
  const home = tempHome()
  const bus = eventBus()
  const presets = {}
  const { hostCtx } = hostStub({ bus, home, presets })
  try {
    apply(hostCtx, { home })
    const { agent, registrations } = agentStub('session-gone', PRESET_ID, presets, hostCtx)
    bus.emit('agent/created', { agent, source: 'startup' })
    assert.equal(registrations.sections.length, 1)
    assert.doesNotThrow(() => bus.emit('agent/disposed', { agent }))
    // Re-announcing the same id must attach again rather than stay detached.
    const again = agentStub('session-gone', PRESET_ID, presets, hostCtx)
    bus.emit('agent/created', { agent: again.agent, source: 'resume' })
    assert.equal(again.registrations.sections.length, 1)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('the HTTP surface is mounted and answers state/sessions/preview', async () => {
  const home = tempHome()
  const bus = eventBus()
  const routes = []
  const presets = {}
  const { hostCtx } = hostStub({ bus, home, presets, routes })
  try {
    apply(hostCtx, { home })
    const route = routes.find((row) => row.path === '/api/roleplay')
    assert.ok(route !== undefined, 'the prefix route must be registered')
    assert.equal(route.kind, 'prefix')

    /** Minimal request/response pair; resolves with the parsed JSON body. */
    const call = (method, url, body) =>
      new Promise((resolve, reject) => {
        const req = {
          method,
          url,
          on(event, handler) {
            if (event === 'data' && body !== undefined) handler(Buffer.from(JSON.stringify(body)))
            if (event === 'end') handler()
            return req
          },
        }
        const chunks = []
        const res = {
          writeHead(status, headers) {
            this.status = status
            this.headers = headers
          },
          end(payload) {
            if (payload !== undefined) chunks.push(payload)
            try {
              resolve({ status: this.status, body: JSON.parse(Buffer.concat(chunks.map(Buffer.from)).toString('utf8')) })
            } catch (error) {
              reject(error)
            }
          },
        }
        route.handler(req, res)
      })

    const empty = await call('GET', '/api/roleplay/state?session=session-x')
    assert.equal(empty.status, 200)
    assert.equal(empty.body.ok, true)
    assert.equal(empty.body.exists, false, 'an unknown session starts empty')
    assert.equal(empty.body.record.profile.name, '')

    const missing = await call('GET', '/api/roleplay/state')
    assert.equal(missing.body.ok, false)
    assert.equal(missing.body.error, 'missing-session')

    const saved = await call('POST', '/api/roleplay/save', {
      sessionId: 'session-x',
      record: { profile: { name: '阿岚' }, memories: [{ kind: 'event', text: '在渡口遇见你' }] },
    })
    assert.equal(saved.body.ok, true)
    assert.equal(saved.body.record.profile.name, '阿岚')
    assert.match(saved.body.preview.text, /阿岚/)
    assert.match(saved.body.preview.contextText, /渡口/)

    const reread = await call('GET', '/api/roleplay/state?session=session-x')
    assert.equal(reread.body.record.memories.length, 1)

    const preview = await call('GET', '/api/roleplay/preview?session=session-x')
    assert.equal(preview.body.ok, true)
    assert.equal(preview.body.sectionText, renderPersonaSection(reread.body.record))
    assert.equal(preview.body.contextText, renderMemoryContext(reread.body.record))

    const list = await call('GET', '/api/roleplay/sessions')
    assert.equal(list.body.sessions.length, 1)
    assert.equal(list.body.sessions[0].name, '阿岚')

    const deleted = await call('POST', '/api/roleplay/delete', { sessionId: 'session-x' })
    assert.equal(deleted.body.deleted, true)
    const afterDelete = await call('GET', '/api/roleplay/sessions')
    assert.equal(afterDelete.body.sessions.length, 0)

    const notFound = await call('GET', '/api/roleplay/nope')
    assert.equal(notFound.status, 404)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('the /roleplay command reports mode without claiming it can switch presets', async () => {
  const home = tempHome()
  const bus = eventBus()
  const commands = []
  const presets = {}
  const { hostCtx } = hostStub({ bus, home, presets, commands })
  try {
    apply(hostCtx, { home })
    const command = commands.find((row) => row.name === 'roleplay')
    assert.ok(command !== undefined)

    const plain = agentStub('session-cmd-plain', 'standard', presets, hostCtx)
    const statusPlain = command.handler({ agent: plain.agent, rawInput: '' })
    assert.equal(statusPlain.kind, 'success')
    assert.match(statusPlain.text, /不是角色扮演模式/)

    const hero = agentStub('session-cmd-hero', PRESET_ID, presets, hostCtx)
    const statusHero = command.handler({ agent: hero.agent, rawInput: 'status' })
    assert.equal(statusHero.kind, 'success')
    assert.match(statusHero.text, /角色扮演模式/)

    const onOutcome = command.handler({ agent: hero.agent, rawInput: 'on' })
    assert.match(onOutcome.text, /预设/, 'on/off must explain the preset owns the mode, not pretend to toggle')

    const bad = command.handler({ agent: hero.agent, rawInput: 'wat' })
    assert.equal(bad.kind, 'error')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('downgrading the memory tool config still keeps the prompt injection', async () => {
  const home = tempHome()
  const bus = eventBus()
  const presets = {}
  const { hostCtx } = hostStub({ bus, home, presets })
  try {
    apply(hostCtx, { home, enableTool: false })
    const { agent, registrations } = agentStub('session-notool', PRESET_ID, presets, hostCtx)
    bus.emit('agent/created', { agent, source: 'startup' })
    assert.equal(registrations.sections.length, 1, 'prompt injection is independent of the tool switch')
    assert.equal(registrations.contexts.length, 1)
    assert.equal(registrations.tools.length, 0)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
