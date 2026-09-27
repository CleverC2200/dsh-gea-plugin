# Adapted from DeepSeek 477b4f4, MIT; see THIRD_PARTY_DESKTOP_NOTICES.txt.
!include "LogicLib.nsh"

Var geaFinalDirectory
Var geaNewDirectory
Var geaOldDirectory
Var geaOldMoved
Var geaNewMoved

!macro geaExtractPayload FILE
  !ifmacrodef customInstallerExtract
    !insertmacro customInstallerExtract "${FILE}"
  !else
    nsExec::ExecToStack '"$PLUGINSDIR\gea-7za.exe" x -y -bd -bb0 "-o$INSTDIR" "${FILE}"'
    Pop $R0
    Pop $R1
  !endif
  ${If} $R0 != 0
    DetailPrint $R1
    Call geaRollbackDirectories
    !ifmacrodef customInstallerExtractFailed
      !insertmacro customInstallerExtractFailed "${FILE}"
    !else
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)" /SD IDOK
    !endif
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro geaStageApplication
  Call geaValidateInstallDirectory
  !insertmacro GEA_INSTALL_TIMING_LOG "directory-stage-begin"
  StrCpy $geaFinalDirectory $INSTDIR
  System::Call 'ole32::CoCreateGuid(g .r0) i .r1'
  ${If} $1 != 0
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $geaNewDirectory "$INSTDIR.new-$0"
  StrCpy $geaOldDirectory "$INSTDIR.old-$0"
  StrCpy $geaOldMoved ""
  StrCpy $geaNewMoved ""
  ClearErrors
  CreateDirectory $geaNewDirectory
  ${If} ${Errors}
    SetErrorLevel 2
    Quit
  ${EndIf}
  File /oname=$PLUGINSDIR\gea-7za.exe "${GEA_SEVENZIP_PATH}"
  StrCpy $INSTDIR $geaNewDirectory
  SetOutPath $INSTDIR
  !insertmacro installApplicationFiles
  !insertmacro GEA_INSTALL_TIMING_LOG "directory-stage-end"
  !ifdef GEA_SEVENZIP_LICENSE_DIR
    File /oname=7zip-installer-LICENSE.txt "${GEA_SEVENZIP_LICENSE_DIR}\LICENSE.txt"
    File /oname=7zip-installer-COPYING.txt "${GEA_SEVENZIP_LICENSE_DIR}\COPYING"
  !endif
  !ifdef UNINSTALLER_ICON
    File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"
  !endif
  StrCpy $INSTDIR $geaFinalDirectory
  SetOutPath $PLUGINSDIR
!macroend


Function geaCleanupDirectories
  ${If} $geaFinalDirectory != ""
    Call geaRollbackDirectories
  ${EndIf}
FunctionEnd

; Only directories created or renamed by this installer are removed during rollback.
Function geaRollbackDirectories
  !insertmacro GEA_INSTALL_TIMING_LOG "directory-rollback"
  SetOutPath $PLUGINSDIR
  ${If} $geaNewMoved == "1"
    RMDir /r "\\?\$geaFinalDirectory"
    StrCpy $geaNewMoved ""
  ${EndIf}
  ${If} $geaOldMoved == "1"
    ClearErrors
    Rename $geaOldDirectory $geaFinalDirectory
    ${If} ${Errors}
      ; Leave the complete backup in place if another process prevents restoration.
      DetailPrint $geaOldDirectory
      Return
    ${EndIf}
    StrCpy $geaOldMoved ""
  ${EndIf}
  ${If} $geaNewDirectory != ""
    RMDir /r "\\?\$geaNewDirectory"
  ${EndIf}
  StrCpy $INSTDIR $geaFinalDirectory
FunctionEnd

Function geaPromoteDirectories
  !insertmacro GEA_INSTALL_TIMING_LOG "directory-promote-begin"
  !ifmacrodef InstallerPublishStage
    !insertmacro InstallerPublishStage 2
  !endif
  ; SetOutPath opens a directory handle; release it before either rename.
  SetOutPath $PLUGINSDIR
  ClearErrors
  ${If} ${FileExists} "$geaFinalDirectory\*.*"
    Rename $geaFinalDirectory $geaOldDirectory
    ${If} ${Errors}
      Call geaRollbackDirectories
      SetErrors
      Return
    ${EndIf}
    StrCpy $geaOldMoved "1"
  ${Else}
    ; NSIS can create the destination before the install section starts.
    RMDir $geaFinalDirectory
  ${EndIf}
  ClearErrors
  Rename $geaNewDirectory $geaFinalDirectory
  ${If} ${Errors}
    Call geaRollbackDirectories
    SetErrors
    Return
  ${EndIf}
  StrCpy $geaNewMoved "1"
  !insertmacro GEA_INSTALL_TIMING_LOG "directory-promote-end"
  SetOutPath $geaFinalDirectory
  !ifmacrodef InstallerPublishStage
    !insertmacro InstallerPublishStage 3
  !endif
  ClearErrors
FunctionEnd

!macro geaFinishDirectories
  !insertmacro GEA_INSTALL_TIMING_LOG "old-directory-cleanup-begin"
  StrCpy $geaNewMoved ""
  ${If} $geaOldMoved == "1"
    RMDir /r "\\?\$geaOldDirectory"
    StrCpy $geaOldMoved ""
  ${EndIf}
  !insertmacro GEA_INSTALL_TIMING_LOG "old-directory-cleanup-end"
!macroend
