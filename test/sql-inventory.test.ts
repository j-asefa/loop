import { expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseSync } from "rolldown/utils";

const root = resolve(import.meta.dirname, "..");
const files = (
  directory: string,
  accepts: (path: string) => boolean = (path) => path.endsWith(".ts"),
): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? files(path, accepts)
      : accepts(path)
        ? [path]
        : [];
  });

// These infrastructure layers own bootstrap or projection SQL, not domain queries.
const exemptions = new Map([
  [
    "execution-ownership.ts",
    "Owns the separate process-ownership lock database.",
  ],
  ["migrations.ts", "Runs immutable, point-in-time schema migrations."],
  [
    "projected-database.ts",
    "Wraps statements to preserve synchronous projection transactions.",
  ],
  ["changes.ts", "Owns the durable change-log transport."],
  [
    "change-deadlines.ts",
    "Maintains durable deadline obligations and publication.",
  ],
  ["event-subjects.ts", "Resolves change subjects inside the write boundary."],
  [
    "feed-projector.ts",
    "Maintains feed projections inside the triggering transaction.",
  ],
  [
    "feed-card-source.ts",
    "Selects the projector's source rows inside that transaction.",
  ],
]);

// Named files still being migrated. Only remove entries as their final direct
// call moves into sql/. Existing files can evolve without call-count churn;
// new files must use query modules and fully migrated files cannot regress.
const allowance: string[] = [];

// Existing smoke and diagnostic callers of SQLite. Remove an entry once its
// last direct call moves to an existing writer or query module.
const scriptAllowance = [
  "acp-deterministic-browser.mjs",
  "approval-layout-browser.mjs",
  "cards-browser-smoke.mjs",
  "cards-content-browser.mjs",
  "companion-browser-smoke.mjs",
  "conversation-history-smoke.mjs",
  "design-scenario.mjs",
  "display-browser-smoke.mjs",
  "feed-transfer-smoke.mjs",
  "feed-websocket-smoke.mjs",
  "fleet-acceptance.mjs",
  "helpers/agent-mail-smoke.mjs",
  "helpers/agent-thread-feed-smoke.mjs",
  "helpers/artifact-read-abort-smoke.mjs",
  "helpers/beginner-chat-smoke.mjs",
  "helpers/card-reminders-smoke.mjs",
  "helpers/checkout-fixture.mjs",
  "helpers/companion-contracts-browser.mjs",
  "helpers/composer-typing-smoke.mjs",
  "helpers/continuation-smoke.mjs",
  "helpers/continuity-smoke.mjs",
  "helpers/conversation-live-smoke.mjs",
  "helpers/create-agent-layout-smoke.mjs",
  "helpers/create-agent-models-smoke.mjs",
  "helpers/design-fixture.mjs",
  "helpers/done-card-actions-smoke.mjs",
  "helpers/done-card-dismissal-smoke.mjs",
  "helpers/done-feed-filters-smoke.mjs",
  "helpers/execution-environments-smoke.mjs",
  "helpers/feed-flows-smoke.mjs",
  "helpers/feed-loading-smoke.mjs",
  "helpers/feed-reading-smoke.mjs",
  "helpers/feed-threads-smoke.mjs",
  "helpers/fleet-browser-host.mjs",
  "helpers/html-preview-smoke.mjs",
  "helpers/markdown-definitions-smoke.mjs",
  "helpers/model-labels-smoke.mjs",
  "helpers/native-auth-browser.mjs",
  "helpers/native-settings-browser.mjs",
  "helpers/needs-stack-smoke.mjs",
  "helpers/personal-decisions-smoke.mjs",
  "helpers/profile-navigation-smoke.mjs",
  "helpers/profile-work-smoke.mjs",
  "helpers/quoted-reply-fixture.mjs",
  "helpers/reply-keyboard-smoke.mjs",
  "helpers/result-files-smoke.mjs",
  "helpers/search-categories-smoke.mjs",
  "helpers/social-smoke.mjs",
  "helpers/steering-replies-smoke.mjs",
  "helpers/swipe-back-smoke.mjs",
  "helpers/team-directory-smoke.mjs",
  "helpers/team-feed-visibility-smoke.mjs",
  "helpers/team-presets-smoke.mjs",
  "helpers/thread-layout-smoke.mjs",
  "helpers/visual-layout-smoke.mjs",
  "helpers/webhook-settings-smoke.mjs",
  "helpers/withdraw-draft-smoke.mjs",
  "helpers/workspace-controls-smoke.mjs",
  "math-browser-smoke.mjs",
  "memory-recall-eval.ts",
  "native-decision-recovery-browser.mjs",
  "personal-files-events-smoke.mjs",
  "pull-requests-smoke.mjs",
  "readme-screenshots.mjs",
  "workspace-lifecycle-smoke.mjs",
];

