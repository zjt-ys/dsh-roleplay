/**
 * 「改动人设后重新注入」的回归测试。
 *
 * 覆盖三件事：
 *   1. injectRefreshCard 的时机语义 —— running → next-step（inject），空闲 → next-turn（followup）；
 *   2. /save 之后自动推卡、/reinject 手动推卡、roleplay_memory remember 之后自动推卡；
 *   3. 非角色扮演会话 / 无活跃 agent 时不推、不报错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const HOST_URL = pathToFileURL(path.join(here, '..', 'index.js')).href

/** One fake live agent: records inject/followup calls. */
function fakeAgent({ running = false } = {}) {
  const calls = []
  return {
    calls,
    status: running ? 'running' : 'idle',
    id: 'session-fake',
    followup(message) {
      calls.push({ mode: 'next-turn', message })
    },
    inject(message) {
      calls.push({ mode: 'next-step', message })
    },
  }
}

/**
 * Minimal host ctx good enough for apply(): agents registry with our fake,
 * no webServer/commands (their ctx.inject branches degrade quietly).
 */
function makeCtx({ agent, roleplay = true } = {}) {
  const sections = []
  return {
    logger: { info: () => undefined, warn: () => undefined },
    on: () => () => undefined,
    effect(factory) {
      factory()
      return () => undefined
    },
    inject(_names, callback) {
      void callback
      return () => undefined
    },
    get(name) {
      if (name === 'agents') {
        return {
          list: () => (agent === undefined ? [] : [agent]),
          get: (id) => (agent !== undefined && id === agent.id ? agent : undefined),
        }
      }
      if (name === 'agentPresets') {
        return { composedPreset: (agentCtx) => (roleplay ? 'roleplay' : 'standard') }
      }
      if (name === 'sessionProjections') {
        return {
          stateOf: () => (roleplay ? 'roleplay' : 'standard'),
        }
      }
      return undefined
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => undefined
      },
      context(context) {
        sections.push(context)
        return () => undefined
      },
      getSectionOrder: () => 0,
      getContextOrder: () => 100,
    },
    tools: {
      get: () => undefined,
      schemas: () => [],
      register: () => () => undefined,
    },
    commands: { register: () => () => undefined },
  }
}

async function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'roleplay-reinject-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await run(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
}

/** Pull the /api/roleplay prefix route out of apply's webServer branch. */
function makeWebCtx(ctxRef, routes) {
  ctxRef.inject = (names, callback) => {
    if (!names.includes('webServer')) return () => undefined
    const scoped = {
      ...ctxRef,
      webServer: {
        register(route) {
          routes.push(route)
          return () => undefined
        },
      },
    }
    return callback(scoped)
  }
  return ctxRef
}

const RECORD = {
  profile: { name: '沈青梧', role: '剑客', personality: '寡言', scenario: '山雨', speechStyle: '短句' },
  memories: [{ id: 'mem-1', kind: 'fact', text: '怕水', pinned: true, createdAt: 1 }],
}

test('injectRefreshCard: running agent → next-step; idle agent → next-turn', async () => {
  await withHome(async (home) => {
    const { apply } = await import(HOST_URL)
    const running = fakeAgent({ running: true })
    const idle = fakeAgent({ running: false })
    // apply 只在 attach 时用 agent；这里直接构造两个并触发 adopt。
    for (const [agent, expected] of [[running, 'next-step'], [idle, 'next-turn']]) {
      const routes = []
      const ctx = makeWebCtx(makeCtx({ agent }), routes)
      apply(ctx, { home })
      // 通过 /save 触发自动注入。
      const route = routes.find((row) => row.path === '/api/roleplay')
      const outcome = await postJson(route.handler, '/api/roleplay/save', { sessionId: agent.id, record: RECORD })
      assert.equal(outcome.ok, true, JSON.stringify(outcome).slice(0, 200))
      assert.equal(agent.calls.length, 1, 'exactly one refresh card per save')
      assert.equal(agent.calls[0].mode, expected, `running→next-step, idle→next-turn (got ${agent.calls[0].mode})`)
      const text = agent.calls[0].message.content[0].text
      assert.match(text, /\[system note\]/, 'the card is a system note, not a user sentence')
      assert.match(text, /沈青梧/)
      assert.match(text, /剑客/)
      assert.match(text, /不需要向用户复述/, 'the card must forbid meta narration')
    }
  })
})

