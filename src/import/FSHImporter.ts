import * as pc from './parserContexts';
import { FSHDocument } from './FSHDocument';
import { RawFSH } from './RawFSH';
import { FSHErrorListener } from './FSHErrorListener';
import { FSHVisitor } from './generated/FSHVisitor';
import { FSHLexer } from './generated/FSHLexer';
import { FSHParser } from './generated/FSHParser';
import { FHIRDefinitions } from '../fhirdefs';
import {
  Config,
  Profile,
  Extension,
  FshCode,
  FshQuantity,
  FshRatio,
  FshReference,
  TextLocation,
  Instance,
  FshValueSet,
  ValueSetComponent,
  ValueSetConceptComponent,
  ValueSetFilterComponent,
  ValueSetComponentFrom,
  ValueSetFilter,
  VsOperator,
  ValueSetFilterValue
} from '../fshtypes';
import {
  Rule,
  CardRule,
  FlagRule,
  ValueSetRule,
  FixedValueRule,
  FixedValueType,
  OnlyRule,
  ContainsRule,
  CaretValueRule
} from '../fshtypes/rules';
import { ParserRuleContext, InputStream, CommonTokenStream } from 'antlr4';
import { logger } from '../utils/FSHLogger';
import { TerminalNode } from 'antlr4/tree/Tree';
import {
  RequiredMetadataError,
  ValueSetFilterOperatorError,
  ValueSetFilterValueTypeError,
  ValueSetFilterMissingValueError
} from '../errors';
import isEqual from 'lodash/isEqual';
import sortBy from 'lodash/sortBy';

enum SdMetadataKey {
  Id = 'Id',
  Parent = 'Parent',
  Title = 'Title',
  Description = 'Description',
  Unknown = 'Unknown'
}

enum InstanceMetadataKey {
  InstanceOf = 'InstanceOf',
  Title = 'Title',
  Unknown = 'Unknown'
}

enum VsMetadataKey {
  Id = 'Id',
  Title = 'Title',
  Description = 'Description',
  Unknown = 'Unknown'
}

enum Flag {
  MustSupport,
  Summary,
  Modifier,
  Unknown
}

enum EntityType {
  Alias,
  Profile,
  Extension,
  ValueSet,
  CodeSystem,
  Instance,
  Resource, // NOTE: only defined in FHIR defs, not FSHTanks
  Type // NOTE: only defined in FHIR defs, not FSHTanks
}

/**
 * Contains the data for translating FSH names, ids, and aliases to URLs.  This data is collected
 * during a preprocessing step and used during import to substitute the names, ids, and aliases
 * w/ their URLs since the FHIR definitions must use the identifying URLs when referring to other
 * entities.
 */
class PreprocessedData {
  aliases: Map<string, string> = new Map();
  profiles: Map<string, string> = new Map();
  extensions: Map<string, string> = new Map();
  valueSets: Map<string, string> = new Map();
  codeSystems: Map<string, string> = new Map();
  instances: Map<string, string> = new Map();
  all: Map<string, string> = new Map();

  forType(type: EntityType): Map<string, string> {
    switch (type) {
      case EntityType.Alias:
        return this.aliases;
      case EntityType.Profile:
        return this.profiles;
      case EntityType.Extension:
        return this.extensions;
      case EntityType.ValueSet:
        return this.valueSets;
      case EntityType.CodeSystem:
        return this.codeSystems;
      case EntityType.Instance:
        return this.instances;
      default:
        // NOTE: the following are not defined in FSH, so only exist in FHIRDefinitions:
        // - EntityType.Resource
        // - EntityType.Type
        // In this case, just return an empty map since nothing can/will be found in the FSHTank.
        return new Map();
    }
  }

  register(name: string, value: string, type: EntityType) {
    const typeMap = this.forType(type);
    if (typeMap.has(name) && typeMap.get(name) !== value) {
      // error
    } else if (this.all.has(name) && this.all.get(name) !== value) {
      // error
    } else {
      typeMap.set(name, value);
      this.all.set(name, value);
    }
  }
}

/**
 * FSHImporter handles the parsing of FSH documents, constructing the data into FSH types.
 * FSHImporter uses a visitor pattern approach with some accomodations due to the ANTLR4
 * implementation and TypeScript requirements.  For example, the `accept` functions that
 * each `ctx` has cannot be used because their signatures return `void` by default. Instead,
 * we must call the explicit visitX functions.
 */
export class FSHImporter extends FSHVisitor {
  private readonly fhirDefs: FHIRDefinitions;
  private currentFile: string;
  private currentDoc: FSHDocument;
  private preprocessedData: PreprocessedData;

  constructor(fhirDefs: FHIRDefinitions) {
    super();
    this.fhirDefs = fhirDefs;
  }

