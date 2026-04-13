// Public configuration baked into the APK.
//
// The Supabase anon key is intentionally embedded — this APK is sideloaded
// on a single personal device, the underlying tables have no RLS and only
// hold non-sensitive match scoring data. If we ever distribute this app
// publicly, switch to a PIN-gated RLS policy.

export const SUPABASE_URL = "https://zdymczdhchjfjijyhfiy.supabase.co";
export const SUPABASE_ANON_KEY =
  "sb_publishable_02auDo8PQ2UXO9bE4NE2Zg_4ZE1qV0A";

// PIN gate (plain compare — local APK only). Set to null to disable.
export const APP_PIN = "1234";
