import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const ORGANIZER_ACCESS_COOKIE = "sptc_organizer_access";
const ORGANIZER_ACCESS_CODE = "92026";
function accessToken() {
  const secret = process.env.ORGANIZER_SESSION_SECRET ?? process.env.SUPABASE_SECRET_KEY;
  if (!secret) throw new Error("Organizer session signing secret is required.");
  return createHmac("sha256", secret).update(`sptc-organizer:${ORGANIZER_ACCESS_CODE}`).digest("hex");
}

export function isOrganizerCodeValid(code: string) {
  const supplied = Buffer.from(code);
  const expected = Buffer.from(ORGANIZER_ACCESS_CODE);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function hasOrganizerAccess() {
  const cookieStore = await cookies();
  return cookieStore.get(ORGANIZER_ACCESS_COOKIE)?.value === accessToken();
}

export function organizerAccessToken() {
  return accessToken();
}
