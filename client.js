// The browser half. In the Plugins page it is this plugin's settings form. On a parent it adds
// a "Remote DSH" tab to the right sidebar, which embeds the remote DSH and asks it to show one
// of the conversation's children. On a remote DSH it answers that request.
window.__ModuleLoader__.load({
  id: 'dsbot-dsh-remote-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ID = 'dsbot-dsh-remote-bridge'
    const NS = 'remote-dsh-bridge'
    const READY = 'remote-dsh-bridge/ready'
    const OPEN = 'remote-dsh-bridge/open'
    const SETTINGS = 'api/remote-dsh-bridge.settings'
    const TEXT = {
      en: {
        title: 'Remote DSH', loading: 'Loading…', none: 'This conversation has no remote sessions yet.', choose: 'Choose a session…', reload: 'Reload the list', newTab: 'Open in a new tab',
        summary: 'Connect this DSH with other DSH: which ones its Bots may use, and which may use it.',
        loadFailed: 'The settings could not be loaded. Reload the page.',
        ownKey: 'Public key of this DSH', ownKeyHelp: 'Give this to the other DSH. It is not a secret.', copy: 'Copy', copied: 'Copied',
        remotes: 'DSH that the Bots here may use', remotesHelp: 'Each one must list this DSH\'s public key under "DSH that may use this one".',
        needsDsBot: 'This DSH has no DS Bot, so it has no Bots that could use another DSH. It can still be used by others, below.',
        addRemote: 'Add a DSH', name: 'Name', nameHelp: 'Bots choose the DSH by this name.',
        url: 'URL', urlHelp: 'As this computer reaches it. Use https beyond this computer.',
        theirKey: 'Its public key', bots: 'Bots that may use it', label: 'Display name (optional)',
        webUrl: 'URL of its screen (optional)', webUrlHelp: 'Shows its sessions in the right sidebar.',
        accessId: 'Cloudflare Access: Client ID (optional)', accessIdHelp: 'Of a service token, when the DSH is behind Cloudflare Access.',
        accessSecret: 'Cloudflare Access: name of the credential holding the Client Secret', accessSecretHelp: 'Store the secret itself under Settings → Plugin configuration → Environment variables / secrets, and write only its name here.',
        accept: 'DSH that may use this one', acceptHelp: 'Whoever holds the matching private key can run agents and tools in the chosen workspaces.',
        addPeer: 'Add a DSH', workspaces: 'Workspaces it may use', permission: 'Permissions of the sessions it creates', dshDefault: 'This DSH\'s default',
        webOrigin: 'Address of its screen (optional)', webOriginHelp: 'Lets that screen show this DSH in its right sidebar. Example: https://parent.example',
        remove: 'Remove', missing: 'no longer exists', save: 'Save', saving: 'Saving…', saved: 'Saved.',
      },
      ja: {
        title: 'リモートDSH', loading: '読み込み中…', none: 'この会話にはまだリモートのセッションがありません。', choose: 'セッションを選択…', reload: '一覧を再読み込み', newTab: '新しいタブで開く',
        summary: 'この DSH をほかの DSH とつなぎます。ここの Bot が使える DSH と、この DSH を使える DSH を設定します。',
        loadFailed: '設定を読み込めませんでした。ページを再読み込みしてください。',
        ownKey: 'この DSH の公開鍵', ownKeyHelp: '相手の DSH に渡してください。秘密ではありません。', copy: 'コピー', copied: 'コピーしました',
        remotes: 'ここの Bot が使える DSH', remotesHelp: '相手側の「この DSH を使える DSH」に、この DSH の公開鍵を登録しておく必要があります。',
        needsDsBot: 'この DSH には DS Bot がないので、ほかの DSH を使う Bot がいません。下の欄で、ほかの DSH から使われる側にはなれます。',
        addRemote: 'DSH を追加', name: '名前', nameHelp: 'Bot はこの名前で DSH を選びます。',
        url: 'URL', urlHelp: 'このコンピューターから届くアドレス。別のコンピューターなら https にします。',
        theirKey: '相手の公開鍵', bots: '使ってよい Bot', label: '表示名（省略可）',
        webUrl: '相手の画面の URL（省略可）', webUrlHelp: '相手のセッションを右サイドバーに表示します。',
        accessId: 'Cloudflare Access: Client ID（省略可）', accessIdHelp: '相手が Cloudflare Access の内側にある場合に、サービストークンの Client ID を入れます。',
        accessSecret: 'Cloudflare Access: Client Secret を入れた資格情報の名前', accessSecretHelp: 'シークレットの値は 設定 → プラグイン設定 → 環境変数 / 秘密管理 に登録し、ここにはその名前だけを書きます。',
        accept: 'この DSH を使える DSH', acceptHelp: '対応する秘密鍵を持つ相手は、選んだワークスペースでエージェントとツールを動かせます。',
        addPeer: 'DSH を追加', workspaces: '使わせるワークスペース', permission: '相手が作るセッションの権限', dshDefault: 'この DSH の既定',
        webOrigin: '相手の画面のアドレス（省略可）', webOriginHelp: '相手の画面の右サイドバーに、この DSH を表示できるようにします。例: https://parent.example',
        remove: '削除', missing: '存在しません', save: '保存', saving: '保存中…', saved: '保存しました。',
      },
    }
    // Written into the page by the Host half (index.js); absent until the first reload after installing.
    const { tab, embedders = [] } = globalThis.__REMOTE_DSH_BRIDGE__ ?? {}

    /** The remote DSH in a frame. Once it has loaded and listens, it is asked to show the session. */
    function Embedded({ webUrl, title, sessionId }) {
      const frame = React.useRef(null)
      const [ready, setReady] = React.useState(false)
      const origin = new URL(webUrl).origin
      React.useEffect(() => {
        const onMessage = event => {
          if (event.source === frame.current.contentWindow && event.origin === origin && event.data?.type === READY) setReady(true)
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])
      React.useEffect(() => {
        if (ready) frame.current.contentWindow.postMessage({ type: OPEN, sessionId }, origin)
      }, [ready, sessionId])
      return h('iframe', { ref: frame, src: webUrl, title, style: { flex: 1, border: 0 } })
    }

    function RemoteTab({ sessionId, t }) {
      const [remotes, setRemotes] = React.useState()
      const [reloads, setReloads] = React.useState(0)
      const [chosen, setChosen] = React.useState('')   // "<remote web URL> <remote session id>"

      React.useEffect(() => {
        const stop = new AbortController()
        fetch('api/remote-dsh-bridge.children?sessionId=' + encodeURIComponent(sessionId), { signal: stop.signal })
          .then(response => response.json())
          .then(setRemotes, () => stop.signal.aborted || setRemotes([]))
        return () => stop.abort()
      }, [sessionId, reloads])

      if (!remotes?.length) return h('p', { style: { padding: 12 } }, t(remotes ? 'none' : 'loading'))
      const [webUrl, remoteSession] = chosen.split(' ')
      const remote = remotes.find(remote => remote.webUrl === webUrl)
      return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
        h('div', { style: { display: 'flex', gap: 8, padding: 8, alignItems: 'center' } },
          h('select', { value: chosen, onChange: event => setChosen(event.target.value), style: { flex: 1, minWidth: 0 } },
            h('option', { value: '' }, t('choose')),
            remotes.map(remote => h('optgroup', { key: remote.webUrl, label: remote.label },
              remote.sessions.map(session => h('option', { key: session.sessionId, value: remote.webUrl + ' ' + session.sessionId }, session.label))))),
          h('button', { type: 'button', title: t('reload'), onClick: () => setReloads(reloads + 1) }, '↻'),
          remote && h('a', { href: remote.webUrl, target: '_blank', rel: 'noreferrer' }, t('newTab'))),
        // Keyed by remote: another remote is another frame, which starts out not ready.
        remote && h(Embedded, { key: remote.webUrl, webUrl: remote.webUrl, title: remote.label, sessionId: remoteSession }))
    }

    // ---- the settings form

    const dim = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }
    const control = { width: '100%', boxSizing: 'border-box', padding: '6px 8px', color: 'inherit', font: 'inherit', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6 }
    const card = { display: 'grid', gap: 10, padding: 12, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8 }
    const button = { ...control, width: 'auto', cursor: 'pointer' }

    const Field = ({ label, help, children }) => h('label', { style: { display: 'grid', gap: 4 } },
      h('span', null, label), children, help && h('span', { style: dim }, help))
    const Text = ({ value, onChange, placeholder }) => h('input', { type: 'text', value: value ?? '', placeholder, spellCheck: false, onChange: event => onChange(event.target.value), style: control })

    /** Choose among things by name; the setting itself holds their IDs. */
    function Choices({ label, options, chosen, onChange, missing }) {
      // An ID in the setting whose thing is gone stays visible, so it can be seen and unticked.
      const all = [...options, ...chosen.filter(id => !options.some(option => option.id === id)).map(id => ({ id, name: id + ' (' + missing + ')' }))]
      return h('fieldset', { style: { border: 0, padding: 0, margin: 0, display: 'grid', gap: 4 } },
        h('legend', { style: { padding: 0, marginBottom: 4 } }, label),
        all.map(option => h('label', { key: option.id, style: { display: 'flex', gap: 6, alignItems: 'center' } },
          h('input', { type: 'checkbox', checked: chosen.includes(option.id), onChange: event => onChange(event.target.checked ? [...chosen, option.id] : chosen.filter(id => id !== option.id)) }),
          option.name)))
    }

    function Section({ title, help, children }) {
      return h('section', { style: { display: 'grid', gap: 10 } }, h('h3', { style: { margin: 0, fontSize: 14 } }, title), help && h('span', { style: dim }, help), children)
    }

    function SettingsForm({ t }) {
      const [info, setInfo] = React.useState()       // what the Host says: this DSH's key and the names to choose from
      const [draft, setDraft] = React.useState()     // { remotes, accept } as edited
      const [status, setStatus] = React.useState()   // undefined | 'loadFailed' | 'saving' | 'saved' | { error }
      const [copied, setCopied] = React.useState(false)

      React.useEffect(() => {
        // The Bots' names come from DS Bot, the way its own screen reads them; null on a DSH without DS Bot.
        const bots = fetch('api/bot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'state' }) })
          .then(response => response.json()).then(reply => reply.value.bots.map(({ id, name }) => ({ id, name }))).catch(() => null)
        Promise.all([fetch(SETTINGS).then(response => response.json()), bots]).then(([info, bots]) => {
          setInfo({ ...info, bots })
          setDraft({ remotes: info.remotes, accept: info.accept })
        }, () => setStatus('loadFailed'))
      }, [])

      if (status === 'loadFailed') return h('p', null, t('loadFailed'))
      if (!draft) return h('p', null, t('loading'))

      const edit = (list, index, change) => {
        setDraft({ ...draft, [list]: draft[list].map((row, i) => i === index ? { ...row, ...change } : row) })
        setStatus()
      }
      const add = (list, row) => { setDraft({ ...draft, [list]: [...draft[list], row] }); setStatus() }
      const remove = (list, index) => { setDraft({ ...draft, [list]: draft[list].filter((_, i) => i !== index) }); setStatus() }
      const save = async () => {
        setStatus('saving')
        // An optional field left empty is left out, so the Host's default applies.
        const filled = rows => rows.map(row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== '')))
        const reply = await fetch(SETTINGS, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remotes: filled(draft.remotes), accept: filled(draft.accept) }) })
          .then(response => response.json(), error => ({ error: error.message }))
        setStatus(reply.ok ? 'saved' : { error: reply.error })
      }
      const removeButton = (list, index) => h('button', { type: 'button', style: { ...button, justifySelf: 'start' }, onClick: () => remove(list, index) }, t('remove'))

      return h('div', { style: { display: 'grid', gap: 24, maxWidth: 640 } },
        h(Section, { title: t('ownKey'), help: t('ownKeyHelp') },
          h('div', { style: { display: 'flex', gap: 8 } },
            h('input', { type: 'text', readOnly: true, value: info.publicKey, onFocus: event => event.target.select(), style: { ...control, fontFamily: 'monospace' } }),
            h('button', { type: 'button', style: button, onClick: () => navigator.clipboard.writeText(info.publicKey).then(() => setCopied(true)) }, t(copied ? 'copied' : 'copy')))),

        h(Section, { title: t('remotes'), help: info.bots ? t('remotesHelp') : t('needsDsBot') },
          info.bots && draft.remotes.map((remote, i) => h('div', { key: i, style: card },
            h(Field, { label: t('name'), help: t('nameHelp') }, h(Text, { value: remote.id, onChange: id => edit('remotes', i, { id }) })),
            h(Field, { label: t('url'), help: t('urlHelp') }, h(Text, { value: remote.url, placeholder: 'https://', onChange: url => edit('remotes', i, { url }) })),
            h(Field, { label: t('theirKey') }, h(Text, { value: remote.publicKey, onChange: publicKey => edit('remotes', i, { publicKey: publicKey.trim() }) })),
            h(Choices, { label: t('bots'), options: info.bots, chosen: remote.allowBots, missing: t('missing'), onChange: allowBots => edit('remotes', i, { allowBots }) }),
            h(Field, { label: t('label') }, h(Text, { value: remote.label, onChange: label => edit('remotes', i, { label }) })),
            h(Field, { label: t('webUrl'), help: t('webUrlHelp') }, h(Text, { value: remote.webUrl, placeholder: 'https://', onChange: webUrl => edit('remotes', i, { webUrl }) })),
            h(Field, { label: t('accessId'), help: t('accessIdHelp') }, h(Text, { value: remote.accessClientId, onChange: accessClientId => edit('remotes', i, { accessClientId: accessClientId.trim() }) })),
            h(Field, { label: t('accessSecret'), help: t('accessSecretHelp') }, h(Text, { value: remote.accessClientSecretRef, placeholder: 'WORKER_ACCESS_SECRET', onChange: accessClientSecretRef => edit('remotes', i, { accessClientSecretRef: accessClientSecretRef.trim() }) })),
            removeButton('remotes', i))),
          info.bots && h('button', { type: 'button', style: { ...button, justifySelf: 'start' }, onClick: () => add('remotes', { id: '', url: '', publicKey: '', allowBots: [] }) }, t('addRemote'))),

        h(Section, { title: t('accept'), help: t('acceptHelp') },
          draft.accept.map((peer, i) => h('div', { key: i, style: card },
            h(Field, { label: t('theirKey') }, h(Text, { value: peer.publicKey, onChange: publicKey => edit('accept', i, { publicKey: publicKey.trim() }) })),
            h(Choices, { label: t('workspaces'), options: info.workspaces.map(({ id, title, path }) => ({ id, name: title + ' — ' + path })), chosen: peer.workspaces, missing: t('missing'), onChange: workspaces => edit('accept', i, { workspaces }) }),
            h(Field, { label: t('permission') },
              h('select', { value: peer.permissionPreset ?? '', onChange: event => edit('accept', i, { permissionPreset: event.target.value }), style: control },
                h('option', { value: '' }, t('dshDefault')),
                [...new Set([...info.permissionPresets, ...(peer.permissionPreset ? [peer.permissionPreset] : [])])].map(name => h('option', { key: name, value: name }, name)))),
            h(Field, { label: t('webOrigin'), help: t('webOriginHelp') }, h(Text, { value: peer.webOrigin, placeholder: 'https://', onChange: webOrigin => edit('accept', i, { webOrigin }) })),
            removeButton('accept', i))),
          h('button', { type: 'button', style: { ...button, justifySelf: 'start' }, onClick: () => add('accept', { publicKey: '', workspaces: [] }) }, t('addPeer'))),

        h('div', { style: { display: 'flex', gap: 12, alignItems: 'center' } },
          h('button', { type: 'button', disabled: status === 'saving', style: { ...button, color: 'var(--dsw-alias-label-primary-foreground)', background: 'var(--dsw-alias-state-business-primary)' }, onClick: save }, t(status === 'saving' ? 'saving' : 'save')),
          status === 'saved' && h('span', { role: 'status' }, t('saved')),
          status?.error && h('span', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)' } }, status.error)))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        for (const [language, text] of Object.entries(TEXT)) ctx.effect(() => ctx.locale.register(NS, language, text))
        const t = ctx.locale.bind(NS)

        // The key is this package's name and the row id in cordis.patch.yml.
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: ID + '#remote-dsh-bridge', locale: NS },
          ({ t, view }) => view === 'summary' ? t('summary') : h(SettingsForm, { t })))

        if (tab) ctx.inject(['sidebarRightTabs'], c => {
          c.effect(() => c.sidebarRightTabs.register({ id: ID, kind: 'remote-dsh', title: () => t('title'), guide: [{ id: 'remote-dsh', order: 90, title: () => t('title') }] }))
          c.slots.inject('sidebar.right.pane.tab', () => c.slots.register({ name: 'sidebar.right.pane.tab', key: ID, locale: NS },
            // Keyed by session, so one conversation's list never shows in another.
            props => h(RemoteTab, { key: props.sessionId, ...props })))
        })

        // Embedded by a parent's tab: show the session it asks for.
        if (embedders.length && window.parent !== window) ctx.inject(['uiWorkspace'], c => {
          const onMessage = event => {
            if (event.source === window.parent && embedders.includes(event.origin) && event.data?.type === OPEN) c.uiWorkspace.openSession(event.data.sessionId)
          }
          window.addEventListener('message', onMessage)
          c.effect(() => () => window.removeEventListener('message', onMessage))
          for (const origin of embedders) window.parent.postMessage({ type: READY }, origin)
        })
      },
    }
  },
})
