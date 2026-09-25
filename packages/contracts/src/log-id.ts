export const FINDING_LOG_ID_PATTERN = /^\d{3,4}\.\d\.\d[A-Z]$/;

export const MIXTAPE_LOG_ID_PATTERN = /^\d{3,4}\.F\.\d[A-F]$/;

export const COORDINATE_PATTERN = /fluncle:\/\/(\d{3,4}\.(?:\d\.\d[A-Z]|F\.\d[A-F]))(?![0-9A-Z])/gi;

export function isLogId(value: string): boolean {
  return FINDING_LOG_ID_PATTERN.test(value);
}

export function isMixtapeLogId(value: string): boolean {
  return MIXTAPE_LOG_ID_PATTERN.test(value);
}

export const LOG_ID_TEST_VECTORS = {
  lowercase: ["241.7.3a", "019.f.1a"],

  malformed: ["04.7.2I", "10240.7.3I", "019.G.1A", "019.F.1Z", "007.12.3I", "7.0.0Z"],

  validFindings: ["004.7.2I", "241.7.3A", "018.8.9J", "1024.7.3I"],

  validMixtapes: ["019.F.1A", "019.F.1F", "1024.F.2C"],
} as const;
