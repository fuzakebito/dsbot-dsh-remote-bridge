// What a forked child is given of the parent conversation: the text people and Bots said,
// up to the last finished turn. Not a replayable session.
const SPOKEN = ['user', 'bot', 'user-question-reply']
const MAINTENANCE = ['kickoff', 'goal', 'handoff', 'snapshot', 'instructions']   // DS Bot's own messages to a Bot

export function conversationText(events) {
  const finished = events.findLast(event => event.type === 'turn/end')?.seq ?? -1
  const lines = []
  for (const event of events) {
    if (event.seq > finished || event.surfaceOp !== 'append') continue
    const message = event.type === 'user/message' ? event.data : event.type === 'assistant/message' ? event.data.message : undefined
    if (!message) continue
    const source = message.source
    if (message.role === 'user' && (!SPOKEN.includes(source?.kind) || source.handoff || MAINTENANCE.includes(source.role) || MAINTENANCE.includes(source.form))) continue
    const text = message.content.map(block => block.type === 'text' ? block.text : block.type === 'image' || block.type === 'file' ? `[${block.type} not transferred]` : '').filter(Boolean).join('\n')
    if (text) lines.push({ role: message.role, text })
  }
  return lines
}
