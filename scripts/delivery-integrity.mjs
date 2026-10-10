/** Internal read-only integrity observations behind checkDelivery. Unsupported Git layouts stay unknown. */
import { readdir, lstat } from "node:fs/promises";
import { resolve, relative, join, posix } from "node:path";
import { createHash } from "node:crypto";
import { createReadScope } from "./delivery-input-scope.mjs";
import { inflateSync } from "node:zlib";
import {
  readSourceCombination,
  componentArtifactEntries,
} from "./source-combination-integrity.mjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const oid = (bytes) => createHash("sha1").update(bytes).digest("hex");
const sha = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const commitId = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const fail = (code) => {
  throw Error(code);
};
async function gitState(scope, source, objectRoot) {
  let git = join(source, ".git");
  const marker = await lstat(git);
  if (marker.isFile()) {
    const match = (await scope.read(git)).toString().match(/^gitdir: (.+)\n?$/);
    if (!match) fail("GIT_LAYOUT_UNSUPPORTED");
    git = await scope.resolve(resolve(source, match[1]));
  } else git = await scope.resolve(git);
  const commonMarker = await scope.optional(join(git, "commondir"));
  const common = commonMarker
    ? await scope.resolve(resolve(git, commonMarker.toString().trim()))
    : git;
  const config = (await scope.optional(join(common, "config")))?.toString() ?? "";
  if (/excludesfile|sparsecheckout\s*=\s*true|objectformat\s*=\s*(?!sha1)/i.test(config))
    fail("GIT_CONFIG_UNSUPPORTED");
  const headBytes = await scope.read(join(git, "HEAD"));
  let head = headBytes.toString().trim();
  if (head.startsWith("ref: ")) {
    const ref = head.slice(5);
    if (!/^refs\/[a-zA-Z0-9._/-]+$/.test(ref) || ref.includes("..")) fail("GIT_HEAD_UNSUPPORTED");
    const loose = await scope.optional(join(common, ref));
    if (loose) head = loose.toString().trim();
    else {
      const packed = (await scope.optional(join(common, "packed-refs")))?.toString() ?? "";
      head = packed
        .split("\n")
        .find((line) => line.endsWith(" " + ref))
        ?.split(" ")[0];
    }
  }
  if (!commitId(head)) fail("GIT_HEAD_UNSUPPORTED");
  const index = await scope.read(join(git, "index"));
  if (
    index.toString("ascii", 0, 4) !== "DIRC" ||
    ![2, 3].includes(index.readUInt32BE(4)) ||
    oid(index.subarray(0, -20)) !== index.subarray(-20).toString("hex")
  )
    fail("GIT_INDEX_UNSUPPORTED");
  const entries = [],
    count = index.readUInt32BE(8);
  if (count > 20000) fail("GIT_INDEX_UNSUPPORTED");
  let offset = 12;
  for (let n = 0; n < count; n++) {
    if (offset + 62 >= index.length - 20) fail("GIT_INDEX_UNSUPPORTED");
    const start = offset,
      flags = index.readUInt16BE(offset + 60),
      mode = index.readUInt32BE(offset + 24).toString(8),
      objectId = index.subarray(offset + 40, offset + 60).toString("hex");
    if (flags & 0xf000) fail("GIT_INDEX_UNSUPPORTED"); // stages, assume-valid and extended entries require their own semantics.
    const end = index.indexOf(0, offset + 62);
    if (end < 0 || end >= index.length - 20) fail("GIT_INDEX_UNSUPPORTED");
    const path = index.toString("utf8", offset + 62, end);
    if (
      !path ||
      path.includes("..") ||
      path.startsWith("/") ||
      !["100644", "100755"].includes(mode)
    )
      fail("GIT_INDEX_UNSUPPORTED");
    entries.push({ path, objectId, mode });
    offset = start + Math.ceil((end - start + 1) / 8) * 8;
  }
  async function object(id, type) {
    let compressed;
    try {
      compressed = await scope.read(join(common, "objects", id.slice(0, 2), id.slice(2)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!objectRoot) fail("GIT_PACKED_OBJECT_UNSUPPORTED");
      const exported = await scope.resolve(join(objectRoot, id.slice(0, 2), id.slice(2)));
      compressed = await scope.read(exported);
    }
    const bytes = inflateSync(compressed, {
      maxOutputLength: 16 * 1024 * 1024,
    });
    if (oid(bytes) !== id) fail("GIT_OBJECT_MISMATCH");
    const end = bytes.indexOf(0),
      header = bytes.toString("ascii", 0, end);
    if (
      !header.startsWith(type + " ") ||
      Number(header.slice(type.length + 1)) !== bytes.length - end - 1
    )
      fail("GIT_OBJECT_MISMATCH");
    return bytes.subarray(end + 1);
  }
  const commit = await object(head, "commit");
  const tree = commit.toString().match(/^tree ([a-f0-9]{40})\n/)?.[1];
  if (!tree) fail("GIT_OBJECT_MISMATCH");
  const committed = [];
  async function walkTree(id, prefix = "") {
    const bytes = await object(id, "tree");
    let pos = 0;
    while (pos < bytes.length) {
      const space = bytes.indexOf(32, pos),
        zero = bytes.indexOf(0, space);
      if (space < pos || zero < space || zero + 21 > bytes.length) fail("GIT_OBJECT_MISMATCH");
      const mode = bytes.toString("ascii", pos, space),
        name = bytes.toString("utf8", space + 1, zero),
        objectId = bytes.subarray(zero + 1, zero + 21).toString("hex"),
        path = prefix + name;
      if (!name || name.includes("/") || name === "..") fail("GIT_OBJECT_MISMATCH");
      if (mode === "40000") await walkTree(objectId, path + "/");
      else if (["100644", "100755"].includes(mode)) committed.push({ path, objectId, mode });
      else fail("GIT_TREE_UNSUPPORTED");
      pos = zero + 21;
    }
  }
  await walkTree(tree);
  return {
    head,
    headSha256: hash(headBytes),
    indexSha256: hash(index),
    git,
    common,
    entries,
    committed,
  };
}
/** Verify full supported checkout, including new/deleted/staged files. No Git subprocess. */
export async function observeCandidate(root, candidate, { readScope } = {}) {
  const scope = readScope ?? (await createReadScope(root));
  if (!candidate?.checkout) return null;
  try {
    const source = await scope.resolve(candidate.checkout.path, {
      traverse: true,
    });
    const state = await gitState(
      scope,
      source,
      candidate.checkout.objectRoot
        ? await scope.resolve(candidate.checkout.objectRoot, { traverse: true })
        : null,
    );
    const tracked = new Map(state.entries.map((entry) => [entry.path, entry]));
    const committed = new Map(state.committed.map((entry) => [entry.path, entry]));
    const actual = new Map(),
      changes = [];
    let count = 0;
    const rules = [];
    async function addRules(file, prefix = "") {
      const bytes = await scope.optional(file);
      if (!bytes) return;
      for (const line of bytes.toString().split(/\r?\n/)) {
        if (!line || line.startsWith("#")) continue;
        // Registered checkout grammar: literals and Workbench's tarball suffix.
        // Negation and other globs still require unsupported Git semantics.
        const tarball = line === "*.tgz";
        if (!tarball && /[!*?[\]\\ ]/.test(line)) fail("GIT_IGNORE_SYNTAX_UNSUPPORTED");
        rules.push({
          tarball,
          prefix,
          value: line.replace(/^\//, ""),
          anchored: line.startsWith("/") || line.replace(/\/$/, "").includes("/"),
        });
      }
    }
    await addRules(join(state.common, "info/exclude"));
    function ignored(path, directory) {
      return rules.some(({ prefix, value, anchored, tarball }) => {
        if (!path.startsWith(prefix)) return false;
        const within = path.slice(prefix.length),
          target = value.replace(/\/$/, "");
        if (tarball) return within.split("/").some((part) => part.endsWith(".tgz"));
        if (value.endsWith("/") && !directory) return false;
        return anchored ? within === target : within.split("/").includes(target);
      });
    }
    async function scan(directory, prefix = "") {
      directory = await scope.resolve(directory, { traverse: true });
      await addRules(join(directory, ".gitignore"), prefix);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = prefix + entry.name;
        if (entry.name === ".git") continue;
        await scope.resolve(join(directory, entry.name));
        if (
          !tracked.has(path) &&
          ![...tracked.keys()].some((p) => p.startsWith(path + "/")) &&
          ignored(path, entry.isDirectory())
        )
          continue;
        if (++count > 20000) fail("INTEGRITY_INPUT_UNSUPPORTED");
        if (entry.isDirectory()) await scan(join(directory, entry.name), path + "/");
        else if (entry.isFile()) {
          const bytes = await scope.read(join(directory, entry.name));
          const mode =
            (await lstat(join(directory, entry.name))).mode & 0o111 ? "100755" : "100644";
          actual.set(path, {
            path,
            sha256: hash(bytes),
            objectId: oid(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])),
            mode,
          });
        } else fail("INTEGRITY_SOURCE_SCOPE_UNSUPPORTED");
      }
    }
    await scan(source);
    for (const path of new Set([...actual.keys(), ...committed.keys(), ...tracked.keys()])) {
      const file = actual.get(path),
        baseline = committed.get(path),
        indexed = tracked.get(path);
      if (
        !file ||
        !baseline ||
        file.objectId !== baseline.objectId ||
        file.mode !== baseline.mode ||
        !indexed ||
        indexed.objectId !== baseline.objectId ||
        indexed.mode !== baseline.mode
      ) {
        changes.push({
          path: relative(root, join(source, path)),
          deleted: !file,
          sha256: file?.sha256 ?? null,
          mode: file?.mode ?? null,
        });
      }
    }
    changes.sort((a, b) => a.path.localeCompare(b.path));
    const files = [...actual.values()].sort((a, b) => a.path.localeCompare(b.path));
    const contentSha256 = hash(
      JSON.stringify({
        head: state.head,
        index: state.entries,
        files,
        changes,
      }),
    );
    let matches =
      state.head === candidate.commit &&
      (candidate.kind === "clean" ? changes.length === 0 : changes.length > 0);
    if (candidate.kind === "dirty") {
      const declared = candidate.files ?? [];
      matches &&=
        declared.length === changes.length &&
        new Set(declared.map((ref) => resolve(root, ref.path))).size === declared.length &&
        changes.every((change) =>
          declared.some(
            (ref) =>
              relative(root, resolve(root, ref.path)) === change.path &&
              (change.deleted
                ? ref.deleted === true && ref.sha256 === undefined
                : ref.deleted !== true &&
                  ref.sha256 === change.sha256 &&
                  (ref.mode === change.mode ||
                    (ref.mode === undefined &&
                      committed.get(relative(source, resolve(root, ref.path)))?.mode ===
                        change.mode) ||
                    (ref.mode === undefined &&
                      !committed.has(relative(source, resolve(root, ref.path)))))),
          ),
        );
    }
    return {
      status: matches ? "passed" : "failed",
      reason:
        state.head !== candidate.commit
          ? "CANDIDATE_HEAD_MISMATCH"
          : matches
            ? "CANDIDATE_COMPLETE_IDENTIFIED"
            : "CANDIDATE_INVENTORY_MISMATCH",
      proof: "complete-checkout",
      contentSha256,
      head: state.head,
      headSha256: state.headSha256,
      indexSha256: state.indexSha256,
      trackedFiles: tracked.size,
      changedFiles: changes.length,
      files: changes.slice(0, 100).map(({ path, ...safe }, index) => ({
        sourceId:
          candidate.files?.find(
            (ref) =>
              typeof ref.path === "string" &&
              typeof ref.id === "string" &&
              /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(ref.id) &&
              relative(root, resolve(root, ref.path)) === path,
          )?.id ?? `candidate-change-${index + 1}`,
        pathSha256: hash(path),
        ...safe,
      })),
    };
  } catch (error) {
    const allowed = new Set([
      "INTEGRITY_MULTILINK_UNVERIFIABLE",
      "INTEGRITY_PERSISTENT_OVERLAP",
      "INTEGRITY_PERSISTENT_SCOPE_UNRESOLVED",
      "INTEGRITY_INPUT_UNSUPPORTED",
      "INTEGRITY_SOURCE_SCOPE_UNSUPPORTED",
      "INTEGRITY_INPUT_OUTSIDE_ROOT",
      "GIT_LAYOUT_UNSUPPORTED",
      "GIT_CONFIG_UNSUPPORTED",
      "GIT_HEAD_UNSUPPORTED",
      "GIT_INDEX_UNSUPPORTED",
      "GIT_PACKED_OBJECT_UNSUPPORTED",
      "GIT_OBJECT_MISMATCH",
      "GIT_TREE_UNSUPPORTED",
      "GIT_IGNORE_SYNTAX_UNSUPPORTED",
    ]);
    return {
      status: "unknown",
      reason: allowed.has(error.message)
        ? error.message
        : error.code === "ENOENT"
          ? "CANDIDATE_CHECKOUT_MISSING"
          : "CANDIDATE_CHECKOUT_UNREADABLE",
      proof: "not-verified",
      contentSha256: null,
    };
  }
}

