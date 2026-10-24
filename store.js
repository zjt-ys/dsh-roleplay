/**
 * dsh-roleplay — 磁盘层。
 *
 * 每一条“角色扮演会话”的档案是一个 JSON 文件，按会话 id 命名，放在
 * $DSH_HOME/roleplay/sessions/<sessionId>.json：
 *
 *   { version, sessionId, title, updatedAt, record }
 *
 * 为什么按会话分文件而不是一份大 JSON：
 *   - 侧边栏每个会话只读自己那一份，不会因为别的会话变大而变慢；
 *   - 一份文件写坏只影响一个会话；
 *   - 用户可以直接打开、备份、删除单个角色的档案。
 *
 * 另外维护一个索引文件 sessions/index.json，只是「有哪些会话是角色扮演会话」
 * 的快速目录（侧边栏下拉框用它，不必把每份档案都读一遍）；它可以从目录内容
 * 重建，因此不作为事实来源。
 *
 * 写入一律「临时文件 + rename」，避免进程中途退出留下半截 JSON。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { normalizeRecord, RECORD_VERSION } from './prompt.js'

/** 插件数据目录名，位于 harness home 之下。 */
export const DATA_DIR_NAME = 'roleplay'

/** 档案目录名。 */
const SESSIONS_DIR = 'sessions'

/** 索引文件名。 */
const INDEX_FILE = 'index.json'

/**
 * 一个会话 id 允许写成文件名的形状。
 *
 * 刻意不含 `:`——Windows 文件名不允许它（`session:1` 会直接写入失败），而
 * 真实的会话 id 形如 `session-<uuid>`，只用字母、数字、`-`、`_`、`.` 就够。
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,160}$/

/**
 * 解析 harness home：优先 `$DSH_HOME`，否则 `~/.dsh`。
 * @returns {string} absolute home path.
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/**
 * 写一个 JSON 文件，先写临时文件再 rename。
 * @param {string} file - 目标绝对路径。
 * @param {unknown} value - 要写入的值。
 */
export function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
}

/**
 * 读一个 JSON 文件，缺失或损坏时返回 undefined。
 * @param {string} file - 绝对路径。
 * @returns the parsed value, or undefined.
 */
export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 会话档案仓库。
 */
export class RoleplayStore {
  /**
   * @param {string} home - harness home。
   */
  constructor(home) {
    this.home = home
    this.baseDir = path.resolve(home, DATA_DIR_NAME)
    this.sessionsDir = path.resolve(this.baseDir, SESSIONS_DIR)
    this.indexFile = path.resolve(this.baseDir, INDEX_FILE)
    /** 内存缓存：sessionId → { version, sessionId, title, updatedAt, record }。 */
    this.cache = new Map()
    /** 索引：sessionId → { title, updatedAt, name }。 */
    this.index = this.loadIndex()
  }

  /** 档案文件的绝对路径；非法 id 返回 undefined。 */
  fileOf(sessionId) {
    if (typeof sessionId !== 'string' || !SAFE_SESSION_ID.test(sessionId)) return undefined
    return path.resolve(this.sessionsDir, `${sessionId}.json`)
  }

  /** 读取索引文件；失败就当空索引，绝不因为索引损坏挡住读取。 */
  loadIndex() {
    const parsed = readJson(this.indexFile)
    const sessions = parsed !== null && typeof parsed === 'object' && parsed.sessions !== null && typeof parsed.sessions === 'object'
      ? parsed.sessions
      : {}
    const out = {}
    for (const [id, entry] of Object.entries(sessions)) {
      if (typeof id !== 'string' || entry === null || typeof entry !== 'object') continue
      out[id] = {
        title: typeof entry.title === 'string' ? entry.title : '',
        name: typeof entry.name === 'string' ? entry.name : '',
        updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : 0,
      }
    }
    return out
  }

  /** 落盘索引。 */
  saveIndex() {
    writeJsonAtomic(this.indexFile, {
      version: RECORD_VERSION,
      updatedAt: Date.now(),
      sessions: this.index,
    })
  }

