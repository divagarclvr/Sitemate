/** An error that is safe to show the user. `hint` tells them what to do next. */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public hint?: string,
  ) {
    super(message);
  }
}
