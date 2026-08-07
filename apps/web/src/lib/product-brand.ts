export const PRODUCT_NAME = 'AjustCam';

/**
 * Instalações antigas podem ter persistido o nome de produto anterior como se
 * fosse o nome do local. Mantemos nomes de instalação personalizados, mas não
 * deixamos a marca legada reaparecer na interface.
 */
export function normalizeFacilityName(value?: string | null) {
  const name = String(value ?? '').trim();
  if (!name || name.toLowerCase() === 'drac vms') return PRODUCT_NAME;
  return name;
}

/**
 * Descritor que acompanha a marca da instalação (barra lateral, tela de login).
 *
 * É um DESCRITOR, nunca uma marca: cada instalação roda sob a marca do próprio
 * cliente, e exibir "AjustCam" logo abaixo de "D-GUARDIAN" põe duas marcas na
 * mesma tela — a nossa dentro do produto que ele comprou. Foi o que o dono viu
 * na primeira instalação de cliente (07/08/2026).
 */
export const PRODUCT_TAGLINE = 'Central de Monitoramento';

/**
 * Título da aba. Só a marca da instalação — `normalizeFacilityName` já devolve
 * PRODUCT_NAME quando não há marca própria, então o fornecedor continua
 * aparecendo onde deve e some onde não deve.
 */
export function productPageTitle(facilityName?: string | null) {
  return normalizeFacilityName(facilityName);
}
