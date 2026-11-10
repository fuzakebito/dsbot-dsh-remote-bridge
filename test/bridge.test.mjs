// The bridge between two real DSH Hosts: every test goes through the installed DSH services and
// a real HTTP request. Only the model is scripted, and DS Bot is replaced by a small stand-in
// for the one service the bridge needs from it.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Service } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as bridge from '../index.js'
import { Parent } from '../src/parent.js'
import { newsAfter } from '../src/receiver.js'
import { ROUTE, call, loadKeys, serve } from '../src/rpc.js'
import { Settings } from '../src/settings.js'
import { bootHost } from './fixture.mjs'

const listen = (t, handler) => new Promise(resolve => {
  const server = createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  t.after(() => server.close())
})
const tempDir = async t => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-dsh-bridge-'))
  t.after(() => rm(dir, { recursive: true }))
  return dir
}

const until = async (what, done) => {
  for (let i = 0; i < 500; i++) { if (await done()) return; await delay(10) }
  assert.fail(`Timed out waiting for ${what}`)
}
const asked = options => options.messages.findLast(message => message.role === 'user' && message.source.kind === 'user').content[0].text
const answers = options => `answer to: ${asked(options)}`

/** One DSH that is both ends of the bridge: its Bots reach it as the remote "worker". */
async function boot(t, { reply = answers, modelDelayMs, permissionPreset, moreRemotes } = {}) {
  const host = await bootHost({ reply, modelDelayMs })
  t.after(() => host.dispose())
  const { root, home } = host
  const origin = root.webServer.getOrigin()
  const workspace = await root.workspaceRegistry.create(home, 'Work')
  const dataDir = join(home, 'bridge')
  const own = await loadKeys(dataDir)                       // this DSH is both ends, so it accepts its own key
  const another = await loadKeys(join(home, 'another'))     // the key of some other DSH

  // DS Bot's part: which Bot conversation a session is, and delivering a message to one.
  const conversations = new Map()
  const delivered = []
  class Identity extends Service {
    constructor(ctx) { super(ctx, 'remoteBridgeIdentity') }
    resolveOrigin(agent) {
      const who = conversations.get(agent.id)
      if (!who) throw new Error('Not a current Bot session')
      return who
    }
    async deliver(to, notification) { delivered.push({ to, ...notification }) }
  }
  root.plugin(Identity)

  const config = {
    remotes: [
      { id: 'worker', url: origin, publicKey: own.publicKey, allowBots: ['ada', 'bo'], label: 'Worker', webUrl: 'https://worker.example/' },
      { id: 'impostor', url: origin, publicKey: another.publicKey, allowBots: ['ada'] },   // the DSH at this URL is not the one whose key we hold
      ...await moreRemotes?.(own.publicKey) ?? [],
    ],
    accept: [{ publicKey: own.publicKey, workspaces: [workspace.id], permissionPreset, webOrigin: 'https://parent.example' }],
    dataDir,
    pollSeconds: 0.03,
  }
  let plugin = root.plugin(bridge, config)

  /** A Bot's conversation: returns the function its model would use to call a tool. */
  const conversation = async (botId, origin = { kind: 'own' }) => {
    const { sessionId } = await root.sessionController.create({ cwd: home })
    const { agent } = await root.sessionController.resolveAgent(sessionId)
    conversations.set(sessionId, { botId, origin })
    const call = (name, args = {}) => root.tools.execute({ agent, callId: randomUUID(), name, arguments: args, signal: new AbortController().signal })
    const use = async (name, args) => {
      const result = await call(name, args)
      assert.equal(result.isError, false, result.error?.message)
      return result.value
    }
    const fails = async (name, args, pattern) => {
      const result = await call(name, args)
      assert.equal(result.isError, true, `${name} should have failed`)
      assert.match(result.error.message, pattern)
    }
    return { agent, call, use, fails }
  }
  const ada = await conversation('ada')
  const loaded = () => until('the bridge to load', async () => !(await ada.call('remote_instances')).isError)
  await loaded()
  const restart = async () => { await plugin.dispose(); plugin = root.plugin(bridge, config); await loaded() }
  const allIdle = () => until('every child to be idle', async () => (await ada.use('remote_list_agents')).every(agent => agent.status === 'idle'))
  const at = { instance_id: 'worker', workspace_id: workspace.id }
  const task = prompt => ({ ...at, description: 'A task', prompt })
  const childModelCalls = id => host.modelCalls.filter(call => call.sessionId === id.split('/')[1])
  return { host, root, home, origin, workspace, config, conversations, delivered, conversation, ada, at, task, childModelCalls, restart, allIdle }
}