  import(rawFSHes: RawFSH[], config: Config): FSHDocument[] {
    const docs: FSHDocument[] = [];
    const contexts: pc.DocContext[] = [];
    rawFSHes.forEach(rawFSH => {
      docs.push(new FSHDocument(rawFSH.path));
      contexts.push(this.parseDoc(rawFSH.content, rawFSH.path));
    });

    this.preprocess(contexts, config);

    contexts.forEach((context, index) => {
      this.currentDoc = docs[index];
      this.currentFile = this.currentDoc.file ?? '';
      this.visitDoc(context);
      this.currentDoc = null;
      this.currentFile = null;
    });

    return docs;
  }

  preprocess(contexts: pc.DocContext[], config: Config): void {
    const data = new PreprocessedData();
    contexts.forEach(ctx => {
      ctx.entity().forEach(e => {
        if (e.alias()) {
          const [name, url] = e
            .alias()
            .SEQUENCE()
            .map(s => s.getText());
          data.register(name, url, EntityType.Alias);
        }

        if (e.profile() || e.extension()) {
          const sd = e.profile() ?? e.extension();
          const pName = sd.SEQUENCE().getText();
          const pId = sd
            .sdMetadata()
            .find(sdMeta => sdMeta.id() != null)
            ?.id()
            .SEQUENCE()
            .getText();
          const url = `${config.canonical}/StructureDefinition/${pId ?? pName}`;
          data.register(pName, url, e.profile() ? EntityType.Profile : EntityType.Extension);
          if (pId != null && pId !== pName) {
            data.register(pId, url, e.profile() ? EntityType.Profile : EntityType.Extension);
          }
        }

        if (e.valueSet()) {
          const vsName = e
            .valueSet()
            .SEQUENCE()
            .getText();
          const vsId = e
            .valueSet()
            .vsMetadata()
            .find(vsMeta => vsMeta.id() != null)
            ?.id()
            .SEQUENCE()
            .getText();
          const url = `${config.canonical}/ValueSet/${vsId ?? vsName}`;
          data.register(vsName, url, EntityType.ValueSet);
          if (vsId != null && vsId !== vsName) {
            data.register(vsId, url, EntityType.ValueSet);
          }
        }

        // TODO: CodeSystem

        // TODO: Instance
      });
    });

    this.preprocessedData = data;
  }

  visitDoc(ctx: pc.DocContext): void {
    ctx.entity().forEach(e => {
      this.visitEntity(e);
    });
  }

  visitEntity(ctx: pc.EntityContext): void {
    if (ctx.alias()) {
      this.visitAlias(ctx.alias());
    }

    if (ctx.profile()) {
      this.visitProfile(ctx.profile());
    }

    if (ctx.extension()) {
      this.visitExtension(ctx.extension());
    }

    if (ctx.instance()) {
      this.visitInstance(ctx.instance());
    }

    if (ctx.valueSet()) {
      this.visitValueSet(ctx.valueSet());
    }
  }

  visitAlias(ctx: pc.AliasContext): void {
    this.currentDoc.aliases.set(ctx.SEQUENCE()[0].getText(), ctx.SEQUENCE()[1].getText());
  }

  visitProfile(ctx: pc.ProfileContext) {
    const profile = new Profile(ctx.SEQUENCE().getText())
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    this.parseProfileOrExtension(profile, ctx.sdMetadata(), ctx.sdRule());
    this.currentDoc.profiles.set(profile.name, profile);
  }

  visitExtension(ctx: pc.ExtensionContext) {
    const extension = new Extension(ctx.SEQUENCE().getText())
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    this.parseProfileOrExtension(extension, ctx.sdMetadata(), ctx.sdRule());
    this.currentDoc.extensions.set(extension.name, extension);
  }

  private parseProfileOrExtension(
    def: Profile | Extension,
    metaCtx: pc.SdMetadataContext[] = [],
    ruleCtx: pc.SdRuleContext[] = []
  ): void {
    const seenPairs: Map<SdMetadataKey, string> = new Map();
    metaCtx
      .map(sdMeta => ({ ...this.visitSdMetadata(sdMeta), context: sdMeta }))
      .forEach(pair => {
        if (seenPairs.has(pair.key)) {
          logger.error(
            `Metadata field '${pair.key}' already declared with value '${seenPairs.get(
              pair.key
            )}'.`,
            { file: this.currentFile, location: this.extractStartStop(pair.context) }
          );
          return;
        }
        seenPairs.set(pair.key, pair.value);
        if (pair.key === SdMetadataKey.Id) {
          def.id = pair.value;
        } else if (pair.key === SdMetadataKey.Parent) {
          def.parent = pair.value;
        } else if (pair.key === SdMetadataKey.Title) {
          def.title = pair.value;
        } else if (pair.key === SdMetadataKey.Description) {
          def.description = pair.value;
        }
      });
    ruleCtx.forEach(sdRule => {
      def.rules.push(...this.visitSdRule(sdRule));
    });
  }

  visitInstance(ctx: pc.InstanceContext) {
    const instance = new Instance(ctx.SEQUENCE().getText())
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    try {
      this.parseInstance(instance, ctx.instanceMetadata(), ctx.fixedValueRule());
      this.currentDoc.instances.set(instance.name, instance);
    } catch (e) {
      logger.error(e.message, instance.sourceInfo);
    }
  }

