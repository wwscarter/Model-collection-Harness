import path from 'node:path';

/**
 * One credential policy for both the project snapshot and the file tools.
 *
 * The two code paths used to keep separate lists: the snapshot skipped only a
 * handful of .env names, while the read/write tools already refused .npmrc.
 * Any divergence becomes a credential leak, so every reader must call this
 * module instead of maintaining its own copy.
 */
const SENSITIVE_BASENAMES = new Set([
  '.env', '.envrc', '.flaskenv', '.npmrc', '.netrc', '_netrc', '.pypirc', '.git-credentials', '.gitconfig',
  '.htpasswd', '.pgpass', '.my.cnf', '.dockercfg', '.vault-token', '.terraformrc', 'application_default_credentials.json',
  'credentials', 'credentials.json', 'auth.json', 'id_rsa', 'id_dsa', 'id_ecdsa',
  'id_ed25519', 'id_ecdsa_sk', 'id_ed25519_sk', 'terraform.tfstate',
  'terraform.tfstate.backup',
]);

/** Paths whose name alone is not enough, e.g. .aws/credentials. */
const SENSITIVE_PATHS: RegExp[] = [
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.aws\/config$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.kube\/config$/i,
  /(^|\/)\.config\/gcloud\/(application_default_credentials|credentials)\.json$/i,
  /(^|\/)\.gem\/credentials$/i,
  /(^|\/)\.ssh\/id_[^/]+$/i,
  /(^|\/)\.m2\/settings\.xml$/i,
  /(^|\/)\.gradle\/gradle\.properties$/i,
  /(^|\/)\.git\/config$/i,
];

const SENSITIVE_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.crt', '.cer', '.der', '.keystore', '.jks', '.ppk',
]);

export function isSensitiveFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (!lower) return false;
  if (SENSITIVE_BASENAMES.has(lower)) return true;
  // Block every .env variant, including .env.test, .env.staging and
  // .env.production.local. Placeholders are cheap to retype; credentials are not.
  if (lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.env')) return true;
  if (lower.startsWith('service-account') && lower.endsWith('.json')) return true;
  if (lower.startsWith('firebase-adminsdk') && lower.endsWith('.json')) return true;
  if (/^secrets?\.(json|ya?ml|toml)$/i.test(lower)) return true;
  return SENSITIVE_EXTENSIONS.has(path.extname(lower));
}

/** Normalize to a root-relative POSIX path without leading ./, / or trailing /. */
export function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
}

export function isInsideGitPath(relativePath: string): boolean {
  // Case-insensitive filesystems would otherwise let .GIT reach .git contents.
  return normalizeRelativePath(relativePath).split('/').some((segment) => segment.toLowerCase() === '.git');
}

export function isSensitiveRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return false;
  if (isInsideGitPath(normalized)) return true;
  const name = normalized.split('/').at(-1) ?? '';
  if (isSensitiveFileName(name)) return true;
  return SENSITIVE_PATHS.some((pattern) => pattern.test(normalized));
}
