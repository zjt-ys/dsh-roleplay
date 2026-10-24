import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RoleplayStore } from '../store.js'

/** Build an isolated store rooted in a fresh temp directory. */
function tempStore() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-roleplay-test-'))
  return { home, store: new RoleplayStore(home), cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

test('a missing record reads as a blank, non-existent profile', () => {
  const { store, cleanup } = tempStore()
  try {
    const loaded = store.read('session-1', '标题')
    assert.equal(loaded.exists, false)
    assert.equal(loaded.title, '标题')
    assert.equal(loaded.record.profile.name, '')
    assert.equal(store.recordOf('session-1'), undefined, 'no file means nothing is rendered into the prompt')
  } finally {
    cleanup()
  }
})

test('write then read round-trips through disk, not just the cache', () => {
  const { home, store, cleanup } = tempStore()
  try {
    const written = store.write('session-abc', {
      profile: { name: '沈青梧', role: '剑客' },
      memories: [{ kind: 'fact', text: '怕水' }],
    }, '第一章')
    assert.equal(written.ok, true)
    assert.equal(written.value.record.profile.name, '沈青梧')

    // A second store instance must see the same bytes.
    const reopened = new RoleplayStore(home)
    const loaded = reopened.read('session-abc')
    assert.equal(loaded.exists, true)
    assert.equal(loaded.record.profile.role, '剑客')
    assert.equal(loaded.record.memories.length, 1)
    assert.equal(loaded.title, '第一章')

    const file = path.join(home, 'roleplay', 'sessions', 'session-abc.json')
    assert.ok(fs.existsSync(file), 'one JSON file per session')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(parsed.sessionId, 'session-abc')
    assert.equal(parsed.record.profile.name, '沈青梧')
  } finally {
    cleanup()
  }
})

test('recordOf publishes a saved record, blank profile included; absence stays absent', () => {
  const { store, cleanup } = tempStore()
  try {
    store.write('s2', { profile: { name: 'A' } })
    assert.equal(store.recordOf('s2').profile.name, 'A')
    store.write('s3', { profile: {} })
    assert.equal(store.recordOf('s3').profile.name, '', 'a saved-but-empty profile still renders its setup guidance')
    assert.equal(store.recordOf('never-written'), undefined)
  } finally {
    cleanup()
  }
})

test('list() joins the index with a directory scan and sorts newest first', () => {
  const { home, store, cleanup } = tempStore()
  try {
    store.write('older', { profile: { name: '老角色' } })
    store.write('newer', { profile: { name: '新角色' } })
    const rows = store.list()
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((row) => row.name).sort(), ['新角色', '老角色'])

    // Corrupt the index: the directory scan must still recover both rows.
    fs.writeFileSync(path.join(home, 'roleplay', 'index.json'), '{ not json', 'utf8')
    const reopened = new RoleplayStore(home)
    assert.equal(reopened.list().length, 2)
  } finally {
    cleanup()
  }
})

test('remove() deletes the file and the index row', () => {
  const { home, store, cleanup } = tempStore()
  try {
    store.write('gone', { profile: { name: 'X' } })
    const removed = store.remove('gone')
    assert.equal(removed.ok, true)
    assert.equal(removed.deleted, true)
    assert.equal(fs.existsSync(path.join(home, 'roleplay', 'sessions', 'gone.json')), false)
    assert.equal(new RoleplayStore(home).list().length, 0)
  } finally {
    cleanup()
  }
})

test('illegal session ids never escape the data directory', () => {
  const { store, cleanup } = tempStore()
  try {
    for (const id of ['../escape', 'a/b', '', 'x'.repeat(200), 'has space']) {
      assert.equal(store.fileOf(id), undefined, id)
      const outcome = store.write(id, { profile: { name: 'X' } })
      assert.equal(outcome.ok, false, id)
      assert.equal(outcome.error, 'bad-session-id', id)
    }
    assert.equal(store.write('Session_1.abc-2', {}).ok, true, 'the allowed charset still works')
  } finally {
    cleanup()
  }
})

test('writing is atomic: no temp file survives a successful write', () => {
  const { home, store, cleanup } = tempStore()
  try {
    store.write('atomic', { profile: { name: 'Y' } })
    const names = fs.readdirSync(path.join(home, 'roleplay', 'sessions'))
    assert.deepEqual(names, ['atomic.json'])
  } finally {
    cleanup()
  }
})
