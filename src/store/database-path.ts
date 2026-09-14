import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

function canonicalPath(value: string): string {
  let current = resolve(value);
  const missing: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(value);
      missing.push(basename(current));
      current = parent;
    }
  }
}

export function sameDatabaseFile(left: string, right: string): boolean {
  if (canonicalPath(left) === canonicalPath(right)) return true;
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}
