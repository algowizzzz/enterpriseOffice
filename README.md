# DocForge

A collaborative, browser-based word processor for air-gapped deployment.

- **Air-gapped.** No CDN, no telemetry, no outbound network calls at runtime.
- **Two targets.** A Linux server for teams, and a single Windows laptop that
  runs the same stack locally.
- **Multi-user.** Real-time co-editing, presence, comments, track changes.
- **Word-compatible.** OOXML-aligned document model with `.docx` import/export.
- **Clean licensing.** MIT/BSD/Apache-2.0/OFL only. No GPL or AGPL in the bundle.

## Documentation

| Doc | What it covers |
|---|---|
| [`docs/01-architecture.md`](docs/01-architecture.md) | Licensing analysis of existing editors, the two viable architectures, the full permissive stack, system diagram, phased plan |
| [`docs/02-feature-matrix.md`](docs/02-feature-matrix.md) | Every Word and OnlyOffice ribbon tab, each feature tagged out-of-box / config / custom / server, with effort by workstream |

## Layout

```
packages/
  model/    ProseMirror schema, styles, numbering, section properties (pure TS)
  layout/   Pagination engine: (doc, fonts, pageSetup) -> pages
  ooxml/    .docx codec (parser + serializer), runs in a Web Worker
  editor/   ProseMirror plugins: commands, tables, comments, track changes, find
  collab/   Yjs bindings, awareness, offline cache
  ui/       React ribbon, dialogs, panes (shadcn/ui)
  assets/   OFL fonts, Hunspell dictionaries, hyphenation patterns
apps/
  web/      Vite app
  server/   Node: Hocuspocus, REST, persistence, conversion worker
  desktop/  Tauri launcher for Windows
deploy/
  docker/ systemd/ windows/
```

Build order: `model` -> `editor` + `collab` -> `ooxml` + `layout` -> `ui`.
`ooxml` and `layout` both depend on a stable schema and will push changes
back into `model`, so stabilise that first.

## Status

Design phase. No application code yet.

## Licence

MIT. See [`LICENSE`](LICENSE) and [`docs/01-architecture.md`](docs/01-architecture.md)
for the dependency licence audit.
