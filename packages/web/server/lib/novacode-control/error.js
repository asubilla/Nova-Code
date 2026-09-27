export class NovaCodeControlError extends Error {
  constructor(message, statusCode = 500, details = {}) {
    super(message);
    this.name = 'NovaCodeControlError';
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

export const asControlError = (error, fallbackMessage, fallbackStatus = 500) => {
  if (error instanceof NovaCodeControlError) return error;
  const message = error instanceof Error ? error.message : fallbackMessage;
  return new NovaCodeControlError(message || fallbackMessage, Number(error?.statusCode) || Number(error?.status) || fallbackStatus, {
    ...(error?.goalConfigured === true ? { goalConfigured: true } : {}),
  });
};
