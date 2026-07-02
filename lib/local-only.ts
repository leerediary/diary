/**
 * LOCAL_ONLY build-time switch (Phase 19 / D-01).
 *
 * When NEXT_PUBLIC_LOCAL_ONLY=1 is set at build time, this const is inlined as
 * `true` into the static bundle under output:'export'. The NEXT_PUBLIC_ prefix
 * is required so Next.js substitutes the value at build time — there is no
 * runtime env on the client in a static export.
 *
 * The sentinel value '1' is set by the deployer (Vercel env / tunnel script);
 * any other value or absence of the env var produces `false`.
 *
 * This is a plain const module — no 'use client' directive, no imports, no DOM
 * access. It is importable from both client components and lib code.
 */
export const LOCAL_ONLY = process.env.NEXT_PUBLIC_LOCAL_ONLY === '1'
