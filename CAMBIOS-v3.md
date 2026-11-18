# Cambios de la v3.6 (según «informe-pulso-v3_5»: prioridad P0 y P1 técnica)

✅ hecho · 🟡 hecho en parte · ⬜ no se hizo. Las pruebas pasan de 43 a 74 (`npm test`).

## P0: errores que el usuario sufre
- ✅ **B1 · Noticias de RSS sin imagen ni resumen.** Un comentario `//` en medio de una línea larga se los comía. Ahora la noticia se arma en `newsItem()` (una propiedad por línea).
- ✅ **B2 · «Borrar mis gustos» no borraba.** Mandaba un perfil vacío con versión 0, el servidor lo tomaba por un guardado viejo (409) y el cliente restauraba todo diciendo que se actualizó en otro dispositivo. Ahora hay `DELETE /api/profile`: deja un perfil vacío con una versión más nueva y la pantalla se vacía solo si el servidor confirmó.
- ✅ **B4 · El guardado fallaba en silencio.** Ahora hay aviso persistente (franja bajo el encabezado), reintentos automáticos con espera creciente, reintento al volver la conexión, aviso al cerrar la pestaña con cambios sin guardar, y mensajes distintos para sin conexión, servidor caído, perfil demasiado grande (413) y sesión vencida (401). Lo no guardado se respalda en el navegador y se recupera al volver a entrar con la misma cuenta.
- ✅ **B5 · El invitado perdía todo al recargar.** Sus gustos se guardan en `localStorage` (con `try/catch`: modo privado, cuota llena) y se migran a la cuenta al registrarse.
- ✅ **B6 · Nombres de artista partidos** («Earth, Wind & Fire» daba `artist:fire`). Un nombre es un solo artista; solo se separan `feat.`/`ft.`/`featuring`. Los nombres viajan separados con `|` (no con coma). La búsqueda por artista sigue tolerando colaboraciones («Drake & Future» cuenta como de Drake).
- ✅ **B8 · La portada esperaba a la personalización** hasta 6 s y la descartaba si tardaba. Ahora se pinta al llegar `/api/home` y «Para vos»/«Descubrí» se rellenan después (esqueletos mientras tanto). Verificado en Chromium: portada a los ~300 ms con la personalización retrasada 8 s.
- ✅ **B11 · Texto de privacidad corregido** (guardado del invitado en el navegador, IP con hash, encargados Vercel/Upstash/Resend, transferencia al exterior). 🟡 Quedan los marcadores **[COMPLETAR]** de responsable, domicilio y email: los tenés que llenar vos y conviene que lo revise quien corresponda.

## P1 técnico
- ✅ **Datos viejos ante una caída (stale-on-error).** Si una fuente externa falla, se sirve el último dato bueno hasta 6 h después de vencer (cabecera `X-Pulso-Fallback: stale`, caché corta) en vez de un 502. `/api/home` informa en `stale` qué secciones están así y la portada lo avisa.
- ✅ **Conflicto 409 = fusión, no descarte.** `public/js/merge.js` (función pura): fusión de tres vías entre la base, lo local y lo del servidor. No pierde trabajo de ningún dispositivo y no duplica pesos al compactar eventos.
- ✅ **Guardado atómico (S9).** `putProfileIf`: comprobar la versión y escribir son una sola operación (en Redis, un script Lua).
- ✅ **Login (S1–S3).** El bloqueo ya no es «10 fallos por email desde cualquier IP» (permitía dejar afuera a la víctima): ahora es por par IP+email, más tope por IP y demora creciente por cuenta. Tope por IP antes de calcular scrypt. Si Redis cae, las rutas de cuentas responden 503 (fallan cerradas) y el contenido sigue (falla abierto). Las IP en Redis van con hash. `Cache-Control: no-store` en `/api/auth` y `/api/profile`.
- ✅ **Búsquedas (R5).** Texto normalizado antes de cachear («Muse», «muse », «MUSE» = un pedido) y tope compartido por IP.
- ✅ **Filtro +18 (B7).** Se quitaron los falsos positivos de palabras sueltas («gore» escondía a Gore Verbinski, «sexual» a cualquier nota de acoso). Steam: descriptores 3 y 4 (sexual) y edad 18; películas por clasificación NC-17/X/TV-MA. Se corrigió el texto de Perfil: ya no promete ocultar violencia.
- ✅ **Pruebas:** fusión, sincronización cliente↔servidor real (borrado, conflicto, 401/413/sin red, invitado), caída de Redis, datos viejos con reloj simulado, límites, +18 de punta a punta. Las nuevas de B1/B6 fallan con el código anterior.

