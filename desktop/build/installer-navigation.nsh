!include "LogicLib.nsh"

# 安装时接管当前安装范围。正式进程启动后也会注册当前用户范围。
!macro GEA_REGISTER_NAVIGATION
  WriteRegStr SHCTX "Software\Classes\aionui" "" "URL:GEA Client Navigation"
  WriteRegStr SHCTX "Software\Classes\aionui" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\aionui\shell\open\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
!macroend

# 只有命令仍精确指向本安装路径时才删除；不清理其他程序已接管的键。
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
