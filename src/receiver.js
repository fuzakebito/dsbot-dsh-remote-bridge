// The receiver end: what a caller whose key is accepted may do on this DSH.
//
// A child is an ordinary session of this DSH, created the way its Web UI creates one, so it
// gets this DSH's presets, default model and history. The bridge keeps no state here: what a
// child said is read from the child's own session log.
import { createHash, randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const METHODS = ['workspaces', 'presets', 'sessions', 'start', 'send', 'read', 'tools', 'call']
const TOOL_SESSION = 'bridge-tools-'
const REPORT = {
  name: 'report_to_parent',
  description: 'Send a progress message to the Bot that gave you this task, without ending your turn. Your final answer reaches it automatically.',
  parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'], additionalProperties: false },
  output: { schema: {}, render: () => [{ type: 'text', text: 'Sent.' }] },
  execute: async () => ({}),   // the parent reads the message from this session's log
}

const spoken = blocks => blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')

/**
 * What a child's session log says happened after event `after`: each report it sent and the
 * answer of each turn it finished, in order. `running` tells whether more will follow, and
 * `end` how far this reading saw.
 */
export function newsAfter(events, after, running) {
  const items = []
  const reports = new Map()   // call id → raw arguments of a REPORT call that has not returned yet
  let answer = ''
  let open = false
  for (const { seq, type, data } of events) {
    if (type === 'turn/start') { open = true; answer = '' }
    else if (type === 'turn/end') open = false
    else if (type === 'assistant/message') answer = spoken(data.message.content) || answer
    else if (type === 'tool/call' && data.name === REPORT.name) reports.set(data.callId, data.arguments)
    if (seq <= after) continue
    if (type === 'turn/end') items.push({ seq, type: 'completed', text: answer, reason: data.reason })
    // A report counts once its call succeeded. A model calls the tool directly, or from run_code.
    else if (type === 'tool/result' && !data.message.isError && reports.has(data.message.toolCallId)) items.push({ seq, type: 'message', text: JSON.parse(reports.get(data.message.toolCallId)).message })
    else if (type === 'tool/ptc-dispatch' && !data.isError && data.name === REPORT.name) items.push({ seq, type: 'message', text: data.arguments.message })
  }
  const end = events.at(-1)?.seq ?? -1
  // A turn that never ended and is not running: this DSH stopped in the middle of it.
  if (open && !running && end > after) items.push({ seq: end, type: 'completed', text: answer, reason: { kind: 'interrupted' } })
  return { items, running, end }
}

export class Receiver {
  reporting = new WeakSet()   // agents that already have the REPORT tool

  constructor(ctx) {
    this.ctx = ctx
    // A tool session only runs tools. What wakes it, such as a finished background job, must not start a model turn.
    ctx.on('agent/pre-step', ({ agent }, next) => agent.id.startsWith(TOOL_SESSION) ? { kind: 'reject' } : next(), { prepend: true })
  }

  handle(method, args, peer, signal) {
    if (!METHODS.includes(method)) throw new Error(`This DSH's bridge does not know the request "${method}"`)
    return this[method](peer, args, signal)
  }

  // ---- what a caller may reach

  workspace(peer, id) {
    const workspace = peer.workspaces.includes(id) && this.ctx.workspaceRegistry.get(id)
    if (!workspace) throw new Error(`No workspace "${id}" is available to this caller`)
    return workspace
  }

  owns(peer, sessionId) {
    if (!peer.workspaces.some(id => this.ctx.workspaceRegistry.get(id)?.sessionIds.includes(sessionId))) throw new Error(`No session "${sessionId}" is available to this caller`)
  }

  async agent(sessionId) {
    const found = await this.ctx.sessionController.resolveAgent(sessionId)
    if (found.error) throw new Error(found.error.message)
    return found.agent
  }

  // ---- looking around

  workspaces(peer) {
    return peer.workspaces.map(id => this.ctx.workspaceRegistry.get(id)).filter(Boolean).map(({ id, title, path }) => ({ id, title, path }))
  }

  async presets() {
    const presets = await this.ctx.agentPresets.list()
    return presets.filter(preset => !preset.broken).map(({ id, name, description }) => ({ id, name, description, isDefault: id === this.ctx.agentPresets.defaultId }))
  }

  async sessions(peer, { workspaceId }) {
    const archived = this.ctx.workspaceRegistry.archivedSessionIds
    const ids = this.workspace(peer, workspaceId).sessionIds.filter(id => !archived.includes(id))
    const titles = await this.ctx.sessionQuery.readTitleSnapshots(ids)
    return titles.map(({ sessionId, value }) => ({ id: sessionId, title: value?.title?.title, status: this.ctx.agents.get(sessionId)?.status ?? 'idle' }))
  }

  // ---- children

  async start(peer, { workspaceId, sessionId, presetId, title, prompt }) {
    if (!sessionId) {
      this.workspace(peer, workspaceId);
      ({ sessionId } = await this.ctx.sessionController.create({ workspaceId, agentPreset: presetId }))
      const { session } = await this.agent(sessionId)
      this.ctx.sessionTitle.rename(session, title)
      if (peer.permissionPreset) this.ctx.permissionPresets.set(session, peer.permissionPreset)
    }
    return { sessionId, ...await this.send(peer, { sessionId, message: prompt }) }
  }

  /** Returns the log position just before the message, from which `read` reports what follows. */
  async send(peer, { sessionId, message }) {
    this.owns(peer, sessionId)
    const agent = await this.agent(sessionId)
    if (!this.reporting.has(agent)) {
      this.reporting.add(agent)
      this.ctx.effect(() => agent.ctx.tools.register(REPORT))
    }
    const seq = agent.session.snapshotEvents().at(-1)?.seq ?? -1
    agent.steer(createUserMessage({ content: [{ type: 'text', text: message }], source: { kind: 'user' } }))
    await this.ctx.sessions.flush(agent.session)
    return { seq }
  }

  async read(peer, { sessionId, after }) {
    this.owns(peer, sessionId)
    const live = this.ctx.agents.get(sessionId)
    const events = live ? live.session.snapshotEvents() : (await this.ctx.sessionQuery.readSession(sessionId)).events
    return newsAfter(events, after, live?.status === 'running')
  }

  // ---- tools without an agent

  /** One session per caller, conversation and workspace, so its background jobs and file observations persist between calls. */
  async toolSession(peer, { workspaceId, conversation }) {
    const { path } = this.workspace(peer, workspaceId)
    const id = TOOL_SESSION + createHash('sha256').update(JSON.stringify([peer.publicKey, conversation, workspaceId])).digest('hex').slice(0, 24)
    const found = await this.ctx.sessionController.resolveAgent(id)
    if (found.agent) return found.agent
    await this.ctx.sessionController.create({ cwd: path, sessionId: id })
    const agent = await this.agent(id)
    if (peer.permissionPreset) this.ctx.permissionPresets.set(agent.session, peer.permissionPreset)
    return agent
  }

  async tools(peer, args, signal) {
    const agent = await this.toolSession(peer, args)
    const { tools } = await this.ctx.systemPrompt.assemble({ scope: agent, agent, signal })
    if (!args.name) return tools.map(({ name, description }) => ({ name, description }))
    const tool = tools.find(tool => tool.name === args.name)
    if (!tool) throw new Error(`The remote workspace has no tool "${args.name}"`)
    return tool
  }

  async call(peer, args, signal) {
    const agent = await this.toolSession(peer, args)
    const result = await this.ctx.tools.execute({ agent, callId: randomUUID(), name: args.name, arguments: args.arguments, signal })
    const text = result.content.map(block => block.type === 'text' ? block.text : `[A ${block.type} result stays on the remote DSH]`).join('\n')
    return { isError: result.isError, text, value: result.value }
  }
}
