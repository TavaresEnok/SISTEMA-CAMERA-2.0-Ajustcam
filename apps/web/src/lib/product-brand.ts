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

export function productPageTitle(facilityName?: string | null) {
  const name = normalizeFacilityName(facilityName);
  return name === PRODUCT_NAME ? PRODUCT_NAME : `${name} · ${PRODUCT_NAME}`;
}
