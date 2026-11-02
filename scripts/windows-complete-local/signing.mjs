import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { X509Certificate } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

export const companyWindowsCertificate = fileURLToPath(
  new URL("../../desktop/build/codesign.cer", import.meta.url),
);
export const companyWindowsUpdateUrl =
  "https://synear-gea.oss-cn-hangzhou.aliyuncs.com/client-release/electron/win-x64/";

export function resolveCompanyWindowsSigning(
  env = process.env,
  certificateFile = companyWindowsCertificate,
) {
  const pfx = env.GEA_WINDOWS_PFX_FILE,
    passwordFile = env.GEA_WINDOWS_PFX_PASSWORD_FILE;
  if (!pfx || !passwordFile)
    throw Error("GEA_WINDOWS_PFX_FILE and GEA_WINDOWS_PFX_PASSWORD_FILE are required");
  for (const file of [pfx, passwordFile])
    if (!statSync(file).isFile()) throw Error("WINDOWS_SIGNING_FILE_INVALID");
  const cert = new X509Certificate(readFileSync(certificateFile));
  if (
    cert.ca ||
    !cert.keyUsage?.includes("1.3.6.1.5.5.7.3.3") ||
    Date.parse(cert.validTo) <= Date.now() ||
    Date.parse(cert.validFrom) > Date.now()
  )
    throw Error("WINDOWS_PUBLIC_CERTIFICATE_INVALID");
  return {
    pfx,
    passwordFile,
    certificateFile,
    publisher: cert.subject,
    fingerprint: cert.fingerprint256,
  };
}

export function createCompanyWindowsSigner(
  options,
  {
    env = process.env,
    run = promisify(execFile),
    certificateFile = companyWindowsCertificate,
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
      await options.repairExecutable(configuration.path);
      try {
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
          {
            windowsHide: true,
            timeout: 120000,
            maxBuffer: 65536,
            env: {
              ...options.signingEnvironment,
              PSModulePath: "",
            },
          },
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

export function resolveCompanyWindowsUpdate() {
  return { publicUrl: companyWindowsUpdateUrl };
}

export function adaptSignedWindowsFactory(source, desktop) {
  const replacements = [
    [
      "createWindowsTokenSigner({",
      "createCompanyWindowsSigner({ repairExecutable: repairDanglingAuthenticodeDirectory, signingEnvironment: scrubWindowsSigningEnvironment(env),",
    ],
    [
      "resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)",
      "resolveCompanyWindowsUpdate()",
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
