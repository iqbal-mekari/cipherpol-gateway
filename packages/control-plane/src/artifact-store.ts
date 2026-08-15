import type { SupabaseClient } from "@supabase/supabase-js";

/** One artifact file as supplied to (and returned from) the artifact store. */
export interface StoredArtifactFile {
  readonly path: string;
  readonly content: Uint8Array;
  readonly mode: number;
}

/** A package's persisted artifact payload, decoded from the `package_files` table. */
export interface PackageArtifacts {
  readonly packageId: string;
  readonly version: string;
  readonly digest: string;
  readonly files: readonly { path: string; contentBase64: string; mode: number }[];
}

/**
 * PostgREST represents a `bytea` column as the Postgres hex literal (`\x<hex>`)
 * in its JSON payload; supabase-js does not transparently convert `Uint8Array`
 * to/from that representation, so this module owns the conversion explicitly.
 */
function toByteaHex(content: Uint8Array): string {
  return `\\x${Buffer.from(content).toString("hex")}`;
}

function byteaHexToBase64(value: string): string {
  const hex = value.startsWith("\\x") ? value.slice(2) : value;
  return Buffer.from(hex, "hex").toString("base64");
}

/**
 * Upserts one package's artifact files into `package_files`, keyed by
 * `(package_id, version, path)`. Re-ingesting an already-present artifact
 * (including a promotion that re-ingests the same envelope) updates the stored
 * content and mode in place rather than conflicting.
 */
export async function storePackageArtifacts(
  client: SupabaseClient,
  input: {
    readonly packageId: string;
    readonly version: string;
    readonly files: readonly StoredArtifactFile[];
  },
): Promise<void> {
  if (input.files.length === 0) return;
  const rows = input.files.map((file) => ({
    package_id: input.packageId,
    version: input.version,
    path: file.path,
    content: toByteaHex(file.content),
    mode: file.mode,
  }));
  const { error } = await client
    .from("package_files")
    .upsert(rows, { onConflict: "package_id,version,path" });
  if (error) throw error;
}

/**
 * Reads one package's persisted artifact files plus its signed digest from the
 * `packages` table. Returns `undefined` when the package has never been
 * ingested, has been revoked (a revoked artifact's bytes must not remain
 * fetchable), or has no stored artifact rows (metadata-only ingest).
 */
export async function getPackageArtifacts(
  client: SupabaseClient,
  packageId: string,
  version: string,
): Promise<PackageArtifacts | undefined> {
  const { data: pkgData, error: pkgError } = await client
    .from("packages")
    .select("digest, revoked")
    .eq("id", packageId)
    .eq("version", version)
    .maybeSingle();
  if (pkgError) throw pkgError;
  if (!pkgData) return undefined;
  const pkg = pkgData as Record<string, unknown>;
  if (pkg.revoked === true) return undefined;

  const { data: filesData, error: filesError } = await client
    .from("package_files")
    .select("path, content, mode")
    .eq("package_id", packageId)
    .eq("version", version)
    .order("path");
  if (filesError) throw filesError;
  if (!filesData || filesData.length === 0) return undefined;

  return {
    packageId,
    version,
    digest: pkg.digest as string,
    files: (filesData as { path: string; content: string; mode: number }[]).map((file) => ({
      path: file.path,
      contentBase64: byteaHexToBase64(file.content),
      mode: file.mode,
    })),
  };
}
