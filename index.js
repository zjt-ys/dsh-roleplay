/**
 * dsh-roleplay — HOST half.
 *
 * 一个「角色扮演模式」会话需要三样东西，且都必须**按会话隔离**：
 *
 *   1. 人设（profile）     —— 谁是角色、身份、性格、场景、说话风格
 *   2. 长期记忆（memories）—— 角色记得的事实/事件/关系/偏好
 *   3. 提示词（prompt）    —— 模板、附加要求、扮演规则开关
 *
 * 这些数据由本插件按 `sessionId` 存在 `$DSH_HOME/roleplay/sessions/` 下，
 * 由侧边栏面板（浏览器半）编辑，由这里注入到该会话的 system prompt：
 *
 *   - 人设 + 规则 + 附加要求 → 一个 prompt **section**（`roleplay:persona`）
 *   - 长期记忆             → 一个 prompt **context**（`roleplay:memory`）
 *
 * 两者都注册在 `agent.ctx` 上，因此只对那个 Agent 生效，Agent 销毁即撤销；
 * 并不会污染其它会话。
 *
 * **只有「角色扮演模式」的会话才会注入。**「角色扮演模式」是一个 agent
 * preset（`roleplay`），在本 bundle 的 cordis.patch.yml 里声明；本插件在
 * `agent/created` 时读该会话的 preset，命中才注册提示词与工具。普通会话里
 * 插件什么都不做，只是侧边栏面板会提示“当前会话不是角色扮演会话”。
 *
 * 另外给模型一个 `roleplay_memory` 工具，让它在对话中自己记住新事实——
 * 与侧边栏编辑的是同一份数据（一个操作两种调用者）。
 */
import path from 'node:path'
import {
  MEMORY_KINDS,
  RECORD_VERSION,
  isBlankRecord,
  newMemoryId,
  normalizeMemories,
  normalizeRecord,
  renderMemoryContext,
  renderPersonaSection,
  renderPreview,
} from './prompt.js'
import { DATA_DIR_NAME, RoleplayStore, resolveDshHome } from './store.js'

/** Stable Loader identity. */
export const name = 'dsh-roleplay'

/** Agent preset id that turns this plugin on for one session. */
export const PRESET_ID = 'roleplay'

/** Prompt section / context names; namespaced so they cannot collide. */
const PERSONA_SECTION = 'roleplay:persona'
const MEMORY_CONTEXT = 'roleplay:memory'

/** Model-facing tool name. */
const TOOL_NAME = 'roleplay_memory'

/** Slash command that switches the current session into character-play mode. */
const COMMAND_NAME = 'roleplay'

/** Services the host half needs. `webServer`/`agents`/`agentPresets` are optional. */
export const inject = ['systemPrompt', 'tools']

/**
 * 判断一个 Agent 是否运行在角色扮演模式。
 *
 * 三级回退，任一级命中即可：
 *   1. 组合层给出的 preset 身份（`agentPresets.composedPreset(agent.ctx)`）；
 *   2. 会话头里记录的 preset；
 *   3. 会话 projection 里记录的 `agentPreset` 键。
 *
 * @param {object} ctx - plugin context.
 * @param {object} agent - the agent to classify.
 * @returns {boolean} whether this agent is a character-play session.
 */
function isRoleplayAgent(ctx, agent) {
  try {
    const registry = ctx.get('agentPresets')
    if (registry !== undefined && typeof registry.composedPreset === 'function') {
      if (registry.composedPreset(agent.ctx) === PRESET_ID) return true
    }
  } catch {
    // Ignore; fall through to the durable records.
  }
  try {
    const header = agent.session?.header
    if (header !== undefined && header.agentPreset === PRESET_ID) return true
  } catch {
    // Ignore.
  }
  try {
    const projections = ctx.get('sessionProjections')
    if (projections !== undefined && agent.session !== undefined) {
      if (projections.stateOf(agent.session, 'agentPreset') === PRESET_ID) return true
    }
  } catch {
    // Ignore.
  }
  return false
}

