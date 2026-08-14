// Prueba de humo SIN red real: simula respuestas de la API de SECOP con datos
// de ejemplo (tomados de una consulta real) para validar que el pipeline
// completo (búsqueda, deduplicado, formateo de alerta) funciona antes de
// desplegarlo donde sí haya acceso a internet.

const MUESTRA = [
  {
    id_del_proceso: "CO1.REQ.4000487",
    entidad: "SERVICIO GEOLOGICO COLOMBIANO",
    descripci_n_del_procedimiento: "Prestar servicios profesionales para cartografía geológica e inventario de puntos de agua",
    precio_base: "92405420",
    ciudad_entidad: "Bogotá",
    estado_del_procedimiento: "En aprobación",
    fecha_de_publicacion_del: "2026-08-10T00:00:00.000",
    codigo_principal_de_categoria: "V1.81151700",
    urlproceso: { url: "https://community.secop.gov.co/Public/Tendering/ejemplo" },
  },
  {
    id_del_proceso: "CO1.REQ.4000999",
    entidad: "GOBERNACIÓN DE CALDAS",
    descripci_n_del_procedimiento: "Toma de muestras de suelos y ensayos de laboratorio en vía departamental",
    precio_base: "148826925",
    ciudad_entidad: "Manizales",
    estado_del_procedimiento: "Seleccionado",
    fecha_de_publicacion_del: "2026-08-09T00:00:00.000",
    codigo_principal_de_categoria: "V1.81101500",
    urlproceso: { url: "https://community.secop.gov.co/Public/Tendering/ejemplo2" },
  },
];

let llamadas = 0;
global.fetch = async (url) => {
  llamadas++;
  return {
    ok: true,
    json: async () => MUESTRA,
  };
};

process.argv.push("--dry-run");

require("./secop-radar.js");

process.on("exit", () => {
  console.error(`\n(prueba de humo: se simularon ${llamadas} llamadas a la API sin tocar la red real)`);
});
