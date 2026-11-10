// One plugin for both ends of the bridge. `remotes` makes this DSH a parent: its Bots get
// the remote_* tools. `accept` makes it a receiver: it serves those tools' requests.
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Parent, registerTools } from './src/parent.js'
import { Receiver } from './src/receiver.js'
import { ROUTE, keyOf, loadKeys, serve } from './src/rpc.js'
import { Settings } from './src/settings.js'

export const name = 'remote-dsh-bridge'

const publicKey = whose => z.string().required().description(`Public key of ${whose}: the line in its key.pub.`)

export const Config = z.object({
  remotes: z.array(z.object({
    id: z.string().required(),
    url: z.string().required().description('Base URL of the remote DSH as this host reaches it. Use https beyond this machine.'),
    publicKey: publicKey('the remote DSH'),
    allowBots: z.array(z.string()).required().description('Stable IDs of the Bots that may use this remote.'),
    label: z.string(),
    webUrl: z.string().description('Browser URL of the remote DSH, shown in the right sidebar.'),
  })).default([]),
  accept: z.array(z.object({
    publicKey: publicKey('the calling DSH'),
    workspaces: z.array(z.string()).required().description('IDs of the workspaces this caller may work in.'),
    permissionPreset: z.string().description('Permission preset of the sessions this caller creates. The DSH default when omitted.'),
    webOrigin: z.string().description("Origin of the caller's web UI, which may embed this DSH and choose the session it shows."),
  })).default([]),
  dataDir: z.string().description("Where this DSH's key pair and a parent's list of children are kept. Defaults to remote-dsh-bridge in the DSH home."),
  pollSeconds: z.number().default(2),
})

/** What the schema cannot say. A mistake here should stop a save or a load, not the first request. */
export function check({ remotes, accept }) {
  for (const end of [...remotes, ...accept]) keyOf(end.publicKey)
  for (const remote of remotes) {
    if (!remote.id) throw new Error('A remote needs a name')
    if (!URL.canParse(remote.url)) throw new Error(`"${remote.url}" is not a URL`)
  }
  const ids = remotes.map(remote => remote.id)
  if (new Set(ids).size < ids.length) throw new Error(`Two remotes share the name "${ids.find((id, i) => ids.indexOf(id) < i)}"`)
}

export async function apply(ctx, config) {
  check(config)
  const dataDir = config.dataDir ?? join(resolveDshHome(), 'remote-dsh-bridge')
  // Created before anything is configured: the other end needs this DSH's key.pub first.
  const keys = await loadKeys(dataDir)

  if (config.remotes.length) {
    // remoteBridgeIdentity is DS Bot's: it names the Bot behind a session and delivers to its conversation.
    ctx.inject(['remoteBridgeIdentity', 'tools', 'sessionQuery', 'connection'], async c => {
      const parent = new Parent({
        remotes: config.remotes,
        keys,
        identity: c.remoteBridgeIdentity,
        readSession: id => c.sessionQuery.readSession(id),
        stateFile: join(dataDir, 'children.json'),
        warn: message => c.logger.warn(message),
      })
      await parent.load()
      registerTools(c, parent)
      c.connection.fetch.register({
        path: '/api/remote-dsh-bridge.children',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async request => Response.json(parent.shownIn(new URL(request.url).searchParams.get('sessionId'))),
      })
      c.effect(() => {
        void parent.run(config.pollSeconds * 1000)
        return () => parent.close()
      })
    })
  }

  if (config.accept.length) {
    ctx.inject(['webServer', 'sessionController', 'sessions', 'sessionQuery', 'sessionTitle', 'workspaceRegistry', 'agents', 'agentPresets', 'permissionPresets', 'systemPrompt', 'tools'], c => {
      for (const peer of config.accept) if (peer.permissionPreset) c.permissionPresets.resolve(peer.permissionPreset)
      c.effect(() => c.webServer.register({ kind: 'exact', path: ROUTE, handler: serve(new Receiver(c), keys, config.accept) }))
    })
  }

  // The settings form in the Plugins page.
  ctx.inject(['connection', 'configEditor', 'workspaceRegistry', 'permissionPresets'], c => {
    const settings = new Settings(c, { owner: ctx.fiber, config, publicKey: keys.publicKey, check })
    c.connection.fetch.register({
      path: '/api/remote-dsh-bridge.settings',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async request => {
        if (request.method === 'GET') return Response.json(settings.read())
        try {
          await settings.save(await request.json())
          return Response.json({ ok: true })
        } catch (error) {
          return Response.json({ ok: false, error: error.message })
        }
      },
    })
  })

  // The browser half gets no config of its own; this is all its sidebar tab needs to know.
  ctx.inject(['webServer'], c => {
    c.on('webserver/index-inject', table => table.push({
      kind: 'global',
      name: '__REMOTE_DSH_BRIDGE__',
      value: { tab: config.remotes.length > 0, embedders: config.accept.map(peer => peer.webOrigin).filter(Boolean) },
    }))
  })
}
