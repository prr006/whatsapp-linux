/**
 * M14 test stub — Node ESM loader hooks: map the GI import specifiers used
 * by the vendored 50.1 source (and the shipped extension) onto the local
 * stub modules, and the shell resource:// URIs onto the vendored files /
 * API stubs.
 */

const GI_STUBS = new URL('./stubs/', import.meta.url);
const VENDOR = new URL('./vendor/gnome-shell-50.1/', import.meta.url);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('gi://')) {
    const name = specifier.slice('gi://'.length);
    return { url: new URL(`${name}.js`, GI_STUBS).href, shortCircuit: true };
  }

  if (specifier === 'resource:///org/gnome/shell/ui/messageTray.js') {
    // The vendored REAL 50.1 file — the single source of truth for the
    // banner state machine under test.
    return { url: new URL('messageTray.js', VENDOR).href, shortCircuit: true };
  }

  if (specifier === 'resource:///org/gnome/shell/extensions/extension.js') {
    return { url: new URL('./stubs/shell-extension-api.js', import.meta.url).href, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}
