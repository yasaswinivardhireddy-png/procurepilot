export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export type LogFields = Record<string, unknown>;

export type Logger = {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
};

function parseLevel(value: string | undefined): LogLevel {
  return value && value in LEVELS ? (value as LogLevel) : 'info';
}

// One JSON object per line (easy to ship to CloudWatch/Kusto); LOG_FORMAT=pretty for local runs.
export function createLogger(service: string, level: LogLevel = parseLevel(process.env.LOG_LEVEL), base: LogFields = {}): Logger {
  const threshold = LEVELS[level];
  const pretty = process.env.LOG_FORMAT === 'pretty';

  const write = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields) => {
    if (LEVELS[lvl] < threshold) return;
    const record = { ts: new Date().toISOString(), level: lvl, svc: service, msg, ...base, ...fields };
    if (pretty) {
      const { ts, level: _l, svc, msg: m, ...rest } = record;
      const extras = Object.entries(rest)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ');
      process.stdout.write(`${ts.slice(11, 23)} ${lvl.toUpperCase().padEnd(5)} ${String(svc).padEnd(9)} ${m} ${extras}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(record)}\n`);
    }
  };

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (fields) => createLogger(service, level, { ...base, ...fields }),
  };
}