  /**
   * 读一条会话档案；不存在时返回一条空档案（不落盘）。
   * @param {string} sessionId - 会话 id。
   * @param {string} [title] - 会话标题，仅用于索引展示。
   * @returns {{sessionId: string, title: string, updatedAt: number, exists: boolean, record: object}}
   */
  read(sessionId, title = '') {
    const cached = this.cache.get(sessionId)
    if (cached !== undefined) {
      return { sessionId, title: cached.title || title, updatedAt: cached.updatedAt, exists: true, record: cached.record }
    }
    const file = this.fileOf(sessionId)
    const parsed = file === undefined ? undefined : readJson(file)
    if (parsed === null || typeof parsed !== 'object' || parsed.record === undefined) {
      return {
        sessionId,
        title,
        updatedAt: 0,
        exists: false,
        record: normalizeRecord(undefined),
      }
    }
    const entry = {
      version: RECORD_VERSION,
      sessionId,
      title: typeof parsed.title === 'string' ? parsed.title : title,
      updatedAt: Number.isFinite(Number(parsed.updatedAt)) ? Number(parsed.updatedAt) : 0,
      record: normalizeRecord(parsed.record),
    }
    this.cache.set(sessionId, entry)
    return { sessionId, title: entry.title || title, updatedAt: entry.updatedAt, exists: true, record: entry.record }
  }

  /**
   * 写入一条会话档案。
   * @param {string} sessionId - 会话 id。
   * @param {unknown} record - 待写入的档案（会被规整）。
   * @param {string} [title] - 会话标题。
   * @returns {{ok: boolean, error?: string, value?: object}}
   */
  write(sessionId, record, title = '') {
    const file = this.fileOf(sessionId)
    if (file === undefined) return { ok: false, error: 'bad-session-id' }
    const normalized = normalizeRecord(record)
    const now = Date.now()
    const entry = {
      version: RECORD_VERSION,
      sessionId,
      title: typeof title === 'string' ? title : '',
      updatedAt: now,
      record: normalized,
    }
    try {
      writeJsonAtomic(file, entry)
    } catch (error) {
      return { ok: false, error: `write-failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    this.cache.set(sessionId, entry)
    // 空档案也进索引：用户可能先建会话再填角色，侧边栏要能立刻看到它。
    this.index[sessionId] = {
      title: entry.title,
      name: normalized.profile.name,
      updatedAt: now,
    }
    try {
      this.saveIndex()
    } catch {
      // 索引是缓存：写失败不影响档案本身，下次写入会重试。
    }
    return { ok: true, value: { sessionId, title: entry.title, updatedAt: now, exists: true, record: normalized } }
  }

  /**
   * 删除一条会话档案。
   * @param {string} sessionId - 会话 id。
   * @returns {{ok: boolean, deleted: boolean, error?: string}}
   */
  remove(sessionId) {
    const file = this.fileOf(sessionId)
    if (file === undefined) return { ok: false, deleted: false, error: 'bad-session-id' }
    let deleted = false
    try {
      fs.rmSync(file, { force: true })
      deleted = true
    } catch (error) {
      return { ok: false, deleted: false, error: `delete-failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    this.cache.delete(sessionId)
    if (this.index[sessionId] !== undefined) {
      delete this.index[sessionId]
      try {
        this.saveIndex()
      } catch {
        // 同上：索引可重建。
      }
    }
    return { ok: true, deleted }
  }

  /**
   * 列出已知的角色扮演会话（索引 + 目录扫描兜底）。
   * @returns {Array<{sessionId: string, title: string, name: string, updatedAt: number}>}
   */
  list() {
    const rows = new Map()
    for (const [sessionId, entry] of Object.entries(this.index)) rows.set(sessionId, { sessionId, ...entry })
    // 目录扫描兜底：索引丢过一次也能恢复；只补索引里没有的文件。
    let names = []
    try {
      names = fs.readdirSync(this.sessionsDir)
    } catch {
      names = []
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const sessionId = name.slice(0, -'.json'.length)
      if (rows.has(sessionId)) continue
      const parsed = readJson(path.resolve(this.sessionsDir, name))
      if (parsed === null || typeof parsed !== 'object') continue
      const record = normalizeRecord(parsed.record)
      rows.set(sessionId, {
        sessionId,
        title: typeof parsed.title === 'string' ? parsed.title : '',
        name: record.profile.name,
        updatedAt: Number.isFinite(Number(parsed.updatedAt)) ? Number(parsed.updatedAt) : 0,
      })
    }
    return [...rows.values()].sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /**
   * 供提示词渲染使用的读取。
   *
   * 语义刻意区分「没有档案」和「有档案但还没填」：
   *   - 没落过盘 → `undefined`，提示词里什么都不注入；
   *   - 落过盘但角色字段还是空的 → 返回空档案，渲染成「先问清角色」的引导段，
   *     这样用户刚建会话、还没在侧边栏填人设时，模型不会一句都不说设定。
   *
   * @param {string} sessionId - 会话 id。
   * @returns the normalized record, or undefined when the session has no file.
   */
  recordOf(sessionId) {
    const loaded = this.read(sessionId)
    return loaded.exists ? loaded.record : undefined
  }
}
