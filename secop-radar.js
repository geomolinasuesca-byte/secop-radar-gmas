#!/usr/bin/env node
/**
 * SECOP Radar — vigilancia automática de licitaciones públicas (SECOP II), multi-cliente
 * -----------------------------------------------------------------------------------------
 * Para CADA cliente en la carpeta clientes/ (excepto la plantilla), busca licitaciones que
 * coincidan con sus palabras clave y le manda UN SOLO correo diario con el resumen.
 *
 * Además, para los clientes marcados con "incluir_top_valor_nacional": true, agrega al
 * correo una sección con el Top 10 de las licitaciones de mayor valor DENTRO DE CADA
 * DEPARTAMENTO (sin filtrar por palabra clave — aplica a cualquier tipo de servicio).
 *
 * Para agregar un cliente: corre `node agregar_cliente.js` (te va preguntando los datos),
 * o copia manualmente la carpeta clientes/_plantilla/.
 *
 * Uso:
 *   node secop-radar.js            -> corre normal, envía correos (y Telegram si está activo)
 *   node secop-radar.js --dry-run  -> corre pero NO envía nada, solo imprime en consola
 *
 * Requiere Node 18+ (usa fetch nativo) y el paquete "nodemailer" (ver package.json).
 */

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config.json");
const CLIENTES_DIR = path.join(__dirname, "clientes");
const CSV_LOG_PATH = path.join(__dirname, "alertas_log.csv");

const DRY_RUN = process.argv.includes("--dry-run");
const SOCRATA_APP_TOKEN = process.env.SOCRATA_APP_TOKEN || null;

const EMAIL_USER = process.env.EMAIL_USER || null; // la cuenta de Gmail que ENVÍA los correos
const EMAIL_APP_PASSWORD = process.env.EMAIL_APP_PASSWORD || null;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || null;

const BASE_URL = "https://www.datos.gov.co/resource";

function cargarConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

// ---------- Clientes ----------
function cargarClientes() {
  if (!fs.existsSync(CLIENTES_DIR)) return [];
  const carpetas = fs
    .readdirSync(CLIENTES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "_plantilla")
    .map((d) => d.name);

  const clientes = [];
  for (const slug of carpetas) {
    const dir = path.join(CLIENTES_DIR, slug);
    const clienteJsonPath = path.join(dir, "cliente.json");
    const palabrasPath = path.join(dir, "palabras_clave.txt");

    if (!fs.existsSync(clienteJsonPath)) {
      console.log(`⚠️  clientes/${slug}/ no tiene cliente.json — se omite.`);
      continue;
    }
    const info = JSON.parse(fs.readFileSync(clienteJsonPath, "utf8"));
    if (info.activo === false) {
      console.log(`⏸️  Cliente "${info.nombre || slug}" está marcado como inactivo — se omite.`);
      continue;
    }

    let palabrasClave = [];
    if (fs.existsSync(palabrasPath)) {
      palabrasClave = fs
        .readFileSync(palabrasPath, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"));
    }

    clientes.push({
      slug,
      nombre: info.nombre || slug,
      email: info.email,
      incluirTopValorNacional: !!info.incluir_top_valor_nacional,
      palabrasClave,
      seenPath: path.join(dir, "seen.json"),
    });
  }
  return clientes;
}

function cargarEstado(seenPath) {
  if (!fs.existsSync(seenPath)) return { vistos: {} };
  try {
    return JSON.parse(fs.readFileSync(seenPath, "utf8"));
  } catch {
    return { vistos: {} };
  }
}

function guardarEstado(seenPath, estado) {
  const limite = Date.now() - 45 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(estado.vistos)) {
    if (ts < limite) delete estado.vistos[id];
  }
  fs.writeFileSync(seenPath, JSON.stringify(estado, null, 2));
}

function fechaHaceNDias(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 19);
}