test('/reinject pushes a card without saving and reports the mode', async () => {
  await withHome(async (home) => {
    const { apply } = await import(HOST_URL)
    const agent = fakeAgent({ running: false })
    const routes = []
    const ctx = makeWebCtx(makeCtx({ agent }), routes)
    apply(ctx, { home })
    const route = routes.find((row) => row.path === '/api/roleplay')
    // 先落一份档案（直接写盘，绕过 /save 以证明 /reinject 本身不依赖保存动作）。
    const file = path.join(home, 'roleplay', 'sessions', 'session-fake.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, sessionId: 'session-fake', title: '', updatedAt: Date.now(), record: RECORD }),
      'utf8',
    )
    const before = agent.calls.length
    const outcome = await postJson(route.handler, '/api/roleplay/reinject', { sessionId: 'session-fake' })
    assert.equal(outcome.ok, true, JSON.stringify(outcome))
    assert.equal(outcome.mode, 'next-turn')
    assert.equal(agent.calls.length, before + 1)
    assert.match(agent.calls[0].message.content[0].text, /用户手动重新注入/)
  })
})

test('/reinject refuses politely when the agent is not live', async () => {
  await withHome(async (home) => {
    const { apply } = await import(HOST_URL)
    const routes = []
    const ctx = makeWebCtx(makeCtx({ agent: undefined }), routes)
    apply(ctx, { home })
    const route = routes.find((row) => row.path === '/api/roleplay')
    const outcome = await postJson(route.handler, '/api/roleplay/reinject', { sessionId: 'session-nobody' })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.error, 'agent-not-live')
    assert.match(outcome.message, /没有活跃/)
  })
})

test('the memory tool remember action also pushes a refresh card', async () => {
  await withHome(async (home) => {
    const { apply } = await import(HOST_URL)
    const agent = fakeAgent({ running: true })
    const sections = []
    const ctx = makeCtx({ agent })
    // 捕获 agent 作用域的 tools.register，拿到 roleplay_memory 的定义。
    const registered = []
    // adopt 分支：ctx.inject(['agents'], cb) 时回调要能拿到 agents 列表。
    ctx.inject = (names, callback) => {
      if (!names.includes('agents')) return () => undefined
      const scoped = { ...ctx, agents: { list: () => [agent] } }
      return callback(scoped)
    }
    // apply 里 attachAgent 用 agent.ctx；桩一个最小 agent.ctx（含 session 头，
    // isRoleplayAgent 的第二级判定走 header.agentPreset）。
    agent.session = { header: { id: agent.id, agentPreset: 'roleplay' } }
    agent.ctx = {
      effect(factory) {
        factory()
        return () => undefined
      },
      systemPrompt: {
        section: (s) => {
          sections.push(s)
          return () => undefined
        },
        context: (c) => {
          sections.push(c)
          return () => undefined
        },
      },
      tools: {
        register: (definition) => {
          registered.push(definition)
          return () => undefined
        },
      },
    }
    apply(ctx, { home })
    assert.equal(registered.length, 1, 'roleplay_memory must be registered')
    const memoryTool = registered[0]
    // 先落一份基础档案。
    const file = path.join(home, 'roleplay', 'sessions', 'session-fake.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, sessionId: 'session-fake', title: '', updatedAt: Date.now(), record: RECORD }),
      'utf8',
    )
    const before = agent.calls.length
    const outcome = await memoryTool.execute({ action: 'remember', kind: 'event', text: '雨夜救过你一次' })
    assert.equal(outcome.ok, true, outcome.message)
    assert.equal(agent.calls.length, before + 1, 'remember pushes exactly one card')
    assert.equal(agent.calls[0].mode, 'next-step', 'the tool runs inside a turn, so the card rides next-step')
    assert.match(agent.calls[0].message.content[0].text, /对话中更新了长期记忆/)
  })
})

test('a standard (non-roleplay) session never gets a card', async () => {
  await withHome(async (home) => {
    const { apply } = await import(HOST_URL)
    const agent = fakeAgent({ running: false })
    const routes = []
    const ctx = makeWebCtx(makeCtx({ agent, roleplay: false }), routes)
    apply(ctx, { home })
    const route = routes.find((row) => row.path === '/api/roleplay')
    const outcome = await postJson(route.handler, '/api/roleplay/save', { sessionId: agent.id, record: RECORD })
    assert.equal(outcome.ok, true, 'saving still works')
    assert.equal(agent.calls.length, 0, 'no card for a standard session')
    const rein = await postJson(route.handler, '/api/roleplay/reinject', { sessionId: agent.id })
    assert.equal(rein.ok, false)
    assert.equal(rein.error, 'not-roleplay')
  })
})

/** Minimal req/res pair against one prefix route handler. */
function postJson(handler, url, body) {
  return new Promise((resolve, reject) => {
    const req = {
      method: 'POST',
      url,
      on(event, cb) {
        if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
        if (event === 'end') cb()
        return req
      },
    }
    const chunks = []
    const res = {
      writeHead(status, headers) {
        this.status = status
      },
      end(payload) {
        if (payload !== undefined) chunks.push(payload)
        try {
          resolve(JSON.parse(Buffer.concat(chunks.map(Buffer.from)).toString('utf8')))
        } catch (error) {
          reject(error)
        }
      },
    }
    handler(req, res)
  })
}
