/**
 * tsdown build for the merged dsh-better-sidebar plugin:
 * - host half: lib/index.js (ESM node) + lib/invariant.js (ESM node)
 * - client core: lib/client.js (CJS closure factory registered through
 *   window.__ModuleLoader__.load)
 * - optional registry-channel client: lib/client-registry.js (same core with
 *   the dsh-external module id)
 * - lazy chunks: lib/client-<name>.js (docx / xlsx / pptx / terminal / editor)
 *   registered on globalThis.__dshChunks__
 *
 * The client bundles keep @deepseek-ai/* and react family external (the web
 * shell provides them through the module table), inline everything else, and
 * compile CSS Modules to hashed class maps + injected <style data-plugin>
 * tags.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve as resolvePath, sep } from 'node:path'
import { builtinModules, createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** Node builtins must never survive into the browser module-loader factory. */
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(id => `node:${id}`),
])

/** Module specifiers the web shell shares into the frozen module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-conversation',
]

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const REPOSITORY_ROOT = fileURLToPath(new URL('.', import.meta.url))
const require = createRequire(import.meta.url)

/** The style-injection prologue shared by module css loads. */
function injectTag(pluginId: string, fileId: string, cssText: string): string {
  const tagId = `${pluginId}/${basename(fileId)}`
  return [
    `const css = ${JSON.stringify(cssText)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
    `  const tag = document.createElement('style');`,
    `  tag.dataset.plugin = ${JSON.stringify(pluginId)};`,
    `  tag.dataset.pluginCss = tagId;`,
    `  tag.textContent = css;`,
    `  document.head.appendChild(tag);`,
    `}`,
  ].join('\n')
}

/** Rebase a physical lib-relative source onto the repository-shaped URL tree. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join('/')
  return `../../../${repositoryPath}`
}

/** A rolldown plugin as tsdown's config accepts it (contextual `this` for load/resolveId). */
type BuildPlugin = NonNullable<UserConfig['plugins']>

/** The client-bundle purity gate (see the clientBundle doc). */
function purityGatePlugin(allowNodeBuiltins = false): BuildPlugin {
  return {
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (NODE_BUILTINS.has(source)) {
        if (allowNodeBuiltins) return null
        throw new Error(
          `client bundle purity: Node builtin "${source}" cannot run in the browser module table — `
          + 'select the dependency browser export or add an explicit browser implementation',
        )
      }
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null // platform module: external wins
      throw new Error(
        `client bundle purity: "${source}" is not a platform module (CLIENT_EXTERNALS) — `
        + 'cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)',
      )
    },
  }
}

/** Resolve a CSS import to an absolute file path (relative or bare package path). */
function resolveCssFile(source: string, importer: string | undefined): string {
  if (source.startsWith('.') || source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source)) {
    return importer === undefined ? source : resolvePath(dirname(importer), source)
  }
  // Bare specifier: resolve through node_modules (e.g. xterm/css/xterm.css,
  // @univerjs/preset-sheets-core/lib/index.css).
  const paths = importer === undefined ? [REPOSITORY_ROOT] : [dirname(importer), REPOSITORY_ROOT]
  return require.resolve(source, { paths })
}

/** The CSS-inline virtual-module plugin (one <style data-plugin> per file). */
function makeCssPlugin(pluginId: string): BuildPlugin {
  return {
    name: 'dsh-css-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css')) return null
      const abs = resolveCssFile(source, importer)
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      if (fileId.endsWith('.module.css')) {
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: `[hash]_[local]` },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
        return [
          injectTag(pluginId, fileId, code.toString()),
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      }
      return [
        injectTag(pluginId, fileId, source.toString('utf8')),
        'export default "";',
      ].join('\n')
    },
  }
}

/** Shared browser-bundle options for the core and lazy chunks. */
function browserBundle(options: {
  entry: Record<string, string>
  outFile: string
  banner: string
  footer: string
  pluginId: string
  allowNodeBuiltins?: boolean
}): UserConfig {
  return {
    entry: options.entry,
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    external: [...CLIENT_EXTERNALS, ...(options.allowNodeBuiltins ? [...NODE_BUILTINS] : [])],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
      },
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) || (options.allowNodeBuiltins && NODE_BUILTINS.has(id)) ? undefined : true),
    plugins: [purityGatePlugin(options.allowNodeBuiltins ?? false), makeCssPlugin(options.pluginId)],
    outputOptions: {
      entryFileNames: options.outFile,
      banner: options.banner,
      footer: options.footer,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  }
}

/** One lazy chunk bundle (docx / xlsx / pptx / terminal / editor). */
function chunkBundle(name: string, entry: string): UserConfig {
  return browserBundle({
    entry: { [name]: entry },
    outFile: `client-${name}.js`,
    banner: `globalThis.__dshChunks__ = globalThis.__dshChunks__ || {};\nglobalThis.__dshChunks__[${JSON.stringify(name)}] = (require) => {`,
    footer: 'return module.exports; };',
    pluginId: 'dsh-better-sidebar',
    allowNodeBuiltins: true,
  })
}

export default [
  // Host half: main plugin + invariant companion.
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { invariant: 'src/invariant.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  // Official profile channel: bundle id = package name (package.json `name`).
  browserBundle({
    entry: { client: 'src/client/index.tsx' },
    outFile: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: "dsh-better-sidebar", factory: (require) => {`,
    footer: 'return module.exports; } });',
    pluginId: 'dsh-better-sidebar',
  }),
  // Plugin-registry channel: same client core, different module-loader id.
  browserBundle({
    entry: { 'client-registry': 'src/client/index.tsx' },
    outFile: 'client-registry.js',
    banner: `window.__ModuleLoader__.load({ id: "dsh-external/dsh-better-sidebar", factory: (require) => {`,
    footer: 'return module.exports; } });',
    pluginId: 'dsh-better-sidebar',
  }),
  // Lazy chunks.
  chunkBundle('docx', 'src/client/chunks/docx.tsx'),
  chunkBundle('xlsx', 'src/client/chunks/xlsx.tsx'),
  chunkBundle('pptx', 'src/client/chunks/pptx.tsx'),
  chunkBundle('terminal', 'src/client/chunks/terminal.tsx'),
  chunkBundle('editor', 'src/client/chunks/editor.tsx'),
] satisfies UserConfig[]
