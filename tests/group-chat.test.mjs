import test from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../index.js'

test('sanitizeName keeps safe chars and lowercases', () => {
  assert.equal(__test.sanitizeName(' Member A_1 '), 'member-a_1')
  assert.equal(__test.sanitizeName('@@bad!!name@@'), 'bad-name')
})

test('parseMentionedMember matches known member by @name', () => {
  const state = { members: [{ id: 'm1', name: 'member-1' }, { id: 'm2', name: 'bot_b' }] }
  assert.equal(__test.parseMentionedMember(state, 'hello @member-1').id, 'm1')
  assert.equal(__test.parseMentionedMember(state, 'ask @BOT_B please').id, 'm2')
  assert.equal(__test.parseMentionedMember(state, 'no mention'), undefined)
})

test('collectRecentForMember returns transcript slice from cursor', () => {
  const state = {
    transcript: [
      { role: 'user', author: 'user', text: 'u1' },
      { role: 'assistant', author: 'captain', text: 'c1' },
      { role: 'user', author: 'user', text: 'u2' },
    ],
    cursors: { m1: 1 },
  }
  assert.equal(__test.collectRecentForMember(state, 'm1'), 'captain: c1\nUser: u2')
})

test('createUserMessage returns identified user message', () => {
  const message = __test.createUserMessage('hello')
  assert.equal(message.role, 'user')
  assert.equal(message.content[0].text, 'hello')
  assert.equal(message.source.kind, 'group-chat')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
})

test('runMemberReply passes pinned provider/model via agentOptions', async () => {
  let captured = undefined
  const ctx = {
    subagents: {
      start: async (_provider, request) => {
        captured = request
        return { result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }] }) }
      },
    },
  }
  const payload = {
    agent: { id: 'captain-1' },
    signal: new AbortController().signal,
  }
  const state = { transcript: [], cursors: {} }
  const member = { id: 'm1', name: 'member-1', provider: 'ghc-local', model: 'gpt-5.6-sol' }
  const reply = await __test.runMemberReply(ctx, payload, state, member, '@member-1 hi')

  assert.equal(reply, 'ok')
  assert.equal(captured.agentOptions.provider, 'ghc-local')
  assert.equal(captured.agentOptions.model, 'gpt-5.6-sol')
  assert.equal(captured.model, undefined)
})
