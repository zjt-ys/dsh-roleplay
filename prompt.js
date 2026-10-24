/**
 * dsh-roleplay — 纯函数层：把一条“角色档案”渲染成注入给模型的文本。
 *
 * 这一层不碰 Cordis、不读磁盘、不依赖 DOM，因此可以被 `node --test` 直接
 * 单测；宿主半（index.js）与浏览器半（client.js）都只消费这里定义的数据形状。
 *
 * 一条会话档案（record）的形状：
 *
 *   profile   { name, role, personality, scenario, speechStyle }
 *   prompt    { template, extra, rules: { inCharacter, metaForbidden, narrate,
 *               proactive }, includeMemories, memoryLimit }
 *   memories  [{ id, kind, text, pinned, createdAt }]
 *
 * 渲染分两段，宿主半分别注册成两种提示词贡献：
 *
 *   renderPersonaSection  → system prompt 的一个 section（角色 + 规则 + 附加要求）
 *   renderMemoryContext   → system prompt 的一个 runtime context（长期记忆）
 *
 * 记忆放进 runtime context 而不是 section：context 每一步都会重新求值并由
 * 框架负责增量投影，因此用户/模型在对话中途增删记忆能立刻生效，而不会让
 * system prompt 反复变化。
 */

/** 记忆条目允许的分类；顺序就是界面下拉的顺序。 */
export const MEMORY_KINDS = ['fact', 'event', 'relation', 'preference', 'scene']

/** 分类的默认中文标签；浏览器半用同一份文本，避免两处漂移。 */
export const MEMORY_KIND_LABELS = {
  fact: '事实',
  event: '事件',
  relation: '关系',
  preference: '偏好',
  scene: '场景',
}

/** 记录形状变化时自增；旧文件按缺省值补全，不做破坏性迁移。 */
export const RECORD_VERSION = 1

/** 单字段长度上限，防止一次粘贴把提示词撑爆。 */
export const FIELD_LIMITS = {
  name: 120,
  role: 400,
  personality: 2000,
  scenario: 2000,
  speechStyle: 800,
  template: 6000,
  extra: 4000,
  memoryText: 2000,
  memories: 200,
}

/**
 * 默认提示词模板。`{{xxx}}` 由 {@link fillTemplate} 直接替换，不经过提示词
 * 注册表的 `{{变量}}` 插值（宿主半注册的 section/context 都带
 * `interpolate: false`），因此模板里出现未知占位符也不会让一次请求失败。
 */
export const DEFAULT_TEMPLATE = `你现在处于「角色扮演模式」，是下面这个角色本人。请完全以该角色的身份、视角和语气说话，不要跳出角色解释自己在扮演。

【角色姓名】{{name}}
【身份定位】{{role}}
【性格特征】{{personality}}
【所处场景】{{scenario}}
【说话风格】{{speechStyle}}

【扮演规则】
{{rules}}`

/** 一条全新角色扮演会话在用户还没编辑时使用的档案。 */
export const DEFAULT_RECORD = Object.freeze({
  version: RECORD_VERSION,
  profile: Object.freeze({
    name: '',
    role: '',
    personality: '',
    scenario: '',
    speechStyle: '',
  }),
  prompt: Object.freeze({
    template: DEFAULT_TEMPLATE,
    extra: '',
    rules: Object.freeze({
      inCharacter: true,
      metaForbidden: true,
      narrate: true,
      proactive: false,
    }),
    includeMemories: true,
    memoryLimit: 40,
  }),
  memories: Object.freeze([]),
})

/** 每条开关对应的规则正文；顺序即渲染顺序。 */
const RULE_LINES = {
  inCharacter: '- 任何时候都以角色的第一人称说话；被问到设定外的问题时，用角色会有的方式回应。',
  metaForbidden: '- 不使用“作为AI/作为一个语言模型/这是一个角色扮演”这类元叙述，除非用户明确要求出戏。',
  narrate: '- 动作、神态、环境描写放在圆括号或独立段落里，与对话区分开。',
  proactive: '- 每次回复都顺手推进一点剧情，给用户可接的话头，而不是被动等待指令。',
}