test('a Bot gives a task to a remote agent and receives its answer in its own conversation', async t => {
  const { ada, task, delivered, workspace, root } = await boot(t)
  assert.deepEqual(await ada.use('remote_instances'), [{ id: 'worker', label: 'Worker' }, { id: 'impostor', label: 'impostor' }])
  assert.deepEqual((await ada.use('remote_workspaces', { instance_id: 'worker' })).map(w => w.id), [workspace.id])
  assert.ok((await ada.use('remote_presets', { instance_id: 'worker' })).some(preset => preset.id === 'standard' && preset.isDefault))

  const child = await ada.use('remote_subagent', task('count the files'))
  assert.equal(child.status, 'running')
  const waited = await ada.use('remote_wait_subagent', { agent_ids: [child.agent_id], timeout_ms: 5000 })
  assert.deepEqual(waited, { agents: [{ agent_id: child.agent_id, label: 'A task', status: 'idle' }], timedOut: false })

  assert.equal(delivered.length, 1)
  assert.deepEqual({ ...delivered[0], seq: undefined }, {
    to: { botId: 'ada', origin: { kind: 'own' } }, seq: undefined,
    type: 'completed', text: 'answer to: count the files', reason: { kind: 'completed' }, agent_id: child.agent_id, instance_id: 'worker',
  })
  // The child is an ordinary session of the remote DSH: in the workspace, titled, on the default preset.
  const sessions = await ada.use('remote_sessions', { instance_id: 'worker', workspace_id: workspace.id })
  assert.deepEqual(sessions, [{ id: child.agent_id.split('/')[1], title: 'A task', status: 'idle' }])
  assert.equal(root.agents.get(sessions[0].id).session.header.agentPreset, 'standard')
})

test('progress reports arrive before the answer, whether the child calls tools directly or through run_code', async t => {
  const reply = options => {
    if (options.messages.some(message => message.role === 'tool')) return 'all done'
    return options.tools.some(tool => tool.name === 'run_code')
      ? { call: 'run_code', arguments: { description: 'Report twice', code: "await tools.report_to_parent({ message: 'one' }); await tools.report_to_parent({ message: 'two' })" } }
      : { call: 'report_to_parent', arguments: { message: 'halfway' } }
  }
  const { ada, task, delivered, allIdle } = await boot(t, { reply })
  const direct = await ada.use('remote_subagent', task('work'))
  const viaCode = await ada.use('remote_subagent', { ...task('work'), preset_id: 'ptc' })
  await allIdle()
  const told = id => delivered.filter(d => d.agent_id === id).map(d => [d.type, d.text])
  assert.deepEqual(told(direct.agent_id), [['message', 'halfway'], ['completed', 'all done']])
  assert.deepEqual(told(viaCode.agent_id), [['message', 'one'], ['message', 'two'], ['completed', 'all done']])
})

test('remote_wait_subagent returns early when a child reports', async t => {
  const reply = async options => {
    if (!options.messages.some(message => message.role === 'tool')) return { call: 'report_to_parent', arguments: { message: 'started' } }
    await delay(600, undefined, { signal: options.signal })
    return 'finished'
  }
  const { ada, task } = await boot(t, { reply })
  const child = await ada.use('remote_subagent', task('slow work'))
  const waited = await ada.use('remote_wait_subagent', { agent_ids: [child.agent_id], timeout_ms: 5000 })
  assert.deepEqual(waited.agents.map(agent => agent.status), ['running'])
  assert.equal(waited.timedOut, false)
  assert.equal((await ada.use('remote_wait_subagent', { agent_ids: [child.agent_id], timeout_ms: 20 })).timedOut, true)
})