function sqlCallLines(file: string, text: string, script = false) {
  const { program, errors } = parseSync(file, text);
  if (errors.length) throw new Error(`${file}: ${errors[0].message}`);
  type Binding = "connection" | "inferred" | "constructor" | "object" | "other";
  const bindingRank: Record<Binding, number> = {
    other: 0,
    inferred: 1,
    object: 2,
    constructor: 3,
    connection: 4,
  };
  type Boundary = "function" | "receiver";
  type SpreadSource = { object: object; index: number; excluded: Set<string> };
  type ObjectAlias = { scope: Scope; name: string; spread?: SpreadSource };
  type Scope = {
    parent?: Scope;
    boundary?: Boundary;
    bindings: Map<string, Binding>;
    classes?: Map<string, Scope>;
    instances?: Map<string, Scope>;
    functions?: Map<string, object>;
    boundCalls?: Map<string, { fn: object; items: any[] }>;
    sqliteMethods?: Map<string, string>;
    strings?: Map<string, string>;
    arrays?: Map<string, any>;
    sqliteTypes?: Set<string>;
    imports?: Set<string>;
    fixtureFactories?: Set<string>;
    objectAliases?: Map<string, ObjectAlias[]>;
  };
  const nodes: any[] = [];
  const scopes = new Map<object, Scope>();
  const parents = new Map<object, any>();
  const declarationScopes = new Map<object, Scope>();
  const varDeclarations = new Set<object>();
  const functionKinds = new Set([
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
  ]);
  const classKinds = new Set(["ClassDeclaration", "ClassExpression"]);
  const objectMethod = (node: any) =>
    node?.type === "Property" && node.value?.type === "FunctionExpression";
  const scopeKinds = new Set([
    "BlockStatement",
    "CatchClause",
    "ForStatement",
    "ForInStatement",
    "ForOfStatement",
    "SwitchStatement",
  ]);
  const fileScope: Scope = { bindings: new Map() };
  const functionNodes = new Map<Scope, any>();
  const visit = (node: any, parent: Scope, syntaxParent?: any): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, parent, syntaxParent));
      return;
    }
    const boundary = functionKinds.has(node.type)
      ? "function"
      : classKinds.has(node.type) ||
          (node.type === "ObjectExpression" &&
            node.properties.some(objectMethod))
        ? "receiver"
        : undefined;
    const scope: Scope =
      boundary || scopeKinds.has(node.type)
        ? { parent, boundary, bindings: new Map() }
        : parent;
    if (node.type === "VariableDeclaration" && node.kind === "var")
      for (const declaration of node.declarations)
        varDeclarations.add(declaration);
    if (node.type) {
      if (boundary === "function") functionNodes.set(scope, node);
      nodes.push(node);
      scopes.set(node, scope);
      parents.set(node, syntaxParent);
    }
    for (const value of Object.values(node))
      visit(value, scope, node.type ? node : syntaxParent);
  };
  visit(program, fileScope);
  const scopeOf = (node: any) => scopes.get(node) ?? fileScope;
  const boundaryScope = (node: any, boundary: Boundary) => {
    for (
      let scope: Scope | undefined = scopeOf(node);
      scope;
      scope = scope.parent
    )
      if (scope.boundary === boundary) return scope;
    return undefined;
  };
  const declarationScope = (node: any) =>
    varDeclarations.has(node)
      ? (boundaryScope(node, "function") ?? fileScope)
      : scopeOf(node);
  const declaringScope = (name: string, node: any): Scope | undefined => {
    for (
      let scope: Scope | undefined = scopeOf(node);
      scope;
      scope = scope.parent
    )
      if (scope.bindings.has(name)) return scope;
    return undefined;
  };
  const bindingOf = (name: string, node: any) =>
    declaringScope(name, node)?.bindings.get(name);
  const straightLineWrites = new Map<Scope, Map<string, any[]>>();
  const assignmentsByName = new Map<string, { node: any; key?: string }[]>();
  const receiverClass = new Map<Scope, any>();
  const boundReceivers = new Map<object, object[]>();
  const explicitReceiverScopes = new Map<object, Scope>();
  const receiverContext = (
    node: any,
    seen = new Set<object>(),
  ): { scope: Scope; static: boolean } | undefined => {
    for (let cursor = node; cursor; cursor = parents.get(cursor)) {
      if (classKinds.has(cursor.type))
        return { scope: scopeOf(cursor), static: false };
      if (
        cursor.type === "PropertyDefinition" ||
        cursor.type === "StaticBlock"
      ) {
        const scope = boundaryScope(cursor, "receiver");
        if (scope)
          return {
            scope,
            static: cursor.static || cursor.type === "StaticBlock",
          };
      }
      if (
        !functionKinds.has(cursor.type) ||
        cursor.type === "ArrowFunctionExpression"
      )
        continue;
      const parent = parents.get(cursor);
      if (parent?.type === "MethodDefinition" || objectMethod(parent)) {
        const scope = boundaryScope(parent, "receiver");
        return scope && { scope, static: Boolean(parent.static) };
      }
      if (seen.has(cursor)) return undefined;
      seen.add(cursor);
      for (const receiver of boundReceivers.get(cursor) ?? []) {
        const context = receiverContext(receiver, seen);
        if (context) return context;
      }
      const explicit = explicitReceiverScopes.get(cursor);
      if (explicit || !script)
        return { scope: explicit ?? scopeOf(cursor), static: false };
      return undefined;
    }
    return undefined;
  };
  const thisScope = (node: any) => receiverContext(node)?.scope;
  const receiverPath = (node: any, path: string) =>
    (path === "this" || path.startsWith("this.")) &&
    receiverContext(node)?.static
      ? `static${path.slice(4)}`
      : path;
  const literalKey = (node: any): any => {
    if (node?.type === "TemplateLiteral" && !node.expressions.length)
      return node.quasis[0]?.value.cooked;
    if (node?.type === "BinaryExpression" && node.operator === "+") {
      const left = literalKey(node.left);
      const right = literalKey(node.right);
      return typeof left === "string" && typeof right === "string"
        ? left + right
        : undefined;
    }
    if (node?.type === "MemberExpression") {
      const name = receiver(node);
      return name
        ? declaringScope(name.split(".")[0], node)?.strings?.get(name)
        : undefined;
    }
    if (node?.type !== "Identifier") return node?.value;
    const owner = declaringScope(node.name, node);
    const write = latestWrite(node, node.name, owner);
    if (write?.type === "VariableDeclarator")
      return literalKey(unwrap(write.init));
    if (write?.operator === "=" && write.left.type === "Identifier")
      return literalKey(unwrap(write.right));
    if (write?.type === "AssignmentExpression") return undefined;
    return owner?.strings?.get(node.name);
  };
  const property = (node: any) =>
    node?.computed ? literalKey(node.property) : node?.property?.name;
  const receiver = (node: any): string | undefined => {
    if (node?.type === "Identifier") return node.name;
    if (node?.type === "ThisExpression") return "this";
    if (node?.type === "MemberExpression") {
      const base = receiver(node.object),
        key = property(node);
      return base && (typeof key === "string" || typeof key === "number")
        ? `${base}.${key}`
        : undefined;
    }
    return undefined;
  };
  const unwrap = (node: any) => {
    while (
      node?.type === "AwaitExpression" ||
      node?.type === "ParenthesizedExpression" ||
      node?.type === "ChainExpression" ||
      node?.type === "TSAsExpression" ||
      node?.type === "TSTypeAssertion" ||
      node?.type === "TSNonNullExpression" ||
      node?.type === "TSSatisfiesExpression"
    )
      node = node.type === "AwaitExpression" ? node.argument : node.expression;
    return node;
  };
  const importsSqlite = (node: any) => {
    const expression = unwrap(node);
    return (
      expression?.type === "ImportExpression" &&
      expression.source.value === "better-sqlite3"
    );
  };
  const requiresSqlite = (node: any) =>
    node?.type === "CallExpression" &&
    node.callee.name === "require" &&
    node.arguments[0]?.value === "better-sqlite3";
  const bindings = (
    pattern: any,
  ): { key: string; name: string; fallback?: any }[] => {
    if (!pattern) return [];
    if (
      pattern.type === "AssignmentPattern" &&
      pattern.left.type === "Identifier"
    )
      return [{ name: pattern.left.name, key: "", fallback: pattern.right }];
    if (pattern.type === "AssignmentPattern") pattern = pattern.left;
    if (pattern.type === "RestElement") return bindings(pattern.argument);
    if (pattern.type === "Identifier") return [{ name: pattern.name, key: "" }];
    const within = (element: any, key: string) =>
      bindings(element).map((binding) => ({
        ...binding,
        key: binding.key ? `${key}.${binding.key}` : key,
      }));
    if (pattern.type === "ArrayPattern") {
      return pattern.elements.flatMap((element: any, index: number) =>
        script && element?.type === "RestElement"
          ? []
          : within(element, String(index)),
      );
    }
    if (pattern.type !== "ObjectPattern") return [];
    return pattern.properties.flatMap((member: any) => {
      if (member.type !== "Property") return [];
      const key = member.computed
        ? literalKey(member.key)
        : (member.key.name ?? member.key.value);
      return typeof key === "string" || typeof key === "number"
        ? within(member.value, String(key))
        : [];
    });
  };
  const dbModule = /(?:^|\/)db(?:\.[cm]?[jt]s)?$/;
  const fixtureModule = /(?:^|\/)design-fixture(?:\.mjs)?$/;
  const modulePath = (source: any): string | undefined =>
    source?.type === "ImportExpression"
      ? source.source.value
      : source?.type === "CallExpression" &&
          ["tsImport", "require"].includes(source.callee.name)
        ? source.arguments[0]?.value
        : undefined;
  const loadsDatabaseModule = (source: any) =>
    dbModule.test(modulePath(source) ?? "");
  const loadsFixtureModule = (source: any) =>
    fixtureModule.test(modulePath(source) ?? "");
  const propertyOrigin = (
    source: any,
    key: string,
  ): ObjectAlias | undefined => {
    const path = receiver(source);
    const root = path?.split(".")[0];
    const owner =
      root === "this"
        ? thisScope(source)
        : root && declaringScope(root, source);
    return owner
      ? { scope: owner, name: receiverPath(source, `${path}.${key}`) }
      : undefined;
  };
  const knownProperty = (source: any, key: string) => {
    const origin = propertyOrigin(source, key);
    return origin ? receiverBinding(origin.scope, origin.name) : undefined;
  };
  const destructuredDatabase = (source: any): Binding => {
    const binding = knownProperty(source, "db");
    if (binding === "connection" || binding === "object") return binding;
    if (loadsDatabaseModule(source) || (script && fixtureCall(source)))
      return "connection";
    return "inferred";
  };
  const propertyInitializers: {
    scope: Scope;
    name: string;
    value: any;
    spread?: SpreadSource;
  }[] = [];
  const typedParameters: { scope: Scope; parameter: any; annotation: any }[] =
    [];
  const objectKey = (member: any) => {
    const key = member.computed
      ? literalKey(member.key)
      : (member.key.name ?? member.key.value);
    return typeof key === "number" ? String(key) : key;
  };
  const isAggregate = (node: any) =>
    node?.type === "ObjectExpression" || node?.type === "ArrayExpression";
  const staticArray = (node: any): any[] | undefined => {
    const source = unwrap(node);
    const array =
      source?.type === "Identifier"
        ? declaringScope(source.name, source)?.arrays?.get(source.name)
        : source;
    return array?.type === "ArrayExpression" ? array.elements : undefined;
  };
  const staticArguments = (
    items: any[],
    seen = new Set<object>(),
  ): { values: any[]; complete: boolean } => {
    if (seen.has(items)) return { values: [], complete: false };
    const visited = new Set(seen).add(items);
    const values: any[] = [];
    for (const item of items) {
      if (item?.type !== "SpreadElement") {
        values.push(item);
        continue;
      }
      const array = staticArray(item.argument);
      if (!array) return { values, complete: false };
      const expanded = staticArguments(array, visited);
      values.push(...expanded.values);
      if (!expanded.complete) return { values, complete: false };
    }
    return { values, complete: true };
  };
  const recordObject = (
    scope: Scope,
    name: string,
    value: any,
    excluded?: Set<string>,
  ): void => {
    if (!["connection", "constructor"].includes(scope.bindings.get(name) ?? ""))
      scope.bindings.set(name, "object");
    const recordField = (key: string, child: any, owner = scope) => {
      const path = `${name}.${key}`;
      if (!owner.bindings.has(path)) owner.bindings.set(path, "other");
      const string = literalKey(child);
      if (typeof string === "string")
        (owner.strings ??= new Map()).set(path, string);
      if (functionKinds.has(child?.type))
        (owner.functions ??= new Map()).set(path, child);
      if (isAggregate(child)) recordObject(owner, path, child);
      else
        propertyInitializers.push({ scope: owner, name: path, value: child });
    };
    if (value.type === "ArrayExpression") {
      for (const [index, element] of staticArguments(
        value.elements,
      ).values.entries()) {
        recordField(String(index), unwrap(element));
      }
      return;
    }
    const receiverScope = scopes.get(value);
    if (receiverScope?.boundary === "receiver" && receiverScope !== scope) {
      const aliases = (receiverScope.objectAliases ??= new Map<
        string,
        ObjectAlias[]
      >());
      const sources = aliases.get("this") ?? [];
      if (
        !sources.some(
          (source) => source.scope === scope && source.name === name,
        )
      ) {
        sources.push({ scope, name });
        aliases.set("this", sources);
      }
    }
    const later = new Set(excluded);
    let earlierFields: Scope | undefined;
    const rememberSource = (
      source: Scope,
      path: string,
      spread: SpreadSource,
    ) => {
      const aliases = (scope.objectAliases ??= new Map());
      const sources = aliases.get(name) ?? [];
      sources.push({ scope: source, name: path, spread });
      aliases.set(name, sources);
    };
    for (let index = value.properties.length - 1; index >= 0; index--) {
      const member = value.properties[index];
      if (member.type === "SpreadElement") {
        const source = unwrap(member.argument);
        const spread = { object: value, index, excluded: new Set(later) };
        // A later spread can replace an earlier explicit field.
        if (!earlierFields) {
          earlierFields = { bindings: new Map() };
          rememberSource(earlierFields, name, {
            object: value,
            index: -1,
            excluded: new Set(),
          });
        }
        if (source?.type === "ObjectExpression") {
          const literal: Scope = { bindings: new Map() };
          recordObject(literal, "object", source);
          rememberSource(literal, "object", spread);
        } else
          propertyInitializers.push({
            scope,
            name,
            value: source,
            spread,
          });
        continue;
      }
      if (member.type !== "Property") continue;
      const key = objectKey(member);
      const child = unwrap(member.value);
      if (typeof key !== "string" || later.has(key)) continue;
      later.add(key);
      recordField(key, child, earlierFields);
    }
  };
  const restElement = (pattern: any) => {
    const members =
      pattern?.type === "ObjectPattern"
        ? pattern.properties
        : script && pattern?.type === "ArrayPattern"
          ? pattern.elements
          : [];
    return members.find(
      (member: any) =>
        member?.type === "RestElement" && member.argument.type === "Identifier",
    );
  };
  for (const node of nodes) {
    const scope = declarationScope(node);
    if (node.type === "FunctionDeclaration" && scope.parent && node.id)
      (scope.parent.functions ??= new Map()).set(node.id.name, node);
    if (classKinds.has(node.type)) {
      receiverClass.set(scope, node);
      if (node.type === "ClassDeclaration" && scope.parent && node.id)
        (scope.parent.classes ??= new Map()).set(node.id.name, scope);
    }
    if (node.type === "MethodDefinition" && node.kind !== "constructor") {
      const key = objectKey(node);
      const owner = boundaryScope(node, "receiver");
      if (owner && typeof key === "string")
        (owner.functions ??= new Map()).set(
          `${node.static ? "static" : "this"}.${key}`,
          node.value,
        );
    }
    if (
      node.id &&
      (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration")
    )
      scope.parent?.bindings.set(node.id.name, "other");
    if (
      node.id &&
      (node.type === "FunctionExpression" || node.type === "ClassExpression")
    )
      scope.bindings.set(node.id.name, "other");
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) {
        let binding: Binding = "other";
        if (
          node.source.value === "better-sqlite3" &&
          (specifier.type === "ImportDefaultSpecifier" ||
            (specifier.imported?.name ?? specifier.imported?.value) ===
              "default")
        )
          binding = "constructor";
        if (
          node.source.value === "better-sqlite3" &&
          specifier.type === "ImportNamespaceSpecifier"
        ) {
          binding = "object";
          scope.bindings.set(`${specifier.local.name}.default`, "constructor");
        }
        if (
          specifier.imported?.name === "db" &&
          dbModule.test(node.source.value)
        )
          binding = "connection";
        if (
          node.source.value === "better-sqlite3" &&
          specifier.imported?.name === "Database"
        )
          (scope.sqliteTypes ??= new Set()).add(specifier.local.name);
        if (fixtureModule.test(node.source.value)) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            binding = "object";
            (scope.fixtureFactories ??= new Set()).add(
              `${specifier.local.name}.designFixture`,
            );
          } else if (specifier.imported?.name === "designFixture") {
            (scope.fixtureFactories ??= new Set()).add(specifier.local.name);
          }
        }
        if (
          specifier.type === "ImportNamespaceSpecifier" &&
          dbModule.test(node.source.value)
        ) {
          binding = "object";
          scope.bindings.set(`${specifier.local.name}.db`, "connection");
        }
        scope.bindings.set(specifier.local.name, binding);
        (scope.imports ??= new Set()).add(specifier.local.name);
      }
    }
    if (node.type === "VariableDeclarator") {
      declarationScopes.set(node.id, scope);
      const rest = restElement(node.id);
      if (rest) scope.bindings.set(rest.argument.name, "object");
      const value = unwrap(node.init);
      const sqliteConstructor =
        (value?.type === "MemberExpression" &&
          property(value) === "default" &&
          importsSqlite(value.object)) ||
        requiresSqlite(value);
      for (const { key, name } of bindings(node.id)) {
        let binding: Binding = "other";
        if (
          key === "" &&
          parents.get(node)?.kind === "const" &&
          value?.type === "ArrayExpression"
        )
          (scope.arrays ??= new Map()).set(name, value);
        if (key === "" && parents.get(node)?.kind === "const") {
          const string = literalKey(value);
          if (typeof string === "string")
            (scope.strings ??= new Map()).set(name, string);
        }
        if (key === "" && functionKinds.has(value?.type))
          (scope.functions ??= new Map()).set(name, value);
        if (key === "" && classKinds.has(value?.type))
          (scope.classes ??= new Map()).set(name, scopeOf(value));
        if (key === "" && loadsDatabaseModule(value)) {
          binding = "object";
          scope.bindings.set(`${name}.db`, "connection");
        }
        if (loadsFixtureModule(value)) {
          if (key === "designFixture")
            (scope.fixtureFactories ??= new Set()).add(name);
          if (key === "") {
            binding = "object";
            (scope.fixtureFactories ??= new Set()).add(`${name}.designFixture`);
          }
        }
        if (key === "" && importsSqlite(value)) {
          binding = "object";
          scope.bindings.set(`${name}.default`, "constructor");
        }
        if (key === "db") binding = "inferred";
        if (key === "" && isAggregate(value)) {
          recordObject(scope, name, value);
          continue;
        }
        if (
          (key === "default" && importsSqlite(node.init)) ||
          (key === "" && sqliteConstructor)
        )
          binding = "constructor";
        scope.bindings.set(name, binding);
      }
    }
    const parameters =
      node.params ??
      (node.type === "CatchClause" && node.param ? [node.param] : []);
    for (const parameter of parameters) {
      const pattern =
        parameter.type === "AssignmentPattern" ? parameter.left : parameter;
      const annotation = pattern.typeAnnotation?.typeAnnotation;
      if (annotation) typedParameters.push({ scope, parameter, annotation });
      const rest = restElement(pattern);
      if (rest) scope.bindings.set(rest.argument.name, "object");
      for (const { key, name } of bindings(parameter)) {
        const binding =
          key === "db" || (key === "" && name === "database")
            ? "inferred"
            : "other";
        scope.bindings.set(name, binding);
      }
    }
  }
  for (const node of nodes) {
    const method = node.callee;
    if (
      node.type !== "CallExpression" ||
      method?.type !== "MemberExpression" ||
      !["call", "apply", "bind"].includes(property(method))
    )
      continue;
    const source = unwrap(method.object);
    const fn =
      source.type === "FunctionExpression"
        ? source
        : declaringScope(source.name, source)?.functions?.get(source.name);
    if (!fn) continue;
    const argument = unwrap(node.arguments[0]);
    if (argument?.type !== "ThisExpression") {
      if (argument?.type === "Identifier") {
        const origin = declaringScope(argument.name, argument);
        if (origin) {
          const target: Scope = explicitReceiverScopes.get(fn) ?? {
            bindings: new Map(),
          };
          const paths = (target.objectAliases ??= new Map());
          const aliases = paths.get("this") ?? [];
          aliases.push({ scope: origin, name: argument.name });
          paths.set("this", aliases);
          explicitReceiverScopes.set(fn, target);
        }
      }
      continue;
    }
    const receivers = boundReceivers.get(fn) ?? [];
    receivers.push(argument);
    boundReceivers.set(fn, receivers);
  }
  if (script) {
    for (const node of nodes) {
      const declaration = node.type === "VariableDeclarator";
      const target = declaration ? node.id : node.left;
      if (!declaration && node.type !== "AssignmentExpression") continue;
      const name = receiver(target);
      const targets = name
        ? [{ name, key: "" }]
        : !declaration && node.operator === "="
          ? bindings(target)
          : [];
      if (!declaration && node.operator === "=") {
        for (const target of targets) {
          if (target.name.startsWith("this.")) continue;
          const writes = assignmentsByName.get(target.name) ?? [];
          writes.push({ node, key: target.key || undefined });
          assignmentsByName.set(target.name, writes);
        }
      }
      let statement = parents.get(node);
      while (statement?.type === "ParenthesizedExpression")
        statement = parents.get(statement);
      const block = parents.get(statement);
      if (
        statement?.type !==
          (declaration ? "VariableDeclaration" : "ExpressionStatement") ||
        (block?.type !== "BlockStatement" && block?.type !== "Program")
      )
        continue;
      // A standalone block runs in sequence with its surrounding statements.
      for (
        let container = block;
        container;
        container = parents.get(container)
      ) {
        if (container.type !== "BlockStatement" && container.type !== "Program")
          break;
        const scope = scopeOf(container);
        const byName =
          straightLineWrites.get(scope) ?? new Map<string, any[]>();
        for (const { name } of targets) {
          if (name.startsWith("this.")) continue;
          const writes = byName.get(name) ?? [];
          writes.push(node);
          byName.set(name, writes);
        }
        straightLineWrites.set(scope, byName);
      }
    }
  }
  const isConstructor = (name: string, node: any) =>
    bindingOf(name, node) === "constructor";
  function receiverProperty<T>(
    scope: Scope,
    name: string,
    select: (scope: Scope, name: string) => T | undefined,
    combine: (first: T | undefined, second: T | undefined) => T | undefined = (
      first,
      second,
    ) => first ?? second,
    aliases = new Set<object>(),
  ): T | undefined {
    const seen = new Set<Scope>();
    let current: Scope | undefined = scope;
    while (current && !seen.has(current)) {
      seen.add(current);
      let binding = select(current, name);
      for (const [path, sources] of current.objectAliases ?? []) {
        if (!name.startsWith(path + ".")) continue;
        const groups = new Set<object>();
        const ordered = [...sources].sort(
          (a, b) => (b.spread?.index ?? -1) - (a.spread?.index ?? -1),
        );
        for (const alias of ordered) {
          const suffix = name.slice(path.length + 1);
          if (
            aliases.has(alias) ||
            (alias.spread &&
              (groups.has(alias.spread.object) ||
                alias.spread.excluded.has(suffix.split(".")[0])))
          )
            continue;
          const visited = new Set(aliases).add(alias);
          const property = receiverProperty(
            alias.scope,
            alias.name + name.slice(path.length),
            select,
            combine,
            visited,
          );
          binding = combine(binding, property);
          if (
            alias.spread &&
            (property !== undefined ||
              receiverProperty(
                alias.scope,
                `${alias.name}.${suffix.split(".")[0]}`,
                (owner, key) => owner.bindings.get(key),
                undefined,
                visited,
              ) !== undefined)
          )
            groups.add(alias.spread.object);
        }
      }
      if (binding) return binding;
      const parent: { type: string; name?: string } | undefined =
        receiverClass.get(current)?.superClass;
      current =
        parent?.type === "Identifier" && parent.name
          ? declaringScope(parent.name, parent)?.classes?.get(parent.name)
          : undefined;
    }
    return undefined;
  }
  function receiverBinding(scope: Scope, name: string) {
    return receiverProperty(
      scope,
      name,
      (owner, key) => owner.bindings.get(key),
      (first, second) =>
        second && (!first || bindingRank[second] > bindingRank[first])
          ? second
          : first,
    );
  }
  const memberReference = <T>(
    expression: any,
    select: (scope: Scope, name: string) => T | undefined,
  ) => {
    const name = receiver(expression);
    if (!name) return undefined;
    const owner = name.startsWith("this.")
      ? thisScope(expression)
      : declaringScope(name.split(".")[0], expression);
    return owner
      ? receiverProperty(owner, receiverPath(expression, name), select)
      : undefined;
  };
  const returnsDatabase = new Set<object>();
  const returnedObjects = new Map<object, Scope>();
  const returnedObject = (expression: any) =>
    expression?.type === "CallExpression"
      ? returnedObjects.get(invocation(expression).fn)
      : undefined;
  const classReference = (expression: any): Scope | undefined =>
    classKinds.has(expression?.type)
      ? scopeOf(expression)
      : memberReference(expression, (scope, key) => scope.classes?.get(key));
  const instanceReference = (expression: any): Scope | undefined =>
    expression?.type === "NewExpression"
      ? classReference(unwrap(expression.callee))
      : memberReference(expression, (scope, key) => scope.instances?.get(key));
  const functionReference = (expression: any): any => {
    if (functionKinds.has(expression?.type)) return expression;
    if (script && expression?.type === "Identifier") {
      const name = expression.name;
      const write = latestWrite(
        expression,
        name,
        declaringScope(name, expression),
      );
      if (write?.operator === "=")
        return functionReference(writtenSource(write, name).value);
    }
    if (expression?.type === "MemberExpression") {
      const object = unwrap(expression.object);
      const cls = classReference(object);
      if (cls)
        return receiverProperty(
          cls,
          `static.${property(expression)}`,
          (scope, key) => scope.functions?.get(key),
        );
      const instance = instanceReference(object);
      if (instance)
        return receiverProperty(
          instance,
          `this.${property(expression)}`,
          (scope, key) => scope.functions?.get(key),
        );
    }
    return memberReference(expression, (scope, key) =>
      scope.functions?.get(key),
    );
  };
  const fixtureFactory = (expression: any) =>
    memberReference(expression, (scope, key) =>
      scope.fixtureFactories?.has(key),
    );
  const fixtureCall = (expression: any) =>
    expression?.type === "CallExpression" &&
    fixtureFactory(unwrap(expression.callee));
  const constructorReference = (expression: any): any => {
    const seen = new Set<Scope>();
    let scope = classReference(expression);
    while (scope && !seen.has(scope)) {
      seen.add(scope);
      const cls = receiverClass.get(scope);
      const constructor = cls?.body.body.find(
        (member: any) =>
          member.type === "MethodDefinition" && member.kind === "constructor",
      );
      if (constructor) return constructor.value;
      scope = classReference(cls?.superClass);
    }
    return functionReference(expression);
  };
  const boundReference = (
    expression: any,
  ): { fn: object; items: any[] } | undefined => {
    if (
      expression?.type === "CallExpression" &&
      expression.callee.type === "MemberExpression" &&
      property(expression.callee) === "bind"
    ) {
      const target = unwrap(expression.callee.object);
      const prior = boundReference(target);
      const fn = prior?.fn ?? functionReference(target);
      if (fn)
        return {
          fn,
          items: [...(prior?.items ?? []), ...expression.arguments.slice(1)],
        };
    }
    return memberReference(expression, (scope, key) =>
      scope.boundCalls?.get(key),
    );
  };
  const invocation = (node: any): { fn?: any; items?: any[] } => {
    const callee = unwrap(node.callee);
    const bound = boundReference(callee);
    if (bound)
      return { fn: bound.fn, items: [...bound.items, ...node.arguments] };
    if (node.type === "NewExpression")
      return { fn: constructorReference(callee), items: node.arguments };
    const direct = functionReference(callee);
    if (direct) return { fn: direct, items: node.arguments };
    if (callee?.type !== "MemberExpression") return {};
    const method = property(callee);
    if (method !== "call" && method !== "apply") return {};
    const fn = functionReference(unwrap(callee.object));
    if (method === "call") return { fn, items: node.arguments.slice(1) };
    return { fn, items: staticArray(node.arguments[1]) };
  };
  function latestWrite(
    expression: any,
    name: string,
    owner: Scope | undefined,
    captured = false,
  ) {
    let write: any;
    let before = expression.start;
    for (
      let scope: Scope | undefined = scopeOf(expression);
      scope;
      scope = scope.parent
    ) {
      const candidate = straightLineWrites
        .get(scope)
        ?.get(name)
        ?.findLast(
          (assignment) =>
            assignment.end <= before &&
            declaringScope(name.split(".")[0], assignment) === owner,
        );
      if (candidate && (!write || candidate.end > write.end)) write = candidate;
      if (scope === owner) break;
      if (scope.boundary === "function") {
        const fn = functionNodes.get(scope);
        if (!captured || write || !fn || fn.type === "FunctionDeclaration")
          break;
        before = fn.start;
      }
    }
    if (
      write &&
      before < expression.start &&
      assignmentsByName
        .get(name)
        ?.some(
          ({ node }) =>
            node.start >= write.end &&
            declaringScope(name.split(".")[0], node) === owner,
        )
    )
      return undefined;
    return write;
  }
  const latestParentWrite = (
    expression: any,
    name: string,
    owner: Scope | undefined,
    after = -1,
  ) => {
    let prefix = name;
    const parentPaths: string[] = [];
    let replacement: any;
    let suffix: string | undefined;
    while (prefix.includes(".")) {
      prefix = prefix.slice(0, prefix.lastIndexOf("."));
      parentPaths.push(prefix);
      const candidate = latestWrite(expression, prefix, owner);
      if (
        candidate?.operator === "=" &&
        candidate.end > (replacement?.end ?? after)
      ) {
        replacement = candidate;
        suffix = name.slice(prefix.length + 1);
      }
    }
    return { parentPaths, replacement, suffix };
  };
  const localCalls = new Map<Scope | undefined, any[]>();
  if (script) {
    for (const node of nodes) {
      if (node.type !== "CallExpression" || node.callee.type !== "Identifier")
        continue;
      const scope = boundaryScope(node, "function");
      const calls = localCalls.get(scope) ?? [];
      calls.push(node);
      localCalls.set(scope, calls);
    }
  }
  const reachesRead = (
    node: any,
    expression: any,
    name: string,
    owner: Scope | undefined,
    after: number,
  ) => {
    if (declaringScope(name.split(".")[0], node) !== owner) return false;
    const writer = boundaryScope(node, "function");
    const reader = boundaryScope(expression, "function");
    if (writer === reader)
      return node.start >= after && node.end <= expression.start;
    const fn = writer && functionNodes.get(writer);
    return (
      fn &&
      localCalls
        .get(reader)
        ?.some(
          (call) =>
            call.start >= after &&
            call.end <= expression.start &&
            invocation(call).fn === fn,
        )
    );
  };
  const writtenBinding = (
    expression: any,
    name: string,
  ): Binding | undefined => {
    if (!name.startsWith("this.")) {
      const owner = declaringScope(name.split(".")[0], expression);
      const write = latestWrite(expression, name, owner, true);
      const { parentPaths, replacement, suffix } = latestParentWrite(
        expression,
        name,
        owner,
        write?.end,
      );
      if (suffix) {
        const reachesSqlite = [name, ...parentPaths].some((path) =>
          assignmentsByName
            .get(path)
            ?.some(
              ({ node, key }) =>
                !key &&
                reachesRead(node, expression, path, owner, replacement.end) &&
                (path === name
                  ? connectionKind(node.right)
                  : propertySource(node.right, name.slice(path.length + 1))
                      .binding) === "connection",
            ),
        );
        if (reachesSqlite) return "connection";
        const property = propertySource(replacement.right, suffix);
        if (property.binding) return property.binding;
      }
      if (write?.operator === "=" || write?.type === "VariableDeclarator") {
        const source = writtenSource(write, name);
        const value = source.value;
        const kind = source.binding ?? connectionKind(value);
        const opaqueImport =
          kind === "other" &&
          value?.type === "Identifier" &&
          declaringScope(value.name, value)?.imports?.has(value.name);
        if (isAggregate(value) || kind === "object" || opaqueImport) {
          const mayReach = assignmentsByName
            .get(name)
            ?.some(
              ({ node, key }) =>
                reachesRead(node, expression, name, owner, write.end) &&
                (key
                  ? propertySource(node.right, key).binding
                  : connectionKind(node.right)) === "connection",
            );
          if (mayReach) return "connection";
          return opaqueImport ? "other" : "object";
        }
      }
    }
    return undefined;
  };
  const resolvingConnections = new Set<object>();
  const connectionKind = (node: any): Binding | undefined => {
    const expression = unwrap(node);
    if (!expression || resolvingConnections.has(expression)) return undefined;
    resolvingConnections.add(expression);
    try {
      return classifyConnection(expression);
    } finally {
      resolvingConnections.delete(expression);
    }
  };
  const classifyConnection = (expression: any): Binding | undefined => {
    if (isAggregate(expression)) return "object";
    if (
      script &&
      expression?.type === "CallExpression" &&
      expression.callee.type === "MemberExpression" &&
      property(expression.callee) === "at"
    ) {
      const array = staticArray(expression.callee.object);
      const argument = expression.arguments[0];
      const index =
        argument?.type === "UnaryExpression" && argument.operator === "-"
          ? -literalKey(argument.argument)
          : literalKey(argument);
      if (array && Number.isInteger(index)) {
        const { values, complete } = staticArguments(array);
        if (index >= 0 || complete) return connectionKind(values.at(index));
      }
    }
    if (expression?.type === "Literal" && expression.regex) return "object";
    if (
      expression?.type === "LogicalExpression" &&
      expression.operator === "&&"
    )
      return connectionKind(expression.right);
    if (
      expression?.type === "CallExpression" &&
      expression.callee.name === "RegExp" &&
      !declaringScope("RegExp", expression.callee)
    )
      return "object";
    const conditional = expression?.type === "ConditionalExpression";
    const fallback =
      expression?.type === "LogicalExpression" &&
      (expression.operator === "??" || expression.operator === "||");
    if (conditional || fallback) {
      const first = connectionKind(
        conditional ? expression.consequent : expression.left,
      );
      const second = connectionKind(
        conditional ? expression.alternate : expression.right,
      );
      return bindingRank[first ?? "other"] >= bindingRank[second ?? "other"]
        ? (first ?? second)
        : second;
    }
    if (script && fixtureCall(expression)) return "object";
    if (
      expression?.type === "MemberExpression" &&
      property(expression) === "db" &&
      (loadsDatabaseModule(unwrap(expression.object)) ||
        (script && fixtureCall(unwrap(expression.object))))
    )
      return "connection";
    if (
      expression?.type === "CallExpression" &&
      returnsDatabase.has(invocation(expression).fn)
    )
      return "connection";
    if (returnedObject(expression)) return "object";
    if (expression?.type === "MemberExpression") {
      const object = unwrap(expression.object);
      if (isAggregate(object)) {
        const key = property(expression);
        return key === undefined
          ? undefined
          : propertySource(object, String(key)).binding;
      }
      const result = returnedObject(object);
      if (result)
        return receiverBinding(result, `result.${property(expression)}`);
    }
    const callee =
      expression?.type === "NewExpression" && unwrap(expression.callee);
    if (callee?.name === "RegExp" && !declaringScope("RegExp", callee))
      return "object";
    if (
      callee &&
      (requiresSqlite(callee) ||
        memberReference(callee, (scope, key) => scope.bindings.get(key)) ===
          "constructor" ||
        (callee.type === "MemberExpression" &&
          property(callee) === "default" &&
          importsSqlite(callee.object)))
    )
      return "connection";
    if (callee && instanceReference(expression)) return "object";
    const name = receiver(expression);
    if (!name) return undefined;
    const databaseName = name === "db" || name.endsWith(".db");
    if (databaseName && !script) return "connection";
    const written = writtenBinding(expression, name);
    if (written) return written;
    if (expression.type === "MemberExpression") {
      const object = unwrap(expression.object);
      const cls = classReference(object);
      const instance = instanceReference(object);
      const known = cls
        ? receiverBinding(cls, `static.${property(expression)}`)
        : instance && receiverBinding(instance, `this.${property(expression)}`);
      if (known) return known;
    }
    const [root] = name.split(".");
    const owner =
      root === "this"
        ? thisScope(expression)
        : declaringScope(root, expression);
    const binding = owner
      ? receiverBinding(owner, receiverPath(expression, name))
      : root === "this"
        ? undefined
        : bindingOf(name, expression);
    if (databaseName) {
      if (!owner) return "connection";
      if (!binding || binding === "other") return "inferred";
    }
    return binding;
  };
  const conditionalOrigins = new Map<object, Map<string, Scope>>();
  function propertySource(
    source: any,
    key: string,
  ): { value?: any; binding?: Binding; origin?: ObjectAlias } {
    const object = unwrap(source);
    if (script && key === "db" && fixtureCall(object))
      return { binding: "connection" };
    if (object?.type === "ConditionalExpression") {
      const first = propertySource(object.consequent, key);
      const second = propertySource(object.alternate, key);
      if (!first.value && !first.binding) return second;
      if (
        first.binding === "object" &&
        second.binding === "object" &&
        first.origin &&
        second.origin
      ) {
        const byKey =
          conditionalOrigins.get(object) ?? new Map<string, Scope>();
        const scope: Scope = byKey.get(key) ?? { bindings: new Map() };
        scope.objectAliases = new Map([
          ["value", [first.origin, second.origin]],
        ]);
        byKey.set(key, scope);
        conditionalOrigins.set(object, byKey);
        return { binding: "object", origin: { scope, name: "value" } };
      }
      return bindingRank[second.binding ?? "other"] >
        bindingRank[first.binding ?? "other"]
        ? second
        : first;
    }
    const separator = key.indexOf(".");
    const head = separator < 0 ? key : key.slice(0, separator);
    const tail = separator < 0 ? undefined : key.slice(separator + 1);
    const resolve = (node: any) => {
      const value = unwrap(node);
      return tail
        ? propertySource(value, tail)
        : { value, binding: connectionKind(value) };
    };
    if (object?.type === "ArrayExpression" && /^(?:0|[1-9]\d*)$/.test(head)) {
      return resolve(staticArguments(object.elements).values[Number(head)]);
    }
    if (object?.type === "ObjectExpression") {
      for (let index = object.properties.length - 1; index >= 0; index--) {
        const member = object.properties[index];
        if (member.type === "Property" && objectKey(member) === head)
          return resolve(member.value);
        if (member.type === "SpreadElement") {
          const next = propertySource(member.argument, key);
          if (next.value || next.binding) return next;
          if (tail) {
            const parent = propertySource(member.argument, head);
            if (parent.value || parent.binding) return {};
          }
        }
      }
    }
    const path = receiver(object);
    const written = path && writtenBinding(object, `${path}.${key}`);
    if (written) return { binding: written };
    const returned = returnedObject(object);
    const cls = classReference(object);
    const instance = instanceReference(object);
    const origin = returned
      ? { scope: returned, name: `result.${key}` }
      : cls
        ? { scope: cls, name: `static.${key}` }
        : instance
          ? { scope: instance, name: `this.${key}` }
          : propertyOrigin(object, key);
    return {
      origin,
      binding: origin ? receiverBinding(origin.scope, origin.name) : undefined,
    };
  }
  const isMissing = (value: any) =>
    !value ||
    (value.type === "Identifier" &&
      value.name === "undefined" &&
      !bindingOf(value.name, value));
  const destructuredSource = (
    source: any,
    key: string,
    fallback: any,
  ): ReturnType<typeof propertySource> => {
    const member = propertySource(source, key);
    const alias = member.origin;
    const initial =
      alias &&
      member.binding === "other" &&
      propertyInitializers.findLast(
        (entry) => entry.scope === alias.scope && entry.name === alias.name,
      )?.value;
    const missing =
      (member.binding === undefined && isMissing(member.value)) ||
      Boolean(initial && isMissing(initial));
    return fallback && missing
      ? { value: fallback, binding: connectionKind(fallback) }
      : member;
  };
  const writtenSource = (
    write: any,
    name: string,
  ): ReturnType<typeof propertySource> => {
    const value = unwrap(
      write.type === "VariableDeclarator" ? write.init : write.right,
    );
    if (
      write.left?.type === "ObjectPattern" ||
      write.left?.type === "ArrayPattern"
    ) {
      const target = bindings(write.left).find(
        (binding) => binding.name === name,
      );
      if (target) return destructuredSource(value, target.key, target.fallback);
    }
    return { value };
  };
  const methods = new Set(["prepare", "exec"]);
  if (script) methods.add("pragma");
  const destructuredMethod = (source: any, path: string) => {
    const separator = path.lastIndexOf(".");
    const method = path.slice(separator + 1);
    if (!methods.has(method)) return undefined;
    const binding =
      separator < 0
        ? connectionKind(source)
        : propertySource(source, path.slice(0, separator)).binding;
    return binding === "connection" ? method : undefined;
  };
  const sqliteMethod = (expression: any): string | undefined => {
    const name = script && receiver(expression);
    if (name && !name.startsWith("this.")) {
      const owner = declaringScope(name.split(".")[0], expression);
      const write = latestWrite(expression, name, owner);
      const { replacement, suffix } = latestParentWrite(
        expression,
        name,
        owner,
        write?.end,
      );
      if (suffix) {
        const source = propertySource(replacement.right, suffix);
        return (
          sqliteMethod(source.value) ??
          (source.origin &&
            receiverProperty(
              source.origin.scope,
              source.origin.name,
              (scope, key) => scope.sqliteMethods?.get(key),
            ))
        );
      }
      if (write?.operator === "=" || write?.type === "VariableDeclarator") {
        const source = writtenSource(write, name);
        const target = bindings(write.left).find(
          (binding) => binding.name === name,
        );
        return (
          (target?.key
            ? destructuredMethod(write.right, target.key)
            : undefined) ??
          sqliteMethod(source.value) ??
          (source.origin &&
            receiverProperty(
              source.origin.scope,
              source.origin.name,
              (scope, key) => scope.sqliteMethods?.get(key),
            ))
        );
      }
    }
    if (expression?.type === "MemberExpression") {
      const method = property(expression);
      if (
        methods.has(method) &&
        connectionKind(expression.object) === "connection"
      )
        return method;
    }
    if (
      expression?.type === "CallExpression" &&
      expression.callee.type === "MemberExpression" &&
      property(expression.callee) === "bind"
    )
      return sqliteMethod(unwrap(expression.callee.object));
    return memberReference(expression, (scope, key) =>
      scope.sqliteMethods?.get(key),
    );
  };
  // Explicitly typed SQLite parameters also cover dynamic SQL statements.
  const isDatabaseType = (type: any, node: any) => {
    if (type?.type !== "TSQualifiedName") {
      const name = type?.name;
      return (
        isConstructor(name, node) ||
        declaringScope(name, node)?.sqliteTypes?.has(name)
      );
    }
    if (type.right?.name !== "Database") return false;
    const name = type.left?.name;
    const owner = declaringScope(name, node);
    return (
      isConstructor(name, node) ||
      (owner && receiverBinding(owner, `${name}.default`) === "constructor")
    );
  };
  for (const node of nodes) {
    const type = node.typeAnnotation?.typeAnnotation?.typeName;
    if (node.type === "Identifier" && isDatabaseType(type, node))
      (declarationScopes.get(node) ?? scopeOf(node)).bindings.set(
        node.name,
        "connection",
      );
  }
  for (const { scope, parameter, annotation } of typedParameters) {
    if (annotation.type !== "TSTypeLiteral") continue;
    for (const member of annotation.members) {
      if (member.type !== "TSPropertySignature") continue;
      const type = member.typeAnnotation?.typeAnnotation?.typeName;
      if (!type) continue;
      const binding = isDatabaseType(type, member) ? "connection" : "object";
      const property = objectKey(member);
      for (const { key, name } of bindings(parameter)) {
        if (!key) scope.bindings.set(`${name}.${property}`, binding);
        else if (key === property) scope.bindings.set(name, binding);
      }
    }
  }
  // Resolve aliases in their own bindings and preserve weaker inference for
  // untyped parameters as it passes through an alias.
  let changed = true;
  const trackMethod = (
    scope: Scope,
    name: string,
    method: string | undefined,
  ) => {
    if (method && !scope.sqliteMethods?.has(name)) {
      (scope.sqliteMethods ??= new Map()).set(name, method);
      changed = true;
    }
  };
  const trackBinding = (
    scope: Scope,
    name: string,
    binding: Binding | undefined,
    value?: any,
    spread?: SpreadSource,
    propertyAlias?: ObjectAlias,
  ) => {
    if (fixtureFactory(value) && !scope.fixtureFactories?.has(name)) {
      (scope.fixtureFactories ??= new Set()).add(name);
      changed = true;
    }
    if (
      script &&
      fixtureCall(value) &&
      scope.bindings.get(`${name}.db`) !== "connection"
    ) {
      scope.bindings.set(`${name}.db`, "connection");
      changed = true;
    }
    const instance = instanceReference(value);
    if (instance && !scope.instances?.has(name)) {
      (scope.instances ??= new Map()).set(name, instance);
      changed = true;
    }
    const cls = classReference(value);
    if (cls && !scope.classes?.has(name)) {
      (scope.classes ??= new Map()).set(name, cls);
      changed = true;
    }
    const fn = functionReference(value);
    if (fn && !scope.functions?.has(name)) {
      (scope.functions ??= new Map()).set(name, fn);
      changed = true;
    }
    const bound = boundReference(value);
    if (bound && !scope.boundCalls?.has(name)) {
      (scope.boundCalls ??= new Map()).set(name, bound);
      changed = true;
    }
    trackMethod(scope, name, sqliteMethod(value));
    if (!binding) return;
    if (binding === "object") {
      if (value?.type === "ConditionalExpression") {
        for (const branch of [value.consequent, value.alternate]) {
          const source = unwrap(branch);
          if (connectionKind(source) === "object") {
            recordArgument(scope, name, source);
            trackBinding(scope, name, "object", source, spread);
          }
        }
      }
      const returned = returnedObject(value);
      const original = receiver(value);
      const path =
        propertyAlias?.name ??
        (returned ? "result" : original && receiverPath(value, original));
      const origin =
        propertyAlias?.scope ??
        returned ??
        (original?.startsWith("this.")
          ? thisScope(value)
          : path && declaringScope(path.split(".")[0], value));
      const sources = scope.objectAliases?.get(name) ?? [];
      if (
        origin &&
        path &&
        (origin !== scope || name !== path) &&
        !sources.some(
          (entry) =>
            entry.scope === origin &&
            entry.name === path &&
            entry.spread === spread,
        )
      ) {
        sources.push({ scope: origin, name: path, spread });
        (scope.objectAliases ??= new Map()).set(name, sources);
        changed = true;
      }
    }
    const previous = scope.bindings.get(name);
    if (bindingRank[binding] <= bindingRank[previous ?? "other"]) return;
    scope.bindings.set(name, binding);
    changed = true;
  };
  const recordedArguments = new Map<object, Map<Scope, Set<string>>>();
  const recordArgument = (
    scope: Scope,
    name: string,
    argument: any,
    excluded?: Set<string>,
  ) => {
    if (!isAggregate(argument)) return;
    const destinations =
      recordedArguments.get(argument) ?? new Map<Scope, Set<string>>();
    const names = destinations.get(scope) ?? new Set<string>();
    if (names.has(name)) return;
    names.add(name);
    destinations.set(scope, names);
    recordedArguments.set(argument, destinations);
    recordObject(scope, name, argument, excluded);
    changed = true;
  };
  const restCopies = new Map<object, Set<object>>();
  const arrayElementCallbacks = new Set([
    "every",
    "filter",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "flatMap",
    "forEach",
    "map",
    "some",
  ]);
  const trackRestCopy = (scope: Scope, pattern: any, rest: any, value: any) => {
    if (!value) return;
    const copies = restCopies.get(rest) ?? new Set<object>();
    if (copies.has(value)) return;
    if (pattern.type === "ArrayPattern") {
      const array = staticArray(value);
      if (!array) return;
      copies.add(value);
      restCopies.set(rest, copies);
      recordArgument(scope, rest.argument.name, {
        type: "ArrayExpression",
        elements: staticArguments(array).values.slice(
          pattern.elements.indexOf(rest),
        ),
      });
      return;
    }
    const copy = {
      type: "ObjectExpression",
      properties: [{ type: "SpreadElement", argument: value }],
    };
    copies.add(value);
    restCopies.set(rest, copies);
    const excluded = new Set<string>();
    for (const member of pattern.properties) {
      if (member.type !== "Property") continue;
      const key = objectKey(member);
      if (typeof key === "string") excluded.add(key);
    }
    recordArgument(scope, rest.argument.name, copy, excluded);
  };
  const trackParameter = (scope: Scope, parameter: any, argument: any) => {
    const pattern =
      parameter.type === "AssignmentPattern" ? parameter.left : parameter;
    const rest = restElement(pattern);
    if (rest) trackRestCopy(scope, pattern, rest, argument);
    for (const { key, name, fallback } of bindings(parameter)) {
      if (key) {
        const member = destructuredSource(argument, key, fallback);
        const value = member.value;
        const method = destructuredMethod(argument, key) ?? sqliteMethod(value);
        trackMethod(scope, name, method);
        trackBinding(
          scope,
          name,
          member.binding ?? connectionKind(value),
          value,
          undefined,
          member.origin,
        );
        recordArgument(scope, name, value);
        continue;
      }
      trackBinding(scope, name, connectionKind(argument), argument);
      recordArgument(scope, name, argument);
    }
  };
  const returnExpressions: { fn: object; value: any }[] = [];
  const addReturn = (fn: object, node: any): void => {
    const value = unwrap(node);
    if (value?.type === "ConditionalExpression") {
      addReturn(fn, value.consequent);
      addReturn(fn, value.alternate);
      return;
    }
    returnExpressions.push({ fn, value });
    // Register literal fields before resolving any spread that uses the result.
    if (isAggregate(value)) {
      const result = returnedObjects.get(fn) ?? { bindings: new Map() };
      returnedObjects.set(fn, result);
      recordObject(result, "result", value);
    }
  };
  if (script) {
    for (const node of nodes) {
      if (
        node.type !== "ReturnStatement" &&
        node.type !== "ArrowFunctionExpression"
      )
        continue;
      const value = unwrap(
        node.type === "ReturnStatement" ? node.argument : node.body,
      );
      let fn = node;
      while (fn && !functionKinds.has(fn.type)) fn = parents.get(fn);
      if (!fn || !value) continue;
      addReturn(fn, value);
    }
  }
  while (changed) {
    changed = false;
    for (const { scope, name, value, spread } of propertyInitializers)
      trackBinding(scope, name, connectionKind(value), value, spread);
    for (const { fn, value } of returnExpressions) {
      const kind = connectionKind(value);
      if (
        kind === "object" &&
        (value.type === "Identifier" ||
          fixtureCall(value) ||
          returnedObject(value))
      ) {
        let result = returnedObjects.get(fn);
        if (!result) {
          result = { bindings: new Map() };
          returnedObjects.set(fn, result);
          changed = true;
        }
        trackBinding(result, "result", kind, value);
      }
      if (!returnsDatabase.has(fn) && kind === "connection") {
        returnsDatabase.add(fn);
        changed = true;
      }
    }
    for (const node of nodes) {
      if (
        node.type === "NewExpression" ||
        (node.type === "CallExpression" &&
          node.callee.type === "MemberExpression")
      ) {
        const fn =
          node.type === "NewExpression"
            ? constructorReference(unwrap(node.callee))
            : functionReference(node.callee);
        if (
          fn &&
          fn.type !== "ArrowFunctionExpression" &&
          !explicitReceiverScopes.has(fn)
        ) {
          explicitReceiverScopes.set(fn, { bindings: new Map() });
          changed = true;
        }
      }
      if (script && node.type === "ForOfStatement") {
        const array = staticArray(node.right);
        const declaration =
          node.left.type === "VariableDeclaration"
            ? node.left.declarations[0]
            : undefined;
        const target = declaration?.id ?? node.left;
        const owner = declaration
          ? declarationScope(declaration)
          : target.type === "Identifier" && declaringScope(target.name, target);
        if (array && owner)
          for (const item of staticArguments(array).values)
            trackParameter(owner, target, unwrap(item));
      }
      if (script && functionKinds.has(node.type))
        for (const parameter of node.params)
          if (parameter.type === "AssignmentPattern")
            trackParameter(scopeOf(node), parameter, unwrap(parameter.right));
      if (
        script &&
        (node.type === "CallExpression" || node.type === "NewExpression")
      ) {
        if (
          node.type === "CallExpression" &&
          node.callee.type === "MemberExpression" &&
          arrayElementCallbacks.has(property(node.callee))
        ) {
          const array = staticArray(node.callee.object);
          const callback =
            array && functionReference(unwrap(node.arguments[0]));
          const parameter = callback?.params[0];
          if (array && parameter)
            for (const item of staticArguments(array).values)
              trackParameter(scopeOf(callback), parameter, unwrap(item));
        }
        const { fn, items } = invocation(node);
        const argumentsList = fn && items ? staticArguments(items) : undefined;
        for (const [index, parameter] of (fn?.params ?? []).entries()) {
          if (
            !argumentsList ||
            (!argumentsList.complete && index >= argumentsList.values.length)
          )
            break;
          const passed = unwrap(argumentsList.values[index]);
          const argument =
            isMissing(passed) && parameter.type === "AssignmentPattern"
              ? unwrap(parameter.right)
              : passed;
          const scope = scopeOf(fn);
          if (
            parameter.type === "RestElement" &&
            parameter.argument.type === "Identifier"
          ) {
            for (const [offset, item] of argumentsList.values
              .slice(index)
              .entries()) {
              const value = unwrap(item);
              trackBinding(
                scope,
                `${parameter.argument.name}.${offset}`,
                connectionKind(value),
                value,
              );
            }
            continue;
          }
          trackParameter(scope, parameter, argument);
        }
      }
      const declaration = node.type === "VariableDeclarator";
      const field = node.type === "PropertyDefinition";
      if (!declaration && !field && node.type !== "AssignmentExpression")
        continue;
      const target = declaration ? node.id : node.left;
      const value = unwrap(
        declaration ? node.init : field ? node.value : node.right,
      );
      const rest = script && restElement(target);
      if (rest) {
        const name = rest.argument.name;
        const owner = declaration
          ? declarationScope(node)
          : (declaringScope(name, node) ?? scopeOf(node));
        trackRestCopy(owner, target, rest, value);
      }
      const assigned: {
        name: string;
        binding: Binding | undefined;
        method?: string;
        extracted?: any;
        origin?: ObjectAlias;
      }[] = [];
      if (target?.type === "ObjectPattern" || target?.type === "ArrayPattern") {
        for (const { key, name, fallback } of bindings(target)) {
          const {
            binding: property,
            value: extracted,
            origin,
          } = destructuredSource(value, key, fallback);
          const binding =
            property ??
            (isAggregate(extracted) ? "object" : undefined) ??
            connectionKind(extracted) ??
            (key === "db" ? destructuredDatabase(value) : undefined);
          const path = receiver(value);
          const owner =
            path === "this" || path?.startsWith("this.")
              ? thisScope(value)
              : path && declaringScope(path.split(".")[0], value);
          const stored =
            owner &&
            receiverProperty(owner, `${path}.${key}`, (scope, property) =>
              scope.sqliteMethods?.get(property),
            );
          const method =
            destructuredMethod(value, key) ??
            sqliteMethod(extracted) ??
            stored ??
            undefined;
          if (binding || method)
            assigned.push({ name, binding, method, extracted, origin });
        }
      } else if (field) {
        const key = node.computed
          ? literalKey(node.key)
          : (node.key.name ?? node.key.value);
        if (typeof key === "string")
          assigned.push({
            name: `${node.static ? "static" : "this"}.${key}`,
            binding: connectionKind(value),
          });
      } else {
        const name = receiver(target);
        if (name) assigned.push({ name, binding: connectionKind(value) });
      }
      for (const { name, binding, method, extracted, origin } of assigned) {
        const owner = declaration
          ? declarationScope(node)
          : field || name.startsWith("this.")
            ? thisScope(node)
            : (declaringScope(name.split(".")[0], node) ?? scopeOf(node));
        if (!owner) continue;
        const path = receiverPath(node, name);
        if (node.type === "AssignmentExpression" && receiver(target))
          recordArgument(owner, path, value);
        if (
          script &&
          node.type === "AssignmentExpression" &&
          !name.startsWith("this.") &&
          name.includes(".")
        ) {
          const separator = name.indexOf(".");
          const alias = latestWrite(node, name.slice(0, separator), owner);
          const source = unwrap(alias?.init);
          if (
            alias?.type === "VariableDeclarator" &&
            source?.type === "Identifier"
          ) {
            const original = declaringScope(source.name, source);
            const originalWrite =
              original && latestWrite(node, source.name, original);
            if (original && !(originalWrite?.start > alias.end)) {
              const property = source.name + name.slice(separator);
              recordArgument(original, property, value);
              trackBinding(original, property, binding, value);
            }
          }
        }
        trackMethod(owner, path, method);
        trackBinding(
          owner,
          path,
          binding,
          target?.type === "ObjectPattern" || target?.type === "ArrayPattern"
            ? extracted
            : value,
          undefined,
          origin,
        );
      }
    }
  }
  return nodes
    .filter((node) => {
      if (node.type !== "CallExpression") return false;
      if (sqliteMethod(unwrap(node.callee))) return true;
      if (node.callee.type !== "MemberExpression") return false;
      const method = property(node.callee);
      const target = unwrap(node.callee.object);
      if (
        script &&
        method === "apply" &&
        target?.type === "Identifier" &&
        target.name === "Reflect" &&
        !declaringScope(target.name, target) &&
        sqliteMethod(unwrap(node.arguments[0]))
      )
        return true;
      if (
        ["call", "apply"].includes(method) &&
        sqliteMethod(unwrap(node.callee.object))
      )
        return true;
      if (!methods.has(method)) return false;
      const binding = connectionKind(node.callee.object);
      if (binding === "connection") return true;
      const opaqueReceiver =
        script &&
        (!binding || binding === "other") &&
        (node.callee.object.type === "MemberExpression" ||
          node.callee.object.type === "Identifier" ||
          node.callee.object.type === "CallExpression");
      if (binding !== "inferred" && !opaqueReceiver) return false;
      // Inferred receivers need recognizable SQL text or a statement variable.
      const statement = node.arguments[0];
      if (
        script &&
        binding === "inferred" &&
        statement?.type === "Identifier" &&
        /^(?:sql|query|statement|migrationText)(?:$|[A-Z_])/.test(
          statement.name,
        )
      )
        return true;
      const text =
        statement?.type === "TemplateLiteral"
          ? binding === "inferred"
            ? statement.quasis.find((quasi: any) => quasi.value.cooked?.trim())
                ?.value.cooked
            : statement.quasis[0]?.value.cooked
          : literalKey(statement);
      if (typeof text !== "string") return false;
      if (method === "pragma" && binding === "inferred") return true;
      const sql = text.replace(
        /^(?:\s+|\/\*[\s\S]*?\*\/|--[^\r\n]*(?:\r\n|[\r\n]|$))+/,
        "",
      );
      const keyword =
        /^\s*(?:SELECT|WITH|INSERT|REPLACE|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|ATTACH|DETACH|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|REINDEX|ANALYZE|EXPLAIN)\b/i.exec(
          sql,
        );
      // For an opaque receiver, a standalone keyword is also a plausible command.
      return Boolean(
        keyword &&
        (!opaqueReceiver || /[^\s;]/.test(sql.slice(keyword[0].length))),
      );
    })
    .map((node) => text.slice(0, node.start).split("\n").length);
}
const inventory = (file: string, text: string) =>
  sqlCallLines(file, text).length;

