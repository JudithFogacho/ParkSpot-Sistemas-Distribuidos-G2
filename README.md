# ParkSpot — Sistema distribuido de reserva de estacionamientos

Proyecto de **Sistemas Distribuidos (Grupo 2)**. Integra la disponibilidad de varios estacionamientos independientes
(universidad, centro comercial, hospital) para que los usuarios consulten y reserven espacios de forma **confiable,
incluso ante fallos parciales de conectividad**.

> **Supuesto del proyecto:** no hay conexión con sensores reales. Cada nodo **simula** sus sensores, que ocupan y
> liberan espacios aleatoriamente según una tasa de ocupación configurada en `config/lots.json`.

---

## 1. Problema

- Cada estacionamiento maneja su información por separado → el usuario recorre varios lugares.
- Si un estacionamiento pierde conectividad, su información queda **desactualizada**.
- Dos usuarios pueden intentar ocupar **el mismo espacio** (conflicto).

## 2. Arquitectura

```
                    ┌──────────────────────────────┐
  Navegador  ◄─SSE──┤  GATEWAY / AGREGADOR  :3000  │◄── heartbeats (push cada 2 s) ──┐
  (SPA)      ──HTTP─►  · caché integrada            │                                 │
                    │  · estado de conexión         │── reservas (reenvío + retry) ──┐│
                    │  · fail-fast / reintentos     │                                ││
                    └──────────────────────────────┘                                ▼│
              ┌───────────────────┬───────────────────┬───────────────────┐
              │ Nodo UC  :4001    │ Nodo CC  :4002    │ Nodo HM  :4003    │
              │ Universidad       │ Centro Comercial  │ Hospital          │
              │ · sensores simul. │ · sensores simul. │ · sensores simul. │
              │ · BD propia (JSON)│ · BD propia (JSON)│ · BD propia (JSON)│
              │ · AUTORIDAD de    │ · AUTORIDAD de    │ · AUTORIDAD de    │
              │   sus espacios    │   sus espacios    │   sus espacios    │
              └───────────────────┴───────────────────┴───────────────────┘
```

| Componente | Archivo | Responsabilidad |
|---|---|---|
| Nodo de estacionamiento | `src/node/server.js` | Fuente de verdad de sus espacios y reservas, persistencia local, sensores simulados, heartbeats, simulación de fallos de red |
| Gateway / agregador | `src/gateway/server.js` | Integra la información de todos los nodos, calcula frescura, reenvía reservas al nodo dueño, tiempo real (SSE), sirve el frontend |
| Frontend | `public/` | Las 4 pantallas del prototipo + panel de simulación (`/admin`) |

Cada nodo es un **proceso independiente** (puerto, memoria y archivo de datos propios). Con Docker, cada uno corre en
**su propio contenedor** con su propio volumen.

## 3. Decisiones de diseño (conceptos de sistemas distribuidos)

### 3.1 Partición de datos y autoridad única
Cada espacio pertenece a **un solo nodo**. Las reservas **no** se deciden en el gateway: se reenvían al nodo dueño, que
valida y escribe de forma atómica (Node.js procesa la validación y la escritura sin interrupciones). Por eso **dos
usuarios nunca pueden obtener el mismo espacio**, aunque lleguen al mismo tiempo (probado con 20 solicitudes
concurrentes: 1 gana, 19 reciben `409 Conflict`).

### 3.2 Teorema CAP: lecturas disponibles, escrituras consistentes
- **Lecturas (AP):** el gateway responde desde su caché aunque un nodo falle, y **muestra la frescura** del dato
  (“Información actualizada”, “Posiblemente desactualizada”, “Sin datos recientes”).
- **Escrituras (CP):** una reserva solo se confirma si el nodo dueño la acepta. Si el nodo está sin conexión,
  la reserva se rechaza (`503`, “Reserva no disponible”) en lugar de arriesgar un conflicto.

### 3.3 Detección de fallos por heartbeats
Los nodos envían su snapshot cada 2 s. Según la antigüedad del último heartbeat recibido:

| Antigüedad | Estado | En la interfaz |
|---|---|---|
| < 6 s | `online` | 🟢 Información actualizada |
| 6 – 15 s | `intermittent` | 🟠 Posiblemente desactualizada (la reserva se intenta, el nodo la valida) |
| > 15 s | `offline` | ⚪ Sin datos recientes · Reserva no disponible |

Se usa el reloj **del gateway** (momento de recepción) para medir la antigüedad, evitando problemas de relojes
desincronizados entre máquinas.

### 3.4 Versionado (reloj lógico) y mensajes fuera de orden
Cada cambio en un nodo incrementa `version`. El gateway descarta un snapshot con versión menor a la que ya tiene
(un heartbeat atrasado nunca pisa uno más reciente). El campo `epoch` identifica la “vida” del estado, por si se
reinicia la base de datos de un nodo.

### 3.5 Reintentos + idempotencia
El gateway reenvía cada reserva con **timeout de 2,5 s y hasta 3 intentos con backoff exponencial**. Cada solicitud
lleva una **clave de idempotencia** generada por el cliente: si la respuesta se pierde en la red y se reintenta, el nodo
devuelve la reserva ya creada en vez de crear otra. Si después de 3 intentos no hay respuesta, el usuario ve
“No pudimos confirmar… reintenta” y el botón reutiliza la misma clave.

### 3.6 Fail-fast (circuit breaker simple)
Si un nodo está `offline`, el gateway rechaza inmediatamente las reservas sin esperar timeouts.

