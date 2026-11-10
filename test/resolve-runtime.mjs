// Plugins import DSH packages by name; inside a profile the DSH runtime resolves them.
// Outside one (these tests), fall back to the runtime named by DSH_RUNTIME.
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

if (!process.env.DSH_RUNTIME) throw new Error('Set DSH_RUNTIME to the dsh-runtime package directory');
const runtime = createRequire(`${process.env.DSH_RUNTIME}/package.json`);

registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('@deepseek-ai/')) throw error;
      // runtime.resolve re-enters this hook with the runtime as parent, where next() succeeds.
      return next(pathToFileURL(runtime.resolve(specifier)).href, context);
    }
  },
});