/**
 * 把任意输入规整成一段安全字符串。
 * @param {unknown} value - 原始值。
 * @param {number} limit - 字符上限。
 * @returns {string} 去掉首尾空白并截断后的字符串。
 */
function text(value, limit) {
  if (typeof value !== 'string') return ''
  const trimmed = value.replace(/\r\n?/g, '\n').trim()
  return trimmed.length > limit ? trimmed.slice(0, limit) : trimmed
}

/**
 * 规整人设字段。
 * @param {unknown} input - 待规整对象。
 * @returns {{name: string, role: string, personality: string, scenario: string, speechStyle: string}}
 */
export function normalizeProfile(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  return {
    name: text(source.name, FIELD_LIMITS.name),
    role: text(source.role, FIELD_LIMITS.role),
    personality: text(source.personality, FIELD_LIMITS.personality),
    scenario: text(source.scenario, FIELD_LIMITS.scenario),
    speechStyle: text(source.speechStyle, FIELD_LIMITS.speechStyle),
  }
}

/**
 * 规整提示词设置。
 * @param {unknown} input - 待规整对象。
 * @returns the normalized prompt block.
 */
export function normalizePrompt(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const rules = source.rules !== null && typeof source.rules === 'object' ? source.rules : {}
  const template = text(source.template, FIELD_LIMITS.template)
  const limit = Number(source.memoryLimit)
  return {
    template: template === '' ? DEFAULT_TEMPLATE : template,
    extra: text(source.extra, FIELD_LIMITS.extra),
    rules: {
      inCharacter: rules.inCharacter !== false,
      metaForbidden: rules.metaForbidden !== false,
      narrate: rules.narrate !== false,
      proactive: rules.proactive === true,
    },
    includeMemories: source.includeMemories !== false,
    memoryLimit: Number.isFinite(limit) ? Math.min(200, Math.max(0, Math.round(limit))) : 40,
  }
}

/** 生成一条记忆的稳定 id。 */
export function newMemoryId(now = Date.now(), rand = Math.random) {
  return `mem-${now.toString(36)}-${Math.floor(rand() * 1e6).toString(36)}`
}

/**
 * 规整记忆列表：丢弃空条目、去重、限制条数。
 * @param {unknown} input - 待规整数组。
 * @returns {Array<{id: string, kind: string, text: string, pinned: boolean, createdAt: number}>}
 */
export function normalizeMemories(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input) {
    if (raw === null || typeof raw !== 'object') continue
    const body = text(raw.text, FIELD_LIMITS.memoryText)
    if (body === '') continue
    const kind = MEMORY_KINDS.includes(raw.kind) ? raw.kind : 'fact'
    const key = `${kind}\u0000${body}`
    if (seen.has(key)) continue
    seen.add(key)
    const created = Number(raw.createdAt)
    out.push({
      id: typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id) ? raw.id : newMemoryId(),
      kind,
      text: body,
      pinned: raw.pinned === true,
      createdAt: Number.isFinite(created) ? created : Date.now(),
    })
    if (out.length >= FIELD_LIMITS.memories) break
  }
  return out
}

/**
 * 规整整条会话档案。
 * @param {unknown} input - 来自 HTTP 请求或磁盘的档案。
 * @returns a complete record with every field present and bounded.
 */
export function normalizeRecord(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  return {
    version: RECORD_VERSION,
    profile: normalizeProfile(source.profile),
    prompt: normalizePrompt(source.prompt),
    memories: normalizeMemories(source.memories),
  }
}

/**
 * 判断一份档案是否还是“空壳”（用户从未填过角色）。
 * @param {object} record - 规整后的档案。
 * @returns whether the character fields are all empty.
 */
