export class EddyError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'EddyError';
  }
}

export class ConfigError extends EddyError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigError';
  }
}

export class NotFoundError extends EddyError {
  constructor(resource: string) {
    super(`${resource} not found`, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends EddyError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

// A known caller asking for something its role may not do (e.g. a kid's id
// on a parent-only route). Mapped to 403.
export class ForbiddenError extends EddyError {
  constructor(message: string) {
    super(message, 'FORBIDDEN');
    this.name = 'ForbiddenError';
  }
}

export class GuardError extends EddyError {
  constructor(message: string) {
    super(message, 'GUARD_ERROR');
    this.name = 'GuardError';
  }
}

export class DownloadError extends EddyError {
  constructor(
    message: string,
    public readonly ytdlpCode?: string
  ) {
    super(message, 'DOWNLOAD_ERROR');
    this.name = 'DownloadError';
  }
}

export class TokenError extends EddyError {
  constructor(message: string) {
    super(message, 'TOKEN_ERROR');
    this.name = 'TokenError';
  }
}

export class PrivacyError extends EddyError {
  constructor(message: string) {
    super(message, 'PRIVACY_ERROR');
    this.name = 'PrivacyError';
  }
}
