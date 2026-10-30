export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return next(new URL('./ui-primitives.ts', import.meta.url).href, context);
  return next(specifier, context);
}