// Failure text names the rule, the repository's pattern and its recipe.
const sqlRecipe =
  "docs/architecture.md#recipe-add-or-extend-a-sql-table-module";
const directSql = (location: string) =>
  `${location} calls SQLite directly. Put the query in the module under src/server/sql/ that owns its table and call that (${sqlRecipe}). If this can't be satisfied, say so in the PR; do not add the file to the allowance.`;

it("counts SQL calls and aliases without counting comments, strings or regular expressions", () => {
  expect(
    inventory(
      "probe.ts",
      `
    import { db as connection } from "./db.js";
    import SQLite from "better-sqlite3";
    const alias = connection, second = alias;
    const lock = new SQLite(":memory:");
    connection.prepare("SELECT 1"); second["exec"]("SELECT 2");
    lock.exec("BEGIN"); db?.prepare("SELECT 3");
    api.prepare("not SQL"); destination.prepare({}); policy.prepare?.();
    this.db.prepare(query);
    function injected(database: SQLite.Database) { database.exec("SELECT 4"); }
    // db.prepare("ignored")
    const text = 'db.exec("ignored")'; /db.prepare/.exec(text);
  `,
    ),
  ).toBe(6);
});

it("detects renamed fixture handles and JavaScript SQLite constructors", () => {
  expect(
    sqlCallLines(
      "probe.mjs",
      `
      const { "db": fixtureConnection = fallback } = fixture;
      const { default: OpenDatabase } = await import("better-sqlite3");
      const source = new OpenDatabase(":memory:");
      fixtureConnection.prepare("SELECT 1");
      source.exec("BEGIN"); source.prepare("SELECT 2");
      function injected(database) { database.prepare("SELECT 3"); }
      function withFixture({ db: handle }) { handle.exec("SELECT 4"); }
      const Sqlite = (await import("better-sqlite3")).default;
      const scratch = new Sqlite(":memory:");
      scratch.exec("SELECT 5");
      const database = service.adapter; database.exec(command);
      function unrelated(database) { database.exec(command); }
      const { service: client } = fixture; client.prepare({});
    `,
    ),
  ).toEqual([5, 6, 6, 7, 8, 11]);
  expect(
    inventory(
      "probe.cjs",
      `
      const Sqlite = require("better-sqlite3");
      const scratch = new Sqlite(":memory:");
      scratch.exec("SELECT 5");
    `,
    ),
  ).toBe(1);
});