## Extras pequeños
- ✅ B9: el resumen de las noticias de Steam venía con BBCode (`[h1]`, `[img]`); ahora se limpia (y se pide más texto antes de recortar).
- ✅ B12: contraste del botón principal de acceso (4,87:1; antes 3,5:1).
- ✅ `appdetails` de Steam se guarda reducido a los campos que se usan (menos Redis).
- ✅ Service worker: si la red tarda más de 4 s para un archivo propio, usa la copia guardada. `vercel.json`: `maxDuration` 30 s para la función.
- ✅ Canciones con letra explícita se marcan con «Explícito» (no se ocultan, ver abajo).

## Decisiones que conviene que revises
- **Canciones explícitas:** se marcan pero NO se ocultan por defecto (`HIDE_EXPLICIT_SONGS` en `shared.js`). Ocultarlas vaciaría casi todo el hip-hop para quien no tocó el ajuste.
- **Violencia:** ya no se oculta (los descriptores de Steam de violencia los llevan muchos juegos populares). El texto de Perfil lo dice.
- **Película «R»** no cuenta como solo adultos; NC-17/X/TV-MA sí.
- **«with»** no separa artistas (rompería «Sleeping With Sirens»).
- Al **acceder a una cuenta existente**, los gustos del invitado de ese navegador se descartan (como antes); solo se migran al registrarse.
- Una **fusión** entre dos dispositivos que compactan el mismo tag a la vez puede contar de más ese tag. Es raro y de efecto leve.

## Pendiente / no verificado
- ⬜ **Prettier:** quedó la configuración (`.prettierrc.json`, `npm run format`) pero no pude ejecutarlo (sin red). Hay ~60 líneas de más de 200 caracteres. Corré `npm run format` una vez y luego volvé obligatorio el chequeo en `ci.yml`.
- 🟡 **Sin verificar contra el servicio real:** el script Lua de Redis (las pruebas simulan su lógica; no hay Lua ni Redis acá), los IDs de descriptores de Steam, las clasificaciones de iTunes, y si `maxDuration: 30` lo admite tu plan de Vercel.
- ⬜ No incluido en esta pasada: el resto de P2/P3 del informe (adaptadores de fuentes, URLs compartibles, verificación de email, regiones de la función, guardado incremental, Express 5, etc.).
- Las pruebas corrieron con un reemplazo mínimo de Express hecho a mano (el real no estaba disponible), y el navegador se probó con Chromium headless. Corré `npm ci && npm test` para confirmarlo con el Express real.

# Cambios de la v3.5

**v3.5:** permiso de adultos en Perfil (apagado por defecto; sin cuenta siempre queda apagado). Filtra noticias y juegos +18 con la clasificación de Steam y una lista de palabras: es una heurística, puede dejar pasar o esconder algo.

# Cambios de la v3.4

**v3.4:** las novedades de videojuegos (tarjetas, portada, rankings y búsqueda) abren una ventana con el mini resumen; «Ver más» redirige a la fuente original. Lo demás es la v3.

# Cambios de la v3 (según «Pulso: revisión sin anestesia»)

Estado de cada punto de la revisión. ✅ hecho · 🟡 hecho en parte · ⬜ no se hizo.

