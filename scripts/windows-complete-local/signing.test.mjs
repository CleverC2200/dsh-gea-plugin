import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import {
  adaptSignedWindowsFactory,
  certumWindowsCertificate,
  certumWindowsUpdateUrl,
  companyCertificateInstaller,
  companyWindowsCertificate,
  companyWindowsUpdateUrl,
  createCompanyWindowsSigner,
  resolveCompanyWindowsSigning,
  resolveCompanyWindowsUpdate,
} from "./signing.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "gea-signing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pfx = join(directory, "codesign.pfx"),
    password = join(directory, "password.txt");
  await writeFile(pfx, "fixture");
  await writeFile(password, "private-test-password");
  return { directory, env: { GEA_WINDOWS_PFX_FILE: pfx, GEA_WINDOWS_PFX_PASSWORD_FILE: password } };
}

test("signing requires private material outside the client and uses the bundled public certificate", async (t) => {
  assert.throws(() => resolveCompanyWindowsSigning({}), /are required/);
  const { env } = await fixture(t);
  const value = resolveCompanyWindowsSigning(env),
    cert = new X509Certificate(await readFile(companyWindowsCertificate));
  assert.equal(value.fingerprint, cert.fingerprint256);
  assert.equal(cert.verify(cert.publicKey), true);
  assert.equal(cert.publicKey.asymmetricKeyDetails.modulusLength, 3072);
  assert.ok(cert.keyUsage.includes("1.3.6.1.5.5.7.3.3"));
});

test("the PFX signer repairs then signs sequentially without passing password contents or inherited secrets", async (t) => {
  const { env } = await fixture(t),
    calls = [];
  const sign = createCompanyWindowsSigner(
    {
      certificateFile: companyWindowsCertificate,
      repairExecutable: async (path) => calls.push("repair:" + path),
      signingEnvironment: {
        USERPROFILE: "C:/Users/build",
        APPDATA: "C:/Users/build/AppData/Roaming",
      },
    },
    {
      env: { ...env, OTHER_SECRET: "must-not-leak" },
      run: async (command, args, options) => {
        calls.push("sign:" + args[args.indexOf("-TargetPath") + 1]);
        assert.equal(command, "powershell.exe");
        assert.equal(options.env.USERPROFILE, "C:/Users/build");
        assert.ok(args.includes("-PasswordFile"));
        assert.doesNotMatch(
          JSON.stringify({ args, options }),
          /private-test-password|must-not-leak/,
        );
      },
    },
  );
  await Promise.all([
    sign({ path: "app.exe", hash: "sha256" }),
    sign({ path: "setup.exe", hash: "sha256" }),
  ]);
  assert.deepEqual(calls, ["repair:app.exe", "sign:app.exe", "repair:setup.exe", "sign:setup.exe"]);
});

test("the Windows store signer pins the leaf and verifies the SHA-256 timestamped signature", async (t) => {
  const { directory, env } = await fixture(t);
  const tool = join(directory, "signtool.exe");
  await writeFile(tool, "");
  const cert = new X509Certificate(await readFile(companyWindowsCertificate));
  const thumbprint = cert.fingerprint.replaceAll(":", "");
  const store = {
    ...env,
    GEA_WINDOWS_STORE_CER_FILE: companyWindowsCertificate,
    GEA_WINDOWS_STORE_CERT_SHA1: thumbprint,
    GEA_WINDOWS_SIGNTOOL: tool,
  };
  assert.equal(resolveCompanyWindowsSigning(store).provider, "windows-store");
  assert.throws(
    () =>
      resolveCompanyWindowsSigning({ ...store, GEA_WINDOWS_STORE_CERT_SHA1: "0".repeat(40) }),
    /WINDOWS_STORE_CERTIFICATE_MISMATCH/,
  );
  const calls = [];
  const sign = createCompanyWindowsSigner(
    {
      certificateFile: companyWindowsCertificate,
      repairExecutable: async () => calls.push(["repair"]),
    },
    {
      env: store,
      run: async (command, args) => {
        assert.equal(command, tool);
        calls.push(args);
      },
    },
  );
  await sign({ path: "setup.exe", hash: "sha256" });
  assert.deepEqual(calls, [
    ["repair"],
    [
      "sign", "/s", "My", "/sha1", thumbprint, "/fd", "SHA256", "/tr",
      "http://time.certum.pl", "/td", "SHA256", "setup.exe",
    ],
    ["verify", "/pa", "/tw", "setup.exe"],
  ]);
});

