import { Configuration, PackageJSON } from '../fshtypes';
import { isEmpty } from 'lodash';

/**
 * Exporter to create an NPM package manifest according to the guidance given here:
 * https://confluence.hl7.org/display/FHIR/NPM+Package+Specification#NPMPackageSpecification-Packagemanifest
 * Note that keywords and and homepage are excluded
 */
export class PackageJSONExporter {
  constructor(private readonly config: Configuration) {}

  export(): PackageJSON {
    // Init package.json using properties taken directly from config
    const packageJSON: PackageJSON = {
      name: this.config.packageId,
      version: this.config.version,
      canonical: this.config.canonical,
      url: this.config.rendering,
      title: this.config.title,
      description: this.config.description,
      fhirVersions: this.config.fhirVersion,
      author: this.config.publisher,
      license: this.config.license
    };
    // Translate config.dependencies into package.json dependencies
    if (this.config.dependencies?.length > 0) {
      // For a package generated with SUSHI, hl7.fhir.r4.core#4.0.1 is always a dependency
      const dependencies: PackageJSON['dependencies'] = { 'hl7.fhir.r4.core': '4.0.1' };
      this.config.dependencies.forEach(dep => {
        if (dep.packageId && dep.version) {
          dependencies[dep.packageId] = dep.version;
        }
      });
      if (!isEmpty(dependencies)) {
        packageJSON.dependencies = dependencies;
      }
    }
    // Translate config.contact into package.json maintainers
    if (this.config.contact?.length > 0) {
      const maintainers: PackageJSON['maintainers'] = [];
      this.config.contact.forEach(contact => {
        // By default the first email/url in the telecom list will be used
        const emailTelecom = contact.telecom?.find(t => t.system === 'email');
        const urlTelecom = contact.telecom?.find(t => t.system === 'url');
        if (contact.name && (emailTelecom || urlTelecom)) {
          maintainers.push({
            name: contact.name,
            email: emailTelecom?.value,
            url: urlTelecom?.value
          });
        }
      });
      if (maintainers.length > 0) {
        packageJSON.maintainers = maintainers;
      }
    }
    return packageJSON;
  }
}
