/** DS Bot-internal adapter: resolve logical recipients immediately before enqueue. */
export function attachRemoteFacade(rt, { createUserMessage } = {}) {
  if (!createUserMessage) throw new Error('createUserMessage is required');
  function recipient({ botId, origin }) {
    if (!rt.botOf(botId)) throw new Error('Remote result recipient Bot no longer exists');
    if (origin?.kind === 'own') return rt.chatOf(botId);
    if (origin?.kind !== 'group') throw new Error('Unknown remote result origin');
    const room = rt.roomOf(origin.roomId);
    if (!room || !room.members?.includes(botId) || !room.sessions?.[botId]) throw new Error('Remote result group membership no longer exists');
    return room.sessions[botId];
  }
  return {
    resolveOrigin(agent) {
      const sessionId = agent?.session?.header?.id ?? agent?.id;
      if (!rt.isBotSession(sessionId)) throw new Error('Not a current Bot session');
      const botId = rt.selfOf(sessionId);
      if (!rt.botOf(botId)) throw new Error('Unknown Bot');
      const group = rt.groupOwners.get(sessionId);
      return { botId, origin: group ? { kind: 'group', roomId: group.roomId } : { kind: 'own' } };
    },
    async deliver(to, notification) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const sessionId = recipient(to);
        await rt.ensureCapabilities(sessionId);
        const agent = await rt.resolveAgent(sessionId);
        if (recipient(to) !== sessionId) continue;
        // No await between the current-part check and enqueue. A switch afterward
        // follows DS Bot's ordinary pending-input part carry path.
        const source = { kind: 'bot', form: 'relay', role: 'remote-result', exchangeId: `remote:${notification.instance_id ?? ''}:${notification.seq}:${notification.agent_id}`, ...(to.origin.kind === 'group' ? { roomId: to.origin.roomId } : {}) };
        const label = notification.type === 'completed' ? 'Remote child completed' : 'Remote child message';
        agent.followup(createUserMessage({ content: [{ type: 'text', text: `[${label}: ${notification.agent_id}]\n${notification.text ?? ''}${notification.reason ? `\nStatus: ${typeof notification.reason === 'string' ? notification.reason : JSON.stringify(notification.reason)}` : ''}` }], source }));
        await rt.ctx.sessions.flush(agent.session);
        return { delivered: true };
      }
      throw new Error('Recipient part kept changing; remote result remains pending');
    },
  };
}

/** Call from DS Bot apply after createRuntime, not from an unrelated plugin. */
export async function installRemoteFacade(ctx, rt) {
  const [{ Service }, { createUserMessage }] = await Promise.all([import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-llm')]);
  const facade = attachRemoteFacade(rt, { createUserMessage });
  class RemoteBridgeIdentity extends Service {
    constructor(context) {
      super(context, 'remoteBridgeIdentity');
      this.resolveOrigin = facade.resolveOrigin;
      this.deliver = facade.deliver;
    }
  }
  return new RemoteBridgeIdentity(ctx);
}
