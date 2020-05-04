import { PackageJSONExporter } from '../../src/export';
import { Configuration } from '../../src/fshtypes';
import { minimalConfig } from '../utils/minimalConfig';

describe('PackageJSONExporter', () => {
  let testConfig: Configuration;

  beforeEach(() => {
    testConfig = {
      ...minimalConfig,
      packageId: 'fhir.us.minimal.packageId',
      title: 'Minimal Implementation Guide',
      description: 'This is a minimal IG we are using for testing.',
      publisher: 'The FSH Team',
      license: 'CC0-1.0',
      rendering: 'http://hl7.org/fhir/us/minimal/home'
    };
  });

  it('should export a basic package.json with all properties given directly in config.yaml', () => {
    const packageJSON = new PackageJSONExporter(testConfig).export();
    expect(packageJSON).toEqual({
      name: 'fhir.us.minimal.packageId',
      version: '1.0.0',
      canonical: 'http://hl7.org/fhir/us/minimal',
      title: 'Minimal Implementation Guide',
      description: 'This is a minimal IG we are using for testing.',
      fhirVersions: ['4.0.1'],
      author: 'The FSH Team',
      license: 'CC0-1.0',
      url: 'http://hl7.org/fhir/us/minimal/home'
    });
  });

  describe('#dependencies', () => {
    it('should export a package.json with dependencies', () => {
      const packageJSON = new PackageJSONExporter({
        ...testConfig,
        dependencies: [
          {
            packageId: 'hl7.fhir.us.pack1',
            version: '1.1.1'
          },
          {
            packageId: 'hl7.fhir.us.pack2',
            version: '2.2.2'
          }
        ]
      }).export();
      expect(packageJSON.dependencies).toEqual({
        'hl7.fhir.r4.core': '4.0.1',
        'hl7.fhir.us.pack1': '1.1.1',
        'hl7.fhir.us.pack2': '2.2.2'
      });
    });

    it('should export a package.json while ignoring dependencies without a packageId and version', () => {
      const packageJSON = new PackageJSONExporter({
        ...testConfig,
        dependencies: [
          {
            packageId: 'hl7.fhir.us.pack1',
            version: '1.1.1'
          },
          {
            uri: 'http://somUri.org'
          },
          {
            packageId: 'hl7.fhir.us.pack2'
          },
          {
            version: '2.2.2'
          }
        ]
      }).export();
      expect(packageJSON.dependencies).toEqual({
        'hl7.fhir.r4.core': '4.0.1',
        'hl7.fhir.us.pack1': '1.1.1'
      });
    });
  });

  describe('#maintainers', () => {
    it('should export a package.json with maintainers', () => {
      const packageJSON = new PackageJSONExporter({
        ...testConfig,
        contact: [
          {
            name: 'Ms. FHIR',
            telecom: [
              { system: 'email', value: 'msFHIR@fhir.org' },
              {
                system: 'url',
                value: 'http://fhir.org'
              }
            ]
          },
          {
            name: 'Mr. FHIR',
            telecom: [{ system: 'email', value: 'mrFHIR@fhir.org' }]
          }
        ]
      }).export();
      expect(packageJSON.maintainers).toEqual([
        { name: 'Ms. FHIR', email: 'msFHIR@fhir.org', url: 'http://fhir.org' },
        { name: 'Mr. FHIR', email: 'mrFHIR@fhir.org' }
      ]);
    });

    it('should export a package.json but not add maintainers with no emails or urls', () => {
      const packageJSON = new PackageJSONExporter({
        ...testConfig,
        contact: [
          {
            name: 'Ms. FHIR',
            telecom: [{ system: 'phone', value: '978-654-3210' }]
          },
          {
            name: 'Mr. FHIR'
          }
        ]
      }).export();
      expect(packageJSON.maintainers).toBeUndefined();
    });
  });
});
