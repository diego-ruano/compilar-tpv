; Ganchos del instalador de Windows (`bundle.windows.nsis.installerHooks` en tauri.conf.json).
;
; Tauri incluye este fichero al principio de su plantilla (installer.nsi), antes de declarar sus
; variables y sus `!define`: por eso lo que usa `$UpdateMode`, `$PassiveMode`, `${BUNDLEID}` o
; `${MAINBINARYNAME}` va dentro de las macros `NSIS_HOOK_*`, que se expanden en sus secciones, y no en
; una `Function` de aquí, que se compila donde está.
;
; Hace tres cosas:
;
; 1. Al instalar, quita la instalación que lleva el nombre de antes («tpv», hasta el 29-10-2026). Era
;    el mismo programa con otro nombre de producto: Tauri no la reconoce, la nueva va a otra carpeta y
;    quedaban dos programas con dos accesos directos sobre los mismos datos. Se hace siempre, también
;    en una actualización, y sin tocar los datos.
; 2. Al instalar a mano, si el equipo ya tiene datos del TPV, ofrece empezar de cero: borrar la base,
;    la configuración y las credenciales de Windows (identidad del equipo, licencia, clave de cifrado).
;    «No» por defecto y con una segunda confirmación. Nunca en una actualización: el updater lanza
;    este mismo instalador en modo pasivo, y un «Sí» por error borraría la caja de un negocio.
; 3. Al desinstalar con «Eliminar los datos de aplicación», que ya borra las carpetas, borra también
;    las credenciales. Si quedaran, el programa nuevo daría el equipo por activado en el negocio de antes.
;
; Las credenciales son genéricas de Windows, llamadas `{clave}.{servicio}` (secret_store.rs), con los
; servicios de device.rs. Las de los E2E llevan detrás `.{espacio}` (`apartar_secretos`) y no
; terminan como éstas: no se tocan.

!define /ifndef TPV_SERVICIO_LICENCIA ".tpv-licensing"
!define /ifndef TPV_SERVICIO_CLAVE ".tpv-licensing-devicekey"
!define /ifndef TPV_SERVICIO_SESION ".tpv-auth"

; El nombre de producto de las instalaciones de antes del 29-10-2026, y su editor: entonces no había
; `bundle.publisher` y Tauri lo sacaba del identifier.
!define /ifndef TPV_NOMBRE_ANTERIOR "tpv"
!define /ifndef TPV_EDITOR_ANTERIOR "altarialights"
!define TPV_CLAVE_ANTERIOR "Software\Microsoft\Windows\CurrentVersion\Uninstall\${TPV_NOMBRE_ANTERIOR}"

; Si la instalación de antes tenía accesos directos, para rehacerlos en una actualización (ver
; NSIS_HOOK_POSTINSTALL).
Var TpvAccesoInicio
Var TpvAccesoEscritorio

