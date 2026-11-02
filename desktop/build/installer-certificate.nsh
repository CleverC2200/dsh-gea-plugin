!define GEA_COMPANY_CERT_DIR "${__FILEDIR__}"
!macro GEA_INSTALL_CERTIFICATE
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File /oname=gea-codesign.cer "${GEA_COMPANY_CERT_DIR}\codesign.cer"
    File /oname=gea-install-certificate.ps1 "${GEA_COMPANY_CERT_DIR}\install-certificate.ps1"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\gea-install-certificate.ps1" -CertificatePath "$PLUGINSDIR\gea-codesign.cer" -CheckOnly'
    Pop $0
    Pop $1
    ${If} $0 == 3
      ${If} ${Silent}
        SetErrorLevel 2
        Abort
      ${EndIf}
      MessageBox MB_OKCANCEL|MB_ICONINFORMATION "首次安装将把思念食品代码签名公钥证书加入当前 Windows 用户的信任存储区，用于验证后续在线更新。是否继续？" /SD IDCANCEL IDOK +3
      SetErrorLevel 2
      Abort
    ${ElseIf} $0 != 0
      SetErrorLevel 2
      Abort
    ${EndIf}
    DetailPrint "正在配置思念食品签名证书，用于后续在线更新。"
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\gea-install-certificate.ps1" -CertificatePath "$PLUGINSDIR\gea-codesign.cer"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "公司签名证书安装失败，无法启用在线更新。请联系 IT 检查证书信任权限和设备策略。" /SD IDOK
      SetErrorLevel 2
      Abort
    ${EndIf}
    SetOutPath "$INSTDIR"
!macroend
