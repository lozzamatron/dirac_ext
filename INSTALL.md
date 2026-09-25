# Installing Dirac EXT

Dirac EXT is a VS Code extension. **You do not need to build it, and you do not need upstream
Dirac** — install the prebuilt `.vsix` from this repo's Releases. It works in desktop VS Code and in
code-server (VS Code 1.101 or newer).

## For a coding agent (Kilo Code, Claude Code, …) — run these steps

Run them in a terminal on the machine where VS Code / code-server itself runs (in code-server, that is
the integrated terminal).

```bash
# 1. Download the release asset
curl -fL -o /tmp/dirac-ext-0.5.13.vsix \
  https://github.com/lozzamatron/dirac_ext/releases/download/v0.5.13-ext.1/dirac-ext-0.5.13.vsix

# 2. Verify it (must print: /tmp/dirac-ext-0.5.13.vsix: OK)
echo "9fa79df9f543936203decc3abb2a048e9b857f44519eaef7c24fb96233e4af31  /tmp/dirac-ext-0.5.13.vsix" | sha256sum -c -

# 3. Install — use whichever CLI exists
if command -v code-server >/dev/null; then
  code-server --install-extension /tmp/dirac-ext-0.5.13.vsix --force
else
  code --install-extension /tmp/dirac-ext-0.5.13.vsix --force
fi

# 4. Confirm (must list lozza.dirac-ext)
(command -v code-server >/dev/null && code-server --list-extensions || code --list-extensions) | grep -i dirac
```

If `code-server` is not on `PATH`, find it with
`find / -path '*bin/code-server' -type f 2>/dev/null | head -1` and use that full path.

Then **stop and hand over to the human** for the steps below — they happen in the UI.

## For the human — three clicks

1. **Reload the window**: Command Palette (`Ctrl/Cmd+Shift+P`) → **Developer: Reload Window**.
2. If VS Code shows **Restricted Mode** in the title bar, choose **Trust** — extensions are disabled
   in an untrusted folder.
3. Open **Dirac EXT** from the Activity Bar, pick a model provider and paste **your own** API key
   (Anthropic, OpenRouter, DeepSeek, …). Dirac brings no model of its own.

Try it: Command Palette → **Dirac EXT: Open in New Tab** opens a second conversation as an editor tab;
`Ctrl/Cmd+Shift+M` opens the Agent Map for a conversation.

## Good to know

- **Upstream Dirac can stay installed.** Dirac EXT has its own identity (`lozza.dirac-ext`), but both
  read and write the same `~/.dirac/data` — they share settings, API keys and history. If you only want
  one, disable the other in the Extensions view.
- **Uninstall:** `code-server --uninstall-extension lozza.dirac-ext` (or `code …`), then reload.

## Building from source (only if you want to)

Branch `ext/main`, Node 22, and `unzip` on `PATH` (the ripgrep-binary step needs it):

```bash
git clone -b ext/main https://github.com/lozzamatron/dirac_ext.git && cd dirac_ext
npm run install:all
npm run package          # also generates the protos
npx vsce package --no-dependencies --allow-package-secrets sendgrid
```