test('a message to an idle child starts new work; a message to a working child steers it', async t => {
  const { ada, task, delivered } = await boot(t, { modelDelayMs: 150 })
  const child = await ada.use('remote_subagent', task('first'))
  await ada.use('remote_send_message', { agent_id: child.agent_id, message: 'second, while working' })
  await ada.use('remote_wait_subagent', { agent_ids: [child.agent_id], timeout_ms: 5000 })
  assert.deepEqual(delivered.map(d => d.text), ['answer to: second, while working'])

  // Asking right after the send must not report the earlier completion again.
  assert.equal((await ada.use('remote_send_message', { agent_id: child.agent_id, message: 'third' })).status, 'running')
  assert.equal((await ada.use('remote_list_agents'))[0].status, 'running')
  const waited = await ada.use('remote_wait_subagent', { agent_ids: [child.agent_id], timeout_ms: 5000 })
  assert.equal(waited.agents[0].status, 'idle')
  assert.deepEqual(delivered.map(d => d.text), ['answer to: second, while working', 'answer to: third'])

  // remote_subagent on a session that is already this Bot's child continues that child.
  const again = await ada.use('remote_subagent', { ...task('fourth'), session_id: child.agent_id.split('/')[1] })
  assert.equal(again.agent_id, child.agent_id)
})

test('an existing remote session can be adopted, and its answer goes to the conversation that adopted it', async t => {
  const { ada, task, delivered, conversation, root, workspace } = await boot(t)
  const { sessionId } = await root.sessionController.create({ workspaceId: workspace.id, agentPreset: 'ptc' })
  const room = await conversation('ada', { kind: 'group', roomId: 'room-1' })
  const child = await room.use('remote_subagent', { ...task('continue here'), session_id: sessionId })
  assert.equal(child.agent_id, `worker/${sessionId}`)
  await room.fails('remote_subagent', { ...task('x'), session_id: sessionId, preset_id: 'standard' }, /only to a new session/)
  // Another conversation of the same Bot may talk to the child; the answer still goes to the room.
  await ada.use('remote_send_message', { agent_id: child.agent_id, message: 'and this' })
  await ada.use('remote_wait_subagent', { agent_ids: [child.agent_id], timeout_ms: 5000 })
  assert.ok(delivered.length >= 1)
  for (const d of delivered) assert.deepEqual(d.to, { botId: 'ada', origin: { kind: 'group', roomId: 'room-1' } })
  assert.equal(root.agents.get(sessionId).session.header.agentPreset, 'ptc')
})

test('remote_subagent_fork gives the child the conversation so far, as text', async t => {
  const { ada, task, childModelCalls } = await boot(t)
  ada.agent.steer(createUserMessage({ content: [{ type: 'text', text: 'the door is blue' }], source: { kind: 'user' } }))
  await ada.agent.whenIdle()
  const child = await ada.use('remote_subagent_fork', task('paint the frame to match'))
  await ada.use('remote_wait_subagent', { agent_ids: [child.agent_id], timeout_ms: 5000 })
  const prompt = asked(childModelCalls(child.agent_id)[0])
  assert.match(prompt, /^Conversation so far, for reference only:/)
  assert.deepEqual(JSON.parse(prompt.split('\n')[1]), [{ role: 'user', text: 'the door is blue' }, { role: 'assistant', text: 'answer to: the door is blue' }])
  assert.match(prompt, /Your task:\npaint the frame to match$/)
})

