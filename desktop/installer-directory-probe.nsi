# Execute the production promotion/rollback functions only on disposable files.
Unicode true
Name "GEA directory installation probe"
OutFile "${PROBE_OUTPUT}"
RequestExecutionLevel user
SilentInstall silent
!include "${TIMING_INCLUDE}"
!include "${DIRECTORY_INCLUDE}"

Function WriteCandidate
  CreateDirectory "$geaNewDirectory"
  FileOpen $0 "$geaNewDirectory\app.txt" w
  FileWrite $0 "new"
  FileClose $0
FunctionEnd
Function CheckOld
  ClearErrors
  FileOpen $0 "$geaFinalDirectory\app.txt" r
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "new" +2
    SetErrors
FunctionEnd

Section
  InitPluginsDir
  StrCpy $geaFinalDirectory "$PLUGINSDIR\path with spaces"
  StrCpy $geaNewDirectory "$geaFinalDirectory.new-fixture"
  StrCpy $geaOldDirectory "$geaFinalDirectory.old-fixture"
  StrCpy $INSTDIR $geaFinalDirectory
  Call WriteCandidate
  Call geaPromoteDirectories
  IfErrors failed
  Call CheckOld
  IfErrors failed
  !insertmacro geaFinishDirectories
  !insertmacro GEA_INSTALL_TIMING_LOG "directory-probe-first-pass"

  FileOpen $0 "$geaFinalDirectory\obsolete.txt" w
  FileWrite $0 "obsolete"
  FileClose $0
  Call WriteCandidate
  Call geaPromoteDirectories
  IfErrors failed
  IfFileExists "$geaOldDirectory\obsolete.txt" +2
    Goto failed
  IfFileExists "$geaFinalDirectory\obsolete.txt" failed
  !insertmacro geaFinishDirectories
  IfFileExists "$geaOldDirectory\*.*" failed
  !insertmacro GEA_INSTALL_TIMING_LOG "directory-probe-upgrade-pass"

  # Promotion source missing after the original directory has been moved.
  Call geaPromoteDirectories
  IfErrors +2
    Goto failed
  Call CheckOld
  IfErrors failed
  IfFileExists "$geaOldDirectory\*.*" failed
  !insertmacro GEA_INSTALL_TIMING_LOG "directory-probe-rollback-pass"

  Call WriteCandidate
  System::Call 'kernel32::CreateFileW(w "$geaFinalDirectory\app.txt", i 0x80000000, i 1, p 0, i 3, i 0, p 0) p.r8'
  StrCmp $8 -1 failed
  Call geaPromoteDirectories
  StrCpy $9 0
  IfErrors 0 +2
    StrCpy $9 1
  System::Call 'kernel32::CloseHandle(p r8)'
  StrCmp $9 1 +2
    Goto failed
  Call CheckOld
  IfErrors failed
  !insertmacro GEA_INSTALL_TIMING_LOG "directory-probe-lock-pass"
  !insertmacro GEA_INSTALL_TIMING_LOG "directory-probe-pass"
  SetErrorLevel 0
  Quit
  failed:
    !insertmacro GEA_INSTALL_TIMING_LOG "directory-probe-failed"
    SetErrorLevel 2
    Quit
SectionEnd
