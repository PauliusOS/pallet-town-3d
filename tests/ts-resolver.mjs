import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * Lets the Node test runner import `src/` the way Vite does.
 *
 * The source uses extensionless relative imports (`from '../core/Noise'`),
 * which the bundler resolves but Node's ESM loader does not. Rather than
 * rewrite every import in the project to suit the test runner, this hook tries
 * the `.ts` (then `.mjs`, `.js`) sibling before giving up — so any module under
 * `src/` is testable without a bundler step.
 */
register(pathToFileURL(new URL('./ts-resolver-hooks.mjs', import.meta.url).pathname));
