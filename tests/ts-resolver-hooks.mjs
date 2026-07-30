import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXTENSIONS = ['.ts', '.mjs', '.js'];

/**
 * Resolve hook: retries an extensionless relative specifier with each known
 * source extension.
 *
 * Only relative specifiers are touched, so bare package names ("three") still
 * go through Node's normal resolution and nothing about dependency lookup
 * changes.
 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !EXTENSIONS.some((e) => specifier.endsWith(e))) {
    const base = new URL(specifier, context.parentURL);
    for (const ext of EXTENSIONS) {
      const candidate = new URL(base.href + ext);
      if (existsSync(fileURLToPath(candidate))) {
        return next(candidate.href, context);
      }
    }
    // Directory import: fall back to its index file.
    for (const ext of EXTENSIONS) {
      const candidate = new URL(`${base.href}/index${ext}`);
      if (existsSync(fileURLToPath(candidate))) {
        return next(candidate.href, context);
      }
    }
  }
  return next(specifier, context);
}