it("checks script pragmas and keeps SQLite alias inference in scope", () => {
  const text = `
    function fromFixture(fixture) {
      const { db: client } = fixture;
      client.pragma("foreign_keys = ON");
      {
        const client = service;
        client.prepare(options);
      }
    }
    function fromParameter(database) {
      const handle = database, alias = handle;
      alias.prepare("SELECT 1");
      handle.pragma("query_only");
    }
    function unrelated(client, handle) {
      client.prepare(options);
      handle.exec(command);
    }
    db.pragma("foreign_keys = OFF");
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 12, 13, 19]);
  expect(sqlCallLines("probe.mjs", text)).toEqual([12]);
});

it("tracks hoisted aliases and instance fields without guessing adapter types", () => {
  const text = `
    function hoisted(flag) {
      if (flag) { var handle = db; }
      handle.exec(sql);
    }
    const { db: client } = adapters;
    client.exec(command);
    class Reader {
      constructor() { this.connection = db; }
      read() { this.connection.prepare(sql); }
    }
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 10]);
});

it("tracks dynamic queries, typed hoisted handles and shared object fields", () => {
  const text = `
    import SQLite from "better-sqlite3";
    const { db: handle } = fixture;
    handle.prepare(query);
    function typed(flag) {
      if (flag) { var sql: SQLite.Database; }
      sql.exec(query);
    }
    const state = {};
    function bind() { state.connection = db; }
    function read() { state.connection.prepare(query); }
    function unrelated() {
      const state = { connection: adapter };
      state.connection.prepare(query);
    }
  `;
  expect(sqlCallLines("probe.ts", text, true)).toEqual([4, 7, 11]);
  expect(sqlCallLines("probe.ts", text)).toEqual([7, 11]);
});

