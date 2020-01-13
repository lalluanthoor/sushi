import { importText, FSHDocument, RawFSH } from '../../src/import';
import { Config } from '../../src/fshtypes';

export function importMultipleText(
  content: string[],
  path: string[] = [],
  config?: Config
): FSHDocument[] {
  if (!config) {
    config = {
      name: 'test',
      version: '0.0.1',
      canonical: 'http://example.org'
    };
  }
  const rawFSHes = content.map((c, i) => {
    if (i < path.length) {
      return new RawFSH(c, path[i]);
    }
    return new RawFSH(c);
  });
  return importText(rawFSHes, config);
}
