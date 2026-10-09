Unicode true
Name "GEA diagnostic probe"
OutFile "${PROBE_OUTPUT}"
RequestExecutionLevel user
SilentInstall silent
!include "${TIMING_INCLUDE}"
Section
  StrCpy $0 "preserve-zero"
  StrCpy $7 "preserve-seven"
  StrCpy $8 "preserve-eight"
  StrCpy $9 "preserve-nine"
  Push "stack-sentinel"
  SetErrors
  !insertmacro GEA_INSTALL_TIMING_LOG "probe-error-set"
  IfErrors +2 0
    Goto failed
  StrCmp $0 "preserve-zero" +2 0
    Goto failed
  StrCmp $7 "preserve-seven" +2 0
    Goto failed
  StrCmp $8 "preserve-eight" +2 0
    Goto failed
  StrCmp $9 "preserve-nine" +2 0
    Goto failed
  Pop $0
  StrCmp $0 "stack-sentinel" +2 0
    Goto failed
  ClearErrors
  !insertmacro GEA_INSTALL_TIMING_LOG "probe-error-clear"
  IfErrors failed
  !insertmacro GEA_INSTALL_TIMING_LOG "probe-pass"
  SetErrorLevel 0
  Goto done
  failed:
    SetErrorLevel 73
  done:
SectionEnd
