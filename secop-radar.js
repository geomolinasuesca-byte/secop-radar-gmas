#!/usr/bin/env node
/**
 * SECOP Radar — vigilancia automática de licitaciones públicas (SECOP II)
 * ------------------------------------------------------------------------
 * Consulta la API oficial de datos abiertos de Colombia (Socrata) buscando
 * procesos de contratación que coincidan con las palabras clave / códigos
 * UNSPSC configurados en config.json, y avisa por Telegram cuando aparece
 * algo nuevo.
 *
 * Uso:
 *   node secop-radar.js            -> corre normal, envía alertas nuevas
 *   node secop-radar.js --dry-run  -> corre pero NO envía Telegram, solo imprime
 *
 * Requiere Node 18+ (usa fetch nativo).
 */

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "seen.json");
const CSV_LOG_PATH = path.join(__dirname, "alertas_log.csv");

const DRY_RUN = process.argv.includes("--dry-run");
const SOCRATA_APP_TOKEN = process.env.SOCRATA_APP_TOKEN || null; // opcional, sube el límite de consultas
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;

const BASE_URL = "https://www.datos.gov.co/resource";

function cargarConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function cargarEstado() {
  if (!fs.existsSync(STATE_PATH)) return { vistos: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { vistos: {} };
  }
}

function guardarEstado(estado) {
  // Poda registros de más de 45 días para que el archivo no crezca sin control
  const limite = Date.now() - 45 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(estado.vistos)) {
    if (ts < limite) delete estado.vistos[id];
  }
  fs.writeFileSync(STATE_PATH, JSON.stringify(estado, null, 2));
}

function fechaHaceNDias(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 19); // formato SoQL: YYYY-MM-DDTHH:MM:SS
}

function construirWhere(config) {
  const partes = [`fecha_de_publicacion_del > '${fechaHaceNDias(config.dias_hacia_atras)}'`];
  if (config.excluir_estados?.length) {
    const excl = config.excluir_estados.map((e) => `estado_del_procedimiento != '${e}'`).join(" AND ");
    partes.push(excl);
  }
  return partes.join(" AND ");
}

async function consultarSocrata(params) {
  const url = new URL(`${BASE_URL}/${params.dataset_id}.json`);
  url.searchParams.set("$limit", params.limite || 20);
  url.searchParams.set("$order", "fecha_de_publicacion_del DESC");
  if (params.where) url.searchParams.set("$where", params.where);
  if (params.q) url.searchParams.set("$q", params.q);

  const headers = {};
  if (SOCRATA_APP_TOKEN) headers["X-App-Token"] = SOCRATA_APP_TOKEN;

  const resp = await fetch(url.toString(), { headers });
  if (!resp.ok) {
    throw new Error(`Socrata respondió ${resp.status} para: ${url.toString()}`);
  }
  return resp.json();
}

async function buscarPorPalabrasClave(config) {
  const where = construirWhere(config);
  const encontrados = new Map();

  for (const palabra of config.palabras_clave) {
    try {
      const filas = await consultarSocrata({
        dataset_id: config.dataset_id,
        where,
        q: palabra,
        limite: config.limite_por_consulta,
      });
      for (const fila of filas) {
        encontrados.set(fila.id_del_proceso, { ...fila, _match: `palabra clave: "${palabra}"` });
      }
    } catch (err) {
      console.error(`⚠️  Error buscando "${palabra}":`, err.message);
    }
    await new Promise((r) => setTimeout(r, 300)); // no saturar la API
  }
  return encontrados;
}

