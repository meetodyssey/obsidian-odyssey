# Installation

## Manual Install

1. Create the plugin directory in your Obsidian vault:

```text
.obsidian/plugins/odyssey/
```

2. Copy the build output into it:

```text
main.js
manifest.json
styles.css
```

3. Restart Obsidian or reload community plugins.
4. Enable **Odyssey** in Settings → Community plugins.

## Build from Source

```bash
npm install
npm run build
```

The compiled `main.js`, `manifest.json`, and `styles.css` will be in the project root. Copy them to your vault's `.obsidian/plugins/odyssey/` directory.

This repository builds a functional public source version with baseline dialogue prompts. An official packaged distribution may additionally include local-only prompt resources for dialogue quality; those resources do not require an Odyssey server or add telemetry. See [Distribution Notes](distribution.md).

## BRAT Install

For beta testing with [BRAT](https://github.com/TfTHacker/obsidian42-brat):

1. Install the BRAT plugin in Obsidian.
2. Add this repository URL in BRAT settings.
3. Select the latest release.
4. Enable the plugin.

## First Launch

After enabling, Odyssey creates an `Odyssey/` directory in your vault for readable conversation and memory records, plus (by default) a local encrypted auxiliary index at `.odyssey/index.enc`. No conversation content is sent to a remote model provider unless you configure one; official local prompt resources do not change that network boundary.
