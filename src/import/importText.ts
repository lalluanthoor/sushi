import { FSHImporter } from './FSHImporter';
import { FSHDocument } from './FSHDocument';
import { RawFSH } from './RawFSH';
import { Config } from '../fshtypes/Config';
import { FHIRDefinitions } from '../fhirdefs';

/**
 * Parses various text strings into individual FSHDocuments.
 * @param {RawFSH[]} rawFSHes - the list of RawFSH to parse into FSHDocuments
 * @param {Config} config - the project configuration
 * @returns {FSHDocument[]} - the FSH documents representing each parsed text
 */
export function importText(
  rawFSHes: RawFSH[],
  config: Config,
  fhirDefs: FHIRDefinitions
): FSHDocument[] {
  const importer = new FSHImporter(fhirDefs);

  return importer.import(rawFSHes, config);
}