export function isBlankRecord(record) {
  const profile = record?.profile ?? {}
  return Object.values(profile).every((value) => String(value ?? '').trim() === '')
}

/**
 * 替换模板里的 `{{字段}}` 占位符。
 * @param {string} template - 模板正文。
 * @param {Record<string, string>} values - 占位符取值。
 * @returns the filled text; unknown placeholders are left literal.
 */
export function fillTemplate(template, values) {
  return String(template ?? '').replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (whole, name) =>
    Object.hasOwn(values, name) ? String(values[name] ?? '') : whole,
  )
}

/**
 * 把开启的规则渲染成条目正文。
 * @param {object} rules - 规则开关。
 * @returns one bullet per enabled rule, or an empty string.
 */
export function renderRules(rules) {
  const enabled = Object.entries(RULE_LINES).filter(([key]) => rules?.[key] === true)
  if (enabled.length === 0) return '- 保持角色设定，不要出戏。'
  return enabled.map(([, line]) => line).join('\n')
}

/**
 * 渲染注入 system prompt 的角色段落。
 * @param {object} record - 规整后的档案。
 * @returns the section text; empty when the session is not configured as a character.
 */
export function renderPersonaSection(record) {
  const profile = record?.profile ?? {}
  const prompt = record?.prompt ?? {}
  if (isBlankRecord(record)) {
    return [
      '你现在处于「角色扮演模式」，但用户还没有设定角色。',
      '先用一两句话问清楚：要扮演谁、什么身份、什么场景、什么说话风格；拿到答案后就按该角色说话。',
      '用户可以在右侧边栏的「角色扮演」面板里填写人设、长期记忆和附加提示词，那些内容会自动出现在你的上下文里。',
    ].join('\n')
  }
  const filled = fillTemplate(prompt.template || DEFAULT_TEMPLATE, {
    name: profile.name,
    role: profile.role,
    personality: profile.personality,
    scenario: profile.scenario,
    speechStyle: profile.speechStyle,
    rules: renderRules(prompt.rules),
  }).trim()
  const extra = String(prompt.extra ?? '').trim()
  return extra === '' ? filled : `${filled}\n\n【附加要求】\n${extra}`
}

/**
 * 渲染注入 runtime context 的记忆段落。
 * @param {object} record - 规整后的档案。
 * @returns the context text; empty when memories are disabled or absent.
 */
export function renderMemoryContext(record) {
  const prompt = record?.prompt ?? {}
  if (prompt.includeMemories === false) return ''
  const limit = Number.isFinite(prompt.memoryLimit) ? prompt.memoryLimit : 40
  if (limit <= 0) return ''
  const memories = Array.isArray(record?.memories) ? record.memories : []
  if (memories.length === 0) return ''
  // 置顶优先，其次新的优先；稳定排序保证同一份档案每次渲染顺序一致。
  const ordered = [...memories]
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
      return right.createdAt - left.createdAt
    })
    .slice(0, limit)
  const lines = ordered.map((memory) => {
    const label = MEMORY_KIND_LABELS[memory.kind] ?? '事实'
    return `- [${label}]${memory.pinned ? '[重要]' : ''} ${memory.text}`
  })
  return [
    '【角色扮演长期记忆】以下是你（角色）记得的既有事实、事件与关系，回答时保持一致，不要与之矛盾：',
    ...lines,
    '需要记住新内容时，调用 roleplay_memory 工具的 remember 动作；用户也会在侧边栏手动维护这份记忆。',
  ].join('\n')
}

/**
 * 侧边栏「提示词」页签使用的合成预览。
 * @param {object} record - 规整后的档案。
 * @returns {{sectionText: string, contextText: string, text: string}}
 */
export function renderPreview(record) {
  const sectionText = renderPersonaSection(record)
  const contextText = renderMemoryContext(record)
  const parts = [sectionText]
  if (contextText !== '') parts.push(`Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${contextText}`)
  return { sectionText, contextText, text: parts.filter((part) => part !== '').join('\n\n') }
}
