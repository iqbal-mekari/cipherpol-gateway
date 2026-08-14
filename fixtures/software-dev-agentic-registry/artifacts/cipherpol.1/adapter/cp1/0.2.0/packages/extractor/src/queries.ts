/**
 * Tree-sitter tagging queries per language. Definitions are captured as
 * `@def.<kind>` with a `@name` child; references as `@ref.<kind>` with a
 * `@name`. extract.ts maps captures → SymbolNode / EdgeRel and computes the
 * FQN from the node's enclosing-definition ancestry.
 *
 * These are intentionally focused (pilot: TS + Python). They follow the same
 * shape as tree-sitter's standard `tags.scm`, so they can be extended per
 * language without touching extract.ts.
 */

export const TYPESCRIPT_QUERY = `
; ---- definitions ----
(function_declaration name: (identifier) @name) @def.function
(generator_function_declaration name: (identifier) @name) @def.function

(class_declaration name: (type_identifier) @name) @def.class
(abstract_class_declaration name: (type_identifier) @name) @def.class
(interface_declaration name: (type_identifier) @name) @def.interface
(enum_declaration name: (identifier) @name) @def.enum
(type_alias_declaration name: (type_identifier) @name) @def.type

(method_definition name: (property_identifier) @name) @def.method
(public_field_definition name: (property_identifier) @name (arrow_function)) @def.method

; const/let arrow functions: const foo = (...) => {...}
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @def.function

; plain exported/const values
(lexical_declaration
  (variable_declarator name: (identifier) @name)) @def.const

; ---- references ----
(call_expression
  function: [(identifier) @name (member_expression property: (property_identifier) @name)]) @ref.calls

(class_heritage (extends_clause (identifier) @name)) @ref.extends
(class_heritage (extends_clause (member_expression property: (property_identifier) @name))) @ref.extends
(class_heritage (implements_clause (type_identifier) @name)) @ref.implements

(import_statement (import_clause (named_imports (import_specifier name: (identifier) @name)))) @ref.imports
(import_statement (import_clause (identifier) @name)) @ref.imports
`;

// JavaScript grammar uses (identifier) not (type_identifier) for class names —
// the two grammars are related but NOT identical.
export const JAVASCRIPT_QUERY = `
; ---- definitions ----
(function_declaration name: (identifier) @name) @def.function
(generator_function_declaration name: (identifier) @name) @def.function

(class_declaration name: (identifier) @name) @def.class

(method_definition name: (property_identifier) @name) @def.method

; const/let arrow functions: const foo = (...) => {...}
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @def.function

; plain exported/const values
(lexical_declaration
  (variable_declarator name: (identifier) @name)) @def.const

; ---- references ----
(call_expression
  function: [(identifier) @name (member_expression property: (property_identifier) @name)]) @ref.calls

(class_declaration (class_heritage (identifier) @name)) @ref.extends
(class_declaration (class_heritage (member_expression property: (property_identifier) @name))) @ref.extends

(import_statement (import_clause (named_imports (import_specifier name: (identifier) @name)))) @ref.imports
(import_statement (import_clause (identifier) @name)) @ref.imports
`;

export const PYTHON_QUERY = `
; ---- definitions ----
(function_definition name: (identifier) @name) @def.function
(class_definition name: (identifier) @name) @def.class

; ---- references ----
(call
  function: [(identifier) @name (attribute attribute: (identifier) @name)]) @ref.calls

(class_definition
  superclasses: (argument_list [(identifier) @name (attribute attribute: (identifier) @name)])) @ref.extends

(import_from_statement name: (dotted_name (identifier) @name)) @ref.imports
(import_statement name: (dotted_name (identifier) @name)) @ref.imports
`;

