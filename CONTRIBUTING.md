# Contributing to Orlo

Thanks for helping. Orlo is small on purpose, so the best contributions are focused ones: a fix with a clear repro, or a feature that fits "tasks, notes and agents, calmly".

## Before you start

- **Bugs:** open an issue with steps to reproduce, what you expected, and your Windows version.
- **Features:** open an issue first so we can agree on the shape before you write code.
- **Security problems:** don't open a public issue. See [SECURITY.md](SECURITY.md).

## Set up

You'll need Node.js 20+, pnpm, and Rust stable with MSVC (Visual Studio Build Tools, C++ workload).

```sh
pnpm install
pnpm tauri dev
```

Keep your real tasks safe while you develop:

```powershell
$env:ORLO_DATA = "$PWD\.dev-data"   # separate SQLite database
$env:ORLO_WORK = "$PWD\.dev-work"   # separate agent work folders
pnpm tauri dev
```

## Project layout

| Path | What |
|---|---|
| `src/App.tsx` | The whole UI: views, sidebar, task detail, intro, palette |
| `src/components/md-editor.tsx` | Live Markdown editor (CodeMirror 6) |
| `src/components/agent-icon.tsx` | Claude / Codex / Grok marks |
| `src/components/ui/` | shadcn/ui components (base-ui flavour) |
| `src/index.css` | Theme tokens, animations, editor styles |
| `src-tauri/src/lib.rs` | SQLite storage, spawning the agent CLIs, parsing their output |

## Guidelines

- **Match the code around you.** Keep naming, comment density and idioms consistent with the surrounding code. Prefer small diffs, and don't add an abstraction until there's a second use for it.
- **UI** uses [shadcn/ui](https://ui.shadcn.com) components. Add new ones with `pnpm dlx shadcn@latest add <name>`. They're base-ui based, so use the `render` prop instead of `asChild`.
- **Animations** must respect `prefers-reduced-motion`. Add any new animation class to the block at the end of the motion section in `src/index.css`.
- **Dependencies:** avoid adding new ones when a few lines will do.

### Agent integration rules (hard requirements)

Orlo works with Claude, Codex and Grok **only by launching their official CLIs** that the user installed and signed into. Pull requests that do any of the following will be closed:

- reading, storing, logging, proxying or forwarding OAuth tokens, refresh tokens, API keys or CLI credential files;
- setting auth environment variables (such as `CLAUDE_CODE_OAUTH_TOKEN`) for the user;
- pooling accounts, sharing sessions between users, or exposing agents over the network;
- installing or bundling the CLIs.

Adding another agent is welcome if it follows the same model. In practice that means three changes:
- a match arm in `start()` in `lib.rs`;
- a name in `clis()`;
- an icon in `agent-icon.tsx`.

## Checks

Run these before opening a PR (CI runs the same):

```sh
pnpm build                          # TypeScript + Vite
cd src-tauri && cargo test          # Rust unit tests
```

## Pull requests

- Keep each PR to one change and explain *why* it's needed.
- Include a screenshot or short clip for any UI change.
- Make sure the checks pass.
- By contributing, you agree your work is licensed under the [MIT License](LICENSE).

Please follow our [Code of Conduct](CODE_OF_CONDUCT.md).
