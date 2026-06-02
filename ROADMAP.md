# SteamDeals - Roadmap de Mejoras

## Estado actual

- [x] Dark theme con dot grid
- [x] Header con branding (WISHLIST white + DEALS #00E205)
- [x] Cards con cover images, link a Steam Store
- [x] Toolbar: busqueda, ordenamiento (descuento, precio, nombre), slider descuento minimo
- [x] Fade-in animations en cards
- [x] Badges historicas (NUEVO RECORD / IGUALO MEJOR / POR DEBAJO)
- [x] Worker con User-Agent header (Cheapshark fix)
- [x] SteamID y API key persistidos en localStorage

---

## Fase 1 - Caché y consistencia de datos

### 1.1 Cache Cheapshark en Cloudflare Worker (Cache API)
**Problema**: La wishlist tiene ~82 juegos pero el Worker trae resultados inconsistentes (34-74 juegos). Causa: timeouts al hacer ~82 subrequests a Cheapshark por invocacion. Cloudflare Workers tiene limites de 50 subrequests (free plan) y 30s wall time.

**Solucion**: Usar el [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) de Cloudflare para cachear las respuestas de Cheapshark. Los precios historicos no cambian todos los dias.

- Cachear por 12-24hs las respuestas de `/api/1.0/games?steamAppID=X` y `/api/1.0/games?id=X`
- Reducir drásticamente las llamadas a Cheapshark por invocacion
- Eliminar timeouts y hacer el Worker mas rapido
- Key de cache: `cheapshark-${gameId}` con TTL de 12h

**Archivos**: `worker.js`

### 1.2 Cache del ultimo resultado en localStorage
**Problema**: Cada vez que se abre la app, hay que esperar a que procese toda la wishlist.

**Solucion**:
- Guardar el ultimo resultado completo en localStorage con timestamp
- Al abrir la app: si hay cache < 6-12hs, mostrar inmediatamente (carga instantanea)
- Paralelamente, ejecutar fetch fresco en background
- Cuando llega el resultado nuevo, reemplazar cache y re-renderizar

**Beneficios**:
- Carga instantanea para el usuario
- Datos siempre frescos (se actualizan en background)

**Archivos**: `index.html`

### 1.3 Comparacion cache vs fresco (badges de cambio)
**Beneficio extra del cache**: al tener "lo que habia ayer" vs "lo que hay hoy", podemos detectar cambios:

- Si un juego tiene mejor descuento que la ultima vez → destacar con badge "BAJO DE PRECIO" o similar
- Si aparece un juego nuevo en oferta → destacar
- Si subio de precio → indicar "SUBIO"

**Archivos**: `index.html`

---

## Fase 2 - Notificaciones proactivas (futuro)

### Opcion A - Comparacion local (sin backend extra)
- Usar el cache de localStorage para comparar cada vez que se abre la app
- Zero infraestructura extra
- Notificaciones dentro de la app (badges, toasts)

### Opcion B - Cloudflare KV + GitHub Actions cron
- KV store gratuito que viene con Cloudflare Workers
- Guardar snapshot diario: `key = "YYYY-MM-DD"`, `value = JSON con deals`
- GitHub Actions cron llama al Worker, compara KV[hoy] vs KV[ayer]
- Enviar resultados via Discord webhook, email, etc.
- Mas complejo pero poderoso

### Opcion C - GitHub Actions + JSON en repo
- Cron job llama al Worker → genera JSON → commit al repo
- Compara contra JSON del dia anterior
- Simple pero "sucio" (repo lleno de commits automaticos)

---

## Ideas sueltas (sin prioridad definida)

- [ ] Mejorar manejo de errores (juegos sin precio, API caida, etc.)
- [ ] Pantalla de "sin resultados" cuando ningun juego matchea los filtros
- [ ] Limpiar endpoint debug del Worker
- [ ] Purgar cache de Cheapshark manualmente si un juego cambia de precio
- [ ] Estadisticas globales: ahorro total, mejor deal encontrado, etc.
- [ ] Paginacion para wishlists muy grandes (100+ juegos)
- [ ] Exportar resultados a CSV/JSON
