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
- [x] CSS bar charts (reemplazaron Chart.js — ~65kb ahorrados)
- [x] Review score dots con glow (Steam appreviews API)
- [x] Carrito virtual (FAB + sidebar + checkbox en cards + localStorage)
- [x] Cart sidebar footer (GitHub, Portfolio, Cafecito + preparado para notificaciones)

---

## Nota importante sobre el comportamiento de datos

- La app **solo trae juegos en oferta**, no toda la wishlist completa (~360 juegos)
- Cuando un juego deja de estar en descuento, desaparece de los resultados
- Steam actualiza precios/descuentos a las **14:00 hs Argentina (17:00 UTC)**
- Es muy raro que aparezcan descuentos nuevos fuera de ese horario
- Por lo tanto, los cambios relevantes ocurren una vez por día alrededor de las 14hs

---

## Fase 1 - Caché y consistencia de datos

### 1.1 Cache Cheapshark + Reviews en Cloudflare Worker (Cache API)
**Problema**: 360 juegos en la wishlist, procesados en lotes de 10. Sin cache: 4 subrequests por juego = 40 por lote (80% del limite de 50 en free plan). CheapShark tiembla mucho causando resultados inconsistentes.

**Solucion implementada**: [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) de Cloudflare con diferentes TTLs segun el tipo de dato:

- Steam appdetails: **NO cacheado** — precios actuales, siempre fresco
- Steam appreviews: **7 dias TTL** — los reviews rara vez cambian, y si un juego sale de oferta probablemente no vuelva a aparecer en una semana
- CheapShark (search + game data combinados): **12h TTL** — datos historicos, cambian infrecuentemente
- Cache key: `cs:{appId}` y `rev:{appId}` usando namespace `steamdeals-cache.local`
- Solo se cachea si el fetch fue exitoso (OK) — si falla, se reintenta en la proxima llamada
- Datos procesados cacheados (no respuestas raw) — payload minimo

**Impacto en subrequests**:
| Escenario | Subreqs/juego | Subreqs/lote (10) | % del limite |
|---|---|---|---|
| Sin cache (cold) | 4 | 40 | 80% |
| Con cache (warm) | 1 | 10 | 20% |

**Archivos**: `worker.js` ✅ implementado

### 1.2 Cache del ultimo resultado en localStorage
**Problema**: Cada vez que se abre la app, hay que esperar a que procese toda la wishlist.

**Solucion**:
- Guardar el ultimo resultado completo en localStorage con timestamp
- Al abrir la app: si hay cache < 6-12hs, mostrar inmediatamente (carga instantanea)
- Paralelamente, ejecutar fetch fresco en background
- Cuando llega el resultado nuevo, reemplazar cache y re-renderizar
- **Timestamp inteligente**: si el cache es de antes de las 14:00hs AR y ya pasaron las 14:00hs, forzar fetch fresco (porque Steam ya refrescó precios)

**Beneficios**:
- Carga instantanea para el usuario
- Datos siempre frescos (se actualizan en background)
- Respetar el ciclo de precios de Steam (14:00hs AR)

**Archivos**: `index.html`

### 1.3 Comparacion cache vs fresco (badges de cambio)
**Beneficio extra del cache**: al tener "lo que habia ayer" vs "lo que hay hoy", podemos detectar cambios. Como Steam refresca a las 14hs, la comparación tiene sentido una vez por día:

**Eventos detectables**:
- `NUEVO EN OFERTA` - Juego que no estaba en descuento ayer y hoy aparece
- `SALIÓ DE OFERTA` - Juego que estaba en descuento ayer y hoy ya no está (podría mostrarse en gris al final de la lista o simplemente no aparecer)
- `BAJÓ DE PRECIO` - Juego que ya estaba en oferta pero mejoró su descuento %
- `SUBIÓ DE PRECIO` - Juego que sigue en oferta pero empeoró su descuento % (menos probable pero posible)

**Archivos**: `index.html`

---

## Fase 2 - Notificaciones proactivas (futuro)

### Opcion A - Comparacion local (sin backend extra)
- Usar el cache de localStorage para comparar cada vez que se abre la app
- Zero infraestructura extra
- Notificaciones dentro de la app (badges, toasts)
- Ideal para uso casual: abrir la app después de las 14hs y ver qué cambió

### Opcion B - Cloudflare KV + GitHub Actions cron
- KV store gratuito que viene con Cloudflare Workers
- Guardar snapshot diario: `key = "YYYY-MM-DD"`, `value = JSON con deals`
- Cron ejecutarse después de las 14:00hs AR (ej: 14:30hs = 17:30 UTC) para capturar el refresh
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
