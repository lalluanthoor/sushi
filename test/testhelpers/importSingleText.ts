import { importText, FSHDocument, RawFSH } from '../../src/import';
import { Config } from '../../src/fshtypes';
import { FHIRDefinitions } from '../../src/fhirdefs';

export function importSingleText(
  content: string,
  path?: string,
  config?: Config,
  fhirDefs?: FHIRDefinitions
): FSHDocument {
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
  return importText([new RawFSH(content, path)], config, fhirDefs)[0];
}

export function importSingleTextFn(fhirDefs?: FHIRDefinitions): typeof importSingleText {
  return (
    content: string,
    path?: string,
    config?: Config,
    fhirDefsOverride?: FHIRDefinitions
  ): FSHDocument => {
    return importSingleText(content, path, config, fhirDefsOverride ?? fhirDefs);
  };
}
