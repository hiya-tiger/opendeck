; OpenDecks Windows installer (NSIS 3, Modern UI 2).
; Built by scripts/make-installer.mjs; do not run makensis on this file by hand
; unless STAGE_DIR, OUT_FILE and APP_VERSION are passed with /D.

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma

!ifndef STAGE_DIR
  !error "Pass /DSTAGE_DIR=<release/OpenDecks-win32-x64>"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "OpenDecks-Setup.exe"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "0.0.0"
!endif

!define APP_NAME "OpenDecks"
!define APP_EXE "OpenDecks.exe"
!define COMPANY "OpenDeck"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "${OUT_FILE}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_NAME}" "InstallDir"
BrandingText "${APP_NAME} ${APP_VERSION}"

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "FileDescription" "${APP_NAME} installer"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "LegalCopyright" "MIT License"
VIAddVersionKey "CompanyName" "${COMPANY}"

!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifdef APP_ICON
  !define MUI_ICON "${APP_ICON}"
  !define MUI_UNICON "${APP_ICON}"
!endif
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Launch ${APP_NAME}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${STAGE_DIR}\resources\app\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ; Close a running copy so its files can be replaced.
  nsExec::Exec 'taskkill /IM "${APP_EXE}" /F'
FunctionEnd

Section "Install"
  SetOutPath "$INSTDIR"
  ; Wipe the old app code so files removed in this version don't linger.
  RMDir /r "$INSTDIR\resources\app"
  File /r "${STAGE_DIR}\*.*"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\${APP_NAME}" "InstallDir" "$INSTDIR"

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall ${APP_NAME}.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${COMPANY}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM "${APP_EXE}" /F'
  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  ; User data (library, cues, stem cache, models) lives in %APPDATA%\opendecks-desktop and is kept.
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${APP_NAME}"
SectionEnd