  private parseInstance(
    instance: Instance,
    metaCtx: pc.InstanceMetadataContext[] = [],
    ruleCtx: pc.FixedValueRuleContext[] = []
  ): void {
    const seenPairs: Map<InstanceMetadataKey, string> = new Map();
    metaCtx
      .map(instanceMetadata => ({
        ...this.visitInstanceMetadata(instanceMetadata),
        context: instanceMetadata
      }))
      .forEach(pair => {
        if (seenPairs.has(pair.key)) {
          logger.error(
            `Metadata field '${pair.key}' already declared with value '${seenPairs.get(
              pair.key
            )}'.`,
            { file: this.currentFile, location: this.extractStartStop(pair.context) }
          );
          return;
        }
        seenPairs.set(pair.key, pair.value);
        if (pair.key === InstanceMetadataKey.InstanceOf) {
          instance.instanceOf = pair.value;
        } else if (pair.key === InstanceMetadataKey.Title) {
          instance.title = pair.value;
        }
      });
    if (!instance.instanceOf) {
      throw new RequiredMetadataError('InstanceOf', 'Instance', instance.name);
    }
    ruleCtx.forEach(fvRule => {
      instance.rules.push(this.visitFixedValueRule(fvRule));
    });
  }

  visitValueSet(ctx: pc.ValueSetContext) {
    const valueSet = new FshValueSet(ctx.SEQUENCE().getText())
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    this.parseValueSet(valueSet, ctx.vsMetadata(), ctx.vsComponent());
    this.currentDoc.valueSets.set(valueSet.name, valueSet);
  }

  private parseValueSet(
    valueSet: FshValueSet,
    metaCtx: pc.VsMetadataContext[] = [],
    componentCtx: pc.VsComponentContext[] = []
  ) {
    const seenPairs: Map<VsMetadataKey, string> = new Map();
    metaCtx
      .map(vsMetadata => ({
        ...this.visitVsMetadata(vsMetadata),
        context: vsMetadata
      }))
      .forEach(pair => {
        if (seenPairs.has(pair.key)) {
          logger.error(
            `Metadata field '${pair.key}' already declared with value '${seenPairs.get(
              pair.key
            )}'.`,
            { file: this.currentFile, location: this.extractStartStop(pair.context) }
          );
          return;
        }
        seenPairs.set(pair.key, pair.value);
        if (pair.key === VsMetadataKey.Id) {
          valueSet.id = pair.value;
        } else if (pair.key === VsMetadataKey.Title) {
          valueSet.title = pair.value;
        } else if (pair.key === VsMetadataKey.Description) {
          valueSet.description = pair.value;
        }
      });
    componentCtx
      .map(vsComponentCtx => this.visitVsComponent(vsComponentCtx))
      .forEach(vsComponent => {
        // if vsComponent is a concept component,
        // we may be able to merge its concepts into an existing concept component.
        if (vsComponent instanceof ValueSetConceptComponent) {
          const matchedComponent = valueSet.components.find(existingComponent => {
            return (
              existingComponent instanceof ValueSetConceptComponent &&
              vsComponent.inclusion == existingComponent.inclusion &&
              vsComponent.from.system == existingComponent.from.system &&
              isEqual(sortBy(vsComponent.from.valueSets), sortBy(existingComponent.from.valueSets))
            );
          }) as ValueSetConceptComponent;
          if (matchedComponent) {
            matchedComponent.concepts.push(...vsComponent.concepts);
          } else {
            valueSet.components.push(vsComponent);
          }
        } else {
          valueSet.components.push(vsComponent);
        }
      });
  }

  visitSdMetadata(ctx: pc.SdMetadataContext): { key: SdMetadataKey; value: string } {
    if (ctx.id()) {
      return { key: SdMetadataKey.Id, value: this.visitId(ctx.id()) };
    } else if (ctx.parent()) {
      return { key: SdMetadataKey.Parent, value: this.visitParent(ctx.parent()) };
    } else if (ctx.title()) {
      return { key: SdMetadataKey.Title, value: this.visitTitle(ctx.title()) };
    } else if (ctx.description()) {
      return { key: SdMetadataKey.Description, value: this.visitDescription(ctx.description()) };
    }
    return { key: SdMetadataKey.Unknown, value: ctx.getText() };
  }

  visitInstanceMetadata(
    ctx: pc.InstanceMetadataContext
  ): { key: InstanceMetadataKey; value: string } {
    if (ctx.instanceOf()) {
      return { key: InstanceMetadataKey.InstanceOf, value: this.visitInstanceOf(ctx.instanceOf()) };
    } else if (ctx.title()) {
      return { key: InstanceMetadataKey.Title, value: this.visitTitle(ctx.title()) };
    }
    return { key: InstanceMetadataKey.Unknown, value: ctx.getText() };
  }

