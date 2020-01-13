import { importText, FSHDocument, RawFSH } from '../../src/import';
import { Config } from '../../src/fshtypes';
import { FHIRDefinitions } from '../../src/fhirdefs';

export function importMultipleText(
  content: string[],
  path: string[] = [],
  config?: Config,
  fhirDefs?: FHIRDefinitions
): FSHDocument[] {
  if (!config) {
    config = {
      name: 'test',
      version: '0.0.1',
      canonical: 'http://example.org'
    };
  }
  if (!fhirDefs) {
    fhirDefs = new FHIRDefinitions();
  }
  const rawFSHes = content.map((c, i) => {
    if (i < path.length) {
      return new RawFSH(c, path[i]);
    }
    return new RawFSH(c);
  });
  return importText(rawFSHes, config, fhirDefs);
}

export function importMultipleTextFn(fhirDefs?: FHIRDefinitions): typeof importMultipleText {
  return (
    content: string[],
    path: string[],
    config?: Config,
    fhirDefsOverride?: FHIRDefinitions
  ): FSHDocument[] => {
    return importMultipleText(content, path, config, fhirDefsOverride ?? fhirDefs);
  };
}
