!include "LogicLib.nsh"

# Candidate only: prepare-installer-diagnostics.mjs explicitly opts into these
# macros. The released installer and the shared electron-builder cache stay intact.
!macro GEA_CREATE_INSTALL_STAGE
  Var /GLOBAL geaInstallStage
  Var /GLOBAL geaMoveEnabled
  Var /GLOBAL geaNeedsCopy
  StrCpy $geaInstallStage "$PLUGINSDIR\7z-out"
  StrCpy $geaMoveEnabled 0
  Push $0
  Push $1
  ClearErrors
  # A child of INSTDIR is on the installation volume and inherits its ACLs.
  # Reserve a unique name; never reuse/remove an earlier installation's stage.
  GetTempFileName $0 "$INSTDIR"
  ${IfNot} ${Errors}
    Delete "$0"
    ${IfNot} ${Errors}
      # Staging adds a path component. Do not turn a previously valid install
      # into a MAX_PATH extraction failure (the package supplies its maximum).
      StrLen $1 "$0"
      IntOp $1 $1 + ${GEA_MAX_RELATIVE_PATH}
      IntOp $1 $1 + 1
      ${If} $1 < 260
        CreateDirectory "$0"
        ${IfNot} ${Errors}
          StrCpy $geaInstallStage "$0"
          StrCpy $geaMoveEnabled 1
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
  CreateDirectory "$geaInstallStage"
  !insertmacro GEA_INSTALL_TIMING_LOG "install-stage sameVolume=$geaMoveEnabled"
!macroend

!macro GEA_MOVE_NEW_ENTRIES
  StrCpy $geaNeedsCopy 1
  ${If} $geaMoveEnabled == 1
    Push $0
    Push $1
    # Keep the original CopyFiles path for every entry that cannot be moved.
    # Rename does not overwrite an existing destination or schedule a reboot.
    StrCpy $geaNeedsCopy 0
    ClearErrors
    FindFirst $0 $1 "$geaInstallStage\*"
    ${If} ${Errors}
      StrCpy $geaNeedsCopy 1
    ${Else}
      ${DoWhile} $1 != ""
        ${If} $1 != "."
        ${AndIf} $1 != ".."
          ClearErrors
          Rename "$geaInstallStage\$1" "$OUTDIR\$1"
          ${If} ${Errors}
            StrCpy $geaNeedsCopy 1
          ${EndIf}
        ${EndIf}
        FindNext $0 $1
      ${Loop}
      FindClose $0
      # Enumeration while moving entries must never make us skip remaining files.
      # A non-recursive removal is the final proof that the stage is empty.
      ClearErrors
      RMDir "$geaInstallStage"
      ${If} ${Errors}
        StrCpy $geaNeedsCopy 1
      ${Else}
        StrCpy $geaNeedsCopy 0
      ${EndIf}
    ${EndIf}
    Pop $1
    Pop $0
  ${EndIf}
  ClearErrors
  !insertmacro GEA_INSTALL_TIMING_LOG "transfer-result needsCopy=$geaNeedsCopy"
!macroend

!macro GEA_CLEAN_INSTALL_STAGE
  !insertmacro GEA_INSTALL_TIMING_LOG "install-stage-cleanup-begin"
  ${If} $geaMoveEnabled == 1
    # Only the unique directory created by this run, never INSTDIR or userData.
    RMDir /r "$geaInstallStage"
  ${EndIf}
  !insertmacro GEA_INSTALL_TIMING_LOG "install-stage-cleanup-end"
  ClearErrors
!macroend