/**
 * 读一个会话的显示标题，尽力而为（拿不到就空串）。
 * @param {object} ctx - plugin context.
 * @param {string} sessionId - session id.
 * @returns {string} the durable title, or ''.
 */
function sessionTitleOf(ctx, sessionId) {
  try {
    const projections = ctx.get('sessionProjections')
    const sessions = ctx.get('sessions')
    const session = sessions?.get?.(sessionId)
    if (projections !== undefined && session !== undefined) {
      const title = projections.stateOf(session, 'title')
      if (typeof title === 'string' && title !== '') return title
    }
  } catch {
    // Ignore.
  }
  return ''
}

/** Write one JSON response. */
function sendJson(res, status, value) {
  const payload = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Collect a JSON request body, refusing anything oversized. */
function readJsonBody(req, limit = 512 * 1024) {
  return new Promise((settle, fail) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        fail(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        settle(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        fail(error)
      }
    })
    req.on('error', fail)
  })
}

/**
 * Config 有意不导出 `Config`：本包不依赖 `@deepseek-ai/schemastery`，而宿主
 * 对带 `Config` 导出的插件会走 `Config['~standard'].validate()`。这里在
 * {@link apply} 里手工校验两个可选字段，缺省值就是文档里的默认值。
 *
 *   - `home`        覆盖数据根目录，留空用 `$DSH_HOME/roleplay`
 *   - `enableTool`  是否给角色扮演会话提供 `roleplay_memory` 工具（默认 true）
 */