test('a Bot reaches only the remotes, workspaces and children it is allowed', async t => {
  const { ada, task, at, conversation, root, home, origin, conversations } = await boot(t)
  const child = await ada.use('remote_subagent', task('mine'))

  const cy = await conversation('cy')   // on no remote's allowBots
  assert.deepEqual(await cy.use('remote_instances'), [])
  await cy.fails('remote_subagent', task('x'), /No remote DSH "worker" is available to this Bot/)

  const bo = await conversation('bo')   // allowed on the remote, but the child is Ada's
  await bo.fails('remote_send_message', { agent_id: child.agent_id, message: 'x' }, /has no remote child/)
  await bo.fails('remote_subagent', { ...task('x'), session_id: child.agent_id.split('/')[1] }, /has no remote child/)
  assert.deepEqual(await bo.use('remote_list_agents'), [])

  const elsewhere = await root.workspaceRegistry.create(join(home, 'sessions'), 'Not shared')
  await ada.fails('remote_subagent', { ...task('x'), workspace_id: elsewhere.id }, /No workspace ".*" is available to this caller/)
  const { sessionId } = await root.sessionController.create({ workspaceId: elsewhere.id })
  await ada.fails('remote_subagent', { ...task('x'), session_id: sessionId }, /No session ".*" is available to this caller/)
  await ada.fails('remote_call_tool', { ...at, workspace_id: elsewhere.id, name: 'bash', arguments: {} }, /No workspace/)

  await ada.fails('remote_workspaces', { instance_id: 'impostor' }, /refused the request: the request is not signed by that key for this DSH/)
  assert.equal((await fetch(origin + ROUTE, { method: 'POST', body: '{}' })).status, 401)

  const outsider = await root.sessionController.create({ cwd: home })   // a session that is no Bot's
  const { agent } = await root.sessionController.resolveAgent(outsider.sessionId)
  const result = await root.tools.execute({ agent, callId: randomUUID(), name: 'remote_instances', arguments: {}, signal: new AbortController().signal })
  assert.match(result.error.message, /Not a current Bot session/)
  assert.equal(conversations.has(outsider.sessionId), false)
})

test('remote tools run on the remote DSH without a model, and keep their state between calls', async t => {
  const { ada, at, home, host, conversation, root } = await boot(t, { permissionPreset: 'danger-full-access' })
  const names = (await ada.use('remote_tools', at)).map(tool => tool.name)
  for (const name of ['bash', 'read', 'write', 'job_output']) assert.ok(names.includes(name), name)
  assert.ok(!names.includes('report_to_parent'))
  assert.deepEqual((await ada.use('remote_tools', { ...at, name: 'bash' })).parameters.required.includes('command'), true)

  const ran = await ada.use('remote_call_tool', { ...at, name: 'bash', arguments: { description: 'Print the directory', command: 'pwd' } })
  assert.equal(ran.value.stdout.text.trim(), home)
  assert.equal(ran.value.sandbox.mode, 'danger-full-access')

  await writeFile(join(home, 'note.txt'), 'remote file')
  assert.match((await ada.use('remote_call_tool', { ...at, name: 'read', arguments: { file_path: join(home, 'note.txt') } })).text, /1: remote file/)

  // A background job started by one call is there for the next, and finishing does not wake a model.
  const job = await ada.use('remote_call_tool', { ...at, name: 'bash', arguments: { description: 'Finish later', command: 'sleep 0.2; echo late', run_in_background: true } })
  await delay(600)
  assert.match((await ada.use('remote_call_tool', { ...at, name: 'job_output', arguments: { job_id: job.value.jobId } })).text, /late/)
  const room = await conversation('ada', { kind: 'group', roomId: 'room-1' })   // another conversation has its own session
  await room.fails('remote_call_tool', { ...at, name: 'job_output', arguments: { job_id: job.value.jobId } }, /./)

  await ada.fails('remote_call_tool', { ...at, name: 'bash', arguments: { description: 'Fail', command: 'exit 3', timeoutMs: 'soon' } }, /./)
  await ada.fails('remote_call_tool', { ...at, name: 'no_such_tool', arguments: {} }, /unknown tool/)
  await ada.fails('remote_tools', { ...at, name: 'no_such_tool' }, /has no tool "no_such_tool"/)
  assert.equal(host.modelCalls.length, 0)
  assert.equal(root.workspaceRegistry.list().flatMap(w => w.sessionIds).length, 0)   // tool sessions are not offered as children
})

