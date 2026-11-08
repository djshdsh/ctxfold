# AI 破甲 · ctxfold

Layered prompt control for [Pi Agent](https://github.com/earendil-works/pi). Positive-only, zero runtime dependencies.

> **QQ group: `1109964876`** · **Relay endpoint: <https://www.hunmeng.icu/>**
>
> The relay is an optional companion service. ctxfold itself runs fully local and needs no account or key.

[中文](README.md) · [CLI reference](docs/CLI.md) · [Architecture](docs/ARCHITECTURE.md) · [Layers](docs/LAYERS.md)

---

## What it does

Pi loads your prompt from `~/.pi/agent/AGENTS.md`. That is one flat file, always on, and it grows until the model starts ignoring the parts that matter.

ctxfold splits the prompt into **layers** and injects only what the current task needs:

| Layer | Size | When |
| --- | ---: | --- |
| `core` | 1.1k | always |
| `refusal` | 2.0k | always |
| `eng` | 1.1k | always |
| `route.re` | 3.6k | reverse engineering, licenses |
| `web` | 1.7k | web pentesting |
| `ctf` | 1.1k | CTF |
| `ir` | 1.4k | incident response |

A plain question gets the 4.2k baseline. A pentest request gets 8.1k. Nothing has to be toggled by hand.

## Three ways to use it

**Window**

```
ctxfold-app.exe
```

Native WinForms window, no browser, no Node install, no terminal. Bundles the backend inside the exe.

**Command line**

```powershell
ctxfold install     # copy extension, layers, rules, skill into Pi
ctxfold status      # what is active right now
ctxfold doctor      # 10-point environment check
```

**Inside Pi**

Just talk. The extension hooks `before_agent_start`, routes the prompt, and writes the layers into the system prompt.

```
/ctxfold status
/ctxfold override on
```

## How injection reaches the model

By default the layers go into one named section of the system prompt, leaving everything else in place. That preserves Pi's prompt cache, so the prefix does not get invalidated every turn.

When you want the layers to *replace* the prompt instead of joining it:

```powershell
ctxfold sanitize      # back up and empty AGENTS.md, then take over
ctxfold restore       # put it back
```

`sanitize` writes `~/.pi/agent/.ctxfold/sanitize.json` and a timestamped backup. `restore` reads both back.

## Change a layer

```powershell
ctxfold layers fork core    # preset -> user copy
ctxfold layers path core    # confirms which file is live
```

Then edit `~/.pi/agent/.ctxfold/layers/core.md`. Takes effect next turn. Delete the file to fall back to the preset.

## Config

`~/.pi/agent/extensions/ctxfold/config.json` — never overwritten by `install`.

```json
{
  "enabled": true,
  "routing": true,
  "maxChars": 0,
  "approval": "auto",
  "override": false
}
```

`routing: false` injects everything every turn. `override: true` replaces the whole system prompt. `approval` decides what happens to destructive commands: `auto` allows, `confirm` asks, `deny` blocks.

## Optional: patch Pi's own dist

Four changes to Pi's bundled source, off by default, each with an automatic `.ctxfold.bak`:

```powershell
ctxfold patch list
ctxfold patch apply --id DEEPSEEK_SYSTEM_ROLE
ctxfold patch revert
```

They lock to a Pi version. After upgrading Pi, revert then re-apply.

## Safety

- `install` never overwrites an existing `config.json`
- every destructive file operation backs up first, and `restore` uses those backups
- `revert` removes only its own marker block, byte-exact
- the extension is a no-op when `enabled` is false

## Requirements

Node ≥ 18.17 for the CLI. Windows for the window (it compiles with the `csc` that ships with .NET Framework). Linux and macOS run the CLI and the web console fine.

## License

MIT
<!-- docs: updated 2026-11-08 -->
