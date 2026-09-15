import { defineConfig } from "vite";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Keep Blender's stable source/export paths, while production URLs identify
// exact bytes and can be cached without revalidation across deployments.
const models = ["archive-cassette", "archive-assembly"].map(name => {
  const source = readFileSync(`public/assets/${name}.glb`);
  const hash = createHash("sha256").update(source).digest("hex").slice(0,16);
  return { key:`assets/${name}.glb`, fileName:`assets/${name}.${hash}.glb`, source };
});
const hasNovecento = ["Normal", "DemiBold", "Bold"].every(weight =>
  existsSync(`public/fonts/novecento/webFonts/NovecentoSansWide${weight}/font.woff2`),
);
export default defineConfig(({ mode, command }) => ({
  // Both non-web hosts load the built app from file://, so every asset URL has
  // to stay relative. `src/asset-url.ts` already routes through BASE_URL.
  base: ["wallpaper", "desktop", "android"].includes(mode) ? "./" : "/",
  define: {
    __RHINE_MODELS__: JSON.stringify(Object.fromEntries(models.map(model => [model.key,model.fileName]))),
    __RHINE_NOVECENTO__: JSON.stringify(hasNovecento),
  },
  // Watching build output or editor scratch files crashes the dev server on
  // Windows rather than merely reloading it: an atomic-write temp folder, a
  // Chromium profile's locked Cookies file, or an in-tree bundle all raise
  // EBUSY inside the watcher. The desktop build's outDir is not the dev
  // server's own, so Vite would otherwise watch it.
  server: {
    watch: {
      ignored: [
        "**/*.tmpdir/**",
        "**/dist/**",
        "**/dist-desktop/**",
        "**/dist-android/**",
        "**/release/**",
        "**/.smoke-profile-*/**",
      ],
    },
  },
  plugins: [{
    name: "versioned-model-assets", apply: "build",
    buildStart() { for (const model of models) this.emitFile({type:"asset",fileName:model.fileName,source:model.source}); },
  }, ...(["desktop", "android"].includes(mode) ? [{
    name: "ssh-ui-licenses", apply: "build" as const,
    buildStart() { this.emitFile({ type: "asset", fileName: "SSH-UI-NOTICES.txt", source: readFileSync("licenses/SSH-UI-NOTICES.txt", "utf8") }); },
  }] : []), ...(!["desktop", "android"].includes(mode) ? [{
    // Vite emits ?url assets while building the graph, before Rollup removes
    // the unused desktop import. Resolve this insert to an empty module first
    // so web / wallpaper releases and their offline caches never include it.
    name: "desktop-only-terminal-asset",
    enforce: "pre" as const,
    resolveId(source: string) {
      if (source.endsWith("/ssh-terminal.glb?url")) return "\0rhine:unused-terminal-asset";
    },
    load(id: string) {
      if (id === "\0rhine:unused-terminal-asset") return 'export default "";';
    },
  }] : []), ...(mode === "wallpaper" ? [{
    name: "wallpaper-host",
    transformIndexHtml(html: string) {
      return { html: html.replace(/\s*<link rel="manifest"[^>]*>/, ""), tags: [{
        tag: "script", children: readFileSync("wallpaper/host.js", "utf8"), injectTo: "head-prepend" as const,
      }] };
    },
  }] : []), ...(["desktop", "android"].includes(mode) ? [{
    // Never inject wallpaper/host.js here: it deliberately skips its own
    // fallback resolve under `file:`, which would leave the `await` in
    // src/main.ts hanging and render a permanently blank window.
    name: "desktop-index",
    transformIndexHtml(html: string) {
      // The marker lets the dev launcher prove a server is serving the desktop
      // build before reusing it — reusing a web-mode server silently produced a
      // window with no session layer at all.
      return {
        html: html.replace(/\s*<link rel="manifest"[^>]*>/, ""),
        tags: [
          { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: [
            "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:", "font-src 'self' data:", "media-src 'self' blob:",
            "worker-src 'self' blob:",
            command === "serve" ? "connect-src 'self' ws://127.0.0.1:* ws://localhost:*" : "connect-src 'self'",
            "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'",
          ].join("; ") }, injectTo: "head-prepend" as const },
          { tag: "meta", attrs: { name: "rhine-host", content: mode }, injectTo: "head" as const },
        ],
      };
    },
  }] : [])],
}));
