import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { X509Certificate } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAbsolute, join } from "node:path";

export const companyWindowsCertificate = fileURLToPath(
  new URL("../../desktop/build/codesign.cer", import.meta.url),
);
export const companyWindowsUpdateUrl =
  "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/electron/win-x64/";
export const certumWindowsUpdateUrl = new URL("../win-x64-certum/", companyWindowsUpdateUrl).href;
export const certumWindowsCertificate = fileURLToPath(
  new URL("../../desktop/build/codesign-certum.cer", import.meta.url),
);

export function resolveCompanyWindowsSigning(
  env = process.env,
  certificateFile = env.GEA_WINDOWS_STORE_CER_FILE ?? companyWindowsCertificate,
) {
  const store = env.GEA_WINDOWS_STORE_CER_FILE !== undefined;
  const pfx = env.GEA_WINDOWS_PFX_FILE,
    passwordFile = env.GEA_WINDOWS_PFX_PASSWORD_FILE;
  if (!store) {
    if (!pfx || !passwordFile)
      throw Error("GEA_WINDOWS_PFX_FILE and GEA_WINDOWS_PFX_PASSWORD_FILE are required");
    for (const file of [pfx, passwordFile])
      if (!statSync(file).isFile()) throw Error("WINDOWS_SIGNING_FILE_INVALID");
  }
  const cert = new X509Certificate(readFileSync(certificateFile));
  if (
    cert.ca ||
    !cert.keyUsage?.includes("1.3.6.1.5.5.7.3.3") ||
    Date.parse(cert.validTo) <= Date.now() ||
    Date.parse(cert.validFrom) > Date.now()
  )
    throw Error("WINDOWS_PUBLIC_CERTIFICATE_INVALID");
  const identity = {
    certificateFile,
    publisher: cert.subject,
    fingerprint: cert.fingerprint256,
  };
  if (store) {
    const thumbprint = env.GEA_WINDOWS_STORE_CERT_SHA1?.toUpperCase();
    const signTool = env.GEA_WINDOWS_SIGNTOOL;
    if (!/^[0-9A-F]{40}$/.test(thumbprint ?? "") || cert.fingerprint.replaceAll(":", "") !== thumbprint)
      throw Error("WINDOWS_STORE_CERTIFICATE_MISMATCH");
    if (!signTool || !isAbsolute(signTool) || !/\.exe$/i.test(signTool) || !statSync(signTool).isFile())
      throw Error("WINDOWS_STORE_SIGNTOOL_REQUIRED");
    return { ...identity, provider: "windows-store", thumbprint, signTool };
  }
  return {
    ...identity,
    provider: "company-pfx",
    pfx,
    passwordFile,
  };
}

export function createCompanyWindowsSigner(
  options,
  {
    env = process.env,
    run = promisify(execFile),
    certificateFile = env.GEA_WINDOWS_STORE_CER_FILE ?? companyWindowsCertificate,
  } = {},
) {
  const signing = resolveCompanyWindowsSigning(env, certificateFile);
  if (
    new X509Certificate(readFileSync(options.certificateFile)).fingerprint256 !==
    signing.fingerprint
  )
    throw Error("WINDOWS_SIGNING_CERTIFICATE_MISMATCH");
  let pending = Promise.resolve();
  return (configuration) => {
    const operation = pending.then(async () => {
      if (configuration.hash !== "sha256") throw Error("WINDOWS_SIGNING_SHA256_REQUIRED");
      if (configuration.isNest) throw Error("WINDOWS_SIGNING_APPEND_UNSUPPORTED");
      if (await options.preserveSignature?.(configuration.path)) return;
      await options.repairExecutable(configuration.path);
      const settings = {
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 65536,
        env: { ...options.signingEnvironment, PSModulePath: "" },
      };
      try {
        if (signing.provider === "windows-store") {
          await run(signing.signTool, [
            "sign",
            "/s", "My",
            "/sha1", signing.thumbprint,
            "/fd", "SHA256",
            "/tr", "http://time.certum.pl",
            "/td", "SHA256",
            configuration.path,
          ], settings);
          await run(signing.signTool, ["verify", "/pa", "/tw", configuration.path], settings);
          return;
        }
        await run(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            fileURLToPath(new URL("../../desktop/build/sign-windows.ps1", import.meta.url)),
            "-TargetPath",
            configuration.path,
            "-PfxFile",
            signing.pfx,
            "-PasswordFile",
            signing.passwordFile,
            "-CertificatePath",
            signing.certificateFile,
          ],
          settings,
        );
      } catch (error) {
        const stage =
          String(error.stdout ?? "")
            .split(/\r?\n/)
            .filter((line) => line.startsWith("[GEA-CERT] "))
            .at(-1) ?? "bootstrap";
        const reason = String(error.stderr ?? "").match(/WINDOWS_[A-Z_]+/)?.[0] ?? "child-process";
        throw Error(`WINDOWS_SIGNING_OR_TIMESTAMP_FAILED (${stage}; ${reason})`);
      }
    });
    pending = operation;
    return operation;
  };
}

export function resolveCompanyWindowsUpdate(env) {
  const bridge = env.GEA_WINDOWS_CERTUM_BRIDGE === "1";
  if (bridge && env.GEA_WINDOWS_STORE_CER_FILE) throw Error("WINDOWS_BRIDGE_REQUIRES_LEGACY_SIGNER");
  return {
    publicUrl:
      bridge || env.GEA_WINDOWS_STORE_CER_FILE ? certumWindowsUpdateUrl : companyWindowsUpdateUrl,
    publisherCertificate: bridge ? certumWindowsCertificate : env.DSH_DESKTOP_WINDOWS_CER_FILE,
  };
}

export function adaptSignedWindowsFactory(source, desktop) {
  const replacements = [
    [
      "createWindowsTokenSigner({",
      "createCompanyWindowsSigner({ repairExecutable: repairDanglingAuthenticodeDirectory, signingEnvironment: scrubWindowsSigningEnvironment(env),",
    ],
    [
      "resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)",
      "resolveCompanyWindowsUpdate(env)",
    ],
    [
      "resolveWindowsUpdatePublisher(env.DSH_DESKTOP_WINDOWS_CER_FILE)",
      "resolveWindowsUpdatePublisher(update.publisherCertificate)",
    ],
    [
      "{ provider: 'generic', url: update.publicUrl, channel: 'nightly' }",
      "{ provider: 'generic', url: update.publicUrl, channel: 'nightly', useMultipleRangeRequest: false }",
    ],
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw Error("SIGNED_COMPANY_CONFIG_ADAPTER_DRIFT");
    source = source.replace(before, after);
  }
  return `import {createCompanyWindowsSigner,resolveCompanyWindowsUpdate} from ${JSON.stringify(import.meta.url)};\nimport {repairDanglingAuthenticodeDirectory} from ${JSON.stringify(pathToFileURL(join(desktop, "scripts/windows-sign.mjs")).href)};\n${source}`;
}

export function companyCertificateInstaller(source, desktop) {
  source = source.replaceAll("${__FILEDIR__}", join(desktop, "scripts"));
  const anchor = "!macro customInstallerExtract Archive\n";
  if (source.split(anchor).length !== 2) throw Error("SIGNED_COMPANY_INSTALLER_ADAPTER_DRIFT");
  const include = fileURLToPath(
    new URL("../../desktop/build/installer-certificate.nsh", import.meta.url),
  );
  return `!include "${include}"\n${source.replace(anchor, anchor + "  !insertmacro GEA_INSTALL_CERTIFICATE\n")}`;
}
