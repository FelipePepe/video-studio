# Feature: video-studio — relanzar pipeline tras fallo (retry con corrección)

- **Rama**: por crear sobre `develop` (o apilada en #12 — decisión al aprobar el plan)
- **Alcance**: solo `frontend/` + ADR + esta doc. **Backend SIN cambios** (el gate ya permite retry sobre failed/cancelled: `routes/pipeline.ts:137-142`).
- **Evidencia**: `routes/pipeline.ts` ("only a failed or cancelled latest job may be retried"); `usePipeline` con approve() y estado 'failed'; `Job.draftId` presente en `api/types.ts` y `jobs/types.ts`.

## Objetivo

Hacer **corregir + relanzar** un flujo de primera clase:
1. Tras un fallo, volver al editor de escenas, corregir, y relanzar desde ahí.
2. Desde Jobs: botón Reintentar en cada job failed/cancelled.

## Corrección de alcance (trazable)

- **Existía ya**: en estado `failed`, `VideoPanel` muestra botón "Reintentar" (video.retry) que vuelve a aprobar (test: *failure shows the error and Retry approves again*). No se toca el backend ni esa ruta.
- **Qué falta (verificado)**: (a) desde `failed` NO hay cómo llegar al editor (condición PipelinePage solo 'review'), (b) JobsPage no tiene acción por job failed/cancelled (solo done→output, active→cancel).

## Decisions

| # | Decisión | Evidencia |
|---|----------|-----------|
| 1 | Backend intacto: 409 solo bloquea active/done en latest job | pipeline.ts:137-142, test approve.routes 409 |
| 2 | PipelinePage: `ReviewPanel` visible en `state==='review'` **o** `(state==='failed' && draft)` | PipelinePage.tsx condicional actual (solo 'review') |
| 3 | ReviewPanel ya recibe `error` y muestra alerts → reutilizar tal cual | ReviewPanel.tsx props |
| 4 | JobsPage: botón Reintentar (failed/cancelled) → POST approve de j.draftId, con estado de "reintentando" | JobsPage.tsx (hoy solo cancel/output), i18n ya tiene jobs.retry (usada para el list-error — añadir **retryJob/retrying/retryFailed** para no confundir con jobs.retry del list) |
| 5 | App.tsx: extender jobsApi con approveDraft (defaultApi ya lo tiene) | App.tsx jobsApi pick |
| 6 | ADR 0001 D1 CORREGIR: la frase "one-shot/409" omite la cláusula retry (mi error) | ADR docs/adr/0001 |

## Checklist

- [ ] feature branch
- [ ] doc + mirror Engram (esta)
- [ ] TESTS RED: PipelinePage failed→editor visible, approve relanza; JobsPage retry failed/cancelled (y que NO aparezca en done/active/queued/running)
- [ ] PipelinePage: condicional de ReviewPanel + error passthrough
- [ ] JobsPage: botón Reintentar + estado "reintentando" + i18n ES/EN
- [ ] App.tsx: wire approveDraft
- [ ] tests GREEN (148 + nuevos), typecheck, build, lint skill
- [ ] ADR D1 corregido (repo + cbm)
- [ ] commit (work unit), PR
- [ ] reporte + logbook + Engram

## Evidencia de verificación

(los runners reales van aquí)

## Progress

explorado; plan aprobado; RED en curso. Decisión UX: en `failed` el ReviewPanel reemplaza el grid (el Reintentar de VideoPanel pasa al "Aprobar y generar" del panel, con opción de corregir antes).
