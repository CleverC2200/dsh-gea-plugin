import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import {
  CAPABILITY_EFFECTS,
  normalizeContract,
  type CapabilityContract,
  type CapabilityView,
  type CapabilityEffect,
} from "./contract.ts";

/** A workbench page references its Agent capability through the existing Consumer code. */
export type CapabilityPageDeclaration = CapabilityView & {
  consumerCode: string;
  maxEffect: CapabilityEffect;
};
/** Agent-owned metadata has no page implementation; it keeps the existing contract fields. */
export type CapabilityDeclaration = Omit<CapabilityContract, "view" | "source">;

/** Read separate page/capability files into the existing contract; declarations are required on the sole supported resource protocol. */
export async function readPluginContract(
  directory: string,
  declarations: unknown,
  installed: CapabilityContract,
): Promise<CapabilityContract> {
  const manifest = resolve(directory, "plugin.json");
  if (declarations === undefined) throw Error(`UNSUPPORTED_HTML_RESOURCE_PROTOCOL [source: ${manifest}]`);
  let source = manifest;
  try {
    if (
      !declarations ||
      typeof declarations !== "object" ||
      Array.isArray(declarations)
    )
      throw Error("INVALID_SPLIT_DECLARATIONS");
    const refs = declarations as Record<string, unknown>;
    if (Object.keys(refs).some((key) => key !== "page" && key !== "capability"))
      throw Error("INVALID_SPLIT_DECLARATIONS");
    const read = async (
      key: "page" | "capability",
    ): Promise<Record<string, unknown>> => {
      const ref = refs[key];
      if (typeof ref !== "string" || !ref.trim())
        throw Error(`MISSING_DECLARATION_REFERENCE: ${key}`);
      source = resolve(directory, ref);
      const path = await realpath(source);
      if (!path.startsWith((await realpath(directory)) + sep))
        throw Error("INVALID_DECLARATION_PATH");
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw Error("INVALID_SPLIT_DECLARATION");
      return value as Record<string, unknown>;
    };
    const page = await read("page");
    const capability = await read("capability");
    source = `${resolve(directory, String(refs.page))} + ${resolve(directory, String(refs.capability))}`;
    if (
      capability.view !== undefined ||
      capability.maxEffect === undefined ||
      page.maxEffect === undefined
    )
      throw Error(
        "INCOMPATIBLE_SPLIT_DECLARATION: separate view and explicit maxEffect required",
      );
    if (!CAPABILITY_EFFECTS.includes(page.maxEffect as CapabilityEffect))
      throw Error("INVALID_CAPABILITY_EFFECT");
    if (
      capability.layers !== undefined &&
      (!Array.isArray(capability.layers) ||
        capability.layers.some((layer) => !installed.layers?.includes(layer)))
    )
      throw Error(
        "INCOMPATIBLE_SPLIT_DECLARATION: unsupported capability layer",
      );
    if (
      !Array.isArray(page.pageIds) ||
      page.pageIds.length > 50 ||
      page.pageIds.some((id) => typeof id !== "string" || !id)
    )
      throw Error("INVALID_PAGE_REFERENCE");
    if (
      capability.skills !== undefined &&
      (!Array.isArray(capability.skills) ||
        capability.skills.some((id) => !installed.skills.includes(id)))
    )
      throw Error("MISSING_SKILL_REFERENCE");
    const joined = normalizeContract({
      ...capability,
      view: {
        surface: page.surface,
        protocol: page.protocol,
        pageIds: page.pageIds,
      },
    });
    const ids = joined.view!.pageIds;
    if (new Set(ids).size !== ids.length) throw Error("DUPLICATE_PAGE_ID");
    const installedView = installed.view!;
    if (
      ids.length !== installedView.pageIds.length ||
      ids.some((id) => !installedView.pageIds.includes(id))
    )
      throw Error("MISSING_PAGE_REFERENCE");
    if (
      joined.id !== installed.id ||
      page.surface !== installedView.surface ||
      page.protocol !== installedView.protocol ||
      page.consumerCode !== joined.data?.consumerCode ||
      page.consumerCode !== installed.data?.consumerCode ||
      page.maxEffect !== joined.maxEffect ||
      joined.maxEffect !== installed.maxEffect ||
      (joined.data?.mock === true) !== (installed.data?.mock === true) ||
      joined.layers?.some((layer) => !installed.layers?.includes(layer))
    )
      throw Error(
        "INCOMPATIBLE_SPLIT_DECLARATION: installed identity or permission differs",
      );
    return { ...joined, source };
  } catch (error) {
    throw Error(
      `${error instanceof Error ? error.message : String(error)} [source: ${source}]`,
      { cause: error },
    );
  }
}