; Recorre las credenciales del usuario y cuenta, o borra, las del TPV.
; Entrada: $R9 = 1 para borrarlas, 0 para sólo contarlas. Salida: $R8 = cuántas había, o -1 si Windows
; no ha dejado leerlas (no es lo mismo que «no hay ninguna»).
!macro TPV_FUNCION_CREDENCIALES UN
Function ${UN}TpvCredenciales
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  StrCpy $R8 0
  ; CredEnumerateW(filtro NULL, 0, &cuántas, &lista): todas las del usuario. Falla con
  ; ERROR_NOT_FOUND (1168) si no hay ninguna; con otro error no se sabe.
  System::Call 'advapi32::CredEnumerateW(p 0, i 0, *i .r1, *p .r2) i .r0 ?e'
  Pop $9
  ${If} $0 = 0
  ${AndIf} $9 <> 1168
    StrCpy $R8 -1
    DetailPrint "No se han podido leer las credenciales de Windows (error $9)"
  ${EndIf}
  ${If} $0 <> 0
    StrCpy $3 0
    ${While} $3 < $1
      ; lista[$3] es un PCREDENTIALW; de la estructura, Flags, Type y TargetName.
      IntOp $4 $3 * ${NSIS_PTR_SIZE}
      IntPtrOp $4 $2 + $4
      System::Call '*$4(p .r5)'
      System::Call '*$5(i .r6, i .r7, w .r8)'
      ; CRED_TYPE_GENERIC = 1
      ${If} $7 = 1
        StrCpy $9 0
        StrLen $6 "${TPV_SERVICIO_LICENCIA}"
        IntOp $6 0 - $6
        StrCpy $5 $8 "" $6
        ${IfThen} $5 == "${TPV_SERVICIO_LICENCIA}" ${|} StrCpy $9 1 ${|}
        StrLen $6 "${TPV_SERVICIO_CLAVE}"
        IntOp $6 0 - $6
        StrCpy $5 $8 "" $6
        ${IfThen} $5 == "${TPV_SERVICIO_CLAVE}" ${|} StrCpy $9 1 ${|}
        StrLen $6 "${TPV_SERVICIO_SESION}"
        IntOp $6 0 - $6
        StrCpy $5 $8 "" $6
        ${IfThen} $5 == "${TPV_SERVICIO_SESION}" ${|} StrCpy $9 1 ${|}
        ${If} $9 = 1
          IntOp $R8 $R8 + 1
          ${If} $R9 = 1
            System::Call 'advapi32::CredDeleteW(w r8, i 1, i 0) i .r0'
            ${If} $0 = 0
              DetailPrint "No se ha podido borrar la credencial $8"
            ${Else}
              DetailPrint "Credencial borrada: $8"
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
      IntOp $3 $3 + 1
    ${EndWhile}
    System::Call 'advapi32::CredFree(p r2)'
  ${EndIf}
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!macroend
!insertmacro TPV_FUNCION_CREDENCIALES ""
!insertmacro TPV_FUNCION_CREDENCIALES "un."

; Cierra el TPV si está abierto (las dos instalaciones ejecutan `tpv.exe`). A mano lo pregunta y
; «Cancelar» detiene la instalación; en una actualización o en silencio lo cierra sin preguntar, como
; hace la plantilla de Tauri. No cambia ningún registro.
!macro TPV_CERRAR_LA_APP
  Push $R0
  nsis_tauri_utils::FindProcessCurrentUser "${MAINBINARYNAME}.exe"
  Pop $R0
  ${If} $R0 = 0
    ${If} $PassiveMode <> 1
    ${AndIfNot} ${Silent}
      ${IfNot} ${Cmd} `MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "El TPV está abierto. Pulsa Aceptar para cerrarlo y seguir con la instalación." IDOK`
        Abort "Instalación cancelada: el TPV sigue abierto."
      ${EndIf}
    ${EndIf}
    nsis_tauri_utils::KillProcessCurrentUser "${MAINBINARYNAME}.exe"
    Pop $R0
    ; Da tiempo a que terminen también sus procesos de WebView2, que tienen abierta su carpeta.
    Sleep 1500
    ${If} $R0 <> 0
    ${AndIf} $R0 <> 2
      ${IfNot} ${Silent}
        MessageBox MB_ICONSTOP "No se ha podido cerrar el TPV. Ciérralo y vuelve a lanzar el instalador."
      ${EndIf}
      Abort "No se ha podido cerrar el TPV."
    ${EndIf}
  ${EndIf}
  Pop $R0
!macroend

; Si queda algo de las dos carpetas de datos o de las credenciales. Salida: $R0 = 1 si queda algo;
; usa $R2, $R8 y $R9. Una carpeta vacía no cuenta (`DirState` = 1 es «con contenido»): lo que importa
; es el contenido, y una carpeta vacía que otro proceso tiene abierta no se deja quitar.
!macro TPV_QUEDAN_DATOS
  StrCpy $R0 0
  ${DirState} "$APPDATA\${BUNDLEID}" $R2
  ${IfThen} $R2 = 1 ${|} StrCpy $R0 1 ${|}
  ${DirState} "$LOCALAPPDATA\${BUNDLEID}" $R2
  ${IfThen} $R2 = 1 ${|} StrCpy $R0 1 ${|}
  StrCpy $R9 0
  Call TpvCredenciales
  ${IfThen} $R8 <> 0 ${|} StrCpy $R0 1 ${|}
!macroend