/**
 * Host half of the plugin.
 * @param {object} ctx - plugin context.
 * @param {object} config - plugin config.
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const home = typeof config.home === 'string' && config.home.trim() !== '' ? config.home.trim() : resolveDshHome()
  const store = new RoleplayStore(home)
  const enableTool = config.enableTool !== false

  /** agent → disposer of the per-agent prompt + tool registrations. */
  const perAgent = new Map()

  /**
   * Read the record a session should be rendered from.
   * @param {string} sessionId - session id.
   * @returns the normalized record, or undefined when this session has none.
   */
  const recordOf = (sessionId) => store.recordOf(sessionId)

  /**
   * Register the per-agent prompt contributions and the memory tool.
   * @param {object} agent - the agent that was just created.
   */
  const attachAgent = (agent) => {
    const sessionId = agent.id
    if (!isRoleplayAgent(ctx, agent)) return
    const scope = agent.ctx
    const disposer = scope.effect(() => {
      const disposers = []
      const personaOrder = (() => {
        try {
          return ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1
        } catch {
          return 1
        }
      })()
      const contextOrder = (() => {
        // 放在工作目录等既有运行时事实之后，让角色设定读起来更自然。
        try {
          return ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY') + 50
        } catch {
          return 150
        }
      })()

      disposers.push(
        scope.systemPrompt.section({
          name: PERSONA_SECTION,
          order: personaOrder,
          interpolate: false,
          // 会话里还没有档案时也要有一段：告诉模型这是角色扮演会话、先问清
          // 角色再说话。否则用户新建会话后不打开侧边栏，模型完全不知道设定。
          text: () => renderPersonaSection(recordOf(sessionId) ?? normalizeRecord(undefined)),
        }),
      )
      disposers.push(
        scope.systemPrompt.context({
          name: MEMORY_CONTEXT,
          order: contextOrder,
          interpolate: false,
          text: () => {
            const record = recordOf(sessionId)
            return record === undefined ? '' : renderMemoryContext(record)
          },
        }),
      )

      if (enableTool) {
        disposers.push(
          scope.tools.register({
            name: TOOL_NAME,
            description:
              '记录或读取当前角色扮演会话的长期记忆（与侧边栏「记忆」页签同一份数据）。' +
              '当用户告诉你需要长期记住的事实、事件、人物关系或偏好时，用 remember 主动记下来；' +
              '需要回忆之前的事时用 recall 检索。记忆会自动出现在你的系统提示里。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                action: {
                  type: 'string',
                  enum: ['remember', 'recall', 'forget'],
                  description: 'remember 新增/更新一条记忆；recall 读取当前记忆；forget 按 id 删除。',
                },
                kind: {
                  type: 'string',
                  enum: MEMORY_KINDS,
                  description: '记忆分类，remember 时使用，默认 fact。',
                },
                text: {
                  type: 'string',
                  description: '记忆内容，一句话说清；remember 时必填。',
                },
                pinned: {
                  type: 'boolean',
                  description: '是否置顶为“重要记忆”，remember 时可选。',
                },
                id: {
                  type: 'string',
                  description: '要删除的记忆 id，forget 时必填。',
                },
              },
              required: ['action'],
            },
            output: {
              schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  ok: { type: 'boolean', description: 'False when the request was refused.' },
                  message: { type: 'string', description: 'Human-readable result.' },
                },
                required: ['ok', 'message'],
              },
              render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
            },
            execute: async (args) => {
              const loaded = store.read(sessionId, sessionTitleOf(ctx, sessionId))
              const record = loaded.record
              const action = typeof args?.action === 'string' ? args.action : 'recall'
              if (action === 'recall') {
                const lines = record.memories.map((memory) => `${memory.id} [${memory.kind}]${memory.pinned ? '[pin]' : ''} ${memory.text}`)
                return {
                  ok: true,
                  message:
                    record.memories.length === 0
                      ? '当前还没有记忆。'
                      : `当前共 ${record.memories.length} 条记忆：\n${lines.join('\n')}`,
                }
              }
              if (action === 'forget') {
                const id = typeof args?.id === 'string' ? args.id : ''
                const next = record.memories.filter((memory) => memory.id !== id)
                if (next.length === record.memories.length) return { ok: false, message: `没有 id 为 ${id} 的记忆。` }
                const written = store.write(sessionId, { ...record, memories: next }, sessionTitleOf(ctx, sessionId))
                return written.ok
                  ? { ok: true, message: `已删除记忆 ${id}，剩余 ${next.length} 条。` }
                  : { ok: false, message: `删除失败：${written.error}` }
              }
              if (action !== 'remember') return { ok: false, message: `未知操作 ${action}。` }
              const body = typeof args?.text === 'string' ? args.text.trim() : ''
              if (body === '') return { ok: false, message: 'remember 需要 text。' }
              const kind = MEMORY_KINDS.includes(args?.kind) ? args.kind : 'fact'
              const memories = normalizeMemories([
                ...record.memories,
                {
                  id: newMemoryId(),
                  kind,
                  text: body,
                  pinned: args?.pinned === true,
                  createdAt: Date.now(),
                },
              ])
              const written = store.write(sessionId, { ...record, memories }, sessionTitleOf(ctx, sessionId))
              if (!written.ok) return { ok: false, message: `记忆写入失败：${written.error}` }
              // 模型自己记了新东西：立即推一张刷新卡，让本回合之后的工作上下文
              // 也带上新记忆（记忆 context 每步重算，但卡片能显式确认这次写入）。
              autoInjectAfterSave(sessionId, written.value.record, 'memory-tool')
              return { ok: true, message: `已记住（${kind}）：${body}。当前共 ${memories.length} 条记忆。` }
            },
          }),
        )
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // A registration already unwound with the agent scope is not an error.
          }
        }
      }
    }, 'dsh-roleplay: per-agent contributions')

    perAgent.set(agent, disposer)
  }

  /** Detach one agent's contributions. */
  const detachAgent = (agent) => {
    const disposer = perAgent.get(agent)
    if (disposer === undefined) return
    perAgent.delete(agent)
    try {
      disposer()
    } catch {
      // The agent scope may already be unwinding.
    }
  }

  ctx.effect(
    () => {
      const stop = ctx.on('agent/created', ({ agent }) => {
        try {
          attachAgent(agent)
        } catch (error) {
          logger.warn?.(`dsh-roleplay: could not attach ${agent.id}: ${String(error)}`)
        }
      })
      const stopDisposed = ctx.on('agent/disposed', ({ agent }) => detachAgent(agent))
      return () => {
        stop()
        stopDisposed()
        for (const agent of [...perAgent.keys()]) detachAgent(agent)
      }
    },
    'dsh-roleplay: agent lifecycle',
  )

  // Adopt agents that were already live when this plugin loaded.
  ctx.inject(['agents'], (scoped) => {
    try {
      for (const agent of scoped.agents.list()) {
        try {
          attachAgent(agent)
        } catch (error) {
          logger.warn?.(`dsh-roleplay: could not adopt ${agent.id}: ${String(error)}`)
        }
      }
    } catch {
      // No live agents to adopt.
    }
  })

  /** Build the state payload the sidebar renders. */
  const statePayload = (sessionId) => {
    const title = sessionTitleOf(ctx, sessionId)
    const loaded = store.read(sessionId, title)
    const roleplay = isRoleplaySession(ctx, sessionId)
    return {
      ok: true,
      sessionId,
      title: loaded.title || title,
      exists: loaded.exists,
      roleplay,
      record: loaded.record,
      preview: renderPreview(loaded.record),
      kinds: MEMORY_KINDS.map((kind) => ({ id: kind })),
      version: RECORD_VERSION,
    }
  }

  /**
   * 把一份「重新注入」卡片塞进会话的下一步。
   *
   * 时机语义：
   *   - agent 正在跑 → `inject()`（next-step）：卡片贴在当前步之后立即被消费；
   *   - agent 空闲   → `followup()`（next-turn）：卡片在下一条用户消息前被消费，
   *     不会平白唤醒一次模型请求。
   *
   * 卡片是 user 角色、`[system note]` 前缀：它是**给模型的指令**，不是用户的
   * 话。改动人设/记忆后注入这一段，模型下一轮就按新人设说话——即使人设已经
   * 在 system prompt 里，这一条也保证「中途换角色」立刻可感，而不是等 compaction
   * 或会话重启。
   *
   * @param {object} agent - the live roleplay agent.
   * @param {object} record - the freshly saved record.
   * @param {string} reason - why this injection happened (sidebar-save | manual | memory-tool).
   * @returns {{ok: boolean, mode?: string, error?: string}}
   */
  const injectRefreshCard = (agent, record, reason) => {
    if (agent === undefined || agent === null) return { ok: false, error: 'agent-not-live' }
    const send = typeof agent.followup === 'function' && typeof agent.inject === 'function' ? undefined : 'unsupported'
    if (send !== undefined) return { ok: false, error: send }
    const profile = record?.profile ?? {}
    const name = String(profile.name ?? '').trim()
    const lines = [
      '[system note] 角色扮演设定已更新，立即生效：',
      `- 本次更新来源：${reason === 'manual' ? '用户手动重新注入' : reason === 'memory-tool' ? '对话中更新了长期记忆' : '侧边栏保存'}`,
      name !== '' ? `- 角色名：${name}` : '- 角色名：（未设定）',
      String(profile.role ?? '').trim() !== '' ? `- 身份定位：${profile.role}` : '- 身份定位：（未设定）',
      '- 请从下一句回复开始完全按更新后的角色设定、语气与记忆说话；与之前不一致的旧设定一律作废。',
      '- 不需要向用户复述这份设定，也不要解释"设定已更新"；直接以角色身份继续。',
    ]
    const message = {
      role: 'user',
      content: [{ type: 'text', text: lines.join('\n') }],
      // v4 消息来源规范：kind 直接标识生产者，字面值 "plugin" 会被
      // dsh-session-format-v3-to-v4 的准入校验拒绝（SessionFormatError）。
      // 未注册的插件名按官方迁移规则加 `plugin:` 前缀。
      source: { kind: 'plugin:dsh-roleplay', reason },
    }
    try {
      if (agent.status === 'running') {
        agent.inject(message)
        return { ok: true, mode: 'next-step' }
      }
      agent.followup(message)
      return { ok: true, mode: 'next-turn' }
    } catch (error) {
      return { ok: false, error: `inject-failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** 保存后对 live 的角色扮演 agent 自动补一张刷新卡（吞错，绝不影响保存本身）。 */
  const autoInjectAfterSave = (sessionId, record, reason) => {
    try {
      if (!isRoleplaySession(ctx, sessionId)) return
      const agent = ctx.get('agents')?.get?.(sessionId)
      if (agent === undefined) return
      const outcome = injectRefreshCard(agent, record, reason)
      if (!outcome.ok) logger.info?.(`dsh-roleplay: refresh card skipped for ${sessionId}: ${outcome.error}`)
    } catch (error) {
      logger.warn?.(`dsh-roleplay: auto inject failed for ${sessionId}: ${String(error)}`)
    }
  }

  /** Whether an existing session runs in character-play mode. */
  function isRoleplaySession(ctxRef, sessionId) {
    try {
      const agents = ctxRef.get('agents')
      const agent = agents?.get?.(sessionId)
      if (agent !== undefined) return isRoleplayAgent(ctxRef, agent)
    } catch {
      // Fall through.
    }
    try {
      const projections = ctxRef.get('sessionProjections')
      const sessions = ctxRef.get('sessions')
      const session = sessions?.get?.(sessionId)
      if (projections !== undefined && session !== undefined) {
        return projections.stateOf(session, 'agentPreset') === PRESET_ID
      }
    } catch {
      // Fall through.
    }
    const loaded = store.read(sessionId)
    return loaded.exists && !isBlankRecord(loaded.record)
  }

  /** The sessions endpoint: store index joined with live titles. */
  const sessionsPayload = () => {
    const rows = store.list().map((row) => ({
      sessionId: row.sessionId,
      title: row.title || sessionTitleOf(ctx, row.sessionId) || '',
      name: row.name,
      updatedAt: row.updatedAt,
      roleplay: isRoleplaySession(ctx, row.sessionId),
    }))
    return { ok: true, sessions: rows }
  }

  // ── HTTP surface for the sidebar panel ────────────────────────────────────
  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer
    scoped.effect(
      () =>
        server.register({
          kind: 'prefix',
          path: '/api/roleplay',
          handler: async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const route = url.pathname.replace(/^\/api\/roleplay/u, '').replace(/\/+$/u, '') || '/'
            const method = String(req.method ?? 'GET').toUpperCase()
            const sessionParam = url.searchParams.get('session') ?? ''
            try {
              if (method === 'GET' && (route === '/' || route === '/state')) {
                if (sessionParam === '') return sendJson(res, 200, { ok: false, error: 'missing-session' })
                return sendJson(res, 200, statePayload(sessionParam))
              }
              if (method === 'GET' && route === '/sessions') {
                return sendJson(res, 200, sessionsPayload())
              }
              if (method === 'GET' && route === '/preview') {
                if (sessionParam === '') return sendJson(res, 200, { ok: false, error: 'missing-session' })
                const loaded = store.read(sessionParam, sessionTitleOf(ctx, sessionParam))
                return sendJson(res, 200, { ok: true, ...renderPreview(loaded.record) })
              }
              if (method === 'POST' && route === '/save') {
                const body = await readJsonBody(req)
                const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
                if (sessionId === '') return sendJson(res, 200, { ok: false, error: 'missing-session' })
                const written = store.write(sessionId, body?.record ?? body, sessionTitleOf(ctx, sessionId))
                if (!written.ok) return sendJson(res, 200, { ok: false, error: written.error })
                // 改动人设/记忆/提示词后自动重新注入：模型下一轮就按新设定说话。
                autoInjectAfterSave(sessionId, written.value.record, 'sidebar-save')
                const payload = statePayload(sessionId)
                return sendJson(res, 200, { ok: true, ...payload })
              }
              if (method === 'POST' && route === '/reinject') {
                // 手动重新注入：不落盘，只把当前档案作为刷新卡塞给模型。
                const body = await readJsonBody(req)
                const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
                if (sessionId === '') return sendJson(res, 200, { ok: false, error: 'missing-session' })
                try {
                  const agent = ctx.get('agents')?.get?.(sessionId)
                  if (agent === undefined) return sendJson(res, 200, { ok: false, error: 'agent-not-live', message: '该会话当前没有活跃的对话进程，发一条消息后再试。' })
                  if (isRoleplaySession(ctx, sessionId) !== true) {
                    return sendJson(res, 200, { ok: false, error: 'not-roleplay', message: '只有角色扮演会话支持重新注入。' })
                  }
                  const loaded = store.read(sessionId, sessionTitleOf(ctx, sessionId))
                  const outcome = injectRefreshCard(agent, loaded.record, 'manual')
                  return sendJson(res, 200, { ok: outcome.ok, ...outcome, message: outcome.ok ? `已重新注入（${outcome.mode === 'next-step' ? '当前回合下一步生效' : '下一次回复生效'}）` : outcome.error })
                } catch (error) {
                  return sendJson(res, 200, { ok: false, error: 'reinject-failed', message: String(error instanceof Error ? error.message : error) })
                }
              }
              if (method === 'POST' && route === '/delete') {
                const body = await readJsonBody(req)
                const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
                if (sessionId === '') return sendJson(res, 200, { ok: false, error: 'missing-session' })
                const removed = store.remove(sessionId)
                return sendJson(res, 200, removed)
              }
              return sendJson(res, 404, { ok: false, error: 'not-found' })
            } catch (error) {
              return sendJson(res, 500, {
                ok: false,
                error: 'internal',
                message: error instanceof Error ? error.message : String(error),
              })
            }
          },
        }),
      'dsh-roleplay: api routes',
    )
    logger.info?.(`dsh-roleplay: data at ${path.join(home, DATA_DIR_NAME)}`)
  })

  // ── slash command: switch the current session into character play ─────────
  ctx.inject(['commands'], (scoped) => {
    scoped.effect(
      () =>
        scoped.commands.register({
          name: COMMAND_NAME,
          description: '查看或切换当前会话的角色扮演设置（人设由侧边栏面板编辑）。',
          input: {
            hint: '[status|on|off|list]',
          },
          handler: ({ agent, rawInput }) => {
            const arg = String(rawInput ?? '').trim().toLowerCase()
            if (arg === '' || arg === 'status') {
              const roleplay = agent === undefined ? false : isRoleplayAgent(ctx, agent)
              const loaded = agent === undefined ? undefined : store.read(agent.id)
              const name = loaded?.record?.profile?.name ?? ''
              return {
                kind: 'success',
                text: roleplay
                  ? `当前会话是角色扮演模式${name === '' ? '（还没有设定角色）' : `，角色：${name}`}；人设/记忆/提示词在侧边栏「角色扮演」面板里管理。`
                  : '当前会话不是角色扮演模式。用「新建角色扮演会话」或在新建对话时选择「角色扮演」预设。',
              }
            }
            if (arg === 'list') {
              const rows = store.list()
              if (rows.length === 0) return { kind: 'success', text: '还没有任何角色扮演会话。' }
              return {
                kind: 'success',
                text: rows
                  .map((row) => `- ${row.name || '(未命名)'} · ${row.title || row.sessionId} · ${row.sessionId}`)
                  .join('\n'),
              }
            }
            if (arg === 'on' || arg === 'off') {
              return {
                kind: 'success',
                text:
                  arg === 'on'
                    ? '角色扮演模式由会话创建时的预设决定：请新建对话并选择「角色扮演」，或在侧边栏面板点「新建角色扮演会话」。'
                    : '要退出角色扮演，请新建一个普通对话；本会话的记忆会保留在侧边栏里，删掉档案即可清除。',
              }
            }
            return { kind: 'error', text: `未知参数 "${arg}"，可用：status / list / on / off。` }
          },
        }),
      'dsh-roleplay: /roleplay command',
    )
  })
}
