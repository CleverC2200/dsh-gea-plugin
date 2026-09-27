!include "FileFunc.nsh"
!include "LogicLib.nsh"
!define GEA_INSTALL_TIMING_ENABLED
!include "${__FILEDIR__}\installer-navigation.nsh"

!macro GEA_INSTALL_TIMING_LOG STAGE
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  StrCpy $8 0
  ${If} ${Errors}
    StrCpy $8 1
  ${EndIf}
  System::Call 'kernel32::GetCurrentProcessId() i .r7'
  ReadEnvStr $9 "GEA_DIAG_DIR"
  ${If} $9 == ""
    StrCpy $9 "$TEMP\GEA-Install-Diagnostics"
  ${EndIf}
  CreateDirectory "$9"
  FileOpen $9 "$9\stages-$7.log" a
  FileSeek $9 0 END
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  FileWrite $9 "$2-$1-$0T$4:$5:$6 [GEA-INSTALL-DIAG] pid=$7 "
  System::Call 'kernel32::GetTickCount() i .r7'
  FileWrite $9 "tickMs=$7 errors=$8 ${STAGE}$\r$\n"
  FileClose $9
  ClearErrors
  ${If} $8 == 1
    SetErrors
  ${EndIf}
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro preInit
  !ifndef BUILD_UNINSTALLER
    !insertmacro GEA_INSTALL_TIMING_LOG "pre-init"
  !endif
!macroend
!macro customInit
  !insertmacro GEA_INSTALL_TIMING_LOG "init"
!macroend

# electron-builder calls this immediately after the bundled 7z has been
# extracted to a temporary directory and copied into the destination.
!macro customFiles_x64
  !ifdef GEA_DIRECTORY_INSTALL
    !insertmacro GEA_INSTALL_TIMING_LOG "stage-payload-ready"
  !else
    !insertmacro GEA_INSTALL_TIMING_LOG "payload-ready"
  !endif
!macroend

# Called after registry entries and shortcuts have been written.
!macro customInstall
  !insertmacro GEA_REGISTER_NAVIGATION
  !ifdef GEA_DIRECTORY_INSTALL
    !insertmacro GEA_INSTALL_STEP "4/4 正在清理旧安装目录…" 0
    !insertmacro geaFinishDirectories
    !insertmacro GEA_INSTALL_STEP "安装完成" 1
  !endif
  !insertmacro GEA_INSTALL_TIMING_LOG "install-complete"
!macroend

!ifndef BUILD_UNINSTALLER
  Function .onInstSuccess
    !insertmacro GEA_INSTALL_TIMING_LOG "install-success"
  FunctionEnd
  Function .onInstFailed
    !insertmacro GEA_INSTALL_TIMING_LOG "install-failed"
  FunctionEnd
  Function .onGUIEnd
    !ifdef GEA_DIRECTORY_INSTALL
      Call geaCleanupDirectories
    !endif
    !insertmacro GEA_INSTALL_TIMING_LOG "gui-end-before-nsis-cleanup"
  FunctionEnd
!endif
