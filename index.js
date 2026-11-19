export const name = 'group-chat'
export const inject = ['subagents']

const DEFAULT_MAX_MEMBERS = 8
const MAX_TRANSCRIPT_ENTRIES = 240

const states = new Map()
const latestModelSelection = new Map()

function nowIso() {
  return new Date().toISOString()
}

function ensureState(agentId, cfg) {
  let state = states.get(agentId)
  if (!state) {
    state = {
      captainId: agentId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      maxMembers: cfg.maxMembers,
      members: [],
      transcript: [],
      cursors: { [agentId]: 0 },
      lastCaptainSessionSeq: -1,
    }
    states.set(agentId, state)
  }
  return state
}

function trimTranscript(state) {
  if (state.transcript.length <= MAX_TRANSCRIPT_ENTRIES) return
  const drop = state.transcript.length - MAX_TRANSCRIPT_ENTRIES
  state.transcript.splice(0, drop)
  for (const k of Object.keys(state.cursors)) {
    state.cursors[k] = Math.max(0, (state.cursors[k] ?? 0) - drop)
  }
}

function appendTranscript(state, item) {
  state.transcript.push({
    role: item.role,
    author: item.author,
    text: item.text,
    at: nowIso(),
  })
  trimTranscript(state)
  state.updatedAt = nowIso()
}

function extractTextContent(content) {
  if (!Array.isArray(content)) return ''
  const out = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
  }
  return out.join('\n').trim()
}

function safeSessionEvents(session) {
  try {
    if (!session || !Array.isArray(session.events)) return []
    return session.events
  } catch {
    return []
  }
}

function syncCaptainReplies(state, agent) {
  const events = safeSessionEvents(agent.session)
  if (events.length === 0) return
  let maxSeq = state.lastCaptainSessionSeq
  for (const ev of events) {
    const seq = Number.isInteger(ev?.seq) ? ev.seq : -1
    if (seq <= state.lastCaptainSessionSeq) continue
    if (typeof ev?.type === 'string' && ev.type === 'assistant/message') {
      const text = extractTextContent(ev?.content)
      if (text) appendTranscript(state, { role: 'assistant', author: 'captain', text })
    }
    if (seq > maxSeq) maxSeq = seq
  }
  state.lastCaptainSessionSeq = maxSeq
}

function parseMentionedMember(state, text) {
  if (!text) return undefined
  const lowered = text.toLowerCase()
  for (const m of state.members) {
    if (lowered.includes(`@${m.name.toLowerCase()}`)) return m
  }
  return undefined
}

function collectRecentForMember(state, memberId) {
  const cursor = state.cursors[memberId] ?? 0
  const slice = state.transcript.slice(cursor)
  return slice.map((m) => `${m.role === 'user' ? 'User' : m.author}: ${m.text}`).join('\n')
}

function composeMemberPrompt(state, member, userText) {
  const history = collectRecentForMember(state, member.id)
  return [
    `You are ${member.name}, a member agent in a captain/member group chat.`,
    'Respond as this member only. Be concise and directly answer the user message.',
    '',
    'Shared recent transcript:',
    history || '(empty)',
    '',
    'Current user message:',
    userText,
  ].join('\n')
}

function extractAssistantTextFromResult(result) {
  if (!result || typeof result !== 'object') return ''
  const maybeOutput = result.output
  if (typeof maybeOutput === 'string') return maybeOutput.trim()
  if (Array.isArray(maybeOutput)) {
    const parts = maybeOutput
      .filter(x => x && typeof x === 'object' && x.type === 'text' && typeof x.text === 'string')
      .map(x => x.text)
    return parts.join('\n').trim()
  }
  const maybeText = result.text
  if (typeof maybeText === 'string') return maybeText.trim()
  return ''
}

async function runMemberReply(ctx, payload, state, member, userText) {
  const prompt = composeMemberPrompt(state, member, userText)
  const request = {
    parent: payload.agent,
    label: `member:${member.name}`,
    prompt: [{ type: 'text', text: prompt }],
    signal: payload.signal,
    // DSH subagents expect agentOptions; "model" is ignored by spawn.
    agentOptions: { provider: member.provider, model: member.model },
  }
  const sub = await ctx.subagents.start('spawn', {
    ...request,
  })
  const result = await sub.result
  return extractAssistantTextFromResult(result) || '(member returned no text)'
}

