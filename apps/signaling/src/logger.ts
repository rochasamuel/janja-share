export type LogCategory = "APP" | "SIGNALING" | "ROOM" | "TURN";

export interface Logger {
  info(category: LogCategory, message: string, fields?: Record<string, unknown>): void;
  warn(category: LogCategory, message: string, fields?: Record<string, unknown>): void;
  error(category: LogCategory, message: string, fields?: Record<string, unknown>): void;
}

function format(
  level: string,
  category: LogCategory,
  message: string,
  fields?: Record<string, unknown>,
): string {
  const suffix = fields
    ? " " +
      Object.entries(fields)
        .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
        .join(" ")
    : "";
  return `${new Date().toISOString()} ${level} [${category}] ${message}${suffix}`;
}

export const consoleLogger: Logger = {
  info: (c, m, f) => console.log(format("INFO ", c, m, f)),
  warn: (c, m, f) => console.warn(format("WARN ", c, m, f)),
  error: (c, m, f) => console.error(format("ERROR", c, m, f)),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