it("counts a fixture's dynamic exec without counting a local command adapter", () => {
  const text = `
    function seed(fixture, query) {
      const { db: sqlite } = fixture;
      sqlite.exec(query);
    }
    function dispatch(command) {
      const db = { exec: runCommand };
      db.exec(command);
    }
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4]);
});

it("counts renamed parameters and inline SQLite without counting nested adapters", () => {
  const text = `
    import SQLite from "better-sqlite3";
    function migrate({ db: handle }, statement) {
      handle.exec(statement);
    }
    new SQLite(":memory:").exec("SELECT 1");
    const services = { db: { exec: runCommand } };
    services.db.exec(command);
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 6]);
});

it("keeps receiver aliases and shadowed constructors in their own scope", () => {
  const text = `
    import OpenDatabase from "better-sqlite3";
    const operations = {
      bind() { this.connection = db; },
      inspect() { this.connection.prepare(query); },
    };
    function migrate(context, query) {
      const { db: handle } = context;
      handle.exec(query);
    }
    function dispatch(command) {
      function OpenDatabase() { return { exec: runCommand }; }
      new OpenDatabase().exec(command);
    }
  `;
  expect(sqlCallLines("probe.ts", text)).toEqual([5]);
  expect(sqlCallLines("probe.ts", text, true)).toEqual([5, 9]);
});

