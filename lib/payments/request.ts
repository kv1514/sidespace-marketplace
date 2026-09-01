export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expectedUrl = new URL(process.env.NEXT_PUBLIC_APP_URL ?? request.url);
  if (process.env.NODE_ENV === "production" && expectedUrl.protocol !== "https:") {
    throw new ApiError("SideSpace payment actions require HTTPS.", 403);
  }
  const expected = expectedUrl.origin;
  if (!origin || origin !== expected) {
    throw new ApiError("This request did not come from SideSpace.", 403);
  }
}

export function requireUuid(value: unknown, message: string) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new ApiError(message);
  }
  return value;
}