  visitVsMetadata(ctx: pc.VsMetadataContext): { key: VsMetadataKey; value: string } {
    if (ctx.id()) {
      return { key: VsMetadataKey.Id, value: this.visitId(ctx.id()) };
    } else if (ctx.title()) {
      return { key: VsMetadataKey.Title, value: this.visitTitle(ctx.title()) };
    } else if (ctx.description()) {
      return { key: VsMetadataKey.Description, value: this.visitDescription(ctx.description()) };
    }
    return { key: VsMetadataKey.Unknown, value: ctx.getText() };
  }

  visitId(ctx: pc.IdContext): string {
    return ctx.SEQUENCE().getText();
  }

  visitParent(ctx: pc.ParentContext): string {
    return this.normalizedValue(
      ctx.SEQUENCE().getText(),
      EntityType.Alias,
      EntityType.Profile,
      EntityType.Extension,
      EntityType.Resource,
      EntityType.Type
    );
  }

  visitTitle(ctx: pc.TitleContext): string {
    return this.extractString(ctx.STRING());
  }

  visitDescription(ctx: pc.DescriptionContext): string {
    if (ctx.STRING()) {
      return this.extractString(ctx.STRING());
    }

    // it must be a multiline string
    return this.extractMultilineString(ctx.MULTILINE_STRING());
  }

  visitInstanceOf(ctx: pc.InstanceOfContext): string {
    return this.normalizedValue(
      ctx.SEQUENCE().getText(),
      EntityType.Alias,
      EntityType.Profile,
      EntityType.Extension,
      EntityType.Resource,
      EntityType.Type
    );
  }

  visitSdRule(ctx: pc.SdRuleContext): Rule[] {
    if (ctx.cardRule()) {
      return this.visitCardRule(ctx.cardRule());
    } else if (ctx.flagRule()) {
      return this.visitFlagRule(ctx.flagRule());
    } else if (ctx.valueSetRule()) {
      return [this.visitValueSetRule(ctx.valueSetRule())];
    } else if (ctx.fixedValueRule()) {
      return [this.visitFixedValueRule(ctx.fixedValueRule())];
    } else if (ctx.onlyRule()) {
      return [this.visitOnlyRule(ctx.onlyRule())];
    } else if (ctx.containsRule()) {
      return this.visitContainsRule(ctx.containsRule());
    } else if (ctx.caretValueRule()) {
      return [this.visitCaretValueRule(ctx.caretValueRule())];
    }
    logger.warn(`Unsupported rule: ${ctx.getText()}`, {
      file: this.currentFile,
      location: this.extractStartStop(ctx)
    });
    return [];
  }

  visitPath(ctx: pc.PathContext): string {
    return ctx.SEQUENCE().getText();
  }

  visitCaretPath(ctx: pc.CaretPathContext): string {
    return ctx.CARET_SEQUENCE().getText();
  }

  visitPaths(ctx: pc.PathsContext): string[] {
    return ctx
      .COMMA_DELIMITED_SEQUENCES()
      .getText()
      .split(/,\s+/);
  }

  visitCardRule(ctx: pc.CardRuleContext): (CardRule | FlagRule)[] {
    const rules: (CardRule | FlagRule)[] = [];

    const cardRule = new CardRule(this.visitPath(ctx.path()))
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    const card = this.parseCard(ctx.CARD().getText());
    cardRule.min = card.min;
    cardRule.max = card.max;
    rules.push(cardRule);

    if (ctx.flag() && ctx.flag().length > 0) {
      const flagRule = new FlagRule(cardRule.path)
        .withLocation(this.extractStartStop(ctx))
        .withFile(this.currentFile);
      this.parseFlags(flagRule, ctx.flag());
      rules.push(flagRule);
    }
    return rules;
  }

  private parseCard(card: string): { min: number; max: string } {
    const parts = card.split('..', 2);
    return {
      min: parseInt(parts[0]),
      max: parts[1]
    };
  }

  visitFlagRule(ctx: pc.FlagRuleContext): FlagRule[] {
    let paths: string[];
    if (ctx.path()) {
      paths = [this.visitPath(ctx.path())];
    } else if (ctx.paths()) {
      paths = this.visitPaths(ctx.paths());
    }

    return paths.map(path => {
      const flagRule = new FlagRule(path)
        .withLocation(this.extractStartStop(ctx))
        .withFile(this.currentFile);
      this.parseFlags(flagRule, ctx.flag());
      return flagRule;
    });
  }

  private parseFlags(flagRule: FlagRule, flagContext: pc.FlagContext[]): void {
    const flags = flagContext.map(f => this.visitFlag(f));
    if (flags.includes(Flag.MustSupport)) {
      flagRule.mustSupport = true;
    }
    if (flags.includes(Flag.Summary)) {
      flagRule.summary = true;
    }
    if (flags.includes(Flag.Modifier)) {
      flagRule.modifier = true;
    }
  }