it("follows inherited fields, field initializers and destructuring assignments", () => {
  const text = `
    import SQLite from "better-sqlite3";
    class Parent {
      constructor() {
        this.connection = db;
        function dispatch() { this.connection.exec(command); }
        dispatch.call(adapter);
      }
    }
    class Child extends Parent {
      read() {
        this.connection.prepare(query);
        const read = () => this.connection.prepare(query);
        function dispatch() { this.connection.exec(command); }
        dispatch.call(adapter);
      }
    }
    class Independent {
      connection = new SQLite(":memory:");
      read() { this.connection.exec(query); }
    }
    let handle;
    ({ db: handle } = fixture);
    handle.exec(query);
  `;
  expect(sqlCallLines("probe.ts", text)).toEqual([12, 13, 20]);
  expect(sqlCallLines("probe.ts", text, true)).toEqual([12, 13, 20, 24]);
});

it("uses known property bindings and carries fixture and object aliases", () => {
  const text = `
    import SQLite from "better-sqlite3";
    function dispatch(db, command) { db.exec(command); }
    {
      const adapter = { exec: runCommand };
      const db = adapter;
      db.exec(command);
    }
    const holder = {};
    holder.db = new SQLite(":memory:");
    const { db: handle } = holder;
    handle.exec(query);
    function seed(context, query) {
      const fixtureAlias = context;
      const { db: connection } = fixtureAlias;
      connection.exec(query);
    }
  `;
  expect(sqlCallLines("probe.ts", text, true)).toEqual([12, 16]);
});

it("counts fixture member calls and SQLite handles in object initializers", () => {
  const text = `
    import SQLite from "better-sqlite3";
    function seed(fixture, query) { fixture.db.exec(query); }
    const first = { connection: new SQLite(":memory:") };
    const second = { connection: first.connection };
    first.connection.prepare("SELECT 1");
    second.connection.exec(query);
    const adapter = { db: { exec: runCommand } };
    adapter.db.exec(command);
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([3, 6, 7]);
});

it("resolves object aliases and explicit callback receivers", () => {
  const text = `
    import SQLite from "better-sqlite3";
    const state = { connection: new SQLite(":memory:") };
    const alias = state;
    alias.connection.exec(query);
    const loop = {};
    loop.self = loop;
    loop.self.self.other.prepare(query);
    class Reader {
      constructor() { this.connection = db; }
      read() {
        function execute() { this.connection.prepare(query); }
        execute.call(this);
        (function () { this.connection.exec(query); }).call(this);
      }
    }
    function dispatch(context, command) { context.db.exec(command); }
  `;
  expect(sqlCallLines("probe.ts", text)).toEqual([5, 12, 14, 17]);
  expect(sqlCallLines("probe.ts", text, true)).toEqual([5, 12, 14]);
});

it("uses known fixture arguments and follows constructor aliases", () => {
  const text = `
    import SQLite from "better-sqlite3";
    const OpenDatabase = SQLite;
    const source = { db: new OpenDatabase(":memory:") };
    function execute(context, statement) {
      context.db.exec(statement);
    }
    execute(source, query);
    const adapter = { db: { exec: runCommand } };
    function dispatch(context, command) { context.db.exec(command); }
    dispatch(adapter, command);
    const standalone = new OpenDatabase(":memory:");
    standalone.exec(query);
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([6, 13]);
});

it("follows namespace imports and local wrappers receiving SQLite handles", () => {
  const text = `
    import * as storage from "../src/server/db.js";
    storage.db.exec(query);
    const execute = (context, statement) => context.db.exec(statement);
    execute({ db: storage.db }, query);
    const prepare = function (connection, statement) {
      connection.prepare(statement);
    };
    prepare(storage.db, query);
    function run(connection, statement) { connection.exec(statement); }
    run(storage.db, query);
    const adapter = { exec: runCommand };
    const dispatch = (connection, command) => connection.exec(command);
    dispatch(adapter, command);
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([3, 4, 7, 10]);
});

it("follows renamed object fields and database parameters at fixture exports", () => {
  const text = `
    import SQLite from "better-sqlite3";
    const state = { connection: new SQLite(":memory:") };
    const { connection: handle } = state;
    handle.exec(query);
    export function read(db, statement) { db.exec(statement); }
    export const write = (db, statement) => db.exec(statement);
    const publish = (db, statement) => db.exec(statement);
    export { publish };
    function dispatch(db, command) { db.exec(command); }
    export function run(db: CommandAdapter, command: string) { db.exec(command); }
  `;
  expect(sqlCallLines("probe.ts", text, true)).toEqual([5, 6, 7, 8]);
});

it("finds database module extensions and passes complete object shapes to methods", () => {
  const text = `
    import { db as connection } from "../src/server/db.ts";
    connection.exec(query);
    const helpers = {
      execute(handle, statement) { handle.exec(statement); },
      read(context, statement) { context.connection.prepare(statement); },
    };
    const alias = helpers;
    alias.execute(connection, query);
    helpers.read({ connection }, query);
    new (await import("better-sqlite3")).default(":memory:").exec(query);
  `;
  expect(sqlCallLines("probe.ts", text, true)).toEqual([3, 5, 6, 11]);
});

it("follows destructured and default parameters and infers opaque SQL text", () => {
  const text = `
    import SQLite from "better-sqlite3";
    const database = new SQLite(":memory:");
    function fromObject({ connection }, query) { connection.exec(query); }
    fromObject({ connection: database }, query);
    function defaulted(handle = database, query) { handle.exec(query); }
    defaulted(undefined, query);
    class Reader {
      connection = database;
      read() {
        const { connection } = this;
        connection.exec(query);
      }
    }
    function opaque(context, command) {
      context.connection.exec("SELECT 1");
      context.adapter.exec(command);
    }
  `;
  expect(sqlCallLines("probe.ts", text, true)).toEqual([4, 6, 12, 16]);
});

it("follows aliased wrappers, CommonJS exports and extracted SQLite methods", () => {
  const text = `
    const SQLite = require("better-sqlite3");
    const db = new SQLite(":memory:");
    function execute(handle, query) { handle.exec(query); }
    const invoke = execute;
    invoke(db, query);
    module.exports = function seed(db, query) { db.exec(query); };
    const bound = db.exec.bind(db);
    const indirect = bound;
    indirect(query);
    db.prepare.bind(db)("SELECT 1");
    function configure(module) {
      module.exports = function dispatch(db, command) { db.exec(command); };
    }
  `;
  expect(sqlCallLines("probe.cjs", text, true)).toEqual([4, 7, 10, 11]);
});

it("retains SQLite evidence across call orders and destructured method aliases", () => {
  const text = `
    import SQLite from "better-sqlite3";
    const db = new SQLite(":memory:");
    const adapter = { connection: { exec: runCommand } };
    const source = { connection: db };
    function run(context, query) { context.connection.exec(query); }
    run(adapter, command);
    run(source, query);
    const { exec: execute } = db;
    const bound = execute.bind(db);
    bound(query);
  `;
  expect(sqlCallLines("probe.ts", text, true)).toEqual([6, 11]);
  const reversed = text.replace(
    "run(adapter, command);\n    run(source, query);",
    "run(source, query);\n    run(adapter, command);",
  );
  expect(sqlCallLines("probe.ts", reversed, true)).toEqual([6, 11]);
});

it("covers namespace constructors, object spreads and defaulted exports", () => {
  const text = `
    import * as SQLite from "better-sqlite3";
    const db = new SQLite.default(":memory:");
    db?.exec(query);
    export function seed(db = openFixtureDb(), query) { db.exec(query); }
    const fixture = { connection: db };
    function run(context, query) { context?.connection?.exec(query); }
    run({ ...fixture }, query);
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 5, 7]);
});

it("discovers aliased exports and distinguishes fixture objects from adapters", () => {
  const text = `
    import SQLite from "better-sqlite3";
    function seed(db, query) { db.exec(query); }
    const publish = seed;
    export { publish };
    const adapter = { exec: runCommand };
    const fixture = { db: adapter };
    const { db: handle } = fixture;
    handle.exec(command);
    fixture.db.exec(command);
    function typedAdapter({ db }: { db: CommandAdapter }, command: string) {
      db.exec(command);
    }
    function typedDatabase({ db: connection }: { db: SQLite.Database }, query: string) {
      connection.exec(query);
    }
  `;
  expect(sqlCallLines("probe.ts", text, true)).toEqual([3, 15]);
});

it("retains SQLite handles passed to constructors or stored in arrays", () => {
  const text = `
    import SQLite from "better-sqlite3";
    const db = new SQLite(":memory:");
    class Reader {
      constructor(handle) { this.connection = handle; }
      read(query) { this.connection.exec(query); }
    }
    new Reader(db);
    const pair = [commandAdapter, db];
    const [, renamed] = pair;
    renamed.exec(query);
    const [inline] = [db];
    inline.prepare(query);
    pair[1].exec(query);
  `;
  expect(sqlCallLines("probe.ts", text, true)).toEqual([6, 11, 13, 14]);
});

it("recognizes dynamic namespaces, assertion aliases and destructured spreads", () => {
  const text = `
    const SQLite = await import("better-sqlite3");
    const handle = new SQLite.default(":memory:");
    handle.exec(query);
    const asserted = (handle as Database)!;
    asserted.exec(query);
    const fixture = { connection: asserted };
    const { connection: unpacked } = { ...fixture };
    unpacked.exec(query);
  `;
  expect(sqlCallLines("probe.ts", text, true)).toEqual([4, 6, 9]);
});

