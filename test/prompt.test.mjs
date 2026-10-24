import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TEMPLATE,
  MEMORY_KINDS,
  fillTemplate,
  isBlankRecord,
  normalizeMemories,
  normalizeRecord,
  renderMemoryContext,
  renderPersonaSection,
  renderPreview,
  renderRules,
} from '../prompt.js'

function recordWith(patch = {}) {
  const base = normalizeRecord({
    profile: {
      name: '沈青梧',
      role: '隐居山林的剑客',
      personality: '寡言，护短，厌恶江湖客套',
      scenario: '暮春，山中草庐，暴雨将至',
      speechStyle: '短句，偶尔带一句诗，称呼对方为「你」',
    },
    prompt: {
      extra: '不要替用户说话。',
      rules: { inCharacter: true, metaForbidden: true, narrate: true, proactive: false },
    },
    memories: [
      { id: 'mem-a', kind: 'fact', text: '左臂有旧伤，阴天会疼', pinned: true, createdAt: 10 },
      { id: 'mem-b', kind: 'event', text: '三年前在青石镇救过用户一命', pinned: false, createdAt: 20 },
    ],
  })
  return { ...base, ...patch }
}

test('normalizeRecord fills every field and clamps lengths', () => {
  const record = normalizeRecord({
    profile: { name: '  '.repeat(500) + 'x', role: 1234 },
    prompt: { memoryLimit: '9999' },
    memories: 'not-an-array',
  })
  assert.equal(record.version, 1)
  assert.equal(record.profile.role, '')
  assert.ok(record.profile.name.length <= 120)
  assert.equal(record.prompt.template, DEFAULT_TEMPLATE, 'empty template falls back to the default')
  assert.equal(record.prompt.memoryLimit, 200, 'memoryLimit is clamped to 200')
  assert.deepEqual(record.memories, [])
  assert.equal(typeof record.prompt.rules.inCharacter, 'boolean')
})

test('normalizeMemories drops blanks, dedupes, and assigns ids', () => {
  const memories = normalizeMemories([
    { kind: 'fact', text: '   ', createdAt: 1 },
    { kind: 'nope', text: '有效记忆', createdAt: 2 },
    { kind: 'fact', text: '有效记忆', createdAt: 3 },
    { kind: 'scene', text: '雨里的一把伞', pinned: true, createdAt: 4 },
  ])
  assert.equal(memories.length, 2, 'blank dropped, duplicate dropped')
  assert.equal(memories[0].kind, 'fact', 'unknown kind falls back to fact')
  assert.equal(memories[1].kind, 'scene')
  assert.equal(memories[1].pinned, true)
  assert.match(memories[0].id, /^mem-/)
})

test('fillTemplate replaces only known placeholders', () => {
  const text = fillTemplate('A {{name}} B {{ unknown }} C {{role}}', { name: 'N', role: 'R' })
  assert.equal(text, 'A N B {{ unknown }} C R')
})

test('renderRules lists enabled rules and always yields something', () => {
  assert.match(renderRules({ inCharacter: true, metaForbidden: false }), /第一人称/)
  assert.equal(renderRules({ inCharacter: true, metaForbidden: true, narrate: true, proactive: true }).split('\n').length, 4)
  assert.match(renderRules({}), /保持角色设定/)
})

test('blank record renders the setup-request prompt, not an empty section', () => {
  const record = normalizeRecord(undefined)
  assert.equal(isBlankRecord(record), true)
  const section = renderPersonaSection(record)
  assert.match(section, /还没有设定角色/)
  assert.equal(renderMemoryContext(record), '')
})

test('a configured record renders persona fields and extra instructions', () => {
  const section = renderPersonaSection(recordWith())
  assert.match(section, /沈青梧/)
  assert.match(section, /隐居山林的剑客/)
  assert.match(section, /暮春/)
  assert.match(section, /附加要求/)
  assert.match(section, /不要替用户说话/)
  assert.ok(!section.includes('{{'), 'no placeholder may survive rendering')
})

test('memory context honors pinned-first ordering and the limit', () => {
  const record = recordWith()
  const context = renderMemoryContext(record)
  const pinnedAt = context.indexOf('旧伤')
  const eventAt = context.indexOf('青石镇')
  assert.ok(pinnedAt >= 0 && eventAt >= 0)
  assert.ok(pinnedAt < eventAt, 'pinned memory must render before a newer unpinned one')
  assert.match(context, /\[事实\]\[重要\]/)
  assert.match(context, /roleplay_memory/)

  const limited = renderMemoryContext({ ...record, prompt: { ...record.prompt, memoryLimit: 1 } })
  assert.ok(limited.includes('旧伤'))
  assert.ok(!limited.includes('青石镇'))

  const off = renderMemoryContext({ ...record, prompt: { ...record.prompt, includeMemories: false } })
  assert.equal(off, '')
})

test('preview joins section and runtime-context text', () => {
  const preview = renderPreview(recordWith())
  assert.match(preview.sectionText, /沈青梧/)
  assert.match(preview.contextText, /长期记忆/)
  assert.match(preview.text, /Current runtime context/)
  assert.ok(preview.text.indexOf(preview.sectionText) < preview.text.indexOf(preview.contextText))
})

test('every memory kind has a label used by rendering', () => {
  for (const kind of MEMORY_KINDS) {
    const record = normalizeRecord({ memories: [{ kind, text: `kind-${kind}` }] })
    assert.ok(renderMemoryContext(record).includes(`kind-${kind}`), kind)
  }
})
