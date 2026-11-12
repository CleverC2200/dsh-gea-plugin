!include "LogicLib.nsh"


!macro GEA_REGISTER_NAVIGATION
  WriteRegStr SHCTX "Software\Classes\aionui" "" "URL:GEA Client Navigation"
  WriteRegStr SHCTX "Software\Classes\aionui" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\aionui\shell\open\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
!macroend


!macro GEA_REMOVE_OWN_NAVIGATION ROOT
  Push $0
  ReadRegStr $0 ${ROOT} "Software\Classes\aionui\shell\open\command" ""
  ${If} $0 == '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
    DeleteRegKey ${ROOT} "Software\Classes\aionui\shell"
    DeleteRegValue ${ROOT} "Software\Classes\aionui" "URL Protocol"
    DeleteRegValue ${ROOT} "Software\Classes\aionui" ""
    DeleteRegKey /ifempty ${ROOT} "Software\Classes\aionui"
  ${EndIf}
  Pop $0
!macroend

!ifndef GEA_INSTALL_TIMING_ENABLED
  !macro customInstall
    !insertmacro GEA_REGISTER_NAVIGATION
  !macroend
!endif

!macro customUnInstall
  !insertmacro GEA_REMOVE_OWN_NAVIGATION SHCTX
  !insertmacro GEA_REMOVE_OWN_NAVIGATION HKCU
!macroend
