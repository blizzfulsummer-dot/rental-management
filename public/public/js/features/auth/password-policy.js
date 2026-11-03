export function applyPasswordRequirement(profile) {
  if (!profile || typeof profile !== 'object') return false;
  return Number(profile.requires_change_password) === 1 || profile.requires_change_password === true;
}
