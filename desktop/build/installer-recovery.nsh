!define GEA_INSTALLER_RECOVERY_SCRIPT "${__FILEDIR__}\installer-recovery.ps1"
!define GEA_DIRECTORY_ROLLBACK_VALUE "GeaPendingDirectoryRollback"

!macro GEA_RESTORE_REGISTERED_DIRECTORY
  Push $0
  Push $1
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 != ""
  ${AndIf} $0 == $INSTDIR
  ${AndIfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    Call InstallerValidatePath
    ${If} $InstallerError == ""
    ${AndIf} $InstallerPath == $INSTDIR
      ReadRegStr $1 HKCU "${INSTALL_REGISTRY_KEY}" "${GEA_DIRECTORY_ROLLBACK_VALUE}"
      ${If} $1 != ""
        InitPluginsDir
        SetOutPath "$PLUGINSDIR"
        File "/oname=$PLUGINSDIR\gea-installer-recovery.ps1" "${GEA_INSTALLER_RECOVERY_SCRIPT}"
        nsExec::ExecToStack /TIMEOUT=10000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\gea-installer-recovery.ps1" -Target "$INSTDIR" -Executable "${APP_EXECUTABLE_FILENAME}" -Backup "$1"'
        Pop $0
        Pop $1
        ${If} $0 != 0
          DetailPrint "恢复上次安装目录失败（$0），备份目录已保留。"
          MessageBox MB_OK|MB_ICONEXCLAMATION "无法恢复上次安装目录。请解除目录占用后重新运行此安装程序。原数据和备份目录已保留。" /SD IDOK
          SetErrorLevel 2
          Quit
        ${ElseIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
          DeleteRegValue HKCU "${INSTALL_REGISTRY_KEY}" "${GEA_DIRECTORY_ROLLBACK_VALUE}"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $1
  Pop $0
  ClearErrors
!macroend

!macro GEA_WATCH_DIRECTORY_SWITCH
  Push $0
  Push $1
  StrCpy $1 1
  ${If} ${FileExists} "$dshFinalDirectory\${APP_EXECUTABLE_FILENAME}"
    StrCpy $1 0
    File "/oname=$PLUGINSDIR\gea-installer-recovery.ps1" "${GEA_INSTALLER_RECOVERY_SCRIPT}"
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    SetOutPath "$TEMP"
    ClearErrors
    Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\gea-installer-recovery.ps1" -Target "$dshFinalDirectory" -Executable "${APP_EXECUTABLE_FILENAME}" -Backup "$dshOldDirectory" -Owner $0 -Ready "$PLUGINSDIR\gea-directory-recovery-ready"'
    ${IfNot} ${Errors}
      StrCpy $0 40
      ${DoWhile} $0 > 0
        ${If} ${FileExists} "$PLUGINSDIR\gea-directory-recovery-ready"
          StrCpy $1 1
          ${ExitDo}
        ${EndIf}
        Sleep 250
        IntOp $0 $0 - 1
      ${Loop}
    ${EndIf}
    SetOutPath "$PLUGINSDIR"
    ${If} $1 == 1
      ClearErrors
      WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "${GEA_DIRECTORY_ROLLBACK_VALUE}" "$dshOldDirectory"
      ${If} ${Errors}
        StrCpy $1 0
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ClearErrors
  ${If} $1 == 0
    SetErrors
  ${EndIf}
  Pop $1
  Pop $0
!macroend

!macro GEA_CLEAR_DIRECTORY_RECOVERY
  DeleteRegValue HKCU "${INSTALL_REGISTRY_KEY}" "${GEA_DIRECTORY_ROLLBACK_VALUE}"
!macroend
