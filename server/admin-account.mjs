import { scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

// Fixed Niko administrator. Only the server receives this verifier, never the UI.
export const ADMIN_ACCOUNT = Object.freeze({
  version: 1,
  username: "liuqi",
  salt: "c977d1870506c5d245e041eb2d68cedc",
  passwordHash:
    "83d91dceab08ceaed98901306f847deb28a8a8ede26776e7663c98c8bcbfce9a0410a30bb8347a16f93686796453faf501031e7d66625f31d83ba58e4f7ce69e",
});

const derive = promisify(scrypt);
export async function verifyAdmin(username, password, account = ADMIN_ACCOUNT) {
  const actual = await derive(password, account.salt, 64);
  const matched = timingSafeEqual(actual, Buffer.from(account.passwordHash, "hex"));
  return username === account.username && matched;
}