test("a mismatched public certificate and a failed timestamp stop signed packaging", async (t) => {
  const { directory, env } = await fixture(t);
  const other = join(directory, "other.cer");
  await writeFile(other, rootCertificates[0]);
  assert.throws(
    () => createCompanyWindowsSigner({ certificateFile: other }, { env }),
    /CERTIFICATE_MISMATCH/,
  );
  let calls = 0;
  const sign = createCompanyWindowsSigner(
    { certificateFile: companyWindowsCertificate, repairExecutable: async () => {} },
    {
      env,
      run: async () => {
        calls++;
        throw Error("child output may contain secrets");
      },
    },
  );
  const result = await Promise.allSettled([
    sign({ path: "app.exe", hash: "sha256" }),
    sign({ path: "setup.exe", hash: "sha256" }),
  ]);
  assert.equal(calls, 1);
  assert.ok(
    result.every(
      (value) =>
        value.status === "rejected" &&
        value.reason.message.startsWith("WINDOWS_SIGNING_OR_TIMESTAMP_FAILED"),
    ),
  );
});

test("company signing keeps the official updater and company feed", () => {
  const original =
    "const windowsSigner=createWindowsTokenSigner({certificateFile: env.DSH_DESKTOP_WINDOWS_CER_FILE});\nconst update=resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch);\nconst publish=[{ provider: 'generic', url: update.publicUrl, channel: 'nightly' }];\nconst publisher=resolveWindowsUpdatePublisher(env.DSH_DESKTOP_WINDOWS_CER_FILE);";
  const adapted = adaptSignedWindowsFactory(original, "C:/core/apps/desktop");
  assert.match(
    adapted,
    /createCompanyWindowsSigner\(\{ repairExecutable: repairDanglingAuthenticodeDirectory,/,
  );
  assert.match(adapted, /const update=resolveCompanyWindowsUpdate\(env\)/);
  assert.match(adapted, /const publisher=resolveWindowsUpdatePublisher\(update.publisherCertificate\)/);
  assert.equal(
    new URL(companyWindowsUpdateUrl).origin,
    "https://synear-gea.oss-cn-hangzhou.aliyuncs.com",
  );
  assert.throws(() => adaptSignedWindowsFactory("changed Core", "C:/core"), /ADAPTER_DRIFT/);
});

test("the old-signed bridge and new-signed build point to the same approved updater publisher", () => {
  const legacy = { DSH_DESKTOP_WINDOWS_CER_FILE: companyWindowsCertificate };
  assert.deepEqual(resolveCompanyWindowsUpdate(legacy), {
    publicUrl: companyWindowsUpdateUrl,
    publisherCertificate: companyWindowsCertificate,
  });
  const bridge = { ...legacy, GEA_WINDOWS_CERTUM_BRIDGE: "1" };
  const store = {
    DSH_DESKTOP_WINDOWS_CER_FILE: certumWindowsCertificate,
    GEA_WINDOWS_STORE_CER_FILE: certumWindowsCertificate,
  };
  const next = { publicUrl: certumWindowsUpdateUrl, publisherCertificate: certumWindowsCertificate };
  assert.deepEqual(resolveCompanyWindowsUpdate(bridge), next);
  assert.deepEqual(resolveCompanyWindowsUpdate(store), next);
  assert.throws(
    () => resolveCompanyWindowsUpdate({ ...bridge, ...store }),
    /WINDOWS_BRIDGE_REQUIRES_LEGACY_SIGNER/,
  );
});

test("the adopted company generic updater uses single ranges and retains other providers", async (t) => {
  const { directory } = await fixture(t);
  await mkdir(join(directory, "scripts"));
  await writeFile(
    join(directory, "scripts/windows-sign.mjs"),
    "export function repairDanglingAuthenticodeDirectory() {}\n",
  );
  const original = `
const env = {};
const update = resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch);
export const publish = [{ provider: 'generic', url: update.publicUrl, channel: 'nightly' }, { provider: 'github', owner: 'example', repo: 'desktop' }];
export const signer = () => createWindowsTokenSigner({});
export const publisher = () => resolveWindowsUpdatePublisher(env.DSH_DESKTOP_WINDOWS_CER_FILE);
`;
  const output = join(directory, "builder-factory.mjs");
  await writeFile(output, adaptSignedWindowsFactory(original, directory));
  const { publish } = await import(pathToFileURL(output).href);
  assert.deepEqual(publish, [
    {
      provider: "generic",
      url: companyWindowsUpdateUrl,
      channel: "nightly",
      useMultipleRangeRequest: false,
    },
    { provider: "github", owner: "example", repo: "desktop" },
  ]);
});

test("certificate import runs before extraction and preserves upstream installer behavior", () => {
  const original =
    '!define DIR "${__FILEDIR__}"\n!macro customInstallerExtract Archive\n  !insertmacro InstallerPublishStage 1\n!macroend\n';
  const adapted = companyCertificateInstaller(original, "C:/core/apps/desktop");
  assert.match(adapted, /GEA_INSTALL_CERTIFICATE\n  !insertmacro InstallerPublishStage 1/);
  assert.ok(adapted.includes("C:/core/apps/desktop/scripts"));
  assert.throws(() => companyCertificateInstaller("changed Core", "C:/core"), /ADAPTER_DRIFT/);
});