; El orden importa: primero se pregunta, y lo que puede fallar (borrar los datos) va antes de quitar
; la instalación de antes, para que un fallo no deje el equipo sin programa.
!macro NSIS_HOOK_PREINSTALL
  !if "${INSTALLMODE}" != "currentUser"
    ; Las credenciales y la instalación de antes son del usuario: con otro modo hay que revisar esto.
    !error "hooks.nsh supone installMode currentUser"
  !endif
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R8
  Push $R9
  SetShellVarContext current

  ; ¿Hay una instalación con el nombre de antes, y es la nuestra? La clave «tpv» la podría usar otro
  ; programa: como hace la plantilla con las de WiX, se exige el nombre, el editor y el ejecutable.
  ; $R4: 0 nada, 1 quitarla, 2 sólo queda su entrada del registro. $R1: su desinstalador. $R5: su
  ; carpeta.
  StrCpy $R4 0
  !if "${PRODUCTNAME}" != "${TPV_NOMBRE_ANTERIOR}"
    ReadRegStr $R0 HKCU "${TPV_CLAVE_ANTERIOR}" "DisplayName"
    ReadRegStr $R3 HKCU "${TPV_CLAVE_ANTERIOR}" "Publisher"
    ${If} $R3 == "${MANUFACTURER}"
      StrCpy $R3 "${TPV_EDITOR_ANTERIOR}"
    ${EndIf}
    ${If} $R0 == "${TPV_NOMBRE_ANTERIOR}"
    ${AndIf} $R3 == "${TPV_EDITOR_ANTERIOR}"
      ReadRegStr $R1 HKCU "${TPV_CLAVE_ANTERIOR}" "UninstallString"
      ; La plantilla la guarda entre comillas.
      StrCpy $R0 $R1 1
      ${If} $R0 == '"'
        StrCpy $R1 $R1 "" 1
        StrCpy $R1 $R1 -1
      ${EndIf}
      ${If} $R1 != ""
        ${GetParent} "$R1" $R5
        ${If} ${FileExists} "$R1"
        ${AndIf} ${FileExists} "$R5\${MAINBINARYNAME}.exe"
          StrCpy $R4 1
        ${ElseIfNot} ${FileExists} "$R5\*.*"
          ; Su carpeta ya no está: sólo queda la entrada de «Programas y características».
          StrCpy $R4 2
        ${EndIf}
      ${EndIf}
    ${EndIf}
  !endif

  ; Empezar de cero: sólo a mano, y no sobre la instalación vigente. Si la página de reinstalación de
  ; la plantilla se resolvió sin desinstalar (reinstalar la misma versión, o actualizar sin quitar la
  ; anterior), su entrada sigue ahí: es una caja que se está actualizando y no se le pregunta. Si se
  ; eligió desinstalar antes (lo que viene marcado al instalar una versión más nueva), sí se pregunta:
  ; el desinstalador de una versión sin estos ganchos no borra las credenciales, y es el momento de
  ; empezar de cero en un equipo de pruebas. «No» va por defecto.
  StrCpy $R3 0
  ReadRegStr $R0 HKCU "${UNINSTKEY}" "UninstallString"
  ${If} $UpdateMode <> 1
  ${AndIf} $PassiveMode <> 1
  ${AndIfNot} ${Silent}
  ${AndIf} $R0 == ""
    !insertmacro TPV_QUEDAN_DATOS
    ${If} $R0 = 1
      ${If} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Este equipo ya tiene datos del TPV.$\n$\n¿Quieres empezar de cero? Se borran de este equipo la base de datos, la configuración, las copias de seguridad guardadas en él y la licencia, también sus credenciales de Windows. Lo que está en la nube no se toca.$\n$\nSi sólo estás actualizando el programa, o no estás seguro, pulsa No y se conserva todo." IDYES`
      ${AndIf} ${Cmd} `MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Se va a borrar todo lo que el TPV guarda en este equipo. Lo que no se haya subido a la nube se pierde y no se puede recuperar.$\n$\n¿Borrar y empezar de cero?" IDYES`
        StrCpy $R3 1
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ${If} $R3 = 1
  ${OrIf} $R4 = 1
    !insertmacro TPV_CERRAR_LA_APP
  ${EndIf}

  ${If} $R3 = 1
    DetailPrint "Borrando los datos del TPV de este equipo"
    RMDir /r "$APPDATA\${BUNDLEID}"
    RMDir /r "$LOCALAPPDATA\${BUNDLEID}"
    StrCpy $R9 1
    Call TpvCredenciales
    ; Un fichero que aún tenía abierto un proceso que se estaba cerrando: otra vez, tras esperar.
    !insertmacro TPV_QUEDAN_DATOS
    ${If} $R0 = 1
      Sleep 3000
      RMDir /r "$APPDATA\${BUNDLEID}"
      RMDir /r "$LOCALAPPDATA\${BUNDLEID}"
      StrCpy $R9 1
      Call TpvCredenciales
      !insertmacro TPV_QUEDAN_DATOS
    ${EndIf}
    ; Lo que quede se avisa y se para: instalar sobre datos a medio borrar dejaría el equipo peor
    ; que antes. La instalación de antes aún no se ha quitado; si la página de reinstalación ya
    ; desinstaló la vigente, el equipo se queda sin programa hasta volver a lanzar el instalador.
    ${If} $R0 = 1
      MessageBox MB_ICONSTOP "No se ha podido borrar todo. Reinicia el equipo y vuelve a lanzar el instalador."
      Abort "No se han podido borrar los datos del TPV."
    ${EndIf}
  ${EndIf}

  ${If} $R4 = 1
    ; Sus accesos directos, para rehacerlos en una actualización (el updater no crea ninguno).
    StrCpy $TpvAccesoInicio 0
    StrCpy $TpvAccesoEscritorio 0
    ${IfThen} ${FileExists} "$SMPROGRAMS\${TPV_NOMBRE_ANTERIOR}.lnk" ${|} StrCpy $TpvAccesoInicio 1 ${|}
    ${IfThen} ${FileExists} "$DESKTOP\${TPV_NOMBRE_ANTERIOR}.lnk" ${|} StrCpy $TpvAccesoEscritorio 1 ${|}
    DetailPrint "Quitando la instalación anterior ($R5)"
    ; `_?=` hace que espere y que no se copie a otra carpeta; por eso no se borra a sí mismo. En
    ; silencio no marca «Eliminar los datos de aplicación»: los datos no se tocan.
    ClearErrors
    ExecWait '"$R1" /S _?=$R5' $R0
    ${If} ${Errors}
    ${OrIf} $R0 <> 0
      DetailPrint "El desinstalador anterior ha terminado con error ($R0); se sigue con la instalación."
    ${Else}
      Delete "$R1"
      RMDir "$R5"
    ${EndIf}
  ${ElseIf} $R4 = 2
    DeleteRegKey HKCU "${TPV_CLAVE_ANTERIOR}"
  ${EndIf}

  Pop $R9
  Pop $R8
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend

