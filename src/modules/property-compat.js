export function normalizePropertyRecord(property) {
  if (!property || typeof property !== 'object') return property;

  return {
    ...property,
    property_id: property.property_id ?? property.house_id ?? property.id ?? null,
    house_id: property.house_id ?? property.property_id ?? property.id ?? null,
    location: property.location ?? property.address ?? null,
    address: property.address ?? property.location ?? null
  };
}

export function getPropertyIdValue(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.property_id ?? payload.house_id ?? null;
}

export function getPropertyIdList(payload) {
  if (!payload || typeof payload !== 'object') return [];

  const values = Array.isArray(payload.property_ids)
    ? payload.property_ids
    : Array.isArray(payload.house_ids)
      ? payload.house_ids
      : [];

  if (values.length > 0) {
    return [...new Set(values.map(value => Number(value)).filter(value => Number.isSafeInteger(value) && value > 0))];
  }

  const singleValue = getPropertyIdValue(payload);
  return singleValue === null || singleValue === undefined || singleValue === ''
    ? []
    : [Number(singleValue)].filter(value => Number.isSafeInteger(value) && value > 0);
}