  visitFlag(ctx: pc.FlagContext): Flag {
    if (ctx.KW_MS()) {
      return Flag.MustSupport;
    } else if (ctx.KW_SU()) {
      return Flag.Summary;
    } else if (ctx.KW_MOD()) {
      return Flag.Modifier;
    }
    return Flag.Unknown;
  }

  visitValueSetRule(ctx: pc.ValueSetRuleContext): ValueSetRule {
    const vsRule = new ValueSetRule(this.visitPath(ctx.path()))
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    vsRule.valueSet = this.normalizedValue(
      ctx.SEQUENCE().getText(),
      EntityType.Alias,
      EntityType.ValueSet
    );
    vsRule.strength = ctx.strength() ? this.visitStrength(ctx.strength()) : 'required';
    return vsRule;
  }

  visitStrength(ctx: pc.StrengthContext): string {
    if (ctx.KW_EXAMPLE()) {
      return 'example';
    } else if (ctx.KW_PREFERRED()) {
      return 'preferred';
    } else if (ctx.KW_EXTENSIBLE()) {
      return 'extensible';
    }
    return 'required';
  }

  visitFixedValueRule(ctx: pc.FixedValueRuleContext): FixedValueRule {
    const fixedValueRule = new FixedValueRule(this.visitPath(ctx.path()))
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    fixedValueRule.fixedValue = this.visitValue(ctx.value());
    return fixedValueRule;
  }

  visitValue(ctx: pc.ValueContext): FixedValueType {
    if (ctx.STRING()) {
      return this.extractString(ctx.STRING());
    }

    if (ctx.MULTILINE_STRING()) {
      return this.extractMultilineString(ctx.MULTILINE_STRING());
    }

    if (ctx.NUMBER()) {
      return parseFloat(ctx.NUMBER().getText());
    }

    if (ctx.DATETIME()) {
      // for now, treat datetime like a string
      return ctx.DATETIME().getText();
    }

    if (ctx.TIME()) {
      // for now, treat datetime like a string
      return ctx.TIME().getText();
    }

    if (ctx.reference()) {
      return this.visitReference(ctx.reference());
    }

    if (ctx.code()) {
      return this.visitCode(ctx.code());
    }

    if (ctx.quantity()) {
      return this.visitQuantity(ctx.quantity());
    }

    if (ctx.ratio()) {
      return this.visitRatio(ctx.ratio());
    }

    if (ctx.bool()) {
      return this.visitBool(ctx.bool());
    }
  }

  visitCode(ctx: pc.CodeContext): FshCode {
    const conceptText = ctx
      .CODE()
      .getText()
      .split('#', 2);
    const system = conceptText[0];
    let code = conceptText[1];
    if (code.startsWith('"')) {
      code = code
        .slice(1, code.length - 1)
        .replace(/\\\\/g, '\\')
        .replace(/\\"/g, '"');
    }
    const concept = new FshCode(code)
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    if (system && system.length > 0) {
      concept.system = this.normalizedValue(system, EntityType.Alias, EntityType.CodeSystem);
    }
    if (ctx.STRING()) {
      concept.display = this.extractString(ctx.STRING());
    }
    return concept;
  }

  visitQuantity(ctx: pc.QuantityContext): FshQuantity {
    const value = parseFloat(ctx.NUMBER().getText());
    const delimitedUnit = ctx.UNIT().getText(); // e.g., 'mm'
    // the literal version of quantity always assumes UCUM code system
    const unit = new FshCode(delimitedUnit.slice(1, -1), 'http://unitsofmeasure.org')
      .withLocation(this.extractStartStop(ctx.UNIT()))
      .withFile(this.currentFile);
    const quantity = new FshQuantity(value, unit)
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    return quantity;
  }

  visitRatio(ctx: pc.RatioContext): FshRatio {
    const ratio = new FshRatio(
      this.visitRatioPart(ctx.ratioPart()[0]),
      this.visitRatioPart(ctx.ratioPart()[1])
    )
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    return ratio;
  }

  visitRatioPart(ctx: pc.RatioPartContext): FshQuantity {
    if (ctx.NUMBER()) {
      const quantity = new FshQuantity(parseFloat(ctx.NUMBER().getText()))
        .withLocation(this.extractStartStop(ctx.NUMBER()))
        .withFile(this.currentFile);
      return quantity;
    }
    return this.visitQuantity(ctx.quantity());
  }

  visitReference(ctx: pc.ReferenceContext): FshReference {
    const ref = new FshReference(
      this.normalizedValue(
        this.parseReference(ctx.REFERENCE().getText())[0],
        EntityType.Alias,
        EntityType.Profile,
        EntityType.Extension,
        EntityType.ValueSet,
        EntityType.CodeSystem,
        EntityType.Instance
        // purposefully exclude Resource and Type -- we don't want URLs for those
      )
    )
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    if (ctx.STRING()) {
      ref.display = this.extractString(ctx.STRING());
    }
    return ref;
  }

  private parseReference(reference: string): string[] {
    return reference.slice(reference.indexOf('(') + 1, reference.length - 1).split(/\s*\|\s*/);
  }

  visitBool(ctx: pc.BoolContext): boolean {
    return ctx.KW_TRUE() != null;
  }

  visitOnlyRule(ctx: pc.OnlyRuleContext): OnlyRule {
    const onlyRule = new OnlyRule(this.visitPath(ctx.path()))
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);
    ctx.targetType().forEach(t => {
      if (t.reference()) {
        const references = this.parseReference(
          t
            .reference()
            .REFERENCE()
            .getText()
        );
        references.forEach(r =>
          onlyRule.types.push({
            type: this.normalizedValue(
              r,
              EntityType.Alias,
              EntityType.Profile,
              EntityType.Extension
            ),
            isReference: true
          })
        );
      } else {
        onlyRule.types.push({
          type: this.normalizedValue(
            t.SEQUENCE().getText(),
            EntityType.Alias,
            EntityType.Profile,
            EntityType.Extension
          )
        });
      }
    });
    return onlyRule;
  }

