# Runs the actual transfer macros against disposable files, before installation.
Unicode true
Name "GEA installer transfer probe"
OutFile "${PROBE_OUTPUT}"
RequestExecutionLevel user
SilentInstall silent
!include "${TIMING_INCLUDE}"
!include "${TRANSFER_INCLUDE}"

Function CreateStage
  !insertmacro GEA_CREATE_INSTALL_STAGE
FunctionEnd
Function MoveEntries
  !insertmacro GEA_MOVE_NEW_ENTRIES
FunctionEnd
Function CleanStage
  !insertmacro GEA_CLEAN_INSTALL_STAGE
FunctionEnd

Section
  InitPluginsDir
  StrCpy $INSTDIR "$PLUGINSDIR\GEA path with spaces"
  SetOutPath "$INSTDIR"
  Call CreateStage
  StrCmp $geaMoveEnabled 1 +2
    Goto failed
  CreateDirectory "$geaInstallStage\resources\payload"
  StrCpy $2 0
  ${DoWhile} $2 < 128
    FileOpen $3 "$geaInstallStage\resources\payload\$2.txt" w
    FileWrite $3 "payload-$2"
    FileClose $3
    IntOp $2 $2 + 1
  ${Loop}
  FileOpen $3 "$geaInstallStage\app.txt" w
  FileWrite $3 "app"
  FileClose $3
  StrCpy $0 "preserve-zero"
  StrCpy $1 "preserve-one"
  Push "stack-sentinel"
  Call MoveEntries
  StrCmp $0 "preserve-zero" +2
    Goto failed
  StrCmp $1 "preserve-one" +2
    Goto failed
  Pop $0
  StrCmp $0 "stack-sentinel" +2
    Goto failed
  StrCmp $geaNeedsCopy 0 +2
    Goto failed
  StrCpy $2 0
  ${DoWhile} $2 < 128
    ClearErrors
    FileOpen $3 "$INSTDIR\resources\payload\$2.txt" r
    IfErrors failed
    FileRead $3 $4
    FileClose $3
    StrCmp $4 "payload-$2" +2
      Goto failed
    IntOp $2 $2 + 1
  ${Loop}
  IfFileExists "$INSTDIR\app.txt" +2
    Goto failed
  !insertmacro GEA_INSTALL_TIMING_LOG "transfer-probe-new-tree-pass"

  # Existing directory and a locked destination remain in place for CopyFiles.
  Call CreateStage
  CreateDirectory "$geaInstallStage\resources\payload"
  FileOpen $3 "$geaInstallStage\resources\payload\new.txt" w
  FileWrite $3 "new-payload"
  FileClose $3
  FileOpen $3 "$geaInstallStage\app.txt" w
  FileWrite $3 "new-app"
  FileClose $3
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\app.txt", i 0x80000000, i 0, p 0, i 3, i 0, p 0) p .r5'
  StrCmp $5 -1 failed
  Call MoveEntries
  System::Call 'kernel32::CloseHandle(p r5)'
  StrCmp $geaNeedsCopy 1 +2
    Goto failed
  IfFileExists "$geaInstallStage\app.txt" +2
    Goto failed
  FileOpen $3 "$INSTDIR\app.txt" r
  FileRead $3 $4
  FileClose $3
  StrCmp $4 "app" +2
    Goto failed
  ClearErrors
  CopyFiles /SILENT "$geaInstallStage\*" "$INSTDIR"
  IfErrors failed
  Call CleanStage
  FileOpen $3 "$INSTDIR\app.txt" r
  FileRead $3 $4
  FileClose $3
  StrCmp $4 "new-app" +2
    Goto failed
  IfFileExists "$INSTDIR\resources\payload\new.txt" +2
    Goto failed
  IfFileExists "$INSTDIR\resources\payload\127.txt" +2
    Goto failed
  !insertmacro GEA_INSTALL_TIMING_LOG "transfer-probe-existing-and-locked-pass"

  # If staging inside INSTDIR is impossible, preserve the original temp/copy path.
  StrCpy $INSTDIR "$PLUGINSDIR\GEA path with spaces\app.txt"
  Call CreateStage
  StrCmp $geaMoveEnabled 0 +2
    Goto failed
  Call MoveEntries
  StrCmp $geaNeedsCopy 1 +2
    Goto failed
  !insertmacro GEA_INSTALL_TIMING_LOG "transfer-probe-stage-fallback-pass"

  # A deep installation path must fall back before the extra stage component
  # pushes otherwise valid package filenames beyond MAX_PATH.
  StrCpy $INSTDIR "$PLUGINSDIR\long-"
  StrLen $2 $INSTDIR
  ${DoWhile} $2 < 236
    StrCpy $INSTDIR "$INSTDIR-x"
    StrLen $2 $INSTDIR
  ${Loop}
  CreateDirectory "$INSTDIR"
  Call CreateStage
  StrCmp $geaMoveEnabled 0 +2
    Goto failed
  !insertmacro GEA_INSTALL_TIMING_LOG "transfer-probe-long-path-fallback-pass"
  !insertmacro GEA_INSTALL_TIMING_LOG "transfer-probe-pass"
  SetErrorLevel 0
  Goto done
  failed:
    !insertmacro GEA_INSTALL_TIMING_LOG "transfer-probe-failed"
    SetErrorLevel 73
  done:
SectionEnd
