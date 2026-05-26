// The public source build does not embed proprietary dialogue prompt resources.
// Official distribution builds may provide a local-only implementation at build time.
export function readPackagedPromptResource(_key: string, _lang: string): string | null {
  return null;
}