### 3.7 Operación autónoma y reconciliación
Mientras un nodo está desconectado, **sus sensores siguen funcionando** y su estado local sigue cambiando y
persistiéndose. Al reconectarse envía su snapshot completo y el gateway registra la reconciliación
(“reconciliado v12 → v31, 19 cambios ocurridos sin conexión”).

### 3.8 Persistencia y recuperación
Cada nodo guarda su estado en `data/<ID>.json` con **escritura atómica** (archivo temporal + renombrado). Si el proceso
se detiene, al reiniciar recupera espacios, reservas y claves de idempotencia.

### 3.9 Otras reglas
- Las reservas expiran 15 min después de la hora de llegada si nadie las usa (el espacio se libera).
- El usuario puede **cancelar** una reserva activa desde la pantalla de confirmación o desde “Mis reservas” en el
  inicio (con confirmación en dos pasos). La cancelación también la decide el nodo dueño: libera el espacio al instante
  y el cambio llega a todos los usuarios en tiempo real. Si el estacionamiento está sin conexión, la cancelación se
  rechaza con un aviso para reintentar más tarde.
- “Recomendado” = estacionamiento en línea con mejor relación espacios libres / distancia.

## 4. Cómo ejecutar

Requisito: **Node.js 20 o superior**. No hay dependencias que instalar.

```bash
npm start
```

- Aplicación: <http://localhost:3000>
- Panel de simulación: <http://localhost:3000/admin>

### Con Docker (cada nodo en su propio contenedor)

```bash
docker compose up --build
```

Para simular la **caída real** de un estacionamiento:

```bash
docker compose stop node-hm
```

```bash
docker compose start node-hm
```

### Ejecutar cada proceso por separado (por ejemplo, en máquinas distintas)

```bash
npm run gateway
```

```bash
LOT_ID=UC GATEWAY_URL=http://IP_DEL_GATEWAY:3000 SELF_URL=http://IP_DE_ESTE_NODO:4001 node src/node/server.js
```

En el gateway, indicar dónde está cada nodo con `NODE_URLS=UC=http://IP:4001,CC=http://IP:4002,HM=http://IP:4003`.

### Pruebas automáticas

```bash
npm test
```

Verifica: registro de nodos, reserva, idempotencia, conflicto (409), 20 reservas concurrentes → 1 ganadora,
cancelación, nodo offline → 503 sin afectar a los demás, reconexión y reconciliación, y modo intermitente sin
reservas duplicadas.

### Reiniciar los datos

```bash
npm run reset
```

## 5. Guion sugerido para la demostración

1. Abrir la app y el panel `/admin` lado a lado. Mostrar cómo los espacios cambian en vivo (sensores simulados).
2. **Concurrencia:** en el panel, “Simular 2 usuarios reservando el mismo espacio” → uno obtiene `201`, el otro `409`.
3. **Fallo intermitente:** poner *Centro Comercial* en “Intermitente”. En la app aparece “Posiblemente
   desactualizada”; en el registro se ven reintentos, snapshots fuera de orden descartados y reintentos idempotentes.
4. **Caída total:** poner *Hospital* en “Sin conexión”. Tras ~15 s: “Sin datos recientes · Reserva no disponible”.
   Los otros estacionamientos siguen funcionando (fallo **parcial**).
5. **Recuperación:** volver a “En línea” → reconciliación automática con los cambios ocurridos durante la desconexión.
6. Detener un proceso (Ctrl+C del nodo o `docker compose stop`) y reiniciarlo: recupera su estado desde disco.

## 6. API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/lots` | Lista integrada con estado, libres, distancia y frescura |
| GET | `/api/lots/:id` | Detalle con espacios (lectura directa al nodo, con respaldo en caché) |
| POST | `/api/lots/:id/reservations` | `{ spaceId, arrivalTime, userId, idempotencyKey }` → 201 / 200 (reintento) / 409 / 503 / 504 |
| GET / DELETE | `/api/lots/:id/reservations/:code` | Consultar / cancelar reserva |
| GET | `/api/events` | Server-Sent Events (`lots`, `lot`, `log`) |
| POST | `/api/admin/nodes/:id/network` | `{ mode: online \| intermittent \| offline }` |
| POST | `/api/admin/nodes/:id/conflict-demo` | Dos reservas simultáneas al mismo espacio |
| POST | `/internal/sync` | Heartbeat de un nodo (uso interno) |

## 7. Limitaciones y trabajo futuro

- **Sensores simulados**: no hay integración con hardware real (supuesto del proyecto).
- **Un solo gateway** por defecto. Los nodos ya admiten varios (`GATEWAY_URLS=http://gw1:3000,http://gw2:3000`):
  cada gateway reconstruye su caché a partir de los heartbeats en segundos, por lo que se pueden poner varios detrás de
  un balanceador para eliminar el punto único de fallo.
- Un nodo no se replica: si su máquina se pierde de forma permanente se pierden sus datos (se podría replicar con un
  esquema líder-seguidor o consenso tipo Raft).
- Sin autenticación de usuarios (fuera del alcance).
- La ubicación del usuario es fija (“Av. Universidad”) y las distancias están configuradas.

## 8. Estructura

```
config/lots.json        Definición de estacionamientos (pasillos, puertos, distancia, ocupación)
src/shared/util.js      Utilidades HTTP, timeouts y escritura atómica
src/node/server.js      Nodo de estacionamiento
src/gateway/server.js   Gateway / agregador
scripts/start-all.js    Lanza gateway + 3 nodos en procesos separados
scripts/test-e2e.js     Pruebas de extremo a extremo
public/                 Frontend (index.html, app.js, styles.css, admin.html)
Dockerfile, docker-compose.yml
```
