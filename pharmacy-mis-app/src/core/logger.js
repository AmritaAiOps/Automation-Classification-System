'use strict';

/**
 * Every step the pipeline takes is announced through a Logger so the UI can
 * show it live. Nothing in src/ writes to the console directly — the renderer
 * is the log surface, and the console is only a fallback when no sink is set.
 */

class Logger {
  constructor(sink) {
    this.sink = sink || null;
    this.entries = [];
    this.indent = 0;
  }

  emit(level, message, detail) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      indent: this.indent,
      message: String(message),
      detail: detail === undefined ? null : detail,
    };
    this.entries.push(entry);
    if (this.sink) this.sink(entry);
    else console.log(`[${level}] ${'  '.repeat(this.indent)}${entry.message}`);
    return entry;
  }

  debug(m, d) { return this.emit('debug', m, d); }
  info(m, d) { return this.emit('info', m, d); }
  ok(m, d) { return this.emit('ok', m, d); }
  warn(m, d) { return this.emit('warn', m, d); }
  error(m, d) { return this.emit('error', m, d); }

  /** A named phase. Everything logged inside it is indented under it. */
  step(message, detail) {
    this.emit('step', message, detail);
    this.indent += 1;
    return () => { this.indent = Math.max(0, this.indent - 1); };
  }

  /** Run fn inside a step, closing the indent even if fn throws. */
  async during(message, fn) {
    const close = this.step(message);
    try {
      return await fn();
    } finally {
      close();
    }
  }

  toText() {
    return this.entries
      .map((e) => `${e.ts}  ${e.level.toUpperCase().padEnd(5)}  ${'  '.repeat(e.indent)}${e.message}`)
      .join('\n');
  }
}

module.exports = { Logger };
