export class TFile {
  path: string;
  basename: string;
  stat: { mtime: number };

  constructor(path: string) {
    this.path = normalizePath(path);
    this.basename = this.path.split("/").pop()?.replace(/\.md$/, "") ?? this.path;
    this.stat = { mtime: Date.now() };
  }
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}
