# Distribution Notes

This repository contains the public source build of Odyssey for Obsidian. It is licensed under GNU AGPL-3.0 and builds a functional local-first plugin with baseline prompts in the source code.

## Public Source Build

The public build:

- includes the memory, retrieval, correction, privacy, and user-interface code in this repository;
- supports user-owned prompt overrides through `Odyssey/Prompts/`;
- does not contain Odyssey's proprietary dialogue prompt resources or their packaging tooling;
- produces a `main.js` that can be inspected and rebuilt from this repository.

`src/context/packaged-prompt-resources.ts` is intentionally an empty provider in this repository.

## Official Distribution Builds

An official packaged distribution may provide additional local-only dialogue prompt resources to improve conversation quality. Those resources:

- execute on the user's device;
- do not require an Odyssey server or account;
- do not add telemetry;
- do not change where model requests are sent: requests go only to the provider configured by the user.

The private release build may replace the empty packaged-prompt provider and use release-only packaging measures intended to discourage casual copying. These measures are not a claim that prompts are impossible to inspect during local execution.

Do not commit private prompt text, generated enhanced bundles, key material, or release-only packaging tooling to this public repository.

## Licensing Boundary

The source code in this repository is distributed under GNU AGPL-3.0. Any official package containing additional proprietary local resources must identify those resources and their applicable terms in the distribution, and should be reviewed against the publication requirements of its distribution channel before release.