function forceCaptainEmitMemberReply(memberName, replyText) {
  return [
    `Group chat routing result: @${memberName} replied.`,
    'Output exactly the following text and nothing else:',
    '',
    `[@${memberName}] ${replyText}`,
  ].join('\n')
}

function createUserMessage(text, sourceKind = 'group-chat') {
  const source = Object.freeze({ kind: sourceKind })
  const content = Object.freeze([{ type: 'text', text }])
  return Object.freeze({
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: 'user',
    content,
    source,
  })
}

function sanitizeName(name) {
  const n = (name || '').trim().toLowerCase()
  return n.replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function nextMemberName(state) {
  for (let i = 1; i <= 99; i += 1) {
    const candidate = `member-${i}`
    if (!state.members.some(m => m.name === candidate)) return candidate
  }
  return `member-${Math.floor(Math.random() * 10000)}`
}

function latestUserText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!msg || msg.role !== 'user') continue
    const text = extractTextContent(msg.content)
    if (text) return text
  }
  return ''
}

export function apply(ctx, cfg = {}) {
  const config = {
    enabled: cfg.enabled !== false,
    maxMembers: Number.isInteger(cfg.maxMembers) ? Math.max(1, cfg.maxMembers) : DEFAULT_MAX_MEMBERS,
    slashCommand: cfg.slashCommand !== false,
  }
  if (!config.enabled) return

  ctx.on('agent/request', async ({ agent }, next) => {
    const selected = await next()
    if (selected && typeof selected.provider === 'string' && typeof selected.model === 'string') {
      latestModelSelection.set(agent.id, { provider: selected.provider, model: selected.model })
    }
    return selected
  })

  if (config.slashCommand) {
    ctx.inject(['commands'], commandCtx => commandCtx.commands.register({
      name: 'add-agent',
      description: 'Add one member agent into current group chat',
      input: { hint: '[optional-member-name]' },
      handler: ({ agent, rawInput }) => {
        const state = ensureState(agent.id, config)
        if (state.members.length >= state.maxMembers) {
          return { kind: 'error', text: `Member limit reached (${state.maxMembers}).` }
        }
        const requested = sanitizeName(rawInput)
        const memberName = requested || nextMemberName(state)
        if (state.members.some(m => m.name === memberName)) {
          return { kind: 'error', text: `Member "@${memberName}" already exists.` }
        }
        const selection = latestModelSelection.get(agent.id)
        const provider = selection?.provider ?? 'openai'
        const model = selection?.model ?? 'gpt-5'
        const member = {
          id: `${agent.id}:${memberName}`,
          name: memberName,
          provider,
          model,
          createdAt: nowIso(),
        }
        state.members.push(member)
        state.cursors[member.id] = state.transcript.length
        state.updatedAt = nowIso()
        return { kind: 'success', text: `Added @${member.name} (${member.provider}/${member.model}).` }
      },
    }))
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    const state = ensureState(payload.agent.id, config)
    syncCaptainReplies(state, payload.agent)

    const userText = latestUserText(payload.messages)
    if (!userText) return next()
    appendTranscript(state, { role: 'user', author: 'user', text: userText })

    const member = parseMentionedMember(state, userText)
    if (!member) return next()

    const memberReply = await runMemberReply(ctx, payload, state, member, userText)
    appendTranscript(state, { role: 'assistant', author: member.name, text: memberReply })
    state.cursors[member.id] = state.transcript.length

    const decision = await next()
    if (!decision || decision.kind !== 'enter') return decision
    return {
      ...decision,
      messages: [
        ...(Array.isArray(decision.messages) ? decision.messages : []),
        createUserMessage(forceCaptainEmitMemberReply(member.name, memberReply)),
      ],
    }
  })

  ctx.inject(['webServer'], ({ webServer }) => {
    webServer.get('/api/plugins/dsh-group-chat/state', (req, res) => {
      const captainId = typeof req.query?.captainId === 'string' ? req.query.captainId : undefined
      if (captainId) {
        const state = states.get(captainId)
        return res.json({ ok: true, state: state ?? null })
      }
      return res.json({
        ok: true,
        sessions: Array.from(states.values()).map(s => ({
          captainId: s.captainId,
          members: s.members.map(m => ({ id: m.id, name: m.name, provider: m.provider, model: m.model })),
          transcriptSize: s.transcript.length,
          updatedAt: s.updatedAt,
        })),
      })
    })
  })
}

export const __test = Object.freeze({
  sanitizeName,
  parseMentionedMember,
  collectRecentForMember,
  createUserMessage,
  runMemberReply,
})
