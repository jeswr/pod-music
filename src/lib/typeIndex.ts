// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
//
// Solid Type Index read/write for Pod Music's primary class (mo:Track). No
// @solid/object wrapper ships for the type index, so we implement read+write
// through our own TermWrapper subclasses — never inline quads, never
// string-concatenated Turtle (AGENTS.md §RDF + the solid-type-index skill).
//
// The type index is convention-only: the server does not maintain it, CSS does
// not seed it, so callers must read-and-create-if-absent. This module supplies
// the typed model; the create-and-link orchestration lives in store.ts.

import {
  DatasetWrapper,
  NamedNodeAs,
  NamedNodeFrom,
  OptionalAs,
  OptionalFrom,
  SetFrom,
  TermWrapper,
} from "@rdfjs/wrapper";
import {
  RDF_TYPE,
  SOLID_FOR_CLASS,
  SOLID_INSTANCE,
  SOLID_INSTANCE_CONTAINER,
  SOLID_LISTED_DOCUMENT,
  SOLID_TYPE_INDEX,
  SOLID_TYPE_REGISTRATION,
} from "../vocab/iris.js";

/**
 * One `solid:TypeRegistration` entry — links a class IRI (`solid:forClass`) to a
 * single resource (`solid:instance`) or a container (`solid:instanceContainer`).
 * A registration uses one or the other, never both.
 */
export class TypeRegistration extends TermWrapper {
  get types(): Set<string> {
    return SetFrom.subjectPredicate(this, RDF_TYPE, NamedNodeAs.string, NamedNodeFrom.string);
  }

  get forClass(): string | undefined {
    return OptionalFrom.subjectPredicate(this, SOLID_FOR_CLASS, NamedNodeAs.string);
  }
  set forClass(value: string | undefined) {
    OptionalAs.object(this, SOLID_FOR_CLASS, value, NamedNodeFrom.string);
  }

  get instance(): string | undefined {
    return OptionalFrom.subjectPredicate(this, SOLID_INSTANCE, NamedNodeAs.string);
  }
  set instance(value: string | undefined) {
    OptionalAs.object(this, SOLID_INSTANCE, value, NamedNodeFrom.string);
  }

  get instanceContainer(): string | undefined {
    return OptionalFrom.subjectPredicate(this, SOLID_INSTANCE_CONTAINER, NamedNodeAs.string);
  }
  set instanceContainer(value: string | undefined) {
    OptionalAs.object(this, SOLID_INSTANCE_CONTAINER, value, NamedNodeFrom.string);
  }

  /** Stamp the solid:TypeRegistration rdf:type. Idempotent. */
  stampType(): this {
    if (!this.types.has(SOLID_TYPE_REGISTRATION)) {
      this.dataset.add(
        this.factory.quad(
          this as never,
          this.factory.namedNode(RDF_TYPE),
          this.factory.namedNode(SOLID_TYPE_REGISTRATION),
        ),
      );
    }
    return this;
  }
}

/**
 * A whole type-index document. Registrations are SIBLING subjects in the
 * document (not objects of the document subject), so this is a DatasetWrapper
 * that iterates `solid:TypeRegistration` instances.
 */
export class TypeIndexDataset extends DatasetWrapper {
  /** All registration entries in the document. */
  registrations(): TypeRegistration[] {
    return [...this.instancesOf(SOLID_TYPE_REGISTRATION, TypeRegistration)];
  }

  /** Registrations whose `solid:forClass` matches the given class IRI. */
  registrationsForClass(classIri: string): TypeRegistration[] {
    return this.registrations().filter((r) => r.forClass === classIri);
  }

  /**
   * The container IRIs registered for a class — drawn from both
   * `solid:instanceContainer` and the parent containers implied by
   * `solid:instance` are NOT inferred (a hint is a hint); we return exactly the
   * declared `solid:instanceContainer` values.
   */
  containersForClass(classIri: string): string[] {
    const out: string[] = [];
    for (const reg of this.registrationsForClass(classIri)) {
      const c = reg.instanceContainer;
      if (c !== undefined) {
        out.push(c);
      }
    }
    return out;
  }

  /** Instance resource IRIs registered for a class (`solid:instance`). */
  instancesForClass(classIri: string): string[] {
    const out: string[] = [];
    for (const reg of this.registrationsForClass(classIri)) {
      const i = reg.instance;
      if (i !== undefined) {
        out.push(i);
      }
    }
    return out;
  }

  /**
   * Add a registration for `classIri` → `containerIri` (a container) at the
   * given fragment subject (e.g. `<index.ttl#registration-track>`). Idempotent
   * for the (class, container) pair. Returns the registration wrapper.
   */
  registerContainer(
    registrationIri: string,
    classIri: string,
    containerIri: string,
  ): TypeRegistration {
    for (const reg of this.registrationsForClass(classIri)) {
      if (reg.instanceContainer === containerIri) {
        return reg;
      }
    }
    const reg = new TypeRegistration(registrationIri, this, this.factory);
    reg.stampType();
    reg.forClass = classIri;
    reg.instanceContainer = containerIri;
    return reg;
  }

  /** Stamp the document subject as a solid:TypeIndex + solid:ListedDocument. */
  stampPublicIndex(documentIri: string): this {
    const doc = new TermWrapper(documentIri, this, this.factory);
    for (const klass of [SOLID_TYPE_INDEX, SOLID_LISTED_DOCUMENT]) {
      const already = SetFrom.subjectPredicate(
        doc,
        RDF_TYPE,
        NamedNodeAs.string,
        NamedNodeFrom.string,
      );
      if (!already.has(klass)) {
        this.add(
          this.factory.quad(
            this.factory.namedNode(documentIri),
            this.factory.namedNode(RDF_TYPE),
            this.factory.namedNode(klass),
          ),
        );
      }
    }
    return this;
  }
}
