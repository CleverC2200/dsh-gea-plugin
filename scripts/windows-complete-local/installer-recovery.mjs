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
      "    !insertmacro GEA_WATCH_DIRECTORY_SWITCH",
      "    ${If} ${Errors}",
      "      Call dshRollbackDirectories",
      "      SetErrors",
      "      Return",
      "    ${EndIf}",
      "    Rename $dshFinalDirectory $dshOldDirectory",
    ].join("\n"),
  );
  const cleanup = '    RMDir /r "\\\\?\\$dshOldDirectory"';
  return replaceOnce(
    installer,
    cleanup,
    "    !insertmacro GEA_CLEAR_DIRECTORY_RECOVERY\n" + cleanup,
  );
}

export function recoverableInstaller(source, directories) {
  const include = '!include "${__FILEDIR__}\\installer-directories.nsh"';
  const installer = replaceOnce(
    source.replaceAll("\r\n", "\n"),
    include,
    '!include "' + directories + '"',
  );
  const selectedPath = "  StrCpy $InstallerPath $INSTDIR";
  return (
    '!include "' +
    hooks +
    '"\n' +
    replaceOnce(
      installer,
      selectedPath,
      selectedPath + "\n  !insertmacro GEA_RESTORE_REGISTERED_DIRECTORY",
    )
  );
}