async function buscarPorUnspsc(config, acumulado) {
  const where = construirWhere(config);
  for (const prefijo of config.prefijos_unspsc || []) {
    const whereConUnspsc = `${where} AND starts_with(codigo_principal_de_categoria, '${prefijo}')`;
    try {
      const filas = await consultarSocrata({
        dataset_id: config.dataset_id,
        where: whereConUnspsc,
        limite: config.limite_por_consulta,
      });
      for (const fila of filas) {
        if (!acumulado.has(fila.id_del_proceso)) {
          acumulado.set(fila.id_del_proceso, { ...fila, _match: `UNSPSC: ${prefijo}` });
        }
      }
    } catch (err) {
      console.error(`⚠️  Error buscando UNSPSC "${prefijo}":`, err.message);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

function formatearAlerta(fila) {
  const valor = fila.precio_base ? Number(fila.precio_base).toLocaleString("es-CO") : "no especificado";
  const url = fila.urlproceso?.url || "https://www.colombiacompra.gov.co";
  return (
    `🛰️ *Nueva licitación relevante*\n\n` +
    `*Entidad:* ${fila.entidad || "?"}\n` +
    `*Objeto:* ${(fila.descripci_n_del_procedimiento || fila.nombre_del_procedimiento || "").slice(0, 300)}\n` +
    `*Valor base:* $${valor} COP\n` +
    `*Ciudad:* ${fila.ciudad_entidad || "no definida"}\n` +
    `*Estado:* ${fila.estado_del_procedimiento || "?"}\n` +
    `*Coincidió por:* ${fila._match}\n` +
    `*Enlace:* ${url}`
  );
}

async function enviarTelegram(texto) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("ℹ️  Telegram no configurado (faltan TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID). Solo se imprime la alerta.");
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: texto, parse_mode: "Markdown" }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    console.error("⚠️  Error enviando a Telegram:", resp.status, body);
  }
}

function registrarEnCsv(filas) {
  const encabezado = "id_del_proceso,entidad,objeto,valor_base,ciudad,estado,coincidio_por,url,fecha_deteccion\n";
  const existe = fs.existsSync(CSV_LOG_PATH);
  if (!existe) fs.writeFileSync(CSV_LOG_PATH, encabezado);

  const lineas = filas.map((fila) => {
    const campos = [
      fila.id_del_proceso,
      fila.entidad,
      (fila.descripci_n_del_procedimiento || "").replace(/[\n,"]/g, " "),
      fila.precio_base || "",
      fila.ciudad_entidad || "",
      fila.estado_del_procedimiento || "",
      fila._match,
      fila.urlproceso?.url || "",
      new Date().toISOString(),
    ];
    return campos.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",");
  });
  fs.appendFileSync(CSV_LOG_PATH, lineas.join("\n") + "\n");
}

async function main() {
  console.log(`\n🛰️  SECOP Radar — corriendo ${DRY_RUN ? "(modo prueba, sin enviar Telegram)" : ""}`);
  const config = cargarConfig();
  const estado = cargarEstado();

  const encontrados = await buscarPorPalabrasClave(config);
  await buscarPorUnspsc(config, encontrados);

  const nuevos = [...encontrados.values()].filter((fila) => !estado.vistos[fila.id_del_proceso]);

  console.log(`🔎 ${encontrados.size} coincidencias totales, ${nuevos.length} son nuevas desde la última corrida.`);

  if (nuevos.length === 0) {
    console.log("Nada nuevo por ahora. ✅");
    return;
  }

  for (const fila of nuevos) {
    const mensaje = formatearAlerta(fila);
    console.log("\n" + mensaje + "\n" + "-".repeat(50));
    if (!DRY_RUN) {
      await enviarTelegram(mensaje);
      estado.vistos[fila.id_del_proceso] = Date.now();
    }
  }

  if (!DRY_RUN) {
    registrarEnCsv(nuevos);
    guardarEstado(estado);
    console.log(`\n💾 Estado guardado. ${nuevos.length} alertas nuevas registradas en alertas_log.csv`);
  } else {
    console.log("\n(modo prueba: no se guardó estado ni se envió nada a Telegram)");
  }
}

main().catch((err) => {
  console.error("❌ Error fatal:", err);
  process.exit(1);
});
