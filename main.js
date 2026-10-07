'use strict';

// MC Browser -- entrypoint delgado (paso 28)
//
// El cuerpo del proceso principal vive en src/main/bootstrap.js: alli se fija
// la carpeta de datos como PRIMERA linea de codigo propio (regla 2.5) y se
// monta todo lo demas. Este archivo arranca esa cadena y no hace nada mas, a
// proposito: si algo del proceso vuelve a caer aqui, se revierte el paso 28.
// Ver docs/RESTRUCTURACION.md 2.5 y 3.
require('./src/main/bootstrap');