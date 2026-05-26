# Odyssey

> Meet yourself along the way.

Many AI conversations lose their thread. You explain your background, work through a decision, or name something important; in the next conversation, the useful context may be absent or hidden inside a memory feature you cannot inspect.

Odyssey is a local-first memory companion for Obsidian. It keeps conversation records and source-backed memories as plain Markdown in your vault, then brings relevant context back when a new conversation begins. You can read the record, correct it, move it, or delete it.

The source code in this repository is available under the GNU AGPL-3.0 license.

<!-- TODO: screenshot of the chat view with recalled memory context -->

## Why Odyssey

There are many AI plugins for Obsidian. Most of them help you search your notes or generate text. Odyssey does something different: it builds *persistent personal memory* from your conversations.

**The problem isn't only search - it's continuity.** A note search tool can find a document. It does not preserve the arc of a conversation, track a correction, or make recalled context traceable to what you actually said.

**Odyssey makes memory inspectable.** In normal mode, conversations are saved as Markdown and the current plugin extracts L1 recent memories and anchored summaries. When an understanding changes - because the AI misunderstood, you made a mistake, or your circumstances changed - a correction can be recorded without silently rewriting the earlier record.

<!-- TODO: screenshot of memory files in the vault (L1 directory with .md files visible) -->

## Features

**Memory that grows with you**
- Cross-session recall grounded in your own words
- Conversation records plus L1 recent memories and source-anchored summaries
- Append-only corrections - never overwrite, always clarify
- Ephemeral mode for conversation intervals you choose not to save

**Your data, your files**
- Conversation and memory records stored as readable Markdown in your vault
- No Odyssey account required and no telemetry
- Privacy lock for chat view and memory files

**Flexible model support**
- Ollama, OpenAI-compatible endpoints, Anthropic Claude
- Quick-start presets for common providers
- API keys stored in Obsidian plugin settings only - never in the memory directory

Odyssey does not ship a built-in model. You bring your own: a local [Ollama](https://ollama.com) instance for fully offline use, or a cloud provider API key.

## Source and Official Builds

Building this repository produces a functional public source build with baseline dialogue prompts. Official packaged distributions may include additional local-only prompt resources to improve conversation quality.

Those resources do not introduce an Odyssey server, account, or telemetry. Model requests still go only to the model provider you configure, including a local Ollama instance for offline use. See [Distribution Notes](docs/distribution.md) for the boundary between this source build and official packaged builds.

## Quick Start

See [Installation Guide](docs/installation.md) for full details including BRAT install.

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to `.obsidian/plugins/odyssey/` in your vault, then enable the plugin in Settings.

## How It Works

Odyssey creates an `Odyssey/` directory in your vault. Open the chat view from the command palette or ribbon, configure a model in settings, and start talking.

### Memory Flow

```
Conversation → L0 working memory → L1 raw memory + summary → retrieval
```

When enough context builds up in a conversation, Odyssey extracts L1 memories: raw excerpts preserving your original words, and summaries with source anchors linking back to the conversation. Future conversations retrieve relevant memories and bring them into context.

### Data Model

| Directory | Purpose |
|-----------|---------|
| `Conversations/` | Original conversation records |
| `L1_Recent_Memory/` | Recent raw memories and summaries |
| `Corrections/` | Append-only correction records |
| `References/` | Imported vault reference material |
| `Index/` | Local indexes |

### Correcting Memories

Memory can be wrong: the AI may have misunderstood, you may have misstated something, or circumstances may have changed. Tell Odyssey directly: "No, that's not right - actually..." A correction record is appended in `Corrections/`, linked to the original memory. The original is never deleted. Future retrieval prefers the correction.

<!-- TODO: screenshot of a correction being made in chat -->

## Privacy

- Conversation and memory records are stored locally as Markdown in your vault.
- API keys are kept in Obsidian plugin settings, not in the memory directory.
- The plugin can run fully offline with a local Ollama model.
- If you use a cloud model provider, conversation requests are sent to that provider.

## Usage

See the [User Guide](docs/user-guide.md) for full details on memory records, ephemeral mode, reference import, export, and model configuration.

## Development

```bash
npm install
npm run dev       # development build with watch
npm run build     # production build with type checking
npm test          # run tests
```

## Feedback

Issue templates are available when you open a new issue:

- **Bug Report** — something isn't working as expected
- **Feature Request** — suggest an improvement or new capability
- **Memory Quality** — Odyssey remembered incorrectly, missed an important fact, or recalled irrelevant context
- **Model Setup Help** — trouble configuring a model provider

Do not paste API keys, private conversations, memory file contents, or unredacted vault paths in public issues.

## Disclaimer

Odyssey responses are AI-generated and may be wrong or incomplete. Odyssey is not a substitute for medical, legal, financial, mental-health, or other professional advice.

## License

The source code in this repository is licensed under [GNU AGPL-3.0](LICENSE). Official packaged distributions may contain additional identified local resources governed by the terms supplied with that distribution.