; En una actualización la plantilla no crea accesos directos, sólo actualiza los que ya llevan este
; nombre. Si se acaba de quitar la instalación de antes, que tenía los suyos, se rehacen aquí; a mano,
; la plantilla ya crea el del menú Inicio y ofrece el del escritorio.
!macro NSIS_HOOK_POSTINSTALL
  ${If} $UpdateMode = 1
  ${AndIf} $NoShortcutMode <> 1
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4
    Push $5
    ${If} $TpvAccesoInicio = 1
    ${AndIfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}
    ${If} $TpvAccesoEscritorio = 1
    ${AndIfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; La plantilla ya ha borrado las carpetas con estas mismas condiciones. Si la de la base no se ha
  ; podido borrar (un fichero abierto), las credenciales se quedan con ella: sin ellas, esa base
  ; quedaría sin su licencia ni su clave de cifrado.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    Push $R7
    Push $R8
    Push $R9
    ${DirState} "$APPDATA\${BUNDLEID}" $R7
    ${If} $R7 = 1
      DetailPrint "La carpeta de datos no se ha podido borrar entera: se conservan las credenciales."
    ${Else}
      StrCpy $R9 1
      Call un.TpvCredenciales
    ${EndIf}
    Pop $R9
    Pop $R8
    Pop $R7
  ${EndIf}
!macroend
