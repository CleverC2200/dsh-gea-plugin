!include "FileFunc.nsh"

!macro GEA_INSTALL_TIMING_LOG STAGE
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $9
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  FileOpen $9 "$TEMP\GEA-Desktop-install-timing.log" a
  FileSeek $9 0 END
  FileWrite $9 "$2-$1-$0T$4:$5:$6 [GEA-INSTALL-DIAG] ${STAGE}$\r$\n"
  FileClose $9
  Pop $9
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customInit
  ${IfNot} ${UAC_IsInnerInstance}
    Delete "$TEMP\GEA-Desktop-install-timing.log"
  ${EndIf}
  !insertmacro GEA_INSTALL_TIMING_LOG "init"
!macroend

# electron-builder calls this immediately after the bundled 7z has been
# extracted to a temporary directory and copied into the destination.
!macro customFiles_x64
  !insertmacro GEA_INSTALL_TIMING_LOG "payload-ready"
!macroend

# Called after registry entries and shortcuts have been written.
!macro customInstall
  !insertmacro GEA_INSTALL_TIMING_LOG "install-complete"
!macroend