test('after the parent restarts it keeps following its children and repeats nothing', async t => {
  const { ada, task, delivered, restart, allIdle } = await boot(t, { modelDelayMs: 300 })
  const first = await ada.use('remote_subagent', task('before the restart'))
  await ada.use('remote_wait_subagent', { agent_ids: [first.agent_id], timeout_ms: 5000 })
  const second = await ada.use('remote_subagent', task('across the restart'))
  await restart()   // while the second child still works
  assert.deepEqual((await ada.use('remote_list_agents')).map(agent => [agent.agent_id, agent.status]), [[first.agent_id, 'idle'], [second.agent_id, 'running']])
  await allIdle()
  assert.deepEqual(delivered.map(d => d.text), ['answer to: before the restart', 'answer to: across the restart'])
})

test('the right sidebar is offered the children of the conversation it is opened in', async t => {
  const { ada, task, conversation, config, root, conversations, allIdle } = await boot(t)
  const room = await conversation('ada', { kind: 'group', roomId: 'room-1' })
  const own = await ada.use('remote_subagent', task('own chat work'))
  await room.use('remote_subagent', { ...task('room work'), description: 'Room task' })
  await allIdle()
  // The list the plugin serves at /api/remote-dsh-bridge.children, read from the same state file.
  const view = new Parent({ remotes: config.remotes, identity: root.remoteBridgeIdentity, stateFile: join(config.dataDir, 'children.json') })
  await view.load()
  const [adaSession, roomSession] = [...conversations.keys()]
  assert.deepEqual(view.shownIn(adaSession), [{ label: 'Worker', webUrl: 'https://worker.example/', sessions: [{ sessionId: own.agent_id.split('/')[1], label: 'A task' }] }])
  assert.deepEqual(view.shownIn(roomSession).flatMap(remote => remote.sessions.map(session => session.label)), ['Room task'])
  assert.deepEqual(view.shownIn('a-session-that-is-no-bots'), [])
})

test('a reading taken before a message cannot mark the child idle', async t => {
  const home = await tempDir(t)
  const parent = new Parent({
    remotes: [{ id: 'worker', url: 'http://unused', allowBots: ['ada'] }],
    identity: { resolveOrigin: () => ({ botId: 'ada', origin: { kind: 'own' } }), deliver: async () => {} },
    stateFile: join(home, 'state.json'),
  })
  parent.children.set('worker/s', { remote: 'worker', sessionId: 's', botId: 'ada', origin: { kind: 'own' }, after: 10, sent: 10, running: true })
  const child = parent.children.get('worker/s')
  // The remote read its log up to event 20 and saw the child idle; our message then went in at 20.
  let answerRead
  parent.rpc = async (_remote, method) => method === 'send' ? { seq: 20 } : new Promise(resolve => { answerRead = resolve })
  const round = parent.poll()
  await until('the read to be under way', () => answerRead)
  await parent.send({ agent_id: 'worker/s', message: 'more' }, { agent: {}, signal: new AbortController().signal })
  answerRead({ items: [{ seq: 20, type: 'completed', text: 'earlier answer' }], running: false, end: 20 })
  await round
  assert.deepEqual({ running: child.running, after: child.after, sent: child.sent }, { running: true, after: 20, sent: 20 })
  // The next reading saw the new work finish.
  parent.rpc = async () => ({ items: [{ seq: 31, type: 'completed', text: 'later answer' }], running: false, end: 31 })
  await parent.poll()
  assert.equal(child.running, false)
})

