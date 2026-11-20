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
  const receiverClass = new Map<Scope, any>();
  const boundReceivers = new Map<object, object[]>();
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
  const literalKey = (node: any) =>
    node?.type === "Identifier"
      ? declaringScope(node.name, node)?.strings?.get(node.name)
      : node?.value;
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
  const bindings = (pattern: any): { key: string; name: string }[] => {
    if (!pattern) return [];
    if (pattern.type === "AssignmentPattern") pattern = pattern.left;
    if (pattern.type === "RestElement") return bindings(pattern.argument);
    if (pattern.type === "Identifier") return [{ name: pattern.name, key: "" }];
    const within = (element: any, key: string) =>
      bindings(element).map((binding) => ({
        name: binding.name,
        key: binding.key ? `${key}.${binding.key}` : key,
      }));
    if (pattern.type === "ArrayPattern") {
      return pattern.elements.flatMap((element: any, index: number) =>
        within(element, String(index)),
      );
    }
    if (pattern.type !== "ObjectPattern") return [];
    return pattern.properties.flatMap((member: any) => {
      if (member.type !== "Property") return [];
      const key = member.computed
        ? literalKey(member.key)
        : (member.key.name ?? member.key.value);
      return typeof key === "string" ? within(member.value, key) : [];
    });
  };
  const dbModule = /(?:^|\/)db(?:\.[cm]?[jt]s)?$/;
  const loadsDatabaseModule = (source: any) => {
    const path =
      source?.type === "ImportExpression"
        ? source.source.value
        : source?.type === "CallExpression" &&
            ["tsImport", "require"].includes(source.callee.name)
          ? source.arguments[0]?.value
          : undefined;
    return typeof path === "string" && dbModule.test(path);
  };
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
  const objectKey = (member: any) =>
    member.computed
      ? literalKey(member.key)
      : (member.key.name ?? member.key.value);
  const isAggregate = (node: any) =>
    node?.type === "ObjectExpression" || node?.type === "ArrayExpression";
  const recordObject = (scope: Scope, name: string, value: any): void => {
    if (!["connection", "constructor"].includes(scope.bindings.get(name) ?? ""))
      scope.bindings.set(name, "object");
    const recordField = (key: string, child: any) => {
      const path = `${name}.${key}`;
      if (!scope.bindings.has(path)) scope.bindings.set(path, "other");
      if (functionKinds.has(child?.type))
        (scope.functions ??= new Map()).set(path, child);
      if (isAggregate(child)) recordObject(scope, path, child);
      else propertyInitializers.push({ scope, name: path, value: child });
    };
    if (value.type === "ArrayExpression") {
      for (const [index, element] of value.elements.entries()) {
        if (element?.type === "SpreadElement") break;
        recordField(String(index), unwrap(element));
      }
      return;
    }
    const later = new Set<string>();
    for (let index = value.properties.length - 1; index >= 0; index--) {
      const member = value.properties[index];
      if (member.type === "SpreadElement") {
        const source = unwrap(member.argument);
        const spread = { object: value, index, excluded: new Set(later) };
        if (source?.type === "ObjectExpression") {
          const literal: Scope = { bindings: new Map() };
          recordObject(literal, "object", source);
          const aliases = (scope.objectAliases ??= new Map());
          const sources = aliases.get(name) ?? [];
          sources.push({ scope: literal, name: "object", spread });
          aliases.set(name, sources);
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
      recordField(key, child);
    }
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
          specifier.imported?.name === "designFixture" &&
          /(?:^|\/)design-fixture(?:\.mjs)?$/.test(node.source.value)
        )
          (scope.fixtureFactories ??= new Set()).add(specifier.local.name);
        if (
          specifier.type === "ImportNamespaceSpecifier" &&
          dbModule.test(node.source.value)
        ) {
          binding = "object";
          scope.bindings.set(`${specifier.local.name}.db`, "connection");
        }
        scope.bindings.set(specifier.local.name, binding);
      }
    }
    if (node.type === "VariableDeclarator") {
      declarationScopes.set(node.id, scope);
      const value = unwrap(node.init);
      const sqliteConstructor =
        (value?.type === "MemberExpression" &&
          property(value) === "default" &&
          importsSqlite(value.object)) ||
        (value?.type === "CallExpression" &&
          value.callee.name === "require" &&
          value.arguments[0]?.value === "better-sqlite3");
      for (const { key, name } of bindings(node.id)) {
        let binding: Binding = "other";
        if (
          key === "" &&
          parents.get(node)?.kind === "const" &&
          value?.type === "Literal" &&
          typeof value.value === "string"
        )
          (scope.strings ??= new Map()).set(name, value.value);
        if (key === "" && functionKinds.has(value?.type))
          (scope.functions ??= new Map()).set(name, value);
        if (key === "" && classKinds.has(value?.type))
          (scope.classes ??= new Map()).set(name, scopeOf(value));
        if (key === "" && loadsDatabaseModule(value)) {
          binding = "object";
          scope.bindings.set(`${name}.db`, "connection");
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
      !["call", "apply", "bind"].includes(property(method)) ||
      node.arguments[0]?.type !== "ThisExpression"
    )
      continue;
    const source = unwrap(method.object);
    const fn =
      source.type === "FunctionExpression"
        ? source
        : declaringScope(source.name, source)?.functions?.get(source.name);
    if (!fn) continue;
    const receivers = boundReceivers.get(fn) ?? [];
    receivers.push(node.arguments[0]);
    boundReceivers.set(fn, receivers);
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
    const array = unwrap(node.arguments[1]);
    return {
      fn,
      items: array?.type === "ArrayExpression" ? array.elements : undefined,
    };
  };
  const connectionKind = (node: any): Binding | undefined => {
    const expression = unwrap(node);
    if (expression?.type === "Literal" && expression.regex) return "object";
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
      script &&
      expression?.type === "MemberExpression" &&
      property(expression) === "db" &&
      fixtureCall(unwrap(expression.object))
    )
      return "connection";
    if (
      expression?.type === "CallExpression" &&
      returnsDatabase.has(invocation(expression).fn)
    )
      return "connection";
    const callee =
      expression?.type === "NewExpression" && unwrap(expression.callee);
    if (
      callee &&
      (memberReference(callee, (scope, key) => scope.bindings.get(key)) ===
        "constructor" ||
        (callee.type === "MemberExpression" &&
          property(callee) === "default" &&
          importsSqlite(callee.object)))
    )
      return "connection";
    const name = receiver(expression);
    if (!name) return undefined;
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
      root === "this" ? thisScope(node) : declaringScope(root, node);
    const binding = owner
      ? receiverBinding(owner, receiverPath(node, name))
      : root === "this"
        ? undefined
        : bindingOf(name, node);
    if (name === "db" || name.endsWith(".db")) {
      if (!script || !owner) return "connection";
      if (!binding || binding === "other") return "inferred";
    }
    return binding;
  };
  function propertySource(
    source: any,
    key: string,
  ): { value?: any; binding?: Binding; origin?: ObjectAlias } {
    const object = unwrap(source);
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
      return resolve(object.elements[Number(head)]);
    }
    if (object?.type === "ObjectExpression") {
      for (let index = object.properties.length - 1; index >= 0; index--) {
        const member = object.properties[index];
        if (member.type === "Property" && objectKey(member) === head)
          return resolve(member.value);
        if (member.type === "SpreadElement") {
          const next = propertySource(member.argument, key);
          if (next.value || next.binding) return next;
        }
      }
    }
    const origin = propertyOrigin(object, key);
    return {
      origin,
      binding: origin ? receiverBinding(origin.scope, origin.name) : undefined,
    };
  }
  const methods = new Set(["prepare", "exec"]);
  if (script) methods.add("pragma");
  const sqliteMethod = (expression: any): string | undefined => {
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
  const isDatabaseType = (type: any, node: any) =>
    type?.type === "TSQualifiedName"
      ? type.right?.name === "Database" && isConstructor(type.left?.name, node)
      : isConstructor(type?.name, node);
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
      const original = receiver(value);
      const path =
        propertyAlias?.name ?? (original && receiverPath(value, original));
      const origin =
        propertyAlias?.scope ??
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
  const recordArgument = (scope: Scope, name: string, argument: any) => {
    if (!isAggregate(argument)) return;
    const destinations =
      recordedArguments.get(argument) ?? new Map<Scope, Set<string>>();
    const names = destinations.get(scope) ?? new Set<string>();
    if (names.has(name)) return;
    names.add(name);
    destinations.set(scope, names);
    recordedArguments.set(argument, destinations);
    recordObject(scope, name, argument);
    changed = true;
  };
  const trackParameter = (scope: Scope, parameter: any, argument: any) => {
    for (const { key, name } of bindings(parameter)) {
      if (key) {
        const member = propertySource(argument, key);
        trackBinding(
          scope,
          name,
          member.binding,
          member.value,
          undefined,
          member.origin,
        );
        recordArgument(scope, name, member.value);
        continue;
      }
      trackBinding(scope, name, connectionKind(argument), argument);
      recordArgument(scope, name, argument);
    }
  };
  const staticArguments = (
    items: any[],
  ): { values: any[]; complete: boolean } => {
    const values: any[] = [];
    for (const item of items) {
      if (item?.type !== "SpreadElement") {
        values.push(item);
        continue;
      }
      const source = unwrap(item.argument);
      if (source?.type !== "ArrayExpression")
        return { values, complete: false };
      const expanded = staticArguments(source.elements);
      values.push(...expanded.values);
      if (!expanded.complete) return { values, complete: false };
    }
    return { values, complete: true };
  };
  while (changed) {
    changed = false;
    for (const { scope, name, value, spread } of propertyInitializers)
      trackBinding(scope, name, connectionKind(value), value, spread);
    for (const node of nodes) {
      if (script && functionKinds.has(node.type))
        for (const parameter of node.params)
          if (parameter.type === "AssignmentPattern")
            trackParameter(scopeOf(node), parameter, unwrap(parameter.right));
      if (
        script &&
        node.type === "ReturnStatement" &&
        connectionKind(node.argument) === "connection"
      ) {
        let fn = parents.get(node);
        while (fn && !functionKinds.has(fn.type)) fn = parents.get(fn);
        if (fn && !returnsDatabase.has(fn)) {
          returnsDatabase.add(fn);
          changed = true;
        }
      }
      if (
        script &&
        node.type === "ArrowFunctionExpression" &&
        !returnsDatabase.has(node) &&
        connectionKind(node.body) === "connection"
      ) {
        returnsDatabase.add(node);
        changed = true;
      }
      if (
        script &&
        (node.type === "CallExpression" || node.type === "NewExpression")
      ) {
        const { fn, items } = invocation(node);
        const argumentsList = fn && items ? staticArguments(items) : undefined;
        for (const [index, parameter] of (fn?.params ?? []).entries()) {
          if (
            !argumentsList ||
            (!argumentsList.complete && index >= argumentsList.values.length)
          )
            break;
          const passed = unwrap(argumentsList.values[index]);
          const missing =
            !passed ||
            (passed.type === "Identifier" &&
              passed.name === "undefined" &&
              !bindingOf(passed.name, passed));
          const argument =
            missing && parameter.type === "AssignmentPattern"
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
      const assigned: {
        name: string;
        binding: Binding | undefined;
        method?: string;
        extracted?: any;
        origin?: ObjectAlias;
      }[] = [];
      if (target?.type === "ObjectPattern" || target?.type === "ArrayPattern") {
        for (const { key, name } of bindings(target)) {
          const {
            binding: property,
            value: extracted,
            origin,
          } = propertySource(value, key);
          const binding =
            property ??
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
            methods.has(key) && connectionKind(value) === "connection"
              ? key
              : (sqliteMethod(extracted) ?? stored ?? undefined);
          if (binding || method)
            assigned.push({ name, binding, method, extracted, origin });
        }
      } else if (field) {
        const key = node.computed
          ? node.key.value
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
      if (
        ["call", "apply"].includes(method) &&
        sqliteMethod(unwrap(node.callee.object))
      )
        return true;
      if (!methods.has(method)) return false;
      const binding = connectionKind(node.callee.object);
      if (binding === "connection") return true;
      const opaqueMember =
        script &&
        (!binding || binding === "other") &&
        (node.callee.object.type === "MemberExpression" ||
          node.callee.object.type === "Identifier");
      if (binding !== "inferred" && !opaqueMember) return false;
      // Inferred receivers need recognizable SQL text or a statement variable.
      const statement = node.arguments[0];
      if (
        script &&
        binding === "inferred" &&
        statement?.type === "Identifier" &&
        /^(?:sql|query|statement)(?:$|[A-Z_])/.test(statement.name)
      )
        return true;
      const text =
        statement?.type === "TemplateLiteral"
          ? statement.quasis[0]?.value.cooked
          : statement?.value;
      return (
        typeof text === "string" &&
        ((method === "pragma" && binding === "inferred") ||
          /^\s*(?:SELECT|WITH|INSERT|REPLACE|UPDATE|DELETE|CREATE|ALTER|DROP|PRAGMA|ATTACH|DETACH|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|REINDEX|ANALYZE|EXPLAIN)\b/i.test(
            text,
          ))
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
