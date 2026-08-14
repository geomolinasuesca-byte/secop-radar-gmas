#!/usr/bin/env node
/**
 * Asistente para dar de alta un cliente nuevo en SECOP Radar.
 * Corre esto EN TU COMPUTADOR (no en GitHub) — te va preguntando los datos
 * y te arma automáticamente la carpeta del cliente con sus 2 archivos.
 * Después solo subes esa carpeta nueva a GitHub, dentro de "clientes/".
 *
 * Uso:
 *   node agregar_cliente.js
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { stdin, stdout } = require("process");

const CLIENTES_DIR = path.join(__dirname, "clientes");

function slugify(texto) {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita tildes
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log("\n🛰️  Asistente para agregar un cliente nuevo a SECOP Radar\n");

  const nombre = (await rl.question("Nombre del cliente (ej. Constructora ABC): ")).trim();
  if (!nombre) {
    console.log("❌ El nombre no puede quedar vacío. Vuelve a correr el asistente.");
    rl.close();
    return;
  }

  const email = (await rl.question("Correo al que le deben llegar las alertas: ")).trim();
  if (!email.includes("@")) {
    console.log("❌ Ese correo no parece válido. Vuelve a correr el asistente.");
    rl.close();
    return;
  }

  const incluirTopValor = (
    await rl.question("¿Incluir también el Top 10 nacional de licitaciones grandes por departamento? (s/n): ")
  )
    .trim()
    .toLowerCase()
    .startsWith("s");

  console.log("\nAhora dime las palabras clave de este cliente, una por una.");
  console.log("Deja la línea vacía (solo Enter) cuando termines.\n");

  const palabras = [];
  while (true) {
    const palabra = (await rl.question(`Palabra clave #${palabras.length + 1} (Enter para terminar): `)).trim();
    if (!palabra) break;
    palabras.push(palabra);
  }

  rl.close();

  if (palabras.length === 0) {
    console.log("\n⚠️  No agregaste ninguna palabra clave. El cliente quedará sin nada que vigilar todavía.");
    console.log("   Puedes agregarlas después editando su archivo palabras_clave.txt.");
  }

  const slug = slugify(nombre);
  const carpetaCliente = path.join(CLIENTES_DIR, slug);

  if (fs.existsSync(carpetaCliente)) {
    console.log(`\n❌ Ya existe un cliente en clientes/${slug}/. Si quieres editarlo, hazlo directamente ahí.`);
    return;
  }

  fs.mkdirSync(carpetaCliente, { recursive: true });

  const clienteJson = {
    nombre,
    email,
    activo: true,
    incluir_top_valor_nacional: incluirTopValor,
  };
  fs.writeFileSync(path.join(carpetaCliente, "cliente.json"), JSON.stringify(clienteJson, null, 2) + "\n");

  const contenidoPalabras =
    `# Palabras clave de ${nombre} — una por línea. Líneas con # son comentarios.\n\n` + palabras.join("\n") + "\n";
  fs.writeFileSync(path.join(carpetaCliente, "palabras_clave.txt"), contenidoPalabras);

  console.log(`\n✅ Cliente creado en: clientes/${slug}/`);
  console.log(`   - cliente.json (nombre, correo, config)`);
  console.log(`   - palabras_clave.txt (${palabras.length} palabra(s) clave)`);
  console.log(`\nSiguiente paso: sube esa carpeta completa a tu repositorio de GitHub, dentro de "clientes/".`);
  console.log(`En la próxima corrida del radar, ${nombre} ya va a recibir sus alertas en ${email}.\n`);
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