// ---------- Consultas a la API de SECOP (Socrata) ----------
async function consultarSocrata(params) {
  const url = new URL(`${BASE_URL}/${params.dataset_id}.json`);
  url.searchParams.set("$limit", params.limite || 20);
  url.searchParams.set("$order", params.orden || "fecha_de_publicacion_del DESC");
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

function construirWhereBase(diasHaciaAtras, excluirEstados) {
  const partes = [`fecha_de_publicacion_del > '${fechaHaceNDias(diasHaciaAtras)}'`];
  if (excluirEstados?.length) {
    partes.push(excluirEstados.map((e) => `estado_del_procedimiento != '${e}'`).join(" AND "));
  }
  return partes.join(" AND ");
}

async function buscarParaCliente(config, palabrasClave) {
  const where = construirWhereBase(config.dias_hacia_atras, config.excluir_estados);
  const encontrados = new Map();

  for (const palabra of palabrasClave) {
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
    await new Promise((r) => setTimeout(r, 250));
  }

  for (const prefijo of config.prefijos_unspsc || []) {
    const whereConUnspsc = `${where} AND starts_with(codigo_principal_de_categoria, '${prefijo}')`;
    try {
      const filas = await consultarSocrata({
        dataset_id: config.dataset_id,
        where: whereConUnspsc,
        limite: config.limite_por_consulta,
      });
      for (const fila of filas) {
        if (!encontrados.has(fila.id_del_proceso)) {
          encontrados.set(fila.id_del_proceso, { ...fila, _match: `UNSPSC: ${prefijo}` });
        }
      }
    } catch (err) {
      console.error(`⚠️  Error buscando UNSPSC "${prefijo}":`, err.message);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return encontrados;
}

// ---------- Top 10 por departamento (sin filtro de palabra clave) ----------
async function buscarTopValorPorDepartamento(config) {
  const cfg = config.top_valor_por_departamento;
  if (!cfg) return {};

  const rutaDeptos = path.join(__dirname, cfg.archivo_departamentos || "departamentos.json");
  const departamentos = fs.existsSync(rutaDeptos) ? JSON.parse(fs.readFileSync(rutaDeptos, "utf8")) : [];

  const where = construirWhereBase(cfg.dias_hacia_atras, cfg.excluir_estados);
  const resultado = {};

  for (const depto of departamentos) {
    const whereDepto = `${where} AND departamento_entidad = '${depto.replace(/'/g, "''")}' AND precio_base > ${cfg.valor_minimo || 0}`;
    try {
      const filas = await consultarSocrata({
        dataset_id: config.dataset_id,
        where: whereDepto,
        orden: "precio_base DESC",
        limite: cfg.limite_por_departamento || 10,
      });
      if (filas.length > 0) resultado[depto] = filas;
    } catch (err) {
      console.error(`⚠️  Error buscando top valor en "${depto}":`, err.message);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return resultado;
}

// ---------- Formateo ----------
function formatearValor(precioBase) {
  return precioBase ? Number(precioBase).toLocaleString("es-CO") : "no especificado";
}

function formatearAlertaTelegram(fila) {
  const url = fila.urlproceso?.url || "https://www.colombiacompra.gov.co";
  return (
    `🛰️ *Nueva licitación relevante*\n\n` +
    `*Entidad:* ${fila.entidad || "?"}\n` +
    `*Objeto:* ${(fila.descripci_n_del_procedimiento || fila.nombre_del_procedimiento || "").slice(0, 300)}\n` +
    `*Valor base:* $${formatearValor(fila.precio_base)} COP\n` +
    `*Ciudad:* ${fila.ciudad_entidad || "no definida"}\n` +
    `*Estado:* ${fila.estado_del_procedimiento || "?"}\n` +
    `*Coincidió por:* ${fila._match}\n` +
    `*Enlace:* ${url}`
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function seccionAlertasTexto(nuevas) {
  if (nuevas.length === 0) return "No hubo licitaciones nuevas relevantes hoy.\n";
  return nuevas
    .map((fila, i) => {
      const url = fila.urlproceso?.url || "https://www.colombiacompra.gov.co";
      return (
        `${i + 1}. ${fila.entidad || "?"}\n` +
        `   Objeto: ${(fila.descripci_n_del_procedimiento || fila.nombre_del_procedimiento || "").slice(0, 300)}\n` +
        `   Valor base: $${formatearValor(fila.precio_base)} COP | Ciudad: ${fila.ciudad_entidad || "no definida"} | Estado: ${fila.estado_del_procedimiento || "?"}\n` +
        `   Coincidió por: ${fila._match}\n` +
        `   Enlace: ${url}\n`
      );
    })
    .join("\n");
}

function seccionAlertasHtml(nuevas) {
  if (nuevas.length === 0) return `<p style="color:#666;">No hubo licitaciones nuevas relevantes hoy.</p>`;
  const filas = nuevas
    .map((fila) => {
      const url = fila.urlproceso?.url || "https://www.colombiacompra.gov.co";
      return `
        <tr>
          <td style="padding:10px;border-bottom:1px solid #e2e2e2;">
            <div style="font-weight:600;color:#1F3B4D;">${escapeHtml(fila.entidad || "?")}</div>
            <div style="color:#333;margin:4px 0;">${escapeHtml((fila.descripci_n_del_procedimiento || fila.nombre_del_procedimiento || "").slice(0, 300))}</div>
            <div style="font-size:13px;color:#595959;">
              Valor base: <b>$${formatearValor(fila.precio_base)} COP</b> ·
              Ciudad: ${escapeHtml(fila.ciudad_entidad || "no definida")} ·
              Estado: ${escapeHtml(fila.estado_del_procedimiento || "?")}
            </div>
            <div style="font-size:12px;color:#0F6E5B;margin-top:4px;">Coincidió por: ${escapeHtml(fila._match)}</div>
            <div style="margin-top:6px;"><a href="${url}" style="color:#0F6E5B;">Ver en SECOP →</a></div>
          </td>
        </tr>`;
    })
    .join("");
  return `<table style="width:100%;border-collapse:collapse;">${filas}</table>`;
}

function seccionTopValorTexto(topPorDepto) {
  const deptos = Object.keys(topPorDepto);
  if (deptos.length === 0) return "";
  let texto = `\n\n=== TOP VALOR POR DEPARTAMENTO (cualquier servicio, sin filtrar por palabra clave) ===\n`;
  for (const depto of deptos) {
    texto += `\n--- ${depto} ---\n`;
    topPorDepto[depto].forEach((fila, i) => {
      texto += `${i + 1}. ${fila.entidad || "?"} — $${formatearValor(fila.precio_base)} COP — ${(fila.descripci_n_del_procedimiento || fila.nombre_del_procedimiento || "").slice(0, 90)}\n`;
    });
  }
  return texto;
}

function seccionTopValorHtml(topPorDepto) {
  const deptos = Object.keys(topPorDepto);
  if (deptos.length === 0) return "";
  let html = `
    <hr style="margin:28px 0;border:none;border-top:2px solid #EAF2F0;">
    <h2 style="color:#1F3B4D;">💰 Top valor por departamento</h2>
    <p style="color:#666;font-size:13px;">Las licitaciones de mayor valor en cada departamento, sin filtrar por servicio.</p>`;
  for (const depto of deptos) {
    html += `<h3 style="color:#0F6E5B;font-size:15px;margin-top:18px;">${escapeHtml(depto)}</h3><ol style="padding-left:20px;margin:6px 0;">`;
    for (const fila of topPorDepto[depto]) {
      const url = fila.urlproceso?.url || "https://www.colombiacompra.gov.co";
      const objeto = (fila.descripci_n_del_procedimiento || fila.nombre_del_procedimiento || "").slice(0, 100);
      html += `<li style="margin-bottom:6px;font-size:13px;color:#333;">
        <b>${escapeHtml(fila.entidad || "?")}</b> — $${formatearValor(fila.precio_base)} COP<br>
        <span style="color:#595959;">${escapeHtml(objeto)}</span> — <a href="${url}" style="color:#0F6E5B;">ver →</a>
      </li>`;
    }
    html += `</ol>`;
  }
  return html;
}

// Construye el cuerpo del correo completo para un cliente: sus alertas + (opcional) top valor.
function construirCuerpoCorreo(nombreCliente, nuevas, fechaTexto, topPorDepto = {}) {
  const texto =
    `SECOP Radar — resumen del ${fechaTexto} para ${nombreCliente}\n\n` +
    `Se encontraron ${nuevas.length} licitaciones nuevas relevantes:\n\n` +
    seccionAlertasTexto(nuevas) +
    seccionTopValorTexto(topPorDepto);

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;">
      <h2 style="color:#1F3B4D;">🛰️ SECOP Radar — resumen del ${fechaTexto}</h2>
      <p style="color:#333;">Para <b>${escapeHtml(nombreCliente)}</b> — se encontraron <b>${nuevas.length}</b> licitaciones nuevas relevantes:</p>
      ${seccionAlertasHtml(nuevas)}
      ${seccionTopValorHtml(topPorDepto)}
      <p style="color:#999;font-size:12px;margin-top:24px;">Generado automáticamente por SECOP Radar. Para agregar o quitar palabras clave, edita clientes/&lt;cliente&gt;/palabras_clave.txt en el repositorio.</p>
    </div>`;

  return { texto, html };
}

async function enviarCorreo(destinatario, asunto, cuerpo) {
  if (!EMAIL_USER || !EMAIL_APP_PASSWORD) {
    console.log("ℹ️  Correo no configurado (faltan EMAIL_USER / EMAIL_APP_PASSWORD). No se envía nada por email.");
    return;
  }
  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: EMAIL_USER, pass: EMAIL_APP_PASSWORD },
  });
  await transporter.sendMail({
    from: `"SECOP Radar" <${EMAIL_USER}>`,
    to: destinatario,
    subject: asunto,
    text: cuerpo.texto,
    html: cuerpo.html,
  });
  console.log(`📧 Correo enviado a ${destinatario}.`);
}

async function enviarTelegramItem(texto) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: texto, parse_mode: "Markdown" }),
  });
  if (!resp.ok) console.error("⚠️  Error enviando a Telegram:", resp.status, await resp.text());
}

function registrarEnCsv(cliente, filas) {
  const encabezado = "cliente,id_del_proceso,entidad,objeto,valor_base,ciudad,estado,coincidio_por,url,fecha_deteccion\n";
  if (!fs.existsSync(CSV_LOG_PATH)) fs.writeFileSync(CSV_LOG_PATH, encabezado);
  const lineas = filas.map((fila) => {
    const campos = [
      cliente,
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
  console.log(`\n🛰️  SECOP Radar — corriendo ${DRY_RUN ? "(modo prueba, no envía nada)" : ""}`);
  const config = cargarConfig();
  const clientes = cargarClientes();
  console.log(`👥 ${clientes.length} cliente(s) activo(s): ${clientes.map((c) => c.nombre).join(", ") || "(ninguno)"}`);

  if (clientes.length === 0) {
    console.log("No hay clientes configurados en clientes/. Nada que hacer.");
    return;
  }

  // El Top 10 por departamento es igual para todos, así que se calcula una sola vez si algún cliente lo pide.
  const algunClienteQuiereTopValor = clientes.some((c) => c.incluirTopValorNacional);
  let topPorDepto = {};
  if (algunClienteQuiereTopValor) {
    console.log("💰 Calculando el Top valor por departamento (una sola vez para todos los clientes que lo pidieron)...");
    topPorDepto = await buscarTopValorPorDepartamento(config);
    const totalFilas = Object.values(topPorDepto).reduce((sum, arr) => sum + arr.length, 0);
    console.log(`   ${Object.keys(topPorDepto).length} departamento(s) con datos, ${totalFilas} licitaciones en total.`);
  }

  const fechaTexto = new Date().toLocaleDateString("es-CO", { year: "numeric", month: "long", day: "numeric" });

  for (const cliente of clientes) {
    console.log(`\n— Procesando cliente: ${cliente.nombre} (${cliente.palabrasClave.length} palabras clave) —`);
    const estado = cargarEstado(cliente.seenPath);
    const encontrados = await buscarParaCliente(config, cliente.palabrasClave);
    const nuevas = [...encontrados.values()].filter((fila) => !estado.vistos[fila.id_del_proceso]);
    console.log(`   ${encontrados.size} coincidencias totales, ${nuevas.length} nuevas.`);

    for (const fila of nuevas) console.log("   • " + (fila.entidad || "?") + " — " + fila._match);

    const topValorParaEsteCliente = cliente.incluirTopValorNacional ? topPorDepto : {};
    const totalTopValor = Object.values(topValorParaEsteCliente).reduce((s, a) => s + a.length, 0);

    if (DRY_RUN) {
      console.log(`   (modo prueba: no se envía correo/Telegram, no se guarda estado para ${cliente.nombre})`);
      continue;
    }

    const debeEnviar = nuevas.length > 0 || totalTopValor > 0 || config.correo?.enviar_aunque_no_haya_nuevas;

    if (config.correo?.activar && debeEnviar && cliente.email) {
      const cuerpo = construirCuerpoCorreo(cliente.nombre, nuevas, fechaTexto, topValorParaEsteCliente);
      const asuntoPrefijo = config.correo?.asunto_prefijo || "SECOP Radar";
      await enviarCorreo(cliente.email, `${asuntoPrefijo} — ${cliente.nombre} — ${fechaTexto}`, cuerpo);
    }

    if (config.canal_telegram?.activar) {
      for (const fila of nuevas) await enviarTelegramItem(formatearAlertaTelegram(fila));
    }

    if (nuevas.length > 0) {
      for (const fila of nuevas) estado.vistos[fila.id_del_proceso] = Date.now();
      registrarEnCsv(cliente.slug, nuevas);
      guardarEstado(cliente.seenPath, estado);
    }
  }

  console.log("\n✅ Corrida terminada.");
}

module.exports = { cargarClientes, construirCuerpoCorreo, buscarTopValorPorDepartamento, main };

if (require.main === module) {
  main().catch((err) => {
    console.error("❌ Error fatal:", err);
    process.exit(1);
  });
}