  visitContainsRule(ctx: pc.ContainsRuleContext): (ContainsRule | CardRule | FlagRule)[] {
    const rules: (ContainsRule | CardRule | FlagRule)[] = [];
    const containsRule = new ContainsRule(this.visitPath(ctx.path()))
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);

    rules.push(containsRule);
    ctx.item().forEach(i => {
      const item = i.SEQUENCE().getText();
      containsRule.items.push(item);

      const cardRule = new CardRule(`${containsRule.path}[${item}]`)
        .withLocation(this.extractStartStop(i))
        .withFile(this.currentFile);
      const card = this.parseCard(i.CARD().getText());
      cardRule.min = card.min;
      cardRule.max = card.max;
      rules.push(cardRule);

      if (i.flag() && i.flag().length > 0) {
        const flagRule = new FlagRule(`${containsRule.path}[${item}]`)
          .withLocation(this.extractStartStop(i))
          .withFile(this.currentFile);
        this.parseFlags(flagRule, i.flag());
        rules.push(flagRule);
      }
    });
    return rules;
  }

  visitCaretValueRule(ctx: pc.CaretValueRuleContext): CaretValueRule {
    const path = ctx.path() ? this.visitPath(ctx.path()) : '';
    const caretValueRule = new CaretValueRule(path)
      .withLocation(this.extractStartStop(ctx))
      .withFile(this.currentFile);

    // Get the caret path, but slice off the starting ^
    caretValueRule.caretPath = this.visitCaretPath(ctx.caretPath()).slice(1);
    caretValueRule.value = this.visitValue(ctx.value());
    return caretValueRule;
  }

  visitVsComponent(ctx: pc.VsComponentContext): ValueSetComponent {
    const inclusion = ctx.KW_EXCLUDE() == null;
    let vsComponent: ValueSetConceptComponent | ValueSetFilterComponent;
    if (ctx.vsConceptComponent()) {
      vsComponent = new ValueSetConceptComponent(inclusion);
      [vsComponent.concepts, vsComponent.from] = this.visitVsConceptComponent(
        ctx.vsConceptComponent()
      );
    } else if (ctx.vsFilterComponent()) {
      vsComponent = new ValueSetFilterComponent(inclusion);
      [vsComponent.filters, vsComponent.from] = this.visitVsFilterComponent(
        ctx.vsFilterComponent()
      );
    }
    return vsComponent;
  }

  visitVsConceptComponent(ctx: pc.VsConceptComponentContext): [FshCode[], ValueSetComponentFrom] {
    const concepts: FshCode[] = [];
    const from: ValueSetComponentFrom = ctx.vsComponentFrom()
      ? this.visitVsComponentFrom(ctx.vsComponentFrom())
      : {};
    if (ctx.code()) {
      const singleCode = this.visitCode(ctx.code());
      if (singleCode.system && from.system) {
        logger.error(`Concept ${singleCode.code} specifies system multiple times`, {
          file: this.currentFile,
          location: this.extractStartStop(ctx)
        });
      } else if (singleCode.system) {
        from.system = singleCode.system;
        concepts.push(singleCode);
      } else if (from.system) {
        singleCode.system = from.system;
        concepts.push(singleCode);
      } else {
        logger.error(
          `Concept ${singleCode.code} must include system as "SYSTEM#CONCEPT" or "#CONCEPT from system SYSTEM"`,
          {
            file: this.currentFile,
            location: this.extractStartStop(ctx)
          }
        );
      }
    } else if (ctx.COMMA_DELIMITED_CODES()) {
      if (from.system) {
        const codes = ctx
          .COMMA_DELIMITED_CODES()
          .getText()
          .split(/\s*,\s+#/);
        codes[0] = codes[0].slice(1);
        const location = this.extractStartStop(ctx.COMMA_DELIMITED_CODES());
        codes.forEach(code => {
          let codePart: string, description: string;
          if (code.charAt(0) == '"') {
            // codePart is a quoted string, just like description (if present).
            [codePart, description] = code
              .match(/"([^\s\\"]|\\"|\\\\)+(\s([^\s\\"]|\\"|\\\\)+)*"/g)
              .map(quotedString => quotedString.slice(1, -1));
          } else {
            // codePart is not a quoted string.
            // if there is a description after the code,
            // it will be separated by whitespace before the leading "
            const codeEnd = code.match(/\s+"/)?.index;
            if (codeEnd) {
              codePart = code.slice(0, codeEnd);
              description = code
                .slice(codeEnd)
                .trim()
                .slice(1, -1);
            } else {
              codePart = code.trim();
            }
          }
          concepts.push(
            new FshCode(codePart, from.system, description)
              .withLocation(location)
              .withFile(this.currentFile)
          );
        });
      } else {
        logger.error('System is required when listing concepts in a value set component', {
          file: this.currentFile,
          location: this.extractStartStop(ctx)
        });
      }
    }
    return [concepts, from];
  }

  visitVsFilterComponent(
    ctx: pc.VsFilterComponentContext
  ): [ValueSetFilter[], ValueSetComponentFrom] {
    const filters: ValueSetFilter[] = [];
    const from: ValueSetComponentFrom = ctx.vsComponentFrom()
      ? this.visitVsComponentFrom(ctx.vsComponentFrom())
      : {};
    if (ctx.vsFilterList()) {
      if (from.system) {
        ctx
          .vsFilterList()
          .vsFilterDefinition()
          .forEach(filterDefinition => {
            try {
              filters.push(this.visitVsFilterDefinition(filterDefinition));
            } catch (e) {
              logger.error(e, {
                location: this.extractStartStop(filterDefinition),
                file: this.currentFile
              });
            }
          });
      } else {
        logger.error('System is required when filtering a value set component', {
          file: this.currentFile,
          location: this.extractStartStop(ctx)
        });
      }
    }
    return [filters, from];
  }

  visitVsComponentFrom(ctx: pc.VsComponentFromContext): ValueSetComponentFrom {
    const from: ValueSetComponentFrom = {};
    if (ctx.vsFromSystem()) {
      from.system = this.normalizedValue(
        ctx
          .vsFromSystem()
          .SEQUENCE()
          .getText(),
        EntityType.Alias,
        EntityType.CodeSystem
      );
    }
    if (ctx.vsFromValueset()) {
      if (ctx.vsFromValueset().SEQUENCE()) {
        from.valueSets = [
          this.normalizedValue(
            ctx
              .vsFromValueset()
              .SEQUENCE()
              .getText(),
            EntityType.Alias,
            EntityType.ValueSet
          )
        ];
      } else if (ctx.vsFromValueset().COMMA_DELIMITED_SEQUENCES()) {
        from.valueSets = ctx
          .vsFromValueset()
          .COMMA_DELIMITED_SEQUENCES()
          .getText()
          .split(',')
          .map(fromVs =>
            this.normalizedValue(fromVs.trim(), EntityType.Alias, EntityType.ValueSet)
          );
      }
    }
    return from;
  }

  /**
   * The replace makes FSH permissive in regards to the official specifications,
   * which spells operator "descendant-of" as "descendent-of".
   * @see {@link http://hl7.org/fhir/valueset-filter-operator.html}
   */
  visitVsFilterDefinition(ctx: pc.VsFilterDefinitionContext): ValueSetFilter {
    const property = ctx.SEQUENCE().getText();
    const operator = ctx
      .vsFilterOperator()
      .getText()
      .toLocaleLowerCase()
      .replace('descendant', 'descendent') as VsOperator;
    if (ctx.vsFilterValue() == null && operator !== VsOperator.EXISTS) {
      throw new ValueSetFilterMissingValueError(operator);
    }
    const value = ctx.vsFilterValue() ? this.visitVsFilterValue(ctx.vsFilterValue()) : true;
    switch (operator) {
      case VsOperator.EQUALS:
      case VsOperator.IN:
      case VsOperator.NOT_IN:
        if (typeof value !== 'string') {
          throw new ValueSetFilterValueTypeError(operator, 'string');
        }
        break;
      case VsOperator.IS_A:
      case VsOperator.DESCENDENT_OF:
      case VsOperator.IS_NOT_A:
      case VsOperator.GENERALIZES:
        if (!(value instanceof FshCode)) {
          throw new ValueSetFilterValueTypeError(operator, 'code');
        }
        break;
      case VsOperator.REGEX:
        if (!(value instanceof RegExp)) {
          throw new ValueSetFilterValueTypeError(operator, 'regex');
        }
        break;
      case VsOperator.EXISTS:
        if (typeof value !== 'boolean') {
          throw new ValueSetFilterValueTypeError(operator, 'boolean');
        }
        break;
      default:
        throw new ValueSetFilterOperatorError(ctx.vsFilterOperator().getText());
    }
    return {
      property: property,
      operator: operator,
      value: value
    };
  }

  visitVsFilterValue(ctx: pc.VsFilterValueContext): ValueSetFilterValue {
    if (ctx.code()) {
      return this.visitCode(ctx.code());
    } else if (ctx.REGEX()) {
      return RegExp(
        ctx
          .REGEX()
          .getText()
          .slice(1, -1)
      );
    } else if (ctx.STRING()) {
      return this.extractString(ctx.STRING());
    } else if (ctx.KW_TRUE()) {
      return true;
    } else if (ctx.KW_FALSE()) {
      return false;
    }
  }

  /**
   * Normalizes a name or id to a defining URL, optionally allowing a list of allowed types
   * to be passed in.
   * @param value - the value to normalize to a URL
   * @param types - the allowed types to resolve to
   */
  private normalizedValue(value: string, ...types: EntityType[]): string {
    // When no types are passed, it's essentially a global search for *anything*
    if (types.length === 0) {
      return this.preprocessedData.all.get(value) ?? this.fhirDefs.find(value) ?? value;
    }
    // First look at the local definitions in the FSH Tank
    for (const type of types) {
      const typeMap = this.preprocessedData.forType(type);
      if (typeMap.has(value)) {
        return typeMap.get(value);
      }
    }
    // Then look at the FHIR definitions (external spec and IGs).
    // This intentionally prefers local definitions over external ones.
    for (const type of types) {
      let def;
      switch (type) {
        case EntityType.Resource:
          def = this.fhirDefs.findResource(value);
          break;
        case EntityType.Type:
          def = this.fhirDefs.findType(value);
          break;
        case EntityType.Profile:
          def = this.fhirDefs.findProfile(value);
          break;
        case EntityType.Extension:
          def = this.fhirDefs.findExtension(value);
          break;
        case EntityType.ValueSet:
          def = this.fhirDefs.findValueSet(value);
          break;
        case EntityType.CodeSystem:
          def = this.fhirDefs.findCodeSystem(value);
          break;
        case EntityType.Instance: // don't support resolving to FHIR examples
        default:
          break;
      }
      if (def && def.url) {
        return def.url;
      }
    }
    // If we got here, just return back the value
    return value;
  }

  private extractString(stringCtx: ParserRuleContext): string {
    const str = stringCtx.getText();
    return str
      .slice(1, str.length - 1)
      .replace(/\\\\/g, '\\')
      .replace(/\\"/g, '"');
  }

  /**
   * Multiline strings receive special handling:
   * - if the first line contains only a newline, toss it
   * - if the last line contains only whitespace (including newline), toss it
   * - for all other lines, detect the shortest number of leading spaces and always trim that off;
   *   this allows authors to indent a whole block of text, but not have it indented in the output.
   */
  private extractMultilineString(mlStringCtx: ParserRuleContext): string {
    let mlstr = mlStringCtx.getText();

    // first remove leading/trailing """ and leading newline (if applicable)
    mlstr = mlstr.slice(mlstr[3] === '\n' ? 4 : 3, -3);

    // split into lines so we can process them to determine what leading spaces to trim
    const lines = mlstr.split('\n');

    // if the last line is only whitespace, remove it
    if (lines[lines.length - 1].search(/\S/) === -1) {
      lines.pop();
    }

    // find the minimum number of spaces before the first char (ignore zero-length lines)
    let minSpaces = 0;
    lines.forEach(line => {
      const firstNonSpace = line.search(/\S|$/);
      if (firstNonSpace > 0 && (minSpaces === 0 || firstNonSpace < minSpaces)) {
        minSpaces = firstNonSpace;
      }
    });

    // consistently remove the common leading spaces and join the lines back together
    return lines.map(l => (l.length >= minSpaces ? l.slice(minSpaces) : l)).join('\n');
  }

  private extractStartStop(ctx: ParserRuleContext): TextLocation {
    if (ctx instanceof TerminalNode) {
      return {
        startLine: ctx.symbol.line,
        startColumn: ctx.symbol.column + 1,
        endLine: ctx.symbol.line,
        endColumn: ctx.symbol.stop - ctx.symbol.start + ctx.symbol.column + 1
      };
    } else {
      return {
        startLine: ctx.start.line,
        startColumn: ctx.start.column + 1,
        endLine: ctx.stop.line,
        endColumn: ctx.stop.stop - ctx.stop.start + ctx.stop.column + 1
      };
    }
  }

  // NOTE: Since the ANTLR parser/lexer is JS (not typescript), we need to use some ts-ignore here.
  private parseDoc(input: string, file?: string): pc.DocContext {
    const chars = new InputStream(input);
    const lexer = new FSHLexer(chars);
    const listener = new FSHErrorListener(file);
    // @ts-ignore
    lexer.removeErrorListeners();
    // @ts-ignore
    lexer.addErrorListener(listener);
    // @ts-ignore
    const tokens = new CommonTokenStream(lexer);
    const parser = new FSHParser(tokens);
    // @ts-ignore
    parser.removeErrorListeners();
    // @ts-ignore
    parser.addErrorListener(listener);
    // @ts-ignore
    parser.buildParseTrees = true;
    // @ts-ignore
    return parser.doc() as DocContext;
  }
}
