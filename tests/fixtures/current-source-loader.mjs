/** Directed source tests resolve the declared owner package from its built sibling. */
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
const ownDecimal = import.meta.resolve("decimal.js");
const workbenchLib =
  pathToFileURL(
    realpathSync(new URL("../../../dsh-agent-workbench/lib", import.meta.url)),
  ).href + "/";
registerHooks({
  resolve(specifier, context, next) {
    // Read-only integration has no writable dependency tree. Resolve only this
    // exact owner's import to the caller's identical locked Decimal 10.6.0 ESM
    // entry; the product implementation and import conditions remain real.
    if (
      specifier === "decimal.js" &&
      context.parentURL?.startsWith(workbenchLib)
    )
      return next(ownDecimal, context);
    if (specifier === "dsh-agent-manage/business-resources")
      return next(
        new URL(
          "../../../dsh-agent-manage/lib/runtime/business-resources.js",
          import.meta.url,
        ).href,
        context,
      );
    return next(specifier, context);
  },
});
