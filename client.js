/* dsh-roleplay — BROWSER half.
 *
 * 侧边栏「角色扮演」面板：一个 main 面板 + 一个侧边栏图标，内部三个页签
 * （人设 / 记忆 / 提示词）。数据全部来自宿主半的 `/api/roleplay/*` 路由，
 * 与模型看到的是同一份文件——侧边栏改完，下一次请求就生效。
 *
 * 结构说明：
 *   - `sidebar.panellist` 注册图标，`main` 注册同名 key 的面板；点击图标由
 *     ui-layout 把 main 切换到我们的 key。
 *   - 「当前会话」从 `useSessions` 的 `retainedBy.mainView` 推断。注意：本
 *     面板显示时对话并不在渲染，mainView 引用会被释放，所以这里会把「最后
 *     一个在对话里打开过的会话」记在 localStorage，作为面板打开时的默认目标；
 *     用户也可以在下拉里显式切换。
 *   - 只有 `agentPreset === 'roleplay'` 的会话才会注入提示词；其它会话上面板
 *     显示引导，不报错。
 *
 * 本文件是手写的模块加载器包体（`window.__ModuleLoader__.load({ id, factory })`），
 * 只 `require('react')`，不引用任何 Harness Client 包。
 */
window.__ModuleLoader__.load({
  id: 'dsh-roleplay',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { createElement: el } = React
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Locale namespace; also the `locale` option of both registrations. */
    const NS = 'dsh-roleplay'
    /** Panel id: the same id keys `sidebar.panellist` and `main`. */
    const PANEL_ID = 'roleplay'
    /** Agent preset id declared by this bundle's patch. */
    const PRESET_ID = 'roleplay'
    /** Host half's HTTP base. */
    const API = '/api/roleplay'
    /** Remembered target session, so the panel keeps a subject while it is open. */
    const STORE_KEY = 'dsh.roleplay.lastSession'
    /** Memory kinds, mirroring prompt.js. */
    const KINDS = ['fact', 'event', 'relation', 'preference', 'scene']

    const zh = {
      nav: '角色扮演',
      title: '角色扮演',
      subtitle: '人设 / 记忆 / 提示词按会话独立保存，并自动注入该会话的系统提示词。',
      tabPersona: '人设',
      tabMemory: '记忆',
      tabPrompt: '提示词',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      reload: '重新读取',
      loading: '载入中…',
      newSession: '新建角色扮演会话',
      newSessionHint: '用「角色扮演」预设新开一个对话；只有在角色扮演会话里才会注入提示词。',
      session: '会话',
      noSession: '还没有可管理的会话',
      noSessionHint: '先在侧边栏新建一个对话，并在新建时选择「角色扮演」预设。',
      notRoleplay: '当前会话不是角色扮演会话',
      notRoleplayHint:
        '角色扮演提示词只会注入到用「角色扮演」预设创建的会话。你可以先在这里编辑档案，再新建一个角色扮演会话。',
      roleplayBadge: '角色扮演会话',
      othersBadge: '普通会话',
      name: '角色名',
      nameHint: '角色在这个世界里的名字，会写进提示词。',
      role: '身份定位',
      roleHint: '例如「隐居山林的剑客」「财阀家的二小姐」。',
      personality: '性格特征',
      personalityHint: '说话做事的方式、在意什么、禁忌是什么。',
      scenario: '所处场景',
      scenarioHint: '当前时间、地点、正发生什么，以及用户在其中扮演谁。',
      speechStyle: '说话风格',
      speechStyleHint: '句长、口头禅、称谓、要不要用括号写动作。',
      memories: '长期记忆',
      memoriesHint: '这些内容会作为「角色记得的事」注入上下文；置顶的排在最前。',
      addMemory: '添加记忆',
      memoryEmpty: '还没有记忆。对话里让角色记住某件事，或在这里手动添加。',
      memoryText: '内容',
      pinned: '置顶',
      remove: '删除',
      template: '提示词模板',
      templateHint: '可用占位符：{{name}} {{role}} {{personality}} {{scenario}} {{speechStyle}} {{rules}}',
      extra: '附加要求',
      extraHint: '追加在模板之后的额外指令，例如文风、篇幅、禁区。',
      rules: '扮演规则',
      ruleInCharacter: '始终以角色第一人称说话',
      ruleMetaForbidden: '禁止元叙述（“作为一个AI…”）',
      ruleNarrate: '动作与神态用括号或独立段落描写',
      ruleProactive: '每次回复主动推进一点剧情',
      includeMemories: '把长期记忆注入上下文',
      memoryLimit: '最多注入几条记忆',
      preview: '合成预览',
      previewHint: '这是下一次请求实际注入的内容：人设部分进系统提示词，记忆部分进运行时上下文。',
      previewRefresh: '刷新预览',
      previewEmpty: '（当前没有可注入的内容）',
      unsaved: '未保存',
      error: '操作失败',
      reinject: '重新注入',
      reinjectHint: '把当前人设/记忆作为系统便签推给模型，立即按新设定说话（保存后会自动注入一次，通常无需手动点）。',
      reinjectDone: '已重新注入，下一句回复即按当前设定生效。',
      kindFact: '事实',
      kindEvent: '事件',
      kindRelation: '关系',
      kindPreference: '偏好',
      kindScene: '场景',
      memoryCount: '{n} 条记忆',
    }

    const en = {
      nav: 'Roleplay',
      title: 'Roleplay',
      subtitle: 'Persona, memory and prompt are stored per session and injected into that session’s system prompt.',
      tabPersona: 'Persona',
      tabMemory: 'Memory',
      tabPrompt: 'Prompt',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      reload: 'Reload',
      loading: 'Loading…',
      newSession: 'New roleplay session',
      newSessionHint: 'Start a conversation with the “Roleplay” preset; only those sessions receive the injection.',
      session: 'Session',
      noSession: 'No session to manage yet',
      noSessionHint: 'Start a conversation from the sidebar and pick the “Roleplay” preset.',
      notRoleplay: 'This session is not a roleplay session',
      notRoleplayHint:
        'The roleplay prompt is injected only into sessions created with the “Roleplay” preset. You can edit the profile here first.',
      roleplayBadge: 'Roleplay session',
      othersBadge: 'Standard session',
      name: 'Character name',
      nameHint: 'The name the character uses in this world.',
      role: 'Role',
      roleHint: 'e.g. “a swordmaster living in seclusion”, “the second daughter of a trading house”.',
      personality: 'Personality',
      personalityHint: 'How they speak and act, what they care about, what they refuse.',
      scenario: 'Scenario',
      scenarioHint: 'Time, place, what is happening, and who the user plays.',
      speechStyle: 'Speaking style',
      speechStyleHint: 'Sentence length, catchphrases, honorifics, whether actions go in parentheses.',
      memories: 'Long-term memory',
      memoriesHint: 'Injected as things the character remembers; pinned entries come first.',
      addMemory: 'Add memory',
      memoryEmpty: 'No memories yet. Have the character remember something in chat, or add one here.',
      memoryText: 'Content',
      pinned: 'Pin',
      remove: 'Delete',
      template: 'Prompt template',
      templateHint: 'Placeholders: {{name}} {{role}} {{personality}} {{scenario}} {{speechStyle}} {{rules}}',
      extra: 'Extra instructions',
      extraHint: 'Appended after the template: style, length, taboos.',
      rules: 'Rules',
      ruleInCharacter: 'Always speak in the character’s first person',
      ruleMetaForbidden: 'No meta narration (“as an AI…”)',
      ruleNarrate: 'Describe actions and expressions in parentheses or paragraphs',
      ruleProactive: 'Advance the scene a little on every reply',
      includeMemories: 'Inject long-term memory',
      memoryLimit: 'Max memories injected',
      preview: 'Composed preview',
      previewHint:
        'What the next request receives: the persona becomes a system prompt section, memory becomes runtime context.',
      previewRefresh: 'Refresh preview',
      previewEmpty: '(nothing to inject yet)',
      unsaved: 'unsaved',
      error: 'Failed',
      reinject: 'Re-inject',
      reinjectHint: 'Push the current persona/memory to the model as a system note so the very next reply follows it (saving already re-injects automatically; this button is for the rare manual case).',
      reinjectDone: 'Re-injected — the next reply follows the current profile.',
      kindFact: 'Fact',
      kindEvent: 'Event',
      kindRelation: 'Relation',
      kindPreference: 'Preference',
      kindScene: 'Scene',
      memoryCount: '{n} memories',
    }

    /* ── styles ────────────────────────────────────────────────────────────
     * 只用宿主主题变量（--dsw-alias-*），不写死颜色，浅色/深色自动跟随。
     */
    const S = {
      root: {
        height: '100%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        // 面板占满中央区，顶部要避开窗口标题栏/交通灯区域（宿主的约定）。
        padding: 'calc(var(--dsh-frame-top-clearance, 0px) + 14px) 18px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        flexWrap: 'wrap',
      },
      heading: { fontSize: '16px', fontWeight: 600, margin: 0 },
      subtitle: {
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)',
        margin: '4px 0 0',
        lineHeight: 1.6,
        maxWidth: '560px',
      },
      spacer: { flex: '1 1 auto' },
      button: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'inherit',
        borderRadius: '6px',
        padding: '4px 12px',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
        whiteSpace: 'nowrap',
      },
      primary: {
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)',
        borderRadius: '6px',
        padding: '4px 12px',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '12px',
        whiteSpace: 'nowrap',
      },
      muted: { opacity: 0.5, cursor: 'default' },
      select: {
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'inherit',
        borderRadius: '6px',
        padding: '4px 8px',
        font: 'inherit',
        fontSize: '12px',
        maxWidth: '300px',
      },
      badge: {
        fontSize: '11px',
        padding: '1px 8px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        whiteSpace: 'nowrap',
      },
      badgeOn: { borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' },
      tabs: {
        display: 'flex',
        gap: '4px',
        padding: '10px 18px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      tab: {
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        padding: '6px 12px 8px',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '13px',
        borderBottom: '2px solid transparent',
        marginBottom: '-1px',
      },
      tabActive: {
        color: 'var(--dsw-alias-label-primary)',
        borderBottom: '2px solid var(--dsw-alias-brand-primary)',
        fontWeight: 600,
      },
      body: { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '16px 18px 40px' },
      section: { display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '16px' },
      label: { fontSize: '12px', fontWeight: 600 },
      hint: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'inherit',
        borderRadius: '8px',
        padding: '7px 10px',
        font: 'inherit',
        fontSize: '13px',
      },
      numberInput: {
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'inherit',
        borderRadius: '6px',
        padding: '4px 8px',
        font: 'inherit',
        fontSize: '12px',
        width: '84px',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: '84px',
        resize: 'vertical',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'inherit',
        borderRadius: '8px',
        padding: '8px 10px',
        font: 'inherit',
        fontSize: '13px',
        lineHeight: 1.65,
      },
      codeArea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: '220px',
        resize: 'vertical',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        color: 'inherit',
        borderRadius: '8px',
        padding: '10px 12px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        lineHeight: 1.7,
      },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: '10px',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        marginBottom: '10px',
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      check: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' },
      error: {
        fontSize: '12px',
        color: 'var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        padding: '6px 10px',
        marginBottom: '12px',
        whiteSpace: 'pre-wrap',
      },
      notice: {
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        padding: '10px 12px',
        lineHeight: 1.8,
        marginBottom: '14px',
      },
      preview: {
        margin: 0,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        lineHeight: 1.75,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '8px',
        padding: '10px 12px',
        maxHeight: '420px',
        overflow: 'auto',
      },
      empty: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.9, padding: '10px 0' },
    }

    /* ── data plumbing ─────────────────────────────────────────────────── */

    /** One JSON request against the host half; never throws. */
    async function call(path, init) {
      try {
        const response = await fetch(`${API}${path}`, {
          headers: { 'content-type': 'application/json' },
          cache: 'no-store',
          ...init,
        })
        return await response.json()
      } catch (error) {
        return { ok: false, error: String(error && error.message ? error.message : error) }
      }
    }

    const getState = (sessionId) => call(`/state?session=${encodeURIComponent(sessionId)}`)
    const getPreview = (sessionId) => call(`/preview?session=${encodeURIComponent(sessionId)}`)
    const saveState = (sessionId, record) =>
      call('/save', { method: 'POST', body: JSON.stringify({ sessionId, record }) })
    const reinject = (sessionId) => call('/reinject', { method: 'POST', body: JSON.stringify({ sessionId }) })

    /** Read the remembered target session. */
    function readRemembered() {
      try {
        const value = window.localStorage.getItem(STORE_KEY)
        return typeof value === 'string' && value !== '' ? value : null
      } catch {
        return null
      }
    }

    /** Write the remembered target session. */
    function remember(sessionId) {
      try {
        if (sessionId === null || sessionId === undefined || sessionId === '') window.localStorage.removeItem(STORE_KEY)
        else window.localStorage.setItem(STORE_KEY, sessionId)
      } catch {
        // localStorage may be unavailable; the in-memory ref still works.
      }
    }

    /** Deep clone a record so editing never mutates the fetched value. */
    function cloneRecord(record) {
      return JSON.parse(JSON.stringify(record ?? {}))
    }

    /** Empty record used before the first fetch settles. */
    function blankRecord() {
      return {
        version: 1,
        profile: { name: '', role: '', personality: '', scenario: '', speechStyle: '' },
        prompt: {
          template: '',
          extra: '',
          rules: { inCharacter: true, metaForbidden: true, narrate: true, proactive: false },
          includeMemories: true,
          memoryLimit: 40,
        },
        memories: [],
      }
    }

    /** Session rows the panel can target, newest first. Subagents are excluded. */
    function sessionRows(snapshot) {
      const byId = snapshot && snapshot.byId ? snapshot.byId : {}
      const rows = []
      for (const id of Object.keys(byId)) {
        const summary = byId[id]
        if (summary === undefined || summary === null || summary.origin === 'subagent') continue
        const values = summary.projectionValues
        const preset = values === undefined || values === null ? undefined : values.agentPreset
        rows.push({
          id,
          title: typeof summary.title === 'string' && summary.title !== '' ? summary.title : id,
          roleplay: preset === PRESET_ID,
          updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : 0,
          retained: ((summary.retainedBy ?? {}).mainView ?? 0) > 0,
        })
      }
      rows.sort((left, right) => right.updatedAt - left.updatedAt)
      return rows
    }

    /* ── presentational helpers ────────────────────────────────────────── */

    function Field(props) {
      return el(
        'div',
        { style: S.section },
        el('label', { style: S.label }, props.label),
        props.children,
        props.hint === undefined ? null : el('div', { style: S.hint }, props.hint),
      )
    }

    function Toggle(props) {
      return el(
        'label',
        { style: S.check },
        el('input', {
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        el('span', null, props.label),
      )
    }

    /* ── tabs ──────────────────────────────────────────────────────────── */

    function PersonaTab(props) {
      const { draft, set, t, disabled } = props
      const profile = draft.profile
      return el(
        'div',
        null,
        el(
          Field,
          { label: t('name'), hint: t('nameHint') },
          el('input', {
            style: S.input,
            type: 'text',
            value: profile.name,
            disabled,
            onChange: (event) => set('profile', 'name', event.target.value),
          }),
        ),
        el(
          Field,
          { label: t('role'), hint: t('roleHint') },
          el('input', {
            style: S.input,
            type: 'text',
            value: profile.role,
            disabled,
            onChange: (event) => set('profile', 'role', event.target.value),
          }),
        ),
        el(
          Field,
          { label: t('personality'), hint: t('personalityHint') },
          el('textarea', {
            style: S.textarea,
            value: profile.personality,
            disabled,
            onChange: (event) => set('profile', 'personality', event.target.value),
          }),
        ),
        el(
          Field,
          { label: t('scenario'), hint: t('scenarioHint') },
          el('textarea', {
            style: S.textarea,
            value: profile.scenario,
            disabled,
            onChange: (event) => set('profile', 'scenario', event.target.value),
          }),
        ),
        el(
          Field,
          { label: t('speechStyle'), hint: t('speechStyleHint') },
          el('textarea', {
            style: S.textarea,
            value: profile.speechStyle,
            disabled,
            onChange: (event) => set('profile', 'speechStyle', event.target.value),
          }),
        ),
      )
    }

    function MemoryTab(props) {
      const { draft, setMemory, addMemory, removeMemory, t, disabled } = props
      const memories = draft.memories
      return el(
        'div',
        null,
        el(
          'div',
          { style: S.row },
          el('div', { style: S.label }, t('memories')),
          el('span', { style: S.hint }, t('memoryCount', { n: memories.length })),
          el('div', { style: S.spacer }),
          el('button', { type: 'button', style: S.button, disabled, onClick: addMemory }, t('addMemory')),
        ),
        el('div', { style: S.hint }, t('memoriesHint')),
        el('div', { style: { height: '10px' } }),
        memories.length === 0
          ? el('div', { style: S.empty }, t('memoryEmpty'))
          : memories.map((memory, index) =>
              el(
                'div',
                { key: memory.id, style: S.card },
                el(
                  'div',
                  { style: S.cardHead },
                  el(
                    'select',
                    {
                      style: S.select,
                      value: memory.kind,
                      disabled,
                      'aria-label': t('memoryText'),
                      onChange: (event) => setMemory(index, { kind: event.target.value }),
                    },
                    KINDS.map((kind) =>
                      el(
                        'option',
                        { key: kind, value: kind },
                        t(`kind${kind.charAt(0).toUpperCase()}${kind.slice(1)}`),
                      ),
                    ),
                  ),
                  el('div', { style: S.spacer }),
                  el(Toggle, {
                    checked: memory.pinned,
                    disabled,
                    label: t('pinned'),
                    onChange: (value) => setMemory(index, { pinned: value }),
                  }),
                  el(
                    'button',
                    { type: 'button', style: S.button, disabled, onClick: () => removeMemory(index) },
                    t('remove'),
                  ),
                ),
                el('textarea', {
                  style: S.textarea,
                  value: memory.text,
                  disabled,
                  placeholder: t('memoryText'),
                  onChange: (event) => setMemory(index, { text: event.target.value }),
                }),
              ),
            ),
      )
    }

    function PromptTab(props) {
      const { draft, set, setRule, t, disabled, preview, previewLoading, refreshPreview } = props
      const prompt = draft.prompt
      return el(
        'div',
        null,
        el(
          Field,
          { label: t('template'), hint: t('templateHint') },
          el('textarea', {
            style: S.codeArea,
            value: prompt.template,
            disabled,
            onChange: (event) => set('prompt', 'template', event.target.value),
          }),
        ),
        el(
          Field,
          { label: t('extra'), hint: t('extraHint') },
          el('textarea', {
            style: S.textarea,
            value: prompt.extra,
            disabled,
            onChange: (event) => set('prompt', 'extra', event.target.value),
          }),
        ),
        el(
          'div',
          { style: S.section },
          el('div', { style: S.label }, t('rules')),
          el(Toggle, {
            checked: prompt.rules.inCharacter,
            disabled,
            label: t('ruleInCharacter'),
            onChange: (value) => setRule('inCharacter', value),
          }),
          el(Toggle, {
            checked: prompt.rules.metaForbidden,
            disabled,
            label: t('ruleMetaForbidden'),
            onChange: (value) => setRule('metaForbidden', value),
          }),
          el(Toggle, {
            checked: prompt.rules.narrate,
            disabled,
            label: t('ruleNarrate'),
            onChange: (value) => setRule('narrate', value),
          }),
          el(Toggle, {
            checked: prompt.rules.proactive,
            disabled,
            label: t('ruleProactive'),
            onChange: (value) => setRule('proactive', value),
          }),
        ),
        el(
          'div',
          { style: S.row },
          el(Toggle, {
            checked: prompt.includeMemories,
            disabled,
            label: t('includeMemories'),
            onChange: (value) => set('prompt', 'includeMemories', value),
          }),
          el('div', { style: S.spacer }),
          el('label', { style: S.check }, t('memoryLimit')),
          el('input', {
            type: 'number',
            min: 0,
            max: 200,
            style: S.numberInput,
            value: prompt.memoryLimit,
            disabled,
            onChange: (event) => {
              const next = Number(event.target.value)
              set('prompt', 'memoryLimit', Number.isFinite(next) ? next : 0)
            },
          }),
        ),
        el('div', { style: { height: '16px' } }),
        el(
          'div',
          { style: S.row },
          el('div', { style: S.label }, t('preview')),
          el('div', { style: S.spacer }),
          el(
            'button',
            { type: 'button', style: S.button, disabled: previewLoading, onClick: refreshPreview },
            t('previewRefresh'),
          ),
        ),
        el('div', { style: S.hint }, t('previewHint')),
        el('pre', { style: S.preview }, preview === '' ? t('previewEmpty') : preview),
      )
    }

    /* ── the panel ─────────────────────────────────────────────────────── */

    /**
     * @param {object} props - standard slot kit (`useSessions`, `t`) plus the injected `kit`.
     */
    function Panel(props) {
      const t = props.t
      const useSessions = props.useSessions
      const kit = props.kit ?? {}
      /** Last session seen with mainView retention; the default while the panel is open. */
      const lastSession = useRef(readRemembered())
      const [manualId, setManualId] = useState(null)
      const [draft, setDraft] = useState(blankRecord)
      const [roleplay, setRoleplay] = useState(false)
      const [loading, setLoading] = useState(false)
      const [saving, setSaving] = useState(false)
      const [dirty, setDirty] = useState(false)
      const [message, setMessage] = useState(null)
      const [error, setError] = useState(null)
      const [tab, setTab] = useState('persona')
      const [preview, setPreview] = useState('')
      const [previewLoading, setPreviewLoading] = useState(false)
      const ticket = useRef(0)

      const snapshot = typeof useSessions === 'function' ? useSessions((state) => state) : undefined
      const rows = useMemo(() => sessionRows(snapshot), [snapshot])
      // 面板只管理角色扮演会话：下拉、默认目标、空态都以这份列表为准。
      const roleplayRows = useMemo(() => rows.filter((row) => row.roleplay), [rows])

      // Track the conversation's session so the panel keeps a subject once opened.
      //
      // 回退顺序很重要：面板显示时对话不在渲染，`mainView` 引用已释放，所以
      // 只靠它会让面板在「从对话切过来」的瞬间丢掉目标。在**角色扮演会话**里
      // 依次尝试：
      //   1. 仍被 mainView 持有、且是角色扮演的会话；
      //   2. localStorage 记住的上一个角色扮演会话；
      //   3. 最新的角色扮演会话。
      // 普通会话永远不会被自动选为目标——面板只服务角色扮演模式。
      const watchedId = useMemo(() => {
        const retained = roleplayRows.find((row) => row.retained)
        const remembered =
          lastSession.current === null ? undefined : roleplayRows.find((row) => row.id === lastSession.current)
        const target = retained ?? remembered ?? roleplayRows[0]
        if (target === undefined) return null
        lastSession.current = target.id
        remember(target.id)
        return target.id
      }, [roleplayRows])

      const sessionId = manualId ?? watchedId ?? null
      const currentRow = sessionId === null ? undefined : rows.find((row) => row.id === sessionId)

      const load = useCallback(async (targetId) => {
        if (targetId === null || targetId === undefined || targetId === '') {
          setDraft(blankRecord())
          setPreview('')
          setRoleplay(false)
          return
        }
        const mine = ++ticket.current
        setLoading(true)
        setError(null)
        const body = await getState(targetId)
        if (mine !== ticket.current) return
        setLoading(false)
        if (body === null || body.ok !== true) {
          setError(String(body && body.error ? body.error : 'state-unavailable'))
          return
        }
        setDraft(cloneRecord(body.record))
        setPreview(body.preview !== undefined && body.preview !== null && body.preview.text ? body.preview.text : '')
        setRoleplay(body.roleplay === true)
        setDirty(false)
        setMessage(null)
      }, [])

      useEffect(() => {
        void load(sessionId)
      }, [sessionId, load])

      /** Immutable setter for one nested field (`profile.x` / `prompt.x`). */
      const set = useCallback((scope, key, value) => {
        setDraft((current) => {
          const next = cloneRecord(current)
          next[scope] = { ...next[scope], [key]: value }
          return next
        })
        setDirty(true)
        setMessage(null)
      }, [])

      /** Immutable setter for one rule toggle (`prompt.rules.x`). */
      const setRule = useCallback((key, value) => {
        setDraft((current) => {
          const next = cloneRecord(current)
          next.prompt.rules = { ...next.prompt.rules, [key]: value }
          return next
        })
        setDirty(true)
        setMessage(null)
      }, [])

      const addMemory = useCallback(() => {
        setDraft((current) => {
          const next = cloneRecord(current)
          next.memories = [
            ...next.memories,
            {
              id: `mem-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
              kind: 'fact',
              text: '',
              pinned: false,
              createdAt: Date.now(),
            },
          ]
          return next
        })
        setDirty(true)
        setMessage(null)
      }, [])

      const setMemory = useCallback((index, patch) => {
        setDraft((current) => {
          const next = cloneRecord(current)
          next.memories = next.memories.map((memory, position) =>
            position === index ? { ...memory, ...patch } : memory,
          )
          return next
        })
        setDirty(true)
        setMessage(null)
      }, [])

      const removeMemory = useCallback((index) => {
        setDraft((current) => {
          const next = cloneRecord(current)
          next.memories = next.memories.filter((_memory, position) => position !== index)
          return next
        })
        setDirty(true)
        setMessage(null)
      }, [])

      const refreshPreview = useCallback(async () => {
        if (sessionId === null) return
        setPreviewLoading(true)
        const body = await getPreview(sessionId)
        setPreviewLoading(false)
        if (body !== null && body.ok === true) setPreview(body.text ?? '')
        else setError(String(body && body.error ? body.error : 'preview-unavailable'))
      }, [sessionId])

      const save = useCallback(async () => {
        if (sessionId === null) return
        setSaving(true)
        setError(null)
        const body = await saveState(sessionId, draft)
        setSaving(false)
        if (body === null || body.ok !== true) {
          setError(String(body && body.error ? body.error : 'save-failed'))
          return
        }
        setDraft(cloneRecord(body.record))
        setRoleplay(body.roleplay === true)
        if (body.preview !== undefined && body.preview !== null && body.preview.text) setPreview(body.preview.text)
        setDirty(false)
        setMessage(t('saved'))
      }, [sessionId, draft, t])

      const startSession = useCallback(() => {
        try {
          const workspace = kit.uiWorkspace
          if (workspace !== undefined && workspace !== null && typeof workspace.startSession === 'function') {
            workspace.startSession(undefined, { agentPreset: PRESET_ID })
            return
          }
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
          return
        }
        setMessage(t('newSessionHint'))
      }, [kit, t])

      /** Manual re-injection: push the current profile to the live agent as a refresh card. */
      const reinjectNow = useCallback(async () => {
        if (sessionId === null) return
        setPreviewLoading(true)
        setError(null)
        setMessage(null)
        const body = await reinject(sessionId)
        setPreviewLoading(false)
        if (body === null || body.ok !== true) {
          setError(String(body && (body.message || body.error) ? body.message || body.error : 'reinject-failed'))
          return
        }
        setMessage(body.message || t('reinjectDone'))
      }, [sessionId, t])

      const badge =
        roleplay === true
          ? el('span', { style: { ...S.badge, ...S.badgeOn } }, t('roleplayBadge'))
          : el('span', { style: S.badge }, t('othersBadge'))

      const tabButton = (id, label) =>
        el(
          'button',
          {
            key: id,
            type: 'button',
            role: 'tab',
            'aria-selected': tab === id ? 'true' : 'false',
            style: tab === id ? { ...S.tab, ...S.tabActive } : S.tab,
            onClick: () => setTab(id),
          },
          label,
        )

      const header = el(
        'div',
        { style: S.header },
        el(
          'div',
          null,
          el('h2', { style: S.heading }, t('title')),
          el('p', { style: S.subtitle }, t('subtitle')),
        ),
        el('div', { style: S.spacer }),
        el(
          'label',
          { style: S.row },
          el('span', { style: S.hint }, t('session')),
          el(
            'select',
            {
              style: S.select,
              value: sessionId ?? '',
              'aria-label': t('session'),
              onChange: (event) => setManualId(event.target.value === '' ? null : event.target.value),
            },
            rows.length === 0 ? el('option', { value: '' }, t('noSession')) : null,
            roleplayRows.map((row) =>
              el('option', { key: row.id, value: row.id }, `◆ ${row.title}`),
            ),
          ),
        ),
        badge,
        el(
          'button',
          { type: 'button', style: S.primary, onClick: startSession, title: t('newSessionHint') },
          t('newSession'),
        ),
        el(
          'button',
          {
            type: 'button',
            style: S.button,
            disabled: saving || dirty,
            title: t('reinjectHint'),
            onClick: () => void reinjectNow(),
          },
          t('reinject'),
        ),
        el('button', { type: 'button', style: S.button, onClick: () => void load(sessionId) }, t('reload')),
        el(
          'button',
          {
            type: 'button',
            style: dirty ? S.primary : { ...S.button, ...S.muted },
            disabled: saving || !dirty || sessionId === null,
            onClick: () => void save(),
          },
          saving ? t('saving') : dirty ? `${t('save')} · ${t('unsaved')}` : t('save'),
        ),
      )

      if (sessionId === null) {
        return el(
          'div',
          { style: S.root },
          header,
          el(
            'div',
            { style: S.body },
            el(
              'div',
              { style: S.notice },
              el('div', { style: S.label }, t('noSession')),
              el('div', { style: { marginTop: '4px' } }, t('noSessionHint')),
            ),
            el('button', { type: 'button', style: S.primary, onClick: startSession }, t('newSession')),
          ),
        )
      }

      const body = loading
        ? el('div', { style: S.body }, el('div', { style: S.empty }, t('loading')))
        : el(
            'div',
            { style: S.body },
            roleplay === false
              ? el(
                  'div',
                  { style: S.notice },
                  el('div', { style: S.label }, t('notRoleplay')),
                  el('div', { style: { marginTop: '4px' } }, t('notRoleplayHint')),
                  el(
                    'div',
                    { style: { marginTop: '8px' } },
                    el('button', { type: 'button', style: S.primary, onClick: startSession }, t('newSession')),
                  ),
                )
              : null,
            message === null ? null : el('div', { style: S.notice }, message),
            error === null ? null : el('div', { style: S.error }, `${t('error')}: ${error}`),
            currentRow === undefined ? null : el('div', { style: S.hint }, `◆ ${currentRow.title} · ${currentRow.id}`),
            el('div', { style: { height: '10px' } }),
            tab === 'persona'
              ? el(PersonaTab, { draft, set, t, disabled: saving })
              : tab === 'memory'
                ? el(MemoryTab, { draft, setMemory, addMemory, removeMemory, t, disabled: saving })
                : el(PromptTab, {
                    draft,
                    set,
                    setRule,
                    t,
                    disabled: saving,
                    preview,
                    previewLoading,
                    refreshPreview: () => void refreshPreview(),
                  }),
          )

      return el(
        'div',
        { style: S.root },
        header,
        el('div', { style: S.tabs, role: 'tablist' }, [
          tabButton('persona', t('tabPersona')),
          tabButton('memory', t('tabMemory')),
          tabButton('prompt', t('tabPrompt')),
        ]),
        body,
      )
    }

    /**
     * The sidebar icon: an open book glyph in currentColor so it follows the
     * selected/active row colour in both themes.
     * @param {object} props - owner props (`size`, `active`).
     */
    function PanelIcon(props) {
      const size = Number(props && props.size) > 0 ? Number(props.size) : 16
      return el(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': 'true' },
        el('path', {
          d: 'M8 3.1c-1.2-.8-2.8-1.2-4.4-1.2H3v10.4h.6c1.6 0 3.2.4 4.4 1.2 1.2-.8 2.8-1.2 4.4-1.2H13V1.9h-.6c-1.6 0-3.2.4-4.4 1.2Zm-.7 8.9c-.9-.4-1.9-.6-2.9-.7V3.2c1.1.1 2.1.4 2.9.9v7.9Zm1.4 0V4.1c.8-.5 1.8-.8 2.9-.9v8.1c-1 .1-2 .3-2.9.7Z',
        }),
      )
    }

    /* ── registration ──────────────────────────────────────────────────── */

    /** Services this client half uses; `uiWorkspace` is read with `ctx.get`. */
    const inject = ['slots', 'locale']

    /**
     * Build the translate function for one resolution of the locale service.
     * @param {object} ctx - browser plugin context.
     * @returns a `t(key, params?)` function with an inline Chinese fallback.
     */
    function makeTranslate(ctx) {
      const fill = (template, params) =>
        params === undefined
          ? template
          : String(template).replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      let fallback = (key, params) => fill(zh[key] ?? key, params)
      try {
        const locale = ctx.get('locale')
        if (locale !== undefined && locale !== null) {
          ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-roleplay: dictionaries')
          const bound = locale.bind(NS)
          return (key, params) => fill(bound(key) ?? key, params)
        }
      } catch (error) {
        console.error('dsh-roleplay: locale registration failed, using inline copy', error)
      }
      return fallback
    }

    /**
     * @param {object} ctx - browser plugin context.
     */
    function apply(ctx) {
      const t = makeTranslate(ctx)
      const kit = { uiWorkspace: ctx.get('uiWorkspace') }

      // Sidebar icon in the panel rail; click selects the matching `main` key.
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 60, locale: NS, label: () => t('nav') },
              PanelIcon,
            ),
          ),
        'dsh-roleplay: sidebar entry',
      )

      // The panel itself, keyed by the same id the rail button selects.
      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ kit }) }, Panel),
          ),
        'dsh-roleplay: main panel',
      )
    }

    return {
      name: 'dsh-roleplay',
      inject,
      apply,
      /** Test-only surface: pure helpers worth asserting without a DOM. */
      __internals: { sessionRows, blankRecord, cloneRecord, KINDS, zh, en },
    }
  },
})
