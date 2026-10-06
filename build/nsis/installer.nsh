; MC Browser -- build/nsis/installer.nsh
;
; Pagina extra del instalador (despues de elegir carpeta, antes de instalar)
; con una casilla: borrar los rastros de instalaciones anteriores.
;
; Que borra, y solo si la casilla esta marcada Y el usuario confirma:
;   $APPDATA\MC Browser          -> marcadores, historial, sesiones, cfg.json,
;                                   claves de IA, sandbox del editor de docs
;   $APPDATA\mc-browser-v2-dev   -> perfil de desarrollo
;
; Que NO toca, a proposito:
;   - La carpeta de programa: la esta escribiendo este mismo instalador ahora.
;   - HKCU\Software\MC Browser: aca viven los protocolos http/https y la entrada
;     de desinstalacion. Si se borra despues de copiar archivos, la app queda
;     instalada pero sin protocolo asociado. El instalador los vuelve a registrar.
;
; La casilla viene SIN MARCAR. Si el usuario cierra esa pagina o el instalador
; corre en modo silencioso, MCB_Borrar nunca vale "1" y no se borra nada.

!include nsDialogs.nsh

; Este archivo tambien se compila para el DESINSTALADOR, y ahi la pagina no
; existe: las funciones quedan sin referenciar (warning 6010) y las variables
; sin usar (warning 6001). NSIS avisa y electron-builder convierte el aviso en
; error. Por eso variables, pagina y funciones van dentro del guard. Es lo
; mismo que hace multiUserUi.nsh con su pagina de modo de instalacion.
!ifndef BUILD_UNINSTALLER

Var MCB_CtrlBorrar
Var MCB_Borrar

; Se declara igual que la pagina de modo de instalacion de electron-builder:
; `PageEx custom` + `PageCallbacks`. Con `Page custom ...` el nombre `custom`
; lo tomaba NSIS como la funcion creadora y MCB_Crear quedaba sin referenciar.
!macro customPageAfterChangeDir
  PageEx custom
    PageCallbacks MCB_Crear MCB_Salir
    Caption " "
  PageExEnd
!macroend

Function MCB_Crear
  ; OJO: este archivo se incluye ANTES que MUI2.nsh, asi que aqui no existen
  ; todavia MUI_PAGE_FUNCTION_CUSTOM ni MUI_HEADER_TEXT. Por eso la pagina va
  ; con `Caption " "` (sin encabezado) y los controles se posicionan desde 0u,
  ; igual que la pagina de modo de instalacion de electron-builder.
  ;
  ; No hace falta llamar a instFilesPre: ese define lo consume la pagina
  ; MUI_PAGE_INSTFILES que va despues, no esta.

  nsDialogs::Create 1018
  Pop $0

  ${If} $0 == error
    ; Si el dialogo no se crea, la pagina queda en blanco y el usuario cree que
    ; no hay opcion. Mejor decirlo explicitamente.
    MessageBox MB_OK|MB_ICONSTOP "No se pudo mostrar la pagina de opciones. Segui con Instalar y el instalador funcionara igual; los datos anteriores no se van a borrar."
    Abort
  ${EndIf}

  ${NSD_CreateLabel} $0 0u 0u 300u 45u "Si ya instalaste MC Browser antes, podes borrar ahora todo lo que dejo esa instalacion: marcadores, historial, sesiones, configuracion, claves de IA y el sandbox del editor de documentos."
  Pop $1

  ${NSD_CreateLabel} $0 0u 50u 300u 30u "Se puede dejar la casilla sin marcar e instalar encima. Si marcas, no se puede deshacer."
  Pop $1

  ${NSD_CreateCheckBox} $0 0u 90u 300u 20u "Borrar datos de instalaciones anteriores"
  Pop $MCB_CtrlBorrar
  ; Sin marcar por defecto: el SendMessage garantiza que borrar solo pase si
  ; el usuario lo pidio de forma explicita.
  SendMessage $MCB_CtrlBorrar ${BM_SETCHECK} ${BST_UNCHECKED} 0

  nsDialogs::Show
FunctionEnd

Function MCB_Salir
  ; Se lee la casilla al salir de la pagina, no durante la copia de archivos.
  StrCpy $MCB_Borrar "0"
  ${If} $MCB_CtrlBorrar != 0
    SendMessage $MCB_CtrlBorrar ${BM_GETCHECK} 0 0 $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $MCB_Borrar "1"
    ${EndIf}
  ${EndIf}
FunctionEnd
!endif

!macro customInstall
  ${If} $MCB_Borrar == "1"
    ; El texto va en una sola linea: MessageBox no admite continuaciones con
    ; "\". Y los destinos son labels con nombre: NSIS no acepta labels que
    ; empiecen con digito, asi que "IDYES 0 IDNO 1" no compila.
    ; /SD IDNO mas la rama mcbNo hacen que en modo silencioso, o si se cierra
    ; la ventana sin elegir, la respuesta sea SIEMPRE no borrar.
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "Se van a BORRAR datos de tu cuenta de Windows.$\r$\n$\r$\n$APPDATA\MC Browser$\r$\n$APPDATA\mc-browser-v2-dev$\r$\n$\r$\nMarcadores, historial, sesiones, claves de IA y sandbox del editor. No se puede deshacer.$\r$\n$\r$\nContinuar con el borrado?" /SD IDNO IDYES mcbSi IDNO mcbNo

    mcbNo:
    Goto mcbListo

    mcbSi:
      DetailPrint "Borrando datos de la instalacion anterior..."
      RMDir /r "$APPDATA\MC Browser"
      RMDir /r "$APPDATA\mc-browser-v2-dev"
      DetailPrint "Datos anteriores borrados."

    mcbListo:
  ${EndIf}
!macroend