| # | Punto | Estado | Qué se hizo / qué falta |
|---|-------|--------|-------------------------|
| 1 | Muro de registro | ✅ | La portada, las secciones y la búsqueda son públicas. Registrarse se pide solo al guardar favoritos o gustos. El modal de gustos ahora es una **oferta** en la portada («Elegir mis gustos» / «Ahora no»). Quien se registra conserva lo que eligió como invitado. |
| 2 | Foco del buscador | ✅ | El foco no se mueve al contenido mientras el buscador sigue enfocado. |
| 3 | Límites en serverless | ✅ | Bloqueo por contraseñas (por IP **y** por cuenta), registros, recuperación y búsquedas de video se cuentan en Redis (`INCR`+`EXPIRE`). El freno general de 120/min sigue siendo por instancia a propósito (no gasta un comando de Redis por pedido). |
| 4 | Cuentas | 🟡 | ✅ «Olvidé mi contraseña» (correo por Resend), ✅ borrado real de cuenta, ✅ cerrar sesión en todos los dispositivos. ⬜ Verificación de email. ⬜ Lista de sesiones. |
| 5 | APIs no oficiales | ⬜ | No hay capa de adaptadores ni pruebas de contrato. Parcial: `/api/home` informa **qué fuente** falló. |
| 6 | Cuota de YouTube | ✅ | Postura: preview de 30 s + «Completa» (apps externas). La canción embebida de YouTube queda **apagada** salvo `YT_MUSIC=1`. Embeds con `youtube-nocookie`. |
| 7 | Portada con ~20 pedidos | 🟡 | ✅ `/api/home` (un solo pedido, cacheado) y aviso cuando la personalización no llegó a tiempo. ⬜ `games/news` sigue pidiendo 14 juegos × 2 llamadas a Steam (ahora detrás de la caché compartida). |
| 8 | Caché por instancia | ✅ | Caché de dos niveles: memoria + Redis compartido. |
| 9 | «Noticiero» sin noticias | ⬜ | Sin fuentes nuevas ni cambio de nombre. |
| 10 | Argentina / voseo | ⬜ | Sin cambios: `region` sigue sin usarse y los textos siguen en voseo. |
| 11 | **Escuchar completa** | ✅ | Botón «Completa» en tarjetas de canciones y en el reproductor, con selector de Spotify, YouTube Music, Apple Music/iCloud, Deezer, Tidal y Amazon Music (enlaces de búsqueda, sin API). «Recordar mi app» + selector en Perfil. |
| 12 | **Juegos: clasificaciones y carga manual** | ✅ | De 6 a 16 géneros y 5 plataformas. Cuadro «Tus juegos favoritos» con sugerencias de Steam (también en Perfil); suman peso a los géneros de cada juego. |
| 13 | «Actualizado ahora» | ✅ | Usa la hora real que devuelve el servidor y se refresca sola. |
| 14 | Sin conexión | ✅ | El service worker guarda las listas de `/api` (nunca datos personales) y la app avisa «datos guardados hace X». |
| 15 | Tarjetas = botones | ✅ | Noticias y juegos usan `<a href>` real. Canciones y tráilers siguen siendo botones (abren el reproductor). |
| 16 | CSS en capas | ⬜ | No se limpió. |
| 17 | Contraste en hover | ✅ | El fondo al pasar el mouse es el acento mezclado con el fondo oscuro. **No se midió en un navegador.** |
| 18 | Tema claro / emojis | 🟡 | ✅ Sin emojis en los gustos. ⬜ Tema claro (hay colores oscuros fijos por todo el CSS). |
| 19 | Reproductor | ✅ | El reloj corre solo mientras suena algo; el video arranca minimizado en pantallas chicas. |
| 20 | Perfil | ✅ | Versionado (`rev`, respuesta 409) y validación de forma y tamaño en el servidor. |
| 21 | Sin build | ⬜ | Sin Vite/esbuild. |
| 22 | Pruebas | 🟡 | ✅ GitHub Actions corre `npm test`; ✅ pruebas nuevas de cuentas, perfil, `/api/home` y almacenamiento. ⬜ Sin pruebas de extremo a extremo ni `axe`. |
| 23 | Código «golf» | ⬜ | Sin Prettier ni partir `server.js`; Express sigue en 4. |
| 24 | Fechas ISO | ✅ | El navegador las formatea con `Intl` (zona e idioma de la persona). |
| 25 | Instalable a medias | ✅ | Íconos PNG 192/512/maskable y `apple-touch-icon`. |
| 26 | Compartible | 🟡 | ✅ `og:image` y `twitter:card` grande. ⬜ Sin páginas por ítem. **`og:image` es relativo: para que las redes lo muestren ponele la dirección completa de tu sitio.** |
| 27 | Seguridad menor | 🟡 | ✅ `/api/health` sin datos internos; ✅ un POST sin `Origin` de otro sitio (según `Sec-Fetch-Site`) se rechaza. ⬜ La CSP sigue permitiendo imágenes de cualquier `https:` (las imágenes de los RSS vienen de muchos sitios). |
| 28 | Región de la función | ⬜ | Hay que medir antes (`gru1` vs `iad1`). |
| 29 | Despliegue frágil | ✅ | `npm run smoke` + workflow `smoke.yml` tras cada despliegue. |
| — | Privacidad | ✅ | `privacidad.html` enlazada en el pie. Es un texto base: revisalo con tus datos de contacto. |
