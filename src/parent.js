// The parent end: what a Bot may do on a remote DSH, and bringing its children's answers back.
//
// A child is an ordinary session of the remote DSH. For each one the parent remembers which Bot
// conversation started it, how far into its log that conversation has been told (`after`), and
// where in that log the latest message to it went (`sent`).
import { EventEmitter, once } from 'node:events'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { conversationText } from './history.js'
import { Refused, call } from './rpc.js'

export class Parent {
  children = new Map()          // agent_id → { remote, sessionId, label, botId, origin, after, sent, running }
  delivered = new EventEmitter()
  saving = Promise.resolve()
  rounds = new Map()            // remote id → its round of reading, while one is under way
  troubles = new Map()          // remote id → the problem last warned about
  stop = new AbortController()

  constructor({ remotes, keys, identity, readSession, stateFile, warn }) {
    Object.assign(this, { remotes, keys, identity, readSession, stateFile, warn })
  }

  async load() {
    const saved = await readFile(this.stateFile, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error })
    if (saved) this.children = new Map(Object.entries(JSON.parse(saved).children))
  }

  save() {
    const body = JSON.stringify({ children: Object.fromEntries(this.children) }, null, 2)
    return this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(dirname(this.stateFile), { recursive: true })
      await writeFile(`${this.stateFile}.tmp`, body, { mode: 0o600 })
      await rename(`${this.stateFile}.tmp`, this.stateFile)
    })
  }

  // ---- who is asking, and what they may reach

  /** The Bot conversation a tool call comes from: { botId, origin }. Throws outside a Bot's session. */
  caller(exec) { return this.identity.resolveOrigin(exec.agent) }

  remote(id, who) {
    const remote = this.remotes.find(remote => remote.id === id && remote.allowBots.includes(who.botId))
    if (!remote) throw new Error(`No remote DSH "${id}" is available to this Bot`)
    return remote
  }

  child(id, who) {
    const child = this.children.get(id)
    if (child?.botId !== who.botId) throw new Error(`This Bot has no remote child "${id}"`)
    return child
  }

  rpc(remote, method, args, signal) {
    // The Cloudflare Access service token that lets requests through to a remote behind Access.
    const accessToken = remote.accessClientId && remote.accessClientSecret ? { 'CF-Access-Client-Id': remote.accessClientId, 'CF-Access-Client-Secret': remote.accessClientSecret } : {}
    return call(this.keys, remote, method, args, signal, accessToken)
  }

  // ---- what the remote_* tools do

  async instances(_args, exec) {
    const who = await this.caller(exec)
    return this.remotes.filter(remote => remote.allowBots.includes(who.botId)).map(({ id, label = id }) => ({ id, label }))
  }

  async ask(method, { instance_id, workspace_id }, exec) {
    return this.rpc(this.remote(instance_id, await this.caller(exec)), method, { workspaceId: workspace_id }, exec.signal)
  }

  async start(args, exec, { withConversation = false } = {}) {
    const who = await this.caller(exec)
    const remote = this.remote(args.instance_id, who)
    if (args.session_id && args.preset_id) throw new Error('preset_id applies only to a new session')
    let prompt = args.prompt
    if (withConversation) {
      const { events } = await this.readSession(exec.agent.id)
      prompt = `Conversation so far, for reference only:\n${JSON.stringify(conversationText(events))}\n\nYour task:\n${prompt}`
    }
    // A session that is already this Bot's child keeps reporting to the conversation that started it.
    const known = args.session_id && `${remote.id}/${args.session_id}`
    if (this.children.has(known)) return this.send({ agent_id: known, message: prompt }, exec)

    const { sessionId, seq } = await this.rpc(remote, 'start', {
      workspaceId: args.workspace_id, sessionId: args.session_id, presetId: args.preset_id, title: args.description, prompt,
    }, exec.signal)
    const id = `${remote.id}/${sessionId}`
    this.children.set(id, { remote: remote.id, sessionId, label: args.description, ...who, after: seq, sent: seq, running: true })
    await this.save()
    return { agent_id: id, status: 'running' }
  }

  async send({ agent_id, message }, exec) {
    const who = await this.caller(exec)
    const child = this.child(agent_id, who)
    const remote = this.remote(child.remote, who)
    const { seq } = await this.rpc(remote, 'send', { sessionId: child.sessionId, message }, exec.signal)
    // While it was idle nobody followed the session; what it did meanwhile is not this conversation's news.
    if (!child.running) child.after = seq
    Object.assign(child, { sent: seq, running: true })
    await this.save()
    return { agent_id, status: 'running' }
  }

  async list(_args, exec) {
    const who = await this.caller(exec)
    return [...this.children].filter(([, child]) => child.botId === who.botId).map(([id, child]) => this.status(id, child))
  }

  status(id, child) {
    return { agent_id: id, label: child.label, status: child.running ? 'running' : 'idle' }
  }

  /** Returns when the awaited children are idle, when one of them sends a message, or at the timeout. */
  async wait({ agent_ids, mode = 'any', timeout_ms = 30_000 }, exec) {
    const who = await this.caller(exec)
    const ids = agent_ids ?? [...this.children].filter(([, child]) => child.botId === who.botId && child.running).map(([id]) => id)
    const children = ids.map(id => this.child(id, who))
    const report = timedOut => ({ agents: ids.map((id, i) => this.status(id, children[i])), timedOut })
    const timeout = AbortSignal.timeout(timeout_ms)
    for (;;) {
      const idle = children.filter(child => !child.running).length
      if (mode === 'all' ? idle === ids.length : idle > 0 || !ids.length) return report(false)
      if (timeout.aborted) return report(true)
      const news = await once(this.delivered, 'news', { signal: AbortSignal.any([timeout, exec.signal]) }).catch(() => exec.signal.throwIfAborted())
      if (news?.[1] === 'message' && ids.includes(news[0])) return report(false)
    }
  }

  /** Remote tools run in a session the remote keeps for this Bot conversation and workspace. */
  async tools(method, args, exec) {
    const who = await this.caller(exec)
    const result = await this.rpc(this.remote(args.instance_id, who), method, {
      workspaceId: args.workspace_id, name: args.name, arguments: args.arguments,
      conversation: `${who.botId}/${who.origin.roomId ?? 'own'}`,
    }, exec.signal)
    if (result.isError) throw new Error(result.text)
    return result
  }

  // ---- bringing answers back

  async run(intervalMs) {
    const { signal } = this.stop
    while (!signal.aborted) {
      void this.poll()   // not awaited: a remote that does not answer must not hold up the others
      await delay(intervalMs, undefined, { signal }).catch(() => {})
    }
  }

  close() { this.stop.abort() }

  /** Reads what the running children have said since last time, each remote DSH on its own. */
  poll() {
    const remotes = new Set([...this.children.values()].filter(child => child.running).map(child => child.remote))
    return Promise.all([...remotes].map(id => this.round(id)))
  }

  /** A remote has one round under way at a time, shared by its callers, so nothing is delivered twice. */
  round(remoteId) {
    if (!this.rounds.has(remoteId)) this.rounds.set(remoteId, this.catchUpRemote(remoteId).finally(() => this.rounds.delete(remoteId)))
    return this.rounds.get(remoteId)
  }

  async catchUpRemote(remoteId) {
    let trouble
    for (const [id, child] of this.children) {
      if (child.remote === remoteId && child.running) await this.catchUp(id, child).catch(error => { trouble = `Remote child ${id}: ${error.message}` })
    }
    if (this.stop.signal.aborted) return
    if (trouble && trouble !== this.troubles.get(remoteId)) this.warn(trouble)   // once per problem, not once per round
    this.troubles.set(remoteId, trouble)
  }

  async catchUp(id, child) {
    const remote = this.remotes.find(remote => remote.id === child.remote)
    if (!remote) throw new Error(`the remote DSH "${child.remote}" is no longer configured`)
    const news = await this.rpc(remote, 'read', { sessionId: child.sessionId, after: child.after }, AbortSignal.any([this.stop.signal, AbortSignal.timeout(30_000)]))
      .catch(error => {
        if (!(error instanceof Refused)) throw error   // unreachable for now: the next round tries again
        return { items: [{ seq: child.after, type: 'completed', text: `This child can no longer be followed: ${error.message}` }], running: false, end: Infinity }
      })
    for (const item of news.items) {
      // A crash between delivering and saving repeats the delivery after restart; it is never lost.
      await this.identity.deliver({ botId: child.botId, origin: child.origin }, { ...item, agent_id: id, instance_id: child.remote })
      child.after = item.seq
      await this.save()
      this.delivered.emit('news', id, item.type)
    }
    // A reading that ended before our latest message says nothing about the work that message started.
    if (!news.running && news.end > child.sent) {
      child.running = false
      await this.save()
      this.delivered.emit('news', id, 'idle')
    }
  }

  // ---- the right sidebar

  /** The remote sessions to offer in the sidebar of one local session: its conversation's children. */
  shownIn(sessionId) {
    let who
    try { who = this.identity.resolveOrigin({ id: sessionId }) } catch { return [] }   // not a Bot's session
    return this.remotes.filter(remote => remote.webUrl).map(remote => ({
      label: remote.label ?? remote.id,
      webUrl: remote.webUrl,
      sessions: [...this.children.values()]
        .filter(child => child.remote === remote.id && child.botId === who.botId && child.origin.kind === who.origin.kind && child.origin.roomId === who.origin.roomId)
        .map(({ sessionId, label }) => ({ sessionId, label })),
    })).filter(remote => remote.sessions.length)
  }
}

