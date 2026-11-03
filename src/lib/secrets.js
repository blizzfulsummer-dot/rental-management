/** Resolve Cloudflare Secrets Store bindings and local string secrets uniformly. */
export async function getSecretString(env, bindingName, minLength = 32) {
  const binding = env?.[bindingName];
  const value = binding && typeof binding.get === 'function'
    ? await binding.get()
    : binding;

  if (typeof value !== 'string' || value.length < minLength) {
    throw new Error(`${bindingName} is missing or too short; configure a secret of at least ${minLength} characters.`);
  }
  return value;
}

export async function getSecretBytes(env, bindingName, minLength = 32) {
  return new TextEncoder().encode(await getSecretString(env, bindingName, minLength));
}