it("follows nested patterns, fixed spread arguments and local factory returns", () => {
  const text = `
    import SQLite from "better-sqlite3";
    const db = new SQLite(":memory:");
    const { storage: { connection } } = { storage: { connection: db } };
    connection.exec(query);
    function execute(handle, statement) { handle.exec(statement); }
    execute(...[db, query]);
    function open() { return new SQLite(":memory:"); }
    const opened = open();
    opened.exec(query);
    const openAlias = () => open();
    openAlias().prepare(query);
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([5, 6, 10, 12]);
});

it("recognizes named default imports and wrappers invoked through call and apply", () => {
  const text = `
    import { default as SQLite } from "better-sqlite3";
    const handle = new SQLite(":memory:");
    handle.exec(query);
    function write(connection, statement) { connection.exec(statement); }
    write.call(null, handle, query);
    const read = (connection, statement) => connection.prepare(statement);
    read.apply(null, [handle, query]);
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 5, 7]);
});

it("recognizes bound wrappers, TypeScript loaders and rest bindings without guessing adapter exports", () => {
  const text = `
    import SQLite from "better-sqlite3";
    const db = new SQLite(":memory:");
    function write(handle, query) { handle.exec(query); }
    const run = write.bind(null, db);
    run(query);
    write.bind(null, db)(query);
    const { db: handle } = await tsImport("../src/server/db.ts", import.meta.url);
    handle.exec(query);
    function readRest(...items) { items[0].exec(query); }
    readRest(db);
    export function dispatch(db, command) { db.exec(command); }
    export function seed(db, statement) { db.exec(statement); }
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 9, 10, 13]);
});

it("uses known defaults and computed methods while respecting spread overrides", () => {
  const text = `
    import SQLite from "better-sqlite3";
    export function seed(handle = new SQLite(":memory:")) { handle.exec("SELECT 1"); }
    const db = new SQLite(":memory:");
    const source = { connection: db };
    const adapter = { exec: runCommand };
    const fixture = { ...source, connection: adapter };
    fixture.connection.exec(command);
    const method = "exec";
    db[method](query);
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([3, 10]);
});

it("preserves named spread order, stored method destructuring and instance arguments", () => {
  const text = `
    import SQLite from "better-sqlite3";
    const db = new SQLite(":memory:");
    const adapter = { exec: runCommand };
    const source = { connection: db };
    const override = { connection: adapter };
    const merged = { ...source, ...override };
    merged.connection.exec(command);
    const ops = { execute: db.exec.bind(db) };
    const { execute } = ops;
    execute(query);
    class Reader {
      run(handle, statement) { handle.exec(statement); }
    }
    const reader = new Reader();
    reader.run(db, query);
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([11, 13]);
  expect(
    sqlCallLines(
      "probe.mjs",
      text.replace("...source, ...override", "...override, ...source"),
      true,
    ),
  ).toEqual([8, 11, 13]);
});

it("follows conditional and fixture-factory handles without classifying adapter parameters", () => {
  const text = `
    import SQLite from "better-sqlite3";
    import { designFixture as makeFixture } from "./helpers/design-fixture.mjs";
    function dispatch({ db: handle }, command) { handle.exec(command); }
    dispatch({ db: { exec: runCommand } }, command);
    const primary = new SQLite(":memory:");
    const scratch = new SQLite(":memory:");
    const connection = useScratch ? scratch : primary;
    connection.exec(query);
    const { db: fromFixture } = await makeFixture();
    fromFixture.exec(query);
    const fixture = await makeFixture();
    fixture.db.prepare(query);
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([9, 11, 13]);
});

it("follows static fields and fallback handles without reporting typed adapters", () => {
  const text = `
    import SQLite from "better-sqlite3";
    class Store {
      static connection = new SQLite(":memory:");
      static write(handle, query) { handle.exec(query); }
    }
    Store.connection.exec(query);
    Store.write(Store.connection, query);
    const selected = primary ?? Store.connection;
    selected.exec(query);
    const fallback = primary || Store.connection;
    fallback.exec(query);
    function dispatch({ db }: { db: CommandAdapter }, options: Options) {
      db.prepare(options);
    }
  `;
  expect(sqlCallLines("probe.ts", text, true)).toEqual([5, 7, 10, 12]);
});

it("tracks external instance fields and gives inline and named spreads equal precedence", () => {
  const text = `
    import SQLite from "better-sqlite3";
    const db = new SQLite(":memory:");
    class Reader { connection = new SQLite(":memory:"); }
    const reader = new Reader();
    reader.connection.exec(query);
    const override = { connection: { exec: runCommand } };
    const mixed = { ...{ connection: db }, ...override };
    mixed.connection.exec(command);
    const reversed = { ...override, ...{ connection: db } };
    reversed.connection.exec(query);
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([6, 11]);
});

it("tracks extracted argument objects and static receivers while honoring nested overrides", () => {
  const text = `
    import SQLite from "better-sqlite3";
    import adapter from "./command-adapter.mjs";
    const db = new SQLite(":memory:");
    function extract({ storage }, query) { storage.connection.exec(query); }
    extract({ storage: { connection: db } }, query);
    class Store {
      static connection = db;
      static flush(statement) { this.connection.exec(statement); }
    }
    const base = { storage: { connection: db } };
    const override = { storage: adapter };
    const merged = { ...base, ...override };
    merged.storage.connection.exec(command);
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([5, 9]);
});

it("follows inline fixtures, computed destructuring and assigned object fields", () => {
  const text = `
    import SQLite from "better-sqlite3";
    import { designFixture } from "./helpers/design-fixture.mjs";
    (await designFixture()).db.exec(query);
    const db = new SQLite(":memory:");
    const source = { connection: db };
    const key = "connection";
    const { [key]: handle } = source;
    handle.exec(query);
    let storage;
    storage = { connection: db };
    storage.connection.exec(query);
  `;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 9, 12]);
});

it("preserves destructured receivers and distinguishes regex calls from opaque SQLite calls", () => {
  const text = `
    import SQLite from "better-sqlite3";
    const db = new SQLite(":memory:");
    const fixture = { storage: { connection: db } };
    const { storage } = fixture;
    storage.connection.exec(query);
    export function run(connection) { connection.prepare("SELECT 1"); }
    const checks = { sql: /^SELECT/ };
    checks.sql.exec("SELECT 1");
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([6, 7]);
});

it("follows default handles and SQL constants while excluding constructed regexes", () => {
  const text = `
    import { db } from "../src/server/db.js";
    const { connection = db } = {};
    connection.exec(query);
    const migration = "SELECT 1";
    export function run(fixture) {
      const { db } = fixture;
      db.exec(migration);
    }
    const prefix = new RegExp("^SELECT");
    prefix.exec("SELECT 1");
    const { connection: adapter = db } = { connection: { exec: runCommand } };
    adapter.exec(migration);
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 8]);
});

it("resolves inline fixture arguments and gives later spreads precedence over explicit fields", () => {
  const text = `
    import SQLite from "better-sqlite3";
    import { designFixture } from "./helpers/design-fixture.mjs";
    function seed({ db: handle }, migrationText) { handle.exec(migrationText); }
    async function run() { seed(await designFixture(), migrationText); }
    const sqlite = new SQLite(":memory:");
    const override = { connection: { exec: runCommand } };
    const target = { connection: sqlite, ...override };
    target.connection.exec(command);
    const retained = { connection: sqlite, ...{ other: 1 } };
    retained.connection.exec(migrationText);
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 11]);
});

it("recognizes inline imports and computed methods while excluding opaque standalone commands", () => {
  const text = `
    import { db } from "../src/server/db.js";
    shell.exec("BEGIN");
    shell.exec("BEGIN;");
    db.exec("BEGIN");
    (await import("../src/server/db.js")).db.exec(query);
    db["ex" + "ec"](query);
    connection.prepare("SELECT 1");
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([5, 6, 7, 8]);
});

it("tracks returned connection objects and CommonJS constructors and honors nested defaults", () => {
  const text = `
    import SQLite from "better-sqlite3";
    function open() { return { connection: new SQLite(":memory:") }; }
    const { connection } = open();
    connection.exec(migrationText);
    const base = { storage: { connection: new SQLite(":memory:") } };
    const override = { storage: {} };
    const { storage: { connection: pattern = /./ } } = { ...base, ...override };
    pattern.exec("SELECT 1");
    new (require("better-sqlite3"))(":memory:").exec(migrationText);
`;
  expect(sqlCallLines("probe.cjs", text, true)).toEqual([5, 10]);
});

it("follows assigned factory results, local reassignments and leading SQL interpolations", () => {
  const text = `
    import SQLite from "better-sqlite3";
    function open() { return { connection: new SQLite(":memory:") }; }
    const store = open();
    store.connection.exec(migrationText);
    let handle = new SQLite(":memory:");
    handle.exec(migrationText);
    handle = { exec: runCommand };
    handle.exec(command);
    handle = new SQLite(":memory:");
    handle.exec(migrationText);
    if (condition) handle = { exec: runCommand };
    handle.exec(migrationText);
    export function run(fixture) {
      const { db } = fixture;
      db.exec(\`\${prefix} SELECT * FROM runs\`);
    }
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([5, 7, 11, 13, 16]);
});

it("preserves copied SQLite fields and resolves design-fixture namespace imports", () => {
  const text = `
    import SQLite from "better-sqlite3";
    import * as fixtures from "./helpers/design-fixture.mjs";
    const sqlite = new SQLite(":memory:");
    const holder = { connection: sqlite, other: sqlite };
    const { other, ...copy } = holder;
    copy.connection.exec(migrationText);
    copy.other?.exec(migrationText);
    const { ...inline } = { connection: sqlite };
    inline.connection.exec(migrationText);
    const { db } = await fixtures.designFixture();
    db.exec(migrationText);
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([7, 10, 12]);
});

it("follows conditional fixture fields and named replacements and skips leading SQL comments", () => {
  const text = `
    import SQLite from "better-sqlite3";
    const scratchFixture = { db: new SQLite(":memory:") };
    const primaryFixture = { db: new SQLite(":memory:") };
    const { db: selected } = flag ? scratchFixture : primaryFixture;
    selected.exec(migrationText);
    let handle = new SQLite(":memory:");
    handle.exec(migrationText);
    const adapter = { exec: runCommand };
    handle = adapter;
    handle.exec(command);
    function run(context) {
      const { db } = context;
      db.exec("/* migration */ -- query\\n SELECT 1");
    }
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([6, 8, 14]);
});

it("follows parameter defaults and namespace types while observing factory spread order", () => {
  const text = `
    import SQLite from "better-sqlite3";
    import * as DatabaseTypes from "better-sqlite3";
    const sqlite = new SQLite(":memory:");
    function migrate({ connection = sqlite }, migrationText) { connection.exec(migrationText); }
    migrate({}, migrationText);
    const { connection: adapter } = { ...{ connection: sqlite }, ...makeAdapter() };
    adapter.exec(command);
    function makeAdapter() { return { connection: { exec: runCommand } }; }
    function seed(connection: DatabaseTypes.Database) { connection.exec(migrationText); }
`;
  expect(sqlCallLines("probe.ts", text, true)).toEqual([5, 10]);
});

it("preserves server receiver detection and follows method destructuring in script parameters", () => {
  const text = `
    import { db } from "../src/server/db.js";
    class Store { constructor(database) { this.db = database; } }
    const store = new Store(db);
    store.db.exec(migrationText);
    function migrate() {
      this.connection = db;
      this.connection.exec(migrationText);
    }
    const holder = {};
    migrate.call(holder);
    function seed({ exec }, connection, text) { exec.call(connection, text); }
    seed(db, db, migrationText);
`;
  expect(sqlCallLines("probe.ts", text)).toEqual([5, 8]);
  expect(sqlCallLines("probe.ts", text, true)).toEqual([5, 8, 12]);
});

it("detects ordinary method receivers and computed keys without using later writes for earlier calls", () => {
  const text = `
    import { db } from "../src/server/db.js";
    import SQLite from "better-sqlite3";
    function migrate(sql) { this.connection = db; this.connection.exec(sql); }
    const holder = { migrate };
    holder.migrate(migrationText);
    const key = "connection";
    class Store {
      [key] = new SQLite(":memory:");
      seed() { this.connection.exec(migrationText); }
    }
    let handle = { exec: runCommand };
    handle.exec(command);
    handle = new SQLite(":memory:");
    handle[\`exec\`](migrationText);
`;
  expect(sqlCallLines("probe.ts", text)).toContain(4);
  expect(sqlCallLines("probe.ts", text, true)).toEqual([4, 10, 15]);
});

it("detects constructor receivers and conditional SQLite bindings while excluding RegExp calls", () => {
  const text = `
    import { db } from "../src/server/db.js";
    function Store() { this.connection = db; this.connection.exec(migrationText); }
    new Store();
    const primary = { db };
    const scratch = { db };
    const fixture = flag ? primary : scratch;
    fixture.db.exec(migrationText);
    let handle = { exec: runCommand };
    handle.exec(command);
    if (flag) handle = db;
    handle.exec(migrationText);
    let other = { exec: runCommand };
    if (flag) { other = db; }
    other.exec(migrationText);
    const pattern = RegExp("^SELECT");
    pattern.exec("SELECT 1");
`;
  expect(sqlCallLines("probe.ts", text)).toContain(3);
  expect(sqlCallLines("probe.ts", text, true)).toEqual([3, 8, 12, 15]);
});

it("follows known array spreads and named SQLite database types", () => {
  const text = `
    import { db } from "../src/server/db.js";
    import type { Database as Handle } from "better-sqlite3";
    function execute(handle, migrationText) { handle.exec(migrationText); }
    const args = [db, migrationText];
    execute(...args);
    function seed(connection: Handle) { connection.exec(migrationText); }
    const handles = [...[], db];
    handles[0].exec("BEGIN");
`;
  expect(sqlCallLines("probe.ts", text, true)).toEqual([4, 7, 9]);
});

it("identifies inline and named factory results and adapter factory replacements", () => {
  const text = `
    import { db } from "../src/server/db.js";
    function open() { return { connection: db }; }
    open().connection.exec(migrationText);
    function openNamed() {
      const store = { connection: db };
      return store;
    }
    openNamed().connection.exec(migrationText);
    const { connection } = openNamed();
    connection.exec(migrationText);
    let handle = db;
    handle.exec(migrationText);
    handle = makeAdapter();
    handle.exec(command);
    function makeAdapter() { return { exec: runCommand }; }
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 9, 11, 13]);
});

it("follows forwarded factory results and named arrays passed through apply", () => {
  const text = `
    import { db } from "../src/server/db.js";
    function open() { return { connection: db }; }
    function relay() { return open(); }
    relay().connection.exec(migrationText);
    function execute(handle, migrationText) { handle.exec(migrationText); }
    const args = [db, migrationText];
    execute.apply(null, args);
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([5, 6]);
});

it("resolves inline fields and guarded SQLite aliases and respects enclosing block writes", () => {
  const text = `
    import SQLite from "better-sqlite3";
    import { db } from "../src/server/db.js";
    let handle = new SQLite(":memory:");
    { handle.exec(migrationText); }
    handle = { exec: runCommand };
    { handle.exec(command); }
    ({ connection: new SQLite(":memory:") }).connection.exec("BEGIN");
    const connection = enabled && db;
    if (connection) connection.exec(migrationText);
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([5, 8, 10]);
});

it("follows wrapped design fixtures and stops classifying handles replaced by regexes", () => {
  const text = `
    import { db } from "../src/server/db.js";
    import { designFixture } from "./helpers/design-fixture.mjs";
    const makeFixture = () => designFixture();
    const fixture = await makeFixture();
    fixture.db.exec(migrationText);
    let handle = db;
    handle.exec(migrationText);
    handle = new RegExp("^SELECT");
    handle.exec("SELECT 1");
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([6, 8]);
});

it("retains receiver and nested method evidence and respects opaque import replacements", () => {
  const text = `
    import { db } from "../src/server/db.js";
    import commandAdapter from "./commands.mjs";
    const receiver = { connection: db };
    function migrate() { this.connection.exec("BEGIN"); }
    migrate.call(receiver);
    const empty = { store: {} };
    const populated = { store: { connection: db } };
    const { store } = flag ? empty : populated;
    store.connection.exec("BEGIN");
    const { connection: { exec } } = receiver;
    exec.call(db, migrationText);
    let handle = db;
    handle.exec(migrationText);
    handle = commandAdapter;
    handle.exec(command);
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([5, 10, 12, 14]);
});

it("honors method reassignment and follows conditional fixture returns", () => {
  const text = `
    import { db } from "../src/server/db.js";
    function openFixture() { return flag ? { db: undefined } : { db }; }
    openFixture().db.exec(migrationText);
    let execute = db.exec.bind(db);
    execute(migrationText);
    execute = runCommand;
    { execute(command); }
    execute = db.exec.bind(db);
    execute(migrationText);
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 6, 10]);
});

