// The Host half of the settings form: what the form shows, and saving what it sends back.
export class Settings {
  /** `owner` is this plugin's own fiber, by which its row in the profile is found. */
  constructor(ctx, { owner, config, publicKey, check }) {
    Object.assign(this, { ctx, owner, config, publicKey, check })
  }

  read() {
    return {
      publicKey: this.publicKey,
      remotes: this.config.remotes,
      accept: this.config.accept,
      // Names to choose from instead of IDs. The form asks DS Bot itself for the Bots.
      workspaces: this.ctx.workspaceRegistry.list().map(({ id, title, path }) => ({ id, title, path })),
      permissionPresets: this.ctx.permissionPresets.names,
    }
  }

  /** Writes the two lists into the profile's cordis.patch.yml; DSH then reloads the plugin with them. */
  async save({ remotes, accept }) {
    this.check({ remotes, accept })
    const entry = this.ctx.configEditor.entries().find(entry => entry.fiber === this.owner)
    await this.ctx.configEditor.edit(entry, current => ({ ...current, remotes, accept }))
  }
}