const string = description => ({ type: 'string', description })
const instance = { instance_id: string('A remote DSH, from remote_instances.') }
const workspace = { ...instance, workspace_id: string('A workspace on it, from remote_workspaces.') }
const preset = { preset_id: string("Agent preset of the new session, from remote_presets. The remote DSH's default when omitted.") }
const task = { description: string('Short title for the session.'), prompt: string('What the child should do.') }
const json = value => JSON.stringify(value)

// name → [description, parameters, optional parameter names, what it does, how its result reads]
const TOOLS = {
  remote_instances: ['List the remote DSH instances this Bot may use.', {}, [],
    (parent, args, exec) => parent.instances(args, exec)],
  remote_workspaces: ['List the workspaces this Bot may use on a remote DSH.', instance, [],
    (parent, args, exec) => parent.ask('workspaces', args, exec)],
  remote_presets: ['List the agent presets of a remote DSH.', instance, [],
    (parent, args, exec) => parent.ask('presets', args, exec)],
  remote_sessions: ['List the sessions in a remote workspace.', workspace, [],
    (parent, args, exec) => parent.ask('sessions', args, exec)],
  remote_subagent: ['Give a task to an agent on a remote DSH and return at once. Its progress messages and its final answer arrive later as messages in this conversation.',
    { ...workspace, ...task, session_id: string('Continue this existing session, from remote_sessions, instead of starting a new one.'), ...preset }, ['session_id', 'preset_id'],
    (parent, args, exec) => parent.start(args, exec)],
  remote_subagent_fork: ['Like remote_subagent, in a new session that is also given the text of this conversation so far. Files, images and tool results are not copied.',
    { ...workspace, ...task, ...preset }, ['preset_id'],
    (parent, args, exec) => parent.start(args, exec, { withConversation: true })],
  remote_send_message: ['Send a message to a remote child: it steers the child while it works, and gives it a new task once it is idle.',
    { agent_id: string('A remote child, from remote_subagent or remote_list_agents.'), message: string('What to tell it.') }, [],
    (parent, args, exec) => parent.send(args, exec)],
  remote_list_agents: ["List this Bot's remote children and whether each is running.", {}, [],
    (parent, args, exec) => parent.list(args, exec)],
  remote_wait_subagent: ['Wait for remote children. Returns when one is idle (mode any) or all are (mode all), when one sends a message, or at the timeout. The children keep working either way.',
    { agent_ids: { type: 'array', items: { type: 'string' }, description: 'Children to wait for. Every running child when omitted.' }, mode: { type: 'string', enum: ['any', 'all'] }, timeout_ms: { type: 'integer', minimum: 0, description: 'Defaults to 30000.' } }, ['agent_ids', 'mode', 'timeout_ms'],
    (parent, args, exec) => parent.wait(args, exec)],
  remote_tools: ["List the tools of a remote workspace, or give one tool's full schema. They run on the remote DSH itself, without an agent there.",
    { ...workspace, name: string('Describe only this tool.') }, ['name'],
    (parent, args, exec) => parent.tools('tools', args, exec)],
  remote_call_tool: ['Run one tool from remote_tools on the remote DSH and return its result. Its background jobs stay available to later calls from this conversation. A call that would need a person to approve it fails; give such work to remote_subagent.',
    { ...workspace, name: string('Tool name.'), arguments: { type: 'object', description: "Arguments, following the tool's schema." } }, [],
    (parent, args, exec) => parent.tools('call', args, exec),
    result => result.text],
}

export function registerTools(ctx, parent) {
  for (const [name, [description, properties, optional, run, read = json]] of Object.entries(TOOLS)) {
    ctx.effect(() => ctx.tools.register({
      name,
      description,
      parameters: { type: 'object', properties, required: Object.keys(properties).filter(key => !optional.includes(key)), additionalProperties: false },
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: read(value) }] },
      execute: (args, exec) => run(parent, args, exec),
    }))
  }
}