it("follows parameter rest fields and migration text and honors object field replacements", () => {
  const text = `
    import { db } from "../src/server/db.js";
    function migrate({ ...store }, text) { store.connection.exec(text); }
    migrate({ connection: db }, migrationText);
    export function inject(fixture, migrationText) { fixture.db.exec(migrationText); }
    const store = { connection: db };
    store.connection.exec(migrationText);
    store.connection = { exec: runCommand };
    store.connection.exec(command);
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([3, 5, 7]);
});

it("follows object-method receivers and computed constants and honors object replacement", () => {
  const text = `
    import { db } from "../src/server/db.js";
    const repository = { connection: db, migrate() { this.connection.exec("BEGIN"); } };
    repository.migrate();
    const method = "ex" + "ec";
    db[method](migrationText);
    let store = { connection: db };
    store.connection.exec(migrationText);
    store = { connection: /^SELECT/ };
    store.connection.exec("SELECT 1");
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([3, 6, 8]);
});

it("follows conditional replacement and destructuring without retaining overwritten methods", () => {
  const text = `
    import { db } from "../src/server/db.js";
    const adapter = { exec: runCommand };
    let store = { connection: db };
    store = { connection: adapter };
    if (flag) store = { connection: db };
    store.connection.exec("BEGIN");
    let handle = adapter;
    if (flag) ({ connection: handle } = { connection: db });
    handle.exec(migrationText);
    const ops = { run: db.exec.bind(db) };
    ops.run(migrationText);
    ops.run = runCommand;
    ops.run(command);
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([7, 10, 12]);
});

it("uses defaults for explicit undefined and clears method aliases when the object is replaced", () => {
  const text = `
    import { db } from "../src/server/db.js";
    const { connection = db } = { connection: undefined };
    connection.exec("BEGIN");
    function migrate({ handle = db }) { handle.exec("BEGIN"); }
    migrate({ handle: undefined });
    let ops = { run: db.exec.bind(db) };
    ops.run(migrationText);
    ops = { run: runCommand };
    ops.run(command);
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 5, 8]);
});

it("uses class fields and the latest writes when destructuring a receiver", () => {
  const text = `
    import { db } from "../src/server/db.js";
    class Store { connection = db; }
    const store = new Store();
    const { connection } = store;
    connection.exec("BEGIN");
    const { connection: inline } = new Store();
    inline.exec(migrationText);
    const holder = { connection: db };
    const { connection: earlier } = holder;
    earlier.exec(migrationText);
    holder.connection = { exec: runCommand };
    const { connection: adapter } = holder;
    adapter.exec(command);
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([6, 8, 11]);
});

it("follows iterated SQLite handles and ignores a method replaced by destructuring", () => {
  const text = `
    import { db } from "../src/server/db.js";
    for (const connection of [db]) connection.exec("BEGIN");
    const stores = [{ connection: db }];
    for (const { connection } of stores) connection.exec(migrationText);
    let execute = db.exec.bind(db);
    execute(migrationText);
    ({ execute } = { execute: runCommand });
    execute(command);
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([3, 5, 7]);
});

it("tracks conditional literal fields, destructured methods and stored method keys", () => {
  const text = `
    import { db } from "../src/server/db.js";
    const store = flag ? { connection: scratch } : { connection: db };
    store.connection.exec("BEGIN");
    let execute;
    ({ exec: execute } = db);
    execute.call(db, "BEGIN");
    const methods = { write: "exec" };
    db[methods.write]("BEGIN");
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 7, 9]);
});

it("follows reassigned wrappers and stable captured handle replacements", () => {
  const text = `
    import { db } from "../src/server/db.js";
    let run = () => {};
    run = (connection, sql) => connection.exec(sql);
    run(db, query);
    let handle = db;
    handle.exec(query);
    handle = { exec: runCommand };
    const callback = () => handle.exec(command);
    callback();
    let other = db;
    other = { exec: runCommand };
    const maybeDatabase = () => other.exec(query);
    if (flag) other = db;
    maybeDatabase();
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 7, 13]);
});

it("passes known array elements to callbacks", () => {
  const text = `
    import { db } from "../src/server/db.js";
    [db].forEach((connection) => connection.exec("BEGIN"));
    const handles = [{ connection: db }];
    function migrate({ connection }) { connection.exec(migrationText); }
    handles.map(migrate);
    [{ exec: runCommand }].forEach((commandAdapter) => commandAdapter.exec(command));
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([3, 5]);
});

it("recognizes dynamic fixture imports, fixed array at calls and conditional replacement fields", () => {
  const text = `
    import { db } from "../src/server/db.js";
    const { designFixture: open } = await import("./helpers/design-fixture.mjs");
    const { db: connection } = await open();
    connection.exec(text);
    const handles = [db];
    handles.at(0).exec("BEGIN");
    handles.at(-1).exec("BEGIN");
    let store = {};
    store = { connection: { exec: runCommand } };
    if (flag) store.connection = db;
    store.connection.exec("BEGIN");
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([5, 7, 8, 12]);
});

it("tracks array rest elements and SQLite methods invoked through Reflect.apply", () => {
  const text = `
    import { db } from "../src/server/db.js";
    const handles = [adapter, db];
    const [, ...copy] = handles;
    copy[0].exec("BEGIN");
    Reflect.apply(db.exec, db, [migrationText]);
    function dispatch(Reflect) { Reflect.apply(db.exec, db, [migrationText]); }
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([5, 6]);
});

it("honors completed block writes and propagates assigned for-of handles", () => {
  const text = `
    import { db } from "../src/server/db.js";
    let handle = db;
    { handle = { exec: runCommand }; }
    handle.exec(command);
    let selected;
    for (selected of [db]) selected.exec("BEGIN");
    let maybe = db;
    if (flag) { maybe = { exec: runCommand }; }
    maybe.exec(migrationText);
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([7, 10]);
});

it("terminates recursive array analysis and handles named defaults and numeric fields", () => {
  const text = `
    import { db } from "../src/server/db.js";
    const choices = [db ?? choices.at(0)];
    choices.at(0).exec("BEGIN");
    const options = { connection: undefined };
    const { connection = db } = options;
    connection.exec("BEGIN");
    const handles = { 0: db };
    handles[0].exec(migrationText);
    class Commands { exec() {} }
    let handle = db;
    handle.exec(migrationText);
    handle = new Commands();
    handle.exec(command);
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([4, 7, 9, 12]);
});

it("resolves mutable keys and factory calls while honoring method initializers", () => {
  const text = `
    import { db } from "../src/server/db.js";
    import { openDatabase } from "./external.mjs";
    let execute = runCommand;
    execute(command);
    execute = db.exec.bind(db);
    execute(migrationText);
    let method = "exec";
    db[method]("BEGIN");
    method = "close";
    db[method]();
    openDatabase().exec("SELECT 1");
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([7, 9, 12]);
});

it("tracks writes made by local initializers and through shared object aliases", () => {
  const text = `
    import { db } from "../src/server/db.js";
    let handle = { exec: runCommand };
    function initialize() { handle = db; }
    handle.exec(command);
    initialize();
    handle.exec("BEGIN");
    const fixture = {};
    const alias = fixture;
    alias.connection = db;
    fixture.connection.exec("BEGIN");
`;
  expect(sqlCallLines("probe.mjs", text, true)).toEqual([7, 11]);
});

it("names the line and the SQL recipe for a direct call", () => {
  const text = 'import { db } from "./db.js";\n\ndb.prepare("SELECT 1");\n';
  expect(sqlCallLines("probe.ts", text)).toEqual([3]);
  expect(directSql("src/server/probe.ts:3")).toBe(
    "src/server/probe.ts:3 calls SQLite directly. Put the query in the module under src/server/sql/ that owns its table and call that (docs/architecture.md#recipe-add-or-extend-a-sql-table-module). If this can't be satisfied, say so in the PR; do not add the file to the allowance.",
  );
});

it("keeps direct SQL in the shrinking named file allowance", () => {
  const actual = new Map<string, string>();
  const serverFiles = files(join(root, "src/server"));
  const hostFiles = readdirSync(join(root, "src"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(root, "src", name));
  for (const file of [...serverFiles, ...hostFiles].sort()) {
    const path = relative(join(root, "src/server"), file);
    if (path.startsWith("sql/") || exemptions.has(path)) continue;
    const lines = sqlCallLines(file, readFileSync(file, "utf8"));
    if (lines.length) actual.set(path, `${relative(root, file)}:${lines[0]}`);
  }
  const allowed = new Set(allowance);
  expect(allowed.size, "Duplicate allowance entries").toBe(allowance.length);
  expect(
    [...actual]
      .filter(([path]) => !allowed.has(path))
      .map(([, location]) => directSql(location)),
    "New or fully migrated files must put SQL in src/server/sql/",
  ).toEqual([]);
  expect(
    allowance
      .filter((path) => !actual.has(path))
      .map(
        (path) =>
          `src/server/${path} has no direct SQL left; remove it from the allowance in test/sql-inventory.test.ts.`,
      ),
    "Remove files from the allowance when their last direct call moves",
  ).toEqual([]);
});

it("keeps direct script SQL in the shrinking named file allowance", () => {
  const directory = join(root, "scripts");
  const actual = new Map<string, string>();
  for (const file of files(directory, (path) =>
    /\.(?:[cm]?[jt]s|[jt]sx)$/.test(path),
  ).sort()) {
    const [line] = sqlCallLines(file, readFileSync(file, "utf8"), true);
    if (line !== undefined)
      actual.set(relative(directory, file), `${relative(root, file)}:${line}`);
  }
  const allowed = new Set(scriptAllowance);
  expect(allowed.size, "Duplicate script allowance entries").toBe(
    scriptAllowance.length,
  );
  expect(
    [...actual]
      .filter(([path]) => !allowed.has(path))
      .map(([, location]) => directSql(location)),
    "Script fixtures must use existing writers or query modules for new SQL callers",
  ).toEqual([]);
  expect(
    scriptAllowance
      .filter((path) => !actual.has(path))
      .map(
        (path) =>
          `scripts/${path} has no direct SQL left; remove it from the script allowance.`,
      ),
    "Remove script files from the allowance when their last direct call moves",
  ).toEqual([]);
});