test('a child whose DSH stopped mid-turn, or whose session is gone, is reported once and no longer followed', async t => {
  const stopped = [
    { seq: 4, type: 'turn/start', data: { turn: 1 } },
    { seq: 9, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'partial' }] } } },
  ]
  assert.deepEqual(newsAfter(stopped, 3, false), { items: [{ seq: 9, type: 'completed', text: 'partial', reason: { kind: 'interrupted' } }], running: false, end: 9 })
  assert.deepEqual(newsAfter(stopped, 9, false), { items: [], running: false, end: 9 })
  assert.deepEqual(newsAfter(stopped, 3, true), { items: [], running: true, end: 9 })
  // A turn that ended before `after` is over, whatever the log records later.
  const ended = [...stopped, { seq: 10, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }, { seq: 11, type: 'job/settled', data: {} }]
  assert.deepEqual(newsAfter(ended, 10, false), { items: [], running: false, end: 11 })
  assert.deepEqual(newsAfter(ended, 3, false).items, [{ seq: 10, type: 'completed', text: 'partial', reason: { kind: 'completed' } }])

  const { ada, task, delivered, config, restart } = await boot(t, { modelDelayMs: 2000 })
  const child = await ada.use('remote_subagent', task('work'))
  config.accept[0].workspaces = []   // the remote's owner withdraws the workspace
  await restart()
  const waited = await ada.use('remote_wait_subagent', { agent_ids: [child.agent_id], timeout_ms: 5000 })
  assert.equal(waited.agents[0].status, 'idle')
  assert.deepEqual(delivered.map(d => [d.type, d.text]), [['completed', `This child can no longer be followed: No session "${child.agent_id.split('/')[1]}" is available to this caller`]])
  await delay(150)   // several more rounds
  assert.equal(delivered.length, 1)
})

const browserSettings = root => root.webServer.collectIndexInjections().find(row => row.name === '__REMOTE_DSH_BRIDGE__').value

test('the Host half tells the browser half what to show', async t => {
  const { root } = await boot(t)
  assert.deepEqual(browserSettings(root), { tab: true, embedders: ['https://parent.example'] })
})

test('installed but not configured, the plugin only prepares its key for the exchange', async t => {
  const host = await bootHost()
  t.after(() => host.dispose())
  const dataDir = join(host.home, 'bridge')
  await host.root.plugin(bridge, { dataDir })
  assert.match(await readFile(join(dataDir, 'key.pub'), 'utf8'), /^[\w-]{43}\n$/)
  assert.equal((await stat(join(dataDir, 'key.pem'))).mode & 0o777, 0o600)
  assert.deepEqual(await loadKeys(dataDir).then(keys => keys.publicKey + '\n'), await readFile(join(dataDir, 'key.pub'), 'utf8'))   // kept, not replaced
  await assert.rejects(async () => host.root.plugin(bridge, { dataDir, accept: [{ publicKey: 'not-a-key', workspaces: [] }] }), /"not-a-key" is not a public key/)
  const remote = { id: 'same', url: 'https://x.example', publicKey: (await loadKeys(dataDir)).publicKey, allowBots: [] }
  await assert.rejects(async () => host.root.plugin(bridge, { dataDir, remotes: [remote, remote] }), /Two remotes share the name "same"/)
  assert.deepEqual(browserSettings(host.root), { tab: false, embedders: [] })
  const { sessionId } = await host.root.sessionController.create({ cwd: host.home })
  const { agent } = await host.root.sessionController.resolveAgent(sessionId)
  const { tools } = await host.root.systemPrompt.assemble({ scope: agent, agent, signal: new AbortController().signal })
  assert.deepEqual(tools.filter(tool => tool.name.startsWith('remote_')), [])
  assert.equal((await fetch(host.root.webServer.getOrigin() + ROUTE, { method: 'POST', body: '{}' })).status, 404)
})

