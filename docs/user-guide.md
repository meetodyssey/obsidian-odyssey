# User Guide

## How Odyssey Works

Odyssey is a local-first memory companion for Obsidian. It remembers across conversations using plain Markdown files in your vault. You own the data.

### Memory Levels

| Level | What It Stores |
|-------|---------------|
| L0 | Current conversation working memory (temporary) |
| L1 | Recent raw memories and summaries extracted from conversations |
| L2 / L3 | Reserved storage levels; the current plugin does not automatically promote memories into them |

### Conversation Modes

**Normal mode** (default): Every turn is saved to `Conversations/`. When enough context builds up, Odyssey consolidates L0 into persistent L1 memories - raw excerpts and summaries with source anchors.

**Ephemeral mode**: Toggle the ephemeral button in the toolbar to mark messages you don't want saved. Ephemeral messages stay in the current session only and are cleared when the interval ends. They are never written to disk, indexed, or extracted as memory.

### Correcting Memories

If a stored understanding needs correction, tell Odyssey directly in conversation: "No, that's not right - actually..." This covers AI misunderstandings, facts you previously misstated, and circumstances that changed. Odyssey appends a correction record in `Corrections/` and keeps the earlier record traceable.

### Reference Import

Import vault notes as low-priority reference material. References help with cold starts but don't become personality memories.

From settings, click **Import Reference** and specify a scope:
- `folder:path` - import a specific folder
- `tag:#tag` - import notes with a specific tag
- `daily` - import daily notes

### Export

Select messages in the chat view with the checkbox, then click Export. Odyssey generates an Obsidian-compatible Markdown note in `Exports/` with source anchors preserved.

## Model Setup

Odyssey supports:

- **Ollama** (local, default): `http://127.0.0.1:11434`
- **OpenAI-compatible**: any API endpoint matching the OpenAI chat completions format
- **Anthropic Claude**: native Claude Messages API support

Quick-start presets are available in settings: Ollama, OpenAI, Anthropic, DeepSeek, Groq, and SiliconFlow.

API keys are stored in Obsidian plugin settings only - never written to the `Odyssey/` memory directory.

For best memory extraction quality, use a stronger extraction model than your chat model when possible.

## Data & Privacy

- Conversation and memory records are stored as readable Markdown in `Odyssey/` inside your vault.
- API keys stay in Obsidian plugin settings, not in the memory directory.
- By default, the plugin writes a local encrypted auxiliary index at `.odyssey/index.enc`; readable memories remain in Markdown under `Odyssey/`.
- An official packaged build may contain additional local-only prompt resources; they do not add an Odyssey server or telemetry.
- The privacy lock hides the chat UI and memory content. It is a local exposure guard, not disk encryption.
- Edit Odyssey memory files only if you know what you're doing. Prefer correcting in conversation.

### Directory Structure

```text
Odyssey/
  Conversations/     Saved conversation records
  L1_Recent_Memory/   Recent raw memories and summaries
  Corrections/       Append-only correction records
  References/        Imported vault reference material
  Exports/           Exported chat notes
  Index/             Local derived index files
```

### Disclaimer

Odyssey responses are AI-generated and may be wrong, incomplete, or based on misunderstood context. Odyssey is not a substitute for medical, legal, financial, mental-health, safety, or other professional advice. For important decisions, verify independently and seek qualified support.
