import { fileURLToPath } from "node:url";

const hooks = fileURLToPath(new URL("../../desktop/build/installer-recovery.nsh", import.meta.url));

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw Error("OFFICIAL_INSTALLER_RECOVERY_ADAPTER_DRIFT");
  return source.replace(anchor, () => replacement);
}

export function recoverableDirectoryInstaller(source) {
  const installer = replaceOnce(
    source.replaceAll("\r\n", "\n"),
    "    Rename $dshFinalDirectory $dshOldDirectory",
    [
      "    Call GeaWatchDirectorySwitch",
      "    ${If} ${Errors}",
      "      Call dshRollbackDirectories",
      "      SetErrors",
      "      Return",
      "    ${EndIf}",
      "    Rename $dshFinalDirectory $dshOldDirectory",
    ].join("\n"),
  );
  const cleanup = '    RMDir /r "\\\\?\\$dshOldDirectory"';
  return replaceOnce(installer, cleanup, "    Call GeaClearDirectoryRecovery\n" + cleanup);
}

export function recoverableInstaller(source, directories) {
  const include = '!include "${__FILEDIR__}\\installer-directories.nsh"';
  const installer = replaceOnce(
    source.replaceAll("\r\n", "\n"),
    include,
    '!include "' + directories + '"',
  );
  const checkRunning = "    Function InstallerCheckAppRunning";
  const initialized = replaceOnce(
    installer,
    checkRunning,
    "    !insertmacro GEA_INSTALLER_RECOVERY_FUNCTIONS\n" + checkRunning,
  );
  const selectedPath = "  StrCpy $InstallerPath $INSTDIR";
  return (
    '!include "' +
    hooks +
    '"\n' +
    replaceOnce(
      initialized,
      selectedPath,
      selectedPath + "\n  !insertmacro GEA_RESTORE_REGISTERED_DIRECTORY",
    )
  );
}
