!define GEA_DIRECTORY_INSTALL
!define GEA_DIRECTORY_BUILD_DIR "${__FILEDIR__}"
!include "${__FILEDIR__}\installer-timing.nsh"
!ifndef BUILD_UNINSTALLER
!macro customHeader
!include "${GEA_DIRECTORY_BUILD_DIR}\installer-directories.nsh"
Function geaCheckAppRunning
  !insertmacro CHECK_APP_RUNNING
FunctionEnd

# Preserve all-user/current-user compatibility. Only an empty destination or a
# registered GEA installation can be replaced as a directory.
Function geaValidateInstallDirectory
  Push $0
  Push $1
  Push $2
  GetFullPathName $INSTDIR "$INSTDIR"
  ${GetRoot} "$INSTDIR" $0
  ${If} $INSTDIR == $0
  ${OrIf} $INSTDIR == "$0\"
  ${OrIf} $INSTDIR == $WINDIR
  ${OrIf} $INSTDIR == $PROFILE
  ${OrIf} $INSTDIR == $APPDATA
  ${OrIf} $INSTDIR == $LOCALAPPDATA
  ${OrIf} $INSTDIR == $PROGRAMFILES32
  ${OrIf} $INSTDIR == $PROGRAMFILES64
    Goto invalid
  ${EndIf}
  StrCpy $2 $INSTDIR
  ${Do}
    System::Call 'kernel32::GetFileAttributesW(w r2) i.r1'
    ${If} $1 != -1
      IntOp $1 $1 & 0x400
      ${If} $1 != 0
        Goto invalid
      ${EndIf}
    ${EndIf}
    ${GetParent} "$2" $1
    ${If} $1 == $2
    ${OrIf} $1 == ""
      ${ExitDo}
    ${EndIf}
    StrCpy $2 $1
  ${Loop}
  ReadRegStr $0 SHCTX "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 == $INSTDIR
  ${AndIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    Goto valid
  ${EndIf}
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $2 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 == $INSTDIR
  ${OrIf} $2 == $INSTDIR
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      Goto valid
    ${EndIf}
  ${EndIf}
  FindFirst $0 $1 "$INSTDIR\*.*"
  ${DoWhile} $1 != ""
    ${If} $1 != "."
    ${AndIf} $1 != ".."
      FindClose $0
      Goto invalid
    ${EndIf}
    FindNext $0 $1
  ${Loop}
  FindClose $0
  Goto valid
  invalid:
    !insertmacro GEA_INSTALL_TIMING_LOG "directory-preflight-rejected"
    MessageBox MB_OK|MB_ICONEXCLAMATION "请选择空文件夹，或已安装的 GEA Desktop 目录。" /SD IDOK
    SetErrorLevel 2
    Quit
  valid:
    Pop $2
    Pop $1
    Pop $0
    ClearErrors
FunctionEnd
!macroend

!macro customInstallerExtract FILE
  !insertmacro GEA_INSTALL_STEP "1/4 正在解压新版本，原安装保留…" 0
  !insertmacro GEA_INSTALL_TIMING_LOG "sevenzip-extract-begin"
  nsExec::ExecToStack '"$PLUGINSDIR\gea-7za.exe" x -y -bd -bb0 "-o$INSTDIR" "${FILE}"'
  Pop $R0
  Pop $R1
  !insertmacro GEA_INSTALL_TIMING_LOG "sevenzip-extract-end result=$R0"
!macroend
!endif

!macro InstallerPublishStage STAGE
  !if ${STAGE} == 2
    !insertmacro GEA_INSTALL_STEP "2/4 正在切换新版本目录…" 0
  !else
    !insertmacro GEA_INSTALL_STEP "3/4 正在登记快捷方式和安装信息…" 0
  !endif
!macroend

# Indeterminate while work is in progress: the embedded archive's extraction
# must not make the normal NSIS bar claim 100% before 7-Zip has finished.
!macro GEA_INSTALL_STEP TITLE COMPLETE
  Push $0
  Push $1
  StrCpy $1 0
  ${If} ${Errors}
    StrCpy $1 1
  ${EndIf}
  ${IfNot} ${Silent}
    SetDetailsPrint textonly
    DetailPrint "${TITLE}"
    System::Call 'user32::GetWindowLongW(p $mui.InstFilesPage.ProgressBar, i -16) i.r0'
    !if ${COMPLETE} == 0
      IntOp $0 $0 | 8
      System::Call 'user32::SetWindowLongW(p $mui.InstFilesPage.ProgressBar, i -16, i r0)'
      SendMessage $mui.InstFilesPage.ProgressBar 0x040A 1 40
    !else
      SendMessage $mui.InstFilesPage.ProgressBar 0x040A 0 0
      IntOp $0 $0 & 0xFFFFFFF7
      System::Call 'user32::SetWindowLongW(p $mui.InstFilesPage.ProgressBar, i -16, i r0)'
      SendMessage $mui.InstFilesPage.ProgressBar 0x0406 0 100
      SendMessage $mui.InstFilesPage.ProgressBar 0x0402 100 0
    !endif
  ${EndIf}
  ClearErrors
  ${If} $1 == 1
    SetErrors
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro customInstallerExtractFailed FILE
  Push $0
  Push $1
  System::Call 'kernel32::GetTickCount() i.r0'
  CreateDirectory "$LOCALAPPDATA\${GEA_UPDATER_CACHE_NAME}\installer-logs"
  FileOpen $1 "$LOCALAPPDATA\${GEA_UPDATER_CACHE_NAME}\installer-logs\extract-failure-$0.log" w
  FileWrite $1 "7-Zip result: $R0$\r$\n$R1$\r$\nOutput is bounded by the NSIS string limit.$\r$\n"
  FileClose $1
  MessageBox MB_OK|MB_ICONEXCLAMATION "解压失败，原安装目录已保留。错误记录位于本地安装日志目录。" /SD IDOK
  Pop $1
  Pop $0
!macroend
