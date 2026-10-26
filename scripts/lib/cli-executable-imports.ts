// @effect-diagnostics nodeBuiltinImport:off
import * as NodeModule from "node:module";
import ts from "typescript-legacy";

/** Node single-executable imports resolve only builtins; use createRequire for file-backed external packages. */
export function findEsmImportsOfExternalPackages(source: string): ReadonlyArray<string> {
  return scanPackageSpecifiers(source, false);
}

/** Packages a bundle loads by name at runtime: its ESM imports plus Rolldown's `__require` calls for CommonJS. */
export function findRuntimePackageSpecifiers(source: string): ReadonlyArray<string> {
  return scanPackageSpecifiers(source, true);
}

function scanPackageSpecifiers(source: string, bundlerRequires: boolean): ReadonlyArray<string> {
  const specifiers = new Set<string>();
  const module = ts.createSourceFile(
    "bundle.mjs",
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const visit = (node: ts.Node): void => {
    const call = ts.isCallExpression(node) ? node : undefined;
    const dynamic = call?.expression.kind === ts.SyntaxKind.ImportKeyword;
    const bundlerRequire =
      bundlerRequires &&
      call !== undefined &&
      ts.isIdentifier(call.expression) &&
      call.expression.text === "__require";
    const specifierNode =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : dynamic || bundlerRequire
          ? call?.arguments[0]
          : undefined;
    if (specifierNode && ts.isStringLiteralLike(specifierNode)) {
      const specifier = specifierNode.text;
      // Optional Bun imports are runtime builtins; static Bun imports still fail under Node.
      const runtimeBuiltin =
        NodeModule.isBuiltin(specifier) || (dynamic && specifier.startsWith("bun:"));
      if (!runtimeBuiltin && !specifier.startsWith("./") && !specifier.startsWith("../")) {
        specifiers.add(specifier);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(module);
  return [...specifiers].sort();
}