test('a request cannot come from a stranger, be sent again or elsewhere, or be answered by anyone else', async t => {
  const dir = await tempDir(t)
  const [parent, child, otherChild, stranger] = await Promise.all(['parent', 'child', 'other', 'stranger'].map(name => loadKeys(join(dir, name))))
  const listen = handler => new Promise(resolve => {
    const server = createServer(handler).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
    t.after(() => server.close())
  })
  const echo = { handle: async (method, args) => ({ method, args }) }
  const childUrl = await listen(serve(echo, child, [{ publicKey: parent.publicKey }]))
  const otherUrl = await listen(serve(echo, otherChild, [{ publicKey: parent.publicKey }]))   // also accepts this parent

  // Someone on the path between the two: sees every request, and can change the answer.
  let seen
  let change = answer => answer
  const pathUrl = await listen(async (request, response) => {
    const { 'x-bridge-from': from, 'x-bridge-time': time, 'x-bridge-signature': signature, 'content-type': type } = request.headers
    seen = { method: 'POST', headers: { 'x-bridge-from': from, 'x-bridge-time': time, 'x-bridge-signature': signature, 'content-type': type }, body: await text(request) }
    const answer = await fetch(childUrl + ROUTE, seen)
    response.writeHead(answer.status, { 'x-bridge-signature': answer.headers.get('x-bridge-signature') }).end(change(await answer.text()))
  })
  const refusal = async response => [response.status, await response.text()]

  assert.deepEqual(await call(parent, { url: pathUrl, publicKey: child.publicKey }, 'echo', { n: 1 }), { method: 'echo', args: { n: 1 } })
  assert.deepEqual(await refusal(await fetch(childUrl + ROUTE, seen)), [401, 'this request was already received'])
  assert.deepEqual(await refusal(await fetch(otherUrl + ROUTE, seen)), [401, 'the request is not signed by that key for this DSH'])
  assert.deepEqual(await refusal(await fetch(childUrl + ROUTE, { ...seen, body: seen.body.replace('"n":1', '"n":2') })), [401, 'the request is not signed by that key for this DSH'])
  await assert.rejects(call(stranger, { url: childUrl, publicKey: child.publicKey }, 'echo', {}), /refused the request: this key is not accepted here/)

  change = answer => answer.replace('"n":1', '"n":2')
  await assert.rejects(call(parent, { url: pathUrl, publicKey: child.publicKey }, 'echo', { n: 1 }), /did not answer with the remote DSH's key/)
  change = answer => answer
  // The other child is a real bridge, but not the one this parent means to talk to.
  await assert.rejects(call(parent, { url: otherUrl, publicKey: child.publicKey }, 'echo', {}), /not signed by that key for this DSH/)

  // A request held back and delivered late, even one never seen before.
  await call(parent, { url: pathUrl, publicKey: child.publicKey }, 'echo', { n: 3 })
  const held = seen
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 6 * 60_000 })
  assert.deepEqual(await refusal(await fetch(otherUrl + ROUTE, held)), [401, 'the clocks of the two DSH differ by more than five minutes'])
})

test('one parent works with several remote DSH, and one that stops answering does not hold up the others', async t => {
  const builder = await bootHost({ reply: options => `built: ${asked(options)}`, modelDelayMs: 300 })
  t.after(() => builder.dispose())
  const builderOrigin = builder.root.webServer.getOrigin()
  const builderWorkspace = await builder.root.workspaceRegistry.create(builder.home, 'Build')
  // The path to the builder, which can stop letting requests through.
  let open = Promise.resolve()
  let reopen
  const pathUrl = await listen(t, async (request, response) => {
    const { 'x-bridge-from': from, 'x-bridge-time': time, 'x-bridge-signature': signature, 'content-type': type } = request.headers
    const body = await text(request)
    await open
    const answer = await fetch(builderOrigin + ROUTE, { method: 'POST', headers: { 'x-bridge-from': from, 'x-bridge-time': time, 'x-bridge-signature': signature, 'content-type': type }, body })
    response.writeHead(answer.status, { 'x-bridge-signature': answer.headers.get('x-bridge-signature') ?? '' }).end(await answer.text())
  })
  const { ada, task, delivered, allIdle } = await boot(t, { moreRemotes: async parentKey => {
    const dataDir = join(builder.home, 'bridge')
    await builder.root.plugin(bridge, { dataDir, accept: [{ publicKey: parentKey, workspaces: [builderWorkspace.id] }] })
    await until('the builder to serve the bridge', async () => (await fetch(builderOrigin + ROUTE, { method: 'POST' })).status === 401)
    return [{ id: 'builder', url: pathUrl, publicKey: (await loadKeys(dataDir)).publicKey, allowBots: ['ada'] }]
  } })
  const onBuilder = { instance_id: 'builder', workspace_id: builderWorkspace.id }

  assert.deepEqual((await ada.use('remote_instances')).map(remote => remote.id), ['worker', 'impostor', 'builder'])
  assert.deepEqual((await ada.use('remote_workspaces', { instance_id: 'builder' })).map(w => w.id), [builderWorkspace.id])
  const built = await ada.use('remote_subagent', { ...onBuilder, description: 'Build', prompt: 'the build' })
  open = new Promise(resolve => { reopen = resolve })   // the builder stops answering

  const worked = await ada.use('remote_subagent', task('the work'))
  await ada.use('remote_wait_subagent', { agent_ids: [worked.agent_id], timeout_ms: 5000 })
  assert.deepEqual(delivered.map(d => [d.instance_id, d.text]), [['worker', 'answer to: the work']])
  assert.deepEqual((await ada.use('remote_list_agents')).map(agent => [agent.agent_id, agent.status]), [[built.agent_id, 'running'], [worked.agent_id, 'idle']])

  reopen()
  await allIdle()
  assert.deepEqual(delivered.map(d => [d.instance_id, d.text]), [['worker', 'answer to: the work'], ['builder', 'built: the build']])
  assert.equal(builder.modelCalls.length, 1)   // the build ran on the builder, and only there

  const ran = await ada.use('remote_call_tool', { ...onBuilder, name: 'bash', arguments: { description: 'Print the directory', command: 'pwd' } })
  assert.equal(ran.value.stdout.text.trim(), builder.home)
})

