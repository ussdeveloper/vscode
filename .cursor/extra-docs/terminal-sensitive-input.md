# Terminal password prompts (TheCoder)

## Behavior

Password/sudo/secret prompts use the same **input-needed** path as other interactive terminal prompts. The agent is not blocked: it receives tool output plus steering to use `send_to_terminal`.

- If the user already gave the password in chat or pointed to a file, the model should **not** ask again — read the file if needed and `send_to_terminal` directly.
- Only use `vscode_askQuestions` when the value is still unknown.
- `sendToTerminalTool` shows **"Password sent to terminal"** in chat (no secret echoed) when the terminal output ends with a password-style prompt.

Upstream’s separate `onDidDetectSensitiveInputNeeded` path is not used for firing events in TheCoder.

## Files

- `outputMonitor.ts` — sensitive prompts fire `onDidDetectInputNeeded`
- `runInTerminalTool.ts` — tool descriptions and `_buildInputNeededSteeringText`
- `sendToTerminalTool.ts` — redacted chat messages for password sends

## Rebuild

Workbench change — requires a **full** min build, not only repackaging:

```powershell
powershell -File scripts/build-release.ps1 -PortableOnly
```

(`-PortableOnly` still runs gulp `vscode-win32-x64-min`; do not use `-SkipBuild` unless you just finished a min build.)

Verify the bundle no longer contains `_registerSensitiveInputElicitation` in both `workbench.desktop.main.js` and `sessions.desktop.main.js`.
