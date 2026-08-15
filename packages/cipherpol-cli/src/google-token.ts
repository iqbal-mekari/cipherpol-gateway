import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Mints a Google OIDC identity token via the installed Cloud SDK.
 *
 * Deliberately omits `--audiences`: `gcloud auth print-identity-token` only
 * accepts a custom audience for service accounts, not regular user accounts
 * (verified directly — passing `--audiences` for a user account fails with
 * "Invalid account type"). Every human engineer's token therefore carries
 * Google's own fixed "Google Cloud SDK" client ID as `aud`, which is exactly
 * what the deployed control plane's `GOOGLE_AUTH_ALLOWED_AUDIENCE` default
 * expects. The real access control is the email-domain check, which is
 * independent of `aud` sharing.
 *
 * Tokens live ~1 hour; a single CLI invocation is well within that, so this is
 * called fresh per request with no caching/refresh logic.
 */
export async function getGoogleIdToken(): Promise<string> {
  let token: string;
  try {
    const { stdout } = await execFileAsync("gcloud", ["auth", "print-identity-token"]);
    token = stdout.trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(
      code === "ENOENT"
        ? "gcloud is not installed or not on PATH. Install the Google Cloud SDK, then run `gcloud auth login` to authenticate."
        : "Failed to obtain a Google identity token (`gcloud auth print-identity-token` failed). Run `gcloud auth login` to authenticate.",
      { cause: error },
    );
  }
  if (token.length === 0) {
    throw new Error("`gcloud auth print-identity-token` returned an empty token. Run `gcloud auth login` to authenticate.");
  }
  return token;
}
