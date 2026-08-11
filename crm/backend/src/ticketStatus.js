export const VALID_STATUSES = ['bot', 'esperando_asesor', 'en_atencion', 'resuelto'];

export function isValidStatus(status) {
  return VALID_STATUSES.includes(status);
}
