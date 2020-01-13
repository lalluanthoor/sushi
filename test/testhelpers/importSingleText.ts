import { importText, FSHDocument, RawFSH } from '../../src/import';
import { Config } from '../../src/fshtypes';

export function importSingleText(content: string, path?: string, config?: Config): FSHDocument {
  if (!config) {
    config = {
      name: 'test',
      version: '0.0.1',
      canonical: 'http://example.org'
    };
  }
  return importText([new RawFSH(content, path)], config)[0];
}