test('the settings form is given names to choose from, and saves only what would load', async t => {
  const { root, config, workspace } = await boot(t)
  // DSH's configEditor needs a real profile directory; this stands in for it and keeps what was saved.
  const owner = {}
  let saved
  const configEditor = { entries: () => [{ fiber: {} }, { fiber: owner }], edit: async (entry, change) => { assert.equal(entry.fiber, owner); saved = change({ dataDir: config.dataDir, pollSeconds: 5 }) } }
  const ctx = Object.create(root, { configEditor: { value: configEditor } })
  const settings = new Settings(ctx, { owner, config, publicKey: 'this-dsh-key', check: bridge.check })

  const shown = settings.read()
  assert.equal(shown.publicKey, 'this-dsh-key')
  assert.deepEqual(shown.workspaces, [{ id: workspace.id, title: 'Work', path: workspace.path }])
  assert.deepEqual(shown.permissionPresets, ['workspace-write', 'danger-full-access'])
  assert.deepEqual([shown.remotes, shown.accept], [config.remotes, config.accept])

  const remote = { id: 'new', url: 'https://new.example', publicKey: config.remotes[0].publicKey, allowBots: ['ada'] }
  await settings.save({ remotes: [remote], accept: [] })
  assert.deepEqual(saved, { dataDir: config.dataDir, pollSeconds: 5, remotes: [remote], accept: [] })   // the other settings are kept
  bridge.Config(saved)

  saved = undefined
  await assert.rejects(settings.save({ remotes: [{ ...remote, publicKey: 'pasted wrong' }], accept: [] }), /"pasted wrong" is not a public key/)
  await assert.rejects(settings.save({ remotes: [{ ...remote, url: 'new.example' }], accept: [] }), /"new.example" is not a URL/)
  await assert.rejects(settings.save({ remotes: [remote, remote], accept: [] }), /Two remotes share the name "new"/)
  await assert.rejects(settings.save({ remotes: [{ ...remote, id: '' }], accept: [] }), /A remote needs a name/)
  assert.equal(saved, undefined)
})

test('the browser half registers its settings form under the row the package declares', async t => {
  let plugin
  globalThis.window = { __ModuleLoader__: { load: module => { plugin = module } } }
  window.parent = window
  t.after(() => { delete globalThis.window })
  await import('../client.js')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const [, rowId] = /- id: (\S+)/.exec(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
  assert.equal(plugin.id, manifest.name)

  const registered = []
  const ctx = {
    effect: run => run(),
    inject: (_services, use) => use(ctx),
    locale: { register: () => {}, bind: () => key => key },
    slots: { inject: (_name, use) => use(), register: (entry, component) => registered.push({ ...entry, component }) },
  }
  plugin.factory(() => ({ createElement: () => ({}) })).apply(ctx)
  const form = registered.find(entry => entry.name === 'plugins.row.config')
  assert.equal(form.key, `${manifest.name}#${rowId}`)
  assert.equal(form.component({ view: 'summary', t: key => key }), 'summary')
})
