---
name: codex-mota-executor
description: Bind MoTA Creator bound Pull Agents from a local file, inspect status and logs, run a local check, or control the standalone MoTA Executor worker on macOS.
---

Use this skill for MoTA Creator bound Pull Agents managed by this plugin. Resolve the CLI at `../../bin/mota.mjs` relative to this skill directory. The commands below use `<cli>` as the absolute path to that file. Quote absolute paths and keep tokens out of chat and command arguments. Node.js 22 or later is required.

- Inspect the worker and all Agent states with `node "<cli>" status`. Read worker logs with `node "<cli>" logs [--lines N]`.
- To bind, get the absolute path to a private local file containing the Creator Worker bundle or full connection instructions. It should belong to the current user and have permissions `600`. Pass the path directly to `node "<cli>" bind --file "/absolute/path"` so the CLI reads the file privately. Report the Agent code and the returned `codexHome`. For a fresh authentication directory, have the user run `CODEX_HOME='/absolute/path/from/codexHome' codex login` in their terminal.
- Run `node "<cli>" check [agentCode]` for a local executor check without claiming a Creator task. This calls OpenAI on synthetic input using the Worker's separate Codex login and may use model quota. Use the Creator UI test to check the Creator connection once the worker is running.
- Use `node "<cli>" enable <agentCode>` or `disable <agentCode>` to change one Agent's eligibility to claim tasks. New bindings are disabled. Binding and eligibility changes take effect on the next start or restart. If an existing service should apply the change now, restart it and verify the updated status. With every binding disabled, restart stops a loaded service.
- Use `node "<cli>" start`, `stop`, or `restart` when asked to change the macOS user service. Check status afterward. Starting an eligible Agent connects to Creator and can claim real tasks. Stop and restart let an already sent long poll finish within 40 seconds, then allow up to 20 seconds for claimed tasks to finish.
- Use `node "<cli>" run` for foreground diagnostics when requested. It can start processing real tasks for enabled Agents. Stop it with Ctrl+C when done.

macOS supervises the worker independently of the Codex app and chat. Read status before diagnosing a stopped Agent. Distinguish service health, Creator heartbeat, `executorReady`, and the actual run's `accepted` receipt when reporting status.
