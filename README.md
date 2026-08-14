# SECOP Radar — piloto Gmas

Vigila automáticamente las licitaciones públicas nuevas en Colombia (SECOP II) que
coincidan con los servicios de Gmas (DRX, FRX, SEM, cartografía geológica, geofísica,
petrofísica, laboratorio de suelos, etc.) y avisa por Telegram apenas aparece algo.

## Aviso importante sobre dónde correr esto

Este código **no puede ejecutarse dentro del entorno donde Claude lo generó** (esa nube
de trabajo solo tiene acceso a un puñado de dominios permitidos, y ni la API de SECOP ni
la de Telegram están en esa lista). Eso es normal y no es un defecto del código — ya se
probó la lógica completa con datos reales de ejemplo (ver `mock_run.js`) y con consultas
en vivo a la API real durante la conversación con Claude, que sí devolvieron licitaciones
reales y vigentes.

La forma más simple, confiable y **gratuita** de correrlo de verdad es con
**GitHub Actions** (ya viene configurado en `.github/workflows/secop-radar.yml`). No
necesitas un servidor propio.

## Puesta en marcha (una sola vez, ~15 minutos)

1. **Crea un repositorio en GitHub** (puede ser privado) y sube el contenido de esta
   carpeta a la raíz del repositorio (no la carpeta "app" en sí, sino lo que hay adentro:
   `secop-radar.js`, `config.json`, `.github/`, etc.).

2. **Crea tu bot de Telegram:**
   - Abre Telegram y búscate a `@BotFather`.
   - Envíale `/newbot` y sigue las instrucciones (nombre, usuario del bot).
   - Te va a dar un **token** parecido a `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` — guárdalo.

3. **Obtén tu chat_id:**
   - Envíale cualquier mensaje a tu bot recién creado (para "activarlo").
   - Visita en el navegador: `https://api.telegram.org/bot<TU_TOKEN>/getUpdates`
   - Busca el campo `"chat":{"id": ...}` — ese número es tu `chat_id`.
   - (Alternativa más simple: háblale al bot `@userinfobot`, te da tu ID directamente.)

4. **Configura los secretos en GitHub:**
   - En tu repositorio: `Settings` → `Secrets and variables` → `Actions` → `New repository secret`.
   - Crea `TELEGRAM_BOT_TOKEN` con el token del paso 2.
   - Crea `TELEGRAM_CHAT_ID` con el número del paso 3.
   - (Opcional pero recomendado) Regístrate gratis en https://dev.socrata.com/register
     y crea `SOCRATA_APP_TOKEN` — evita que te limiten las consultas cuando el proyecto crezca.

5. **Dale permisos de escritura al workflow** (para que pueda guardar qué alertas ya envió
   y no te las repita):
   - `Settings` → `Actions` → `General` → `Workflow permissions` → marca
     **"Read and write permissions"** → Guardar.

6. **Pruébalo manualmente:**
   - Pestaña `Actions` de tu repositorio → selecciona `SECOP Radar` → botón `Run workflow`.
   - Revisa los logs: debería mostrarte las licitaciones que encontró y, si configuraste
     Telegram bien, deberías recibir los mensajes en tu chat en segundos.

Desde ahí, corre solo cada 6 horas, sin que tengas que hacer nada. Es 100% gratis dentro
de los límites normales de uso de GitHub Actions (muy por encima de lo que este proyecto necesita).

## Ajustar qué vigila

Todo se controla desde `config.json`:

- `palabras_clave`: agrega o quita términos según lo que le interese a Gmas.
- `prefijos_unspsc`: códigos UNSPSC de respaldo (menos dependientes del texto exacto).
  Verifica/ajusta los códigos con el buscador oficial:
  https://www.colombiacompra.gov.co/secop/consulta-codigo-unspsc
- `dias_hacia_atras`: qué tan atrás mirar en cada corrida (por defecto 5 días).
- `excluir_estados`: por defecto excluye procesos "Cancelado".

No necesitas tocar `secop-radar.js` para ajustar el radar — solo el `config.json`.

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `secop-radar.js` | El programa principal. |
| `config.json` | Palabras clave, códigos UNSPSC, y demás ajustes. |
| `mock_run.js` | Prueba de humo con datos de ejemplo, sin tocar la red real (`node mock_run.js`). |
| `seen.json` | Se crea solo — memoria de qué licitaciones ya se alertaron. |
| `alertas_log.csv` | Se crea solo — historial de todas las alertas enviadas, para revisar después. |
| `.github/workflows/secop-radar.yml` | La automatización que lo corre cada 6 horas gratis. |

## Probar en tu computador antes de subirlo (opcional)

Si tienes Node 18+ instalado:

```bash
node mock_run.js          # prueba con datos de ejemplo, sin red real
node secop-radar.js --dry-run   # prueba con la API real, pero sin enviar Telegram
node secop-radar.js       # corrida real (necesita TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID en el entorno)
```
