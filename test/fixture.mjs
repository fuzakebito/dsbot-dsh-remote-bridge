// A real DSH Host assembled from the installed public packages, with a scripted model.
// Nothing here is a stand-in for DSH behaviour except the model and the temp directories.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

const tool = (id, name, config = {}) => ({ id, name: import.meta.resolve(`@deepseek-ai/${name}`), config });
const PRESETS = [
  { id: 'standard', name: 'Standard', plugins: [tool('fs', 'dsh-tool-fs'), tool('bash', 'dsh-tool-bash'), tool('jobs', 'dsh-tool-jobs')] },
  { id: 'ptc', name: 'PTC', plugins: [tool('fs', 'dsh-tool-fs'), tool('bash', 'dsh-tool-bash'), tool('presentation', 'dsh-agent-tool-presentation', { mode: 'ptc' })] },
];

export async function bootHost({ reply = 'fixture response', modelDelayMs = 20 } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'remote-dsh-bridge-'));
  const root = new Context();
  const modelCalls = [];
  class ScriptedModel extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: 'Fixture', inputModalities: ['text'] }; }
    async *stream(options) {
      modelCalls.push(options);
      await delay(modelDelayMs, undefined, { signal: options.signal });
      const said = typeof reply === 'function' ? await reply(options) : reply;
      if (typeof said === 'string') {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: said };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: said } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } else {   // { call: tool name, arguments }
        const block = { type: 'tool-call', id: randomUUID(), name: said.call, arguments: JSON.stringify(said.arguments) };
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    }
  }
  const mount = async (name, config) => {
    const module = await import(`@deepseek-ai/${name}`);
    return root.plugin(module.default ?? module, config);
  };
  const dispose = async () => { await root.fiber.dispose(); await rm(home, { recursive: true, force: true }); };
  try {
    for (const name of ['dsh-session', 'dsh-session-projection', 'dsh-agent', 'dsh-llm']) await mount(name);
    root.llm.registerAdapter(['fixture'], new ScriptedModel());
    await mount('dsh-system-prompt', { includeRuntimeContext: false });
    await mount('dsh-tools');
    await mount('dsh-agent-loop', { agents: [], maxParallelToolCalls: 10 });
    await mount('dsh-fs-local', { cwd: home });
    await mount('dsh-working-directory', { defaultDirectory: home });
    await mount('dsh-fs-observation-policy');
    await mount('dsh-user-approval', { policy: 'never' });
    await mount('dsh-subprocess-local');
    await mount('dsh-sandbox-local');
    await mount('dsh-sandbox-policy', { mode: 'danger-full-access', workspaceRoot: home });
    await mount('dsh-jobs-local');
    await mount('dsh-tool-jobs');
    await mount('dsh-shell-env');
    await mount('dsh-bash-sandbox', { timeoutMs: 60000 });
    await mount('dsh-ptc-runtime-node', { executionMode: 'persistent-in-memory', launch: { kind: 'node-script', executable: process.execPath }, timeoutMs: 5000 });
    // Everything below is what the Web profile adds for ordinary Sessions.
    await mount('dsh-session-persistence-jsonl', { root: join(home, 'sessions'), compression: 'none' });
    await mount('dsh-session-query');
    await mount('dsh-session-title', { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 });
    await mount('dsh-storage');
    await mount('dsh-storage-json', { root: join(home, 'storages') });
    await mount('dsh-storage-domain', { backend: 'json' });
    await mount('dsh-workspace');
    await mount('dsh-commands');
    await mount('dsh-credentials-local', { dshHome: home, watch: false });
    await mount('dsh-host-webserver', { host: '127.0.0.1', port: 0 });
    await mount('dsh-client-connection');
    await mount('dsh-typert-registry');
    await mount('dsh-api-remote-access');
    await mount('dsh-attachment-local', { dshHome: home });
    await mount('dsh-client-file-upload');
    await mount('dsh-agent-default-model', { provider: 'fixture', model: 'fixture-model' });
    await mount('dsh-permission-presets', { presets: { 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' }, 'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' } } });
    await mount('cordis-plugin-loader');
    await root.loader.create({ id: 'presets', name: import.meta.resolve('@deepseek-ai/dsh-agent-preset-registry'), config: { default: 'standard' } });
    await root.loader.await();
    for (const preset of PRESETS) await root.agentPresets.register(preset);
    await mount('dsh-api-session-controller', { nativeOpen: false });
    return { root, home, modelCalls, dispose };
  } catch (error) { await dispose(); throw error; }
}