/** Assembly linkage is recorded; bytes, selection and canonical combination validity are freshly observed. */
export async function observeAssembly(root, record, context) {
  const scope = context.readScope ?? (await createReadScope(root));
  const evidence = [],
    inputs = [];
  let activeInputId = null;
  const result = (status, reason, minimumGap = reason) => ({
    status,
    reason,
    minimumGap: status === "passed" ? null : minimumGap,
    proof: status === "passed" ? "official-combination-and-inputs" : "not-verified",
    evidence,
    inputs,
  });
  async function observe(ref, limit = 16 * 1024 * 1024) {
    if (!ref || typeof ref.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(ref.id))
      fail("ASSEMBLY_INPUT_REFERENCE_INVALID");
    activeInputId = ref.id;
    const file = await scope.resolve(ref.path),
      bytes = await scope.read(file, limit),
      actual = hash(bytes);
    const entry = {
      id: ref.id,
      sha256: actual,
      observedAt: context.observedAt,
    };
    inputs.push(entry);
    evidence.push({
      sourceId: ref.id,
      sha256: actual,
      observedAt: context.observedAt,
    });
    return { bytes, sha256: actual };
  }
  try {
    if (!record || record.taskId !== context.taskId || record.projectId !== context.projectId)
      return result("unknown", "ASSEMBLY_RECORD_REQUIRED");
    if (!context.candidate?.checkout || context.integrity?.status !== "passed")
      return result("unknown", "COMPLETE_CANDIDATE_REQUIRED", "VERIFY_COMPLETE_CANDIDATE");
    if (
      record.candidateSha256 !== context.candidateSha256 ||
      record.candidateContentSha256 !== context.integrity.contentSha256
    )
      return result("blocked", "ASSEMBLY_PENDING", "ASSEMBLE_CURRENT_CANDIDATE_AND_ARTIFACTS");
    if (
      typeof record.runtime !== "string" ||
      !/^[a-f0-9-]{36}$/.test(record.combinationId) ||
      !sha(record.manifestSha256) ||
      !sha(record.selectionSha256)
    )
      return result("unknown", "ASSEMBLY_BINDING_REQUIRED");
    const runtime = await scope.resolve(record.runtime),
      directory = join(runtime, "source-combinations", record.combinationId);
    const manifestInput = await observe({
      id: "assembly-manifest",
      path: join(directory, "combination.json"),
    });
    if (manifestInput.sha256 !== record.manifestSha256)
      return result("failed", "ASSEMBLY_MANIFEST_MISMATCH", "MATCHING_FROZEN_MANIFEST_REQUIRED");
    const manifest = JSON.parse(manifestInput.bytes);
    const selectionInput = await observe({
      id: "assembly-selection",
      path: join(runtime, "source-selection.json"),
    });
    const selection = JSON.parse(selectionInput.bytes);
    if (
      selectionInput.sha256 !== record.selectionSha256 ||
      selection.id !== record.combinationId ||
      selection.manifestSha256 !== manifestInput.sha256
    )
      return result("failed", "ASSEMBLY_SELECTION_MISMATCH", "MATCHING_CURRENT_SELECTION_REQUIRED");
    if (!record.core || !commitId(record.core.commit))
      return result("unknown", "ASSEMBLY_CORE_REFERENCE_REQUIRED");
    const core = await observeCandidate(
      root,
      {
        kind: "clean",
        commit: record.core.commit,
        checkout: record.core,
      },
      { readScope: scope },
    );
    if (core.status !== "passed")
      return result(core.status, "ASSEMBLY_CORE_" + core.reason, "VERIFY_ACTUAL_CLEAN_CORE");
    if (manifest.core !== core.head)
      return result("failed", "SOURCE_COMBINATION_CORE_MISMATCH", "ASSEMBLE_MATCHING_CORE");
    evidence.push({
      sourceId: "assembly-core",
      sha256: core.contentSha256,
      observedAt: context.observedAt,
    });
    if (
      !Array.isArray(record.buildInputs) ||
      !record.buildInputs.length ||
      !Array.isArray(record.artifacts) ||
      !record.artifacts.length
    )
      return result("unknown", "ASSEMBLY_BUILD_AND_ARTIFACT_INPUTS_REQUIRED");
    const ids = [...record.buildInputs, ...record.artifacts].map((ref) => ref?.id);
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) =>
        ["assembly-manifest", "assembly-selection", "assembly-core", "assembly-plugins"].includes(
          id,
        ),
      )
    )
      return result("unknown", "ASSEMBLY_INPUT_ID_CONFLICT");
    for (const ref of record.buildInputs) {
      const actual = await observe(ref);
      if (!sha(ref.sha256) || actual.sha256 !== ref.sha256)
        return result("failed", "ASSEMBLY_BUILD_INPUT_MISMATCH", "REBUILD_CHANGED_INPUTS");
    }
    // Guard the complete dependency traversal before entering the official validator. Do not reimplement its digest rules.
    const visited = new Set();
    let count = 0;
    async function guardTree(path) {
      const physical = await scope.resolve(path, { traverse: true });
      if (visited.has(physical)) return;
      visited.add(physical);
      if (++count > 100000) fail("INTEGRITY_INPUT_UNSUPPORTED");
      const info = await lstat(physical);
      if (info.isDirectory())
        for (const entry of await readdir(physical)) await guardTree(join(physical, entry));
      else if (!info.isFile()) fail("INTEGRITY_INPUT_UNSUPPORTED");
    }
    if (!Array.isArray(manifest.externalRoots) || !Array.isArray(manifest.externalLockFiles))
      return result("unknown", "ASSEMBLY_DEPENDENCY_REFERENCES_REQUIRED");
    await guardTree(directory);
    for (const external of [...manifest.externalRoots, ...manifest.externalLockFiles])
      await guardTree(external);
    // Deliberately omit core argument: the canonical validator otherwise spawns Git.
    activeInputId = "assembly-combination";
    await readSourceCombination(runtime, record.combinationId, undefined, {
      readScope: scope,
    });
    const pluginsInput = await observe({
      id: "assembly-plugins",
      path: join(directory, "company-plugins.json"),
    });
    const plugins = JSON.parse(pluginsInput.bytes),
      plugin = plugins[record.component];
    if (
      !plugin ||
      plugin.commit !== context.candidate.commit ||
      (context.candidate.kind === "clean"
        ? plugin.dirty !== ""
        : typeof plugin.dirty !== "string" || !plugin.dirty)
    )
      return result("blocked", "ASSEMBLY_PENDING", "ASSEMBLE_CURRENT_CANDIDATE_AND_ARTIFACTS");
    if (
      (await scope.resolve(plugin.source)) !==
      (await scope.resolve(context.candidate.checkout.path))
    )
      return result(
        "failed",
        "ASSEMBLY_COMPONENT_SOURCE_MISMATCH",
        "MATCHING_COMPONENT_SOURCE_REQUIRED",
      );
    if (!plugin.digests || typeof plugin.digests !== "object" || Array.isArray(plugin.digests))
      return result("unknown", "ASSEMBLY_COMPONENT_ARTIFACTS_REQUIRED");
    const moduleNames = Object.keys(manifest.composition.dependencies);
    const otherNames = moduleNames.filter((name) => name !== record.component);
    const modules = record.modules ?? [];
    if (
      !Array.isArray(modules) ||
      modules.length !== otherNames.length ||
      new Set(modules.map((module) => module?.name)).size !== modules.length ||
      otherNames.some((name) => !modules.some((module) => module?.name === name))
    )
      return result(
        "unknown",
        "ASSEMBLY_MODULE_CANDIDATES_REQUIRED",
        "VERIFY_NECESSARY_MODULE_CANDIDATES",
      );
    for (const [index, module] of modules.entries()) {
      const snapshot = plugins[module.name],
        candidate = module.candidate;
      if (
        !snapshot ||
        !candidate?.checkout ||
        !["clean", "dirty"].includes(candidate.kind) ||
        !commitId(candidate.commit)
      )
        return result("unknown", "ASSEMBLY_MODULE_CANDIDATES_REQUIRED");
      const actual = await observeCandidate(root, candidate, {
        readScope: scope,
      });
      if (actual.status !== "passed")
        return result(
          actual.status,
          "ASSEMBLY_MODULE_" + actual.reason,
          "VERIFY_NECESSARY_MODULE_CANDIDATES",
        );
      if (
        actual.contentSha256 !== module.contentSha256 ||
        snapshot.commit !== candidate.commit ||
        (candidate.kind === "clean" ? snapshot.dirty !== "" : !snapshot.dirty) ||
        (await scope.resolve(snapshot.source)) !== (await scope.resolve(candidate.checkout.path))
      )
        return result("blocked", "ASSEMBLY_PENDING", "ASSEMBLE_CURRENT_CANDIDATE_AND_ARTIFACTS");
      evidence.push({
        sourceId: `assembly-module-${index + 1}`,
        sha256: actual.contentSha256,
        observedAt: context.observedAt,
      });
    }
    const expectedArtifacts = [];
    for (const name of moduleNames) {
      const digests = plugins[name]?.digests;
      if (
        !digests ||
        typeof digests !== "object" ||
        Array.isArray(digests) ||
        !Object.keys(digests).length
      )
        return result("unknown", "ASSEMBLY_COMPONENT_ARTIFACTS_REQUIRED");
      const componentManifest = JSON.parse(
        await scope.read(
          await scope.resolve(join(directory, "node_modules", name, "package.json")),
        ),
      );
      if (componentArtifactEntries(componentManifest).some((file) => !sha(digests[file])))
        return result("unknown", "ASSEMBLY_COMPONENT_ARTIFACTS_REQUIRED");
      for (const [file, sha256] of Object.entries(digests))
        expectedArtifacts.push({ component: name, file, sha256 });
    }
    if (
      record.artifacts.length !== expectedArtifacts.length ||
      new Set(record.artifacts.map((ref) => `${ref.component}/${ref.file}`)).size !==
        record.artifacts.length ||
      expectedArtifacts.some(
        (expected) =>
          !record.artifacts.some(
            (ref) => ref.component === expected.component && ref.file === expected.file,
          ),
      )
    )
      return result("unknown", "ASSEMBLY_COMPONENT_ARTIFACTS_REQUIRED");
    for (const ref of record.artifacts) {
      const expected = expectedArtifacts.find(
        (expected) => expected.component === ref.component && expected.file === ref.file,
      );
      if (
        !expected ||
        typeof ref.file !== "string" ||
        ref.file.split("/").includes("..") ||
        !sha(ref.sha256)
      )
        return result("unknown", "ASSEMBLY_ARTIFACT_REFERENCE_INVALID");
      const actual = await observe(ref, 64 * 1024 * 1024);
      if (actual.sha256 !== ref.sha256)
        return {
          ...result(
            "failed",
            "ASSEMBLY_ARTIFACT_DIGEST_MISMATCH",
            "MATCHING_DECLARED_ARTIFACT_BYTES_REQUIRED",
          ),
          inputId: ref.id,
          mismatchCount: 1,
          mismatches: [
            {
              sourceId: ref.id,
              kind: "artifact",
              actualSha256: actual.sha256,
              expectedSha256: ref.sha256,
            },
          ],
        };
      if (
        actual.sha256 !== expected.sha256 ||
        manifest.files[`node_modules/${ref.component}/${posix.normalize(ref.file)}`] !==
          actual.sha256
      )
        return result("blocked", "ASSEMBLY_PENDING", "ASSEMBLE_CURRENT_CANDIDATE_AND_ARTIFACTS");
    }
    return {
      ...result("passed", "ASSEMBLY_INPUTS_AND_SELECTION_MATCH"),
      combinationId: record.combinationId,
      manifestSha256: manifestInput.sha256,
      selectionSha256: selectionInput.sha256,
      coreCommit: core.head,
    };
  } catch (error) {
    const known = new Set([
      "SOURCE_COMBINATION_ID_MISMATCH",
      "INVALID_SOURCE_COMBINATION",
      "INVALID_SOURCE_DEPENDENCIES",
      "INVALID_SOURCE_COMPONENT",
      "SOURCE_COMPONENT_VERSION_MISMATCH",
      "SOURCE_COMBINATION_DIGEST_MISMATCH",
      "SOURCE_DEPENDENCY_DIGEST_MISMATCH",
      "ASSEMBLY_INPUT_REFERENCE_INVALID",
      "INTEGRITY_MULTILINK_UNVERIFIABLE",
      "INTEGRITY_PERSISTENT_OVERLAP",
      "INTEGRITY_PERSISTENT_SCOPE_UNRESOLVED",
      "INTEGRITY_INPUT_UNSUPPORTED",
      "INTEGRITY_INPUT_OUTSIDE_ROOT",
      "INTEGRITY_SOURCE_SCOPE_UNSUPPORTED",
    ]);
    const reason = known.has(error.message)
      ? error.message
      : error.code === "ENOENT"
        ? "ASSEMBLY_INPUT_MISSING"
        : error instanceof SyntaxError
          ? "ASSEMBLY_INPUT_INVALID_JSON"
          : "ASSEMBLY_INPUT_UNREADABLE";
    return {
      ...result(
        reason.startsWith("SOURCE_") ? "failed" : "unknown",
        reason,
        reason === "SOURCE_DEPENDENCY_DIGEST_MISMATCH"
          ? "MATCHING_EXTERNAL_DEPENDENCIES_AND_LOCKS_REQUIRED"
          : reason === "SOURCE_COMBINATION_DIGEST_MISMATCH"
            ? "REASSEMBLE_MATCHING_ARTIFACTS"
            : reason,
      ),
      inputId: activeInputId,
      mismatches: Array.isArray(error.mismatches)
        ? error.mismatches.slice(0, 100).map((entry, index) => ({
            sourceId: `assembly-${entry.kind === "lock" ? "lock" : entry.kind === "external-dependency" ? "dependency" : "resource"}-${index + 1}`,
            pathSha256: hash(entry.path),
            kind: entry.kind ?? "resource",
            actualSha256: sha(entry.actual) ? entry.actual : null,
            expectedSha256: sha(entry.expected) ? entry.expected : null,
          }))
        : [],
      mismatchCount: Array.isArray(error.mismatches) ? error.mismatches.length : 0,
    };
  }
}