// tree-sitter-dart node types (verified against the grammar):
//   class_definition / enum_declaration / mixin_definition / type_alias
//   function_signature name: / getter_signature name: / setter_signature
//   constructor_signature name: / factory_constructor_signature (id id) / operator_signature
// methods appear wrapped in (method_signature (function_signature ...)) inside class_body;
// the extractor computes the FQN by walking up to the enclosing class_definition.
export const DART_QUERY = `
; ---- definitions (verified node types for tree-sitter-dart) ----
(class_definition name: (identifier) @name) @def.class
(enum_declaration name: (identifier) @name) @def.enum

; methods / functions / getters / setters (these have a name field)
(function_signature name: (identifier) @name) @def.function
(getter_signature name: (identifier) @name) @def.function
(setter_signature name: (identifier) @name) @def.function

; constructors and factory constructors (factory Name.factoryName -> 2nd id is the name)
(constructor_signature name: (identifier) @name) @def.method
(factory_constructor_signature (identifier) (identifier) @name) @def.method

; mixins (no "name" field in the grammar — first bare identifier child is the name)
; and named extensions (anonymous "extension on X" has no name node, so won't match)
(mixin_declaration (identifier) @name) @def.class
(extension_declaration name: (identifier) @name) @def.class
`;

// tree-sitter-kotlin node types (verified against the grammar):
//   class_declaration — classes, interfaces, data classes, enums (no named "name" field; use plain child)
//   object_declaration — singleton objects / companion objects
//   function_declaration — top-level and member functions
//   property_declaration — val/var properties
//   simple_identifier — function / property name child
//   type_identifier — class / object name child
//   delegation_specifier — super-type in `: Foo()` or `: Bar`
export const KOTLIN_QUERY = `
; ---- definitions ----
(class_declaration (type_identifier) @name) @def.class
(object_declaration (type_identifier) @name) @def.class
(function_declaration (simple_identifier) @name) @def.function
(property_declaration (variable_declaration (simple_identifier) @name)) @def.const

; ---- references ----
(delegation_specifier (user_type (type_identifier) @name)) @ref.extends
(call_expression (simple_identifier) @name) @ref.calls
(call_expression (navigation_expression (navigation_suffix (simple_identifier) @name))) @ref.calls
`;

// tree-sitter-java node types (verified against the grammar):
//   class_declaration name: (identifier) / interface_declaration / enum_declaration
//   method_declaration name: (identifier) / field_declaration declarator:
//   superclass (type_identifier) — "extends" parent
//   super_interfaces (type_list (type_identifier)) — "implements" list
//   method_invocation name: (identifier) — call sites
export const JAVA_QUERY = `
; ---- definitions ----
(class_declaration name: (identifier) @name) @def.class
(interface_declaration name: (identifier) @name) @def.interface
(enum_declaration name: (identifier) @name) @def.enum
(method_declaration name: (identifier) @name) @def.method
(field_declaration declarator: (variable_declarator name: (identifier) @name)) @def.const

; ---- references ----
(superclass (type_identifier) @name) @ref.extends
(super_interfaces (type_list (type_identifier) @name)) @ref.implements
(method_invocation name: (identifier) @name) @ref.calls
`;

// tree-sitter-swift node types (verified against the grammar):
//   class/struct/actor/enum/protocol/extension/typealias_declaration name: (type_identifier)
//   function_declaration name: (simple_identifier);  initializer_declaration (init)
//   property_declaration name: (pattern bound_identifier: (simple_identifier))
//   inheritance_specifier inherits_from: (user_type (type_identifier))
//   import_declaration (identifier (simple_identifier))
export const SWIFT_QUERY = `
; ---- definitions ----
; NOTE: this grammar collapses class/struct/enum all into class_declaration.
(class_declaration name: (type_identifier) @name) @def.class
(protocol_declaration name: (type_identifier) @name) @def.interface
(typealias_declaration name: (type_identifier) @name) @def.type

(function_declaration name: (simple_identifier) @name) @def.function
(property_declaration name: (pattern bound_identifier: (simple_identifier) @name)) @def.const

; ---- references ----
; inheritance / conformance (enclosing def owns the edge)
(inheritance_specifier inherits_from: (user_type (type_identifier) @name)) @ref.extends
; calls: foo.bar()
(call_expression (navigation_expression suffix: (navigation_suffix suffix: (simple_identifier) @name))) @ref.calls
(import_declaration (identifier (simple_identifier) @name)) @ref.imports
`;
